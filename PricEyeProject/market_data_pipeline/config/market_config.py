"""
Gestion de la configuration par pays pour le pipeline marché.
"""

import asyncio
import logging
from typing import Dict, List, Optional, Any
from dataclasses import dataclass, asdict

try:
    from supabase import create_client, Client
    SUPABASE_AVAILABLE = True
except ImportError:
    SUPABASE_AVAILABLE = False
    logging.warning("Supabase client not available")

from .settings import Settings

logger = logging.getLogger(__name__)


# Configuration par défaut si pas de config en DB
DEFAULT_CONFIGS = {
    'FR': {
        'default_currency': 'EUR',
        'default_timezone': 'Europe/Paris',
        'primary_language': 'fr',
        'supported_languages': ['fr', 'en'],
        'competitor_api_source': 'apify',  # Live scraping
        'competitor_api_fallback': 'historical_csv_airdna',  # Historical
        'weather_api_source': 'openweather',
        'weather_api_fallback': 'weatherapi',
        'events_api_source': 'eventbrite',
        'events_api_fallback': 'google',
        'news_api_source': 'newsapi',
        'news_api_fallback': 'google_news_rss',
        'trends_api_source': 'google_trends',
        'trends_api_fallback': 'internal_aggregation',
        'collection_enabled': True,
        'collection_frequency': 'daily'
    },
    'US': {
        'default_currency': 'USD',
        'default_timezone': 'America/New_York',
        'primary_language': 'en',
        'supported_languages': ['en'],
        'competitor_api_source': 'apify',
        'competitor_api_fallback': 'historical_csv_airdna',
        'weather_api_source': 'openweather',
        'weather_api_fallback': 'weatherapi',
        'events_api_source': 'eventbrite',
        'events_api_fallback': 'google',
        'news_api_source': 'newsapi',
        'news_api_fallback': 'google_news_rss',
        'trends_api_source': 'google_trends',
        'trends_api_fallback': 'internal_aggregation',
        'collection_enabled': True,
        'collection_frequency': 'daily'
    },
    'GB': {
        'default_currency': 'GBP',
        'default_timezone': 'Europe/London',
        'primary_language': 'en',
        'supported_languages': ['en'],
        'competitor_api_source': 'apify',
        'competitor_api_fallback': 'historical_csv_airdna',
        'weather_api_source': 'openweather',
        'weather_api_fallback': 'weatherapi',
        'events_api_source': 'eventbrite',
        'events_api_fallback': 'google',
        'news_api_source': 'newsapi',
        'news_api_fallback': 'google_news_rss',
        'trends_api_source': 'google_trends',
        'trends_api_fallback': 'internal_aggregation',
        'collection_enabled': True,
        'collection_frequency': 'daily'
    },
    'ES': {
        'default_currency': 'EUR',
        'default_timezone': 'Europe/Madrid',
        'primary_language': 'es',
        'supported_languages': ['es', 'en'],
        'competitor_api_source': 'apify',
        'competitor_api_fallback': 'historical_csv_airdna',
        'weather_api_source': 'openweather',
        'weather_api_fallback': 'weatherapi',
        'events_api_source': 'eventbrite',
        'events_api_fallback': 'google',
        'news_api_source': 'newsapi',
        'news_api_fallback': 'google_news_rss',
        'trends_api_source': 'google_trends',
        'trends_api_fallback': 'internal_aggregation',
        'collection_enabled': True,
        'collection_frequency': 'daily'
    },
    'IT': {
        'default_currency': 'EUR',
        'default_timezone': 'Europe/Rome',
        'primary_language': 'it',
        'supported_languages': ['it', 'en'],
        'competitor_api_source': 'apify',
        'competitor_api_fallback': 'historical_csv_airdna',
        'weather_api_source': 'openweather',
        'weather_api_fallback': 'weatherapi',
        'events_api_source': 'eventbrite',
        'events_api_fallback': 'google',
        'news_api_source': 'newsapi',
        'news_api_fallback': 'google_news_rss',
        'trends_api_source': 'google_trends',
        'trends_api_fallback': 'internal_aggregation',
        'collection_enabled': True,
        'collection_frequency': 'daily'
    },
    'DE': {
        'default_currency': 'EUR',
        'default_timezone': 'Europe/Berlin',
        'primary_language': 'de',
        'supported_languages': ['de', 'en'],
        'competitor_api_source': 'apify',
        'competitor_api_fallback': 'historical_csv_airdna',
        'weather_api_source': 'openweather',
        'weather_api_fallback': 'weatherapi',
        'events_api_source': 'eventbrite',
        'events_api_fallback': 'google',
        'news_api_source': 'newsapi',
        'news_api_fallback': 'google_news_rss',
        'trends_api_source': 'google_trends',
        'trends_api_fallback': 'internal_aggregation',
        'collection_enabled': True,
        'collection_frequency': 'daily'
    },
    'PT': {
        'default_currency': 'EUR',
        'default_timezone': 'Europe/Lisbon',
        'primary_language': 'pt',
        'supported_languages': ['pt', 'en'],
        'competitor_api_source': 'apify',
        'competitor_api_fallback': 'historical_csv_airdna',
        'weather_api_source': 'openweather',
        'weather_api_fallback': 'weatherapi',
        'events_api_source': 'eventbrite',
        'events_api_fallback': 'google',
        'news_api_source': 'newsapi',
        'news_api_fallback': 'google_news_rss',
        'trends_api_source': 'google_trends',
        'trends_api_fallback': 'internal_aggregation',
        'collection_enabled': True,
        'collection_frequency': 'daily'
    },
    'GR': {
        'default_currency': 'EUR',
        'default_timezone': 'Europe/Athens',
        'primary_language': 'el',
        'supported_languages': ['el', 'en'],
        'competitor_api_source': 'apify',
        'competitor_api_fallback': 'historical_csv_airdna',
        'weather_api_source': 'openweather',
        'weather_api_fallback': 'weatherapi',
        'events_api_source': 'eventbrite',
        'events_api_fallback': 'google',
        'news_api_source': 'newsapi',
        'news_api_fallback': 'google_news_rss',
        'trends_api_source': 'google_trends',
        'trends_api_fallback': 'internal_aggregation',
        'collection_enabled': True,
        'collection_frequency': 'daily'
    },
    'NL': {
        'default_currency': 'EUR',
        'default_timezone': 'Europe/Amsterdam',
        'primary_language': 'nl',
        'supported_languages': ['nl', 'en'],
        'competitor_api_source': 'apify',
        'competitor_api_fallback': 'historical_csv_airdna',
        'weather_api_source': 'openweather',
        'weather_api_fallback': 'weatherapi',
        'events_api_source': 'eventbrite',
        'events_api_fallback': 'google',
        'news_api_source': 'newsapi',
        'news_api_fallback': 'google_news_rss',
        'trends_api_source': 'google_trends',
        'trends_api_fallback': 'internal_aggregation',
        'collection_enabled': True,
        'collection_frequency': 'daily'
    },
    'CA': {
        'default_currency': 'CAD',
        'default_timezone': 'America/Toronto',
        'primary_language': 'en',
        'supported_languages': ['en', 'fr'],
        'competitor_api_source': 'apify',
        'competitor_api_fallback': 'historical_csv_airdna',
        'weather_api_source': 'openweather',
        'weather_api_fallback': 'weatherapi',
        'events_api_source': 'eventbrite',
        'events_api_fallback': 'google',
        'news_api_source': 'newsapi',
        'news_api_fallback': 'google_news_rss',
        'trends_api_source': 'google_trends',
        'trends_api_fallback': 'internal_aggregation',
        'collection_enabled': True,
        'collection_frequency': 'daily'
    },
    'AU': {
        'default_currency': 'AUD',
        'default_timezone': 'Australia/Sydney',
        'primary_language': 'en',
        'supported_languages': ['en'],
        'competitor_api_source': 'apify',
        'competitor_api_fallback': 'historical_csv_airdna',
        'weather_api_source': 'openweather',
        'weather_api_fallback': 'weatherapi',
        'events_api_source': 'eventbrite',
        'events_api_fallback': 'google',
        'news_api_source': 'newsapi',
        'news_api_fallback': 'google_news_rss',
        'trends_api_source': 'google_trends',
        'trends_api_fallback': 'internal_aggregation',
        'collection_enabled': True,
        'collection_frequency': 'daily'
    }
}


@dataclass
class MarketConfig:
    """
    Configuration de marché pour un pays donné.
    """
    
    country: str
    default_currency: str
    default_timezone: str
    primary_language: str
    supported_languages: List[str]
    
    # Sources API
    competitor_api_source: Optional[str] = None
    competitor_api_fallback: Optional[str] = None
    weather_api_source: Optional[str] = 'openweather'
    weather_api_fallback: Optional[str] = None
    events_api_source: Optional[str] = None
    events_api_fallback: Optional[str] = None
    news_api_source: Optional[str] = None
    news_api_fallback: Optional[str] = None
    trends_api_source: Optional[str] = None
    trends_api_fallback: Optional[str] = None
    
    # Configuration collecte
    collection_enabled: bool = True
    collection_frequency: str = 'daily'
    cities_priority: Optional[List[str]] = None
    
    # Métadonnées
    notes: Optional[str] = None
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "MarketConfig":
        """Crée une instance depuis un dict."""
        # Filtrer les clés valides
        valid_keys = {f.name for f in cls.__dataclass_fields__.values()}
        filtered_data = {k: v for k, v in data.items() if k in valid_keys}
        return cls(**filtered_data)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convertit en dict."""
        return asdict(self)


class MarketConfigManager:
    """
    Gestionnaire de configuration par pays.
    
    Charge la config depuis Supabase avec fallback vers DEFAULT_CONFIGS.
    """
    
    def __init__(self, settings: Optional[Settings] = None):
        """
        Initialise le gestionnaire de configuration.
        
        Args:
            settings: Configuration globale (si None, charge depuis env)
        """
        self.settings = settings or Settings.from_env()
        self._supabase_client: Optional[Client] = None
        self._cache: Dict[str, MarketConfig] = {}
        
        logger.info("Initialized MarketConfigManager")
    
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
    
    async def get_config(self, country: str) -> MarketConfig:
        """
        Récupère la configuration pour un pays.
        
        Args:
            country: Code pays (ISO 3166-1 alpha-2)
            
        Returns:
            Configuration du pays
        """
        country_upper = country.upper()
        
        # Vérifier le cache
        if country_upper in self._cache:
            return self._cache[country_upper]
        
        # Essayer de charger depuis Supabase
        supabase_client = self._get_supabase_client()
        if supabase_client:
            try:
                loop = asyncio.get_event_loop()
                
                response = await loop.run_in_executor(
                    None,
                    lambda: supabase_client.table('market_config')
                        .select('*')
                        .eq('country', country_upper)
                        .maybe_single()
                        .execute()
                )
                
                if response.data:
                    config = MarketConfig.from_dict(response.data)
                    self._cache[country_upper] = config
                    logger.info(f"Loaded market config for {country_upper} from database")
                    return config
            
            except Exception as e:
                logger.warning(f"Error loading config from database for {country_upper}: {e}")
        
        # Fallback vers configuration par défaut
        if country_upper in DEFAULT_CONFIGS:
            config = MarketConfig.from_dict({
                'country': country_upper,
                **DEFAULT_CONFIGS[country_upper]
            })
            self._cache[country_upper] = config
            logger.info(f"Using default config for {country_upper}")
            return config
        
        # Si pas de config par défaut, créer une config minimale
        logger.warning(f"No config found for {country_upper}, using minimal defaults")
        config = MarketConfig(
            country=country_upper,
            default_currency='EUR',
            default_timezone='UTC',
            primary_language='en',
            supported_languages=['en']
        )
        self._cache[country_upper] = config
        return config
    
    def get_config_sync(self, country: str) -> MarketConfig:
        """
        Récupère la configuration pour un pays (version synchrone).
        
        Args:
            country: Code pays
            
        Returns:
            Configuration du pays
        """
        country_upper = country.upper()
        
        # Vérifier le cache
        if country_upper in self._cache:
            return self._cache[country_upper]
        
        # Essayer de charger depuis Supabase (synchrone)
        supabase_client = self._get_supabase_client()
        if supabase_client:
            try:
                response = supabase_client.table('market_config')\
                    .select('*')\
                    .eq('country', country_upper)\
                    .maybe_single()\
                    .execute()
                
                if response.data:
                    config = MarketConfig.from_dict(response.data)
                    self._cache[country_upper] = config
                    logger.info(f"Loaded market config for {country_upper} from database")
                    return config
            
            except Exception as e:
                logger.warning(f"Error loading config from database for {country_upper}: {e}")
        
        # Fallback vers configuration par défaut
        if country_upper in DEFAULT_CONFIGS:
            config = MarketConfig.from_dict({
                'country': country_upper,
                **DEFAULT_CONFIGS[country_upper]
            })
            self._cache[country_upper] = config
            logger.info(f"Using default config for {country_upper}")
            return config
        
        # Si pas de config par défaut, créer une config minimale
        logger.warning(f"No config found for {country_upper}, using minimal defaults")
        config = MarketConfig(
            country=country_upper,
            default_currency='EUR',
            default_timezone='UTC',
            primary_language='en',
            supported_languages=['en']
        )
        self._cache[country_upper] = config
        return config
    
    def get_api_source(
        self,
        country: str,
        data_type: str,
        use_primary: bool = True
    ) -> Optional[str]:
        """
        Récupère la source API à utiliser pour un type de données.
        
        Args:
            country: Code pays
            data_type: Type de données ('competitor', 'weather', 'events', 'news', 'trends')
            use_primary: Si True, retourne la source primaire, sinon le fallback
            
        Returns:
            Nom de la source API ou None
        """
        config = self.get_config_sync(country)
        
        data_type_lower = data_type.lower()
        
        if use_primary:
            if data_type_lower == 'competitor':
                return config.competitor_api_source
            elif data_type_lower == 'weather':
                return config.weather_api_source
            elif data_type_lower == 'events':
                return config.events_api_source
            elif data_type_lower == 'news':
                return config.news_api_source
            elif data_type_lower == 'trends':
                return config.trends_api_source
        else:
            if data_type_lower == 'competitor':
                return config.competitor_api_fallback
            elif data_type_lower == 'weather':
                return config.weather_api_fallback
            elif data_type_lower == 'events':
                return config.events_api_fallback
            elif data_type_lower == 'news':
                return config.news_api_fallback
            elif data_type_lower == 'trends':
                return config.trends_api_fallback
        
        return None
    
    async def update_config(
        self,
        country: str,
        updates: Dict[str, Any]
    ) -> bool:
        """
        Met à jour la configuration d'un pays.
        
        Args:
            country: Code pays
            updates: Dict avec les champs à mettre à jour
            
        Returns:
            True si succès, False sinon
        """
        supabase_client = self._get_supabase_client()
        if not supabase_client:
            logger.error("Supabase client not available for updating config")
            return False
        
        try:
            loop = asyncio.get_event_loop()
            
            # Upsert la configuration
            response = await loop.run_in_executor(
                None,
                lambda: supabase_client.table('market_config')\
                    .upsert({
                        'country': country.upper(),
                        **updates
                    }, on_conflict='country')\
                    .execute()
            )
            
            # Invalider le cache
            if country.upper() in self._cache:
                del self._cache[country.upper()]
            
            logger.info(f"Updated market config for {country.upper()}")
            return True
        
        except Exception as e:
            logger.error(f"Error updating config for {country.upper()}: {e}")
            return False
    
    def clear_cache(self):
        """Vide le cache de configuration."""
        self._cache.clear()
        logger.info("Cleared market config cache")


# Instance globale (singleton)
_manager_instance: Optional[MarketConfigManager] = None


def get_market_config_manager(settings: Optional[Settings] = None) -> MarketConfigManager:
    """
    Récupère l'instance globale du gestionnaire de configuration.
    
    Args:
        settings: Configuration (si None, utilise une nouvelle instance)
        
    Returns:
        Instance du gestionnaire
    """
    global _manager_instance
    
    if _manager_instance is None:
        _manager_instance = MarketConfigManager(settings)
    
    return _manager_instance











