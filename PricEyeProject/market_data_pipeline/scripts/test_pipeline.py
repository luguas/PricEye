"""
Script de test end-to-end du pipeline de données marché.

Ce script exécute toutes les étapes du pipeline (collecte, enrichissement, features)
pour une ville de test et génère un rapport détaillé.

Usage:
    python -m market_data_pipeline.scripts.test_pipeline [--city CITY] [--country COUNTRY] [--skip-collect] [--skip-enrich] [--skip-features]
"""

import argparse
import asyncio
import json
import logging
import sys
from typing import Dict, Optional, Any, List
from datetime import date, datetime, timedelta
from pathlib import Path

try:
    from supabase import create_client, Client
    SUPABASE_AVAILABLE = True
except ImportError:
    SUPABASE_AVAILABLE = False
    logging.warning("Supabase client not available. Install with: pip install supabase")

from ..jobs.collect_market_data import collect_all_sources, get_active_properties
from ..jobs.enrich_market_data import enrich_all_sources, get_unenriched_data
from ..jobs.build_market_features import (
    build_features_for_date_range,
    get_cities_to_process
)
from ..config.settings import Settings
from ..utils.monitoring import (
    get_pipeline_monitor, log_job_start, log_job_end, JobStatus
)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class PipelineTestReport:
    """Classe pour générer le rapport de test du pipeline."""
    
    def __init__(self):
        self.start_time = datetime.now()
        self.steps = {
            "collect": {"status": "pending", "duration": 0, "data_count": 0, "errors": []},
            "enrich": {"status": "pending", "duration": 0, "data_count": 0, "errors": []},
            "build_features": {"status": "pending", "duration": 0, "features_count": 0, "errors": []}
        }
        self.verification_results = {}
        self.test_city = None
        self.test_country = None
    
    def mark_step_start(self, step_name: str):
        """Marque le début d'une étape."""
        if step_name in self.steps:
            self.steps[step_name]["start_time"] = datetime.now()
            self.steps[step_name]["status"] = "running"
    
    def mark_step_end(self, step_name: str, success: bool, data_count: int = 0, errors: Optional[List[str]] = None):
        """Marque la fin d'une étape."""
        if step_name in self.steps:
            end_time = datetime.now()
            start_time = self.steps[step_name].get("start_time", self.start_time)
            duration = (end_time - start_time).total_seconds()
            
            self.steps[step_name]["status"] = "success" if success else "failed"
            self.steps[step_name]["duration"] = duration
            self.steps[step_name]["data_count"] = data_count
            if errors:
                self.steps[step_name]["errors"] = errors
    
    def add_verification(self, name: str, passed: bool, message: str):
        """Ajoute un résultat de vérification."""
        self.verification_results[name] = {
            "passed": passed,
            "message": message
        }
    
    def generate_report(self) -> str:
        """Génère le rapport au format texte."""
        end_time = datetime.now()
        total_duration = (end_time - self.start_time).total_seconds()
        
        report_lines = []
        report_lines.append("=" * 80)
        report_lines.append("RAPPORT DE TEST END-TO-END - PIPELINE DONNÉES MARCHÉ")
        report_lines.append("=" * 80)
        report_lines.append("")
        
        # Informations générales
        report_lines.append(f"Date du test: {self.start_time.strftime('%Y-%m-%d %H:%M:%S')}")
        report_lines.append(f"Durée totale: {total_duration:.2f} secondes")
        if self.test_city:
            report_lines.append(f"Ville testée: {self.test_city}, {self.test_country}")
        report_lines.append("")
        
        # Résumé des étapes
        report_lines.append("-" * 80)
        report_lines.append("RÉSUMÉ DES ÉTAPES")
        report_lines.append("-" * 80)
        
        for step_name, step_info in self.steps.items():
            status_emoji = {
                "pending": "⏳",
                "running": "🔄",
                "success": "✅",
                "failed": "❌",
                "skipped": "⏭️"
            }.get(step_info["status"], "❓")
            
            status_text = step_info["status"].upper()
            duration = step_info.get("duration", 0)
            data_count = step_info.get("data_count", 0)
            
            report_lines.append(f"{status_emoji} {step_name.upper()}: {status_text}")
            report_lines.append(f"   Durée: {duration:.2f}s")
            
            if step_name == "collect":
                report_lines.append(f"   Données collectées: {data_count}")
            elif step_name == "enrich":
                report_lines.append(f"   Données enrichies: {data_count}")
            elif step_name == "build_features":
                report_lines.append(f"   Features créées: {data_count}")
            
            if step_info.get("errors"):
                report_lines.append(f"   Erreurs: {len(step_info['errors'])}")
                for error in step_info["errors"][:3]:  # Limiter à 3 erreurs
                    report_lines.append(f"      - {error}")
            
            report_lines.append("")
        
        # Vérifications
        if self.verification_results:
            report_lines.append("-" * 80)
            report_lines.append("VÉRIFICATIONS")
            report_lines.append("-" * 80)
            
            for name, result in self.verification_results.items():
                emoji = "✅" if result["passed"] else "❌"
                report_lines.append(f"{emoji} {name}: {result['message']}")
            
            report_lines.append("")
        
        # Résultat final
        report_lines.append("-" * 80)
        report_lines.append("RÉSULTAT FINAL")
        report_lines.append("-" * 80)
        
        all_passed = all(
            step["status"] == "success" or step["status"] == "skipped"
            for step in self.steps.values()
        )
        all_verifications_passed = all(
            result["passed"] for result in self.verification_results.values()
        ) if self.verification_results else True
        
        if all_passed and all_verifications_passed:
            report_lines.append("✅ SUCCÈS: Toutes les étapes ont réussi")
        else:
            report_lines.append("❌ ÉCHEC: Certaines étapes ont échoué")
            failed_steps = [
                name for name, info in self.steps.items()
                if info["status"] == "failed"
            ]
            if failed_steps:
                report_lines.append(f"   Étapes échouées: {', '.join(failed_steps)}")
        
        report_lines.append("")
        report_lines.append("=" * 80)
        
        return "\n".join(report_lines)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convertit le rapport en dictionnaire."""
        end_time = datetime.now()
        total_duration = (end_time - self.start_time).total_seconds()
        
        return {
            "start_time": self.start_time.isoformat(),
            "end_time": end_time.isoformat(),
            "total_duration_seconds": total_duration,
            "test_city": self.test_city,
            "test_country": self.test_country,
            "steps": self.steps,
            "verification_results": self.verification_results,
            "success": all(
                step["status"] == "success" or step["status"] == "skipped"
                for step in self.steps.values()
            ) and all(
                result["passed"] for result in self.verification_results.values()
            ) if self.verification_results else True
        }


async def verify_collected_data(
    supabase_client: Client,
    city: str,
    country: str,
    report: PipelineTestReport
) -> bool:
    """Vérifie que des données ont été collectées."""
    try:
        # Vérifier raw_competitor_data
        query_competitor = supabase_client.table('raw_competitor_data')\
            .select('id', count='exact')\
            .eq('city', city)\
            .eq('country', country)
        
        loop = asyncio.get_event_loop()
        response_competitor = await loop.run_in_executor(
            None,
            lambda: query_competitor.execute()
        )
        
        competitor_count = response_competitor.count if hasattr(response_competitor, 'count') else len(response_competitor.data or [])
        
        # Vérifier raw_weather_data
        query_weather = supabase_client.table('raw_weather_data')\
            .select('id', count='exact')\
            .eq('city', city)\
            .eq('country', country)
        
        response_weather = await loop.run_in_executor(
            None,
            lambda: query_weather.execute()
        )
        
        weather_count = response_weather.count if hasattr(response_weather, 'count') else len(response_weather.data or [])
        
        total_count = competitor_count + weather_count
        
        report.add_verification(
            "Données collectées",
            total_count > 0,
            f"{competitor_count} données concurrents, {weather_count} données météo"
        )
        
        return total_count > 0
        
    except Exception as e:
        logger.error(f"Erreur lors de la vérification des données collectées: {e}")
        report.add_verification("Données collectées", False, f"Erreur: {str(e)}")
        return False


async def verify_enriched_data(
    supabase_client: Client,
    city: str,
    country: str,
    report: PipelineTestReport
) -> bool:
    """Vérifie que des données ont été enrichies."""
    try:
        # Vérifier enriched_competitor_data
        query_enriched = supabase_client.table('enriched_competitor_data')\
            .select('id', count='exact')\
            .eq('city', city)\
            .eq('country', country)
        
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None,
            lambda: query_enriched.execute()
        )
        
        enriched_count = response.count if hasattr(response, 'count') else len(response.data or [])
        
        report.add_verification(
            "Données enrichies",
            enriched_count > 0,
            f"{enriched_count} données enrichies"
        )
        
        return enriched_count > 0
        
    except Exception as e:
        logger.error(f"Erreur lors de la vérification des données enrichies: {e}")
        report.add_verification("Données enrichies", False, f"Erreur: {str(e)}")
        return False


async def verify_features(
    supabase_client: Client,
    city: str,
    country: str,
    report: PipelineTestReport
) -> bool:
    """Vérifie que des features ont été créées."""
    try:
        # Vérifier market_features
        query_features = supabase_client.table('market_features')\
            .select('id', count='exact')\
            .eq('city', city)\
            .eq('country', country)
        
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None,
            lambda: query_features.execute()
        )
        
        features_count = response.count if hasattr(response, 'count') else len(response.data or [])
        
        report.add_verification(
            "Features créées",
            features_count > 0,
            f"{features_count} features créées"
        )
        
        # Vérifier qu'au moins une feature a des données complètes
        if features_count > 0:
            query_sample = supabase_client.table('market_features')\
                .select('*')\
                .eq('city', city)\
                .eq('country', country)\
                .limit(1)
            
            response_sample = await loop.run_in_executor(
                None,
                lambda: query_sample.execute()
            )
            
            if response_sample.data:
                sample = response_sample.data[0]
                has_competitor_features = sample.get('competitor_avg_price') is not None
                has_weather_features = sample.get('avg_temperature') is not None
                
                report.add_verification(
                    "Features complètes",
                    has_competitor_features or has_weather_features,
                    f"Features concurrents: {has_competitor_features}, Features météo: {has_weather_features}"
                )
        
        return features_count > 0
        
    except Exception as e:
        logger.error(f"Erreur lors de la vérification des features: {e}")
        report.add_verification("Features créées", False, f"Erreur: {str(e)}")
        return False


async def run_pipeline_test(
    city: str = "Paris",
    country: str = "FR",
    skip_collect: bool = False,
    skip_enrich: bool = False,
    skip_features: bool = False,
    settings: Optional[Settings] = None
) -> PipelineTestReport:
    """
    Exécute un test end-to-end du pipeline.
    
    Args:
        city: Ville à tester
        country: Pays à tester
        skip_collect: Passer l'étape de collecte
        skip_enrich: Passer l'étape d'enrichissement
        skip_features: Passer l'étape de construction des features
        settings: Configuration (si None, charge depuis env)
    
    Returns:
        Rapport de test
    """
    settings = settings or Settings.from_env()
    report = PipelineTestReport()
    report.test_city = city
    report.test_country = country
    
    logger.info(f"Démarrage du test end-to-end pour {city}, {country}")
    
    if not SUPABASE_AVAILABLE or not settings.supabase_url:
        logger.error("Supabase n'est pas configuré. Le test ne peut pas s'exécuter.")
        report.add_verification("Configuration Supabase", False, "Supabase non configuré")
        return report
    
    supabase_client = create_client(settings.supabase_url, settings.supabase_key)
    
    # Étape 1: Collecte
    if not skip_collect:
        logger.info("=" * 80)
        logger.info("ÉTAPE 1: COLLECTE DES DONNÉES")
        logger.info("=" * 80)
        
        report.mark_step_start("collect")
        
        try:
            date_range = {
                "start_date": date.today(),
                "end_date": date.today() + timedelta(days=14)
            }
            
            collect_result = await collect_all_sources(
                countries=[country],
                cities=[city],
                date_range=date_range,
                settings=settings,
                collect_competitors=True,
                collect_weather=True
            )
            
            total_collected = (
                collect_result.get("summary", {}).get("competitors", {}).get("total_collected", 0) +
                collect_result.get("summary", {}).get("weather", {}).get("total_collected", 0)
            )
            
            success = collect_result.get("success", False)
            errors = collect_result.get("errors", [])
            
            report.mark_step_end("collect", success, total_collected, errors)
            
            if success:
                logger.info(f"✅ Collecte réussie: {total_collected} données collectées")
            else:
                logger.warning(f"⚠️ Collecte partiellement réussie: {total_collected} données collectées")
            
            # Vérification
            await verify_collected_data(supabase_client, city, country, report)
            
        except Exception as e:
            logger.error(f"❌ Erreur lors de la collecte: {e}", exc_info=True)
            report.mark_step_end("collect", False, 0, [str(e)])
    else:
        logger.info("⏭️ Étape de collecte ignorée")
        report.steps["collect"]["status"] = "skipped"
    
    # Étape 2: Enrichissement
    if not skip_enrich:
        logger.info("")
        logger.info("=" * 80)
        logger.info("ÉTAPE 2: ENRICHISSEMENT IA")
        logger.info("=" * 80)
        
        report.mark_step_start("enrich")
        
        try:
            date_range = {
                "start_date": date.today() - timedelta(days=1),
                "end_date": date.today()
            }
            
            enrich_result = await enrich_all_sources(
                countries=[country],
                cities=[city],
                date_range=date_range,
                settings=settings
            )
            
            total_enriched = (
                enrich_result.get("summary", {}).get("competitors", {}).get("total_enriched", 0) +
                enrich_result.get("summary", {}).get("weather", {}).get("total_enriched", 0) +
                enrich_result.get("summary", {}).get("events", {}).get("total_enriched", 0) +
                enrich_result.get("summary", {}).get("news", {}).get("total_enriched", 0) +
                enrich_result.get("summary", {}).get("trends", {}).get("total_enriched", 0)
            )
            
            success = enrich_result.get("success", False)
            errors = enrich_result.get("errors", [])
            
            report.mark_step_end("enrich", success, total_enriched, errors)
            
            if success:
                logger.info(f"✅ Enrichissement réussi: {total_enriched} données enrichies")
            else:
                logger.warning(f"⚠️ Enrichissement partiellement réussi: {total_enriched} données enrichies")
            
            # Vérification
            await verify_enriched_data(supabase_client, city, country, report)
            
        except Exception as e:
            logger.error(f"❌ Erreur lors de l'enrichissement: {e}", exc_info=True)
            report.mark_step_end("enrich", False, 0, [str(e)])
    else:
        logger.info("⏭️ Étape d'enrichissement ignorée")
        report.steps["enrich"]["status"] = "skipped"
    
    # Étape 3: Construction des features
    if not skip_features:
        logger.info("")
        logger.info("=" * 80)
        logger.info("ÉTAPE 3: CONSTRUCTION DES FEATURES")
        logger.info("=" * 80)
        
        report.mark_step_start("build_features")
        
        try:
            date_range = {
                "start_date": date.today(),
                "end_date": date.today()
            }
            
            features_result = await build_features_for_date_range(
                date_range=date_range,
                cities=[{"country": country, "city": city}],
                settings=settings,
                update_pricing_features=True
            )
            
            total_features = features_result.get("summary", {}).get("total_features_created", 0)
            success = features_result.get("success", False)
            errors = features_result.get("errors", [])
            
            report.mark_step_end("build_features", success, total_features, errors)
            
            if success:
                logger.info(f"✅ Construction des features réussie: {total_features} features créées")
            else:
                logger.warning(f"⚠️ Construction des features partiellement réussie: {total_features} features créées")
            
            # Vérification
            await verify_features(supabase_client, city, country, report)
            
        except Exception as e:
            logger.error(f"❌ Erreur lors de la construction des features: {e}", exc_info=True)
            report.mark_step_end("build_features", False, 0, [str(e)])
    else:
        logger.info("⏭️ Étape de construction des features ignorée")
        report.steps["build_features"]["status"] = "skipped"
    
    return report


async def main():
    """Point d'entrée principal."""
    parser = argparse.ArgumentParser(
        description="Test end-to-end du pipeline de données marché",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Exemples:
  python -m market_data_pipeline.scripts.test_pipeline
  python -m market_data_pipeline.scripts.test_pipeline --city Paris --country FR
  python -m market_data_pipeline.scripts.test_pipeline --city NewYork --country US --skip-collect
        """
    )
    
    parser.add_argument(
        "--city",
        type=str,
        default="Paris",
        help="Ville à tester (défaut: Paris)"
    )
    
    parser.add_argument(
        "--country",
        type=str,
        default="FR",
        help="Pays à tester (défaut: FR)"
    )
    
    parser.add_argument(
        "--skip-collect",
        action="store_true",
        help="Ignorer l'étape de collecte"
    )
    
    parser.add_argument(
        "--skip-enrich",
        action="store_true",
        help="Ignorer l'étape d'enrichissement"
    )
    
    parser.add_argument(
        "--skip-features",
        action="store_true",
        help="Ignorer l'étape de construction des features"
    )
    
    parser.add_argument(
        "--output-json",
        type=str,
        help="Chemin pour sauvegarder le rapport en JSON"
    )
    
    args = parser.parse_args()
    
    # Exécuter le test
    report = await run_pipeline_test(
        city=args.city,
        country=args.country,
        skip_collect=args.skip_collect,
        skip_enrich=args.skip_enrich,
        skip_features=args.skip_features
    )
    
    # Afficher le rapport
    print("\n")
    print(report.generate_report())
    print("\n")
    
    # Sauvegarder en JSON si demandé
    if args.output_json:
        with open(args.output_json, 'w', encoding='utf-8') as f:
            json.dump(report.to_dict(), f, indent=2, ensure_ascii=False)
        logger.info(f"Rapport JSON sauvegardé dans {args.output_json}")
    
    # Code de sortie
    if report.to_dict()["success"]:
        sys.exit(0)
    else:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())

