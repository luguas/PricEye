"""
Job principal de collecte de données marché.

Collecte les données depuis toutes les sources (concurrents, météo) pour toutes les propriétés actives.
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

from ..collectors.competitor_collector import CompetitorCollector
from ..collectors.weather_collector import WeatherCollector
from ..config.settings import Settings
from ..config import create_rate_limiter
from ..utils.monitoring import (
    get_pipeline_monitor, log_job_start, log_job_end, JobStatus
)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


async def get_active_properties(
    settings: Settings,
    countries: Optional[List[str]] = None,
    cities: Optional[List[str]] = None
) -> List[Dict[str, Any]]:
    """
    Récupère les propriétés actives depuis Supabase.
    
    Args:
        settings: Configuration
        countries: Filtrer par pays (optionnel)
        cities: Filtrer par villes (optionnel)
    
    Returns:
        Liste de propriétés avec {id, city, country, bedrooms, property_type, etc.}
    """
    if not SUPABASE_AVAILABLE or not settings.supabase_url:
        logger.warning("Supabase not configured, returning empty properties list")
        return []
    
    try:
        supabase = create_client(settings.supabase_url, settings.supabase_key)
        
        # Construire la requête
        query = supabase.table('properties').select('id, city, country, bedrooms, bathrooms, property_type, status, latitude, longitude')
        
        # Filtrer par status actif
        query = query.eq('status', 'active')
        
        # Filtrer par pays si spécifié
        if countries:
            query = query.in_('country', countries)
        
        # Filtrer par villes si spécifié
        if cities:
            query = query.in_('city', cities)
        
        # Exécuter la requête
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None,
            lambda: query.execute()
        )
        
        properties = response.data if response.data else []
        
        logger.info(f"Retrieved {len(properties)} active properties from Supabase")
        return properties
        
    except Exception as e:
        logger.error(f"Error fetching properties from Supabase: {e}")
        return []


async def collect_all_sources(
    countries: Optional[List[str]] = None,
    cities: Optional[List[str]] = None,
    date_range: Optional[Dict[str, date]] = None,
    settings: Optional[Settings] = None,
    collect_competitors: bool = True,
    collect_weather: bool = True
) -> Dict[str, Any]:
    """
    Collecte les données de toutes les sources.
    
    Args:
        countries: Liste de codes pays à traiter (None = tous)
        cities: Liste de villes à traiter (None = toutes)
        date_range: Dict avec 'start_date' et 'end_date' (None = +90 jours)
        settings: Configuration (si None, charge depuis env)
        collect_competitors: Si True, collecte les données concurrents
        collect_weather: Si True, collecte les données météo
    
    Returns:
        Rapport de collecte avec stats et erreurs
    """
    settings = settings or Settings.from_env()
    start_time = datetime.now()
    
    # Logger le début du job
    job_params = {
        'countries': countries,
        'cities': cities,
        'date_range': date_range,
        'collect_competitors': collect_competitors,
        'collect_weather': collect_weather
    }
    await log_job_start(
        job_name="collect_market_data",
        job_type="collect",
        params=job_params,
        triggered_by="api"
    )
    
    report = {
        "start_time": start_time.isoformat(),
        "end_time": None,
        "duration_seconds": 0,
        "sources": {
            "competitors": {
                "status": "skipped",
                "records_collected": 0,
                "properties_processed": 0,
                "errors": []
            },
            "weather": {
                "status": "skipped",
                "records_collected": 0,
                "cities_processed": 0,
                "errors": []
            }
        },
        "total_records": 0,
        "errors": [],
        "warnings": []
    }
    
    logger.info("=" * 60)
    logger.info("Starting market data collection")
    logger.info("=" * 60)
    
    # Définir la plage de dates par défaut (+90 jours)
    if not date_range:
        today = date.today()
        date_range = {
            "start_date": today,
            "end_date": today + timedelta(days=90)
        }
    
    logger.info(
        f"Date range: {date_range['start_date']} to {date_range['end_date']}"
    )
    
    # Récupérer les propriétés actives
    logger.info("Fetching active properties from Supabase...")
    properties = await get_active_properties(settings, countries, cities)
    
    if not properties:
        logger.warning("No active properties found")
        report["warnings"].append("No active properties found")
        report["end_time"] = datetime.now().isoformat()
        report["duration_seconds"] = (datetime.now() - start_time).total_seconds()
        return report
    
    logger.info(f"Found {len(properties)} active properties")
    
    # Grouper les propriétés par ville (pour éviter les doublons météo)
    cities_to_process = {}
    for prop in properties:
        city_key = f"{prop.get('city', '')}:{prop.get('country', '')}"
        if city_key not in cities_to_process:
            cities_to_process[city_key] = {
                "city": prop.get('city'),
                "country": prop.get('country')
            }
    
    logger.info(f"Processing {len(cities_to_process)} unique cities")
    
    # 1. Collecte des données concurrents (Apify)
    if collect_competitors and settings.collect_competitors:
        logger.info("-" * 60)
        logger.info("COLLECTING COMPETITOR DATA (Apify)")
        logger.info("-" * 60)
        
        try:
            # Créer le collecteur avec rate limiting
            rate_limiter = create_rate_limiter("apify_actor", persist_state=False)
            competitor_collector = CompetitorCollector(rate_limiter=rate_limiter)
            
            competitor_start = datetime.now()
            records_collected = 0
            properties_processed = 0
            
            for prop in properties:
                try:
                    city = prop.get('city')
                    country = prop.get('country')
                    
                    if not city or not country:
                        logger.warning(
                            f"Property {prop.get('id')} missing city or country, skipping"
                        )
                        continue
                    
                    logger.info(
                        f"Collecting competitor data for property {prop.get('id')} "
                        f"({city}, {country})"
                    )
                    
                    property_info = {
                        "city": city,
                        "country": country,
                        "property_type": prop.get('property_type'),
                        "bedrooms": prop.get('bedrooms'),
                        "bathrooms": prop.get('bathrooms'),
                        "location": {
                            "latitude": prop.get('latitude'),
                            "longitude": prop.get('longitude')
                        } if prop.get('latitude') and prop.get('longitude') else None
                    }
                    
                    # Collecter les données
                    data = await competitor_collector.collect(
                        property_info=property_info,
                        date_range=date_range,
                        store_in_db=True
                    )
                    
                    records_collected += len(data)
                    properties_processed += 1
                    
                    logger.info(
                        f"✅ Collected {len(data)} competitor records for "
                        f"{city}, {country}"
                    )
                    
                except Exception as e:
                    error_msg = f"Error collecting competitors for property {prop.get('id')}: {e}"
                    logger.error(error_msg, exc_info=True)
                    report["sources"]["competitors"]["errors"].append({
                        "property_id": prop.get('id'),
                        "city": prop.get('city'),
                        "country": prop.get('country'),
                        "error": str(e)
                    })
                    report["errors"].append({
                        "source": "competitors",
                        "property_id": prop.get('id'),
                        "error": str(e)
                    })
                    continue
            
            competitor_duration = (datetime.now() - competitor_start).total_seconds()
            
            report["sources"]["competitors"] = {
                "status": "completed",
                "records_collected": records_collected,
                "properties_processed": properties_processed,
                "duration_seconds": competitor_duration,
                "errors": report["sources"]["competitors"]["errors"]
            }
            
            report["total_records"] += records_collected
            
            logger.info(
                f"✅ Competitor collection completed: {records_collected} records "
                f"from {properties_processed} properties in {competitor_duration:.2f}s"
            )
            
            await competitor_collector.close()
            
        except Exception as e:
            error_msg = f"Critical error in competitor collection: {e}"
            logger.error(error_msg, exc_info=True)
            report["sources"]["competitors"]["status"] = "failed"
            report["sources"]["competitors"]["errors"].append({"error": str(e)})
            report["errors"].append({"source": "competitors", "error": str(e)})
    
    # 2. Collecte des données météo
    if collect_weather and settings.collect_weather:
        logger.info("-" * 60)
        logger.info("COLLECTING WEATHER DATA")
        logger.info("-" * 60)
        
        try:
            # Créer le collecteur météo avec fallback
            rate_limiter = create_rate_limiter("openweather", persist_state=False)
            weather_collector = WeatherCollector(
                primary_source="openweather",
                fallback_source="weatherapi",
                rate_limiter=rate_limiter
            )
            
            weather_start = datetime.now()
            records_collected = 0
            cities_processed = 0
            
            for city_key, location in cities_to_process.items():
                try:
                    city = location["city"]
                    country = location["country"]
                    
                    if not city or not country:
                        continue
                    
                    logger.info(f"Collecting weather data for {city}, {country}")
                    
                    # Collecter les données météo
                    data = await weather_collector.collect(
                        city=city,
                        country=country,
                        date_range=date_range,
                        store_in_db=True
                    )
                    
                    records_collected += len(data)
                    cities_processed += 1
                    
                    logger.info(
                        f"✅ Collected {len(data)} weather records for {city}, {country}"
                    )
                    
                except Exception as e:
                    error_msg = f"Error collecting weather for {city}, {country}: {e}"
                    logger.error(error_msg, exc_info=True)
                    report["sources"]["weather"]["errors"].append({
                        "city": city,
                        "country": country,
                        "error": str(e)
                    })
                    report["errors"].append({
                        "source": "weather",
                        "city": city,
                        "country": country,
                        "error": str(e)
                    })
                    continue
            
            weather_duration = (datetime.now() - weather_start).total_seconds()
            
            report["sources"]["weather"] = {
                "status": "completed",
                "records_collected": records_collected,
                "cities_processed": cities_processed,
                "duration_seconds": weather_duration,
                "errors": report["sources"]["weather"]["errors"]
            }
            
            report["total_records"] += records_collected
            
            logger.info(
                f"✅ Weather collection completed: {records_collected} records "
                f"from {cities_processed} cities in {weather_duration:.2f}s"
            )
            
            await weather_collector.close()
            
        except Exception as e:
            error_msg = f"Critical error in weather collection: {e}"
            logger.error(error_msg, exc_info=True)
            report["sources"]["weather"]["status"] = "failed"
            report["sources"]["weather"]["errors"].append({"error": str(e)})
            report["errors"].append({"source": "weather", "error": str(e)})
    
    # Finaliser le rapport
    end_time = datetime.now()
    duration = (end_time - start_time).total_seconds()
    
    report["end_time"] = end_time.isoformat()
    report["duration_seconds"] = duration
    
    # Calculer le statut global
    competitor_status = report["sources"]["competitors"]["status"]
    weather_status = report["sources"]["weather"]["status"]
    
    if competitor_status == "failed" and weather_status == "failed":
        report["status"] = "failed"
    elif competitor_status == "skipped" and weather_status == "skipped":
        report["status"] = "skipped"
    elif competitor_status == "failed" or weather_status == "failed":
        report["status"] = "partial"
    else:
        report["status"] = "success"
    
    # Logger la fin du job
    job_status = JobStatus.SUCCESS if report["status"] == "success" else (
        JobStatus.FAILED if report["status"] == "failed" else JobStatus.PARTIAL
    )
    
    stats = {
        "records_processed": report["total_records"],
        "records_success": report["total_records"],
        "records_failed": len(report["errors"]),
        "duration_seconds": duration,
        "competitor_status": competitor_status,
        "weather_status": weather_status
    }
    
    await log_job_end(
        job_name="collect_market_data",
        status=job_status,
        stats=stats,
        errors=report["errors"] if report["errors"] else None,
        error_message=f"Collection completed with {len(report['errors'])} errors" if report["errors"] else None
    )
    
    logger.info("=" * 60)
    logger.info("Collection completed")
    logger.info(f"  Duration: {duration:.2f}s")
    logger.info(f"  Total records: {report['total_records']}")
    logger.info(f"  Status: {report['status']}")
    logger.info(f"  Errors: {len(report['errors'])}")
    logger.info("=" * 60)
    
    return report


def main():
    """Point d'entrée CLI."""
    parser = argparse.ArgumentParser(
        description="Collect market data from all sources (competitors, weather)"
    )
    
    parser.add_argument(
        "--countries",
        nargs="+",
        help="Countries to collect (ISO codes, ex: FR US)"
    )
    
    parser.add_argument(
        "--cities",
        nargs="+",
        help="Cities to collect (ex: Paris Nice)"
    )
    
    parser.add_argument(
        "--start-date",
        help="Start date (YYYY-MM-DD, default: today)"
    )
    
    parser.add_argument(
        "--end-date",
        help="End date (YYYY-MM-DD, default: today + 90 days)"
    )
    
    parser.add_argument(
        "--skip-competitors",
        action="store_true",
        help="Skip competitor data collection"
    )
    
    parser.add_argument(
        "--skip-weather",
        action="store_true",
        help="Skip weather data collection"
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
        today = date.today()
        start_date = date.fromisoformat(args.start_date) if args.start_date else today
        end_date = date.fromisoformat(args.end_date) if args.end_date else today + timedelta(days=90)
        date_range = {"start_date": start_date, "end_date": end_date}
    
    # Exécuter la collecte
    try:
        report = asyncio.run(collect_all_sources(
            countries=args.countries,
            cities=args.cities,
            date_range=date_range,
            collect_competitors=not args.skip_competitors,
            collect_weather=not args.skip_weather
        ))
        
        # Afficher le rapport
        if args.json:
            print(json.dumps(report, indent=2, default=str))
        else:
            print("\n" + "=" * 60)
            print("COLLECTION REPORT")
            print("=" * 60)
            print(f"Status: {report['status']}")
            print(f"Duration: {report['duration_seconds']:.2f}s")
            print(f"Total records: {report['total_records']}")
            print()
            
            if report["sources"]["competitors"]["status"] != "skipped":
                comp = report["sources"]["competitors"]
                print(f"Competitors:")
                print(f"  Status: {comp['status']}")
                print(f"  Records: {comp['records_collected']}")
                print(f"  Properties: {comp['properties_processed']}")
                print(f"  Errors: {len(comp['errors'])}")
            
            if report["sources"]["weather"]["status"] != "skipped":
                weather = report["sources"]["weather"]
                print(f"Weather:")
                print(f"  Status: {weather['status']}")
                print(f"  Records: {weather['records_collected']}")
                print(f"  Cities: {weather['cities_processed']}")
                print(f"  Errors: {len(weather['errors'])}")
            
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
        logger.warning("Collection interrupted by user")
        print("\n⚠️  Collection interrupted")
        return 130
    except Exception as e:
        logger.error(f"Collection failed: {e}", exc_info=True)
        print(f"\n❌ Collection failed: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
