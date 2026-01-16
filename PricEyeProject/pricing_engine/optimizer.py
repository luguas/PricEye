"""
Logique d’optimisation de prix pour le moteur de pricing PricEye.

Ce module est responsable de :
- simuler le revenu attendu pour une grille de prix,
- appliquer les contraintes business (bornes, volatilité, capacité restante),
- choisir le prix optimal à proposer.

Il s’appuie sur le modèle de demande défini dans `models.demand_model`.
"""

from typing import List, Dict, Any, Optional
from datetime import datetime, timedelta, date

from .config import get_pricing_config_for_property, PricingConfig
from .interfaces.data_access import (
    get_internal_pricing_data, 
    get_property_pricing_constraints,
    get_property_location,
)
from .models.demand_model import predict_demand
from .models.market_model import (
    predict_market_demand_score,
    MarketDemandPredictor,
)


def simulate_revenue_for_price_grid(
    property_id: str,
    room_type: str,
    date: str,
    price_grid: List[float],
    capacity_remaining: int,
    context_features: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """
    Simule le revenu attendu pour chaque prix d’une grille.

    Pour chaque prix :
    - on prédit la demande via le modèle de demande,
    - on calcule le revenu attendu = price * min(demande_prévue, capacité_restante).
    """
    results: List[Dict[str, Any]] = []
    for price in price_grid:
        predicted_demand = predict_demand(
            property_id=property_id,
            room_type=room_type,
            date=date,
            price=price,
            context_features=context_features,
        )
        effective_demand = min(predicted_demand, capacity_remaining)
        expected_revenue = price * max(effective_demand, 0)

        results.append(
            {
                "price": price,
                "predicted_demand": float(predicted_demand),
                "expected_revenue": float(expected_revenue),
            }
        )
    return results


def _build_price_grid(
    min_price: float,
    max_price: float,
    base_price: Optional[float] = None,
    step: float = 5.0,
) -> List[float]:
    """
    Construit une grille de prix entre min_price et max_price.

    Si base_price est fourni, la grille est plus dense autour de base_price (±20%).
    Sinon, la grille est uniforme avec le pas défini.
    """
    if base_price is not None and min_price <= base_price <= max_price:
        # Grille plus dense autour de base_price (±20%)
        price_grid: List[float] = []
        
        # Zone dense autour de base_price (±20%)
        dense_min = max(min_price, base_price * 0.8)
        dense_max = min(max_price, base_price * 1.2)
        dense_step = step * 0.5  # Pas plus fin dans la zone dense
        
        # Zone avant base_price (moins dense)
        if dense_min > min_price:
            current = min_price
            while current < dense_min:
                price_grid.append(round(current, 2))
                current += step
        
        # Zone dense autour de base_price
        current = dense_min
        while current <= dense_max + 1e-6:
            price_grid.append(round(current, 2))
            current += dense_step
        
        # Zone après base_price (moins dense)
        if dense_max < max_price:
            current = dense_max + step
            while current <= max_price + 1e-6:
                price_grid.append(round(current, 2))
                current += step
        
        # Dédupliquer et trier
        price_grid = sorted(list(set(price_grid)))
    else:
        # Grille uniforme simple
        price_grid = []
        current = min_price
        while current <= max_price + 1e-6:
            price_grid.append(round(current, 2))
            current += step
    
    return price_grid


def _calculate_heuristic_confidence(target_date_str, history_days=None):
    """
    Calcule un score de confiance (0.0 à 1.0) basé sur des heuristiques simples.
    Plus on s'éloigne dans le temps ou moins on a de données, moins on est confiant.
    """
    confidence = 0.80  # Score de base (modèle supposé décent)

    try:
        # 1. Pénalité de distance temporelle (Horizon de prédiction)
        # L'IA est moins précise au-delà de 3 mois
        target_date = datetime.strptime(target_date_str, "%Y-%m-%d").date()
        today = date.today()
        days_ahead = (target_date - today).days

        if days_ahead < 0:
            return 0.0 # Date passée
        
        if days_ahead > 180:
            confidence -= 0.30 # Très loin -> grosse pénalité
        elif days_ahead > 90:
            confidence -= 0.15 # Loin -> petite pénalité
        elif days_ahead < 7:
            confidence += 0.05 # Très proche -> bonus de confiance (données marché fraîches)

        # 2. Pénalité d'historique (Cold Start)
        # Si history_days est fourni, on l'utilise. Sinon on reste neutre.
        if history_days is not None:
            if history_days < 30:
                confidence -= 0.30 # Cold start critique (moins d'un mois)
            elif history_days < 90:
                confidence -= 0.10 # Historique faible (moins d'une saison)
            elif history_days > 365:
                confidence += 0.05 # Bonus historique solide (> 1 an)

    except Exception as e:
        # En cas d'erreur de calcul (ex: format date), on retourne une confiance neutre basse
        print(f"Warning: Confidence calculation error: {e}")
        return 0.5

    # Clamp entre 0.0 et 1.0 et arrondi
    return max(0.0, min(1.0, round(confidence, 2)))


def calculate_confidence_score(
    property_id: str,
    date: str,
) -> float:
    """
    Calcule un score de confiance (0.0 à 1.0) pour la prédiction de prix.
    
    Heuristique simple pour le MVP :
    - Score de base : 0.8
    - Pénalité si la date est très éloignée (> 90 jours) : l'IA prédit mal le long terme
    - Pénalité si l'historique de la propriété est faible (Cold Start) : peu de données
    
    Retourne un float entre 0.0 et 1.0.
    """
    base_confidence = 0.8
    
    try:
        # Calculer la distance en jours depuis aujourd'hui
        today = datetime.now().date()
        target_date = datetime.strptime(date, "%Y-%m-%d").date()
        days_away = (target_date - today).days
        
        # Pénalité pour les dates éloignées (> 90 jours)
        date_penalty = 0.0
        if days_away > 90:
            # Pénalité progressive : -0.1 par tranche de 30 jours au-delà de 90
            extra_days = days_away - 90
            date_penalty = min(0.3, (extra_days / 30) * 0.1)  # Max -0.3
        
        # Vérifier l'historique de la propriété (Cold Start)
        # On regarde les 90 derniers jours pour voir s'il y a des données
        history_start_date = (today - timedelta(days=90)).isoformat()
        history_end_date = today.isoformat()
        
        try:
            historical_records = get_internal_pricing_data(
                property_id=property_id,
                start_date=history_start_date,
                end_date=history_end_date,
            )
            
            # Compter les jours avec des bookings (données significatives)
            days_with_data = sum(1 for record in historical_records if record.bookings > 0)
            
            # Pénalité si moins de 7 jours avec des données (Cold Start)
            cold_start_penalty = 0.0
            if days_with_data < 7:
                # Pénalité progressive : -0.2 si 0 jours, -0.1 si < 7 jours
                if days_with_data == 0:
                    cold_start_penalty = 0.2
                else:
                    cold_start_penalty = 0.1
        except Exception:
            # En cas d'erreur, on considère qu'il n'y a pas d'historique (Cold Start)
            cold_start_penalty = 0.2
        
        # Calculer le score final
        confidence = base_confidence - date_penalty - cold_start_penalty
        
        # S'assurer que le score reste entre 0.0 et 1.0
        confidence = max(0.0, min(1.0, confidence))
        
        return round(confidence, 2)
        
    except Exception:
        # En cas d'erreur, retourner un score de confiance minimal
        return 0.5


def choose_optimal_price(
    property_id: str,
    room_type: str,
    date: str,
    capacity_remaining: int,
    context_features: Dict[str, Any],
    min_price: Optional[float] = None,
    max_price: Optional[float] = None,
    base_price: Optional[float] = None,
) -> Dict[str, Any]:
    """
    Choisit un prix optimal pour une propriété / type de chambre / date donnés.

    Paramètres optionnels :
    - min_price: prix minimum (utilise config si None)
    - max_price: prix maximum (utilise config si None)
    - base_price: prix de base pour une grille plus dense autour (optionnel)

    Étapes :
    1. Récupérer la configuration de pricing pour la propriété.
    2. Construire une grille de prix (plus dense autour de base_price si fourni).
    3. Appeler `simulate_revenue_for_price_grid`.
    4. Appliquer les contraintes business et choisir le meilleur prix.
    """
    config = get_pricing_config_for_property(property_id)

    # Utiliser les paramètres fournis ou les valeurs de config
    effective_min_price = min_price if min_price is not None else config.default_min_price
    effective_max_price = max_price if max_price is not None else config.default_max_price
    effective_base_price = base_price

    # Gérer les cas limites
    if effective_min_price <= 0 or effective_max_price <= 0 or effective_max_price <= effective_min_price:
        # Fallback si la config est incohérente
        confidence_score = calculate_confidence_score(property_id, date)
        return {
            "price": config.fallback_price,
            "confidence_score": confidence_score,
            "strategy": "fallback_invalid_config",
            "details": {
                "reason": "Configuration de prix invalide, utilisation du fallback.",
            },
        }

    # Ajuster base_price s'il est en dehors de [min_price, max_price]
    if effective_base_price is not None:
        if effective_base_price < effective_min_price:
            effective_base_price = effective_min_price
        elif effective_base_price > effective_max_price:
            effective_base_price = effective_max_price

    # Construire la grille de prix
    # Limiter la taille de la grille pour éviter les timeouts (max 50 prix)
    price_grid = _build_price_grid(
        min_price=effective_min_price,
        max_price=effective_max_price,
        base_price=effective_base_price,
        step=config.price_step,
    )
    
    # Limiter la taille de la grille si elle est trop grande
    if len(price_grid) > 50:
        # Prendre un échantillon représentatif : début, milieu (autour de base_price), fin
        if effective_base_price is not None:
            # Prioriser les prix autour de base_price
            base_idx = min(range(len(price_grid)), key=lambda i: abs(price_grid[i] - effective_base_price))
            start_idx = max(0, base_idx - 10)
            end_idx = min(len(price_grid), base_idx + 10)
            price_grid = price_grid[:5] + price_grid[start_idx:end_idx] + price_grid[-5:]
            price_grid = sorted(list(set(price_grid)))[:50]
        else:
            # Échantillonnage uniforme
            step = max(1, len(price_grid) // 50)
            price_grid = price_grid[::step][:50]

    # Simuler le revenu pour chaque prix
    simulations = simulate_revenue_for_price_grid(
        property_id=property_id,
        room_type=room_type,
        date=date,
        price_grid=price_grid,
        capacity_remaining=capacity_remaining,
        context_features=context_features,
    )

    # Filtrer les prix avec un revenu défini
    valid_simulations = [s for s in simulations if s["expected_revenue"] is not None]
    if not valid_simulations:
        confidence_score = calculate_confidence_score(property_id, date)
        return {
            "price": config.fallback_price,
            "confidence_score": confidence_score,
            "strategy": "fallback_no_valid_simulation",
            "details": {
                "reason": "Aucune simulation valide, utilisation du fallback.",
                "simulations": simulations,
            },
        }

    # Choisir le prix qui maximise le revenu
    best = max(valid_simulations, key=lambda s: s["expected_revenue"])

    # Proposer également quelques alternatives proches (top 3)
    sorted_sims = sorted(valid_simulations, key=lambda s: s["expected_revenue"], reverse=True)
    alternatives = sorted_sims[1:4]

    # Calculer le score de confiance
    confidence_score = calculate_confidence_score(property_id, date)

    return {
        "price": best["price"],
        "expected_revenue": best["expected_revenue"],
        "predicted_demand": best["predicted_demand"],
        "confidence_score": confidence_score,
        "strategy": "demand_simulation_grid_search",
        "details": {
            "date": date,
            "capacity_remaining": capacity_remaining,
            "alternatives": alternatives,
        },
    }


def _is_cold_start_property(property_id: str, min_history_days: int = 30) -> bool:
    """
    Détermine si une propriété est en Cold Start (pas d'historique suffisant).
    
    Paramètres :
    - property_id: ID de la propriété
    - min_history_days: Nombre minimum de jours d'historique requis (défaut: 30)
    
    Retourne True si la propriété est en Cold Start, False sinon.
    """
    try:
        today = date.today()
        history_start_date = (today - timedelta(days=365)).isoformat()
        history_end_date = today.isoformat()
        historical_records = get_internal_pricing_data(
            property_id=property_id,
            start_date=history_start_date,
            end_date=history_end_date,
        )
        
        if not historical_records:
            return True
        
        # Compter les jours avec des bookings significatifs (> 0)
        days_with_bookings = sum(1 for record in historical_records if record.bookings > 0)
        
        # Si moins de min_history_days avec des bookings, c'est un Cold Start
        return days_with_bookings < min_history_days
    except Exception:
        # En cas d'erreur, considérer comme Cold Start par sécurité
        return True


def _adjust_base_price_for_market_demand(
    base_price: float,
    market_demand_score: float,
) -> float:
    """
    Ajuste le prix de base selon le score de demande marché.
    
    Paramètres :
    - base_price: Prix de base de la propriété
    - market_demand_score: Score de demande marché (0-100, market_occupancy_estimate)
    
    Logique :
    - Score > 70 (Demande Haute) : +20% (base_price * 1.2)
    - Score > 50 (Demande Moyenne-Haute) : +10% (base_price * 1.1)
    - Score < 30 (Demande Faible) : -10% (base_price * 0.9)
    - Sinon : Prix de base inchangé
    
    Retourne le prix ajusté.
    """
    if market_demand_score > 70:
        # Demande très haute
        return base_price * 1.2
    elif market_demand_score > 50:
        # Demande moyenne-haute
        return base_price * 1.1
    elif market_demand_score < 30:
        # Demande faible
        return base_price * 0.9
    else:
        # Demande moyenne, pas d'ajustement
        return base_price


def get_recommended_price(
    property_id: str,
    room_type: str,
    date: str,
    capacity_remaining: Optional[int] = None,
    context_features: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Point d'entrée de haut niveau pour obtenir un prix recommandé.

    Cette fonction est celle appelée par l'API (backend) pour récupérer
    une recommandation de prix.

    Elle récupère automatiquement les contraintes de prix de la propriété
    (floor_price, ceiling_price, base_price) depuis Supabase.
    
    Si la propriété est en Cold Start, utilise le MarketDemandModel pour
    ajuster le prix de base selon la demande marché.
    """
    if context_features is None:
        context_features = {}

    # Récupérer les contraintes de prix de la propriété
    constraints = get_property_pricing_constraints(property_id)
    floor_price = constraints.get("floor_price")
    ceiling_price = constraints.get("ceiling_price")
    base_price = constraints.get("base_price")
    
    # Vérifier si la propriété est en Cold Start
    is_cold_start = _is_cold_start_property(property_id)
    
    # Si Cold Start, utiliser le MarketDemandModel pour ajuster le prix de base
    market_demand_adjustment = None
    if is_cold_start and base_price is not None:
        try:
            # Récupérer la localisation de la propriété
            location = get_property_location(property_id)
            city = location.get("city")
            country = location.get("country")
            
            if city and country:
                # Prédire le score de demande marché pour cette date
                market_demand_score = predict_market_demand_score(
                    city=city,
                    country=country,
                    date=date,
                    market_features=context_features.get("market_features"),
                )
                
                # Ajuster le prix de base selon le score
                adjusted_base_price = _adjust_base_price_for_market_demand(
                    base_price=base_price,
                    market_demand_score=market_demand_score,
                )
                
                # Mettre à jour base_price avec le prix ajusté
                base_price = adjusted_base_price
                market_demand_adjustment = {
                    "score": market_demand_score,
                    "original_base_price": constraints.get("base_price"),
                    "adjusted_base_price": adjusted_base_price,
                    "adjustment_factor": adjusted_base_price / constraints.get("base_price") if constraints.get("base_price") else 1.0,
                }
        except Exception as e:
            # En cas d'erreur avec le MarketDemandModel, continuer avec le prix de base original
            # (ne pas faire échouer la recommandation)
            print(f"Warning: Erreur lors de l'utilisation du MarketDemandModel pour {property_id}: {e}")
            pass

    # Si la capacité restante n'est pas fournie, on essaie de l'estimer
    # de manière simple à partir des données internes.
    if capacity_remaining is None:
        try:
            records = get_internal_pricing_data(
                property_id=property_id,
                start_date=date,
                end_date=date,
            )
            if records:
                record = records[0]
                # Capacité restante approximée = capacité totale - bookings du jour
                if record.capacity is not None:
                    capacity_remaining = max(record.capacity - record.bookings, 0)
        except Exception:
            # On laisse capacity_remaining à None si erreur ; ce sera géré plus bas
            capacity_remaining = None

    if capacity_remaining is None:
        # Fallback : considérer une capacité de 1 pour éviter les incohérences
        capacity_remaining = 1

    # Obtenir la recommandation de prix via choose_optimal_price
    optimal_result = choose_optimal_price(
        property_id=property_id,
        room_type=room_type,
        date=date,
        capacity_remaining=capacity_remaining,
        context_features=context_features,
        min_price=floor_price,
        max_price=ceiling_price,
        base_price=base_price,
    )
    
    # Calculer history_days (nombre de jours d'historique disponible)
    history_days = None
    try:
        today = datetime.now().date()
        history_start_date = (today - timedelta(days=365)).isoformat()
        history_end_date = today.isoformat()
        historical_records = get_internal_pricing_data(
            property_id=property_id,
            start_date=history_start_date,
            end_date=history_end_date,
        )
        if historical_records:
            # Compter les jours uniques avec des données
            unique_dates = set()
            for record in historical_records:
                if hasattr(record, 'date'):
                    unique_dates.add(record.date)
            history_days = len(unique_dates)
    except Exception:
        # En cas d'erreur, on laisse history_days à None
        history_days = None

    # Calculer le score de confiance avec la nouvelle fonction heuristique
    confidence_score = _calculate_heuristic_confidence(date, history_days)

    # Construire la réponse enrichie avec le format JSON demandé
    result = {
        "property_id": property_id,
        "date": date,
        "recommended_price": float(optimal_result.get("price", 0.0)),
        "currency": "EUR",
        
        # Le champ critique pour l'hybridation
        "confidence": confidence_score,
        
        "meta": {
            "strategy": optimal_result.get("strategy", "unknown"),
            "horizon_days": (datetime.strptime(date, "%Y-%m-%d").date() - datetime.now().date()).days,
            "data_quality": "high" if confidence_score > 0.7 else "low",
            "expected_revenue": optimal_result.get("expected_revenue"),
            "predicted_demand": optimal_result.get("predicted_demand"),
            "details": optimal_result.get("details", {}),
            "is_cold_start": is_cold_start,
            "market_demand_adjustment": market_demand_adjustment,
        }
    }

    return result


