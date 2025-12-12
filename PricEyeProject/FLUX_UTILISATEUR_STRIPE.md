# 📊 Flux Utilisateur Complet - Intégration Stripe (Priceye)

## 🎯 Vue d'ensemble

Ce document explique **étape par étape** ce qui se passe lorsqu'un utilisateur crée un compte et active son abonnement Stripe.

---

## 📝 ÉTAPE 1 : Création du Compte

### Ce que fait l'utilisateur :
1. Va sur la page d'inscription
2. Remplit le formulaire (nom, email, mot de passe)
3. Clique sur "S'inscrire"

### Ce qui se passe côté backend (`POST /api/auth/register`) :

```javascript
// 1. Création du compte Firebase Auth
const userRecord = await admin.auth().createUser({
  email: email,
  password: password,
  displayName: name
});

// 2. Création du profil utilisateur dans Firestore
await db.collection('users').doc(userRecord.uid).set({
  name: name,
  email: email,
  createdAt: admin.firestore.FieldValue.serverTimestamp(),
  subscriptionStatus: 'none', // Pas encore d'abonnement
  accessDisabled: false,
  pmsSyncEnabled: false // Pas encore activé
});
```

### Résultat :
- ✅ Compte Firebase créé
- ✅ Profil Firestore créé
- ✅ Utilisateur peut se connecter
- ❌ **PAS encore d'abonnement Stripe**
- ❌ **PAS encore d'accès complet à l'application**

---

## 📝 ÉTAPE 2 : Connexion et Import de Propriétés

### Ce que fait l'utilisateur :
1. Se connecte avec son email/mot de passe
2. Accède au Dashboard
3. **Optionnel** : Importe des propriétés depuis un PMS (Smoobu, Beds24, etc.)

### Ce qui se passe lors de l'import (`POST /api/integrations/import-properties`) :

```javascript
// 1. Import des propriétés dans Firestore
// 2. Enregistrement des listing IDs pour l'anti-abus
await db.collection('used_listing_ids').add({
  listingId: property.pmsId,
  userId: userId,
  usedAt: admin.firestore.FieldValue.serverTimestamp(),
  source: 'import_properties' // Enregistré AVANT le checkout
});
```

### Résultat :
- ✅ Propriétés importées dans Firestore
- ✅ Listing IDs enregistrés (pour l'anti-abus)
- ❌ **Toujours pas d'abonnement Stripe**
- ⚠️ **L'utilisateur peut utiliser l'application mais de manière limitée**

---

## 📝 ÉTAPE 3 : Activation de l'Abonnement (Stripe Checkout)

### Ce que fait l'utilisateur :
1. Va dans **Paramètres** → Section **"Gestion de l'abonnement"**
2. Clique sur **"Activer l'abonnement"**

### Ce qui se passe côté backend (`POST /api/checkout/create-session`) :

#### 3.1 Récupération des données utilisateur
```javascript
// Récupère toutes les propriétés de l'utilisateur
const propertiesSnapshot = await db.collection('properties')
  .where('userId', '==', userId)
  .get();

// Récupère tous les groupes de l'utilisateur
const groupsSnapshot = await db.collection('groups')
  .where('userId', '==', userId)
  .get();
```

#### 3.2 Calcul des quantités Parent/Enfant
```javascript
// Utilise la fonction calculateBillingQuantities()
const { quantityPrincipal, quantityChild } = calculateBillingQuantities(
  userProperties,
  userGroups
);

// Exemple :
// - 3 propriétés seules → 3 Parent
// - 1 groupe avec 4 propriétés → 1 Parent (1ère) + 3 Enfant
// Total : 4 Parent, 3 Enfant
```

#### 3.3 Vérification Anti-Abus des Essais Gratuits
```javascript
// Récupère tous les listing IDs des propriétés importées
const listingIds = userProperties
  .map(p => p.pmsId)
  .filter(Boolean);

// Vérifie dans used_listing_ids si ces IDs ont déjà été utilisés
const usedListingIdsSnapshot = await db.collection('used_listing_ids')
  .where('listingId', 'in', listingIds)
  .get();

// Décision :
if (usedListingIdsSnapshot.empty) {
  trialPeriodDays = 30; // ✅ Essai gratuit accordé
} else {
  trialPeriodDays = 0;  // ❌ Essai gratuit refusé (abus détecté)
}
```

#### 3.4 Création ou Récupération du Customer Stripe
```javascript
let customerId = userProfile.stripeCustomerId;

if (!customerId) {
  // Créer un nouveau customer Stripe
  const customer = await stripe.customers.create({
    email: userProfile.email,
    name: userProfile.name,
    metadata: { userId: userId }
  });
  customerId = customer.id;
  
  // Sauvegarder dans Firestore
  await userProfileRef.update({ stripeCustomerId: customerId });
}
```

#### 3.5 Création de la Session Stripe Checkout
```javascript
const session = await stripe.checkout.sessions.create({
  mode: 'subscription',
  customer: customerId,
  customer_email: userProfile.email,
  
  // Lignes de facturation (Parent + Enfant)
  line_items: [
    {
      price: process.env.STRIPE_PRICE_PARENT_ID, // 13.99€ (dégressif)
      quantity: quantityPrincipal
    },
    {
      price: process.env.STRIPE_PRICE_CHILD_ID,  // 3.99€ (fixe)
      quantity: quantityChild
    }
  ],
  
  // Essai gratuit (30 jours ou 0 selon anti-abus)
  subscription_data: {
    trial_period_days: trialPeriodDays,
    metadata: { userId: userId }
  },
  
  // URLs de redirection
  success_url: `${FRONTEND_URL}/#checkout-success?session_id={CHECKOUT_SESSION_ID}`,
  cancel_url: `${FRONTEND_URL}/#checkout-cancel?canceled=true`
});
```

#### 3.6 Retour de l'URL au Frontend
```json
{
  "url": "https://checkout.stripe.com/c/pay/cs_test_..."
}
```

### Résultat :
- ✅ Session Stripe Checkout créée
- ✅ URL retournée au frontend
- ⏳ **En attente du paiement de l'utilisateur**

---

## 📝 ÉTAPE 4 : Paiement sur Stripe Checkout

### Ce que fait l'utilisateur :
1. Est **redirigé automatiquement** vers la page Stripe Checkout
2. Voit le résumé :
   - "Essai gratuit 30 jours, puis X€/mois" (si essai accordé)
   - "X€/mois" (si essai refusé)
3. Entre ses informations de carte bancaire
4. Clique sur **"S'abonner"**

### Ce qui se passe côté Stripe :
- ✅ Carte validée
- ✅ Customer créé (si nouveau)
- ✅ Abonnement créé avec période d'essai (si applicable)
- ✅ **Aucun prélèvement** si essai gratuit (0€)
- ✅ **Prélèvement immédiat** si pas d'essai gratuit

---

## 📝 ÉTAPE 5 : Webhook `checkout.session.completed`

### Ce qui se passe automatiquement (backend) :

Stripe envoie un webhook à votre serveur :

```javascript
// POST /api/webhooks/stripe
// Événement : checkout.session.completed

async function handleCheckoutSessionCompleted(session, db) {
  // 1. Récupérer l'abonnement créé
  const subscription = await stripe.subscriptions.retrieve(
    session.subscription
  );
  
  // 2. Récupérer le customer
  const customerId = session.customer;
  
  // 3. Trouver l'utilisateur via metadata ou customerId
  const userId = subscription.metadata.userId;
  
  // 4. Mettre à jour le profil utilisateur dans Firestore
  await db.collection('users').doc(userId).update({
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscription.id,
    subscriptionStatus: subscription.status, // 'trialing' ou 'active'
    subscriptionCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
    accessDisabled: false,        // ✅ Accès activé
    pmsSyncEnabled: true          // ✅ Sync PMS activée
  });
  
  // 5. Enregistrer les listing IDs (anti-abus)
  const userProperties = await db.collection('properties')
    .where('userId', '==', userId)
    .get();
    
  for (const propertyDoc of userProperties.docs) {
    const property = propertyDoc.data();
    if (property.pmsId) {
      await db.collection('used_listing_ids').add({
        listingId: property.pmsId,
        userId: userId,
        usedAt: admin.firestore.FieldValue.serverTimestamp(),
        source: 'checkout_completed'
      });
    }
  }
}
```

### Résultat :
- ✅ Profil utilisateur mis à jour avec les IDs Stripe
- ✅ `subscriptionStatus: 'trialing'` (si essai gratuit) ou `'active'` (si pas d'essai)
- ✅ `accessDisabled: false` → **Accès activé**
- ✅ `pmsSyncEnabled: true` → **Synchronisation PMS activée**
- ✅ Listing IDs enregistrés pour l'anti-abus

---

## 📝 ÉTAPE 6 : Retour sur l'Application

### Ce que fait l'utilisateur :
1. Est **redirigé automatiquement** vers `/checkout-success`
2. Voit un message : "Abonnement activé avec succès ! 🎉"
3. Est redirigé vers les **Paramètres** après 3 secondes

### Ce qui se passe côté frontend :
```javascript
// CheckoutSuccessPage.jsx
useEffect(() => {
  // Attendre 2 secondes pour que le webhook soit traité
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Rafraîchir le profil utilisateur
  const updatedProfile = await getUserProfile(token);
  setUserProfile(updatedProfile);
  
  // Rediriger vers les paramètres
  setTimeout(() => {
    window.location.href = '/#settings';
  }, 3000);
}, []);
```

### Résultat :
- ✅ Utilisateur voit son abonnement actif dans les Paramètres
- ✅ Peut utiliser toutes les fonctionnalités de l'application
- ✅ Synchronisation PMS activée

---

## 📊 Résumé du Flux Complet

```
1. INSCRIPTION
   └─> Création compte Firebase + Profil Firestore
       └─> subscriptionStatus: 'none'
       └─> accessDisabled: false
       └─> pmsSyncEnabled: false

2. CONNEXION
   └─> Accès au Dashboard
   └─> Import de propriétés (optionnel)
       └─> Listing IDs enregistrés (anti-abus)

3. ACTIVATION ABONNEMENT
   └─> Clic sur "Activer l'abonnement"
   └─> POST /api/checkout/create-session
       └─> Calcul Parent/Enfant
       └─> Vérification anti-abus
       └─> Création session Stripe Checkout
       └─> Redirection vers Stripe

4. PAIEMENT STRIPE
   └─> Utilisateur entre sa carte
   └─> Stripe valide et crée l'abonnement
   └─> 0€ prélevé si essai gratuit
   └─> Prélèvement immédiat si pas d'essai

5. WEBHOOK
   └─> checkout.session.completed
   └─> Mise à jour profil Firestore
       └─> subscriptionStatus: 'trialing' ou 'active'
       └─> accessDisabled: false
       └─> pmsSyncEnabled: true
       └─> Listing IDs enregistrés

6. RETOUR APPLICATION
   └─> Page de succès
   └─> Redirection vers Paramètres
   └─> Utilisateur voit son abonnement actif
```

---

## 🔒 Sécurités Implémentées

### 1. Anti-Abus des Essais Gratuits
- ✅ Listing IDs enregistrés lors de l'import
- ✅ Listing IDs enregistrés lors du checkout
- ✅ Vérification avant accord de l'essai gratuit
- ✅ Essai gratuit refusé si listing ID déjà utilisé

### 2. Kill-Switch
- ✅ `accessDisabled: true` si paiement échoué
- ✅ `pmsSyncEnabled: false` si paiement échoué
- ✅ Utilisateur bloqué jusqu'à mise à jour de la carte

### 3. Limite d'Essai Gratuit
- ✅ Maximum 10 propriétés pendant l'essai
- ✅ Popup de blocage si limite dépassée
- ✅ Option de fin d'essai anticipée avec facturation immédiate

---

## 📝 États Possibles d'un Utilisateur

| État | `subscriptionStatus` | `accessDisabled` | `pmsSyncEnabled` | Description |
|------|---------------------|------------------|------------------|-------------|
| **Nouveau compte** | `none` | `false` | `false` | Compte créé mais pas d'abonnement |
| **En essai gratuit** | `trialing` | `false` | `true` | Abonnement actif, essai de 30 jours |
| **Abonnement actif** | `active` | `false` | `true` | Abonnement payant actif |
| **Paiement échoué** | `past_due` | `true` | `false` | Accès bloqué, sync PMS stoppée |
| **Abonnement annulé** | `canceled` | `true` | `false` | Abonnement annulé, accès bloqué |

---

## ⚠️ Points Importants

1. **L'abonnement n'est PAS créé automatiquement à l'inscription**
   - L'utilisateur doit **manuellement** activer l'abonnement depuis les Paramètres

2. **Le webhook est CRITIQUE**
   - Sans le webhook, l'abonnement Stripe existe mais le profil utilisateur n'est pas mis à jour
   - L'utilisateur n'aurait pas accès complet à l'application

3. **L'essai gratuit dépend de l'anti-abus**
   - Si les listing IDs ont déjà été utilisés → Pas d'essai gratuit
   - Si les listing IDs sont nouveaux → Essai gratuit de 30 jours

4. **La limite de 10 propriétés s'applique uniquement pendant l'essai**
   - Une fois l'essai terminé ou l'abonnement actif, plus de limite

---

**Date de création :** 2025-01-XX  
**Statut :** ✅ Documentation complète du flux utilisateur

