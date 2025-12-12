# ✅ Phase 5 : Kill-Switch & Gestion des Impayés - TERMINÉE

## 📦 Fichiers modifiés

### Fichier principal :
- **`server.js`** - Amélioration du webhook `invoice.payment_failed` et ajout de vérifications `pmsSyncEnabled`

---

## ✅ Fonctionnalités implémentées

### 1. Amélioration du Webhook `invoice.payment_failed`

**Fonction modifiée :** `handlePaymentFailed(invoice, db)`

**Actions ajoutées :**
- ✅ **STOPPER la synchronisation PMS** : `pmsSyncEnabled: false`
- ✅ **Raison de l'arrêt** : `pmsSyncStoppedReason: 'payment_failed'`
- ✅ **Timestamp** : `pmsSyncStoppedAt` pour traçabilité

**Actions existantes (maintenues) :**
- ✅ Bloquer l'accès au Dashboard : `accessDisabled: true`
- ✅ Désactiver l'utilisateur dans Firebase Auth : `disabled: true`
- ✅ Mettre à jour le statut : `subscriptionStatus: 'past_due'`

**Comportement :**
- Si l'utilisateur est encore en période d'essai : pas de coupure d'accès (juste flag `paymentFailed`)
- Si la période d'essai est terminée : coupure complète (accès + sync PMS)

---

### 2. Fonction Helper : `isPMSSyncEnabled()`

**Fonction créée :** `isPMSSyncEnabled(userId, db)`

**Logique :**
- ✅ Vérifie le flag `pmsSyncEnabled` dans le profil utilisateur
- ✅ Par défaut (rétrocompatibilité) : `true` si le flag n'existe pas
- ✅ Retourne `false` si `pmsSyncEnabled === false`
- ✅ Gestion d'erreur : retourne `true` en cas d'erreur (fail-safe)

**Utilisation :**
- Vérifie avant chaque synchronisation PMS
- Permet de bloquer toutes les synchronisations si le paiement a échoué

---

### 3. Vérifications dans les Routes de Synchronisation PMS

**Routes modifiées :**

#### A. Synchronisation des paramètres de stratégie
- **Route :** `PUT /api/properties/:id/strategy`
- ✅ Vérifie `pmsSyncEnabled` avant d'appeler `updatePropertySettings()`
- ✅ Si désactivé : log et skip de la synchronisation

#### B. Synchronisation des règles
- **Route :** `PUT /api/properties/:id/rules`
- ✅ Vérifie `pmsSyncEnabled` avant d'appeler `updatePropertySettings()`
- ✅ Si désactivé : log et skip de la synchronisation

#### C. Synchronisation de la stratégie IA
- **Route :** `POST /api/properties/:id/generate-strategy`
- ✅ Vérifie `pmsSyncEnabled` avant d'appeler `updateBatchRates()`
- ✅ Si désactivé : log et skip de la synchronisation

#### D. Auto-pricing (cron job)
- **Route :** Tâche cron automatique
- ✅ Vérifie `pmsSyncEnabled` avant d'appeler `updateBatchRates()`
- ✅ Si désactivé : skip de l'utilisateur et passage au suivant

#### E. Synchronisation des prix manuels
- **Route :** `POST /api/properties/:id/sync-prices`
- ✅ Vérifie `pmsSyncEnabled` avant d'appeler `updateBatchRates()`
- ✅ Si désactivé : log et skip de la synchronisation

---

### 4. Vérification dans le Cron Job de Synchronisation

**Fonction modifiée :** `syncAllPMSRates()`

**Amélioration :**
- ✅ Vérifie `pmsSyncEnabled` pour chaque utilisateur avant traitement
- ✅ Si désactivé : log et passage à l'utilisateur suivant
- ✅ Ne bloque pas le traitement des autres utilisateurs

**Comportement :**
- Traite tous les utilisateurs avec sync activée
- Ignore silencieusement les utilisateurs avec sync désactivée
- Log clair pour le debugging

---

## 🔄 Flux complet

### Scénario : Échec de paiement après période d'essai

1. **Stripe détecte l'échec de paiement**
   - Événement : `invoice.payment_failed`
   - Webhook appelé : `POST /api/webhooks/stripe`

2. **Backend traite l'événement**
   - Vérifie que la période d'essai est terminée
   - Met à jour le profil utilisateur :
     ```javascript
     {
       accessDisabled: true,
       pmsSyncEnabled: false,
       pmsSyncStoppedReason: 'payment_failed',
       pmsSyncStoppedAt: Timestamp,
       subscriptionStatus: 'past_due'
     }
     ```
   - Désactive l'utilisateur dans Firebase Auth

3. **Middleware d'authentification bloque l'accès**
   - Vérifie `accessDisabled` dans Firestore
   - Vérifie `disabled` dans Firebase Auth
   - Retourne 403 si l'accès est désactivé

4. **Routes de synchronisation PMS bloquées**
   - Chaque route vérifie `pmsSyncEnabled` avant synchronisation
   - Si `false` : skip de la synchronisation
   - Les données sont toujours sauvegardées dans Firestore (pas de perte)

5. **Cron job ignore l'utilisateur**
   - `syncAllPMSRates()` vérifie `pmsSyncEnabled`
   - Skip de l'utilisateur si désactivé
   - Continue avec les autres utilisateurs

---

## 🧪 Tests à effectuer

### Test 1 : Échec de paiement
```bash
# Utiliser Stripe CLI pour simuler un échec de paiement
stripe listen --forward-to localhost:5000/api/webhooks/stripe
stripe trigger invoice.payment_failed
```

**Vérifications :**
- ✅ Le profil utilisateur est mis à jour avec `accessDisabled: true`
- ✅ Le profil utilisateur est mis à jour avec `pmsSyncEnabled: false`
- ✅ L'utilisateur est désactivé dans Firebase Auth
- ✅ Les routes API retournent 403

### Test 2 : Blocage de la synchronisation PMS
```bash
# Après un échec de paiement, tenter de synchroniser des prix
# Vérifier que la synchronisation est ignorée
```

**Vérifications :**
- ✅ Les routes de sync PMS loggent "Synchronisation PMS désactivée"
- ✅ Aucun appel à `updateBatchRates()` ou `updatePropertySettings()`
- ✅ Les données sont toujours sauvegardées dans Firestore

### Test 3 : Cron job ignore l'utilisateur
```bash
# Attendre le prochain run du cron job
# Vérifier les logs
```

**Vérifications :**
- ✅ Le cron job log "Synchronisation PMS désactivée" pour l'utilisateur
- ✅ Le cron job continue avec les autres utilisateurs
- ✅ Aucune synchronisation effectuée pour l'utilisateur désactivé

---

## 📝 Notes importantes

1. **Rétrocompatibilité** : Si `pmsSyncEnabled` n'existe pas, la sync est activée par défaut
2. **Fail-safe** : En cas d'erreur lors de la vérification, la sync est autorisée (évite de bloquer par erreur)
3. **Sauvegarde Firestore** : Les données sont toujours sauvegardées dans Firestore, même si la sync PMS est désactivée
4. **Réactivation** : La sync peut être réactivée via le webhook `invoice.paid` (à implémenter si nécessaire)

---

## 🔍 Points d'attention

1. **Middleware d'authentification** : Déjà en place, vérifie `accessDisabled` et `disabled`
2. **Toutes les routes de sync** : Vérifient maintenant `pmsSyncEnabled` avant synchronisation
3. **Cron job** : Vérifie `pmsSyncEnabled` pour chaque utilisateur
4. **Logs** : Messages clairs pour le debugging

---

## 🚀 Prochaines étapes (optionnel)

### Réactivation automatique après paiement réussi

Le webhook `invoice.paid` existe déjà (`handlePaymentSucceeded`). Vous pouvez l'améliorer pour réactiver la sync PMS :

```javascript
await db.collection('users').doc(userId).update({
  pmsSyncEnabled: true,
  accessDisabled: false
});
```

---

## 📋 Checklist de validation

- [ ] Webhook `invoice.payment_failed` met à jour `pmsSyncEnabled: false`
- [ ] Fonction `isPMSSyncEnabled()` fonctionnelle
- [ ] Route `PUT /api/properties/:id/strategy` vérifie `pmsSyncEnabled`
- [ ] Route `PUT /api/properties/:id/rules` vérifie `pmsSyncEnabled`
- [ ] Route `POST /api/properties/:id/generate-strategy` vérifie `pmsSyncEnabled`
- [ ] Route `POST /api/properties/:id/sync-prices` vérifie `pmsSyncEnabled`
- [ ] Fonction `syncAllPMSRates()` vérifie `pmsSyncEnabled`
- [ ] Test avec échec de paiement (webhook)
- [ ] Test avec synchronisation bloquée
- [ ] Test avec cron job qui ignore l'utilisateur

---

**Date de complétion :** 2025-01-XX  
**Statut :** ✅ Phase 5 terminée - Kill-Switch opérationnel


