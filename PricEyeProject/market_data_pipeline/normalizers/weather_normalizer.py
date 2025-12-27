"""
Normaliseur de données météo (OpenWeatherMap, WeatherAPI).
"""

import logging
from typing import Dict, Any, Optional
from datetime import date, datetime

logger = logging.getLogger(__name__)


class WeatherNormalizer:
    """
    Normalise les réponses API météo vers le schéma raw_weather_data.
    
    Supporte :
    - OpenWeatherMap
    - WeatherAPI
    """
    
    # Mapping des conditions météo vers valeurs standardisées
    WEATHER_CONDITION_MAPPING = {
        # OpenWeatherMap
        'Clear': 'sunny',
        'clear sky': 'sunny',
        'Clouds': 'cloudy',
        'few clouds': 'cloudy',
        'scattered clouds': 'cloudy',
        'broken clouds': 'cloudy',
        'overcast clouds': 'overcast',
        'Rain': 'rainy',
        'light rain': 'rainy',
        'moderate rain': 'rainy',
        'heavy rain': 'rainy',
        'Drizzle': 'rainy',
        'Thunderstorm': 'stormy',
        'Snow': 'snowy',
        'light snow': 'snowy',
        'Mist': 'cloudy',
        'Fog': 'cloudy',
        'Haze': 'cloudy',
        
        # WeatherAPI
        'sunny': 'sunny',
        'clear': 'sunny',
        'partly cloudy': 'cloudy',
        'cloudy': 'cloudy',
        'overcast': 'overcast',
        'rain': 'rainy',
        'light rain': 'rainy',
        'moderate rain': 'rainy',
        'heavy rain': 'rainy',
        'snow': 'snowy',
        'sleet': 'snowy',
        'thunderstorm': 'stormy',
        'fog': 'cloudy',
        'mist': 'cloudy',
    }
    
    def __init__(self, source: Optional[str] = None):
        """
        Initialise le normaliseur.
        
        Args:
            source: Source API (auto-détectée si None)
        """
        self.source = source.lower() if source else None
        logger.info(f"Initialized WeatherNormalizer (source: {self.source or 'auto-detect'})")
    
    def normalize(
        self,
        raw_response: Dict[str, Any],
        country: str,
        city: str,
        forecast_date: date,
        source: Optional[str] = None,
        latitude: Optional[float] = None,
        longitude: Optional[float] = None,
        timezone: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Normalise une réponse API vers le schéma raw_weather_data.
        
        Args:
            raw_response: Réponse brute de l'API
            country: Pays
            city: Ville
            forecast_date: Date de prévision
            source: Source API (auto-détectée si None)
            latitude: Latitude (optionnel)
            longitude: Longitude (optionnel)
            timezone: Timezone IANA (optionnel)
        
        Returns:
            Données normalisées selon schéma raw_weather_data
        
        Raises:
            ValueError: Si les données sont invalides
        """
        source = source or self.source or self._detect_source(raw_response)
        
        logger.debug(
            f"Normalizing weather data from {source} "
            f"for {city}, {country} on {forecast_date}"
        )
        
        if source == 'openweather':
            return self._normalize_openweather(
                raw_response, country, city, forecast_date,
                latitude, longitude, timezone
            )
        elif source == 'weatherapi':
            return self._normalize_weatherapi(
                raw_response, country, city, forecast_date,
                latitude, longitude, timezone
            )
        else:
            logger.warning(f"Unknown source: {source}, attempting generic normalization")
            return self._normalize_generic(
                raw_response, country, city, forecast_date,
                latitude, longitude, timezone, source
            )
    
    def _normalize_openweather(
        self,
        raw_response: Dict[str, Any],
        country: str,
        city: str,
        forecast_date: date,
        latitude: Optional[float],
        longitude: Optional[float],
        timezone: Optional[str]
    ) -> Dict[str, Any]:
        """
        Normalise les données OpenWeatherMap.
        
        Format attendu :
        {
            'data': {
                'list': [
                    {
                        'dt_txt': '2024-01-15 12:00:00',
                        'main': {'temp': 288.15, 'temp_min': 285, 'temp_max': 290, 'humidity': 65},
                        'weather': [{'main': 'Clear', 'description': 'clear sky'}],
                        'wind': {'speed': 3.5},
                        'clouds': {'all': 20},
                        'rain': {'3h': 0}
                    },
                    ...
                ]
            }
        }
        """
        data = raw_response.get('data', {})
        forecast_list = data.get('list', [])
        
        # Filtrer les prévisions pour cette date
        day_forecasts = []
        for item in forecast_list:
            dt_txt = item.get('dt_txt')
            if not dt_txt:
                continue
            
            try:
                forecast_dt = datetime.strptime(dt_txt, '%Y-%m-%d %H:%M:%S')
                if forecast_dt.date() == forecast_date:
                    day_forecasts.append(item)
            except ValueError:
                continue
        
        if not day_forecasts:
            raise ValueError(f"No forecasts found for date {forecast_date} in OpenWeatherMap data")
        
        # Agréger les données de la journée
        temps = []
        temps_min = []
        temps_max = []
        humidities = []
        precipitations = []
        wind_speeds = []
        cloud_covers = []
        weather_conditions = []
        
        for item in day_forecasts:
            main = item.get('main', {})
            weather = item.get('weather', [{}])[0]
            wind = item.get('wind', {})
            clouds = item.get('clouds', {})
            rain = item.get('rain', {})
            
            # Températures (convertir Kelvin → Celsius)
            temp_k = main.get('temp')
            if temp_k:
                temps.append(self._convert_kelvin_to_celsius(temp_k))
            
            temp_min_k = main.get('temp_min')
            if temp_min_k:
                temps_min.append(self._convert_kelvin_to_celsius(temp_min_k))
            
            temp_max_k = main.get('temp_max')
            if temp_max_k:
                temps_max.append(self._convert_kelvin_to_celsius(temp_max_k))
            
            # Humidité
            if main.get('humidity') is not None:
                humidities.append(main['humidity'])
            
            # Précipitations (mm sur 3h)
            precip_3h = rain.get('3h', 0)
            if precip_3h:
                precipitations.append(precip_3h)
            
            # Vent (m/s → km/h)
            wind_speed_ms = wind.get('speed', 0)
            if wind_speed_ms:
                wind_speeds.append(wind_speed_ms * 3.6)  # Conversion
            
            # Couverture nuageuse
            if clouds.get('all') is not None:
                cloud_covers.append(clouds['all'])
            
            # Condition météo
            condition = weather.get('main') or weather.get('description', '')
            if condition:
                weather_conditions.append(condition)
        
        # Calculer les moyennes
        temp_avg = sum(temps) / len(temps) if temps else None
        temp_min = min(temps_min) if temps_min else None
        temp_max = max(temps_max) if temps_max else None
        humidity_avg = sum(humidities) / len(humidities) if humidities else None
        precipitation_total = sum(precipitations) if precipitations else 0.0
        wind_speed_avg = sum(wind_speeds) / len(wind_speeds) if wind_speeds else None
        cloud_cover_avg = sum(cloud_covers) / len(cloud_covers) if cloud_covers else None
        
        # Condition météo la plus fréquente
        most_common_condition = self._standardize_condition(
            max(set(weather_conditions), key=weather_conditions.count)
            if weather_conditions else 'unknown'
        )
        
        # Calculer is_sunny
        is_sunny = (
            most_common_condition in ['sunny', 'clear'] and
            (cloud_cover_avg is None or cloud_cover_avg < 30)
        )
        
        normalized = {
            'source': 'openweather',
            'country': country,
            'city': city,
            'latitude': float(latitude) if latitude else None,
            'longitude': float(longitude) if longitude else None,
            'forecast_date': forecast_date.isoformat(),
            'collected_at': datetime.now().isoformat(),
            'raw_data': {
                'api_response': day_forecasts[0] if day_forecasts else {},
                'items_count': len(day_forecasts)
            },
            'temperature_avg': round(temp_avg, 2) if temp_avg else None,
            'temperature_min': round(temp_min, 2) if temp_min else None,
            'temperature_max': round(temp_max, 2) if temp_max else None,
            'precipitation_mm': round(precipitation_total, 2),
            'humidity_percent': round(humidity_avg, 2) if humidity_avg else None,
            'wind_speed_kmh': round(wind_speed_avg, 2) if wind_speed_avg else None,
            'weather_condition': most_common_condition,
            'is_sunny': is_sunny,
            'cloud_cover_percent': round(cloud_cover_avg, 2) if cloud_cover_avg else None,
            'uv_index': None,  # Non disponible dans forecast gratuit OpenWeatherMap
            'timezone': timezone,
            'metadata': {
                'source': 'openweather',
                'forecast_count': len(day_forecasts)
            }
        }
        
        logger.debug(
            f"Normalized OpenWeatherMap data for {city} on {forecast_date}: "
            f"temp={temp_avg}°C, condition={most_common_condition}"
        )
        
        return normalized
    
    def _normalize_weatherapi(
        self,
        raw_response: Dict[str, Any],
        country: str,
        city: str,
        forecast_date: date,
        latitude: Optional[float],
        longitude: Optional[float],
        timezone: Optional[str]
    ) -> Dict[str, Any]:
        """
        Normalise les données WeatherAPI.
        
        Format attendu :
        {
            'data': {
                'location': {'lat': 48.8566, 'lon': 2.3522, 'tz_id': 'Europe/Paris'},
                'forecast': {
                    'forecastday': [
                        {
                            'date': '2024-01-15',
                            'day': {
                                'avgtemp_c': 15.5,
                                'mintemp_c': 10.0,
                                'maxtemp_c': 20.0,
                                'totalprecip_mm': 2.5,
                                'avghumidity': 65.0,
                                'maxwind_kph': 15.2,
                                'condition': {'text': 'Partly cloudy', 'code': 1003},
                                'uv': 3.5
                            },
                            'hour': [...]
                        }
                    ]
                }
            }
        }
        """
        data = raw_response.get('data', {})
        location = data.get('location', {})
        forecast_days = data.get('forecast', {}).get('forecastday', [])
        
        # Trouver le forecast pour cette date
        forecast_day = None
        for day in forecast_days:
            if day.get('date') == forecast_date.isoformat():
                forecast_day = day
                break
        
        if not forecast_day:
            raise ValueError(f"No forecast found for date {forecast_date} in WeatherAPI data")
        
        day_data = forecast_day.get('day', {})
        hour_data = forecast_day.get('hour', [])
        
        # Extraire les données
        temp_avg = day_data.get('avgtemp_c')
        temp_min = day_data.get('mintemp_c')
        temp_max = day_data.get('maxtemp_c')
        precipitation_mm = day_data.get('totalprecip_mm', 0)
        humidity_avg = day_data.get('avghumidity')
        
        # Vent (moyenne des heures ou max)
        wind_speeds = [h.get('wind_kph', 0) for h in hour_data if h.get('wind_kph')]
        wind_speed_kmh = (
            sum(wind_speeds) / len(wind_speeds) if wind_speeds
            else day_data.get('maxwind_kph')
        )
        
        # Couverture nuageuse (moyenne des heures)
        cloud_covers = [h.get('cloud', 0) for h in hour_data if h.get('cloud')]
        cloud_cover_avg = (
            sum(cloud_covers) / len(cloud_covers) if cloud_covers
            else None
        )
        
        # Condition météo
        condition = day_data.get('condition', {})
        condition_text = condition.get('text', '')
        weather_condition = self._standardize_condition(condition_text)
        
        # UV index
        uv_index = day_data.get('uv')
        
        # Calculer is_sunny
        is_sunny = (
            weather_condition in ['sunny', 'clear'] and
            (cloud_cover_avg is None or cloud_cover_avg < 30)
        )
        
        # Latitude/Longitude depuis location si non fourni
        if not latitude:
            latitude = location.get('lat')
        if not longitude:
            longitude = location.get('lon')
        if not timezone:
            timezone = location.get('tz_id')
        
        normalized = {
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
            'cloud_cover_percent': round(cloud_cover_avg, 2) if cloud_cover_avg else None,
            'uv_index': round(uv_index, 1) if uv_index else None,
            'timezone': timezone,
            'metadata': {
                'source': 'weatherapi',
                'condition_code': condition.get('code')
            }
        }
        
        logger.debug(
            f"Normalized WeatherAPI data for {city} on {forecast_date}: "
            f"temp={temp_avg}°C, condition={weather_condition}"
        )
        
        return normalized
    
    def _normalize_generic(
        self,
        raw_response: Dict[str, Any],
        country: str,
        city: str,
        forecast_date: date,
        latitude: Optional[float],
        longitude: Optional[float],
        timezone: Optional[str],
        source: str
    ) -> Dict[str, Any]:
        """Normalisation générique (tente d'extraire les champs communs)."""
        logger.warning(f"Using generic normalization for source: {source}")
        
        data = raw_response.get('data', raw_response)
        
        return {
            'source': source,
            'country': country,
            'city': city,
            'latitude': float(latitude) if latitude else None,
            'longitude': float(longitude) if longitude else None,
            'forecast_date': forecast_date.isoformat(),
            'collected_at': datetime.now().isoformat(),
            'raw_data': raw_response,
            'temperature_avg': self._extract_temp(data, 'temp', 'temperature', 'temp_avg'),
            'temperature_min': self._extract_temp(data, 'temp_min', 'temp_min', 'min_temp'),
            'temperature_max': self._extract_temp(data, 'temp_max', 'temp_max', 'max_temp'),
            'precipitation_mm': self._extract_value(data, ['precipitation', 'precip_mm', 'rain']),
            'humidity_percent': self._extract_value(data, ['humidity', 'humidity_percent']),
            'wind_speed_kmh': self._extract_value(data, ['wind_speed', 'wind']),
            'weather_condition': self._standardize_condition(
                self._extract_value(data, ['condition', 'weather', 'description'], as_str=True)
            ),
            'is_sunny': None,
            'cloud_cover_percent': self._extract_value(data, ['cloud_cover', 'clouds']),
            'uv_index': self._extract_value(data, ['uv', 'uv_index']),
            'timezone': timezone,
            'metadata': {
                'source': source,
                'normalization': 'generic'
            }
        }
    
    def validate(self, normalized_data: Dict[str, Any]) -> bool:
        """
        Valide les données normalisées.
        
        Args:
            normalized_data: Données à valider
        
        Returns:
            True si valides
        
        Raises:
            ValueError: Si les données sont invalides
        """
        errors = []
        
        # Vérifier les champs requis
        required_fields = ['source', 'country', 'city', 'forecast_date']
        for field in required_fields:
            if field not in normalized_data or normalized_data[field] is None:
                errors.append(f"Missing required field: {field}")
        
        # Valider la date
        date_str = normalized_data.get('forecast_date')
        if date_str:
            try:
                datetime.fromisoformat(date_str)
            except (ValueError, TypeError):
                errors.append(f"Invalid date format: {date_str}")
        
        # Valider les températures (si présentes, doivent être cohérentes)
        temp_avg = normalized_data.get('temperature_avg')
        temp_min = normalized_data.get('temperature_min')
        temp_max = normalized_data.get('temperature_max')
        
        if temp_avg is not None:
            if not isinstance(temp_avg, (int, float)):
                errors.append(f"Invalid temperature_avg: {temp_avg}")
            elif temp_avg < -100 or temp_avg > 100:
                errors.append(f"Temperature out of range: {temp_avg}°C")
        
        if temp_min and temp_max and temp_min > temp_max:
            errors.append(
                f"Inconsistent temperatures: min={temp_min} > max={temp_max}"
            )
        
        if temp_avg and temp_min and temp_max:
            if not (temp_min <= temp_avg <= temp_max):
                errors.append(
                    f"Temperature avg not between min and max: "
                    f"{temp_min} <= {temp_avg} <= {temp_max}"
                )
        
        # Valider l'humidité (0-100%)
        humidity = normalized_data.get('humidity_percent')
        if humidity is not None:
            if not isinstance(humidity, (int, float)) or humidity < 0 or humidity > 100:
                errors.append(f"Invalid humidity: {humidity}% (must be 0-100)")
        
        # Valider la couverture nuageuse (0-100%)
        cloud_cover = normalized_data.get('cloud_cover_percent')
        if cloud_cover is not None:
            if not isinstance(cloud_cover, (int, float)) or cloud_cover < 0 or cloud_cover > 100:
                errors.append(f"Invalid cloud_cover: {cloud_cover}% (must be 0-100)")
        
        if errors:
            error_message = "Validation errors:\n" + "\n".join(f"  - {e}" for e in errors)
            logger.error(f"Weather data validation failed:\n{error_message}")
            raise ValueError(error_message)
        
        logger.debug("Weather data validation passed")
        return True
    
    # Helper methods
    
    def _detect_source(self, raw_response: Dict[str, Any]) -> str:
        """Détecte la source depuis les données brutes."""
        if 'list' in raw_response.get('data', {}):
            return 'openweather'
        elif 'forecast' in raw_response.get('data', {}):
            return 'weatherapi'
        return 'unknown'
    
    def _convert_kelvin_to_celsius(self, temp_kelvin: float) -> float:
        """Convertit Kelvin en Celsius."""
        return temp_kelvin - 273.15
    
    def _convert_fahrenheit_to_celsius(self, temp_fahrenheit: float) -> float:
        """Convertit Fahrenheit en Celsius."""
        return (temp_fahrenheit - 32) * 5 / 9
    
    def _standardize_condition(self, condition: Optional[str]) -> str:
        """
        Standardise les conditions météo vers des valeurs communes.
        
        Args:
            condition: Condition météo brute
        
        Returns:
            Condition standardisée : 'sunny', 'cloudy', 'rainy', 'snowy', 'stormy', 'overcast'
        """
        if not condition:
            return 'unknown'
        
        condition_lower = str(condition).lower().strip()
        
        # Vérifier le mapping
        if condition_lower in self.WEATHER_CONDITION_MAPPING:
            return self.WEATHER_CONDITION_MAPPING[condition_lower]
        
        # Recherche partielle
        for key, value in self.WEATHER_CONDITION_MAPPING.items():
            if key in condition_lower or condition_lower in key:
                return value
        
        # Par défaut
        if any(word in condition_lower for word in ['sun', 'clear']):
            return 'sunny'
        elif any(word in condition_lower for word in ['cloud', 'overcast']):
            return 'cloudy'
        elif any(word in condition_lower for word in ['rain', 'drizzle']):
            return 'rainy'
        elif any(word in condition_lower for word in ['snow', 'sleet']):
            return 'snowy'
        elif any(word in condition_lower for word in ['storm', 'thunder']):
            return 'stormy'
        
        return 'unknown'
    
    def _extract_temp(
        self,
        data: Dict[str, Any],
        *keys: str
    ) -> Optional[float]:
        """Extrait une température et convertit si nécessaire."""
        value = self._extract_value(data, list(keys))
        if value is None:
            return None
        
        # Si c'est en Kelvin (généralement > 200), convertir
        if isinstance(value, (int, float)):
            if value > 200:
                return round(self._convert_kelvin_to_celsius(value), 2)
            return round(float(value), 2)
        
        return None
    
    def _extract_value(
        self,
        data: Dict[str, Any],
        keys: List[str],
        as_str: bool = False
    ) -> Optional[Any]:
        """Extrait une valeur depuis plusieurs clés possibles."""
        for key in keys:
            # Support pour clés imbriquées (ex: 'main.temp')
            parts = key.split('.')
            value = data
            try:
                for part in parts:
                    value = value[part]
                
                if value is not None:
                    return str(value) if as_str else value
            except (KeyError, TypeError, AttributeError):
                continue
        return None
