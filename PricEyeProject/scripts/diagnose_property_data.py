"""
Script de diagnostic pour comprendre pourquoi une propriété n'a pas de données.

Usage (depuis `PricEyeProject/`) :

    python -m scripts.diagnose_property_data --property-id YOUR_PROPERTY_ID

Ce script vérifie :
- Les données dans la table bookings
- Les données dans la table price_overrides
- La capacité de la propriété
- Le résultat de get_internal_pricing_data
"""

import argparse
from datetime import datetime, timedelta

from pricing_engine.interfaces.data_access import (
    get_bookings_for_property_date_range,
    get_internal_pricing_data,
    get_price_overrides_for_property_date_range,
    get_property_capacity,
    get_supabase_client,
)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Diagnostiquer pourquoi une propriété n'a pas de données."
    )
    parser.add_argument(
        "--property-id",
        type=str,
        required=True,
        help="ID de la propriété à diagnostiquer (UUID Supabase).",
    )
    parser.add_argument(
        "--days",
        type=int,
        default=180,
        help="Nombre de jours à vérifier en arrière (défaut: 180).",
    )

    args = parser.parse_args()

    print("=" * 80)
    print("🔍 DIAGNOSTIC DES DONNÉES D'UNE PROPRIÉTÉ")
    print("=" * 80)
    print(f"🏠 Property ID: {args.property_id}")
    print()

    # Calculer les dates
    end_date = datetime.now().date()
    start_date = end_date - timedelta(days=args.days)

    start_date_str = start_date.isoformat()
    end_date_str = end_date.isoformat()

    print(f"📅 Plage de dates vérifiée: {start_date_str} → {end_date_str} ({args.days} jours)")
    print()

    # 1. Vérifier les bookings
    print("1️⃣  Vérification des réservations (table 'bookings')...")
    try:
        bookings = get_bookings_for_property_date_range(
            args.property_id, start_date_str, end_date_str
        )
        print(f"   📊 Nombre de réservations trouvées: {len(bookings)}")

        if bookings:
            print(f"   ✅ Exemples de réservations:")
            for i, booking in enumerate(bookings[:5], 1):
                start_date_booking = booking.get("start_date", "N/A")
                print(f"      {i}. start_date: {start_date_booking}")
        else:
            print("   ⚠️  Aucune réservation trouvée")
            print("   💡 Vérifiez que:")
            print("      - La table 'bookings' contient des données")
            print("      - Les réservations ont un 'property_id' correspondant")
            print("      - Les réservations ont un 'start_date' dans la plage")
        print()
    except Exception as e:
        print(f"   ❌ Erreur lors de la récupération des bookings: {e}")
        import traceback

        traceback.print_exc()
        print()

    # 2. Vérifier les price_overrides
    print("2️⃣  Vérification des prix (table 'price_overrides')...")
    try:
        overrides = get_price_overrides_for_property_date_range(
            args.property_id, start_date_str, end_date_str
        )
        print(f"   📊 Nombre de price_overrides trouvés: {len(overrides)}")

        if overrides:
            print(f"   ✅ Exemples de price_overrides:")
            for i, override in enumerate(overrides[:5], 1):
                date_override = override.get("date", "N/A")
                price = override.get("price", "N/A")
                print(f"      {i}. date: {date_override}, price: {price}")
        else:
            print("   ⚠️  Aucun price_override trouvé (ce n'est pas nécessaire)")
        print()
    except Exception as e:
        print(f"   ❌ Erreur lors de la récupération des price_overrides: {e}")
        import traceback

        traceback.print_exc()
        print()

    # 3. Vérifier la capacité
    print("3️⃣  Vérification de la capacité (table 'properties')...")
    try:
        capacity = get_property_capacity(args.property_id)
        print(f"   📊 Capacité trouvée: {capacity}")
        if capacity is None:
            print("   ⚠️  Aucune capacité trouvée (vérifiez la colonne 'max_guests' dans 'properties')")
        print()
    except Exception as e:
        print(f"   ❌ Erreur lors de la récupération de la capacité: {e}")
        import traceback

        traceback.print_exc()
        print()

    # 4. Vérifier get_internal_pricing_data
    print("4️⃣  Vérification de get_internal_pricing_data()...")
    try:
        records = get_internal_pricing_data(args.property_id, start_date_str, end_date_str)
        print(f"   📊 Nombre d'enregistrements retournés: {len(records)}")

        if records:
            print(f"   ✅ Exemples d'enregistrements:")
            for i, record in enumerate(records[:5], 1):
                print(
                    f"      {i}. date: {record.date}, bookings: {record.bookings}, price: {record.price}, capacity: {record.capacity}"
                )
        else:
            print("   ⚠️  Aucun enregistrement retourné")
            print("   💡 Raisons possibles:")
            print("      - Aucune réservation dans la plage de dates")
            print("      - Les réservations n'ont pas de 'start_date' valide")
            print("      - Problème dans la logique d'agrégation")
        print()
    except Exception as e:
        print(f"   ❌ Erreur lors de l'appel à get_internal_pricing_data: {e}")
        import traceback

        traceback.print_exc()
        print()

    # 5. Vérification directe dans Supabase
    print("5️⃣  Vérification directe dans Supabase...")
    try:
        client = get_supabase_client()

        # Vérifier toutes les bookings (sans filtre de date pour voir ce qui existe)
        response_all = (
            client.table("bookings")
            .select("id, property_id, start_date")
            .eq("property_id", args.property_id)
            .limit(10)
            .execute()
        )

        all_bookings = response_all.data or []
        print(f"   📊 Total de bookings pour cette propriété (toutes dates): {len(all_bookings)}")

        if all_bookings:
            print(f"   ✅ Exemples de bookings (toutes dates):")
            for i, booking in enumerate(all_bookings[:5], 1):
                print(
                    f"      {i}. id: {booking.get('id', 'N/A')[:8]}..., start_date: {booking.get('start_date', 'N/A')}"
                )
        else:
            print("   ⚠️  Aucune booking trouvée pour cette propriété (même sans filtre de date)")
            print("   💡 Vérifiez que:")
            print("      - La table 'bookings' existe")
            print("      - Il y a des réservations avec ce property_id")
            print("      - Le property_id est correct")

        print()
    except Exception as e:
        print(f"   ❌ Erreur lors de la vérification directe: {e}")
        import traceback

        traceback.print_exc()
        print()

    # Résumé
    print("=" * 80)
    print("📋 RÉSUMÉ")
    print("=" * 80)
    print()
    print("Pour que get_internal_pricing_data retourne des données, il faut :")
    print("1. ✅ Des réservations dans la table 'bookings' avec :")
    print("   - property_id correspondant")
    print("   - start_date dans la plage de dates")
    print("2. (Optionnel) Des price_overrides pour avoir des prix")
    print("3. (Optionnel) Une capacité dans la table 'properties'")
    print()


if __name__ == "__main__":
    main()

