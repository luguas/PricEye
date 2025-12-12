# ✅ Phase 4 : Gestion de la Facturation - TERMINÉE

## 📦 Fichiers modifiés

### Fichier principal :
- **`server.js`** - Modification de `recalculateAndUpdateBilling()` et ajout de l'endpoint Customer Portal

---

## ✅ Fonctionnalités implémentées

### 1. Ajout de Propriété en Cours de Mois (Facturation Complète)

**Fonction modifiée :** `recalculateAndUpdateBilling(userId, db)`

**Logique implémentée :**

#### A. Détection de la période d'essai
- ✅ Si l'utilisateur est en période d'essai : mise à jour des quantités uniquement (pas de facturation)
- ✅ Si l'utilisateur n'est plus en essai : gestion du rattrapage

#### B. Calcul des augmentations
- ✅ Compare les quantités actuelles dans l'abonnement avec les nouvelles quantités
- ✅ Détecte les augmentations (nouvelles propriétés ajoutées)
- ✅ Calcule séparément les augmentations pour les propriétés parentes et enfants

#### C. Mise à jour de l'abonnement (mois suivant)
- ✅ Met à jour les quantités dans l'abonnement avec `proration_behavior: 'none'`
- ✅ Les changements prennent effet au prochain cycle de facturation
- ✅ Pas de facturation immédiate via cette mise à jour

#### D. Création d'invoice items (rattrapage mois en cours)
- ✅ Si augmentation détectée, crée des invoice items pour le mois en cours
- ✅ Prix plein appliqué :
  - Propriété parente : **13.99€** (1399 centimes)
  - Propriété enfant : **3.99€** (399 centimes)
- ✅ Description claire : "Rattrapage - Ajout de X propriété(s) en cours de mois"
- ✅ Metadata incluse pour traçabilité

**Comportement :**
- Les invoice items s'ajoutent à la prochaine facture
- **SAUF** si le billing threshold est atteint → facturation immédiate

---

### 2. Stripe Customer Portal

**Route :** `POST /api/billing/portal-session`  
**Authentification :** Requis (Bearer token)

**Fonctionnalités :**
- ✅ Vérifie que l'utilisateur a un `stripeCustomerId`
- ✅ Crée une session Stripe Customer Portal
- ✅ Retourne l'URL de redirection

**Ce que le client peut faire dans le portal :**
- ✅ Mettre à jour sa carte bancaire
- ✅ Télécharger ses factures
- ✅ Voir l'historique des paiements
- ✅ Gérer son abonnement (annuler, modifier)
- ✅ Mettre à jour ses informations de facturation

**Réponse :**
```json
{
  "url": "https://billing.stripe.com/p/session/..."
}
```

**Exemple d'utilisation (Frontend) :**
```javascript
// Quand l'utilisateur clique sur "Gérer mon abonnement"
const response = await fetch('/api/billing/portal-session', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

const { url } = await response.json();
window.location.href = url; // Redirection vers le portal Stripe
```

---

## 🔄 Flux complet

### Scénario : Ajout d'une propriété le 20 du mois

1. **Utilisateur ajoute une propriété** (le 20 du mois)
   - Route : `POST /api/properties`
   - Propriété ajoutée dans Firestore

2. **Backend appelle `recalculateAndUpdateBilling()`**
   - Détecte que l'utilisateur n'est plus en essai
   - Compare les quantités : anciennes vs nouvelles
   - Détecte une augmentation (ex: +1 propriété parente)

3. **Action 1 : Mise à jour de l'abonnement (mois suivant)**
   ```
   stripe.subscriptions.update({
     items: [{ id: principalItem.id, quantity: nouvelleQuantité }],
     proration_behavior: 'none' // Pas de proration
   })
   ```
   - Les quantités sont mises à jour
   - Prendra effet au prochain cycle (1er du mois suivant)

4. **Action 2 : Création d'invoice item (rattrapage mois en cours)**
   ```
   stripe.invoiceItems.create({
     customer: customerId,
     amount: 1399, // 13.99€ en centimes
     description: "Rattrapage - Ajout de 1 propriété(s) principale(s) en cours de mois"
   })
   ```
   - Invoice item créé
   - S'ajoutera à la prochaine facture

5. **Comportement selon le billing threshold :**
   - **Si seuil non atteint** : L'invoice item attendra la prochaine facture mensuelle
   - **Si seuil atteint** : Stripe génère et prélève immédiatement la facture

---

## 📝 Configuration des Billing Thresholds

**À configurer manuellement dans Stripe Dashboard :**

1. Allez sur https://dashboard.stripe.com/test/settings/billing
2. Activez **"Automatically collect payment"**
3. Configurez le **Billing threshold** (ex: 50€)
4. Configurez l'action en cas d'échec : **"Pause subscription"**

**Comportement :**
- Si la dette cumulée (invoice items) dépasse le seuil → facturation immédiate
- Si le paiement échoue → service coupé (via webhook `invoice.payment_failed`)

---

## 🧪 Tests à effectuer

### Test 1 : Ajout de propriété en cours de mois
```bash
# 1. Créer un compte avec abonnement actif (pas en essai)
# 2. Ajouter une propriété le 20 du mois
# 3. Vérifier dans Stripe Dashboard :
#    - L'abonnement est mis à jour (quantités pour le mois suivant)
#    - Un invoice item est créé (rattrapage mois en cours)
```

**Vérifications :**
- ✅ Invoice item créé avec le bon montant (13.99€ ou 3.99€)
- ✅ Description correcte
- ✅ Metadata présente

### Test 2 : Customer Portal
```bash
# Avec un token valide
curl -X POST http://localhost:5000/api/billing/portal-session \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Vérifications :**
- ✅ URL de session retournée
- ✅ Redirection vers le portal Stripe fonctionnelle
- ✅ Le client peut gérer son abonnement

### Test 3 : Billing Threshold
```bash
# 1. Configurer un billing threshold de 50€ dans Stripe Dashboard
# 2. Ajouter plusieurs propriétés rapidement (pour cumuler > 50€)
# 3. Vérifier que la facture est générée immédiatement
```

---

## 📋 Notes importantes

1. **Prix en centimes** : Les montants sont stockés en centimes (1399 = 13.99€)
2. **Proration** : Pas de proration lors de la mise à jour de l'abonnement (`proration_behavior: 'none'`)
3. **Invoice items** : S'ajoutent à la prochaine facture SAUF si seuil atteint
4. **Metadata** : Chaque invoice item contient des metadata pour traçabilité
5. **Période d'essai** : Pas de facturation pendant l'essai (juste mise à jour des quantités)

---

## 🔍 Points d'attention

1. **Calcul des augmentations** : Seules les augmentations sont facturées (pas les diminutions)
2. **Format des prix** : Vérifier que les prix (13.99€ et 3.99€) correspondent à votre configuration Stripe
3. **Billing threshold** : Configuration manuelle requise dans Stripe Dashboard
4. **Customer Portal** : Nécessite que l'utilisateur ait un `stripeCustomerId`

---

## 🚀 Prochaines étapes

Une fois la Phase 4 validée, vous pouvez passer à la **Phase 5 : Kill-Switch & Gestion des Impayés**.

Voir le document `PLAN_ROUTE_BILLING_STRIPE.md` pour la suite.

---

## 📋 Checklist de validation

- [ ] Fonction `recalculateAndUpdateBilling()` modifiée avec succès
- [ ] Détection de période d'essai fonctionnelle
- [ ] Calcul des augmentations correct
- [ ] Mise à jour de l'abonnement (mois suivant) fonctionnelle
- [ ] Création d'invoice items (rattrapage) fonctionnelle
- [ ] Endpoint `POST /api/billing/portal-session` fonctionnel
- [ ] Customer Portal accessible et fonctionnel
- [ ] Billing threshold configuré dans Stripe Dashboard
- [ ] Test avec ajout de propriété en cours de mois
- [ ] Test avec billing threshold (facturation immédiate)

---

**Date de complétion :** 2025-01-XX  
**Statut :** ✅ Phase 4 terminée - Prêt pour Phase 5


