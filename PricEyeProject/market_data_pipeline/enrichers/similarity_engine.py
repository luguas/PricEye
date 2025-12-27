"""
Moteur de similarité pour identifier les comparables.

Utilise des embeddings (numériques + texte) et cosine similarity
pour trouver les propriétés similaires dans les données concurrents.
"""

import asyncio
import logging
from datetime import datetime
from typing import Dict, List, Optional, Any, Tuple
import numpy as np
from sklearn.preprocessing import StandardScaler
from sklearn.metrics.pairwise import cosine_similarity

try:
    from sentence_transformers import SentenceTransformer
    SENTENCE_TRANSFORMERS_AVAILABLE = True
except ImportError:
    SENTENCE_TRANSFORMERS_AVAILABLE = False
    logging.warning("sentence-transformers not installed. Install with: pip install sentence-transformers")

try:
    from supabase import create_client, Client
    SUPABASE_AVAILABLE = True
except ImportError:
    SUPABASE_AVAILABLE = False
    logging.warning("Supabase client not available")

from ..config.settings import Settings

logger = logging.getLogger(__name__)


class SimilarityEngine:
    """
    Moteur de similarité pour identifier les listings comparables.
    
    Utilise des embeddings et cosine similarity pour trouver
    les propriétés similaires dans les données concurrents.
    
    Combinaison de :
    - Features numériques (bedrooms, bathrooms, price, location) → StandardScaler
    - Features texte (property_type, amenities, description) → Sentence-BERT
    """
    
    # Features numériques à utiliser pour l'embedding
    NUMERIC_FEATURES = [
        'bedrooms',
        'bathrooms',
        'price',
        'latitude',
        'longitude',
        'accommodates',  # Capacité d'accueil
        'square_meters',  # Surface si disponible
    ]
    
    # Features texte à utiliser pour l'embedding
    TEXT_FEATURES = [
        'property_type',
        'amenities',
        'description',
        'neighborhood'
    ]
    
    def __init__(
        self,
        model_name: str = "all-MiniLM-L6-v2",
        settings: Optional[Settings] = None
    ):
        """
        Initialise le moteur de similarité.
        
        Args:
            model_name: Nom du modèle Sentence-BERT à utiliser
            settings: Configuration (si None, charge depuis env)
        """
        if not SENTENCE_TRANSFORMERS_AVAILABLE:
            raise ImportError(
                "sentence-transformers is required. Install with: "
                "pip install sentence-transformers"
            )
        
        self.model_name = model_name
        self.model = None  # Chargé lazy
        self.scaler = StandardScaler()
        self.scaler_fitted = False
        self.settings = settings or Settings.from_env()
        self.supabase_client: Optional[Client] = None
        
        logger.info(f"Initialized SimilarityEngine with model: {model_name}")
    
    def _load_model(self):
        """Charge le modèle Sentence-BERT (lazy loading)."""
        if self.model is None:
            try:
                logger.info(f"Loading Sentence-BERT model: {self.model_name}")
                self.model = SentenceTransformer(self.model_name)
                logger.info(f"Model loaded successfully: {self.model_name}")
            except Exception as e:
                logger.error(f"Failed to load model {self.model_name}: {e}")
                raise
    
    def _extract_numeric_features(
        self,
        property_features: Dict[str, Any]
    ) -> np.ndarray:
        """
        Extrait et normalise les features numériques.
        
        Args:
            property_features: Dict avec les features de la propriété
        
        Returns:
            Array normalisé des features numériques
        """
        features = []
        
        for feature_name in self.NUMERIC_FEATURES:
            value = property_features.get(feature_name)
            
            # Gérer les valeurs manquantes
            if value is None:
                # Valeur par défaut selon le type de feature
                if feature_name in ['bedrooms', 'bathrooms', 'accommodates']:
                    value = 0
                elif feature_name in ['latitude', 'longitude']:
                    value = 0.0  # 0,0 sera traité comme "non localisé"
                elif feature_name == 'price':
                    value = 0.0
                elif feature_name == 'square_meters':
                    value = 0.0
                else:
                    value = 0.0
            else:
                # Convertir en float si nécessaire
                try:
                    value = float(value)
                except (ValueError, TypeError):
                    value = 0.0
            
            features.append(value)
        
        return np.array(features, dtype=np.float32)
    
    def _extract_text_features(
        self,
        property_features: Dict[str, Any]
    ) -> str:
        """
        Extrait et combine les features texte en une seule chaîne.
        
        Args:
            property_features: Dict avec les features de la propriété
        
        Returns:
            Chaîne combinée de toutes les features texte
        """
        text_parts = []
        
        # Property type
        property_type = property_features.get('property_type', '')
        if property_type:
            text_parts.append(f"Type: {property_type}")
        
        # Neighborhood
        neighborhood = property_features.get('neighborhood', '')
        if neighborhood:
            text_parts.append(f"Neighborhood: {neighborhood}")
        
        # Amenities (peut être une liste ou une chaîne)
        amenities = property_features.get('amenities', '')
        if amenities:
            if isinstance(amenities, list):
                amenities_str = ', '.join(str(a) for a in amenities)
            else:
                amenities_str = str(amenities)
            text_parts.append(f"Amenities: {amenities_str}")
        
        # Description
        description = property_features.get('description', '')
        if description:
            # Limiter la longueur de la description pour éviter les tokens excessifs
            max_desc_length = 500
            if len(description) > max_desc_length:
                description = description[:max_desc_length] + "..."
            text_parts.append(f"Description: {description}")
        
        # Si aucune feature texte, retourner un texte par défaut
        combined_text = ' '.join(text_parts) if text_parts else "No description available"
        
        return combined_text
    
    def _fit_scaler(self, numeric_features_list: List[np.ndarray]):
        """
        Fit le StandardScaler sur une liste de features numériques.
        
        Args:
            numeric_features_list: Liste d'arrays de features numériques
        """
        if not numeric_features_list:
            return
        
        # Stack tous les arrays
        all_features = np.vstack(numeric_features_list)
        
        # Fit le scaler
        self.scaler.fit(all_features)
        self.scaler_fitted = True
        
        logger.info(f"Fitted StandardScaler on {len(numeric_features_list)} properties")
    
    def create_property_embedding(
        self,
        property_features: Dict[str, Any],
        fit_scaler: bool = False,
        reference_features: Optional[List[np.ndarray]] = None
    ) -> np.ndarray:
        """
        Crée un embedding pour une propriété.
        
        Combine :
        1. Features numériques normalisées (bedrooms, bathrooms, price, location)
        2. Embedding texte via Sentence-BERT (property_type, amenities, description)
        
        Args:
            property_features: Dict avec features de la propriété
                - bedrooms: int
                - bathrooms: int
                - price: float
                - latitude: float
                - longitude: float
                - property_type: str
                - amenities: str ou List[str]
                - description: str
                - neighborhood: str
            fit_scaler: Si True, fit le scaler avant de normaliser
            reference_features: Liste de features numériques pour fit le scaler
        
        Returns:
            Embedding vector combiné (numpy array)
        """
        logger.debug("Creating property embedding")
        
        # 1. Extraire et normaliser les features numériques
        numeric_features = self._extract_numeric_features(property_features)
        
        # Fit le scaler si demandé
        if fit_scaler and reference_features:
            self._fit_scaler(reference_features)
        
        # Normaliser les features numériques
        if self.scaler_fitted:
            numeric_features = self.scaler.transform(numeric_features.reshape(1, -1)).flatten()
        else:
            # Si le scaler n'est pas fit, utiliser les valeurs brutes (non optimal mais fonctionnel)
            logger.warning("Scaler not fitted, using raw numeric features")
        
        # 2. Extraire et encoder les features texte
        text_features = self._extract_text_features(property_features)
        
        # Charger le modèle si nécessaire
        self._load_model()
        
        # Encoder le texte avec Sentence-BERT
        text_embedding = self.model.encode(
            text_features,
            convert_to_numpy=True,
            normalize_embeddings=True  # Normaliser pour cosine similarity
        )
        
        # 3. Combiner les embeddings (concaténation)
        # Optionnel : pondérer les deux parties si nécessaire
        combined_embedding = np.concatenate([
            numeric_features,
            text_embedding
        ])
        
        # Normaliser le vecteur combiné pour cosine similarity
        norm = np.linalg.norm(combined_embedding)
        if norm > 0:
            combined_embedding = combined_embedding / norm
        
        logger.debug(f"Created embedding of dimension {len(combined_embedding)}")
        
        return combined_embedding
    
    def find_comparables(
        self,
        target_property: Dict[str, Any],
        competitor_listings: List[Dict[str, Any]],
        top_k: int = 20,
        similarity_threshold: float = 0.7
    ) -> List[Dict[str, Any]]:
        """
        Trouve les listings comparables les plus similaires.
        
        Args:
            target_property: Propriété cible à comparer (dict avec features)
            competitor_listings: Liste des listings concurrents (liste de dicts)
            top_k: Nombre de comparables à retourner
            similarity_threshold: Seuil minimum de similarité (0-1)
        
        Returns:
            Liste de dicts avec :
            - listing_id: str (ou index si pas d'ID)
            - similarity_score: float (0-1)
            - features: dict (features originales du listing)
            - property_features: dict (features extraites)
        """
        if not competitor_listings:
            logger.warning("No competitor listings provided")
            return []
        
        logger.info(
            f"Finding comparables for property "
            f"(competitors: {len(competitor_listings)}, top_k={top_k}, threshold={similarity_threshold})"
        )
        
        # 1. Extraire les features numériques de référence pour le scaler
        all_numeric_features = []
        for listing in competitor_listings:
            numeric_feat = self._extract_numeric_features(listing)
            all_numeric_features.append(numeric_feat)
        
        # Ajouter aussi la propriété cible
        target_numeric_feat = self._extract_numeric_features(target_property)
        all_numeric_features.append(target_numeric_feat)
        
        # 2. Créer l'embedding de la propriété cible (avec fit du scaler)
        target_embedding = self.create_property_embedding(
            target_property,
            fit_scaler=True,
            reference_features=all_numeric_features
        )
        
        # 3. Créer les embeddings de tous les concurrents
        competitor_embeddings = []
        valid_listings = []
        
        for idx, listing in enumerate(competitor_listings):
            try:
                embedding = self.create_property_embedding(listing)
                competitor_embeddings.append(embedding)
                valid_listings.append((idx, listing))
            except Exception as e:
                logger.warning(f"Failed to create embedding for listing {idx}: {e}")
                continue
        
        if not competitor_embeddings:
            logger.warning("No valid competitor embeddings created")
            return []
        
        competitor_embeddings = np.array(competitor_embeddings)
        
        # 4. Calculer cosine similarity
        # target_embedding est déjà normalisé, competitor_embeddings aussi
        similarities = cosine_similarity(
            target_embedding.reshape(1, -1),
            competitor_embeddings
        ).flatten()
        
        # 5. Filtrer par seuil et trier
        results = []
        for (idx, listing), similarity in zip(valid_listings, similarities):
            if similarity >= similarity_threshold:
                # Extraire un ID unique si disponible
                listing_id = listing.get('id') or listing.get('listing_id') or f"competitor_{idx}"
                
                results.append({
                    'listing_id': listing_id,
                    'similarity_score': float(similarity),
                    'features': listing,
                    'property_features': {
                        'bedrooms': listing.get('bedrooms'),
                        'bathrooms': listing.get('bathrooms'),
                        'property_type': listing.get('property_type'),
                        'price': listing.get('price') or listing.get('avg_price'),
                        'latitude': listing.get('latitude'),
                        'longitude': listing.get('longitude')
                    }
                })
        
        # Trier par score décroissant
        results.sort(key=lambda x: x['similarity_score'], reverse=True)
        
        # Prendre les top_k
        results = results[:top_k]
        
        logger.info(
            f"Found {len(results)} comparable listings "
            f"(threshold={similarity_threshold}, top_k={top_k})"
        )
        
        return results
    
    async def enrich_competitor_data(
        self,
        raw_data_id: str,
        target_property: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Enrichit les données concurrents avec similarity scores.
        
        Args:
            raw_data_id: ID de la donnée raw à enrichir (dans raw_competitor_data)
            target_property: Propriété cible pour comparaison (optionnel)
        
        Returns:
            Données enrichies à stocker
        """
        logger.info(f"Enriching competitor data: {raw_data_id}")
        
        if not SUPABASE_AVAILABLE or not self.settings.supabase_url:
            raise RuntimeError("Supabase not configured")
        
        try:
            # 1. Récupérer le client Supabase
            if not self.supabase_client:
                self.supabase_client = create_client(
                    self.settings.supabase_url,
                    self.settings.supabase_key
                )
            
            # 2. Lire raw_competitor_data
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(
                None,
                lambda: self.supabase_client.table('raw_competitor_data')
                    .select('*')
                    .eq('id', raw_data_id)
                    .single()
                    .execute()
            )
            
            if not response.data:
                raise ValueError(f"Raw competitor data not found: {raw_data_id}")
            
            raw_data = response.data
            
            # 3. Extraire les listings individuels depuis raw_data.raw_data
            raw_json = raw_data.get('raw_data', {})
            listings = []
            
            # Structure peut varier selon la source (Apify, CSV, etc.)
            # Chercher dans différentes structures possibles
            if isinstance(raw_json, dict):
                if 'items' in raw_json:
                    listings = raw_json['items']
                elif 'listings' in raw_json:
                    listings = raw_json['listings']
                elif 'data' in raw_json:
                    listings = raw_json['data']
                else:
                    # Si raw_data est déjà une liste
                    listings = [raw_json]
            elif isinstance(raw_json, list):
                listings = raw_json
            
            if not listings:
                logger.warning(f"No listings found in raw_data for {raw_data_id}")
                return {}
            
            # 4. Construire target_property depuis raw_data si non fourni
            if not target_property:
                target_property = {
                    'bedrooms': raw_data.get('bedrooms'),
                    'bathrooms': raw_data.get('bathrooms'),
                    'property_type': raw_data.get('property_type'),
                    'neighborhood': raw_data.get('neighborhood'),
                    'latitude': None,  # À récupérer depuis properties table si disponible
                    'longitude': None,
                    'price': raw_data.get('avg_price')
                }
            
            # 5. Normaliser les listings pour find_comparables
            competitor_listings = []
            for listing in listings:
                # Normaliser la structure du listing
                normalized = {
                    'bedrooms': listing.get('bedrooms') or listing.get('beds'),
                    'bathrooms': listing.get('bathrooms'),
                    'property_type': listing.get('property_type') or listing.get('roomType'),
                    'neighborhood': listing.get('neighborhood') or listing.get('address', {}).get('neighborhood'),
                    'latitude': listing.get('latitude') or listing.get('location', {}).get('lat'),
                    'longitude': listing.get('longitude') or listing.get('location', {}).get('lng'),
                    'price': listing.get('price') or listing.get('avg_price'),
                    'amenities': listing.get('amenities') or listing.get('amenitiesList', []),
                    'description': listing.get('description') or listing.get('summary'),
                    'id': listing.get('id') or listing.get('listing_id')
                }
                competitor_listings.append(normalized)
            
            # 6. Trouver les comparables
            comparables = self.find_comparables(
                target_property=target_property,
                competitor_listings=competitor_listings,
                top_k=20,
                similarity_threshold=0.7
            )
            
            # 7. Calculer les stats de pricing
            comparable_prices = [
                comp['property_features']['price']
                for comp in comparables
                if comp['property_features']['price'] is not None
                and comp['property_features']['price'] > 0
            ]
            
            target_price = target_property.get('price') or raw_data.get('avg_price')
            
            # Stats
            comparable_listings_count = len(comparables)
            price_rank_percentile = None
            price_vs_market_premium = None
            price_vs_market_premium_pct = None
            is_price_outlier = False
            outlier_reason = None
            
            if comparable_prices and target_price:
                target_price = float(target_price)
                avg_market_price = float(np.mean(comparable_prices))
                
                # Percentile rank
                percentile_rank = (np.sum(np.array(comparable_prices) <= target_price) / len(comparable_prices)) * 100
                price_rank_percentile = float(percentile_rank)
                
                # Premium vs marché
                price_vs_market_premium = float(target_price - avg_market_price)
                price_vs_market_premium_pct = float((target_price / avg_market_price - 1) * 100) if avg_market_price > 0 else None
                
                # Détection d'outlier (si > 2x ou < 0.5x la moyenne)
                if target_price > 2 * avg_market_price:
                    is_price_outlier = True
                    outlier_reason = f"Price is {target_price / avg_market_price:.2f}x above market average"
                elif target_price < 0.5 * avg_market_price:
                    is_price_outlier = True
                    outlier_reason = f"Price is {avg_market_price / target_price:.2f}x below market average"
            
            # Similarity scores (dictionnaire listing_id -> score)
            similarity_scores = {
                comp['listing_id']: comp['similarity_score']
                for comp in comparables
            }
            
            # 8. Construire les données enrichies
            enriched_data = {
                'raw_data_id': raw_data_id,
                'comparable_listings_count': comparable_listings_count,
                'price_rank_percentile': price_rank_percentile,
                'price_vs_market_premium': price_vs_market_premium,
                'price_vs_market_premium_pct': price_vs_market_premium_pct,
                'is_price_outlier': is_price_outlier,
                'outlier_reason': outlier_reason,
                'similarity_scores': similarity_scores,
                'model_version': f'similarity-{self.model_name}-v1.0',
                'confidence_score': float(np.mean([c['similarity_score'] for c in comparables])) * 100 if comparables else None,
                'enriched_at': datetime.now().isoformat()
            }
            
            # 9. Stocker dans enriched_competitor_data (upsert)
            await loop.run_in_executor(
                None,
                lambda: self.supabase_client.table('enriched_competitor_data')
                    .upsert(enriched_data, on_conflict='raw_data_id')
                    .execute()
            )
            
            logger.info(
                f"Enriched competitor data for {raw_data_id}: "
                f"{comparable_listings_count} comparables found, "
                f"outlier={is_price_outlier}"
            )
            
            return enriched_data
            
        except Exception as e:
            logger.error(f"Error enriching competitor data {raw_data_id}: {e}", exc_info=True)
            raise
