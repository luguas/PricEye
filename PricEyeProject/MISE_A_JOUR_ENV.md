# 🔧 Mise à Jour du Fichier .env

## 📝 Instructions

Votre fichier `.env` existe déjà mais utilise les anciens noms de variables. Ajoutez les nouvelles variables pour que tout fonctionne correctement.

---

## ✅ Contenu Complet du Fichier .env

Ouvrez votre fichier `.env` (dans `PricEyeProject/.env`) et remplacez son contenu par ceci :

```env
# ============================================
# CONFIGURATION STRIPE - PRICEYE
# ============================================

# Clés Stripe (Test Mode)
STRIPE_SECRET_KEY=sk_test_51SXqLnG8ypIuy6LADuLGhncm5V0raUDVWOBLt7pnftPE2cbKxaE6fFvFdf539GUvIPKql5b0WPNjNDtC5GCMe2Sm006axjPD05
STRIPE_PUBLISHABLE_KEY=pk_test_51SXqLnG8ypIuy6LARlB49xAiphTudIodq9BFRda7lbrYCMUF5uIB7KBAgLBvrmg8gb30f2Cb5el7JsknEGSh6g5s00hEhg8wLd

# Produits & Prix Stripe (Test Mode)
# Support des deux noms pour compatibilité
STRIPE_PRODUCT_PARENT_ID=prod_TUq3ZQwDAhpeIE
STRIPE_PRICE_PARENT_ID=price_1SXqNeG8ypIuy6LAL1GVrUW2
STRIPE_PRODUCT_PRINCIPAL_ID=prod_TUq3ZQwDAhpeIE
STRIPE_PRICE_PRINCIPAL_ID=price_1SXqNeG8ypIuy6LAL1GVrUW2
STRIPE_PRODUCT_CHILD_ID=prod_TUq4pDV3LDv4ec
STRIPE_PRICE_CHILD_ID=price_1SXqNuG8ypIuy6LALQjrv9JF

# Webhook Secret (À configurer depuis Stripe Dashboard)
# Pour obtenir le webhook secret :
# 1. Allez sur https://dashboard.stripe.com/test/webhooks
# 2. Créez un endpoint : https://priceye.onrender.com/api/webhooks/stripe
# 3. Sélectionnez les événements : checkout.session.completed, invoice.payment_failed, invoice.paid, customer.subscription.updated, customer.subscription.deleted
# 4. Copiez le "Signing secret" (commence par whsec_)
STRIPE_WEBHOOK_SECRET=

# URLs (Production)
FRONTEND_URL=https://pric-eye.vercel.app
BACKEND_URL=https://priceye.onrender.com

# Port du serveur
PORT=5000
```

---

## 🔍 Vérification

Après avoir mis à jour le fichier `.env`, redémarrez votre serveur :

```bash
# Arrêter le serveur (Ctrl+C si en cours d'exécution)
# Puis relancer
node server.js
```

Vous devriez voir dans la console :

```
✅ Configuration Stripe chargée avec succès
```

---

## ⚠️ Note Importante

Le `STRIPE_WEBHOOK_SECRET` est vide pour l'instant. C'est normal si vous testez en local. Pour tester les webhooks en local, utilisez Stripe CLI :

```bash
# Installer Stripe CLI : https://stripe.com/docs/stripe-cli
stripe listen --forward-to localhost:5000/api/webhooks/stripe
```

Le secret sera affiché dans le terminal (commence par `whsec_`).

---

**Date de création :** 2025-01-XX  
**Statut :** ✅ Guide de mise à jour du fichier .env

