"""
Collecteur de données météo (OpenWeatherMap, WeatherAPI avec fallback).
"""

import asyncio
import logging
from typing import Dict, List, Optional, Any
from datetime import date, datetime, timedelta

from .base_collector import BaseCollector
from ..config.api_keys import get_api_key, API_SERVICES
from ..config.cities_config import get_city_config

logger = logging.getLogger(__name__)


class WeatherCollector(BaseCollector):
    """
    Collecteur de données météo avec support OpenWeatherMap et WeatherAPI.
    
    Collecte les prévisions météo (14 jours) et normalise les données.
    Supporte le fallback automatique si une API est down.
    """
    
    # URLs des APIs
    OPENWEATHER_BASE_URL = "https://api.openweathermap.org/data/2.5"
    WEATHERAPI_BASE_URL = "http://api.weatherapi.com/v1"
    
    def __init__(
        self,
        primary_source: str = "openweather",
        fallback_source: Optional[str] = "weatherapi",
        api_key: Optional[str] = None,
        forecast_days: int = 14,
        **kwargs
    ):
        """
        Initialise le collecteur météo.
        
        Args:
            primary_source: Source primaire ('openweather' ou 'weatherapi')
            fallback_source: Source de fallback (None pour désactiver)
            api_key: Clé API (si None, récupère depuis env)
            forecast_days: Nombre de jours de prévisions (max 14)
            **kwargs: Arguments additionnels pour BaseCollector
        """
        self.primary_source = primary_source.lower()
        self.fallback_source = fallback_source.lower() if fallback_source else None
        self.forecast_days = min(forecast_days, 14)  # Limiter à 14 jours
        
        # Récupérer les clés API
        self.api_keys = {}
        if self.primary_source == "openweather":
            self.api_keys["openweather"] = api_key or get_api_key(API_SERVICES.OPENWEATHER)
        elif self.primary_source == "weatherapi":
            self.api_keys["weatherapi"] = api_key or get_api_key(API_SERVICES.WEATHERAPI)
        
        if self.fallback_source:
            if self.fallback_source == "openweather":
                self.api_keys["openweather"] = self.api_keys.get("openweather") or get_api_key(API_SERVICES.OPENWEATHER)
            elif self.fallback_source == "weatherapi":
                self.api_keys["weatherapi"] = self.api_keys.get("weatherapi") or get_api_key(API_SERVICES.WEATHERAPI)
        
        # Utiliser la clé de la source primaire pour BaseCollector
        primary_api_key = self.api_keys.get(self.primary_source)
        
        super().__init__(
            source_name=f"weather_{self.primary_source}",
            api_key=primary_api_key,
            **kwargs
        )
        
        logger.info(
            f"Initialized WeatherCollector (primary: {self.primary_source}, "
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
        Collecte les données météo pour une ville.
        
        Args:
            city: Nom de la ville
            country: Code pays (ex: 'FR', 'US')
            date_range: Plage de dates (optionnel, défaut: aujourd'hui + forecast_days)
            store_in_db: Si True, stocke dans Supabase
        
        Returns:
            Liste de données normalisées par date
        """
        # Obtenir les coordonnées de la ville
        city_config = get_city_config(city, country)
        if not city_config:
            logger.warning(
                f"City config not found for {city}, {country}. "
                "Coordinates will need to be fetched from API."
            )
            lat, lon = None, None
            timezone = self.settings.default_timezone
        else:
            lat, lon = city_config.latitude, city_config.longitude
            timezone = city_config.timezone
        
        # Définir la plage de dates
        if not date_range:
            today = date.today()
            date_range = {
                'start_date': today,
                'end_date': today + timedelta(days=self.forecast_days)
            }
        
        logger.info(
            f"Collecting weather for {city}, {country} "
            f"from {date_range['start_date']} to {date_range['end_date']}"
        )
        
        # Collecter avec fallback si nécessaire
        raw_data = None
        source_used = self.primary_source
        
        try:
            raw_data = await self._fetch_data(
                city=city,
                country=country,
                latitude=lat,
                longitude=lon,
                date_range=date_range
            )
        except Exception as e:
            logger.warning(f"Primary source {self.primary_source} failed: {e}")
            
            if self.fallback_source and self.fallback_source != self.primary_source:
                logger.info(f"Trying fallback source: {self.fallback_source}")
                try:
                    # Changer temporairement de source
                    original_source = self.primary_source
                    self.primary_source = self.fallback_source
                    self.api_key = self.api_keys.get(self.fallback_source)
                    
                    raw_data = await self._fetch_data(
                        city=city,
                        country=country,
                        latitude=lat,
                        longitude=lon,
                        date_range=date_range
                    )
                    
                    source_used = self.fallback_source
                    logger.info(f"Fallback source {self.fallback_source} succeeded")
                    
                    # Restaurer la source primaire
                    self.primary_source = original_source
                    self.api_key = self.api_keys.get(original_source)
                    
                except Exception as fallback_error:
                    logger.error(
                        f"Both sources failed. Primary: {e}, Fallback: {fallback_error}"
                    )
                    raise RuntimeError(
                        f"All weather sources failed. Last error: {fallback_error}"
                    ) from fallback_error
            else:
                raise
        
        # Normaliser les données
        normalized_data = self._normalize(
            raw_response=raw_data,
            city=city,
            country=country,
            latitude=lat,
            longitude=lon,
            timezone=timezone,
            source_used=source_used
        )
        
        # Valider et stocker
        if store_in_db:
            validated_data = [
                item for item in normalized_data
                if self._validate(item)
            ]
            
            if validated_data:
                await self._store_raw_data(validated_data)
        
        return normalized_data
    
    async def _fetch_data(
        self,
        city: str,
        country: str,
        latitude: Optional[float] = None,
        longitude: Optional[float] = None,
        date_range: Optional[Dict[str, date]] = None
    ) -> Dict[str, Any]:
        """
        Récupère les données brutes depuis l'API météo.
        
        Args:
            city: Nom de la ville
            country: Code pays
            latitude: Latitude (optionnel)
            longitude: Longitude (optionnel)
            date_range: Plage de dates
        
        Returns:
            Données brutes de l'API
        """
        if self.primary_source == "openweather":
            return await self._fetch_openweather(
                city=city,
                country=country,
                latitude=latitude,
                longitude=longitude
            )
        elif self.primary_source == "weatherapi":
            return await self._fetch_weatherapi(
                city=city,
                country=country,
                latitude=latitude,
                longitude=longitude,
                date_range=date_range
            )
        else:
            raise ValueError(f"Unknown source: {self.primary_source}")
    
    async def _fetch_openweather(
        self,
        city: str,
        country: str,
        latitude: Optional[float] = None,
        longitude: Optional[float] = None
    ) -> Dict[str, Any]:
        """Récupère les données depuis OpenWeatherMap API."""
        if not self.api_keys.get("openweather"):
            raise RuntimeError("OpenWeatherMap API key not configured")
        
        # Construire l'URL selon si on a les coordonnées
        if latitude and longitude:
            url = f"{self.OPENWEATHER_BASE_URL}/forecast"
            params = {
                'lat': latitude,
                'lon': longitude,
                'appid': self.api_keys["openweather"],
                'units': 'metric',  # Celsius
                'lang': 'en'
            }
        else:
            # Utiliser le nom de la ville
            url = f"{self.OPENWEATHER_BASE_URL}/forecast"
            params = {
                'q': f"{city},{country}",
                'appid': self.api_keys["openweather"],
                'units': 'metric',
                'lang': 'en'
            }
        
        response = await self._make_request('GET', url, params=params)
        
        return {
            'source': 'openweather',
            'data': response,
            'city': city,
            'country': country
        }
    
    async def _fetch_weatherapi(
        self,
        city: str,
        country: str,
        latitude: Optional[float] = None,
        longitude: Optional[float] = None,
        date_range: Optional[Dict[str, date]] = None
    ) -> Dict[str, Any]:
        """Récupère les données depuis WeatherAPI."""
        if not self.api_keys.get("weatherapi"):
            raise RuntimeError("WeatherAPI key not configured")
        
        # Construire le query
        if latitude and longitude:
            query = f"{latitude},{longitude}"
        else:
            query = f"{city},{country}"
        
        # WeatherAPI supporte forecast jusqu'à 14 jours
        url = f"{self.WEATHERAPI_BASE_URL}/forecast.json"
        params = {
            'key': self.api_keys["weatherapi"],
            'q': query,
            'days': self.forecast_days,
            'aqi': 'no',
            'alerts': 'no'
        }
        
        response = await self._make_request('GET', url, params=params)
        
        return {
            'source': 'weatherapi',
            'data': response,
            'city': city,
            'country': country
        }
    
    def _normalize(
        self,
        raw_response: Dict[str, Any],
        city: str,
        country: str,
        latitude: Optional[float],
        longitude: Optional[float],
        timezone: str,
        source_used: str
    ) -> List[Dict[str, Any]]:
        """
        Normalise les données brutes vers le schéma raw_weather_data.
        
        Args:
            raw_response: Réponse brute de l'API
            city: Nom de la ville
            country: Code pays
            latitude: Latitude
            longitude: Longitude
            timezone: Timezone IANA
            source_used: Source utilisée ('openweather' ou 'weatherapi')
        
        Returns:
            Liste de données normalisées (une par date)
        """
        logger.info(f"Normalizing weather data from {source_used}")
        
        if source_used == "openweather":
            return self._normalize_openweather(
                raw_response, city, country, latitude, longitude, timezone
            )
        elif source_used == "weatherapi":
            return self._normalize_weatherapi(
                raw_response, city, country, latitude, longitude, timezone
            )
        else:
            raise ValueError(f"Unknown source for normalization: {source_used}")
    
    def _normalize_openweather(
        self,
        raw_response: Dict[str, Any],
        city: str,
        country: str,
        latitude: Optional[float],
        longitude: Optional[float],
        timezone: str
    ) -> List[Dict[str, Any]]:
        """Normalise les données OpenWeatherMap."""
        data = raw_response.get('data', {})
        forecast_list = data.get('list', [])
        
        # Grouper par date (OpenWeatherMap donne des prévisions par 3h)
        forecasts_by_date: Dict[date, List[Dict]] = {}
        
        for item in forecast_list:
            dt_txt = item.get('dt_txt')
            if not dt_txt:
                continue
            
            # Parser la date
            try:
                forecast_dt = datetime.strptime(dt_txt, '%Y-%m-%d %H:%M:%S')
                forecast_date = forecast_dt.date()
            except ValueError:
                logger.warning(f"Could not parse date: {dt_txt}")
                continue
            
            if forecast_date not in forecasts_by_date:
                forecasts_by_date[forecast_date] = []
            
            forecasts_by_date[forecast_date].append(item)
        
        # Agréger par date
        normalized_records = []
        
        for forecast_date, items in forecasts_by_date.items():
            # Calculer les moyennes
            temps = [item['main']['temp'] for item in items]
            temps_min = [item['main']['temp_min'] for item in items]
            temps_max = [item['main']['temp_max'] for item in items]
            humidities = [item['main']['humidity'] for item in items]
            precipitations = [
                item.get('rain', {}).get('3h', 0) for item in items
            ]
            wind_speeds = [item.get('wind', {}).get('speed', 0) for item in items]
            cloud_covers = [item.get('clouds', {}).get('all', 0) for item in items]
            
            # Conditions météo (prendre la plus fréquente)
            weather_conditions = [
                item.get('weather', [{}])[0].get('main', '').lower()
                for item in items
            ]
            most_common_condition = max(
                set(weather_conditions),
                key=weather_conditions.count
            ) if weather_conditions else 'unknown'
            
            # Calculer is_sunny
            is_sunny = (
                most_common_condition in ['clear', 'sunny'] and
                max(cloud_covers) < 30  # Moins de 30% de couverture nuageuse
            )
            
            # UV index (non disponible dans forecast gratuit, mettre None)
            uv_index = None
            
            record = {
                'source': 'openweather',
                'country': country,
                'city': city,
                'latitude': float(latitude) if latitude else None,
                'longitude': float(longitude) if longitude else None,
                'forecast_date': forecast_date.isoformat(),
                'collected_at': datetime.now().isoformat(),
                'raw_data': {
                    'api_response': items[0] if items else {},  # Échantillon
                    'items_count': len(items)
                },
                'temperature_avg': round(sum(temps) / len(temps), 2),
                'temperature_min': round(min(temps_min), 2),
                'temperature_max': round(max(temps_max), 2),
                'precipitation_mm': round(sum(precipitations), 2),
                'humidity_percent': round(sum(humidities) / len(humidities), 2),
                'wind_speed_kmh': round(
                    sum(wind_speeds) / len(wind_speeds) * 3.6, 2
                ),  # Convertir m/s en km/h
                'weather_condition': most_common_condition,
                'is_sunny': is_sunny,
                'cloud_cover_percent': round(sum(cloud_covers) / len(cloud_covers), 2),
                'uv_index': uv_index,
                'timezone': timezone,
                'metadata': {
                    'source': 'openweather',
                    'forecast_count': len(items)
                }
            }
            
            normalized_records.append(record)
        
        return normalized_records
    
    def _normalize_weatherapi(
        self,
        raw_response: Dict[str, Any],
        city: str,
        country: str,
        latitude: Optional[float],
        longitude: Optional[float],
        timezone: str
    ) -> List[Dict[str, Any]]:
        """Normalise les données WeatherAPI."""
        data = raw_response.get('data', {})
        location = data.get('location', {})
        forecast_days = data.get('forecast', {}).get('forecastday', [])
        
        normalized_records = []
        
        for forecast_day in forecast_days:
            date_str = forecast_day.get('date')
            if not date_str:
                continue
            
            try:
                forecast_date = datetime.strptime(date_str, '%Y-%m-%d').date()
            except ValueError:
                logger.warning(f"Could not parse date: {date_str}")
                continue
            
            day_data = forecast_day.get('day', {})
            hour_data = forecast_day.get('hour', [])
            
            # Températures
            temp_avg = day_data.get('avgtemp_c')
            temp_min = day_data.get('mintemp_c')
            temp_max = day_data.get('maxtemp_c')
            
            # Précipitations
            precipitation_mm = day_data.get('totalprecip_mm', 0)
            
            # Humidité (moyenne des heures)
            humidities = [h.get('humidity', 0) for h in hour_data]
            humidity_avg = sum(humidities) / len(humidities) if humidities else day_data.get('avghumidity', 0)
            
            # Vent (moyenne des heures)
            wind_speeds = [h.get('wind_kph', 0) for h in hour_data]
            wind_speed_kmh = sum(wind_speeds) / len(wind_speeds) if wind_speeds else day_data.get('maxwind_kph', 0)
            
            # Conditions météo
            condition = day_data.get('condition', {})
            weather_condition = condition.get('text', '').lower()
            
            # Couverture nuageuse (moyenne des heures)
            cloud_covers = [h.get('cloud', 0) for h in hour_data]
            cloud_cover_percent = sum(cloud_covers) / len(cloud_covers) if cloud_covers else day_data.get('avgvis_km', 0)
            
            # UV index
            uv_index = day_data.get('uv', None)
            
            # Calculer is_sunny
            is_sunny = (
                'sun' in weather_condition or 'clear' in weather_condition
            ) and cloud_cover_percent < 30
            
            # Latitude/Longitude depuis location si non fourni
            if not latitude:
                latitude = location.get('lat')
            if not longitude:
                longitude = location.get('lon')
            
            record = {
                'source': 'weatherapi',
                'country': country,
                'city': city,
                'latitude': float(latitude) if latitude else None,
                'longitude': float(longitude) if longitude else None,
                'forecast_date': forecast_date.isoformat(),
                'collected_at': datetime.now().isoformat(),
                'raw_data': {
                    'api_response': forecast_day,
                    'location': location
                },
                'temperature_avg': round(temp_avg, 2) if temp_avg else None,
                'temperature_min': round(temp_min, 2) if temp_min else None,
                'temperature_max': round(temp_max, 2) if temp_max else None,
                'precipitation_mm': round(precipitation_mm, 2) if precipitation_mm else 0,
                'humidity_percent': round(humidity_avg, 2) if humidity_avg else None,
                'wind_speed_kmh': round(wind_speed_kmh, 2) if wind_speed_kmh else None,
                'weather_condition': weather_condition,
                'is_sunny': is_sunny,
                'cloud_cover_percent': round(cloud_cover_percent, 2) if cloud_cover_percent else None,
                'uv_index': round(uv_index, 1) if uv_index else None,
                'timezone': timezone or location.get('tz_id'),
                'metadata': {
                    'source': 'weatherapi',
                    'condition_code': condition.get('code')
                }
            }
            
            normalized_records.append(record)
        
        return normalized_records
    
    def _validate(self, data: Dict[str, Any]) -> bool:
        """Valide les données normalisées."""
        required_fields = ['source', 'country', 'city', 'forecast_date']
        
        for field in required_fields:
            if field not in data:
                logger.warning(f"Missing required field: {field}")
                return False
        
        # Valider la date
        try:
            datetime.fromisoformat(data['forecast_date'])
        except (ValueError, KeyError):
            logger.warning(f"Invalid date: {data.get('forecast_date')}")
            return False
        
        return True
