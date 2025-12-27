"""
Job de construction des features marché finales.

Lit les données enrichies, calcule toutes les features via FeatureCalculator,
les agrège et les stocke dans market_features.
Met également à jour features_pricing_daily avec competitor_avg_price et market_demand_level.
"""

import asyncio
import argparse
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

from ..enrichers.feature_calculator import FeatureCalculator
from ..config.settings import Settings
from ..utils.monitoring import (
    get_pipeline_monitor, log_job_start, log_job_end, JobStatus
)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


async def get_cities_to_process(
    supabase_client: Client,
    target_cities: Optional[List[str]] = None
) -> List[Dict[str, str]]:
    """
    Récupère la liste des villes à traiter depuis les données enrichies.
    
    Args:
        supabase_client: Client Supabase
        target_cities: Liste de villes spécifiques (None = toutes)
        
    Returns:
        Liste de dicts avec 'country' et 'city'
    """
    try:
        loop = asyncio.get_event_loop()
        
        # Récupérer les villes depuis raw_competitor_data ou raw_weather_data
        # (peu importe, on veut juste la liste des villes disponibles)
        query = supabase_client.table('raw_competitor_data')\
            .select('country, city')\
            .order('country, city')\
            .limit(1000)  # Limite raisonnable
        
        response = await loop.run_in_executor(
            None,
            lambda: query.execute()
        )
        
        cities_data = response.data if response.data else []
        
        # Dédupliquer
        cities_set = set()
        for item in cities_data:
            country = item.get('country')
            city = item.get('city')
            if country and city:
                cities_set.add((country, city))
        
        cities_list = [
            {'country': c[0], 'city': c[1]}
            for c in sorted(cities_set)
        ]
        
        # Filtrer par target_cities si fourni
        if target_cities:
            cities_list = [
                c for c in cities_list
                if c['city'] in target_cities
            ]
        
        logger.info(f"Found {len(cities_list)} cities to process")
        return cities_list
        
    except Exception as e:
        logger.error(f"Error fetching cities: {e}")
        return []


async def get_properties_for_city(
    supabase_client: Client,
    country: str,
    city: str
) -> List[Dict[str, Any]]:
    """
    Récupère les propriétés pour une ville donnée.
    
    Args:
        supabase_client: Client Supabase
        country: Pays
        city: Ville
        
    Returns:
        Liste de propriétés avec id, city, country, neighborhood, property_type
    """
    try:
        loop = asyncio.get_event_loop()
        
        query = supabase_client.table('properties')\
            .select('id, city, country, neighborhood, property_type')\
            .eq('country', country)\
            .eq('city', city)
        
        response = await loop.run_in_executor(
            None,
            lambda: query.execute()
        )
        
        properties = response.data if response.data else []
        
        logger.debug(f"Found {len(properties)} properties for {city}, {country}")
        return properties
        
    except Exception as e:
        logger.error(f"Error fetching properties for {city}, {country}: {e}")
        return []


async def store_market_features(
    supabase_client: Client,
    features: Dict[str, Any]
) -> bool:
    """
    Stocke les features dans market_features.
    
    Args:
        supabase_client: Client Supabase
        features: Dict avec toutes les features à stocker
        
    Returns:
        True si succès, False sinon
    """
    try:
        loop = asyncio.get_event_loop()
        
        # Préparer le record pour Supabase
        record = features.copy()
        
        # S'assurer que les listes sont bien formatées (TEXT[])
        if 'event_categories' in record and record['event_categories']:
            if not isinstance(record['event_categories'], list):
                record['event_categories'] = [record['event_categories']]
        else:
            record['event_categories'] = []
        
        if 'data_sources' in record and record['data_sources']:
            if not isinstance(record['data_sources'], list):
                record['data_sources'] = [record['data_sources']]
        else:
            record['data_sources'] = []
        
        # Upsert (idempotent grâce à UNIQUE constraint)
        response = await loop.run_in_executor(
            None,
            lambda: supabase_client.table('market_features')\
                .upsert(
                    record,
                    on_conflict='country,city,neighborhood,property_type,date'
                )\
                .execute()
        )
        
        return True
        
    except Exception as e:
        logger.error(f"Error storing market features: {e}", exc_info=True)
        return False


async def calculate_market_demand_level(
    weather_score: Optional[float],
    event_intensity: Optional[float],
    market_trend: Optional[float],
    market_sentiment: Optional[float],
    is_holiday: bool = False,
    is_school_holiday: bool = False
) -> Optional[float]:
    """
    Calcule un score de demande marché (0-100).
    
    Plus élevé = demande plus forte.
    
    Args:
        weather_score: Score météo (0-100)
        event_intensity: Intensité événements (0-100)
        market_trend: Tendance marché (-1 à +1)
        market_sentiment: Sentiment marché (-1 à +1)
        is_holiday: Jour férié
        is_school_holiday: Vacances scolaires
        
    Returns:
        Score de demande (0-100) ou None
    """
    score = 50.0  # Base
    
    # Weather (0-100) → contribue 30%
    if weather_score is not None:
        score += (weather_score - 50.0) * 0.3
    
    # Event intensity (0-100) → contribue 25%
    if event_intensity is not None:
        score += (event_intensity - 50.0) * 0.25
    
    # Market trend (-1 à +1) → contribue 20%
    if market_trend is not None:
        score += market_trend * 20.0 * 0.2
    
    # Market sentiment (-1 à +1) → contribue 15%
    if market_sentiment is not None:
        score += market_sentiment * 20.0 * 0.15
    
    # Holidays → bonus 10 points
    if is_holiday:
        score += 10.0
    if is_school_holiday:
        score += 10.0
    
    # Limiter entre 0 et 100
    score = max(0.0, min(100.0, score))
    
    return float(score)


async def update_pricing_features(
    supabase_client: Client,
    date_range: Dict[str, date],
    settings: Optional[Settings] = None
) -> Dict[str, Any]:
    """
    Met à jour features_pricing_daily avec competitor_avg_price et market_demand_level.
    
    Joint market_features avec properties pour mettre à jour les features de pricing.
    
    Args:
        supabase_client: Client Supabase
        date_range: Plage de dates avec 'start_date' et 'end_date'
        settings: Configuration
        
    Returns:
        Rapport de mise à jour
    """
    settings = settings or Settings.from_env()
    
    report = {
        "start_time": datetime.now(),
        "properties_updated": 0,
        "errors": []
    }
    
    logger.info(f"Updating pricing features for date range: {date_range}")
    
    try:
        loop = asyncio.get_event_loop()
        
        start_date = date_range['start_date']
        end_date = date_range['end_date']
        
        # Récupérer toutes les propriétés actives
        properties_query = supabase_client.table('properties')\
            .select('id, country, city, neighborhood, property_type')\
            .not_.is_('city', 'null')\
            .not_.is_('country', 'null')
        
        properties_response = await loop.run_in_executor(
            None,
            lambda: properties_query.execute()
        )
        
        properties = properties_response.data if properties_response.data else []
        
        logger.info(f"Found {len(properties)} properties to update")
        
        # Pour chaque propriété et chaque date
        current_date = start_date
        updates_count = 0
        
        while current_date <= end_date:
            for prop in properties:
                try:
                    country = prop.get('country')
                    city = prop.get('city')
                    neighborhood = prop.get('neighborhood')
                    property_type = prop.get('property_type')
                    property_id = prop.get('id')
                    
                    if not country or not city or not property_id:
                        continue
                    
                    # Chercher les market_features correspondantes
                    # D'abord essayer avec neighborhood + property_type
                    mf_query = supabase_client.table('market_features')\
                        .select('competitor_avg_price, weather_score, event_intensity_score, '
                               'market_trend_score, market_sentiment_score, '
                               'is_holiday, is_school_holiday')\
                        .eq('country', country)\
                        .eq('city', city)\
                        .eq('date', current_date.isoformat())
                    
                    if neighborhood:
                        mf_query = mf_query.eq('neighborhood', neighborhood)
                    else:
                        mf_query = mf_query.is_('neighborhood', 'null')
                    
                    if property_type:
                        mf_query = mf_query.eq('property_type', property_type)
                    else:
                        mf_query = mf_query.is_('property_type', 'null')
                    
                    mf_response = await loop.run_in_executor(
                        None,
                        lambda: mf_query.maybe_single().execute()
                    )
                    
                    market_features = mf_response.data if mf_response.data else None
                    
                    if not market_features:
                        # Fallback: chercher au niveau ville (sans neighborhood/property_type)
                        mf_query_fallback = supabase_client.table('market_features')\
                            .select('competitor_avg_price, weather_score, event_intensity_score, '
                                   'market_trend_score, market_sentiment_score, '
                                   'is_holiday, is_school_holiday')\
                            .eq('country', country)\
                            .eq('city', city)\
                            .eq('date', current_date.isoformat())\
                            .is_('neighborhood', 'null')\
                            .is_('property_type', 'null')
                        
                        mf_response_fallback = await loop.run_in_executor(
                            None,
                            lambda: mf_query_fallback.maybe_single().execute()
                        )
                        
                        market_features = mf_response_fallback.data if mf_response_fallback.data else None
                    
                    if not market_features:
                        logger.debug(
                            f"No market features found for {property_id} on {current_date}"
                        )
                        continue
                    
                    # Extraire les valeurs
                    competitor_avg_price = market_features.get('competitor_avg_price')
                    
                    market_demand_level = await calculate_market_demand_level(
                        weather_score=market_features.get('weather_score'),
                        event_intensity=market_features.get('event_intensity_score'),
                        market_trend=market_features.get('market_trend_score'),
                        market_sentiment=market_features.get('market_sentiment_score'),
                        is_holiday=market_features.get('is_holiday', False),
                        is_school_holiday=market_features.get('is_school_holiday', False)
                    )
                    
                    # Mettre à jour features_pricing_daily
                    # Note: Cette table doit exister et avoir les colonnes property_id, date,
                    # competitor_avg_price, market_demand_level
                    update_data = {}
                    if competitor_avg_price is not None:
                        update_data['competitor_avg_price'] = float(competitor_avg_price)
                    if market_demand_level is not None:
                        update_data['market_demand_level'] = float(market_demand_level)
                    
                    if update_data:
                        # Upsert dans features_pricing_daily
                        update_record = {
                            'property_id': property_id,
                            'date': current_date.isoformat(),
                            **update_data
                        }
                        
                        update_response = await loop.run_in_executor(
                            None,
                            lambda: supabase_client.table('features_pricing_daily')\
                                .upsert(
                                    update_record,
                                    on_conflict='property_id,date'
                                )\
                                .execute()
                        )
                        
                        updates_count += 1
                        
                        if updates_count % 100 == 0:
                            logger.info(f"Updated {updates_count} pricing features...")
                        
                except Exception as e:
                    error_msg = f"Error updating pricing features for {prop.get('id')} on {current_date}: {e}"
                    logger.error(error_msg)
                    report['errors'].append(error_msg)
            
            current_date += timedelta(days=1)
        
        report['properties_updated'] = updates_count
        report['end_time'] = datetime.now()
        report['duration_seconds'] = (
            report['end_time'] - report['start_time']
        ).total_seconds()
        
        logger.info(
            f"Updated {updates_count} pricing features in "
            f"{report['duration_seconds']:.2f}s"
        )
        
        return report
        
    except Exception as e:
        error_msg = f"Error in update_pricing_features: {e}"
        logger.error(error_msg, exc_info=True)
        report['errors'].append(error_msg)
        report['end_time'] = datetime.now()
        report['duration_seconds'] = (
            report['end_time'] - report['start_time']
        ).total_seconds()
        return report


async def build_features_for_date_range(
    date_range: Dict[str, date],
    cities: Optional[List[str]] = None,
    neighborhoods: Optional[List[str]] = None,
    property_types: Optional[List[str]] = None,
    settings: Optional[Settings] = None
) -> Dict[str, Any]:
    """
    Construit les features marché pour une plage de dates.
    
    Args:
        date_range: Dict avec 'start_date' et 'end_date'
        cities: Liste de villes (None = toutes disponibles)
        neighborhoods: Liste de quartiers (None = tous)
        property_types: Liste de types de propriétés (None = tous)
        settings: Configuration
        
    Returns:
        Rapport de construction
    """
    settings = settings or Settings.from_env()
    
    # Logger le début du job
    job_params = {
        'date_range': date_range,
        'cities': cities,
        'neighborhoods': neighborhoods,
        'property_types': property_types
    }
    await log_job_start(
        job_name="build_market_features",
        job_type="build_features",
        params=job_params,
        triggered_by="api"
    )
    
    if not SUPABASE_AVAILABLE:
        error_msg = "Supabase client not available"
        await log_job_end(
            job_name="build_market_features",
            status=JobStatus.FAILED,
            stats={"records_processed": 0, "records_success": 0, "records_failed": 1},
            errors=[{"error": error_msg}],
            error_message=error_msg
        )
        raise RuntimeError(error_msg)
    
    if not settings.supabase_url or not settings.supabase_key:
        error_msg = "Supabase URL or key not configured"
        await log_job_end(
            job_name="build_market_features",
            status=JobStatus.FAILED,
            stats={"records_processed": 0, "records_success": 0, "records_failed": 1},
            errors=[{"error": error_msg}],
            error_message=error_msg
        )
        raise RuntimeError(error_msg)
    
    supabase_client = create_client(settings.supabase_url, settings.supabase_key)
    calculator = FeatureCalculator(settings=settings)
    
    report = {
        "start_time": datetime.now(),
        "features_built": 0,
        "features_skipped": 0,
        "errors": [],
        "warnings": []
    }
    
    logger.info(f"Building market features for date range: {date_range}")
    
    # Récupérer les villes à traiter
    cities_to_process = await get_cities_to_process(supabase_client, cities)
    
    if not cities_to_process:
        logger.warning("No cities found to process")
        report['warnings'].append("No cities found to process")
        report['end_time'] = datetime.now()
        report['duration_seconds'] = 0
        report['status'] = 'success'
        
        # Logger la fin du job
        await log_job_end(
            job_name="build_market_features",
            status=JobStatus.SUCCESS,
            stats={"records_processed": 0, "records_success": 0, "records_failed": 0},
            errors=None,
            error_message=None
        )
        
        return report
    
    # Parcourir chaque date
    current_date = date_range['start_date']
    end_date = date_range['end_date']
    
    while current_date <= end_date:
        logger.info(f"Processing date: {current_date}")
        
        for city_info in cities_to_process:
            country = city_info['country']
            city = city_info['city']
            
            try:
                # Récupérer les propriétés pour cette ville
                properties = await get_properties_for_city(
                    supabase_client, country, city
                )
                
                # Construire les combinaisons de features à calculer
                # 1. Niveau ville (neighborhood=None, property_type=None)
                # 2. Par neighborhood (si propriétés avec neighborhoods)
                # 3. Par property_type (si propriétés avec types)
                # 4. Par neighborhood + property_type
                
                combinations = [
                    {
                        'neighborhood': None,
                        'property_type': None,
                        'description': f"{city}, {country} (all)"
                    }
                ]
                
                # Ajouter les neighborhoods uniques
                unique_neighborhoods = set()
                unique_property_types = set()
                
                for prop in properties:
                    if prop.get('neighborhood'):
                        unique_neighborhoods.add(prop['neighborhood'])
                    if prop.get('property_type'):
                        unique_property_types.add(prop['property_type'])
                
                # Filtrer si spécifié
                if neighborhoods:
                    unique_neighborhoods = {
                        n for n in unique_neighborhoods
                        if n in neighborhoods
                    }
                
                if property_types:
                    unique_property_types = {
                        t for t in unique_property_types
                        if t in property_types
                    }
                
                # Ajouter les combinaisons
                for neighborhood in unique_neighborhoods:
                    combinations.append({
                        'neighborhood': neighborhood,
                        'property_type': None,
                        'description': f"{city}, {country}, {neighborhood}"
                    })
                
                for property_type in unique_property_types:
                    combinations.append({
                        'neighborhood': None,
                        'property_type': property_type,
                        'description': f"{city}, {country}, {property_type}"
                    })
                
                for neighborhood in unique_neighborhoods:
                    for property_type in unique_property_types:
                        combinations.append({
                            'neighborhood': neighborhood,
                            'property_type': property_type,
                            'description': f"{city}, {country}, {neighborhood}, {property_type}"
                        })
                
                # Calculer les features pour chaque combinaison
                for combo in combinations:
                    try:
                        logger.debug(
                            f"Building features for {combo['description']} on {current_date}"
                        )
                        
                        # Calculer toutes les features
                        features = await calculator.build_all_features(
                            target_date=current_date,
                            city=city,
                            country=country,
                            neighborhood=combo['neighborhood'],
                            property_type=combo['property_type']
                        )
                        
                        # Stocker dans market_features
                        success = await store_market_features(
                            supabase_client, features
                        )
                        
                        if success:
                            report['features_built'] += 1
                        else:
                            report['features_skipped'] += 1
                            report['warnings'].append(
                                f"Failed to store features for {combo['description']} on {current_date}"
                            )
                        
                    except Exception as e:
                        error_msg = (
                            f"Error building features for {combo['description']} "
                            f"on {current_date}: {e}"
                        )
                        logger.error(error_msg, exc_info=True)
                        report['errors'].append(error_msg)
                
            except Exception as e:
                error_msg = f"Error processing {city}, {country} on {current_date}: {e}"
                logger.error(error_msg, exc_info=True)
                report['errors'].append(error_msg)
        
        current_date += timedelta(days=1)
    
    report['end_time'] = datetime.now()
    report['duration_seconds'] = (
        report['end_time'] - report['start_time']
    ).total_seconds()
    
    # Déterminer le statut
    if report.get('errors'):
        report['status'] = 'partial' if report['features_built'] > 0 else 'failed'
    else:
        report['status'] = 'success'
    
    # Logger la fin du job
    job_status = JobStatus.SUCCESS if report['status'] == 'success' else (
        JobStatus.FAILED if report['status'] == 'failed' else JobStatus.PARTIAL
    )
    
    stats = {
        "records_processed": report.get('features_built', 0),
        "records_success": report.get('features_built', 0),
        "records_failed": len(report.get('errors', [])),
        "duration_seconds": report.get('duration_seconds', 0)
    }
    
    await log_job_end(
        job_name="build_market_features",
        status=job_status,
        stats=stats,
        errors=report.get('errors') if report.get('errors') else None,
        error_message=f"Built features with {len(report.get('errors', []))} errors" if report.get('errors') else None
    )
    
    logger.info(
        f"Built {report['features_built']} market features in "
        f"{report['duration_seconds']:.2f}s"
    )
    
    return report


async def main_async(
    date_range: Dict[str, date],
    cities: Optional[List[str]] = None,
    neighborhoods: Optional[List[str]] = None,
    property_types: Optional[List[str]] = None,
    update_pricing: bool = True,
    json_output: bool = False
) -> Dict[str, Any]:
    """
    Point d'entrée principal asynchrone.
    
    Args:
        date_range: Plage de dates
        cities: Villes à traiter
        neighborhoods: Quartiers à traiter
        property_types: Types de propriétés à traiter
        update_pricing: Si True, met à jour features_pricing_daily
        json_output: Si True, affiche le rapport en JSON
        
    Returns:
        Rapport combiné
    """
    settings = Settings.from_env()
    
    # 1. Construire les features
    build_report = await build_features_for_date_range(
        date_range=date_range,
        cities=cities,
        neighborhoods=neighborhoods,
        property_types=property_types,
        settings=settings
    )
    
    # 2. Mettre à jour pricing features si demandé
    pricing_report = None
    if update_pricing:
        logger.info("Updating pricing features...")
        pricing_report = await update_pricing_features(
            supabase_client=create_client(settings.supabase_url, settings.supabase_key),
            date_range=date_range,
            settings=settings
        )
    
    # Combiner les rapports
    combined_report = {
        "status": "failed" if build_report.get('errors') else "success",
        "build_features": build_report,
        "update_pricing": pricing_report
    }
    
    if json_output:
        # Convertir datetime en string pour JSON
        def json_serial(obj):
            if isinstance(obj, (datetime, date)):
                return obj.isoformat()
            raise TypeError(f"Type {type(obj)} not serializable")
        
        print(json.dumps(combined_report, indent=2, default=json_serial))
    else:
        print(f"\n{'='*60}")
        print("MARKET FEATURES BUILD REPORT")
        print(f"{'='*60}")
        print(f"\nBuild Features:")
        print(f"  Status: {build_report.get('status', 'completed')}")
        print(f"  Features built: {build_report['features_built']}")
        print(f"  Features skipped: {build_report.get('features_skipped', 0)}")
        print(f"  Duration: {build_report['duration_seconds']:.2f}s")
        print(f"  Errors: {len(build_report['errors'])}")
        print(f"  Warnings: {len(build_report.get('warnings', []))}")
        
        if pricing_report:
            print(f"\nUpdate Pricing Features:")
            print(f"  Properties updated: {pricing_report['properties_updated']}")
            print(f"  Duration: {pricing_report['duration_seconds']:.2f}s")
            print(f"  Errors: {len(pricing_report.get('errors', []))}")
        
        if build_report.get('errors'):
            print(f"\nErrors:")
            for error in build_report['errors'][:10]:  # Afficher les 10 premiers
                print(f"  - {error}")
    
    return combined_report


def main():
    """Point d'entrée CLI."""
    parser = argparse.ArgumentParser(
        description="Build market features from enriched data"
    )
    parser.add_argument(
        "--start-date",
        required=True,
        help="Start date (YYYY-MM-DD)"
    )
    parser.add_argument(
        "--end-date",
        required=True,
        help="End date (YYYY-MM-DD)"
    )
    parser.add_argument(
        "--cities",
        nargs="+",
        help="Cities to process (default: all)"
    )
    parser.add_argument(
        "--neighborhoods",
        nargs="+",
        help="Neighborhoods to process (default: all)"
    )
    parser.add_argument(
        "--property-types",
        nargs="+",
        help="Property types to process (default: all)"
    )
    parser.add_argument(
        "--no-update-pricing",
        action="store_true",
        help="Skip updating features_pricing_daily"
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output report as JSON"
    )
    
    args = parser.parse_args()
    
    date_range = {
        "start_date": date.fromisoformat(args.start_date),
        "end_date": date.fromisoformat(args.end_date),
    }
    
    exit_code = 0
    try:
        report = asyncio.run(main_async(
            date_range=date_range,
            cities=args.cities,
            neighborhoods=args.neighborhoods,
            property_types=args.property_types,
            update_pricing=not args.no_update_pricing,
            json_output=args.json
        ))
        
        if report['status'] == 'failed':
            exit_code = 1
        
    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        if args.json:
            print(json.dumps({"status": "error", "error": str(e)}))
        else:
            print(f"\nFatal error: {e}")
        exit_code = 1
    
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
