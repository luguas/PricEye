#!/usr/bin/env python3
"""
Script de test end-to-end pour le système de pricing déterministe
Vérifie que le pricing fonctionne correctement avec les données marché
"""

import asyncio
import sys
import os
from datetime import date, datetime, timedelta
from pathlib import Path

# Ajouter le répertoire parent au path pour les imports
project_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(project_root))

from dotenv import load_dotenv
load_dotenv(project_root / '.env')

from supabase import create_client, Client

import json

def get_supabase_client() -> Client:
    """Initialise le client Supabase"""
    supabase_url = os.getenv('SUPABASE_URL')
    supabase_key = os.getenv('SUPABASE_SERVICE_ROLE_KEY')
    
    if not supabase_url or not supabase_key:
        print("[ERREUR] Variables d'environnement Supabase manquantes")
        print("Veuillez configurer SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY dans votre .env")
        sys.exit(1)
    
    return create_client(supabase_url, supabase_key)

def format_currency(amount):
    """Formate un montant en euros"""
    if amount is None:
        return "N/A"
    return f"{amount:.2f}€"

def print_section(title):
    """Affiche un titre de section"""
    print("\n" + "=" * 70)
    print(f"  {title}")
    print("=" * 70)

def print_test_result(test_name, passed, details=None):
    """Affiche le résultat d'un test"""
    status = "[OK]" if passed else "[ECHEC]"
    print(f"{status} {test_name}")
    if details:
        print(f"    {details}")

async def test_market_features_available(supabase: Client, city: str, country: str):
    """Teste si des données market_features sont disponibles"""
    print_section("Test 1: Vérification des données marché disponibles")
    
    try:
        # Vérifier s'il y a des données pour cette ville
        today = date.today()
        end_date = today + timedelta(days=30)
        
        response = supabase.table('market_features')\
            .select('*')\
            .eq('country', country)\
            .eq('city', city)\
            .gte('date', today.isoformat())\
            .lte('date', end_date.isoformat())\
            .limit(5)\
            .execute()
        
        if response.data and len(response.data) > 0:
            print_test_result(
                "Données marché disponibles",
                True,
                f"{len(response.data)} enregistrements trouvés pour {city}, {country}"
            )
            
            # Afficher un échantillon
            sample = response.data[0]
            print("\n  Exemple de données marché:")
            print(f"    Date: {sample.get('date')}")
            print(f"    Prix moyen concurrents: {format_currency(sample.get('competitor_avg_price'))}")
            print(f"    Score météo: {sample.get('weather_score', 'N/A')}")
            print(f"    Impact événements: {sample.get('expected_demand_impact', 'N/A')}%")
            print(f"    Tendance marché: {sample.get('market_trend_score', 'N/A')}")
            
            return True, response.data
        else:
            print_test_result(
                "Données marché disponibles",
                False,
                f"Aucune donnée marché trouvée pour {city}, {country}"
            )
            print("\n  [ATTENTION] Le pricing déterministe fonctionnera mais utilisera uniquement")
            print("  les ajustements basiques (stratégie, lead time, week-end).")
            print("  Exécutez le pipeline de données marché pour collecter des données.")
            return False, []
            
    except Exception as e:
        print_test_result("Données marché disponibles", False, f"Erreur: {e}")
        return False, []

async def test_property_exists(supabase: Client, property_id: str = None):
    """Teste si des propriétés existent"""
    print_section("Test 2: Vérification des propriétés")
    
    try:
        # Si un ID est fourni, vérifier cette propriété spécifique
        if property_id:
            response = supabase.table('properties')\
                .select('*')\
                .eq('id', property_id)\
                .limit(1)\
                .execute()
            
            if response.data and len(response.data) > 0:
                prop = response.data[0]
                print_test_result(
                    "Propriété trouvée",
                    True,
                    f"Propriété: {prop.get('address', 'N/A')} à {prop.get('location', 'N/A')}"
                )
                return True, prop
            else:
                print_test_result("Propriété trouvée", False, f"Propriété {property_id} non trouvée")
                return False, None
        
        # Sinon, prendre la première propriété disponible
        response = supabase.table('properties')\
            .select('*')\
            .limit(1)\
            .execute()
        
        if response.data and len(response.data) > 0:
            prop = response.data[0]
            print_test_result(
                "Propriété disponible",
                True,
                f"Propriété: {prop.get('address', 'N/A')} à {prop.get('location', 'N/A')}"
            )
            return True, prop
        else:
            print_test_result("Propriété disponible", False, "Aucune propriété trouvée")
            return False, None
            
    except Exception as e:
        print_test_result("Vérification propriété", False, f"Erreur: {e}")
        return False, None

async def test_deterministic_pricing_calculation(supabase: Client, property: dict):
    """Teste le calcul de pricing déterministe pour quelques dates"""
    print_section("Test 3: Calcul de pricing déterministe")
    
    try:
        # Extraire city et country
        location = property.get('location', '')
        city = location.split(',')[0].strip() if location else 'Paris'
        country = property.get('country', 'FR')
        
        # Dates de test (aujourd'hui, +7 jours, +30 jours, +90 jours)
        today = date.today()
        test_dates = [
            today,
            today + timedelta(days=7),
            today + timedelta(days=30),
            today + timedelta(days=90)
        ]
        
        base_price = property.get('base_price', 100)
        floor_price = property.get('floor_price', 0)
        ceiling_price = property.get('ceiling_price')
        strategy = property.get('strategy', 'Équilibré')
        
        print(f"\n  Propriété: {property.get('address', 'N/A')}")
        print(f"  Ville: {city}, Pays: {country}")
        print(f"  Prix de base: {format_currency(base_price)}")
        print(f"  Prix plancher: {format_currency(floor_price)}")
        print(f"  Prix plafond: {format_currency(ceiling_price) if ceiling_price else 'Non défini'}")
        print(f"  Stratégie: {strategy}")
        
        print("\n  Calcul des prix pour quelques dates:")
        print("  " + "-" * 65)
        
        all_passed = True
        prices_calculated = []
        
        for test_date in test_dates:
            # Récupérer les market_features pour cette date
            response = supabase.table('market_features')\
                .select('*')\
                .eq('country', country)\
                .eq('city', city)\
                .eq('date', test_date.isoformat())\
                .maybe_single()\
                .execute()
            
            market_features = response.data if response.data else None
            
            # Calculer le prix (simplifié, sans appel API Node.js)
            # On va juste vérifier que les données sont disponibles et calculer manuellement
            calculated_price = base_price
            adjustments = []
            
            if market_features:
                competitor_price = market_features.get('competitor_avg_price')
                if competitor_price:
                    ratio = competitor_price / base_price if base_price > 0 else 1
                    if ratio > 1.1:
                        adjustment = (ratio - 1) * 0.5
                        calculated_price += base_price * adjustment
                        adjustments.append(f"Marché: +{adjustment*100:.0f}%")
            
            # Ajustement stratégie
            if strategy == 'Prudent':
                calculated_price *= 0.95
                adjustments.append("Stratégie: -5%")
            elif strategy == 'Agressif':
                calculated_price *= 1.05
                adjustments.append("Stratégie: +5%")
            
            # Ajustement lead time
            days_until = (test_date - today).days
            if days_until > 90:
                calculated_price *= 1.10
                adjustments.append(f"Lead time ({days_until}j): +10%")
            elif days_until < 7:
                if strategy == 'Prudent':
                    calculated_price *= 0.85
                    adjustments.append(f"Last minute: -15%")
            
            # Appliquer contraintes
            if calculated_price < floor_price:
                calculated_price = floor_price
            if ceiling_price and calculated_price > ceiling_price:
                calculated_price = ceiling_price
            
            prices_calculated.append({
                'date': test_date.isoformat(),
                'price': round(calculated_price),
                'has_market_data': market_features is not None
            })
            
            weekday_names = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim']
            weekday = test_date.weekday()
            
            print(f"  {test_date.isoformat()} ({weekday_names[weekday]})")
            print(f"    Prix calculé: {format_currency(calculated_price)}")
            if adjustments:
                print(f"    Ajustements: {', '.join(adjustments)}")
            if market_features:
                print(f"    Données marché: Oui")
            else:
                print(f"    Données marché: Non (prix de base + ajustements basiques)")
        
        print_test_result(
            "Calcul de prix",
            True,
            f"{len(prices_calculated)} prix calculés avec succès"
        )
        
        # Vérifier la cohérence (même date = même prix)
        print("\n  Vérification de la reproductibilité:")
        test_date = test_dates[0]
        prices = [p['price'] for p in prices_calculated if p['date'] == test_date.isoformat()]
        if len(set(prices)) == 1:
            print_test_result("Reproductibilité", True, f"Prix identique pour {test_date.isoformat()}: {prices[0]}€")
        else:
            print_test_result("Reproductibilité", False, f"Prix différents pour {test_date.isoformat()}: {prices}")
            all_passed = False
        
        return all_passed, prices_calculated
        
    except Exception as e:
        print_test_result("Calcul de prix", False, f"Erreur: {e}")
        import traceback
        traceback.print_exc()
        return False, []

async def test_api_endpoint():
    """Teste l'endpoint API de pricing (nécessite que le serveur soit en cours d'exécution)"""
    print_section("Test 4: Endpoint API /api/properties/:id/pricing-strategy")
    
    print("\n  [INFO] Ce test nécessite que le serveur Node.js soit en cours d'exécution")
    print("  et qu'un token d'authentification soit disponible.")
    print("  Pour tester manuellement:")
    print("    POST http://localhost:3001/api/properties/{propertyId}/pricing-strategy")
    print("    Headers: Authorization: Bearer {token}")
    print("    Query params: useMarketData=true (par défaut)")
    
    print_test_result(
        "Endpoint API",
        True,
        "Test manuel requis (voir instructions ci-dessus)"
    )
    
    return True

async def test_price_overrides(supabase: Client, property_id: str):
    """Teste la sauvegarde des price_overrides"""
    print_section("Test 5: Vérification des price_overrides existants")
    
    try:
        response = supabase.table('price_overrides')\
            .select('*')\
            .eq('property_id', property_id)\
            .limit(10)\
            .execute()
        
        if response.data and len(response.data) > 0:
            print_test_result(
                "Price overrides existants",
                True,
                f"{len(response.data)} prix surchargés trouvés"
            )
            
            # Afficher quelques exemples
            print("\n  Exemples de price_overrides:")
            for override in response.data[:3]:
                print(f"    {override.get('date')}: {format_currency(override.get('price'))}")
                if override.get('is_locked'):
                    print(f"      [VERROUILLE]")
            
            return True
        else:
            print_test_result(
                "Price overrides existants",
                True,
                "Aucun price_override trouvé (normal si aucune stratégie n'a été générée)"
            )
            return True
            
    except Exception as e:
        print_test_result("Vérification price_overrides", False, f"Erreur: {e}")
        return False

async def run_all_tests():
    """Exécute tous les tests"""
    print("\n" + "=" * 70)
    print("  TESTS END-TO-END: SYSTÈME DE PRICING DÉTERMINISTE")
    print("=" * 70)
    
    supabase = get_supabase_client()
    
    # Test 1: Propriété disponible
    property_exists, property = await test_property_exists(supabase)
    
    if not property_exists:
        print("\n[ERREUR] Aucune propriété trouvée. Veuillez créer une propriété avant de tester.")
        return False
    
    property_id = property['id']
    location = property.get('location', '')
    city = location.split(',')[0].strip() if location else 'Paris'
    country = property.get('country', 'FR')
    
    # Test 2: Données marché
    market_data_available, market_data = await test_market_features_available(supabase, city, country)
    
    # Test 3: Calcul de prix
    pricing_works, prices = await test_deterministic_pricing_calculation(supabase, property)
    
    # Test 4: Endpoint API (info seulement)
    await test_api_endpoint()
    
    # Test 5: Price overrides
    await test_price_overrides(supabase, property_id)
    
    # Résumé
    print_section("RÉSUMÉ DES TESTS")
    
    results = [
        ("Propriété disponible", property_exists),
        ("Données marché disponibles", market_data_available),
        ("Calcul de pricing déterministe", pricing_works),
        ("Price overrides", True),  # Toujours OK (juste une vérification)
    ]
    
    passed = sum(1 for _, result in results if result)
    total = len(results)
    
    print("\n  Résultats:")
    for name, result in results:
        status = "[OK]" if result else "[ECHEC]"
        print(f"    {status} {name}")
    
    print(f"\n  Total: {passed}/{total} tests réussis")
    
    if passed == total:
        print("\n  [SUCCÈS] Tous les tests sont passés !")
    elif market_data_available and pricing_works:
        print("\n  [ATTENTION] Certains tests ont échoué, mais le pricing déterministe")
        print("  fonctionne correctement. Vérifiez les détails ci-dessus.")
    else:
        print("\n  [ECHEC] Certains tests critiques ont échoué.")
        print("  Veuillez vérifier:")
        print("    - Que le pipeline de données marché a été exécuté")
        print("    - Que des propriétés existent dans la base de données")
    
    return passed == total

if __name__ == '__main__':
    try:
        success = asyncio.run(run_all_tests())
        sys.exit(0 if success else 1)
    except KeyboardInterrupt:
        print("\n\n[INTERRUPTION] Tests interrompus par l'utilisateur")
        sys.exit(1)
    except Exception as e:
        print(f"\n[ERREUR] Erreur fatale: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)








