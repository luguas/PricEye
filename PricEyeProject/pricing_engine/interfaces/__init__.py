"""
Sous-package `interfaces` du moteur de pricing PricEye.

Responsabilités :
- fournir une couche d’abstraction entre le moteur IA
  et les systèmes externes (base de données, APIs internes, etc.),
- centraliser les appels à Supabase/PostgreSQL ou à tout autre backend,
- faciliter le test (en permettant le mocking de cette couche).

Les implémentations concrètes seront ajoutées progressivement
au fil des étapes (accès aux données internes, logs, etc.).
"""



