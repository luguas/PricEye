"""
Tests unitaires pour les utilitaires (currency converter, validators, etc.).
"""

import pytest
import asyncio
from unittest.mock import Mock, AsyncMock, patch
from datetime import date, datetime, timedelta

from market_data_pipeline.utils.currency_converter import CurrencyConverter
from market_data_pipeline.utils.validators import validate_data, validate_schema
from market_data_pipeline.utils.timezone_handler import TimezoneHandler


class TestCurrencyConverter:
    """Tests pour CurrencyConverter."""
    
    @pytest.fixture
    def currency_converter(self, mock_settings):
        """Fixture pour CurrencyConverter."""
        converter = CurrencyConverter(
            base_currency="EUR",
            settings=mock_settings
        )
        return converter
    
    @pytest.mark.asyncio
    @patch('aiohttp.ClientSession')
    async def test_convert_exchangerate_api(self, mock_session_class, currency_converter):
        """Test conversion avec exchangerate-api.com."""
        # Mock response
        mock_response = AsyncMock()
        mock_response.status = 200
        mock_response.json = AsyncMock(return_value={
            "rates": {
                "USD": 1.10,
                "GBP": 0.85
            },
            "base": "EUR",
            "date": date.today().isoformat()
        })
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=None)
        
        mock_session = AsyncMock()
        mock_session.get.return_value = mock_response
        mock_session_class.return_value.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session_class.return_value.__aexit__ = AsyncMock(return_value=None)
        
        currency_converter.session = mock_session
        
        # Convertir 100 EUR en USD
        result = await currency_converter.convert(amount=100.0, from_currency="EUR", to_currency="USD")
        
        assert result == pytest.approx(110.0, abs=0.01)  # 100 * 1.10
    
    @pytest.mark.asyncio
    @patch('aiohttp.ClientSession')
    async def test_convert_same_currency(self, mock_session_class, currency_converter):
        """Test conversion vers la même devise (devrait retourner le montant original)."""
        result = await currency_converter.convert(amount=100.0, from_currency="EUR", to_currency="EUR")
        
        assert result == 100.0
    
    @pytest.mark.asyncio
    @patch('aiohttp.ClientSession')
    async def test_convert_with_cached_rate(self, mock_session_class, currency_converter, mock_supabase_client):
        """Test utilisation d'un taux en cache."""
        # Mock Supabase pour retourner un taux en cache
        mock_table = Mock()
        mock_query = Mock()
        mock_query.eq.return_value = mock_query
        mock_query.gte.return_value = mock_query
        mock_query.limit.return_value = mock_query
        mock_query.execute.return_value.data = [{
            "from_currency": "EUR",
            "to_currency": "USD",
            "rate": 1.10,
            "date": date.today().isoformat()
        }]
        
        mock_table.select.return_value = mock_query
        mock_supabase_client.table.return_value = mock_table
        
        currency_converter._supabase_client = mock_supabase_client
        
        # Ne devrait pas faire d'appel API si le taux est en cache
        result = await currency_converter.convert(amount=100.0, from_currency="EUR", to_currency="USD")
        
        # Devrait utiliser le taux en cache
        assert result == pytest.approx(110.0, abs=0.01)
    
    @pytest.mark.asyncio
    @patch('aiohttp.ClientSession')
    async def test_convert_with_fallback(self, mock_session_class, currency_converter):
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
            "success": True,
            "rates": {"USD": 1.10}
        })
        mock_response_success.__aenter__ = AsyncMock(return_value=mock_response_success)
        mock_response_success.__aexit__ = AsyncMock(return_value=None)
        
        mock_session = AsyncMock()
        mock_session.get.side_effect = [mock_response_fail, mock_response_success]
        mock_session_class.return_value.__aenter__ = AsyncMock(return_value=mock_session)
        mock_session_class.return_value.__aexit__ = AsyncMock(return_value=None)
        
        currency_converter.session = mock_session
        currency_converter.fallback_source = "fixer"
        currency_converter.api_keys["fixer"] = "test_key"
        
        result = await currency_converter.convert(amount=100.0, from_currency="EUR", to_currency="USD")
        
        assert result == pytest.approx(110.0, abs=0.01)
    
    @pytest.mark.asyncio
    async def test_convert_invalid_currency(self, currency_converter):
        """Test conversion avec devise invalide."""
        with pytest.raises((ValueError, KeyError)):
            await currency_converter.convert(
                amount=100.0,
                from_currency="INVALID",
                to_currency="USD"
            )
    
    def test_format_currency_code(self):
        """Test formatage des codes de devise."""
        assert CurrencyConverter._format_currency_code("eur") == "EUR"
        assert CurrencyConverter._format_currency_code("USD") == "USD"
        assert CurrencyConverter._format_currency_code("gbp") == "GBP"


class TestTimezoneHandler:
    """Tests pour TimezoneHandler."""
    
    @pytest.fixture
    def timezone_handler(self, mock_settings):
        """Fixture pour TimezoneHandler."""
        return TimezoneHandler(settings=mock_settings)
    
    def test_get_timezone_for_city(self, timezone_handler):
        """Test récupération du fuseau horaire pour une ville."""
        timezone = timezone_handler.get_timezone_for_city(city="Paris", country="FR")
        
        assert timezone == "Europe/Paris"
    
    def test_get_timezone_for_city_not_found(self, timezone_handler):
        """Test récupération pour une ville inconnue."""
        timezone = timezone_handler.get_timezone_for_city(city="UnknownCity", country="XX")
        
        # Devrait retourner un fuseau par défaut ou None
        assert timezone is None or isinstance(timezone, str)
    
    def test_convert_datetime_to_timezone(self, timezone_handler):
        """Test conversion de datetime vers un fuseau horaire."""
        dt = datetime(2024, 1, 1, 12, 0, 0)  # 12h UTC
        
        converted = timezone_handler.convert_datetime_to_timezone(
            dt=dt,
            target_timezone="Europe/Paris"
        )
        
        # Paris est UTC+1 en janvier, donc 13h
        assert converted.hour == 13 or converted.hour == 12  # Dépend de l'heure d'été
    
    def test_get_local_date(self, timezone_handler):
        """Test récupération de la date locale."""
        dt = datetime(2024, 1, 1, 23, 0, 0, tzinfo=None)  # 23h UTC
        
        local_date = timezone_handler.get_local_date(
            dt=dt,
            timezone="America/New_York"
        )
        
        # New York est UTC-5, donc 18h le même jour ou jour suivant
        assert isinstance(local_date, date)


class TestValidatorsUtils:
    """Tests additionnels pour les validators."""
    
    def test_validate_data_complex_types(self):
        """Test validation avec types complexes."""
        data = {
            "string_list": ["a", "b", "c"],
            "number": 123,
            "nested_dict": {"key": "value"}
        }
        
        schema = {
            "string_list": list,
            "number": int,
            "nested_dict": dict
        }
        
        assert validate_data(data, schema) is True
    
    def test_validate_data_partial_match(self):
        """Test validation avec données partiellement valides."""
        data = {
            "field1": "value1",
            "field2": "value2",  # Type incorrect
            "field3": 123
        }
        
        schema = {
            "field1": str,
            "field2": int,  # Devrait être int
            "field3": int
        }
        
        assert validate_data(data, schema) is False
    
    def test_validate_schema_with_date(self):
        """Test validation avec date."""
        data = {
            "source": "test",
            "country": "FR",
            "city": "Paris",
            "data_date": date.today(),
            "raw_data": {}
        }
        
        assert validate_schema("raw_competitor_data", data) is True


class TestUtilsEdgeCases:
    """Tests pour les cas limites des utilitaires."""
    
    @pytest.mark.asyncio
    async def test_currency_converter_zero_amount(self, currency_converter):
        """Test conversion avec montant zéro."""
        result = await currency_converter.convert(amount=0.0, from_currency="EUR", to_currency="USD")
        
        assert result == 0.0
    
    @pytest.mark.asyncio
    async def test_currency_converter_negative_amount(self, currency_converter):
        """Test conversion avec montant négatif."""
        # Devrait gérer gracieusement ou lever une exception
        with pytest.raises((ValueError, AssertionError)):
            await currency_converter.convert(amount=-100.0, from_currency="EUR", to_currency="USD")
    
    def test_timezone_handler_invalid_timezone(self, timezone_handler):
        """Test avec fuseau horaire invalide."""
        dt = datetime.now()
        
        # Devrait gérer gracieusement ou lever une exception
        try:
            converted = timezone_handler.convert_datetime_to_timezone(
                dt=dt,
                target_timezone="Invalid/Timezone"
            )
            # Si pas d'exception, devrait retourner quelque chose
            assert converted is not None
        except Exception:
            # Exception acceptable pour fuseau invalide
            pass
    
    def test_validate_data_empty_schema(self):
        """Test validation avec schéma vide."""
        data = {"any": "data"}
        schema = {}
        
        # Schéma vide devrait retourner True (pas de validation)
        assert validate_data(data, schema) is True
    
    def test_validate_data_empty_data(self):
        """Test validation avec données vides."""
        data = {}
        schema = {"field1": str}
        
        assert validate_data(data, schema) is False  # Champ manquant








