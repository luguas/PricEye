"""
Test end-to-end complet du moteur de pricing IA.

Ce script teste le flux complet :
1. Vérifier qu'une propriété de test existe
2. Construire le dataset pour cette propriété
3. Entraîner le modèle
4. Vérifier que le modèle est sauvegardé
5. Vérifier que les métriques sont dans la base
6. Appeler l'API /api/pricing/recommend
7. Vérifier que la recommandation est logguée
8. Simuler des logs supplémentaires
9. Réentraîner le modèle
10. Vérifier que les nouvelles métriques sont mises à jour

Usage:
    python -m scripts.test_pricing_engine_e2e --property-id <PROPERTY_ID>
    python -m scripts.test_pricing_engine_e2e --property-id <PROPERTY_ID> --api-url http://localhost:5000
"""

import argparse
import json
import os
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Optional

import requests  # type: ignore

# Ajouter le répertoire parent au path pour les imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from pricing_engine.dataset_builder import build_pricing_dataset
from pricing_engine.interfaces.data_access import get_supabase_client
from pricing_engine.models.demand_model import train_demand_model_for_property
from supabase import create_client  # type: ignore

from market_data_pipeline.config.settings import Settings

MODELS_DIR = Path("pricing_models")


class Colors:
    """Codes couleur pour l'affichage dans le terminal."""
    GREEN = '\033[92m'
    RED = '\033[91m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    RESET = '\033[0m'
    BOLD = '\033[1m'


def print_step(step_num: int, description: str):
    """Affiche une étape du test."""
    print(f"\n{Colors.BOLD}{Colors.BLUE}{'='*80}{Colors.RESET}")
    print(f"{Colors.BOLD}ÉTAPE {step_num}: {description}{Colors.RESET}")
    print(f"{Colors.BLUE}{'='*80}{Colors.RESET}\n")


def print_success(message: str):
    """Affiche un message de succès."""
    print(f"{Colors.GREEN}✅ {message}{Colors.RESET}")


def print_error(message: str):
    """Affiche un message d'erreur."""
    print(f"{Colors.RED}❌ {message}{Colors.RESET}")


def print_warning(message: str):
    """Affiche un message d'avertissement."""
    print(f"{Colors.YELLOW}⚠️  {message}{Colors.RESET}")


def print_info(message: str):
    """Affiche un message d'information."""
    print(f"{Colors.BLUE}ℹ️  {message}{Colors.RESET}")


def get_supabase_client():
    """Récupère un client Supabase."""
    settings = Settings.from_env()
    if not settings.supabase_url or not settings.supabase_key:
        raise RuntimeError(
            "SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY/SUPABASE_KEY doivent être configurés."
        )
    return create_client(settings.supabase_url, settings.supabase_key)


def step1_verify_property(property_id: str) -> Dict[str, Any]:
    """Étape 1: Vérifier qu'une propriété de test existe."""
    print_step(1, "Vérification de l'existence de la propriété")
    
    client = get_supabase_client()
    
    response = (
        client.table("properties")
        .select("*")
        .eq("id", property_id)
        .execute()
    )
    
    if not hasattr(response, "data") or not response.data:
        raise RuntimeError(f"Propriété {property_id} non trouvée")
    
    property_data = response.data[0]
    print_success(f"Propriété trouvée: {property_data.get('name', 'N/A')}")
    print_info(f"  - ID: {property_id}")
    print_info(f"  - Ville: {property_data.get('city', 'N/A')}")
    print_info(f"  - Pays: {property_data.get('country', 'N/A')}")
    print_info(f"  - Prix de base: {property_data.get('base_price', 'N/A')}")
    
    return property_data


def step2_build_dataset(property_id: str, days: int = 180) -> Any:
    """Étape 2: Construire le dataset pour cette propriété."""
    print_step(2, "Construction du dataset de pricing")
    
    end_date = date.today()
    start_date = end_date - timedelta(days=days)
    
    print_info(f"Période: {start_date} → {end_date} ({days} jours)")
    
    try:
        df = build_pricing_dataset(
            property_id=property_id,
            start_date=start_date.isoformat(),
            end_date=end_date.isoformat(),
        )
        
        if df is None or df.empty:
            raise RuntimeError("Dataset vide ou None")
        
        print_success(f"Dataset construit: {len(df)} lignes")
        print_info(f"  - Colonnes: {len(df.columns)}")
        print_info(f"  - Colonnes: {', '.join(df.columns[:10])}...")
        print_info(f"  - Lignes avec demande > 0: {(df['y_demand'] > 0).sum()}")
        
        return df
        
    except Exception as e:
        print_error(f"Erreur lors de la construction du dataset: {e}")
        raise


def step3_train_model(property_id: str, start_date: str, end_date: str) -> Dict[str, Any]:
    """Étape 3: Entraîner le modèle."""
    print_step(3, "Entraînement du modèle de demande")
    
    try:
        result = train_demand_model_for_property(
            property_id=property_id,
            start_date=start_date,
            end_date=end_date,
            trained_by="e2e_test",
            model_version="v1.0",
        )
        
        print_success("Modèle entraîné avec succès")
        print_info(f"  - Train RMSE: {result.get('train_rmse', 'N/A')}")
        print_info(f"  - Val RMSE: {result.get('val_rmse', 'N/A')}")
        print_info(f"  - Train MAE: {result.get('train_mae', 'N/A')}")
        print_info(f"  - Val MAE: {result.get('val_mae', 'N/A')}")
        
        return result
        
    except Exception as e:
        print_error(f"Erreur lors de l'entraînement: {e}")
        raise


def step4_verify_model_saved(property_id: str) -> bool:
    """Étape 4: Vérifier que le modèle est sauvegardé."""
    print_step(4, "Vérification de la sauvegarde du modèle")
    
    model_path = MODELS_DIR / f"demand_model_{property_id}.json"
    meta_path = MODELS_DIR / f"demand_model_{property_id}.meta.json"
    
    if not model_path.exists():
        print_error(f"Fichier modèle non trouvé: {model_path}")
        return False
    
    if not meta_path.exists():
        print_error(f"Fichier meta non trouvé: {meta_path}")
        return False
    
    print_success(f"Modèle sauvegardé: {model_path}")
    print_success(f"Métadonnées sauvegardées: {meta_path}")
    
    # Vérifier la taille du fichier
    model_size = model_path.stat().st_size
    print_info(f"  - Taille du modèle: {model_size / 1024:.2f} KB")
    
    return True


def step5_verify_metrics_in_db(property_id: str) -> Optional[Dict[str, Any]]:
    """Étape 5: Vérifier que les métriques sont dans la base."""
    print_step(5, "Vérification des métriques dans la base de données")
    
    client = get_supabase_client()
    
    response = (
        client.table("pricing_model_metrics")
        .select("*")
        .eq("property_id", property_id)
        .eq("trained_by", "e2e_test")
        .order("trained_at", desc=True)
        .limit(1)
        .execute()
    )
    
    if not hasattr(response, "data") or not response.data:
        print_error("Aucune métrique trouvée dans la base")
        return None
    
    metrics = response.data[0]
    print_success("Métriques trouvées dans la base")
    print_info(f"  - Train RMSE: {metrics.get('train_rmse')}")
    print_info(f"  - Val RMSE: {metrics.get('val_rmse')}")
    print_info(f"  - Train MAE: {metrics.get('train_mae')}")
    print_info(f"  - Val MAE: {metrics.get('val_mae')}")
    print_info(f"  - Entraîné le: {metrics.get('trained_at')}")
    print_info(f"  - Version: {metrics.get('model_version')}")
    
    return metrics


def step6_call_api_recommend(
    property_id: str,
    api_url: str,
    auth_token: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Étape 6: Appeler l'API /api/pricing/recommend."""
    print_step(6, "Appel de l'API /api/pricing/recommend")
    
    url = f"{api_url}/api/pricing/recommend"
    
    # Date de test (demain)
    test_date = (date.today() + timedelta(days=1)).isoformat()
    
    payload = {
        "property_id": property_id,
        "date": test_date,
        "room_type": "default",
    }
    
    headers = {
        "Content-Type": "application/json",
    }
    
    if auth_token:
        headers["Authorization"] = f"Bearer {auth_token}"
    
    print_info(f"URL: {url}")
    print_info(f"Payload: {json.dumps(payload, indent=2)}")
    
    try:
        response = requests.post(url, json=payload, headers=headers, timeout=30)
        
        if response.status_code == 200:
            result = response.json()
            print_success("API appelée avec succès")
            print_info(f"  - Prix recommandé: {result.get('recommended_price')}")
            print_info(f"  - Stratégie: {result.get('strategy')}")
            print_info(f"  - Revenu attendu: {result.get('expected_revenue')}")
            print_info(f"  - Demande prédite: {result.get('predicted_demand')}")
            return result
        else:
            print_error(f"Erreur API: {response.status_code}")
            print_error(f"Réponse: {response.text}")
            return None
            
    except Exception as e:
        print_error(f"Erreur lors de l'appel API: {e}")
        return None


def step7_verify_recommendation_logged(property_id: str, test_date: str) -> bool:
    """Étape 7: Vérifier que la recommandation est logguée."""
    print_step(7, "Vérification du logging de la recommandation")
    
    client = get_supabase_client()
    
    # Attendre un peu pour que le log soit écrit
    time.sleep(2)
    
    response = (
        client.table("pricing_recommendations")
        .select("*")
        .eq("property_id", property_id)
        .eq("stay_date", test_date)
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    
    if not hasattr(response, "data") or not response.data:
        print_warning("Aucune recommandation logguée trouvée (peut être normal si le logging a échoué)")
        return False
    
    log_entry = response.data[0]
    print_success("Recommandation logguée trouvée")
    print_info(f"  - Prix recommandé: {log_entry.get('recommended_price')}")
    print_info(f"  - Stratégie: {log_entry.get('strategy')}")
    print_info(f"  - Contexte: {json.dumps(log_entry.get('context', {}), indent=2)}")
    
    return True


def step8_simulate_additional_logs(property_id: str, num_logs: int = 10) -> int:
    """Étape 8: Simuler des logs supplémentaires."""
    print_step(8, f"Simulation de {num_logs} logs supplémentaires")
    
    client = get_supabase_client()
    
    test_date = date.today() + timedelta(days=1)
    logs_created = 0
    
    for i in range(num_logs):
        try:
            response = client.table("pricing_recommendations").insert({
                "property_id": property_id,
                "stay_date": (test_date + timedelta(days=i)).isoformat(),
                "recommended_price": 100.0 + (i * 10),
                "expected_revenue": None,
                "predicted_demand": None,
                "strategy": "e2e_test",
                "context": {
                    "test": True,
                    "simulation": True,
                    "iteration": i
                }
            }).execute()
            
            if hasattr(response, "data") and response.data:
                logs_created += 1
                
        except Exception as e:
            print_warning(f"Erreur lors de la création du log {i}: {e}")
    
    print_success(f"{logs_created} logs créés avec succès")
    return logs_created


def step9_retrain_model(property_id: str, start_date: str, end_date: str) -> Dict[str, Any]:
    """Étape 9: Réentraîner le modèle."""
    print_step(9, "Réentraînement du modèle")
    
    try:
        result = train_demand_model_for_property(
            property_id=property_id,
            start_date=start_date,
            end_date=end_date,
            trained_by="e2e_test_retrain",
            model_version="v1.0",
        )
        
        print_success("Modèle réentraîné avec succès")
        print_info(f"  - Train RMSE: {result.get('train_rmse', 'N/A')}")
        print_info(f"  - Val RMSE: {result.get('val_rmse', 'N/A')}")
        
        return result
        
    except Exception as e:
        print_error(f"Erreur lors du réentraînement: {e}")
        raise


def step10_verify_updated_metrics(property_id: str) -> bool:
    """Étape 10: Vérifier que les nouvelles métriques sont mises à jour."""
    print_step(10, "Vérification des métriques mises à jour")
    
    client = get_supabase_client()
    
    response = (
        client.table("pricing_model_metrics")
        .select("*")
        .eq("property_id", property_id)
        .order("trained_at", desc=True)
        .limit(2)
        .execute()
    )
    
    if not hasattr(response, "data") or not response.data or len(response.data) < 2:
        print_warning("Moins de 2 métriques trouvées, impossible de comparer")
        return False
    
    old_metrics = response.data[1]
    new_metrics = response.data[0]
    
    print_success("Comparaison des métriques:")
    print_info(f"  Ancien modèle (entraîné le {old_metrics.get('trained_at')}):")
    print_info(f"    - Val RMSE: {old_metrics.get('val_rmse')}")
    print_info(f"  Nouveau modèle (entraîné le {new_metrics.get('trained_at')}):")
    print_info(f"    - Val RMSE: {new_metrics.get('val_rmse')}")
    
    old_rmse = float(old_metrics.get('val_rmse', 0))
    new_rmse = float(new_metrics.get('val_rmse', 0))
    
    if old_rmse > 0:
        improvement = ((old_rmse - new_rmse) / old_rmse) * 100
        print_info(f"  Amélioration: {improvement:.2f}%")
    
    return True


def main():
    parser = argparse.ArgumentParser(
        description="Test end-to-end du moteur de pricing IA"
    )
    parser.add_argument(
        "--property-id",
        type=str,
        required=True,
        help="ID de la propriété à tester"
    )
    parser.add_argument(
        "--api-url",
        type=str,
        default="http://localhost:5000",
        help="URL de l'API (défaut: http://localhost:5000)"
    )
    parser.add_argument(
        "--auth-token",
        type=str,
        default=None,
        help="Token d'authentification pour l'API (optionnel)"
    )
    parser.add_argument(
        "--days",
        type=int,
        default=180,
        help="Nombre de jours d'historique à utiliser (défaut: 180)"
    )
    parser.add_argument(
        "--skip-api",
        action="store_true",
        help="Ignorer les tests d'API (étapes 6-7)"
    )
    
    args = parser.parse_args()
    
    print(f"\n{Colors.BOLD}{Colors.BLUE}{'='*80}{Colors.RESET}")
    print(f"{Colors.BOLD}TEST END-TO-END DU MOTEUR DE PRICING IA{Colors.RESET}")
    print(f"{Colors.BLUE}{'='*80}{Colors.RESET}\n")
    print_info(f"Propriété: {args.property_id}")
    print_info(f"API URL: {args.api_url}")
    print_info(f"Jours d'historique: {args.days}")
    
    start_time = time.time()
    results = {}
    
    try:
        # Étape 1: Vérifier la propriété
        property_data = step1_verify_property(args.property_id)
        results["step1"] = "success"
        
        # Étape 2: Construire le dataset
        df = step2_build_dataset(args.property_id, args.days)
        results["step2"] = "success"
        
        # Étape 3: Entraîner le modèle
        end_date = date.today()
        start_date = end_date - timedelta(days=args.days)
        train_result = step3_train_model(
            args.property_id,
            start_date.isoformat(),
            end_date.isoformat(),
        )
        results["step3"] = "success"
        results["train_metrics"] = train_result
        
        # Étape 4: Vérifier la sauvegarde
        if step4_verify_model_saved(args.property_id):
            results["step4"] = "success"
        else:
            results["step4"] = "failed"
        
        # Étape 5: Vérifier les métriques
        metrics = step5_verify_metrics_in_db(args.property_id)
        if metrics:
            results["step5"] = "success"
            results["metrics"] = metrics
        else:
            results["step5"] = "failed"
        
        # Étape 6-7: Tests API (optionnel)
        if not args.skip_api:
            api_result = step6_call_api_recommend(
                args.property_id,
                args.api_url,
                args.auth_token,
            )
            if api_result:
                results["step6"] = "success"
                results["api_result"] = api_result
                
                test_date = (date.today() + timedelta(days=1)).isoformat()
                if step7_verify_recommendation_logged(args.property_id, test_date):
                    results["step7"] = "success"
                else:
                    results["step7"] = "warning"
            else:
                results["step6"] = "failed"
                results["step7"] = "skipped"
        else:
            results["step6"] = "skipped"
            results["step7"] = "skipped"
        
        # Étape 8: Simuler des logs
        logs_created = step8_simulate_additional_logs(args.property_id, 10)
        results["step8"] = "success"
        results["logs_created"] = logs_created
        
        # Étape 9: Réentraîner
        retrain_result = step9_retrain_model(
            args.property_id,
            start_date.isoformat(),
            end_date.isoformat(),
        )
        results["step9"] = "success"
        results["retrain_metrics"] = retrain_result
        
        # Étape 10: Vérifier les métriques mises à jour
        if step10_verify_updated_metrics(args.property_id):
            results["step10"] = "success"
        else:
            results["step10"] = "warning"
        
        # Résumé final
        duration = time.time() - start_time
        results["duration_seconds"] = duration
        results["timestamp"] = datetime.utcnow().isoformat()
        
        print(f"\n{Colors.BOLD}{Colors.GREEN}{'='*80}{Colors.RESET}")
        print(f"{Colors.BOLD}TEST TERMINÉ{Colors.RESET}")
        print(f"{Colors.GREEN}{'='*80}{Colors.RESET}\n")
        
        success_count = sum(1 for v in results.values() if v == "success")
        total_steps = sum(1 for k in results.keys() if k.startswith("step"))
        
        print_info(f"Étapes réussies: {success_count}/{total_steps}")
        print_info(f"Durée totale: {duration:.2f}s")
        
        # Sauvegarder les résultats
        output_file = Path("test_results_e2e.json")
        output_file.write_text(json.dumps(results, indent=2, default=str), encoding="utf-8")
        print_info(f"Résultats sauvegardés dans: {output_file}")
        
    except Exception as e:
        print_error(f"Erreur fatale: {e}")
        import traceback
        traceback.print_exc()
        results["error"] = str(e)
        results["duration_seconds"] = time.time() - start_time
        sys.exit(1)


if __name__ == "__main__":
    main()

