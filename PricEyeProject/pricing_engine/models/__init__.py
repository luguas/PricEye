"""
Sous-package `models` du moteur de pricing PricEye.

Ce dossier contiendra :
- le modèle de prévision de demande (demande attendue pour un prix donné),
- les modèles d’élasticité prix (par segment, saison, etc.),
- éventuellement d’autres modèles auxiliaires (prévision de base, anomalies, etc.).

Les classes et fonctions ici seront connectées au pipeline de données marché
et aux données internes (réservations, occupation, etc.).

TODO (prochaines étapes) :
- `demand_model.py` : entraînement + prédiction de la demande,
- `elasticity_model.py` : estimation d’élasticité par segment.
"""



