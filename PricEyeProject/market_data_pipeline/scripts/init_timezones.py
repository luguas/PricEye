"""
Script pour initialiser les timezones dans Supabase depuis cities_config.py.

À exécuter une fois pour peupler la table timezones avec les villes configurées.
"""

import asyncio
import sys
import logging
from market_data_pipeline.utils.timezone_handler import TimezoneHandler
from market_data_pipeline.config.cities_config import get_all_cities
from market_data_pipeline.config.settings import Settings

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def init_timezones():
    """Initialise les timezones dans Supabase depuis cities_config.py."""
    logger.info("Initializing timezones in Supabase")
    
    handler = TimezoneHandler(Settings.from_env())
    cities = get_all_cities()
    
    stored_count = 0
    failed_count = 0
    
    for city_config in cities:
        try:
            success = await handler.store_timezone_mapping(
                country=city_config.country,
                city=city_config.name,
                timezone=city_config.timezone,
                latitude=city_config.latitude,
                longitude=city_config.longitude,
                region=city_config.region
            )
            
            if success:
                stored_count += 1
            else:
                failed_count += 1
                
        except Exception as e:
            logger.error(f"Error storing timezone for {city_config.name}, {city_config.country}: {e}")
            failed_count += 1
    
    logger.info(
        f"Timezone initialization complete: "
        f"{stored_count} stored, {failed_count} failed"
    )
    
    return stored_count, failed_count


def main():
    """Point d'entrée CLI."""
    try:
        stored, failed = asyncio.run(init_timezones())
        
        if failed == 0:
            print(f"✅ Successfully initialized {stored} timezone mappings")
            return 0
        else:
            print(f"⚠️  Initialized {stored} timezones, {failed} failed")
            return 1
            
    except Exception as e:
        logger.error(f"Timezone initialization failed: {e}", exc_info=True)
        print(f"❌ Initialization failed: {e}")
        return 1


if __name__ == '__main__':
    sys.exit(main())


