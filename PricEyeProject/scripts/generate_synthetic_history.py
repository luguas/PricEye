"""
Script pour générer un historique synthétique de réservations pour une nouvelle propriété.

Ce script permet de créer des fausses réservations basées sur le taux d'occupation
du marché, permettant ainsi d'entraîner le modèle IA standard immédiatement
pour une nouvelle propriété (Cold Start).

Usage:
    python scripts/generate_synthetic_history.py --property_id <uuid> --city "Paris"
"""

import argparse
import random
import sys
from datetime import datetime, timedelta, date
from pathlib import Path
from typing import Dict, List, Optional

# Ajouter le répertoire parent au path pour les imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from pricing_engine.interfaces.data_access import (
    get_supabase_client,
    get_property_capacity,
    get_property_location,
)
from market_data_pipeline.config.settings import Settings


def get_market_features_for_city(
    city: str,
    country: Optional[str] = None,
    start_date: str = None,
    end_date: str = None,
) -> List[Dict]:
    """
    Récupère les market_features pour une ville sur une plage de dates.
    
    Paramètres :
    - city: Ville
    - country: Pays (optionnel, si None, récupère tous les pays)
    - start_date: Date de début (format YYYY-MM-DD)
    - end_date: Date de fin (format YYYY-MM-DD)
    
    Retourne une liste de dictionnaires avec les market_features.
    """
    client = get_supabase_client()
    
    query = (
        client.table("market_features")
        .select("*")
        .eq("city", city)
        .gte("date", start_date)
        .lte("date", end_date)
        .order("date", desc=False)
    )
    
    if country:
        query = query.eq("country", country)
    
    response = query.execute()
    
    if not hasattr(response, 'data'):
        raise RuntimeError("Réponse Supabase invalide: pas d'attribut 'data'")
    
    return response.data or []


def generate_synthetic_bookings(
    property_id: str,
    city: str,
    country: Optional[str] = None,
    months_back: int = 12,
    min_occupancy_threshold: float = 0.3,  # Seuil minimum pour créer une réservation
) -> Dict[str, any]:
    """
    Génère un historique synthétique de réservations pour une propriété.
    
    Paramètres :
    - property_id: ID de la propriété
    - city: Ville de la propriété
    - country: Pays de la propriété (optionnel)
    - months_back: Nombre de mois en arrière pour générer l'historique (défaut: 12)
    - min_occupancy_threshold: Taux d'occupation minimum pour créer une réservation (défaut: 0.3)
    
    Retourne un dictionnaire avec les statistiques de génération.
    """
    client = get_supabase_client()
    
    # 1. Vérifier que la propriété existe et récupérer sa capacité
    try:
        capacity = get_property_capacity(property_id)
        if capacity is None:
            # Si pas de capacité définie, utiliser une valeur par défaut
            capacity = 1
            print(f"Warning: Capacité non définie pour la propriété {property_id}, utilisation de 1 par défaut")
    except Exception as e:
        print(f"Erreur lors de la récupération de la capacité: {e}")
        capacity = 1
    
    # 2. Récupérer la localisation de la propriété si country n'est pas fourni
    if country is None:
        try:
            location = get_property_location(property_id)
            country = location.get("country")
            if not country:
                raise ValueError(f"Pays non trouvé pour la propriété {property_id}")
        except Exception as e:
            raise ValueError(f"Impossible de récupérer le pays de la propriété: {e}")
    
    # 3. Calculer les dates (12 derniers mois)
    end_date = date.today()
    start_date = end_date - timedelta(days=months_back * 30)  # Approximation
    
    start_date_str = start_date.isoformat()
    end_date_str = end_date.isoformat()
    
    print(f"Récupération des market_features pour {city}, {country} du {start_date_str} au {end_date_str}...")
    
    # 4. Récupérer les market_features
    market_features = get_market_features_for_city(
        city=city,
        country=country,
        start_date=start_date_str,
        end_date=end_date_str,
    )
    
    if not market_features:
        raise ValueError(
            f"Aucune donnée market_features trouvée pour {city}, {country} "
            f"dans la plage {start_date_str} → {end_date_str}"
        )
    
    print(f"✓ {len(market_features)} jours de données marché récupérés")
    
    # 5. Générer les réservations synthétiques
    bookings_to_insert: List[Dict] = []
    total_days = 0
    days_with_bookings = 0
    
    for mf in market_features:
        date_str = mf.get("date")
        if not date_str:
            continue
        
        # Normaliser la date (enlever l'heure si présente)
        if isinstance(date_str, str):
            date_str = date_str.split("T")[0]
        
        total_days += 1
        
        # Récupérer le taux d'occupation marché
        market_occupancy = mf.get("market_occupancy_estimate")
        if market_occupancy is None:
            # Si pas de taux d'occupation, utiliser une valeur par défaut (50%)
            market_occupancy = 50.0
        else:
            market_occupancy = float(market_occupancy)
        
        # Convertir le taux d'occupation (0-100) en probabilité (0-1)
        occupancy_probability = market_occupancy / 100.0
        
        # Si le taux d'occupation est supérieur au seuil, créer une réservation
        if occupancy_probability >= min_occupancy_threshold:
            # Nombre de réservations à créer pour ce jour
            # On utilise une distribution basée sur le taux d'occupation
            # Plus le taux est élevé, plus on crée de réservations
            expected_bookings = max(1, int(capacity * occupancy_probability * random.uniform(0.7, 1.0)))
            expected_bookings = min(expected_bookings, capacity)  # Ne pas dépasser la capacité
            
            # Créer les réservations pour ce jour
            for i in range(expected_bookings):
                # Générer une durée de séjour aléatoire (1-7 nuits)
                nights = random.randint(1, min(7, 14))  # Max 7 nuits, mais peut être ajusté
                start_date_obj = datetime.strptime(date_str, "%Y-%m-%d").date()
                end_date_obj = start_date_obj + timedelta(days=nights)
                
                # Générer un prix aléatoire basé sur le prix moyen du marché si disponible
                market_price = mf.get("competitor_avg_price")
                if market_price:
                    # Prix avec une variation de ±20% autour du prix marché
                    base_price = float(market_price)
                    price = round(base_price * random.uniform(0.8, 1.2), 2)
                else:
                    # Prix par défaut si pas de prix marché
                    price = round(random.uniform(50, 200), 2)
                
                booking = {
                    "property_id": property_id,
                    "start_date": start_date_obj.isoformat(),
                    "end_date": end_date_obj.isoformat(),
                    "status": "confirmed",  # Statut par défaut
                    "source": "synthetic",  # Marquer comme synthétique
                    "guests": random.randint(1, min(4, capacity)),  # Nombre de guests aléatoire
                    "total_price": price * nights,  # Prix total pour le séjour
                    "price_per_night": price,
                    "created_at": datetime.utcnow().isoformat(),
                    "updated_at": datetime.utcnow().isoformat(),
                }
                
                bookings_to_insert.append(booking)
            
            days_with_bookings += 1
    
    if not bookings_to_insert:
        print("Aucune réservation à créer (taux d'occupation marché trop faible)")
        return {
            "property_id": property_id,
            "city": city,
            "country": country,
            "total_days": total_days,
            "days_with_bookings": 0,
            "bookings_created": 0,
        }
    
    print(f"✓ {len(bookings_to_insert)} réservations synthétiques générées pour {days_with_bookings} jours")
    
    # 6. Vérifier et supprimer les réservations synthétiques existantes (optionnel)
    print("Vérification des réservations synthétiques existantes...")
    try:
        existing_synthetic = (
            client.table("bookings")
            .select("id")
            .eq("property_id", property_id)
            .eq("source", "synthetic")
            .execute()
        )
        
        if hasattr(existing_synthetic, 'data') and existing_synthetic.data:
            print(f"  → {len(existing_synthetic.data)} réservations synthétiques existantes trouvées")
            delete_response = (
                client.table("bookings")
                .delete()
                .eq("property_id", property_id)
                .eq("source", "synthetic")
                .execute()
            )
            print(f"  → Réservations synthétiques existantes supprimées")
    except Exception as e:
        print(f"  → Warning: Impossible de vérifier/supprimer les réservations existantes: {e}")
        # Continuer quand même
    
    # 7. Insérer les réservations dans la base de données
    print("Insertion des réservations dans la base de données...")
    
    # Insérer par batch pour éviter les timeouts
    batch_size = 100
    inserted_count = 0
    
    for i in range(0, len(bookings_to_insert), batch_size):
        batch = bookings_to_insert[i:i + batch_size]
        
        try:
            response = client.table("bookings").insert(batch).execute()
            
            if hasattr(response, 'data') and response.data:
                inserted_count += len(response.data)
            else:
                # Si pas de data retourné, on suppose que l'insertion a réussi
                inserted_count += len(batch)
        
        except Exception as e:
            print(f"Erreur lors de l'insertion du batch {i//batch_size + 1}: {e}")
            # Continuer avec les autres batches
            continue
    
    print(f"✓ {inserted_count} réservations insérées avec succès")
    
    return {
        "property_id": property_id,
        "city": city,
        "country": country,
        "total_days": total_days,
        "days_with_bookings": days_with_bookings,
        "bookings_created": inserted_count,
        "date_range": {
            "start": start_date_str,
            "end": end_date_str,
        },
    }


def main():
    """Point d'entrée principal du script."""
    parser = argparse.ArgumentParser(
        description="Génère un historique synthétique de réservations pour une nouvelle propriété"
    )
    parser.add_argument(
        "--property_id",
        type=str,
        required=True,
        help="ID de la propriété (UUID)",
    )
    parser.add_argument(
        "--city",
        type=str,
        required=True,
        help="Ville de la propriété",
    )
    parser.add_argument(
        "--country",
        type=str,
        required=False,
        help="Pays de la propriété (optionnel, sera récupéré depuis la propriété si non fourni)",
    )
    parser.add_argument(
        "--months_back",
        type=int,
        default=12,
        help="Nombre de mois en arrière pour générer l'historique (défaut: 12)",
    )
    parser.add_argument(
        "--min_occupancy_threshold",
        type=float,
        default=0.3,
        help="Taux d'occupation minimum pour créer une réservation (0-1, défaut: 0.3)",
    )
    
    args = parser.parse_args()
    
    try:
        print(f"Génération de l'historique synthétique pour la propriété {args.property_id}")
        print(f"Ville: {args.city}")
        if args.country:
            print(f"Pays: {args.country}")
        print(f"Mois en arrière: {args.months_back}")
        print(f"Seuil d'occupation minimum: {args.min_occupancy_threshold}")
        print("-" * 60)
        
        result = generate_synthetic_bookings(
            property_id=args.property_id,
            city=args.city,
            country=args.country,
            months_back=args.months_back,
            min_occupancy_threshold=args.min_occupancy_threshold,
        )
        
        print("-" * 60)
        print("✓ Génération terminée avec succès!")
        print(f"  - Jours analysés: {result['total_days']}")
        print(f"  - Jours avec réservations: {result['days_with_bookings']}")
        print(f"  - Réservations créées: {result['bookings_created']}")
        
        return 0
    
    except Exception as e:
        print(f"✗ Erreur: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
