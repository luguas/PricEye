"""
Script de diagnostic pour le pipeline de données marché.

Ce script vérifie :
- Configuration Supabase
- Propriétés actives dans la base
- Clés API configurées
- Connexion aux APIs externes
- Structure des données

Usage:
    python -m market_data_pipeline.scripts.diagnose_pipeline [--city CITY] [--country COUNTRY]
"""

import argparse
import asyncio
import logging
import os
import sys
from typing import List, Dict, Optional, Any

try:
    from supabase import create_client, Client
    SUPABASE_AVAILABLE = True
except ImportError:
    SUPABASE_AVAILABLE = False

from ..config.settings import Settings
from ..jobs.collect_market_data import get_active_properties

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


async def check_supabase_connection(settings: Settings) -> bool:
    """Vérifie la connexion à Supabase."""
    print("\n" + "=" * 80)
    print("1. VÉRIFICATION SUPABASE")
    print("=" * 80)
    
    if not SUPABASE_AVAILABLE:
        print("[ERREUR] Bibliotheque Supabase non installee")
        return False
    
    if not settings.supabase_url:
        print("[ERREUR] SUPABASE_URL non configure")
        return False
    
    if not settings.supabase_key:
        print("[ERREUR] SUPABASE_SERVICE_ROLE_KEY non configure")
        return False
    
    print(f"[OK] URL Supabase: {settings.supabase_url}")
    print(f"[OK] Cle Supabase: {'*' * 20}...{settings.supabase_key[-4:]}")
    
    try:
        supabase = create_client(settings.supabase_url, settings.supabase_key)
        
        # Test de connexion simple
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None,
            lambda: supabase.table('properties').select('id', count='exact').limit(1).execute()
        )
        
        print("[OK] Connexion a Supabase reussie")
        return True
        
    except Exception as e:
        print(f"[ERREUR] Erreur de connexion a Supabase: {e}")
        return False


async def check_properties(settings: Settings, city: Optional[str] = None, country: Optional[str] = None) -> List[Dict[str, Any]]:
    """Vérifie les propriétés dans la base."""
    print("\n" + "=" * 80)
    print("2. VÉRIFICATION DES PROPRIÉTÉS")
    print("=" * 80)
    
    try:
        properties = await get_active_properties(settings, countries=[country] if country else None, cities=[city] if city else None)
        
        print(f"[INFO] Total de proprietes actives trouvees: {len(properties)}")
        
        if properties:
            print("\n[INFO] Details des proprietes:")
            for i, prop in enumerate(properties[:10], 1):  # Limiter à 10 pour l'affichage
                print(f"\n  Propriété {i}:")
                print(f"    ID: {prop.get('id', 'N/A')}")
                print(f"    Nom: {prop.get('name', 'N/A')}")
                print(f"    Ville: {prop.get('city', 'N/A')}")
                print(f"    Pays: {prop.get('country', 'N/A')}")
                print(f"    Statut: {prop.get('status', 'N/A')}")
                print(f"    Type: {prop.get('property_type', 'N/A')}")
                print(f"    Chambres: {prop.get('bedrooms', 'N/A')}")
                print(f"    Latitude: {prop.get('latitude', 'N/A')}")
                print(f"    Longitude: {prop.get('longitude', 'N/A')}")
                
                # Vérifier les champs critiques
                issues = []
                if not prop.get('city'):
                    issues.append("❌ 'city' manquant")
                if not prop.get('country'):
                    issues.append("❌ 'country' manquant")
                if prop.get('status') != 'active':
                    issues.append(f"⚠️  'status' = '{prop.get('status', 'N/A')}' (attendu: 'active')")
                
                if issues:
                    print(f"    Problemes: {'; '.join(issues)}")
                else:
                    print(f"    [OK] Tous les champs critiques sont presents")
            
            if len(properties) > 10:
                print(f"\n  ... et {len(properties) - 10} autres propriétés")
        else:
            print("\n[ATTENTION] Aucune propriete active trouvee")
            print("\n  Causes possibles:")
            print("    - Aucune propriété avec status='active' dans la base")
            print("    - Filtres city/country trop restrictifs")
            print("    - Colonnes 'city' ou 'country' manquantes ou dans un format différent")
            print("\n  Vérification directe dans Supabase:")
            print("    SELECT id, name, city, country, status FROM properties LIMIT 10;")
        
        return properties
        
    except Exception as e:
        print(f"[ERREUR] Erreur lors de la recuperation des proprietes: {e}")
        import traceback
        traceback.print_exc()
        return []


async def check_api_keys(settings: Settings):
    """Vérifie les clés API configurées."""
    print("\n" + "=" * 80)
    print("3. VÉRIFICATION DES CLÉS API")
    print("=" * 80)
    
    # Les clés API sont récupérées directement depuis les variables d'environnement
    api_keys = {
        "APIFY_API_TOKEN": os.getenv('APIFY_API_TOKEN'),
        "OPENWEATHER_API_KEY": os.getenv('OPENWEATHER_API_KEY'),
        "WEATHERAPI_KEY": os.getenv('WEATHERAPI_KEY'),
        "NEWSAPI_KEY": os.getenv('NEWSAPI_KEY'),
        "GOOGLE_TRENDS_API_KEY": os.getenv('GOOGLE_TRENDS_API_KEY'),
    }
    
    required_keys = {
        "APIFY_API_TOKEN": "Collecte de données concurrents (requis pour collect_competitors)",
        "OPENWEATHER_API_KEY": "Collecte météo principale (requis pour collect_weather)",
    }
    
    optional_keys = {
        "WEATHERAPI_KEY": "Fallback météo (optionnel)",
        "NEWSAPI_KEY": "Collecte news (optionnel)",
        "GOOGLE_TRENDS_API_KEY": "Tendances Google (optionnel)",
    }
    
    print("\n[INFO] Cles API requises:")
    all_required_ok = True
    for key_name, description in required_keys.items():
        value = api_keys.get(key_name)
        if value:
            print(f"  [OK] {key_name}: {'*' * 20}...{value[-4:]}")
        else:
            print(f"  [ERREUR] {key_name}: NON CONFIGUREE")
            print(f"     -> {description}")
            all_required_ok = False
    
    print("\n[INFO] Cles API optionnelles:")
    for key_name, description in optional_keys.items():
        value = api_keys.get(key_name)
        if value:
            print(f"  [OK] {key_name}: {'*' * 20}...{value[-4:]}")
        else:
            print(f"  [ATTENTION] {key_name}: Non configuree ({description})")
    
    if not all_required_ok:
        print("\n[ATTENTION] Certaines cles API requises sont manquantes")
        print("   Cela peut empêcher la collecte de données")
    
    return all_required_ok


async def check_raw_data(settings: Settings, city: Optional[str] = None, country: Optional[str] = None):
    """Vérifie les données brutes existantes."""
    print("\n" + "=" * 80)
    print("4. VÉRIFICATION DES DONNÉES BRUTES")
    print("=" * 80)
    
    if not SUPABASE_AVAILABLE:
        print("[ERREUR] Supabase non disponible")
        return
    
    try:
        supabase = create_client(settings.supabase_url, settings.supabase_key)
        loop = asyncio.get_event_loop()
        
        # Vérifier raw_competitor_data
        query_comp = supabase.table('raw_competitor_data').select('id', count='exact')
        if city:
            query_comp = query_comp.eq('city', city)
        if country:
            query_comp = query_comp.eq('country', country)
        
        response_comp = await loop.run_in_executor(
            None,
            lambda: query_comp.execute()
        )
        comp_count = response_comp.count if hasattr(response_comp, 'count') else len(response_comp.data or [])
        
        print(f"[INFO] Donnees concurrents brutes: {comp_count}")
        if comp_count > 0:
            print(f"  [OK] Des donnees concurrents existent deja")
        else:
            print(f"  [ATTENTION] Aucune donnee concurrent brute")
        
        # Vérifier raw_weather_data
        query_weather = supabase.table('raw_weather_data').select('id', count='exact')
        if city:
            query_weather = query_weather.eq('city', city)
        if country:
            query_weather = query_weather.eq('country', country)
        
        response_weather = await loop.run_in_executor(
            None,
            lambda: query_weather.execute()
        )
        weather_count = response_weather.count if hasattr(response_weather, 'count') else len(response_weather.data or [])
        
        print(f"[INFO] Donnees meteo brutes: {weather_count}")
        if weather_count > 0:
            print(f"  [OK] Des donnees meteo existent deja")
        else:
            print(f"  [ATTENTION] Aucune donnee meteo brute")
        
    except Exception as e:
        print(f"[ERREUR] Erreur lors de la verification des donnees brutes: {e}")
        import traceback
        traceback.print_exc()


async def test_property_filtering(settings: Settings):
    """Test le filtrage des propriétés."""
    print("\n" + "=" * 80)
    print("5. TEST DU FILTRAGE DES PROPRIÉTÉS")
    print("=" * 80)
    
    if not SUPABASE_AVAILABLE:
        print("[ERREUR] Supabase non disponible")
        return
    
    try:
        supabase = create_client(settings.supabase_url, settings.supabase_key)
        loop = asyncio.get_event_loop()
        
        # Récupérer toutes les propriétés (sans filtre)
        print("\n[INFO] Toutes les proprietes (premieres 20):")
        response_all = await loop.run_in_executor(
            None,
            lambda: supabase.table('properties').select('*').limit(20).execute()
        )
        
        all_props = response_all.data if response_all.data else []
        print(f"  Total récupéré: {len(all_props)}")
        
        if all_props:
            print("\n  Analyse des colonnes disponibles:")
            sample = all_props[0]
            print(f"    Colonnes présentes: {list(sample.keys())[:10]}...")
            
            # Analyser le format des données
            statuses = set()
            cities = set()
            countries = set()
            
            for prop in all_props:
                if prop.get('status'):
                    statuses.add(prop.get('status'))
                if prop.get('city'):
                    cities.add(prop.get('city'))
                if prop.get('country'):
                    countries.add(prop.get('country'))
            
            print(f"\n  Valeurs trouvées:")
            print(f"    Status: {list(statuses)}")
            print(f"    Cities (échantillon): {list(cities)[:5]}")
            print(f"    Countries (échantillon): {list(countries)[:5]}")
            
            # Vérifier si city/country sont dans un sous-objet
            for prop in all_props[:3]:
                if 'address' in prop and isinstance(prop['address'], dict):
                    print(f"\n  [ATTENTION] Propriete {prop.get('id', 'N/A')}: 'city'/'country' dans 'address'")
                    print(f"      address: {prop['address']}")
        
    except Exception as e:
        print(f"[ERREUR] Erreur lors du test de filtrage: {e}")
        import traceback
        traceback.print_exc()


async def main():
    """Point d'entrée principal."""
    parser = argparse.ArgumentParser(
        description="Diagnostic du pipeline de données marché"
    )
    
    parser.add_argument(
        "--city",
        type=str,
        help="Ville à vérifier"
    )
    
    parser.add_argument(
        "--country",
        type=str,
        help="Pays à vérifier"
    )
    
    args = parser.parse_args()
    
    print("=" * 80)
    print("DIAGNOSTIC DU PIPELINE DE DONNÉES MARCHÉ")
    print("=" * 80)
    
    # Charger la configuration
    settings = Settings.from_env()
    
    # 1. Vérifier Supabase
    supabase_ok = await check_supabase_connection(settings)
    if not supabase_ok:
        print("\n[ERREUR] Supabase n'est pas configure correctement. Arret du diagnostic.")
        sys.exit(1)
    
    # 2. Vérifier les propriétés
    properties = await check_properties(settings, args.city, args.country)
    
    # 3. Vérifier les clés API
    api_keys_ok = await check_api_keys(settings)
    
    # 4. Vérifier les données brutes
    await check_raw_data(settings, args.city, args.country)
    
    # 5. Test du filtrage
    await test_property_filtering(settings)
    
    # Résumé final
    print("\n" + "=" * 80)
    print("RÉSUMÉ DU DIAGNOSTIC")
    print("=" * 80)
    
    issues = []
    if not properties:
        issues.append("[ERREUR] Aucune propriete active trouvee")
    if not api_keys_ok:
        issues.append("[ERREUR] Cles API requises manquantes")
    
    if not issues:
        print("[OK] Tous les prerequis semblent etre en place")
        print("\n[INFO] Si le pipeline ne collecte toujours pas de donnees:")
        print("   - Verifiez les logs detailles avec --verbose")
        print("   - Verifiez que les cles API sont valides")
        print("   - Verifiez que les APIs externes sont accessibles")
    else:
        print("[ATTENTION] Problemes detectes:")
        for issue in issues:
            print(f"   {issue}")
        print("\n[INFO] Corrigez ces problemes avant de reessayer")


if __name__ == "__main__":
    asyncio.run(main())

