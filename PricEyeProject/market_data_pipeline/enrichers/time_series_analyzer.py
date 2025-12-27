"""
Analyseur de séries temporelles pour tendances marché.

Utilise Prophet pour forecasting et détection de saisonnalité.
Utilise ruptures pour change-point detection.
"""

import asyncio
import logging
from typing import Dict, List, Optional, Any
from datetime import datetime, date, timedelta
import pandas as pd
import numpy as np

try:
    from prophet import Prophet
    PROPHET_AVAILABLE = True
except ImportError:
    PROPHET_AVAILABLE = False
    logging.warning("Prophet not available, using statsmodels as fallback")

try:
    import ruptures as rpt
    RUPTURES_AVAILABLE = True
except ImportError:
    RUPTURES_AVAILABLE = False
    logging.warning("ruptures not available, change-point detection disabled")

try:
    from supabase import create_client, Client
    SUPABASE_AVAILABLE = True
except ImportError:
    SUPABASE_AVAILABLE = False
    logging.warning("Supabase client not available")

from ..config.settings import Settings

logger = logging.getLogger(__name__)


class TimeSeriesAnalyzer:
    """
    Analyseur de séries temporelles pour détecter tendances marché.
    
    Utilise Prophet si disponible, sinon statsmodels pour forecasting.
    Utilise ruptures pour change-point detection.
    """
    
    def __init__(self, settings: Optional[Settings] = None):
        """
        Initialise l'analyseur de séries temporelles.
        
        Args:
            settings: Configuration (si None, charge depuis env)
        """
        self.settings = settings or Settings.from_env()
        self.use_prophet = PROPHET_AVAILABLE
        self.supabase_client: Optional[Client] = None
        
        if not self.use_prophet:
            try:
                from statsmodels.tsa.seasonal import seasonal_decompose
                from statsmodels.tsa.holtwinters import ExponentialSmoothing
                logger.info("Initialized TimeSeriesAnalyzer with statsmodels fallback")
            except ImportError:
                logger.warning("Neither Prophet nor statsmodels available for time-series analysis")
        else:
            logger.info("Initialized TimeSeriesAnalyzer with Prophet")
    
    def analyze_market_trends(
        self,
        historical_data: pd.DataFrame
    ) -> Dict[str, Any]:
        """
        Analyse les tendances marché à partir de données historiques.
        
        Args:
            historical_data: DataFrame avec colonnes ['date', 'value'] (prix, volumes, etc.)
                - date: datetime ou date
                - value: float (prix moyen, volume, etc.)
            
        Returns:
            {
                'trend_score': float (-1 à +1),
                'trend_direction': str ('up', 'down', 'stable'),
                'change_points': List[date],
                'seasonality': Dict (si Prophet disponible),
                'forecast': Optional[DataFrame] (prévisions si Prophet)
            }
        """
        logger.info(f"Analyzing market trends for {len(historical_data)} data points")
        
        if len(historical_data) < 7:
            logger.warning("Not enough data for trend analysis (minimum 7 points required)")
            return {
                "trend_score": 0.0,
                "trend_direction": "stable",
                "change_points": [],
                "seasonality": {},
                "forecast": None
            }
        
        # Normaliser les données
        df = historical_data.copy()
        
        # S'assurer que 'date' est datetime
        if not pd.api.types.is_datetime64_any_dtype(df['date']):
            df['date'] = pd.to_datetime(df['date'])
        
        # Trier par date
        df = df.sort_values('date').reset_index(drop=True)
        
        # S'assurer que 'value' est numérique et sans NaN
        df['value'] = pd.to_numeric(df['value'], errors='coerce')
        df = df.dropna(subset=['value'])
        
        if len(df) < 7:
            logger.warning("Not enough valid data after cleaning")
            return {
                "trend_score": 0.0,
                "trend_direction": "stable",
                "change_points": [],
                "seasonality": {},
                "forecast": None
            }
        
        trend_score = 0.0
        trend_direction = "stable"
        change_points = []
        seasonality = {}
        forecast_df = None
        
        # Analyser avec Prophet si disponible
        if self.use_prophet:
            try:
                # Préparer données pour Prophet (ds = date, y = value)
                prophet_df = pd.DataFrame({
                    'ds': df['date'],
                    'y': df['value']
                })
                
                # Initialiser et entraîner le modèle Prophet
                model = Prophet(
                    daily_seasonality=False,  # Désactiver si données pas quotidiennes
                    weekly_seasonality=True,  # Détecter saisonnalité hebdomadaire
                    yearly_seasonality=True,  # Détecter saisonnalité annuelle
                    seasonality_mode='multiplicative'  # Ou 'additive'
                )
                
                model.fit(prophet_df)
                
                # Générer prévisions (30 jours dans le futur)
                future = model.make_future_dataframe(periods=30)
                forecast = model.predict(future)
                
                # Extraire la tendance
                trend_component = forecast['trend']
                
                # Calculer la pente de la tendance (derniers 30 jours vs premiers 30 jours)
                if len(trend_component) >= 30:
                    recent_trend = trend_component.iloc[-30:].mean()
                    initial_trend = trend_component.iloc[:30].mean()
                    trend_change = recent_trend - initial_trend
                    trend_change_pct = (trend_change / initial_trend) * 100 if initial_trend != 0 else 0
                else:
                    # Si pas assez de données, comparer début et fin
                    recent_trend = trend_component.iloc[-1]
                    initial_trend = trend_component.iloc[0]
                    trend_change_pct = ((recent_trend - initial_trend) / initial_trend) * 100 if initial_trend != 0 else 0
                
                # Normaliser le score de tendance (-1 à +1)
                # +1% = +0.01, +10% = +0.1, etc.
                trend_score = max(-1.0, min(1.0, trend_change_pct / 10.0))
                
                # Déterminer la direction
                if trend_score > 0.1:
                    trend_direction = "up"
                elif trend_score < -0.1:
                    trend_direction = "down"
                else:
                    trend_direction = "stable"
                
                # Extraire la saisonnalité
                if 'weekly' in forecast.columns:
                    seasonality['weekly'] = {
                        'amplitude': forecast['weekly'].std(),
                        'peak_day': forecast.groupby(forecast['ds'].dt.dayofweek)['weekly'].mean().idxmax()
                    }
                
                if 'yearly' in forecast.columns:
                    seasonality['yearly'] = {
                        'amplitude': forecast['yearly'].std(),
                        'peak_month': forecast.groupby(forecast['ds'].dt.month)['yearly'].mean().idxmax()
                    }
                
                forecast_df = forecast[['ds', 'yhat', 'yhat_lower', 'yhat_upper', 'trend']].tail(30)
                
                logger.debug(f"Prophet analysis: trend_score={trend_score:.3f}, direction={trend_direction}")
                
            except Exception as e:
                logger.error(f"Error in Prophet analysis: {e}", exc_info=True)
                # Fallback sur statsmodels
                self.use_prophet = False
        
        # Fallback: Utiliser statsmodels si Prophet n'est pas disponible ou a échoué
        if not self.use_prophet:
            try:
                from statsmodels.tsa.seasonal import seasonal_decompose
                
                # Préparer série temporelle
                df_ts = df.set_index('date').sort_index()
                ts_values = df_ts['value']
                
                # Décomposition saisonnière
                period = min(7, len(ts_values) // 2) if len(ts_values) >= 14 else None
                
                if period and len(ts_values) >= period * 2:
                    decomposition = seasonal_decompose(
                        ts_values,
                        model='additive',
                        period=period
                    )
                    
                    # Calculer tendance
                    trend = decomposition.trend.dropna()
                    
                    if len(trend) > 1:
                        # Calculer la pente de la tendance
                        trend_slope = (trend.iloc[-1] - trend.iloc[0]) / len(trend)
                        
                        # Normaliser par la valeur moyenne
                        mean_value = ts_values.mean()
                        if mean_value != 0:
                            trend_change_pct = (trend_slope / mean_value) * 100
                            trend_score = max(-1.0, min(1.0, trend_change_pct / 10.0))
                        else:
                            trend_score = 0.0
                        
                        # Déterminer direction
                        if trend_score > 0.1:
                            trend_direction = "up"
                        elif trend_score < -0.1:
                            trend_direction = "down"
                        else:
                            trend_direction = "stable"
                    else:
                        trend_score = 0.0
                        trend_direction = "stable"
                else:
                    # Pas assez de données pour décomposition, utiliser régression simple
                    x = np.arange(len(ts_values))
                    y = ts_values.values
                    
                    # Régression linéaire simple
                    slope = np.polyfit(x, y, 1)[0]
                    
                    # Normaliser
                    if y.mean() != 0:
                        trend_change_pct = (slope / y.mean()) * 100
                        trend_score = max(-1.0, min(1.0, trend_change_pct / 10.0))
                    else:
                        trend_score = 0.0
                    
                    # Déterminer direction
                    if trend_score > 0.1:
                        trend_direction = "up"
                    elif trend_score < -0.1:
                        trend_direction = "down"
                    else:
                        trend_direction = "stable"
                
                logger.debug(f"Statsmodels analysis: trend_score={trend_score:.3f}, direction={trend_direction}")
                
            except Exception as e:
                logger.error(f"Error in statsmodels analysis: {e}", exc_info=True)
                trend_score = 0.0
                trend_direction = "stable"
        
        # Détection de change-points avec ruptures
        if RUPTURES_AVAILABLE and len(df) >= 10:
            try:
                values = df['value'].values
                
                # Utiliser Pelt (Pruned Exact Linear Time) pour détection automatique
                # Modèle "rbf" (Radial Basis Function) pour changements de moyenne/variance
                algo = rpt.Pelt(model="rbf").fit(values.reshape(-1, 1))
                
                # Prédire les breakpoints (pénalité adaptative)
                pen = max(1, len(values) // 20)  # Pénalité adaptative
                breakpoints = algo.predict(pen=pen)
                
                # Convertir les breakpoints en dates
                if len(breakpoints) > 0:
                    # Filtrer le dernier breakpoint s'il est à la fin
                    breakpoints = [bp for bp in breakpoints if bp < len(df) - 1]
                    
                    if breakpoints:
                        change_points = []
                        for bp in breakpoints:
                            date_val = df.iloc[bp]['date']
                            if isinstance(date_val, date):
                                change_points.append(date_val)
                            elif hasattr(date_val, 'date'):
                                change_points.append(date_val.date())
                            else:
                                change_points.append(pd.Timestamp(date_val).date())
                        
                        logger.debug(f"Detected {len(change_points)} change points")
                
            except Exception as e:
                logger.warning(f"Error in change-point detection: {e}")
                change_points = []
        else:
            if not RUPTURES_AVAILABLE:
                logger.debug("ruptures not available, skipping change-point detection")
            else:
                logger.debug("Not enough data for change-point detection (minimum 10 points)")
        
        return {
            "trend_score": float(trend_score),
            "trend_direction": trend_direction,
            "change_points": change_points,
            "seasonality": seasonality,
            "forecast": forecast_df.to_dict('records') if forecast_df is not None else None
        }
    
    def calculate_trend_score(self, trend_data: Dict[str, Any]) -> float:
        """
        Calcule un score de tendance normalisé (-1 à +1).
        
        Convertit les données de tendance Prophet/statsmodels en score normalisé.
        
        Args:
            trend_data: Données de tendance depuis analyze_market_trends()
                - trend_score: float (-1 à +1)
                - trend_direction: str
                - change_points: List[date]
            
        Returns:
            Score -1 (baisse) à +1 (hausse)
        """
        logger.debug("Calculating trend score")
        
        # Le trend_score est déjà normalisé de -1 à +1
        base_score = trend_data.get('trend_score', 0.0)
        
        # Ajuster selon les change-points récents (si changement récent, amplifier)
        change_points = trend_data.get('change_points', [])
        
        # Si changement récent (derniers 30 jours), amplifier légèrement
        if change_points:
            today = date.today()
            recent_changes = [
                cp for cp in change_points
                if isinstance(cp, date) and (today - cp).days <= 30
            ]
            
            if recent_changes:
                # Amplifier le score de 10% si changement récent
                base_score *= 1.1
        
        # Limiter entre -1 et +1
        final_score = max(-1.0, min(1.0, base_score))
        
        return float(final_score)
    
    async def enrich_trends_data(
        self,
        city: str,
        country: str
    ) -> Dict[str, Any]:
        """
        Enrichit les données de tendances avec analyse time-series.
        
        Lit raw_market_trends_data pour une ville/pays, analyse les tendances,
        et met à jour les données enrichies.
        
        Args:
            city: Ville
            country: Pays
            
        Returns:
            Données enrichies
        """
        logger.info(f"Enriching trends data for {city}, {country}")
        
        if not SUPABASE_AVAILABLE or not self.settings.supabase_url:
            raise RuntimeError("Supabase not configured")
        
        try:
            # 1. Récupérer le client Supabase
            if not self.supabase_client:
                self.supabase_client = create_client(
                    self.settings.supabase_url,
                    self.settings.supabase_key
                )
            
            # 2. Lire raw_market_trends_data (90+ jours d'historique)
            loop = asyncio.get_event_loop()
            cutoff_date = date.today() - timedelta(days=90)
            
            response = await loop.run_in_executor(
                None,
                lambda: self.supabase_client.table('raw_market_trends_data')
                    .select('*')
                    .eq('country', country)
                    .eq('city', city)
                    .gte('trend_date', cutoff_date.isoformat())
                    .order('trend_date')
                    .execute()
            )
            
            if not response.data or len(response.data) < 7:
                logger.warning(f"Not enough trend data for {city}, {country}")
                return {}
            
            raw_trends = response.data
            
            # 3. Préparer les données pour analyse
            # Utiliser search_volume_index ou booking_volume_estimate comme valeur
            historical_data = pd.DataFrame([
                {
                    'date': pd.to_datetime(trend['trend_date']),
                    'value': float(trend.get('search_volume_index') or trend.get('booking_volume_estimate') or 0)
                }
                for trend in raw_trends
                if trend.get('search_volume_index') or trend.get('booking_volume_estimate')
            ])
            
            if len(historical_data) < 7:
                logger.warning(f"Not enough valid trend data points for {city}, {country}")
                return {}
            
            # 4. Analyser les tendances
            trend_analysis = self.analyze_market_trends(historical_data)
            
            # 5. Calculer le score de tendance normalisé
            market_trend_score = self.calculate_trend_score(trend_analysis)
            
            # 6. Préparer les données enrichies
            # Note: On pourrait créer une table enriched_market_trends_data si nécessaire
            # Pour l'instant, on retourne les résultats
            
            enriched_data = {
                'city': city,
                'country': country,
                'market_trend_score': market_trend_score,
                'trend_direction': trend_analysis['trend_direction'],
                'change_points': [cp.isoformat() if isinstance(cp, date) else str(cp) for cp in trend_analysis['change_points']],
                'seasonality': trend_analysis.get('seasonality', {}),
                'analysis_date': date.today().isoformat(),
                'data_points_count': len(historical_data),
                'forecast': trend_analysis.get('forecast')
            }
            
            logger.info(
                f"Enriched trends data for {city}, {country}: "
                f"trend_score={market_trend_score:.3f}, "
                f"direction={trend_analysis['trend_direction']}, "
                f"change_points={len(trend_analysis['change_points'])}"
            )
            
            return enriched_data
            
        except Exception as e:
            logger.error(f"Error enriching trends data for {city}, {country}: {e}", exc_info=True)
            raise
