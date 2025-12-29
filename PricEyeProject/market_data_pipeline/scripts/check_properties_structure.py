"""Script pour vérifier la structure exacte des propriétés dans Supabase."""

import asyncio
import json
from ..config.settings import Settings

async def main():
    settings = Settings.from_env()
    
    if not settings.supabase_url or not settings.supabase_key:
        print("Erreur: Variables d'environnement Supabase non configurees")
        return
    
    from supabase import create_client
    supabase = create_client(settings.supabase_url, settings.supabase_key)
    
    # Récupérer quelques propriétés
    response = supabase.table('properties').select('*').limit(5).execute()
    
    if not response.data:
        print("Aucune propriete trouvee")
        return
    
    print("=" * 80)
    print("STRUCTURE DES PROPRIETES")
    print("=" * 80)
    
    for i, prop in enumerate(response.data, 1):
        print(f"\nPropriete {i} (ID: {prop.get('id', 'N/A')}):")
        print(f"  Status: {prop.get('status', 'N/A')}")
        print(f"  Nom: {prop.get('name', 'N/A')}")
        
        # Vérifier city/country directement
        print(f"  city (direct): {prop.get('city', 'NON TROUVE')}")
        print(f"  country (direct): {prop.get('country', 'NON TROUVE')}")
        
        # Vérifier dans address
        if 'address' in prop:
            address = prop['address']
            print(f"  address (type): {type(address)}")
            if isinstance(address, dict):
                print(f"  address.city: {address.get('city', 'NON TROUVE')}")
                print(f"  address.country: {address.get('country', 'NON TROUVE')}")
                print(f"  address complet: {json.dumps(address, indent=6, ensure_ascii=False)}")
            else:
                print(f"  address valeur: {address}")
        
        # Vérifier dans location
        if 'location' in prop:
            location = prop['location']
            print(f"  location (type): {type(location)}")
            if isinstance(location, dict):
                print(f"  location.city: {location.get('city', 'NON TROUVE')}")
                print(f"  location.country: {location.get('country', 'NON TROUVE')}")
                print(f"  location complet: {json.dumps(location, indent=6, ensure_ascii=False)}")
            else:
                print(f"  location valeur: {location}")
        
        print("-" * 80)

if __name__ == "__main__":
    asyncio.run(main())

