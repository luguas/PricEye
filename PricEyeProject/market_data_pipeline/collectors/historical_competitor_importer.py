"""
Importeur de données historiques depuis CSV (AirDNA, Lighthouse).

Script one-off pour importer des exports CSV ponctuels achetés chez AirDNA ou Lighthouse.
Ces données sont utilisées UNIQUEMENT pour l'entraînement initial de l'IA.
Une fois le modèle entraîné, on utilise uniquement les données live (Apify).
"""

import argparse
import asyncio
import csv
import json
import logging
import os
from datetime import datetime, date
from typing import Dict, List, Optional, Any
from pathlib import Path

try:
    from supabase import create_client, Client
    SUPABASE_AVAILABLE = True
except ImportError:
    SUPABASE_AVAILABLE = False
    logging.warning("Supabase client not available. Install with: pip install supabase")

from ..config.settings import Settings

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class HistoricalCompetitorImporter:
    """
    Importeur de données historiques depuis CSV.
    
    Supporte les formats AirDNA et Lighthouse (ex-Transparent).
    """
    
    def __init__(self, settings: Optional[Settings] = None):
        """
        Initialise l'importeur.
        
        Args:
            settings: Configuration (si None, charge depuis env)
        """
        self.settings = settings or Settings.from_env()
        self.supabase_client = None
        
        if SUPABASE_AVAILABLE:
            if self.settings.supabase_url and self.settings.supabase_key:
                self.supabase_client = create_client(
                    self.settings.supabase_url,
                    self.settings.supabase_key
                )
                logger.info("Supabase client initialized")
            else:
                logger.warning(
                    "Supabase URL or key not configured. "
                    "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env"
                )
    
    def import_csv(
        self,
        file_path: str,
        source_format: str,
        city: str,
        country: str,
        dry_run: bool = False
    ) -> int:
        """
        Importe un fichier CSV historique.
        
        Args:
            file_path: Chemin vers le fichier CSV
            source_format: Format source ('airdna' ou 'lighthouse')
            city: Nom de la ville
            country: Code pays (ex: 'FR', 'US')
            dry_run: Si True, ne stocke pas les données (test uniquement)
        
        Returns:
            Nombre de records importés
        """
        file_path_obj = Path(file_path)
        
        if not file_path_obj.exists():
            raise FileNotFoundError(f"CSV file not found: {file_path}")
        
        logger.info(
            f"Importing CSV: {file_path} (format: {source_format}, "
            f"city: {city}, country: {country})"
        )
        
        # Parser le CSV selon le format
        if source_format.lower() == 'airdna':
            records = self.parse_airdna_csv(file_path)
        elif source_format.lower() == 'lighthouse':
            records = self.parse_lighthouse_csv(file_path)
        else:
            raise ValueError(
                f"Unknown source format: {source_format}. "
                "Supported: 'airdna', 'lighthouse'"
            )
        
        logger.info(f"Parsed {len(records)} records from CSV")
        
        # Enrichir avec city et country
        for record in records:
            record['city'] = city
            record['country'] = country
        
        # Valider les données
        validated_records = self.validate_historical_data(records)
        logger.info(f"Validated {len(validated_records)} records")
        
        if dry_run:
            logger.info("DRY RUN: Data would be imported but won't be stored")
            return len(validated_records)
        
        # Stocker dans Supabase
        stored_count = asyncio.run(self.store_historical_data(validated_records))
        
        logger.info(f"Successfully imported {stored_count} records")
        return stored_count
    
    def parse_airdna_csv(self, file_path: str) -> List[Dict[str, Any]]:
        """
        Parse un fichier CSV AirDNA.
        
        Format attendu (colonnes typiques AirDNA) :
        - Date, City, Property Type, Bedrooms, Avg Price, Min Price, Max Price,
          Occupancy, RevPAR, ADR, etc.
        
        Args:
            file_path: Chemin vers le CSV
        
        Returns:
            Liste de dicts avec les données normalisées
        """
        records = []
        
        with open(file_path, 'r', encoding='utf-8') as f:
            # Détecter le délimiteur
            sample = f.read(1024)
            f.seek(0)
            delimiter = ',' if ',' in sample else ';'
            
            reader = csv.DictReader(f, delimiter=delimiter)
            
            for row_num, row in enumerate(reader, start=2):  # Start at 2 (header = 1)
                try:
                    # Extraire la date (formats possibles: YYYY-MM-DD, DD/MM/YYYY, etc.)
                    date_str = row.get('Date') or row.get('date') or row.get('DATE')
                    if not date_str:
                        logger.warning(f"Row {row_num}: No date column found")
                        continue
                    
                    data_date = self._parse_date(date_str)
                    if not data_date:
                        logger.warning(f"Row {row_num}: Could not parse date: {date_str}")
                        continue
                    
                    # Extraire le type de propriété
                    property_type = (
                        row.get('Property Type') or
                        row.get('property_type') or
                        row.get('PropertyType') or
                        'unknown'
                    ).lower().strip()
                    
                    # Extraire les chambres
                    bedrooms = self._parse_int(row.get('Bedrooms') or row.get('bedrooms') or row.get('BR'))
                    bathrooms = self._parse_int(row.get('Bathrooms') or row.get('bathrooms') or row.get('BA'))
                    
                    # Extraire les prix
                    avg_price = self._parse_float(
                        row.get('Avg Price') or
                        row.get('Average Price') or
                        row.get('avg_price') or
                        row.get('ADR')  # ADR = Average Daily Rate
                    )
                    
                    min_price = self._parse_float(
                        row.get('Min Price') or
                        row.get('min_price') or
                        row.get('Floor Price')
                    )
                    
                    max_price = self._parse_float(
                        row.get('Max Price') or
                        row.get('max_price') or
                        row.get('Ceiling Price')
                    )
                    
                    # Extraire l'occupation (si disponible)
                    occupancy = self._parse_float(
                        row.get('Occupancy') or
                        row.get('occupancy') or
                        row.get('Occupancy %')
                    )
                    
                    # Extraire la devise (par défaut USD pour AirDNA)
                    currency = (
                        row.get('Currency') or
                        row.get('currency') or
                        'USD'
                    ).upper()
                    
                    # Extraire le quartier (si disponible)
                    neighborhood = (
                        row.get('Neighborhood') or
                        row.get('neighborhood') or
                        row.get('Area')
                    )
                    
                    if not avg_price:
                        logger.warning(f"Row {row_num}: No valid price found, skipping")
                        continue
                    
                    record = {
                        'data_date': data_date.isoformat(),
                        'property_type': property_type,
                        'bedrooms': bedrooms,
                        'bathrooms': bathrooms,
                        'avg_price': avg_price,
                        'min_price': min_price or avg_price,  # Fallback
                        'max_price': max_price or avg_price,  # Fallback
                        'occupancy': occupancy,
                        'currency': currency,
                        'neighborhood': neighborhood if neighborhood else None,
                        'raw_row': row,  # Garder les données brutes
                        'source': 'historical_csv_airdna'
                    }
                    
                    records.append(record)
                    
                except Exception as e:
                    logger.error(f"Error parsing row {row_num}: {e}")
                    continue
        
        return records
    
    def parse_lighthouse_csv(self, file_path: str) -> List[Dict[str, Any]]:
        """
        Parse un fichier CSV Lighthouse (ex-Transparent).
        
        Format attendu (colonnes typiques Lighthouse) :
        - Date, Location, Property Type, Bedrooms, Price, Occupancy, etc.
        
        Args:
            file_path: Chemin vers le CSV
        
        Returns:
            Liste de dicts avec les données normalisées
        """
        records = []
        
        with open(file_path, 'r', encoding='utf-8') as f:
            sample = f.read(1024)
            f.seek(0)
            delimiter = ',' if ',' in sample else ';'
            
            reader = csv.DictReader(f, delimiter=delimiter)
            
            for row_num, row in enumerate(reader, start=2):
                try:
                    # Date
                    date_str = row.get('Date') or row.get('date') or row.get('DATE')
                    if not date_str:
                        logger.warning(f"Row {row_num}: No date column found")
                        continue
                    
                    data_date = self._parse_date(date_str)
                    if not data_date:
                        logger.warning(f"Row {row_num}: Could not parse date: {date_str}")
                        continue
                    
                    # Type de propriété
                    property_type = (
                        row.get('Property Type') or
                        row.get('property_type') or
                        row.get('Type') or
                        'unknown'
                    ).lower().strip()
                    
                    # Chambres
                    bedrooms = self._parse_int(
                        row.get('Bedrooms') or
                        row.get('bedrooms') or
                        row.get('BR') or
                        row.get('Bedroom')
                    )
                    
                    bathrooms = self._parse_int(
                        row.get('Bathrooms') or
                        row.get('bathrooms') or
                        row.get('BA') or
                        row.get('Bathroom')
                    )
                    
                    # Prix (Lighthouse peut avoir un seul champ Price)
                    price = self._parse_float(
                        row.get('Price') or
                        row.get('price') or
                        row.get('ADR') or
                        row.get('Average Price')
                    )
                    
                    # Si pas de price, essayer min/max
                    min_price = self._parse_float(row.get('Min Price') or row.get('min_price'))
                    max_price = self._parse_float(row.get('Max Price') or row.get('max_price'))
                    
                    avg_price = price or ((min_price + max_price) / 2 if min_price and max_price else None)
                    
                    # Occupation
                    occupancy = self._parse_float(
                        row.get('Occupancy') or
                        row.get('occupancy') or
                        row.get('Occupancy %') or
                        row.get('Occ %')
                    )
                    
                    # Devise
                    currency = (
                        row.get('Currency') or
                        row.get('currency') or
                        'USD'
                    ).upper()
                    
                    # Quartier/Location
                    location = (
                        row.get('Location') or
                        row.get('location') or
                        row.get('Neighborhood') or
                        row.get('Area')
                    )
                    
                    if not avg_price:
                        logger.warning(f"Row {row_num}: No valid price found, skipping")
                        continue
                    
                    record = {
                        'data_date': data_date.isoformat(),
                        'property_type': property_type,
                        'bedrooms': bedrooms,
                        'bathrooms': bathrooms,
                        'avg_price': avg_price,
                        'min_price': min_price or avg_price,
                        'max_price': max_price or avg_price,
                        'occupancy': occupancy,
                        'currency': currency,
                        'neighborhood': location if location else None,
                        'raw_row': row,
                        'source': 'historical_csv_lighthouse'
                    }
                    
                    records.append(record)
                    
                except Exception as e:
                    logger.error(f"Error parsing row {row_num}: {e}")
                    continue
        
        return records
    
    def validate_historical_data(self, records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Valide et nettoie les données historiques.
        
        Args:
            records: Liste de records à valider
        
        Returns:
            Liste de records validés
        """
        validated = []
        
        for record in records:
            # Vérifier les champs requis
            if not record.get('data_date'):
                logger.warning("Record missing data_date, skipping")
                continue
            
            if not record.get('avg_price') or record['avg_price'] <= 0:
                logger.warning(f"Invalid avg_price: {record.get('avg_price')}, skipping")
                continue
            
            if not record.get('city') or not record.get('country'):
                logger.warning("Record missing city or country, skipping")
                continue
            
            # Nettoyer les valeurs None pour les champs optionnels
            if not record.get('min_price'):
                record['min_price'] = record['avg_price']
            
            if not record.get('max_price'):
                record['max_price'] = record['avg_price']
            
            # Calculer les percentiles si manquants
            if not record.get('p25_price'):
                record['p25_price'] = record['min_price']
            
            if not record.get('p50_price'):
                record['p50_price'] = record['avg_price']
            
            if not record.get('p75_price'):
                record['p75_price'] = record['max_price']
            
            # Sample size par défaut (inconnu pour données historiques)
            if not record.get('sample_size'):
                record['sample_size'] = None
            
            validated.append(record)
        
        return validated
    
    async def store_historical_data(self, records: List[Dict[str, Any]]) -> int:
        """
        Stocke les données historiques dans Supabase.
        
        Gère les doublons (ne réimporte pas si déjà présent).
        
        Args:
            records: Liste de records à stocker
        
        Returns:
            Nombre de records stockés (après déduplication)
        """
        if not self.supabase_client:
            raise RuntimeError("Supabase client not initialized")
        
        if not records:
            logger.warning("No records to store")
            return 0
        
        # Préparer les records pour Supabase
        records_to_insert = []
        duplicates_count = 0
        
        for record in records:
            # Préparer le record pour la table raw_competitor_data
            supabase_record = {
                'source': record.get('source', 'historical_csv'),
                'country': record['country'],
                'city': record['city'],
                'neighborhood': record.get('neighborhood'),
                'property_type': record.get('property_type'),
                'bedrooms': record.get('bedrooms'),
                'bathrooms': record.get('bathrooms'),
                'data_date': record['data_date'],
                'collected_at': datetime.now().isoformat(),
                
                # Données brutes
                'raw_data': {
                    'imported_from': 'csv',
                    'raw_row': record.get('raw_row', {}),
                    'import_date': datetime.now().isoformat()
                },
                
                # Prix normalisés
                'avg_price': float(record['avg_price']),
                'min_price': float(record['min_price']),
                'max_price': float(record['max_price']),
                'p25_price': float(record.get('p25_price', record['min_price'])),
                'p50_price': float(record.get('p50_price', record['avg_price'])),
                'p75_price': float(record.get('p75_price', record['max_price'])),
                'sample_size': record.get('sample_size'),
                
                # Devise et timezone
                'currency': record.get('currency', 'EUR'),
                'timezone': None,  # À déterminer selon city/country
                
                # Métadonnées
                'metadata': {
                    'import_source': record.get('source'),
                    'occupancy': record.get('occupancy'),
                    'import_date': datetime.now().isoformat()
                }
            }
            
            records_to_insert.append(supabase_record)
        
        # Vérifier les doublons (basé sur la contrainte UNIQUE)
        # On utilise upsert qui gère automatiquement les doublons
        logger.info(f"Storing {len(records_to_insert)} records in Supabase...")
        
        try:
            # Exécuter upsert dans un thread pool (Supabase client est synchrone)
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(
                None,
                lambda: self.supabase_client.table('raw_competitor_data').upsert(
                    records_to_insert
                ).execute()
            )
            
            stored_count = len(response.data) if response.data else len(records_to_insert)
            
            logger.info(
                f"Successfully stored {stored_count} records "
                f"(duplicates handled automatically)"
            )
            
            return stored_count
            
        except Exception as e:
            logger.error(f"Error storing records in Supabase: {e}")
            raise
    
    def _parse_date(self, date_str: str) -> Optional[date]:
        """Parse une date depuis différents formats."""
        if not date_str:
            return None
        
        date_str = str(date_str).strip()
        
        # Formats à essayer
        formats = [
            '%Y-%m-%d',
            '%d/%m/%Y',
            '%m/%d/%Y',
            '%Y/%m/%d',
            '%d-%m-%Y',
            '%m-%d-%Y',
        ]
        
        for fmt in formats:
            try:
                return datetime.strptime(date_str, fmt).date()
            except ValueError:
                continue
        
        logger.warning(f"Could not parse date: {date_str}")
        return None
    
    def _parse_float(self, value: Any) -> Optional[float]:
        """Parse un float, gère les formats avec virgules, espaces, etc."""
        if value is None or value == '':
            return None
        
        try:
            # Enlever les espaces, remplacer virgule par point
            cleaned = str(value).strip().replace(',', '.').replace(' ', '')
            # Enlever les symboles de devise
            cleaned = cleaned.replace('€', '').replace('$', '').replace('£', '').replace('€', '')
            return float(cleaned)
        except (ValueError, AttributeError):
            return None
    
    def _parse_int(self, value: Any) -> Optional[int]:
        """Parse un int."""
        if value is None or value == '':
            return None
        
        try:
            return int(float(str(value).strip()))
        except (ValueError, AttributeError):
            return None


def main():
    """Point d'entrée CLI."""
    parser = argparse.ArgumentParser(
        description='Import historical competitor data from CSV (AirDNA/Lighthouse)'
    )
    
    parser.add_argument(
        '--file',
        required=True,
        help='Path to CSV file'
    )
    
    parser.add_argument(
        '--source',
        required=True,
        choices=['airdna', 'lighthouse'],
        help='Source format: airdna or lighthouse'
    )
    
    parser.add_argument(
        '--city',
        required=True,
        help='City name (e.g., "Paris")'
    )
    
    parser.add_argument(
        '--country',
        required=True,
        help='Country code (e.g., "FR", "US")'
    )
    
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Test import without storing data'
    )
    
    args = parser.parse_args()
    
    # Créer l'importeur
    importer = HistoricalCompetitorImporter()
    
    # Importer
    try:
        count = importer.import_csv(
            file_path=args.file,
            source_format=args.source,
            city=args.city,
            country=args.country,
            dry_run=args.dry_run
        )
        
        print(f"✅ Successfully imported {count} records")
        return 0
        
    except Exception as e:
        logger.error(f"Import failed: {e}", exc_info=True)
        print(f"❌ Import failed: {e}")
        return 1


if __name__ == '__main__':
    exit(main())

