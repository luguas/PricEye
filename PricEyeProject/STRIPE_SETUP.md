# Configuration du Système de Paiement Stripe

Ce document explique comment configurer le système de facturation Stripe pour PricEye.

## Variables d'environnement requises

Ajoutez les variables suivantes dans votre fichier `.env` :

```env
STRIPE_SECRET_KEY=sk_test_... # Votre clé secrète Stripe (test ou production)
STRIPE_PRODUCT_PRINCIPAL_ID=prod_... # ID du produit principal (prix dégressif)
STRIPE_PRODUCT_CHILD_ID=prod_... # ID du produit enfant (3.99€ fixe)
STRIPE_PRICE_PRINCIPAL_ID=price_... # ID du prix principal
STRIPE_PRICE_CHILD_ID=price_... # ID du prix enfant (3.99€)
STRIPE_WEBHOOK_SECRET=whsec_... # Secret du webhook Stripe (pour la sécurité)
```

## Logique de facturation

### Algorithme de calcul

La fonction `calculateBillingQuantities` calcule les quantités de facturation selon les règles suivantes :

**Propriétés PARENTES (quantityPrincipal)** :
- Première propriété de chaque groupe
- Toutes les propriétés sans groupe

**Propriétés FILLES (quantityChild)** :
- Les autres propriétés (suivantes dans un groupe)

### Exemple

Si un utilisateur a :
- **Groupe A** avec 3 propriétés : 
  - 1ère propriété = PARENTE (prix principal)
  - 2ème et 3ème propriétés = FILLES (prix enfant 3.99€)
- **2 propriétés indépendantes** : 
  - Toutes les 2 = PARENTES (prix principal)

**Résultat** :
- `quantityPrincipal` = 3 (1 du groupe + 2 indépendantes)
- `quantityChild` = 2 (2 filles du groupe)

**Total facturation** : 3 × prix principal + 2 × prix enfant (3.99€)

## Configuration Stripe

### 1. Créer les produits dans Stripe

1. Allez dans votre dashboard Stripe
2. Créez deux produits :
   - **Produit Principal** : Prix dégressif (ex: 9.99€ pour la première propriété)
   - **Produit Enfant** : Prix fixe à 3.99€

### 2. Créer les prix récurrents

Pour chaque produit, créez un prix récurrent (subscription) avec :
- **Billing period** : Monthly ou Yearly selon vos besoins
- **Price** : Configurez selon votre modèle tarifaire

### 3. Récupérer les IDs

- **Product IDs** : Disponibles dans l'URL ou les détails du produit (format: `prod_...`)
- **Price IDs** : Disponibles dans la section "Pricing" du produit (format: `price_...`)

## Stockage des informations utilisateur

Le profil utilisateur dans Firestore doit contenir :
- `stripeSubscriptionId` : ID de l'abonnement Stripe actif
- `stripeCustomerId` : ID du client Stripe (optionnel, peut être récupéré depuis l'abonnement)

## Endpoints Stripe

### Création d'abonnement

**POST /api/subscriptions/create**

Crée un nouvel abonnement Stripe pour un utilisateur.

**Requêtes** :
- Headers : `Authorization: Bearer <token>`
- Body :
```json
{
  "paymentMethodId": "pm_...",  // ID de la méthode de paiement Stripe
  "trialPeriodDays": 30         // Optionnel, défaut: 30 jours
}
```

**Réponse** :
```json
{
  "message": "Abonnement créé avec succès",
  "subscriptionId": "sub_...",
  "customerId": "cus_...",
  "status": "trialing",
  "trialEnd": "2024-02-15T00:00:00.000Z"
}
```

**Fonctionnalités** :
- Calcule automatiquement les quantités basées sur les propriétés et groupes existants
- Crée ou récupère le customer Stripe
- Configure une période d'essai gratuit de 30 jours
- Si aucune propriété n'existe, démarre avec 1 propriété principale
- Vérifie qu'il n'y a pas déjà un abonnement actif

## Endpoints qui déclenchent la mise à jour de facturation

La facturation est automatiquement recalculée et mise à jour dans Stripe lors des actions suivantes :

1. **POST /api/properties** - Création d'une propriété
2. **DELETE /api/properties/:id** - Suppression d'une propriété
3. **POST /api/groups** - Création d'un groupe
4. **PUT /api/groups/:id/properties** - Ajout de propriétés à un groupe
5. **DELETE /api/groups/:id/properties** - Retrait de propriétés d'un groupe
6. **DELETE /api/groups/:id** - Suppression d'un groupe
7. **POST /api/integrations/import-properties** - Import de propriétés depuis un PMS

## Installation

1. Installer la dépendance Stripe :
```bash
npm install stripe
```

2. Configurer les variables d'environnement (voir ci-dessus)

3. Redémarrer le serveur

## Gestion des erreurs

- Si l'abonnement Stripe n'existe pas, la facturation est ignorée silencieusement
- Les erreurs de mise à jour Stripe sont loggées mais n'interrompent pas les opérations principales
- Vérifiez les logs du serveur pour les erreurs de facturation

## Exemple de flux d'inscription

1. **L'utilisateur s'inscrit** (POST /api/auth/register)
2. **L'utilisateur entre sa carte bancaire** via Stripe Elements (frontend)
3. **Le frontend obtient un paymentMethodId** depuis Stripe
4. **Appel à l'API pour créer l'abonnement** :
   ```javascript
   POST /api/subscriptions/create
   Headers: { Authorization: "Bearer <token>" }
   Body: {
     paymentMethodId: "pm_1234...",
     trialPeriodDays: 30
   }
   ```
5. **L'abonnement est créé** avec :
   - Quantités calculées automatiquement
   - Période d'essai de 30 jours
   - Customer Stripe créé automatiquement
   - IDs sauvegardés dans Firestore

## Mise à jour de l'abonnement (ajout de propriété)

Lorsqu'un utilisateur ajoute une propriété après l'inscription, l'abonnement Stripe est automatiquement mis à jour via `stripe.subscriptions.update`.

**Paramètres cruciaux** :
- `items`: Les quantités sont mises à jour avec les nouveaux chiffres calculés
- `proration_behavior: 'none'` : **Important** - Ce paramètre désactive le prorata et offre la gratuité jusqu'au prochain cycle

**Comportement** :
- Les changements de quantité sont enregistrés immédiatement
- Les nouvelles propriétés sont gratuites jusqu'au prochain cycle de facturation
- Au prochain cycle, la facturation reflétera les nouvelles quantités

## Webhook Stripe (Sécurité)

### Configuration

Pour activer le webhook, ajoutez la variable d'environnement `STRIPE_WEBHOOK_SECRET` (voir section Variables d'environnement).

### Endpoint webhook

**POST /api/webhooks/stripe**

Cet endpoint écoute les événements Stripe et gère automatiquement :

1. **`invoice.payment_failed`** :
   - Vérifie si la période d'essai est terminée
   - Si oui, coupe l'accès à Priceye en désactivant l'utilisateur
   - Met à jour le statut dans Firestore (`accessDisabled: true`)
   - Désactive l'utilisateur dans Firebase Auth

2. **`invoice.paid`** :
   - Réactive l'accès si le paiement réussit
   - Met à jour le statut dans Firestore
   - Réactive l'utilisateur dans Firebase Auth

3. **`customer.subscription.updated`** :
   - Met à jour le statut de l'abonnement dans Firestore

4. **`customer.subscription.deleted`** :
   - Coupe l'accès définitivement
   - Désactive l'utilisateur

### Configuration dans Stripe Dashboard

1. Allez dans **Developers > Webhooks**
2. Cliquez sur **Add endpoint**
3. URL : `https://votre-domaine.com/api/webhooks/stripe`
4. Sélectionnez les événements :
   - `invoice.payment_failed`
   - `invoice.paid`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
5. Copiez le **Signing secret** (commence par `whsec_`) et ajoutez-le à vos variables d'environnement

### Sécurité

- La signature du webhook est vérifiée pour s'assurer que la requête vient bien de Stripe
- Seuls les événements authentifiés sont traités
- L'accès est vérifié dans le middleware `authenticateToken` pour toutes les autres routes

### Comportement

- **Pendant la période d'essai** : Si le paiement échoue, l'accès n'est pas coupé (seul le flag `paymentFailed` est mis à jour)
- **Après la période d'essai** : Si le paiement échoue, l'utilisateur est désactivé dans Firebase Auth et ne peut plus accéder à l'application
- **Paiement réussi** : L'accès est réactivé automatiquement

### Protection des routes

Le middleware `authenticateToken` vérifie maintenant :
- Si l'utilisateur est désactivé dans Firebase Auth
- Si l'accès est désactivé dans Firestore (`accessDisabled: true`)

Si l'une de ces conditions est vraie, l'utilisateur reçoit une erreur 403 avec un message explicatif.

## Notes importantes

- **Pas de proration** : `proration_behavior: 'none'` - Les changements prennent effet au prochain cycle (gratuité jusqu'à la prochaine facturation)
- Les quantités sont mises à jour en temps réel lors de chaque modification
- Si un item d'abonnement n'existe pas encore, il sera créé automatiquement
- Si une quantité tombe à 0, l'item correspondant sera supprimé de l'abonnement
- La période d'essai de 30 jours est configurée lors de la création de l'abonnement
- Si l'utilisateur n'a pas encore de propriétés, l'abonnement démarre avec 1 propriété principale
- **Sécurité webhook** : La signature est vérifiée pour chaque événement reçu
- **Coupure d'accès** : Automatique en cas d'échec de paiement après la période d'essai

