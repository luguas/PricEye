"""
Tests unitaires pour optimizer.py
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Ajouter le répertoire parent au path
sys.path.insert(0, str(Path(__file__).parent.parent))

from pricing_engine.optimizer import (
    choose_optimal_price,
    simulate_revenue_for_price_grid,
)


class TestSimulateRevenueForPriceGrid:
    """Tests pour simulate_revenue_for_price_grid."""
    
    @patch("pricing_engine.optimizer.predict_demand")
    def test_simulate_revenue_basic(self, mock_predict_demand):
        """Test de simulation de base."""
        # Configurer le mock
        mock_predict_demand.return_value = 2.0  # Demande prédite = 2
        
        property_id = "test-property"
        room_type = "default"
        date = "2024-01-01"
        price_grid = [100.0, 150.0, 200.0]
        capacity_remaining = 5
        context_features = {}
        
        results = simulate_revenue_for_price_grid(
            property_id=property_id,
            room_type=room_type,
            date=date,
            price_grid=price_grid,
            capacity_remaining=capacity_remaining,
            context_features=context_features,
        )
        
        # Vérifications
        assert len(results) == len(price_grid)
        assert all("price" in r for r in results)
        assert all("predicted_demand" in r for r in results)
        assert all("expected_revenue" in r for r in results)
        
        # Vérifier que le revenu est calculé correctement
        for i, result in enumerate(results):
            assert result["price"] == price_grid[i]
            assert result["predicted_demand"] == 2.0
            # Revenu = price * min(demande, capacité) = price * min(2, 5) = price * 2
            assert result["expected_revenue"] == price_grid[i] * 2.0
    
    @patch("pricing_engine.optimizer.predict_demand")
    def test_simulate_revenue_capacity_limit(self, mock_predict_demand):
        """Test avec limitation de capacité."""
        # Demande prédite supérieure à la capacité
        mock_predict_demand.return_value = 10.0
        
        price_grid = [100.0]
        capacity_remaining = 3
        
        results = simulate_revenue_for_price_grid(
            property_id="test",
            room_type="default",
            date="2024-01-01",
            price_grid=price_grid,
            capacity_remaining=capacity_remaining,
            context_features={},
        )
        
        # Le revenu devrait être limité par la capacité
        assert results[0]["predicted_demand"] == 10.0
        assert results[0]["expected_revenue"] == 100.0 * 3  # price * capacity


class TestChooseOptimalPrice:
    """Tests pour choose_optimal_price."""
    
    @patch("pricing_engine.optimizer.simulate_revenue_for_price_grid")
    def test_choose_optimal_price_basic(self, mock_simulate):
        """Test de sélection du prix optimal."""
        # Simuler des résultats de simulation
        mock_simulate.return_value = [
            {"price": 100.0, "predicted_demand": 2.0, "expected_revenue": 200.0},
            {"price": 150.0, "predicted_demand": 1.5, "expected_revenue": 225.0},  # Meilleur revenu
            {"price": 200.0, "predicted_demand": 1.0, "expected_revenue": 200.0},
        ]
        
        result = choose_optimal_price(
            property_id="test-property",
            room_type="default",
            date="2024-01-01",
            capacity_remaining=5,
            context_features={},
        )
        
        # Le prix optimal devrait être celui avec le meilleur revenu
        assert result["price"] == 150.0
        assert result["expected_revenue"] == 225.0
        assert result["predicted_demand"] == 1.5
    
    @patch("pricing_engine.optimizer.simulate_revenue_for_price_grid")
    def test_choose_optimal_price_with_constraints(self, mock_simulate):
        """Test avec contraintes de prix."""
        # Simuler des résultats
        mock_simulate.return_value = [
            {"price": 50.0, "predicted_demand": 3.0, "expected_revenue": 150.0},
            {"price": 100.0, "predicted_demand": 2.0, "expected_revenue": 200.0},
            {"price": 150.0, "predicted_demand": 1.5, "expected_revenue": 225.0},
        ]
        
        result = choose_optimal_price(
            property_id="test-property",
            room_type="default",
            date="2024-01-01",
            capacity_remaining=5,
            context_features={},
            min_price=80.0,  # Exclure 50.0
            max_price=120.0,  # Exclure 150.0
        )
        
        # Le prix optimal devrait être 100.0 (dans les contraintes)
        assert result["price"] == 100.0
        assert 80.0 <= result["price"] <= 120.0
    
    @patch("pricing_engine.optimizer.get_property_pricing_constraints")
    @patch("pricing_engine.optimizer.simulate_revenue_for_price_grid")
    def test_get_recommended_price_with_constraints(
        self,
        mock_simulate,
        mock_get_constraints,
    ):
        """Test de get_recommended_price avec contraintes de propriété."""
        from pricing_engine.optimizer import get_recommended_price
        
        # Configurer les mocks
        mock_get_constraints.return_value = {
            "floor_price": 80.0,
            "ceiling_price": 200.0,
            "base_price": 120.0,
        }
        
        mock_simulate.return_value = [
            {"price": 100.0, "predicted_demand": 2.0, "expected_revenue": 200.0},
            {"price": 120.0, "predicted_demand": 1.8, "expected_revenue": 216.0},
            {"price": 150.0, "predicted_demand": 1.5, "expected_revenue": 225.0},
        ]
        
        result = get_recommended_price(
            property_id="test-property",
            room_type="default",
            date="2024-01-01",
            capacity_remaining=5,
            context_features={},
        )
        
        # Vérifier que les contraintes sont utilisées
        assert mock_get_constraints.called
        assert result["price"] is not None
        assert 80.0 <= result["price"] <= 200.0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

