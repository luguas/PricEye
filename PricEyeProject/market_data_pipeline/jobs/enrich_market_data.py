"""
Job principal d'enrichissement IA des données marché.

Orchestre tous les enrichers (Similarity Engine, NLP Pipeline, Time-Series Analyzer)
pour enrichir les données raw collectées.
"""

import argparse
import asyncio
import json
import logging
import sys
from typing import List, Dict, Optional, Any
from datetime import date, datetime, timedelta

try:
    from supabase import create_client, Client
    SUPABASE_AVAILABLE = True
except ImportError:
    SUPABASE_AVAILABLE = False
    logging.warning("Supabase client not available. Install with: pip install supabase")

from ..enrichers.similarity_engine import SimilarityEngine
from ..enrichers.nlp_pipeline import NLPPipeline
from ..enrichers.time_series_analyzer import TimeSeriesAnalyzer
from ..config.settings import Settings
from ..utils.monitoring import (
    get_pipeline_monitor, log_job_start, log_job_end, JobStatus
)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


async def get_unenriched_data(
    supabase_client: Client,
    table_name: str,
    date_range: Optional[Dict[str, date]] = None,
    limit: int = 100
) -> List[Dict[str, Any]]:
    """
    Récupère les données raw non encore enrichies.
    
    Args:
        supabase_client: Client Supabase
        table_name: Nom de la table raw (ex: 'raw_competitor_data')
        date_range: Plage de dates (None = toutes les données non enrichies)
        limit: Nombre maximum de records à traiter par batch
    
    Returns:
        Liste de données raw à enrichir
    """
    try:
        # Construire la requête
        query = supabase_client.table(table_name).select('*')
        
        # Filtrer par date range si fourni
        if date_range:
            start_date = date_range.get('start_date')
            end_date = date_range.get('end_date')
            
            if start_date:
                # Utiliser collected_at pour filtrer
                query = query.gte('collected_at', start_date.isoformat())
            if end_date:
                query = query.lte('collected_at', end_date.isoformat())
        
        # Limiter le nombre de résultats
        query = query.limit(limit)
        
        # Exécuter la requête
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None,
            lambda: query.execute()
        )
        
        data = response.data if response.data else []
        
        # Filtrer les données déjà enrichies si nécessaire
        # Note: Les enrichers vérifient eux-mêmes si déjà enrichi (via upsert avec on_conflict)
        # Donc on peut laisser passer toutes les données, elles seront idempotentes
        
        return data
        
    except Exception as e:
        logger.error(f"Error fetching unenriched data from {table_name}: {e}")
        return []


async def enrich_all_sources(
    date_range: Optional[Dict[str, date]] = None,
    settings: Optional[Settings] = None,
    force_reprocess: bool = False
) -> Dict[str, Any]:
    """
    Enrichit toutes les données raw collectées.
    
    Applique:
    - Similarity Engine sur competitor_data
    - NLP Pipeline sur events_data et news_data
    - Time-Series Analyzer sur trends_data
    
    Args:
        date_range: Plage de dates (None = toutes les données non enrichies)
        settings: Configuration (si None, charge depuis env)
        force_reprocess: Si True, re-enrichit même les données déjà enrichies
        
    Returns:
        Rapport d'enrichissement avec stats et erreurs
    """
    settings = settings or Settings.from_env()
    start_time = datetime.now()
    
    # Logger le début du job
    job_params = {
        'date_range': date_range,
        'force_reprocess': force_reprocess
    }
    await log_job_start(
        job_name="enrich_market_data",
        job_type="enrich",
        params=job_params,
        triggered_by="api"
    )
    
    report = {
        "start_time": start_time.isoformat(),
        "end_time": None,
        "duration_seconds": 0,
        "sources": {
            "competitors": {
                "status": "pending",
                "records_processed": 0,
                "records_enriched": 0,
                "errors": []
            },
            "events": {
                "status": "pending",
                "records_processed": 0,
                "records_enriched": 0,
                "errors": []
            },
            "news": {
                "status": "pending",
                "records_processed": 0,
                "records_enriched": 0,
                "errors": []
            },
            "trends": {
                "status": "pending",
                "cities_processed": 0,
                "cities_enriched": 0,
                "errors": []
            }
        },
        "total_records_enriched": 0,
        "errors": [],
        "warnings": []
    }
    
    logger.info("=" * 60)
    logger.info("Starting market data enrichment")
    logger.info("=" * 60)
    
    if not SUPABASE_AVAILABLE or not settings.supabase_url:
        logger.error("Supabase not configured")
        report["errors"].append({"error": "Supabase not configured"})
        report["end_time"] = datetime.now().isoformat()
        report["duration_seconds"] = (datetime.now() - start_time).total_seconds()
        report["status"] = "failed"
        
        # Logger la fin du job
        await log_job_end(
            job_name="enrich_market_data",
            status=JobStatus.FAILED,
            stats={"records_processed": 0, "records_success": 0, "records_failed": 1},
            errors=report["errors"],
            error_message="Supabase not configured"
        )
        
        return report
    
    try:
        # Récupérer le client Supabase
        supabase_client = create_client(settings.supabase_url, settings.supabase_key)
        
        # Initialiser les enrichers
        logger.info("Initializing enrichers...")
        similarity_engine = SimilarityEngine(settings=settings)
        nlp_pipeline = NLPPipeline(settings=settings)
        time_series_analyzer = TimeSeriesAnalyzer(settings=settings)
        
        # 1. ENRICHIR COMPETITOR DATA (Similarity Engine)
        logger.info("-" * 60)
        logger.info("ENRICHING COMPETITOR DATA (Similarity Engine)")
        logger.info("-" * 60)
        
        try:
            competitor_start = datetime.now()
            
            # Récupérer les données raw non enrichies
            raw_competitor_data = await get_unenriched_data(
                supabase_client,
                'raw_competitor_data',
                date_range=date_range,
                limit=500
            )
            
            logger.info(f"Found {len(raw_competitor_data)} unenriched competitor records")
            
            if raw_competitor_data:
                enriched_count = 0
                for raw_item in raw_competitor_data:
                    try:
                        report["sources"]["competitors"]["records_processed"] += 1
                        
                        await similarity_engine.enrich_competitor_data(
                            raw_data_id=raw_item['id']
                        )
                        
                        enriched_count += 1
                        report["sources"]["competitors"]["records_enriched"] += 1
                        
                        if enriched_count % 10 == 0:
                            logger.info(f"  Processed {enriched_count}/{len(raw_competitor_data)} competitor records")
                        
                    except Exception as e:
                        error_msg = f"Error enriching competitor data {raw_item['id']}: {e}"
                        logger.error(error_msg, exc_info=True)
                        report["sources"]["competitors"]["errors"].append({
                            "raw_data_id": raw_item['id'],
                            "error": str(e)
                        })
                        report["errors"].append({
                            "source": "competitors",
                            "raw_data_id": raw_item['id'],
                            "error": str(e)
                        })
                
                competitor_duration = (datetime.now() - competitor_start).total_seconds()
                report["sources"]["competitors"]["status"] = "completed"
                report["sources"]["competitors"]["duration_seconds"] = competitor_duration
                
                logger.info(
                    f"✅ Competitor enrichment completed: "
                    f"{enriched_count} records enriched in {competitor_duration:.2f}s"
                )
            else:
                report["sources"]["competitors"]["status"] = "skipped"
                logger.info("No unenriched competitor data found")
            
        except Exception as e:
            error_msg = f"Critical error in competitor enrichment: {e}"
            logger.error(error_msg, exc_info=True)
            report["sources"]["competitors"]["status"] = "failed"
            report["sources"]["competitors"]["errors"].append({"error": str(e)})
            report["errors"].append({"source": "competitors", "error": str(e)})
        
        # 2. ENRICHIR EVENTS DATA (NLP Pipeline)
        logger.info("-" * 60)
        logger.info("ENRICHING EVENTS DATA (NLP Pipeline)")
        logger.info("-" * 60)
        
        try:
            events_start = datetime.now()
            
            raw_events_data = await get_unenriched_data(
                supabase_client,
                'raw_events_data',
                date_range=date_range,
                limit=500
            )
            
            logger.info(f"Found {len(raw_events_data)} unenriched event records")
            
            if raw_events_data:
                enriched_count = 0
                for raw_item in raw_events_data:
                    try:
                        report["sources"]["events"]["records_processed"] += 1
                        
                        await nlp_pipeline.enrich_events_data(
                            raw_data_id=raw_item['id']
                        )
                        
                        enriched_count += 1
                        report["sources"]["events"]["records_enriched"] += 1
                        
                        if enriched_count % 10 == 0:
                            logger.info(f"  Processed {enriched_count}/{len(raw_events_data)} event records")
                        
                    except Exception as e:
                        error_msg = f"Error enriching event data {raw_item['id']}: {e}"
                        logger.error(error_msg, exc_info=True)
                        report["sources"]["events"]["errors"].append({
                            "raw_data_id": raw_item['id'],
                            "error": str(e)
                        })
                        report["errors"].append({
                            "source": "events",
                            "raw_data_id": raw_item['id'],
                            "error": str(e)
                        })
                
                events_duration = (datetime.now() - events_start).total_seconds()
                report["sources"]["events"]["status"] = "completed"
                report["sources"]["events"]["duration_seconds"] = events_duration
                
                logger.info(
                    f"✅ Events enrichment completed: "
                    f"{enriched_count} records enriched in {events_duration:.2f}s"
                )
            else:
                report["sources"]["events"]["status"] = "skipped"
                logger.info("No unenriched events data found")
            
        except Exception as e:
            error_msg = f"Critical error in events enrichment: {e}"
            logger.error(error_msg, exc_info=True)
            report["sources"]["events"]["status"] = "failed"
            report["sources"]["events"]["errors"].append({"error": str(e)})
            report["errors"].append({"source": "events", "error": str(e)})
        
        # 3. ENRICHIR NEWS DATA (NLP Pipeline - Sentiment)
        logger.info("-" * 60)
        logger.info("ENRICHING NEWS DATA (NLP Pipeline - Sentiment)")
        logger.info("-" * 60)
        
        try:
            news_start = datetime.now()
            
            raw_news_data = await get_unenriched_data(
                supabase_client,
                'raw_news_data',
                date_range=date_range,
                limit=500
            )
            
            logger.info(f"Found {len(raw_news_data)} unenriched news records")
            
            if raw_news_data:
                enriched_count = 0
                for raw_item in raw_news_data:
                    try:
                        report["sources"]["news"]["records_processed"] += 1
                        
                        await nlp_pipeline.enrich_news_data(
                            raw_data_id=raw_item['id']
                        )
                        
                        enriched_count += 1
                        report["sources"]["news"]["records_enriched"] += 1
                        
                        if enriched_count % 10 == 0:
                            logger.info(f"  Processed {enriched_count}/{len(raw_news_data)} news records")
                        
                    except Exception as e:
                        error_msg = f"Error enriching news data {raw_item['id']}: {e}"
                        logger.error(error_msg, exc_info=True)
                        report["sources"]["news"]["errors"].append({
                            "raw_data_id": raw_item['id'],
                            "error": str(e)
                        })
                        report["errors"].append({
                            "source": "news",
                            "raw_data_id": raw_item['id'],
                            "error": str(e)
                        })
                
                news_duration = (datetime.now() - news_start).total_seconds()
                report["sources"]["news"]["status"] = "completed"
                report["sources"]["news"]["duration_seconds"] = news_duration
                
                logger.info(
                    f"✅ News enrichment completed: "
                    f"{enriched_count} records enriched in {news_duration:.2f}s"
                )
            else:
                report["sources"]["news"]["status"] = "skipped"
                logger.info("No unenriched news data found")
            
        except Exception as e:
            error_msg = f"Critical error in news enrichment: {e}"
            logger.error(error_msg, exc_info=True)
            report["sources"]["news"]["status"] = "failed"
            report["sources"]["news"]["errors"].append({"error": str(e)})
            report["errors"].append({"source": "news", "error": str(e)})
        
        # 4. ENRICHIR TRENDS DATA (Time-Series Analyzer)
        logger.info("-" * 60)
        logger.info("ENRICHING TRENDS DATA (Time-Series Analyzer)")
        logger.info("-" * 60)
        
        try:
            trends_start = datetime.now()
            
            # Récupérer les villes uniques avec données de trends
            loop = asyncio.get_event_loop()
            cities_query = supabase_client.table('raw_market_trends_data')\
                .select('city, country')\
                .order('collected_at', desc=True)
            
            if date_range:
                start_date = date_range.get('start_date')
                end_date = date_range.get('end_date')
                if start_date:
                    cities_query = cities_query.gte('collected_at', start_date.isoformat())
                if end_date:
                    cities_query = cities_query.lte('collected_at', end_date.isoformat())
            
            cities_response = await loop.run_in_executor(
                None,
                lambda: cities_query.execute()
            )
            
            # Dédupliquer les villes
            cities_set = set()
            for item in (cities_response.data or []):
                city_key = (item.get('city'), item.get('country'))
                if city_key not in cities_set:
                    cities_set.add(city_key)
            
            cities_list = list(cities_set)
            
            logger.info(f"Found {len(cities_list)} unique cities with trend data")
            
            if cities_list:
                enriched_count = 0
                for city, country in cities_list:
                    try:
                        report["sources"]["trends"]["cities_processed"] += 1
                        
                        await time_series_analyzer.enrich_trends_data(
                            city=city,
                            country=country
                        )
                        
                        enriched_count += 1
                        report["sources"]["trends"]["cities_enriched"] += 1
                        
                        logger.info(f"  Enriched trends for {city}, {country}")
                        
                    except Exception as e:
                        error_msg = f"Error enriching trends for {city}, {country}: {e}"
                        logger.error(error_msg, exc_info=True)
                        report["sources"]["trends"]["errors"].append({
                            "city": city,
                            "country": country,
                            "error": str(e)
                        })
                        report["errors"].append({
                            "source": "trends",
                            "city": city,
                            "country": country,
                            "error": str(e)
                        })
                
                trends_duration = (datetime.now() - trends_start).total_seconds()
                report["sources"]["trends"]["status"] = "completed"
                report["sources"]["trends"]["duration_seconds"] = trends_duration
                
                logger.info(
                    f"✅ Trends enrichment completed: "
                    f"{enriched_count} cities enriched in {trends_duration:.2f}s"
                )
            else:
                report["sources"]["trends"]["status"] = "skipped"
                logger.info("No trend data found")
            
        except Exception as e:
            error_msg = f"Critical error in trends enrichment: {e}"
            logger.error(error_msg, exc_info=True)
            report["sources"]["trends"]["status"] = "failed"
            report["sources"]["trends"]["errors"].append({"error": str(e)})
            report["errors"].append({"source": "trends", "error": str(e)})
        
        # Finaliser le rapport
        end_time = datetime.now()
        duration = (end_time - start_time).total_seconds()
        
        report["end_time"] = end_time.isoformat()
        report["duration_seconds"] = duration
        
        # Calculer le total de records enrichis
        report["total_records_enriched"] = (
            report["sources"]["competitors"]["records_enriched"] +
            report["sources"]["events"]["records_enriched"] +
            report["sources"]["news"]["records_enriched"] +
            report["sources"]["trends"]["cities_enriched"]
        )
        
        # Calculer le statut global
        statuses = [
            report["sources"]["competitors"]["status"],
            report["sources"]["events"]["status"],
            report["sources"]["news"]["status"],
            report["sources"]["trends"]["status"]
        ]
        
        if all(s == "failed" for s in statuses):
            report["status"] = "failed"
        elif all(s in ["skipped", "failed"] for s in statuses):
            report["status"] = "skipped"
        elif any(s == "failed" for s in statuses):
            report["status"] = "partial"
        else:
            report["status"] = "success"
        
        # Logger la fin du job
        job_status = JobStatus.SUCCESS if report["status"] == "success" else (
            JobStatus.FAILED if report["status"] == "failed" else JobStatus.PARTIAL
        )
        
        stats = {
            "records_processed": report["total_records_enriched"],
            "records_success": report["total_records_enriched"],
            "records_failed": len(report["errors"]),
            "duration_seconds": duration
        }
        
        await log_job_end(
            job_name="enrich_market_data",
            status=job_status,
            stats=stats,
            errors=report["errors"] if report["errors"] else None,
            error_message=f"Enrichment completed with {len(report['errors'])} errors" if report["errors"] else None
        )
        
        logger.info("=" * 60)
        logger.info("Enrichment completed")
        logger.info(f"  Duration: {duration:.2f}s")
        logger.info(f"  Total records enriched: {report['total_records_enriched']}")
        logger.info(f"  Status: {report['status']}")
        logger.info(f"  Errors: {len(report['errors'])}")
        logger.info("=" * 60)
    
    return report
        
    except Exception as e:
        logger.error(f"Critical error in enrichment pipeline: {e}", exc_info=True)
        report["status"] = "failed"
        report["errors"].append({"error": str(e)})
        report["end_time"] = datetime.now().isoformat()
        report["duration_seconds"] = (datetime.now() - start_time).total_seconds()
        
        # Logger la fin du job (erreur critique)
        await log_job_end(
            job_name="enrich_market_data",
            status=JobStatus.FAILED,
            stats={"records_processed": 0, "records_success": 0, "records_failed": 1},
            errors=report["errors"],
            error_message=str(e)
        )
        
        return report


def main():
    """Point d'entrée CLI."""
    parser = argparse.ArgumentParser(
        description="Enrich market data with AI (Similarity, NLP, Time-Series)"
    )
    
    parser.add_argument(
        "--start-date",
        help="Start date (YYYY-MM-DD, default: all unenriched data)"
    )
    
    parser.add_argument(
        "--end-date",
        help="End date (YYYY-MM-DD, default: today)"
    )
    
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force re-processing of already enriched data (not yet implemented)"
    )
    
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output report as JSON"
    )
    
    args = parser.parse_args()
    
    # Parser la plage de dates
    date_range = None
    if args.start_date or args.end_date:
        start_date = date.fromisoformat(args.start_date) if args.start_date else None
        end_date = date.fromisoformat(args.end_date) if args.end_date else date.today()
        date_range = {"start_date": start_date, "end_date": end_date}
    
    # Exécuter l'enrichissement
    try:
        report = asyncio.run(enrich_all_sources(
            date_range=date_range,
            force_reprocess=args.force
        ))
        
        # Afficher le rapport
        if args.json:
            print(json.dumps(report, indent=2, default=str))
        else:
            print("\n" + "=" * 60)
            print("ENRICHMENT REPORT")
            print("=" * 60)
            print(f"Status: {report['status']}")
            print(f"Duration: {report['duration_seconds']:.2f}s")
            print(f"Total records enriched: {report['total_records_enriched']}")
            print()
            
            # Competitors
            comp = report["sources"]["competitors"]
            if comp["status"] != "skipped":
                print(f"Competitors:")
                print(f"  Status: {comp['status']}")
                print(f"  Processed: {comp['records_processed']}")
                print(f"  Enriched: {comp['records_enriched']}")
                print(f"  Errors: {len(comp['errors'])}")
            
            # Events
            events = report["sources"]["events"]
            if events["status"] != "skipped":
                print(f"Events:")
                print(f"  Status: {events['status']}")
                print(f"  Processed: {events['records_processed']}")
                print(f"  Enriched: {events['records_enriched']}")
                print(f"  Errors: {len(events['errors'])}")
            
            # News
            news = report["sources"]["news"]
            if news["status"] != "skipped":
                print(f"News:")
                print(f"  Status: {news['status']}")
                print(f"  Processed: {news['records_processed']}")
                print(f"  Enriched: {news['records_enriched']}")
                print(f"  Errors: {len(news['errors'])}")
            
            # Trends
            trends = report["sources"]["trends"]
            if trends["status"] != "skipped":
                print(f"Trends:")
                print(f"  Status: {trends['status']}")
                print(f"  Processed: {trends['cities_processed']}")
                print(f"  Enriched: {trends['cities_enriched']}")
                print(f"  Errors: {len(trends['errors'])}")
    
    if report["errors"]:
                print(f"\nErrors ({len(report['errors'])}):")
                for error in report["errors"][:5]:  # Afficher les 5 premières
                    print(f"  - {error.get('source', 'unknown')}: {error.get('error', 'unknown error')}")
                if len(report["errors"]) > 5:
                    print(f"  ... and {len(report['errors']) - 5} more errors")
        
        # Exit code basé sur le statut
        if report["status"] == "failed":
            return 1
        elif report["status"] == "partial":
            return 2  # Warning
        else:
            return 0
            
    except KeyboardInterrupt:
        logger.warning("Enrichment interrupted by user")
        print("\n⚠️  Enrichment interrupted")
        return 130
    except Exception as e:
        logger.error(f"Enrichment failed: {e}", exc_info=True)
        print(f"\n❌ Enrichment failed: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
