"""
Script pour insérer des données brutes de test dans Supabase.
Permet de tester l'enrichissement sans avoir à collecter les données (évite les coûts Apify).
"""

import asyncio
import argparse
import logging
import sys
from datetime import date, datetime, timedelta
from typing import List, Dict, Any

try:
    from supabase import create_client, Client
    SUPABASE_AVAILABLE = True
except ImportError:
    SUPABASE_AVAILABLE = False
    logging.warning("Supabase client not available. Install with: pip install supabase")

from ..config.settings import Settings

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


async def insert_test_competitor_data(
    supabase_client: Client,
    city: str = "Paris",
    country: str = "FR",
    num_records: int = 5
) -> int:
    """Insère des données brutes de test pour les concurrents."""
    logger.info(f"Inserting {num_records} test competitor records for {city}, {country}")
    
    today = date.today()
    records = []
    
    for i in range(num_records):
        data_date = today + timedelta(days=i)
        
        record = {
            "source": "apify",
            "country": country,
            "city": city,
            "neighborhood": f"Quartier {i+1}" if i < 3 else None,
            "property_type": "apartment" if i % 2 == 0 else "house",
            "bedrooms": 2 + (i % 3),
            "bathrooms": 1 + (i % 2),
            "data_date": data_date.isoformat(),
            "collected_at": datetime.now().isoformat(),
            "raw_data": {
                "source": "test_data",
                "test_id": i,
                "url": f"https://airbnb.com/rooms/test-{i}",
                "title": f"Test Property {i+1}",
                "pricing": {
                    "price": 100.0 + (i * 20),
                    "currency": "EUR",
                    "date": data_date.isoformat()
                },
                "bedrooms": 2 + (i % 3),
                "bathrooms": 1 + (i % 2)
            },
            "avg_price": 100.0 + (i * 20),
            "min_price": 90.0 + (i * 20),
            "max_price": 110.0 + (i * 20),
            "p25_price": 95.0 + (i * 20),
            "p50_price": 100.0 + (i * 20),
            "p75_price": 105.0 + (i * 20),
            "sample_size": 1,
            "currency": "EUR",
            "timezone": "Europe/Paris",
            "metadata": {
                "test": True,
                "inserted_by": "insert_test_raw_data.py"
            }
        }
        records.append(record)
    
    try:
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None,
            lambda: supabase_client.table('raw_competitor_data').upsert(
                records,
                on_conflict='source,country,city,neighborhood,property_type,data_date'
            ).execute()
        )
        
        if hasattr(response, 'data') and response.data:
            logger.info(f"Successfully inserted {len(response.data)} competitor records")
            return len(response.data)
        else:
            logger.warning("No data returned from insert (may have been duplicates)")
            return 0
            
    except Exception as e:
        logger.error(f"Error inserting competitor data: {e}", exc_info=True)
        return 0


async def insert_test_events_data(
    supabase_client: Client,
    city: str = "Paris",
    country: str = "FR",
    num_records: int = 3
) -> int:
    """Insère des données brutes de test pour les événements."""
    logger.info(f"Inserting {num_records} test event records for {city}, {country}")
    
    today = date.today()
    records = []
    
    event_types = [
        {"title": "Festival de Musique", "category": "music", "impact": "positive"},
        {"title": "Marathon de Paris", "category": "sport", "impact": "positive"},
        {"title": "Convention Business", "category": "business", "impact": "neutral"}
    ]
    
    for i in range(num_records):
        event = event_types[i % len(event_types)]
        event_date = today + timedelta(days=7 + i)
        
        record = {
            "source": "eventbrite",
            "country": country,
            "city": city,
            "event_date": event_date.isoformat(),
            "collected_at": datetime.now().isoformat(),
            "raw_data": {
                "source": "test_data",
                "test_id": i,
                "name": event["title"],
                "description": f"Test event {i+1} in {city}",
                "start": {
                    "local": event_date.isoformat(),
                    "timezone": "Europe/Paris"
                },
                "category": event["category"],
                "venue": {
                    "name": f"Venue {i+1}",
                    "address": {
                        "city": city,
                        "country": country
                    }
                }
            },
            "event_name": event["title"],
            "event_type": event["category"],
            "event_category": event["category"],
            "description": f"Test event {i+1} in {city}",
            "venue_name": f"Venue {i+1}",
            "venue_address": f"{i+1} Test Street, {city}",
            "metadata": {
                "test": True,
                "impact": event["impact"],
                "inserted_by": "insert_test_raw_data.py"
            }
        }
        records.append(record)
    
    try:
        loop = asyncio.get_event_loop()
        # Utiliser la contrainte UNIQUE correcte: (source, country, city, event_name, event_date, venue_name)
        response = await loop.run_in_executor(
            None,
            lambda: supabase_client.table('raw_events_data').upsert(
                records,
                on_conflict='source,country,city,event_name,event_date,venue_name'
            ).execute()
        )
        
        if hasattr(response, 'data') and response.data:
            logger.info(f"Successfully inserted {len(response.data)} event records")
            return len(response.data)
        else:
            logger.warning("No data returned from insert (may have been duplicates)")
            return 0
            
    except Exception as e:
        logger.error(f"Error inserting events data: {e}", exc_info=True)
        return 0


async def insert_test_news_data(
    supabase_client: Client,
    city: str = "Paris",
    country: str = "FR",
    num_records: int = 5
) -> int:
    """Insère des données brutes de test pour les actualités."""
    logger.info(f"Inserting {num_records} test news records for {city}, {country}")
    
    today = date.today()
    records = []
    
    news_samples = [
        {"title": f"Tourisme en hausse à {city}", "sentiment": "positive"},
        {"title": f"Nouvelles attractions à {city}", "sentiment": "positive"},
        {"title": f"Événements culturels à {city}", "sentiment": "neutral"},
        {"title": f"Infrastructure améliorée à {city}", "sentiment": "positive"},
        {"title": f"Actualités {city}", "sentiment": "neutral"}
    ]
    
    for i in range(num_records):
        news = news_samples[i % len(news_samples)]
        published_date = today - timedelta(days=i)
        
        record = {
            "source": "newsapi",
            "country": country,
            "city": city,
            "published_at": datetime.combine(published_date, datetime.min.time()).isoformat(),
            "collected_at": datetime.now().isoformat(),
            "raw_data": {
                "source": "test_data",
                "test_id": i,
                "title": news["title"],
                "description": f"Test news article {i+1} about {city}",
                "content": f"This is test content for article {i+1} about tourism and events in {city}.",
                "url": f"https://example.com/news/{i}",
                "publishedAt": published_date.isoformat(),
                "author": f"Test Author {i+1}",
                "source": {"name": "Test News Source"}
            },
            "headline": news["title"],
            "article_text": f"Test news article {i+1} about {city}. This is test content for article about tourism and events in {city}.",
            "url": f"https://example.com/news/{i}",
            "author": f"Test Author {i+1}",
            "language": "fr" if country == "FR" else "en",
            "source_media": "Test News Source",
            "metadata": {
                "test": True,
                "sentiment": news["sentiment"],
                "inserted_by": "insert_test_raw_data.py"
            }
        }
        records.append(record)
    
    try:
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None,
            lambda: supabase_client.table('raw_news_data').upsert(
                records,
                on_conflict='source,url,published_at'
            ).execute()
        )
        
        if hasattr(response, 'data') and response.data:
            logger.info(f"Successfully inserted {len(response.data)} news records")
            return len(response.data)
        else:
            logger.warning("No data returned from insert (may have been duplicates)")
            return 0
            
    except Exception as e:
        logger.error(f"Error inserting news data: {e}", exc_info=True)
        return 0


async def insert_test_trends_data(
    supabase_client: Client,
    city: str = "Paris",
    country: str = "FR",
    num_records: int = 30
) -> int:
    """Insère des données brutes de test pour les tendances."""
    logger.info(f"Inserting {num_records} test trend records for {city}, {country}")
    
    today = date.today()
    records = []
    
    # Générer des données sur 30 jours
    for i in range(num_records):
        data_date = today - timedelta(days=num_records - i - 1)
        
        # Simuler une tendance avec variation
        base_value = 100
        trend_value = base_value + (i * 2) + (10 * (i % 7))  # Variation hebdomadaire
        
        record = {
            "source": "google_trends",
            "country": country,
            "city": city,
            "trend_date": data_date.isoformat(),  # Note: le champ s'appelle trend_date dans le schéma
            "collected_at": datetime.now().isoformat(),
            "raw_data": {
                "source": "test_data",
                "test_id": i,
                "query": f"airbnb {city}",
                "interest_over_time": [
                    {
                        "date": data_date.isoformat(),
                        "value": trend_value
                    }
                ]
            },
            "keywords": [f"airbnb {city}"],
            "search_volume_index": trend_value,
            "metadata": {
                "test": True,
                "inserted_by": "insert_test_raw_data.py"
            }
        }
        records.append(record)
    
    try:
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None,
            lambda: supabase_client.table('raw_market_trends_data').upsert(
                records,
                on_conflict='source,country,city,trend_date'
            ).execute()
        )
        
        if hasattr(response, 'data') and response.data:
            logger.info(f"Successfully inserted {len(response.data)} trend records")
            return len(response.data)
        else:
            logger.warning("No data returned from insert (may have been duplicates)")
            return 0
            
    except Exception as e:
        logger.error(f"Error inserting trends data: {e}", exc_info=True)
        return 0


async def main():
    """Point d'entrée principal."""
    parser = argparse.ArgumentParser(
        description="Insère des données brutes de test dans Supabase",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Exemples:
  python -m market_data_pipeline.scripts.insert_test_raw_data
  python -m market_data_pipeline.scripts.insert_test_raw_data --city Paris --country FR
  python -m market_data_pipeline.scripts.insert_test_raw_data --city Paris --country FR --competitors-only
        """
    )
    
    parser.add_argument(
        "--city",
        type=str,
        default="Paris",
        help="Ville pour les données de test (defaut: Paris)"
    )
    
    parser.add_argument(
        "--country",
        type=str,
        default="FR",
        help="Pays pour les donnees de test (defaut: FR)"
    )
    
    parser.add_argument(
        "--competitors-only",
        action="store_true",
        help="Inserer uniquement les donnees concurrents"
    )
    
    parser.add_argument(
        "--events-only",
        action="store_true",
        help="Inserer uniquement les donnees evenements"
    )
    
    parser.add_argument(
        "--news-only",
        action="store_true",
        help="Inserer uniquement les donnees actualites"
    )
    
    parser.add_argument(
        "--trends-only",
        action="store_true",
        help="Inserer uniquement les donnees tendances"
    )
    
    parser.add_argument(
        "--num-records",
        type=int,
        default=5,
        help="Nombre de records a inserer par type (defaut: 5)"
    )
    
    args = parser.parse_args()
    
    if not SUPABASE_AVAILABLE:
        logger.error("Supabase client not available. Install with: pip install supabase")
        sys.exit(1)
    
    settings = Settings.from_env()
    
    if not settings.supabase_url or not settings.supabase_key:
        logger.error("Supabase URL or key not configured. Check your .env file.")
        sys.exit(1)
    
    supabase_client = create_client(settings.supabase_url, settings.supabase_key)
    
    logger.info("=" * 80)
    logger.info("INSERTION DE DONNEES BRUTES DE TEST")
    logger.info("=" * 80)
    logger.info(f"Ville: {args.city}, Pays: {args.country}")
    logger.info("=" * 80)
    
    total_inserted = 0
    
    # Insérer selon les options
    if args.competitors_only:
        total_inserted += await insert_test_competitor_data(
            supabase_client, args.city, args.country, args.num_records
        )
    elif args.events_only:
        total_inserted += await insert_test_events_data(
            supabase_client, args.city, args.country, args.num_records
        )
    elif args.news_only:
        total_inserted += await insert_test_news_data(
            supabase_client, args.city, args.country, args.num_records
        )
    elif args.trends_only:
        total_inserted += await insert_test_trends_data(
            supabase_client, args.city, args.country, 30  # Trends: 30 jours
        )
    else:
        # Insérer toutes les données
        total_inserted += await insert_test_competitor_data(
            supabase_client, args.city, args.country, args.num_records
        )
        total_inserted += await insert_test_events_data(
            supabase_client, args.city, args.country, args.num_records
        )
        total_inserted += await insert_test_news_data(
            supabase_client, args.city, args.country, args.num_records
        )
        total_inserted += await insert_test_trends_data(
            supabase_client, args.city, args.country, 30  # Trends: 30 jours
        )
    
    logger.info("=" * 80)
    logger.info(f"INSERTION TERMINEE: {total_inserted} records inseres")
    logger.info("=" * 80)
    logger.info("Vous pouvez maintenant tester l'enrichissement avec:")
    logger.info(f"  python -m market_data_pipeline.scripts.test_pipeline --city {args.city} --country {args.country} --skip-collect")


if __name__ == "__main__":
    asyncio.run(main())

