"""
Rate limiter pour gérer les quotas API par source.
Utilise un sliding window pour gérer les limites par minute, heure et jour.
"""

import asyncio
import time
import json
import os
from dataclasses import dataclass, field, asdict
from typing import Optional, Dict
from collections import defaultdict, deque
from datetime import datetime, timedelta
import logging

logger = logging.getLogger(__name__)


@dataclass
class RateLimitConfig:
    """
    Configuration du rate limiting pour une source API.
    
    Toutes les limites sont optionnelles. Si None, la limite n'est pas appliquée.
    """
    requests_per_minute: Optional[int] = None
    requests_per_hour: Optional[int] = None
    requests_per_day: Optional[int] = None
    
    def __post_init__(self):
        """Valide la configuration."""
        if self.requests_per_minute is not None and self.requests_per_minute <= 0:
            raise ValueError("requests_per_minute must be positive")
        if self.requests_per_hour is not None and self.requests_per_hour <= 0:
            raise ValueError("requests_per_hour must be positive")
        if self.requests_per_day is not None and self.requests_per_day <= 0:
            raise ValueError("requests_per_day must be positive")


class RateLimiter:
    """
    Rate limiter utilisant un sliding window algorithm.
    
    Gère les limites de requêtes par minute, heure ou jour pour différentes sources API.
    Supporte la persistance de l'état entre les runs (optionnel).
    
    Algorithme : Sliding Window
    - Maintient un deque des timestamps des requêtes
    - Nettoie automatiquement les timestamps expirés
    - Calcule le temps d'attente basé sur la fenêtre la plus restrictive
    """
    
    def __init__(
        self,
        config: Optional[RateLimitConfig] = None,
        source_name: Optional[str] = None,
        persist_state: bool = False,
        state_file: Optional[str] = None
    ):
        """
        Initialise le rate limiter.
        
        Args:
            config: Configuration des limites (si None, aucune limite)
            source_name: Nom de la source API (pour multi-source)
            persist_state: Si True, persiste l'état entre les runs
            state_file: Chemin du fichier de persistance (défaut: .rate_limiter_state.json)
        """
        self.config = config
        self.source_name = source_name or "default"
        self.persist_state = persist_state
        self.state_file = state_file or ".rate_limiter_state.json"
        
        # {source_name: deque(timestamps)}
        self.request_times: Dict[str, deque] = defaultdict(deque)
        
        # Lock pour la thread-safety
        self._lock = asyncio.Lock()
        
        # Charger l'état persistant si activé
        if persist_state:
            self._load_state()
        
        logger.info(f"Initialized RateLimiter for source '{self.source_name}'")
    
    async def acquire(self, source_name: Optional[str] = None) -> None:
        """
        Attend si nécessaire pour respecter les limites, puis enregistre la requête.
        
        Cette méthode bloque jusqu'à ce qu'une requête puisse être effectuée.
        
        Args:
            source_name: Nom de la source (si None, utilise self.source_name)
        """
        source = source_name or self.source_name
        
        async with self._lock:
            await self.wait_if_needed(source)
            self.request_times[source].append(time.time())
            self._clean_old_requests(source)
            
            # Sauvegarder l'état si activé
            if self.persist_state:
                self._save_state()
    
    async def wait_if_needed(self, source_name: Optional[str] = None) -> None:
        """
        Attend si les limites sont atteintes pour la source donnée.
        
        Args:
            source_name: Nom de la source (si None, utilise self.source_name)
        """
        source = source_name or self.source_name
        
        if not self.can_proceed(source):
            wait_time = self._calculate_wait_time(source)
            if wait_time > 0:
                logger.info(
                    f"Rate limit reached for '{source}', waiting {wait_time:.2f}s"
                )
                await asyncio.sleep(wait_time)
                
                # Vérifier à nouveau après l'attente
                if not self.can_proceed(source):
                    # Si toujours bloqué, recalculer et attendre à nouveau
                    wait_time = self._calculate_wait_time(source)
                    if wait_time > 0:
                        logger.warning(
                            f"Still rate limited for '{source}' after wait, "
                            f"waiting additional {wait_time:.2f}s"
                        )
                        await asyncio.sleep(wait_time)
    
    def can_proceed(self, source_name: Optional[str] = None) -> bool:
        """
        Vérifie si une nouvelle requête peut être effectuée pour la source donnée.
        
        Args:
            source_name: Nom de la source (si None, utilise self.source_name)
            
        Returns:
            True si on peut procéder, False sinon
        """
        source = source_name or self.source_name
        
        # Si pas de config, autoriser toutes les requêtes
        if not self.config:
            return True
        
        now = time.time()
        self._clean_old_requests(source)
        request_times = self.request_times[source]
        
        # Vérifier limite par minute
        if self.config.requests_per_minute:
            recent_minute = [t for t in request_times if now - t < 60]
            if len(recent_minute) >= self.config.requests_per_minute:
                logger.debug(
                    f"Rate limit per minute reached for '{source}': "
                    f"{len(recent_minute)}/{self.config.requests_per_minute}"
                )
                return False
        
        # Vérifier limite par heure
        if self.config.requests_per_hour:
            recent_hour = [t for t in request_times if now - t < 3600]
            if len(recent_hour) >= self.config.requests_per_hour:
                logger.debug(
                    f"Rate limit per hour reached for '{source}': "
                    f"{len(recent_hour)}/{self.config.requests_per_hour}"
                )
                return False
        
        # Vérifier limite par jour
        if self.config.requests_per_day:
            recent_day = [t for t in request_times if now - t < 86400]
            if len(recent_day) >= self.config.requests_per_day:
                logger.debug(
                    f"Rate limit per day reached for '{source}': "
                    f"{len(recent_day)}/{self.config.requests_per_day}"
                )
                return False
        
        return True
    
    def _calculate_wait_time(self, source_name: Optional[str] = None) -> float:
        """
        Calcule le temps d'attente nécessaire pour la source donnée.
        
        Args:
            source_name: Nom de la source (si None, utilise self.source_name)
            
        Returns:
            Temps d'attente en secondes (minimum 0.1 pour éviter les requêtes trop rapides)
        """
        source = source_name or self.source_name
        
        if not self.config:
            return 0.0
        
        request_times = self.request_times[source]
        if not request_times:
            return 0.0
        
        now = time.time()
        wait_times = []
        
        # Limite par minute
        if self.config.requests_per_minute:
            recent_minute = [t for t in request_times if now - t < 60]
            if len(recent_minute) >= self.config.requests_per_minute:
                # Attendre jusqu'à ce que la plus ancienne requête sorte de la fenêtre
                oldest_in_minute = min(recent_minute)
                wait_time_minute = 60 - (now - oldest_in_minute) + 0.1  # +0.1 pour sécurité
                wait_times.append(wait_time_minute)
        
        # Limite par heure
        if self.config.requests_per_hour:
            recent_hour = [t for t in request_times if now - t < 3600]
            if len(recent_hour) >= self.config.requests_per_hour:
                oldest_in_hour = min(recent_hour)
                wait_time_hour = 3600 - (now - oldest_in_hour) + 0.1
                wait_times.append(wait_time_hour)
        
        # Limite par jour
        if self.config.requests_per_day:
            recent_day = [t for t in request_times if now - t < 86400]
            if len(recent_day) >= self.config.requests_per_day:
                oldest_in_day = min(recent_day)
                wait_time_day = 86400 - (now - oldest_in_day) + 0.1
                wait_times.append(wait_time_day)
        
        return max(wait_times) if wait_times else 0.0
    
    def _clean_old_requests(self, source_name: Optional[str] = None) -> None:
        """
        Supprime les timestamps trop anciens pour la source donnée.
        
        Args:
            source_name: Nom de la source (si None, utilise self.source_name)
        """
        source = source_name or self.source_name
        now = time.time()
        max_age = 86400  # 24 heures (pour la limite journalière)
        
        request_times = self.request_times[source]
        while request_times and (now - request_times[0]) > max_age:
            request_times.popleft()
    
    def _save_state(self) -> None:
        """Sauvegarde l'état du rate limiter dans un fichier."""
        if not self.persist_state:
            return
        
        try:
            state = {
                source: list(times)
                for source, times in self.request_times.items()
            }
            
            with open(self.state_file, 'w') as f:
                json.dump(state, f)
            
            logger.debug(f"Saved rate limiter state to {self.state_file}")
        except Exception as e:
            logger.warning(f"Failed to save rate limiter state: {e}")
    
    def _load_state(self) -> None:
        """Charge l'état du rate limiter depuis un fichier."""
        if not self.persist_state or not os.path.exists(self.state_file):
            return
        
        try:
            with open(self.state_file, 'r') as f:
                state = json.load(f)
            
            # Convertir les listes en deques et nettoyer les timestamps expirés
            now = time.time()
            max_age = 86400
            
            for source, times in state.items():
                # Filtrer les timestamps expirés
                valid_times = [t for t in times if now - t < max_age]
                if valid_times:
                    self.request_times[source] = deque(valid_times)
            
            logger.info(f"Loaded rate limiter state from {self.state_file}")
        except Exception as e:
            logger.warning(f"Failed to load rate limiter state: {e}")
    
    def get_stats(self, source_name: Optional[str] = None) -> Dict[str, int]:
        """
        Retourne les statistiques d'utilisation pour la source donnée.
        
        Args:
            source_name: Nom de la source (si None, utilise self.source_name)
            
        Returns:
            Dict avec les compteurs pour minute, heure, jour
        """
        source = source_name or self.source_name
        now = time.time()
        request_times = self.request_times[source]
        
        recent_minute = [t for t in request_times if now - t < 60]
        recent_hour = [t for t in request_times if now - t < 3600]
        recent_day = [t for t in request_times if now - t < 86400]
        
        return {
            "requests_last_minute": len(recent_minute),
            "requests_last_hour": len(recent_hour),
            "requests_last_day": len(recent_day),
            "total_requests_tracked": len(request_times)
        }
    
    def reset(self, source_name: Optional[str] = None) -> None:
        """
        Réinitialise les compteurs pour la source donnée.
        
        Args:
            source_name: Nom de la source (si None, réinitialise toutes les sources)
        """
        if source_name:
            self.request_times[source_name] = deque()
            logger.info(f"Reset rate limiter for source '{source_name}'")
        else:
            self.request_times.clear()
            logger.info("Reset all rate limiter counters")
        
        if self.persist_state:
            self._save_state()


class MultiSourceRateLimiter:
    """
    Rate limiter pour gérer plusieurs sources API avec des configurations différentes.
    
    Utile quand on utilise plusieurs APIs avec des quotas différents.
    """
    
    def __init__(self, persist_state: bool = False, state_file: Optional[str] = None):
        """
        Initialise le multi-source rate limiter.
        
        Args:
            persist_state: Si True, persiste l'état entre les runs
            state_file: Chemin du fichier de persistance
        """
        # {source_name: RateLimiter}
        self.limiters: Dict[str, RateLimiter] = {}
        self.persist_state = persist_state
        self.state_file = state_file or ".rate_limiter_state.json"
    
    def add_source(
        self,
        source_name: str,
        config: RateLimitConfig,
        persist_state: Optional[bool] = None
    ) -> None:
        """
        Ajoute une source avec sa configuration.
        
        Args:
            source_name: Nom de la source
            config: Configuration des limites
            persist_state: Si True, persiste l'état (override global)
        """
        persist = persist_state if persist_state is not None else self.persist_state
        self.limiters[source_name] = RateLimiter(
            config=config,
            source_name=source_name,
            persist_state=persist,
            state_file=self.state_file
        )
        logger.info(f"Added rate limiter for source '{source_name}'")
    
    async def acquire(self, source_name: str) -> None:
        """
        Acquiert une requête pour la source donnée.
        
        Args:
            source_name: Nom de la source
            
        Raises:
            KeyError: Si la source n'existe pas
        """
        if source_name not in self.limiters:
            raise KeyError(f"Rate limiter not configured for source '{source_name}'")
        
        await self.limiters[source_name].acquire()
    
    def can_proceed(self, source_name: str) -> bool:
        """
        Vérifie si on peut procéder pour la source donnée.
        
        Args:
            source_name: Nom de la source
            
        Returns:
            True si on peut procéder, False sinon
        """
        if source_name not in self.limiters:
            return True  # Pas de limite si non configuré
        
        return self.limiters[source_name].can_proceed()
    
    def get_stats(self, source_name: Optional[str] = None) -> Dict:
        """
        Retourne les statistiques.
        
        Args:
            source_name: Nom de la source (None = toutes les sources)
            
        Returns:
            Dict des statistiques
        """
        if source_name:
            if source_name not in self.limiters:
                return {}
            return self.limiters[source_name].get_stats()
        else:
            return {
                source: limiter.get_stats()
                for source, limiter in self.limiters.items()
            }

