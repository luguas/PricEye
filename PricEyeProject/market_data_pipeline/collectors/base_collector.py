"""
Classe abstraite de base pour tous les collecteurs.
"""

import asyncio
import logging
from abc import ABC, abstractmethod
from typing import Dict, List, Optional, Any, Callable
from datetime import datetime, date
import aiohttp
import json

from ..config.settings import Settings
from .rate_limiter import RateLimiter

logger = logging.getLogger(__name__)

# Import conditionnel de Supabase
try:
    from supabase import create_client, Client
    SUPABASE_AVAILABLE = True
except ImportError:
    SUPABASE_AVAILABLE = False
    logger.warning("Supabase client not available, storage will be skipped")


class BaseCollector(ABC):
    """
    Classe abstraite pour tous les collecteurs de données marché.
    
    Cette classe définit l'interface commune et gère :
    - Rate limiting
    - Retries avec exponential backoff
    - Validation des données
    - Stockage dans Supabase
    - Gestion des erreurs
    """
    
    def __init__(
        self,
        source_name: str,
        api_key: Optional[str] = None,
        rate_limiter: Optional[RateLimiter] = None,
        settings: Optional[Settings] = None
    ):
        """
        Initialise le collecteur.
        
        Args:
            source_name: Nom de la source (ex: 'airdna', 'openweather')
            api_key: Clé API pour cette source
            rate_limiter: Instance de RateLimiter
            settings: Configuration globale
        """
        self.source_name = source_name
        self.api_key = api_key
        self.rate_limiter = rate_limiter
        self.settings = settings or Settings.from_env()
        self.session: Optional[aiohttp.ClientSession] = None
        self._supabase_client: Optional[Any] = None  # Client Supabase (lazy init)
        
        logger.info(f"Initialized collector: {source_name}")
    
    async def __aenter__(self):
        """Context manager entry."""
        self.session = aiohttp.ClientSession()
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit."""
        if self.session:
            await self.session.close()
    
    async def collect(
        self,
        date_range: Optional[Dict[str, date]] = None,
        locations: Optional[List[Dict[str, str]]] = None,
        store_in_db: bool = True
    ) -> List[Dict[str, Any]]:
        """
        Collecte les données depuis la source API.
        
        Args:
            date_range: Dict avec 'start_date' et 'end_date'
            locations: Liste de dicts avec 'country' et 'city'
            store_in_db: Si True, stocke les données dans Supabase
            
        Returns:
            Liste de données collectées et normalisées
        """
        if not self.session:
            self.session = aiohttp.ClientSession()
        
        try:
            # Rate limiting
            if self.rate_limiter:
                await self.rate_limiter.acquire()
            
            # Collecte des données avec retry (méthode abstraite)
            raw_data = await self._retry_with_backoff(
                self._fetch_data,
                max_retries=self.settings.max_retries,
                date_range=date_range,
                locations=locations
            )
            
            # Normalisation - peut retourner une liste ou un dict
            normalized_result = self._normalize(raw_data)
            
            # S'assurer que c'est une liste
            if isinstance(normalized_result, dict):
                normalized_data_list = [normalized_result]
            elif isinstance(normalized_result, list):
                normalized_data_list = normalized_result
            else:
                raise ValueError(f"Normalize must return dict or list, got {type(normalized_result)}")
            
            # Valider chaque élément
            validated_data = []
            for item in normalized_data_list:
                if self._validate(item):
                    validated_data.append(item)
                else:
                    logger.warning(f"Validation failed for item in {self.source_name}: {item}")
            
            if not validated_data:
                raise ValueError(f"No valid data after validation for {self.source_name}")
            
            # Stockage dans Supabase si demandé
            if store_in_db:
                await self._store_raw_data(validated_data)
            
            logger.info(f"Successfully collected {len(validated_data)} records from {self.source_name}")
            return validated_data
            
        except aiohttp.ClientResponseError as e:
            if e.status == 429:
                logger.error(f"Rate limit exceeded for {self.source_name}")
                raise RuntimeError(f"Rate limit exceeded for {self.source_name}: {e.message}")
            elif e.status >= 500:
                logger.error(f"Server error for {self.source_name}: {e.status}")
                raise RuntimeError(f"Server error {e.status} for {self.source_name}")
            else:
                logger.error(f"HTTP error for {self.source_name}: {e.status} - {e.message}")
                raise
        except Exception as e:
            logger.error(f"Error collecting data from {self.source_name}: {e}", exc_info=True)
            raise
        finally:
            if self.session and not hasattr(self, '_keep_session'):
                await self.session.close()
    
    @abstractmethod
    async def _fetch_data(
        self,
        date_range: Optional[Dict[str, date]] = None,
        locations: Optional[List[Dict[str, str]]] = None
    ) -> Dict[str, Any]:
        """
        Récupère les données brutes depuis l'API.
        
        Args:
            date_range: Plage de dates
            locations: Liste de localisations
            
        Returns:
            Données brutes de l'API
        """
        pass
    
    @abstractmethod
    def _normalize(self, raw_response: Dict[str, Any]) -> Dict[str, Any]:
        """
        Normalise les données brutes vers le schéma commun.
        
        Args:
            raw_response: Réponse brute de l'API
            
        Returns:
            Données normalisées
        """
        pass
    
    def _validate(self, data: Dict[str, Any]) -> bool:
        """
        Valide les données collectées.
        
        Args:
            data: Données à valider
            
        Returns:
            True si valides, False sinon
        """
        # Validation basique par défaut
        return data is not None and isinstance(data, dict)
    
    async def _retry_with_backoff(
        self,
        func: Callable,
        max_retries: Optional[int] = None,
        *args,
        **kwargs
    ) -> Any:
        """
        Réessaye une fonction avec exponential backoff.
        
        Gère intelligemment les erreurs HTTP :
        - 429 (Rate Limit) : Attend plus longtemps
        - 5xx (Server Error) : Retry avec backoff
        - 4xx (Client Error) : Pas de retry (erreur client)
        
        Args:
            func: Fonction à exécuter (doit être async)
            max_retries: Nombre maximum de tentatives (None = utiliser settings)
            *args, **kwargs: Arguments à passer à la fonction
            
        Returns:
            Résultat de la fonction
            
        Raises:
            Exception si toutes les tentatives échouent
        """
        if max_retries is None:
            max_retries = self.settings.max_retries
        
        backoff_factor = self.settings.retry_backoff_factor
        
        for attempt in range(max_retries):
            try:
                return await func(*args, **kwargs)
            except aiohttp.ClientResponseError as e:
                # Ne pas retry sur erreurs 4xx (sauf 429)
                if 400 <= e.status < 500 and e.status != 429:
                    logger.error(
                        f"Client error {e.status} for {self.source_name}: {e.message}. "
                        "Not retrying."
                    )
                    raise
                
                # Retry sur 429 et 5xx
                if attempt == max_retries - 1:
                    raise
                
                # Backoff plus long pour rate limits
                if e.status == 429:
                    wait_time = backoff_factor ** attempt * 2  # Double le temps pour rate limits
                    logger.warning(
                        f"Rate limit hit for {self.source_name} (attempt {attempt + 1}/{max_retries}), "
                        f"waiting {wait_time}s..."
                    )
                else:
                    wait_time = backoff_factor ** attempt
                    logger.warning(
                        f"Server error {e.status} for {self.source_name} (attempt {attempt + 1}/{max_retries}), "
                        f"retrying in {wait_time}s: {e.message}"
                    )
                
                await asyncio.sleep(wait_time)
                
            except (aiohttp.ClientError, asyncio.TimeoutError) as e:
                # Retry sur erreurs réseau/timeout
                if attempt == max_retries - 1:
                    raise
                
                wait_time = backoff_factor ** attempt
                logger.warning(
                    f"Network error for {self.source_name} (attempt {attempt + 1}/{max_retries}), "
                    f"retrying in {wait_time}s: {e}"
                )
                await asyncio.sleep(wait_time)
                
            except Exception as e:
                # Autres erreurs - retry selon la nature
                if attempt == max_retries - 1:
                    raise
                
                wait_time = backoff_factor ** attempt
                logger.warning(
                    f"Error for {self.source_name} (attempt {attempt + 1}/{max_retries}), "
                    f"retrying in {wait_time}s: {e}"
                )
                await asyncio.sleep(wait_time)
    
    async def _store_raw_data(self, data: List[Dict[str, Any]]) -> None:
        """
        Stocke les données brutes dans Supabase.
        
        Détermine automatiquement la table selon source_name :
        - competitor_* → raw_competitor_data
        - weather_* → raw_weather_data
        - events_* → raw_events_data
        - news_* → raw_news_data
        - trends_* → raw_market_trends_data
        
        Args:
            data: Liste de données à stocker (doivent correspondre au schéma de la table)
        """
        if not SUPABASE_AVAILABLE:
            logger.warning("Supabase not available, skipping storage")
            return
        
        if not data:
            logger.warning(f"No data to store for {self.source_name}")
            return
        
        try:
            # Créer client Supabase si pas déjà fait
            if not hasattr(self, '_supabase_client') or self._supabase_client is None:
                self._supabase_client = create_client(
                    self.settings.supabase_url,
                    self.settings.supabase_key
                )
            
            # Vérifier la configuration Supabase
            if not self.settings.supabase_url or not self.settings.supabase_key:
                logger.warning("Supabase URL or key not configured, skipping storage")
                return
            
            # Déterminer la table selon source_name
            table_name = self._get_table_name()
            
            if not table_name:
                logger.warning(f"Unknown table for source {self.source_name}, skipping storage")
                return
            
            # Préparer les données pour insertion
            records_to_insert = []
            for record in data:
                record_copy = record.copy()
                
                # S'assurer que raw_data est en JSONB (Supabase accepte dict directement)
                if 'raw_data' in record_copy:
                    if isinstance(record_copy['raw_data'], str):
                        try:
                            record_copy['raw_data'] = json.loads(record_copy['raw_data'])
                        except json.JSONDecodeError:
                            pass  # Garder la string si pas JSON valide
                    # Si c'est déjà un dict, Supabase le convertira en JSONB
                
                # Convertir les dates en strings ISO
                for key, value in record_copy.items():
                    if isinstance(value, date):
                        record_copy[key] = value.isoformat()
                    elif isinstance(value, datetime):
                        record_copy[key] = value.isoformat()
                
                # Ajouter collected_at si manquant
                if 'collected_at' not in record_copy:
                    record_copy['collected_at'] = datetime.now().isoformat()
                
                records_to_insert.append(record_copy)
            
            # Insert avec upsert
            # Note: Le client Supabase Python est synchrone, on l'exécute dans un thread pool
            # pour ne pas bloquer l'event loop
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(
                None,
                lambda: self._supabase_client.table(table_name).upsert(
                    records_to_insert
                ).execute()
            )
            
            # Vérifier les erreurs
            if hasattr(response, 'error') and response.error:
                raise Exception(f"Supabase error: {response.error}")
            
            logger.info(
                f"Stored {len(records_to_insert)} records for {self.source_name} "
                f"in table {table_name}"
            )
            
        except Exception as e:
            logger.error(
                f"Error storing data for {self.source_name} in Supabase: {e}",
                exc_info=True
            )
            # Ne pas faire échouer la collecte si le stockage échoue
            # (on peut reprocesser plus tard)
    
    def _get_table_name(self) -> Optional[str]:
        """
        Détermine le nom de la table Supabase selon source_name.
        
        Returns:
            Nom de la table ou None si inconnu
        """
        source_lower = self.source_name.lower()
        
        if 'competitor' in source_lower:
            return 'raw_competitor_data'
        elif 'weather' in source_lower:
            return 'raw_weather_data'
        elif 'event' in source_lower:
            return 'raw_events_data'
        elif 'news' in source_lower:
            return 'raw_news_data'
        elif 'trend' in source_lower:
            return 'raw_market_trends_data'
        
        return None
    
    async def _make_request(
        self,
        method: str,
        url: str,
        headers: Optional[Dict[str, str]] = None,
        params: Optional[Dict[str, Any]] = None,
        json_data: Optional[Dict[str, Any]] = None,
        timeout: int = 30
    ) -> Dict[str, Any]:
        """
        Effectue une requête HTTP avec gestion d'erreurs.
        
        Args:
            method: Méthode HTTP ('GET', 'POST', etc.)
            url: URL complète
            headers: Headers HTTP
            params: Query parameters
            json_data: JSON body (pour POST/PUT)
            timeout: Timeout en secondes
            
        Returns:
            Réponse JSON parsée
            
        Raises:
            aiohttp.ClientResponseError: Pour erreurs HTTP
            aiohttp.ClientError: Pour erreurs réseau
        """
        if not self.session:
            self.session = aiohttp.ClientSession()
        
        request_headers = headers or {}
        if self.api_key and 'Authorization' not in request_headers:
            request_headers['Authorization'] = f'Bearer {self.api_key}'
        
        timeout_obj = aiohttp.ClientTimeout(total=timeout)
        
        try:
            async with self.session.request(
                method=method,
                url=url,
                headers=request_headers,
                params=params,
                json=json_data,
                timeout=timeout_obj
            ) as response:
                # Gérer les erreurs HTTP
                response.raise_for_status()
                
                # Parser JSON
                try:
                    return await response.json()
                except aiohttp.ContentTypeError:
                    # Si pas JSON, retourner le texte
                    text = await response.text()
                    logger.warning(f"Non-JSON response from {url}: {text[:200]}")
                    return {"raw_response": text}
                    
        except aiohttp.ClientResponseError as e:
            logger.error(f"HTTP {e.status} error for {url}: {e.message}")
            raise
        except asyncio.TimeoutError:
            logger.error(f"Timeout for {url}")
            raise

