"""
Logique d’optimisation de prix pour le moteur de pricing PricEye.

Ce module est responsable de :
- simuler le revenu attendu pour une grille de prix,
- appliquer les contraintes business (bornes, volatilité, capacité restante),
- choisir le prix optimal à proposer.

Il s’appuie sur le modèle de demande défini dans `models.demand_model`.
"""

from typing import List, Dict, Any, Optional

from .config import get_pricing_config_for_property, PricingConfig
from .interfaces.data_access import get_internal_pricing_data, get_property_pricing_constraints
from .models.demand_model import predict_demand


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
        return {
            "price": config.fallback_price,
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
    price_grid = _build_price_grid(
        min_price=effective_min_price,
        max_price=effective_max_price,
        base_price=effective_base_price,
        step=config.price_step,
    )

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
        return {
            "price": config.fallback_price,
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

    return {
        "price": best["price"],
        "expected_revenue": best["expected_revenue"],
        "predicted_demand": best["predicted_demand"],
        "strategy": "demand_simulation_grid_search",
        "details": {
            "date": date,
            "capacity_remaining": capacity_remaining,
            "alternatives": alternatives,
        },
    }


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
    """
    if context_features is None:
        context_features = {}

    # Récupérer les contraintes de prix de la propriété
    constraints = get_property_pricing_constraints(property_id)
    floor_price = constraints.get("floor_price")
    ceiling_price = constraints.get("ceiling_price")
    base_price = constraints.get("base_price")

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

    return choose_optimal_price(
        property_id=property_id,
        room_type=room_type,
        date=date,
        capacity_remaining=capacity_remaining,
        context_features=context_features,
        min_price=floor_price,
        max_price=ceiling_price,
        base_price=base_price,
    )


