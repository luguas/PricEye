"""
Serveur Python persistant pour le moteur de pricing PricEye.

Ce script charge les modèles au démarrage et attend les requêtes via stdin.
Il est conçu pour être robuste : si une requête plante, le serveur loggue l'erreur
mais ne s'arrête pas.

Communication :
- Entrée : JSON ligne par ligne sur stdin
- Sortie : JSON ligne par ligne sur stdout
- Logs : stderr
"""

import sys
import json
import traceback
import os

# Ajout du chemin courant pour les imports relatifs si nécessaire
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Importation de votre logique métier
try:
    from pricing_engine.optimizer import get_recommended_price
    MODEL_LOADED = True
except ImportError as e:
    sys.stderr.write(f"Erreur d'importation critique: {str(e)}\n")
    sys.stderr.flush()
    MODEL_LOADED = False


def process_request(data):
    """
    Traite une requête JSON unique.
    
    Format attendu :
    {
        "propertyId": "uuid",
        "roomType": "default",
        "date": "2024-01-01",
        "capacityRemaining": 5,  # optionnel
        "contextFeatures": {}     # optionnel
    }
    
    Retourne :
    {
        "status": "success",
        "propertyId": "uuid",
        "price": 150.00,
        "expected_revenue": 750.00,
        "predicted_demand": 5.0,
        "strategy": "demand_simulation_grid_search",
        "details": {...}
    }
    """
    if not MODEL_LOADED:
        raise Exception("Le modèle de pricing n'a pas pu être chargé au démarrage.")

    # Extraction des paramètres
    property_id = data.get('propertyId')
    room_type = data.get('roomType', 'default')
    date = data.get('date')
    capacity_remaining = data.get('capacityRemaining')  # optionnel
    context_features = data.get('contextFeatures')  # optionnel
    
    # Validation des paramètres requis
    if not property_id:
        raise ValueError("propertyId est requis")
    if not date:
        raise ValueError("date est requise")
    
    # Appel à la fonction réelle
    result = get_recommended_price(
        property_id=property_id,
        room_type=room_type,
        date=date,
        capacity_remaining=capacity_remaining,
        context_features=context_features,
    )
    
    # Formater la réponse pour Node.js
    response = {
        "status": "success",
        "propertyId": property_id,
        "price": result.get("price"),
        "expected_revenue": result.get("expected_revenue"),
        "predicted_demand": result.get("predicted_demand"),
        "strategy": result.get("strategy"),
        "details": result.get("details", {})
    }
    
    return response


def main():
    sys.stderr.write("Service Python Pricing Engine Démarré (PID: {})\n".format(os.getpid()))
    sys.stderr.flush()

    # Boucle infinie de lecture sur stdin
    while True:
        try:
            line = sys.stdin.readline()
            if not line:
                break  # Fin du flux (Node.js a fermé le process)
            
            line = line.strip()
            if not line:
                continue

            try:
                # 1. Parsing
                request_data = json.loads(line)
                
                # 2. Traitement
                response_data = process_request(request_data)
                
                # 3. Réponse (Succès)
                sys.stdout.write(json.dumps(response_data) + "\n")
                sys.stdout.flush()

            except Exception as e:
                # 3. Réponse (Erreur spécifique à la requête)
                # On renvoie un JSON d'erreur pour que Node.js puisse rejeter la Promise proprement
                error_response = {
                    "error": str(e),
                    "status": "error",
                    "type": type(e).__name__
                }
                sys.stdout.write(json.dumps(error_response) + "\n")
                sys.stdout.flush()
                # On loggue l'erreur complète dans stderr pour le debug
                sys.stderr.write(f"Erreur traitement requête: {str(e)}\n")
                sys.stderr.write(f"Traceback: {traceback.format_exc()}\n")
                sys.stderr.flush()

        except KeyboardInterrupt:
            break
        except Exception as global_error:
            sys.stderr.write(f"Erreur critique boucle principale: {str(global_error)}\n")
            sys.stderr.write(f"Traceback: {traceback.format_exc()}\n")
            sys.stderr.flush()


if __name__ == "__main__":
    main()
