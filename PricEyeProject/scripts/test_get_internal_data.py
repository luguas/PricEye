"""
Script de test pour vérifier que get_internal_pricing_data retourne bien tous les jours.

Usage (depuis `PricEyeProject/`) :

    python -m scripts.test_get_internal_data --property-id YOUR_PROPERTY_ID
"""

import argparse
from datetime import datetime, timedelta

from pricing_engine.interfaces.data_access import get_internal_pricing_data


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Tester get_internal_pricing_data pour une propriété."
    )
    parser.add_argument(
        "--property-id",
        type=str,
        required=True,
        help="ID de la propriété à tester (UUID Supabase).",
    )
    parser.add_argument(
        "--days",
        type=int,
        default=90,
        help="Nombre de jours à vérifier (défaut: 90).",
    )

    args = parser.parse_args()

    print("=" * 80)
    print("🧪 TEST DE get_internal_pricing_data")
    print("=" * 80)
    print(f"🏠 Property ID: {args.property_id}")
    print()

    # Calculer les dates
    end_date = datetime.now().date()
    start_date = end_date - timedelta(days=args.days)

    start_date_str = start_date.isoformat()
    end_date_str = end_date.isoformat()

    print(f"📅 Plage de dates: {start_date_str} → {end_date_str} ({args.days} jours)")
    print()

    # Appeler la fonction
    print("🔄 Appel de get_internal_pricing_data()...")
    try:
        records = get_internal_pricing_data(args.property_id, start_date_str, end_date_str)
        
        print(f"✅ Fonction exécutée sans erreur")
        print(f"📊 Nombre d'enregistrements retournés: {len(records)}")
        print()

        if len(records) == 0:
            print("❌ PROBLÈME: Aucun enregistrement retourné!")
            print()
            print("🔍 Vérification des dates...")
            print(f"   start_date_str: {start_date_str} (type: {type(start_date_str)})")
            print(f"   end_date_str: {end_date_str} (type: {type(end_date_str)})")
            print()
            print("💡 Causes possibles:")
            print("   1. Erreur silencieuse dans get_internal_pricing_data")
            print("   2. Problème de parsing des dates")
            print("   3. Exception attrapée quelque part")
            return

        # Vérifier que tous les jours sont présents
        expected_days = args.days + 1  # +1 car on inclut le jour de fin
        if len(records) != expected_days:
            print(f"⚠️  ATTENTION: {len(records)} enregistrements au lieu de {expected_days} attendus")
        else:
            print(f"✅ Tous les jours sont présents ({len(records)} enregistrements)")

        # Afficher quelques exemples
        print()
        print("📋 Exemples d'enregistrements (premiers 5):")
        for i, record in enumerate(records[:5], 1):
            print(f"   {i}. date: {record.date}, bookings: {record.bookings}, price: {record.price}, capacity: {record.capacity}")

        # Compter les jours avec et sans réservations
        days_with_bookings = sum(1 for r in records if r.bookings > 0)
        days_without_bookings = sum(1 for r in records if r.bookings == 0)
        
        print()
        print("📊 Statistiques:")
        print(f"   Jours avec réservations: {days_with_bookings}")
        print(f"   Jours sans réservations: {days_without_bookings}")
        print(f"   Total: {len(records)}")

    except Exception as e:
        print(f"❌ ERREUR lors de l'appel: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    main()

