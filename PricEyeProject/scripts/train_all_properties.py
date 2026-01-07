"""
Script CLI pour entraîner les modèles de demande pour toutes les propriétés actives.

Usage typique (depuis `PricEyeProject/`) :

    # Entraîner toutes les propriétés actives
    python -m scripts.train_all_properties

    # Entraîner une propriété spécifique
    python -m scripts.train_all_properties --property-id YOUR_PROPERTY_ID

    # Forcer la réentraînement même si modèle existe
    python -m scripts.train_all_properties --force

    # Spécifier une plage de dates personnalisée
    python -m scripts.train_all_properties --start-date 2023-01-01 --end-date 2023-12-31

Ce script :
- Liste les propriétés actives depuis Supabase
- Pour chaque propriété :
  * Vérifie si assez d'historique (minimum de jours requis)
  * Vérifie si modèle existe déjà (sauf si --force)
  * Construit le dataset via `build_pricing_dataset`
  * Entraîne le modèle via `train_demand_model_for_property`
  * Sauvegarde les métriques
- Génère un rapport JSON final avec statistiques et erreurs
"""

import argparse
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from pricing_engine.dataset_builder import build_pricing_dataset
from pricing_engine.interfaces.data_access import get_internal_pricing_data, get_supabase_client
from pricing_engine.models.demand_model import (
    DemandModelConfig,
    train_demand_model_for_property,
)

MODELS_DIR = Path("pricing_models")
MODELS_DIR.mkdir(exist_ok=True)


def get_active_properties(property_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    Récupère les propriétés actives depuis Supabase.

    Si `property_id` est fourni, retourne uniquement cette propriété.
    Sinon, retourne toutes les propriétés avec `status = 'active'`.
    """
    client = get_supabase_client()

    query = client.table("properties").select("*")

    if property_id:
        query = query.eq("id", property_id)
    else:
        query = query.eq("status", "active")

    try:
        response = query.execute()

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


def check_model_exists(property_id: str) -> bool:
    """
    Vérifie si un modèle existe déjà pour une propriété.
    """
    model_path = MODELS_DIR / f"demand_model_{property_id}.json"
    meta_path = MODELS_DIR / f"demand_model_{property_id}.meta.json"
    return model_path.exists() and meta_path.exists()


def check_sufficient_history(
    property_id: str,
    start_date: str,
    end_date: str,
    min_days: int,
) -> Tuple[bool, int]:
    """
    Vérifie si une propriété a suffisamment d'historique.

    Retourne (has_sufficient_data, actual_days_count).
    """
    try:
        records = get_internal_pricing_data(property_id, start_date, end_date)
        actual_days = len(records)
        return actual_days >= min_days, actual_days
    except Exception as e:
        # En cas d'erreur, on considère qu'il n'y a pas assez de données
        print(f"  ⚠️  Erreur lors de la vérification de l'historique: {e}")
        return False, 0


def train_property_model(
    property_id: str,
    start_date: str,
    end_date: str,
    force: bool = False,
    min_days: int = 90,
) -> Dict[str, Any]:
    """
    Entraîne un modèle pour une propriété donnée.

    Retourne un dictionnaire avec les résultats (succès/échec, métriques, erreurs).
    """
    result: Dict[str, Any] = {
        "property_id": property_id,
        "success": False,
        "skipped": False,
        "skip_reason": None,
        "metrics": None,
        "n_rows": 0,
        "error": None,
    }

    try:
        # Vérifier si le modèle existe déjà
        if not force and check_model_exists(property_id):
            result["skipped"] = True
            result["skip_reason"] = "Modèle existe déjà (utilisez --force pour réentraîner)"
            return result

        # Vérifier l'historique
        has_sufficient_data, actual_days = check_sufficient_history(
            property_id, start_date, end_date, min_days
        )

        if not has_sufficient_data:
            result["skipped"] = True
            result["skip_reason"] = f"Données insuffisantes: {actual_days} jours (minimum requis: {min_days})"
            return result

        # Construire le dataset
        print(f"  📊 Construction du dataset pour {property_id}...")
        df = build_pricing_dataset(property_id=property_id, start_date=start_date, end_date=end_date)

        if df.empty:
            result["skipped"] = True
            result["skip_reason"] = "Dataset vide après construction"
            return result

        result["n_rows"] = len(df)

        # Entraîner le modèle
        print(f"  🎯 Entraînement du modèle pour {property_id}...")
        training_result = train_demand_model_for_property(
            property_id=property_id,
            start_date=start_date,
            end_date=end_date,
            config=None,  # Utiliser la config par défaut
            trained_by="batch",
            model_version="v1.0",
        )

        result["success"] = True
        result["metrics"] = training_result.get("metrics", {})
        result["n_rows"] = training_result.get("n_rows", len(df))

        print(f"  ✅ Modèle entraîné avec succès (RMSE val: {result['metrics'].get('val_rmse', 'N/A'):.2f})")

    except Exception as e:
        error_msg = str(e)
        result["error"] = error_msg
        print(f"  ❌ Erreur: {error_msg}")

    return result


def format_duration(seconds: float) -> str:
    """Formate une durée en secondes en une chaîne lisible."""
    if seconds < 60:
        return f"{seconds:.1f}s"
    elif seconds < 3600:
        minutes = int(seconds // 60)
        secs = seconds % 60
        return f"{minutes}m {secs:.1f}s"
    else:
        hours = int(seconds // 3600)
        minutes = int((seconds % 3600) // 60)
        return f"{hours}h {minutes}m"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Entraîner les modèles de demande pour toutes les propriétés actives."
    )
    parser.add_argument(
        "--property-id",
        type=str,
        default=None,
        help="Entraîner seulement cette propriété (optionnel).",
    )
    parser.add_argument(
        "--min-days",
        type=int,
        default=90,
        help="Minimum de jours d'historique requis (défaut: 90).",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Réentraîner même si modèle existe déjà.",
    )
    parser.add_argument(
        "--start-date",
        type=str,
        default=None,
        help="Date de début pour l'historique (format: YYYY-MM-DD). Par défaut: 90 jours avant aujourd'hui.",
    )
    parser.add_argument(
        "--end-date",
        type=str,
        default=None,
        help="Date de fin (format: YYYY-MM-DD). Par défaut: aujourd'hui.",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="Fichier de sortie pour le rapport JSON (optionnel). Par défaut: affichage sur stdout.",
    )

    args = parser.parse_args()

    # Calculer les dates par défaut si non fournies
    today = datetime.now().date()
    if args.end_date:
        end_date = datetime.strptime(args.end_date, "%Y-%m-%d").date()
    else:
        end_date = today

    if args.start_date:
        start_date = datetime.strptime(args.start_date, "%Y-%m-%d").date()
    else:
        # Par défaut: 90 jours avant end_date
        start_date = end_date - timedelta(days=90)

    start_date_str = start_date.isoformat()
    end_date_str = end_date.isoformat()

    print("=" * 80)
    print("🚀 Entraînement des modèles de demande")
    print("=" * 80)
    print(f"📅 Plage de dates: {start_date_str} → {end_date_str}")
    print(f"📊 Minimum de jours requis: {args.min_days}")
    print(f"🔄 Force réentraînement: {args.force}")
    if args.property_id:
        print(f"🎯 Propriété spécifique: {args.property_id}")
    print()

    # Récupérer les propriétés
    try:
        print("📋 Récupération des propriétés actives...")
        properties = get_active_properties(args.property_id)

        if not properties:
            print("❌ Aucune propriété trouvée.")
            sys.exit(1)

        print(f"✅ {len(properties)} propriété(s) trouvée(s)")
        print()

    except Exception as e:
        print(f"❌ Erreur lors de la récupération des propriétés: {e}")
        sys.exit(1)

    # Initialiser le rapport
    report: Dict[str, Any] = {
        "started_at": datetime.utcnow().isoformat(),
        "date_range": {"start": start_date_str, "end": end_date_str},
        "min_days": args.min_days,
        "force": args.force,
        "total_properties": len(properties),
        "results": [],
        "summary": {
            "success": 0,
            "skipped": 0,
            "failed": 0,
        },
    }

    # Traiter chaque propriété
    start_time = datetime.now()

    for idx, property_data in enumerate(properties, 1):
        property_id = property_data.get("id")
        property_name = property_data.get("name") or property_data.get("title") or "Sans nom"

        print(f"[{idx}/{len(properties)}] 🏠 {property_name} ({property_id})")

        result = train_property_model(
            property_id=property_id,
            start_date=start_date_str,
            end_date=end_date_str,
            force=args.force,
            min_days=args.min_days,
        )

        report["results"].append(result)

        # Mettre à jour le résumé
        if result["success"]:
            report["summary"]["success"] += 1
        elif result["skipped"]:
            report["summary"]["skipped"] += 1
        else:
            report["summary"]["failed"] += 1

        print()  # Ligne vide entre les propriétés

    # Finaliser le rapport
    end_time = datetime.now()
    duration = (end_time - start_time).total_seconds()
    report["completed_at"] = datetime.utcnow().isoformat()
    report["duration_seconds"] = duration

    # Afficher le résumé
    print("=" * 80)
    print("📊 RÉSUMÉ")
    print("=" * 80)
    print(f"✅ Succès: {report['summary']['success']}")
    print(f"⏭️  Ignorées: {report['summary']['skipped']}")
    print(f"❌ Échecs: {report['summary']['failed']}")
    print(f"⏱️  Durée: {format_duration(duration)}")
    print()

    # Afficher les détails des échecs
    failures = [r for r in report["results"] if not r["success"] and not r["skipped"]]
    if failures:
        print("❌ Échecs détaillés:")
        for failure in failures:
            print(f"  - {failure['property_id']}: {failure.get('error', 'Erreur inconnue')}")
        print()

    # Sauvegarder ou afficher le rapport JSON
    report_json = json.dumps(report, indent=2, ensure_ascii=False)

    if args.output:
        output_path = Path(args.output)
        output_path.write_text(report_json, encoding="utf-8")
        print(f"💾 Rapport sauvegardé dans: {output_path}")
    else:
        print("📄 Rapport JSON:")
        print(report_json)

    # Code de sortie approprié
    exit_code = 0 if report["summary"]["failed"] == 0 else 1
    sys.exit(exit_code)


if __name__ == "__main__":
    main()

