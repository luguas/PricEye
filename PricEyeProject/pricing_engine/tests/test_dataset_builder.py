"""
Tests unitaires pour dataset_builder.py
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pandas as pd
import pytest

# Ajouter le répertoire parent au path
sys.path.insert(0, str(Path(__file__).parent.parent))

from pricing_engine.dataset_builder import build_pricing_dataset


class TestDatasetBuilder:
    """Tests pour build_pricing_dataset."""
    
    @pytest.fixture
    def mock_supabase_client(self):
        """Mock du client Supabase."""
        client = MagicMock()
        return client
    
    @pytest.fixture
    def sample_internal_data(self):
        """Données internes de test."""
        return [
            {
                "date": "2024-01-01",
                "bookings": 2,
                "price_override": 150.0,
                "capacity": 4,
            },
            {
                "date": "2024-01-02",
                "bookings": 1,
                "price_override": None,
                "capacity": 4,
            },
        ]
    
    @pytest.fixture
    def sample_market_features(self):
        """Features marché de test."""
        return [
            {
                "property_id": "test-property",
                "date": "2024-01-01",
                "competitor_avg_price": 140.0,
                "competitor_min_price": 120.0,
                "competitor_max_price": 160.0,
                "market_demand_index": 0.8,
            },
            {
                "property_id": "test-property",
                "date": "2024-01-02",
                "competitor_avg_price": 145.0,
                "competitor_min_price": 125.0,
                "competitor_max_price": 165.0,
                "market_demand_index": 0.9,
            },
        ]
    
    @patch("pricing_engine.dataset_builder.get_internal_pricing_data")
    @patch("pricing_engine.dataset_builder.get_market_pricing_features_for_property_date_range")
    def test_build_pricing_dataset_success(
        self,
        mock_market_features,
        mock_internal_data,
        sample_internal_data,
        sample_market_features,
    ):
        """Test de construction réussie du dataset."""
        # Configurer les mocks
        mock_internal_data.return_value = sample_internal_data
        mock_market_features.return_value = sample_market_features
        
        # Appeler la fonction
        df = build_pricing_dataset(
            property_id="test-property",
            start_date="2024-01-01",
            end_date="2024-01-02",
        )
        
        # Vérifications
        assert df is not None
        assert isinstance(df, pd.DataFrame)
        assert len(df) == 2
        assert "y_demand" in df.columns
        assert "date" in df.columns
        
        # Vérifier que les colonnes attendues sont présentes
        expected_cols = ["date", "y_demand", "bookings", "capacity"]
        for col in expected_cols:
            assert col in df.columns, f"Colonne {col} manquante"
    
    @patch("pricing_engine.dataset_builder.get_internal_pricing_data")
    @patch("pricing_engine.dataset_builder.get_market_pricing_features_for_property_date_range")
    def test_build_pricing_dataset_empty_internal(
        self,
        mock_market_features,
        mock_internal_data,
    ):
        """Test avec données internes vides."""
        mock_internal_data.return_value = []
        mock_market_features.return_value = []
        
        df = build_pricing_dataset(
            property_id="test-property",
            start_date="2024-01-01",
            end_date="2024-01-02",
        )
        
        # Le dataset devrait être vide ou None
        assert df is None or df.empty
    
    @patch("pricing_engine.dataset_builder.get_internal_pricing_data")
    @patch("pricing_engine.dataset_builder.get_market_pricing_features_for_property_date_range")
    def test_build_pricing_dataset_with_missing_market_features(
        self,
        mock_market_features,
        mock_internal_data,
        sample_internal_data,
    ):
        """Test avec features marché manquantes."""
        mock_internal_data.return_value = sample_internal_data
        mock_market_features.return_value = []  # Pas de features marché
        
        df = build_pricing_dataset(
            property_id="test-property",
            start_date="2024-01-01",
            end_date="2024-01-02",
        )
        
        # Le dataset devrait quand même être construit avec les données internes
        assert df is not None
        assert len(df) == 2
    
    def test_build_pricing_dataset_invalid_dates(self):
        """Test avec dates invalides."""
        with pytest.raises((ValueError, TypeError)):
            build_pricing_dataset(
                property_id="test-property",
                start_date="invalid-date",
                end_date="2024-01-02",
            )


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

