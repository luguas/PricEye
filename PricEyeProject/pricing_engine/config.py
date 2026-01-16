"""
Configuration centrale pour le moteur de pricing PricEye.

Ce module définit les paramètres globaux utilisés par le moteur :
- bornes de prix par défaut (min / max),
- pas de variation de prix,
- contraintes de volatilité,
- paramètres de fallback lorsque les modèles IA ne sont pas disponibles.

Les valeurs sont initialisées avec des defaults raisonnables et
doivent être adaptées / surchargées par environnement (ENV, base, etc.).
"""

from dataclasses import dataclass
from typing import Optional


@dataclass
class PricingConfig:
    """
    Paramètres de haut niveau pour le moteur de pricing.

    Ces paramètres pourront ensuite être :
    - surchargés par propriété,
    - stockés dans la base,
    - ou fournis via une API d’administration.
    """

    # Prix minimum et maximum par nuit (fallback global)
    default_min_price: float = 30.0
    default_max_price: float = 800.0

    # Pas de la grille de prix utilisée pour la simulation (en unité monétaire)
    price_step: float = 5.0

    # Variation maximale autorisée d’un jour sur l’autre (en pourcentage, ex: 0.3 = ±30 %)
    max_daily_price_change_ratio: float = 0.3

    # Prix de repli si le modèle IA n’est pas disponible
    fallback_price: float = 100.0

    # TODO : ajouter ici des paramètres plus fins (par canal, par segment, par pays, etc.)


def get_default_pricing_config() -> PricingConfig:
    """
    Retourne une instance de configuration par défaut.

    À terme, cette fonction pourra :
    - lire des variables d’environnement,
    - consulter une table de configuration en base,
    - ou prendre en compte l’ID de propriété.
    """
    return PricingConfig()


def get_pricing_config_for_property(property_id: Optional[str] = None) -> PricingConfig:
    """
    Retourne la configuration à utiliser pour une propriété donnée.

    Pour l’instant, renvoie simplement la configuration par défaut.
    TODO :
    - connecter à Supabase/PostgreSQL pour charger une config spécifique à la propriété,
    - gérer la surcharge par pays / ville / segment.
    """
    # Stub pour implémentation future
    _ = property_id
    return get_default_pricing_config()





