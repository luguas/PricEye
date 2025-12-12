# 📋 Plan de Route : Implémentation Billing & Stripe (Priceye)

## 🎯 Vue d'ensemble

Ce document détaille le plan d'implémentation complet pour intégrer Stripe Checkout avec la logique de facturation Parent/Enfant, essai gratuit, et toutes les mesures de sécurité.

---

## 📦 PHASE 1 : Configuration & Infrastructure

### 1.1 Configuration des Variables d'Environnement

**Fichier : `.env`**

```env
# Clés Stripe (Test)
STRIPE_SECRET_KEY=sk_test_51SXqLnG8ypIuy6LADuLGhncm5V0raUDVWOBLt7pnftPE2cbKxaE6fFvFdf539GUvIPKql5b0WPNjNDtC5GCMe2Sm006axjPD05
STRIPE_PUBLISHABLE_KEY=pk_test_51SXqLnG8ypIuy6LARlB49xAiphTudIodq9BFRda7lbrYCMUF5uIB7KBAgLBvrmg8gb30f2Cb5el7JsknEGSh6g5s00hEhg8wLd
STRIPE_WEBHOOK_SECRET=whsec_... # À récupérer depuis Stripe Dashboard

# Produits & Prix Stripe
STRIPE_PRODUCT_PARENT_ID=prod_TUq3ZQwDAhpeIE
STRIPE_PRICE_PARENT_ID=price_1SXqNeG8ypIuy6LAL1GVrUW2
STRIPE_PRODUCT_CHILD_ID=prod_TUq4pDV3LDv4ec
STRIPE_PRICE_CHILD_ID=price_1SXqNuG8ypIuy6LALQjrv9JF

# URLs (MVP - tout sur le même domaine)
FRONTEND_URL=https://pric-eye.vercel.app
BACKEND_URL=https://priceye.onrender.com
```

**Actions :**
- [ ] Ajouter toutes les variables dans `.env`
- [ ] Configurer le webhook secret depuis Stripe Dashboard
- [ ] Vérifier que les IDs produits/prix sont corrects

---

## 🚀 PHASE 2 : Onboarding & Stripe Checkout

### 2.1 Endpoint de Création de Session Checkout

**Fichier : `server.js`**

**Route : `POST /api/checkout/create-session`**

**Logique à implémenter :**

1. **Récupérer les propriétés de l'utilisateur**
   - Lire toutes les propriétés depuis Firestore
   - Lire tous les groupes depuis Firestore

2. **Calculer les buckets Parent/Enfant**
   - Utiliser la fonction existante `calculateBillingQuantities()`
   - Bucket A (Parent) : Propriétés seules + 1ère propriété de chaque groupe
   - Bucket B (Enfant) : Autres propriétés des groupes

3. **Vérifier l'anti-abus des essais gratuits**
   - Récupérer les `listingIds` (Airbnb/PMS) des propriétés importées
   - Vérifier dans une collection `used_listing_ids` si ces IDs ont déjà été utilisés
   - Si oui : `trial_period_days: 0` (pas d'essai gratuit)
   - Si non : `trial_period_days: 30` (essai gratuit)

4. **Créer ou récupérer le Customer Stripe**
   - Utiliser `stripeManager.getOrCreateStripeCustomer()`
   - Stocker `stripeCustomerId` dans le profil utilisateur

5. **Créer la session Checkout**
   ```javascript
   const session = await stripe.checkout.sessions.create({
     mode: 'subscription',
     customer: customerId,
     customer_email: user.email,
     line_items: [
       { price: STRIPE_PRICE_PARENT_ID, quantity: bucketA },
       { price: STRIPE_PRICE_CHILD_ID, quantity: bucketB }
     ],
     subscription_data: {
       trial_period_days: trialDays, // 30 ou 0 selon anti-abus
       metadata: { userId: userId }
     },
     success_url: `${FRONTEND_URL}/dashboard?success=true&session_id={CHECKOUT_SESSION_ID}`,
     cancel_url: `${FRONTEND_URL}/billing?canceled=true`
   });
   ```

6. **Retourner l'URL de la session**
   ```json
   { "url": session.url }
   ```

**Actions :**
- [ ] Créer la route `/api/checkout/create-session`
- [ ] Implémenter la logique de calcul des buckets
- [ ] Implémenter la vérification anti-abus des listing IDs
- [ ] Tester la création de session Checkout

---

### 2.2 Webhook `checkout.session.completed`

**Fichier : `server.js` (section webhook existante)**

**Événement : `checkout.session.completed`**

**Logique à implémenter :**

1. **Récupérer les données de la session**
   ```javascript
   const session = event.data.object;
   const customerId = session.customer;
   const subscriptionId = session.subscription;
   const userId = session.metadata?.userId || customer.metadata?.userId;
   ```

2. **Mettre à jour le profil utilisateur dans Firestore**
   ```javascript
   await db.collection('users').doc(userId).update({
     stripeCustomerId: customerId,
     stripeSubscriptionId: subscriptionId,
     subscriptionStatus: 'trialing', // ou 'active' si pas d'essai
     subscriptionCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
     accessDisabled: false
   });
   ```

3. **Enregistrer les listing IDs utilisés (anti-abus)**
   - Récupérer les propriétés de l'utilisateur
   - Extraire tous les `listingIds` (Airbnb/PMS)
   - Les ajouter dans la collection `used_listing_ids` avec `userId` et `timestamp`

4. **Activer la synchronisation PMS**
   - Mettre un flag `pmsSyncEnabled: true` dans le profil utilisateur

**Actions :**
- [ ] Ajouter le case `checkout.session.completed` dans le webhook
- [ ] Implémenter la mise à jour du profil utilisateur
- [ ] Implémenter l'enregistrement des listing IDs
- [ ] Tester avec Stripe CLI

---

## 🛡️ PHASE 3 : Sécurité & Limites

### 3.1 Limite de 10 Propriétés pendant l'Essai Gratuit

**Fichier : `server.js`**

**À implémenter dans :**
- Route `POST /api/properties` (ajout manuel)
- Route `POST /api/integrations/import-properties` (import PMS)

**Logique à ajouter AVANT l'ajout de la propriété :**

```javascript
// 1. Vérifier le statut de l'abonnement
const userProfile = await db.collection('users').doc(userId).get().data();
const subscriptionId = userProfile.stripeSubscriptionId;

if (subscriptionId) {
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  
  // 2. Vérifier si en période d'essai
  const isTrialActive = subscription.status === 'trialing' && 
                        subscription.trial_end && 
                        subscription.trial_end * 1000 > Date.now();
  
  if (isTrialActive) {
    // 3. Compter le nombre total de propriétés (actuelles + nouvelle)
    const currentProperties = await db.collection('properties')
      .where('teamId', '==', teamId).get();
    const totalProperties = currentProperties.size + 1; // +1 pour la nouvelle
    
    // 4. Si > 10, bloquer et retourner une erreur
    if (totalProperties > 10) {
      return res.status(403).json({
        error: 'LIMIT_EXCEEDED',
        message: 'Vous dépassez la limite gratuite de 10 propriétés.',
        currentCount: currentProperties.size,
        maxAllowed: 10,
        requiresPayment: true
      });
    }
  }
}

// 5. Si OK, continuer avec l'ajout normal de la propriété
```

**Actions :**
- [ ] Ajouter la vérification dans `POST /api/properties`
- [ ] Ajouter la vérification dans `POST /api/integrations/import-properties`
- [ ] Créer une réponse d'erreur structurée pour le frontend
- [ ] Tester avec différents scénarios

---

### 3.2 Popup Frontend & Fin d'Essai Anticipée

**Fichier Frontend : À créer/modifier**

**Composant : `PaymentRequiredModal.jsx`**

**Logique Frontend :**
1. Détecter l'erreur `LIMIT_EXCEEDED` lors de l'ajout de propriété
2. Afficher une modale avec message : "Vous dépassez la limite gratuite. Pour continuer, vous devez activer la facturation maintenant."
3. Bouton "Confirmer et Payer" qui appelle l'endpoint backend

**Fichier Backend : `server.js`**

**Route : `POST /api/subscriptions/end-trial-and-bill`**

**Logique :**

```javascript
// 1. Récupérer l'abonnement actuel
const subscription = await stripe.subscriptions.retrieve(subscriptionId);

// 2. Recalculer les quantités avec la nouvelle propriété
const quantities = calculateBillingQuantities(allProperties, allGroups);

// 3. Mettre à jour l'abonnement (quantité + fin d'essai)
await stripe.subscriptions.update(subscriptionId, {
  items: [
    { id: principalItem.id, quantity: quantities.quantityPrincipal },
    { id: childItem.id, quantity: quantities.quantityChild }
  ],
  trial_end: 'now', // Terminer l'essai immédiatement
  proration_behavior: 'always_invoice' // Facturer immédiatement
});

// 4. Forcer la génération de la facture
await stripe.invoices.create({
  customer: customerId,
  subscription: subscriptionId,
  auto_advance: true // Générer et envoyer immédiatement
});
```

**Actions :**
- [ ] Créer le composant `PaymentRequiredModal.jsx`
- [ ] Créer la route `/api/subscriptions/end-trial-and-bill`
- [ ] Implémenter la logique de fin d'essai + facturation
- [ ] Tester le flux complet

---

### 3.3 Géofencing pour Anti-Fraude des Groupes

**Fichier : `server.js`**

**Route : `POST /api/groups` (création de groupe)**
**Route : `POST /api/groups/:id/properties` (ajout de propriétés à un groupe)**

**Logique à ajouter :**

```javascript
// Fonction helper pour calculer la distance (formule Haversine)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Rayon de la Terre en mètres
  const φ1 = lat1 * Math.PI/180;
  const φ2 = lat2 * Math.PI/180;
  const Δφ = (lat2-lat1) * Math.PI/180;
  const Δλ = (lon2-lon1) * Math.PI/180;
  
  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  
  return R * c; // Distance en mètres
}

// Vérification lors de l'ajout de propriétés à un groupe
const groupProperties = group.properties || [];
if (groupProperties.length > 0) {
  // Récupérer la première propriété du groupe (référence)
  const firstProperty = await db.collection('properties').doc(groupProperties[0]).get();
  const firstPropData = firstProperty.data();
  
  // Récupérer la nouvelle propriété à ajouter
  const newProperty = await db.collection('properties').doc(newPropertyId).get();
  const newPropData = newProperty.data();
  
  // Vérifier la distance
  const distance = calculateDistance(
    firstPropData.location.latitude,
    firstPropData.location.longitude,
    newPropData.location.latitude,
    newPropData.location.longitude
  );
  
  if (distance > 500) { // 500 mètres
    return res.status(403).json({
      error: 'GEO_FENCING_VIOLATION',
      message: 'Les propriétés d\'un groupe doivent être à moins de 500m les unes des autres.',
      distance: Math.round(distance)
    });
  }
}
```

**Actions :**
- [ ] Créer la fonction `calculateDistance()`
- [ ] Ajouter la vérification dans la création de groupe
- [ ] Ajouter la vérification dans l'ajout de propriétés à un groupe
- [ ] Tester avec des propriétés distantes

---

### 3.4 Anti-Abus des Essais Gratuits (Listing IDs)

**Fichier : `server.js`**

**Collection Firestore : `used_listing_ids`**

**Structure :**
```javascript
{
  listingId: "airbnb_12345",
  userId: "user_abc",
  usedAt: Timestamp,
  propertyId: "prop_xyz"
}
```

**Fonction helper :**

```javascript
async function checkListingIdsAbuse(listingIds, db) {
  if (!listingIds || listingIds.length === 0) return false;
  
  // Vérifier si un des listing IDs a déjà été utilisé
  for (const listingId of listingIds) {
    const existing = await db.collection('used_listing_ids')
      .where('listingId', '==', listingId)
      .limit(1)
      .get();
    
    if (!existing.empty) {
      return true; // Abus détecté
    }
  }
  
  return false; // Pas d'abus
}
```

**Utilisation :**
- Dans `/api/checkout/create-session` : vérifier avant de définir `trial_period_days`
- Dans le webhook `checkout.session.completed` : enregistrer les listing IDs

**Actions :**
- [ ] Créer la fonction `checkListingIdsAbuse()`
- [ ] Intégrer dans la création de session Checkout
- [ ] Intégrer dans le webhook pour enregistrer les IDs
- [ ] Tester avec des IDs dupliqués

---

## 💰 PHASE 4 : Gestion de la Facturation

### 4.1 Ajout de Propriété en Cours de Mois (Facturation Complète)

**Fichier : `server.js`**

**Fonction : `recalculateAndUpdateBilling()` (existe déjà, à modifier)**

**Logique à modifier :**

```javascript
async function recalculateAndUpdateBilling(userId, db) {
  // ... code existant pour calculer les quantités ...
  
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const isTrialActive = subscription.status === 'trialing' && 
                        subscription.trial_end && 
                        subscription.trial_end * 1000 > Date.now();
  
  if (!isTrialActive) {
    // ACTION 1 : Mettre à jour l'abonnement pour le MOIS SUIVANT
    await stripe.subscriptions.update(subscriptionId, {
      items: itemsToUpdate,
      proration_behavior: 'none' // Pas de proration pour le cycle actuel
    });
    
    // ACTION 2 : Facturer le MOIS EN COURS (rattrapage)
    // Calculer le prix plein de la nouvelle propriété
    const newPropertyPrice = quantities.quantityPrincipal > oldQuantities.quantityPrincipal 
      ? 1399 // 13.99€ en centimes (prix parent)
      : 399; // 3.99€ en centimes (prix enfant)
    
    // Créer une ligne de facture pendante
    await stripe.invoiceItems.create({
      customer: customerId,
      amount: newPropertyPrice,
      currency: 'eur',
      description: `Rattrapage - Ajout de propriété en cours de mois`,
      metadata: {
        userId: userId,
        reason: 'mid_month_property_addition'
      }
    });
    
    // Note : Cette ligne s'ajoutera à la prochaine facture
    // SAUF si le billing threshold est atteint (déclenchement immédiat)
  } else {
    // En période d'essai, juste mettre à jour les quantités (pas de facturation)
    await stripe.subscriptions.update(subscriptionId, {
      items: itemsToUpdate,
      proration_behavior: 'none'
    });
  }
}
```

**Actions :**
- [ ] Modifier `recalculateAndUpdateBilling()` pour gérer le rattrapage
- [ ] Implémenter la création d'invoice items
- [ ] Tester l'ajout de propriété en cours de mois
- [ ] Vérifier que la facturation se déclenche correctement

---

### 4.2 Configuration des Billing Thresholds

**Stripe Dashboard :**
1. Aller dans **Settings > Billing > Customer billing**
2. Activer **"Automatically collect payment"**
3. Configurer le **Billing threshold** (ex: 50€)
4. Configurer l'action en cas d'échec : **"Pause subscription"**

**Note :** Cette configuration se fait manuellement dans Stripe Dashboard, pas dans le code.

**Actions :**
- [ ] Configurer le billing threshold dans Stripe Dashboard
- [ ] Tester avec un ajout massif de propriétés
- [ ] Vérifier que le prélèvement se déclenche au seuil

---

### 4.3 Stripe Customer Portal

**Fichier : `server.js`**

**Route : `POST /api/billing/portal-session`**

**Logique :**

```javascript
app.post('/api/billing/portal-session', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    const db = admin.firestore();
    
    const userProfile = await db.collection('users').doc(userId).get();
    const customerId = userProfile.data().stripeCustomerId;
    
    if (!customerId) {
      return res.status(400).json({ error: 'Aucun customer Stripe trouvé' });
    }
    
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${FRONTEND_URL}/billing`
    });
    
    res.json({ url: session.url });
  } catch (error) {
    console.error('Erreur lors de la création de la session portal:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
```

**Actions :**
- [ ] Créer la route `/api/billing/portal-session`
- [ ] Tester la génération du lien portal
- [ ] Intégrer le bouton dans le frontend

---

## 🔒 PHASE 5 : Kill-Switch & Gestion des Impayés

### 5.1 Amélioration du Webhook `invoice.payment_failed`

**Fichier : `server.js` (fonction `handlePaymentFailed` existe déjà)**

**Logique à améliorer :**

```javascript
async function handlePaymentFailed(invoice, db) {
  // ... code existant ...
  
  // ACTION 1 : Bloquer l'accès au Dashboard
  await db.collection('users').doc(userId).update({
    accessDisabled: true,
    subscriptionStatus: 'past_due',
    paymentFailedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  
  // ACTION 2 : Désactiver l'utilisateur dans Firebase Auth
  await admin.auth().updateUser(userId, { disabled: true });
  
  // ACTION 3 : STOPPER la synchronisation PMS
  await db.collection('users').doc(userId).update({
    pmsSyncEnabled: false,
    pmsSyncStoppedReason: 'payment_failed'
  });
  
  // ACTION 4 : Envoyer email transactionnel (via service email)
  // TODO : Intégrer avec service d'email (SendGrid, etc.)
  console.log(`[Webhook] Email d'échec de paiement à envoyer pour ${userEmail}`);
}
```

**Actions :**
- [ ] Améliorer `handlePaymentFailed()` avec toutes les actions
- [ ] Ajouter le flag `pmsSyncEnabled: false`
- [ ] Intégrer l'envoi d'email (optionnel pour MVP)
- [ ] Tester avec Stripe CLI

---

### 5.2 Vérification dans le Middleware d'Authentification

**Fichier : `server.js` (middleware `authenticateToken` existe déjà)**

**Vérifier que :**
- Le check `accessDisabled` est bien présent ✅ (déjà fait)
- Le check `pmsSyncEnabled` est ajouté pour les routes de sync PMS

**Actions :**
- [ ] Vérifier que `accessDisabled` bloque bien l'accès
- [ ] Ajouter un check `pmsSyncEnabled` dans les routes de sync PMS
- [ ] Tester le blocage d'accès

---

## 🧪 PHASE 6 : Tests & Validation

### 6.1 Tests du Flux Complet

**Scénarios à tester :**

1. **Onboarding complet**
   - [ ] Création de compte
   - [ ] Import de propriétés
   - [ ] Redirection vers Stripe Checkout
   - [ ] Paiement avec carte test
   - [ ] Retour au dashboard
   - [ ] Vérification de l'activation

2. **Essai gratuit**
   - [ ] Ajout de 10 propriétés (OK)
   - [ ] Tentative d'ajout de la 11ème (blocage)
   - [ ] Popup de paiement
   - [ ] Fin d'essai anticipée
   - [ ] Facturation immédiate

3. **Ajout en cours de mois**
   - [ ] Ajouter une propriété le 20 du mois
   - [ ] Vérifier la mise à jour de l'abonnement (mois suivant)
   - [ ] Vérifier la création d'invoice item (mois courant)
   - [ ] Vérifier la facturation

4. **Géofencing**
   - [ ] Créer un groupe avec 2 propriétés à < 500m (OK)
   - [ ] Tenter d'ajouter une propriété à > 500m (refus)

5. **Anti-abus listing IDs**
   - [ ] Premier compte avec listing ID "airbnb_123" (essai gratuit OK)
   - [ ] Deuxième compte avec même listing ID (pas d'essai gratuit)

6. **Impayés**
   - [ ] Simuler un échec de paiement (Stripe CLI)
   - [ ] Vérifier le blocage d'accès
   - [ ] Vérifier l'arrêt de la sync PMS

**Actions :**
- [ ] Créer un document de tests
- [ ] Exécuter tous les scénarios
- [ ] Documenter les bugs trouvés
- [ ] Corriger les bugs

---

## 📝 PHASE 7 : Documentation & Configuration Stripe

### 7.1 Configuration Stripe Dashboard

**Checklist :**

- [ ] **Branding** : Logo et couleurs configurés (Settings > Branding)
- [ ] **Webhooks** : Endpoint configuré avec secret
  - URL : `https://priceye.onrender.com/api/webhooks/stripe`
  - Événements à écouter :
    - `checkout.session.completed`
    - `invoice.payment_failed`
    - `invoice.paid`
    - `customer.subscription.updated`
    - `customer.subscription.deleted`
- [ ] **Billing Thresholds** : Configuré à 50€
- [ ] **Products & Prices** : Vérifier que les IDs correspondent

**Actions :**
- [ ] Configurer le branding dans Stripe
- [ ] Configurer les webhooks
- [ ] Configurer les billing thresholds
- [ ] Vérifier tous les IDs produits/prix

---

## 🎯 Résumé des Priorités

### Priorité HAUTE (MVP)
1. ✅ Configuration des variables d'environnement
2. ✅ Endpoint `/api/checkout/create-session`
3. ✅ Webhook `checkout.session.completed`
4. ✅ Limite de 10 propriétés pendant l'essai
5. ✅ Fin d'essai anticipée avec facturation

### Priorité MOYENNE
6. ✅ Ajout de propriété en cours de mois (facturation complète)
7. ✅ Stripe Customer Portal
8. ✅ Amélioration du webhook `invoice.payment_failed`

### Priorité BASSE (Sécurité avancée)
9. ✅ Géofencing pour les groupes
10. ✅ Anti-abus des listing IDs
11. ✅ Configuration des billing thresholds

---

## 📌 Notes Importantes

- **Tout est sur le MVP** : Pas de séparation landing page pour l'instant
- **Clés Stripe en TEST** : Utiliser les clés de test fournies
- **Webhook Secret** : À récupérer depuis Stripe Dashboard après configuration
- **Frontend** : Les composants frontend (modales, etc.) seront créés séparément

---

## 🔄 Ordre d'Implémentation Recommandé

1. **Jour 1** : Configuration + Endpoint Checkout + Webhook
2. **Jour 2** : Limite 10 propriétés + Fin d'essai anticipée
3. **Jour 3** : Facturation en cours de mois + Customer Portal
4. **Jour 4** : Sécurité (géofencing + anti-abus)
5. **Jour 5** : Tests complets + Corrections

---

**Date de création :** 2025-01-XX  
**Dernière mise à jour :** 2025-01-XX


