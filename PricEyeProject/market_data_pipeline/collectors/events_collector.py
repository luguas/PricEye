"""
Collecteur d'événements locaux (Google Events API, Eventbrite avec fallback).
"""

import asyncio
import logging
from typing import Dict, List, Optional, Any
from datetime import date, datetime, timedelta
import random
import aiohttp

from .base_collector import BaseCollector
from ..config.api_keys import get_api_key, API_SERVICES
from ..config.cities_config import get_city_config

logger = logging.getLogger(__name__)


class EventsCollector(BaseCollector):
    """
    Collecteur d'événements locaux avec support Google Events API et Eventbrite.
    
    Collecte les événements par ville/date et normalise les données.
    Supporte le fallback automatique et un mode mock si aucune API n'est disponible.
    """
    
    # URLs des APIs
    GOOGLE_EVENTS_BASE_URL = "https://www.googleapis.com/calendar/v3"
    EVENTBRITE_BASE_URL = "https://www.eventbriteapi.com/v3"
    
    def __init__(
        self,
        primary_source: str = "google",
        fallback_source: Optional[str] = "eventbrite",
        api_key: Optional[str] = None,
        use_mock: bool = False,
        **kwargs
    ):
        """
        Initialise le collecteur d'événements.
        
        Args:
            primary_source: Source primaire ('google' ou 'eventbrite')
            fallback_source: Source de fallback (None pour désactiver)
            api_key: Clé API (si None, récupère depuis env)
            use_mock: Si True, utilise des données mock (pour tests/dev)
            **kwargs: Arguments additionnels pour BaseCollector
        """
        self.primary_source = primary_source.lower()
        self.fallback_source = fallback_source.lower() if fallback_source else None
        self.use_mock = use_mock
        
        # Récupérer les clés API
        self.api_keys = {}
        if self.primary_source == "google":
            self.api_keys["google"] = api_key or get_api_key("GOOGLE_EVENTS_API_KEY")
        elif self.primary_source == "eventbrite":
            self.api_keys["eventbrite"] = api_key or get_api_key("EVENTBRITE_API_KEY")
        
        if self.fallback_source:
            if self.fallback_source == "google":
                self.api_keys["google"] = self.api_keys.get("google") or get_api_key("GOOGLE_EVENTS_API_KEY")
            elif self.fallback_source == "eventbrite":
                self.api_keys["eventbrite"] = self.api_keys.get("eventbrite") or get_api_key("EVENTBRITE_API_KEY")
        
        # Utiliser la clé de la source primaire pour BaseCollector
        primary_api_key = self.api_keys.get(self.primary_source) if not use_mock else None
        
        super().__init__(
            source_name=f"events_{self.primary_source}" if not use_mock else "events_mock",
            api_key=primary_api_key,
            **kwargs
        )
        
        logger.info(
            f"Initialized EventsCollector (primary: {self.primary_source}, "
            f"fallback: {self.fallback_source}, mock: {use_mock})"
        )
    
    async def collect(
        self,
        city: str,
        country: str,
        date_range: Optional[Dict[str, date]] = None,
        store_in_db: bool = True
    ) -> List[Dict[str, Any]]:
        """
        Collecte les événements pour une ville donnée.
        
        Args:
            city: Nom de la ville
            country: Code pays (ISO 3166-1 alpha-2)
            date_range: Dict avec 'start_date' et 'end_date'
            store_in_db: Si True, stocke dans Supabase
            
        Returns:
            Liste d'événements normalisés
        """
        # Date range par défaut : aujourd'hui + 90 jours
        if not date_range:
            today = date.today()
            date_range = {
                'start_date': today,
                'end_date': today + timedelta(days=90)
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
            normalized_data = self._normalize(raw_data, city, country)
            
            # Stockage
            if store_in_db and normalized_data:
                await self._store_raw_data(normalized_data)
            
            logger.info(
                f"Collected {len(normalized_data)} events for {city}, {country}"
            )
            
            return normalized_data
            
        except Exception as e:
            logger.error(f"Error collecting events for {city}, {country}: {e}", exc_info=True)
            raise
    
    async def _fetch_data(
        self,
        city: str,
        country: str,
        date_range: Dict[str, date]
    ) -> Dict[str, Any]:
        """
        Récupère les données brutes depuis l'API.
        
        Args:
            city: Nom de la ville
            country: Code pays
            date_range: Plage de dates
            
        Returns:
            Dict avec les données brutes
        """
        # Mode mock
        if self.use_mock:
            return await self._fetch_mock_data(city, country, date_range)
        
        # Essayer la source primaire
        try:
            if self.primary_source == "google":
                return await self._fetch_google_events(city, country, date_range)
            elif self.primary_source == "eventbrite":
                return await self._fetch_eventbrite_events(city, country, date_range)
        except Exception as e:
            logger.warning(f"Primary source {self.primary_source} failed: {e}")
            
            # Essayer le fallback
            if self.fallback_source:
                try:
                    if self.fallback_source == "google":
                        return await self._fetch_google_events(city, country, date_range)
                    elif self.fallback_source == "eventbrite":
                        return await self._fetch_eventbrite_events(city, country, date_range)
                except Exception as fallback_error:
                    logger.error(f"Fallback source {self.fallback_source} also failed: {fallback_error}")
        
        # Si toutes les sources échouent, utiliser mock
        logger.warning("All API sources failed, falling back to mock data")
        return await self._fetch_mock_data(city, country, date_range)
    
    async def _fetch_google_events(
        self,
        city: str,
        country: str,
        date_range: Dict[str, date]
    ) -> Dict[str, Any]:
        """
        Récupère les événements depuis Google Events API.
        
        Note: Google Events API nécessite une clé API et utilise Google Calendar API
        pour rechercher des événements publics.
        """
        api_key = self.api_keys.get("google")
        if not api_key:
            raise ValueError("Google Events API key not configured")
        
        # Récupérer les coordonnées de la ville
        city_config = get_city_config(city, country)
        if not city_config:
            raise ValueError(f"City config not found for {city}, {country}")
        
        # Construire la requête
        # Note: Google Calendar API nécessite un calendarId spécifique
        # Pour les événements publics, on peut utiliser des calendriers publics
        # ou utiliser Google Places API pour trouver des événements
        
        # Pour l'instant, on simule une réponse Google
        # TODO: Implémenter la vraie intégration Google Events API
        logger.warning("Google Events API integration not fully implemented, using mock")
        return await self._fetch_mock_data(city, country, date_range)
    
    async def _fetch_eventbrite_events(
        self,
        city: str,
        country: str,
        date_range: Dict[str, date]
    ) -> Dict[str, Any]:
        """
        Récupère les événements depuis Eventbrite API.
        """
        api_key = self.api_keys.get("eventbrite")
        if not api_key:
            raise ValueError("Eventbrite API key not configured")
        
        try:
            # Construire l'URL de recherche
            start_date = date_range['start_date'].isoformat()
            end_date = date_range['end_date'].isoformat()
            
            # Eventbrite API: /events/search/
            url = f"{self.EVENTBRITE_BASE_URL}/events/search/"
            
            params = {
                'token': api_key,
                'location.address': city,
                'location.within': '50km',  # Rayon de recherche
                'start_date.range_start': f"{start_date}T00:00:00",
                'start_date.range_end': f"{end_date}T23:59:59",
                'expand': 'venue',
                'page_size': 100
            }
            
            # Faire la requête
            async with self.session.get(url, params=params) as response:
                if response.status == 200:
                    data = await response.json()
                    return {
                        'source': 'eventbrite',
                        'items': data.get('events', []),
                        'pagination': data.get('pagination', {})
                    }
                elif response.status == 401:
                    error_text = await response.text()
                    logger.error(
                        f"Eventbrite API authentication failed (401). "
                        f"Please check your EVENTBRITE_API_KEY in .env file. "
                        f"Error: {error_text[:200]}"
                    )
                    raise ValueError(
                        f"Eventbrite API authentication failed. "
                        f"Please check your EVENTBRITE_API_KEY configuration."
                    )
                else:
                    error_text = await response.text()
                    raise Exception(f"Eventbrite API error {response.status}: {error_text}")
        
        except Exception as e:
            logger.error(f"Error fetching Eventbrite events: {e}")
            raise
    
    async def _fetch_mock_data(
        self,
        city: str,
        country: str,
        date_range: Dict[str, date]
    ) -> Dict[str, Any]:
        """
        Génère des données mock réalistes pour les tests/dev.
        """
        logger.info(f"Generating mock events for {city}, {country}")
        
        # Types d'événements réalistes
        event_types = [
            'concert', 'festival', 'sport', 'conference', 'exhibition',
            'theater', 'comedy', 'food', 'art', 'music'
        ]
        
        event_names = {
            'concert': ['Concert Rock', 'Jazz Night', 'Electronic Music Festival', 'Classical Concert'],
            'festival': ['Summer Festival', 'Food Festival', 'Wine Festival', 'Cultural Festival'],
            'sport': ['Football Match', 'Marathon', 'Tennis Tournament', 'Basketball Game'],
            'conference': ['Tech Conference', 'Business Summit', 'Innovation Forum'],
            'exhibition': ['Art Exhibition', 'Photo Exhibition', 'Design Show'],
            'theater': ['Theater Play', 'Musical', 'Dance Performance'],
            'comedy': ['Comedy Show', 'Stand-up Comedy', 'Improv Night'],
            'food': ['Food Market', 'Wine Tasting', 'Cooking Class'],
            'art': ['Art Gallery Opening', 'Street Art Tour', 'Sculpture Exhibition'],
            'music': ['Live Music', 'DJ Set', 'Acoustic Session']
        }
        
        venues = [
            'City Center', 'Convention Center', 'Stadium', 'Park',
            'Theater', 'Concert Hall', 'Museum', 'Gallery'
        ]
        
        mock_events = []
        current_date = date_range['start_date']
        
        # Générer 2-5 événements par mois
        while current_date <= date_range['end_date']:
            # Probabilité d'avoir un événement ce jour (plus élevée le week-end)
            weekday = current_date.weekday()
            probability = 0.1 if weekday < 5 else 0.3  # 10% en semaine, 30% le week-end
            
            if random.random() < probability:
                event_type = random.choice(event_types)
                event_name = random.choice(event_names.get(event_type, ['Event']))
                
                # Estimation d'attendance selon le type
                attendance_ranges = {
                    'concert': (500, 10000),
                    'festival': (1000, 50000),
                    'sport': (1000, 50000),
                    'conference': (100, 5000),
                    'exhibition': (50, 2000),
                    'theater': (100, 2000),
                    'comedy': (50, 1000),
                    'food': (200, 5000),
                    'art': (50, 1000),
                    'music': (100, 3000)
                }
                
                min_att, max_att = attendance_ranges.get(event_type, (100, 1000))
                attendance = random.randint(min_att, max_att)
                
                venue = random.choice(venues)
                
                mock_events.append({
                    'name': f"{event_name} - {city}",
                    'type': event_type,
                    'venue': {
                        'name': f"{venue} {city}",
                        'address': f"{venue}, {city}, {country}",
                        'latitude': 48.8566 + random.uniform(-0.1, 0.1),  # Exemple pour Paris
                        'longitude': 2.3522 + random.uniform(-0.1, 0.1)
                    },
                    'date': current_date.isoformat(),
                    'attendance': attendance,
                    'description': f"{event_name} happening in {city}",
                    'url': f"https://example.com/events/{random.randint(1000, 9999)}",
                    'organizer': f"{city} Events",
                    'ticket_price': {
                        'min': random.randint(10, 50),
                        'max': random.randint(50, 200),
                        'currency': 'EUR'
                    }
                })
            
            current_date += timedelta(days=1)
        
        return {
            'source': 'mock',
            'items': mock_events
        }
    
    def _normalize(
        self,
        raw_response: Dict[str, Any],
        city: str,
        country: str
    ) -> List[Dict[str, Any]]:
        """
        Normalise les données brutes vers le format raw_events_data.
        
        Args:
            raw_response: Réponse brute de l'API
            city: Nom de la ville
            country: Code pays
            
        Returns:
            Liste de dicts normalisés
        """
        source = raw_response.get('source', self.primary_source)
        items = raw_response.get('items', [])
        
        if not items:
            logger.warning(f"No events found in response from {source}")
            return []
        
        normalized = []
        
        for item in items:
            try:
                if source == 'eventbrite':
                    record = self._normalize_eventbrite(item, city, country)
                elif source == 'mock':
                    record = self._normalize_mock(item, city, country)
                else:
                    # Format générique (Google, etc.)
                    record = self._normalize_generic(item, city, country, source)
                
                if record:
                    normalized.append(record)
            
            except Exception as e:
                logger.error(f"Error normalizing event item: {e}", exc_info=True)
                continue
        
        logger.info(f"Normalized {len(normalized)} events from {source}")
        return normalized
    
    def _normalize_eventbrite(
        self,
        item: Dict[str, Any],
        city: str,
        country: str
    ) -> Optional[Dict[str, Any]]:
        """
        Normalise un événement Eventbrite.
        """
        # Extraire les informations
        name = item.get('name', {}).get('text', '')
        if not name:
            return None
        
        # Date de début
        start = item.get('start', {})
        start_utc = start.get('utc')
        if not start_utc:
            return None
        
        try:
            event_date = datetime.fromisoformat(start_utc.replace('Z', '+00:00')).date()
        except:
            return None
        
        # Venue
        venue = item.get('venue', {})
        venue_name = venue.get('name', '')
        venue_address = venue.get('address', {}).get('localized_area_display', '')
        
        # Coordonnées
        latitude = venue.get('latitude')
        longitude = venue.get('longitude')
        
        # Description
        description = item.get('description', {}).get('text', '')
        
        # URL
        url = item.get('url', '')
        
        # Organizer
        organizer = item.get('organizer', {})
        organizer_name = organizer.get('name', '')
        
        # Prix
        ticket_availability = item.get('ticket_availability', {})
        ticket_price = item.get('ticket_availability', {}).get('minimum_ticket_price', {})
        price_min = ticket_price.get('value', {}).get('major_value') if ticket_price else None
        price_max = ticket_price.get('value', {}).get('major_value') if ticket_price else None
        currency = ticket_price.get('currency', 'EUR') if ticket_price else 'EUR'
        
        # Type d'événement (catégorie Eventbrite)
        category = item.get('category', {})
        event_type = category.get('name', '').lower() if category else None
        
        # Estimation d'attendance (capacité)
        capacity = item.get('capacity', 0)
        
        return {
            'source': 'eventbrite',
            'country': country,
            'city': city,
            'event_date': event_date.isoformat(),
            'event_name': name,
            'event_type': event_type,
            'venue_name': venue_name,
            'venue_address': venue_address,
            'expected_attendance': capacity if capacity > 0 else None,
            'event_category': None,  # Sera classifié par IA
            'description': description[:1000] if description else None,  # Limiter à 1000 chars
            'url': url,
            'latitude': float(latitude) if latitude else None,
            'longitude': float(longitude) if longitude else None,
            'organizer_name': organizer_name,
            'ticket_price_min': float(price_min) if price_min else None,
            'ticket_price_max': float(price_max) if price_max else None,
            'currency': currency,
            'timezone': item.get('start', {}).get('timezone', 'UTC'),
            'metadata': {
                'eventbrite_id': item.get('id'),
                'format': item.get('format', {}).get('name'),
                'is_free': item.get('is_free', False)
            },
            'collected_at': datetime.now().isoformat()
        }
    
    def _normalize_mock(
        self,
        item: Dict[str, Any],
        city: str,
        country: str
    ) -> Optional[Dict[str, Any]]:
        """
        Normalise un événement mock.
        """
        try:
            event_date = datetime.fromisoformat(item['date']).date()
        except:
            return None
        
        venue = item.get('venue', {})
        
        return {
            'source': 'mock',
            'country': country,
            'city': city,
            'event_date': event_date.isoformat(),
            'event_name': item.get('name', ''),
            'event_type': item.get('type'),
            'venue_name': venue.get('name', '') if isinstance(venue, dict) else str(venue),
            'venue_address': venue.get('address', '') if isinstance(venue, dict) else '',
            'expected_attendance': item.get('attendance'),
            'event_category': None,
            'description': item.get('description'),
            'url': item.get('url'),
            'latitude': venue.get('latitude') if isinstance(venue, dict) else None,
            'longitude': venue.get('longitude') if isinstance(venue, dict) else None,
            'organizer_name': item.get('organizer'),
            'ticket_price_min': item.get('ticket_price', {}).get('min') if isinstance(item.get('ticket_price'), dict) else None,
            'ticket_price_max': item.get('ticket_price', {}).get('max') if isinstance(item.get('ticket_price'), dict) else None,
            'currency': item.get('ticket_price', {}).get('currency', 'EUR') if isinstance(item.get('ticket_price'), dict) else 'EUR',
            'timezone': 'UTC',
            'metadata': {
                'is_mock': True
            },
            'collected_at': datetime.now().isoformat()
        }
    
    def _normalize_generic(
        self,
        item: Dict[str, Any],
        city: str,
        country: str,
        source: str
    ) -> Optional[Dict[str, Any]]:
        """
        Normalise un événement depuis un format générique (Google, etc.).
        """
        # Extraction générique des champs communs
        name = item.get('name') or item.get('title') or item.get('summary', '')
        if not name:
            return None
        
        # Date
        start = item.get('start') or item.get('startDate') or item.get('date')
        if isinstance(start, str):
            try:
                event_date = datetime.fromisoformat(start.split('T')[0]).date()
            except:
                return None
        elif isinstance(start, dict):
            event_date_str = start.get('date') or start.get('dateTime', '').split('T')[0]
            try:
                event_date = datetime.fromisoformat(event_date_str).date()
            except:
                return None
        else:
            return None
        
        # Venue
        venue = item.get('venue') or item.get('location') or {}
        venue_name = venue.get('name', '') if isinstance(venue, dict) else str(venue)
        venue_address = venue.get('address', '') if isinstance(venue, dict) else ''
        
        # Coordonnées
        location = item.get('location') or venue
        latitude = location.get('latitude') if isinstance(location, dict) else None
        longitude = location.get('longitude') if isinstance(location, dict) else None
        
        return {
            'source': source,
            'country': country,
            'city': city,
            'event_date': event_date.isoformat(),
            'event_name': name,
            'event_type': item.get('type') or item.get('category'),
            'venue_name': venue_name,
            'venue_address': venue_address,
            'expected_attendance': item.get('attendance') or item.get('expectedAttendance'),
            'event_category': None,
            'description': item.get('description') or item.get('summary'),
            'url': item.get('url') or item.get('link'),
            'latitude': float(latitude) if latitude else None,
            'longitude': float(longitude) if longitude else None,
            'organizer_name': item.get('organizer') or item.get('organizerName'),
            'ticket_price_min': item.get('ticketPrice', {}).get('min') if isinstance(item.get('ticketPrice'), dict) else None,
            'ticket_price_max': item.get('ticketPrice', {}).get('max') if isinstance(item.get('ticketPrice'), dict) else None,
            'currency': item.get('currency', 'EUR'),
            'timezone': item.get('timezone', 'UTC'),
            'metadata': item.get('metadata', {}),
            'collected_at': datetime.now().isoformat()
        }
