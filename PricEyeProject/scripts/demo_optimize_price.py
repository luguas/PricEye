"""
Script de démonstration pour tester le moteur d’optimisation de prix.

Usage (depuis `PricEyeProject/`) :

    python -m scripts.demo_optimize_price --property-id YOUR_PROPERTY_ID --date 2024-06-01

Ce script suppose qu’un modèle de demande a déjà été entraîné pour la propriété
via `scripts/train_demand_model.py`.
"""

import argparse
import json

from pricing_engine.optimizer import get_recommended_price


def main() -> None:
    parser = argparse.ArgumentParser(description="Demo: optimize price for a given property/date.")
    parser.add_argument("--property-id", required=True, help="ID de la propriété (UUID Supabase).")
    parser.add_argument("--room-type", default="default", help="Type de chambre (facultatif).")
    parser.add_argument("--date", required=True, help="Date de séjour (YYYY-MM-DD).")

    args = parser.parse_args()

    # Contexte minimal : on pourrait enrichir avec des features marché si nécessaires
    context_features = {}

    recommendation = get_recommended_price(
        property_id=args.property_id,
        room_type=args.room_type,
        date=args.date,
        context_features=context_features,
    )

    print("✅ Recommandation de prix")
    print(json.dumps(recommendation, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()



