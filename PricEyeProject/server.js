// Importer les modules nécessaires
const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
require('dotenv').config();
const cron = require('node-cron'); 

// Configuration Firebase (nécessaire pour la clé API web)
const firebaseConfig = {
    apiKey: "AIzaSyCqdbT96st3gc9bQ9A4Yk7uxU-Dfuzyiuc",
    authDomain: "priceye-6f81a.firebaseapp.com",
    databaseURL: "https://priceye-6f81a-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "priceye-6f81a",
    storageBucket: "priceye-6f81a.appspot.com",
    messagingSenderId: "244431363759",
    appId: "1:244431363759:web:c2f600581f341fbca63e5a",
    measurementId: "G-QC6JW8HXBE"
};

// --- INITIALISATION DE FIREBASE ADMIN ---
try {
  admin.initializeApp({
    credential: admin.credential.applicationDefault()
  });
  console.log('Connecté à Firebase avec succès.');
} catch (error) {
  console.error('Erreur d\'initialisation de Firebase Admin:', error);
  process.exit(1);
}

const app = express();
const port = process.env.PORT || 5000;

// --- MIDDLEWARES ---

// CORRECTION: Configuration CORS explicite pour la production
const allowedOrigins = [
    'https://priceye.onrender.com',    // L'API elle-même
    'http://localhost:5173',           // Votre app React en local (Vite)
    'http://localhost:3000',
    'https://priceye.vercel.app',
    'https://pric-eye.vercel.app'           // Votre app React en local (CRA)
    // 'https://votre-frontend-sur-vercel.app' // << AJOUTEZ L'URL DE VOTRE FRONTEND DÉPLOYÉ ICI
];

app.use(cors({
    origin: function (origin, callback) {
        // Autoriser les requêtes sans origine (ex: Postman, apps mobiles)
        if (!origin) return callback(null, true);
        
        if (allowedOrigins.indexOf(origin) === -1) {
            const msg = `La politique CORS pour ce site n'autorise pas l'accès depuis l'origine : ${origin}`;
            console.error(msg);
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    }
}));
// Fin de la correction CORS

// IMPORTANT: Configurer le raw body pour le webhook Stripe AVANT express.json()
// Le webhook Stripe nécessite le body brut pour vérifier la signature
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));

// Middleware JSON pour toutes les autres routes
app.use(express.json());

// --- MIDDLEWARE D'AUTHENTIFICATION ---
const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).send({ error: 'Accès non autorisé. Jeton manquant.' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        
        // Vérifier si l'utilisateur est désactivé (accès coupé)
        if (decodedToken.disabled) {
            return res.status(403).send({ error: 'Votre accès a été désactivé. Veuillez contacter le support.' });
        }
        
        // Vérifier également dans Firestore si l'accès est désactivé
        const db = admin.firestore();
        const userDoc = await db.collection('users').doc(decodedToken.uid).get();
        if (userDoc.exists) {
            const userData = userDoc.data();
            if (userData.accessDisabled === true) {
                return res.status(403).send({ 
                    error: 'Votre accès a été désactivé. Veuillez mettre à jour votre moyen de paiement ou contacter le support.' 
                });
            }
        }
        
        req.user = decodedToken; // Ajoute les infos user (uid, email) à la requête
        next();
    } catch (error) {
        console.error('Erreur de vérification du jeton:', error);
        res.status(403).send({ error: 'Jeton invalide ou expiré.' });
    }
};

/**
 * FONCTION D'AUDIT: Enregistre une action dans les logs d'une propriété.
 * @param {string} propertyId - ID de la propriété
 * @param {string} userId - ID de l'utilisateur
 * @param {string} userEmail - Email de l'utilisateur
 * @param {string} action - Description de l'action (ex: "update:details")
 * @param {object} changes - Objet décrivant les changements
 */
async function logPropertyChange(propertyId, userId, userEmail, action, changes) {
  try {
    const db = admin.firestore();
    const logRef = db.collection('properties').doc(propertyId).collection('logs').doc();
    
    // Nettoyer les 'undefined' potentiels
    const cleanChanges = JSON.parse(JSON.stringify(changes || {}));

    await logRef.set({
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      userId: userId,
      userEmail: userEmail || 'Inconnu',
      action: action,
      changes: cleanChanges
    });
    console.log(`Log enregistré pour ${propertyId}: action ${action}`);
  } catch (error) {
    console.error(`Erreur lors de l'enregistrement du log pour ${propertyId}:`, error);
    // Ne pas bloquer la requête principale si le logging échoue
  }
}

/**
 * HELPER PMS: Récupère les identifiants PMS d'un utilisateur et instancie un client.
 * @param {string} userId - L'ID de l'utilisateur
 * @returns {Promise<PMSBase>} - Une instance de l'adaptateur PMS (ex: SmoobuAdapter)
 */
async function getUserPMSClient(userId) {
    const db = admin.firestore();
    // Les intégrations sont stockées sous /users/{userId}/integrations/{pmsType}
    const integrationsRef = db.collection('users').doc(userId).collection('integrations');
    const snapshot = await integrationsRef.limit(1).get(); // Prend la première intégration trouvée

    if (snapshot.empty) {
        throw new Error("Aucun PMS n'est connecté à ce compte.");
    }

    const integrationDoc = snapshot.docs[0];
    const integration = integrationDoc.data();
    const pmsType = integrationDoc.id; // Le type (ex: 'smoobu') est l'ID du document
    const credentials = integration.credentials; // Les identifiants stockés

    if (!pmsType || !credentials) {
         throw new Error("Configuration PMS invalide ou manquante dans Firestore.");
    }

    // Utiliser l'import() dynamique car pmsManager est un module ES6
    const { getPMSClient } = await import('./integrations/pmsManager.js');
    
    // getPMSClient est maintenant asynchrone et doit être attendu
    return await getPMSClient(pmsType, credentials);
}

/**
 * TÂCHE CRON: Synchronise les prix de tous les PMS connectés.
 */
async function syncAllPMSRates() {
    console.log('[PMS Sync] Démarrage de la tâche de synchronisation quotidienne des tarifs...');
    const db = admin.firestore();
    const { getPMSClient } = await import('./integrations/pmsManager.js');

    // 1. Récupérer toutes les connexions PMS actives
    const integrationsSnapshot = await db.collectionGroup('integrations').get();
    if (integrationsSnapshot.empty) {
        console.log('[PMS Sync] Aucune intégration PMS active trouvée. Tâche terminée.');
        return;
    }

    console.log(`[PMS Sync] ${integrationsSnapshot.size} connexions PMS trouvées. Traitement...`);
    
    // Traiter chaque intégration individuellement
    for (const doc of integrationsSnapshot.docs) {
        const userId = doc.ref.parent.parent.id;
        const pmsType = doc.id;
        const credentials = doc.data().credentials;
        const userDoc = await db.collection('users').doc(userId).get();
        const userData = userDoc.data();
        const userEmail = userData?.email || 'email-inconnu';

        // Vérifier si la synchronisation PMS est activée pour cet utilisateur
        if (userData?.pmsSyncEnabled === false) {
            console.log(`[PMS Sync] Synchronisation désactivée pour ${userEmail} (ID: ${userId}). Raison: ${userData.pmsSyncStoppedReason || 'unknown'}`);
            continue; // Passer à l'utilisateur suivant
        }

        console.log(`[PMS Sync] Traitement de ${pmsType} pour ${userEmail} (ID: ${userId})`);

        try {
            // 2. Obtenir le client et les propriétés
            const client = await getPMSClient(pmsType, credentials);
            const properties = await client.getProperties();

            if (!properties || properties.length === 0) {
                console.log(`[PMS Sync] Aucune propriété trouvée pour ${userEmail}.`);
                continue;
            }

            // 3. Pour chaque propriété, calculer et mettre à jour le prix (pour aujourd'hui, en mock)
            const priceUpdatePromises = [];
            const today = new Date().toISOString().split('T')[0];

            for (const prop of properties) {
                // MOCK: Calcul du prix IA
                // TODO: Remplacer par un véritable appel à votre service de pricing
                const mockPrice = Math.floor(100 + Math.random() * 150); // Simule un prix entre 100 et 250

                priceUpdatePromises.push(
                    client.updateRate(prop.pmsId, today, mockPrice)
                        .then(() => ({ 
                            status: 'fulfilled', 
                            propertyId: prop.pmsId, 
                            price: mockPrice, 
                            date: today 
                        }))
                        .catch(e => ({ 
                            status: 'rejected', 
                            propertyId: prop.pmsId, 
                            reason: e.message 
                        }))
                );
            }

            // 4. Exécuter toutes les mises à jour en parallèle
            const results = await Promise.allSettled(priceUpdatePromises);

            // 5. Journaliser les résultats
            for (const result of results) {
                if (result.status === 'fulfilled') {
                    console.log(`[PMS Sync] Succès: Prix pour ${result.value.propertyId} mis à ${result.value.price}€ pour ${result.value.date}`);
                    // logPropertyChange(result.value.propertyId, 'system-pms', 'pms-sync', 'update:rate', { ... });
                } else {
                    console.error(`[PMS Sync] Échec: Prix pour ${result.reason.propertyId} n'a pas pu être mis à jour. Raison: ${result.reason.reason}`);
                }
            }

        } catch (error) {
            console.error(`[PMS Sync] Échec critique pour ${userEmail} (PMS: ${pmsType}). Raison: ${error.message}`);
            // On pourrait logger cette erreur dans le profil de l'utilisateur
        }
    }
    console.log('[PMS Sync] Tâche de synchronisation quotidienne terminée.');
}


/**
 * HELPER: Obtient l'identifiant de la semaine (ISO 8601) pour une date donnée.
 * @param {Date} date - L'objet Date (en UTC)
 * @returns {string} - L'identifiant de la semaine (ex: "2025-W05")
 */
function getWeekId(date) {
    // Crée une copie pour éviter de muter la date originale
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    // Positionne au jeudi de la même semaine
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    // Date du 1er janvier de cette année
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    // Calcule le numéro de la semaine
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/**
 * Calcule les quantités de facturation pour un utilisateur basées sur ses propriétés et groupes.
 * 
 * Logique de facturation :
 * - Propriétés PARENTES (quantityPrincipal) : 
 *   * Première propriété de chaque groupe
 *   * Toutes les propriétés sans groupe
 * - Propriétés FILLES (quantityChild) :
 *   * Les autres propriétés (suivantes dans un groupe)
 * 
 * @param {Array} userProperties - Liste des propriétés de l'utilisateur (avec ou sans groupId)
 * @param {Array} userGroups - Liste des groupes de l'utilisateur (avec propriétés incluses)
 * @returns {Object} - { quantityPrincipal, quantityChild }
 */
function calculateBillingQuantities(userProperties, userGroups) {
    // Propriétés parentes : premières de chaque groupe + propriétés sans groupe
    let quantityPrincipal = 0; 
    // Propriétés filles : autres propriétés (suivantes dans un groupe)
    let quantityChild = 0;     

    // Créer un Set des IDs de propriétés qui sont dans un groupe pour identifier les propriétés indépendantes
    const propertiesInGroups = new Set();
    
    // Étape 1 : Gérer les propriétés groupées
    userGroups.forEach(group => {
        const groupProperties = group.properties || [];
        
        if (groupProperties.length > 0) {
            // La 1ère propriété du groupe = PROPRIÉTÉ PARENTE (prix principal)
            quantityPrincipal += 1;
            
            // Les propriétés suivantes dans le groupe = PROPRIÉTÉS FILLES (prix enfant 3.99€)
            if (groupProperties.length > 1) {
                quantityChild += (groupProperties.length - 1);
            }
            
            // Ajouter toutes les propriétés du groupe au Set pour les exclure des propriétés indépendantes
            groupProperties.forEach(propId => {
                propertiesInGroups.add(propId);
            });
            
            // TODO: Ajouter ici la validation de géolocalisation pour éviter la fraude
        }
    });

    // Étape 2 : Gérer les propriétés indépendantes (qui ne sont pas dans un groupe)
    // Ces propriétés sont toutes des PROPRIÉTÉS PARENTES (prix principal)
    const independentProperties = userProperties.filter(p => {
        const propId = typeof p === 'string' ? p : p.id;
        return !propertiesInGroups.has(propId);
    });
    
    // Toutes les propriétés sans groupe sont des propriétés parentes
    quantityPrincipal += independentProperties.length;

    return { quantityPrincipal, quantityChild };
}

/**
 * Vérifie si l'utilisateur est en période d'essai et si l'ajout d'une propriété dépasse la limite de 10
 * @param {string} userId - ID de l'utilisateur
 * @param {string} subscriptionId - ID de l'abonnement Stripe
 * @param {number} currentPropertyCount - Nombre actuel de propriétés
 * @param {number} newPropertiesCount - Nombre de nouvelles propriétés à ajouter
 * @param {Object} db - Instance Firestore
 * @returns {Promise<{isAllowed: boolean, isTrialActive: boolean, currentCount: number, maxAllowed: number}>}
 */
async function checkTrialPropertyLimit(userId, subscriptionId, currentPropertyCount, newPropertiesCount, db) {
    try {
        if (!subscriptionId) {
            // Pas d'abonnement = pas de limite
            return { isAllowed: true, isTrialActive: false, currentCount: currentPropertyCount, maxAllowed: Infinity };
        }
        
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        
        // Vérifier si en période d'essai
        const isTrialActive = subscription.status === 'trialing' && 
                              subscription.trial_end && 
                              subscription.trial_end * 1000 > Date.now();
        
        if (!isTrialActive) {
            // Pas en période d'essai = pas de limite
            return { isAllowed: true, isTrialActive: false, currentCount: currentPropertyCount, maxAllowed: Infinity };
        }
        
        // En période d'essai : vérifier la limite de 10
        const totalProperties = currentPropertyCount + newPropertiesCount;
        const maxAllowed = 10;
        const isAllowed = totalProperties <= maxAllowed;
        
        return { isAllowed, isTrialActive: true, currentCount: currentPropertyCount, maxAllowed };
        
    } catch (error) {
        console.error('[Trial Limit] Erreur lors de la vérification:', error);
        // En cas d'erreur, on autorise (fail-safe)
        return { isAllowed: true, isTrialActive: false, currentCount: currentPropertyCount, maxAllowed: Infinity };
    }
}

/**
 * Calcule la distance entre deux points géographiques (formule Haversine)
 * @param {number} lat1 - Latitude du premier point
 * @param {number} lon1 - Longitude du premier point
 * @param {number} lat2 - Latitude du deuxième point
 * @param {number} lon2 - Longitude du deuxième point
 * @returns {number} - Distance en mètres
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Rayon de la Terre en mètres
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    
    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    
    return R * c; // Distance en mètres
}

/**
 * Vérifie si la synchronisation PMS est activée pour un utilisateur
 * @param {string} userId - ID de l'utilisateur
 * @param {Object} db - Instance Firestore
 * @returns {Promise<boolean>} - true si la sync est activée, false sinon
 */
async function isPMSSyncEnabled(userId, db) {
    try {
        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists) {
            return false;
        }
        const userData = userDoc.data();
        // Par défaut, la sync est activée si le flag n'existe pas (rétrocompatibilité)
        return userData.pmsSyncEnabled !== false;
    } catch (error) {
        console.error(`[PMS Sync] Erreur lors de la vérification de pmsSyncEnabled pour ${userId}:`, error);
        // En cas d'erreur, on autorise (fail-safe)
        return true;
    }
}

/**
 * Récupère toutes les propriétés et groupes d'un utilisateur et met à jour Stripe
 * @param {string} userId - ID de l'utilisateur
 * @param {Object} db - Instance Firestore
 * @returns {Promise<void>}
 */
async function recalculateAndUpdateBilling(userId, db) {
    try {
        // Récupérer le profil utilisateur pour vérifier l'abonnement Stripe
        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        
        if (!userProfileDoc.exists) {
            console.warn(`[Billing] Profil utilisateur ${userId} non trouvé. Facturation ignorée.`);
            return;
        }
        
        const userProfile = userProfileDoc.data();
        const subscriptionId = userProfile.stripeSubscriptionId;
        
        // Si pas d'abonnement Stripe, on ne fait rien
        if (!subscriptionId) {
            console.log(`[Billing] Aucun abonnement Stripe trouvé pour l'utilisateur ${userId}. Facturation ignorée.`);
            return;
        }
        
        // Récupérer le teamId pour récupérer toutes les propriétés de l'équipe
        const teamId = userProfile.teamId || userId;
        
        // 1. Récupérer toutes les propriétés de l'équipe
        const propertiesSnapshot = await db.collection('properties').where('teamId', '==', teamId).get();
        const userProperties = propertiesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        
        // 2. Récupérer tous les groupes de l'utilisateur
        const groupsSnapshot = await db.collection('groups').where('ownerId', '==', userId).get();
        const userGroups = groupsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        
        // 3. Calculer les quantités de facturation
        const quantities = calculateBillingQuantities(userProperties, userGroups);
        
        console.log(`[Billing] Quantités calculées pour ${userId}: Principal=${quantities.quantityPrincipal}, Enfant=${quantities.quantityChild}`);
        
        // 4. Récupérer l'abonnement pour vérifier le statut et les quantités actuelles
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        
        // Vérifier si en période d'essai
        const isTrialActive = subscription.status === 'trialing' && 
                              subscription.trial_end && 
                              subscription.trial_end * 1000 > Date.now();
        
        if (isTrialActive) {
            // En période d'essai : juste mettre à jour les quantités (pas de facturation)
            console.log(`[Billing] Utilisateur en période d'essai. Mise à jour des quantités sans facturation.`);
            const stripeManager = require('./integrations/stripeManager');
            await stripeManager.updateSubscriptionQuantities(subscriptionId, quantities);
            return;
        }
        
        // Pas en période d'essai : gérer le rattrapage en cours de mois
        // 5. Calculer les quantités actuelles dans l'abonnement
        const parentPriceId = process.env.STRIPE_PRICE_PARENT_ID || process.env.STRIPE_PRICE_PRINCIPAL_ID;
        const childPriceId = process.env.STRIPE_PRICE_CHILD_ID;
        
        const subscriptionItems = subscription.items.data;
        let principalItem = subscriptionItems.find(item => {
            const priceId = typeof item.price === 'string' ? item.price : item.price.id;
            return priceId === parentPriceId;
        });
        let childItem = subscriptionItems.find(item => {
            const priceId = typeof item.price === 'string' ? item.price : item.price.id;
            return priceId === childPriceId;
        });
        
        const oldQuantityPrincipal = principalItem ? principalItem.quantity : 0;
        const oldQuantityChild = childItem ? childItem.quantity : 0;
        
        // 6. Détecter les augmentations (nouvelles propriétés ajoutées)
        const principalIncrease = Math.max(0, quantities.quantityPrincipal - oldQuantityPrincipal);
        const childIncrease = Math.max(0, quantities.quantityChild - oldQuantityChild);
        
        // 7. Mettre à jour l'abonnement pour le MOIS SUIVANT (sans proration)
        const stripeManager = require('./integrations/stripeManager');
        await stripeManager.updateSubscriptionQuantities(subscriptionId, quantities);
        
        // 8. Si augmentation : créer des invoice items pour le MOIS EN COURS (rattrapage)
        if (principalIncrease > 0 || childIncrease > 0) {
            const customerId = subscription.customer;
            
            // Prix en centimes (13.99€ = 1399 centimes, 3.99€ = 399 centimes)
            const parentPricePerUnit = 1399; // 13.99€
            const childPricePerUnit = 399; // 3.99€
            
            // Créer un invoice item pour chaque augmentation
            if (principalIncrease > 0) {
                await stripe.invoiceItems.create({
                    customer: customerId,
                    amount: principalIncrease * parentPricePerUnit,
                    currency: 'eur',
                    description: `Rattrapage - Ajout de ${principalIncrease} propriété(s) principale(s) en cours de mois`,
                    metadata: {
                        userId: userId,
                        reason: 'mid_month_property_addition',
                        propertyType: 'principal',
                        quantity: principalIncrease
                    }
                });
                console.log(`[Billing] Invoice item créé pour ${principalIncrease} propriété(s) principale(s) (rattrapage)`);
            }
            
            if (childIncrease > 0) {
                await stripe.invoiceItems.create({
                    customer: customerId,
                    amount: childIncrease * childPricePerUnit,
                    currency: 'eur',
                    description: `Rattrapage - Ajout de ${childIncrease} propriété(s) enfant(s) en cours de mois`,
                    metadata: {
                        userId: userId,
                        reason: 'mid_month_property_addition',
                        propertyType: 'child',
                        quantity: childIncrease
                    }
                });
                console.log(`[Billing] Invoice item créé pour ${childIncrease} propriété(s) enfant(s) (rattrapage)`);
            }
            
            // Note : Ces invoice items s'ajouteront à la prochaine facture
            // SAUF si le billing threshold est atteint (déclenchement immédiat)
        }
        
        console.log(`[Billing] Facturation mise à jour avec succès pour ${userId}`);
    } catch (error) {
        console.error(`[Billing] Erreur lors du recalcul de la facturation pour ${userId}:`, error);
        // Ne pas bloquer la requête principale si la facturation échoue
        // L'erreur sera loggée mais n'interrompra pas l'opération
    }
}


// --- ROUTES D'AUTHENTIFICATION (PUBLIQUES) ---
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name, currency, language, timezone } = req.body;

  if (!email || !password) {
    return res.status(400).send({ error: 'Email et mot de passe sont requis.' });
  }

  try {
    const userRecord = await admin.auth().createUser({
      email: email,
      password: password,
    });

    const db = admin.firestore();
    await db.collection('users').doc(userRecord.uid).set({
      email: email,
      name: name || 'Nouvel Utilisateur',
      currency: currency || 'EUR',
      language: language || 'fr',
      timezone: timezone || 'Europe/Paris',
      theme: 'auto', // Thème par défaut
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      notificationPreferences: {
          notifyOnBooking: true,
          notifyOnApiError: true,
      },
      reportFrequency: 'hebdomadaire',
      teamId: userRecord.uid,
      role: 'admin'
    });

    res.status(201).send({
      message: 'Utilisateur créé et profil enregistré avec succès',
      uid: userRecord.uid
    });
  } catch (error) {
    console.error('Erreur lors de la création de l\'utilisateur ou du profil:', error);
    if (error.code === 'auth/email-already-exists') {
      return res.status(409).send({ error: 'Cette adresse e-mail est déjà utilisée.' });
    }
    if (error.code === 'auth/invalid-password') {
      return res.status(400).send({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });
    }
    res.status(500).send({ error: 'Erreur interne du serveur lors de la création de l\'utilisateur.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).send({ error: 'Email et mot de passe sont requis.' });
    }
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseConfig.apiKey}`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email, password: password, returnSecureToken: true })
        });
        const data = await response.json();
        if (!response.ok) {
            const errorMessage = data.error?.message || 'Erreur inconnue de Firebase.';
            switch (errorMessage) {
                case 'INVALID_LOGIN_CREDENTIALS':
                    return res.status(401).send({ error: 'Email ou mot de passe invalide.' });
                case 'EMAIL_NOT_FOUND':
                    return res.status(404).send({ error: 'Aucun compte trouvé pour cet e-mail.' });
                default:
                    return res.status(400).send({ error: `Erreur d'authentification: ${errorMessage}` });
            }
        }
        res.status(200).send({ message: 'Connexion réussie', idToken: data.idToken });
    } catch (error) {
        console.error('Erreur lors de la connexion:', error);
        res.status(500).send({ error: 'Erreur interne du serveur lors de la connexion.' });
    }
});


// --- ROUTES DE GESTION DU PROFIL UTILISATEUR (SÉCURISÉES) ---
app.get('/api/users/profile', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const userId = req.user.uid;
        const userRef = db.collection('users').doc(userId);
        const doc = await userRef.get();
        if (!doc.exists) {
             console.warn(`Profil Firestore manquant pour l'utilisateur ${userId}. Tentative de création.`);
             await userRef.set({
                email: req.user.email,
                name: 'Utilisateur existant',
                currency: 'EUR', language: 'fr', timezone: 'Europe/Paris',
                theme: 'auto',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                notificationPreferences: { notifyOnBooking: true, notifyOnApiError: true },
                reportFrequency: 'hebdomadaire',
                teamId: userId, role: 'admin'
             });
             const newDoc = await userRef.get();
             return res.status(200).json(newDoc.data());
        }
        res.status(200).json(doc.data());
    } catch (error) {
        console.error('Erreur lors de la récupération du profil:', error);
        res.status(500).send({ error: 'Erreur lors de la récupération du profil.' });
    }
});

app.put('/api/users/profile', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const userId = req.user.uid;
        const incomingData = req.body;
        
        const allowedFields = [
            'name', 
            'currency', 
            'language', 
            'timezone', 
            'theme', 
            'notificationPreferences',
            'reportFrequency'
        ];
        
        const dataToUpdate = {};
        Object.keys(incomingData).forEach(key => {
            if (allowedFields.includes(key)) {
                if (key === 'theme') {
                    const allowedThemes = ['light', 'dark', 'auto'];
                    if (allowedThemes.includes(incomingData[key])) {
                        dataToUpdate[key] = incomingData[key];
                    }
                }
                else if (key === 'notificationPreferences') {
                    if (typeof incomingData[key] === 'object' && incomingData[key] !== null) {
                        dataToUpdate[key] = {
                            notifyOnBooking: typeof incomingData[key].notifyOnBooking === 'boolean' ? incomingData[key].notifyOnBooking : true,
                            notifyOnApiError: typeof incomingData[key].notifyOnApiError === 'boolean' ? incomingData[key].notifyOnApiError : true
                        };
                    }
                } else if (key === 'reportFrequency') {
                     const allowedFrequencies = ['jamais', 'quotidien', 'hebdomadaire', 'mensuel'];
                     if (allowedFrequencies.includes(incomingData[key])) {
                         dataToUpdate[key] = incomingData[key];
                     }
                } else {
                    dataToUpdate[key] = incomingData[key];
                }
            }
        });

        if (Object.keys(dataToUpdate).length === 0) {
            return res.status(400).send({ error: 'Aucun champ valide à mettre à jour.' });
        }

        const userRef = db.collection('users').doc(userId);
        await userRef.update(dataToUpdate);
        res.status(200).send({ message: 'Profil mis à jour avec succès' });
    } catch (error) {
        console.error('Erreur lors de la mise à jour du profil:', error);
        res.status(500).send({ error: 'Erreur lors de la mise à jour du profil.' });
    }
});

// --- WEBHOOK STRIPE (DOIT ÊTRE AVANT LES AUTRES ROUTES) ---
/**
 * POST /api/webhooks/stripe - Webhook Stripe pour gérer les événements
 * Gère notamment invoice.payment_failed pour couper l'accès
 */
app.post('/api/webhooks/stripe', async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    
    if (!webhookSecret) {
        console.error('[Webhook] STRIPE_WEBHOOK_SECRET non configuré');
        return res.status(500).send({ error: 'Configuration webhook manquante' });
    }
    
    let event;
    
    try {
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        // Vérifier la signature du webhook
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        console.error(`[Webhook] Erreur de signature: ${err.message}`);
        return res.status(400).send({ error: `Webhook Error: ${err.message}` });
    }
    
    const db = admin.firestore();
    
    try {
        // Gérer les différents événements Stripe
        switch (event.type) {
            case 'checkout.session.completed':
                await handleCheckoutSessionCompleted(event.data.object, db);
                break;
                
            case 'invoice.payment_failed':
                await handlePaymentFailed(event.data.object, db);
                break;
                
            case 'invoice.paid':
                await handlePaymentSucceeded(event.data.object, db);
                break;
                
            case 'customer.subscription.updated':
                await handleSubscriptionUpdated(event.data.object, db);
                break;
                
            case 'customer.subscription.deleted':
                await handleSubscriptionDeleted(event.data.object, db);
                break;
                
            default:
                console.log(`[Webhook] Événement non géré: ${event.type}`);
        }
        
        // Répondre rapidement à Stripe
        res.json({ received: true });
    } catch (error) {
        console.error('[Webhook] Erreur lors du traitement de l\'événement:', error);
        res.status(500).send({ error: 'Erreur lors du traitement du webhook' });
    }
});

/**
 * Gère l'échec de paiement d'une facture
 * Coupe l'accès à Priceye si le paiement échoue après la période d'essai
 */
async function handlePaymentFailed(invoice, db) {
    try {
        const subscriptionId = invoice.subscription;
        const customerId = invoice.customer;
        
        console.log(`[Webhook] Échec de paiement pour la facture ${invoice.id}, subscription: ${subscriptionId}, customer: ${customerId}`);
        
        if (!subscriptionId) {
            console.warn('[Webhook] Aucune subscription ID dans la facture');
            return;
        }
        
        // Récupérer le customer Stripe pour obtenir le userId depuis les metadata
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        const customer = await stripe.customers.retrieve(customerId);
        const userId = customer.metadata?.userId;
        
        if (!userId) {
            console.error(`[Webhook] Impossible de trouver le userId pour le customer ${customerId}`);
            return;
        }
        
        // Vérifier si la période d'essai est terminée
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const isTrialOver = !subscription.trial_end || subscription.trial_end * 1000 < Date.now();
        
        if (!isTrialOver) {
            console.log(`[Webhook] Paiement échoué mais l'utilisateur est encore en période d'essai. Pas de coupure d'accès.`);
            // Mettre à jour le statut mais ne pas couper l'accès
            await db.collection('users').doc(userId).update({
                subscriptionStatus: 'trialing',
                paymentFailed: true,
                lastPaymentFailureAt: admin.firestore.FieldValue.serverTimestamp()
            });
            return;
        }
        
        // Période d'essai terminée : couper l'accès
        console.log(`[Webhook] Période d'essai terminée. Coupure de l'accès pour l'utilisateur ${userId}`);
        
        // Désactiver l'accès dans Firestore
        await db.collection('users').doc(userId).update({
            subscriptionStatus: 'past_due',
            accessDisabled: true,
            accessDisabledAt: admin.firestore.FieldValue.serverTimestamp(),
            paymentFailed: true,
            lastPaymentFailureAt: admin.firestore.FieldValue.serverTimestamp(),
            lastPaymentFailureInvoiceId: invoice.id,
            pmsSyncEnabled: false, // STOPPER la synchronisation PMS
            pmsSyncStoppedReason: 'payment_failed',
            pmsSyncStoppedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        // Optionnel : Désactiver l'utilisateur dans Firebase Auth
        try {
            await admin.auth().updateUser(userId, {
                disabled: true
            });
            console.log(`[Webhook] Utilisateur ${userId} désactivé dans Firebase Auth`);
        } catch (authError) {
            console.error(`[Webhook] Erreur lors de la désactivation de l'utilisateur dans Firebase Auth:`, authError);
        }
        
        console.log(`[Webhook] Accès coupé avec succès pour l'utilisateur ${userId}`);
        
    } catch (error) {
        console.error('[Webhook] Erreur lors de la gestion de l\'échec de paiement:', error);
        throw error;
    }
}

/**
 * Gère la complétion d'une session Stripe Checkout
 * Active l'abonnement et enregistre les listing IDs pour l'anti-abus
 */
async function handleCheckoutSessionCompleted(session, db) {
    try {
        const customerId = session.customer;
        const subscriptionId = session.subscription;
        
        console.log(`[Webhook] Checkout session complétée: ${session.id}, subscription: ${subscriptionId}, customer: ${customerId}`);
        
        if (!subscriptionId || !customerId) {
            console.error('[Webhook] Session incomplète: subscriptionId ou customerId manquant');
            return;
        }
        
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        
        // Récupérer le customer pour obtenir le userId
        const customer = await stripe.customers.retrieve(customerId);
        const userId = session.metadata?.userId || customer.metadata?.userId;
        
        if (!userId) {
            console.error(`[Webhook] Impossible de trouver le userId pour la session ${session.id}`);
            return;
        }
        
        // Récupérer l'abonnement pour obtenir le statut
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        
        // Mettre à jour le profil utilisateur dans Firestore
        await db.collection('users').doc(userId).update({
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscriptionId,
            subscriptionStatus: subscription.status, // 'trialing' ou 'active'
            subscriptionCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
            accessDisabled: false,
            pmsSyncEnabled: true // Activer la synchronisation PMS
        });
        
        console.log(`[Webhook] Profil utilisateur ${userId} mis à jour avec l'abonnement ${subscriptionId}`);
        
        // Enregistrer les listing IDs pour l'anti-abus des essais gratuits
        // Récupérer toutes les propriétés de l'utilisateur
        const userProfile = await db.collection('users').doc(userId).get();
        const teamId = userProfile.data()?.teamId || userId;
        
        const propertiesSnapshot = await db.collection('properties')
            .where('teamId', '==', teamId)
            .get();
        
        const listingIds = [];
        propertiesSnapshot.docs.forEach(doc => {
            const prop = doc.data();
            if (prop.pmsId) {
                listingIds.push(prop.pmsId);
            }
        });
        
        // Enregistrer chaque listing ID dans la collection used_listing_ids
        if (listingIds.length > 0) {
            const batch = db.batch();
            for (const listingId of listingIds) {
                // Vérifier si le listing ID n'est pas déjà enregistré
                const existing = await db.collection('used_listing_ids')
                    .where('listingId', '==', listingId)
                    .limit(1)
                    .get();
                
                if (existing.empty) {
                    // Enregistrer le listing ID
                    const usedListingRef = db.collection('used_listing_ids').doc();
                    batch.set(usedListingRef, {
                        listingId: listingId,
                        userId: userId,
                        usedAt: admin.firestore.FieldValue.serverTimestamp(),
                        checkoutSessionId: session.id,
                        subscriptionId: subscriptionId,
                        source: 'checkout_completed' // Source de l'enregistrement
                    });
                }
            }
            
            if (listingIds.length > 0) {
                await batch.commit();
                console.log(`[Webhook] ${listingIds.length} listing ID(s) enregistré(s) pour l'anti-abus`);
            }
        }
        
        console.log(`[Webhook] Checkout session complétée avec succès pour l'utilisateur ${userId}`);
        
    } catch (error) {
        console.error('[Webhook] Erreur lors de la gestion de la session checkout:', error);
        throw error;
    }
}

/**
 * Gère le succès de paiement d'une facture
 * Réactive l'accès à Priceye
 */
async function handlePaymentSucceeded(invoice, db) {
    try {
        const subscriptionId = invoice.subscription;
        const customerId = invoice.customer;
        
        console.log(`[Webhook] Paiement réussi pour la facture ${invoice.id}, subscription: ${subscriptionId}`);
        
        if (!subscriptionId) {
            return;
        }
        
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        const customer = await stripe.customers.retrieve(customerId);
        const userId = customer.metadata?.userId;
        
        if (!userId) {
            console.error(`[Webhook] Impossible de trouver le userId pour le customer ${customerId}`);
            return;
        }
        
        // Réactiver l'accès
        console.log(`[Webhook] Réactivation de l'accès pour l'utilisateur ${userId}`);
        
        await db.collection('users').doc(userId).update({
            subscriptionStatus: 'active',
            accessDisabled: false,
            accessReactivatedAt: admin.firestore.FieldValue.serverTimestamp(),
            paymentFailed: false
        });
        
        // Réactiver l'utilisateur dans Firebase Auth
        try {
            await admin.auth().updateUser(userId, {
                disabled: false
            });
            console.log(`[Webhook] Utilisateur ${userId} réactivé dans Firebase Auth`);
        } catch (authError) {
            console.error(`[Webhook] Erreur lors de la réactivation de l'utilisateur dans Firebase Auth:`, authError);
        }
        
        console.log(`[Webhook] Accès réactivé avec succès pour l'utilisateur ${userId}`);
        
    } catch (error) {
        console.error('[Webhook] Erreur lors de la gestion du succès de paiement:', error);
        throw error;
    }
}

/**
 * Gère la mise à jour d'un abonnement
 * Met à jour le statut dans Firestore
 */
async function handleSubscriptionUpdated(subscription, db) {
    try {
        const customerId = subscription.customer;
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        const customer = await stripe.customers.retrieve(customerId);
        const userId = customer.metadata?.userId;
        
        if (!userId) {
            return;
        }
        
        await db.collection('users').doc(userId).update({
            subscriptionStatus: subscription.status,
            subscriptionUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        console.log(`[Webhook] Statut d'abonnement mis à jour pour ${userId}: ${subscription.status}`);
        
    } catch (error) {
        console.error('[Webhook] Erreur lors de la mise à jour de l\'abonnement:', error);
    }
}

/**
 * Gère la suppression d'un abonnement
 * Coupe l'accès définitivement
 */
async function handleSubscriptionDeleted(subscription, db) {
    try {
        const customerId = subscription.customer;
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        const customer = await stripe.customers.retrieve(customerId);
        const userId = customer.metadata?.userId;
        
        if (!userId) {
            return;
        }
        
        console.log(`[Webhook] Abonnement annulé. Coupure de l'accès pour l'utilisateur ${userId}`);
        
        await db.collection('users').doc(userId).update({
            subscriptionStatus: 'canceled',
            accessDisabled: true,
            accessDisabledAt: admin.firestore.FieldValue.serverTimestamp(),
            subscriptionCanceledAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        // Désactiver l'utilisateur dans Firebase Auth
        try {
            await admin.auth().updateUser(userId, {
                disabled: true
            });
        } catch (authError) {
            console.error(`[Webhook] Erreur lors de la désactivation de l'utilisateur:`, authError);
        }
        
    } catch (error) {
        console.error('[Webhook] Erreur lors de la suppression de l\'abonnement:', error);
    }
}

// --- ROUTES D'ABONNEMENT STRIPE ---
/**
 * POST /api/subscriptions/create - Crée un abonnement Stripe pour un utilisateur
 * Requiert : paymentMethodId dans le body
 */
app.post('/api/subscriptions/create', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const userId = req.user.uid;
        const { paymentMethodId, trialPeriodDays } = req.body;
        
        if (!paymentMethodId) {
            return res.status(400).send({ error: 'paymentMethodId est requis.' });
        }
        
        // Récupérer le profil utilisateur
        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        
        if (!userProfileDoc.exists) {
            return res.status(404).send({ error: 'Profil utilisateur non trouvé.' });
        }
        
        const userProfile = userProfileDoc.data();
        
        // Importer le module Stripe une seule fois
        const stripeManager = require('./integrations/stripeManager');
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        
        // Vérifier si l'utilisateur a déjà un abonnement actif
        if (userProfile.stripeSubscriptionId) {
            try {
                const existingSubscription = await stripe.subscriptions.retrieve(userProfile.stripeSubscriptionId);
                
                // Vérifier si l'abonnement est actif ou en période d'essai
                if (existingSubscription.status === 'active' || existingSubscription.status === 'trialing') {
                    return res.status(400).send({ error: 'Vous avez déjà un abonnement actif.' });
                }
            } catch (error) {
                // L'abonnement n'existe peut-être plus, on peut continuer
                console.log(`[Subscription] L'abonnement existant ${userProfile.stripeSubscriptionId} n'est plus valide. Création d'un nouvel abonnement.`);
            }
        }
        
        // Récupérer le teamId pour calculer les quantités
        const teamId = userProfile.teamId || userId;
        
        // 1. Récupérer toutes les propriétés de l'équipe
        const propertiesSnapshot = await db.collection('properties').where('teamId', '==', teamId).get();
        const userProperties = propertiesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        
        // 2. Récupérer tous les groupes de l'utilisateur
        const groupsSnapshot = await db.collection('groups').where('ownerId', '==', userId).get();
        const userGroups = groupsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        
        // 3. Calculer les quantités de facturation
        const quantities = calculateBillingQuantities(userProperties, userGroups);
        
        // Si aucune propriété, on crée quand même l'abonnement avec des quantités à 0
        // (l'utilisateur pourra ajouter des propriétés plus tard)
        if (quantities.quantityPrincipal === 0 && quantities.quantityChild === 0) {
            // Pour un nouvel utilisateur, on commence avec 1 propriété principale
            quantities.quantityPrincipal = 1;
        }
        
        console.log(`[Subscription] Création d'abonnement pour ${userId}: Principal=${quantities.quantityPrincipal}, Enfant=${quantities.quantityChild}`);
        
        // 4. Créer ou récupérer le customer Stripe
        const customerId = await stripeManager.getOrCreateStripeCustomer(
            userId,
            userProfile.email || req.user.email,
            userProfile.name || 'Utilisateur',
            userProfile.stripeCustomerId
        );
        
        // 5. Créer l'abonnement
        const subscription = await stripeManager.createSubscription(
            customerId,
            paymentMethodId,
            quantities,
            trialPeriodDays || 30
        );
        
        // 6. Sauvegarder les IDs dans le profil utilisateur
        await userProfileRef.update({
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscription.id,
            subscriptionStatus: subscription.status,
            subscriptionCreatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        console.log(`[Subscription] Abonnement créé avec succès pour ${userId}: ${subscription.id}`);
        
        res.status(201).send({
            message: 'Abonnement créé avec succès',
            subscriptionId: subscription.id,
            customerId: customerId,
            status: subscription.status,
            trialEnd: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null
        });
        
    } catch (error) {
        console.error('[Subscription] Erreur lors de la création de l\'abonnement:', error);
        res.status(500).send({ error: `Erreur lors de la création de l'abonnement: ${error.message}` });
    }
});

// --- ROUTES STRIPE SUBSCRIPTIONS (Phase 3) ---
/**
 * POST /api/subscriptions/end-trial-and-bill - Termine l'essai anticipé et facture immédiatement
 * Utilisé quand l'utilisateur dépasse la limite de 10 propriétés pendant l'essai
 */
app.post('/api/subscriptions/end-trial-and-bill', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const userId = req.user.uid;
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        
        // Récupérer le profil utilisateur
        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        
        if (!userProfileDoc.exists) {
            return res.status(404).send({ error: 'Profil utilisateur non trouvé.' });
        }
        
        const userProfile = userProfileDoc.data();
        const subscriptionId = userProfile.stripeSubscriptionId;
        
        if (!subscriptionId) {
            return res.status(400).send({ error: 'Aucun abonnement trouvé.' });
        }
        
        // Récupérer l'abonnement actuel
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        
        // Vérifier que l'utilisateur est bien en période d'essai
        const isTrialActive = subscription.status === 'trialing' && 
                              subscription.trial_end && 
                              subscription.trial_end * 1000 > Date.now();
        
        if (!isTrialActive) {
            return res.status(400).send({ error: 'Vous n\'êtes pas en période d\'essai.' });
        }
        
        // Récupérer toutes les propriétés et groupes pour recalculer les quantités
        const teamId = userProfile.teamId || userId;
        const propertiesSnapshot = await db.collection('properties').where('teamId', '==', teamId).get();
        const userProperties = propertiesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        
        const groupsSnapshot = await db.collection('groups').where('ownerId', '==', userId).get();
        const userGroups = groupsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        
        // Calculer les nouvelles quantités
        const quantities = calculateBillingQuantities(userProperties, userGroups);
        
        // Si aucune propriété, on commence avec 1 propriété principale
        if (quantities.quantityPrincipal === 0 && quantities.quantityChild === 0) {
            quantities.quantityPrincipal = 1;
        }
        
        // Récupérer les items d'abonnement existants
        const subscriptionItems = subscription.items.data;
        const parentPriceId = process.env.STRIPE_PRICE_PARENT_ID || process.env.STRIPE_PRICE_PRINCIPAL_ID;
        const childPriceId = process.env.STRIPE_PRICE_CHILD_ID;
        
        // Trouver les items existants
        let principalItem = subscriptionItems.find(item => {
            const priceId = typeof item.price === 'string' ? item.price : item.price.id;
            return priceId === parentPriceId;
        });
        let childItem = subscriptionItems.find(item => {
            const priceId = typeof item.price === 'string' ? item.price : item.price.id;
            return priceId === childPriceId;
        });
        
        // Construire les items à mettre à jour
        const itemsToUpdate = [];
        
        if (principalItem) {
            itemsToUpdate.push({
                id: principalItem.id,
                quantity: quantities.quantityPrincipal
            });
        } else if (quantities.quantityPrincipal > 0) {
            itemsToUpdate.push({
                price: parentPriceId,
                quantity: quantities.quantityPrincipal
            });
        }
        
        if (childItem) {
            itemsToUpdate.push({
                id: childItem.id,
                quantity: quantities.quantityChild
            });
        } else if (quantities.quantityChild > 0) {
            itemsToUpdate.push({
                price: childPriceId,
                quantity: quantities.quantityChild
            });
        }
        
        // Mettre à jour l'abonnement : quantité + fin d'essai + facturation immédiate
        const updatedSubscription = await stripe.subscriptions.update(subscriptionId, {
            items: itemsToUpdate,
            trial_end: 'now', // Terminer l'essai immédiatement
            proration_behavior: 'always_invoice' // Facturer immédiatement avec proration
        });
        
        // Forcer la génération de la facture
        const invoice = await stripe.invoices.create({
            customer: subscription.customer,
            subscription: subscriptionId,
            auto_advance: true // Générer et envoyer immédiatement
        });
        
        // Finaliser la facture (prélèvement immédiat)
        await stripe.invoices.finalizeInvoice(invoice.id, { auto_advance: true });
        
        // Mettre à jour le profil utilisateur
        await userProfileRef.update({
            subscriptionStatus: updatedSubscription.status,
            trialEndedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        console.log(`[End Trial] Essai terminé et facturation effectuée pour ${userId}`);
        
        res.status(200).json({
            message: 'Essai terminé et facturation effectuée avec succès',
            subscriptionId: subscriptionId,
            invoiceId: invoice.id,
            status: updatedSubscription.status
        });
        
    } catch (error) {
        console.error('[End Trial] Erreur lors de la fin d\'essai anticipée:', error);
        res.status(500).send({ error: `Erreur lors de la fin d'essai: ${error.message}` });
    }
});

// --- ROUTES STRIPE BILLING PORTAL (Phase 4) ---
/**
 * POST /api/billing/portal-session - Crée une session Stripe Customer Portal
 * Permet au client de gérer son abonnement, ses factures et sa carte bancaire
 */
app.post('/api/billing/portal-session', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const userId = req.user.uid;
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        
        // Récupérer le profil utilisateur
        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        
        if (!userProfileDoc.exists) {
            return res.status(404).send({ error: 'Profil utilisateur non trouvé.' });
        }
        
        const userProfile = userProfileDoc.data();
        const customerId = userProfile.stripeCustomerId;
        
        if (!customerId) {
            return res.status(400).json({ error: 'Aucun customer Stripe trouvé. Vous devez d\'abord créer un abonnement.' });
        }
        
        // Créer la session du portail client
        const frontendUrl = process.env.FRONTEND_URL || 'https://pric-eye.vercel.app';
        const session = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: `${frontendUrl}/billing`
        });
        
        console.log(`[Billing Portal] Session créée pour ${userId}: ${session.url}`);
        
        res.json({ url: session.url });
    } catch (error) {
        console.error('[Billing Portal] Erreur lors de la création de la session portal:', error);
        res.status(500).json({ error: 'Erreur serveur lors de la création de la session portal.' });
    }
});

// --- ROUTES STRIPE CHECKOUT (NOUVEAU - Phase 2) ---
/**
 * POST /api/checkout/create-session - Crée une session Stripe Checkout pour l'onboarding
 * Utilise Stripe Checkout (page hébergée) pour la sécurité et la conformité
 */
app.post('/api/checkout/create-session', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const userId = req.user.uid;
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        const stripeManager = require('./integrations/stripeManager');
        
        // Récupérer le profil utilisateur
        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        
        if (!userProfileDoc.exists) {
            return res.status(404).send({ error: 'Profil utilisateur non trouvé.' });
        }
        
        const userProfile = userProfileDoc.data();
        
        // Vérifier si l'utilisateur a déjà un abonnement actif
        if (userProfile.stripeSubscriptionId) {
            try {
                const existingSubscription = await stripe.subscriptions.retrieve(userProfile.stripeSubscriptionId);
                if (existingSubscription.status === 'active' || existingSubscription.status === 'trialing') {
                    return res.status(400).send({ error: 'Vous avez déjà un abonnement actif.' });
                }
            } catch (error) {
                console.log(`[Checkout] L'abonnement existant ${userProfile.stripeSubscriptionId} n'est plus valide.`);
            }
        }
        
        // 1. Récupérer toutes les propriétés de l'utilisateur
        const teamId = userProfile.teamId || userId;
        const propertiesSnapshot = await db.collection('properties').where('teamId', '==', teamId).get();
        const userProperties = propertiesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        
        // 2. Récupérer tous les groupes de l'utilisateur
        const groupsSnapshot = await db.collection('groups').where('ownerId', '==', userId).get();
        const userGroups = groupsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        
        // 3. Calculer les buckets Parent/Enfant
        const quantities = calculateBillingQuantities(userProperties, userGroups);
        
        // Si aucune propriété, on commence avec 1 propriété principale
        if (quantities.quantityPrincipal === 0 && quantities.quantityChild === 0) {
            quantities.quantityPrincipal = 1;
        }
        
        // 4. Vérifier l'anti-abus des essais gratuits (listing IDs)
        let trialPeriodDays = 30; // Par défaut, essai gratuit de 30 jours
        
        // Extraire tous les listing IDs (pmsId) des propriétés importées
        const listingIds = userProperties
            .filter(p => p.pmsId)
            .map(p => p.pmsId);
        
        if (listingIds.length > 0) {
            const hasAbuse = await checkListingIdsAbuse(listingIds, db);
            if (hasAbuse) {
                console.log(`[Checkout] Anti-abus détecté pour l'utilisateur ${userId}. Essai gratuit refusé.`);
                trialPeriodDays = 0; // Pas d'essai gratuit
            }
        }
        
        // 5. Créer ou récupérer le Customer Stripe
        const customerId = await stripeManager.getOrCreateStripeCustomer(
            userId,
            userProfile.email || req.user.email,
            userProfile.name || 'Utilisateur',
            userProfile.stripeCustomerId
        );
        
        // 6. Construire les line_items pour Stripe Checkout
        const lineItems = [];
        
        // Support des deux noms de variables pour compatibilité
        const parentPriceId = process.env.STRIPE_PRICE_PARENT_ID || process.env.STRIPE_PRICE_PRINCIPAL_ID;
        const childPriceId = process.env.STRIPE_PRICE_CHILD_ID;
        
        if (!parentPriceId || !childPriceId) {
            return res.status(500).send({ error: 'Configuration Stripe incomplète. Contactez le support.' });
        }
        
        // Ajouter l'item parent si quantité > 0
        if (quantities.quantityPrincipal > 0) {
            lineItems.push({
                price: parentPriceId,
                quantity: quantities.quantityPrincipal
            });
        }
        
        // Ajouter l'item enfant si quantité > 0
        if (quantities.quantityChild > 0) {
            lineItems.push({
                price: childPriceId,
                quantity: quantities.quantityChild
            });
        }
        
        // Si aucun item, on crée quand même avec 1 propriété principale
        if (lineItems.length === 0) {
            lineItems.push({
                price: parentPriceId,
                quantity: 1
            });
        }
        
        // 7. Créer la session Stripe Checkout
        const frontendUrl = process.env.FRONTEND_URL || 'https://pric-eye.vercel.app';
        
        const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            customer: customerId,
            customer_email: userProfile.email || req.user.email,
            line_items: lineItems,
            subscription_data: {
                trial_period_days: trialPeriodDays,
                metadata: {
                    userId: userId
                }
            },
            success_url: `${frontendUrl}/dashboard?success=true&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${frontendUrl}/billing?canceled=true`
        });
        
        console.log(`[Checkout] Session créée pour ${userId}: ${session.id} (essai: ${trialPeriodDays} jours)`);
        
        // Retourner l'URL de la session
        res.status(200).json({
            url: session.url,
            sessionId: session.id
        });
        
    } catch (error) {
        console.error('[Checkout] Erreur lors de la création de la session:', error);
        res.status(500).send({ error: `Erreur lors de la création de la session: ${error.message}` });
    }
});

/**
 * Fonction helper : Vérifie si des listing IDs ont déjà été utilisés (anti-abus essai gratuit)
 * @param {Array<string>} listingIds - Liste des listing IDs à vérifier
 * @param {Object} db - Instance Firestore
 * @returns {Promise<boolean>} - true si abus détecté, false sinon
 */
async function checkListingIdsAbuse(listingIds, db) {
    if (!listingIds || listingIds.length === 0) return false;
    
    try {
        // Vérifier si un des listing IDs a déjà été utilisé
        for (const listingId of listingIds) {
            const existing = await db.collection('used_listing_ids')
                .where('listingId', '==', listingId)
                .limit(1)
                .get();
            
            if (!existing.empty) {
                console.log(`[Anti-Abus] Listing ID ${listingId} déjà utilisé. Abus détecté.`);
                return true; // Abus détecté
            }
        }
        
        return false; // Pas d'abus
    } catch (error) {
        console.error('[Anti-Abus] Erreur lors de la vérification:', error);
        // En cas d'erreur, on autorise l'essai gratuit (fail-safe)
        return false;
    }
}

/**
 * Endpoint pour récupérer l'état actuel de la génération automatique des prix IA
 * GET /api/users/auto-pricing/:userId
 */
app.get('/api/users/auto-pricing/:userId', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const requestedUserId = req.params.userId;
        const authenticatedUserId = req.user.uid;

        // Vérifier que l'utilisateur ne peut consulter que son propre profil
        if (requestedUserId !== authenticatedUserId) {
            return res.status(403).send({ 
                error: 'Vous n\'êtes pas autorisé à consulter les préférences d\'un autre utilisateur.' 
            });
        }

        const userRef = db.collection('users').doc(requestedUserId);
        const userDoc = await userRef.get();

        // Vérifier que l'utilisateur existe
        if (!userDoc.exists) {
            return res.status(404).send({ 
                error: 'Utilisateur non trouvé.' 
            });
        }

        const userData = userDoc.data();
        const autoPricing = userData.autoPricing || {};

        // Retourner l'état actuel avec des valeurs par défaut si non défini
        const response = {
            enabled: autoPricing.enabled || false,
            timezone: autoPricing.timezone || userData.timezone || 'Europe/Paris',
            lastRun: autoPricing.lastRun || null,
            enabledAt: autoPricing.enabledAt || null,
            updatedAt: autoPricing.updatedAt || null
        };

        res.status(200).send(response);

    } catch (error) {
        console.error('Erreur lors de la récupération des préférences de génération automatique:', error);
        
        // Gestion des erreurs spécifiques
        if (error.code === 'permission-denied') {
            return res.status(403).send({ 
                error: 'Permission refusée. Vérifiez vos droits d\'accès.' 
            });
        }
        
        if (error.code === 'not-found') {
            return res.status(404).send({ 
                error: 'Utilisateur non trouvé.' 
            });
        }

        res.status(500).send({ 
            error: 'Erreur interne du serveur lors de la récupération des préférences de génération automatique.' 
        });
    }
});

/**
 * Endpoint pour activer/désactiver la génération automatique des prix IA
 * PUT /api/users/auto-pricing/:userId
 * Body: { enabled: boolean, timezone: string }
 */
app.put('/api/users/auto-pricing/:userId', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const requestedUserId = req.params.userId;
        const authenticatedUserId = req.user.uid;
        const { enabled, timezone } = req.body;

        // Vérifier que l'utilisateur ne peut modifier que son propre profil
        if (requestedUserId !== authenticatedUserId) {
            return res.status(403).send({ 
                error: 'Vous n\'êtes pas autorisé à modifier les préférences d\'un autre utilisateur.' 
            });
        }

        // Validation des données
        if (typeof enabled !== 'boolean') {
            return res.status(400).send({ 
                error: 'Le champ "enabled" doit être un booléen (true ou false).' 
            });
        }

        if (!timezone || typeof timezone !== 'string') {
            return res.status(400).send({ 
                error: 'Le champ "timezone" est requis et doit être une chaîne de caractères.' 
            });
        }

        // Valider le format du fuseau horaire (format IANA, ex: "Europe/Paris", "America/New_York")
        const timezoneRegex = /^[A-Za-z_]+\/[A-Za-z_]+$/;
        if (!timezoneRegex.test(timezone)) {
            return res.status(400).send({ 
                error: 'Le fuseau horaire doit être au format IANA (ex: "Europe/Paris", "America/New_York").' 
            });
        }

        const userRef = db.collection('users').doc(requestedUserId);
        const userDoc = await userRef.get();

        // Vérifier que l'utilisateur existe
        if (!userDoc.exists) {
            return res.status(404).send({ 
                error: 'Utilisateur non trouvé.' 
            });
        }

        // Préparer les données à mettre à jour
        const updateData = {
            autoPricing: {
                enabled: enabled,
                timezone: timezone,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }
        };

        // Si la génération automatique est activée, enregistrer aussi la date d'activation
        if (enabled) {
            const existingData = userDoc.data();
            if (!existingData.autoPricing || !existingData.autoPricing.enabled) {
                updateData.autoPricing.enabledAt = admin.firestore.FieldValue.serverTimestamp();
                // Initialiser le compteur d'échecs à 0 lors de l'activation
                updateData.autoPricing.failedAttempts = 0;
            } else {
                // Conserver la date d'activation existante si elle existe
                updateData.autoPricing.enabledAt = existingData.autoPricing.enabledAt || admin.firestore.FieldValue.serverTimestamp();
            }
        } else {
            // Si désactivé, on peut optionnellement enregistrer la date de désactivation
            updateData.autoPricing.disabledAt = admin.firestore.FieldValue.serverTimestamp();
        }

        // Mettre à jour le document utilisateur
        await userRef.update(updateData);

        // Message de confirmation
        const message = enabled 
            ? `Génération automatique des prix IA activée. Les prix seront générés tous les jours à 00h00 (fuseau horaire: ${timezone}).`
            : 'Génération automatique des prix IA désactivée.';

        res.status(200).send({ 
            message: message,
            autoPricing: {
                enabled: enabled,
                timezone: timezone
            }
        });

    } catch (error) {
        console.error('Erreur lors de la mise à jour des préférences de génération automatique:', error);
        
        // Gestion des erreurs spécifiques
        if (error.code === 'permission-denied') {
            return res.status(403).send({ 
                error: 'Permission refusée. Vérifiez vos droits d\'accès.' 
            });
        }
        
        if (error.code === 'not-found') {
            return res.status(404).send({ 
                error: 'Utilisateur non trouvé.' 
            });
        }

        res.status(500).send({ 
            error: 'Erreur interne du serveur lors de la mise à jour des préférences de génération automatique.' 
        });
    }
});

// --- ROUTES D'INTÉGRATION PMS (SÉCURISÉES) ---

app.get('/api/integrations', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const userId = req.user.uid;
        const integrationsRef = db.collection('users').doc(userId).collection('integrations');
        const snapshot = await integrationsRef.get();

        if (snapshot.empty) {
            return res.status(200).json(null); // Pas d'intégration
        }

        // Renvoie la première intégration trouvée (en supposant un seul PMS à la fois)
        const integrationDoc = snapshot.docs[0];
        res.status(200).json({
            type: integrationDoc.id,
            ...integrationDoc.data()
        });
    } catch (error) {
        console.error("Erreur lors de la récupération des intégrations:", error.message);
        res.status(500).send({ error: "Erreur serveur." });
    }
});


/**
 * Teste les identifiants d'un PMS sans les sauvegarder.
 */
app.post('/api/integrations/test-connection', authenticateToken, async (req, res) => {
    const { type, credentials } = req.body;
    if (!type || !credentials) {
        return res.status(400).send({ error: 'Le type de PMS et les identifiants sont requis.' });
    }

    try {
        // Importer dynamiquement le manager (ESM)
        const { getPMSClient } = await import('./integrations/pmsManager.js');
        // CORRECTION: getPMSClient est maintenant asynchrone
        const client = await getPMSClient(type, credentials);
        
        await client.testConnection(); // Teste la connexion
        
        res.status(200).send({ message: 'Connexion réussie ✅' });
    } catch (error) {
        console.error("Erreur de connexion test PMS:", error.message);
        res.status(400).send({ error: error.message });
    }
});

/**
 * Connecte un PMS à un utilisateur et sauvegarde les identifiants.
 */
app.post('/api/integrations/connect', authenticateToken, async (req, res) => {
    const { type, credentials } = req.body;
    const userId = req.user.uid;

    if (!type || !credentials) {
        return res.status(400).send({ error: 'Le type de PMS et les identifiants sont requis.' });
    }

    try {
        // 1. Tester la connexion avant de sauvegarder
        const { getPMSClient } = await import('./integrations/pmsManager.js');
        // CORRECTION: getPMSClient est maintenant asynchrone
        const client = await getPMSClient(type, credentials);
        await client.testConnection();
        
        // 2. Si le test réussit, sauvegarder les identifiants
        const db = admin.firestore();
        // Sauvegarde dans une sous-collection de l'utilisateur
        const integrationRef = db.collection('users').doc(userId).collection('integrations').doc(type);
        
        await integrationRef.set({
            type: type,
            credentials: credentials, // NOTE: Pour une production réelle, ceci devrait être chiffré.
            connectedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastSync: null
        });
        
        res.status(200).send({ message: `Connexion à ${type} réussie et sauvegardée.` });
    } catch (error) {
        console.error("Erreur de connexion/sauvegarde PMS:", error.message);
        res.status(400).send({ error: error.message });
    }
});

/**
 * Synchronise (récupère) les propriétés du PMS déjà connecté.
 */
app.post('/api/integrations/sync-properties', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        
        // 1. Récupérer le client PMS configuré pour l'utilisateur
        const client = await getUserPMSClient(userId);

        // 2. Appeler la méthode getProperties() de l'adaptateur
        const pmsProperties = await client.getProperties(); // Ceci est la liste normalisée
        
        res.status(200).json(pmsProperties);
    } catch (error) {
        console.error("Erreur de synchronisation des propriétés:", error.message);
        res.status(400).send({ error: error.message });
    }
});

/**
 * Importe les propriétés PMS dans la base de données Priceye.
 */
app.post('/api/integrations/import-properties', authenticateToken, async (req, res) => {
    const { propertiesToImport, pmsType } = req.body; // Attend un tableau et le type de PMS
    const userId = req.user.uid;
    const userEmail = req.user.email;

    if (!propertiesToImport || !Array.isArray(propertiesToImport) || !pmsType) {
        return res.status(400).send({ error: "Une liste de 'propertiesToImport' et un 'pmsType' sont requis." });
    }

    try {
        const db = admin.firestore();
        
        // 1. Get user's teamId
        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        if (!userProfileDoc.exists || !userProfileDoc.data().teamId) { // CORRECTION: Vérification plus robuste
             console.error(`[Import] Échec: Profil utilisateur ${userId} non trouvé ou n'a pas de teamId.`);
             return res.status(404).send({ error: 'Profil utilisateur non trouvé ou teamId manquant.' });
        }
        const userProfile = userProfileDoc.data();
        const teamId = userProfile.teamId;
        
        // 2. Vérification de la limite de 10 propriétés pendant l'essai gratuit
        const subscriptionId = userProfile.stripeSubscriptionId;
        if (subscriptionId) {
            // Compter les propriétés actuelles
            const currentPropertiesSnapshot = await db.collection('properties')
                .where('teamId', '==', teamId).get();
            const currentPropertyCount = currentPropertiesSnapshot.size;
            
            // Compter les nouvelles propriétés à importer
            const newPropertiesCount = propertiesToImport.filter(p => p.pmsId && p.name).length;
            
            // Vérifier la limite
            const limitCheck = await checkTrialPropertyLimit(
                userId, 
                subscriptionId, 
                currentPropertyCount, 
                newPropertiesCount,
                db
            );
            
            if (!limitCheck.isAllowed) {
                return res.status(403).json({
                    error: 'LIMIT_EXCEEDED',
                    message: 'Vous dépassez la limite gratuite de 10 propriétés.',
                    currentCount: limitCheck.currentCount,
                    maxAllowed: limitCheck.maxAllowed,
                    requiresPayment: true,
                    attemptedImport: newPropertiesCount
                });
            }
        }
        
        // 3. Batch write to Firestore
        const batch = db.batch();
        let importedCount = 0;
        
        for (const prop of propertiesToImport) {
            if (!prop.pmsId || !prop.name) {
                console.warn('[Import] Propriété ignorée, pmsId or name manquant:', prop);
                continue;
            }

            // 3. Create new document in 'properties' collection
            const newPropertyRef = db.collection('properties').doc(); // Auto-generate ID
            
            const newPropertyData = {
                // PMS Info
                pmsId: prop.pmsId,
                pmsType: pmsType,
                
                // User/Team Info
                ownerId: userId,
                teamId: teamId, // CORRECTION: Assure que teamId est bien défini
                
                // Normalized Data from PMS
                address: prop.name, // Utilise le 'name' du PMS comme 'address'
                location: prop.location || 'Inconnue', // TODO: Améliorer la localisation
                surface: prop.surface || 0,
                capacity: prop.capacity || 0,
                
                // Priceye Defaults
                status: 'active',
                amenities: [],
                strategy: 'Équilibré',
                floor_price: 50, // Prix plancher par défaut
                base_price: 100, // Prix de base par défaut
                ceiling_price: null,
                min_stay: 1,
                max_stay: null,
                weekly_discount_percent: null,
                monthly_discount_percent: null,
                weekend_markup_percent: null
            };

            batch.set(newPropertyRef, newPropertyData);
            
            // 4. Log this creation
            const logRef = db.collection('properties').doc(newPropertyRef.id).collection('logs').doc();
            batch.set(logRef, {
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                userId: userId,
                userEmail: userEmail,
                action: 'import:pms',
                changes: { pmsId: prop.pmsId, pmsType: pmsType, name: prop.name }
            });

            importedCount++;
        }

        // 5. Commit batch
        await batch.commit();

        // 5bis. Enregistrer les listing IDs pour l'anti-abus des essais gratuits
        // (Même si l'utilisateur n'a pas encore fait de checkout, on enregistre les IDs)
        const listingIdsToRegister = propertiesToImport
            .filter(p => p.pmsId && p.name)
            .map(p => p.pmsId);
        
        if (listingIdsToRegister.length > 0) {
            const listingBatch = db.batch();
            for (const listingId of listingIdsToRegister) {
                // Vérifier si le listing ID n'est pas déjà enregistré
                const existing = await db.collection('used_listing_ids')
                    .where('listingId', '==', listingId)
                    .limit(1)
                    .get();
                
                if (existing.empty) {
                    // Enregistrer le listing ID
                    const usedListingRef = db.collection('used_listing_ids').doc();
                    listingBatch.set(usedListingRef, {
                        listingId: listingId,
                        userId: userId,
                        usedAt: admin.firestore.FieldValue.serverTimestamp(),
                        source: 'import_properties', // Source de l'enregistrement
                        propertyCount: listingIdsToRegister.length
                    });
                }
            }
            
            if (listingIdsToRegister.length > 0) {
                await listingBatch.commit();
                console.log(`[Import] ${listingIdsToRegister.length} listing ID(s) enregistré(s) pour l'anti-abus`);
            }
        }

        // 6. Importer les réservations pour chaque propriété importée
        let totalReservationsImported = 0;
        let totalReservationsUpdated = 0;
        const today = new Date();
        const sixMonthsAgo = new Date(today);
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
        const sixMonthsLater = new Date(today);
        sixMonthsLater.setMonth(sixMonthsLater.getMonth() + 6);
        
        const startDate = sixMonthsAgo.toISOString().split('T')[0];
        const endDate = sixMonthsLater.toISOString().split('T')[0];

        try {
            const client = await getUserPMSClient(userId);
            const pmsReservations = await client.getReservations(startDate, endDate);

            // Grouper les réservations par propriété PMS
            const reservationsByProperty = new Map();
            for (const pmsReservation of pmsReservations) {
                const propertyPmsId = pmsReservation.propertyId;
                if (!reservationsByProperty.has(propertyPmsId)) {
                    reservationsByProperty.set(propertyPmsId, []);
                }
                reservationsByProperty.get(propertyPmsId).push(pmsReservation);
            }

            // Pour chaque propriété importée, importer ses réservations
            const reservationsBatch = db.batch();
            for (const prop of propertiesToImport) {
                if (!prop.pmsId || !prop.name) continue;

                // Trouver l'ID Firestore de la propriété que nous venons d'importer
                const propertyQuery = await db.collection('properties')
                    .where('pmsId', '==', prop.pmsId)
                    .where('teamId', '==', teamId)
                    .limit(1)
                    .get();

                if (propertyQuery.empty) continue;
                const propertyDoc = propertyQuery.docs[0];
                const propertyId = propertyDoc.id;
                const reservationsRef = propertyDoc.ref.collection('reservations');

                // Récupérer les réservations pour cette propriété
                const propertyReservations = reservationsByProperty.get(prop.pmsId) || [];

                for (const pmsReservation of propertyReservations) {
                    // Chercher si une réservation avec ce pmsId existe déjà
                    const existingQuery = await reservationsRef
                        .where('pmsId', '==', pmsReservation.pmsId)
                        .limit(1)
                        .get();

                    const reservationData = {
                        startDate: pmsReservation.startDate,
                        endDate: pmsReservation.endDate,
                        pricePerNight: pmsReservation.totalPrice ? 
                            Math.round(pmsReservation.totalPrice / 
                                Math.max(1, Math.round((new Date(pmsReservation.endDate) - new Date(pmsReservation.startDate)) / (1000 * 60 * 60 * 24)))) : 0,
                        totalPrice: pmsReservation.totalPrice || 0,
                        channel: pmsReservation.channel || 'Direct',
                        status: pmsReservation.status === 'confirmed' ? 'confirmé' : pmsReservation.status || 'confirmé',
                        guestName: pmsReservation.guestName || '',
                        pmsId: pmsReservation.pmsId,
                        teamId: teamId,
                        pricingMethod: 'pms',
                        syncedAt: admin.firestore.FieldValue.serverTimestamp()
                    };

                    if (existingQuery.empty) {
                        // Nouvelle réservation
                        const newReservationRef = reservationsRef.doc();
                        reservationsBatch.set(newReservationRef, {
                            ...reservationData,
                            bookedAt: admin.firestore.FieldValue.serverTimestamp()
                        });
                        totalReservationsImported++;
                    } else {
                        // Mise à jour de la réservation existante
                        const existingDoc = existingQuery.docs[0];
                        reservationsBatch.update(existingDoc.ref, reservationData);
                        totalReservationsUpdated++;
                    }
                }
            }

            if (totalReservationsImported > 0 || totalReservationsUpdated > 0) {
                await reservationsBatch.commit();
            }
        } catch (reservationError) {
            console.error(`[Import] Erreur lors de l'importation des réservations:`, reservationError.message);
            // On continue quand même, les propriétés sont déjà importées
        }

        // Recalculer et mettre à jour la facturation Stripe après l'import
        if (importedCount > 0) {
            await recalculateAndUpdateBilling(userId, db);
        }
        
        const message = `${importedCount} propriété(s) importée(s) avec succès.`;
        const reservationsMessage = totalReservationsImported > 0 || totalReservationsUpdated > 0
            ? ` ${totalReservationsImported} nouvelle(s) réservation(s) importée(s), ${totalReservationsUpdated} réservation(s) mise(s) à jour.`
            : '';

        res.status(201).send({ 
            message: message + reservationsMessage,
            propertiesImported: importedCount,
            reservationsImported: totalReservationsImported,
            reservationsUpdated: totalReservationsUpdated
        });

    } catch (error) {
        console.error("Erreur lors de l'importation des propriétés:", error.message);
        res.status(500).send({ error: `Erreur interne du serveur: ${error.message}` });
    }
});

/**
 * NOUVEAU: Déconnecte un PMS et supprime ses identifiants.
 */
app.delete('/api/integrations/:type', authenticateToken, async (req, res) => {
    const { type } = req.params;
    const userId = req.user.uid;

    if (!type) {
        return res.status(400).send({ error: 'Le type de PMS est requis.' });
    }

    try {
        const db = admin.firestore();
        const integrationRef = db.collection('users').doc(userId).collection('integrations').doc(type);
        
        const doc = await integrationRef.get();
        if (!doc.exists) {
            return res.status(404).send({ error: 'Aucune intégration de ce type n\'a été trouvée.' });
        }

        await integrationRef.delete();
        
        res.status(200).send({ message: 'Déconnexion réussie.' });
    } catch (error) {
        console.error("Erreur lors de la déconnexion du PMS:", error.message);
        res.status(500).send({ error: error.message });
    }
});



// --- ROUTES DE L'API POUR LES PROPRIÉTÉS (SÉCURISÉES) ---
app.get('/api/properties', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const userId = req.user.uid;
        
        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        if (!userProfileDoc.exists || !userProfileDoc.data().teamId) {
             console.warn(`Utilisateur ${userId} n'a pas de teamId, fallback sur ownerId.`);
             const propertiesSnapshot = await db.collection('properties').where('ownerId', '==', userId).get();
             const properties = propertiesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
             return res.status(200).json(properties);
        }
        const teamId = userProfileDoc.data().teamId;
        
        const propertiesSnapshot = await db.collection('properties').where('teamId', '==', teamId).get();
        
        const properties = propertiesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.status(200).json(properties);
    } catch (error) {
        console.error('Erreur lors de la récupération des propriétés:', error);
        res.status(500).send({ error: 'Erreur lors de la récupération des propriétés.' });
    }
});

app.post('/api/properties', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const newPropertyData = req.body;
        const userId = req.user.uid;
        if (!newPropertyData || !newPropertyData.address || !newPropertyData.location) {
            return res.status(400).send({ error: 'Les données fournies sont incomplètes.' });
        }
        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        if (!userProfileDoc.exists) {
            return res.status(404).send({ error: 'Profil utilisateur non trouvé.' });
        }
        const userProfile = userProfileDoc.data();
        const teamId = userProfile.teamId || userId;
        
        // Vérification de la limite de 10 propriétés pendant l'essai gratuit
        const subscriptionId = userProfile.stripeSubscriptionId;
        if (subscriptionId) {
            // Compter les propriétés actuelles
            const currentPropertiesSnapshot = await db.collection('properties')
                .where('teamId', '==', teamId).get();
            const currentPropertyCount = currentPropertiesSnapshot.size;
            
            // Vérifier la limite
            const limitCheck = await checkTrialPropertyLimit(
                userId, 
                subscriptionId, 
                currentPropertyCount, 
                1, // 1 nouvelle propriété
                db
            );
            
            if (!limitCheck.isAllowed) {
                return res.status(403).json({
                    error: 'LIMIT_EXCEEDED',
                    message: 'Vous dépassez la limite gratuite de 10 propriétés.',
                    currentCount: limitCheck.currentCount,
                    maxAllowed: limitCheck.maxAllowed,
                    requiresPayment: true
                });
            }
        } 

        const propertyWithOwner = { 
            ...newPropertyData, 
            ownerId: userId, 
            teamId: teamId, 
            status: 'active', // Statut par défaut
            amenities: newPropertyData.amenities || [],
            strategy: newPropertyData.strategy || 'Équilibré',
            floor_price: newPropertyData.floor_price || 0,
            base_price: newPropertyData.base_price || 100,
            ceiling_price: newPropertyData.ceiling_price || null,
            min_stay: newPropertyData.min_stay || 1,
            max_stay: newPropertyData.max_stay || null,
            weekly_discount_percent: newPropertyData.weekly_discount_percent || null,
            monthly_discount_percent: newPropertyData.monthly_discount_percent || null,
            weekend_markup_percent: newPropertyData.weekend_markup_percent || null
        };
        const docRef = await db.collection('properties').add(propertyWithOwner);
        
        // Log de la création
        await logPropertyChange(docRef.id, req.user.uid, req.user.email, 'create', propertyWithOwner);
        
        // Recalculer et mettre à jour la facturation Stripe
        await recalculateAndUpdateBilling(userId, db);
        
        res.status(201).send({ message: 'Propriété ajoutée avec succès', id: docRef.id });
    } catch (error) {
        console.error('Erreur lors de l\'ajout de la propriété:', error);
        res.status(500).send({ error: 'Erreur lors de l\'ajout de la propriété.' });
    }
});

app.put('/api/properties/:id', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const propertyId = req.params.id;
        const userId = req.user.uid;
        const updatedData = req.body;

        const propertyRef = db.collection('properties').doc(propertyId);
        const doc = await propertyRef.get();
        if (!doc.exists) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }
        
        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        const propertyTeamId = doc.data().teamId || doc.data().ownerId; 
        if (!userProfileDoc.exists || userProfileDoc.data().teamId !== propertyTeamId) {
             return res.status(403).send({ error: 'Action non autorisée (pas dans la bonne équipe).' });
        }
        if (userProfileDoc.data().role !== 'admin' && userProfileDoc.data().role !== 'manager') {
             return res.status(403).send({ error: 'Action non autorisée (rôle insuffisant).' });
        }
        
        // Log de la modification
        await logPropertyChange(propertyId, req.user.uid, req.user.email, 'update:details', updatedData);
        
        await propertyRef.update(updatedData);
        res.status(200).send({ message: 'Propriété mise à jour avec succès', id: propertyId });
    } catch (error) {
        console.error('Erreur lors de la mise à jour de la propriété:', error);
        res.status(500).send({ error: 'Erreur lors de la mise à jour de la propriété.' });
    }
});

app.delete('/api/properties/:id', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const propertyId = req.params.id;
        const userId = req.user.uid;
        const propertyRef = db.collection('properties').doc(propertyId);
        const doc = await propertyRef.get();
        if (!doc.exists) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }
        
        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        const propertyTeamId = doc.data().teamId || doc.data().ownerId;
         if (!userProfileDoc.exists || userProfileDoc.data().teamId !== propertyTeamId) {
             return res.status(403).send({ error: 'Action non autorisée (pas dans la bonne équipe).' });
        }
        if (userProfileDoc.data().role !== 'admin') {
             return res.status(403).send({ error: 'Action non autorisée (rôle admin requis).' });
        }
        
        // Log de la suppression
        await logPropertyChange(propertyId, req.user.uid, req.user.email, 'delete', { name: doc.data().address });

        await propertyRef.delete();
        
        // Recalculer et mettre à jour la facturation Stripe
        await recalculateAndUpdateBilling(userId, db);
        
        res.status(200).send({ message: 'Propriété supprimée avec succès', id: propertyId });
    } catch (error) {
        console.error('Erreur lors de la suppression de la propriété:', error);
        res.status(500).send({ error: 'Erreur lors de la suppression de la propriété.' });
    }
});

app.post('/api/properties/:id/sync', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { id: propertyId } = req.params;
        const userId = req.user.uid;

        // 1. Vérifier les droits
        const propertyRef = db.collection('properties').doc(propertyId);
        const doc = await propertyRef.get();
        if (!doc.exists) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }
        
        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        const propertyTeamId = doc.data().teamId || doc.data().ownerId; 
        if (!userProfileDoc.exists || userProfileDoc.data().teamId !== propertyTeamId) {
             return res.status(403).send({ error: 'Action non autorisée (pas dans la bonne équipe).' });
        }
        if (userProfileDoc.data().role !== 'admin' && userProfileDoc.data().role !== 'manager') {
             return res.status(403).send({ error: 'Action non autorisée (rôle insuffisant).' });
        }

        // 2. Log de début de synchro
        await logPropertyChange(propertyId, req.user.uid, req.user.email, 'sync:start', {});
        
        // 3. Simuler un travail
        console.log(`[Mock Sync] Démarrage de la synchronisation pour ${propertyId}...`);
        await new Promise(resolve => setTimeout(resolve, 2000)); // Simule 2 secondes
        console.log(`[Mock Sync] Synchronisation terminée pour ${propertyId}.`);

        // 4. Log de fin de synchro
        await logPropertyChange(propertyId, req.user.uid, req.user.email, 'sync:complete', { status: "mock_success" });

        res.status(200).send({ message: 'Synchronisation terminée avec succès !' });

    } catch (error) {
        console.error('Erreur lors de la synchronisation:', error);
        // Log de l'erreur de synchro
        await logPropertyChange(req.params.id, req.user.uid, req.user.email, 'sync:error', { error: error.message });
        res.status(500).send({ error: 'Erreur lors de la synchronisation.' });
    }
});


app.put('/api/properties/:id/strategy', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { id } = req.params;
        const userId = req.user.uid;
        const { strategy, floor_price, base_price, ceiling_price } = req.body;

        const allowedStrategies = ['Prudent', 'Équilibré', 'Agressif'];
        if (!strategy || !allowedStrategies.includes(strategy)) {
            return res.status(400).send({ error: 'Stratégie invalide ou manquante.' });
        }
        const floorPriceNum = Number(floor_price);
        const basePriceNum = Number(base_price);
        const ceilingPriceNum = ceiling_price != null ? Number(ceiling_price) : null;

        if (isNaN(floorPriceNum) || floorPriceNum < 0 || isNaN(basePriceNum) || basePriceNum < 0) {
             return res.status(400).send({ error: 'Prix plancher et de base sont requis et doivent être des nombres positifs.' });
         }
         if (floorPriceNum > basePriceNum) {
             return res.status(400).send({ error: 'Le prix plancher ne peut pas être supérieur au prix de base.' });
         }
        if (ceiling_price != null && (isNaN(ceilingPriceNum) || ceilingPriceNum < basePriceNum)) {
             return res.status(400).send({ error: 'Prix plafond doit être un nombre valide et supérieur ou égal au prix de base.' });
        }

        const propertyRef = db.collection('properties').doc(id);
        const doc = await propertyRef.get();
        if (!doc.exists) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }
        
        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        const propertyTeamId = doc.data().teamId || doc.data().ownerId;
         if (!userProfileDoc.exists || userProfileDoc.data().teamId !== propertyTeamId) {
             return res.status(403).send({ error: 'Action non autorisée (pas dans la bonne équipe).' });
        }
         if (userProfileDoc.data().role !== 'admin' && userProfileDoc.data().role !== 'manager') {
             return res.status(403).send({ error: 'Action non autorisée (rôle insuffisant).' });
        }

        const strategyData = {
            strategy,
            floor_price: floorPriceNum,
            base_price: basePriceNum,
            ceiling_price: ceilingPriceNum,
        };
        
        // 1. Sauvegarder dans Firestore (et log)
        await logPropertyChange(id, req.user.uid, req.user.email, 'update:strategy', strategyData);
        await propertyRef.update(strategyData);
        
        // 2. Vérifier si la propriété est liée au PMS
        const propertyData = doc.data();
        if (propertyData.pmsId && propertyData.pmsType) {
            // Vérifier si la synchronisation PMS est activée
            const syncEnabled = await isPMSSyncEnabled(userId, db);
            if (!syncEnabled) {
                console.log(`[PMS Sync] Synchronisation PMS désactivée pour l'utilisateur ${userId}. Synchronisation ignorée.`);
            } else {
                console.log(`[PMS Sync] Propriété ${id} (PMS ID: ${propertyData.pmsId}) est liée. Synchronisation des paramètres...`);
                try {
                    // 3. Récupérer le client PMS
                    const client = await getUserPMSClient(userId); 
                    
                    // 4. Appeler updatePropertySettings
                    const settingsToSync = {
                        base_price: strategyData.base_price,
                        floor_price: strategyData.floor_price,
                        ceiling_price: strategyData.ceiling_price
                    };
                    await client.updatePropertySettings(propertyData.pmsId, settingsToSync);
                    
                    console.log(`[PMS Sync] Paramètres de stratégie synchronisés avec ${propertyData.pmsType} pour ${id}.`);
                    
                } catch (pmsError) {
                    console.error(`[PMS Sync] ERREUR: Échec de la synchronisation des paramètres pour ${id}. Raison: ${pmsError.message}`);
                    // Renvoyer une erreur au client, même si Firestore a réussi
                    return res.status(500).send({ error: `Sauvegarde Firestore réussie, mais échec de la synchronisation PMS: ${pmsError.message}` });
                }
            }
        }
        
        // 5. Renvoyer le succès
        res.status(200).send({ message: 'Stratégie de prix mise à jour et synchronisée avec succès.' });


    } catch (error) {
        console.error('Erreur lors de la mise à jour de la stratégie:', error);
        res.status(500).send({ error: 'Erreur lors de la mise à jour de la stratégie.' });
    }
});

app.put('/api/properties/:id/rules', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { id } = req.params;
        const userId = req.user.uid;
        const { 
            min_stay, 
            max_stay, 
            weekly_discount_percent, 
            monthly_discount_percent, 
            weekend_markup_percent 
        } = req.body;

        const rulesData = {};
        const parseNumericOrNull = (value, min = 0, max = Infinity) => {
            if (value == null || value === '') return null;
            const num = Number(value);
            return !isNaN(num) && num >= min && num <= max ? num : null;
        };

        rulesData.min_stay = parseNumericOrNull(min_stay, 1);
        rulesData.max_stay = parseNumericOrNull(max_stay, rulesData.min_stay || 1);
        rulesData.weekly_discount_percent = parseNumericOrNull(weekly_discount_percent, 0, 100);
        rulesData.monthly_discount_percent = parseNumericOrNull(monthly_discount_percent, 0, 100);
        rulesData.weekend_markup_percent = parseNumericOrNull(weekend_markup_percent, 0);

        const cleanRulesData = Object.entries(rulesData)
          .filter(([_, value]) => value !== null)
          .reduce((obj, [key, value]) => {
            obj[key] = value;
            return obj;
          }, {});

        if (Object.keys(cleanRulesData).length === 0) {
             return res.status(200).send({ message: 'Aucune règle valide fournie, aucune mise à jour effectuée.' });
        }

        const propertyRef = db.collection('properties').doc(id);
        const doc = await propertyRef.get();
        if (!doc.exists) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }
        
        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        const propertyTeamId = doc.data().teamId || doc.data().ownerId;
         if (!userProfileDoc.exists || userProfileDoc.data().teamId !== propertyTeamId) {
             return res.status(403).send({ error: 'Action non autorisée (pas dans la bonne équipe).' });
        }
         if (userProfileDoc.data().role !== 'admin' && userProfileDoc.data().role !== 'manager') {
             return res.status(403).send({ error: 'Action non autorisée (rôle insuffisant).' });
        }
        
        // 1. Sauvegarder dans Firestore (et log)
        await logPropertyChange(id, req.user.uid, req.user.email, 'update:rules', cleanRulesData);
        await propertyRef.update(cleanRulesData);
        
        // 2. Vérifier si la propriété est liée au PMS
        const propertyData = doc.data(); // doc est déjà récupéré plus haut
        if (propertyData.pmsId && propertyData.pmsType) {
            // Vérifier si la synchronisation PMS est activée
            const syncEnabled = await isPMSSyncEnabled(userId, db);
            if (!syncEnabled) {
                console.log(`[PMS Sync] Synchronisation PMS désactivée pour l'utilisateur ${userId}. Synchronisation ignorée.`);
            } else {
                console.log(`[PMS Sync] Propriété ${id} (PMS ID: ${propertyData.pmsId}) est liée. Synchronisation des règles...`);
                try {
                    // 3. Récupérer le client PMS
                    const client = await getUserPMSClient(userId);
                    
                    // 4. Appeler updatePropertySettings
                    // Les 'cleanRulesData' (min_stay, etc.) sont exactement ce que nous voulons synchroniser
                    await client.updatePropertySettings(propertyData.pmsId, cleanRulesData);
                    
                    console.log(`[PMS Sync] Règles synchronisées avec ${propertyData.pmsType} pour ${id}.`);
                    
                } catch (pmsError) {
                    console.error(`[PMS Sync] ERREUR: Échec de la synchronisation des règles pour ${id}. Raison: ${pmsError.message}`);
                    // Renvoyer une erreur au client
                    return res.status(500).send({ error: `Sauvegarde Firestore réussie, mais échec de la synchronisation PMS: ${pmsError.message}` });
                }
            }
        }

        // 5. Renvoyer le succès
        res.status(200).send({ message: 'Règles personnalisées mises à jour et synchronisées avec succès.' });

    } catch (error) {
        console.error('Erreur lors de la mise à jour des règles:', error);
        res.status(500).send({ error: 'Erreur lors de la mise à jour des règles.' });
    }
});

app.put('/api/properties/:id/status', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { id } = req.params;
        const { status } = req.body;
        const userId = req.user.uid;

        // 1. Valider le statut
        const allowedStatus = ['active', 'archived', 'error'];
        if (!status || !allowedStatus.includes(status)) {
            return res.status(400).send({ error: 'Statut invalide. Les valeurs autorisées sont : active, archived, error.' });
        }

        // 2. Vérifier la propriété et les permissions
        const propertyRef = db.collection('properties').doc(id);
        const doc = await propertyRef.get();
        if (!doc.exists) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }

        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        const propertyTeamId = doc.data().teamId || doc.data().ownerId;
        if (!userProfileDoc.exists || userProfileDoc.data().teamId !== propertyTeamId) {
            return res.status(403).send({ error: 'Action non autorisée (pas dans la bonne équipe).' });
        }
        
        if (userProfileDoc.data().role !== 'admin' && userProfileDoc.data().role !== 'manager') {
             return res.status(403).send({ error: 'Action non autorisée (rôle insuffisant).' });
        }

        // 3. Log et mise à jour du statut
        await logPropertyChange(id, req.user.uid, req.user.email, 'update:status', { status: status });
        await propertyRef.update({ status: status });

        res.status(200).send({ message: 'Statut de la propriété mis à jour avec succès.' });

    } catch (error) {
        console.error('Erreur lors de la mise à jour du statut:', error);
        res.status(500).send({ error: 'Erreur serveur lors de la mise à jour du statut.' });
    }
});


// POST /api/properties/:id/bookings - Ajouter une réservation
app.post('/api/properties/:id/bookings', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { id: propertyId } = req.params;
        const userId = req.user.uid;
        const { startDate, endDate, pricePerNight, totalPrice, channel, guestName, numberOfGuests } = req.body;

        if (!startDate || !endDate || typeof pricePerNight !== 'number' || pricePerNight <= 0) {
            return res.status(400).send({ error: 'Dates de début/fin et prix par nuit valides sont requis.' });
        }

        const propertyRef = db.collection('properties').doc(propertyId);
        const propertyDoc = await propertyRef.get();
        if (!propertyDoc.exists) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }
        
        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        const propertyTeamId = propertyDoc.data().teamId || propertyDoc.data().ownerId;
         if (!userProfileDoc.exists || userProfileDoc.data().teamId !== propertyTeamId) {
             return res.status(403).send({ error: 'Action non autorisée (pas dans la bonne équipe).' });
        }

        const start = new Date(startDate);
        const end = new Date(endDate);
        const nights = Math.round((end - start) / (1000 * 60 * 60 * 24));
         if (nights <= 0) {
             return res.status(400).send({ error: 'La date de fin doit être après la date de début.' });
         }
         
        // Déterminer la méthode de tarification
        let pricingMethod = 'ia'; // Par défaut 'ia' (inclut le prix de base)
        try {
            const overrideRef = db.collection('properties').doc(propertyId).collection('price_overrides').doc(startDate);
            const overrideDoc = await overrideRef.get();
            
            if (overrideDoc.exists) {
                const reason = overrideDoc.data().reason;
                if (reason === 'Manuel') {
                    pricingMethod = 'manuelle';
                }
            }
        } catch (e) {
            console.error("Erreur lors de la vérification de la méthode de prix:", e);
        }

        const propertyData = propertyDoc.data();
        let pmsReservationId = null;

        // Synchronisation avec PMS si la propriété est liée
        if (propertyData.pmsId && propertyData.pmsType) {
            try {
                console.log(`[PMS Sync] Propriété ${propertyId} (PMS ID: ${propertyData.pmsId}) est liée. Création de la réservation...`);
                const client = await getUserPMSClient(userId);
                
                const reservationData = {
                    startDate,
                    endDate,
                    totalPrice: totalPrice || pricePerNight * nights,
                    guestName,
                    numberOfGuests,
                    channel: channel || 'Direct',
                    status: 'confirmed'
                };

                const pmsReservation = await client.createReservation(propertyData.pmsId, reservationData);
                pmsReservationId = pmsReservation.pmsId;
                console.log(`[PMS Sync] Réservation créée dans ${propertyData.pmsType} avec l'ID: ${pmsReservationId}`);
            } catch (pmsError) {
                console.error(`[PMS Sync] ERREUR lors de la création de la réservation pour ${propertyId}:`, pmsError.message);
                // On continue quand même avec la sauvegarde Firestore
            }
        }

        const newBooking = {
            startDate,
            endDate,
            pricePerNight,
            totalPrice: totalPrice || pricePerNight * nights,
            channel: channel || 'Direct',
            status: 'confirmé', // Statut par défaut
            pricingMethod: pricingMethod, // Méthode de prix
            bookedAt: admin.firestore.FieldValue.serverTimestamp(),
            teamId: propertyTeamId,
            ...(guestName && { guestName }),
            ...(numberOfGuests && typeof numberOfGuests === 'number' && { numberOfGuests }),
            ...(pmsReservationId && { pmsId: pmsReservationId }), // Stocker l'ID PMS si disponible
        };

        const bookingRef = await propertyRef.collection('reservations').add(newBooking);

        res.status(201).send({ 
            message: 'Réservation ajoutée avec succès.', 
            bookingId: bookingRef.id,
            ...(pmsReservationId && { pmsReservationId })
        });

    } catch (error) {
        console.error('Erreur lors de l\'ajout de la réservation:', error);
        res.status(500).send({ error: 'Erreur serveur lors de l\'ajout de la réservation.' });
    }
});

// GET /api/properties/:id/bookings - Récupérer les réservations pour un mois donné
app.get('/api/properties/:id/bookings', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { id: propertyId } = req.params;
        const userId = req.user.uid;
        const { year, month } = req.query; 

        const yearNum = parseInt(year);
        const monthNum = parseInt(month); // Attend 1-12
        if (isNaN(yearNum) || isNaN(monthNum) || monthNum < 1 || monthNum > 12) {
            return res.status(400).send({ error: 'Année et mois (1-12) valides sont requis.' });
        }

        const propertyRef = db.collection('properties').doc(propertyId);
        const propertyDoc = await propertyRef.get();
        if (!propertyDoc.exists) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }
       
        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        const propertyTeamId = propertyDoc.data().teamId || propertyDoc.data().ownerId;
         if (!userProfileDoc.exists || userProfileDoc.data().teamId !== propertyTeamId) {
             return res.status(403).send({ error: 'Action non autorisée (pas dans la bonne équipe).' });
        }

        const startOfMonth = `${yearNum}-${String(monthNum).padStart(2, '0')}-01`;
        const nextMonth = monthNum === 12 ? 1 : monthNum + 1;
        const nextYear = monthNum === 12 ? yearNum + 1 : yearNum;
        const startOfNextMonth = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

        const bookingsCol = propertyRef.collection('reservations');
        
        const q = bookingsCol
                        .where("startDate", "<", startOfNextMonth)
                        .where("endDate", ">", startOfMonth); 
        
        const snapshot = await q.get();

        const bookings = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        res.status(200).json(bookings);

    } catch (error) {
        if (error.message && error.message.includes('requires an index')) {
             console.error('ERREUR FIRESTORE - Index manquant :', error.message);
        } else {
             console.error('Erreur lors de la récupération des réservations:', error);
        }
        res.status(500).send({ error: 'Erreur serveur lors de la récupération des réservations. Vérifiez les logs du serveur pour plus de détails.' });
    }
});

// GET /api/bookings - Récupérer TOUTES les réservations pour une plage de dates
app.get('/api/bookings', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const userId = req.user.uid;
        const { startDate, endDate } = req.query; 

        if (!startDate || !endDate) {
            return res.status(400).send({ error: 'Les dates de début et de fin sont requises (startDate, endDate).' });
        }

        // 1. Récupérer le teamId de l'utilisateur
        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        if (!userProfileDoc.exists || !userProfileDoc.data().teamId) {
            return res.status(404).send({ error: 'Impossible de trouver votre équipe.' });
        }
        const teamId = userProfileDoc.data().teamId;

        // 2. Interroger toutes les réservations de l'équipe qui chevauchent la période
        const bookingsQuery = db.collectionGroup('reservations')
            .where('teamId', '==', teamId)
            .where('startDate', '<=', endDate) // Commencé avant ou pendant la fin
            .where('endDate', '>', startDate);  // Fini après ou pendant le début
            
        const snapshot = await bookingsQuery.get();

        if (snapshot.empty) {
             return res.status(200).json([]); // Renvoyer un tableau vide
        }
        
        // 3. Mapper les résultats
        const bookings = snapshot.docs.map(doc => ({
            id: doc.id,
            propertyId: doc.ref.parent.parent.id, // Ajouter l'ID de la propriété
            ...doc.data()
        }));

        res.status(200).json(bookings);

    } catch (error) {
        if (error.message && error.message.includes('requires an index')) {
             console.error('ERREUR FIRESTORE - Index manquant :', error.message);
             return res.status(500).send({ error: 'Index Firestore manquant. Veuillez exécuter la requête pour obtenir le lien de création dans les logs du serveur.' });
        }
        console.error('Erreur lors de la récupération de toutes les réservations:', error);
        res.status(500).send({ error: 'Erreur serveur lors de la récupération des réservations.' });
    }
});

// PUT /api/properties/:id/bookings/:bookingId - Modifier une réservation
app.put('/api/properties/:id/bookings/:bookingId', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { id: propertyId, bookingId } = req.params;
        const userId = req.user.uid;
        const { startDate, endDate, pricePerNight, totalPrice, channel, guestName, numberOfGuests, status } = req.body;

        const propertyRef = db.collection('properties').doc(propertyId);
        const propertyDoc = await propertyRef.get();
        if (!propertyDoc.exists) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }

        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        const propertyTeamId = propertyDoc.data().teamId || propertyDoc.data().ownerId;
        if (!userProfileDoc.exists || userProfileDoc.data().teamId !== propertyTeamId) {
            return res.status(403).send({ error: 'Action non autorisée (pas dans la bonne équipe).' });
        }

        const bookingRef = propertyRef.collection('reservations').doc(bookingId);
        const bookingDoc = await bookingRef.get();
        if (!bookingDoc.exists) {
            return res.status(404).send({ error: 'Réservation non trouvée.' });
        }

        const bookingData = bookingDoc.data();
        const propertyData = propertyDoc.data();

        // Préparer les données de mise à jour
        const updateData = {};
        if (startDate) updateData.startDate = startDate;
        if (endDate) updateData.endDate = endDate;
        if (pricePerNight != null) updateData.pricePerNight = pricePerNight;
        if (totalPrice != null) updateData.totalPrice = totalPrice;
        if (channel) updateData.channel = channel;
        if (guestName) updateData.guestName = guestName;
        if (numberOfGuests != null) updateData.numberOfGuests = numberOfGuests;
        if (status) updateData.status = status;
        updateData.updatedAt = admin.firestore.FieldValue.serverTimestamp();

        // Synchronisation avec PMS si la propriété est liée et la réservation a un pmsId
        if (propertyData.pmsId && propertyData.pmsType && bookingData.pmsId) {
            try {
                console.log(`[PMS Sync] Mise à jour de la réservation ${bookingId} (PMS ID: ${bookingData.pmsId})...`);
                const client = await getUserPMSClient(userId);
                
                const reservationData = {};
                if (startDate) reservationData.startDate = startDate;
                if (endDate) reservationData.endDate = endDate;
                if (totalPrice != null) reservationData.totalPrice = totalPrice;
                if (guestName) reservationData.guestName = guestName;
                if (numberOfGuests != null) reservationData.numberOfGuests = numberOfGuests;
                if (channel) reservationData.channel = channel;
                if (status) reservationData.status = status === 'confirmé' ? 'confirmed' : status;

                await client.updateReservation(bookingData.pmsId, reservationData);
                console.log(`[PMS Sync] Réservation mise à jour dans ${propertyData.pmsType}.`);
            } catch (pmsError) {
                console.error(`[PMS Sync] ERREUR lors de la mise à jour de la réservation pour ${propertyId}:`, pmsError.message);
                // On continue quand même avec la sauvegarde Firestore
            }
        }

        await bookingRef.update(updateData);

        res.status(200).send({ message: 'Réservation modifiée avec succès.' });
    } catch (error) {
        console.error('Erreur lors de la modification de la réservation:', error);
        res.status(500).send({ error: 'Erreur serveur lors de la modification de la réservation.' });
    }
});

// DELETE /api/properties/:id/bookings/:bookingId - Supprimer une réservation
app.delete('/api/properties/:id/bookings/:bookingId', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { id: propertyId, bookingId } = req.params;
        const userId = req.user.uid;

        const propertyRef = db.collection('properties').doc(propertyId);
        const propertyDoc = await propertyRef.get();
        if (!propertyDoc.exists) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }

        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        const propertyTeamId = propertyDoc.data().teamId || propertyDoc.data().ownerId;
        if (!userProfileDoc.exists || userProfileDoc.data().teamId !== propertyTeamId) {
            return res.status(403).send({ error: 'Action non autorisée (pas dans la bonne équipe).' });
        }

        const bookingRef = propertyRef.collection('reservations').doc(bookingId);
        const bookingDoc = await bookingRef.get();
        if (!bookingDoc.exists) {
            return res.status(404).send({ error: 'Réservation non trouvée.' });
        }

        const bookingData = bookingDoc.data();
        const propertyData = propertyDoc.data();

        // Synchronisation avec PMS si la propriété est liée et la réservation a un pmsId
        if (propertyData.pmsId && propertyData.pmsType && bookingData.pmsId) {
            try {
                console.log(`[PMS Sync] Suppression de la réservation ${bookingId} (PMS ID: ${bookingData.pmsId})...`);
                const client = await getUserPMSClient(userId);
                await client.deleteReservation(bookingData.pmsId);
                console.log(`[PMS Sync] Réservation supprimée dans ${propertyData.pmsType}.`);
            } catch (pmsError) {
                console.error(`[PMS Sync] ERREUR lors de la suppression de la réservation pour ${propertyId}:`, pmsError.message);
                // On continue quand même avec la suppression Firestore
            }
        }

        await bookingRef.delete();

        res.status(200).send({ message: 'Réservation supprimée avec succès.' });
    } catch (error) {
        console.error('Erreur lors de la suppression de la réservation:', error);
        res.status(500).send({ error: 'Erreur serveur lors de la suppression de la réservation.' });
    }
});

// POST /api/properties/:id/bookings/sync - Synchroniser les réservations depuis le PMS
app.post('/api/properties/:id/bookings/sync', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { id: propertyId } = req.params;
        const userId = req.user.uid;
        const { startDate, endDate } = req.body;

        if (!startDate || !endDate) {
            return res.status(400).send({ error: 'Les dates de début et de fin sont requises.' });
        }

        const propertyRef = db.collection('properties').doc(propertyId);
        const propertyDoc = await propertyRef.get();
        if (!propertyDoc.exists) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }

        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        const propertyTeamId = propertyDoc.data().teamId || propertyDoc.data().ownerId;
        if (!userProfileDoc.exists || userProfileDoc.data().teamId !== propertyTeamId) {
            return res.status(403).send({ error: 'Action non autorisée (pas dans la bonne équipe).' });
        }

        const propertyData = propertyDoc.data();
        if (!propertyData.pmsId || !propertyData.pmsType) {
            return res.status(400).send({ error: 'Cette propriété n\'est pas liée à un PMS.' });
        }

        try {
            console.log(`[PMS Sync] Synchronisation des réservations depuis ${propertyData.pmsType} pour ${propertyId}...`);
            const client = await getUserPMSClient(userId);
            const pmsReservations = await client.getReservations(startDate, endDate);

            // Filtrer les réservations pour cette propriété uniquement
            const propertyReservations = pmsReservations.filter(
                res => res.propertyId === propertyData.pmsId
            );

            const batch = db.batch();
            const reservationsRef = propertyRef.collection('reservations');
            let importedCount = 0;
            let updatedCount = 0;

            for (const pmsReservation of propertyReservations) {
                // Chercher si une réservation avec ce pmsId existe déjà
                const existingQuery = await reservationsRef
                    .where('pmsId', '==', pmsReservation.pmsId)
                    .limit(1)
                    .get();

                const reservationData = {
                    startDate: pmsReservation.startDate,
                    endDate: pmsReservation.endDate,
                    pricePerNight: pmsReservation.totalPrice ? 
                        Math.round(pmsReservation.totalPrice / 
                            Math.max(1, Math.round((new Date(pmsReservation.endDate) - new Date(pmsReservation.startDate)) / (1000 * 60 * 60 * 24)))) : 0,
                    totalPrice: pmsReservation.totalPrice || 0,
                    channel: pmsReservation.channel || 'Direct',
                    status: pmsReservation.status === 'confirmed' ? 'confirmé' : pmsReservation.status || 'confirmé',
                    guestName: pmsReservation.guestName || '',
                    pmsId: pmsReservation.pmsId,
                    teamId: propertyTeamId,
                    pricingMethod: 'pms', // Marquer comme importé depuis PMS
                    syncedAt: admin.firestore.FieldValue.serverTimestamp()
                };

                if (existingQuery.empty) {
                    // Nouvelle réservation
                    const newReservationRef = reservationsRef.doc();
                    batch.set(newReservationRef, {
                        ...reservationData,
                        bookedAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                    importedCount++;
                } else {
                    // Mise à jour de la réservation existante
                    const existingDoc = existingQuery.docs[0];
                    batch.update(existingDoc.ref, reservationData);
                    updatedCount++;
                }
            }

            await batch.commit();

            res.status(200).send({ 
                message: `Synchronisation réussie. ${importedCount} nouvelle(s) réservation(s) importée(s), ${updatedCount} réservation(s) mise(s) à jour.`,
                imported: importedCount,
                updated: updatedCount,
                total: propertyReservations.length
            });
        } catch (pmsError) {
            console.error(`[PMS Sync] ERREUR lors de la synchronisation des réservations pour ${propertyId}:`, pmsError.message);
            return res.status(500).send({ error: `Échec de la synchronisation PMS: ${pmsError.message}` });
        }
    } catch (error) {
        console.error('Erreur lors de la synchronisation des réservations:', error);
        res.status(500).send({ error: 'Erreur serveur lors de la synchronisation des réservations.' });
    }
});

// GET /api/properties/:id/news - Récupérer les actualités spécifiques (avec cache par propriété)
app.get('/api/properties/:id/news', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { id: propertyId } = req.params;
        const userId = req.user.uid;

        // 1. Vérifier la propriété et les droits
        const propertyRef = db.collection('properties').doc(propertyId);
        const propertyDoc = await propertyRef.get();
        if (!propertyDoc.exists) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }
        
        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        const propertyTeamId = propertyDoc.data().teamId || propertyDoc.data().ownerId; 
        if (!userProfileDoc.exists || userProfileDoc.data().teamId !== propertyTeamId) { 
             return res.status(403).send({ error: 'Action non autorisée sur cette propriété (pas dans la bonne équipe).' });
        }
        
        const property = propertyDoc.data();
        const fullLocation = property.location || 'France';
        const city = fullLocation.split(',')[0].trim();

        // 2. Vérifier le cache de cette propriété
        const cacheRef = db.collection('properties').doc(propertyId).collection('cache').doc('localNews');
        const cacheDoc = await cacheRef.get();
        const now = new Date();
        const oneDay = 24 * 60 * 60 * 1000; 
        
        if (cacheDoc.exists) {
            const cacheData = cacheDoc.data();
            const cacheAge = (now.getTime() - cacheData.updatedAt.toDate().getTime());
            
            if (cacheAge < oneDay) {
                console.log(`Utilisation du cache pour les actualités de ${propertyId}`);
                return res.status(200).json(cacheData.data);
            }
        }

        // 3. Si cache vide ou expiré, appeler l'IA
        console.log(`Cache expiré ou absent pour ${propertyId} (ville: ${city}), appel de Gemini...`);
        const prompt = `
            Tu es un analyste de marché expert pour la location saisonnière.
            Utilise l'outil de recherche pour trouver 2-3 actualités ou événements 
            très récents (moins de 7 jours) OU à venir (6 prochains mois)
            spécifiques à la ville : "${city}".
            Concentre-toi sur les événements (concerts, festivals, salons) ou
            les tendances qui impactent la demande de location dans cette ville.

            Pour chaque actualité/événement:
            1. Fournis un titre concis.
            2. Fais un résumé d'une phrase.
            3. Estime l'impact sur les prix en pourcentage (ex: 15 pour +15%, -5 pour -5%).
            4. Catégorise cet impact comme "élevé", "modéré", ou "faible".

            Réponds UNIQUEMENT avec un tableau JSON valide. 
            N'inclus aucun texte avant ou après le tableau, même pas \`\`\`json.
            Le format doit être:
            [
                {
                    "title": "Titre de l'actualité",
                    "summary": "Résumé de l'actualité.",
                    "source": "Nom de la source (ex: 'Le Monde')",
                    "impact_percentage": 15,
                    "impact_category": "élevé"
                }
            ]
        `;

        const newsData = await callGeminiWithSearch(prompt);
        const newsDataArray = Array.isArray(newsData) ? newsData : (newsData ? [newsData] : []);

        if (newsDataArray.length === 0) {
             console.warn("Aucune actualité pertinente trouvée par Gemini pour", city);
        }

        // 4. Mettre à jour le cache
        await cacheRef.set({
            data: newsDataArray,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        await logPropertyChange(propertyId, "system", "auto-update", 'update:news-cache', { count: newsDataArray.length });


        res.status(200).json(newsDataArray);

    } catch (error) {
        console.error(`Erreur lors de la récupération des actualités pour ${req.params.id}:`, error);
         if (error.message.includes('403') || error.message.includes('API key not valid')) {
             res.status(500).send({ error: "L'API Gemini (Search) n'est pas correctement configurée." });
         } else if (error.message.includes('429') || error.message.includes('overloaded')) {
             res.status(503).send({ error: "L'API d'actualités est temporairement surchargée." });
        } else {
             res.status(500).send({ error: `Erreur serveur: ${error.message}` });
        }
    }
});



// --- ROUTES DE GESTION DES GROUPES (SÉCURISÉES) ---
app.post('/api/groups', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { name } = req.body;
        const userId = req.user.uid;
        if (!name) {
            return res.status(400).send({ error: 'Le nom du groupe est requis.' });
        }
        const newGroup = {
            name,
            ownerId: userId,
            properties: [],
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            syncPrices: false 
        };
        const docRef = await db.collection('groups').add(newGroup);
        
        // Recalculer et mettre à jour la facturation Stripe
        await recalculateAndUpdateBilling(userId, db);
        
        res.status(201).send({ message: 'Groupe créé avec succès', id: docRef.id });
    } catch (error) {
        console.error('Erreur lors de la création du groupe:', error);
        res.status(500).send({ error: 'Erreur lors de la création du groupe.' });
    }
});

app.get('/api/groups', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const userId = req.user.uid;
        const groupsSnapshot = await db.collection('groups').where('ownerId', '==', userId).get();
        const groups = groupsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.status(200).json(groups);
    } catch (error) {
        console.error('Erreur lors de la récupération des groupes:', error);
        res.status(500).send({ error: 'Erreur lors de la récupération des groupes.' });
    }
});

app.put('/api/groups/:id', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { id } = req.params;
        const { name, syncPrices, mainPropertyId } = req.body; 
        const userId = req.user.uid;

        const groupRef = db.collection('groups').doc(id);
        const doc = await groupRef.get();

        if (!doc.exists) {
            return res.status(404).send({ error: 'Groupe non trouvé.' });
        }

        if (doc.data().ownerId !== userId) {
            return res.status(403).send({ error: 'Action non autorisée sur ce groupe.' });
        }

        const dataToUpdate = {};
        if (name) {
            dataToUpdate.name = name;
        }
        if (syncPrices != null && typeof syncPrices === 'boolean') {
            dataToUpdate.syncPrices = syncPrices;
        }
         if (mainPropertyId) {
            if (doc.data().properties && doc.data().properties.includes(mainPropertyId)) {
                dataToUpdate.mainPropertyId = mainPropertyId;
            } else {
                return res.status(400).send({ error: 'La propriété principale doit faire partie du groupe.' });
            }
        }

        if (Object.keys(dataToUpdate).length === 0) {
             return res.status(400).send({ error: 'Aucune donnée valide à mettre à jour (name, syncPrices ou mainPropertyId requis).' });
        }

        await groupRef.update(dataToUpdate);

        res.status(200).send({ message: 'Groupe mis à jour avec succès', id });
    } catch (error) {
        console.error('Erreur lors de la mise à jour du groupe:', error);
        res.status(500).send({ error: 'Erreur lors de la mise à jour du groupe.' });
    }
});

app.delete('/api/groups/:id', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { id } = req.params;
        const userId = req.user.uid;
        const groupRef = db.collection('groups').doc(id);
        const doc = await groupRef.get();
        if (!doc.exists) {
            return res.status(404).send({ error: 'Groupe non trouvé.' });
        }
        if (doc.data().ownerId !== userId) {
            return res.status(403).send({ error: 'Action non autorisée sur ce groupe.' });
        }
        await groupRef.delete();
        
        // Recalculer et mettre à jour la facturation Stripe
        await recalculateAndUpdateBilling(userId, db);
        
        res.status(200).send({ message: 'Groupe supprimé avec succès', id });
    } catch (error) {
        console.error('Erreur lors de la suppression du groupe:', error);
        res.status(500).send({ error: 'Erreur lors de la suppression du groupe.' });
    }
});

app.put('/api/groups/:id/properties', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { id } = req.params;
        const { propertyIds } = req.body;
        const userId = req.user.uid;
        if (!propertyIds || !Array.isArray(propertyIds)) {
            return res.status(400).send({ error: 'Un tableau d\'IDs de propriétés est requis.' });
        }
        const groupRef = db.collection('groups').doc(id);
        const groupDoc = await groupRef.get();
        if (!groupDoc.exists) {
            return res.status(404).send({ error: 'Groupe non trouvé.' });
        }
        if (groupDoc.data().ownerId !== userId) {
            return res.status(403).send({ error: 'Action non autorisée sur ce groupe.' });
        }

        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        const teamId = userProfileDoc.exists ? userProfileDoc.data().teamId : userId;
        
        const groupData = groupDoc.data();
        const existingPropertiesInGroup = groupData.properties || [];
        let templatePropertyData = null;

        // 1. Définir le "modèle" de propriété (si le groupe n'est pas vide)
        if (existingPropertiesInGroup.length > 0) {
            const templatePropertyId = groupData.mainPropertyId || existingPropertiesInGroup[0]; 
            const templatePropDoc = await db.collection('properties').doc(templatePropertyId).get();
            
            if (templatePropDoc.exists) {
                templatePropertyData = templatePropDoc.data();
            } else {
                for (const propId of existingPropertiesInGroup) {
                     const tempDoc = await db.collection('properties').doc(propId).get();
                     if (tempDoc.exists) {
                         templatePropertyData = tempDoc.data();
                         break;
                     }
                }
                if (!templatePropertyData) {
                     console.warn(`Groupe ${id} ne contient que des propriétés fantômes. Le premier ajout définira le nouveau modèle.`);
                }
            }
        }

        // 2. Vérifier chaque nouvelle propriété par rapport au modèle
        for (const propId of propertyIds) {
            const propRef = db.collection('properties').doc(propId);
            const propDoc = await propRef.get();
            
            const propTeamId = propDoc.exists ? (propDoc.data().teamId || propDoc.data().ownerId) : null;
            if (!propDoc.exists || propTeamId !== teamId) { 
                return res.status(403).send({ error: `La propriété ${propId} est invalide ou n'appartient pas à votre équipe.` });
            }

            const newPropertyData = propDoc.data();

            if (!templatePropertyData) {
                // C'est la première propriété ajoutée. Elle devient le modèle.
                templatePropertyData = newPropertyData;
            } else {
                // Vérification géofencing : distance < 500m
                if (templatePropertyData.location && newPropertyData.location) {
                    // Extraire les coordonnées (format peut varier)
                    let templateLat, templateLon, newLat, newLon;
                    
                    if (templatePropertyData.location.latitude && templatePropertyData.location.longitude) {
                        templateLat = templatePropertyData.location.latitude;
                        templateLon = templatePropertyData.location.longitude;
                    } else if (typeof templatePropertyData.location === 'string') {
                        // Format "lat,lon" ou autre
                        const coords = templatePropertyData.location.split(',').map(c => parseFloat(c.trim()));
                        if (coords.length >= 2) {
                            templateLat = coords[0];
                            templateLon = coords[1];
                        }
                    }
                    
                    if (newPropertyData.location.latitude && newPropertyData.location.longitude) {
                        newLat = newPropertyData.location.latitude;
                        newLon = newPropertyData.location.longitude;
                    } else if (typeof newPropertyData.location === 'string') {
                        const coords = newPropertyData.location.split(',').map(c => parseFloat(c.trim()));
                        if (coords.length >= 2) {
                            newLat = coords[0];
                            newLon = coords[1];
                        }
                    }
                    
                    if (templateLat !== undefined && templateLon !== undefined && 
                        newLat !== undefined && newLon !== undefined) {
                        const distance = calculateDistance(templateLat, templateLon, newLat, newLon);
                        
                        if (distance > 500) {
                            return res.status(403).json({
                                error: 'GEO_FENCING_VIOLATION',
                                message: 'Les propriétés d\'un groupe doivent être à moins de 500m les unes des autres.',
                                distance: Math.round(distance),
                                maxDistance: 500
                            });
                        }
                    }
                }
                
                // Comparer au modèle (capacité, surface, et type de propriété)
                const fieldsToMatch = ['capacity', 'surface', 'property_type'];
                for (const field of fieldsToMatch) {
                    if (newPropertyData[field] !== templatePropertyData[field]) {
                        return res.status(400).send({ 
                            error: `Échec d'ajout : La propriété "${newPropertyData.address}" a un champ '${field}' (${newPropertyData[field] || 'N/A'}) 
                                    qui ne correspond pas au modèle du groupe (${templatePropertyData[field] || 'N/A'}). 
                                    Toutes les propriétés d'un groupe doivent avoir une capacité, une surface et un type identiques.`
                        });
                    }
                }
            }
        }
        
        await groupRef.update({
            properties: admin.firestore.FieldValue.arrayUnion(...propertyIds)
        });
        
        // Recalculer et mettre à jour la facturation Stripe
        await recalculateAndUpdateBilling(userId, db);
        
        res.status(200).send({ message: 'Propriétés ajoutées au groupe avec succès.' });
    } catch (error) {
        console.error('Erreur lors de l\'ajout de propriétés au groupe:', error);
        res.status(500).send({ error: 'Erreur lors de l\'ajout de propriétés au groupe.' });
    }
});

app.delete('/api/groups/:id/properties', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { id } = req.params;
        const { propertyIds } = req.body;
        const userId = req.user.uid;
        if (!propertyIds || !Array.isArray(propertyIds) || propertyIds.length === 0) {
            return res.status(400).send({ error: 'Un tableau d\'IDs de propriétés est requis.' });
        }
        const groupRef = db.collection('groups').doc(id);
        const groupDoc = await groupRef.get();
        if (!groupDoc.exists) {
            return res.status(404).send({ error: 'Groupe non trouvé.' });
        }
        if (groupDoc.data().ownerId !== userId) { 
            return res.status(403).send({ error: 'Action non autorisée sur ce groupe.' });
        }
        const currentPropertiesInGroup = groupDoc.data().properties || [];
        const propertiesToRemove = propertyIds.filter(propId => currentPropertiesInGroup.includes(propId));
        
        const mainPropertyId = groupDoc.data().mainPropertyId;
        let needsMainPropReset = false;
        if (mainPropertyId && propertiesToRemove.includes(mainPropertyId)) {
            needsMainPropReset = true;
        }

        if (propertiesToRemove.length === 0) {
            return res.status(404).send({ error: 'Aucune des propriétés spécifiées n\'a été trouvée dans ce groupe.' });
        }
        
        const updateData = {
             properties: admin.firestore.FieldValue.arrayRemove(...propertiesToRemove)
        };
        if (needsMainPropReset) {
            updateData.mainPropertyId = null; 
        }
        
        await groupRef.update(updateData);
        
        // Recalculer et mettre à jour la facturation Stripe
        await recalculateAndUpdateBilling(userId, db);
        
        res.status(200).send({ message: 'Propriétés retirées du groupe avec succès.' });
    } catch (error) {
        console.error('Erreur lors du retrait de propriétés du groupe:', error);
        res.status(500).send({ error: 'Erreur lors de la mise à jour des règles.' });
    }
});

app.put('/api/groups/:id/strategy', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { id } = req.params;
        const userId = req.user.uid;
        const { strategy, floor_price, base_price, ceiling_price } = req.body;

        const groupRef = db.collection('groups').doc(id);
        const groupDoc = await groupRef.get();
        if (!groupDoc.exists) {
            return res.status(404).send({ error: 'Groupe non trouvé.' });
        }
        if (groupDoc.data().ownerId !== userId) {
            return res.status(403).send({ error: 'Action non autorisée sur ce groupe.' });
        }
        
        // Valider les données (copié de /api/properties/:id/strategy)
        const allowedStrategies = ['Prudent', 'Équilibré', 'Agressif'];
        if (!strategy || !allowedStrategies.includes(strategy)) {
            return res.status(400).send({ error: 'Stratégie invalide ou manquante.' });
        }
        const floorPriceNum = Number(floor_price);
        const basePriceNum = Number(base_price);
        const ceilingPriceNum = ceiling_price != null ? Number(ceiling_price) : null;
        if (isNaN(floorPriceNum) || floorPriceNum < 0 || isNaN(basePriceNum) || basePriceNum < 0) {
             return res.status(400).send({ error: 'Prix plancher et de base sont requis et doivent être des nombres positifs.' });
         }
         // ... (autres validations)

        const strategyData = {
            strategy,
            floor_price: floorPriceNum,
            base_price: basePriceNum,
            ceiling_price: ceilingPriceNum,
        };

        const propertiesInGroup = groupDoc.data().properties || [];
        if (propertiesInGroup.length === 0) {
            return res.status(400).send({ error: 'Ce groupe ne contient aucune propriété.' });
        }
        
        const batch = db.batch();
        
        // Mettre à jour le document du groupe lui-même avec la stratégie
        batch.update(groupRef, strategyData);
        
        // Mettre à jour toutes les propriétés du groupe
        propertiesInGroup.forEach(propId => {
            const propRef = db.collection('properties').doc(propId);
            batch.update(propRef, strategyData);
            // Log de l'action
            logPropertyChange(propId, req.user.uid, req.user.email, 'update:strategy:group', { ...strategyData, groupId: id });
        });
        
        await batch.commit();
        
        res.status(200).send({ message: `Stratégie appliquée au groupe et à ${propertiesInGroup.length} propriété(s).` });
        
    } catch (error) {
        console.error('Erreur lors de la mise à jour de la stratégie de groupe:', error);
        res.status(500).send({ error: 'Erreur lors de la mise à jour de la stratégie de groupe.' });
    }
});

app.put('/api/groups/:id/rules', authenticateToken, async (req, res) => {
     try {
        const db = admin.firestore();
        const { id } = req.params;
        const userId = req.user.uid;
        
        const groupRef = db.collection('groups').doc(id);
        const groupDoc = await groupRef.get();
        if (!groupDoc.exists) {
            return res.status(404).send({ error: 'Groupe non trouvé.' });
        }
        if (groupDoc.data().ownerId !== userId) {
            return res.status(403).send({ error: 'Action non autorisée sur ce groupe.' });
        }

        // Valider les données (copié de /api/properties/:id/rules)
        const { min_stay, max_stay, weekly_discount_percent, monthly_discount_percent, weekend_markup_percent } = req.body;
        const rulesData = {};
        const parseNumericOrNull = (value, min = 0, max = Infinity) => {
            if (value == null || value === '') return null;
            const num = Number(value);
            return !isNaN(num) && num >= min && num <= max ? num : null;
        };
        rulesData.min_stay = parseNumericOrNull(min_stay, 1);
        rulesData.max_stay = parseNumericOrNull(max_stay, rulesData.min_stay || 1);
        rulesData.weekly_discount_percent = parseNumericOrNull(weekly_discount_percent, 0, 100);
        rulesData.monthly_discount_percent = parseNumericOrNull(monthly_discount_percent, 0, 100);
        rulesData.weekend_markup_percent = parseNumericOrNull(weekend_markup_percent, 0);

        const cleanRulesData = Object.entries(rulesData)
          .filter(([_, value]) => value !== null)
          .reduce((obj, [key, value]) => {
            obj[key] = value;
            return obj;
          }, {});

        if (Object.keys(cleanRulesData).length === 0) {
             return res.status(200).send({ message: 'Aucune règle valide fournie, aucune mise à jour effectuée.' });
        }

        const propertiesInGroup = groupDoc.data().properties || [];
        if (propertiesInGroup.length === 0) {
            return res.status(400).send({ error: 'Ce groupe ne contient aucune propriété.' });
        }
        
        const batch = db.batch();
        propertiesInGroup.forEach(propId => {
            const propRef = db.collection('properties').doc(propId);
            batch.update(propRef, cleanRulesData);
            // Log de l'action
            logPropertyChange(propId, req.user.uid, req.user.email, 'update:rules:group', { ...cleanRulesData, groupId: id });
        });
        
        await batch.commit();
        
        res.status(200).send({ message: `Règles appliquées à ${propertiesInGroup.length} propriétés.` });
        
    } catch (error) {
        console.error('Erreur lors de la mise à jour des règles de groupe:', error);
        res.status(500).send({ error: 'Erreur lors de la mise à jour des règles de groupe.' });
    }
});


// --- ROUTES DE GESTION D'ÉQUIPE (SÉCURISÉES) ---
app.post('/api/teams/invites', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { email: inviteeEmail, role = 'member' } = req.body;
        const inviterId = req.user.uid;

        if (!inviteeEmail) {
            return res.status(400).send({ error: 'L\'adresse e-mail de l\'invité est requise.' });
        }
        
        const allowedRoles = ['admin', 'manager', 'member'];
        if (!allowedRoles.includes(role)) {
            return res.status(400).send({ error: 'Rôle invalide.' });
        }

        const inviterProfileRef = db.collection('users').doc(inviterId);
        const inviterProfileDoc = await inviterProfileRef.get();
        if (!inviterProfileDoc.exists || !inviterProfileDoc.data().teamId) {
             return res.status(404).send({ error: 'Profil de l\'inviteur ou ID d\'équipe non trouvé.' });
        }
        const inviterData = inviterProfileDoc.data();
        const teamId = inviterData.teamId;

        if (inviterData.role !== 'admin') {
             return res.status(403).send({ error: 'Seul un administrateur peut inviter des membres.' });
        }
        
        let inviteeUser;
        try {
            inviteeUser = await admin.auth().getUserByEmail(inviteeEmail);
             const inviteeProfileRef = db.collection('users').doc(inviteeUser.uid);
             const inviteeProfileDoc = await inviteeProfileRef.get();
             if (inviteeProfileDoc.exists && inviteeProfileDoc.data().teamId) {
                  return res.status(409).send({ error: 'Cet utilisateur fait déjà partie d\'une équipe.' });
             }
        } catch (error) {
            if (error.code !== 'auth/user-not-found') { throw error; }
        }

        const existingInviteQuery = await db.collection('invitations')
            .where('teamId', '==', teamId)
            .where('inviteeEmail', '==', inviteeEmail)
            .where('status', '==', 'pending')
            .limit(1)
            .get();
        
        if (!existingInviteQuery.empty) {
            return res.status(409).send({ error: 'Une invitation est déjà en attente pour cet utilisateur et cette équipe.' });
        }

        const invitation = {
            teamId: teamId,
            inviteeEmail: inviteeEmail,
            inviterId: inviterId,
            role: role,
            status: 'pending',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        const docRef = await db.collection('invitations').add(invitation);

        console.log(`SIMULATION: Envoi d'un email d'invitation à ${inviteeEmail} pour rejoindre l'équipe ${teamId} avec le rôle ${role}. Invitation ID: ${docRef.id}`);

        res.status(201).send({
            message: 'Invitation envoyée avec succès (simulation)',
            inviteId: docRef.id
        });

    } catch (error) {
        console.error('Erreur lors de l\'invitation:', error);
        res.status(500).send({ error: 'Erreur interne du serveur lors de l\'invitation.' });
    }
});

app.get('/api/teams/members', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const userId = req.user.uid;

        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        if (!userProfileDoc.exists || !userProfileDoc.data().teamId) {
            return res.status(404).send({ error: 'Impossible de trouver votre équipe.' });
        }
        const teamId = userProfileDoc.data().teamId;

        const membersSnapshot = await db.collection('users').where('teamId', '==', teamId).get();

        const members = membersSnapshot.docs.map(doc => {
            const data = doc.data();
            return {
                id: doc.id,
                name: data.name,
                email: data.email,
                role: data.role
            };
        });

        res.status(200).json(members);

    } catch (error) {
        console.error('Erreur lors de la récupération des membres de l\'équipe:', error);
        res.status(500).send({ error: 'Erreur lors de la récupération des membres de l\'équipe.' });
    }
});

app.put('/api/teams/members/:memberId/role', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { memberId } = req.params;
        const { role: newRole } = req.body;
        const adminId = req.user.uid;

        const allowedRoles = ['admin', 'manager', 'member'];
        if (!newRole || !allowedRoles.includes(newRole)) {
            return res.status(400).send({ error: 'Rôle invalide.' });
        }

        const adminProfileRef = db.collection('users').doc(adminId);
        const adminProfileDoc = await adminProfileRef.get();
        if (!adminProfileDoc.exists || adminProfileDoc.data().role !== 'admin') {
            return res.status(403).send({ error: 'Action non autorisée. Seul un administrateur peut modifier les rôles.' });
        }
        const teamId = adminProfileDoc.data().teamId;

        if (adminId === memberId) {
             return res.status(400).send({ error: 'Vous ne pouvez pas modifier votre propre rôle.' });
        }

        const memberProfileRef = db.collection('users').doc(memberId);
        const memberProfileDoc = await memberProfileRef.get();
        if (!memberProfileDoc.exists) {
            return res.status(404).send({ error: 'Membre non trouvé.' });
        }
        if (memberProfileDoc.data().teamId !== teamId) {
            return res.status(403).send({ error: 'Ce membre ne fait pas partie de votre équipe.' });
        }

        await memberProfileRef.update({ role: newRole });

        res.status(200).send({ message: 'Rôle du membre mis à jour avec succès.' });

    } catch (error) {
        console.error('Erreur lors de la modification du rôle:', error);
        res.status(500).send({ error: 'Erreur interne du serveur lors de la modification du rôle.' });
    }
});

app.delete('/api/teams/members/:memberId', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { memberId } = req.params;
        const adminId = req.user.uid;

        const adminProfileRef = db.collection('users').doc(adminId);
        const adminProfileDoc = await adminProfileRef.get();
        if (!adminProfileDoc.exists || adminProfileDoc.data().role !== 'admin') {
            return res.status(403).send({ error: 'Action non autorisée. Seul un administrateur peut supprimer des membres.' });
        }
        const teamId = adminProfileDoc.data().teamId;

        if (adminId === memberId) {
             return res.status(400).send({ error: 'Vous ne pouvez pas vous supprimer vous-même de l\'équipe.' });
        }

        const memberProfileRef = db.collection('users').doc(memberId);
        const memberProfileDoc = await memberProfileRef.get();
        if (!memberProfileDoc.exists) {
            return res.status(404).send({ error: 'Membre non trouvé.' });
        }
        if (memberProfileDoc.data().teamId !== teamId) {
            return res.status(403).send({ error: 'Ce membre ne fait pas partie de votre équipe.' });
        }

        await memberProfileRef.update({
             teamId: admin.firestore.FieldValue.delete(), 
             role: admin.firestore.FieldValue.delete() 
        });

        res.status(200).send({ message: 'Membre retiré de l\'équipe avec succès.' });

    } catch (error) {
        console.error('Erreur lors de la suppression du membre:', error);
        res.status(500).send({ error: 'Erreur interne du serveur lors de la suppression du membre.' });
    }
});


// --- ROUTES POUR LES RAPPORTS (SÉCURISÉES) ---
app.get('/api/reports/kpis', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const userId = req.user.uid;
        const { startDate, endDate } = req.query; // ex: '2025-01-01', '2025-01-31'

        if (!startDate || !endDate) {
            return res.status(400).send({ error: 'Les dates de début et de fin sont requises.' });
        }

        // 1. Récupérer le teamId de l'utilisateur
        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        if (!userProfileDoc.exists || !userProfileDoc.data().teamId) {
            return res.status(404).send({ error: 'Impossible de trouver votre équipe.' });
        }
        const teamId = userProfileDoc.data().teamId;

        // 2. Récupérer les données des propriétés (pour le prix de base)
        const propertiesSnapshot = await db.collection('properties').where('teamId', '==', teamId).get();
        if (propertiesSnapshot.empty) {
            return res.status(200).json({ totalRevenue: 0, totalNightsBooked: 0, adr: 0, occupancy: 0, totalNightsAvailable: 0, iaGain: 0, iaScore: 0, revPar: 0 });
        }
        
        const propertyBasePrices = new Map();
        propertiesSnapshot.forEach(doc => {
            propertyBasePrices.set(doc.id, doc.data().base_price || 0); // Utiliser 0 si non défini
        });
        
        const totalPropertiesInTeam = propertiesSnapshot.size;

        // 3. Calculer le nombre de jours dans la période
        const start = new Date(startDate);
        const end = new Date(endDate);
        const daysInPeriod = Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1; // +1 pour inclure le dernier jour
        const totalNightsAvailable = totalPropertiesInTeam * daysInPeriod;

        // 4. Interroger toutes les réservations de l'équipe qui chevauchent la période
        const bookingsQuery = db.collectionGroup('reservations')
            .where('teamId', '==', teamId)
            .where('startDate', '<=', endDate) // Commencé avant ou pendant la fin
            .where('endDate', '>', startDate);  // Fini après ou pendant le début
            
        const snapshot = await bookingsQuery.get();

        if (snapshot.empty) {
             return res.status(200).json({ totalRevenue: 0, totalNightsBooked: 0, adr: 0, occupancy: 0, totalNightsAvailable: totalNightsAvailable, iaGain: 0, iaScore: 0, revPar: 0 });
        }

        let totalRevenue = 0;
        let totalNightsBooked = 0;
        let totalBaseRevenue = 0; // Pour calculer le gain IA
        let premiumNights = 0; // Pour le score IA

        // 5. Calculer les KPIs
        snapshot.forEach(doc => {
            const booking = doc.data();
            const propertyId = doc.ref.parent.parent.id; // ID de la propriété parente
            const basePrice = propertyBasePrices.get(propertyId) || 0; // Récupérer le prix de base

            const bookingStart = new Date(booking.startDate);
            const bookingEnd = new Date(booking.endDate);

            const effectiveStart = new Date(Math.max(bookingStart.getTime(), start.getTime()));
            const effectiveEnd = new Date(Math.min(bookingEnd.getTime(), end.getTime()));
            
            let nightsInPeriod = 0;
            let currentDate = new Date(effectiveStart);
            while(currentDate < effectiveEnd && currentDate <= end) { 
                nightsInPeriod++;
                currentDate.setDate(currentDate.getDate() + 1);
            }
            
            totalNightsBooked += nightsInPeriod;
            totalRevenue += (booking.pricePerNight || 0) * nightsInPeriod;
            
            // Nouveaux calculs
            totalBaseRevenue += (basePrice || 0) * nightsInPeriod;
            if (booking.pricePerNight > basePrice) {
                premiumNights += nightsInPeriod;
            }
        });

        const adr = totalNightsBooked > 0 ? totalRevenue / totalNightsBooked : 0;
        const occupancy = totalNightsAvailable > 0 ? (totalNightsBooked / totalNightsAvailable) * 100 : 0;
        const iaGain = totalRevenue - totalBaseRevenue;
        const iaScore = totalNightsBooked > 0 ? (premiumNights / totalNightsBooked) * 100 : 0;
        const revPar = totalNightsAvailable > 0 ? totalRevenue / totalNightsAvailable : 0;


        res.status(200).json({
            totalRevenue,
            totalNightsBooked,
            adr,
            occupancy: occupancy, 
            totalNightsAvailable,
            iaGain,
            iaScore,
            revPar
        });

    } catch (error) {
        if (error.message && error.message.includes('requires an index')) {
             console.error('ERREUR FIRESTORE - Index manquant :', error.message);
             return res.status(500).send({ error: 'Index Firestore manquant. Veuillez exécuter la requête pour obtenir le lien de création dans les logs du serveur.' });
        }
        console.error('Erreur lors du calcul des KPIs:', error);
        res.status(500).send({ error: 'Erreur serveur lors du calcul des KPIs.' });
    }
});

// GET /api/reports/revenue-over-time
app.get('/api/reports/revenue-over-time', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const userId = req.user.uid;
        const { startDate, endDate } = req.query;

        if (!startDate || !endDate) {
            return res.status(400).send({ error: 'Les dates de début et de fin sont requises.' });
        }

        // 1. Trouver le teamId et le nombre total de propriétés
        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        if (!userProfileDoc.exists || !userProfileDoc.data().teamId) {
            return res.status(404).send({ error: 'Impossible de trouver votre équipe.' });
        }
        const teamId = userProfileDoc.data().teamId;

        const propertiesSnapshot = await db.collection('properties').where('teamId', '==', teamId).get();
        const totalPropertiesInTeam = propertiesSnapshot.size;

        // 2. Initialiser une carte de dates
        const datesMap = new Map();
        let currentDate = new Date(startDate + 'T00:00:00Z'); // Forcer UTC
        const finalDate = new Date(endDate + 'T00:00:00Z');

        while (currentDate <= finalDate) {
            datesMap.set(currentDate.toISOString().split('T')[0], { revenue: 0, nightsBooked: 0 }); // Stocker un objet
            currentDate.setUTCDate(currentDate.getUTCDate() + 1);
        }

        // 3. Récupérer les réservations qui chevauchent la période
        const bookingsQuery = db.collectionGroup('reservations')
            .where('teamId', '==', teamId)
            .where('startDate', '<=', endDate)
            .where('endDate', '>', startDate);
            
        const snapshot = await bookingsQuery.get();

        // 4. Itérer sur chaque réservation et chaque jour de la réservation
        snapshot.forEach(doc => {
            const booking = doc.data();
            const pricePerNight = booking.pricePerNight || 0;
            
            let bookingDay = new Date(booking.startDate + 'T00:00:00Z');
            const bookingEnd = new Date(booking.endDate + 'T00:00:00Z');

            while (bookingDay < bookingEnd) {
                const dateStr = bookingDay.toISOString().split('T')[0];
                // Si le jour est dans notre plage de dates, ajouter le revenu
                if (datesMap.has(dateStr)) {
                    const current = datesMap.get(dateStr);
                    current.revenue += pricePerNight;
                    current.nightsBooked += 1;
                }
                bookingDay.setUTCDate(bookingDay.getUTCDate() + 1);
            }
        });

        res.status(200).json({
            labels: Array.from(datesMap.keys()),
            revenueData: Array.from(datesMap.values()).map(d => d.revenue),
            nightsBookedData: Array.from(datesMap.values()).map(d => d.nightsBooked),
            // Calculer l'offre (nuits disponibles) pour chaque jour
            supplyData: Array.from(datesMap.values()).map(d => totalPropertiesInTeam - d.nightsBooked)
        });

    } catch (error) {
        console.error('Erreur lors du calcul des revenus journaliers:', error);
        res.status(500).send({ error: 'Erreur serveur lors du calcul des revenus journaliers.' });
    }
});

// GET /api/reports/performance-over-time
app.get('/api/reports/performance-over-time', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const userId = req.user.uid;
        const { startDate, endDate } = req.query;

        if (!startDate || !endDate) {
            return res.status(400).send({ error: 'Les dates de début et de fin sont requises.' });
        }

        // 1. Find teamId and total properties
        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        if (!userProfileDoc.exists || !userProfileDoc.data().teamId) {
            return res.status(404).send({ error: 'Impossible de trouver votre équipe.' });
        }
        const teamId = userProfileDoc.data().teamId;

        const propertiesSnapshot = await db.collection('properties').where('teamId', '==', teamId).get();
        const totalPropertiesInTeam = propertiesSnapshot.size;

        if (totalPropertiesInTeam === 0) {
             return res.status(200).json({ labels: [], bookingCounts: [], occupancyRates: [] });
        }

        // 2. Determine interval
        const start = new Date(startDate + 'T00:00:00Z');
        const end = new Date(endDate + 'T00:00:00Z');
        const durationDays = Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1;
        const interval = durationDays > 90 ? 'week' : 'day'; // Switch to weekly if > 3 months

        // 3. Initialize aggregation maps
        const dailyData = new Map(); // YYYY-MM-DD -> { nightsBooked: 0, newBookings: 0 }
        let currentDate = new Date(start);
        while (currentDate <= end) {
            dailyData.set(currentDate.toISOString().split('T')[0], { nightsBooked: 0, newBookings: 0 });
            currentDate.setUTCDate(currentDate.getUTCDate() + 1);
        }

        // 4. Get bookings
        const bookingsQuery = db.collectionGroup('reservations')
            .where('teamId', '==', teamId)
            .where('startDate', '<=', endDate)
            .where('endDate', '>', startDate);
            
        const snapshot = await bookingsQuery.get();

        // 5. Populate dailyData map
        snapshot.forEach(doc => {
            const booking = doc.data();
            const bookingStartDateStr = booking.startDate;
            
            // A. Count new bookings (bookingCount)
            if (dailyData.has(bookingStartDateStr)) {
                dailyData.get(bookingStartDateStr).newBookings += 1;
            }
            
            // B. Count occupied nights (occupancyRate)
            let bookingDay = new Date(booking.startDate + 'T00:00:00Z');
            const bookingEnd = new Date(booking.endDate + 'T00:00:00Z');
            while (bookingDay < bookingEnd) {
                const dateStr = bookingDay.toISOString().split('T')[0];
                if (dailyData.has(dateStr)) {
                    dailyData.get(dateStr).nightsBooked += 1;
                }
                bookingDay.setUTCDate(bookingDay.getUTCDate() + 1);
            }
        });

        // 6. Aggregate results based on interval
        let labels = [];
        let bookingCounts = [];
        let occupancyRates = [];

        if (interval === 'day') {
            dailyData.forEach((value, date) => {
                labels.push(date);
                bookingCounts.push(value.newBookings);
                const occupancy = totalPropertiesInTeam > 0 ? (value.nightsBooked / totalPropertiesInTeam) * 100 : 0;
                occupancyRates.push(occupancy);
            });
        } else { // 'week'
            const weeklyData = new Map();
            dailyData.forEach((value, date) => {
                const weekId = getWeekId(new Date(date + 'T00:00:00Z'));
                if (!weeklyData.has(weekId)) {
                    weeklyData.set(weekId, { newBookings: 0, nightsBooked: 0, daysInInterval: 0 });
                }
                const week = weeklyData.get(weekId);
                week.newBookings += value.newBookings;
                week.nightsBooked += value.nightsBooked;
                week.daysInInterval += 1;
            });
            
            // Sort weekly data by key (date)
            const sortedWeeks = Array.from(weeklyData.keys()).sort();
            
            sortedWeeks.forEach(weekId => {
                const week = weeklyData.get(weekId);
                labels.push(weekId);
                bookingCounts.push(week.newBookings);
                const totalNightsPossible = totalPropertiesInTeam * week.daysInInterval;
                const occupancy = totalNightsPossible > 0 ? (week.nightsBooked / totalNightsPossible) * 100 : 0;
                occupancyRates.push(occupancy);
            });
        }
        
        res.status(200).json({ labels, bookingCounts, occupancyRates });

    } catch (error) {
         console.error('Erreur lors du calcul de la performance:', error);
         res.status(500).send({ error: 'Erreur serveur lors du calcul de la performance.' });
    }
});


// POST /api/reports/analyze-date
app.post('/api/reports/analyze-date', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const userId = req.user.uid;
        const { propertyId, date } = req.body;

        if (!propertyId || !date) {
            return res.status(400).send({ error: 'Un ID de propriété et une date (YYYY-MM-DD) sont requis.' });
        }

        // 1. Vérifier la propriété et les droits
        const propertyRef = db.collection('properties').doc(propertyId);
        const propertyDoc = await propertyRef.get();
        if (!propertyDoc.exists) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }
        
        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        const propertyTeamId = propertyDoc.data().teamId || propertyDoc.data().ownerId; 
        if (!userProfileDoc.exists || userProfileDoc.data().teamId !== propertyTeamId) { 
             return res.status(403).send({ error: 'Action non autorisée sur cette propriété.' });
        }
        
        const property = propertyDoc.data();
        const location = property.location || 'France';
        const city = location.split(',')[0].trim();
        const capacity = property.capacity || 2;

        // 2. Construire le prompt pour Gemini
        const prompt = `
            Tu es un analyste de marché expert pour la location saisonnière.
            Analyse la demande du marché pour la date spécifique: **${date}**
            dans la ville de: **${city}**
            pour un logement de type "${property.property_type || 'appartement'}" pouvant accueillir **${capacity} personnes**.

            Utilise l'outil de recherche Google pour trouver:
            1.  Les événements locaux (concerts, salons, matchs, vacances scolaires, jours fériés) ayant lieu à cette date ou ce week-end là.
            2.  Une estimation de la demande du marché (ex: "Faible", "Moyenne", "Élevée", "Très Élevée").
            3.  Une suggestion de fourchette de prix pour une nuit à cette date, basée sur le marché (ex: "120€ - 140€").

            Réponds UNIQUEMENT avec un objet JSON valide (pas de texte avant ou après, pas de markdown \`\`\`json).
            Le format doit être:
            {
              "marketDemand": "...",
              "events": [
                "Événement 1 (si trouvé)",
                "Événement 2 (si trouvé)"
              ],
              "priceSuggestion": "...",
              "analysisSummary": "Courte phrase résumant pourquoi la demande est ce qu'elle est."
            }
        `;

        // 3. Appeler Gemini avec l'outil de recherche
        const analysisResult = await callGeminiWithSearch(prompt);

        if (!analysisResult || !analysisResult.marketDemand) {
            // Renvoyer un objet JSON d'erreur contrôlée au lieu de planter
            return res.status(503).send({ error: "L'analyse IA n'a pas pu générer de réponse valide." });
        }

        // 4. Renvoyer le résultat
        res.status(200).json(analysisResult);

    } catch (error) {
        console.error(`Erreur lors de l'analyse de la date ${req.body.date}:`, error);
         if (error.message.includes('403') || error.message.includes('API key not valid')) {
             res.status(500).send({ error: "L'API Gemini (Search) n'est pas correctement configurée." });
         } else if (error.message.includes('429') || error.message.includes('overloaded')) {
             res.status(503).send({ error: "L'API d'analyse est temporairement surchargée." });
        } else {
             res.status(500).send({ error: `Erreur serveur: ${error.message}` });
        }
    }
});


// GET /api/recommendations/group-candidates - Suggérer des groupes
app.get('/api/recommendations/group-candidates', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const userId = req.user.uid;

        // 1. Trouver le teamId de l'utilisateur
        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        if (!userProfileDoc.exists || !userProfileDoc.data().teamId) {
             return res.status(404).send({ error: 'Impossible de trouver votre équipe.' });
        }
        const teamId = userProfileDoc.data().teamId;

        // 2. Récupérer toutes les propriétés de l'équipe
        const propertiesSnapshot = await db.collection('properties').where('teamId', '==', teamId).get();
        if (propertiesSnapshot.empty) {
            return res.status(200).json([]); // Pas de propriétés, pas de recommandations
        }

        // 3. Récupérer tous les groupes et les propriétés déjà groupées
        const groupsSnapshot = await db.collection('groups').where('ownerId', '==', userId).get(); // ou 'teamId' si les groupes sont partagés
        const groupedPropertyIds = new Set();
        groupsSnapshot.forEach(doc => {
            const propertiesInGroup = doc.data().properties || [];
            propertiesInGroup.forEach(propId => groupedPropertyIds.add(propId));
        });

        // 4. Filtrer les propriétés qui ne sont dans AUCUN groupe
        const ungroupedProperties = [];
        propertiesSnapshot.forEach(doc => {
            if (!groupedPropertyIds.has(doc.id)) {
                ungroupedProperties.push({ id: doc.id, ...doc.data() });
            }
        });

        // 5. Regrouper les propriétés non groupées par caractéristiques
        const candidates = new Map();
        const fieldsToMatch = ['capacity', 'surface', 'property_type'];
        
        ungroupedProperties.forEach(prop => {
             // Créer une clé unique basée sur les caractéristiques
             const key = fieldsToMatch.map(field => prop[field] || 'N/A').join('-');
             
             if (!candidates.has(key)) {
                 candidates.set(key, []);
             }
             candidates.get(key).push({
                 id: prop.id,
                 address: prop.address
             });
        });

        // 6. Ne garder que les groupes de 2 propriétés ou plus
        const recommendations = [];
        candidates.forEach((properties, key) => {
            if (properties.length >= 2) {
                recommendations.push({
                    key: key,
                    properties: properties
                });
            }
        });
        
        res.status(200).json(recommendations);

    } catch (error) {
        console.error('Erreur lors de la génération des recommandations de groupe:', error);
        res.status(500).send({ error: 'Erreur serveur lors de la génération des recommandations.' });
    }
});



// --- ROUTES DE L'IA DE TARIFICATION (SÉCURISÉES) ---

// Fonction utilitaire pour attendre (utilisée pour le retry)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Fonction helper pour appeler l'API Gemini avec retry et backoff exponentiel
 */
async function callGeminiAPI(prompt, maxRetries = 10) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error("GEMINI_API_KEY non trouvée dans .env");
        throw new Error("Clé API Gemini non configurée sur le serveur.");
    }
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`; 
    
    const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" }
    };

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (response.status === 429) {
                // Backoff exponentiel: 2^(attempt-1) secondes, avec un maximum de 60 secondes
                const waitTime = Math.min(Math.pow(2, attempt - 1) * 1000, 60000);
                console.warn(`Tentative ${attempt}/${maxRetries}: API Gemini surchargée (429). Nouvel essai dans ${waitTime / 1000} seconde(s)...`);
                await delay(waitTime);
                continue;
            }

            if (!response.ok) {
                const errorBody = await response.json();
                console.error(`Erreur API Gemini (Tentative ${attempt}):`, errorBody);
                throw new Error(`Erreur de l'API Gemini: ${errorBody.error?.message || response.statusText}`);
            }

            const result = await response.json();
            const candidate = result.candidates?.[0];
            const textPart = candidate?.content?.parts?.[0]?.text;

            // Extraire les informations de tokens depuis usageMetadata
            if (result.usageMetadata) {
                const inputTokens = result.usageMetadata.promptTokenCount || 0;
                const outputTokens = result.usageMetadata.candidatesTokenCount || 0;
                const totalTokens = result.usageMetadata.totalTokenCount || (inputTokens + outputTokens);
                console.log(`[Gemini Tokens] Entrée: ${inputTokens}, Sortie: ${outputTokens}, Total: ${totalTokens}`);
            }

            if (textPart) {
                try {
                    return JSON.parse(textPart);
                } catch (parseError) {
                    console.error("Erreur de parsing JSON de la réponse Gemini:", textPart);
                    throw new Error("Réponse de l'API Gemini reçue mais n'est pas un JSON valide.");
                }
            } else {
                console.error("Réponse Gemini inattendue:", result);
                throw new Error("Réponse de l'API Gemini malformée ou vide.");
            }
        } catch (error) {
             if (attempt === maxRetries) {
                 throw error;
             }
             console.error(`Erreur lors de la tentative ${attempt} d'appel à Gemini:`, error.message);
             // Backoff exponentiel: 2^(attempt-1) secondes, avec un maximum de 60 secondes
             const waitTime = Math.min(Math.pow(2, attempt - 1) * 1000, 60000);
             console.log(`Nouvelle tentative dans ${waitTime / 1000} seconde(s)...`);
             await delay(waitTime);
        }
    }
     throw new Error(`Échec de l'appel à l'API Gemini après ${maxRetries} tentatives.`);
}

/**
 * Fonction helper pour appeler l'API Gemini avec l'outil de recherche et backoff exponentiel
 */
async function callGeminiWithSearch(prompt, maxRetries = 10) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error("Clé API Gemini non configurée sur le serveur.");
    }
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`; 

    const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ "google_search": {} }], 
    };
    
     for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

             if (response.status === 429) {
                // Backoff exponentiel: 2^(attempt-1) secondes, avec un maximum de 60 secondes
                const waitTime = Math.min(Math.pow(2, attempt - 1) * 1000, 60000);
                console.warn(`Tentative ${attempt}/${maxRetries}: API Gemini (Search) surchargée (429). Nouvel essai dans ${waitTime / 1000} seconde(s)...`);
                await delay(waitTime);
                continue;
            }
            if (!response.ok) {
                const errorBody = await response.json();
                console.error(`Erreur API Gemini (Search) (Tentative ${attempt}):`, errorBody);
                throw new Error(`Erreur de l'API Gemini (Search): ${errorBody.error?.message || response.statusText}`);
            }

            const result = await response.json();
            const candidate = result.candidates?.[0];
            const textPart = candidate?.content?.parts?.[0]?.text;
            
            // Extraire les informations de tokens depuis usageMetadata
            if (result.usageMetadata) {
                const inputTokens = result.usageMetadata.promptTokenCount || 0;
                const outputTokens = result.usageMetadata.candidatesTokenCount || 0;
                const totalTokens = result.usageMetadata.totalTokenCount || (inputTokens + outputTokens);
                console.log(`[Gemini Tokens (Search)] Entrée: ${inputTokens}, Sortie: ${outputTokens}, Total: ${totalTokens}`);
            }
            
            if (textPart) {
                 try {
                    const cleanText = textPart.replace(/^```json\n?/, '').replace(/\n?```$/, '');
                    console.log("Texte JSON nettoyé reçu de Gemini (Search):", cleanText); // Log pour débogage
                    return JSON.parse(cleanText); 
                } catch (parseError) {
                    console.error("Erreur de parsing JSON de la réponse Gemini (Search):", textPart);
                    throw new Error("Réponse de l'API Gemini (Search) reçue mais n'est pas un JSON valide.");
                }
            } else {
                 console.error("Réponse Gemini (Search) inattendue:", result);
                 if (candidate?.finishReason === 'SAFETY') {
                      throw new Error("La réponse de l'IA a été bloquée pour des raisons de sécurité.");
                 } else if (candidate?.finishReason === 'OTHER') {
                     throw new Error("L'API Gemini n'a pas pu terminer la recherche.");
                 }
                throw new Error("Réponse de l'API Gemini (Search) malformée ou vide.");
            }
        } catch (error) {
             if (attempt === maxRetries) {
                 throw new Error(`Échec de l'appel à l'API Gemini (Search) après ${maxRetries} tentatives. ${error.message}`);
             }
             console.error(`Erreur (Search) Tentative ${attempt}:`, error.message);
             // Backoff exponentiel: 2^(attempt-1) secondes, avec un maximum de 60 secondes
             const waitTime = Math.min(Math.pow(2, attempt - 1) * 1000, 60000);
             console.log(`Nouvelle tentative dans ${waitTime / 1000} seconde(s)...`);
             await delay(waitTime);
        }
     }
}

// POST /api/properties/:id/pricing-strategy - Générer une stratégie de prix
app.post('/api/properties/:id/pricing-strategy', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { id } = req.params;
        const userId = req.user.uid;

        const propertyRef = db.collection('properties').doc(id);
        const propertyDoc = await propertyRef.get();

        if (!propertyDoc.exists) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }
        
        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        const propertyTeamId = propertyDoc.data().teamId || propertyDoc.data().ownerId; 
        if (!userProfileDoc.exists || userProfileDoc.data().teamId !== propertyTeamId) { 
             return res.status(403).send({ error: 'Action non autorisée sur cette propriété (pas dans la bonne équipe).' });
        }
        
        const property = propertyDoc.data();
        const today = new Date().toISOString().split('T')[0];

        const prompt = `
            Tu es un expert mondial en tarification dynamique pour le marché de la location saisonnière (${property.location}).
            Ton objectif est de créer une stratégie de prix détaillée, jour par jour, pour les 180 prochains jours, en respectant les règles définies par l'utilisateur.

            PROPRIÉTÉ À ANALYSER:
            ${JSON.stringify({
                address: property.address,
                location: property.location,
                property_type: property.property_type,
                capacity: property.capacity,
                surface: property.surface,
                amenities: property.amenities || []
            })}

            RÈLES UTILISATEUR À RESPECTER IMPÉRATIVEMENT:
            - Stratégie Générale: ${property.strategy || 'Équilibré'}

            INSTRUCTIONS DE STRATÉGIE DÉTAILLÉES:
            Tu dois pondérer les facteurs de demande (saisonnalité, événements) différemment selon la stratégie choisie:
            
            1.  **Si "Prudent":**
                * **Objectif:** Maximiser le taux d'occupation.
                * **Basse saison:** N'hésite pas à baisser le prix (vers le Prix Plancher) pour sécuriser des réservations.
                * **Haute saison/Événements:** Augmente le prix, mais reste légèrement *en dessous* du pic du marché pour garantir une réservation rapide.
                * **Pondération:** Taux d'occupation (Élevé) > Saisonnalité (Moyen) > Tendance Marché (Faible).

            2.  **Si "Équilibré" (Défaut):**
                * **Objectif:** Équilibre parfait entre Taux d'occupation et ADR.
                * **Basse saison:** Applique des réductions modérées.
                * **Haute saison/Événements:** Augmente le prix significativement pour suivre la demande du marché.
                * **Pondération:** Saisonnalité (Élevé) > Taux d'occupation (Moyen) > Tendance Marché (Moyen).

            3.  **Si "Agressif":**
                * **Objectif:** Maximiser l'ADR (Prix moyen par nuit).
                * **Basse saison:** Maintiens le prix proche du Prix de Base. Ne pas brader.
                * **Haute saison/Événements:** Augmente le prix *au-dessus* du marché. Il vaut mieux avoir moins de réservations mais à un prix très élevé.
                * **Pondération:** Tendance Marché/Événements (Élevé) > Saisonnalité (Moyen) > Taux d'occupation (Faible).

            - Prix Plancher Absolu: ${property.floor_price} € (Ne JAMAIS proposer un prix inférieur)
            - Prix de Référence (Base): ${property.base_price} € (Utilise comme point de départ pour tes ajustements)
            - Prix Plafond (Optionnel): ${property.ceiling_price != null ? property.ceiling_price + ' €' : 'Aucun'} (Ne JAMAIS proposer un prix supérieur si défini)
            - Durée Minimale de Séjour: ${property.min_stay != null ? property.min_stay + ' nuits' : 'Aucune'}
            - Durée Maximale de Séjour: ${property.max_stay != null ? property.max_stay + ' nuits' : 'Aucune'}
            - Réduction Hebdomadaire: ${property.weekly_discount_percent != null ? property.weekly_discount_percent + '%' : 'Aucune'}
            - Réduction Mensuelle: ${property.monthly_discount_percent != null ? property.monthly_discount_percent + '%' : 'Aucune'}
            - Majoration Week-end (Ven/Sam): ${property.weekend_markup_percent != null ? property.weekend_markup_percent + '%' : 'Aucune'}

            INSTRUCTIONS DÉTAILLÉES (SUITE):
            1.  **Analyse des Facteurs de Demande (180 jours à partir du ${today}) pour "${property.location}"**:
                * **Saisonnalité:** Haute, moyenne, basse saison.
                * **Effet Week-end:** Majoration si définie.
                * **Jours Fériés & Vacances Scolaires (France Zone A, B, C):** Impact sur la demande.
                * **Événements Locaux:** Recherche simulée (festivals, conférences, etc.).
                * **Qualité du bien:** Prendre en compte les équipements fournis.

            2.  **Génération des Prix Journaliers (180 jours):**
                * Pour CHAQUE jour, calcule un prix optimal.
                * Commence par le prix de base, puis ajuste en fonction des facteurs de demande ET des règles utilisateur (surtout la stratégie).
                * **Contraintes:** Le prix final doit TOUJOURS être >= Prix Plancher et <= Prix Plafond (si défini).
                * **Justification:** Fournis une raison CLAIRE pour chaque prix (ex: "Base + Majoration WE", "Haute saison + Vacances", "Événement + Agressif").

            FORMAT DE SORTIE OBLIGATOIRE (JSON uniquement, sans texte avant/après):
            {
              "strategy_summary": "Résumé très bref de la stratégie globale.",
              "daily_prices": [ { "date": "YYYY-MM-DD", "price": 135, "reason": "Basse saison" }, /* ... autres jours ... */ ]
            }
        `;

        const strategyResult = await callGeminiAPI(prompt);

        if (!strategyResult || !Array.isArray(strategyResult.daily_prices) || strategyResult.daily_prices.length === 0) {
            throw new Error("La réponse de l'IA est invalide ou ne contient pas de prix journaliers.");
        }

        // --- NOUVELLE ÉTAPE: Synchronisation PMS (AVANT la sauvegarde Firestore) ---
        if (property.pmsId && property.pmsType) {
            // Vérifier si la synchronisation PMS est activée
            const syncEnabled = await isPMSSyncEnabled(req.user.uid, db);
            if (!syncEnabled) {
                console.log(`[PMS Sync] Synchronisation PMS désactivée pour l'utilisateur ${req.user.uid}. Synchronisation ignorée.`);
            } else {
                console.log(`[PMS Sync] Propriété ${id} (PMS ID: ${property.pmsId}) est liée. Synchronisation de la stratégie IA...`);
                try {
                    // 1. Récupérer le client PMS
                    const client = await getUserPMSClient(req.user.uid);
                
                // 2. Appeler updateBatchRates
                // Nous filtrons les prix verrouillés localement AVANT de les envoyer au PMS
                // (Bien que la logique de verrouillage soit gérée côté Priceye)
                const lockedPricesCol = db.collection('properties').doc(id).collection('price_overrides');
                const lockedSnapshot = await lockedPricesCol.where('isLocked', '==', true).get();
                const lockedDates = new Set(lockedSnapshot.docs.map(doc => doc.id));
                
                const pricesToSync = strategyResult.daily_prices.filter(day => !lockedDates.has(day.date));
                
                    if (pricesToSync.length > 0) {
                        await client.updateBatchRates(property.pmsId, pricesToSync);
                        console.log(`[PMS Sync] Stratégie IA (${pricesToSync.length} jours) synchronisée avec ${property.pmsType} pour ${id}.`);
                    } else {
                        console.log(`[PMS Sync] Aucun prix à synchroniser (tous les jours générés étaient peut-être verrouillés).`);
                    }

                } catch (pmsError) {
                    console.error(`[PMS Sync] ERREUR FATALE: Échec de la synchronisation de la stratégie IA pour ${id}. Raison: ${pmsError.message}`);
                    // 3. Bloquer la sauvegarde Firestore et renvoyer une erreur
                    return res.status(502).send({ error: `Échec de la synchronisation PMS: ${pmsError.message}. Les prix n'ont pas été sauvegardés.` });
                }
            }
        }
        // --- FIN DE L'ÉTAPE DE SYNCHRONISATION PMS ---

 
        const batch = db.batch(); 
        const floor = property.floor_price;
        const ceiling = property.ceiling_price;

        const overridesCol = db.collection('properties').doc(id).collection('price_overrides');
        const lockedSnapshot = await overridesCol.where('isLocked', '==', true).get();
        const lockedPrices = new Map();
        lockedSnapshot.forEach(doc => {
            lockedPrices.set(doc.id, doc.data().price); 
        });
        console.log(`Trouvé ${lockedPrices.size} prix verrouillés pour ${id}. Ils ne seront pas modifiés.`);


        for (const day of strategyResult.daily_prices) {
            const priceNum = Number(day.price);
             if (isNaN(priceNum)) {
                 console.warn(`Prix invalide reçu pour ${day.date}: ${day.price}. Utilisation du prix plancher.`);
                 day.price = floor;
                 continue;
             }
             
            if (lockedPrices.has(day.date)) {
                console.log(`Ignoré ${day.date}: prix verrouillé manuellement.`);
                continue; 
            }

            let finalPrice = priceNum;
            if (priceNum < floor) {
                 console.warn(`Prix ${priceNum}€ pour ${day.date} inférieur au plancher ${floor}€. Ajustement.`);
                 finalPrice = floor;
            }
            if (ceiling != null && priceNum > ceiling) {
                 console.warn(`Prix ${priceNum}€ pour ${day.date} supérieur au plafond ${ceiling}€. Ajustement.`);
                 finalPrice = ceiling;
            }
            
            const dayRef = db.collection('properties').doc(id).collection('price_overrides').doc(day.date);
            batch.set(dayRef, {
                date: day.date,
                price: finalPrice,
                reason: day.reason || "Stratégie IA",
                isLocked: false 
            });
        }
        
        await batch.commit();
        console.log(`Stratégie IA sauvegardée pour ${id} (en respectant les prix verrouillés).`);
        
        // Log de l'action
        await logPropertyChange(id, req.user.uid, req.user.email, 'update:ia-pricing', {
            summary: strategyResult.strategy_summary,
            days: strategyResult.daily_prices.length,
            lockedPricesIgnored: lockedPrices.size
        });

        res.status(200).json(strategyResult); 

    } catch (error) {
        console.error('Erreur lors de la génération de la stratégie de prix:', error);
        if (error.message.includes('429') || error.message.includes('overloaded')) {
             res.status(503).send({ error: `L'API de génération de prix est temporairement surchargée. Veuillez réessayer plus tard.` });
        } else {
             res.status(500).send({ error: `Erreur du serveur lors de la génération de la stratégie: ${error.message}` });
        }
    }
});

// GET /api/news - Récupérer les actualités du marché (depuis le cache)
app.get('/api/news', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const newsRef = db.collection('system').doc('marketNews');
        const newsDoc = await newsRef.get();

        if (!newsDoc.exists) {
            return res.status(404).send({ error: 'Cache d\'actualités non encore généré. Veuillez patienter.' });
        }
        
        res.status(200).json(newsDoc.data().data); 

    } catch (error) {
        console.error('Erreur lors de la récupération des actualités depuis le cache:', error);
         res.status(500).send({ error: `Erreur serveur lors de la récupération des actualités: ${error.message}` });
    }
});

// GET /api/properties/:id/news - Récupérer les actualités spécifiques (avec cache par propriété)
app.get('/api/properties/:id/news', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const { id: propertyId } = req.params;
        const userId = req.user.uid;

        // 1. Vérifier la propriété et les droits
        const propertyRef = db.collection('properties').doc(propertyId);
        const propertyDoc = await propertyRef.get();
        if (!propertyDoc.exists) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }
        
        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        const propertyTeamId = propertyDoc.data().teamId || propertyDoc.data().ownerId; 
        if (!userProfileDoc.exists || userProfileDoc.data().teamId !== propertyTeamId) { 
             return res.status(403).send({ error: 'Action non autorisée sur cette propriété (pas dans la bonne équipe).' });
        }
        
        const property = propertyDoc.data();
        const fullLocation = property.location || 'France';
        const city = fullLocation.split(',')[0].trim();

        // 2. Vérifier le cache de cette propriété
        const cacheRef = db.collection('properties').doc(propertyId).collection('cache').doc('localNews');
        const cacheDoc = await cacheRef.get();
        const now = new Date();
        const oneDay = 24 * 60 * 60 * 1000; 
        
        if (cacheDoc.exists) {
            const cacheData = cacheDoc.data();
            const cacheAge = (now.getTime() - cacheData.updatedAt.toDate().getTime());
            
            if (cacheAge < oneDay) {
                console.log(`Utilisation du cache pour les actualités de ${propertyId}`);
                return res.status(200).json(cacheData.data);
            }
        }

        // 3. Si cache vide ou expiré, appeler l'IA
        console.log(`Cache expiré ou absent pour ${propertyId} (ville: ${city}), appel de Gemini...`);
        const prompt = `
            Tu es un analyste de marché expert pour la location saisonnière.
            Utilise l'outil de recherche pour trouver 2-3 actualités ou événements 
            très récents (moins de 7 jours) OU à venir (6 prochains mois)
            spécifiques à la ville : "${city}".
            Concentre-toi sur les événements (concerts, festivals, salons) ou
            les tendances qui impactent la demande de location dans cette ville.

            Pour chaque actualité/événement:
            1. Fournis un titre concis.
            2. Fais un résumé d'une phrase.
            3. Estime l'impact sur les prix en pourcentage (ex: 15 pour +15%, -5 pour -5%).
            4. Catégorise cet impact comme "élevé", "modéré", ou "faible".

            Réponds UNIQUEMENT avec un tableau JSON valide. 
            N'inclus aucun texte avant ou après le tableau, même pas \`\`\`json.
            Le format doit être:
            [
                {
                    "title": "Titre de l'actualité",
                    "summary": "Résumé de l'actualité.",
                    "source": "Nom de la source (ex: 'Le Monde')",
                    "impact_percentage": 15,
                    "impact_category": "élevé"
                }
            ]
        `;

        const newsData = await callGeminiWithSearch(prompt);
        const newsDataArray = Array.isArray(newsData) ? newsData : (newsData ? [newsData] : []);

        if (newsDataArray.length === 0) {
             console.warn("Aucune actualité pertinente trouvée par Gemini pour", city);
        }

        // 4. Mettre à jour le cache
        await cacheRef.set({
            data: newsDataArray,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        await logPropertyChange(propertyId, "system", "auto-update", 'update:news-cache', { count: newsDataArray.length });


        res.status(200).json(newsDataArray);

    } catch (error) {
        console.error(`Erreur lors de la récupération des actualités pour ${req.params.id}:`, error);
         if (error.message.includes('403') || error.message.includes('API key not valid')) {
             res.status(500).send({ error: "L'API Gemini (Search) n'est pas correctement configurée." });
         } else if (error.message.includes('429') || error.message.includes('overloaded')) {
             res.status(503).send({ error: "L'API d'actualités est temporairement surchargée." });
        } else {
             res.status(500).send({ error: `Erreur serveur: ${error.message}` });
        }
    }
});



// --- TÂCHES PLANIFIÉES (CRON JOBS) ---
/**
 * Met à jour le cache des actualités du marché dans Firestore.
 */
async function updateMarketNewsCache() {
    console.log('Tâche planifiée : Démarrage de la mise à jour des actualités...');
    try {
        const prompt = `
            Tu es un analyste de marché expert pour la location saisonnière en France.
            Utilise l'outil de recherche pour trouver les 3-4 actualités ou tendances 
            les plus récentes et pertinentes (moins de 7 jours) qui impactent 
            le marché de la location (type Airbnb, Booking) en France.
            Recherche aussi des événements majeurs (concerts, festivals, salons) 
            annoncés récemment en France pour les 6 prochains mois.

            Pour chaque actualité:
            1. Fournis un titre concis.
            2. Fais un résumé d'une phrase.
            3. Estime l'impact sur les prix en pourcentage (ex: 15 pour +15%, -5 pour -5%).
            4. Catégorise cet impact comme "élevé", "modéré", ou "faible".

            Réponds UNIQUEMENT avec un tableau JSON valide. 
            N'inclus aucun texte avant ou après le tableau, même pas \`\`\`json.
            Le format doit être:
            [
                {
                    "title": "Titre de l'actualité",
                    "summary": "Résumé de l'actualité.",
                    "source": "Nom de la source (ex: 'Le Monde')",
                    "impact_percentage": 15,
                    "impact_category": "élevé"
                }
            ]
        `;
        
        const newsData = await callGeminiWithSearch(prompt); // Appelle la fonction avec retry

        if (!newsData || !Array.isArray(newsData)) {
             throw new Error("Données d'actualités invalides reçues de Gemini.");
        }

        const db = admin.firestore();
        const newsRef = db.collection('system').doc('marketNews');
        await newsRef.set({
            data: newsData,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log('Mise à jour du cache des actualités terminée avec succès.');

    } catch (error) {
        console.error('Erreur lors de la mise à jour du cache des actualités:', error.message);
    }
}

// Planifier la tâche pour s'exécuter tous les jours à 3h00 du matin
console.log("Mise en place de la tâche planifiée pour les actualités (tous les jours à 3h00).");
cron.schedule('0 3 * * *', () => {
    updateMarketNewsCache();
}, {
    scheduled: true,
    timezone: "Europe/Paris"
});

// Planifier la tâche de synchronisation des PMS (tous les jours à 4h00 du matin)
console.log("Mise en place de la tâche planifiée pour la synchronisation des PMS (tous les jours à 4h00).");
cron.schedule('0 4 * * *', () => {
    syncAllPMSRates();
}, {
    scheduled: true,
    timezone: "Europe/Paris"
});


// Lancer une mise à jour au démarrage du serveur (pour avoir des données fraîches)
setTimeout(updateMarketNewsCache, 10000); // Délai de 10s


// ============================================================================
// SERVICE DE PLANIFICATION POUR LA GÉNÉRATION AUTOMATIQUE DES PRIX IA
// ============================================================================

/**
 * Fonction utilitaire pour obtenir l'heure actuelle dans un fuseau horaire donné
 * @param {string} timezone - Fuseau horaire IANA (ex: "Europe/Paris")
 * @returns {Date} Date dans le fuseau horaire spécifié
 */
function getCurrentTimeInTimezone(timezone) {
    try {
        // Utiliser Intl.DateTimeFormat pour obtenir l'heure dans un fuseau horaire spécifique
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });
        
        const parts = formatter.formatToParts(new Date());
        const hour = parseInt(parts.find(p => p.type === 'hour').value);
        const minute = parseInt(parts.find(p => p.type === 'minute').value);
        
        return { hour, minute };
    } catch (error) {
        console.error(`Erreur lors de la récupération de l'heure pour le fuseau horaire ${timezone}:`, error);
        // Fallback: retourner l'heure UTC
        const now = new Date();
        return { hour: now.getUTCHours(), minute: now.getUTCMinutes() };
    }
}

/**
 * Génère et applique les prix IA pour une propriété
 * @param {string} propertyId - ID de la propriété
 * @param {object} property - Données de la propriété
 * @param {string} userId - ID de l'utilisateur
 * @param {string} userEmail - Email de l'utilisateur
 * @returns {Promise<{success: boolean, propertyId: string, message: string}>}
 */
async function generateAndApplyPricingForProperty(propertyId, property, userId, userEmail) {
    const db = admin.firestore();
    
    try {
        const today = new Date().toISOString().split('T')[0];

        // Construire le prompt pour l'IA (identique à celui de l'endpoint)
        const prompt = `
            Tu es un expert mondial en tarification dynamique pour le marché de la location saisonnière (${property.location}).
            Ton objectif est de créer une stratégie de prix détaillée, jour par jour, pour les 180 prochains jours, en respectant les règles définies par l'utilisateur.

            PROPRIÉTÉ À ANALYSER:
            ${JSON.stringify({
                address: property.address,
                location: property.location,
                property_type: property.property_type,
                capacity: property.capacity,
                surface: property.surface,
                amenities: property.amenities || []
            })}

            RÈLES UTILISATEUR À RESPECTER IMPÉRATIVEMENT:
            - Stratégie Générale: ${property.strategy || 'Équilibré'}

            INSTRUCTIONS DE STRATÉGIE DÉTAILLÉES:
            Tu dois pondérer les facteurs de demande (saisonnalité, événements) différemment selon la stratégie choisie:
            
            1.  **Si "Prudent":**
                * **Objectif:** Maximiser le taux d'occupation.
                * **Basse saison:** N'hésite pas à baisser le prix (vers le Prix Plancher) pour sécuriser des réservations.
                * **Haute saison/Événements:** Augmente le prix, mais reste légèrement *en dessous* du pic du marché pour garantir une réservation rapide.
                * **Pondération:** Taux d'occupation (Élevé) > Saisonnalité (Moyen) > Tendance Marché (Faible).

            2.  **Si "Équilibré" (Défaut):**
                * **Objectif:** Équilibre parfait entre Taux d'occupation et ADR.
                * **Basse saison:** Applique des réductions modérées.
                * **Haute saison/Événements:** Augmente le prix significativement pour suivre la demande du marché.
                * **Pondération:** Saisonnalité (Élevé) > Taux d'occupation (Moyen) > Tendance Marché (Moyen).

            3.  **Si "Agressif":**
                * **Objectif:** Maximiser l'ADR (Prix moyen par nuit).
                * **Basse saison:** Maintiens le prix proche du Prix de Base. Ne pas brader.
                * **Haute saison/Événements:** Augmente le prix *au-dessus* du marché. Il vaut mieux avoir moins de réservations mais à un prix très élevé.
                * **Pondération:** Tendance Marché/Événements (Élevé) > Saisonnalité (Moyen) > Taux d'occupation (Faible).

            - Prix Plancher Absolu: ${property.floor_price} € (Ne JAMAIS proposer un prix inférieur)
            - Prix de Référence (Base): ${property.base_price} € (Utilise comme point de départ pour tes ajustements)
            - Prix Plafond (Optionnel): ${property.ceiling_price != null ? property.ceiling_price + ' €' : 'Aucun'} (Ne JAMAIS proposer un prix supérieur si défini)
            - Durée Minimale de Séjour: ${property.min_stay != null ? property.min_stay + ' nuits' : 'Aucune'}
            - Durée Maximale de Séjour: ${property.max_stay != null ? property.max_stay + ' nuits' : 'Aucune'}
            - Réduction Hebdomadaire: ${property.weekly_discount_percent != null ? property.weekly_discount_percent + '%' : 'Aucune'}
            - Réduction Mensuelle: ${property.monthly_discount_percent != null ? property.monthly_discount_percent + '%' : 'Aucune'}
            - Majoration Week-end (Ven/Sam): ${property.weekend_markup_percent != null ? property.weekend_markup_percent + '%' : 'Aucune'}

            INSTRUCTIONS DÉTAILLÉES (SUITE):
            1.  **Analyse des Facteurs de Demande (180 jours à partir du ${today}) pour "${property.location}":**
                * **Saisonnalité:** Haute, moyenne, basse saison.
                * **Effet Week-end:** Majoration si définie.
                * **Jours Fériés & Vacances Scolaires (France Zone A, B, C):** Impact sur la demande.
                * **Événements Locaux:** Recherche simulée (festivals, conférences, etc.).
                * **Qualité du bien:** Prendre en compte les équipements fournis.

            2.  **Génération des Prix Journaliers (180 jours):**
                * Pour CHAQUE jour, calcule un prix optimal.
                * Commence par le prix de base, puis ajuste en fonction des facteurs de demande ET des règles utilisateur (surtout la stratégie).
                * **Contraintes:** Le prix final doit TOUJOURS être >= Prix Plancher et <= Prix Plafond (si défini).
                * **Justification:** Fournis une raison CLAIRE pour chaque prix (ex: "Base + Majoration WE", "Haute saison + Vacances", "Événement + Agressif").

            FORMAT DE SORTIE OBLIGATOIRE (JSON uniquement, sans texte avant/après):
            {
              "strategy_summary": "Résumé très bref de la stratégie globale.",
              "daily_prices": [ { "date": "YYYY-MM-DD", "price": 135, "reason": "Basse saison" }, /* ... autres jours ... */ ]
            }
        `;

        // Appeler l'API Gemini
        const strategyResult = await callGeminiAPI(prompt);

        if (!strategyResult || !Array.isArray(strategyResult.daily_prices) || strategyResult.daily_prices.length === 0) {
            throw new Error("La réponse de l'IA est invalide ou ne contient pas de prix journaliers.");
        }

        // Synchronisation PMS si nécessaire
        if (property.pmsId && property.pmsType) {
            // Vérifier si la synchronisation PMS est activée
            const syncEnabled = await isPMSSyncEnabled(userId, db);
            if (!syncEnabled) {
                console.log(`[Auto-Pricing] [PMS Sync] Synchronisation PMS désactivée pour l'utilisateur ${userId}. Synchronisation ignorée.`);
            } else {
                try {
                    const client = await getUserPMSClient(userId);
                    const lockedPricesCol = db.collection('properties').doc(propertyId).collection('price_overrides');
                    const lockedSnapshot = await lockedPricesCol.where('isLocked', '==', true).get();
                    const lockedDates = new Set(lockedSnapshot.docs.map(doc => doc.id));
                    
                    const pricesToSync = strategyResult.daily_prices.filter(day => !lockedDates.has(day.date));
                    
                    if (pricesToSync.length > 0) {
                        await client.updateBatchRates(property.pmsId, pricesToSync);
                        console.log(`[Auto-Pricing] [PMS Sync] Stratégie IA (${pricesToSync.length} jours) synchronisée avec ${property.pmsType} pour ${propertyId}.`);
                    }
                } catch (pmsError) {
                    console.error(`[Auto-Pricing] [PMS Sync] ERREUR pour ${propertyId}: ${pmsError.message}`);
                    // On continue quand même avec la sauvegarde Firestore
                }
            }
        }

        // Sauvegarder les prix dans Firestore
        const batch = db.batch();
        const floor = property.floor_price;
        const ceiling = property.ceiling_price;

        const overridesCol = db.collection('properties').doc(propertyId).collection('price_overrides');
        const lockedSnapshot = await overridesCol.where('isLocked', '==', true).get();
        const lockedPrices = new Map();
        lockedSnapshot.forEach(doc => {
            lockedPrices.set(doc.id, doc.data().price);
        });

        let pricesApplied = 0;
        for (const day of strategyResult.daily_prices) {
            const priceNum = Number(day.price);
            if (isNaN(priceNum)) {
                console.warn(`[Auto-Pricing] Prix invalide pour ${propertyId} - ${day.date}: ${day.price}. Ignoré.`);
                continue;
            }

            if (lockedPrices.has(day.date)) {
                continue; // Ignorer les prix verrouillés
            }

            let finalPrice = priceNum;
            if (priceNum < floor) {
                finalPrice = floor;
            }
            if (ceiling != null && priceNum > ceiling) {
                finalPrice = ceiling;
            }

            const dayRef = db.collection('properties').doc(propertyId).collection('price_overrides').doc(day.date);
            batch.set(dayRef, {
                date: day.date,
                price: finalPrice,
                reason: day.reason || "Stratégie IA (Auto)",
                isLocked: false
            });
            pricesApplied++;
        }

        await batch.commit();

        // Log de l'action
        await logPropertyChange(propertyId, userId, userEmail, 'update:ia-pricing-auto', {
            summary: strategyResult.strategy_summary,
            days: pricesApplied,
            lockedPricesIgnored: lockedPrices.size
        });

        return {
            success: true,
            propertyId: propertyId,
            message: `Prix générés avec succès pour ${property.address} (${pricesApplied} jours)`
        };

    } catch (error) {
        console.error(`[Auto-Pricing] Erreur pour la propriété ${propertyId}:`, error);
        return {
            success: false,
            propertyId: propertyId,
            message: `Erreur: ${error.message}`
        };
    }
}

/**
 * Génère et applique les prix IA pour tous les groupes d'un utilisateur
 * @param {string} userId - ID de l'utilisateur
 * @param {string} userEmail - Email de l'utilisateur
 * @param {Array} groups - Liste des groupes
 * @param {Array} allProperties - Liste de toutes les propriétés
 * @returns {Promise<Array>} Résultats pour chaque groupe
 */
async function generatePricingForGroups(userId, userEmail, groups, allProperties) {
    const results = [];

    for (const group of groups) {
        if (!group.syncPrices || !group.mainPropertyId) {
            continue; // Ignorer les groupes sans synchronisation ou sans propriété principale
        }

        try {
            const mainProperty = allProperties.find(p => p.id === group.mainPropertyId);
            if (!mainProperty) {
                console.warn(`[Auto-Pricing] Propriété principale ${group.mainPropertyId} du groupe ${group.id} non trouvée.`);
                continue;
            }

            // Générer les prix pour la propriété principale
            const result = await generateAndApplyPricingForProperty(
                group.mainPropertyId,
                mainProperty,
                userId,
                userEmail
            );

            if (result.success) {
                // Appliquer les mêmes prix aux autres propriétés du groupe si syncPrices est activé
                const otherProperties = group.properties
                    .filter(propId => propId !== group.mainPropertyId)
                    .map(propId => allProperties.find(p => p.id === propId))
                    .filter(Boolean);

                for (const otherProp of otherProperties) {
                    await generateAndApplyPricingForProperty(
                        otherProp.id,
                        otherProp,
                        userId,
                        userEmail
                    );
                }

                results.push({
                    ...result,
                    groupId: group.id,
                    groupName: group.name,
                    propertiesCount: group.properties.length
                });
            } else {
                results.push(result);
            }
        } catch (error) {
            console.error(`[Auto-Pricing] Erreur pour le groupe ${group.id}:`, error);
            results.push({
                success: false,
                groupId: group.id,
                message: `Erreur: ${error.message}`
            });
        }
    }

    return results;
}

/**
 * Traite la génération automatique des prix pour un utilisateur
 * @param {string} userId - ID de l'utilisateur
 * @param {object} userData - Données de l'utilisateur
 * @returns {Promise<{success: boolean, userId: string, results: Array}>}
 */
async function processAutoPricingForUser(userId, userData) {
    const db = admin.firestore();
    const startTime = new Date();

    try {
        console.log(`[Auto-Pricing] Début du traitement pour l'utilisateur ${userId} (${userData.email || 'N/A'})`);

        // Récupérer toutes les propriétés de l'utilisateur
        // Les propriétés peuvent être liées par ownerId ou teamId
        const teamId = userData.teamId || userId;
        
        // Récupérer les propriétés par ownerId
        const propertiesByOwner = await db.collection('properties')
            .where('ownerId', '==', userId)
            .get();
        
        // Récupérer les propriétés par teamId (si différent de userId)
        let propertiesByTeam = [];
        if (teamId !== userId) {
            const teamSnapshot = await db.collection('properties')
                .where('teamId', '==', teamId)
                .get();
            propertiesByTeam = teamSnapshot;
        }

        // Combiner les résultats et éviter les doublons
        const propertiesMap = new Map();
        propertiesByOwner.forEach(doc => {
            propertiesMap.set(doc.id, { id: doc.id, ...doc.data() });
        });
        propertiesByTeam.forEach(doc => {
            if (!propertiesMap.has(doc.id)) {
                propertiesMap.set(doc.id, { id: doc.id, ...doc.data() });
            }
        });

        const properties = Array.from(propertiesMap.values());

        if (properties.length === 0) {
            console.log(`[Auto-Pricing] Aucune propriété trouvée pour l'utilisateur ${userId}`);
            return {
                success: true,
                userId: userId,
                results: [],
                message: 'Aucune propriété à traiter'
            };
        }

        // Récupérer tous les groupes de l'utilisateur
        const groupsSnapshot = await db.collection('groups')
            .where('ownerId', '==', userId)
            .get();

        const groups = [];
        groupsSnapshot.forEach(doc => {
            groups.push({ id: doc.id, ...doc.data() });
        });

        const results = [];

        // Traiter les groupes avec synchronisation activée
        const groupsWithSync = groups.filter(g => g.syncPrices && g.mainPropertyId);
        if (groupsWithSync.length > 0) {
            const groupResults = await generatePricingForGroups(userId, userData.email, groupsWithSync, properties);
            results.push(...groupResults);
        }

        // Traiter les propriétés individuelles (non dans un groupe avec sync)
        const propertiesInSyncedGroups = new Set();
        groupsWithSync.forEach(group => {
            group.properties.forEach(propId => propertiesInSyncedGroups.add(propId));
        });

        const individualProperties = properties.filter(p => !propertiesInSyncedGroups.has(p.id));
        for (const property of individualProperties) {
            const result = await generateAndApplyPricingForProperty(
                property.id,
                property,
                userId,
                userData.email
            );
            results.push(result);
        }

        const endTime = new Date();
        const duration = ((endTime - startTime) / 1000).toFixed(2);

        const successCount = results.filter(r => r.success).length;
        const failureCount = results.filter(r => !r.success).length;

        // Mettre à jour lastRun dans le profil utilisateur (toujours, même en cas d'échec)
        const userRef = db.collection('users').doc(userId);
        const updateData = {
            'autoPricing.lastRun': admin.firestore.FieldValue.serverTimestamp(),
            'autoPricing.lastAttempt': admin.firestore.FieldValue.serverTimestamp()
        };

        // Si toutes les propriétés ont réussi, mettre à jour lastSuccessfulRun
        if (failureCount === 0 && results.length > 0) {
            updateData['autoPricing.lastSuccessfulRun'] = admin.firestore.FieldValue.serverTimestamp();
            updateData['autoPricing.failedAttempts'] = 0; // Réinitialiser le compteur d'échecs
            console.log(`[Auto-Pricing] Traitement terminé avec succès pour ${userId}: ${successCount} succès (${duration}s)`);
        } else if (failureCount > 0) {
            // Incrémenter le compteur d'échecs
            const userDoc = await userRef.get();
            const currentFailedAttempts = (userDoc.data()?.autoPricing?.failedAttempts || 0) + 1;
            updateData['autoPricing.failedAttempts'] = currentFailedAttempts;
            console.log(`[Auto-Pricing] Traitement terminé avec échecs pour ${userId}: ${successCount} succès, ${failureCount} échecs (${duration}s) - Tentative ${currentFailedAttempts}`);
        }

        await userRef.update(updateData);

        return {
            success: failureCount === 0,
            userId: userId,
            results: results,
            summary: {
                total: results.length,
                success: successCount,
                failures: failureCount,
                duration: `${duration}s`
            }
        };

    } catch (error) {
        console.error(`[Auto-Pricing] Erreur fatale pour l'utilisateur ${userId}:`, error);
        return {
            success: false,
            userId: userId,
            error: error.message
        };
    }
}

/**
 * Vérifie et exécute la génération automatique pour tous les utilisateurs éligibles
 * Réessaye toutes les heures tant que le pricing n'a pas réussi
 */
async function checkAndRunAutoPricing() {
    const db = admin.firestore();
    const now = new Date();

    try {
        console.log(`[Auto-Pricing] Vérification des utilisateurs éligibles à ${now.toISOString()}`);

        // Récupérer tous les utilisateurs avec autoPricing.enabled = true
        const usersSnapshot = await db.collection('users')
            .where('autoPricing.enabled', '==', true)
            .get();

        if (usersSnapshot.empty) {
            console.log(`[Auto-Pricing] Aucun utilisateur avec génération automatique activée.`);
            return;
        }

        const eligibleUsers = [];

        usersSnapshot.forEach(doc => {
            const userData = doc.data();
            const autoPricing = userData.autoPricing || {};
            const timezone = autoPricing.timezone || userData.timezone || 'Europe/Paris';

            // Vérifier si c'est 00h00 dans le fuseau horaire de l'utilisateur (première tentative du jour)
            const { hour, minute } = getCurrentTimeInTimezone(timezone);
            const isScheduledTime = hour === 0 && minute === 0;

            // Vérifier si le dernier run a échoué et qu'il faut réessayer
            const lastSuccessfulRun = autoPricing.lastSuccessfulRun;
            const lastAttempt = autoPricing.lastAttempt;
            const failedAttempts = autoPricing.failedAttempts || 0;

            // Si le dernier run a échoué, vérifier si au moins 1 heure s'est écoulée depuis la dernière tentative
            let shouldRetry = false;
            if (lastAttempt && failedAttempts > 0) {
                // Convertir lastAttempt en Date si c'est un Timestamp Firestore
                let lastAttemptDate;
                if (lastAttempt.toDate && typeof lastAttempt.toDate === 'function') {
                    lastAttemptDate = lastAttempt.toDate();
                } else if (lastAttempt.seconds) {
                    lastAttemptDate = new Date(lastAttempt.seconds * 1000);
                } else if (lastAttempt._seconds) {
                    lastAttemptDate = new Date(lastAttempt._seconds * 1000);
                } else if (typeof lastAttempt === 'string') {
                    lastAttemptDate = new Date(lastAttempt);
                } else {
                    lastAttemptDate = new Date(lastAttempt);
                }

                // Vérifier si au moins 1 heure s'est écoulée depuis la dernière tentative
                const hoursSinceLastAttempt = (now - lastAttemptDate) / (1000 * 60 * 60);
                shouldRetry = hoursSinceLastAttempt >= 1;
            }

            // Éligible si c'est l'heure prévue (00h00) OU si on doit réessayer après un échec
            if (isScheduledTime || shouldRetry) {
                eligibleUsers.push({
                    userId: doc.id,
                    userData: userData,
                    timezone: timezone,
                    isRetry: shouldRetry && !isScheduledTime
                });
                const reason = isScheduledTime ? 'Heure prévue (00h00)' : `Réessai après échec (tentative ${failedAttempts})`;
                console.log(`[Auto-Pricing] Utilisateur ${doc.id} (${userData.email || 'N/A'}) éligible - ${reason} - Fuseau: ${timezone}`);
            }
        });

        if (eligibleUsers.length === 0) {
            console.log(`[Auto-Pricing] Aucun utilisateur éligible à ce moment.`);
            return;
        }

        // Traiter chaque utilisateur éligible
        for (const { userId, userData, timezone, isRetry } of eligibleUsers) {
            try {
                const result = await processAutoPricingForUser(userId, userData);
                if (isRetry && result.success) {
                    console.log(`[Auto-Pricing] ✅ Réessai réussi pour l'utilisateur ${userId} après ${userData.autoPricing?.failedAttempts || 0} tentatives`);
                }
            } catch (error) {
                console.error(`[Auto-Pricing] Erreur lors du traitement de l'utilisateur ${userId}:`, error);
            }
        }

    } catch (error) {
        console.error(`[Auto-Pricing] Erreur lors de la vérification des utilisateurs éligibles:`, error);
    }
}

// Démarrer le service de planification
// Exécuter toutes les heures pour vérifier si c'est 00h00 dans chaque fuseau horaire
cron.schedule('0 * * * *', () => {
    console.log(`[Auto-Pricing] Exécution du cron job (vérification toutes les heures)`);
    checkAndRunAutoPricing();
}, {
    scheduled: true,
    timezone: "UTC" // Le cron s'exécute en UTC, mais on vérifie les fuseaux horaires dans la fonction
});

console.log('[Auto-Pricing] Service de planification démarré. Vérification toutes les heures.');

// --- ENDPOINTS POUR LES PRICE OVERRIDES ---

// GET /api/properties/:id/price-overrides - Récupérer les price overrides pour une période
app.get('/api/properties/:id/price-overrides', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const propertyId = req.params.id;
        const userId = req.user.uid;
        const { startDate, endDate } = req.query;

        // Vérifier que la propriété appartient à l'utilisateur
        const propertyRef = db.collection('properties').doc(propertyId);
        const propertyDoc = await propertyRef.get();
        
        if (!propertyDoc.exists) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }

        const propertyData = propertyDoc.data();
        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        const propertyTeamId = propertyData.teamId || propertyData.ownerId;
        
        if (!userProfileDoc.exists || userProfileDoc.data().teamId !== propertyTeamId) {
            return res.status(403).send({ error: 'Action non autorisée.' });
        }

        // Construire la requête
        const overridesCol = db.collection(`properties/${propertyId}/price_overrides`);
        let query = overridesCol;

        if (startDate) {
            query = query.where('date', '>=', startDate);
        }
        if (endDate) {
            query = query.where('date', '<=', endDate);
        }

        const snapshot = await query.get();
        const overrides = {};
        
        snapshot.forEach(doc => {
            const data = doc.data();
            overrides[data.date] = {
                price: data.price,
                isLocked: data.isLocked || false,
                date: data.date
            };
        });

        res.status(200).json(overrides);
    } catch (error) {
        console.error('Erreur lors de la récupération des price overrides:', error);
        res.status(500).send({ error: 'Erreur lors de la récupération des price overrides.' });
    }
});

// PUT /api/properties/:id/price-overrides - Mettre à jour les price overrides en batch
app.put('/api/properties/:id/price-overrides', authenticateToken, async (req, res) => {
    try {
        const db = admin.firestore();
        const propertyId = req.params.id;
        const userId = req.user.uid;
        const { overrides } = req.body; // Array of { date, price, isLocked }

        if (!Array.isArray(overrides)) {
            return res.status(400).send({ error: 'Le paramètre "overrides" doit être un tableau.' });
        }

        // Vérifier que la propriété appartient à l'utilisateur
        const propertyRef = db.collection('properties').doc(propertyId);
        const propertyDoc = await propertyRef.get();
        
        if (!propertyDoc.exists) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }

        const propertyData = propertyDoc.data();
        const userProfileRef = db.collection('users').doc(userId);
        const userProfileDoc = await userProfileRef.get();
        const propertyTeamId = propertyData.teamId || propertyData.ownerId;
        
        if (!userProfileDoc.exists || userProfileDoc.data().teamId !== propertyTeamId) {
            return res.status(403).send({ error: 'Action non autorisée.' });
        }

        // Utiliser un batch pour les mises à jour
        const batch = db.batch();
        const overridesCol = db.collection(`properties/${propertyId}/price_overrides`);

        for (const override of overrides) {
            if (!override.date) continue;
            
            const docRef = overridesCol.doc(override.date);
            const dataToSet = {
                date: override.date,
                price: Number(override.price),
                isLocked: override.isLocked !== undefined ? Boolean(override.isLocked) : false,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedBy: userId
            };
            
            batch.set(docRef, dataToSet, { merge: true });
        }

        await batch.commit();

        // Synchronisation avec PMS si la propriété est liée à un PMS
        if (propertyData.pmsId && propertyData.pmsType) {
            // Vérifier si la synchronisation PMS est activée
            const syncEnabled = await isPMSSyncEnabled(userId, db);
            if (!syncEnabled) {
                console.log(`[PMS Sync] Synchronisation PMS désactivée pour l'utilisateur ${userId}. Synchronisation ignorée.`);
            } else {
                try {
                    console.log(`[PMS Sync] Propriété ${propertyId} (PMS ID: ${propertyData.pmsId}) est liée. Synchronisation des prix...`);
                    
                    // Récupérer le client PMS
                    const client = await getUserPMSClient(userId);
                    
                    // Filtrer les prix verrouillés et invalides (on ne synchronise pas les prix verrouillés)
                    const pricesToSync = overrides
                        .filter(override => !override.isLocked && override.date && override.price != null)
                        .map(override => ({
                            date: override.date,
                            price: Number(override.price)
                        }))
                        .filter(rate => !isNaN(rate.price) && rate.price > 0); // Filtrer les prix invalides

                    if (pricesToSync.length > 0) {
                        await client.updateBatchRates(propertyData.pmsId, pricesToSync);
                        console.log(`[PMS Sync] ${pricesToSync.length} prix synchronisés avec ${propertyData.pmsType} pour ${propertyId}.`);
                    } else {
                        console.log(`[PMS Sync] Aucun prix à synchroniser (tous les prix sont verrouillés ou invalides).`);
                    }
                } catch (pmsError) {
                    console.error(`[PMS Sync] ERREUR lors de la synchronisation des prix pour ${propertyId}:`, pmsError.message);
                    // On continue quand même car les prix sont déjà sauvegardés dans Firestore
                    // On pourrait optionnellement retourner un avertissement dans la réponse
                }
            }
        }

        res.status(200).send({ 
            message: `${overrides.length} price override(s) mis à jour avec succès.`,
            count: overrides.length
        });
    } catch (error) {
        console.error('Erreur lors de la mise à jour des price overrides:', error);
        res.status(500).send({ error: 'Erreur lors de la mise à jour des price overrides.' });
    }
});

// --- DÉMARRAGE DU SERVEUR ---
app.listen(port, () => {
  console.log(`Le serveur écoute sur le port ${port}`);
});