# ✅ Phase 2 : Onboarding & Stripe Checkout - TERMINÉE

## 📦 Fichiers modifiés

### Fichier principal :
- **`server.js`** - Ajout de l'endpoint `/api/checkout/create-session` et du webhook `checkout.session.completed`

---

## ✅ Fonctionnalités implémentées

### 1. Endpoint `/api/checkout/create-session`

**Route :** `POST /api/checkout/create-session`  
**Authentification :** Requis (Bearer token)

**Fonctionnalités :**
- ✅ Récupération des propriétés et groupes de l'utilisateur
- ✅ Calcul automatique des buckets Parent/Enfant via `calculateBillingQuantities()`
- ✅ Vérification anti-abus des listing IDs (essai gratuit refusé si listing ID déjà utilisé)
- ✅ Création ou récupération du Customer Stripe
- ✅ Création de la session Stripe Checkout avec :
  - Mode : `subscription`
  - Line items : Produits Parent et Enfant selon les quantités calculées
  - Essai gratuit : 30 jours (ou 0 si anti-abus détecté)
  - URLs de redirection : success et cancel

**Réponse :**
```json
{
  "url": "https://checkout.stripe.com/...",
  "sessionId": "cs_test_..."
}
```

**Exemple d'utilisation :**
```javascript
// Frontend
const response = await fetch('/api/checkout/create-session', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

const { url } = await response.json();
window.location.href = url; // Redirection vers Stripe Checkout
```

---

### 2. Fonction Anti-Abus des Listing IDs

**Fonction :** `checkListingIdsAbuse(listingIds, db)`

**Logique :**
- Vérifie dans la collection `used_listing_ids` si un des listing IDs fournis a déjà été utilisé
- Retourne `true` si abus détecté, `false` sinon
- Utilisée dans l'endpoint checkout pour déterminer si l'essai gratuit doit être accordé

**Collection Firestore :** `used_listing_ids`
```javascript
{
  listingId: "airbnb_12345",
  userId: "user_abc",
  usedAt: Timestamp,
  checkoutSessionId: "cs_test_...",
  subscriptionId: "sub_..."
}
```

---

### 3. Webhook `checkout.session.completed`

**Événement Stripe :** `checkout.session.completed`

**Fonction :** `handleCheckoutSessionCompleted(session, db)`

**Actions effectuées :**
1. ✅ Récupération du `customerId` et `subscriptionId` depuis la session
2. ✅ Récupération du `userId` depuis les metadata
3. ✅ Mise à jour du profil utilisateur dans Firestore :
   - `stripeCustomerId`
   - `stripeSubscriptionId`
   - `subscriptionStatus` (trialing ou active)
   - `accessDisabled: false`
   - `pmsSyncEnabled: true` (activation de la sync PMS)
4. ✅ Enregistrement des listing IDs dans `used_listing_ids` pour l'anti-abus

**Sécurité :**
- Ne fait jamais confiance à la redirection `success_url`
- L'activation se fait uniquement via le webhook (source de vérité)

---

## 🔄 Flux complet d'onboarding

### 1. Utilisateur clique sur "Activer l'abonnement"
```
Frontend → POST /api/checkout/create-session
```

### 2. Backend calcule les quantités et crée la session
```
- Récupère propriétés et groupes
- Calcule buckets Parent/Enfant
- Vérifie anti-abus (listing IDs)
- Crée session Stripe Checkout
- Retourne URL de session
```

### 3. Redirection vers Stripe Checkout
```
Frontend → Redirige vers session.url
```

### 4. Utilisateur entre sa carte et valide
```
Stripe → Traite le paiement
Stripe → Enregistre la carte
Stripe → Crée l'abonnement (avec essai gratuit si applicable)
```

### 5. Stripe envoie le webhook
```
Stripe → POST /api/webhooks/stripe
         (événement: checkout.session.completed)
```

### 6. Backend active l'abonnement
```
- Met à jour le profil utilisateur
- Active la sync PMS
- Enregistre les listing IDs
```

### 7. Redirection vers le dashboard
```
Stripe → Redirige vers success_url
Frontend → Affiche le dashboard avec confettis 🎉
```

---

## 📝 Variables d'environnement utilisées

- `STRIPE_SECRET_KEY` - Clé secrète Stripe
- `STRIPE_PRICE_PARENT_ID` ou `STRIPE_PRICE_PRINCIPAL_ID` - Prix du produit parent
- `STRIPE_PRICE_CHILD_ID` - Prix du produit enfant
- `FRONTEND_URL` - URL du frontend pour les redirections (défaut: `https://pric-eye.vercel.app`)

---

## 🧪 Tests à effectuer

### Test 1 : Création de session Checkout
```bash
# Avec un token valide
curl -X POST http://localhost:5000/api/checkout/create-session \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json"
```

**Résultat attendu :**
```json
{
  "url": "https://checkout.stripe.com/...",
  "sessionId": "cs_test_..."
}
```

### Test 2 : Webhook checkout.session.completed
```bash
# Utiliser Stripe CLI pour tester
stripe listen --forward-to localhost:5000/api/webhooks/stripe
stripe trigger checkout.session.completed
```

**Vérifications :**
- ✅ Le profil utilisateur est mis à jour dans Firestore
- ✅ Les listing IDs sont enregistrés dans `used_listing_ids`
- ✅ `pmsSyncEnabled` est à `true`

### Test 3 : Anti-abus des listing IDs
1. Créer un compte avec un listing ID "airbnb_123"
2. Compléter le checkout (essai gratuit accordé)
3. Créer un nouveau compte avec le même listing ID "airbnb_123"
4. Vérifier que l'essai gratuit est refusé (`trial_period_days: 0`)

---

## 🔍 Points d'attention

1. **Sécurité** : Le webhook vérifie toujours la signature Stripe avant traitement
2. **Idempotence** : Le webhook peut être appelé plusieurs fois (Stripe garantit au moins une fois)
3. **Erreurs** : En cas d'erreur dans le webhook, Stripe réessaiera automatiquement
4. **Metadata** : Le `userId` est stocké dans les metadata de la session et du customer

---

## 🚀 Prochaines étapes

Une fois la Phase 2 validée, vous pouvez passer à la **Phase 3 : Sécurité & Limites**.

Voir le document `PLAN_ROUTE_BILLING_STRIPE.md` pour la suite.

---

## 📋 Checklist de validation

- [ ] Endpoint `/api/checkout/create-session` accessible et fonctionnel
- [ ] Session Stripe Checkout créée avec succès
- [ ] Redirection vers Stripe Checkout fonctionnelle
- [ ] Webhook `checkout.session.completed` configuré dans Stripe Dashboard
- [ ] Webhook reçoit et traite correctement les événements
- [ ] Profil utilisateur mis à jour après checkout
- [ ] Listing IDs enregistrés pour l'anti-abus
- [ ] Test anti-abus fonctionnel (essai gratuit refusé pour listing ID dupliqué)

---

**Date de complétion :** 2025-01-XX  
**Statut :** ✅ Phase 2 terminée - Prêt pour Phase 3


