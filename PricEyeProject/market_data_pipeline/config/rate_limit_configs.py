"""
Configurations des rate limits par source API.

Ces configurations peuvent être personnalisées selon les quotas réels de chaque API.
"""

import logging
from market_data_pipeline.collectors.rate_limiter import RateLimitConfig

logger = logging.getLogger(__name__)

# Configuration par défaut (limites génériques)
DEFAULT_RATE_LIMIT = RateLimitConfig(
    requests_per_minute=60,
    requests_per_hour=1000,
    requests_per_day=10000
)

# Configurations spécifiques par API source
RATE_LIMIT_CONFIGS = {
    # Apify API (scraping Airbnb pour données concurrents live)
    "apify": RateLimitConfig(
        requests_per_minute=10,  # Limite Apify (varie selon le plan)
        requests_per_hour=100,
        requests_per_day=1000
    ),
    
    # Apify Actor runs (spécifique aux runs d'acteurs)
    "apify_actor": RateLimitConfig(
        requests_per_minute=5,  # Plus restrictif car chaque run peut prendre plusieurs minutes
        requests_per_hour=50,
        requests_per_day=500
    ),
    
    # OpenWeather API
    "openweather": RateLimitConfig(
        requests_per_minute=60,  # Free tier: 60/min
        requests_per_hour=1000,
        requests_per_day=None  # Pas de limite journalière
    ),
    
    # Eventbrite API
    "eventbrite": RateLimitConfig(
        requests_per_minute=2000,  # OAuth: 2000/min
        requests_per_hour=100000,
        requests_per_day=None
    ),
    
    # NewsAPI
    "newsapi": RateLimitConfig(
        requests_per_minute=100,  # Developer: 100/min
        requests_per_hour=10000,
        requests_per_day=None
    ),
    
    # ExchangeRate API (ou autre service de taux de change)
    "exchangerate": RateLimitConfig(
        requests_per_minute=60,
        requests_per_hour=1000,
        requests_per_day=None
    ),
    
    # Google Trends (via API ou scraping)
    "googletrends": RateLimitConfig(
        requests_per_minute=5,  # Limite stricte pour éviter le ban
        requests_per_hour=100,
        requests_per_day=1000
    ),
    
    # Note: AirDNA et Lighthouse ne nécessitent pas de rate limiting
    # car les données historiques sont importées via CSV (one-off)
    # "airdna" est gardé pour compatibilité si des APIs futures sont utilisées
    "airdna": RateLimitConfig(
        requests_per_minute=10,
        requests_per_hour=500,
        requests_per_day=10000
    ),
    
    # Lighthouse/Transparent (pour référence, si API future)
    "lighthouse": RateLimitConfig(
        requests_per_minute=30,
        requests_per_hour=1000,
        requests_per_day=20000
    ),
}


def get_rate_limit_config(source_name: str) -> RateLimitConfig:
    """
    Retourne la configuration de rate limit pour une source donnée.
    
    Args:
        source_name: Nom de la source API (en minuscules)
        
    Returns:
        RateLimitConfig pour la source, ou DEFAULT_RATE_LIMIT si non trouvé
    """
    source_lower = source_name.lower()
    
    # Rechercher une correspondance exacte
    if source_lower in RATE_LIMIT_CONFIGS:
        return RATE_LIMIT_CONFIGS[source_lower]
    
    # Rechercher une correspondance partielle (ex: "competitor_airdna" -> "airdna")
    for config_key, config in RATE_LIMIT_CONFIGS.items():
        if config_key in source_lower:
            return config
    
    # Retourner la config par défaut
    logger.warning(
        f"No rate limit config found for '{source_name}', using default"
    )
    return DEFAULT_RATE_LIMIT


def create_rate_limiter(
    source_name: str,
    persist_state: bool = False
) -> "RateLimiter":
    """
    Crée un RateLimiter configuré pour une source donnée.
    
    Args:
        source_name: Nom de la source API
        persist_state: Si True, persiste l'état entre les runs
        
    Returns:
        RateLimiter configuré
    """
    from market_data_pipeline.collectors.rate_limiter import RateLimiter
    
    config = get_rate_limit_config(source_name)
    return RateLimiter(
        config=config,
        source_name=source_name,
        persist_state=persist_state
    )

