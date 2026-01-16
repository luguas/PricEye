"""
Accès aux données internes nécessaires au moteur de pricing PricEye.

Ce module fournit une couche d’abstraction entre le moteur IA
et la base de données (Supabase/PostgreSQL).

Objectifs principaux :
- récupérer l’historique des réservations et des prix,
- calculer des agrégats simples (taux d’occupation, capacité restante),
- préparer une structure de données exploitable par la couche IA.

IMPORTANT :
- On réutilise la configuration déjà utilisée par `market_data_pipeline`
  (variables d’environnement `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY`),
  via la même logique que `market_data_pipeline.config.settings`.

Les fonctions ici sont conçues pour être appelées par :
- `dataset_builder.py` (à créer),
- puis par les modèles de demande / élasticité.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from supabase import Client, create_client  # type: ignore

from market_data_pipeline.config.settings import Settings


_supabase_client: Optional[Client] = None


def get_supabase_client() -> Client:
    """
    Retourne un client Supabase initialisé pour PricEye.

    Cette fonction réutilise les mêmes variables d’environnement que
    le pipeline marché afin de garder une configuration unique.
    """
    global _supabase_client

    if _supabase_client is not None:
        return _supabase_client

    settings = Settings.from_env()
    if not settings.supabase_url or not settings.supabase_key:
        raise RuntimeError(
            "Les variables d'environnement SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY/SUPABASE_KEY "
            "doivent être configurées pour utiliser le moteur de pricing."
        )

    _supabase_client = create_client(settings.supabase_url, settings.supabase_key)
    return _supabase_client


@dataclass
class InternalPricingRecord:
    """
    Enregistrement interne de base pour le pricing.

    Ce format est volontairement simple et proche de la base,
    il sera enrichi/transformé plus tard dans le dataset builder.
    """

    property_id: str
    room_type: Optional[str]
    date: str
    price: Optional[float]
    bookings: int
    capacity: Optional[int]

    # TODO : ajouter d’autres champs utiles (promotion_id, channel, etc.)


def _safe_int(value: Any) -> int:
    try:
        if value is None:
            return 0
        return int(value)
    except (TypeError, ValueError):
        return 0


def _safe_float(value: Any) -> Optional[float]:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def get_bookings_for_property_date_range(
    property_id: str,
    start_date: str,
    end_date: str,
) -> List[Dict[str, Any]]:
    """
    Récupère les réservations d’une propriété sur une plage de dates.

    Cette fonction interroge la table `bookings` de Supabase.
    Elle renvoie les lignes brutes (dict) pour garder de la flexibilité.
    """
    client = get_supabase_client()

    response = (
        client.table("bookings")
        .select("*")
        .eq("property_id", property_id)
        .gte("start_date", start_date)
        .lte("start_date", end_date)
        .order("start_date", desc=False)
        .execute()
    )

    # Vérifier si response.data existe (compatible avec différentes versions de Supabase)
    if not hasattr(response, 'data'):
        raise RuntimeError("Réponse Supabase invalide: pas d'attribut 'data'")

    return response.data or []


def get_price_overrides_for_property_date_range(
    property_id: str,
    start_date: str,
    end_date: str,
) -> List[Dict[str, Any]]:
    """
    Récupère les price overrides pour une propriété sur une plage de dates.

    Table cible : `price_overrides`.
    """
    client = get_supabase_client()

    query = (
        client.table("price_overrides")
        .select("*")
        .eq("property_id", property_id)
        .gte("date", start_date)
        .lte("date", end_date)
        .order("date", desc=False)
    )

    response = query.execute()
    
    # Vérifier si response.data existe (compatible avec différentes versions de Supabase)
    if not hasattr(response, 'data'):
        raise RuntimeError("Réponse Supabase invalide: pas d'attribut 'data'")

    return response.data or []


def get_property_capacity(property_id: str) -> Optional[int]:
    """
    Récupère la capacité totale de la propriété (si disponible).

    TODO :
    - Adapter les noms de colonnes (ex: `max_guests`, `bedrooms`, etc.)
      en fonction du schéma réel de la table `properties`.
    - Si la capacité est stockée par type de chambre, cette fonction
      devra être raffinée ou complétée.
    """
    client = get_supabase_client()

    response = (
        client.table("properties")
        .select("*")
        .eq("id", property_id)
        .single()
        .execute()
    )

    # Vérifier si response.data existe (compatible avec différentes versions de Supabase)
    if not hasattr(response, 'data'):
        # On ne lève pas systématiquement ici pour laisser l'appelant gérer le fallback
        return None

    data = response.data or {}

    # Exemple simple : on suppose une colonne `max_guests` comme capacité.
    capacity = data.get("max_guests")
    return _safe_int(capacity) if capacity is not None else None


def get_property_pricing_constraints(property_id: str) -> Dict[str, Optional[float]]:
    """
    Récupère les contraintes de prix d'une propriété depuis Supabase.

    Retourne un dictionnaire avec :
    - floor_price: prix minimum autorisé
    - ceiling_price: prix maximum autorisé
    - base_price: prix de base de la propriété

    Si une valeur n'est pas définie, elle sera None.
    """
    client = get_supabase_client()

    try:
        response = (
            client.table("properties")
            .select("floor_price, ceiling_price, base_price")
            .eq("id", property_id)
            .maybe_single()
            .execute()
        )

        # Vérifier si response.data existe
        if not hasattr(response, 'data') or not response.data:
            return {
                "floor_price": None,
                "ceiling_price": None,
                "base_price": None,
            }

        data = response.data

        return {
            "floor_price": _safe_float(data.get("floor_price")),
            "ceiling_price": _safe_float(data.get("ceiling_price")),
            "base_price": _safe_float(data.get("base_price")),
        }
    except Exception:
        # En cas d'erreur, retourner None pour toutes les valeurs
        return {
            "floor_price": None,
            "ceiling_price": None,
            "base_price": None,
        }


def get_property_location(property_id: str) -> Dict[str, Optional[str]]:
    """
    Récupère la localisation (ville et pays) d'une propriété depuis Supabase.

    Retourne un dictionnaire avec :
    - city: ville de la propriété
    - country: pays de la propriété

    Si une valeur n'est pas définie, elle sera None.
    """
    client = get_supabase_client()

    try:
        response = (
            client.table("properties")
            .select("city, country")
            .eq("id", property_id)
            .maybe_single()
            .execute()
        )

        # Vérifier si response.data existe
        if not hasattr(response, 'data') or not response.data:
            return {
                "city": None,
                "country": None,
            }

        data = response.data

        return {
            "city": data.get("city"),
            "country": data.get("country"),
        }
    except Exception:
        # En cas d'erreur, retourner None pour toutes les valeurs
        return {
            "city": None,
            "country": None,
        }


def get_internal_pricing_data(
    property_id: str,
    start_date: str,
    end_date: str,
) -> List[InternalPricingRecord]:
    """
    Récupère et agrège les données internes nécessaires au pricing
    pour une propriété et une plage de dates.

    Cette fonction inclut TOUS les jours de la plage, même ceux sans réservations
    (avec bookings = 0), ce qui est important pour l'entraînement du modèle.

    Pour l'instant :
    - Utilise `bookings` pour compter le nombre de réservations par jour,
    - Utilise `price_overrides` pour récupérer un prix journalier s'il existe,
    - Utilise `properties` pour une capacité globale,
    - Génère un enregistrement pour chaque jour de la plage (même sans réservations).

    TODO (prochaines itérations) :
    - intégrer les types de chambres,
    - intégrer les promotions,
    - distinguer les canaux, etc.
    """
    bookings = get_bookings_for_property_date_range(property_id, start_date, end_date)
    overrides = get_price_overrides_for_property_date_range(property_id, start_date, end_date)
    capacity = get_property_capacity(property_id)

    # Indexer les overrides par date pour un accès rapide
    overrides_by_date: Dict[str, Dict[str, Any]] = {}
    for o in overrides:
        date_str = o.get("date")
        if date_str:
            overrides_by_date[date_str] = o

    # Agréger les bookings par date (sans distinction de room_type pour l'instant)
    bookings_by_date: Dict[str, int] = {}
    for b in bookings:
        date_str = b.get("start_date")
        if not date_str:
            continue
        # Normaliser la date (enlever l'heure si présente)
        if isinstance(date_str, str):
            date_str = date_str.split("T")[0]  # Garder seulement la partie date
        bookings_by_date[date_str] = bookings_by_date.get(date_str, 0) + 1

    # Générer tous les jours de la plage de dates
    start_dt = datetime.strptime(start_date, "%Y-%m-%d").date()
    end_dt = datetime.strptime(end_date, "%Y-%m-%d").date()
    
    records: List[InternalPricingRecord] = []
    current_date = start_dt
    
    while current_date <= end_dt:
        date_str = current_date.isoformat()
        
        # Récupérer le nombre de bookings pour ce jour (0 si aucun)
        bookings_count = bookings_by_date.get(date_str, 0)
        
        # Récupérer le prix override pour ce jour (None si aucun)
        override = overrides_by_date.get(date_str)
        price = _safe_float(override.get("price")) if override else None

        records.append(
            InternalPricingRecord(
                property_id=property_id,
                room_type=None,  # TODO : intégrer le type de chambre lorsque le schéma le permettra
                date=date_str,
                price=price,
                bookings=_safe_int(bookings_count),
                capacity=capacity,
            )
        )
        
        # Passer au jour suivant
        current_date += timedelta(days=1)

    return records



