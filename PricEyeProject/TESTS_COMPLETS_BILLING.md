# 🧪 Phase 12 : Tests Complets - Billing & Stripe

## 📋 Vue d'ensemble

Ce document contient tous les tests à effectuer pour valider l'implémentation complète du système de facturation Stripe.

---

## 🔧 Prérequis

### 1. Configuration

- [ ] Fichier `.env` créé et rempli avec toutes les variables Stripe
- [ ] `STRIPE_WEBHOOK_SECRET` configuré
- [ ] Webhook configuré dans Stripe Dashboard
- [ ] Billing thresholds configurés dans Stripe Dashboard (50€ recommandé)

### 2. Outils de test

- [ ] Stripe CLI installé (pour tester les webhooks en local)
- [ ] Compte Stripe Test avec cartes de test
- [ ] Accès à Firestore pour vérifier les données

### 3. Cartes de test Stripe

```
Carte valide : 4242 4242 4242 4242
Date : n'importe quelle date future
CVC : n'importe quel 3 chiffres
Code postal : n'importe quel code postal

Carte refusée : 4000 0000 0000 0002
```

---

## 📝 TEST 1 : Onboarding Complet (Flux Principal)

### Objectif
Valider le flux complet d'onboarding avec Stripe Checkout.

### Étapes

1. **Créer un nouveau compte**
   ```bash
   POST /api/auth/register
   {
     "email": "test1@example.com",
     "password": "password123",
     "name": "Test User 1"
   }
   ```

2. **Importer des propriétés**
   ```bash
   POST /api/integrations/import-properties
   {
     "propertiesToImport": [
       {
         "pmsId": "airbnb_123",
         "name": "Appartement Paris",
         "location": "Paris, France",
         "surface": 50,
         "capacity": 4
       },
       {
         "pmsId": "airbnb_456",
         "name": "Studio Lyon",
         "location": "Lyon, France",
         "surface": 30,
         "capacity": 2
       }
     ],
     "pmsType": "smoobu"
   }
   ```

3. **Vérifier l'enregistrement des listing IDs**
   - Aller dans Firestore → Collection `used_listing_ids`
   - Vérifier que "airbnb_123" et "airbnb_456" sont enregistrés
   - Vérifier que `source: "import_properties"`

4. **Créer une session Checkout**
   ```bash
   POST /api/checkout/create-session
   Headers: Authorization: Bearer <token>
   ```

5. **Vérifier la réponse**
   ```json
   {
     "url": "https://checkout.stripe.com/...",
     "sessionId": "cs_test_..."
   }
   ```

6. **Compléter le checkout**
   - Rediriger vers l'URL retournée
   - Utiliser la carte de test : 4242 4242 4242 4242
   - Compléter le paiement

7. **Vérifier le webhook**
   - Utiliser Stripe CLI : `stripe listen --forward-to localhost:5000/api/webhooks/stripe`
   - Vérifier que l'événement `checkout.session.completed` est reçu
   - Vérifier les logs : "Checkout session complétée avec succès"

8. **Vérifier le profil utilisateur**
   - Aller dans Firestore → Collection `users` → Document utilisateur
   - Vérifier :
     - `stripeCustomerId` présent
     - `stripeSubscriptionId` présent
     - `subscriptionStatus: "trialing"`
     - `pmsSyncEnabled: true`
     - `accessDisabled: false`

9. **Vérifier l'enregistrement des listing IDs (checkout)**
   - Aller dans Firestore → Collection `used_listing_ids`
   - Vérifier que les listing IDs sont enregistrés avec `source: "checkout_completed"`

### ✅ Résultat attendu

- ✅ Session Checkout créée avec succès
- ✅ Essai gratuit de 30 jours accordé
- ✅ Profil utilisateur mis à jour
- ✅ Listing IDs enregistrés (import + checkout)
- ✅ Synchronisation PMS activée

---

## 📝 TEST 2 : Limite de 10 Propriétés pendant l'Essai

### Objectif
Valider que la limite de 10 propriétés est respectée pendant l'essai gratuit.

### Étapes

1. **Utiliser le compte créé dans TEST 1** (en période d'essai)

2. **Ajouter 8 propriétés supplémentaires** (total = 10)
   ```bash
   POST /api/properties
   {
     "address": "Propriété X",
     "location": "Ville, Pays",
     "surface": 50,
     "capacity": 4
   }
   ```
   - Répéter 8 fois
   - ✅ Chaque ajout doit réussir

3. **Tenter d'ajouter la 11ème propriété**
   ```bash
   POST /api/properties
   {
     "address": "Propriété 11",
     "location": "Ville, Pays",
     "surface": 50,
     "capacity": 4
   }
   ```

4. **Vérifier la réponse d'erreur**
   ```json
   {
     "error": "LIMIT_EXCEEDED",
     "message": "Vous dépassez la limite gratuite de 10 propriétés.",
     "currentCount": 10,
     "maxAllowed": 10,
     "requiresPayment": true
   }
   ```

5. **Tester avec l'import de propriétés**
   ```bash
   POST /api/integrations/import-properties
   {
     "propertiesToImport": [
       {
         "pmsId": "airbnb_999",
         "name": "Nouvelle propriété",
         "location": "Ville, Pays"
       }
     ],
     "pmsType": "smoobu"
   }
   ```
   - ✅ Doit retourner la même erreur `LIMIT_EXCEEDED`

### ✅ Résultat attendu

- ✅ Les 10 premières propriétés sont ajoutées avec succès
- ✅ La 11ème propriété est bloquée avec erreur `LIMIT_EXCEEDED`
- ✅ L'import de propriétés respecte aussi la limite
- ✅ Le message d'erreur est clair et structuré

---

## 📝 TEST 3 : Fin d'Essai Anticipée et Facturation

### Objectif
Valider que l'utilisateur peut terminer son essai et payer immédiatement.

### Étapes

1. **Utiliser le compte avec 10 propriétés** (en période d'essai)

2. **Appeler l'endpoint de fin d'essai**
   ```bash
   POST /api/subscriptions/end-trial-and-bill
   Headers: Authorization: Bearer <token>
   ```

3. **Vérifier la réponse**
   ```json
   {
     "message": "Essai terminé et facturation effectuée avec succès",
     "subscriptionId": "sub_...",
     "invoiceId": "in_...",
     "status": "active"
   }
   ```

4. **Vérifier dans Stripe Dashboard**
   - Aller sur https://dashboard.stripe.com/test/subscriptions
   - Trouver l'abonnement
   - Vérifier :
     - Statut : `active` (plus `trialing`)
     - `trial_end` : maintenant (essai terminé)
     - Facture générée et prélevée

5. **Vérifier le profil utilisateur**
   - Aller dans Firestore → Collection `users`
   - Vérifier :
     - `subscriptionStatus: "active"`
     - `trialEndedAt` présent

6. **Tenter d'ajouter une propriété**
   ```bash
   POST /api/properties
   {
     "address": "Propriété 11",
     "location": "Ville, Pays"
   }
   ```
   - ✅ Doit maintenant réussir (plus de limite)

### ✅ Résultat attendu

- ✅ Essai terminé immédiatement
- ✅ Facture générée et prélevée
- ✅ Abonnement passe à `active`
- ✅ Plus de limite de 10 propriétés
- ✅ Propriétés peuvent être ajoutées normalement

---

## 📝 TEST 4 : Anti-Abus des Essais Gratuits

### Objectif
Valider que les listing IDs déjà utilisés bloquent l'essai gratuit.

### Étapes

1. **Créer un NOUVEAU compte**
   ```bash
   POST /api/auth/register
   {
     "email": "test2@example.com",
     "password": "password123",
     "name": "Test User 2"
   }
   ```

2. **Importer des propriétés avec les MÊMES listing IDs**
   ```bash
   POST /api/integrations/import-properties
   {
     "propertiesToImport": [
       {
         "pmsId": "airbnb_123",  // MÊME ID que TEST 1
         "name": "Appartement Paris",
         "location": "Paris, France"
       }
     ],
     "pmsType": "smoobu"
   }
   ```

3. **Vérifier l'enregistrement des listing IDs**
   - Aller dans Firestore → Collection `used_listing_ids`
   - Vérifier que "airbnb_123" est enregistré avec le nouveau `userId`

4. **Créer une session Checkout**
   ```bash
   POST /api/checkout/create-session
   Headers: Authorization: Bearer <token>
   ```

5. **Compléter le checkout**
   - Rediriger vers l'URL
   - Compléter le paiement

6. **Vérifier dans Stripe Dashboard**
   - Aller sur l'abonnement créé
   - Vérifier :
     - `trial_period_days: 0` (pas d'essai gratuit)
     - Facturation immédiate

7. **Vérifier le profil utilisateur**
   - Aller dans Firestore → Collection `users`
   - Vérifier :
     - `subscriptionStatus: "active"` (pas `trialing`)

### ✅ Résultat attendu

- ✅ Listing IDs détectés comme déjà utilisés
- ✅ Essai gratuit refusé (`trial_period_days: 0`)
- ✅ Facturation immédiate
- ✅ Abonnement directement `active`

---

## 📝 TEST 5 : Ajout de Propriété en Cours de Mois

### Objectif
Valider la facturation complète du mois lors de l'ajout d'une propriété.

### Étapes

1. **Utiliser un compte actif** (hors période d'essai, abonnement `active`)

2. **Vérifier l'abonnement actuel dans Stripe**
   - Aller sur https://dashboard.stripe.com/test/subscriptions
   - Noter les quantités actuelles (ex: 2 parent, 1 child)

3. **Ajouter une nouvelle propriété** (ex: le 20 du mois)
   ```bash
   POST /api/properties
   {
     "address": "Nouvelle propriété",
     "location": "Ville, Pays",
     "surface": 50,
     "capacity": 4
   }
   ```

4. **Vérifier dans Stripe Dashboard**
   - Aller sur l'abonnement
   - Vérifier :
     - Les quantités sont mises à jour (ex: 3 parent, 1 child)
     - Les changements prennent effet au prochain cycle

5. **Vérifier les Invoice Items**
   - Aller sur https://dashboard.stripe.com/test/invoiceitems
   - Vérifier qu'un invoice item a été créé :
     - Montant : 13.99€ (ou 3.99€ selon le type)
     - Description : "Rattrapage - Ajout de X propriété(s) en cours de mois"
     - Metadata : `reason: "mid_month_property_addition"`

6. **Vérifier la facture**
   - Si le billing threshold est atteint : facture générée immédiatement
   - Sinon : invoice item attendra la prochaine facture mensuelle

### ✅ Résultat attendu

- ✅ Abonnement mis à jour pour le mois suivant
- ✅ Invoice item créé pour le mois en cours
- ✅ Description claire du rattrapage
- ✅ Metadata présente pour traçabilité

---

## 📝 TEST 6 : Géofencing des Groupes

### Objectif
Valider que les propriétés d'un groupe doivent être à moins de 500m.

### Étapes

1. **Créer un groupe**
   ```bash
   POST /api/groups
   {
     "name": "Groupe Test"
   }
   ```

2. **Ajouter une première propriété au groupe**
   ```bash
   PUT /api/groups/:groupId/properties
   {
     "propertyIds": ["propertyId1"]
   }
   ```
   - ✅ Doit réussir (première propriété = référence)

3. **Ajouter une deuxième propriété proche (< 500m)**
   - Créer une propriété avec des coordonnées proches
   - Exemple : Paris (48.8566, 2.3522) et Paris proche (48.8570, 2.3525)
   ```bash
   PUT /api/groups/:groupId/properties
   {
     "propertyIds": ["propertyId1", "propertyId2"]
   }
   ```
   - ✅ Doit réussir (distance < 500m)

4. **Tenter d'ajouter une propriété distante (> 500m)**
   - Créer une propriété avec des coordonnées distantes
   - Exemple : Paris (48.8566, 2.3522) et Lyon (45.7640, 4.8357)
   ```bash
   PUT /api/groups/:groupId/properties
   {
     "propertyIds": ["propertyId1", "propertyId2", "propertyId3"]
   }
   ```

5. **Vérifier la réponse d'erreur**
   ```json
   {
     "error": "GEO_FENCING_VIOLATION",
     "message": "Les propriétés d'un groupe doivent être à moins de 500m les unes des autres.",
     "distance": 392000,
     "maxDistance": 500
   }
   ```

### ✅ Résultat attendu

- ✅ Propriétés proches (< 500m) peuvent être groupées
- ✅ Propriétés distantes (> 500m) sont refusées
- ✅ Erreur `GEO_FENCING_VIOLATION` retournée
- ✅ Distance calculée et retournée dans l'erreur

---

## 📝 TEST 7 : Stripe Customer Portal

### Objectif
Valider que le Customer Portal est accessible et fonctionnel.

### Étapes

1. **Créer une session Portal**
   ```bash
   POST /api/billing/portal-session
   Headers: Authorization: Bearer <token>
   ```

2. **Vérifier la réponse**
   ```json
   {
     "url": "https://billing.stripe.com/p/session/..."
   }
   ```

3. **Accéder au Portal**
   - Rediriger vers l'URL retournée
   - Vérifier que le portal Stripe s'affiche

4. **Tester les fonctionnalités du Portal**
   - ✅ Voir les factures
   - ✅ Télécharger une facture
   - ✅ Mettre à jour la carte bancaire
   - ✅ Voir l'historique des paiements

5. **Vérifier la redirection**
   - Après fermeture du portal, vérifier la redirection vers `/billing`

### ✅ Résultat attendu

- ✅ Session Portal créée avec succès
- ✅ URL de redirection retournée
- ✅ Portal accessible et fonctionnel
- ✅ Redirection après fermeture fonctionnelle

---

## 📝 TEST 8 : Kill-Switch (Échec de Paiement)

### Objectif
Valider que l'accès est coupé et la sync PMS stoppée en cas d'échec de paiement.

### Étapes

1. **Utiliser un compte actif** (hors période d'essai)

2. **Simuler un échec de paiement**
   ```bash
   # Avec Stripe CLI
   stripe listen --forward-to localhost:5000/api/webhooks/stripe
   stripe trigger invoice.payment_failed
   ```

3. **Vérifier le profil utilisateur**
   - Aller dans Firestore → Collection `users`
   - Vérifier :
     - `accessDisabled: true`
     - `pmsSyncEnabled: false`
     - `pmsSyncStoppedReason: "payment_failed"`
     - `pmsSyncStoppedAt` présent
     - `subscriptionStatus: "past_due"`

4. **Vérifier Firebase Auth**
   - Vérifier que l'utilisateur est désactivé (`disabled: true`)

5. **Tenter d'accéder à une route API**
   ```bash
   GET /api/properties
   Headers: Authorization: Bearer <token>
   ```
   - ✅ Doit retourner 403 avec message d'erreur

6. **Tenter de synchroniser des prix**
   ```bash
   POST /api/properties/:id/generate-strategy
   Headers: Authorization: Bearer <token>
   ```
   - ✅ Les prix sont sauvegardés dans Firestore
   - ✅ La synchronisation PMS est ignorée (log : "Synchronisation PMS désactivée")

7. **Vérifier le cron job**
   - Attendre le prochain run du cron job
   - Vérifier les logs : "Synchronisation PMS désactivée pour l'utilisateur X"

### ✅ Résultat attendu

- ✅ Accès coupé (`accessDisabled: true`)
- ✅ Sync PMS stoppée (`pmsSyncEnabled: false`)
- ✅ Utilisateur désactivé dans Firebase Auth
- ✅ Routes API retournent 403
- ✅ Synchronisations PMS ignorées
- ✅ Cron job ignore l'utilisateur

---

## 📝 TEST 9 : Réactivation après Paiement Réussi

### Objectif
Valider que l'accès est réactivé après un paiement réussi.

### Étapes

1. **Utiliser le compte désactivé du TEST 8**

2. **Simuler un paiement réussi**
   ```bash
   # Avec Stripe CLI
   stripe trigger invoice.paid
   ```

3. **Vérifier le profil utilisateur**
   - Aller dans Firestore → Collection `users`
   - Vérifier :
     - `accessDisabled: false`
     - `subscriptionStatus: "active"`
     - `pmsSyncEnabled: true` (si réactivé dans le webhook)

4. **Vérifier Firebase Auth**
   - Vérifier que l'utilisateur est réactivé (`disabled: false`)

5. **Tenter d'accéder à une route API**
   ```bash
   GET /api/properties
   Headers: Authorization: Bearer <token>
   ```
   - ✅ Doit maintenant réussir

6. **Tenter de synchroniser des prix**
   ```bash
   POST /api/properties/:id/generate-strategy
   ```
   - ✅ La synchronisation PMS doit maintenant fonctionner

### ✅ Résultat attendu

- ✅ Accès réactivé
- ✅ Sync PMS réactivée
- ✅ Utilisateur réactivé dans Firebase Auth
- ✅ Routes API accessibles
- ✅ Synchronisations PMS fonctionnelles

---

## 📝 TEST 10 : Billing Threshold (Facturation Immédiate)

### Objectif
Valider que le billing threshold déclenche une facturation immédiate.

### Étapes

1. **Configurer le billing threshold à 50€ dans Stripe Dashboard**

2. **Utiliser un compte actif** (hors période d'essai)

3. **Ajouter plusieurs propriétés rapidement**
   - Ajouter suffisamment de propriétés pour cumuler > 50€ en invoice items
   - Exemple : 4 propriétés parentes = 4 × 13.99€ = 55.96€

4. **Vérifier dans Stripe Dashboard**
   - Aller sur https://dashboard.stripe.com/test/invoices
   - Vérifier qu'une facture a été générée immédiatement
   - Vérifier que le montant correspond au cumul des invoice items

5. **Vérifier le prélèvement**
   - Vérifier que la carte a été prélevée immédiatement
   - Vérifier le statut de la facture : `paid`

### ✅ Résultat attendu

- ✅ Invoice items créés pour chaque ajout
- ✅ Facture générée immédiatement au seuil (50€)
- ✅ Carte prélevée immédiatement
- ✅ Facture marquée comme `paid`

---

## 📝 TEST 11 : Calcul des Buckets Parent/Enfant

### Objectif
Valider que le calcul des quantités Parent/Enfant est correct.

### Scénarios à tester

#### Scénario A : Propriétés indépendantes
- 3 propriétés sans groupe
- **Attendu** : 3 parent, 0 enfant

#### Scénario B : Groupe avec plusieurs propriétés
- 1 groupe avec 4 propriétés
- **Attendu** : 1 parent (1ère), 3 enfants (suivantes)

#### Scénario C : Mix
- 2 propriétés indépendantes
- 1 groupe avec 3 propriétés
- **Attendu** : 3 parent (2 indépendantes + 1ère du groupe), 2 enfants (2 suivantes du groupe)

### Étapes

1. **Créer les propriétés et groupes selon le scénario**

2. **Créer une session Checkout**
   ```bash
   POST /api/checkout/create-session
   ```

3. **Vérifier dans Stripe Dashboard**
   - Aller sur la session Checkout créée
   - Vérifier les line items :
     - Quantité parent = nombre attendu
     - Quantité enfant = nombre attendu

4. **Vérifier les logs**
   - Vérifier les logs du serveur : "Quantités calculées pour X: Principal=Y, Enfant=Z"

### ✅ Résultat attendu

- ✅ Calcul correct pour chaque scénario
- ✅ Quantités correspondantes dans Stripe
- ✅ Logs clairs et précis

---

## 📝 TEST 12 : Webhooks Stripe (Tous les Événements)

### Objectif
Valider que tous les webhooks sont correctement traités.

### Événements à tester

1. **`checkout.session.completed`**
   - ✅ Déjà testé dans TEST 1
   - Vérifier que le profil utilisateur est mis à jour

2. **`invoice.payment_failed`**
   - ✅ Déjà testé dans TEST 8
   - Vérifier que l'accès est coupé

3. **`invoice.paid`**
   - ✅ Déjà testé dans TEST 9
   - Vérifier que l'accès est réactivé

4. **`customer.subscription.updated`**
   ```bash
   stripe trigger customer.subscription.updated
   ```
   - Vérifier que le statut est mis à jour dans Firestore

5. **`customer.subscription.deleted`**
   ```bash
   stripe trigger customer.subscription.deleted
   ```
   - Vérifier que l'accès est coupé définitivement

### ✅ Résultat attendu

- ✅ Tous les événements sont reçus et traités
- ✅ Logs clairs pour chaque événement
- ✅ Profil utilisateur mis à jour correctement

---

## 📊 Checklist de Validation Globale

### Configuration
- [ ] Variables d'environnement configurées
- [ ] Webhook configuré dans Stripe Dashboard
- [ ] Billing thresholds configurés
- [ ] IDs produits/prix vérifiés

### Fonctionnalités Core
- [ ] Onboarding avec Stripe Checkout fonctionnel
- [ ] Essai gratuit de 30 jours fonctionnel
- [ ] Limite de 10 propriétés respectée
- [ ] Fin d'essai anticipée fonctionnelle
- [ ] Anti-abus des listing IDs fonctionnel

### Facturation
- [ ] Calcul Parent/Enfant correct
- [ ] Ajout en cours de mois (invoice items) fonctionnel
- [ ] Billing threshold fonctionnel
- [ ] Customer Portal accessible

### Sécurité
- [ ] Géofencing fonctionnel (500m)
- [ ] Kill-switch fonctionnel (échec paiement)
- [ ] Sync PMS stoppée en cas d'impayé
- [ ] Accès bloqué correctement

### Webhooks
- [ ] `checkout.session.completed` traité
- [ ] `invoice.payment_failed` traité
- [ ] `invoice.paid` traité
- [ ] `customer.subscription.updated` traité
- [ ] `customer.subscription.deleted` traité

---

## 🐛 Dépannage

### Problème : Webhook non reçu

**Solutions :**
1. Vérifier que `STRIPE_WEBHOOK_SECRET` est correct
2. Vérifier que l'URL du webhook est correcte dans Stripe Dashboard
3. Utiliser Stripe CLI pour tester en local : `stripe listen --forward-to localhost:5000/api/webhooks/stripe`

### Problème : Essai gratuit toujours accordé malgré abus

**Solutions :**
1. Vérifier que les listing IDs sont bien enregistrés dans `used_listing_ids`
2. Vérifier que la fonction `checkListingIdsAbuse()` est appelée
3. Vérifier les logs : "Anti-abus détecté"

### Problème : Invoice items non créés

**Solutions :**
1. Vérifier que l'utilisateur n'est pas en période d'essai
2. Vérifier que les quantités ont augmenté
3. Vérifier les logs : "Invoice item créé"

### Problème : Sync PMS non stoppée

**Solutions :**
1. Vérifier que `pmsSyncEnabled: false` dans le profil utilisateur
2. Vérifier que la fonction `isPMSSyncEnabled()` est appelée
3. Vérifier les logs : "Synchronisation PMS désactivée"

---

## 📝 Notes Finales

- **Temps estimé pour tous les tests** : 2-3 heures
- **Environnement recommandé** : Environnement de test/staging
- **Données de test** : Utiliser des données fictives (emails, noms, etc.)
- **Nettoyage** : Supprimer les données de test après validation

---

**Date de création :** 2025-01-XX  
**Statut :** ✅ Phase 12 - Tests complets documentés


