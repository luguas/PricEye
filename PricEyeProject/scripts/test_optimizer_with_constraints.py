"""
Script de test pour vérifier que l'optimiseur utilise correctement les contraintes de prix.

Usage (depuis `PricEyeProject/`) :

    python -m scripts.test_optimizer_with_constraints --property-id YOUR_PROPERTY_ID --date 2024-01-15
"""

import argparse
import json

from pricing_engine.interfaces.data_access import get_property_pricing_constraints
from pricing_engine.optimizer import get_recommended_price


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Tester l'optimiseur avec les contraintes de prix d'une propriété."
    )
    parser.add_argument(
        "--property-id",
        type=str,
        required=True,
        help="ID de la propriété à tester (UUID Supabase).",
    )
    parser.add_argument(
        "--date",
        type=str,
        required=True,
        help="Date de séjour (YYYY-MM-DD).",
    )
    parser.add_argument(
        "--room-type",
        type=str,
        default="default",
        help="Type de chambre (défaut: default).",
    )

    args = parser.parse_args()

    print("=" * 80)
    print("🧪 TEST DE L'OPTIMISEUR AVEC CONTRAINTES DE PRIX")
    print("=" * 80)
    print(f"🏠 Property ID: {args.property_id}")
    print(f"📅 Date: {args.date}")
    print(f"🛏️  Room Type: {args.room_type}")
    print()

    # 1. Vérifier les contraintes de la propriété
    print("1️⃣  Vérification des contraintes de prix de la propriété...")
    constraints = get_property_pricing_constraints(args.property_id)

    print(f"   💰 floor_price: {constraints.get('floor_price')}")
    print(f"   💰 ceiling_price: {constraints.get('ceiling_price')}")
    print(f"   💰 base_price: {constraints.get('base_price')}")
    print()

    # Vérifier si les contraintes sont définies
    has_constraints = (
        constraints.get("floor_price") is not None
        or constraints.get("ceiling_price") is not None
        or constraints.get("base_price") is not None
    )

    if not has_constraints:
        print("   ⚠️  Aucune contrainte de prix définie pour cette propriété")
        print("   💡 L'optimiseur utilisera les valeurs par défaut de la config")
    else:
        print("   ✅ Contraintes de prix trouvées")
        if constraints.get("floor_price") is not None and constraints.get("ceiling_price") is not None:
            if constraints["floor_price"] >= constraints["ceiling_price"]:
                print("   ⚠️  ATTENTION: floor_price >= ceiling_price (incohérent)")
                print("   💡 L'optimiseur utilisera les valeurs par défaut")
            else:
                print(f"   ✅ Plage valide: {constraints['floor_price']} - {constraints['ceiling_price']}")
    print()

    # 2. Obtenir une recommandation de prix
    print("2️⃣  Obtention d'une recommandation de prix...")
    try:
        recommendation = get_recommended_price(
            property_id=args.property_id,
            room_type=args.room_type,
            date=args.date,
            capacity_remaining=None,  # Sera calculé automatiquement
            context_features={},
        )

        print(f"   ✅ Recommandation obtenue")
        print()
        print("3️⃣  Résultats:")
        print(f"   💰 Prix recommandé: {recommendation.get('price')}")
        print(f"   📊 Stratégie: {recommendation.get('strategy')}")
        print(f"   💵 Revenu attendu: {recommendation.get('expected_revenue')}")
        print(f"   📈 Demande prédite: {recommendation.get('predicted_demand')}")
        print()

        # Vérifier que le prix recommandé respecte les contraintes
        if has_constraints:
            print("4️⃣  Vérification du respect des contraintes:")
            recommended_price = recommendation.get("price")
            floor = constraints.get("floor_price")
            ceiling = constraints.get("ceiling_price")

            if floor is not None and recommended_price < floor:
                print(f"   ❌ ERREUR: Prix recommandé ({recommended_price}) < floor_price ({floor})")
            elif ceiling is not None and recommended_price > ceiling:
                print(f"   ❌ ERREUR: Prix recommandé ({recommended_price}) > ceiling_price ({ceiling})")
            else:
                print(f"   ✅ Prix recommandé respecte les contraintes")
                if floor is not None:
                    print(f"      {recommended_price} >= {floor} ✓")
                if ceiling is not None:
                    print(f"      {recommended_price} <= {ceiling} ✓")
        print()

        # Afficher les détails
        details = recommendation.get("details", {})
        if details:
            print("5️⃣  Détails supplémentaires:")
            print(json.dumps(details, indent=2, ensure_ascii=False))
            print()

    except Exception as e:
        print(f"   ❌ Erreur lors de l'obtention de la recommandation: {e}")
        import traceback

        traceback.print_exc()
        return

    print("=" * 80)
    print("✅ TEST TERMINÉ")
    print("=" * 80)


if __name__ == "__main__":
    main()

