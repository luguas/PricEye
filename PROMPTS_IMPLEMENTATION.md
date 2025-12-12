# Prompts pour l'Implémentation - Système d'Essai Stripe

Ce document contient tous les prompts nécessaires pour implémenter le système d'essai gratuit avec limite de 10 propriétés.

---

## PROMPT 1 : Configuration des Variables d'Environnement

```
Configure les variables d'environnement Stripe dans le projet.

Backend (PricEyeProject) :
- STRIPE_SECRET_KEY=sk_test_51SXqLnG8ypIuy6LADuLGhncm5V0raUDVWOBLt7pnftPE2cbKxaE6fFvFdf539GUvIPKql5b0WPNjNDtC5GCMe2Sm006axjPD05
- STRIPE_PRODUCT_PRINCIPAL_ID=prod_TUq3ZQwDAhpeIE
- STRIPE_PRODUCT_CHILD_ID=prod_TUq4pDV3LDv4ec
- STRIPE_PRICE_PRINCIPAL_ID=price_1SXqNeG8ypIuy6LAL1GVrUW2
- STRIPE_PRICE_CHILD_ID=price_1SXqNuG8ypIuy6LALQjrv9JF

Frontend (PricEye-frontend) :
- VITE_STRIPE_PUBLIC_KEY=pk_test_51SXqLnG8ypIuy6LARlB49xAiphTudIodq9BFRda7lbrYCMUF5uIB7KBAgLBvrmg8gb30f2Cb5el7JsknEGSh6g5s00hEhg8wLd

Vérifie que le fichier .env existe et ajoute ces variables. Si le fichier n'existe pas, crée-le.
```

---

## PROMPT 2 : Installation des Dépendances Stripe Frontend

```
Installe la dépendance @stripe/stripe-js dans le projet frontend PricEye-frontend.

Exécute la commande npm install @stripe/stripe-js dans le dossier PricEye-frontend.
```

---

## PROMPT 3 : Créer le Composant StripePaymentForm

```
Crée un composant React StripePaymentForm.jsx dans PricEye-frontend/src/components/ qui permet de collecter les informations de carte bancaire.

Le composant doit :
1. Utiliser @stripe/stripe-js pour initialiser Stripe avec la clé publique depuis les variables d'environnement
2. Utiliser les Elements de Stripe pour créer un formulaire de paiement sécurisé
3. Avoir un champ pour le nom du titulaire de la carte
4. Avoir un champ CardElement de Stripe pour la carte
5. Avoir un bouton de soumission qui crée un PaymentMethod
6. Exposer une fonction onSuccess qui retourne le paymentMethodId
7. Gérer les erreurs et afficher les messages d'erreur Stripe
8. Avoir un design cohérent avec le reste de l'application (fond gris foncé, style moderne)

Le composant doit être en français et suivre le style de l'application existante.
```

---

## PROMPT 4 : Modifier RegisterPage pour Intégrer Stripe

```
Modifie RegisterPage.jsx pour intégrer le composant StripePaymentForm.

Modifications à faire :
1. Importer StripePaymentForm
2. Ajouter un état pour gérer l'affichage du formulaire de paiement (afficher après la création du compte)
3. Après la création réussie du compte (register), afficher le formulaire Stripe
4. Quand le formulaire Stripe est soumis avec succès, appeler une nouvelle fonction API createSubscription avec le paymentMethodId
5. Afficher un message de chargement pendant la création de l'abonnement
6. En cas de succès, afficher un message de confirmation et rediriger vers la page de connexion
7. Gérer les erreurs (carte refusée, etc.) avec des messages clairs en français

Le flux doit être : Inscription → Création compte → Formulaire carte → Création abonnement → Confirmation
```

---

## PROMPT 5 : Créer l'API Frontend pour createSubscription

```
Ajoute une fonction createSubscription dans PricEye-frontend/src/services/api.js.

La fonction doit :
1. Prendre en paramètre paymentMethodId (string)
2. Faire un POST vers /api/subscriptions/create avec le paymentMethodId dans le body
3. Utiliser le token d'authentification si disponible
4. Retourner la réponse du serveur
5. Gérer les erreurs et les propager

Signature : export function createSubscription(paymentMethodId, token)
```

---

## PROMPT 6 : Créer l'Endpoint Backend createSubscription

```
Crée une route POST /api/subscriptions/create dans PricEyeProject/server.js.

Cette route doit :
1. Être sécurisée avec authenticateToken
2. Récupérer le paymentMethodId depuis req.body
3. Récupérer les informations de l'utilisateur (userId, email, name) depuis req.user et Firestore
4. Utiliser stripeManager.getOrCreateStripeCustomer pour créer/récupérer le customer Stripe
5. Créer un abonnement Stripe avec :
   - trial_period_days: 30
   - Quantités initiales : quantityPrincipal: 0, quantityChild: 0 (aucune propriété au départ)
   - Le paymentMethodId attaché au customer
6. Enregistrer dans Firestore (document users/{userId}) :
   - stripeCustomerId
   - stripeSubscriptionId
   - subscriptionStatus: "trialing"
   - isTrialActive: true
   - trialEndDate: (calculé depuis la date de création + 30 jours)
   - propertyLimit: 10
7. Retourner un succès avec les informations de l'abonnement

Gérer tous les cas d'erreur (carte invalide, erreur Stripe, etc.) avec des messages clairs.
```

---

## PROMPT 7 : Modifier stripeManager.createSubscription

```
Modifie la fonction createSubscription dans PricEyeProject/integrations/stripeManager.js pour supporter des quantités à 0.

La fonction doit :
1. Accepter des quantités à 0 (quantityPrincipal: 0, quantityChild: 0)
2. Si toutes les quantités sont à 0, créer quand même l'abonnement avec un seul item (principal avec quantité 1 minimum, ou gérer le cas spécial)
3. OU créer l'abonnement sans items et les ajouter plus tard quand des propriétés sont ajoutées

Option recommandée : Créer l'abonnement avec quantityPrincipal: 1 même si on n'a pas de propriétés, car Stripe nécessite au moins un item. On ajustera les quantités réelles lors du premier ajout de propriété.
```

---

## PROMPT 8 : Créer la Fonction checkPropertyLimit

```
Crée une fonction checkPropertyLimit dans PricEyeProject/server.js.

La fonction doit :
1. Prendre en paramètres : userId (string), newPropertyCount (number), db (Firestore instance)
2. Récupérer le document utilisateur depuis Firestore
3. Vérifier si l'utilisateur a un abonnement Stripe (stripeSubscriptionId)
4. Si pas d'abonnement, retourner { allowed: false, reason: "NO_SUBSCRIPTION", isTrial: false }
5. Récupérer le statut de l'abonnement depuis Stripe (status === 'trialing' ou 'active')
6. Compter le nombre total de propriétés actuelles de l'utilisateur (via teamId)
7. Calculer le total : propriétés actuelles + newPropertyCount
8. Si isTrial === true ET total > 10 :
   - Retourner { allowed: false, reason: "TRIAL_LIMIT_EXCEEDED", isTrial: true, currentCount: X, totalCount: total }
9. Sinon :
   - Retourner { allowed: true, isTrial: isTrial, currentCount: X, totalCount: total }

Signature : async function checkPropertyLimit(userId, newPropertyCount, db)
```

---

## PROMPT 9 : Créer la Fonction getTotalPropertyCount

```
Crée une fonction utilitaire getTotalPropertyCount dans PricEyeProject/server.js.

La fonction doit :
1. Prendre en paramètres : userId (string), db (Firestore instance)
2. Récupérer le document utilisateur pour obtenir le teamId
3. Compter toutes les propriétés où teamId === teamId de l'utilisateur
4. Retourner le nombre total (number)

Signature : async function getTotalPropertyCount(userId, db)
```

---

## PROMPT 10 : Créer la Fonction isUserInTrial

```
Crée une fonction utilitaire isUserInTrial dans PricEyeProject/server.js.

La fonction doit :
1. Prendre en paramètres : userId (string), db (Firestore instance)
2. Récupérer le document utilisateur depuis Firestore
3. Vérifier si stripeSubscriptionId existe
4. Si oui, récupérer l'abonnement depuis Stripe
5. Retourner true si subscription.status === 'trialing', false sinon
6. Si pas d'abonnement, retourner false

Signature : async function isUserInTrial(userId, db)
```

---

## PROMPT 11 : Modifier la Route POST /api/properties

```
Modifie la route POST /api/properties dans PricEyeProject/server.js pour vérifier la limite avant d'ajouter une propriété.

Ajouter AVANT la création de la propriété :
1. Appeler checkPropertyLimit(userId, 1, db) pour vérifier si on peut ajouter 1 propriété
2. Si allowed === false ET isTrial === true :
   - Retourner une erreur 403 avec :
     {
       error: "PROPERTY_LIMIT_EXCEEDED",
       message: "Vous dépassez la limite gratuite de 10 propriétés. Pour continuer, vous devez activer la facturation.",
       currentCount: result.currentCount,
       totalCount: result.totalCount,
       isTrial: true
     }
3. Si allowed === false ET isTrial === false :
   - Retourner une erreur 403 avec un message approprié (abonnement inactif, etc.)
4. Si allowed === true :
   - Continuer normalement avec la création de la propriété
   - Après la création, appeler recalculateAndUpdateBilling comme avant

Ne PAS créer la propriété si la limite est dépassée en période d'essai.
```

---

## PROMPT 12 : Modifier la Route POST /api/integrations/import-properties

```
Modifie la route POST /api/integrations/import-properties dans PricEyeProject/server.js pour vérifier la limite avant d'importer.

Ajouter AVANT l'import en batch :
1. Calculer le nombre de propriétés à importer : propertiesToImport.length
2. Appeler checkPropertyLimit(userId, propertiesToImport.length, db)
3. Si allowed === false ET isTrial === true :
   - Retourner une erreur 403 avec :
     {
       error: "PROPERTY_LIMIT_EXCEEDED",
       message: "Vous dépassez la limite gratuite de 10 propriétés. Pour continuer, vous devez activer la facturation.",
       currentCount: result.currentCount,
       totalCount: result.totalCount,
       isTrial: true,
       wouldImport: propertiesToImport.length
     }
4. Si allowed === false ET isTrial === false :
   - Retourner une erreur appropriée
5. Si allowed === true :
   - Continuer normalement avec l'import
   - Après l'import, appeler recalculateAndUpdateBilling

Ne PAS importer les propriétés si la limite est dépassée en période d'essai.
```

---

## PROMPT 13 : Créer le Composant TrialLimitModal

```
Crée un composant React TrialLimitModal.jsx dans PricEye-frontend/src/components/.

Le composant doit :
1. Afficher une modale avec :
   - Un titre : "Limite d'essai atteinte"
   - Un message : "Vous avez atteint la limite de 10 propriétés gratuites. Pour ajouter plus de propriétés, vous devez activer la facturation maintenant."
   - Des informations : "Propriétés actuelles : X / 10"
   - Deux boutons :
     * "Confirmer et Payer" (principal, bleu)
     * "Annuler" (secondaire, gris)
2. Avoir une prop onConfirm qui sera appelée quand l'utilisateur clique sur "Confirmer et Payer"
3. Avoir une prop onCancel qui sera appelée quand l'utilisateur clique sur "Annuler"
4. Avoir une prop isOpen pour contrôler l'affichage
5. Avoir une prop currentCount pour afficher le nombre de propriétés actuelles
6. Utiliser le style de l'application (fond gris foncé, modale centrée)
7. Afficher un loader pendant le traitement si nécessaire

Le design doit être cohérent avec AlertModal.jsx existant.
```

---

## PROMPT 14 : Créer l'API Frontend activateBilling

```
Ajoute une fonction activateBilling dans PricEye-frontend/src/services/api.js.

La fonction doit :
1. Faire un POST vers /api/subscriptions/activate-billing
2. Utiliser le token d'authentification
3. Retourner la réponse du serveur
4. Gérer les erreurs

Signature : export function activateBilling(token)
```

---

## PROMPT 15 : Créer l'Endpoint Backend activateBilling

```
Crée une route POST /api/subscriptions/activate-billing dans PricEyeProject/server.js.

Cette route doit :
1. Être sécurisée avec authenticateToken
2. Récupérer userId depuis req.user
3. Vérifier que l'utilisateur a un abonnement Stripe actif
4. Vérifier que l'utilisateur est en période d'essai (status === 'trialing')
5. Récupérer toutes les propriétés de l'utilisateur
6. Calculer les nouvelles quantités avec calculateBillingQuantities
7. Mettre à jour l'abonnement Stripe avec :
   - Les nouvelles quantités (via updateSubscriptionQuantities)
   - trial_end: 'now' (pour arrêter l'essai immédiatement)
   - billing_cycle_anchor: 'now' (pour facturer immédiatement)
8. Forcer la génération d'une facture immédiate avec stripe.invoices.create
9. Mettre à jour Firestore :
   - subscriptionStatus: "active"
   - isTrialActive: false
   - trialEndDate: null
10. Retourner un succès avec les informations mises à jour

Gérer tous les cas d'erreur (pas d'abonnement, pas en essai, erreur Stripe, etc.)
```

---

## PROMPT 16 : Modifier stripeManager pour Activer la Facturation

```
Ajoute une fonction activateBillingAndUpdateQuantities dans PricEyeProject/integrations/stripeManager.js.

La fonction doit :
1. Prendre en paramètres : subscriptionId (string), quantities (object avec quantityPrincipal et quantityChild)
2. Mettre à jour l'abonnement Stripe avec :
   - Les nouvelles quantités (via items)
   - trial_end: 'now'
   - billing_cycle_anchor: 'now'
3. Forcer la création d'une facture immédiate avec stripe.invoices.create
4. Retourner l'abonnement mis à jour et la facture créée

Signature : async function activateBillingAndUpdateQuantities(subscriptionId, quantities)
```

---

## PROMPT 17 : Modifier PropertyModal pour Gérer le Blocage

```
Modifie PropertyModal.jsx pour intercepter l'erreur PROPERTY_LIMIT_EXCEEDED et afficher TrialLimitModal.

Modifications :
1. Importer TrialLimitModal et activateBilling depuis api.js
2. Ajouter un état pour gérer l'affichage de TrialLimitModal
3. Dans le catch de handleSubmit (après addProperty), vérifier si l'erreur contient "PROPERTY_LIMIT_EXCEEDED"
4. Si oui, afficher TrialLimitModal avec les informations de l'erreur
5. Dans onConfirm du modal :
   - Appeler activateBilling(token)
   - En cas de succès, réessayer addProperty
   - Afficher un message de succès
6. Dans onCancel, fermer le modal

Gérer les états de chargement et les erreurs.
```

---

## PROMPT 18 : Modifier PropertySyncModal pour Gérer le Blocage

```
Modifie PropertySyncModal.jsx pour intercepter l'erreur PROPERTY_LIMIT_EXCEEDED et afficher TrialLimitModal.

Modifications similaires à PropertyModal :
1. Importer TrialLimitModal et activateBilling
2. Ajouter un état pour TrialLimitModal
3. Dans le catch de handleImport, vérifier si l'erreur contient "PROPERTY_LIMIT_EXCEEDED"
4. Si oui, afficher TrialLimitModal
5. Dans onConfirm, appeler activateBilling puis réessayer l'import
6. Gérer les états de chargement

Le modal doit afficher le nombre de propriétés qui seraient importées.
```

---

## PROMPT 19 : Modifier recalculateAndUpdateBilling pour Gérer l'Essai

```
Modifie la fonction recalculateAndUpdateBilling dans PricEyeProject/server.js pour gérer correctement la période d'essai.

Modifications :
1. Vérifier si l'utilisateur est en période d'essai (via isUserInTrial)
2. Si en essai :
   - Mettre à jour les quantités dans Stripe (même en essai, on met à jour pour suivre)
   - Ne PAS facturer (c'est automatique avec Stripe en essai)
3. Si pas en essai :
   - Comportement normal (mise à jour et facturation au prochain cycle)

La fonction doit continuer à fonctionner normalement, mais être consciente du statut d'essai.
```

---

## PROMPT 20 : Ajouter le Handler Webhook trial_will_end

```
Ajoute un handler pour l'événement customer.subscription.trial_will_end dans le webhook Stripe de PricEyeProject/server.js.

Le handler doit :
1. Récupérer le customerId depuis l'événement
2. Récupérer le userId depuis customer.metadata.userId
3. Envoyer une notification à l'utilisateur (email, notification in-app, etc.) pour l'informer que son essai se termine bientôt
4. Optionnellement, mettre à jour Firestore avec une date de rappel

Pour l'instant, logger l'événement et préparer la structure pour les notifications futures.
```

---

## PROMPT 21 : Modifier le Handler subscription.updated

```
Modifie le handler handleSubscriptionUpdated dans PricEyeProject/server.js pour détecter la fin automatique de l'essai.

Le handler doit :
1. Vérifier si subscription.status est passé de 'trialing' à 'active'
2. Si oui, mettre à jour Firestore :
   - subscriptionStatus: "active"
   - isTrialActive: false
   - trialEndDate: null
3. Logger l'événement pour le suivi

S'assurer que le handler existant continue de fonctionner pour les autres cas.
```

---

## PROMPT 22 : Ajouter l'Affichage du Statut d'Essai dans le Dashboard

```
Ajoute un indicateur du statut d'essai dans DashboardPage.jsx ou dans un composant de navigation.

L'indicateur doit :
1. Afficher "Essai gratuit - X jours restants" si en essai
2. Afficher "Abonnement actif" si pas en essai
3. Être visible mais discret (peut être dans la NavBar ou en haut de page)
4. Récupérer les informations depuis le profil utilisateur (getUserProfile)

Optionnel : Ajouter un lien vers une page de gestion d'abonnement.
```

---

## PROMPT 23 : Créer une Fonction pour Récupérer le Statut d'Abonnement

```
Ajoute une fonction getSubscriptionStatus dans PricEye-frontend/src/services/api.js.

La fonction doit :
1. Faire un GET vers /api/subscriptions/status
2. Utiliser le token d'authentification
3. Retourner les informations de l'abonnement (status, isTrial, trialEndDate, etc.)

Signature : export function getSubscriptionStatus(token)
```

---

## PROMPT 24 : Créer l'Endpoint getSubscriptionStatus

```
Crée une route GET /api/subscriptions/status dans PricEyeProject/server.js.

Cette route doit :
1. Être sécurisée avec authenticateToken
2. Récupérer userId depuis req.user
3. Récupérer les informations de l'utilisateur depuis Firestore
4. Si un abonnement existe, récupérer les détails depuis Stripe
5. Retourner :
   {
     hasSubscription: boolean,
     status: string, // "trialing" | "active" | "past_due" | etc.
     isTrialActive: boolean,
     trialEndDate: timestamp | null,
     propertyLimit: number,
     currentPropertyCount: number
   }

Si pas d'abonnement, retourner hasSubscription: false.
```

---

## PROMPT 25 : Tests et Validation

```
Crée un document de tests pour valider le système complet.

Les tests doivent couvrir :
1. Inscription avec carte → Vérifier création abonnement avec essai 30 jours
2. Ajout de 10 propriétés → Vérifier que tout fonctionne
3. Tentative d'ajout de la 11ème propriété → Vérifier blocage et affichage modal
4. Activation de la facturation → Vérifier arrêt essai + facture générée
5. Après activation → Vérifier que l'ajout fonctionne sans limite
6. Import de propriétés → Vérifier que la limite s'applique aussi
7. Fin automatique de l'essai → Vérifier via webhook

Utiliser les cartes de test Stripe :
- 4242 4242 4242 4242 (succès)
- 4000 0000 0000 0002 (refus)

Documenter les résultats et les cas limites.
```

---

## ORDRE D'UTILISATION DES PROMPTS

**Phase 1 - Configuration de base :**
1. PROMPT 1 (Variables d'environnement)
2. PROMPT 2 (Installation dépendances)
3. PROMPT 3 (Composant StripePaymentForm)
4. PROMPT 4 (Modifier RegisterPage)

**Phase 2 - Backend abonnement :**
5. PROMPT 5 (API frontend createSubscription)
6. PROMPT 6 (Endpoint backend createSubscription)
7. PROMPT 7 (Modifier stripeManager.createSubscription)

**Phase 3 - Vérification de limite :**
8. PROMPT 8 (checkPropertyLimit)
9. PROMPT 9 (getTotalPropertyCount)
10. PROMPT 10 (isUserInTrial)
11. PROMPT 11 (Modifier POST /api/properties)
12. PROMPT 12 (Modifier POST /api/integrations/import-properties)

**Phase 4 - Activation facturation :**
13. PROMPT 13 (TrialLimitModal)
14. PROMPT 14 (API frontend activateBilling)
15. PROMPT 15 (Endpoint backend activateBilling)
16. PROMPT 16 (Modifier stripeManager pour activation)

**Phase 5 - Intégration frontend :**
17. PROMPT 17 (Modifier PropertyModal)
18. PROMPT 18 (Modifier PropertySyncModal)

**Phase 6 - Améliorations :**
19. PROMPT 19 (Modifier recalculateAndUpdateBilling)
20. PROMPT 20 (Webhook trial_will_end)
21. PROMPT 21 (Modifier subscription.updated)
22. PROMPT 22 (Affichage statut essai)
23. PROMPT 23 (API getSubscriptionStatus)
24. PROMPT 24 (Endpoint getSubscriptionStatus)

**Phase 7 - Tests :**
25. PROMPT 25 (Tests et validation)

---

## NOTES IMPORTANTES

- Utilisez ces prompts dans l'ordre recommandé
- Testez chaque étape avant de passer à la suivante
- Vérifiez les logs serveur et les erreurs console
- Utilisez le mode test de Stripe pour tous les tests
- Configurez le webhook secret dans Stripe Dashboard une fois le webhook déployé




