"""
Pipeline NLP pour enrichir événements et news.

Fonctionnalités:
- Traduction multi-langue
- Classification d'événements
- Scoring d'impact
- Sentiment analysis
- Topic extraction
"""

import asyncio
import logging
import re
from typing import Dict, List, Optional, Any
from datetime import datetime

try:
    from deep_translator import GoogleTranslator
    try:
        from deep_translator import single_detection
        DETECTION_AVAILABLE = True
    except ImportError:
        DETECTION_AVAILABLE = False
    TRANSLATION_AVAILABLE = True
except ImportError:
    TRANSLATION_AVAILABLE = False
    DETECTION_AVAILABLE = False
    logging.warning("deep-translator not installed. Install with: pip install deep-translator")

try:
    from transformers import pipeline, AutoTokenizer, AutoModelForSequenceClassification
    TRANSFORMERS_AVAILABLE = True
except ImportError:
    TRANSFORMERS_AVAILABLE = False
    logging.warning("transformers not installed. Install with: pip install transformers")

try:
    from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
    VADER_AVAILABLE = True
except ImportError:
    VADER_AVAILABLE = False
    logging.warning("vaderSentiment not installed. Install with: pip install vaderSentiment")

try:
    from supabase import create_client, Client
    SUPABASE_AVAILABLE = True
except ImportError:
    SUPABASE_AVAILABLE = False
    logging.warning("Supabase client not available")

from ..config.settings import Settings

logger = logging.getLogger(__name__)


class NLPPipeline:
    """
    Pipeline NLP pour traiter événements et news.
    
    Fonctionnalités:
    - Traduction multi-langue (deep-translator)
    - Classification d'événements (règles-based + keywords)
    - Sentiment analysis (VADER)
    - Topic extraction
    - Impact scoring (règles-based + ML)
    """
    
    # Catégories d'événements supportées
    EVENT_CATEGORIES = [
        'concert',
        'sport',
        'conference',
        'festival',
        'crisis',
        'strike',
        'regulation',
        'other'
    ]
    
    # Mots-clés pour classification par catégorie
    EVENT_KEYWORDS = {
        'concert': [
            'concert', 'music', 'band', 'singer', 'artist', 'musician',
            'performance', 'gig', 'show', 'tour', 'live music',
            'rock', 'pop', 'jazz', 'classical', 'opera'
        ],
        'sport': [
            'sport', 'game', 'match', 'tournament', 'championship',
            'football', 'soccer', 'basketball', 'tennis', 'rugby',
            'race', 'marathon', 'olympic', 'competition', 'athletics'
        ],
        'conference': [
            'conference', 'summit', 'congress', 'symposium', 'workshop',
            'seminar', 'meeting', 'business', 'tech', 'convention'
        ],
        'festival': [
            'festival', 'celebration', 'carnival', 'fair', 'fiesta',
            'cultural', 'art', 'food', 'wine', 'beer', 'music festival'
        ],
        'crisis': [
            'crisis', 'emergency', 'disaster', 'evacuation', 'alert',
            'warning', 'catastrophe', 'flood', 'fire', 'earthquake'
        ],
        'strike': [
            'strike', 'protest', 'demonstration', 'march', 'rally',
            'union', 'labor', 'walkout', 'picket'
        ],
        'regulation': [
            'regulation', 'law', 'policy', 'rule', 'ban', 'restriction',
            'regulation', 'ordinance', 'decree', 'legislation'
        ]
    }
    
    # Topics pertinents pour le tourisme
    TOURISM_KEYWORDS = [
        'tourism', 'tourist', 'travel', 'visitor', 'vacation', 'holiday',
        'hotel', 'accommodation', 'booking', 'airbnb', 'rental',
        'attraction', 'sightseeing', 'museum', 'monument', 'beach',
        'restaurant', 'cuisine', 'dining', 'nightlife', 'entertainment',
        'festival', 'event', 'conference', 'exhibition',
        'transport', 'airport', 'train', 'metro', 'public transport',
        'safety', 'security', 'crime', 'protest', 'strike',
        'economy', 'currency', 'inflation', 'prices',
        'weather', 'climate', 'season'
    ]
    
    def __init__(self, settings: Optional[Settings] = None):
        """
        Initialise le pipeline NLP.
        
        Args:
            settings: Configuration (si None, charge depuis env)
        """
        self.settings = settings or Settings.from_env()
        self.sentiment_analyzer = None  # VADER (fallback)
        self.sentiment_pipeline = None  # XLM-RoBERTa (multi-langue)
        self.classifier = None
        self.supabase_client: Optional[Client] = None
        
        # Initialiser l'analyseur de sentiment VADER (fallback)
        if VADER_AVAILABLE:
            self.sentiment_analyzer = SentimentIntensityAnalyzer()
        
        # Initialiser le pipeline de sentiment multi-langue (lazy loading)
        self.sentiment_model_name = "cardiffnlp/twitter-xlm-roberta-base-sentiment"
        
        logger.info("Initialized NLPPipeline")
    
    def _load_sentiment_model(self):
        """Charge le modèle de sentiment multi-langue (lazy loading)."""
        if self.sentiment_pipeline is None and TRANSFORMERS_AVAILABLE:
            try:
                logger.info(f"Loading sentiment model: {self.sentiment_model_name}")
                self.sentiment_pipeline = pipeline(
                    "sentiment-analysis",
                    model=self.sentiment_model_name,
                    tokenizer=self.sentiment_model_name
                )
                logger.info("Sentiment model loaded successfully")
            except Exception as e:
                logger.error(f"Failed to load sentiment model: {e}")
                # Continuer avec VADER en fallback
    
    async def translate_text(
        self,
        text: str,
        source_lang: Optional[str] = None,
        target_lang: str = "en"
    ) -> str:
        """
        Traduit un texte d'une langue à une autre.
        
        Utilise deep-translator (Google Translate) avec fallback.
        
        Args:
            text: Texte à traduire
            source_lang: Langue source (ISO 639-1), si None détecte automatiquement
            target_lang: Langue cible (ISO 639-1, défaut: 'en')
            
        Returns:
            Texte traduit (ou texte original si traduction échoue)
        """
        if not text or not text.strip():
            return text
        
        if not TRANSLATION_AVAILABLE:
            logger.warning("Translation not available, returning original text")
            return text
        
        # Si source_lang == target_lang, retourner le texte
        if source_lang and source_lang.lower() == target_lang.lower():
            return text
        
        try:
            # Détecter la langue si non fournie
            if not source_lang:
                if DETECTION_AVAILABLE:
                    try:
                        source_lang = single_detection(text, api_key=None)
                        logger.debug(f"Detected language: {source_lang}")
                    except Exception as e:
                        logger.debug(f"Language detection failed: {e}, using auto-detect")
                        source_lang = 'auto'  # Laisser Google Translate détecter
                else:
                    source_lang = 'auto'  # Laisser Google Translate détecter
            
            # Si déjà dans la langue cible (et connu), retourner
            if source_lang != 'auto' and source_lang.lower() == target_lang.lower():
                return text
            
            # Traduire avec Google Translate
            # Utiliser 'auto' pour laisser Google détecter automatiquement si source_lang est None
            translator = GoogleTranslator(source=source_lang if source_lang != 'auto' else 'auto', target=target_lang)
            translated = translator.translate(text)
            
            logger.debug(f"Translated text from {source_lang} to {target_lang}")
            return translated
            
        except Exception as e:
            logger.error(f"Translation failed: {e}, returning original text")
            return text  # Fallback: retourner le texte original
    
    def classify_event(
        self,
        description: str,
        event_type: Optional[str] = None,
        venue_info: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Classifie un événement par catégorie.
        
        Utilise une approche basée sur keywords + règles.
        Peut être étendu avec un modèle ML (XLM-RoBERTa) si nécessaire.
        
        Args:
            description: Description de l'événement (en anglais ou original)
            event_type: Type brut si disponible (optionnel)
            venue_info: Informations sur le lieu (optionnel)
            
        Returns:
            {
                'category': str (une des EVENT_CATEGORIES),
                'subcategory': Optional[str],
                'confidence_score': float (0-100)
            }
        """
        logger.debug("Classifying event")
        
        if not description:
            return {
                "category": "other",
                "subcategory": None,
                "confidence_score": 50.0
            }
        
        # Normaliser la description (lowercase)
        desc_lower = description.lower()
        event_type_lower = event_type.lower() if event_type else ""
        
        # Scores par catégorie
        category_scores = {cat: 0.0 for cat in self.EVENT_CATEGORIES}
        
        # 1. Vérifier event_type si fourni
        if event_type_lower:
            for category, keywords in self.EVENT_KEYWORDS.items():
                if any(keyword in event_type_lower for keyword in keywords):
                    category_scores[category] += 10.0
        
        # 2. Chercher keywords dans la description
        for category, keywords in self.EVENT_KEYWORDS.items():
            matches = sum(1 for keyword in keywords if keyword in desc_lower)
            if matches > 0:
                category_scores[category] += matches * 5.0
        
        # 3. Règles spéciales
        
        # Crisis: mots spécifiques
        crisis_keywords = ['emergency', 'disaster', 'alert', 'warning', 'evacuation']
        if any(kw in desc_lower for kw in crisis_keywords):
            category_scores['crisis'] += 20.0
        
        # Strike: mots spécifiques
        strike_keywords = ['strike', 'protest', 'demonstration', 'rally']
        if any(kw in desc_lower for kw in strike_keywords):
            category_scores['strike'] += 20.0
        
        # Venue-based hints
        if venue_info:
            venue_name = venue_info.get('name', '').lower()
            venue_type = venue_info.get('type', '').lower()
            
            if 'stadium' in venue_name or 'arena' in venue_name or 'stadium' in venue_type:
                category_scores['sport'] += 15.0
            elif 'theater' in venue_name or 'theatre' in venue_name or 'auditorium' in venue_name:
                category_scores['concert'] += 10.0
            elif 'conference' in venue_name or 'convention' in venue_name:
                category_scores['conference'] += 15.0
        
        # Trouver la catégorie avec le score le plus élevé
        best_category = max(category_scores.items(), key=lambda x: x[1])
        
        # Calculer la confiance (normalisée sur 0-100)
        total_score = sum(category_scores.values())
        confidence = (best_category[1] / total_score * 100) if total_score > 0 else 0.0
        
        # Si score trop faible, classer comme "other"
        if best_category[1] < 5.0:
            best_category = ("other", 0.0)
            confidence = 50.0
        
        # Extraire une sous-catégorie si possible
        subcategory = self._extract_subcategory(desc_lower, best_category[0])
        
        result = {
            "category": best_category[0],
            "subcategory": subcategory,
            "confidence_score": min(confidence, 100.0)
        }
        
        logger.debug(f"Classified as: {result['category']} (confidence: {result['confidence_score']:.1f}%)")
        
        return result
    
    def _extract_subcategory(self, description: str, category: str) -> Optional[str]:
        """Extrait une sous-catégorie depuis la description."""
        if category == 'concert':
            if 'rock' in description:
                return 'rock_concert'
            elif 'jazz' in description:
                return 'jazz_concert'
            elif 'classical' in description or 'opera' in description:
                return 'classical_concert'
            elif 'pop' in description:
                return 'pop_concert'
        elif category == 'sport':
            if 'football' in description or 'soccer' in description:
                return 'football_match'
            elif 'basketball' in description:
                return 'basketball_game'
            elif 'tennis' in description:
                return 'tennis_match'
            elif 'marathon' in description or 'race' in description:
                return 'running_event'
        elif category == 'festival':
            if 'music' in description:
                return 'music_festival'
            elif 'food' in description:
                return 'food_festival'
            elif 'film' in description or 'cinema' in description:
                return 'film_festival'
        
        return None
    
    def calculate_impact_score(self, event_data: Dict[str, Any]) -> float:
        """
        Calcule le score d'impact d'un événement (0-100).
        
        Basé sur:
        - Type d'événement
        - Attendance estimée
        - Taille du venue
        - Historique similaire (si disponible)
        
        Args:
            event_data: Données de l'événement avec:
                - category: str
                - subcategory: Optional[str]
                - expected_attendance: Optional[int]
                - venue_capacity: Optional[int]
                - venue_size: Optional[str]
                - description: str
        
        Returns:
            Score d'impact (0-100)
        """
        logger.debug("Calculating event impact score")
        
        category = event_data.get('category', 'other')
        attendance = event_data.get('expected_attendance') or event_data.get('attendance', 0)
        venue_capacity = event_data.get('venue_capacity', 0)
        venue_size = event_data.get('venue_size', '')
        
        score = 0.0
        
        # Base score par catégorie
        category_base_scores = {
            'crisis': 90.0,  # Crises ont toujours un impact élevé
            'strike': 70.0,  # Grèves impactent fortement
            'festival': 60.0,  # Festivals attirent beaucoup de monde
            'sport': 55.0,  # Événements sportifs populaires
            'concert': 50.0,  # Concerts varient beaucoup
            'conference': 40.0,  # Conférences impactent modérément
            'regulation': 80.0,  # Réglementations peuvent impacter fortement
            'other': 30.0
        }
        
        score += category_base_scores.get(category, 30.0)
        
        # Modifier selon l'attendance
        if attendance:
            if attendance > 100000:
                score += 25.0
            elif attendance > 50000:
                score += 20.0
            elif attendance > 20000:
                score += 15.0
            elif attendance > 10000:
                score += 10.0
            elif attendance > 5000:
                score += 5.0
            elif attendance > 1000:
                score += 2.0
        
        # Modifier selon la capacité du venue
        if venue_capacity:
            if venue_capacity > 50000:
                score += 15.0
            elif venue_capacity > 20000:
                score += 10.0
            elif venue_capacity > 10000:
                score += 5.0
        
        # Modifier selon la taille du venue (si pas de capacité)
        if venue_size:
            size_lower = venue_size.lower()
            if 'large' in size_lower or 'major' in size_lower or 'stadium' in size_lower:
                score += 10.0
            elif 'medium' in size_lower:
                score += 5.0
        
        # Limiter entre 0 et 100
        score = max(0.0, min(100.0, score))
        
        logger.debug(f"Calculated impact score: {score:.1f}")
        
        return score
    
    def analyze_sentiment(
        self,
        text: str,
        language: str = "en"
    ) -> Dict[str, Any]:
        """
        Analyse le sentiment d'un texte.
        
        Utilise cardiffnlp/twitter-xlm-roberta-base-sentiment (multi-langue)
        avec fallback sur VADER si le modèle n'est pas disponible.
        
        Args:
            text: Texte à analyser
            language: Langue du texte (ISO 639-1)
            
        Returns:
            {
                'score': float (-1 à +1),
                'label': str ('positive', 'negative', 'neutral'),
                'confidence': float (0-100)
            }
        """
        if not text or not text.strip():
            return {
                "score": 0.0,
                "label": "neutral",
                "confidence": 0.0
            }
        
        logger.debug(f"Analyzing sentiment (language: {language})")
        
        # Essayer d'abord avec le modèle XLM-RoBERTa (multi-langue)
        if TRANSFORMERS_AVAILABLE:
            try:
                self._load_sentiment_model()
                
                if self.sentiment_pipeline:
                    # Le modèle XLM-RoBERTa supporte plusieurs langues
                    # Limiter la longueur du texte (max 512 tokens)
                    text_truncated = text[:1000]  # Approximatif
                    
                    result = self.sentiment_pipeline(text_truncated)[0]
                    
                    # Le modèle retourne: {'label': 'POSITIVE'/'NEGATIVE'/'NEUTRAL', 'score': float}
                    label_map = {
                        'POSITIVE': 'positive',
                        'NEGATIVE': 'negative',
                        'NEUTRAL': 'neutral',
                        'LABEL_0': 'negative',  # Certains modèles utilisent LABEL_0/1/2
                        'LABEL_1': 'neutral',
                        'LABEL_2': 'positive'
                    }
                    
                    label = label_map.get(result['label'], 'neutral')
                    score_raw = result['score']
                    
                    # Convertir en score -1 à +1
                    if label == 'positive':
                        score = score_raw  # 0 à 1
                    elif label == 'negative':
                        score = -score_raw  # -1 à 0
                    else:
                        score = 0.0
                    
                    confidence = score_raw * 100
                    
                    logger.debug(f"Sentiment (XLM-RoBERTa): {label} (score: {score:.3f})")
                    
                    return {
                        "score": score,
                        "label": label,
                        "confidence": confidence
                    }
            except Exception as e:
                logger.warning(f"XLM-RoBERTa sentiment analysis failed: {e}, falling back to VADER")
        
        # Fallback: VADER (pour anglais) ou traduction + VADER
        if language.lower() != 'en' and VADER_AVAILABLE:
            try:
                loop = asyncio.get_event_loop()
                text = loop.run_until_complete(
                    self.translate_text(text, source_lang=language, target_lang='en')
                )
            except Exception as e:
                logger.warning(f"Translation for sentiment analysis failed: {e}")
        
        if VADER_AVAILABLE and self.sentiment_analyzer:
            try:
                scores = self.sentiment_analyzer.polarity_scores(text)
                compound = scores['compound']
                
                # Déterminer le label
                if compound >= 0.05:
                    label = 'positive'
                elif compound <= -0.05:
                    label = 'negative'
                else:
                    label = 'neutral'
                
                # Confiance basée sur l'intensité
                confidence = abs(compound) * 100
                
                logger.debug(f"Sentiment (VADER): {label} (score: {compound:.3f})")
                
                return {
                    "score": compound,
                    "label": label,
                    "confidence": confidence
                }
            except Exception as e:
                logger.error(f"VADER sentiment analysis failed: {e}")
        
        # Fallback final: retourner neutre
        return {
            "score": 0.0,
            "label": "neutral",
            "confidence": 0.0
        }
    
    def extract_keywords(self, text: str, max_keywords: int = 10) -> List[str]:
        """
        Extrait les mots-clés d'un texte (alias pour extract_topics).
        
        Args:
            text: Texte à analyser
            max_keywords: Nombre maximum de keywords à retourner
            
        Returns:
            Liste de keywords
        """
        return self.extract_topics(text, max_keywords)
    
    def extract_topics(self, text: str, max_keywords: int = 10) -> List[str]:
        """
        Extrait les topics/keywords d'un texte.
        
        Priorise les mots-clés pertinents pour le tourisme.
        
        Args:
            text: Texte à analyser
            max_keywords: Nombre maximum de keywords à retourner
            
        Returns:
            Liste de keywords/topics
        """
        if not text:
            return []
        
        # Normaliser le texte
        text_lower = text.lower()
        
        # 1. Chercher les keywords de tourisme en priorité
        tourism_topics = []
        for keyword in self.TOURISM_KEYWORDS:
            if keyword in text_lower:
                tourism_topics.append(keyword)
        
        # 2. Extraire d'autres mots significatifs
        words = re.findall(r'\b[a-zA-Z]{4,}\b', text_lower)
        
        # Mots à ignorer (stop words étendus)
        stop_words = {
            'that', 'this', 'with', 'from', 'have', 'will', 'would',
            'there', 'their', 'they', 'them', 'then', 'than', 'these',
            'those', 'which', 'when', 'where', 'what', 'about', 'into',
            'could', 'should', 'would', 'might', 'must', 'shall',
            'been', 'being', 'have', 'has', 'had', 'were', 'was'
        }
        
        # Filtrer et compter
        word_freq = {}
        for word in words:
            if word not in stop_words and len(word) > 3:
                # Bonus pour les mots déjà dans tourism_keywords
                if word in self.TOURISM_KEYWORDS:
                    word_freq[word] = word_freq.get(word, 0) + 2  # Poids double
                else:
                    word_freq[word] = word_freq.get(word, 0) + 1
        
        # 3. Combiner tourism_topics et autres keywords
        all_topics = list(set(tourism_topics))  # Déjà trouvés
        
        # Ajouter les autres keywords triés par fréquence
        other_keywords = sorted(word_freq.items(), key=lambda x: x[1], reverse=True)
        for kw, freq in other_keywords:
            if kw not in all_topics:
                all_topics.append(kw)
        
        # Retourner les top max_keywords
        return all_topics[:max_keywords]
    
    def calculate_relevance_score(self, text: str, topics: List[str]) -> float:
        """
        Calcule le score de pertinence pour le tourisme (0-100).
        
        Args:
            text: Texte analysé
            topics: Topics extraits
            
        Returns:
            Score de pertinence (0-100)
        """
        if not text or not topics:
            return 0.0
        
        text_lower = text.lower()
        score = 0.0
        
        # Compter les occurrences de keywords de tourisme
        tourism_matches = sum(1 for kw in self.TOURISM_KEYWORDS if kw in text_lower)
        
        # Score basé sur les matches
        score += min(tourism_matches * 10, 60.0)  # Max 60 points
        
        # Bonus si topics contient des mots de tourisme
        tourism_topics_count = sum(1 for topic in topics if topic in self.TOURISM_KEYWORDS)
        score += min(tourism_topics_count * 5, 30.0)  # Max 30 points
        
        # Bonus pour certains contextes
        if any(word in text_lower for word in ['hotel', 'accommodation', 'booking', 'rental']):
            score += 10.0
        
        return min(100.0, score)
    
    async def enrich_events_data(self, raw_data_id: str) -> Dict[str, Any]:
        """
        Enrichit les données d'événements avec NLP.
        
        Applique:
        1. Traduction (si nécessaire)
        2. Classification
        3. Scoring d'impact
        4. Extraction de keywords
        5. Estimation du rayon d'impact
        
        Args:
            raw_data_id: ID de la donnée raw à enrichir (dans raw_events_data)
            
        Returns:
            Données enrichies
        """
        logger.info(f"Enriching events data: {raw_data_id}")
        
        if not SUPABASE_AVAILABLE or not self.settings.supabase_url:
            raise RuntimeError("Supabase not configured")
        
        try:
            # 1. Récupérer le client Supabase
            if not self.supabase_client:
                self.supabase_client = create_client(
                    self.settings.supabase_url,
                    self.settings.supabase_key
                )
            
            # 2. Lire raw_events_data
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(
                None,
                lambda: self.supabase_client.table('raw_events_data')
                    .select('*')
                    .eq('id', raw_data_id)
                    .single()
                    .execute()
            )
            
            if not response.data:
                raise ValueError(f"Raw events data not found: {raw_data_id}")
            
            raw_data = response.data
            
            # 3. Extraire les informations de l'événement
            description = raw_data.get('description', '')
            event_type = raw_data.get('event_type', '')
            event_name = raw_data.get('event_name', '')
            venue_name = raw_data.get('venue_name', '')
            venue_address = raw_data.get('venue_address', '')
            expected_attendance = raw_data.get('expected_attendance')
            
            # Détecter la langue du texte
            source_lang = None
            if description and DETECTION_AVAILABLE:
                try:
                    source_lang = single_detection(description, api_key=None)
                except Exception:
                    pass
            # Sinon, laisser Google Translate détecter automatiquement
            
            # 4. Traduire la description (si nécessaire)
            translated_description = None
            if description:
                translated_description = await self.translate_text(
                    description,
                    source_lang=source_lang,
                    target_lang='en'
                )
            
            # 5. Classifier l'événement
            # Combiner description et event_name pour la classification
            classification_text = f"{event_name} {description}".strip()
            classification_result = self.classify_event(
                description=classification_text,
                event_type=event_type,
                venue_info={
                    'name': venue_name,
                    'address': venue_address
                }
            )
            
            # 6. Calculer le score d'impact
            impact_score = self.calculate_impact_score({
                'category': classification_result['category'],
                'subcategory': classification_result['subcategory'],
                'expected_attendance': expected_attendance,
                'description': description
            })
            
            # 7. Estimer l'impact sur la demande et les prix
            expected_demand_impact = self._estimate_demand_impact(
                classification_result['category'],
                impact_score
            )
            
            expected_price_impact = self._estimate_price_impact(
                classification_result['category'],
                impact_score,
                expected_demand_impact
            )
            
            # 8. Estimer le rayon d'impact (en km)
            impact_radius_km = self._estimate_impact_radius(
                impact_score,
                expected_attendance
            )
            
            # 9. Extraire les keywords
            keywords = self.extract_keywords(
                translated_description or description,
                max_keywords=10
            )
            
            # 10. Générer un résumé (simple pour l'instant)
            summary = self._generate_summary(
                event_name,
                translated_description or description,
                max_length=200
            )
            
            # 11. Construire les données enrichies
            enriched_data = {
                'raw_data_id': raw_data_id,
                'event_category': classification_result['category'],
                'event_subcategory': classification_result['subcategory'],
                'classification_confidence': classification_result['confidence_score'],
                'event_intensity_score': impact_score,
                'expected_demand_impact': expected_demand_impact,
                'expected_price_impact': expected_price_impact,
                'impact_radius_km': impact_radius_km,
                'affected_neighborhoods': None,  # À calculer depuis la géolocalisation
                'extracted_keywords': keywords,
                'translated_description': translated_description,
                'summary': summary,
                'model_version': 'nlp-pipeline-v1.0',
                'nlp_model_version': 'keywords-classifier-v1.0',
                'enriched_at': datetime.now().isoformat()
            }
            
            # 12. Stocker dans enriched_events_data (upsert)
            await loop.run_in_executor(
                None,
                lambda: self.supabase_client.table('enriched_events_data')
                    .upsert(enriched_data, on_conflict='raw_data_id')
                    .execute()
            )
            
            logger.info(
                f"Enriched events data for {raw_data_id}: "
                f"category={classification_result['category']}, "
                f"impact_score={impact_score:.1f}"
            )
            
            return enriched_data
            
        except Exception as e:
            logger.error(f"Error enriching events data {raw_data_id}: {e}", exc_info=True)
            raise
    
    def _estimate_demand_impact(
        self,
        category: str,
        intensity_score: float
    ) -> float:
        """
        Estime l'impact sur la demande (-50 à +50).
        
        Négatif = baisse de demande, Positif = hausse de demande.
        """
        base_impacts = {
            'festival': +30.0,  # Festivals augmentent la demande
            'concert': +20.0,
            'sport': +15.0,
            'conference': +10.0,
            'crisis': -40.0,  # Crises diminuent la demande
            'strike': -30.0,  # Grèves diminuent la demande
            'regulation': -20.0,  # Réglementations peuvent diminuer
            'other': 0.0
        }
        
        base = base_impacts.get(category, 0.0)
        
        # Modifier selon l'intensité (linéaire)
        intensity_factor = (intensity_score - 50) / 50.0
        adjusted = base * (1 + intensity_factor * 0.5)
        
        # Limiter entre -50 et +50
        return max(-50.0, min(50.0, adjusted))
    
    def _estimate_price_impact(
        self,
        category: str,
        intensity_score: float,
        demand_impact: float
    ) -> float:
        """
        Estime l'impact sur les prix (-20% à +20%).
        """
        # L'impact prix est corrélé à l'impact demande mais avec un ratio plus faible
        price_impact = demand_impact * 0.4  # 40% de l'impact demande
        
        # Limiter entre -20 et +20
        return max(-20.0, min(20.0, price_impact))
    
    def _estimate_impact_radius(
        self,
        intensity_score: float,
        attendance: Optional[int] = None
    ) -> float:
        """
        Estime le rayon d'impact en km.
        """
        # Base sur l'intensité
        base_radius = intensity_score / 100 * 10  # Max 10km pour score 100
        
        # Ajuster selon l'attendance
        if attendance:
            if attendance > 100000:
                base_radius *= 2.0
            elif attendance > 50000:
                base_radius *= 1.5
            elif attendance > 20000:
                base_radius *= 1.2
        
        return min(50.0, max(1.0, base_radius))  # Entre 1 et 50 km
    
    def _generate_summary(
        self,
        event_name: str,
        description: str,
        max_length: int = 200
    ) -> str:
        """
        Génère un résumé simple de l'événement.
        """
        if not description:
            return event_name or ""
        
        # Simple: prendre les premières phrases jusqu'à max_length
        sentences = re.split(r'[.!?]+', description)
        summary = ""
        
        for sentence in sentences:
            if len(summary) + len(sentence) > max_length:
                break
            summary += sentence.strip() + ". "
        
        if not summary:
            # Si trop court, prendre le début
            summary = description[:max_length] + "..."
        
        return summary.strip()
    
    def estimate_tourism_impact(self, article_data: Dict[str, Any]) -> float:
        """
        Estime l'impact d'un article sur le tourisme (0-100).
        
        Basé sur:
        - Sentiment (positif = impact positif, négatif = impact négatif)
        - Pertinence pour le tourisme (relevance_score)
        - Topics identifiés
        - Intensité du sentiment
        
        Args:
            article_data: Données de l'article avec:
                - sentiment_score: float (-1 à +1)
                - sentiment_label: str
                - relevance_score: float (0-100)
                - main_topics: List[str]
        
        Returns:
            Score d'impact (0-100)
        """
        logger.debug("Estimating tourism impact")
        
        sentiment_score = article_data.get('sentiment_score', 0.0)
        sentiment_label = article_data.get('sentiment_label', 'neutral')
        relevance_score = article_data.get('relevance_score', 0.0)
        topics = article_data.get('main_topics', [])
        
        # Base: pertinence pour le tourisme
        impact_score = relevance_score * 0.6  # 60% basé sur pertinence
        
        # Modifier selon le sentiment
        sentiment_factor = abs(sentiment_score)  # Intensité (0-1)
        
        if sentiment_label == 'positive':
            # Sentiment positif augmente l'impact
            impact_score += sentiment_factor * 30.0
        elif sentiment_label == 'negative':
            # Sentiment négatif peut aussi avoir un impact (mais négatif)
            # On le compte quand même comme "impact" (score élevé = impact fort, même si négatif)
            impact_score += sentiment_factor * 20.0
        
        # Bonus pour certains topics critiques
        critical_topics = ['safety', 'security', 'crime', 'protest', 'strike', 'regulation']
        if any(topic in topics for topic in critical_topics):
            impact_score += 15.0
        
        # Bonus pour topics très pertinents
        high_value_topics = ['tourism', 'travel', 'visitor', 'accommodation', 'attraction']
        if any(topic in topics for topic in high_value_topics):
            impact_score += 10.0
        
        # Limiter entre 0 et 100
        impact_score = max(0.0, min(100.0, impact_score))
        
        logger.debug(f"Calculated tourism impact score: {impact_score:.1f}")
        
        return impact_score
    
    async def enrich_news_data(self, raw_data_id: str) -> Dict[str, Any]:
        """
        Enrichit les données de news avec NLP.
        
        Applique:
        1. Traduction (si nécessaire)
        2. Sentiment analysis (multi-langue)
        3. Topic extraction
        4. Calcul de pertinence
        5. Estimation d'impact tourisme
        
        Args:
            raw_data_id: ID de la donnée raw à enrichir (dans raw_news_data)
            
        Returns:
            Données enrichies
        """
        logger.info(f"Enriching news data: {raw_data_id}")
        
        if not SUPABASE_AVAILABLE or not self.settings.supabase_url:
            raise RuntimeError("Supabase not configured")
        
        try:
            # 1. Récupérer le client Supabase
            if not self.supabase_client:
                self.supabase_client = create_client(
                    self.settings.supabase_url,
                    self.settings.supabase_key
                )
            
            # 2. Lire raw_news_data
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(
                None,
                lambda: self.supabase_client.table('raw_news_data')
                    .select('*')
                    .eq('id', raw_data_id)
                    .single()
                    .execute()
            )
            
            if not response.data:
                raise ValueError(f"Raw news data not found: {raw_data_id}")
            
            raw_data = response.data
            
            # 3. Extraire les informations de l'article
            headline = raw_data.get('headline', '')
            article_text = raw_data.get('article_text', '')
            summary = raw_data.get('summary', '')
            language = raw_data.get('language', 'en')
            
            # Utiliser article_text si disponible, sinon summary, sinon headline
            text_to_analyze = article_text or summary or headline
            
            if not text_to_analyze:
                logger.warning(f"No text to analyze for news {raw_data_id}")
                return {}
            
            # 4. Traduire le headline et l'article (si nécessaire)
            translated_headline = None
            translated_article_text = None
            
            if headline and language.lower() != 'en':
                translated_headline = await self.translate_text(
                    headline,
                    source_lang=language,
                    target_lang='en'
                )
            
            if article_text and language.lower() != 'en':
                # Limiter la longueur pour éviter les coûts de traduction élevés
                article_truncated = article_text[:2000]  # Limiter à 2000 caractères
                translated_article_text = await self.translate_text(
                    article_truncated,
                    source_lang=language,
                    target_lang='en'
                )
            
            # 5. Analyser le sentiment (multi-langue, pas besoin de traduction)
            sentiment_result = self.analyze_sentiment(
                text=text_to_analyze,
                language=language
            )
            
            # 6. Extraire les topics
            # Utiliser le texte traduit si disponible pour meilleure extraction
            text_for_topics = translated_article_text or article_text or summary or headline
            topics = self.extract_topics(text_for_topics, max_keywords=10)
            
            # 7. Calculer le score de pertinence
            relevance_score = self.calculate_relevance_score(text_for_topics, topics)
            
            # 8. Estimer l'impact tourisme
            tourism_impact_score = self.estimate_tourism_impact({
                'sentiment_score': sentiment_result['score'],
                'sentiment_label': sentiment_result['label'],
                'relevance_score': relevance_score,
                'main_topics': topics
            })
            
            # 9. Déterminer le type d'impact
            if sentiment_result['score'] > 0.1:
                impact_type = 'positive'
            elif sentiment_result['score'] < -0.1:
                impact_type = 'negative'
            else:
                impact_type = 'neutral'
            
            # 10. Calculer la confiance dans l'impact
            impact_confidence = (
                sentiment_result['confidence'] * 0.4 +
                relevance_score * 0.3 +
                (tourism_impact_score / 100) * 100 * 0.3
            )
            
            # 11. Générer un résumé AI (simple pour l'instant)
            ai_summary = self._generate_summary(
                headline,
                article_text or summary,
                max_length=300
            )
            
            # 12. Construire topic_confidence_scores (simple mapping)
            topic_confidence_scores = {
                topic: 80.0 if topic in self.TOURISM_KEYWORDS else 60.0
                for topic in topics
            }
            
            # 13. Construire les données enrichies
            enriched_data = {
                'raw_data_id': raw_data_id,
                'sentiment_score': sentiment_result['score'],
                'sentiment_label': sentiment_result['label'],
                'sentiment_confidence': sentiment_result['confidence'],
                'main_topics': topics,
                'topic_confidence_scores': topic_confidence_scores,
                'relevance_score': relevance_score,
                'tourism_impact_score': tourism_impact_score,
                'impact_type': impact_type,
                'impact_confidence': impact_confidence,
                'translated_headline': translated_headline,
                'translated_article_text': translated_article_text,
                'ai_summary': ai_summary,
                'model_version': f'sentiment-{self.sentiment_model_name}-v1.0',
                'nlp_model_version': 'topics-extraction-v1.0',
                'enriched_at': datetime.now().isoformat()
            }
            
            # 14. Stocker dans enriched_news_data (upsert)
            await loop.run_in_executor(
                None,
                lambda: self.supabase_client.table('enriched_news_data')
                    .upsert(enriched_data, on_conflict='raw_data_id')
                    .execute()
            )
            
            logger.info(
                f"Enriched news data for {raw_data_id}: "
                f"sentiment={sentiment_result['label']}, "
                f"relevance={relevance_score:.1f}, "
                f"tourism_impact={tourism_impact_score:.1f}"
            )
            
            return enriched_data
            
        except Exception as e:
            logger.error(f"Error enriching news data {raw_data_id}: {e}", exc_info=True)
            raise
