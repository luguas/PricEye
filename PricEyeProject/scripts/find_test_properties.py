"""
Script pour trouver des propriétés de test avec suffisamment de données historiques.

Usage (depuis `PricEyeProject/`) :

    python -m scripts.find_test_properties --min-days 90

Ce script liste les propriétés actives avec leur historique de données
pour faciliter la sélection de propriétés de test.
"""

import argparse
from datetime import datetime, timedelta
from typing import Tuple

from pricing_engine.interfaces.data_access import get_internal_pricing_data, get_supabase_client


def get_active_properties() -> list:
    """Récupère toutes les propriétés actives."""
    client = get_supabase_client()

    try:
        response = (
            client.table("properties")
            .select("*")
            .eq("status", "active")
            .execute()
        )

        # Vérifier si response.data existe (compatible avec différentes versions de Supabase)
        if not hasattr(response, 'data'):
            raise RuntimeError("Réponse Supabase invalide: pas d'attribut 'data'")

        return response.data or []
    except Exception as e:
        # Si c'est déjà une RuntimeError, la relancer
        if isinstance(e, RuntimeError):
            raise
        # Sinon, envelopper dans une RuntimeError
        raise RuntimeError(f"Erreur lors de la récupération des propriétés: {e}") from e


def check_property_history(property_id: str, min_days: int = 90) -> Tuple[bool, int]:
    """Vérifie l'historique d'une propriété."""
    end_date = datetime.now().date()
    start_date = end_date - timedelta(days=min_days * 2)

    start_date_str = start_date.isoformat()
    end_date_str = end_date.isoformat()

    try:
        records = get_internal_pricing_data(property_id, start_date_str, end_date_str)
        actual_days = len(records)
        return actual_days >= min_days, actual_days
    except Exception as e:
        # Logger l'erreur pour le debugging
        print(f"      ⚠️  Erreur lors de la vérification: {e}")
        return False, 0


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Trouver des propriétés de test avec suffisamment de données."
    )
    parser.add_argument(
        "--min-days",
        type=int,
        default=90,
        help="Minimum de jours d'historique requis (défaut: 90).",
    )

    args = parser.parse_args()

    print("=" * 80)
    print("🔍 RECHERCHE DE PROPRIÉTÉS DE TEST")
    print("=" * 80)
    print(f"📊 Minimum de jours requis: {args.min_days}")
    print()

    try:
        properties = get_active_properties()
        print(f"📋 {len(properties)} propriété(s) active(s) trouvée(s)")
        print()

        suitable_properties = []

        for idx, prop in enumerate(properties, 1):
            property_id = prop.get("id")
            property_name = prop.get("name") or prop.get("title") or "Sans nom"
            property_city = prop.get("city", "N/A")
            property_country = prop.get("country", "N/A")

            print(f"[{idx}/{len(properties)}] Vérification: {property_name} ({property_id[:8]}...)")

            has_sufficient, actual_days = check_property_history(property_id, args.min_days)

            if has_sufficient:
                suitable_properties.append({
                    "id": property_id,
                    "name": property_name,
                    "city": property_city,
                    "country": property_country,
                    "days": actual_days,
                })
                print(f"  ✅ {actual_days} jours de données disponibles")
            else:
                print(f"  ⚠️  {actual_days} jours (insuffisant)")

        print()
        print("=" * 80)
        print(f"✅ {len(suitable_properties)} propriété(s) adaptée(s) pour les tests")
        print("=" * 80)
        print()

        if suitable_properties:
            print("📋 Propriétés recommandées pour les tests:")
            print()
            for prop in suitable_properties[:10]:  # Limiter à 10 pour l'affichage
                print(f"  🏠 {prop['name']}")
                print(f"     ID: {prop['id']}")
                print(f"     📍 {prop['city']}, {prop['country']}")
                print(f"     📊 {prop['days']} jours de données")
                print()
                print(f"     Commande de test:")
                print(f"     python -m scripts.test_train_single_property --property-id {prop['id']}")
                print()

            if len(suitable_properties) > 10:
                print(f"  ... et {len(suitable_properties) - 10} autre(s) propriété(s)")
        else:
            print("❌ Aucune propriété avec suffisamment de données trouvée.")
            print(f"   Réduisez --min-days (actuellement: {args.min_days}) pour voir plus de propriétés.")

    except Exception as e:
        print(f"❌ Erreur: {e}")
        import traceback

        traceback.print_exc()


if __name__ == "__main__":
    main()

