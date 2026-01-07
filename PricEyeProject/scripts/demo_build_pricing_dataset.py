"""
Script de démonstration pour construire un dataset de pricing
pour une propriété donnée.

Usage (depuis la racine `PricEyeProject/`) :

    python -m scripts.demo_build_pricing_dataset --property-id YOUR_PROPERTY_ID --start-date 2024-01-01 --end-date 2024-01-31

Assurez-vous que :
- les variables d’environnement SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont configurées,
- la propriété et les données (bookings, price_overrides, features_pricing_daily) existent.
"""

import argparse

from pricing_engine.dataset_builder import demo_build_pricing_dataset


def main() -> None:
    parser = argparse.ArgumentParser(description="Demo: build pricing dataset for a property.")
    parser.add_argument("--property-id", required=True, help="ID de la propriété (UUID Supabase).")
    parser.add_argument("--start-date", required=True, help="Date de début (YYYY-MM-DD).")
    parser.add_argument("--end-date", required=True, help="Date de fin (YYYY-MM-DD).")

    args = parser.parse_args()

    demo_build_pricing_dataset(
        property_id=args.property_id,
        start_date=args.start_date,
        end_date=args.end_date,
    )


if __name__ == "__main__":
    main()



