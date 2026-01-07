"""
Tests unitaires pour demand_model.py
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pandas as pd
import pytest

# Ajouter le répertoire parent au path
sys.path.insert(0, str(Path(__file__).parent.parent))

from pricing_engine.models.demand_model import (
    DemandModelConfig,
    DemandModelTrainer,
    DemandPredictor,
)


class TestDemandModelConfig:
    """Tests pour DemandModelConfig."""
    
    def test_default_config(self):
        """Test de la configuration par défaut."""
        config = DemandModelConfig()
        
        assert config.n_estimators == 300
        assert config.learning_rate == 0.05
        assert config.max_depth == 6
        assert config.subsample == 0.9
        assert config.colsample_bytree == 0.9
        assert config.random_state == 42
    
    def test_custom_config(self):
        """Test avec configuration personnalisée."""
        config = DemandModelConfig(
            n_estimators=100,
            learning_rate=0.1,
            max_depth=4,
        )
        
        assert config.n_estimators == 100
        assert config.learning_rate == 0.1
        assert config.max_depth == 4


class TestDemandModelTrainer:
    """Tests pour DemandModelTrainer."""
    
    @pytest.fixture
    def sample_dataset(self):
        """Dataset de test."""
        np.random.seed(42)
        n_samples = 100
        
        df = pd.DataFrame({
            "price": np.random.uniform(50, 200, n_samples),
            "competitor_avg_price": np.random.uniform(100, 150, n_samples),
            "market_demand_index": np.random.uniform(0.5, 1.0, n_samples),
            "day_of_week": np.random.randint(0, 7, n_samples),
            "month": np.random.randint(1, 13, n_samples),
            "y_demand": np.random.poisson(2, n_samples),  # Demande simulée
        })
        
        return df
    
    def test_trainer_initialization(self):
        """Test de l'initialisation du trainer."""
        trainer = DemandModelTrainer(
            property_id="test-property",
            config=DemandModelConfig(),
        )
        
        assert trainer.property_id == "test-property"
        assert trainer.config is not None
        assert trainer.model is None  # Pas encore entraîné
    
    def test_fit(self, sample_dataset):
        """Test de l'entraînement."""
        trainer = DemandModelTrainer(
            property_id="test-property",
            config=DemandModelConfig(n_estimators=10),  # Réduire pour les tests
        )
        
        # Séparer features et target
        feature_cols = [col for col in sample_dataset.columns if col != "y_demand"]
        X = sample_dataset[feature_cols]
        y = sample_dataset["y_demand"]
        
        # Split train/val
        split_idx = int(len(X) * 0.8)
        X_train, X_val = X[:split_idx], X[split_idx:]
        y_train, y_val = y[:split_idx], y[split_idx:]
        
        # Entraîner
        trainer.fit(X_train, y_train, X_val, y_val)
        
        # Vérifications
        assert trainer.model is not None
        assert trainer.train_rmse is not None
        assert trainer.val_rmse is not None
        assert trainer.train_rmse >= 0
        assert trainer.val_rmse >= 0
    
    def test_save_model(self, sample_dataset, tmp_path):
        """Test de la sauvegarde du modèle."""
        from pricing_engine.models.demand_model import MODELS_DIR
        
        # Utiliser un répertoire temporaire
        import shutil
        if MODELS_DIR.exists():
            backup_dir = tmp_path / "backup"
            backup_dir.mkdir()
            shutil.copytree(MODELS_DIR, backup_dir / "models")
        
        trainer = DemandModelTrainer(
            property_id="test-save-property",
            config=DemandModelConfig(n_estimators=10),
        )
        
        # Entraîner
        feature_cols = [col for col in sample_dataset.columns if col != "y_demand"]
        X = sample_dataset[feature_cols]
        y = sample_dataset["y_demand"]
        
        split_idx = int(len(X) * 0.8)
        X_train, X_val = X[:split_idx], X[split_idx:]
        y_train, y_val = y[:split_idx], y[split_idx:]
        
        trainer.fit(X_train, y_train, X_val, y_val)
        
        # Sauvegarder
        trainer.save_model()
        
        # Vérifier que les fichiers existent
        model_path = MODELS_DIR / "demand_model_test-save-property.json"
        meta_path = MODELS_DIR / "demand_model_test-save-property.meta.json"
        
        assert model_path.exists(), "Fichier modèle non créé"
        assert meta_path.exists(), "Fichier meta non créé"


class TestDemandPredictor:
    """Tests pour DemandPredictor."""
    
    @pytest.fixture
    def trained_model_path(self, tmp_path):
        """Crée un modèle entraîné pour les tests."""
        from pricing_engine.models.demand_model import MODELS_DIR
        
        # Créer un modèle simple
        from xgboost import XGBRegressor
        
        model = XGBRegressor(n_estimators=5, random_state=42)
        X_train = np.random.rand(10, 3)
        y_train = np.random.poisson(2, 10)
        model.fit(X_train, y_train)
        
        # Sauvegarder
        property_id = "test-predict-property"
        model_path = MODELS_DIR / f"demand_model_{property_id}.json"
        meta_path = MODELS_DIR / f"demand_model_{property_id}.meta.json"
        
        model.save_model(str(model_path))
        
        # Créer le fichier meta
        import json
        meta = {
            "property_id": property_id,
            "feature_columns": ["feature_0", "feature_1", "feature_2"],
            "config": {},
        }
        meta_path.write_text(json.dumps(meta), encoding="utf-8")
        
        return property_id
    
    def test_predictor_load(self, trained_model_path):
        """Test du chargement du modèle."""
        predictor = DemandPredictor(property_id=trained_model_path)
        
        assert predictor.model is not None
        assert predictor.feature_columns is not None
        assert len(predictor.feature_columns) > 0
    
    def test_predict(self, trained_model_path):
        """Test de la prédiction."""
        predictor = DemandPredictor(property_id=trained_model_path)
        
        # Créer des features de test
        context_features = {
            "feature_0": 1.0,
            "feature_1": 2.0,
            "feature_2": 3.0,
        }
        
        prediction = predictor.predict(context_features)
        
        assert prediction is not None
        assert isinstance(prediction, (int, float))
        assert prediction >= 0  # La demande ne peut pas être négative


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

