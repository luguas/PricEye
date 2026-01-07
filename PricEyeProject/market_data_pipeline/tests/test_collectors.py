"""
Tests unitaires pour les collecteurs de données.
"""

import pytest
import asyncio
from unittest.mock import Mock, AsyncMock, patch, MagicMock
from datetime import date, datetime, timedelta
from typing import Dict, Any, List

from market_data_pipeline.collectors.base_collector import BaseCollector
from market_data_pipeline.collectors.competitor_collector import CompetitorCollector
from market_data_pipeline.collectors.weather_collector import WeatherCollector
from market_data_pipeline.normalizers.competitor_normalizer import CompetitorNormalizer
from market_data_pipeline.normalizers.weather_normalizer import WeatherNormalizer


class TestBaseCollector:
    """Tests pour BaseCollector."""
    
    @pytest.mark.asyncio
    async def test_context_manager(self, mock_settings, mock_rate_limiter):
        """Test du context manager (async with)."""
        class ConcreteCollector(BaseCollector):
            async def _fetch_data(self, *args, **kwargs):
                return []
        
        async with ConcreteCollector(
            source_name="test_source",
            settings=mock_settings,
            rate_limiter=mock_rate_limiter
        ) as collector:
            assert collector.session is not None
            assert collector.source_name == "test_source"
    
    @pytest.mark.asyncio
    async def test_rate_limiting(self, mock_settings, mock_rate_limiter):
        """Test que le rate limiter est appelé."""
        class ConcreteCollector(BaseCollector):
            async def _fetch_data(self, *args, **kwargs):
                return []
        
        collector = ConcreteCollector(
            source_name="test_source",
            settings=mock_settings,
            rate_limiter=mock_rate_limiter
        )
        
        await collector.collect(store_in_db=False)
        mock_rate_limiter.acquire.assert_called_once()
    
    @pytest.mark.asyncio
    async def test_retry_on_failure(self, mock_settings):
        """Test du retry avec exponential backoff."""
        class FailingCollector(BaseCollector):
            call_count = 0
            
            async def _fetch_data(self, *args, **kwargs):
                self.call_count += 1
                if self.call_count < 3:
                    raise Exception("Temporary error")
                return [{"data": "success"}]
        
        collector = FailingCollector(
            source_name="test_source",
            settings=mock_settings
        )
        
        # Ne devrait pas lever d'exception après retries
        result = await collector.collect(store_in_db=False)
        assert len(result) > 0
        assert collector.call_count == 3


class TestCompetitorCollector:
    """Tests pour CompetitorCollector."""
    
    @pytest.mark.asyncio
    async def test_init_without_apify(self, mock_settings):
        """Test initialisation sans Apify."""
        with patch('market_data_pipeline.collectors.competitor_collector.APIFY_AVAILABLE', False):
            with pytest.raises(ImportError):
                CompetitorCollector(settings=mock_settings)
    
    @pytest.mark.asyncio
    @patch('market_data_pipeline.collectors.competitor_collector.APIFY_AVAILABLE', True)
    @patch('market_data_pipeline.collectors.competitor_collector.ApifyClient')
    async def test_collect_success(self, mock_apify_client_class, mock_settings, sample_apify_response):
        """Test collecte réussie avec Apify."""
        # Mock Apify client
        mock_client = Mock()
        mock_run = Mock()
        mock_run.get.return_value = {
            "status": "SUCCEEDED",
            "defaultDatasetId": "dataset_123"
        }
        mock_dataset = Mock()
        mock_dataset.iterate_items.return_value = [sample_apify_response]
        mock_client.runs.return_value = mock_run
        mock_client.dataset.return_value = mock_dataset
        mock_apify_client_class.return_value = mock_client
        
        collector = CompetitorCollector(
            api_token="test_token",
            settings=mock_settings
        )
        
        result = await collector.collect(
            city="Paris",
            country="FR",
            store_in_db=False
        )
        
        assert len(result) > 0
        assert "normalized_data" in result[0]
    
    @pytest.mark.asyncio
    @patch('market_data_pipeline.collectors.competitor_collector.APIFY_AVAILABLE', True)
    @patch('market_data_pipeline.collectors.competitor_collector.ApifyClient')
    async def test_collect_api_error(self, mock_apify_client_class, mock_settings):
        """Test gestion d'erreur API Apify."""
        mock_client = Mock()
        mock_run = Mock()
        mock_run.get.return_value = {
            "status": "FAILED",
            "statusMessage": "API error"
        }
        mock_client.runs.return_value = mock_run
        mock_apify_client_class.return_value = mock_client
        
        collector = CompetitorCollector(
            api_token="test_token",
            settings=mock_settings
        )
        
        # Devrait lever une exception ou retourner une liste vide
        with pytest.raises(Exception):
            await collector.collect(
                city="Paris",
                country="FR",
                store_in_db=False
            )
    
    @pytest.mark.asyncio
    @patch('market_data_pipeline.collectors.competitor_collector.APIFY_AVAILABLE', True)
    async def test_collect_without_token(self, mock_settings):
        """Test collecte sans token API."""
        collector = CompetitorCollector(settings=mock_settings)
        
        # Devrait gérer l'absence de token
        with pytest.raises(Exception):
            await collector.collect(
                city="Paris",
                country="FR",
                store_in_db=False
            )


class TestWeatherCollector:
    """Tests pour WeatherCollector."""
    
    @pytest.mark.asyncio
    @patch('aiohttp.ClientSession')
    async def test_collect_openweather_success(self, mock_session_class, mock_settings, sample_weather_data):
        """Test collecte réussie avec OpenWeatherMap."""
        # Mock response
        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.json = AsyncMock(return_value={
            "list": [
                {
                    "dt": int(datetime.now().timestamp()),
                    "main": {
                        "temp": 293.15,  # 20°C en Kelvin
                        "humidity": 65
                    },
                    "weather": [{"main": "Clear"}],
                    "wind": {"speed": 10.0},
                    "rain": {"3h": 0.0}
                }
            ]
        })
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=None)
        
        mock_session = AsyncMock()
        mock_session.get.return_value = mock_response
        mock_session_class.return_value.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session_class.return_value.__aexit__ = AsyncMock(return_value=None)
        
        collector = WeatherCollector(
            primary_source="openweather",
            api_key="test_key",
            settings=mock_settings
        )
        collector.session = mock_session
        
        result = await collector.collect(
            city="Paris",
            country="FR",
            store_in_db=False
        )
        
        assert len(result) > 0
        assert "temperature" in result[0].get("normalized_data", {})
    
    @pytest.mark.asyncio
    @patch('aiohttp.ClientSession')
    async def test_fallback_to_secondary_source(self, mock_session_class, mock_settings):
        """Test fallback vers source secondaire si primaire échoue."""
        # Mock primary source failure
        mock_response_fail = AsyncMock()
        mock_response_fail.status = 500
        mock_response_fail.__aenter__ = AsyncMock(return_value=mock_response_fail)
        mock_response_fail.__aexit__ = AsyncMock(return_value=None)
        
        # Mock fallback source success
        mock_response_success = AsyncMock()
        mock_response_success.status = 200
        mock_response_success.json = AsyncMock(return_value={
            "forecast": {
                "forecastday": [{
                    "date": date.today().isoformat(),
                    "day": {
                        "avgtemp_c": 20.5,
                        "avghumidity": 65,
                        "condition": {"text": "Clear"},
                        "maxwind_kph": 10.0,
                        "totalprecip_mm": 0.0
                    }
                }]
            }
        })
        mock_response_success.__aenter__ = AsyncMock(return_value=mock_response_success)
        mock_response_success.__aexit__ = AsyncMock(return_value=None)
        
        mock_session = AsyncMock()
        # Premier appel échoue, deuxième réussit
        mock_session.get.side_effect = [mock_response_fail, mock_response_success]
        mock_session_class.return_value.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session_class.return_value.__aexit__ = AsyncMock(return_value=None)
        
        collector = WeatherCollector(
            primary_source="openweather",
            fallback_source="weatherapi",
            api_key="test_key",
            settings=mock_settings
        )
        collector.session = mock_session
        
        result = await collector.collect(
            city="Paris",
            country="FR",
            store_in_db=False
        )
        
        # Devrait utiliser le fallback
        assert len(result) > 0
        assert mock_session.get.call_count >= 2  # Au moins 2 appels (primaire + fallback)


class TestNormalizers:
    """Tests pour les normalizers."""
    
    def test_competitor_normalizer_apify(self, sample_apify_response):
        """Test normalisation des données Apify."""
        normalizer = CompetitorNormalizer(source="apify")
        
        result = normalizer.normalize(
            raw_response=sample_apify_response,
            country="FR",
            city="Paris",
            data_date=date.today()
        )
        
        assert "normalized_data" in result
        assert "listing_id" in result["normalized_data"] or "property_id" in result["normalized_data"]
        assert "price" in result["normalized_data"]
        assert result["country"] == "FR"
        assert result["city"] == "Paris"
    
    def test_competitor_normalizer_airdna_csv(self):
        """Test normalisation des données AirDNA CSV."""
        normalizer = CompetitorNormalizer(source="airdna")
        
        csv_data = {
            "property_id": "12345",
            "listing_price": 150.0,
            "bedrooms": 2,
            "bathrooms": 1,
            "accommodates": 4,
            "property_type": "Apartment",
            "latitude": 48.8566,
            "longitude": 2.3522
        }
        
        result = normalizer.normalize(
            raw_response=csv_data,
            country="FR",
            city="Paris",
            data_date=date.today()
        )
        
        assert "normalized_data" in result
        assert "price" in result["normalized_data"]
        assert result["normalized_data"]["bedrooms"] == 2
    
    def test_competitor_normalizer_invalid_data(self):
        """Test normalisation avec données invalides."""
        normalizer = CompetitorNormalizer()
        
        # Données manquantes
        invalid_data = {}
        
        with pytest.raises((ValueError, KeyError)):
            normalizer.normalize(
                raw_response=invalid_data,
                country="FR",
                city="Paris",
                data_date=date.today()
            )
    
    def test_weather_normalizer_openweather(self):
        """Test normalisation des données OpenWeatherMap."""
        normalizer = WeatherNormalizer()
        
        raw_data = {
            "dt": int(datetime.now().timestamp()),
            "main": {
                "temp": 293.15,  # 20°C
                "humidity": 65
            },
            "weather": [{"main": "Clear"}],
            "wind": {"speed": 10.0},
            "rain": {"3h": 0.0}
        }
        
        result = normalizer.normalize(
            raw_response=raw_data,
            country="FR",
            city="Paris",
            data_date=date.today(),
            source="openweather"
        )
        
        assert "normalized_data" in result
        assert "temperature" in result["normalized_data"]
        assert result["normalized_data"]["temperature"] == pytest.approx(20.0, abs=1.0)  # ~20°C
        assert "humidity" in result["normalized_data"]
        assert result["normalized_data"]["humidity"] == 65


class TestEdgeCases:
    """Tests pour les cas limites."""
    
    @pytest.mark.asyncio
    async def test_collect_with_empty_locations(self, mock_settings):
        """Test collecte avec liste de locations vide."""
        class ConcreteCollector(BaseCollector):
            async def _fetch_data(self, *args, **kwargs):
                return []
        
        collector = ConcreteCollector(
            source_name="test_source",
            settings=mock_settings
        )
        
        result = await collector.collect(
            locations=[],
            store_in_db=False
        )
        
        assert result == []
    
    @pytest.mark.asyncio
    async def test_collect_with_invalid_date_range(self, mock_settings):
        """Test collecte avec plage de dates invalide."""
        class ConcreteCollector(BaseCollector):
            async def _fetch_data(self, *args, **kwargs):
                return []
        
        collector = ConcreteCollector(
            source_name="test_source",
            settings=mock_settings
        )
        
        # Date de fin avant date de début
        invalid_range = {
            "start_date": date.today(),
            "end_date": date.today() - timedelta(days=1)
        }
        
        # Devrait gérer gracieusement ou lever une exception
        result = await collector.collect(
            date_range=invalid_range,
            store_in_db=False
        )
        
        # Devrait retourner une liste vide ou gérer l'erreur
        assert isinstance(result, list)








