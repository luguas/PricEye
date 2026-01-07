"""
Construction du dataset complet pour le moteur de pricing PricEye.

Ce module fusionne :
- les données internes (réservations, prix, capacité),
- les features marché déjà calculées par le pipeline (`features_pricing_daily`).

Objectif :
- produire un dataframe tabulaire exploitable pour entraîner
  un modèle de demande (et plus tard des modèles d’élasticité).
"""

from __future__ import annotations

from dataclasses import asdict
from typing import Any, Dict, List

import pandas as pd  # type: ignore
from supabase import Client  # type: ignore

from market_data_pipeline.config.settings import Settings
from .interfaces.data_access import (
    InternalPricingRecord,
    get_internal_pricing_data,
    get_supabase_client,
)


def _get_supabase_client_from_settings() -> Client:
    """
    Retourne un client Supabase en réutilisant la configuration du pipeline marché.

    Cette fonction est séparée pour faciliter un éventuel mocking dans les tests.
    """
    return get_supabase_client()


def get_market_pricing_features_for_property_date_range(
    property_id: str,
    start_date: str,
    end_date: str,
) -> List[Dict[str, Any]]:
    """
    Récupère les features marché pertinentes pour le pricing
    dans la table `features_pricing_daily`.

    Colonnes minimales attendues (d’après README_BUILD_MARKET_FEATURES) :
    - property_id
    - date
    - competitor_avg_price
    - market_demand_level
    """
    client = _get_supabase_client_from_settings()

    response = (
        client.table("features_pricing_daily")
        .select("*")
        .eq("property_id", property_id)
        .gte("date", start_date)
        .lte("date", end_date)
        .order("date", desc=False)
        .execute()
    )

    # Vérifier si response.data existe (compatible avec différentes versions de Supabase)
    if not hasattr(response, 'data'):
        raise RuntimeError("Réponse Supabase invalide: pas d'attribut 'data'")

    return response.data or []


def build_pricing_dataset(
    property_id: str,
    start_date: str,
    end_date: str,
) -> pd.DataFrame:
    """
    Construit le dataset complet pour le pricing pour une propriété et une plage de dates.

    Étapes :
    1. Récupérer les données internes via `get_internal_pricing_data`.
    2. Récupérer les features marché via `features_pricing_daily`.
    3. Fusionner sur `[property_id, date]`.
    4. Ajouter une cible `y_demand` (ici = `bookings`).
    5. Gérer simplement les valeurs manquantes (fillna sur certaines colonnes).

    Retour :
    - Un `pd.DataFrame` avec au minimum :
      - `property_id`
      - `date`
      - `price` (si disponible)
      - `bookings` (cible brute)
      - `y_demand` (alias de `bookings`)
      - `capacity`
      - `competitor_avg_price`
      - `market_demand_level`
    """
    # 1. Données internes
    internal_records: List[InternalPricingRecord] = get_internal_pricing_data(
        property_id=property_id,
        start_date=start_date,
        end_date=end_date,
    )
    internal_rows: List[Dict[str, Any]] = [asdict(r) for r in internal_records]
    internal_df = pd.DataFrame(internal_rows)

    if internal_df.empty:
        # On renvoie un dataframe vide mais typé, pour éviter les surprises
        return pd.DataFrame(
            columns=[
                "property_id",
                "room_type",
                "date",
                "price",
                "bookings",
                "capacity",
                "competitor_avg_price",
                "market_demand_level",
                "y_demand",
            ]
        )

    # 2. Features marché pour le pricing
    market_features_rows = get_market_pricing_features_for_property_date_range(
        property_id=property_id,
        start_date=start_date,
        end_date=end_date,
    )
    market_df = pd.DataFrame(market_features_rows)

    # On ne garde que les colonnes utiles par défaut
    cols_to_keep = [
        "property_id",
        "date",
        "competitor_avg_price",
        "market_demand_level",
    ]
    # Si certaines colonnes n’existent pas (déploiement partiel), on ignore
    existing_cols = [c for c in cols_to_keep if c in market_df.columns]
    market_df = market_df[existing_cols] if not market_df.empty else pd.DataFrame(columns=existing_cols)

    # 3. Fusion sur property_id + date
    # On s’assure que les types sont cohérents (string / date ISO)
    for df in (internal_df, market_df):
        if "property_id" in df.columns:
            df["property_id"] = df["property_id"].astype(str)
        if "date" in df.columns:
            df["date"] = df["date"].astype(str)

    merged_df = internal_df.merge(
        market_df,
        on=["property_id", "date"],
        how="left",
        suffixes=("", "_market"),
    )

    # 4. Cible de demande
    merged_df["y_demand"] = merged_df["bookings"].fillna(0).astype(int)

    # 5. Gestion simple des NaN pour quelques features clés
    if "competitor_avg_price" in merged_df.columns:
        merged_df["competitor_avg_price"] = merged_df["competitor_avg_price"].fillna(0.0)
    if "market_demand_level" in merged_df.columns:
        merged_df["market_demand_level"] = merged_df["market_demand_level"].fillna(50.0)

    return merged_df


def demo_build_pricing_dataset(
    property_id: str,
    start_date: str,
    end_date: str,
) -> None:
    """
    Démonstration simple : construit un dataset de pricing et affiche
    quelques lignes + les colonnes disponibles.

    Cette fonction peut être appelée depuis un script ou un notebook
    pour valider rapidement que tout fonctionne.
    """
    df = build_pricing_dataset(property_id=property_id, start_date=start_date, end_date=end_date)

    print(f"Dataset de pricing pour property_id={property_id}, dates {start_date} → {end_date}")
    print(f"Lignes: {len(df)}, Colonnes: {len(df.columns)}")
    print("Colonnes:", list(df.columns))
    print(df.head(10))



