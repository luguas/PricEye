"""
Script CLI pour entraîner un modèle de demande pour une propriété.

Usage typique (depuis `PricEyeProject/`) :

    python -m scripts.train_demand_model --property-id YOUR_PROPERTY_ID --start-date 2023-01-01 --end-date 2023-12-31

Ce script :
- construit le dataset via `build_pricing_dataset`,
- entraîne un modèle XGBoost,
- sauvegarde le modèle dans le dossier `pricing_models/`,
- affiche les métriques d’entraînement (RMSE train/val).
"""

import argparse
import json

from pricing_engine.models.demand_model import (
    DemandModelConfig,
    train_demand_model_for_property,
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Train demand model for a given property.")
    parser.add_argument("--property-id", required=True, help="ID de la propriété (UUID Supabase).")
    parser.add_argument("--start-date", required=True, help="Date de début (YYYY-MM-DD).")
    parser.add_argument("--end-date", required=True, help="Date de fin (YYYY-MM-DD).")

    # Hyperparamètres optionnels (MVP)
    parser.add_argument("--n-estimators", type=int, default=300)
    parser.add_argument("--learning-rate", type=float, default=0.05)
    parser.add_argument("--max-depth", type=int, default=6)

    args = parser.parse_args()

    config = DemandModelConfig(
        n_estimators=args.n_estimators,
        learning_rate=args.learning_rate,
        max_depth=args.max_depth,
    )

    result = train_demand_model_for_property(
        property_id=args.property_id,
        start_date=args.start_date,
        end_date=args.end_date,
        config=config,
        trained_by="manual",
        model_version="v1.0",
    )

    print("✅ Modèle de demande entraîné avec succès")
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()



