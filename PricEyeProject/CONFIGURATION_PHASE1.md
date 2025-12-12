# ✅ Phase 1 : Configuration & Infrastructure - Guide d'Installation

## 📋 Checklist de Configuration

### 1. Variables d'Environnement

#### Étape 1 : Créer le fichier `.env`

```bash
cd PricEyeProject
cp .env.example .env
```

#### Étape 2 : Remplir les variables dans `.env`

**Variables déjà fournies (à copier telles quelles) :**

```env
# Clés Stripe (Test)
STRIPE_SECRET_KEY=sk_test_51SXqLnG8ypIuy6LADuLGhncm5V0raUDVWOBLt7pnftPE2cbKxaE6fFvFdf539GUvIPKql5b0WPNjNDtC5GCMe2Sm006axjPD05
STRIPE_PUBLISHABLE_KEY=pk_test_51SXqLnG8ypIuy6LARlB49xAiphTudIodq9BFRda7lbrYCMUF5uIB7KBAgLBvrmg8gb30f2Cb5el7JsknEGSh6g5s00hEhg8wLd

# Produits & Prix Stripe
STRIPE_PRODUCT_PARENT_ID=prod_TUq3ZQwDAhpeIE
STRIPE_PRICE_PARENT_ID=price_1SXqNeG8ypIuy6LAL1GVrUW2
STRIPE_PRODUCT_CHILD_ID=prod_TUq4pDV3LDv4ec
STRIPE_PRICE_CHILD_ID=price_1SXqNuG8ypIuy6LALQjrv9JF
```

**Variable à récupérer depuis Stripe Dashboard :**

```env
STRIPE_WEBHOOK_SECRET=whsec_... # Voir instructions ci-dessous
```

---

### 2. Configuration du Webhook Stripe

#### Étape 1 : Accéder au Dashboard Stripe

1. Allez sur https://dashboard.stripe.com/test/webhooks
2. Cliquez sur **"Add endpoint"**

#### Étape 2 : Configurer l'endpoint

- **URL** : `https://priceye.onrender.com/api/webhooks/stripe`
- **Description** : "Webhook Priceye - Gestion des événements de facturation"

#### Étape 3 : Sélectionner les événements

Cochez les événements suivants :
- ✅ `checkout.session.completed` (NOUVEAU - pour l'onboarding)
- ✅ `invoice.payment_failed` (existant)
- ✅ `invoice.paid` (existant)
- ✅ `customer.subscription.updated` (existant)
- ✅ `customer.subscription.deleted` (existant)

#### Étape 4 : Récupérer le Secret

1. Après la création, cliquez sur l'endpoint créé
2. Dans la section **"Signing secret"**, cliquez sur **"Reveal"**
3. Copiez le secret (commence par `whsec_`)
4. Ajoutez-le dans votre fichier `.env` :

```env
STRIPE_WEBHOOK_SECRET=whsec_votre_secret_ici
```

#### Étape 5 : Tester le Webhook (Optionnel - pour développement local)

Si vous testez en local, utilisez Stripe CLI :

```bash
# Installer Stripe CLI
# https://stripe.com/docs/stripe-cli

# Forwarder les webhooks vers votre serveur local
stripe listen --forward-to localhost:5000/api/webhooks/stripe

# Le secret sera affiché dans le terminal (whsec_...)
```

---

### 3. Vérification des IDs Produits/Prix

#### Vérification dans Stripe Dashboard

1. Allez sur https://dashboard.stripe.com/test/products
2. Vérifiez que les produits existent :

**Produit Parent :**
- ID : `prod_TUq3ZQwDAhpeIE`
- Prix : `price_1SXqNeG8ypIuy6LAL1GVrUW2`
- Type : Modèle Graduated (paliers : 13.99€, puis 11.99€, etc.)

**Produit Enfant :**
- ID : `prod_TUq4pDV3LDv4ec`
- Prix : `price_1SXqNuG8ypIuy6LALQjrv9JF`
- Type : Modèle Standard (Prix fixe : 3.99€)

#### Si les IDs ne correspondent pas

1. Notez les nouveaux IDs depuis le Dashboard
2. Mettez à jour le fichier `.env` avec les nouveaux IDs
3. Vérifiez que le code utilise bien `process.env.STRIPE_PRICE_PARENT_ID` et `process.env.STRIPE_PRICE_CHILD_ID`

---

### 4. Configuration du Branding Stripe (Optionnel mais recommandé)

1. Allez sur https://dashboard.stripe.com/test/settings/branding
2. Uploadez votre logo Priceye
3. Configurez les couleurs de votre marque
4. Ces paramètres seront utilisés dans les pages Stripe Checkout

---

### 5. Configuration des Billing Thresholds (Pour plus tard)

⚠️ **À configurer après l'implémentation de la Phase 4**

1. Allez sur https://dashboard.stripe.com/test/settings/billing
2. Activez **"Automatically collect payment"**
3. Configurez le **Billing threshold** (ex: 50€)
4. Configurez l'action en cas d'échec : **"Pause subscription"**

---

## ✅ Validation de la Configuration

### Test 1 : Vérifier que les variables sont chargées

```bash
# Dans le terminal, depuis PricEyeProject
node -e "require('dotenv').config(); console.log('STRIPE_SECRET_KEY:', process.env.STRIPE_SECRET_KEY ? '✅ Configuré' : '❌ Manquant');"
```

### Test 2 : Vérifier la connexion Stripe

Créez un fichier de test temporaire :

```javascript
// test-stripe.js
require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

async function test() {
  try {
    const products = await stripe.products.list({ limit: 5 });
    console.log('✅ Connexion Stripe OK');
    console.log('Produits trouvés:', products.data.length);
  } catch (error) {
    console.error('❌ Erreur Stripe:', error.message);
  }
}

test();
```

Exécutez :
```bash
node test-stripe.js
```

### Test 3 : Vérifier les IDs produits/prix

```javascript
// test-ids.js
require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

async function test() {
  try {
    // Vérifier le produit parent
    const parentProduct = await stripe.products.retrieve(process.env.STRIPE_PRODUCT_PARENT_ID);
    console.log('✅ Produit Parent trouvé:', parentProduct.name);
    
    // Vérifier le prix parent
    const parentPrice = await stripe.prices.retrieve(process.env.STRIPE_PRICE_PARENT_ID);
    console.log('✅ Prix Parent trouvé:', parentPrice.unit_amount / 100, '€');
    
    // Vérifier le produit enfant
    const childProduct = await stripe.products.retrieve(process.env.STRIPE_PRODUCT_CHILD_ID);
    console.log('✅ Produit Enfant trouvé:', childProduct.name);
    
    // Vérifier le prix enfant
    const childPrice = await stripe.prices.retrieve(process.env.STRIPE_PRICE_CHILD_ID);
    console.log('✅ Prix Enfant trouvé:', childPrice.unit_amount / 100, '€');
  } catch (error) {
    console.error('❌ Erreur:', error.message);
  }
}

test();
```

Exécutez :
```bash
node test-ids.js
```

---

## 📝 Notes Importantes

1. **Ne commitez JAMAIS le fichier `.env`** dans Git
2. Le fichier `.env.example` peut être commité (sans les valeurs sensibles)
3. Pour la production, utilisez les clés Stripe en mode **LIVE**
4. Le `STRIPE_WEBHOOK_SECRET` est différent pour les environnements test et live
5. Si vous changez d'environnement (test → live), mettez à jour toutes les clés

---

## 🚀 Prochaines Étapes

Une fois la Phase 1 terminée, vous pouvez passer à la **Phase 2 : Onboarding & Stripe Checkout**.

Voir le document `PLAN_ROUTE_BILLING_STRIPE.md` pour la suite.

---

**Date de création :** 2025-01-XX  
**Statut :** ✅ Phase 1 - Configuration & Infrastructure


