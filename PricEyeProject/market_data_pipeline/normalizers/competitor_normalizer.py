"""
Normaliseur de données concurrents (Apify, CSV historiques AirDNA/Lighthouse).
"""

import logging
import statistics
from typing import Dict, Any, Optional, List
from datetime import date, datetime

logger = logging.getLogger(__name__)


class CompetitorNormalizer:
    """
    Normalise les réponses concurrents vers le schéma raw_competitor_data.
    
    Supporte :
    - Apify (scraping Airbnb) : format JSON
    - CSV historiques AirDNA : format CSV parsé
    - CSV historiques Lighthouse : format CSV parsé
    """
    
    def __init__(self, source: Optional[str] = None):
        """
        Initialise le normaliseur.
        
        Args:
            source: Source (détectée automatiquement si None)
        """
        self.source = source.lower() if source else None
        logger.info(f"Initialized CompetitorNormalizer (source: {self.source or 'auto-detect'})")
    
    def normalize(
        self,
        raw_response: Dict[str, Any],
        country: str,
        city: str,
        data_date: date,
        source: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Normalise une réponse vers le schéma raw_competitor_data.
        
        Args:
            raw_response: Données brutes (format Apify, CSV parsé, etc.)
            country: Pays
            city: Ville
            data_date: Date des données
            source: Source (auto-détectée si None)
        
        Returns:
            Données normalisées selon schéma raw_competitor_data
        
        Raises:
            ValueError: Si les données sont invalides
        """
        source = source or self.source or self._detect_source(raw_response)
        
        logger.debug(
            f"Normalizing competitor data from {source} "
            f"for {city}, {country} on {data_date}"
        )
        
        if source.startswith('apify') or source == 'competitor_apify':
            return self._normalize_apify(raw_response, country, city, data_date)
        elif 'airdna' in source.lower():
            return self._normalize_airdna_csv(raw_response, country, city, data_date)
        elif 'lighthouse' in source.lower():
            return self._normalize_lighthouse_csv(raw_response, country, city, data_date)
        else:
            logger.warning(f"Unknown source format: {source}, attempting generic normalization")
            return self._normalize_generic(raw_response, country, city, data_date, source)
    
    def _normalize_apify(
        self,
        raw_response: Dict[str, Any],
        country: str,
        city: str,
        data_date: date
    ) -> Dict[str, Any]:
        """
        Normalise les données Apify (scraping Airbnb).
        
        Format attendu :
        {
            'items': [
                {
                    'pricing': {'price': 150, 'currency': 'EUR', 'date': '2024-01-15'},
                    'bedrooms': 2,
                    ...
                },
                ...
            ]
        }
        """
        items = raw_response.get('items', [])
        
        if not items:
            raise ValueError("No items found in Apify response")
        
        # Extraire les prix pour cette date
        prices = []
        price_data_list = []
        
        for item in items:
            pricing = item.get('pricing') or item.get('priceDetails') or {}
            
            # Extraire la date
            item_date_str = pricing.get('date') or item.get('checkInDate')
            if item_date_str:
                try:
                    item_date = datetime.fromisoformat(
                        item_date_str.replace('Z', '+00:00')
                    ).date()
                except (ValueError, AttributeError):
                    try:
                        item_date = datetime.strptime(item_date_str, '%Y-%m-%d').date()
                    except ValueError:
                        continue
            else:
                continue
            
            # Filtrer par date
            if item_date != data_date:
                continue
            
            # Extraire le prix
            price = pricing.get('price') or pricing.get('amount')
            if price is None:
                continue
            
            try:
                price_float = float(price)
                currency = pricing.get('currency') or item.get('currency') or 'EUR'
                
                prices.append(price_float)
                price_data_list.append({
                    'price': price_float,
                    'currency': currency,
                    'listing': item
                })
            except (ValueError, TypeError):
                logger.warning(f"Could not convert price to float: {price}")
                continue
        
        if not prices:
            raise ValueError(f"No prices found for date {data_date}")
        
        # Calculer les statistiques
        prices_sorted = sorted(prices)
        n = len(prices_sorted)
        
        # Extraire métadonnées
        bedrooms = self._extract_common_value(
            [item.get('bedrooms') for item in items if item.get('bedrooms')]
        )
        bathrooms = self._extract_common_value(
            [item.get('bathrooms') for item in items if item.get('bathrooms')]
        )
        property_type = self._extract_common_value(
            [item.get('propertyType') or item.get('type') for item in items]
        )
        
        currency = price_data_list[0]['currency'] if price_data_list else 'EUR'
        
        normalized = {
            'source': 'apify',
            'country': country,
            'city': city,
            'neighborhood': None,  # Pas toujours disponible dans Apify
            'property_type': property_type,
            'bedrooms': bedrooms,
            'bathrooms': bathrooms,
            'data_date': data_date.isoformat(),
            'collected_at': datetime.now().isoformat(),
            'raw_data': {
                'apify_response': raw_response,
                'price_data': price_data_list[:10]  # Échantillon
            },
            'avg_price': round(statistics.mean(prices), 2),
            'min_price': round(min(prices), 2),
            'max_price': round(max(prices), 2),
            'p25_price': round(
                statistics.quantiles(prices, n=4)[0] if n >= 4 else prices_sorted[0],
                2
            ),
            'p50_price': round(statistics.median(prices), 2),
            'p75_price': round(
                statistics.quantiles(prices, n=4)[2] if n >= 4 else prices_sorted[-1],
                2
            ),
            'sample_size': n,
            'currency': currency,
            'timezone': None,  # À déterminer depuis city/country
            'metadata': {
                'source': 'apify',
                'competitor_count': n,
                'scraping_date': datetime.now().isoformat()
            }
        }
        
        logger.info(
            f"Normalized {n} Apify listings for {city} on {data_date}: "
            f"avg={normalized['avg_price']} {currency}"
        )
        
        return normalized
    
    def _normalize_airdna_csv(
        self,
        raw_response: Dict[str, Any],
        country: str,
        city: str,
        data_date: date
    ) -> Dict[str, Any]:
        """
        Normalise les données CSV AirDNA (historiques).
        
        Format attendu (déjà parsé depuis CSV) :
        {
            'data_date': '2024-01-15',
            'property_type': 'apartment',
            'bedrooms': 2,
            'avg_price': 150.0,
            'min_price': 120.0,
            'max_price': 180.0,
            'occupancy': 0.75,
            'currency': 'EUR',
            'raw_row': {...}
        }
        """
        normalized = {
            'source': 'historical_csv_airdna',
            'country': country,
            'city': city,
            'neighborhood': raw_response.get('neighborhood'),
            'property_type': raw_response.get('property_type', 'unknown').lower(),
            'bedrooms': self._parse_int(raw_response.get('bedrooms')),
            'bathrooms': self._parse_int(raw_response.get('bathrooms')),
            'data_date': data_date.isoformat(),
            'collected_at': datetime.now().isoformat(),
            'raw_data': {
                'imported_from': 'csv_airdna',
                'raw_row': raw_response.get('raw_row', {}),
                'import_date': datetime.now().isoformat()
            },
            'avg_price': round(float(raw_response.get('avg_price', 0)), 2),
            'min_price': round(
                float(raw_response.get('min_price', raw_response.get('avg_price', 0))),
                2
            ),
            'max_price': round(
                float(raw_response.get('max_price', raw_response.get('avg_price', 0))),
                2
            ),
            'p25_price': round(
                float(raw_response.get('p25_price', raw_response.get('min_price', 0))),
                2
            ),
            'p50_price': round(
                float(raw_response.get('p50_price', raw_response.get('avg_price', 0))),
                2
            ),
            'p75_price': round(
                float(raw_response.get('p75_price', raw_response.get('max_price', 0))),
                2
            ),
            'sample_size': raw_response.get('sample_size'),  # Généralement inconnu pour CSV
            'currency': (raw_response.get('currency') or 'EUR').upper(),
            'timezone': None,
            'metadata': {
                'import_source': 'historical_csv_airdna',
                'occupancy': raw_response.get('occupancy'),
                'import_date': datetime.now().isoformat()
            }
        }
        
        logger.debug(f"Normalized AirDNA CSV data for {city} on {data_date}")
        return normalized
    
    def _normalize_lighthouse_csv(
        self,
        raw_response: Dict[str, Any],
        country: str,
        city: str,
        data_date: date
    ) -> Dict[str, Any]:
        """
        Normalise les données CSV Lighthouse (historiques).
        
        Format similaire à AirDNA mais peut avoir des variations.
        """
        # Lighthouse format est très similaire à AirDNA
        normalized = self._normalize_airdna_csv(raw_response, country, city, data_date)
        normalized['source'] = 'historical_csv_lighthouse'
        normalized['raw_data']['imported_from'] = 'csv_lighthouse'
        normalized['metadata']['import_source'] = 'historical_csv_lighthouse'
        
        return normalized
    
    def _normalize_generic(
        self,
        raw_response: Dict[str, Any],
        country: str,
        city: str,
        data_date: date,
        source: str
    ) -> Dict[str, Any]:
        """
        Normalisation générique (tente d'extraire les champs communs).
        """
        logger.warning(f"Using generic normalization for source: {source}")
        
        # Tenter d'extraire les prix
        avg_price = self._extract_price(raw_response, ['avg_price', 'average_price', 'price', 'ADR'])
        min_price = self._extract_price(raw_response, ['min_price', 'floor_price', 'minimum_price'])
        max_price = self._extract_price(raw_response, ['max_price', 'ceiling_price', 'maximum_price'])
        
        return {
            'source': source,
            'country': country,
            'city': city,
            'neighborhood': raw_response.get('neighborhood'),
            'property_type': raw_response.get('property_type', 'unknown'),
            'bedrooms': self._parse_int(raw_response.get('bedrooms')),
            'bathrooms': self._parse_int(raw_response.get('bathrooms')),
            'data_date': data_date.isoformat(),
            'collected_at': datetime.now().isoformat(),
            'raw_data': raw_response,
            'avg_price': round(avg_price, 2) if avg_price else None,
            'min_price': round(min_price, 2) if min_price else None,
            'max_price': round(max_price, 2) if max_price else None,
            'p25_price': round(min_price or avg_price or 0, 2) if min_price or avg_price else None,
            'p50_price': round(avg_price or 0, 2) if avg_price else None,
            'p75_price': round(max_price or avg_price or 0, 2) if max_price or avg_price else None,
            'sample_size': raw_response.get('sample_size'),
            'currency': (raw_response.get('currency') or 'EUR').upper(),
            'timezone': raw_response.get('timezone'),
            'metadata': {
                'source': source,
                'normalization': 'generic'
            }
        }
    
    def validate(self, normalized_data: Dict[str, Any]) -> bool:
        """
        Valide les données normalisées.
        
        Args:
            normalized_data: Données à valider
        
        Returns:
            True si valides, False sinon
        
        Raises:
            ValueError: Si les données sont invalides (avec message détaillé)
        """
        errors = []
        
        # Vérifier les champs requis
        required_fields = ['source', 'country', 'city', 'data_date', 'avg_price']
        for field in required_fields:
            if field not in normalized_data or normalized_data[field] is None:
                errors.append(f"Missing required field: {field}")
        
        # Valider les prix
        avg_price = normalized_data.get('avg_price')
        if avg_price is not None:
            if not isinstance(avg_price, (int, float)) or avg_price <= 0:
                errors.append(f"Invalid avg_price: {avg_price} (must be > 0)")
        
        # Valider les percentiles (cohérence)
        if avg_price:
            min_price = normalized_data.get('min_price', avg_price)
            max_price = normalized_data.get('max_price', avg_price)
            p25 = normalized_data.get('p25_price', min_price)
            p50 = normalized_data.get('p50_price', avg_price)
            p75 = normalized_data.get('p75_price', max_price)
            
            # Vérifier la cohérence : min <= p25 <= p50 <= p75 <= max
            if not (min_price <= p25 <= p50 <= p75 <= max_price):
                errors.append(
                    f"Inconsistent percentiles: min={min_price}, p25={p25}, "
                    f"p50={p50}, p75={p75}, max={max_price}"
                )
        
        # Valider la date
        data_date_str = normalized_data.get('data_date')
        if data_date_str:
            try:
                datetime.fromisoformat(data_date_str)
            except (ValueError, TypeError):
                errors.append(f"Invalid date format: {data_date_str}")
        
        # Valider la devise
        currency = normalized_data.get('currency')
        if currency and not isinstance(currency, str) or len(currency) != 3:
            errors.append(f"Invalid currency code: {currency}")
        
        if errors:
            error_message = "Validation errors:\n" + "\n".join(f"  - {e}" for e in errors)
            logger.error(f"Validation failed for competitor data:\n{error_message}")
            raise ValueError(error_message)
        
        logger.debug("Competitor data validation passed")
        return True
    
    # Helper methods
    
    def _detect_source(self, raw_response: Dict[str, Any]) -> str:
        """Détecte la source depuis les données brutes."""
        if 'items' in raw_response and isinstance(raw_response['items'], list):
            return 'apify'
        elif 'raw_row' in raw_response:
            if 'airdna' in str(raw_response.get('source', '')).lower():
                return 'historical_csv_airdna'
            elif 'lighthouse' in str(raw_response.get('source', '')).lower():
                return 'historical_csv_lighthouse'
        return 'unknown'
    
    def _extract_common_value(self, values: List[Any]) -> Optional[Any]:
        """Extrait la valeur la plus commune d'une liste."""
        if not values:
            return None
        
        # Filtrer None
        values = [v for v in values if v is not None]
        if not values:
            return None
        
        # Retourner la valeur la plus fréquente
        try:
            return max(set(values), key=values.count)
        except (TypeError, ValueError):
            return values[0]
    
    def _extract_price(self, data: Dict[str, Any], keys: List[str]) -> Optional[float]:
        """Extrait un prix depuis plusieurs clés possibles."""
        for key in keys:
            value = data.get(key)
            if value is not None:
                try:
                    return float(value)
                except (ValueError, TypeError):
                    continue
        return None
    
    def _parse_int(self, value: Any) -> Optional[int]:
        """Parse un int."""
        if value is None or value == '':
            return None
        try:
            return int(float(str(value).strip()))
        except (ValueError, TypeError):
            return None
