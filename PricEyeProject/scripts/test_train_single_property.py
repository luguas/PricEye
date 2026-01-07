"""
Script de test pour entraîner un modèle de demande sur une propriété réelle.

Usage (depuis `PricEyeProject/`) :

    python -m scripts.test_train_single_property --property-id YOUR_PROPERTY_ID

Ce script :
- Vérifie que la propriété existe et est active
- Vérifie qu'il y a assez de données (≥ 90 jours d'historique)
- Entraîne le modèle
- Affiche les métriques (RMSE train/val, nombre de lignes, features utilisées)
- Teste une prédiction avec `predict_demand()`
- Vérifie que les fichiers de modèle sont sauvegardés
"""

import argparse
import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Tuple

from pricing_engine.dataset_builder import build_pricing_dataset
from pricing_engine.interfaces.data_access import (
    get_internal_pricing_data,
    get_supabase_client,
)
from pricing_engine.models.demand_model import (
    DemandModelConfig,
    predict_demand,
    train_demand_model_for_property,
)

MODELS_DIR = Path("pricing_models")


def check_property_exists(property_id: str) -> dict:
    """
    Vérifie que la propriété existe et est active.

    Retourne les données de la propriété ou None si elle n'existe pas.
    """
    client = get_supabase_client()

    try:
        response = (
            client.table("properties")
            .select("*")
            .eq("id", property_id)
            .maybe_single()
            .execute()
        )

        # Vérifier si response.data existe (compatible avec différentes versions de Supabase)
        if not hasattr(response, 'data'):
            raise RuntimeError("Réponse Supabase invalide: pas d'attribut 'data'")

        if not response.data:
            return None

        return response.data
    except Exception as e:
        # Si c'est déjà une RuntimeError, la relancer
        if isinstance(e, RuntimeError):
            raise
        # Sinon, envelopper dans une RuntimeError
        raise RuntimeError(f"Erreur lors de la vérification de la propriété: {e}") from e


def check_sufficient_history(property_id: str, min_days: int = 90) -> Tuple[bool, int, str, str]:
    """
    Vérifie qu'il y a assez de données historiques.

    Retourne (has_sufficient_data, actual_days, start_date, end_date).
    """
    end_date = datetime.now().date()
    start_date = end_date - timedelta(days=min_days * 2)  # On prend une marge pour être sûr

    start_date_str = start_date.isoformat()
    end_date_str = end_date.isoformat()

    try:
        records = get_internal_pricing_data(property_id, start_date_str, end_date_str)
        actual_days = len(records)
        return actual_days >= min_days, actual_days, start_date_str, end_date_str
    except Exception as e:
        print(f"  ⚠️  Erreur lors de la vérification de l'historique: {e}")
        return False, 0, start_date_str, end_date_str


def check_model_files(property_id: str) -> Tuple[bool, bool]:
    """
    Vérifie si les fichiers de modèle existent.

    Retourne (model_exists, meta_exists).
    """
    model_path = MODELS_DIR / f"demand_model_{property_id}.json"
    meta_path = MODELS_DIR / f"demand_model_{property_id}.meta.json"
    return model_path.exists(), meta_path.exists()


def load_model_metadata(property_id: str) -> dict:
    """
    Charge les métadonnées du modèle sauvegardé.
    """
    meta_path = MODELS_DIR / f"demand_model_{property_id}.meta.json"
    if not meta_path.exists():
        return {}

    try:
        return json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"  ⚠️  Erreur lors du chargement des métadonnées: {e}")
        return {}


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Tester l'entraînement d'un modèle de demande sur une propriété réelle."
    )
    parser.add_argument(
        "--property-id",
        type=str,
        required=True,
        help="ID de la propriété à tester (UUID Supabase).",
    )
    parser.add_argument(
        "--min-days",
        type=int,
        default=90,
        help="Minimum de jours d'historique requis (défaut: 90).",
    )
    parser.add_argument(
        "--start-date",
        type=str,
        default=None,
        help="Date de début pour l'historique (format: YYYY-MM-DD). Par défaut: calculée automatiquement.",
    )
    parser.add_argument(
        "--end-date",
        type=str,
        default=None,
        help="Date de fin (format: YYYY-MM-DD). Par défaut: aujourd'hui.",
    )

    args = parser.parse_args()

    print("=" * 80)
    print("🧪 TEST D'ENTRAÎNEMENT DE MODÈLE DE DEMANDE")
    print("=" * 80)
    print(f"🏠 Property ID: {args.property_id}")
    print()

    # 1. Vérifier que la propriété existe et est active
    print("1️⃣  Vérification de la propriété...")
    property_data = check_property_exists(args.property_id)

    if not property_data:
        print(f"❌ Propriété {args.property_id} non trouvée dans la base de données.")
        return

    property_name = property_data.get("name") or property_data.get("title") or "Sans nom"
    property_status = property_data.get("status", "unknown")
    property_city = property_data.get("city", "N/A")
    property_country = property_data.get("country", "N/A")

    print(f"✅ Propriété trouvée: {property_name}")
    print(f"   📍 Localisation: {property_city}, {property_country}")
    print(f"   📊 Statut: {property_status}")

    if property_status != "active":
        print(f"⚠️  Attention: La propriété n'est pas active (statut: {property_status})")
    print()

    # 2. Vérifier qu'il y a assez de données
    print("2️⃣  Vérification de l'historique de données...")

    if args.start_date and args.end_date:
        start_date_str = args.start_date
        end_date_str = args.end_date
        has_sufficient, actual_days, _, _ = check_sufficient_history(
            args.property_id, args.min_days
        )
    else:
        has_sufficient, actual_days, start_date_str, end_date_str = check_sufficient_history(
            args.property_id, args.min_days
        )

    print(f"   📅 Plage de dates: {start_date_str} → {end_date_str}")
    print(f"   📊 Jours de données disponibles: {actual_days}")

    if not has_sufficient:
        print(f"❌ Données insuffisantes: {actual_days} jours (minimum requis: {args.min_days})")
        return

    print(f"✅ Données suffisantes ({actual_days} jours)")
    print()

    # 3. Construire le dataset
    print("3️⃣  Construction du dataset...")
    try:
        df = build_pricing_dataset(
            property_id=args.property_id,
            start_date=start_date_str,
            end_date=end_date_str,
        )

        if df.empty:
            print("❌ Dataset vide après construction")
            return

        print(f"✅ Dataset construit: {len(df)} lignes, {len(df.columns)} colonnes")
        print(f"   Colonnes: {', '.join(df.columns.tolist()[:10])}{'...' if len(df.columns) > 10 else ''}")
        print()
    except Exception as e:
        print(f"❌ Erreur lors de la construction du dataset: {e}")
        import traceback

        traceback.print_exc()
        return

    # 4. Entraîner le modèle
    print("4️⃣  Entraînement du modèle...")
    start_time = datetime.now()

    try:
        result = train_demand_model_for_property(
            property_id=args.property_id,
            start_date=start_date_str,
            end_date=end_date_str,
            config=None,  # Utiliser la config par défaut
            trained_by="manual",
            model_version="v1.0",
        )

        end_time = datetime.now()
        duration = (end_time - start_time).total_seconds()

        print(f"✅ Modèle entraîné en {duration:.1f} secondes")
        print()
    except Exception as e:
        print(f"❌ Erreur lors de l'entraînement: {e}")
        import traceback

        traceback.print_exc()
        return

    # 5. Afficher les métriques
    print("5️⃣  Métriques d'entraînement:")
    metrics = result.get("metrics", {})
    print(f"   📊 RMSE (train): {metrics.get('train_rmse', 'N/A'):.4f}")
    print(f"   📊 RMSE (validation): {metrics.get('val_rmse', 'N/A'):.4f}")
    print(f"   📈 Nombre de lignes: {result.get('n_rows', 0)}")
    print()

    # 6. Vérifier que les fichiers sont sauvegardés
    print("6️⃣  Vérification des fichiers de modèle...")
    model_exists, meta_exists = check_model_files(args.property_id)

    if model_exists and meta_exists:
        print("✅ Fichiers de modèle sauvegardés:")
        print(f"   📄 Modèle: {MODELS_DIR / f'demand_model_{args.property_id}.json'}")
        print(f"   📄 Métadonnées: {MODELS_DIR / f'demand_model_{args.property_id}.meta.json'}")
    else:
        print(f"❌ Fichiers manquants: model={model_exists}, meta={meta_exists}")
        return

    # Charger et afficher les métadonnées
    metadata = load_model_metadata(args.property_id)
    if metadata:
        print()
        print("   📋 Métadonnées du modèle:")
        print(f"      - Features utilisées: {len(metadata.get('feature_columns', []))}")
        print(f"      - Sauvegardé le: {metadata.get('saved_at', 'N/A')}")
        if metadata.get("feature_columns"):
            print(f"      - Exemples de features: {', '.join(metadata['feature_columns'][:5])}...")
    print()

    # 7. Tester une prédiction
    print("7️⃣  Test de prédiction...")
    try:
        # Utiliser une date récente pour la prédiction
        test_date = (datetime.now() + timedelta(days=7)).date().isoformat()
        test_price = 150.0  # Prix de test

        predicted_demand = predict_demand(
            property_id=args.property_id,
            room_type="default",
            date=test_date,
            price=test_price,
            context_features={},
        )

        print(f"✅ Prédiction réussie:")
        print(f"   📅 Date: {test_date}")
        print(f"   💰 Prix: {test_price}")
        print(f"   📊 Demande prédite: {predicted_demand:.2f}")
        print()
    except Exception as e:
        print(f"❌ Erreur lors de la prédiction: {e}")
        import traceback

        traceback.print_exc()
        return

    # Résumé final
    print("=" * 80)
    print("✅ TEST RÉUSSI")
    print("=" * 80)
    print(f"🏠 Propriété: {property_name} ({args.property_id})")
    print(f"📊 Métriques: RMSE train={metrics.get('train_rmse', 'N/A'):.4f}, val={metrics.get('val_rmse', 'N/A'):.4f}")
    print(f"⏱️  Temps d'entraînement: {duration:.1f}s")
    print(f"📈 Lignes de données: {result.get('n_rows', 0)}")
    print(f"🎯 Prédiction test: {predicted_demand:.2f} demandes pour {test_price}€")
    print()


if __name__ == "__main__":
    main()

