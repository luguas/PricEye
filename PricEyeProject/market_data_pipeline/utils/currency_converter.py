"""
Convertisseur de devises avec cache et historique.

Utilise exchangerate-api.com (gratuit) ou fixer.io avec fallback.
Met en cache les taux dans Supabase (table fx_rates) pour performance et historique.
"""

import asyncio
import logging
from typing import Optional, List, Dict, Any
from datetime import date, datetime, timedelta
import aiohttp

try:
    from supabase import create_client, Client
    SUPABASE_AVAILABLE = True
except ImportError:
    SUPABASE_AVAILABLE = False
    logging.warning("Supabase client not available. Install with: pip install supabase")

from ..config.api_keys import get_api_key, API_SERVICES
from ..config.settings import Settings

logger = logging.getLogger(__name__)


class CurrencyConverter:
    """
    Convertisseur de devises avec cache et historique.
    
    Supporte :
    - exchangerate-api.com (gratuit, pas de clé API nécessaire)
    - fixer.io (nécessite clé API)
    
    Met en cache les taux dans Supabase (table fx_rates) pour :
    - Performance (évite les appels API répétés)
    - Historique (pour reprocessing de données anciennes)
    - Résilience (utilise dernier taux connu si API down)
    """
    
    # URLs des APIs
    EXCHANGERATE_API_URL = "https://api.exchangerate-api.com/v4"
    FIXER_API_URL = "http://data.fixer.io/api"
    
    def __init__(
        self,
        base_currency: str = "EUR",
        primary_source: str = "exchangerate",
        fallback_source: Optional[str] = "fixer",
        settings: Optional[Settings] = None
    ):
        """
        Initialise le convertisseur.
        
        Args:
            base_currency: Devise de base pour conversions (défaut: EUR)
            primary_source: Source primaire ('exchangerate' ou 'fixer')
            fallback_source: Source de fallback (None pour désactiver)
            settings: Configuration (si None, charge depuis env)
        """
        self.base_currency = base_currency.upper()
        self.primary_source = primary_source.lower()
        self.fallback_source = fallback_source.lower() if fallback_source else None
        self.settings = settings or Settings.from_env()
        
        # Récupérer les clés API
        self.api_keys = {}
        if self.primary_source == "fixer" or (self.fallback_source == "fixer"):
            self.api_keys["fixer"] = get_api_key(API_SERVICES.EXCHANGERATE)
        
        # Session HTTP
        self.session: Optional[aiohttp.ClientSession] = None
        
        # Client Supabase (lazy init)
        self.supabase_client: Optional[Client] = None
        
        logger.info(
            f"Initialized CurrencyConverter (base: {self.base_currency}, "
            f"primary: {self.primary_source}, fallback: {self.fallback_source})"
        )
    
    async def get_rate(
        self,
        from_currency: str,
        to_currency: str,
        rate_date: Optional[date] = None
    ) -> float:
        """
        Récupère le taux de change entre deux devises.
        
        Utilise le cache Supabase si disponible, sinon récupère depuis l'API.
        
        Args:
            from_currency: Devise source (ISO 4217, ex: 'USD')
            to_currency: Devise cible (ex: 'EUR')
            rate_date: Date du taux (None = aujourd'hui)
        
        Returns:
            Taux de change (1 from_currency = rate to_currency)
        
        Raises:
            ValueError: Si les devises sont invalides
            RuntimeError: Si aucun taux n'est disponible
        """
        from_currency = from_currency.upper()
        to_currency = to_currency.upper()
        
        if from_currency == to_currency:
            return 1.0
        
        if rate_date is None:
            rate_date = date.today()
        
        logger.debug(f"Getting rate {from_currency} → {to_currency} for {rate_date}")
        
        # 1. Essayer le cache Supabase
        cached_rate = await self._get_cached_rate(from_currency, to_currency, rate_date)
        if cached_rate is not None:
            logger.debug(f"Found cached rate: {cached_rate}")
            return cached_rate
        
        # 2. Récupérer depuis l'API
        try:
            rate = await self._fetch_rate_from_api(from_currency, to_currency, rate_date)
            
            # 3. Mettre en cache
            await self._store_rate_in_cache(
                from_currency, to_currency, rate, rate_date, self.primary_source
            )
            
            return rate
            
        except Exception as e:
            logger.warning(f"Failed to fetch rate from API: {e}")
            
            # 3. Utiliser le dernier taux connu (plus récent)
            last_rate = await self._get_last_known_rate(from_currency, to_currency)
            if last_rate is not None:
                logger.info(
                    f"Using last known rate: {last_rate} "
                    f"(date: {await self._get_last_rate_date(from_currency, to_currency)})"
                )
                return last_rate
            
            # 4. Si tout échoue, essayer le fallback
            if self.fallback_source and self.fallback_source != self.primary_source:
                logger.info(f"Trying fallback source: {self.fallback_source}")
                try:
                    rate = await self._fetch_rate_from_api(
                        from_currency, to_currency, rate_date, use_fallback=True
                    )
                    await self._store_rate_in_cache(
                        from_currency, to_currency, rate, rate_date, self.fallback_source
                    )
                    return rate
                except Exception as fallback_error:
                    logger.error(f"Fallback source also failed: {fallback_error}")
            
            raise RuntimeError(
                f"Could not get exchange rate {from_currency} → {to_currency} "
                f"for {rate_date}. API failed and no cached rate available."
            ) from e
    
    async def convert(
        self,
        amount: float,
        from_currency: str,
        to_currency: str,
        rate_date: Optional[date] = None
    ) -> float:
        """
        Convertit un montant d'une devise à une autre.
        
        Args:
            amount: Montant à convertir
            from_currency: Devise source
            to_currency: Devise cible
            rate_date: Date du taux (None = aujourd'hui)
        
        Returns:
            Montant converti
        
        Raises:
            ValueError: Si amount est invalide
        """
        if amount is None or (isinstance(amount, float) and amount != amount):  # NaN check
            raise ValueError(f"Invalid amount: {amount}")
        
        if from_currency.upper() == to_currency.upper():
            return float(amount)
        
        rate = await self.get_rate(from_currency, to_currency, rate_date)
        converted = float(amount) * rate
        
        logger.debug(
            f"Converted {amount} {from_currency} → {converted:.2f} {to_currency} "
            f"(rate: {rate})"
        )
        
        return converted
    
    async def fetch_and_store_rates(
        self,
        currencies: Optional[List[str]] = None,
        rate_date: Optional[date] = None
    ) -> Dict[str, int]:
        """
        Récupère et stocke les taux de change dans fx_rates.
        
        Job quotidien pour mettre à jour les taux de change.
        
        Args:
            currencies: Liste des devises à récupérer (None = devises courantes)
            rate_date: Date pour laquelle récupérer les taux (None = aujourd'hui)
        
        Returns:
            Dict avec {'stored': int, 'updated': int, 'failed': int}
        """
        if rate_date is None:
            rate_date = date.today()
        
        # Devises par défaut (les plus courantes)
        if currencies is None:
            currencies = ['USD', 'GBP', 'EUR', 'JPY', 'CHF', 'CAD', 'AUD', 'CNY', 'NZD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'BRL', 'MXN', 'INR', 'SGD', 'HKD', 'KRW', 'TRY', 'ZAR']
        
        # Filtrer la devise de base
        currencies = [c.upper() for c in currencies if c.upper() != self.base_currency]
        
        logger.info(
            f"Fetching and storing FX rates for {len(currencies)} currencies "
            f"on {rate_date}"
        )
        
        stats = {'stored': 0, 'updated': 0, 'failed': 0}
        
        for currency in currencies:
            try:
                # Récupérer le taux depuis l'API
                rate = await self._fetch_rate_from_api(
                    currency, self.base_currency, rate_date
                )
                
                # Stocker dans Supabase
                stored = await self._store_rate_in_cache(
                    currency, self.base_currency, rate, rate_date, self.primary_source
                )
                
                if stored:
                    stats['stored'] += 1
                else:
                    stats['updated'] += 1
                
            except Exception as e:
                logger.error(f"Failed to fetch/store rate for {currency}: {e}")
                stats['failed'] += 1
                continue
        
        logger.info(
            f"FX rates update complete: {stats['stored']} stored, "
            f"{stats['updated']} updated, {stats['failed']} failed"
        )
        
        return stats
    
    # Méthodes privées
    
    async def _get_cached_rate(
        self,
        from_currency: str,
        to_currency: str,
        rate_date: date
    ) -> Optional[float]:
        """Récupère un taux depuis le cache Supabase."""
        if not SUPABASE_AVAILABLE or not self.settings.supabase_url:
            return None
        
        try:
            if not self.supabase_client:
                self.supabase_client = create_client(
                    self.settings.supabase_url,
                    self.settings.supabase_key
                )
            
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(
                None,
                lambda: self.supabase_client.table('fx_rates')
                    .select('rate')
                    .eq('from_currency', from_currency)
                    .eq('to_currency', to_currency)
                    .eq('rate_date', rate_date.isoformat())
                    .single()
                    .execute()
            )
            
            if response.data:
                return float(response.data['rate'])
            
        except Exception as e:
            logger.debug(f"Could not get cached rate: {e}")
        
        return None
    
    async def _get_last_known_rate(
        self,
        from_currency: str,
        to_currency: str
    ) -> Optional[float]:
        """Récupère le dernier taux connu (le plus récent disponible)."""
        if not SUPABASE_AVAILABLE or not self.settings.supabase_url:
            return None
        
        try:
            if not self.supabase_client:
                self.supabase_client = create_client(
                    self.settings.supabase_url,
                    self.settings.supabase_key
                )
            
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(
                None,
                lambda: self.supabase_client.table('fx_rates')
                    .select('rate, rate_date')
                    .eq('from_currency', from_currency)
                    .eq('to_currency', to_currency)
                    .order('rate_date', desc=True)
                    .limit(1)
                    .execute()
            )
            
            if response.data and len(response.data) > 0:
                return float(response.data[0]['rate'])
            
        except Exception as e:
            logger.debug(f"Could not get last known rate: {e}")
        
        return None
    
    async def _get_last_rate_date(
        self,
        from_currency: str,
        to_currency: str
    ) -> Optional[date]:
        """Récupère la date du dernier taux connu."""
        if not SUPABASE_AVAILABLE or not self.settings.supabase_url:
            return None
        
        try:
            if not self.supabase_client:
                self.supabase_client = create_client(
                    self.settings.supabase_url,
                    self.settings.supabase_key
                )
            
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(
                None,
                lambda: self.supabase_client.table('fx_rates')
                    .select('rate_date')
                    .eq('from_currency', from_currency)
                    .eq('to_currency', to_currency)
                    .order('rate_date', desc=True)
                    .limit(1)
                    .execute()
            )
            
            if response.data and len(response.data) > 0:
                return datetime.fromisoformat(response.data[0]['rate_date']).date()
            
        except Exception as e:
            logger.debug(f"Could not get last rate date: {e}")
        
        return None
    
    async def _fetch_rate_from_api(
        self,
        from_currency: str,
        to_currency: str,
        rate_date: date,
        use_fallback: bool = False
    ) -> float:
        """
        Récupère un taux depuis l'API.
        
        Args:
            from_currency: Devise source
            to_currency: Devise cible
            rate_date: Date du taux
            use_fallback: Si True, utilise la source de fallback
        
        Returns:
            Taux de change
        """
        source = self.fallback_source if use_fallback else self.primary_source
        
        if source == "exchangerate":
            return await self._fetch_exchangerate_api(from_currency, to_currency, rate_date)
        elif source == "fixer":
            return await self._fetch_fixer_api(from_currency, to_currency, rate_date)
        else:
            raise ValueError(f"Unknown source: {source}")
    
    async def _fetch_exchangerate_api(
        self,
        from_currency: str,
        to_currency: str,
        rate_date: date
    ) -> float:
        """
        Récupère un taux depuis exchangerate-api.com (gratuit, pas de clé API).
        
        Note: exchangerate-api.com retourne les taux avec la devise de base.
        Exemple: /latest/USD retourne {base: "USD", rates: {EUR: 0.92, ...}}
        Cela signifie 1 USD = 0.92 EUR
        """
        if not self.session:
            self.session = aiohttp.ClientSession()
        
        # Pour dates historiques
        if rate_date < date.today():
            # exchangerate-api.com ne supporte pas les dates historiques dans le plan gratuit
            logger.warning(
                f"Historical rates not supported by exchangerate-api.com free tier. "
                f"Using latest rate for {rate_date}"
            )
        
        # Récupérer les taux pour la devise source
        url = f"{self.EXCHANGERATE_API_URL}/latest/{from_currency}"
        
        try:
            async with self.session.get(url) as response:
                response.raise_for_status()
                data = await response.json()
                
                # Les taux sont dans data['rates'] avec from_currency comme base
                # data['rates'][to_currency] donne le taux to_currency/from_currency
                rates = data.get('rates', {})
                rate = rates.get(to_currency)
                
                if rate:
                    return float(rate)
                
                raise ValueError(
                    f"Rate not found for {to_currency} in response. "
                    f"Available rates: {list(rates.keys())[:10]}"
                )
                
        except Exception as e:
            logger.error(f"Error fetching from exchangerate-api.com: {e}")
            raise
    
    async def _fetch_fixer_api(
        self,
        from_currency: str,
        to_currency: str,
        rate_date: date
    ) -> float:
        """Récupère un taux depuis fixer.io (nécessite clé API)."""
        if not self.api_keys.get("fixer"):
            raise RuntimeError("Fixer API key not configured")
        
        if not self.session:
            self.session = aiohttp.ClientSession()
        
        # Fixer.io utilise EUR comme base currency
        # Format date: YYYY-MM-DD
        date_str = rate_date.strftime('%Y-%m-%d')
        
        url = f"{self.FIXER_API_URL}/{date_str}"
        params = {
            'access_key': self.api_keys["fixer"],
            'base': 'EUR',
            'symbols': f"{from_currency},{to_currency}"
        }
        
        try:
            async with self.session.get(url, params=params) as response:
                response.raise_for_status()
                data = await response.json()
                
                if not data.get('success', False):
                    error_msg = data.get('error', {}).get('info', 'Unknown error')
                    raise RuntimeError(f"Fixer API error: {error_msg}")
                
                rates = data.get('rates', {})
                from_rate = rates.get(from_currency)
                to_rate = rates.get(to_currency)
                
                if not from_rate or not to_rate:
                    raise ValueError(f"Rates not found: from={from_currency}, to={to_currency}")
                
                # Convertir via EUR
                # 1 from_currency = (1/EUR_from_rate) EUR = (1/EUR_from_rate) * EUR_to_rate to_currency
                return (1.0 / float(from_rate)) * float(to_rate)
                
        except Exception as e:
            logger.error(f"Error fetching from fixer.io: {e}")
            raise
    
    async def _store_rate_in_cache(
        self,
        from_currency: str,
        to_currency: str,
        rate: float,
        rate_date: date,
        source: str
    ) -> bool:
        """
        Stocke un taux dans le cache Supabase.
        
        Args:
            from_currency: Devise source
            to_currency: Devise cible
            rate: Taux de change
            rate_date: Date du taux
            source: Source du taux
        
        Returns:
            True si nouveau record, False si mis à jour
        """
        if not SUPABASE_AVAILABLE or not self.settings.supabase_url:
            logger.warning("Supabase not configured, cannot cache FX rates")
            return False
        
        try:
            if not self.supabase_client:
                self.supabase_client = create_client(
                    self.settings.supabase_url,
                    self.settings.supabase_key
                )
            
            record = {
                'from_currency': from_currency,
                'to_currency': to_currency,
                'rate': float(rate),
                'rate_date': rate_date.isoformat(),
                'source': source,
                'collected_at': datetime.now().isoformat(),
                'metadata': {
                    'base_currency': self.base_currency,
                    'collected_at': datetime.now().isoformat()
                }
            }
            
            # Vérifier si existe déjà
            loop = asyncio.get_event_loop()
            existing = await loop.run_in_executor(
                None,
                lambda: self.supabase_client.table('fx_rates')
                    .select('id')
                    .eq('from_currency', from_currency)
                    .eq('to_currency', to_currency)
                    .eq('rate_date', rate_date.isoformat())
                    .single()
                    .execute()
            )
            
            # Upsert
            response = await loop.run_in_executor(
                None,
                lambda: self.supabase_client.table('fx_rates')
                    .upsert(record)
                    .execute()
            )
            
            is_new = not existing.data
            logger.debug(
                f"{'Stored' if is_new else 'Updated'} FX rate: "
                f"{from_currency} → {to_currency} = {rate} on {rate_date}"
            )
            
            return is_new
            
        except Exception as e:
            logger.error(f"Error storing FX rate in cache: {e}")
            return False
    
    async def close(self):
        """Ferme la session HTTP."""
        if self.session:
            await self.session.close()
            self.session = None
    
    async def __aenter__(self):
        """Context manager entry."""
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit."""
        await self.close()
