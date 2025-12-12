# ✅ Phase 3 : Sécurité & Limites - TERMINÉE

## 📦 Fichiers modifiés

### Fichier principal :
- **`server.js`** - Ajout des vérifications de limite, géofencing et endpoint de fin d'essai anticipé

---

## ✅ Fonctionnalités implémentées

### 1. Limite de 10 Propriétés pendant l'Essai Gratuit

**Fonction helper :** `checkTrialPropertyLimit(userId, subscriptionId, currentPropertyCount, newPropertiesCount, db)`

**Logique :**
- ✅ Vérifie si l'utilisateur est en période d'essai
- ✅ Compte le nombre total de propriétés (actuelles + nouvelles)
- ✅ Retourne une erreur structurée si la limite de 10 est dépassée

**Routes modifiées :**
- ✅ `POST /api/properties` - Ajout manuel de propriété
- ✅ `POST /api/integrations/import-properties` - Import depuis PMS

**Réponse d'erreur :**
```json
{
  "error": "LIMIT_EXCEEDED",
  "message": "Vous dépassez la limite gratuite de 10 propriétés.",
  "currentCount": 10,
  "maxAllowed": 10,
  "requiresPayment": true
}
```

---

### 2. Endpoint de Fin d'Essai Anticipée

**Route :** `POST /api/subscriptions/end-trial-and-bill`  
**Authentification :** Requis (Bearer token)

**Fonctionnalités :**
- ✅ Vérifie que l'utilisateur est en période d'essai
- ✅ Recalcule les quantités Parent/Enfant avec toutes les propriétés
- ✅ Met à jour l'abonnement Stripe :
  - Quantités mises à jour
  - Essai terminé immédiatement (`trial_end: 'now'`)
  - Facturation immédiate avec proration (`proration_behavior: 'always_invoice'`)
- ✅ Génère et finalise la facture immédiatement
- ✅ Met à jour le profil utilisateur

**Réponse :**
```json
{
  "message": "Essai terminé et facturation effectuée avec succès",
  "subscriptionId": "sub_...",
  "invoiceId": "in_...",
  "status": "active"
}
```

**Exemple d'utilisation (Frontend) :**
```javascript
// Quand l'utilisateur accepte de payer après avoir dépassé la limite
const response = await fetch('/api/subscriptions/end-trial-and-bill', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

const result = await response.json();
// L'essai est terminé et la facture est prélevée immédiatement
```

---

### 3. Géofencing pour Anti-Fraude des Groupes

**Fonction helper :** `calculateDistance(lat1, lon1, lat2, lon2)`

**Logique :**
- ✅ Utilise la formule Haversine pour calculer la distance entre deux points
- ✅ Retourne la distance en mètres
- ✅ Vérifie que les propriétés d'un groupe sont à moins de 500m les unes des autres

**Route modifiée :**
- ✅ `PUT /api/groups/:id/properties` - Ajout de propriétés à un groupe

**Vérification :**
- ✅ Récupère la première propriété du groupe (référence)
- ✅ Pour chaque nouvelle propriété, calcule la distance
- ✅ Si distance > 500m, retourne une erreur

**Réponse d'erreur :**
```json
{
  "error": "GEO_FENCING_VIOLATION",
  "message": "Les propriétés d'un groupe doivent être à moins de 500m les unes des autres.",
  "distance": 1250,
  "maxDistance": 500
}
```

**Support des formats de localisation :**
- Format objet : `{ latitude: 48.8566, longitude: 2.3522 }`
- Format string : `"48.8566,2.3522"`

---

## 🔄 Flux complet

### Scénario 1 : Ajout de propriété pendant l'essai (≤ 10 propriétés)

1. Utilisateur ajoute une propriété
2. Backend vérifie la limite
3. Si ≤ 10 : ✅ Ajout autorisé
4. Si > 10 : ❌ Erreur `LIMIT_EXCEEDED`

### Scénario 2 : Dépassement de limite et paiement

1. Utilisateur tente d'ajouter la 11ème propriété
2. Backend retourne `LIMIT_EXCEEDED`
3. Frontend affiche popup : "Vous dépassez la limite gratuite. Pour continuer, vous devez activer la facturation maintenant."
4. Utilisateur clique sur "Confirmer et Payer"
5. Frontend appelle `POST /api/subscriptions/end-trial-and-bill`
6. Backend :
   - Termine l'essai immédiatement
   - Met à jour les quantités
   - Facture immédiatement
7. ✅ Propriété ajoutée avec succès

### Scénario 3 : Création de groupe avec géofencing

1. Utilisateur crée un groupe
2. Utilisateur ajoute la première propriété (référence)
3. Utilisateur tente d'ajouter une deuxième propriété
4. Backend calcule la distance
5. Si distance ≤ 500m : ✅ Ajout autorisé
6. Si distance > 500m : ❌ Erreur `GEO_FENCING_VIOLATION`

---

## 🧪 Tests à effectuer

### Test 1 : Limite de 10 propriétés
```bash
# Ajouter 10 propriétés (OK)
# Tenter d'ajouter la 11ème (erreur LIMIT_EXCEEDED)
```

### Test 2 : Fin d'essai anticipée
```bash
# Avec un compte en essai ayant 10 propriétés
curl -X POST http://localhost:5000/api/subscriptions/end-trial-and-bill \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Vérifications :**
- ✅ L'abonnement passe de `trialing` à `active`
- ✅ Une facture est générée et prélevée
- ✅ Le profil utilisateur est mis à jour

### Test 3 : Géofencing
```bash
# Créer un groupe avec 2 propriétés distantes de > 500m
# Vérifier que l'ajout est refusé avec erreur GEO_FENCING_VIOLATION
```

**Coordonnées de test :**
- Paris : 48.8566, 2.3522
- Lyon : 45.7640, 4.8357 (Distance : ~392 km, devrait être refusé)

---

## 📝 Notes importantes

1. **Distance calculée** : La formule Haversine calcule la distance "à vol d'oiseau" (grand cercle)
2. **Format de localisation** : Le code supporte plusieurs formats, mais il est recommandé d'utiliser le format objet `{ latitude, longitude }`
3. **Proration** : Lors de la fin d'essai anticipée, Stripe calcule automatiquement le prorata pour le reste du mois
4. **Facturation immédiate** : La facture est générée et prélevée immédiatement après la fin d'essai

---

## 🚀 Prochaines étapes

Une fois la Phase 3 validée, vous pouvez passer à la **Phase 4 : Gestion de la Facturation**.

Voir le document `PLAN_ROUTE_BILLING_STRIPE.md` pour la suite.

---

## 📋 Checklist de validation

- [ ] Limite de 10 propriétés fonctionnelle dans `POST /api/properties`
- [ ] Limite de 10 propriétés fonctionnelle dans `POST /api/integrations/import-properties`
- [ ] Erreur `LIMIT_EXCEEDED` retournée correctement
- [ ] Endpoint `POST /api/subscriptions/end-trial-and-bill` fonctionnel
- [ ] Essai terminé et facturation immédiate fonctionnels
- [ ] Géofencing fonctionnel dans `PUT /api/groups/:id/properties`
- [ ] Erreur `GEO_FENCING_VIOLATION` retournée correctement
- [ ] Test avec propriétés distantes de > 500m (refusé)
- [ ] Test avec propriétés distantes de < 500m (autorisé)

---

**Date de complétion :** 2025-01-XX  
**Statut :** ✅ Phase 3 terminée - Prêt pour Phase 4


