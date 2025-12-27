"""
Calculateur de features pour le pricing.

Agrège les données enrichies et calcule les features finales pour les modèles de pricing.
"""

import asyncio
import logging
from typing import Dict, List, Optional, Any
from datetime import date, datetime, timedelta
import pandas as pd
import numpy as np

try:
    from supabase import create_client, Client
    SUPABASE_AVAILABLE = True
except ImportError:
    SUPABASE_AVAILABLE = False
    logging.warning("Supabase client not available")

from ..config.settings import Settings
from ..utils.timezone_handler import TimezoneHandler

logger = logging.getLogger(__name__)


class FeatureCalculator:
    """
    Calcule les features agrégées pour le pricing.
    
    Agrége les données enrichies et calcule les features finales
    prêtes pour les modèles de pricing dynamique.
    """
    
    def __init__(self, settings: Optional[Settings] = None):
        """
        Initialise le calculateur de features.
        
        Args:
            settings: Configuration (si None, charge depuis env)
        """
        self.settings = settings or Settings.from_env()
        self.supabase_client: Optional[Client] = None
        self.timezone_handler = TimezoneHandler(settings=settings)
        
        logger.info("Initialized FeatureCalculator")
    
    def calculate_competitor_features(
        self,
        enriched_data: List[Dict[str, Any]],
        target_date: date,
        city: str,
        neighborhood: Optional[str] = None,
        property_type: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Calcule les features concurrents agrégées.
        
        Args:
            enriched_data: Données enrichies concurrents depuis enriched_competitor_data
            target_date: Date cible
            city: Ville
            neighborhood: Quartier (optionnel, pour filtrage)
            property_type: Type de propriété (optionnel, pour filtrage)
            
        Returns:
            Features concurrents agrégées
        """
        logger.debug(f"Calculating competitor features for {city} on {target_date}")
        
        if not enriched_data:
            return {
                "competitor_avg_price": None,
                "competitor_min_price": None,
                "competitor_max_price": None,
                "competitor_p25_price": None,
                "competitor_p50_price": None,
                "competitor_p75_price": None,
                "competitor_sample_size": 0,
                "price_rank_percentile": None,
                "market_occupancy_estimate": None
            }
        
        # Extraire les prix depuis raw_competitor_data (via raw_data_id)
        prices = []
        price_rank_percentiles = []
        
        for enriched_item in enriched_data:
            # Récupérer le raw_data_id et aller chercher les prix depuis raw_competitor_data
            raw_data_id = enriched_item.get('raw_data_id')
            
            # Les prix sont dans raw_competitor_data
            # Pour l'instant, on utilise les prix depuis enriched si disponibles
            # Sinon, il faudrait faire une jointure avec raw_competitor_data
            
            # Utiliser price_rank_percentile si disponible
            price_rank = enriched_item.get('price_rank_percentile')
            if price_rank is not None:
                price_rank_percentiles.append(float(price_rank))
        
        # Si on a des données directes, utiliser celles-ci
        # Sinon, on devra les récupérer depuis raw_competitor_data via Supabase
        # Pour l'instant, retourner None pour les prix (sera récupéré depuis raw)
        
        # Calculer le percentile rank moyen si disponible
        avg_price_rank = np.mean(price_rank_percentiles) if price_rank_percentiles else None
        
        # Estimation de l'occupation basée sur les données disponibles
        # (peut être amélioré avec des données réelles)
        market_occupancy = None
        
        return {
            "competitor_avg_price": None,  # Sera calculé depuis raw_competitor_data
            "competitor_min_price": None,
            "competitor_max_price": None,
            "competitor_p25_price": None,
            "competitor_p50_price": None,
            "competitor_p75_price": None,
            "competitor_sample_size": len(enriched_data),
            "price_rank_percentile": avg_price_rank,
            "market_occupancy_estimate": market_occupancy
        }
    
    async def _get_competitor_prices(
        self,
        target_date: date,
        city: str,
        country: str,
        neighborhood: Optional[str] = None,
        property_type: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Récupère les prix concurrents depuis raw_competitor_data.
        
        Helper pour récupérer les prix depuis la table raw.
        """
        if not self.supabase_client:
            return {}
        
        try:
            loop = asyncio.get_event_loop()
            
            # Construire la requête
            query = self.supabase_client.table('raw_competitor_data')\
                .select('avg_price, min_price, max_price, p25_price, p50_price, p75_price, sample_size')\
                .eq('country', country)\
                .eq('city', city)\
                .eq('data_date', target_date.isoformat())
            
            if neighborhood:
                query = query.eq('neighborhood', neighborhood)
            
            if property_type:
                query = query.eq('property_type', property_type)
            
            response = await loop.run_in_executor(
                None,
                lambda: query.execute()
            )
            
            records = response.data if response.data else []
            
            if not records:
                return {}
            
            # Agréger les prix (moyenne pondérée par sample_size)
            total_sample = sum(r.get('sample_size', 0) for r in records if r.get('sample_size'))
            
            if total_sample == 0:
                # Fallback: moyenne simple
                avg_price = np.mean([r.get('avg_price') for r in records if r.get('avg_price')])
                min_price = min([r.get('min_price') for r in records if r.get('min_price')], default=None)
                max_price = max([r.get('max_price') for r in records if r.get('max_price')], default=None)
                
                # Percentiles: prendre la médiane des percentiles
                p25_prices = [r.get('p25_price') for r in records if r.get('p25_price')]
                p50_prices = [r.get('p50_price') for r in records if r.get('p50_price')]
                p75_prices = [r.get('p75_price') for r in records if r.get('p75_price')]
                
                return {
                    "competitor_avg_price": float(avg_price) if avg_price else None,
                    "competitor_min_price": float(min_price) if min_price else None,
                    "competitor_max_price": float(max_price) if max_price else None,
                    "competitor_p25_price": float(np.median(p25_prices)) if p25_prices else None,
                    "competitor_p50_price": float(np.median(p50_prices)) if p50_prices else None,
                    "competitor_p75_price": float(np.median(p75_prices)) if p75_prices else None,
                    "competitor_sample_size": len(records)
                }
            else:
                # Moyenne pondérée
                weighted_avg = sum(
                    r.get('avg_price', 0) * r.get('sample_size', 0)
                    for r in records
                    if r.get('avg_price') and r.get('sample_size')
                ) / total_sample
                
                min_price = min([r.get('min_price') for r in records if r.get('min_price')], default=None)
                max_price = max([r.get('max_price') for r in records if r.get('max_price')], default=None)
                
                # Percentiles: moyenne pondérée
                p25_weighted = sum(
                    r.get('p25_price', 0) * r.get('sample_size', 0)
                    for r in records
                    if r.get('p25_price') and r.get('sample_size')
                ) / total_sample
                
                p50_weighted = sum(
                    r.get('p50_price', 0) * r.get('sample_size', 0)
                    for r in records
                    if r.get('p50_price') and r.get('sample_size')
                ) / total_sample
                
                p75_weighted = sum(
                    r.get('p75_price', 0) * r.get('sample_size', 0)
                    for r in records
                    if r.get('p75_price') and r.get('sample_size')
                ) / total_sample
                
                return {
                    "competitor_avg_price": float(weighted_avg) if weighted_avg else None,
                    "competitor_min_price": float(min_price) if min_price else None,
                    "competitor_max_price": float(max_price) if max_price else None,
                    "competitor_p25_price": float(p25_weighted) if p25_weighted else None,
                    "competitor_p50_price": float(p50_weighted) if p50_weighted else None,
                    "competitor_p75_price": float(p75_weighted) if p75_weighted else None,
                    "competitor_sample_size": int(total_sample)
                }
                
        except Exception as e:
            logger.error(f"Error fetching competitor prices: {e}")
            return {}
    
    def calculate_weather_features(
        self,
        weather_data: List[Dict[str, Any]],
        target_date: date,
        city: str,
        country: str
    ) -> Dict[str, Any]:
        """
        Calcule les features météo (normalisées par saison).
        
        Args:
            weather_data: Données météo depuis raw_weather_data
            target_date: Date cible
            city: Ville
            country: Pays
            
        Returns:
            Features météo
        """
        logger.debug(f"Calculating weather features for {city} on {target_date}")
        
        if not weather_data:
            return {
                "weather_score": None,
                "temperature_avg": None,
                "temperature_min": None,
                "temperature_max": None,
                "precipitation_mm": None,
                "humidity_percent": None,
                "wind_speed_kmh": None,
                "is_sunny": None,
                "cloud_cover_percent": None
            }
        
        # Filtrer pour la date cible
        target_records = [
            w for w in weather_data
            if pd.to_datetime(w.get('forecast_date') or w.get('data_date')).date() == target_date
        ]
        
        if not target_records:
            # Utiliser la première si pas d'exact match
            target_records = [weather_data[0]] if weather_data else []
        
        if not target_records:
            return {
                "weather_score": None,
                "temperature_avg": None,
                "temperature_min": None,
                "temperature_max": None,
                "precipitation_mm": None,
                "humidity_percent": None,
                "wind_speed_kmh": None,
                "is_sunny": None,
                "cloud_cover_percent": None
            }
        
        record = target_records[0]
        
        # Extraire les valeurs
        temp_avg = record.get('temperature_avg')
        temp_min = record.get('temperature_min')
        temp_max = record.get('temperature_max')
        precipitation = record.get('precipitation_mm', 0)
        humidity = record.get('humidity_percent')
        wind_speed = record.get('wind_speed_kmh')
        is_sunny = record.get('is_sunny', False)
        cloud_cover = record.get('cloud_cover_percent')
        
        # Calculer weather_score normalisé par saison (0-100)
        weather_score = self._calculate_weather_score(
            temp_avg=temp_avg,
            precipitation=precipitation,
            is_sunny=is_sunny,
            target_date=target_date,
            city=city,
            country=country
        )
        
        return {
            "weather_score": weather_score,
            "temperature_avg": float(temp_avg) if temp_avg is not None else None,
            "temperature_min": float(temp_min) if temp_min is not None else None,
            "temperature_max": float(temp_max) if temp_max is not None else None,
            "precipitation_mm": float(precipitation) if precipitation is not None else 0.0,
            "humidity_percent": float(humidity) if humidity is not None else None,
            "wind_speed_kmh": float(wind_speed) if wind_speed is not None else None,
            "is_sunny": bool(is_sunny) if is_sunny is not None else None,
            "cloud_cover_percent": float(cloud_cover) if cloud_cover is not None else None
        }
    
    def _calculate_weather_score(
        self,
        temp_avg: Optional[float],
        precipitation: Optional[float],
        is_sunny: Optional[bool],
        target_date: date,
        city: str,
        country: str
    ) -> Optional[float]:
        """
        Calcule un score météo normalisé par saison (0-100).
        
        Score plus élevé = meilleur pour le tourisme.
        """
        if temp_avg is None:
            return None
        
        score = 50.0  # Base
        
        # Bonus/malus température (optimal: 20-25°C)
        if 20 <= temp_avg <= 25:
            score += 30.0
        elif 15 <= temp_avg < 20 or 25 < temp_avg <= 28:
            score += 15.0
        elif 10 <= temp_avg < 15 or 28 < temp_avg <= 30:
            score += 5.0
        elif temp_avg < 5 or temp_avg > 35:
            score -= 20.0
        
        # Malus précipitation
        if precipitation:
            if precipitation > 10:
                score -= 30.0
            elif precipitation > 5:
                score -= 15.0
            elif precipitation > 2:
                score -= 5.0
        
        # Bonus si ensoleillé
        if is_sunny:
            score += 10.0
        
        # Ajuster selon la saison (normalisation)
        month = target_date.month
        
        # Hiver (déc-fév): températures plus basses acceptables
        if month in [12, 1, 2]:
            if 10 <= temp_avg <= 15:
                score += 10.0
        
        # Été (juin-août): températures plus élevées acceptables
        if month in [6, 7, 8]:
            if 25 <= temp_avg <= 30:
                score += 10.0
        
        # Limiter entre 0 et 100
        return max(0.0, min(100.0, score))
    
    def calculate_event_features(
        self,
        enriched_events: List[Dict[str, Any]],
        target_date: date
    ) -> Dict[str, Any]:
        """
        Calcule les features événements agrégées.
        
        Args:
            enriched_events: Événements enrichis depuis enriched_events_data
            target_date: Date cible
            
        Returns:
            Features événements
        """
        logger.debug(f"Calculating event features for {target_date}")
        
        if not enriched_events:
            return {
                "event_intensity_score": None,
                "event_count": 0,
                "event_categories": [],
                "has_major_event": False,
                "expected_demand_impact": None
            }
        
        # Filtrer pour la date cible
        target_events = []
        for event in enriched_events:
            # Récupérer la date depuis raw_events_data
            # Pour l'instant, supposer que tous les événements sont pour target_date
            target_events.append(event)
        
        if not target_events:
            return {
                "event_intensity_score": None,
                "event_count": 0,
                "event_categories": [],
                "has_major_event": False,
                "expected_demand_impact": None
            }
        
        # Agréger
        intensity_scores = [
            float(e.get('event_intensity_score', 0))
            for e in target_events
            if e.get('event_intensity_score') is not None
        ]
        
        max_intensity = max(intensity_scores) if intensity_scores else None
        
        categories = list(set([
            e.get('event_category')
            for e in target_events
            if e.get('event_category')
        ]))
        
        # Calculer l'impact demande agrégé
        demand_impacts = [
            float(e.get('expected_demand_impact', 0))
            for e in target_events
            if e.get('expected_demand_impact') is not None
        ]
        
        aggregated_demand_impact = sum(demand_impacts) if demand_impacts else None
        # Limiter entre -50 et +50
        if aggregated_demand_impact is not None:
            aggregated_demand_impact = max(-50.0, min(50.0, aggregated_demand_impact))
        
        return {
            "event_intensity_score": float(max_intensity) if max_intensity is not None else None,
            "event_count": len(target_events),
            "event_categories": categories,
            "has_major_event": max_intensity is not None and max_intensity > 70.0,
            "expected_demand_impact": aggregated_demand_impact
        }
    
    def calculate_trend_features(
        self,
        trends_data: Dict[str, Any],
        target_date: date
    ) -> Dict[str, Any]:
        """
        Calcule les features tendances marché.
        
        Args:
            trends_data: Données de tendances depuis time_series_analyzer
            target_date: Date cible
            
        Returns:
            Features tendances
        """
        logger.debug(f"Calculating trend features for {target_date}")
        
        if not trends_data:
            return {
                "market_trend_score": None,
                "market_sentiment_score": None,
                "search_volume_index": None,
                "booking_volume_estimate": None,
                "active_listings_count": None
            }
        
        # Extraire les scores
        trend_score = trends_data.get('market_trend_score')
        
        # market_sentiment_score sera calculé depuis les news enrichies
        sentiment_score = None
        
        return {
            "market_trend_score": float(trend_score) if trend_score is not None else None,
            "market_sentiment_score": sentiment_score,  # Sera calculé depuis news
            "search_volume_index": None,  # Depuis raw_market_trends_data
            "booking_volume_estimate": None,
            "active_listings_count": None
        }
    
    async def _get_market_sentiment(
        self,
        target_date: date,
        city: str,
        country: str
    ) -> Optional[float]:
        """
        Calcule le sentiment marché agrégé depuis les news enrichies.
        
        Args:
            target_date: Date cible
            city: Ville
            country: Pays
            
        Returns:
            Score de sentiment -1 à +1
        """
        if not self.supabase_client:
            return None
        
        try:
            loop = asyncio.get_event_loop()
            
            # Récupérer les news enrichies pour la période (7 jours autour)
            start_date = target_date - timedelta(days=7)
            end_date = target_date + timedelta(days=7)
            
            # Récupérer raw_news_data avec leurs enriched
            query = self.supabase_client.table('enriched_news_data')\
                .select('sentiment_score, raw_data_id')\
                .not_.is_('sentiment_score', 'null')
            
            # Joindre avec raw_news_data pour filtrer par city/country/date
            # Note: Supabase ne supporte pas directement les jointures complexes
            # On récupère d'abord les raw_news_data, puis leurs enriched
            
            raw_query = self.supabase_client.table('raw_news_data')\
                .select('id, published_at')\
                .eq('country', country)\
                .eq('city', city)\
                .gte('published_at', start_date.isoformat())\
                .lte('published_at', end_date.isoformat())
            
            raw_response = await loop.run_in_executor(
                None,
                lambda: raw_query.execute()
            )
            
            raw_ids = [item['id'] for item in (raw_response.data or [])]
            
            if not raw_ids:
                return None
            
            # Récupérer les enriched correspondants
            enriched_query = self.supabase_client.table('enriched_news_data')\
                .select('sentiment_score')\
                .in_('raw_data_id', raw_ids)\
                .not_.is_('sentiment_score', 'null')
            
            enriched_response = await loop.run_in_executor(
                None,
                lambda: enriched_query.execute()
            )
            
            sentiments = [
                float(item['sentiment_score'])
                for item in (enriched_response.data or [])
                if item.get('sentiment_score') is not None
            ]
            
            if not sentiments:
                return None
            
            # Moyenne pondérée ou simple moyenne
            avg_sentiment = np.mean(sentiments)
            
            return float(avg_sentiment)
            
        except Exception as e:
            logger.error(f"Error calculating market sentiment: {e}")
            return None
    
    async def _get_trends_raw_data(
        self,
        target_date: date,
        city: str,
        country: str
    ) -> Dict[str, Any]:
        """
        Récupère les données raw de tendances pour une date.
        """
        if not self.supabase_client:
            return {}
        
        try:
            loop = asyncio.get_event_loop()
            
            query = self.supabase_client.table('raw_market_trends_data')\
                .select('search_volume_index, booking_volume_estimate, active_listings_count')\
                .eq('country', country)\
                .eq('city', city)\
                .eq('trend_date', target_date.isoformat())\
                .maybe_single()
            
            response = await loop.run_in_executor(
                None,
                lambda: query.execute()
            )
            
            if response.data:
                return {
                    "search_volume_index": response.data.get('search_volume_index'),
                    "booking_volume_estimate": response.data.get('booking_volume_estimate'),
                    "active_listings_count": response.data.get('active_listings_count')
                }
            
            return {}
            
        except Exception as e:
            logger.error(f"Error fetching trends raw data: {e}")
            return {}
    
    async def _calculate_rolling_features_from_db(
        self,
        target_date: date,
        city: str,
        country: str,
        neighborhood: Optional[str],
        property_type: Optional[str],
        window_days: int
    ) -> Dict[str, Any]:
        """
        Calcule les rolling features depuis l'historique dans market_features.
        
        Args:
            target_date: Date cible
            city: Ville
            country: Pays
            neighborhood: Quartier
            property_type: Type de propriété
            window_days: Fenêtre en jours
            
        Returns:
            Dict avec les rolling features
        """
        if not self.supabase_client:
            return {}
        
        try:
            loop = asyncio.get_event_loop()
            
            # Récupérer l'historique (window_days jours avant target_date)
            start_date = target_date - timedelta(days=window_days - 1)
            
            query = self.supabase_client.table('market_features')\
                .select('*')\
                .eq('country', country)\
                .eq('city', city)\
                .gte('date', start_date.isoformat())\
                .lte('date', target_date.isoformat())
            
            if neighborhood:
                query = query.eq('neighborhood', neighborhood)
            else:
                query = query.is_('neighborhood', 'null')
            
            if property_type:
                query = query.eq('property_type', property_type)
            else:
                query = query.is_('property_type', 'null')
            
            response = await loop.run_in_executor(
                None,
                lambda: query.execute()
            )
            
            history = response.data if response.data else []
            
            if not history:
                return {}
            
            # Calculer les rolling features
            return self.calculate_rolling_features(history, window_days)
            
        except Exception as e:
            logger.error(f"Error calculating rolling features from DB: {e}")
            return {}
    
    def calculate_rolling_features(
        self,
        features_history: List[Dict[str, Any]],
        window_days: int
    ) -> Dict[str, Any]:
        """
        Calcule les features en moyenne mobile (rolling window).
        
        Args:
            features_history: Historique des features (DataFrame ou liste de dicts)
            window_days: Fenêtre en jours (7, 30, etc.)
            
        Returns:
            Features agrégées sur la fenêtre
        """
        logger.debug(f"Calculating rolling features (window: {window_days}d)")
        
        if not features_history or len(features_history) < window_days:
            return {}
        
        # Convertir en DataFrame si nécessaire
        if isinstance(features_history, list):
            df = pd.DataFrame(features_history)
        else:
            df = features_history.copy()
        
        # S'assurer que 'date' est datetime et trié
        if 'date' in df.columns:
            df['date'] = pd.to_datetime(df['date'])
            df = df.sort_values('date').tail(window_days)
        else:
            df = df.tail(window_days)
        
        rolling_features = {}
        
        # Features à agréger
        numeric_features = [
            'competitor_avg_price',
            'competitor_min_price',
            'competitor_max_price',
            'market_occupancy_estimate',
            'event_intensity_score',
            'weather_score',
            'market_trend_score',
            'market_sentiment_score'
        ]
        
        for feature in numeric_features:
            if feature in df.columns:
                values = pd.to_numeric(df[feature], errors='coerce').dropna()
                if len(values) > 0:
                    rolling_features[f"{feature}_{window_days}d"] = float(values.mean())
        
        return rolling_features
    
    async def build_all_features(
        self,
        target_date: date,
        city: str,
        country: str,
        neighborhood: Optional[str] = None,
        property_type: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Construit toutes les features pour une date/ville donnée.
        
        Combine toutes les sources et calcule les features finales.
        
        Args:
            target_date: Date cible
            city: Ville
            country: Pays
            neighborhood: Quartier (optionnel)
            property_type: Type de propriété (optionnel)
            
        Returns:
            Dict avec toutes les features prêtes pour market_features table
        """
        logger.info(
            f"Building all features for {city}, {country} "
            f"on {target_date} "
            f"(neighborhood={neighborhood}, property_type={property_type})"
        )
        
        if not SUPABASE_AVAILABLE or not self.settings.supabase_url:
            raise RuntimeError("Supabase not configured")
        
        if not self.supabase_client:
            self.supabase_client = create_client(
                self.settings.supabase_url,
                self.settings.supabase_key
            )
        
        loop = asyncio.get_event_loop()
        
        # 1. Récupérer les données enrichies
        # Competitor data: d'abord récupérer raw, puis enriched
        raw_comp_query = self.supabase_client.table('raw_competitor_data')\
            .select('id')\
            .eq('country', country)\
            .eq('city', city)\
            .eq('data_date', target_date.isoformat())
        
        if neighborhood:
            raw_comp_query = raw_comp_query.eq('neighborhood', neighborhood)
        
        if property_type:
            raw_comp_query = raw_comp_query.eq('property_type', property_type)
        
        raw_comp_response = await loop.run_in_executor(
            None,
            lambda: raw_comp_query.execute()
        )
        
        raw_comp_ids = [item['id'] for item in (raw_comp_response.data or [])]
        
        enriched_competitor_data = []
        if raw_comp_ids:
            enriched_comp_query = self.supabase_client.table('enriched_competitor_data')\
                .select('*')\
                .in_('raw_data_id', raw_comp_ids)
            
            enriched_comp_response = await loop.run_in_executor(
                None,
                lambda: enriched_comp_query.execute()
            )
            enriched_competitor_data = enriched_comp_response.data if enriched_comp_response.data else []
        
        # Competitor prices (depuis raw)
        competitor_prices = await self._get_competitor_prices(
            target_date, city, country, neighborhood, property_type
        )
        
        # Weather data
        weather_query = self.supabase_client.table('raw_weather_data')\
            .select('*')\
            .eq('country', country)\
            .eq('city', city)\
            .eq('forecast_date', target_date.isoformat())
        
        weather_response = await loop.run_in_executor(
            None,
            lambda: weather_query.execute()
        )
        weather_data = weather_response.data if weather_response.data else []
        
        # Events data: d'abord récupérer raw, puis enriched
        raw_events_query = self.supabase_client.table('raw_events_data')\
            .select('id')\
            .eq('country', country)\
            .eq('city', city)\
            .eq('event_date', target_date.isoformat())
        
        raw_events_response = await loop.run_in_executor(
            None,
            lambda: raw_events_query.execute()
        )
        
        raw_events_ids = [item['id'] for item in (raw_events_response.data or [])]
        
        enriched_events_data = []
        if raw_events_ids:
            enriched_events_query = self.supabase_client.table('enriched_events_data')\
                .select('*')\
                .in_('raw_data_id', raw_events_ids)
            
            enriched_events_response = await loop.run_in_executor(
                None,
                lambda: enriched_events_query.execute()
            )
            enriched_events_data = enriched_events_response.data if enriched_events_response.data else []
        
        # Trends data (depuis time_series_analyzer enrich_trends_data)
        # Note: On récupère depuis raw_market_trends_data et on calcule
        trends_raw = await self._get_trends_raw_data(target_date, city, country)
        
        # 2. Calculer chaque type de feature
        competitor_features = self.calculate_competitor_features(
            enriched_competitor_data, target_date, city, neighborhood, property_type
        )
        # Fusionner avec les prix récupérés
        competitor_features.update(competitor_prices)
        
        weather_features = self.calculate_weather_features(
            weather_data, target_date, city, country
        )
        
        event_features = self.calculate_event_features(
            enriched_events_data, target_date
        )
        
        # Market sentiment depuis news
        market_sentiment = await self._get_market_sentiment(target_date, city, country)
        
        # Trends features (basique pour l'instant)
        trend_features = self.calculate_trend_features({}, target_date)
        trend_features.update({
            "market_sentiment_score": market_sentiment,
            "search_volume_index": trends_raw.get('search_volume_index'),
            "booking_volume_estimate": trends_raw.get('booking_volume_estimate'),
            "active_listings_count": trends_raw.get('active_listings_count')
        })
        
        # 3. Calculer rolling features (7j et 30j)
        # Récupérer l'historique depuis market_features
        rolling_7d = await self._calculate_rolling_features_from_db(
            target_date, city, country, neighborhood, property_type, window_days=7
        )
        
        rolling_30d = await self._calculate_rolling_features_from_db(
            target_date, city, country, neighborhood, property_type, window_days=30
        )
        
        # 4. Combiner toutes les features
        timezone = self.timezone_handler.get_timezone(country, city)
        
        # Sources de données utilisées
        data_sources = []
        if enriched_competitor_data:
            data_sources.append('competitor')
        if weather_data:
            data_sources.append('weather')
        if enriched_events_data:
            data_sources.append('events')
        if trends_raw:
            data_sources.append('trends')
        
        # Calculer data quality score (completeness)
        total_features = 20  # Nombre approximatif de features importantes
        filled_features = sum(1 for v in [
            competitor_features.get('competitor_avg_price'),
            weather_features.get('weather_score'),
            event_features.get('event_intensity_score'),
            trend_features.get('market_trend_score')
        ] if v is not None)
        
        data_quality_score = (filled_features / 4.0) * 100 if total_features > 0 else 0.0
        
        all_features = {
            "country": country,
            "city": city,
            "neighborhood": neighborhood,
            "property_type": property_type,
            "date": target_date.isoformat(),
            
            # Competitor features
            **competitor_features,
            
            # Weather features
            **weather_features,
            
            # Event features
            **event_features,
            
            # Trend features
            **trend_features,
            
            # Rolling features (7d)
            **rolling_7d,
            
            # Rolling features (30d)
            **rolling_30d,
            
            # Métadonnées
            "currency": self.settings.base_currency,
            "timezone": timezone,
            "data_sources": data_sources,
            "data_quality_score": float(data_quality_score),
            "calculated_at": datetime.now().isoformat()
        }
        
        logger.info(
            f"Built {len(all_features)} features for {city}, {country} "
            f"on {target_date} (quality: {data_quality_score:.1f}%)"
        )
        
        return all_features
