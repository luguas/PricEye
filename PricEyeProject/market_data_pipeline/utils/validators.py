"""
Validateurs de données.
"""

import logging
from typing import Dict, Any, Optional, List
from datetime import date

logger = logging.getLogger(__name__)


def validate_data(data: Dict[str, Any], schema: Dict[str, type]) -> bool:
    """
    Valide des données selon un schéma.
    
    Args:
        data: Données à valider
        schema: Schéma avec {field: type}
        
    Returns:
        True si valides
    """
    for field, expected_type in schema.items():
        if field not in data:
            logger.warning(f"Missing field: {field}")
            return False
        
        if data[field] is not None and not isinstance(data[field], expected_type):
            logger.warning(
                f"Invalid type for {field}: expected {expected_type}, "
                f"got {type(data[field])}"
            )
            return False
    
    return True


def validate_schema(table_name: str, data: Dict[str, Any]) -> bool:
    """
    Valide des données selon le schéma d'une table.
    
    Args:
        table_name: Nom de la table ('raw_competitor_data', etc.)
        data: Données à valider
        
    Returns:
        True si valides
    """
    # TODO: Implémenter validation selon schéma de table
    # Utiliser les schémas SQL comme référence
    
    schemas = {
        "raw_competitor_data": {
            "source": str,
            "country": str,
            "city": str,
            "data_date": date,
            "raw_data": dict,
        },
        # Ajouter autres schémas
    }
    
    if table_name not in schemas:
        logger.warning(f"Unknown schema: {table_name}")
        return True  # Pas de validation si schéma inconnu
    
    return validate_data(data, schemas[table_name])

