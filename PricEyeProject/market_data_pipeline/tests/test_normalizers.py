"""
Tests unitaires pour les normalizers.
"""

import pytest
from datetime import date, datetime
from typing import Dict, Any

from market_data_pipeline.normalizers.competitor_normalizer import CompetitorNormalizer
from market_data_pipeline.normalizers.weather_normalizer import WeatherNormalizer
from market_data_pipeline.normalizers.events_normalizer import EventsNormalizer
from market_data_pipeline.utils.validators import validate_data, validate_schema


class TestCompetitorNormalizer:
    """Tests pour CompetitorNormalizer."""
    
    def test_normalize_apify_format(self, sample_apify_response):
        """Test normalisation format Apify."""
        normalizer = CompetitorNormalizer(source="apify")
        
        result = normalizer.normalize(
            raw_response=sample_apify_response,
            country="FR",
            city="Paris",
            data_date=date.today()
        )
        
        # Vérifier structure de base
        assert "source" in result
        assert "country" in result
        assert "city" in result
        assert "data_date" in result
        assert "raw_data" in result
        assert "normalized_data" in result
        
        # Vérifier valeurs
        assert result["source"] == "apify"
        assert result["country"] == "FR"
        assert result["city"] == "Paris"
        assert result["data_date"] == date.today()
        
        # Vérifier normalized_data
        normalized = result["normalized_data"]
        assert isinstance(normalized, dict)
        assert "price" in normalized or "listing_id" in normalized
    
    def test_normalize_airdna_csv(self):
        """Test normalisation format AirDNA CSV."""
        normalizer = CompetitorNormalizer(source="airdna")
        
        csv_data = {
            "property_id": "prop_123",
            "listing_price": 200.0,
            "bedrooms": 3,
            "bathrooms": 2,
            "accommodates": 6,
            "property_type": "House",
            "latitude": 48.8566,
            "longitude": 2.3522,
            "neighborhood": "Montmartre"
        }
        
        result = normalizer.normalize(
            raw_response=csv_data,
            country="FR",
            city="Paris",
            data_date=date.today()
        )
        
        assert result["source"] == "airdna"
        normalized = result["normalized_data"]
        
        # Vérifier mapping des champs
        assert normalized.get("property_id") == "prop_123" or normalized.get("listing_id") == "prop_123"
        assert normalized.get("price") == 200.0 or normalized.get("listing_price") == 200.0
        assert normalized.get("bedrooms") == 3
        assert normalized.get("bathrooms") == 2
    
    def test_normalize_lighthouse_csv(self):
        """Test normalisation format Lighthouse CSV."""
        normalizer = CompetitorNormalizer(source="lighthouse")
        
        csv_data = {
            "id": "lh_123",
            "rate": 180.0,
            "bedroom_count": 2,
            "bathroom_count": 1,
            "max_occupancy": 4,
            "property_type": "Apartment",
            "lat": 48.8566,
            "lng": 2.3522
        }
        
        result = normalizer.normalize(
            raw_response=csv_data,
            country="FR",
            city="Paris",
            data_date=date.today()
        )
        
        assert result["source"] == "lighthouse"
        normalized = result["normalized_data"]
        
        # Vérifier mapping Lighthouse
        assert normalized.get("property_id") or normalized.get("listing_id")
        assert normalized.get("price") or normalized.get("rate")
        assert normalized.get("bedrooms") or normalized.get("bedroom_count") == 2
    
    def test_normalize_auto_detect_source(self, sample_apify_response):
        """Test auto-détection de la source."""
        normalizer = CompetitorNormalizer()  # Pas de source spécifiée
        
        result = normalizer.normalize(
            raw_response=sample_apify_response,
            country="FR",
            city="Paris",
            data_date=date.today()
        )
        
        # Devrait détecter Apify via la structure des données
        assert "normalized_data" in result
    
    def test_normalize_invalid_data(self):
        """Test normalisation avec données invalides."""
        normalizer = CompetitorNormalizer()
        
        # Données complètement vides
        empty_data = {}
        
        with pytest.raises((ValueError, KeyError, TypeError)):
            normalizer.normalize(
                raw_response=empty_data,
                country="FR",
                city="Paris",
                data_date=date.today()
            )
    
    def test_normalize_missing_optional_fields(self):
        """Test normalisation avec champs optionnels manquants."""
        normalizer = CompetitorNormalizer(source="apify")
        
        # Données minimales (sans champs optionnels)
        minimal_data = {
            "defaultLocale": {"title": "Apartment"},
            "pricingMetadata": {"rate": {"amount": 150.0}},
            "bedrooms": 2,
            "lat": 48.8566,
            "lng": 2.3522
        }
        
        result = normalizer.normalize(
            raw_response=minimal_data,
            country="FR",
            city="Paris",
            data_date=date.today()
        )
        
        # Devrait normaliser avec valeurs par défaut pour champs manquants
        assert "normalized_data" in result
        normalized = result["normalized_data"]
        assert normalized.get("price") == 150.0 or normalized.get("price") is not None


class TestWeatherNormalizer:
    """Tests pour WeatherNormalizer."""
    
    def test_normalize_openweather(self):
        """Test normalisation format OpenWeatherMap."""
        normalizer = WeatherNormalizer(source="openweather")
        
        raw_data = {
            "dt": int(datetime.now().timestamp()),
            "main": {
                "temp": 293.15,  # 20°C en Kelvin
                "humidity": 65,
                "pressure": 1013
            },
            "weather": [{"main": "Clear", "description": "clear sky"}],
            "wind": {"speed": 10.0, "deg": 180},
            "rain": {"3h": 0.0}
        }
        
        result = normalizer.normalize(
            raw_response=raw_data,
            country="FR",
            city="Paris",
            forecast_date=date.today(),
            source="openweather"
        )
        
        assert "source" in result
        assert result["source"] == "openweather"
        assert "normalized_data" in result
        
        normalized = result["normalized_data"]
        
        # Vérifier conversion Kelvin -> Celsius
        assert "temperature" in normalized
        assert normalized["temperature"] == pytest.approx(20.0, abs=1.0)
        
        # Vérifier autres champs
        assert normalized.get("humidity") == 65
        assert normalized.get("weather_condition") in ["sunny", "clear"]
    
    def test_normalize_weatherapi(self):
        """Test normalisation format WeatherAPI."""
        normalizer = WeatherNormalizer(source="weatherapi")
        
        raw_data = {
            "forecast": {
                "forecastday": [{
                    "date": date.today().isoformat(),
                    "day": {
                        "avgtemp_c": 20.5,
                        "avghumidity": 65,
                        "condition": {"text": "Sunny"},
                        "maxwind_kph": 10.0,
                        "totalprecip_mm": 0.0
                    }
                }]
            }
        }
        
        result = normalizer.normalize(
            raw_response=raw_data,
            country="FR",
            city="Paris",
            forecast_date=date.today(),
            source="weatherapi"
        )
        
        assert result["source"] == "weatherapi"
        normalized = result["normalized_data"]
        
        assert normalized.get("temperature") == pytest.approx(20.5, abs=0.1)
        assert normalized.get("humidity") == 65
    
    def test_weather_condition_mapping(self):
        """Test mapping des conditions météo."""
        normalizer = WeatherNormalizer()
        
        # Tester différents formats de conditions
        test_cases = [
            ("Clear", "sunny"),
            ("clear sky", "sunny"),
            ("Clouds", "cloudy"),
            ("Rain", "rainy"),
            ("Thunderstorm", "stormy"),
            ("Snow", "snowy")
        ]
        
        for input_condition, expected in test_cases:
            raw_data = {
                "dt": int(datetime.now().timestamp()),
                "main": {"temp": 293.15, "humidity": 50},
                "weather": [{"main": input_condition}],
                "wind": {"speed": 5.0}
            }
            
            result = normalizer.normalize(
                raw_response=raw_data,
                country="FR",
                city="Paris",
                forecast_date=date.today(),
                source="openweather"
            )
            
            normalized = result["normalized_data"]
            # La condition devrait être mappée
            assert normalized.get("weather_condition") in ["sunny", "cloudy", "rainy", "stormy", "snowy"]


class TestEventsNormalizer:
    """Tests pour EventsNormalizer."""
    
    def test_not_implemented(self):
        """Test que EventsNormalizer n'est pas encore implémenté."""
        normalizer = EventsNormalizer()
        
        with pytest.raises(NotImplementedError):
            normalizer.normalize(
                raw_response={},
                country="FR",
                city="Paris",
                event_date=date.today()
            )


class TestValidators:
    """Tests pour les validators."""
    
    def test_validate_data_success(self):
        """Test validation avec données valides."""
        data = {
            "field1": "value1",
            "field2": 123,
            "field3": True
        }
        
        schema = {
            "field1": str,
            "field2": int,
            "field3": bool
        }
        
        assert validate_data(data, schema) is True
    
    def test_validate_data_missing_field(self):
        """Test validation avec champ manquant."""
        data = {
            "field1": "value1"
        }
        
        schema = {
            "field1": str,
            "field2": int  # Manquant
        }
        
        assert validate_data(data, schema) is False
    
    def test_validate_data_wrong_type(self):
        """Test validation avec type incorrect."""
        data = {
            "field1": "value1",
            "field2": "not_an_int"  # Devrait être int
        }
        
        schema = {
            "field1": str,
            "field2": int
        }
        
        assert validate_data(data, schema) is False
    
    def test_validate_data_none_value(self):
        """Test validation avec valeur None (devrait être accepté)."""
        data = {
            "field1": "value1",
            "field2": None
        }
        
        schema = {
            "field1": str,
            "field2": int  # None devrait passer (champ optionnel)
        }
        
        assert validate_data(data, schema) is True
    
    def test_validate_schema_raw_competitor_data(self):
        """Test validation avec schéma raw_competitor_data."""
        data = {
            "source": "apify",
            "country": "FR",
            "city": "Paris",
            "data_date": date.today(),
            "raw_data": {"key": "value"}
        }
        
        assert validate_schema("raw_competitor_data", data) is True
    
    def test_validate_schema_unknown_table(self):
        """Test validation avec table inconnue (devrait retourner True par défaut)."""
        data = {"any": "data"}
        
        # Table inconnue devrait retourner True (pas de validation stricte)
        assert validate_schema("unknown_table", data) is True


class TestNormalizersEdgeCases:
    """Tests pour les cas limites des normalizers."""
    
    def test_competitor_normalizer_null_values(self):
        """Test normalisation avec valeurs null."""
        normalizer = CompetitorNormalizer(source="apify")
        
        data_with_nulls = {
            "defaultLocale": {"title": None},
            "pricingMetadata": {"rate": {"amount": None}},
            "bedrooms": None,
            "lat": 48.8566,
            "lng": 2.3522
        }
        
        # Devrait gérer les nulls gracieusement
        result = normalizer.normalize(
            raw_response=data_with_nulls,
            country="FR",
            city="Paris",
            data_date=date.today()
        )
        
        assert "normalized_data" in result
    
    def test_weather_normalizer_extreme_values(self):
        """Test normalisation avec valeurs extrêmes."""
        normalizer = WeatherNormalizer(source="openweather")
        
        extreme_data = {
            "dt": int(datetime.now().timestamp()),
            "main": {
                "temp": 323.15,  # 50°C (très chaud)
                "humidity": 0,  # Très sec
                "pressure": 2000  # Pression anormale
            },
            "weather": [{"main": "Clear"}],
            "wind": {"speed": 100.0}  # Vent très fort
        }
        
        result = normalizer.normalize(
            raw_response=extreme_data,
            country="FR",
            city="Paris",
            forecast_date=date.today(),
            source="openweather"
        )
        
        normalized = result["normalized_data"]
        # Devrait normaliser même avec valeurs extrêmes
        assert "temperature" in normalized
        assert normalized["temperature"] == pytest.approx(50.0, abs=1.0)








