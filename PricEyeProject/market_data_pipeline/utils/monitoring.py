"""
Système de monitoring et logging pour le pipeline marché.

Gère le logging structuré, les métriques, et les alertes.
"""

import asyncio
import logging
import json
from typing import Dict, List, Optional, Any
from datetime import datetime
from enum import Enum
import os

try:
    from supabase import create_client, Client
    SUPABASE_AVAILABLE = True
except ImportError:
    SUPABASE_AVAILABLE = False
    logging.warning("Supabase client not available")

from ..config.settings import Settings

logger = logging.getLogger(__name__)


class AlertLevel(Enum):
    """Niveaux d'alerte."""
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"


class JobStatus(Enum):
    """Statuts d'exécution des jobs."""
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"
    PARTIAL = "partial"


class PipelineMonitor:
    """
    Gestionnaire de monitoring pour le pipeline marché.
    
    Log les exécutions de jobs, collecte les métriques, et envoie des alertes.
    """
    
    def __init__(self, settings: Optional[Settings] = None):
        """
        Initialise le monitor.
        
        Args:
            settings: Configuration (si None, charge depuis env)
        """
        self.settings = settings or Settings.from_env()
        self._supabase_client: Optional[Client] = None
        self._current_jobs: Dict[str, Dict[str, Any]] = {}  # job_name -> job_info
        
        # Configuration des alertes
        self.alert_email_enabled = os.getenv("ALERT_EMAIL_ENABLED", "false").lower() == "true"
        self.alert_slack_enabled = os.getenv("ALERT_SLACK_ENABLED", "false").lower() == "true"
        self.alert_email_recipients = os.getenv("ALERT_EMAIL_RECIPIENTS", "").split(",")
        self.slack_webhook_url = os.getenv("SLACK_WEBHOOK_URL", "")
        
        logger.info("Initialized PipelineMonitor")
    
    def _get_supabase_client(self) -> Optional[Client]:
        """Récupère le client Supabase (lazy init)."""
        if not SUPABASE_AVAILABLE:
            return None
        
        if not self.settings.supabase_url or not self.settings.supabase_key:
            return None
        
        if self._supabase_client is None:
            self._supabase_client = create_client(
                self.settings.supabase_url,
                self.settings.supabase_key
            )
        
        return self._supabase_client
    
    async def log_job_start(
        self,
        job_name: str,
        job_type: str,
        params: Optional[Dict[str, Any]] = None,
        triggered_by: str = "scheduled",
        triggered_by_user: Optional[str] = None
    ) -> str:
        """
        Enregistre le début d'exécution d'un job.
        
        Args:
            job_name: Nom du job (ex: 'collect_competitors')
            job_type: Type de job ('collect', 'enrich', 'build_features')
            params: Paramètres du job (countries, date_range, etc.)
            triggered_by: Déclencheur ('scheduled', 'manual', 'api')
            triggered_by_user: ID utilisateur si déclenché manuellement
            
        Returns:
            ID du log créé (UUID string)
        """
        start_time = datetime.now()
        
        # Stocker en mémoire
        job_info = {
            'job_name': job_name,
            'job_type': job_type,
            'start_time': start_time,
            'params': params or {},
            'triggered_by': triggered_by,
            'triggered_by_user': triggered_by_user
        }
        self._current_jobs[job_name] = job_info
        
        # Logger
        logger.info(
            f"[Monitor] Job started: {job_name} (type: {job_type}, "
            f"triggered_by: {triggered_by})"
        )
        
        # Enregistrer dans Supabase
        supabase_client = self._get_supabase_client()
        if supabase_client:
            try:
                loop = asyncio.get_event_loop()
                
                record = {
                    'job_name': job_name,
                    'job_type': job_type,
                    'start_time': start_time.isoformat(),
                    'status': JobStatus.RUNNING.value,
                    'records_processed': 0,
                    'records_success': 0,
                    'records_failed': 0,
                    'config': json.dumps(params) if params else None,
                    'triggered_by': triggered_by,
                    'triggered_by_user': triggered_by_user
                }
                
                response = await loop.run_in_executor(
                    None,
                    lambda: supabase_client.table('pipeline_logs_market')
                        .insert(record)
                        .execute()
                )
                
                if response.data and len(response.data) > 0:
                    log_id = response.data[0].get('id')
                    job_info['log_id'] = log_id
                    return log_id
                
            except Exception as e:
                logger.error(f"Error logging job start to database: {e}")
        
        return ""
    
    async def log_job_end(
        self,
        job_name: str,
        status: JobStatus,
        stats: Optional[Dict[str, Any]] = None,
        errors: Optional[List[Dict[str, Any]]] = None,
        error_message: Optional[str] = None
    ) -> bool:
        """
        Enregistre la fin d'exécution d'un job.
        
        Args:
            job_name: Nom du job
            status: Statut final ('success', 'failed', 'partial')
            stats: Statistiques (records_processed, records_success, etc.)
            errors: Liste des erreurs [{error, source, timestamp}, ...]
            error_message: Message d'erreur principal
            
        Returns:
            True si succès, False sinon
        """
        end_time = datetime.now()
        
        # Récupérer les infos du job
        job_info = self._current_jobs.get(job_name, {})
        start_time = job_info.get('start_time', end_time)
        log_id = job_info.get('log_id')
        
        # Calculer la durée
        duration = (end_time - start_time).total_seconds() if isinstance(start_time, datetime) else 0
        
        # Préparer les stats
        stats = stats or {}
        records_processed = stats.get('records_processed', stats.get('total_records', 0))
        records_success = stats.get('records_success', stats.get('total_records', 0))
        records_failed = stats.get('records_failed', len(errors) if errors else 0)
        
        # Logger
        logger.info(
            f"[Monitor] Job ended: {job_name} (status: {status.value}, "
            f"duration: {duration:.2f}s, processed: {records_processed})"
        )
        
        # Enregistrer dans Supabase
        supabase_client = self._get_supabase_client()
        if supabase_client:
            try:
                loop = asyncio.get_event_loop()
                
                update_data = {
                    'end_time': end_time.isoformat(),
                    'status': status.value,
                    'records_processed': records_processed,
                    'records_success': records_success,
                    'records_failed': records_failed,
                    'errors': json.dumps(errors) if errors else None,
                    'error_message': error_message
                }
                
                if log_id:
                    # Mettre à jour le log existant
                    response = await loop.run_in_executor(
                        None,
                        lambda: supabase_client.table('pipeline_logs_market')
                            .update(update_data)
                            .eq('id', log_id)
                            .execute()
                    )
                else:
                    # Créer un nouveau log (si log_job_start n'a pas fonctionné)
                    record = {
                        'job_name': job_name,
                        'job_type': job_info.get('job_type', 'unknown'),
                        'start_time': start_time.isoformat() if isinstance(start_time, datetime) else end_time.isoformat(),
                        **update_data,
                        'config': json.dumps(job_info.get('params', {})),
                        'triggered_by': job_info.get('triggered_by', 'unknown'),
                        'triggered_by_user': job_info.get('triggered_by_user')
                    }
                    
                    response = await loop.run_in_executor(
                        None,
                        lambda: supabase_client.table('pipeline_logs_market')
                            .insert(record)
                            .execute()
                    )
                
                # Envoyer une alerte si erreur critique
                if status == JobStatus.FAILED or (status == JobStatus.PARTIAL and records_failed > records_success):
                    await self.send_alert(
                        f"Job {job_name} ended with status {status.value}",
                        AlertLevel.ERROR,
                        {
                            'job_name': job_name,
                            'status': status.value,
                            'duration': duration,
                            'errors': errors or [],
                            'error_message': error_message
                        }
                    )
                
                # Nettoyer
                if job_name in self._current_jobs:
                    del self._current_jobs[job_name]
                
                return True
                
            except Exception as e:
                logger.error(f"Error logging job end to database: {e}")
                return False
        
        return True
    
    async def send_alert(
        self,
        message: str,
        level: AlertLevel = AlertLevel.ERROR,
        details: Optional[Dict[str, Any]] = None
    ) -> bool:
        """
        Envoie une alerte (email, Slack, etc.).
        
        Args:
            message: Message d'alerte
            level: Niveau d'alerte
            details: Détails additionnels
            
        Returns:
            True si succès, False sinon
        """
        details = details or {}
        
        # Logger l'alerte
        if level == AlertLevel.CRITICAL:
            logger.critical(f"[Alert] {message} - Details: {details}")
        elif level == AlertLevel.ERROR:
            logger.error(f"[Alert] {message} - Details: {details}")
        elif level == AlertLevel.WARNING:
            logger.warning(f"[Alert] {message} - Details: {details}")
        else:
            logger.info(f"[Alert] {message} - Details: {details}")
        
        # Envoyer par email si activé
        if self.alert_email_enabled and level in [AlertLevel.ERROR, AlertLevel.CRITICAL]:
            await self._send_email_alert(message, level, details)
        
        # Envoyer par Slack si activé
        if self.alert_slack_enabled and level in [AlertLevel.ERROR, AlertLevel.CRITICAL]:
            await self._send_slack_alert(message, level, details)
        
        return True
    
    async def _send_email_alert(
        self,
        message: str,
        level: AlertLevel,
        details: Dict[str, Any]
    ) -> bool:
        """
        Envoie une alerte par email.
        
        Note: Nécessite une configuration SMTP ou service email (SendGrid, etc.)
        """
        if not self.alert_email_recipients:
            logger.warning("Email alert enabled but no recipients configured")
            return False
        
        try:
            # TODO: Implémenter l'envoi d'email
            # Pour l'instant, juste logger
            logger.info(
                f"[Email Alert] Would send to {self.alert_email_recipients}: "
                f"{level.value.upper()}: {message}"
            )
            
            # Exemple avec smtplib (à implémenter si nécessaire):
            # import smtplib
            # from email.mime.text import MIMEText
            # msg = MIMEText(f"{message}\n\nDetails: {json.dumps(details, indent=2)}")
            # msg['Subject'] = f"[Market Pipeline] {level.value.upper()}: {message}"
            # msg['From'] = os.getenv("ALERT_EMAIL_FROM", "noreply@pric-eye.com")
            # msg['To'] = ", ".join(self.alert_email_recipients)
            # 
            # smtp_server = os.getenv("SMTP_SERVER", "smtp.gmail.com")
            # smtp_port = int(os.getenv("SMTP_PORT", "587"))
            # smtp_user = os.getenv("SMTP_USER")
            # smtp_password = os.getenv("SMTP_PASSWORD")
            # 
            # with smtplib.SMTP(smtp_server, smtp_port) as server:
            #     server.starttls()
            #     server.login(smtp_user, smtp_password)
            #     server.send_message(msg)
            
            return True
            
        except Exception as e:
            logger.error(f"Error sending email alert: {e}")
            return False
    
    async def _send_slack_alert(
        self,
        message: str,
        level: AlertLevel,
        details: Dict[str, Any]
    ) -> bool:
        """
        Envoie une alerte par Slack.
        
        Nécessite SLACK_WEBHOOK_URL dans les variables d'environnement.
        """
        if not self.slack_webhook_url:
            logger.warning("Slack alert enabled but no webhook URL configured")
            return False
        
        try:
            import aiohttp
            
            # Couleur selon le niveau
            color_map = {
                AlertLevel.INFO: "#36a64f",  # Vert
                AlertLevel.WARNING: "#ff9500",  # Orange
                AlertLevel.ERROR: "#ff0000",  # Rouge
                AlertLevel.CRITICAL: "#8b0000"  # Rouge foncé
            }
            
            # Préparer le payload Slack
            payload = {
                "text": f"Market Data Pipeline Alert: {level.value.upper()}",
                "attachments": [
                    {
                        "color": color_map.get(level, "#808080"),
                        "title": message,
                        "fields": [
                            {
                                "title": "Level",
                                "value": level.value.upper(),
                                "short": True
                            },
                            {
                                "title": "Timestamp",
                                "value": datetime.now().isoformat(),
                                "short": True
                            }
                        ],
                        "footer": "PricEye Market Data Pipeline",
                        "ts": int(datetime.now().timestamp())
                    }
                ]
            }
            
            # Ajouter les détails si disponibles
            if details:
                details_text = "\n".join([
                    f"• {k}: {v}" for k, v in details.items()
                    if k not in ['errors']  # Les erreurs seront dans un champ séparé
                ])
                
                if details_text:
                    payload["attachments"][0]["fields"].append({
                        "title": "Details",
                        "value": details_text,
                        "short": False
                    })
                
                # Ajouter les erreurs si présentes
                if 'errors' in details and details['errors']:
                    errors_text = "\n".join([
                        f"• {err.get('error', err)}" for err in details['errors'][:5]
                    ])
                    if len(details['errors']) > 5:
                        errors_text += f"\n... and {len(details['errors']) - 5} more errors"
                    
                    payload["attachments"][0]["fields"].append({
                        "title": "Errors",
                        "value": errors_text,
                        "short": False
                    })
            
            # Envoyer la requête
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    self.slack_webhook_url,
                    json=payload,
                    headers={"Content-Type": "application/json"}
                ) as response:
                    if response.status == 200:
                        logger.info("Slack alert sent successfully")
                        return True
                    else:
                        error_text = await response.text()
                        logger.error(f"Error sending Slack alert: {response.status} - {error_text}")
                        return False
                        
        except ImportError:
            logger.warning("aiohttp not available for Slack alerts")
            return False
        except Exception as e:
            logger.error(f"Error sending Slack alert: {e}")
            return False
    
    async def get_job_status(
        self,
        job_name: Optional[str] = None,
        limit: int = 10
    ) -> List[Dict[str, Any]]:
        """
        Récupère le statut des jobs récents.
        
        Args:
            job_name: Nom du job (None = tous)
            limit: Nombre maximum de résultats
            
        Returns:
            Liste des logs de jobs
        """
        supabase_client = self._get_supabase_client()
        if not supabase_client:
            return []
        
        try:
            loop = asyncio.get_event_loop()
            
            query = supabase_client.table('pipeline_logs_market')\
                .select('*')\
                .order('start_time', desc=True)\
                .limit(limit)
            
            if job_name:
                query = query.eq('job_name', job_name)
            
            response = await loop.run_in_executor(
                None,
                lambda: query.execute()
            )
            
            return response.data if response.data else []
            
        except Exception as e:
            logger.error(f"Error fetching job status: {e}")
            return []
    
    def get_current_jobs(self) -> Dict[str, Dict[str, Any]]:
        """
        Récupère les jobs actuellement en cours.
        
        Returns:
            Dict avec job_name -> job_info
        """
        # Nettoyer les jobs trop anciens (> 24h)
        now = datetime.now()
        jobs_to_remove = []
        
        for job_name, job_info in self._current_jobs.items():
            start_time = job_info.get('start_time')
            if isinstance(start_time, datetime):
                if (now - start_time).total_seconds() > 86400:  # 24h
                    jobs_to_remove.append(job_name)
        
        for job_name in jobs_to_remove:
            del self._current_jobs[job_name]
        
        return self._current_jobs.copy()


# Instance globale (singleton)
_monitor_instance: Optional[PipelineMonitor] = None


def get_pipeline_monitor(settings: Optional[Settings] = None) -> PipelineMonitor:
    """
    Récupère l'instance globale du monitor.
    
    Args:
        settings: Configuration (si None, utilise une nouvelle instance)
        
    Returns:
        Instance du monitor
    """
    global _monitor_instance
    
    if _monitor_instance is None:
        _monitor_instance = PipelineMonitor(settings)
    
    return _monitor_instance


# Fonctions de convenance pour usage direct
async def log_job_start(
    job_name: str,
    job_type: str,
    params: Optional[Dict[str, Any]] = None,
    triggered_by: str = "scheduled",
    triggered_by_user: Optional[str] = None
) -> str:
    """
    Enregistre le début d'exécution d'un job.
    
    Fonction de convenance qui utilise l'instance globale.
    """
    monitor = get_pipeline_monitor()
    return await monitor.log_job_start(
        job_name, job_type, params, triggered_by, triggered_by_user
    )


async def log_job_end(
    job_name: str,
    status: JobStatus,
    stats: Optional[Dict[str, Any]] = None,
    errors: Optional[List[Dict[str, Any]]] = None,
    error_message: Optional[str] = None
) -> bool:
    """
    Enregistre la fin d'exécution d'un job.
    
    Fonction de convenance qui utilise l'instance globale.
    """
    monitor = get_pipeline_monitor()
    return await monitor.log_job_end(job_name, status, stats, errors, error_message)


async def send_alert(
    message: str,
    level: AlertLevel = AlertLevel.ERROR,
    details: Optional[Dict[str, Any]] = None
) -> bool:
    """
    Envoie une alerte.
    
    Fonction de convenance qui utilise l'instance globale.
    """
    monitor = get_pipeline_monitor()
    return await monitor.send_alert(message, level, details)


