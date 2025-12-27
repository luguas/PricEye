"""
Collecteur de tendances marché (Google Trends, agrégations internes).
"""

import asyncio
import logging
from typing import Dict, List, Optional, Any
from datetime import date, datetime, timedelta

import aiohttp

from .base_collector import BaseCollector
from ..config.settings import Settings

logger = logging.getLogger(__name__)

# Import conditionnel de Supabase
try:
    from supabase import create_client, Client
    SUPABASE_AVAILABLE = True
except ImportError:
    SUPABASE_AVAILABLE = False
    logger.warning("Supabase client not available, internal aggregation will not work")

# Import conditionnel de pandas pour Google Trends
try:
    import pandas as pd
    PANDAS_AVAILABLE = True
except ImportError:
    PANDAS_AVAILABLE = False
    logger.warning("pandas not available, some features may not work")


class TrendsCollector(BaseCollector):
    """
    Collecteur de données de tendances marché.
    
    Supporte Google Trends (via pytrends) et agrégations internes depuis Supabase.
    """
    
    # Mots-clés pertinents pour la recherche de tendances
    DEFAULT_KEYWORDS = [
        "airbnb {city}",
        "hotel {city}",
        "vacation rental {city}",
        "short term rental {city}",
        "{city} tourism",
        "{city} travel"
    ]
    
    def __init__(
        self,
        primary_source: str = "google_trends",
        fallback_source: Optional[str] = "internal_aggregation",
        api_key: Optional[str] = None,
        keywords: Optional[List[str]] = None,
        **kwargs
    ):
        """
        Initialise le collecteur de tendances.
        
        Args:
            primary_source: Source primaire ('google_trends' ou 'internal_aggregation')
            fallback_source: Source de fallback (None pour désactiver)
            api_key: Clé API (non utilisé pour Google Trends)
            keywords: Liste de mots-clés personnalisés (None = utiliser DEFAULT_KEYWORDS)
            **kwargs: Arguments additionnels pour BaseCollector
        """
        self.primary_source = primary_source.lower()
        self.fallback_source = fallback_source.lower() if fallback_source else None
        self.keywords = keywords or self.DEFAULT_KEYWORDS
        
        super().__init__(
            source_name=f"trends_{self.primary_source}",
            api_key=api_key,
            **kwargs
        )
        
        logger.info(
            f"Initialized TrendsCollector (primary: {self.primary_source}, "
            f"fallback: {self.fallback_source})"
        )
    
    async def collect(
        self,
        city: str,
        country: str,
        date_range: Optional[Dict[str, date]] = None,
        store_in_db: bool = True
    ) -> List[Dict[str, Any]]:
        """
        Collecte les tendances pour une ville donnée.
        
        Args:
            city: Nom de la ville
            country: Code pays (ISO 3166-1 alpha-2)
            date_range: Dict avec 'start_date' et 'end_date'
            store_in_db: Si True, stocke dans Supabase
            
        Returns:
            Liste de tendances normalisées
        """
        # Date range par défaut : aujourd'hui - 90 jours
        if not date_range:
            today = date.today()
            date_range = {
                'start_date': today - timedelta(days=90),
                'end_date': today
            }
        
        # Initialiser la session si nécessaire
        if not self.session:
            self.session = aiohttp.ClientSession()
        
        try:
            # Rate limiting
            if self.rate_limiter:
                await self.rate_limiter.acquire()
            
            # Collecte des données
            raw_data = await self._fetch_data(city, country, date_range)
            
            # Normalisation
            normalized_data = self._normalize(raw_data, city, country, date_range)
            
            # Stockage
            if store_in_db and normalized_data:
                await self._store_raw_data(normalized_data)
            
            logger.info(
                f"Collected {len(normalized_data)} trends data points for {city}, {country}"
            )
            
            return normalized_data
            
        except Exception as e:
            logger.error(f"Error collecting trends for {city}, {country}: {e}", exc_info=True)
            raise
    
    async def _fetch_data(
        self,
        city: str,
        country: str,
        date_range: Dict[str, date]
    ) -> Dict[str, Any]:
        """
        Récupère les tendances depuis l'API ou agrégations internes.
        
        Args:
            city: Nom de la ville
            country: Code pays
            date_range: Plage de dates
            
        Returns:
            Données brutes de tendances
        """
        # Essayer la source primaire
        try:
            if self.primary_source == "google_trends":
                return await self._fetch_google_trends(city, country, date_range)
            elif self.primary_source == "internal_aggregation":
                return await self._fetch_internal_aggregation(city, country, date_range)
        except Exception as e:
            logger.warning(f"Primary source {self.primary_source} failed: {e}")
            
            # Essayer le fallback
            if self.fallback_source:
                try:
                    if self.fallback_source == "google_trends":
                        return await self._fetch_google_trends(city, country, date_range)
                    elif self.fallback_source == "internal_aggregation":
                        return await self._fetch_internal_aggregation(city, country, date_range)
                except Exception as fallback_error:
                    logger.error(f"Fallback source {self.fallback_source} also failed: {fallback_error}")
        
        # Si toutes les sources échouent, retourner des données vides
        logger.warning("All trends sources failed, returning empty data")
        return {
            'source': 'none',
            'data': []
        }
    
    async def _fetch_google_trends(
        self,
        city: str,
        country: str,
        date_range: Dict[str, date]
    ) -> Dict[str, Any]:
        """
        Récupère les tendances depuis Google Trends via pytrends.
        """
        try:
            from pytrends.request import TrendReq
        except ImportError:
            logger.warning("pytrends not installed, falling back to internal aggregation")
            raise ImportError("pytrends package required for Google Trends")
        
        try:
            # Initialiser pytrends
            pytrends = TrendReq(hl='fr', tz=360)  # Français, UTC+1
            
            # Préparer les mots-clés avec la ville
            keywords_list = [kw.format(city=city) for kw in self.keywords[:5]]  # Limiter à 5 mots-clés
            
            # Construire la requête
            pytrends.build_payload(
                kw_list=keywords_list,
                geo=f"{country}-{city}",  # Format: FR-Paris (peut nécessiter ajustement)
                timeframe=f"{date_range['start_date'].strftime('%Y-%m-%d')} {date_range['end_date'].strftime('%Y-%m-%d')}"
            )
            
            # Récupérer les données d'intérêt au fil du temps
            interest_over_time = pytrends.interest_over_time()
            
            if interest_over_time.empty:
                logger.warning(f"No Google Trends data for {city}, {country}")
                return {
                    'source': 'google_trends',
                    'data': [],
                    'keywords': keywords_list
                }
            
            # Convertir en format standardisé
            trends_data = []
            for date_idx, row in interest_over_time.iterrows():
                # Calculer la moyenne des volumes de recherche pour tous les mots-clés
                row_values = row.drop('isPartial') if 'isPartial' in row else row
                avg_volume = row_values.mean()
                
                # Vérifier si la valeur est NaN
                if PANDAS_AVAILABLE:
                    is_na = pd.isna(avg_volume)
                else:
                    is_na = avg_volume is None or (isinstance(avg_volume, float) and avg_volume != avg_volume)
                
                trends_data.append({
                    'date': date_idx.date() if hasattr(date_idx, 'date') else date_idx,
                    'search_volume_index': int(avg_volume) if not is_na else None,
                    'keywords': keywords_list,
                    'details': row.to_dict() if hasattr(row, 'to_dict') else dict(row)
                })
            
            return {
                'source': 'google_trends',
                'data': trends_data,
                'keywords': keywords_list
            }
        
        except Exception as e:
            logger.error(f"Error fetching Google Trends: {e}", exc_info=True)
            raise
    
    async def _fetch_internal_aggregation(
        self,
        city: str,
        country: str,
        date_range: Dict[str, date]
    ) -> Dict[str, Any]:
        """
        Agrège les données internes depuis Supabase pour estimer les tendances.
        
        Utilise:
        - Volume de réservations (bookings)
        - Nombre de listings actifs (properties)
        - Données de pricing (calendar/price_overrides)
        """
        if not SUPABASE_AVAILABLE or not self.settings.supabase_url:
            raise RuntimeError("Supabase not configured for internal aggregation")
        
        if not hasattr(self, '_supabase_client') or self._supabase_client is None:
            self._supabase_client = create_client(
                self.settings.supabase_url,
                self.settings.supabase_key
            )
        
        try:
            loop = asyncio.get_event_loop()
            
            # Récupérer les propriétés pour cette ville
            properties_query = self._supabase_client.table('properties')\
                .select('id')\
                .eq('city', city)\
                .eq('country', country)
            
            properties_response = await loop.run_in_executor(
                None,
                lambda: properties_query.execute()
            )
            
            property_ids = [p['id'] for p in (properties_response.data or [])]
            
            if not property_ids:
                logger.warning(f"No properties found for {city}, {country}")
                return {
                    'source': 'internal_aggregation',
                    'data': []
                }
            
            # Parcourir les dates dans la plage
            trends_data = []
            current_date = date_range['start_date']
            
            while current_date <= date_range['end_date']:
                try:
                    # Récupérer les réservations pour ce jour
                    bookings_query = self._supabase_client.table('bookings')\
                        .select('id')\
                        .in_('property_id', property_ids)\
                        .lte('start_date', current_date.isoformat())\
                        .gte('end_date', current_date.isoformat())
                    
                    bookings_response = await loop.run_in_executor(
                        None,
                        lambda: bookings_query.execute()
                    )
                    
                    booking_count = len(bookings_response.data or [])
                    
                    # Estimer le volume de recherche basé sur les réservations
                    # (corrélation approximative : plus de réservations = plus de recherche)
                    # Normaliser sur une échelle 0-100
                    # On utilise une estimation basée sur le nombre de propriétés et réservations
                    total_properties = len(property_ids)
                    booking_rate = booking_count / max(total_properties, 1)
                    
                    # Estimation du volume de recherche (0-100)
                    # Basé sur le taux de réservation et le nombre de propriétés
                    search_volume_estimate = min(100, int(booking_rate * 50 + (total_properties / 10)))
                    
                    # Récupérer le nombre de listings actifs (propriétés non supprimées)
                    active_listings_count = total_properties
                    
                    # Estimation du volume de réservations (basé sur les réservations du jour)
                    booking_volume_estimate = booking_count
                    
                    trends_data.append({
                        'date': current_date,
                        'search_volume_index': search_volume_estimate,
                        'booking_volume_estimate': booking_volume_estimate,
                        'active_listings_count': active_listings_count,
                        'new_listings_count': None,  # Nécessiterait historique
                        'average_lead_time_days': None,  # Nécessiterait calcul depuis bookings
                        'cancellation_rate': None  # Nécessiterait calcul depuis bookings
                    })
                
                except Exception as e:
                    logger.warning(f"Error aggregating data for {current_date}: {e}")
                
                current_date += timedelta(days=1)
            
            return {
                'source': 'internal_aggregation',
                'data': trends_data
            }
        
        except Exception as e:
            logger.error(f"Error in internal aggregation: {e}", exc_info=True)
            raise
    
    def _normalize(
        self,
        raw_response: Dict[str, Any],
        city: str,
        country: str,
        date_range: Dict[str, date]
    ) -> List[Dict[str, Any]]:
        """
        Normalise les données brutes vers le format raw_market_trends_data.
        
        Args:
            raw_response: Réponse brute de l'API ou agrégations
            city: Nom de la ville
            country: Code pays
            date_range: Plage de dates
            
        Returns:
            Liste de dicts normalisés
        """
        source = raw_response.get('source', self.primary_source)
        data_items = raw_response.get('data', [])
        
        if not data_items:
            logger.warning(f"No trends data found in response from {source}")
            return []
        
        normalized = []
        
        for item in data_items:
            try:
                # Date
                trend_date = item.get('date')
                if isinstance(trend_date, str):
                    trend_date = datetime.fromisoformat(trend_date).date()
                elif hasattr(trend_date, 'date'):
                    trend_date = trend_date.date()
                elif isinstance(trend_date, date):
                    pass
                else:
                    continue
                
                # Créer le record normalisé
                record = {
                    'source': source,
                    'country': country,
                    'city': city,
                    'trend_date': trend_date.isoformat(),
                    'search_volume_index': item.get('search_volume_index'),
                    'booking_volume_estimate': item.get('booking_volume_estimate'),
                    'active_listings_count': item.get('active_listings_count'),
                    'new_listings_count': item.get('new_listings_count'),
                    'average_lead_time_days': item.get('average_lead_time_days'),
                    'cancellation_rate': item.get('cancellation_rate'),
                    'keywords': raw_response.get('keywords', []),
                    'timezone': 'UTC',  # Sera mis à jour par timezone_handler si nécessaire
                    'metadata': {
                        'data_points': len(data_items),
                        'calculation_method': source
                    },
                    'raw_data': item,
                    'collected_at': datetime.now().isoformat()
                }
                
                normalized.append(record)
            
            except Exception as e:
                logger.error(f"Error normalizing trends item: {e}", exc_info=True)
                continue
        
        logger.info(f"Normalized {len(normalized)} trends data points from {source}")
        return normalized


# Import conditionnel de Supabase
try:
    from supabase import create_client, Client
    SUPABASE_AVAILABLE = True
except ImportError:
    SUPABASE_AVAILABLE = False
    logger.warning("Supabase client not available, internal aggregation will not work")

# Import conditionnel de pandas pour Google Trends
try:
    import pandas as pd
    PANDAS_AVAILABLE = True
except ImportError:
    PANDAS_AVAILABLE = False
    logger.warning("pandas not available, some features may not work")
