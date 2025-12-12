# 🔧 Instructions pour Créer le Fichier .env

## ⚠️ IMPORTANT

Le fichier `.env` contient des clés sensibles et ne doit **JAMAIS** être commité sur Git.

---

## 📝 Étape 1 : Créer le fichier .env

Créez un fichier nommé `.env` à la racine du dossier `PricEyeProject` (même niveau que `server.js`).

---

## 📝 Étape 2 : Copier le contenu suivant

Ouvrez le fichier `.env` et copiez-collez ce contenu :

```env
# ============================================
# CONFIGURATION STRIPE - PRICEYE
# ============================================

# Clés Stripe (Test Mode)
STRIPE_SECRET_KEY=sk_test_51SXqLnG8ypIuy6LADuLGhncm5V0raUDVWOBLt7pnftPE2cbKxaE6fFvFdf539GUvIPKql5b0WPNjNDtC5GCMe2Sm006axjPD05
STRIPE_PUBLISHABLE_KEY=pk_test_51SXqLnG8ypIuy6LARlB49xAiphTudIodq9BFRda7lbrYCMUF5uIB7KBAgLBvrmg8gb30f2Cb5el7JsknEGSh6g5s00hEhg8wLd

# Webhook Secret (À configurer depuis Stripe Dashboard)
# Pour obtenir le webhook secret :
# 1. Allez sur https://dashboard.stripe.com/test/webhooks
# 2. Créez un endpoint : https://priceye.onrender.com/api/webhooks/stripe
# 3. Sélectionnez les événements : checkout.session.completed, invoice.payment_failed, invoice.paid, customer.subscription.updated, customer.subscription.deleted
# 4. Copiez le "Signing secret" (commence par whsec_)
STRIPE_WEBHOOK_SECRET=whsec_... # À REMPLACER AVEC LE VRAI SECRET

# Produits & Prix Stripe (Test Mode)
STRIPE_PRODUCT_PARENT_ID=prod_TUq3ZQwDAhpeIE
STRIPE_PRICE_PARENT_ID=price_1SXqNeG8ypIuy6LAL1GVrUW2
STRIPE_PRODUCT_CHILD_ID=prod_TUq4pDV3LDv4ec
STRIPE_PRICE_CHILD_ID=price_1SXqNuG8ypIuy6LALQjrv9JF

# URLs (Production)
FRONTEND_URL=https://pric-eye.vercel.app
BACKEND_URL=https://priceye.onrender.com

# Port du serveur
PORT=5000
```

---

## 📝 Étape 3 : Vérifier que le fichier .env est dans .gitignore

Assurez-vous que le fichier `.gitignore` contient :

```
.env
.env.local
.env.*.local
```

---

## 📝 Étape 4 : Redémarrer le serveur

Après avoir créé le fichier `.env`, redémarrez votre serveur :

```bash
# Arrêter le serveur (Ctrl+C)
# Puis relancer
node server.js
# ou
npm start
```

Vous devriez voir dans la console :

```
✅ Configuration Stripe chargée avec succès
```

---

## 🔍 Vérification

Pour vérifier que les variables sont bien chargées, vous pouvez tester :

```bash
# Depuis le dossier PricEyeProject
node -e "require('dotenv').config(); console.log('STRIPE_SECRET_KEY:', process.env.STRIPE_SECRET_KEY ? '✅ Configuré' : '❌ Manquant');"
```

---

## ⚠️ Si vous êtes sur Render.com (Production)

Si votre serveur est déployé sur Render.com, vous devez configurer les variables d'environnement dans le dashboard Render :

1. Allez sur https://dashboard.render.com
2. Sélectionnez votre service
3. Allez dans **"Environment"**
4. Ajoutez toutes les variables une par une :
   - `STRIPE_SECRET_KEY`
   - `STRIPE_PUBLISHABLE_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - `STRIPE_PRODUCT_PARENT_ID`
   - `STRIPE_PRICE_PARENT_ID`
   - `STRIPE_PRODUCT_CHILD_ID`
   - `STRIPE_PRICE_CHILD_ID`
   - `FRONTEND_URL`
   - `BACKEND_URL`
   - `PORT`

**Note :** Sur Render.com, vous n'avez pas besoin de créer un fichier `.env`, les variables sont configurées directement dans le dashboard.

---

## ✅ Résultat Attendu

Une fois le fichier `.env` créé et le serveur redémarré, l'erreur `STRIPE_SECRET_KEY non configuré` devrait disparaître.

---

**Date de création :** 2025-01-XX  
**Statut :** ✅ Instructions pour créer le fichier .env

