"""
Collecteur de données concurrents via Apify (scraping Airbnb en temps réel).
"""

import asyncio
import logging
from typing import Dict, List, Optional, Any
from datetime import date, datetime, timedelta
import statistics

try:
    from apify_client import ApifyClient
    APIFY_AVAILABLE = True
except ImportError:
    APIFY_AVAILABLE = False
    logging.warning("Apify client not available. Install with: pip install apify-client")

from .base_collector import BaseCollector
from ..config.api_keys import get_api_key, API_SERVICES

logger = logging.getLogger(__name__)


class CompetitorCollector(BaseCollector):
    """
    Collecteur de données de prix concurrents via Apify (scraping Airbnb).
    
    Utilise Apify Actor "Airbnb Scraper" pour récupérer les prix des concurrents directs
    en temps réel. Alternative à AirDNA pour les données "live".
    
    Stratégie :
    - Scrape les 20 concurrents directs identifiés pour chaque propriété
    - Collecte quotidienne (ou plusieurs fois/jour si nécessaire)
    - Données temps réel : si un concurrent baisse son prix, on le sait immédiatement
    """
    
    # Actor ID par défaut (peut être personnalisé)
    DEFAULT_ACTOR_ID = "airbnb-scraper"  # Ou l'ID spécifique de l'Actor Apify
    
    def __init__(
        self,
        actor_id: Optional[str] = None,
        api_token: Optional[str] = None,
        timeout: int = 300,  # 5 minutes par défaut
        **kwargs
    ):
        """
        Initialise le collecteur de concurrents via Apify.
        
        Args:
            actor_id: ID de l'Actor Apify (défaut: 'airbnb-scraper')
            api_token: Token Apify (si None, récupère depuis env)
            timeout: Timeout en secondes pour attendre la completion d'un run
            **kwargs: Arguments additionnels pour BaseCollector
        """
        api_token = api_token or get_api_key(API_SERVICES.APIFY)
        
        if not api_token:
            logger.warning(
                "No Apify API token found. Set APIFY_API_TOKEN in .env. "
                "Some features will be limited."
            )
        
        self.actor_id = actor_id or self.DEFAULT_ACTOR_ID
        self.timeout = timeout
        self.apify_client = None
        
        if APIFY_AVAILABLE and api_token:
            self.apify_client = ApifyClient(token=api_token)
        
        super().__init__(
            source_name="competitor_apify",
            api_key=api_token,
            **kwargs
        )
        
        logger.info(f"Initialized CompetitorCollector with Apify Actor: {self.actor_id}")
    
    async def collect(
        self,
        property_info: Dict[str, Any],
        date_range: Optional[Dict[str, date]] = None,
        competitor_urls: Optional[List[str]] = None,
        store_in_db: bool = True
    ) -> List[Dict[str, Any]]:
        """
        Collecte les données de concurrents pour une propriété donnée.
        
        Args:
            property_info: Dict avec {
                'city': str,
                'country': str,
                'property_type': str (optionnel),
                'bedrooms': int (optionnel),
                'bathrooms': int (optionnel),
                'location': Dict avec 'latitude' et 'longitude' (optionnel)
            }
            date_range: Dict avec 'start_date' et 'end_date' (optionnel, défaut: +90 jours)
            competitor_urls: Liste des URLs Airbnb des concurrents directs (optionnel)
            store_in_db: Si True, stocke dans Supabase
        
        Returns:
            Liste de données normalisées par date
        """
        if not self.apify_client:
            raise RuntimeError(
                "Apify client not initialized. Provide APIFY_API_TOKEN in .env"
            )
        
        # Définir la plage de dates par défaut (90 jours dans le futur)
        if not date_range:
            today = date.today()
            date_range = {
                'start_date': today,
                'end_date': today + timedelta(days=90)
            }
        
        logger.info(
            f"Collecting competitor data for {property_info.get('city')}, "
            f"{property_info.get('country')} from {date_range['start_date']} "
            f"to {date_range['end_date']}"
        )
        
        # Générer les URLs de recherche si non fournies
        if not competitor_urls:
            competitor_urls = self._generate_search_urls(property_info, date_range)
        
        # Collecter les données via Apify
        raw_data = await self._fetch_data(
            property_info=property_info,
            date_range=date_range,
            competitor_urls=competitor_urls
        )
        
        # Normaliser les données
        normalized_data = self._normalize(
            raw_response=raw_data,
            property_info=property_info,
            date_range=date_range
        )
        
        # Valider et stocker
        if store_in_db:
            validated_data = [
                item for item in normalized_data
                if self._validate(item)
            ]
            
            if validated_data:
                await self._store_raw_data(validated_data)
        
        return normalized_data
    
    async def _fetch_data(
        self,
        property_info: Dict[str, Any],
        date_range: Dict[str, date],
        competitor_urls: List[str]
    ) -> Dict[str, Any]:
        """
        Récupère les données brutes via Apify Actor.
        
        Args:
            property_info: Informations sur la propriété
            date_range: Plage de dates
            competitor_urls: URLs Airbnb des concurrents
        
        Returns:
            Données brutes de l'Actor Apify
        """
        logger.info(f"Triggering Apify Actor {self.actor_id} for {len(competitor_urls)} listings")
        
        # Préparer les paramètres de l'Actor
        actor_input = self._prepare_actor_input(
            property_info=property_info,
            date_range=date_range,
            competitor_urls=competitor_urls
        )
        
        # Déclencher l'Actor
        run_id = await self._trigger_apify_actor(actor_input)
        
        # Attendre la completion
        results = await self._wait_for_apify_completion(run_id)
        
        return results
    
    def _prepare_actor_input(
        self,
        property_info: Dict[str, Any],
        date_range: Dict[str, date],
        competitor_urls: List[str]
    ) -> Dict[str, Any]:
        """
        Prépare les paramètres d'entrée pour l'Actor Apify.
        
        Args:
            property_info: Informations sur la propriété
            date_range: Plage de dates
            competitor_urls: URLs Airbnb
        
        Returns:
            Dict de configuration pour l'Actor
        """
        # Format standard pour Apify Airbnb Scraper
        # Note: Le format exact dépend de l'Actor utilisé
        actor_input = {
            "startUrls": [
                {"url": url} for url in competitor_urls[:20]  # Limiter à 20
            ],
            # Options de scraping
            "maxItems": 20,
            "extendOutputFunction": None,
            "extendScraperFunction": None,
            # Dates
            "checkInDate": date_range['start_date'].isoformat(),
            "checkOutDate": date_range['end_date'].isoformat(),
            # Options additionnelles
            "proxy": {
                "useApifyProxy": True
            }
        }
        
        return actor_input
    
    async def _trigger_apify_actor(self, actor_input: Dict[str, Any]) -> str:
        """
        Déclenche l'exécution de l'Actor Apify.
        
        Args:
            actor_input: Paramètres d'entrée pour l'Actor
        
        Returns:
            ID du run Apify
        """
        if not self.apify_client:
            raise RuntimeError("Apify client not initialized")
        
        logger.info(f"Starting Apify Actor run for {self.actor_id}")
        
        try:
            # Exécuter l'Actor de manière asynchrone
            run = self.apify_client.actor(self.actor_id).call(run_input=actor_input)
            run_id = run['id']
            
            logger.info(f"Apify Actor run started: {run_id}")
            return run_id
            
        except Exception as e:
            logger.error(f"Error triggering Apify Actor: {e}")
            raise RuntimeError(f"Failed to trigger Apify Actor: {e}") from e
    
    async def _wait_for_apify_completion(
        self,
        run_id: str,
        timeout: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        Attend la completion d'un run Apify et récupère les résultats.
        
        Args:
            run_id: ID du run Apify
            timeout: Timeout en secondes (défaut: self.timeout)
        
        Returns:
            Résultats du scraping
        """
        if not self.apify_client:
            raise RuntimeError("Apify client not initialized")
        
        timeout = timeout or self.timeout
        start_time = datetime.now()
        check_interval = 5  # Vérifier toutes les 5 secondes
        
        logger.info(f"Waiting for Apify run {run_id} to complete (timeout: {timeout}s)")
        
        while True:
            # Vérifier le temps écoulé
            elapsed = (datetime.now() - start_time).total_seconds()
            if elapsed > timeout:
                raise TimeoutError(
                    f"Apify run {run_id} timed out after {timeout}s"
                )
            
            # Vérifier le statut du run
            run_status = self.apify_client.run(run_id).get()
            status = run_status['status']
            
            logger.debug(f"Apify run {run_id} status: {status}")
            
            if status == 'SUCCEEDED':
                # Récupérer les résultats
                dataset_items = list(
                    self.apify_client.dataset(run_status['defaultDatasetId']).iterate_items()
                )
                
                logger.info(
                    f"Apify run {run_id} completed successfully. "
                    f"Retrieved {len(dataset_items)} items"
                )
                
                return {
                    "run_id": run_id,
                    "status": status,
                    "items": dataset_items,
                    "metadata": {
                        "started_at": run_status.get('startedAt'),
                        "finished_at": run_status.get('finishedAt'),
                        "stats": run_status.get('stats', {}),
                    }
                }
            
            elif status in ['FAILED', 'ABORTED', 'TIMED-OUT']:
                error_message = run_status.get('defaultDatasetId')
                raise RuntimeError(
                    f"Apify run {run_id} failed with status {status}: {error_message}"
                )
            
            # Attendre avant de revérifier
            await asyncio.sleep(check_interval)
    
    def _normalize(
        self,
        raw_response: Dict[str, Any],
        property_info: Dict[str, Any],
        date_range: Dict[str, date]
    ) -> List[Dict[str, Any]]:
        """
        Normalise les données brutes Apify vers le schéma raw_competitor_data.
        
        Args:
            raw_response: Réponse brute de l'Actor Apify
            property_info: Informations sur la propriété
            date_range: Plage de dates
        
        Returns:
            Liste de données normalisées (une par date)
        """
        logger.info("Normalizing Apify scraping results")
        
        items = raw_response.get('items', [])
        if not items:
            logger.warning("No items returned from Apify scraping")
            return []
        
        # Extraire les prix par date depuis chaque listing
        prices_by_date: Dict[date, List[float]] = {}
        
        for item in items:
            # Le format exact dépend de l'Actor Apify utilisé
            # Exemple de structure attendue :
            # {
            #   'url': 'https://airbnb.com/rooms/...',
            #   'title': '...',
            #   'pricing': {
            #     'price': 150.0,
            #     'currency': 'EUR',
            #     'date': '2024-01-15',
            #     ...
            #   },
            #   'bedrooms': 2,
            #   'bathrooms': 1,
            #   ...
            # }
            
            pricing_info = item.get('pricing') or item.get('priceDetails') or {}
            
            # Extraire le prix (peut être dans différents champs selon l'Actor)
            price = None
            if isinstance(pricing_info, dict):
                price = pricing_info.get('price') or pricing_info.get('amount')
            elif isinstance(pricing_info, (int, float)):
                price = pricing_info
            
            # Extraire la date
            data_date_str = pricing_info.get('date') or item.get('checkInDate')
            if not data_date_str:
                continue
            
            try:
                data_date = datetime.fromisoformat(data_date_str.replace('Z', '+00:00')).date()
            except (ValueError, AttributeError):
                # Essayer un autre format
                try:
                    data_date = datetime.strptime(data_date_str, '%Y-%m-%d').date()
                except ValueError:
                    logger.warning(f"Could not parse date: {data_date_str}")
                    continue
            
            # Extraire la devise
            currency = pricing_info.get('currency') or item.get('currency') or 'EUR'
            
            # Convertir le prix en float
            if price is not None:
                try:
                    price_float = float(price)
                    if data_date not in prices_by_date:
                        prices_by_date[data_date] = []
                    prices_by_date[data_date].append({
                        'price': price_float,
                        'currency': currency,
                        'listing': item
                    })
                except (ValueError, TypeError):
                    logger.warning(f"Could not convert price to float: {price}")
        
        # Calculer les statistiques par date
        normalized_records = []
        
        for data_date, price_data in prices_by_date.items():
            if not price_data:
                continue
            
            # Extraire les prix et convertir en devise de base (EUR)
            prices = []
            for pd in price_data:
                price = pd['price']
                currency = pd['currency']
                
                # TODO: Convertir en EUR via currency_converter
                # Pour l'instant, on assume que tous les prix sont déjà en EUR
                # ou on les garde dans leur devise originale
                if currency.upper() != 'EUR':
                    logger.warning(
                        f"Price in {currency} not converted to EUR. "
                        "Currency conversion not yet implemented."
                    )
                
                prices.append(price)
            
            if not prices:
                continue
            
            # Calculer les statistiques
            prices_sorted = sorted(prices)
            n = len(prices_sorted)
            
            record = {
                'source': 'apify',
                'country': property_info.get('country', ''),
                'city': property_info.get('city', ''),
                'neighborhood': property_info.get('neighborhood'),  # Si disponible
                'property_type': property_info.get('property_type'),
                'bedrooms': property_info.get('bedrooms'),
                'bathrooms': property_info.get('bathrooms'),
                'data_date': data_date.isoformat(),
                'collected_at': datetime.now().isoformat(),
                'raw_data': {
                    'apify_run_id': raw_response.get('run_id'),
                    'items_count': len(items),
                    'price_data': price_data[:10]  # Garder un échantillon
                },
                'avg_price': statistics.mean(prices),
                'min_price': min(prices),
                'max_price': max(prices),
                'p25_price': statistics.quantiles(prices, n=4)[0] if n >= 4 else prices_sorted[0],
                'p50_price': statistics.median(prices),
                'p75_price': statistics.quantiles(prices, n=4)[2] if n >= 4 else prices_sorted[-1],
                'sample_size': n,
                'currency': 'EUR',  # Après conversion
                'timezone': property_info.get('timezone'),  # Si disponible
                'metadata': {
                    'actor_id': self.actor_id,
                    'competitor_count': len(price_data),
                    'scraping_date': datetime.now().isoformat(),
                }
            }
            
            normalized_records.append(record)
        
        logger.info(
            f"Normalized {len(normalized_records)} date records from "
            f"{len(items)} scraped listings"
        )
        
        return normalized_records
    
    def _generate_search_urls(
        self,
        property_info: Dict[str, Any],
        date_range: Dict[str, date]
    ) -> List[str]:
        """
        Génère des URLs de recherche Airbnb pour trouver les concurrents.
        
        Note: Cette méthode génère des URLs de recherche génériques.
        Idéalement, les URLs des 20 concurrents directs devraient être fournies
        manuellement ou identifiées via une autre méthode (ex: recherche manuelle,
        base de données existante, etc.).
        
        Args:
            property_info: Informations sur la propriété
            date_range: Plage de dates
        
        Returns:
            Liste d'URLs Airbnb
        """
        city = property_info.get('city', '')
        country = property_info.get('country', '')
        bedrooms = property_info.get('bedrooms')
        
        # Construire une URL de recherche Airbnb
        # Format: https://www.airbnb.com/s/[city]--[country]/homes?...
        search_params = {
            'checkin': date_range['start_date'].isoformat(),
            'checkout': date_range['end_date'].isoformat(),
        }
        
        if bedrooms:
            search_params['bedrooms'] = bedrooms
        
        # Construire l'URL
        location_slug = f"{city}--{country}".replace(' ', '-').lower()
        query_string = '&'.join([f"{k}={v}" for k, v in search_params.items()])
        
        url = f"https://www.airbnb.com/s/{location_slug}/homes?{query_string}"
        
        logger.warning(
            f"Generated generic search URL: {url}. "
            "For best results, provide specific competitor URLs in competitor_urls parameter."
        )
        
        # Retourner une seule URL de recherche pour l'instant
        # En production, cette méthode devrait identifier les 20 meilleurs concurrents
        return [url]
    
    def _validate(self, data: Dict[str, Any]) -> bool:
        """
        Valide les données normalisées.
        
        Args:
            data: Données à valider
        
        Returns:
            True si valides, False sinon
        """
        required_fields = ['source', 'country', 'city', 'data_date', 'avg_price']
        
        for field in required_fields:
            if field not in data:
                logger.warning(f"Missing required field: {field}")
                return False
        
        # Valider que le prix est positif
        if data.get('avg_price', 0) <= 0:
            logger.warning(f"Invalid avg_price: {data.get('avg_price')}")
            return False
        
        # Valider la date
        try:
            datetime.fromisoformat(data['data_date'])
        except (ValueError, KeyError):
            logger.warning(f"Invalid date: {data.get('data_date')}")
            return False
        
        return True
