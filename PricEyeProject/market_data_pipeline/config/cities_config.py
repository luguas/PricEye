"""
Configuration des villes à tracker pour les données météo.

Contient les coordonnées (lat/long) et informations pour chaque ville.
"""

from typing import Dict, Optional, List
from dataclasses import dataclass


@dataclass
class CityConfig:
    """Configuration d'une ville."""
    name: str
    country: str
    latitude: float
    longitude: float
    timezone: str  # IANA timezone (ex: 'Europe/Paris')
    
    # Informations additionnelles (optionnel)
    region: Optional[str] = None
    population: Optional[int] = None


# Base de données des villes courantes
CITIES_DATABASE: Dict[str, Dict[str, CityConfig]] = {
    # France
    "FR": {
        "Paris": CityConfig(
            name="Paris",
            country="FR",
            latitude=48.8566,
            longitude=2.3522,
            timezone="Europe/Paris"
        ),
        "Nice": CityConfig(
            name="Nice",
            country="FR",
            latitude=43.7102,
            longitude=7.2620,
            timezone="Europe/Paris"
        ),
        "Lyon": CityConfig(
            name="Lyon",
            country="FR",
            latitude=45.7640,
            longitude=4.8357,
            timezone="Europe/Paris"
        ),
        "Marseille": CityConfig(
            name="Marseille",
            country="FR",
            latitude=43.2965,
            longitude=5.3698,
            timezone="Europe/Paris"
        ),
        "Bordeaux": CityConfig(
            name="Bordeaux",
            country="FR",
            latitude=44.8378,
            longitude=-0.5792,
            timezone="Europe/Paris"
        ),
    },
    
    # Espagne
    "ES": {
        "Madrid": CityConfig(
            name="Madrid",
            country="ES",
            latitude=40.4168,
            longitude=-3.7038,
            timezone="Europe/Madrid"
        ),
        "Barcelona": CityConfig(
            name="Barcelona",
            country="ES",
            latitude=41.3851,
            longitude=2.1734,
            timezone="Europe/Madrid"
        ),
        "Valencia": CityConfig(
            name="Valencia",
            country="ES",
            latitude=39.4699,
            longitude=-0.3763,
            timezone="Europe/Madrid"
        ),
    },
    
    # Italie
    "IT": {
        "Rome": CityConfig(
            name="Rome",
            country="IT",
            latitude=41.9028,
            longitude=12.4964,
            timezone="Europe/Rome"
        ),
        "Milan": CityConfig(
            name="Milan",
            country="IT",
            latitude=45.4642,
            longitude=9.1900,
            timezone="Europe/Rome"
        ),
        "Venice": CityConfig(
            name="Venice",
            country="IT",
            latitude=45.4408,
            longitude=12.3155,
            timezone="Europe/Rome"
        ),
    },
    
    # États-Unis
    "US": {
        "New York": CityConfig(
            name="New York",
            country="US",
            latitude=40.7128,
            longitude=-74.0060,
            timezone="America/New_York"
        ),
        "Los Angeles": CityConfig(
            name="Los Angeles",
            country="US",
            latitude=34.0522,
            longitude=-118.2437,
            timezone="America/Los_Angeles"
        ),
        "Miami": CityConfig(
            name="Miami",
            country="US",
            latitude=25.7617,
            longitude=-80.1918,
            timezone="America/New_York"
        ),
    },
    
    # Royaume-Uni
    "GB": {
        "London": CityConfig(
            name="London",
            country="GB",
            latitude=51.5074,
            longitude=-0.1278,
            timezone="Europe/London"
        ),
    },
    
    # Allemagne
    "DE": {
        "Berlin": CityConfig(
            name="Berlin",
            country="DE",
            latitude=52.5200,
            longitude=13.4050,
            timezone="Europe/Berlin"
        ),
        "Munich": CityConfig(
            name="Munich",
            country="DE",
            latitude=48.1351,
            longitude=11.5820,
            timezone="Europe/Berlin"
        ),
    },
}


def get_city_config(city: str, country: str) -> Optional[CityConfig]:
    """
    Récupère la configuration d'une ville.
    
    Args:
        city: Nom de la ville
        country: Code pays (ex: 'FR', 'US')
    
    Returns:
        CityConfig ou None si non trouvé
    """
    country_upper = country.upper()
    city_lower = city.lower().strip()
    
    if country_upper not in CITIES_DATABASE:
        return None
    
    # Recherche exacte
    for city_name, config in CITIES_DATABASE[country_upper].items():
        if city_name.lower() == city_lower:
            return config
    
    # Recherche partielle
    for city_name, config in CITIES_DATABASE[country_upper].items():
        if city_lower in city_name.lower() or city_name.lower() in city_lower:
            return config
    
    return None


def get_all_cities() -> List[CityConfig]:
    """Retourne toutes les villes configurées."""
    all_cities = []
    for country_cities in CITIES_DATABASE.values():
        all_cities.extend(country_cities.values())
    return all_cities


def add_city_config(city_config: CityConfig) -> None:
    """
    Ajoute une configuration de ville.
    
    Args:
        city_config: Configuration de la ville
    """
    country = city_config.country.upper()
    if country not in CITIES_DATABASE:
        CITIES_DATABASE[country] = {}
    
    CITIES_DATABASE[country][city_config.name] = city_config









