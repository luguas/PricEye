# Plan d'Implémentation - Système d'Essai Gratuit Stripe avec Limite de 10 Propriétés

## Vue d'ensemble

Ce document décrit toutes les étapes pour implémenter un système de période d'essai de 30 jours avec limite de 10 propriétés gratuites, puis bascule vers facturation payante.

---

## ÉTAPE 1 : Configuration des Variables d'Environnement

### Backend (PricEyeProject)

Ajouter dans le fichier `.env` ou les variables d'environnement du serveur :

```env
STRIPE_SECRET_KEY=sk_test_51SXqLnG8ypIuy6LADuLGhncm5V0raUDVWOBLt7pnftPE2cbKxaE6fFvFdf539GUvIPKql5b0WPNjNDtC5GCMe2Sm006axjPD05
STRIPE_PUBLIC_KEY=pk_test_51SXqLnG8ypIuy6LARlB49xAiphTudIodq9BFRda7lbrYCMUF5uIB7KBAgLBvrmg8gb30f2Cb5el7JsknEGSh6g5s00hEhg8wLd
STRIPE_PRODUCT_PRINCIPAL_ID=prod_TUq3ZQwDAhpeIE
STRIPE_PRODUCT_CHILD_ID=prod_TUq4pDV3LDv4ec
STRIPE_PRICE_PRINCIPAL_ID=price_1SXqNeG8ypIuy6LAL1GVrUW2
STRIPE_PRICE_CHILD_ID=price_1SXqNuG8ypIuy6LALQjrv9JF
STRIPE_WEBHOOK_SECRET=<À configurer depuis le dashboard Stripe>
```

### Frontend (PricEye-frontend)

Créer un fichier `.env` ou ajouter dans les variables d'environnement :

```env
VITE_STRIPE_PUBLIC_KEY=pk_test_51SXqLnG8ypIuy6LARlB49xAiphTudIodq9BFRda7lbrYCMUF5uIB7KBAgLBvrmg8gb30f2Cb5el7JsknEGSh6g5s00hEhg8wLd
```

---

## ÉTAPE 2 : Modifier la Page d'Inscription pour Intégrer Stripe

### 2.1 Installer Stripe.js côté frontend

```bash
cd PricEye-frontend
npm install @stripe/stripe-js
```

### 2.2 Créer un composant de formulaire de paiement

**Fichier : `PricEye-frontend/src/components/StripePaymentForm.jsx`**

Ce composant permettra à l'utilisateur d'ajouter sa carte bancaire lors de l'inscription.

### 2.3 Modifier RegisterPage.jsx

Intégrer le formulaire Stripe dans la page d'inscription pour collecter la carte bancaire.

---

## ÉTAPE 3 : Créer l'Endpoint Backend pour la Création d'Abonnement avec Essai

### 3.1 Créer une route POST `/api/subscriptions/create`

Cette route :
- Crée un customer Stripe
- Crée un abonnement avec période d'essai de 30 jours
- Initialise les quantités à 0 (car aucune propriété au départ)
- Enregistre les IDs Stripe dans Firestore

### 3.2 Modifier la fonction `createSubscription` dans `stripeManager.js`

S'assurer qu'elle supporte :
- La création avec période d'essai
- Des quantités initiales à 0

---

## ÉTAPE 4 : Modifier la Logique d'Ajout de Propriétés

### 4.1 Créer une fonction de vérification de limite

**Fichier : `PricEyeProject/server.js`**

Créer une fonction `checkPropertyLimit(userId, newPropertyCount, db)` qui :
- Récupère le nombre total de propriétés actuelles
- Vérifie si le total (actuelles + nouvelles) dépasse 10
- Vérifie si l'utilisateur est encore en période d'essai
- Retourne un objet avec `{ allowed: boolean, reason?: string, isTrial: boolean }`

### 4.2 Modifier la route POST `/api/properties`

Avant d'ajouter la propriété :
1. Appeler `checkPropertyLimit`
2. Si `allowed === false` ET `isTrial === true` :
   - Retourner une erreur spéciale avec code `PROPERTY_LIMIT_EXCEEDED`
   - Ne pas ajouter la propriété
3. Si `allowed === true` :
   - Ajouter la propriété normalement
   - Mettre à jour Stripe (même en essai, on met à jour les quantités)

### 4.3 Modifier la route POST `/api/integrations/import-properties`

Même logique que pour l'ajout manuel :
1. Calculer le nombre total après import
2. Vérifier la limite
3. Bloquer si nécessaire

---

## ÉTAPE 5 : Créer le Composant Frontend de Blocage avec Pop-up

### 5.1 Créer un composant `TrialLimitModal.jsx`

Ce composant affiche :
- Un message : "Vous dépassez la limite gratuite. Pour continuer, vous devez activer la facturation maintenant."
- Un bouton "Confirmer et Payer"
- Un bouton "Annuler"

### 5.2 Modifier les composants qui ajoutent des propriétés

**Fichier : `PricEye-frontend/src/components/PropertyModal.jsx`**
**Fichier : `PricEye-frontend/src/components/PropertySyncModal.jsx`**

Intercepter l'erreur `PROPERTY_LIMIT_EXCEEDED` et afficher le modal.

---

## ÉTAPE 6 : Créer l'Endpoint de Bascule vers Facturation Payante

### 6.1 Créer une route POST `/api/subscriptions/activate-billing`

Cette route :
1. Récupère l'abonnement Stripe actuel
2. Calcule les nouvelles quantités (avec la propriété qui dépasse la limite)
3. Met à jour l'abonnement avec :
   - Les nouvelles quantités
   - `trial_end: 'now'` (arrête l'essai immédiatement)
   - `billing_cycle_anchor: 'now'` (facture immédiatement)
4. Génère une facture immédiate
5. Met à jour Firestore avec le nouveau statut

### 6.2 Modifier `stripeManager.js`

Ajouter une fonction `activateBillingAndUpdateQuantities(subscriptionId, quantities)` qui :
- Met à jour l'abonnement
- Arrête l'essai
- Force la facturation immédiate

---

## ÉTAPE 7 : Gérer les États dans Firestore

### 7.1 Ajouter des champs dans le document utilisateur

Lors de la création de l'abonnement, ajouter :
```javascript
{
  stripeCustomerId: "...",
  stripeSubscriptionId: "...",
  subscriptionStatus: "trialing", // ou "active" après bascule
  isTrialActive: true,
  trialEndDate: <timestamp>,
  propertyLimit: 10
}
```

### 7.2 Mettre à jour lors de la bascule

Lorsque l'utilisateur active la facturation :
```javascript
{
  subscriptionStatus: "active",
  isTrialActive: false,
  trialEndDate: null
}
```

---

## ÉTAPE 8 : Gérer les Webhooks Stripe

### 8.1 Ajouter le handler pour `customer.subscription.trial_will_end`

Informer l'utilisateur que son essai se termine bientôt.

### 8.2 Modifier le handler `customer.subscription.updated`

Détecter quand l'essai se termine automatiquement et mettre à jour Firestore.

---

## ÉTAPE 9 : Créer des Fonctions Utilitaires

### 9.1 Fonction pour vérifier le statut d'essai

```javascript
async function isUserInTrial(userId, db) {
  const userDoc = await db.collection('users').doc(userId).get();
  const userData = userDoc.data();
  
  if (!userData.stripeSubscriptionId) return false;
  
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const subscription = await stripe.subscriptions.retrieve(userData.stripeSubscriptionId);
  
  return subscription.status === 'trialing';
}
```

### 9.2 Fonction pour compter les propriétés

```javascript
async function getTotalPropertyCount(userId, db) {
  const userDoc = await db.collection('users').doc(userId).get();
  const teamId = userDoc.data().teamId || userId;
  
  const propertiesSnapshot = await db.collection('properties')
    .where('teamId', '==', teamId)
    .get();
  
  return propertiesSnapshot.size;
}
```

---

## ÉTAPE 10 : Tests et Validation

### 10.1 Scénarios de test

1. **Inscription avec carte** : Vérifier que l'abonnement est créé avec essai de 30 jours
2. **Ajout de 10 propriétés** : Vérifier que tout fonctionne normalement
3. **Ajout de la 11ème propriété** : Vérifier que le blocage fonctionne
4. **Activation de la facturation** : Vérifier que l'essai s'arrête et que la facture est générée
5. **Après activation** : Vérifier que l'ajout de propriétés fonctionne sans limite

### 10.2 Tests Stripe en mode test

Utiliser les cartes de test Stripe :
- `4242 4242 4242 4242` (succès)
- `4000 0000 0000 0002` (refus)

---

## ORDRE D'IMPLÉMENTATION RECOMMANDÉ

1. ✅ **Étape 1** : Configuration des variables d'environnement
2. ✅ **Étape 3** : Créer l'endpoint de création d'abonnement (backend d'abord)
3. ✅ **Étape 2** : Intégrer Stripe dans la page d'inscription (frontend)
4. ✅ **Étape 4** : Modifier la logique d'ajout de propriétés (backend)
5. ✅ **Étape 5** : Créer le composant de blocage (frontend)
6. ✅ **Étape 6** : Créer l'endpoint de bascule (backend)
7. ✅ **Étape 7** : Gérer les états Firestore
8. ✅ **Étape 8** : Gérer les webhooks
9. ✅ **Étape 9** : Créer les fonctions utilitaires
10. ✅ **Étape 10** : Tests complets

---

## NOTES IMPORTANTES

1. **Sécurité** : Ne jamais exposer la clé secrète Stripe côté frontend
2. **Webhooks** : Configurer le webhook secret dans Stripe Dashboard
3. **Gestion d'erreurs** : Gérer tous les cas d'erreur Stripe (carte refusée, etc.)
4. **UX** : Informer clairement l'utilisateur de son statut (essai actif, jours restants, etc.)
5. **Limite de 10** : Cette limite doit être vérifiée à chaque ajout/import, pas seulement au moment de l'inscription

---

## PROCHAINES ÉTAPES

Une fois ce plan validé, je peux commencer l'implémentation étape par étape. Souhaitez-vous que je commence par une étape spécifique ?






