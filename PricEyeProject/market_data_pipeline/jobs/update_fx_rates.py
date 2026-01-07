"""
Job quotidien pour mettre à jour les taux de change.

À exécuter quotidiennement pour récupérer les derniers taux de change
et les stocker dans la table fx_rates.
"""

import asyncio
import logging
import sys
from datetime import date

from market_data_pipeline.utils.currency_converter import CurrencyConverter
from market_data_pipeline.config.settings import Settings

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


async def update_fx_rates_daily():
    """
    Met à jour les taux de change quotidiennement.
    
    Peut être appelé depuis un cron job ou un scheduler.
    """
    logger.info("Starting daily FX rates update")
    
    try:
        # Charger la configuration
        settings = Settings.from_env()
        
        # Créer le convertisseur
        converter = CurrencyConverter(
            base_currency=settings.base_currency,
            settings=settings
        )
        
        # Devises à tracker (les plus courantes pour le marché short-term rental)
        currencies = [
            'USD',  # États-Unis
            'GBP',  # Royaume-Uni
            'EUR',  # Europe
            'JPY',  # Japon
            'CHF',  # Suisse
            'CAD',  # Canada
            'AUD',  # Australie
            'CNY',  # Chine
            'NZD',  # Nouvelle-Zélande
            'SEK',  # Suède
            'NOK',  # Norvège
            'DKK',  # Danemark
            'PLN',  # Pologne
            'CZK',  # République tchèque
            'HUF',  # Hongrie
            'BRL',  # Brésil
            'MXN',  # Mexique
            'INR',  # Inde
            'SGD',  # Singapour
            'HKD',  # Hong Kong
            'KRW',  # Corée du Sud
            'TRY',  # Turquie
            'ZAR',  # Afrique du Sud
            'AED',  # Émirats arabes unis
            'ILS',  # Israël
            'THB',  # Thaïlande
            'MYR',  # Malaisie
            'IDR',  # Indonésie
            'PHP',  # Philippines
            'VND',  # Viêt Nam
        ]
        
        # Récupérer et stocker les taux pour aujourd'hui
        stats = await converter.fetch_and_store_rates(
            currencies=currencies,
            rate_date=date.today()
        )
        
        logger.info(
            f"FX rates update completed: "
            f"{stats['stored']} stored, {stats['updated']} updated, "
            f"{stats['failed']} failed"
        )
        
        # Fermer la session
        await converter.close()
        
        return stats
        
    except Exception as e:
        logger.error(f"Error updating FX rates: {e}", exc_info=True)
        raise


def main():
    """Point d'entrée CLI."""
    try:
        stats = asyncio.run(update_fx_rates_daily())
        
        # Afficher un résumé
        total = stats['stored'] + stats['updated']
        failed = stats['failed']
        
        if failed == 0:
            print(f"✅ Successfully updated {total} FX rates")
            return 0
        else:
            print(f"⚠️  Updated {total} FX rates, {failed} failed")
            return 1
            
    except Exception as e:
        logger.error(f"FX rates update failed: {e}")
        print(f"❌ FX rates update failed: {e}")
        return 1


if __name__ == '__main__':
    sys.exit(main())









