"""
Collecteur de news locales (NewsAPI, Google News RSS avec fallback).
"""

import asyncio
import logging
from typing import Dict, List, Optional, Any
from datetime import date, datetime, timedelta
import re
from urllib.parse import quote_plus

import aiohttp

from .base_collector import BaseCollector
from ..config.api_keys import get_api_key, API_SERVICES

logger = logging.getLogger(__name__)


class NewsCollector(BaseCollector):
    """
    Collecteur de news locales avec support NewsAPI et Google News RSS.
    
    Collecte les articles par ville/pays et normalise les données.
    Filtre les articles pertinents pour le tourisme et les événements locaux.
    """
    
    # URLs des APIs
    NEWSAPI_BASE_URL = "https://newsapi.org/v2"
    GOOGLE_NEWS_RSS_BASE_URL = "https://news.google.com/rss"
    
    # Mots-clés pour filtrer les articles pertinents
    TOURISM_KEYWORDS = [
        'tourisme', 'tourist', 'hotel', 'hôtel', 'airbnb', 'booking',
        'vacation', 'vacances', 'holiday', 'voyage', 'travel', 'voyager',
        'beach', 'plage', 'festival', 'concert', 'event', 'événement',
        'restaurant', 'café', 'cafe', 'museum', 'musée', 'attraction',
        'visitor', 'visiteur', 'destination', 'stay', 'séjour'
    ]
    
    LOCAL_EVENT_KEYWORDS = [
        'event', 'événement', 'festival', 'concert', 'exhibition', 'exposition',
        'show', 'spectacle', 'match', 'game', 'tournament', 'tournoi',
        'conference', 'conférence', 'summit', 'sommet'
    ]
    
    def __init__(
        self,
        primary_source: str = "newsapi",
        fallback_source: Optional[str] = "google_news_rss",
        api_key: Optional[str] = None,
        days_back: int = 1,
        max_articles: int = 100,
        filter_relevant: bool = True,
        **kwargs
    ):
        """
        Initialise le collecteur de news.
        
        Args:
            primary_source: Source primaire ('newsapi' ou 'google_news_rss')
            fallback_source: Source de fallback (None pour désactiver)
            api_key: Clé API (si None, récupère depuis env)
            days_back: Nombre de jours en arrière pour collecter (défaut: 1 = dernières 24h)
            max_articles: Nombre maximum d'articles à collecter
            filter_relevant: Si True, filtre les articles pertinents pour le tourisme
            **kwargs: Arguments additionnels pour BaseCollector
        """
        self.primary_source = primary_source.lower()
        self.fallback_source = fallback_source.lower() if fallback_source else None
        self.days_back = days_back
        self.max_articles = max_articles
        self.filter_relevant = filter_relevant
        
        # Récupérer les clés API
        self.api_keys = {}
        if self.primary_source == "newsapi":
            self.api_keys["newsapi"] = api_key or get_api_key(API_SERVICES.NEWSAPI)
        
        if self.fallback_source == "newsapi":
            self.api_keys["newsapi"] = self.api_keys.get("newsapi") or get_api_key(API_SERVICES.NEWSAPI)
        
        # Utiliser la clé de la source primaire pour BaseCollector
        primary_api_key = self.api_keys.get(self.primary_source)
        
        super().__init__(
            source_name=f"news_{self.primary_source}",
            api_key=primary_api_key,
            **kwargs
        )
        
        logger.info(
            f"Initialized NewsCollector (primary: {self.primary_source}, "
            f"fallback: {self.fallback_source}, days_back: {days_back})"
        )
    
    async def collect(
        self,
        city: str,
        country: str,
        days_back: Optional[int] = None,
        store_in_db: bool = True
    ) -> List[Dict[str, Any]]:
        """
        Collecte les news pour une ville donnée.
        
        Args:
            city: Nom de la ville
            country: Code pays (ISO 3166-1 alpha-2)
            days_back: Nombre de jours en arrière (si None, utilise self.days_back)
            store_in_db: Si True, stocke dans Supabase
            
        Returns:
            Liste d'articles normalisés
        """
        if days_back is None:
            days_back = self.days_back
        
        # Initialiser la session si nécessaire
        if not self.session:
            self.session = aiohttp.ClientSession()
        
        try:
            # Rate limiting
            if self.rate_limiter:
                await self.rate_limiter.acquire()
            
            # Collecte des données
            raw_data = await self._fetch_data(city, country, days_back)
            
            # Normalisation
            normalized_data = self._normalize(raw_data, city, country)
            
            # Filtrage des articles pertinents
            if self.filter_relevant and normalized_data:
                normalized_data = self._filter_relevant_articles(normalized_data)
            
            # Limiter le nombre d'articles
            if len(normalized_data) > self.max_articles:
                normalized_data = normalized_data[:self.max_articles]
            
            # Stockage
            if store_in_db and normalized_data:
                await self._store_raw_data(normalized_data)
            
            logger.info(
                f"Collected {len(normalized_data)} news articles for {city}, {country}"
            )
            
            return normalized_data
            
        except Exception as e:
            logger.error(f"Error collecting news for {city}, {country}: {e}", exc_info=True)
            raise
    
    async def _fetch_data(
        self,
        city: str,
        country: str,
        days_back: int
    ) -> Dict[str, Any]:
        """
        Récupère les données brutes depuis l'API.
        
        Args:
            city: Nom de la ville
            country: Code pays
            days_back: Nombre de jours en arrière
            
        Returns:
            Dict avec les données brutes
        """
        # Essayer la source primaire
        try:
            if self.primary_source == "newsapi":
                return await self._fetch_newsapi(city, country, days_back)
            elif self.primary_source == "google_news_rss":
                return await self._fetch_google_news_rss(city, country, days_back)
        except Exception as e:
            logger.warning(f"Primary source {self.primary_source} failed: {e}")
            
            # Essayer le fallback
            if self.fallback_source:
                try:
                    if self.fallback_source == "newsapi":
                        return await self._fetch_newsapi(city, country, days_back)
                    elif self.fallback_source == "google_news_rss":
                        return await self._fetch_google_news_rss(city, country, days_back)
                except Exception as fallback_error:
                    logger.error(f"Fallback source {self.fallback_source} also failed: {fallback_error}")
        
        # Si toutes les sources échouent, retourner une liste vide
        logger.warning("All news sources failed, returning empty list")
        return {
            'source': 'none',
            'articles': []
        }
    
    async def _fetch_newsapi(
        self,
        city: str,
        country: str,
        days_back: int
    ) -> Dict[str, Any]:
        """
        Récupère les articles depuis NewsAPI.
        """
        api_key = self.api_keys.get("newsapi")
        if not api_key:
            raise ValueError("NewsAPI key not configured")
        
        # Calculer la date de début
        from_date = (datetime.now() - timedelta(days=days_back)).strftime('%Y-%m-%d')
        
        # Construire la requête de recherche
        # NewsAPI nécessite un terme de recherche
        query = f"{city} {country}"
        
        url = f"{self.NEWSAPI_BASE_URL}/everything"
        
        all_articles = []
        page = 1
        page_size = 100
        max_pages = (self.max_articles // page_size) + 1
        
        while page <= max_pages:
            params = {
                'apiKey': api_key,
                'q': query,
                'from': from_date,
                'sortBy': 'publishedAt',
                'language': self._detect_language_from_country(country),
                'page': page,
                'pageSize': page_size
            }
            
            try:
                async with self.session.get(url, params=params) as response:
                    if response.status == 200:
                        data = await response.json()
                        articles = data.get('articles', [])
                        
                        if not articles:
                            break
                        
                        all_articles.extend(articles)
                        
                        # Vérifier s'il y a plus de pages
                        total_results = data.get('totalResults', 0)
                        if len(all_articles) >= total_results or len(articles) < page_size:
                            break
                        
                        page += 1
                    elif response.status == 429:
                        logger.warning("NewsAPI rate limit hit, waiting...")
                        await asyncio.sleep(60)  # Attendre 1 minute
                        continue
                    else:
                        error_text = await response.text()
                        raise Exception(f"NewsAPI error {response.status}: {error_text}")
            
            except aiohttp.ClientError as e:
                logger.error(f"Error fetching NewsAPI page {page}: {e}")
                break
        
        return {
            'source': 'newsapi',
            'articles': all_articles,
            'total': len(all_articles)
        }
    
    async def _fetch_google_news_rss(
        self,
        city: str,
        country: str,
        days_back: int
    ) -> Dict[str, Any]:
        """
        Récupère les articles depuis Google News RSS.
        
        Note: Google News RSS ne nécessite pas de clé API mais a des limitations.
        """
        # Construire la requête de recherche
        query = f"{city} {country}"
        encoded_query = quote_plus(query)
        
        # URL Google News RSS
        url = f"{self.GOOGLE_NEWS_RSS_BASE_URL}/search?q={encoded_query}&hl=fr&gl={country.lower()}&ceid={country.lower()}:fr"
        
        try:
            async with self.session.get(url) as response:
                if response.status == 200:
                    xml_content = await response.text()
                    
                    # Parser le RSS XML (basique)
                    articles = self._parse_rss_xml(xml_content, city, country)
                    
                    # Filtrer par date (derniers N jours)
                    cutoff_date = datetime.now() - timedelta(days=days_back)
                    filtered_articles = []
                    
                    for article in articles:
                        pub_date = article.get('published_at')
                        if pub_date and pub_date >= cutoff_date:
                            filtered_articles.append(article)
                    
                    return {
                        'source': 'google_news_rss',
                        'articles': filtered_articles,
                        'total': len(filtered_articles)
                    }
                else:
                    error_text = await response.text()
                    raise Exception(f"Google News RSS error {response.status}: {error_text}")
        
        except Exception as e:
            logger.error(f"Error fetching Google News RSS: {e}")
            raise
    
    def _parse_rss_xml(
        self,
        xml_content: str,
        city: str,
        country: str
    ) -> List[Dict[str, Any]]:
        """
        Parse le contenu RSS XML de Google News.
        
        Utilise feedparser si disponible, sinon parsing basique avec regex.
        """
        # Essayer d'utiliser feedparser si disponible
        try:
            import feedparser
            feed = feedparser.parse(xml_content)
            articles = []
            
            for entry in feed.entries:
                try:
                    # Parser la date
                    pub_date = entry.get('published_parsed')
                    if pub_date:
                        from time import struct_time
                        if isinstance(pub_date, struct_time):
                            pub_date = datetime(*pub_date[:6])
                        else:
                            pub_date = datetime.now()
                    else:
                        pub_date = datetime.now()
                    
                    articles.append({
                        'title': entry.get('title', ''),
                        'description': entry.get('summary', ''),
                        'url': entry.get('link', ''),
                        'publishedAt': pub_date.isoformat() if isinstance(pub_date, datetime) else pub_date,
                        'source': {'name': entry.get('source', {}).get('title', '') if hasattr(entry, 'source') else ''},
                        'content': entry.get('summary', '')
                    })
                except Exception as e:
                    logger.warning(f"Error parsing feedparser entry: {e}")
                    continue
            
            return articles
        
        except ImportError:
            # Fallback: parsing basique avec regex
            logger.debug("feedparser not available, using basic regex parsing")
            pass  # Continue avec le parsing regex ci-dessous
        
        # Fallback: parsing basique avec regex
        articles = []
        
        # Regex pour extraire les items
        item_pattern = r'<item>(.*?)</item>'
        items = re.findall(item_pattern, xml_content, re.DOTALL)
        
        for item in items:
            try:
                # Extraire le titre
                title_match = re.search(r'<title><!\[CDATA\[(.*?)\]\]></title>', item)
                title = title_match.group(1) if title_match else ''
                
                # Extraire le lien
                link_match = re.search(r'<link>(.*?)</link>', item)
                link = link_match.group(1) if link_match else ''
                
                # Extraire la description
                desc_match = re.search(r'<description><!\[CDATA\[(.*?)\]\]></description>', item)
                description = desc_match.group(1) if desc_match else ''
                
                # Extraire la date de publication
                pub_match = re.search(r'<pubDate>(.*?)</pubDate>', item)
                pub_date_str = pub_match.group(1) if pub_match else ''
                
                # Parser la date
                try:
                    from email.utils import parsedate_to_datetime
                    pub_date = parsedate_to_datetime(pub_date_str)
                except:
                    pub_date = datetime.now()
                
                # Extraire le source (media)
                source_match = re.search(r'<source>(.*?)</source>', item)
                source_name = source_match.group(1) if source_match else ''
                
                if title and link:
                    articles.append({
                        'title': title,
                        'description': description,
                        'url': link,
                        'publishedAt': pub_date.isoformat() if isinstance(pub_date, datetime) else pub_date_str,
                        'source': {'name': source_name},
                        'content': description  # Pour Google News RSS, description = contenu
                    })
            
            except Exception as e:
                logger.warning(f"Error parsing RSS item: {e}")
                continue
        
        return articles
        articles = []
        
        # Regex pour extraire les items
        item_pattern = r'<item>(.*?)</item>'
        items = re.findall(item_pattern, xml_content, re.DOTALL)
        
        for item in items:
            try:
                # Extraire le titre
                title_match = re.search(r'<title><!\[CDATA\[(.*?)\]\]></title>', item)
                title = title_match.group(1) if title_match else ''
                
                # Extraire le lien
                link_match = re.search(r'<link>(.*?)</link>', item)
                link = link_match.group(1) if link_match else ''
                
                # Extraire la description
                desc_match = re.search(r'<description><!\[CDATA\[(.*?)\]\]></description>', item)
                description = desc_match.group(1) if desc_match else ''
                
                # Extraire la date de publication
                pub_match = re.search(r'<pubDate>(.*?)</pubDate>', item)
                pub_date_str = pub_match.group(1) if pub_match else ''
                
                # Parser la date
                try:
                    from email.utils import parsedate_to_datetime
                    pub_date = parsedate_to_datetime(pub_date_str)
                except:
                    pub_date = datetime.now()
                
                # Extraire le source (media)
                source_match = re.search(r'<source>(.*?)</source>', item)
                source_name = source_match.group(1) if source_match else ''
                
                if title and link:
                    articles.append({
                        'title': title,
                        'description': description,
                        'url': link,
                        'publishedAt': pub_date.isoformat() if isinstance(pub_date, datetime) else pub_date_str,
                        'source': {'name': source_name},
                        'content': description  # Pour Google News RSS, description = contenu
                    })
            
            except Exception as e:
                logger.warning(f"Error parsing RSS item: {e}")
                continue
        
        return articles
    
    def _detect_language_from_country(self, country: str) -> str:
        """
        Détecte la langue principale d'un pays.
        """
        language_map = {
            'FR': 'fr',
            'US': 'en',
            'GB': 'en',
            'DE': 'de',
            'ES': 'es',
            'IT': 'it',
            'PT': 'pt',
            'NL': 'nl',
            'BE': 'fr',  # Belgique (français)
            'CH': 'de',  # Suisse (allemand)
            'CA': 'en',  # Canada (anglais)
            'AU': 'en',
            'NZ': 'en'
        }
        
        return language_map.get(country.upper(), 'en')
    
    def _filter_relevant_articles(
        self,
        articles: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """
        Filtre les articles pertinents pour le tourisme et les événements locaux.
        """
        relevant_articles = []
        
        for article in articles:
            # Combiner titre, description et contenu pour la recherche
            text_to_search = ' '.join([
                article.get('headline', ''),
                article.get('article_text', ''),
                article.get('summary', ''),
                article.get('description', '')
            ]).lower()
            
            # Vérifier si l'article contient des mots-clés pertinents
            is_relevant = False
            
            # Vérifier les mots-clés de tourisme
            for keyword in self.TOURISM_KEYWORDS:
                if keyword.lower() in text_to_search:
                    is_relevant = True
                    break
            
            # Vérifier les mots-clés d'événements locaux
            if not is_relevant:
                for keyword in self.LOCAL_EVENT_KEYWORDS:
                    if keyword.lower() in text_to_search:
                        is_relevant = True
                        break
            
            if is_relevant:
                relevant_articles.append(article)
        
        logger.info(
            f"Filtered {len(relevant_articles)} relevant articles "
            f"out of {len(articles)} total articles"
        )
        
        return relevant_articles
    
    def _normalize(
        self,
        raw_response: Dict[str, Any],
        city: str,
        country: str
    ) -> List[Dict[str, Any]]:
        """
        Normalise les données brutes vers le format raw_news_data.
        
        Args:
            raw_response: Réponse brute de l'API
            city: Nom de la ville
            country: Code pays
            
        Returns:
            Liste de dicts normalisés
        """
        source = raw_response.get('source', self.primary_source)
        articles = raw_response.get('articles', [])
        
        if not articles:
            logger.warning(f"No articles found in response from {source}")
            return []
        
        normalized = []
        
        for article in articles:
            try:
                if source == 'newsapi':
                    record = self._normalize_newsapi(article, city, country)
                elif source == 'google_news_rss':
                    record = self._normalize_google_rss(article, city, country)
                else:
                    # Format générique
                    record = self._normalize_generic(article, city, country, source)
                
                if record:
                    normalized.append(record)
            
            except Exception as e:
                logger.error(f"Error normalizing article: {e}", exc_info=True)
                continue
        
        logger.info(f"Normalized {len(normalized)} articles from {source}")
        return normalized
    
    def _normalize_newsapi(
        self,
        article: Dict[str, Any],
        city: str,
        country: str
    ) -> Optional[Dict[str, Any]]:
        """
        Normalise un article NewsAPI.
        """
        # Headline
        headline = article.get('title', '')
        if not headline:
            return None
        
        # Date de publication
        published_at_str = article.get('publishedAt', '')
        if not published_at_str:
            return None
        
        try:
            # Parser ISO format
            published_at = datetime.fromisoformat(published_at_str.replace('Z', '+00:00'))
        except:
            try:
                published_at = datetime.strptime(published_at_str, '%Y-%m-%dT%H:%M:%SZ')
            except:
                published_at = datetime.now()
        
        # Description / Résumé
        description = article.get('description', '')
        content = article.get('content', '') or description
        
        # URL
        url = article.get('url', '')
        
        # Source media
        source_info = article.get('source', {})
        source_name = source_info.get('name', '') if isinstance(source_info, dict) else str(source_info)
        
        # Auteur
        author = article.get('author', '')
        
        # Image
        image_url = article.get('urlToImage', '')
        
        # Détecter la langue
        language = self._detect_language_from_country(country)
        
        return {
            'source': 'newsapi',
            'country': country,
            'city': city,
            'published_at': published_at.isoformat(),
            'headline': headline,
            'article_text': content,
            'summary': description,
            'url': url,
            'author': author,
            'language': language,
            'source_media': source_name,
            'image_url': image_url,
            'sentiment_score': None,  # Sera calculé par NLP Pipeline
            'topics': None,  # Sera extrait par NLP Pipeline
            'metadata': {
                'newsapi_article_id': article.get('url', '').split('/')[-1] if url else None
            },
            'raw_data': article,
            'collected_at': datetime.now().isoformat()
        }
    
    def _normalize_google_rss(
        self,
        article: Dict[str, Any],
        city: str,
        country: str
    ) -> Optional[Dict[str, Any]]:
        """
        Normalise un article Google News RSS.
        """
        # Headline
        headline = article.get('title', '')
        if not headline:
            return None
        
        # Date de publication
        published_at_str = article.get('publishedAt', '')
        if not published_at_str:
            return None
        
        try:
            published_at = datetime.fromisoformat(published_at_str.replace('Z', '+00:00'))
        except:
            published_at = datetime.now()
        
        # Description / Contenu
        description = article.get('description', '')
        content = article.get('content', '') or description
        
        # URL
        url = article.get('url', '')
        
        # Source media
        source_info = article.get('source', {})
        source_name = source_info.get('name', '') if isinstance(source_info, dict) else str(source_info)
        
        # Détecter la langue
        language = self._detect_language_from_country(country)
        
        return {
            'source': 'google_news_rss',
            'country': country,
            'city': city,
            'published_at': published_at.isoformat(),
            'headline': headline,
            'article_text': content,
            'summary': description,
            'url': url,
            'author': None,
            'language': language,
            'source_media': source_name,
            'image_url': None,
            'sentiment_score': None,
            'topics': None,
            'metadata': {
                'google_news_rss': True
            },
            'raw_data': article,
            'collected_at': datetime.now().isoformat()
        }
    
    def _normalize_generic(
        self,
        article: Dict[str, Any],
        city: str,
        country: str,
        source: str
    ) -> Optional[Dict[str, Any]]:
        """
        Normalise un article depuis un format générique.
        """
        headline = article.get('title') or article.get('headline', '')
        if not headline:
            return None
        
        # Date
        published_at_str = article.get('publishedAt') or article.get('published_at') or article.get('date', '')
        if published_at_str:
            try:
                published_at = datetime.fromisoformat(published_at_str.replace('Z', '+00:00'))
            except:
                published_at = datetime.now()
        else:
            published_at = datetime.now()
        
        # Contenu
        content = article.get('content') or article.get('article_text') or article.get('description', '')
        summary = article.get('summary') or article.get('description', '')
        
        # URL
        url = article.get('url') or article.get('link', '')
        
        # Source media
        source_info = article.get('source', {})
        source_name = source_info.get('name', '') if isinstance(source_info, dict) else str(source_info)
        
        # Auteur
        author = article.get('author', '')
        
        # Image
        image_url = article.get('image_url') or article.get('urlToImage', '')
        
        # Langue
        language = article.get('language') or self._detect_language_from_country(country)
        
        return {
            'source': source,
            'country': country,
            'city': city,
            'published_at': published_at.isoformat(),
            'headline': headline,
            'article_text': content,
            'summary': summary,
            'url': url,
            'author': author,
            'language': language,
            'source_media': source_name,
            'image_url': image_url,
            'sentiment_score': None,
            'topics': None,
            'metadata': article.get('metadata', {}),
            'raw_data': article,
            'collected_at': datetime.now().isoformat()
        }
