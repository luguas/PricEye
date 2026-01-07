"""
Script de réentraînement intelligent des modèles de demande à partir des logs de pricing.

Ce script détecte automatiquement les propriétés qui ont besoin d'être réentraînées
en se basant sur :
- La date du dernier entraînement
- Le nombre de nouvelles recommandations
- La dégradation des performances

Usage (depuis `PricEyeProject/`) :

    # Réentraînement automatique avec critères par défaut
    python -m scripts.retrain_demand_models_from_logs

    # Personnaliser les critères
    python -m scripts.retrain_demand_models_from_logs --min-new-recommendations 100 --min-days-since-training 60

    # Forcer le réentraînement même si critères non remplis
    python -m scripts.retrain_demand_models_from_logs --force
"""

import argparse
import json
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from supabase import create_client  # type: ignore

from market_data_pipeline.config.settings import Settings
from pricing_engine.models.demand_model import train_demand_model_for_property

MODELS_DIR = Path("pricing_models")


def get_supabase_client():
    settings = Settings.from_env()
    if not settings.supabase_url or not settings.supabase_key:
        raise RuntimeError(
            "SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY/SUPABASE_KEY doivent être configurés."
        )
    return create_client(settings.supabase_url, settings.supabase_key)


def get_latest_model_metrics(property_id: str) -> Optional[Dict[str, Any]]:
    """
    Récupère les métriques du dernier modèle entraîné pour une propriété.
    """
    client = get_supabase_client()

    response = (
        client.table("pricing_model_metrics")
        .select("*")
        .eq("property_id", property_id)
        .order("trained_at", desc=True)
        .limit(1)
        .execute()
    )

    if not hasattr(response, "data") or not response.data:
        return None

    return response.data[0] if response.data else None


def count_new_recommendations_since_training(
    property_id: str, last_training_date: datetime
) -> int:
    """
    Compte le nombre de nouvelles recommandations depuis le dernier entraînement.
    """
    client = get_supabase_client()

    response = (
        client.table("pricing_recommendations")
        .select("id", count="exact")
        .eq("property_id", property_id)
        .gte("created_at", last_training_date.isoformat())
        .execute()
    )

    if not hasattr(response, "count"):
        # Fallback : compter les données
        data = response.data or []
        return len(data)

    return response.count or 0


def check_model_performance_degradation(
    property_id: str, threshold: float = 0.2
) -> Tuple[bool, Optional[float]]:
    """
    Vérifie si les performances du modèle se dégradent.

    Compare les val_rmse des 2 derniers modèles.
    Retourne (is_degrading, degradation_ratio) où degradation_ratio est positif si dégradation.
    """
    client = get_supabase_client()

    response = (
        client.table("pricing_model_metrics")
        .select("val_rmse, trained_at")
        .eq("property_id", property_id)
        .order("trained_at", desc=True)
        .limit(2)
        .execute()
    )

    if not hasattr(response, "data") or not response.data or len(response.data) < 2:
        return False, None

    latest_rmse = float(response.data[0]["val_rmse"])
    previous_rmse = float(response.data[1]["val_rmse"])

    if previous_rmse == 0:
        return False, None

    degradation_ratio = (latest_rmse - previous_rmse) / previous_rmse
    is_degrading = degradation_ratio > threshold

    return is_degrading, degradation_ratio


def should_retrain_property(
    property_id: str,
    min_new_recommendations: int,
    min_days_since_training: int,
    force: bool = False,
) -> Tuple[bool, str, Dict[str, Any]]:
    """
    Détermine si une propriété doit être réentraînée.

    Retourne (should_retrain, reason, context).
    """
    if force:
        return True, "Force réentraînement demandé", {}

    # Vérifier si un modèle existe
    latest_metrics = get_latest_model_metrics(property_id)
    if not latest_metrics:
        return False, "Aucun modèle existant", {}

    # Vérifier la date du dernier entraînement
    last_training_str = latest_metrics.get("trained_at")
    if not last_training_str:
        return False, "Date d'entraînement manquante", {}

    try:
        last_training_date = datetime.fromisoformat(
            last_training_str.replace("Z", "+00:00")
        )
    except Exception:
        return False, "Format de date invalide", {}

    days_since_training = (datetime.now(last_training_date.tzinfo) - last_training_date).days

    # Critère 1 : ≥ min_days_since_training ET ≥ min_new_recommendations
    new_recommendations = count_new_recommendations_since_training(
        property_id, last_training_date
    )

    if days_since_training >= min_days_since_training and new_recommendations >= min_new_recommendations:
        return (
            True,
            f"{days_since_training} jours depuis entraînement et {new_recommendations} nouvelles recommandations",
            {
                "days_since_training": days_since_training,
                "new_recommendations": new_recommendations,
                "last_training_date": last_training_str,
            },
        )

    # Critère 2 : Dégradation de performance > 20%
    is_degrading, degradation_ratio = check_model_performance_degradation(property_id, threshold=0.2)
    if is_degrading and degradation_ratio:
        return (
            True,
            f"Dégradation de performance détectée ({degradation_ratio * 100:.1f}%)",
            {
                "degradation_ratio": degradation_ratio,
                "last_training_date": last_training_str,
            },
        )

    # Ne pas réentraîner
    return (
        False,
        f"Critères non remplis (jours: {days_since_training}/{min_days_since_training}, nouvelles recs: {new_recommendations}/{min_new_recommendations})",
        {
            "days_since_training": days_since_training,
            "new_recommendations": new_recommendations,
            "last_training_date": last_training_str,
        },
    )


def backup_model(property_id: str) -> Optional[Tuple[str, str]]:
    """
    Sauvegarde une copie de l'ancien modèle avant réentraînement.
    Retourne (backup_model_path, backup_meta_path) ou None si erreur.
    """
    model_path = MODELS_DIR / f"demand_model_{property_id}.json"
    meta_path = MODELS_DIR / f"demand_model_{property_id}.meta.json"

    if not model_path.exists() or not meta_path.exists():
        return None

    try:
        backup_dir = MODELS_DIR / "backups"
        backup_dir.mkdir(exist_ok=True)

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_model_path = backup_dir / f"demand_model_{property_id}_{timestamp}.json"
        backup_meta_path = backup_dir / f"demand_model_{property_id}_{timestamp}.meta.json"

        # Copier les fichiers
        import shutil

        shutil.copy2(model_path, backup_model_path)
        shutil.copy2(meta_path, backup_meta_path)

        return (str(backup_model_path), str(backup_meta_path))
    except Exception as e:
        print(f"  ⚠️  Erreur lors du backup du modèle: {e}")
        return None


def restore_model(property_id: str, backup_model_path: str, backup_meta_path: str) -> bool:
    """
    Restaure un modèle depuis un backup.
    Retourne True si succès, False sinon.
    """
    try:
        import shutil

        model_path = MODELS_DIR / f"demand_model_{property_id}.json"
        meta_path = MODELS_DIR / f"demand_model_{property_id}.meta.json"

        shutil.copy2(backup_model_path, model_path)
        shutil.copy2(backup_meta_path, meta_path)

        return True
    except Exception as e:
        print(f"  ⚠️  Erreur lors de la restauration du modèle: {e}")
        return False


def retrain_property_with_comparison(
    property_id: str,
    start_date: str,
    end_date: str,
    min_improvement: float = 0.05,
    force: bool = False,
) -> Dict[str, Any]:
    """
    Réentraîne un modèle pour une propriété et compare les performances.

    Retourne un dictionnaire avec les résultats de la comparaison.
    """
    result: Dict[str, Any] = {
        "property_id": property_id,
        "success": False,
        "model_replaced": False,
        "old_metrics": None,
        "new_metrics": None,
        "improvement": None,
        "error": None,
    }

    try:
        # Récupérer les métriques de l'ancien modèle
        old_metrics = get_latest_model_metrics(property_id)
        if old_metrics:
            result["old_metrics"] = {
                "val_rmse": old_metrics.get("val_rmse"),
                "train_rmse": old_metrics.get("train_rmse"),
                "trained_at": old_metrics.get("trained_at"),
                "model_version": old_metrics.get("model_version"),
            }

        # Faire un backup de l'ancien modèle
        backup_paths = backup_model(property_id)
        backup_model_path = None
        backup_meta_path = None
        if backup_paths:
            backup_model_path, backup_meta_path = backup_paths
            print(f"  💾 Backup créé: {backup_model_path}")

        # Entraîner le nouveau modèle
        print(f"  🎯 Entraînement du nouveau modèle...")
        training_result = train_demand_model_for_property(
            property_id=property_id,
            start_date=start_date,
            end_date=end_date,
            config=None,
            trained_by="auto_retrain",
            model_version="v1.0",
        )

        # Récupérer les métriques du nouveau modèle
        new_metrics = get_latest_model_metrics(property_id)
        if new_metrics:
            result["new_metrics"] = {
                "val_rmse": new_metrics.get("val_rmse"),
                "train_rmse": new_metrics.get("train_rmse"),
                "trained_at": new_metrics.get("trained_at"),
                "model_version": new_metrics.get("model_version"),
            }

        result["success"] = True

        # Comparer les performances
        if old_metrics and new_metrics:
            old_val_rmse = float(old_metrics.get("val_rmse", 0))
            new_val_rmse = float(new_metrics.get("val_rmse", 0))

            if old_val_rmse > 0:
                improvement_ratio = (old_val_rmse - new_val_rmse) / old_val_rmse
                result["improvement"] = improvement_ratio

                if force:
                    # En mode force, toujours remplacer
                    result["model_replaced"] = True
                    print(f"  ✅ Modèle remplacé (force mode)")
                elif improvement_ratio >= min_improvement:
                    # Amélioration suffisante : garder le nouveau modèle
                    result["model_replaced"] = True
                    print(
                        f"  ✅ Modèle remplacé (amélioration: {improvement_ratio * 100:.1f}%)"
                    )
                elif improvement_ratio < -0.05:
                    # Dégradation significative : restaurer l'ancien modèle
                    result["model_replaced"] = False
                    print(
                        f"  ⚠️  Dégradation détectée ({improvement_ratio * 100:.1f}%), restauration de l'ancien modèle"
                    )
                    if backup_model_path and backup_meta_path:
                        if restore_model(property_id, backup_model_path, backup_meta_path):
                            print(f"  ✅ Ancien modèle restauré avec succès")
                        else:
                            print(f"  ❌ Erreur lors de la restauration du modèle")
                    else:
                        print(f"  ⚠️  Pas de backup disponible pour restauration")
                else:
                    # Amélioration insuffisante : ne pas remplacer
                    result["model_replaced"] = False
                    print(
                        f"  ⏭️  Amélioration insuffisante ({improvement_ratio * 100:.1f}% < {min_improvement * 100:.1f}%), ancien modèle conservé"
                    )
            else:
                result["model_replaced"] = True
                print(f"  ✅ Nouveau modèle (pas d'ancien modèle valide pour comparaison)")

    except Exception as e:
        result["error"] = str(e)
        print(f"  ❌ Erreur: {e}")
        import traceback

        traceback.print_exc()

    return result


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Réentraînement intelligent des modèles de demande à partir des logs."
    )
    parser.add_argument(
        "--days",
        type=int,
        default=180,
        help="Nombre de jours d'historique à utiliser pour l'entraînement (défaut: 180).",
    )
    parser.add_argument(
        "--min-new-recommendations",
        type=int,
        default=50,
        help="Minimum de nouvelles recommandations depuis le dernier entraînement (défaut: 50).",
    )
    parser.add_argument(
        "--min-days-since-training",
        type=int,
        default=30,
        help="Minimum de jours depuis le dernier entraînement (défaut: 30).",
    )
    parser.add_argument(
        "--min-improvement",
        type=float,
        default=0.05,
        help="Amélioration minimale pour remplacer le modèle (défaut: 0.05 = 5%).",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Réentraîner même si les critères ne sont pas remplis.",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="Fichier de sortie pour le rapport JSON (optionnel).",
    )

    args = parser.parse_args()

    print("=" * 80)
    print("🔄 RÉENTRAÎNEMENT INTELLIGENT DES MODÈLES DE DEMANDE")
    print("=" * 80)
    print(f"📊 Critères de réentraînement:")
    print(f"   - Minimum de jours depuis entraînement: {args.min_days_since_training}")
    print(f"   - Minimum de nouvelles recommandations: {args.min_new_recommendations}")
    print(f"   - Amélioration minimale pour remplacer: {args.min_improvement * 100:.1f}%")
    print(f"   - Mode force: {args.force}")
    print()

    client = get_supabase_client()

    # Récupérer toutes les propriétés avec un modèle existant
    print("📋 Recherche des propriétés avec modèles existants...")
    response = (
        client.table("pricing_model_metrics")
        .select("property_id")
        .execute()
    )

    if not hasattr(response, "data"):
        print("❌ Erreur lors de la récupération des propriétés")
        return

    all_property_ids = sorted(
        {row["property_id"] for row in (response.data or []) if row.get("property_id")}
    )

    print(f"✅ {len(all_property_ids)} propriété(s) avec modèle(s) trouvée(s)")
    print()

    # Analyser chaque propriété
    properties_to_retrain = []
    properties_skipped = []

    for property_id in all_property_ids:
        should_retrain, reason, context = should_retrain_property(
            property_id=property_id,
            min_new_recommendations=args.min_new_recommendations,
            min_days_since_training=args.min_days_since_training,
            force=args.force,
        )

        if should_retrain:
            properties_to_retrain.append(
                {
                    "property_id": property_id,
                    "reason": reason,
                    "context": context,
                }
            )
            print(f"✅ {property_id[:8]}... : {reason}")
        else:
            properties_skipped.append(
                {
                    "property_id": property_id,
                    "reason": reason,
                    "context": context,
                }
            )
            print(f"⏭️  {property_id[:8]}... : {reason}")

    print()
    print("=" * 80)
    print(f"📊 {len(properties_to_retrain)} propriété(s) à réentraîner")
    print(f"⏭️  {len(properties_skipped)} propriété(s) ignorée(s)")
    print("=" * 80)
    print()

    if not properties_to_retrain:
        print("✅ Aucune propriété à réentraîner selon les critères.")
        return

    # Calculer les dates pour l'entraînement
    end_date = date.today()
    start_date = end_date - timedelta(days=args.days)

    # Réentraîner chaque propriété
    report: Dict[str, Any] = {
        "started_at": datetime.utcnow().isoformat(),
        "criteria": {
            "min_new_recommendations": args.min_new_recommendations,
            "min_days_since_training": args.min_days_since_training,
            "min_improvement": args.min_improvement,
            "force": args.force,
        },
        "training_period": {
            "start": start_date.isoformat(),
            "end": end_date.isoformat(),
            "days": args.days,
        },
        "results": [],
        "summary": {
            "total_processed": 0,
            "success": 0,
            "model_replaced": 0,
            "model_kept": 0,
            "errors": 0,
        },
    }

    for idx, prop_info in enumerate(properties_to_retrain, 1):
        property_id = prop_info["property_id"]
        print(f"[{idx}/{len(properties_to_retrain)}] 🏠 {property_id[:8]}...")
        print(f"   Raison: {prop_info['reason']}")

        result = retrain_property_with_comparison(
            property_id=property_id,
            start_date=start_date.isoformat(),
            end_date=end_date.isoformat(),
            min_improvement=args.min_improvement,
            force=args.force,
        )

        result["retrain_reason"] = prop_info["reason"]
        result["retrain_context"] = prop_info["context"]
        report["results"].append(result)

        # Mettre à jour le résumé
        report["summary"]["total_processed"] += 1
        if result["success"]:
            report["summary"]["success"] += 1
            if result.get("model_replaced"):
                report["summary"]["model_replaced"] += 1
            else:
                report["summary"]["model_kept"] += 1
        else:
            report["summary"]["errors"] += 1

        print()

    # Finaliser le rapport
    report["completed_at"] = datetime.utcnow().isoformat()
    duration = (
        datetime.fromisoformat(report["completed_at"].replace("Z", "+00:00"))
        - datetime.fromisoformat(report["started_at"].replace("Z", "+00:00"))
    ).total_seconds()
    report["duration_seconds"] = duration

    # Afficher le résumé
    print("=" * 80)
    print("📊 RÉSUMÉ")
    print("=" * 80)
    print(f"✅ Succès: {report['summary']['success']}")
    print(f"🔄 Modèles remplacés: {report['summary']['model_replaced']}")
    print(f"⏸️  Modèles conservés: {report['summary']['model_kept']}")
    print(f"❌ Erreurs: {report['summary']['errors']}")
    print(f"⏱️  Durée: {duration:.1f}s")
    print()

    # Afficher les détails des modèles remplacés
    replaced = [r for r in report["results"] if r.get("model_replaced")]
    if replaced:
        print("🔄 Modèles remplacés avec succès:")
        for r in replaced:
            improvement = r.get("improvement")
            if improvement is not None:
                print(
                    f"   - {r['property_id'][:8]}... : amélioration {improvement * 100:.1f}%"
                )
            else:
                print(f"   - {r['property_id'][:8]}... : nouveau modèle")
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


if __name__ == "__main__":
    main()
