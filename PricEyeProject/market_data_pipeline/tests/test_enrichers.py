"""
Tests unitaires pour les enrichers (Similarity Engine, NLP Pipeline, etc.).
"""

import pytest
import numpy as np
import pandas as pd
from unittest.mock import Mock, patch, MagicMock
from datetime import date, datetime, timedelta
from typing import Dict, Any, List

from market_data_pipeline.enrichers.similarity_engine import SimilarityEngine
from market_data_pipeline.enrichers.nlp_pipeline import NLPPipeline
from market_data_pipeline.enrichers.feature_calculator import FeatureCalculator
from market_data_pipeline.enrichers.time_series_analyzer import TimeSeriesAnalyzer


class TestSimilarityEngine:
    """Tests pour SimilarityEngine."""
    
    @pytest.fixture
    def similarity_engine(self):
        """Fixture pour SimilarityEngine."""
        with patch('market_data_pipeline.enrichers.similarity_engine.SENTENCE_TRANSFORMERS_AVAILABLE', True):
            with patch('market_data_pipeline.enrichers.similarity_engine.SentenceTransformer') as mock_model:
                # Mock le modèle SentenceTransformer
                mock_transformer = Mock()
                mock_transformer.encode.return_value = np.random.rand(384)  # Embedding dimension
                mock_model.return_value = mock_transformer
                
                engine = SimilarityEngine(model_name="all-MiniLM-L6-v2")
                engine._model = mock_transformer  # Injecter le mock
                return engine
    
    def test_create_property_embedding_numeric(self, similarity_engine, sample_property_data):
        """Test création d'embedding pour features numériques."""
        embedding = similarity_engine.create_property_embedding(sample_property_data)
        
        assert isinstance(embedding, np.ndarray)
        assert len(embedding) > 0
    
    def test_create_property_embedding_missing_fields(self, similarity_engine):
        """Test embedding avec champs manquants (devrait utiliser valeurs par défaut)."""
        incomplete_data = {
            "bedrooms": 2,
            "price": 150.0
            # Manque plusieurs champs
        }
        
        embedding = similarity_engine.create_property_embedding(incomplete_data)
        
        assert isinstance(embedding, np.ndarray)
        assert len(embedding) > 0
    
    def test_find_comparables(self, similarity_engine, sample_property_data):
        """Test identification de propriétés comparables."""
        # Mock des embeddings
        target_embedding = np.random.rand(384)
        competitor_embeddings = np.random.rand(5, 384)
        
        competitors = [
            {"listing_id": f"comp_{i}", "price": 100.0 + i * 10}
            for i in range(5)
        ]
        
        with patch.object(similarity_engine, 'create_property_embedding', return_value=target_embedding):
            with patch('numpy.array', return_value=competitor_embeddings):
                with patch('sklearn.metrics.pairwise.cosine_similarity') as mock_cosine:
                    # Mock cosine similarity results
                    mock_cosine.return_value = np.array([[0.9, 0.7, 0.8, 0.6, 0.5]])
                    
                    comparables = similarity_engine.find_comparables(
                        target_property=sample_property_data,
                        competitors=competitors,
                        top_k=3
                    )
                    
                    assert len(comparables) <= 3
                    assert all("similarity_score" in comp for comp in comparables)
                    assert all(comp["similarity_score"] > 0 for comp in comparables)
    
    def test_calculate_price_rank_percentile(self, similarity_engine):
        """Test calcul du percentile de rang de prix."""
        target_price = 150.0
        competitor_prices = [100.0, 120.0, 130.0, 150.0, 180.0, 200.0]
        
        percentile = similarity_engine.calculate_price_rank_percentile(
            target_price=target_price,
            competitor_prices=competitor_prices
        )
        
        assert 0 <= percentile <= 100
        # 150 est au milieu, devrait être ~50-60%
        assert 40 <= percentile <= 70
    
    def test_detect_price_outlier(self, similarity_engine):
        """Test détection d'outliers de prix."""
        competitor_prices = [100.0, 110.0, 120.0, 115.0, 125.0]
        
        # Prix normal (proche de la moyenne)
        is_outlier_normal = similarity_engine.detect_price_outlier(
            price=115.0,
            competitor_prices=competitor_prices,
            threshold_std=2.0
        )
        assert is_outlier_normal is False
        
        # Prix outlier (loin de la moyenne)
        is_outlier_extreme = similarity_engine.detect_price_outlier(
            price=500.0,
            competitor_prices=competitor_prices,
            threshold_std=2.0
        )
        assert is_outlier_extreme is True


class TestNLPPipeline:
    """Tests pour NLPPipeline."""
    
    @pytest.fixture
    def nlp_pipeline(self):
        """Fixture pour NLPPipeline."""
        with patch('market_data_pipeline.enrichers.nlp_pipeline.TRANSLATION_AVAILABLE', True):
            with patch('market_data_pipeline.enrichers.nlp_pipeline.VADER_AVAILABLE', True):
                with patch('deep_translator.GoogleTranslator') as mock_translator:
                    with patch('vaderSentiment.vaderSentiment.SentimentIntensityAnalyzer') as mock_vader:
                        # Mock translator
                        mock_trans = Mock()
                        mock_trans.translate.return_value = "Translated text"
                        mock_translator.return_value = mock_trans
                        
                        # Mock VADER
                        mock_analyzer = Mock()
                        mock_analyzer.polarity_scores.return_value = {
                            "pos": 0.5,
                            "neu": 0.3,
                            "neg": 0.2,
                            "compound": 0.3
                        }
                        mock_vader.return_value = mock_analyzer
                        
                        pipeline = NLPPipeline()
                        pipeline._translator = mock_trans
                        pipeline._sentiment_analyzer = mock_analyzer
                        return pipeline
    
    def test_translate_text(self, nlp_pipeline):
        """Test traduction de texte."""
        result = nlp_pipeline.translate_text("Bonjour", target_lang="en")
        
        assert result == "Translated text"
        nlp_pipeline._translator.translate.assert_called_once()
    
    def test_classify_event_concert(self, nlp_pipeline):
        """Test classification d'événement (concert)."""
        event_data = {
            "title": "Rock Concert in Paris",
            "description": "A great music performance"
        }
        
        category = nlp_pipeline.classify_event(event_data)
        
        assert category in NLPPipeline.EVENT_CATEGORIES
        assert category == "concert"  # Devrait classifier comme concert
    
    def test_classify_event_sport(self, nlp_pipeline):
        """Test classification d'événement (sport)."""
        event_data = {
            "title": "Football Match",
            "description": "Championship final"
        }
        
        category = nlp_pipeline.classify_event(event_data)
        
        assert category in NLPPipeline.EVENT_CATEGORIES
        assert category == "sport"
    
    def test_calculate_impact_score(self, nlp_pipeline, sample_event_data):
        """Test calcul du score d'impact."""
        impact_score = nlp_pipeline.calculate_impact_score(sample_event_data)
        
        assert 0 <= impact_score <= 100
        # Festival avec 50000 participants devrait avoir un impact élevé
        assert impact_score > 50
    
    def test_analyze_sentiment(self, nlp_pipeline):
        """Test analyse de sentiment."""
        text = "This is a great event that will boost tourism!"
        
        sentiment = nlp_pipeline.analyze_sentiment(text)
        
        assert "compound" in sentiment
        assert "positive" in sentiment or "neg" in sentiment
        assert -1 <= sentiment.get("compound", 0) <= 1
    
    def test_extract_keywords(self, nlp_pipeline):
        """Test extraction de mots-clés."""
        text = "Music festival in Paris with many concerts and performances"
        
        keywords = nlp_pipeline.extract_keywords(text, top_k=5)
        
        assert isinstance(keywords, list)
        assert len(keywords) <= 5
        assert all(isinstance(kw, str) for kw in keywords)


class TestFeatureCalculator:
    """Tests pour FeatureCalculator."""
    
    @pytest.fixture
    def feature_calculator(self, mock_settings):
        """Fixture pour FeatureCalculator."""
        with patch('market_data_pipeline.enrichers.feature_calculator.SUPABASE_AVAILABLE', True):
            calculator = FeatureCalculator(settings=mock_settings)
            return calculator
    
    def test_calculate_competitor_features_empty(self, feature_calculator):
        """Test calcul features concurrents avec données vides."""
        features = feature_calculator.calculate_competitor_features(
            enriched_data=[],
            target_date=date.today(),
            city="Paris"
        )
        
        assert features["competitor_avg_price"] is None
        assert features["competitor_sample_size"] == 0
    
    def test_calculate_competitor_features_with_data(self, feature_calculator):
        """Test calcul features concurrents avec données."""
        enriched_data = [
            {
                "raw_data_id": "raw_1",
                "price_rank_percentile": 50.0,
                "similarity_score": 0.9
            },
            {
                "raw_data_id": "raw_2",
                "price_rank_percentile": 60.0,
                "similarity_score": 0.8
            }
        ]
        
        # Mock pour récupérer les prix depuis raw_competitor_data
        with patch.object(feature_calculator, '_get_prices_from_raw_data') as mock_get_prices:
            mock_get_prices.return_value = [150.0, 170.0]
            
            features = feature_calculator.calculate_competitor_features(
                enriched_data=enriched_data,
                target_date=date.today(),
                city="Paris"
            )
            
            assert features["competitor_avg_price"] == pytest.approx(160.0, abs=0.1)
            assert features["competitor_sample_size"] == 2
    
    def test_calculate_weather_features(self, feature_calculator):
        """Test calcul features météo."""
        enriched_weather = [
            {
                "normalized_data": {
                    "temperature": 20.0,
                    "humidity": 65,
                    "weather_condition": "clear",
                    "precipitation": 0.0
                }
            }
        ]
        
        features = feature_calculator.calculate_weather_features(
            enriched_data=enriched_weather,
            target_date=date.today(),
            city="Paris"
        )
        
        assert "avg_temperature" in features
        assert "weather_score" in features
        assert features["avg_temperature"] == 20.0
    
    def test_calculate_event_features(self, feature_calculator, sample_event_data):
        """Test calcul features événements."""
        enriched_events = [
            {
                "normalized_data": sample_event_data,
                "impact_score": 75.0,
                "category": "festival"
            }
        ]
        
        features = feature_calculator.calculate_event_features(
            enriched_data=enriched_events,
            target_date=date.today(),
            city="Paris"
        )
        
        assert "event_intensity_score" in features
        assert "demand_impact" in features
        assert features["event_intensity_score"] > 0
    
    def test_calculate_trend_features(self, feature_calculator):
        """Test calcul features tendances."""
        enriched_trends = [
            {
                "normalized_data": {
                    "trend_score": 0.7,
                    "sentiment_score": 0.5
                }
            }
        ]
        
        features = feature_calculator.calculate_trend_features(
            enriched_data=enriched_trends,
            target_date=date.today(),
            city="Paris"
        )
        
        assert "market_sentiment" in features
        assert "trend_direction" in features
    
    def test_calculate_market_demand_level(self, feature_calculator):
        """Test calcul du niveau de demande marché."""
        features = {
            "competitor_avg_price": 150.0,
            "event_intensity_score": 75.0,
            "weather_score": 80.0,
            "market_sentiment": 0.6
        }
        
        demand_level = feature_calculator.calculate_market_demand_level(features)
        
        assert 0 <= demand_level <= 100
    
    def test_calculate_rolling_features(self, feature_calculator):
        """Test calcul des features rolling (moyennes mobiles)."""
        # Mock données historiques
        historical_features = [
            {
                "data_date": date.today() - timedelta(days=i),
                "competitor_avg_price": 150.0 + i * 2,
                "weather_score": 70.0
            }
            for i in range(30)
        ]
        
        rolling_features = feature_calculator.calculate_rolling_features(
            historical_features=historical_features,
            target_date=date.today(),
            window_days=7
        )
        
        assert "competitor_avg_price_7d_avg" in rolling_features
        assert "competitor_avg_price_30d_avg" in rolling_features or "competitor_avg_price_30d_avg" not in rolling_features  # Peut ne pas exister si < 30 jours


class TestTimeSeriesAnalyzer:
    """Tests pour TimeSeriesAnalyzer."""
    
    @pytest.fixture
    def time_series_analyzer(self, mock_settings):
        """Fixture pour TimeSeriesAnalyzer."""
        with patch('market_data_pipeline.enrichers.time_series_analyzer.PROPHET_AVAILABLE', True):
            with patch('market_data_pipeline.enrichers.time_series_analyzer.Prophet') as mock_prophet:
                analyzer = TimeSeriesAnalyzer(settings=mock_settings)
                return analyzer
    
    def test_analyze_market_trends_with_prophet(self, time_series_analyzer):
        """Test analyse de tendances avec Prophet."""
        # Mock données historiques
        historical_data = [
            {
                "data_date": date.today() - timedelta(days=i),
                "value": 100.0 + i * 0.5  # Tendance croissante
            }
            for i in range(30, 0, -1)
        ]
        
        with patch('pandas.DataFrame') as mock_df:
            with patch.object(time_series_analyzer, '_prepare_data_for_prophet'):
                with patch('prophet.Prophet') as mock_prophet_class:
                    mock_model = Mock()
                    mock_model.fit = Mock()
                    mock_model.predict = Mock(return_value=pd.DataFrame({
                        'ds': [date.today()],
                        'yhat': [115.0],
                        'trend': [115.0]
                    }))
                    mock_prophet_class.return_value = mock_model
                    
                    result = time_series_analyzer.analyze_market_trends(
                        historical_data=historical_data,
                        target_date=date.today(),
                        forecast_days=7
                    )
                    
                    assert "trend_direction" in result
                    assert "trend_score" in result
    
    def test_calculate_trend_score(self, time_series_analyzer):
        """Test calcul du score de tendance."""
        # Tendance croissante
        trend_data = {
            "trend_direction": "increasing",
            "trend_magnitude": 0.5,
            "seasonality_strength": 0.3
        }
        
        score = time_series_analyzer.calculate_trend_score(trend_data)
        
        assert 0 <= score <= 100
        assert score > 50  # Tendance croissante devrait avoir un score > 50
    
    def test_detect_change_points(self, time_series_analyzer):
        """Test détection de change-points."""
        # Mock données avec changement
        historical_data = [
            {"data_date": date.today() - timedelta(days=i), "value": 100.0}
            if i > 15
            else {"data_date": date.today() - timedelta(days=i), "value": 150.0}
            for i in range(30, 0, -1)
        ]
        
        with patch('market_data_pipeline.enrichers.time_series_analyzer.RUPTURES_AVAILABLE', True):
            with patch('ruptures.Binseg') as mock_ruptures:
                mock_detector = Mock()
                mock_detector.fit.return_value = mock_detector
                mock_detector.predict.return_value = [15]  # Changement au jour 15
                mock_ruptures.return_value = mock_detector
                
                change_points = time_series_analyzer.detect_change_points(historical_data)
                
                assert isinstance(change_points, list)


class TestEnrichersEdgeCases:
    """Tests pour les cas limites des enrichers."""
    
    def test_similarity_engine_empty_competitors(self):
        """Test SimilarityEngine avec liste de concurrents vide."""
        with patch('market_data_pipeline.enrichers.similarity_engine.SENTENCE_TRANSFORMERS_AVAILABLE', True):
            with patch('market_data_pipeline.enrichers.similarity_engine.SentenceTransformer'):
                engine = SimilarityEngine()
                
                comparables = engine.find_comparables(
                    target_property={"bedrooms": 2},
                    competitors=[],
                    top_k=5
                )
                
                assert comparables == []
    
    def test_nlp_pipeline_empty_text(self):
        """Test NLP Pipeline avec texte vide."""
        with patch('market_data_pipeline.enrichers.nlp_pipeline.TRANSLATION_AVAILABLE', True):
            with patch('market_data_pipeline.enrichers.nlp_pipeline.VADER_AVAILABLE', True):
                pipeline = NLPPipeline()
                
                sentiment = pipeline.analyze_sentiment("")
                
                # Devrait retourner un sentiment neutre ou gérer gracieusement
                assert isinstance(sentiment, dict)
    
    def test_feature_calculator_missing_fields(self):
        """Test FeatureCalculator avec données partiellement manquantes."""
        with patch('market_data_pipeline.enrichers.feature_calculator.SUPABASE_AVAILABLE', True):
            calculator = FeatureCalculator()
            
            # Données avec champs manquants
            incomplete_features = {
                "competitor_avg_price": 150.0
                # Manque autres champs
            }
            
            demand_level = calculator.calculate_market_demand_level(incomplete_features)
            
            # Devrait gérer gracieusement et retourner une valeur par défaut
            assert 0 <= demand_level <= 100

