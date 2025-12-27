"""
Fixtures partagées pour les tests.
"""

import pytest
import asyncio
from unittest.mock import Mock, AsyncMock, MagicMock
from datetime import date, datetime, timedelta
from typing import Dict, Any, List, Optional

# Mock Supabase client
@pytest.fixture
def mock_supabase_client():
    """Mock du client Supabase."""
    client = Mock()
    client.table.return_value = Mock()
    return client

# Mock Settings
@pytest.fixture
def mock_settings():
    """Mock des settings."""
    settings = Mock()
    settings.supabase_url = "https://mock.supabase.co"
    settings.supabase_key = "mock_key"
    settings.environment = "test"
    return settings

# Mock Rate Limiter
@pytest.fixture
def mock_rate_limiter():
    """Mock du rate limiter."""
    limiter = AsyncMock()
    limiter.acquire = AsyncMock(return_value=None)
    return limiter

# Sample data fixtures
@pytest.fixture
def sample_competitor_data():
    """Données de test pour un concurrent."""
    return {
        "listing_id": "12345",
        "title": "Beautiful apartment in Paris",
        "price": 150.0,
        "bedrooms": 2,
        "bathrooms": 1,
        "accommodates": 4,
        "property_type": "Apartment",
        "latitude": 48.8566,
        "longitude": 2.3522,
        "neighborhood": "Le Marais",
        "amenities": ["WiFi", "Kitchen", "TV"],
        "description": "A lovely apartment in the heart of Paris"
    }

@pytest.fixture
def sample_apify_response():
    """Réponse mockée d'Apify."""
    return {
        "defaultLocale": {
            "title": "Beautiful apartment in Paris",
            "description": "A lovely apartment in the heart of Paris",
            "localizedCityName": "Paris"
        },
        "pricingMetadata": {
            "rate": {"amount": 150.0}
        },
        "roomAndPropertyType": {
            "roomTypeCategory": "entire_home",
            "roomType": "Entire apartment"
        },
        "bedrooms": 2,
        "bathrooms": 1,
        "personCapacity": 4,
        "lat": 48.8566,
        "lng": 2.3522,
        "publicAddress": {"subtitle": "Le Marais"},
        "listingAmenityNames": ["WiFi", "Kitchen", "TV"]
    }

@pytest.fixture
def sample_weather_data():
    """Données de test pour la météo."""
    return {
        "temperature": 20.5,
        "humidity": 65,
        "weather_condition": "clear",
        "wind_speed": 10.0,
        "precipitation": 0.0
    }

@pytest.fixture
def sample_event_data():
    """Données de test pour un événement."""
    return {
        "event_id": "evt_123",
        "title": "Music Festival in Paris",
        "description": "Annual music festival",
        "start_date": datetime.now() + timedelta(days=7),
        "end_date": datetime.now() + timedelta(days=9),
        "location": "Paris, France",
        "category": "festival",
        "attendees": 50000
    }

@pytest.fixture
def sample_news_data():
    """Données de test pour une news."""
    return {
        "article_id": "news_123",
        "title": "Tourism increases in Paris",
        "description": "Tourism sector sees growth",
        "published_at": datetime.now() - timedelta(days=1),
        "source": "Reuters",
        "url": "https://example.com/news",
        "content": "Tourism in Paris has increased significantly..."
    }

@pytest.fixture
def sample_property_data():
    """Données de test pour une propriété."""
    return {
        "id": "prop_123",
        "country": "FR",
        "city": "Paris",
        "neighborhood": "Le Marais",
        "property_type": "apartment",
        "bedrooms": 2,
        "bathrooms": 1,
        "accommodates": 4,
        "latitude": 48.8566,
        "longitude": 2.3522,
        "description": "Beautiful apartment in Paris"
    }

@pytest.fixture
def sample_raw_competitor_data():
    """Données normalisées pour raw_competitor_data."""
    return {
        "source": "apify",
        "country": "FR",
        "city": "Paris",
        "data_date": date.today(),
        "raw_data": {
            "listing_id": "12345",
            "title": "Beautiful apartment",
            "price": 150.0
        },
        "normalized_data": {
            "listing_id": "12345",
            "price": 150.0,
            "bedrooms": 2,
            "bathrooms": 1
        }
    }

# Async test fixture
@pytest.fixture
def event_loop():
    """Event loop pour les tests async."""
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()

# Mock HTTP session
@pytest.fixture
def mock_aiohttp_session():
    """Mock d'une session aiohttp."""
    session = AsyncMock()
    session.get = AsyncMock()
    session.post = AsyncMock()
    session.close = AsyncMock()
    return session

