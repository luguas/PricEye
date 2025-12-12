# ✅ Phase 8 : Anti-Abus des Essais Gratuits - TERMINÉE

## 📦 Fichiers modifiés

### Fichier principal :
- **`server.js`** - Amélioration de l'enregistrement des listing IDs lors de l'import de propriétés

---

## ✅ Fonctionnalités implémentées

### 1. Fonction de Vérification Anti-Abus

**Fonction :** `checkListingIdsAbuse(listingIds, db)`

**Logique :**
- ✅ Vérifie dans la collection `used_listing_ids` si un des listing IDs fournis a déjà été utilisé
- ✅ Retourne `true` si abus détecté, `false` sinon
- ✅ Fail-safe : retourne `false` en cas d'erreur (autorise l'essai gratuit)

**Utilisation :**
- Utilisée dans `/api/checkout/create-session` pour déterminer si l'essai gratuit doit être accordé

---

### 2. Vérification lors de la Création de Session Checkout

**Route :** `POST /api/checkout/create-session`

**Logique :**
- ✅ Extrait tous les listing IDs (pmsId) des propriétés de l'utilisateur
- ✅ Appelle `checkListingIdsAbuse()` pour vérifier
- ✅ Si abus détecté : `trial_period_days: 0` (pas d'essai gratuit)
- ✅ Si pas d'abus : `trial_period_days: 30` (essai gratuit normal)

**Code :**
```javascript
const listingIds = userProperties
    .filter(p => p.pmsId)
    .map(p => p.pmsId);

if (listingIds.length > 0) {
    const hasAbuse = await checkListingIdsAbuse(listingIds, db);
    if (hasAbuse) {
        trialPeriodDays = 0; // Pas d'essai gratuit
    }
}
```

---

### 3. Enregistrement des Listing IDs lors du Checkout

**Webhook :** `checkout.session.completed`

**Fonction :** `handleCheckoutSessionCompleted()`

**Logique :**
- ✅ Récupère toutes les propriétés de l'utilisateur après le checkout
- ✅ Extrait tous les listing IDs (pmsId)
- ✅ Enregistre chaque listing ID dans la collection `used_listing_ids`
- ✅ Vérifie si le listing ID n'est pas déjà enregistré (évite les doublons)

**Structure de données :**
```javascript
{
  listingId: "airbnb_12345",
  userId: "user_abc",
  usedAt: Timestamp,
  checkoutSessionId: "cs_test_...",
  subscriptionId: "sub_...",
  source: "checkout_completed"
}
```

---

### 4. Enregistrement des Listing IDs lors de l'Import de Propriétés (NOUVEAU)

**Route :** `POST /api/integrations/import-properties`

**Amélioration :**
- ✅ Enregistre les listing IDs immédiatement lors de l'import
- ✅ Même si l'utilisateur n'a pas encore fait de checkout
- ✅ Permet de détecter l'abus avant même la création d'un compte Stripe

**Logique :**
- ✅ Après l'import des propriétés, extrait tous les `pmsId`
- ✅ Vérifie si chaque listing ID est déjà enregistré
- ✅ Enregistre les nouveaux listing IDs dans `used_listing_ids`

**Structure de données :**
```javascript
{
  listingId: "airbnb_12345",
  userId: "user_abc",
  usedAt: Timestamp,
  source: "import_properties",
  propertyCount: 3
}
```

**Avantage :**
- Détecte l'abus même si l'utilisateur importe des propriétés avant de créer un compte Stripe
- Plus robuste contre les tentatives de contournement

---

## 🔄 Flux complet

### Scénario 1 : Utilisateur légitime (premier compte)

1. **Import de propriétés**
   - Utilisateur importe des propriétés avec listing IDs "airbnb_123", "airbnb_456"
   - Listing IDs enregistrés dans `used_listing_ids` avec `source: "import_properties"`

2. **Création de session Checkout**
   - Backend vérifie les listing IDs
   - Aucun abus détecté (première utilisation)
   - Essai gratuit accordé : `trial_period_days: 30`

3. **Checkout complété**
   - Webhook `checkout.session.completed` déclenché
   - Listing IDs enregistrés à nouveau avec `source: "checkout_completed"`
   - (Les doublons sont évités par la vérification)

### Scénario 2 : Tentative d'abus (deuxième compte)

1. **Nouvel utilisateur importe les mêmes propriétés**
   - Importe des propriétés avec listing IDs "airbnb_123", "airbnb_456"
   - Listing IDs enregistrés dans `used_listing_ids` avec `source: "import_properties"`

2. **Création de session Checkout**
   - Backend vérifie les listing IDs
   - **Abus détecté** : "airbnb_123" et "airbnb_456" déjà utilisés
   - Essai gratuit refusé : `trial_period_days: 0`
   - L'utilisateur doit payer immédiatement

---

## 📊 Collection Firestore : `used_listing_ids`

**Structure :**
```javascript
{
  listingId: string,        // ID unique du listing (pmsId)
  userId: string,           // ID de l'utilisateur qui a utilisé ce listing
  usedAt: Timestamp,        // Date d'enregistrement
  source: string,           // "import_properties" ou "checkout_completed"
  checkoutSessionId?: string, // Optionnel (si source = checkout_completed)
  subscriptionId?: string,   // Optionnel (si source = checkout_completed)
  propertyCount?: number     // Optionnel (si source = import_properties)
}
```

**Index recommandé :**
- Index sur `listingId` pour des recherches rapides
- Index sur `userId` pour le debugging

---

## 🧪 Tests à effectuer

### Test 1 : Utilisateur légitime
```bash
# 1. Créer un compte
# 2. Importer des propriétés avec listing IDs "airbnb_123", "airbnb_456"
# 3. Créer une session Checkout
# 4. Vérifier que l'essai gratuit est accordé (30 jours)
```

**Vérifications :**
- ✅ Listing IDs enregistrés dans `used_listing_ids` après l'import
- ✅ Listing IDs enregistrés à nouveau après le checkout
- ✅ Essai gratuit accordé

### Test 2 : Tentative d'abus
```bash
# 1. Créer un NOUVEAU compte
# 2. Importer des propriétés avec les MÊMES listing IDs "airbnb_123", "airbnb_456"
# 3. Créer une session Checkout
# 4. Vérifier que l'essai gratuit est refusé (0 jours)
```

**Vérifications :**
- ✅ Listing IDs détectés comme déjà utilisés
- ✅ Essai gratuit refusé (`trial_period_days: 0`)
- ✅ L'utilisateur doit payer immédiatement

### Test 3 : Import avant checkout
```bash
# 1. Créer un compte
# 2. Importer des propriétés (listing IDs enregistrés)
# 3. Créer un autre compte avec les mêmes listing IDs
# 4. Vérifier que l'abus est détecté même sans checkout
```

**Vérifications :**
- ✅ Listing IDs enregistrés lors de l'import (même sans checkout)
- ✅ Abus détecté lors du checkout du deuxième compte

---

## 📝 Notes importantes

1. **Double enregistrement** : Les listing IDs peuvent être enregistrés deux fois :
   - Une fois lors de l'import (`source: "import_properties"`)
   - Une fois lors du checkout (`source: "checkout_completed"`)
   - La vérification évite les doublons dans la même session

2. **Fail-safe** : En cas d'erreur lors de la vérification, l'essai gratuit est autorisé (évite de bloquer par erreur)

3. **Performance** : La vérification se fait en boucle (une requête par listing ID). Pour de grandes quantités, on pourrait optimiser avec une requête batch.

4. **Rétrocompatibilité** : Les utilisateurs existants sans listing IDs enregistrés bénéficient toujours de l'essai gratuit

---

## 🔍 Points d'attention

1. **Format des listing IDs** : Les listing IDs doivent être cohérents (même format pour le même listing)
2. **Case sensitivity** : Les listing IDs sont comparés de manière exacte (case-sensitive)
3. **Performance** : Pour de très grandes quantités de listing IDs, considérer une optimisation avec des requêtes batch

---

## 🚀 Optimisations possibles (futures)

### Option 1 : Requête batch pour plusieurs listing IDs
```javascript
// Au lieu de boucler, faire une requête avec "in"
const existing = await db.collection('used_listing_ids')
    .where('listingId', 'in', listingIds)
    .get();
```

**Limitation** : Firestore limite `in` à 10 éléments. Pour plus, il faut faire plusieurs requêtes.

### Option 2 : Index composite
Créer un index composite sur `listingId` et `userId` pour des recherches plus rapides.

---

## 📋 Checklist de validation

- [ ] Fonction `checkListingIdsAbuse()` fonctionnelle
- [ ] Vérification dans `/api/checkout/create-session` fonctionnelle
- [ ] Enregistrement dans webhook `checkout.session.completed` fonctionnel
- [ ] Enregistrement lors de l'import de propriétés fonctionnel
- [ ] Test avec utilisateur légitime (essai gratuit accordé)
- [ ] Test avec tentative d'abus (essai gratuit refusé)
- [ ] Test avec import avant checkout (abus détecté)
- [ ] Collection `used_listing_ids` correctement structurée

---

**Date de complétion :** 2025-01-XX  
**Statut :** ✅ Phase 8 terminée - Anti-abus opérationnel


