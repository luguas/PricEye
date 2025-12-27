"""
Gestionnaire de fuseaux horaires.

Mappe country + city → timezone IANA et gère les conversions UTC ↔ local.
"""

import asyncio
import logging
from typing import Optional, Dict
from datetime import datetime, date
from zoneinfo import ZoneInfo

try:
    import pytz
    PYTZ_AVAILABLE = True
except ImportError:
    PYTZ_AVAILABLE = False
    logging.warning("pytz not available, using zoneinfo only")

try:
    from supabase import create_client, Client
    SUPABASE_AVAILABLE = True
except ImportError:
    SUPABASE_AVAILABLE = False
    logging.warning("Supabase client not available. Install with: pip install supabase")

from ..config.cities_config import get_city_config
from ..config.settings import Settings

logger = logging.getLogger(__name__)


class TimezoneHandler:
    """
    Gestionnaire de fuseaux horaires.
    
    Mappe country + city → timezone IANA via :
    1. Table Supabase timezones (si disponible)
    2. cities_config.py (mapping local)
    3. Mappings par défaut par pays
    4. Fallback sur UTC
    
    Gère les conversions UTC ↔ local pour les dates et datetimes.
    """
    
    # Mappings par défaut par pays (fallback)
    DEFAULT_COUNTRY_TIMEZONES: Dict[str, str] = {
        'FR': 'Europe/Paris',
        'ES': 'Europe/Madrid',
        'IT': 'Europe/Rome',
        'DE': 'Europe/Berlin',
        'GB': 'Europe/London',
        'PT': 'Europe/Lisbon',
        'NL': 'Europe/Amsterdam',
        'BE': 'Europe/Brussels',
        'CH': 'Europe/Zurich',
        'AT': 'Europe/Vienna',
        'US': 'America/New_York',  # Par défaut, peut varier par ville
        'CA': 'America/Toronto',
        'MX': 'America/Mexico_City',
        'BR': 'America/Sao_Paulo',
        'AR': 'America/Buenos_Aires',
        'JP': 'Asia/Tokyo',
        'CN': 'Asia/Shanghai',
        'IN': 'Asia/Kolkata',
        'AU': 'Australia/Sydney',
        'NZ': 'Pacific/Auckland',
        'ZA': 'Africa/Johannesburg',
        'AE': 'Asia/Dubai',
        'IL': 'Asia/Jerusalem',
        'TR': 'Europe/Istanbul',
        'TH': 'Asia/Bangkok',
        'SG': 'Asia/Singapore',
        'MY': 'Asia/Kuala_Lumpur',
        'ID': 'Asia/Jakarta',
        'PH': 'Asia/Manila',
        'VN': 'Asia/Ho_Chi_Minh',
        'KR': 'Asia/Seoul',
        'TW': 'Asia/Taipei',
        'HK': 'Asia/Hong_Kong',
    }
    
    def __init__(self, settings: Optional[Settings] = None):
        """
        Initialise le gestionnaire de fuseaux horaires.
        
        Args:
            settings: Configuration (si None, charge depuis env)
        """
        self.settings = settings or Settings.from_env()
        self.supabase_client: Optional[Client] = None
        self._timezone_cache: Dict[str, str] = {}  # Cache local
        
        logger.info("Initialized TimezoneHandler")
    
    def get_timezone(self, country: str, city: Optional[str] = None) -> str:
        """
        Récupère le timezone IANA pour un pays/ville.
        
        Recherche dans l'ordre :
        1. Cache local
        2. Table Supabase timezones
        3. cities_config.py
        4. Mappings par défaut par pays
        5. UTC (fallback)
        
        Args:
            country: Code pays (ISO 3166-1 alpha-2, ex: 'FR')
            city: Nom de la ville (optionnel)
        
        Returns:
            Timezone IANA (ex: 'Europe/Paris')
        """
        country = country.upper()
        cache_key = f"{country}:{city or ''}"
        
        # Vérifier le cache local
        if cache_key in self._timezone_cache:
            return self._timezone_cache[cache_key]
        
        logger.debug(f"Getting timezone for {city or 'N/A'}, {country}")
        
        timezone = None
        
        # 1. Essayer depuis cities_config.py (synchrone, rapide)
        if city:
            city_config = get_city_config(city, country)
            if city_config and city_config.timezone:
                timezone = city_config.timezone
                logger.debug(f"Found timezone from cities_config: {timezone}")
        
        # 2. Essayer depuis Supabase (synchrone via client)
        if not timezone and city:
            timezone = self._get_timezone_from_supabase_sync(country, city)
        
        # 3. Utiliser le mapping par défaut par pays
        if not timezone:
            timezone = self.DEFAULT_COUNTRY_TIMEZONES.get(country)
            if timezone:
                logger.debug(f"Using default timezone for country {country}: {timezone}")
        
        # 4. Fallback sur UTC
        if not timezone:
            timezone = 'UTC'
            logger.warning(
                f"No timezone found for {city or 'N/A'}, {country}, using UTC"
            )
        
        # Mettre en cache
        self._timezone_cache[cache_key] = timezone
        
        return timezone
    
    def _get_timezone_from_supabase_sync(
        self,
        country: str,
        city: str
    ) -> Optional[str]:
        """
        Récupère le timezone depuis Supabase (synchrone).
        
        Note: Le client Supabase Python est synchrone, donc cette méthode
        est synchrone pour éviter les problèmes avec asyncio.run().
        """
        if not SUPABASE_AVAILABLE or not self.settings.supabase_url:
            return None
        
        try:
            if not self.supabase_client:
                self.supabase_client = create_client(
                    self.settings.supabase_url,
                    self.settings.supabase_key
                )
            
            response = self.supabase_client.table('timezones')\
                .select('timezone')\
                .eq('country', country.upper())\
                .eq('city', city)\
                .maybe_single()\
                .execute()
            
            if response.data:
                timezone = response.data.get('timezone')
                logger.debug(f"Found timezone in Supabase: {timezone}")
                return timezone
            
        except Exception as e:
            logger.debug(f"Could not get timezone from Supabase: {e}")
        
        return None
    
    def to_utc(
        self,
        local_datetime: datetime,
        timezone: Optional[str] = None,
        country: Optional[str] = None,
        city: Optional[str] = None
    ) -> datetime:
        """
        Convertit une datetime locale vers UTC.
        
        Args:
            local_datetime: Datetime locale (naive ou avec tzinfo)
            timezone: Timezone IANA source (si None, cherche depuis country/city)
            country: Code pays (si timezone non fourni)
            city: Nom de la ville (si timezone non fourni)
        
        Returns:
            Datetime en UTC (timezone-aware)
        """
        # Déterminer le timezone
        if not timezone:
            if country:
                timezone = self.get_timezone(country, city)
            else:
                timezone = 'UTC'
        
        # Si la datetime est déjà timezone-aware, utiliser directement
        if local_datetime.tzinfo is not None:
            return local_datetime.astimezone(ZoneInfo('UTC'))
        
        # Convertir la datetime naive vers le timezone local, puis vers UTC
        try:
            # Essayer zoneinfo (Python 3.9+)
            tz = ZoneInfo(timezone)
            local_dt = local_datetime.replace(tzinfo=tz)
            return local_dt.astimezone(ZoneInfo('UTC'))
        except Exception:
            # Fallback sur pytz si zoneinfo échoue
            if PYTZ_AVAILABLE:
                try:
                    tz = pytz.timezone(timezone)
                    local_dt = tz.localize(local_datetime)
                    return local_dt.astimezone(pytz.UTC)
                except Exception as e:
                    logger.error(f"Error converting to UTC with pytz: {e}")
                    raise
            
            logger.error(f"Could not convert timezone: {timezone}")
            raise ValueError(f"Invalid timezone: {timezone}")
    
    def to_local(
        self,
        utc_datetime: datetime,
        timezone: Optional[str] = None,
        country: Optional[str] = None,
        city: Optional[str] = None
    ) -> datetime:
        """
        Convertit une datetime UTC vers locale.
        
        Args:
            utc_datetime: Datetime UTC (naive ou avec tzinfo)
            timezone: Timezone IANA cible (si None, cherche depuis country/city)
            country: Code pays (si timezone non fourni)
            city: Nom de la ville (si timezone non fourni)
        
        Returns:
            Datetime locale (timezone-aware)
        """
        # Déterminer le timezone
        if not timezone:
            if country:
                timezone = self.get_timezone(country, city)
            else:
                timezone = 'UTC'
        
        # Si la datetime est naive, supposer UTC
        if utc_datetime.tzinfo is None:
            utc_dt = utc_datetime.replace(tzinfo=ZoneInfo('UTC'))
        else:
            utc_dt = utc_datetime
        
        try:
            # Essayer zoneinfo (Python 3.9+)
            target_tz = ZoneInfo(timezone)
            return utc_dt.astimezone(target_tz)
        except Exception:
            # Fallback sur pytz
            if PYTZ_AVAILABLE:
                try:
                    target_tz = pytz.timezone(timezone)
                    return utc_dt.astimezone(target_tz)
                except Exception as e:
                    logger.error(f"Error converting from UTC with pytz: {e}")
                    raise
            
            logger.error(f"Could not convert timezone: {timezone}")
            raise ValueError(f"Invalid timezone: {timezone}")
    
    def normalize_date(
        self,
        date_str: str,
        timezone: Optional[str] = None,
        country: Optional[str] = None,
        city: Optional[str] = None
    ) -> date:
        """
        Normalise une date string vers date UTC.
        
        Parse une date string locale et retourne la date correspondante en UTC.
        Utile pour gérer les dates qui peuvent changer selon le timezone
        (ex: 2024-01-15 23:00 à Paris = 2024-01-16 00:00 UTC).
        
        Args:
            date_str: Date en format string (ex: '2024-01-15', '2024-01-15 23:00:00')
            timezone: Timezone IANA de la date source (si None, cherche depuis country/city)
            country: Code pays (si timezone non fourni)
            city: Nom de la ville (si timezone non fourni)
        
        Returns:
            Date normalisée (UTC)
        """
        # Déterminer le timezone
        if not timezone:
            if country:
                timezone = self.get_timezone(country, city)
            else:
                timezone = 'UTC'
        
        # Parser la date string
        dt = self._parse_date_string(date_str, timezone)
        
        # Convertir en UTC
        if dt.tzinfo is None:
            # Si naive, supposer qu'elle est dans le timezone local
            dt = self.to_utc(dt, timezone)
        else:
            # Déjà timezone-aware, convertir vers UTC
            dt = dt.astimezone(ZoneInfo('UTC'))
        
        # Retourner la date (pas la datetime)
        return dt.date()
    
    def _parse_date_string(self, date_str: str, timezone: str) -> datetime:
        """
        Parse une date string et retourne une datetime.
        
        Supporte plusieurs formats :
        - '2024-01-15'
        - '2024-01-15 10:00:00'
        - '2024/01/15'
        - '15-01-2024'
        etc.
        """
        date_str = str(date_str).strip()
        
        # Formats à essayer
        formats = [
            '%Y-%m-%d',
            '%Y-%m-%d %H:%M:%S',
            '%Y-%m-%d %H:%M',
            '%Y/%m/%d',
            '%Y/%m/%d %H:%M:%S',
            '%d-%m-%Y',
            '%d/%m/%Y',
            '%m-%d-%Y',
            '%m/%d/%Y',
            '%Y-%m-%dT%H:%M:%S',
            '%Y-%m-%dT%H:%M:%S%z',  # Avec timezone offset
            '%Y-%m-%dT%H:%M:%SZ',   # UTC
        ]
        
        for fmt in formats:
            try:
                dt = datetime.strptime(date_str, fmt)
                
                # Si le format incluait un timezone, retourner tel quel
                if dt.tzinfo is not None:
                    return dt
                
                # Sinon, la datetime est naive, on la retourne telle quelle
                # (le caller devra gérer le timezone)
                return dt
                
            except ValueError:
                continue
        
        # Si aucun format ne fonctionne, essayer de parser juste la date
        try:
            # Extraire juste la partie date (avant le premier espace ou T)
            date_part = date_str.split(' ')[0].split('T')[0]
            dt = datetime.strptime(date_part, '%Y-%m-%d')
            return dt
        except ValueError:
            raise ValueError(f"Could not parse date string: {date_str}")
    
    def normalize_datetime_to_utc(
        self,
        datetime_str: str,
        timezone: Optional[str] = None,
        country: Optional[str] = None,
        city: Optional[str] = None
    ) -> datetime:
        """
        Normalise une datetime string vers datetime UTC.
        
        Utile pour normaliser les timestamps collectés depuis différentes sources.
        
        Args:
            datetime_str: Datetime en format string
            timezone: Timezone IANA de la datetime source
            country: Code pays
            city: Nom de la ville
        
        Returns:
            Datetime en UTC (timezone-aware)
        """
        # Déterminer le timezone
        if not timezone:
            if country:
                timezone = self.get_timezone(country, city)
            else:
                timezone = 'UTC'
        
        # Parser et convertir
        dt = self._parse_date_string(datetime_str, timezone)
        return self.to_utc(dt, timezone)
    
    def get_local_date_from_utc(
        self,
        utc_date: date,
        timezone: Optional[str] = None,
        country: Optional[str] = None,
        city: Optional[str] = None
    ) -> date:
        """
        Convertit une date UTC vers date locale.
        
        Utile pour afficher les dates dans le timezone local de l'utilisateur.
        
        Args:
            utc_date: Date en UTC
            timezone: Timezone IANA cible
            country: Code pays
            city: Nom de la ville
        
        Returns:
            Date locale
        """
        # Déterminer le timezone
        if not timezone:
            if country:
                timezone = self.get_timezone(country, city)
            else:
                timezone = 'UTC'
        
        # Convertir date → datetime (minuit UTC), puis vers local
        utc_dt = datetime.combine(utc_date, datetime.min.time())
        utc_dt = utc_dt.replace(tzinfo=ZoneInfo('UTC'))
        
        local_dt = self.to_local(utc_dt, timezone)
        return local_dt.date()
    
    async def store_timezone_mapping(
        self,
        country: str,
        city: str,
        timezone: str,
        latitude: Optional[float] = None,
        longitude: Optional[float] = None,
        region: Optional[str] = None
    ) -> bool:
        """
        Stocke un mapping timezone dans Supabase.
        
        Args:
            country: Code pays
            city: Nom de la ville
            timezone: Timezone IANA
            latitude: Latitude (optionnel)
            longitude: Longitude (optionnel)
            region: Région/état (optionnel)
        
        Returns:
            True si stocké avec succès
        """
        if not SUPABASE_AVAILABLE or not self.settings.supabase_url:
            logger.warning("Supabase not configured, cannot store timezone mapping")
            return False
        
        try:
            if not self.supabase_client:
                self.supabase_client = create_client(
                    self.settings.supabase_url,
                    self.settings.supabase_key
                )
            
            record = {
                'country': country.upper(),
                'city': city,
                'timezone': timezone,
                'latitude': float(latitude) if latitude else None,
                'longitude': float(longitude) if longitude else None,
                'region': region,
                'updated_at': datetime.now().isoformat()
            }
            
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(
                None,
                lambda: self.supabase_client.table('timezones')
                    .upsert(record)
                    .execute()
            )
            
            # Mettre à jour le cache local
            cache_key = f"{country.upper()}:{city}"
            self._timezone_cache[cache_key] = timezone
            
            logger.info(f"Stored timezone mapping: {city}, {country} → {timezone}")
            return True
            
        except Exception as e:
            logger.error(f"Error storing timezone mapping: {e}")
            return False
    
    def is_valid_timezone(self, timezone: str) -> bool:
        """
        Vérifie si un timezone IANA est valide.
        
        Args:
            timezone: Timezone IANA à vérifier
        
        Returns:
            True si valide, False sinon
        """
        try:
            ZoneInfo(timezone)
            return True
        except Exception:
            if PYTZ_AVAILABLE:
                try:
                    pytz.timezone(timezone)
                    return True
                except Exception:
                    pass
            return False
