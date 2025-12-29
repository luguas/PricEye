"""
Configuration générale du pipeline.
"""

import os
from typing import List, Optional
from dataclasses import dataclass
from dotenv import load_dotenv
from pathlib import Path

# Charger .env depuis le répertoire du projet (PricEyeProject/)
project_root = Path(__file__).parent.parent.parent
load_dotenv(dotenv_path=project_root / ".env")


@dataclass
class DatabaseConfig:
    """Configuration de la base de données Supabase."""
    url: str
    key: str
    timeout: int = 30


@dataclass
class Settings:
    """Configuration globale du pipeline."""
    
    # Base de données
    supabase_url: str
    supabase_key: str
    
    # Devise de base pour les conversions
    base_currency: str = "EUR"
    
    # Timezone par défaut
    default_timezone: str = "UTC"
    
    # Pays et villes à traiter (vide = tous)
    target_countries: Optional[List[str]] = None
    target_cities: Optional[List[str]] = None
    
    # Configuration des jobs
    collect_competitors: bool = True
    collect_weather: bool = True
    collect_events: bool = True
    collect_news: bool = True
    collect_trends: bool = True
    
    # Rate limiting
    default_rate_limit_per_minute: int = 60
    default_rate_limit_per_hour: int = 1000
    
    # Retry configuration
    max_retries: int = 3
    retry_backoff_factor: float = 2.0
    
    # Logging
    log_level: str = "INFO"
    log_to_file: bool = False
    log_file_path: str = "logs/market_data_pipeline.log"
    
    @classmethod
    def from_env(cls) -> "Settings":
        """Crée une instance Settings depuis les variables d'environnement."""
        return cls(
            supabase_url=os.getenv("SUPABASE_URL", ""),
            supabase_key=os.getenv("SUPABASE_SERVICE_ROLE_KEY", os.getenv("SUPABASE_KEY", "")),
            base_currency=os.getenv("BASE_CURRENCY", "EUR"),
            default_timezone=os.getenv("DEFAULT_TIMEZONE", "UTC"),
            log_level=os.getenv("LOG_LEVEL", "INFO"),
        )

