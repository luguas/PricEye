"""
Gestion des clés API pour les différentes sources de données.
"""

import os
from typing import Optional
from dotenv import load_dotenv

# Charger les variables d'environnement
load_dotenv()


def get_api_key(service_name: str, default: Optional[str] = None) -> Optional[str]:
    """
    Récupère la clé API pour un service donné.
    
    Args:
        service_name: Nom du service (ex: 'AIRDNA', 'OPENWEATHER', 'NEWSAPI')
        default: Valeur par défaut si la clé n'est pas trouvée
        
    Returns:
        La clé API ou None si non trouvée
    """
    env_key = f"{service_name}_API_KEY"
    return os.getenv(env_key, default)


def set_api_key(service_name: str, api_key: str) -> None:
    """
    Définit une clé API dans les variables d'environnement (session uniquement).
    
    Args:
        service_name: Nom du service
        api_key: La clé API
    """
    env_key = f"{service_name}_API_KEY"
    os.environ[env_key] = api_key


# Constantes pour les noms de services
class API_SERVICES:
    """Constantes pour les noms de services API."""
    APIFY = "APIFY"  # Scraping Airbnb (données live)
    # Note: AirDNA/Lighthouse ne nécessitent pas de clé API (imports CSV ponctuels)
    OPENWEATHER = "OPENWEATHER"
    WEATHERAPI = "WEATHERAPI"
    NEWSAPI = "NEWSAPI"
    EVENTBRITE = "EVENTBRITE"
    EXCHANGERATE = "EXCHANGERATE"
    OPENAI = "OPENAI"

