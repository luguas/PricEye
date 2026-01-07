"""
Script pour simuler la demande et le revenu pour une grille de prix.

Usage:
    python -m scripts.simulate_price_grid --property-id PROPERTY_ID --date YYYY-MM-DD --room-type ROOM_TYPE --price-grid 100,150,200,250

Ce script est appelé depuis le bridge Node.js pour éviter les problèmes de compatibilité
avec les heredocs Python sur Windows.
"""

import argparse
import json
import sys

from pricing_engine.optimizer import simulate_revenue_for_price_grid
from pricing_engine.interfaces.data_access import get_internal_pricing_data


def main() -> None:
    parser = argparse.ArgumentParser(description="Simule la demande pour une grille de prix.")
    parser.add_argument("--property-id", required=True, help="ID de la propriété (UUID Supabase).")
    parser.add_argument("--room-type", default="default", help="Type de chambre (facultatif).")
    parser.add_argument("--date", required=True, help="Date de séjour (YYYY-MM-DD).")
    parser.add_argument("--price-grid", required=True, help="Grille de prix séparée par des virgules (ex: 100,150,200).")

    args = parser.parse_args()

    # Parser la grille de prix
    try:
        price_grid = [float(p.strip()) for p in args.price_grid.split(',')]
    except ValueError as e:
        print(f"❌ Erreur: Format de grille de prix invalide: {args.price_grid}", file=sys.stderr)
        sys.exit(1)

    if not price_grid:
        print("❌ Erreur: Grille de prix vide", file=sys.stderr)
        sys.exit(1)

    # Récupérer la capacité restante
    try:
        records = get_internal_pricing_data(args.property_id, args.date, args.date)
        if records and records[0].capacity is not None:
            capacity_remaining = max(records[0].capacity - records[0].bookings, 0)
        else:
            capacity_remaining = 10  # Fallback
    except Exception as e:
        print(f"⚠️  Avertissement: Impossible de récupérer la capacité, utilisation du fallback: {e}", file=sys.stderr)
        capacity_remaining = 10

    context_features = {}

    # Simuler
    try:
        simulations = simulate_revenue_for_price_grid(
            property_id=args.property_id,
            room_type=args.room_type,
            date=args.date,
            price_grid=price_grid,
            capacity_remaining=capacity_remaining,
            context_features=context_features,
        )

        # Afficher le résultat en JSON
        print(json.dumps(simulations, indent=2, ensure_ascii=False))
    except Exception as e:
        print(f"❌ Erreur lors de la simulation: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

