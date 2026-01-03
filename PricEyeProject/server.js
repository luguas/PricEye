// Importer les modules nécessaires
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const cron = require('node-cron');
const OpenAI = require('openai');
const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const execAsync = promisify(exec); 

// --- INITIALISATION DE SUPABASE ---
const { supabase } = require('./config/supabase.js');
console.log('✅ Connecté à Supabase avec succès.');

const app = express();
const port = process.env.PORT || 5000;

// Vérification des variables d'environnement Stripe au démarrage
if (!process.env.STRIPE_SECRET_KEY) {
    console.error('❌ ERREUR CRITIQUE: STRIPE_SECRET_KEY non configuré dans les variables d\'environnement');
    console.error('📝 Veuillez créer un fichier .env avec la clé Stripe ou configurer les variables d\'environnement.');
    console.error('📝 Voir CONFIGURATION_PHASE1.md pour les instructions.');
    process.exit(1);
}

// Vérifier les IDs produits/prix (support des deux noms : PARENT et PRINCIPAL)
const parentPriceId = process.env.STRIPE_PRICE_PARENT_ID || process.env.STRIPE_PRICE_PRINCIPAL_ID;
if (!parentPriceId || !process.env.STRIPE_PRICE_CHILD_ID) {
    console.error('❌ ERREUR CRITIQUE: IDs produits/prix Stripe non configurés');
    console.error('📝 Veuillez configurer STRIPE_PRICE_PARENT_ID (ou STRIPE_PRICE_PRINCIPAL_ID) et STRIPE_PRICE_CHILD_ID dans .env');
    process.exit(1);
}

console.log('✅ Configuration Stripe chargée avec succès');

// --- MIDDLEWARES ---

// CORRECTION: Configuration CORS explicite pour la production
const allowedOrigins = [
    'https://priceye.onrender.com',    // L'API elle-même
    'http://localhost:5173',           // Votre app React en local (Vite dev)
    'http://localhost:4173',           // Votre app React en local (Vite preview)
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

    const accessToken = authHeader.split('Bearer ')[1];
    try {
        // Décoder le token JWT pour extraire l'ID utilisateur
        // Les JWT sont en format base64url (3 parties séparées par des points)
        let userId;
        try {
            const parts = accessToken.split('.');
            if (parts.length !== 3) {
                return res.status(403).send({ error: 'Jeton invalide: format incorrect.' });
            }
            
            // Décoder la partie payload (partie 2)
            const payload = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
            const decoded = JSON.parse(payload);
            
            if (!decoded || !decoded.sub) {
                return res.status(403).send({ error: 'Jeton invalide: informations manquantes.' });
            }
            
            userId = decoded.sub;
        } catch (decodeError) {
            console.error('Erreur de décodage du token:', decodeError);
            return res.status(403).send({ error: 'Jeton invalide.' });
        }
        
        // Vérifier que l'utilisateur existe toujours avec la clé de service role
        const { data: user, error: userError } = await supabase.auth.admin.getUserById(userId);
        
        if (userError || !user) {
            console.error('Erreur de récupération de l\'utilisateur:', userError);
            return res.status(403).send({ error: 'Utilisateur non trouvé.' });
        }
        
        // Vérifier si l'utilisateur est désactivé
        if (user.user.banned_until && new Date(user.user.banned_until) > new Date()) {
            return res.status(403).send({ error: 'Votre accès a été désactivé. Veuillez contacter le support.' });
        }
        
        // Adapter le format pour compatibilité avec le reste du code
        req.user = {
            uid: user.user.id,
            email: user.user.email,
            // Ajouter d'autres propriétés si nécessaire
        };
        
        next();
    } catch (error) {
        console.error('Erreur de vérification du jeton:', error);
        res.status(403).send({ error: 'Jeton invalide ou expiré.' });
    }
};

// Importer les helpers Supabase
const db = require('./helpers/supabaseDb.js');

/**
 * FONCTION D'AUDIT: Enregistre une action dans les logs d'une propriété.
 * @param {string} propertyId - ID de la propriété
 * @param {string} userId - ID de l'utilisateur
 * @param {string} userEmail - Email de l'utilisateur
 * @param {string} action - Description de l'action (ex: "update:details")
 * @param {object} changes - Objet décrivant les changements
 */
async function logPropertyChange(propertyId, userId, userEmail, action, changes) {
  // Nettoyer les 'undefined' potentiels
  const cleanChanges = JSON.parse(JSON.stringify(changes || {}));
  await db.logPropertyChange(propertyId, userId, userEmail, action, cleanChanges);
}

/**
 * HELPER PMS: Récupère les identifiants PMS d'un utilisateur et instancie un client.
 * @param {string} userId - L'ID de l'utilisateur
 * @returns {Promise<PMSBase>} - Une instance de l'adaptateur PMS (ex: SmoobuAdapter)
 */
async function getUserPMSClient(userId) {
    // Récupérer la première intégration de l'utilisateur
    const integrations = await db.getIntegrationsByUser(userId);
    
    if (!integrations || integrations.length === 0) {
        throw new Error("Aucun PMS n'est connecté à ce compte.");
    }

    const integration = integrations[0];
    const pmsType = integration.type;
    const credentials = integration.credentials;

    if (!pmsType || !credentials) {
         throw new Error("Configuration PMS invalide ou manquante.");
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
    const { getPMSClient } = await import('./integrations/pmsManager.js');

    // 1. Récupérer toutes les connexions PMS actives avec les infos utilisateur
    const integrations = await db.getAllIntegrations();
    if (!integrations || integrations.length === 0) {
        console.log('[PMS Sync] Aucune intégration PMS active trouvée. Tâche terminée.');
        return;
    }

    console.log(`[PMS Sync] ${integrations.length} connexions PMS trouvées. Traitement...`);
    
    // Traiter chaque intégration individuellement
    for (const integration of integrations) {
        const userId = integration.user_id;
        const pmsType = integration.type;
        const credentials = integration.credentials;
        const userData = integration.users;
        const userEmail = userData?.email || 'email-inconnu';

        // Vérifier si la synchronisation PMS est activée pour cet utilisateur
        if (userData?.pms_sync_enabled === false) {
            console.log(`[PMS Sync] Synchronisation désactivée pour ${userEmail} (ID: ${userId}). Raison: ${userData.pms_sync_stopped_reason || 'unknown'}`);
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
 * HELPER: Récupère ou initialise le team_id d'un utilisateur
 * Si l'utilisateur n'a pas de team_id, il est initialisé avec son propre userId
 * @param {string} userId - L'ID de l'utilisateur
 * @returns {Promise<{teamId: string, userProfile: object}>} - Le team_id et le profil utilisateur
 */
async function getOrInitializeTeamId(userId) {
    const userProfile = await db.getUser(userId);
    if (!userProfile) {
        throw new Error('Profil utilisateur non trouvé.');
    }
    
    // Si team_id existe, le retourner
    if (userProfile.team_id) {
        return { teamId: userProfile.team_id, userProfile };
    }
    
    // Sinon, initialiser team_id = userId (l'utilisateur est son propre équipe)
    console.log(`[Helper] Initialisation du team_id pour l'utilisateur ${userId}`);
    const teamId = userId;
    await db.updateUser(userId, { team_id: teamId });
    // Mettre à jour le userProfile en mémoire pour le retourner
    userProfile.team_id = teamId;
    return { teamId, userProfile };
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
 * Calcule le prix mensuel total pour les Parent Units selon le système de tarification par paliers.
 * 
 * Paliers de tarification :
 * - 1ère unité : €13.99/mo
 * - Unités 2-5 : €11.99/mo (4 unités)
 * - Unités 6-15 : €8.99/mo (10 unités)
 * - Unités 16-30 : €5.49/mo (15 unités)
 * - 30+ unités : €3.99/mo
 * 
 * @param {number} quantityPrincipal - Nombre total de Parent Units
 * @returns {Object} - { totalAmount, breakdown } où totalAmount est en centimes et breakdown détaille chaque palier
 */
function calculateTieredPricing(quantityPrincipal) {
    if (quantityPrincipal === 0) {
        return { totalAmount: 0, breakdown: [] };
    }
    
    // Prix en centimes par palier
    const TIERS = [
        { start: 1, end: 1, pricePerUnit: 1399 },      // 1ère unité : €13.99
        { start: 2, end: 5, pricePerUnit: 1199 },     // Unités 2-5 : €11.99
        { start: 6, end: 15, pricePerUnit: 899 },      // Unités 6-15 : €8.99
        { start: 16, end: 30, pricePerUnit: 549 },    // Unités 16-30 : €5.49
        { start: 31, end: Infinity, pricePerUnit: 399 } // 30+ unités : €3.99
    ];
    
    let totalAmount = 0;
    const breakdown = [];
    
    for (const tier of TIERS) {
        if (quantityPrincipal < tier.start) break;
        
        // Calculer combien d'unités dans ce palier
        const unitsInTier = Math.min(quantityPrincipal, tier.end) - tier.start + 1;
        const tierAmount = unitsInTier * tier.pricePerUnit;
        
        if (unitsInTier > 0) {
            totalAmount += tierAmount;
            breakdown.push({
                range: tier.end === Infinity 
                    ? `${tier.start}+` 
                    : tier.start === tier.end 
                        ? `${tier.start}` 
                        : `${tier.start}-${tier.end}`,
                units: unitsInTier,
                pricePerUnit: tier.pricePerUnit,
                amount: tierAmount
            });
        }
    }
    
    return { totalAmount, breakdown };
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
            // Identifier la propriété principale du groupe
            // Utiliser mainPropertyId (ou main_property_id) si défini, sinon utiliser la première propriété
            const mainPropertyId = group.mainPropertyId || group.main_property_id;
            
            // Convertir toutes les propriétés en IDs pour faciliter la comparaison
            const groupPropertyIds = groupProperties.map(prop => {
                return typeof prop === 'string' ? prop : (prop.id || prop.property_id);
            }).filter(Boolean);
            
            // Déterminer quelle propriété est la principale
            let principalPropertyId;
            if (mainPropertyId && groupPropertyIds.includes(mainPropertyId)) {
                // Utiliser la propriété principale définie dans le groupe
                principalPropertyId = mainPropertyId;
            } else if (groupPropertyIds.length > 0) {
                // Fallback : utiliser la première propriété si aucune principale n'est définie
                principalPropertyId = groupPropertyIds[0];
            }
            
            // La propriété principale = PROPRIÉTÉ PARENTE (prix principal)
            if (principalPropertyId) {
                quantityPrincipal += 1;
            }
            
            // Toutes les autres propriétés du groupe = PROPRIÉTÉS FILLES (prix enfant 3.99€)
            const childPropertiesCount = groupPropertyIds.length - (principalPropertyId ? 1 : 0);
            if (childPropertiesCount > 0) {
                quantityChild += childPropertiesCount;
            }
            
            // Ajouter toutes les propriétés du groupe au Set pour les exclure des propriétés indépendantes
            groupPropertyIds.forEach(propId => {
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
 * @returns {Promise<{isAllowed: boolean, isTrialActive: boolean, currentCount: number, maxAllowed: number}>}
 */
async function checkTrialPropertyLimit(userId, subscriptionId, currentPropertyCount, newPropertiesCount) {
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
async function isPMSSyncEnabled(userId) {
    try {
        const userData = await db.getUser(userId);
        if (!userData) {
            return false;
        }
        // Par défaut, la sync est activée si le flag n'existe pas (rétrocompatibilité)
        return userData.pms_sync_enabled !== false;
    } catch (error) {
        console.error(`[PMS Sync] Erreur lors de la vérification de pms_sync_enabled pour ${userId}:`, error);
        // En cas d'erreur, on autorise (fail-safe)
        return true;
    }
}

/**
 * Récupère toutes les propriétés et groupes d'un utilisateur et met à jour Stripe
 * @param {string} userId - ID de l'utilisateur
 * @returns {Promise<void>}
 */
async function recalculateAndUpdateBilling(userId) {
    try {
        // Récupérer le profil utilisateur pour vérifier l'abonnement Stripe
        const userProfile = await db.getUser(userId);
        
        if (!userProfile) {
            console.warn(`[Billing] Profil utilisateur ${userId} non trouvé. Facturation ignorée.`);
            return;
        }
        
        const subscriptionId = userProfile.stripe_subscription_id || userProfile.subscription_id;
        
        // Si pas d'abonnement Stripe, on ne fait rien
        if (!subscriptionId) {
            console.log(`[Billing] Aucun abonnement Stripe trouvé pour l'utilisateur ${userId}. Facturation ignorée.`);
            return;
        }
        
        // Récupérer le teamId pour récupérer toutes les propriétés de l'équipe
        const teamId = userProfile.team_id || userId;
        
        // 1. Récupérer toutes les propriétés de l'équipe
        const userProperties = await db.getPropertiesByTeam(teamId);
        
        // 2. Récupérer tous les groupes de l'utilisateur
        const userGroups = await db.getGroupsByOwner(userId);
        
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
            
            // Calculer le montant pour les Parent Units selon le système de paliers
            if (principalIncrease > 0) {
                // Calculer le prix pour les nouvelles unités ajoutées
                // On calcule le prix total avec toutes les unités, puis on soustrait le prix des anciennes unités
                const newTotalPricing = calculateTieredPricing(quantities.quantityPrincipal);
                const oldTotalPricing = calculateTieredPricing(oldQuantityPrincipal);
                const principalAmount = newTotalPricing.totalAmount - oldTotalPricing.totalAmount;
                
                if (principalAmount > 0) {
                    await stripe.invoiceItems.create({
                        customer: customerId,
                        amount: principalAmount,
                        currency: 'eur',
                        description: `Rattrapage - Ajout de ${principalIncrease} propriété(s) principale(s) en cours de mois (tarification par paliers)`,
                        metadata: {
                            userId: userId,
                            reason: 'mid_month_property_addition',
                            propertyType: 'principal',
                            quantity: principalIncrease,
                            oldQuantity: oldQuantityPrincipal,
                            newQuantity: quantities.quantityPrincipal,
                            pricingBreakdown: JSON.stringify(newTotalPricing.breakdown)
                        }
                    });
                    console.log(`[Billing] Invoice item créé pour ${principalIncrease} propriété(s) principale(s) (rattrapage): ${principalAmount / 100}€`);
                }
            }
            
            // Prix fixe pour les Child Units (3.99€ par unité)
            const childPricePerUnit = 399; // 3.99€ en centimes
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
    // Créer l'utilisateur dans Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: email,
      password: password,
      email_confirm: true // Auto-confirmer l'email pour simplifier
    });

    if (authError) {
      if (authError.message.includes('already registered') || authError.message.includes('already exists')) {
        return res.status(409).send({ error: 'Cette adresse e-mail est déjà utilisée.' });
      }
      if (authError.message.includes('Password')) {
        return res.status(400).send({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });
      }
      throw authError;
    }

    if (!authData.user) {
      throw new Error('Utilisateur non créé');
    }

    // Créer le profil utilisateur dans la table users
    await db.setUser(authData.user.id, {
      email: email,
      name: name || 'Nouvel Utilisateur',
      currency: currency || 'EUR',
      language: language || 'fr',
      timezone: timezone || 'Europe/Paris',
      theme: 'auto',
      notification_preferences: {
          notifyOnBooking: true,
          notifyOnApiError: true,
      },
      report_frequency: 'hebdomadaire',
      team_id: authData.user.id,
      role: 'admin'
    });

    res.status(201).send({
      message: 'Utilisateur créé et profil enregistré avec succès',
      uid: authData.user.id
    });
  } catch (error) {
    console.error('Erreur lors de la création de l\'utilisateur ou du profil:', error);
    if (error.message && error.message.includes('already')) {
      return res.status(409).send({ error: 'Cette adresse e-mail est déjà utilisée.' });
    }
    res.status(500).send({ error: 'Erreur interne du serveur lors de la création de l\'utilisateur.' });
  }
});

// Note: Avec Supabase, l'authentification se fait généralement côté client
// Cette route est conservée pour compatibilité, mais l'authentification devrait être gérée côté client
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).send({ error: 'Email et mot de passe sont requis.' });
    }
    
    try {
        // Utiliser Supabase pour authentifier l'utilisateur
        const { data, error } = await supabase.auth.signInWithPassword({
            email: email,
            password: password
        });

        if (error) {
            console.error('Erreur de connexion Supabase:', error.message);
            if (error.message.includes('Invalid login credentials') || error.message.includes('Email not confirmed')) {
                return res.status(401).send({ error: 'Email ou mot de passe invalide.' });
            }
            return res.status(400).send({ error: `Erreur d'authentification: ${error.message}` });
        }

        if (!data.session) {
            return res.status(500).send({ error: 'Aucune session créée.' });
        }

        // Retourner l'access_token comme idToken pour compatibilité
        res.status(200).send({ 
            message: 'Connexion réussie', 
            idToken: data.session.access_token 
        });
    } catch (error) {
        console.error('Erreur lors de la connexion:', error);
        res.status(500).send({ error: 'Erreur interne du serveur lors de la connexion.' });
    }
});


// --- ROUTES DE GESTION DU PROFIL UTILISATEUR (SÉCURISÉES) ---
app.get('/api/users/profile', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        let userData = await db.getUser(userId);
        
        if (!userData) {
            console.warn(`Profil manquant pour l'utilisateur ${userId}. Tentative de création.`);
            userData = await db.setUser(userId, {
                email: req.user.email,
                name: 'Utilisateur existant',
                currency: 'EUR',
                language: 'fr',
                timezone: 'Europe/Paris',
                theme: 'auto',
                notification_preferences: { notifyOnBooking: true, notifyOnApiError: true },
                report_frequency: 'hebdomadaire',
                team_id: userId,
                role: 'admin'
            });
            return res.status(200).json(userData);
        }
        
        // Adapter le format pour compatibilité avec le frontend
        const formattedData = {
            ...userData,
            notificationPreferences: userData.notification_preferences,
            reportFrequency: userData.report_frequency,
            teamId: userData.team_id,
            createdAt: userData.created_at,
            subscriptionStatus: userData.subscription_status || userData.subscriptionStatus || 'none',
            stripeCustomerId: userData.stripe_customer_id || userData.stripeCustomerId,
            stripeSubscriptionId: userData.stripe_subscription_id || userData.stripeSubscriptionId
        };
        
        res.status(200).json(formattedData);
    } catch (error) {
        console.error('Erreur lors de la récupération du profil:', error);
        res.status(500).send({ error: 'Erreur lors de la récupération du profil.' });
    }
});

app.put('/api/users/profile', authenticateToken, async (req, res) => {
    try {
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
                        // Convertir en snake_case pour PostgreSQL
                        dataToUpdate.notification_preferences = {
                            notifyOnBooking: typeof incomingData[key].notifyOnBooking === 'boolean' ? incomingData[key].notifyOnBooking : true,
                            notifyOnApiError: typeof incomingData[key].notifyOnApiError === 'boolean' ? incomingData[key].notifyOnApiError : true
                        };
                    }
                } else if (key === 'reportFrequency') {
                     const allowedFrequencies = ['jamais', 'quotidien', 'hebdomadaire', 'mensuel'];
                     if (allowedFrequencies.includes(incomingData[key])) {
                         // Convertir en snake_case pour PostgreSQL
                         dataToUpdate.report_frequency = incomingData[key];
                     }
                } else {
                    dataToUpdate[key] = incomingData[key];
                }
            }
        });

        if (Object.keys(dataToUpdate).length === 0) {
            return res.status(400).send({ error: 'Aucun champ valide à mettre à jour.' });
        }

        await db.updateUser(userId, dataToUpdate);
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
    
    try {
        // Gérer les différents événements Stripe
        switch (event.type) {
            case 'checkout.session.completed':
                await handleCheckoutSessionCompleted(event.data.object);
                break;
                
            case 'invoice.payment_failed':
                await handlePaymentFailed(event.data.object);
                break;
                
            case 'invoice.paid':
                await handlePaymentSucceeded(event.data.object);
                break;
                
            case 'customer.subscription.updated':
                await handleSubscriptionUpdated(event.data.object);
                break;
                
            case 'customer.subscription.deleted':
                await handleSubscriptionDeleted(event.data.object);
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
async function handlePaymentFailed(invoice) {
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
            await db.updateUser(userId, {
                subscription_status: 'trialing',
                payment_failed: true,
                last_payment_failure_at: new Date().toISOString()
            });
            return;
        }
        
        // Période d'essai terminée : couper l'accès
        console.log(`[Webhook] Période d'essai terminée. Coupure de l'accès pour l'utilisateur ${userId}`);
        
        // Désactiver l'accès dans Supabase
        await db.updateUser(userId, {
            subscription_status: 'past_due',
            access_disabled: true,
            access_disabled_at: new Date().toISOString(),
            payment_failed: true,
            last_payment_failure_at: new Date().toISOString(),
            last_payment_failure_invoice_id: invoice.id,
            pms_sync_enabled: false, // STOPPER la synchronisation PMS
            pms_sync_stopped_reason: 'payment_failed',
            pms_sync_stopped_at: new Date().toISOString()
        });
        
        // Optionnel : Désactiver l'utilisateur dans Supabase Auth
        try {
            await supabase.auth.admin.updateUserById(userId, {
                ban_expires_at: '9999-12-31T23:59:59Z' // Bannir indéfiniment
            });
            console.log(`[Webhook] Utilisateur ${userId} désactivé dans Supabase Auth`);
        } catch (authError) {
            console.error(`[Webhook] Erreur lors de la désactivation de l'utilisateur dans Supabase Auth:`, authError);
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
async function handleCheckoutSessionCompleted(session) {
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
        
        // Mettre à jour le profil utilisateur dans Supabase
        await db.updateUser(userId, {
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            subscription_status: subscription.status, // 'trialing' ou 'active'
            subscription_created_at: new Date().toISOString(),
            access_disabled: false,
            pms_sync_enabled: true // Activer la synchronisation PMS
        });
        
        console.log(`[Webhook] Profil utilisateur ${userId} mis à jour avec l'abonnement ${subscriptionId}`);
        
        // Enregistrer les listing IDs pour l'anti-abus des essais gratuits
        // Récupérer toutes les propriétés de l'utilisateur
        const userProfile = await db.getUser(userId);
        const teamId = userProfile?.team_id || userId;
        
        const properties = await db.getPropertiesByTeam(teamId);
        
        const listingIds = properties
            .filter(prop => prop.pms_id)
            .map(prop => prop.pms_id);
        
        // Enregistrer chaque listing ID dans la table used_listing_ids
        if (listingIds.length > 0) {
            try {
                // Vérifier quels listing IDs ne sont pas déjà enregistrés
                const { data: existing } = await supabase
                    .from('used_listing_ids')
                    .select('listing_id')
                    .in('listing_id', listingIds);
                
                const existingIds = new Set((existing || []).map(e => e.listing_id));
                const newListingIds = listingIds.filter(id => !existingIds.has(id));
                
                if (newListingIds.length > 0) {
                    const listingIdsToInsert = newListingIds.map(listingId => ({
                        listing_id: listingId,
                        user_id: userId,
                        checkout_session_id: session.id,
                        subscription_id: subscriptionId,
                        source: 'checkout_completed'
                    }));
                    
                    await supabase
                        .from('used_listing_ids')
                        .insert(listingIdsToInsert);
                    
                    console.log(`[Webhook] ${newListingIds.length} listing ID(s) enregistré(s) pour l'anti-abus`);
                }
            } catch (error) {
                // Si la table n'existe pas, on ignore l'erreur (pas critique)
                if (error.code === 'PGRST204' || error.message.includes('does not exist')) {
                    console.log('[Webhook] Table used_listing_ids non trouvée. Enregistrement ignoré.');
                } else {
                    console.error('[Webhook] Erreur lors de l\'enregistrement des listing IDs:', error);
                }
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
async function handlePaymentSucceeded(invoice) {
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
        
        await db.updateUser(userId, {
            subscription_status: 'active',
            access_disabled: false,
            access_reactivated_at: new Date().toISOString(),
            payment_failed: false
        });
        
        // Réactiver l'utilisateur dans Supabase Auth
        try {
            await supabase.auth.admin.updateUserById(userId, {
                ban_expires_at: null // Retirer le ban
            });
            console.log(`[Webhook] Utilisateur ${userId} réactivé dans Supabase Auth`);
        } catch (authError) {
            console.error(`[Webhook] Erreur lors de la réactivation de l'utilisateur dans Supabase Auth:`, authError);
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
async function handleSubscriptionUpdated(subscription) {
    try {
        const customerId = subscription.customer;
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        const customer = await stripe.customers.retrieve(customerId);
        const userId = customer.metadata?.userId;
        
        if (!userId) {
            return;
        }
        
        await db.updateUser(userId, {
            subscription_status: subscription.status,
            subscription_updated_at: new Date().toISOString()
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
async function handleSubscriptionDeleted(subscription) {
    try {
        const customerId = subscription.customer;
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        const customer = await stripe.customers.retrieve(customerId);
        const userId = customer.metadata?.userId;
        
        if (!userId) {
            return;
        }
        
        console.log(`[Webhook] Abonnement annulé. Coupure de l'accès pour l'utilisateur ${userId}`);
        
        await db.updateUser(userId, {
            subscription_status: 'canceled',
            access_disabled: true,
            access_disabled_at: new Date().toISOString(),
            subscription_canceled_at: new Date().toISOString()
        });
        
        // Désactiver l'utilisateur dans Supabase Auth
        try {
            await supabase.auth.admin.updateUserById(userId, {
                ban_expires_at: '9999-12-31T23:59:59Z' // Bannir indéfiniment
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
        const userId = req.user.uid;
        const { paymentMethodId, trialPeriodDays } = req.body;
        
        if (!paymentMethodId) {
            return res.status(400).send({ error: 'paymentMethodId est requis.' });
        }
        
        // Récupérer le profil utilisateur
        const userProfile = await db.getUser(userId);
        
        if (!userProfile) {
            return res.status(404).send({ error: 'Profil utilisateur non trouvé.' });
        }
        
        // Importer le module Stripe une seule fois
        const stripeManager = require('./integrations/stripeManager');
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        
        // Vérifier si l'utilisateur a déjà un abonnement actif (payant)
        // On autorise les utilisateurs en période d'essai ('trialing') à créer une session checkout
        if (userProfile.stripe_subscription_id) {
            try {
                const existingSubscription = await stripe.subscriptions.retrieve(userProfile.stripe_subscription_id);
                
                // Ne bloquer que si l'abonnement est actif (payant)
                // Les utilisateurs en période d'essai ('trialing') peuvent créer une session checkout
                if (existingSubscription.status === 'active') {
                    return res.status(400).send({ error: 'Vous avez déjà un abonnement actif.' });
                }
            } catch (error) {
                // L'abonnement n'existe peut-être plus, on peut continuer
                console.log(`[Subscription] L'abonnement existant ${userProfile.stripe_subscription_id} n'est plus valide. Création d'un nouvel abonnement.`);
            }
        }
        
        // Récupérer le teamId pour calculer les quantités
        const teamId = userProfile.team_id || userId;
        
        // 1. Récupérer toutes les propriétés de l'équipe
        const userProperties = await db.getPropertiesByTeam(teamId);
        
        // 2. Récupérer tous les groupes de l'utilisateur
        const userGroups = await db.getGroupsByOwner(userId);
        
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
            userProfile.stripe_customer_id
        );
        
        // 5. Créer l'abonnement
        const subscription = await stripeManager.createSubscription(
            customerId,
            paymentMethodId,
            quantities,
            trialPeriodDays || 30
        );
        
        // 6. Sauvegarder les IDs dans le profil utilisateur
        await db.updateUser(userId, {
            stripe_customer_id: customerId,
            stripe_subscription_id: subscription.id,
            subscription_status: subscription.status
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
        const userId = req.user.uid;
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        
        // Récupérer le profil utilisateur
        const userProfile = await db.getUser(userId);
        
        if (!userProfile) {
            return res.status(404).send({ error: 'Profil utilisateur non trouvé.' });
        }
        
        const subscriptionId = userProfile.stripe_subscription_id || userProfile.stripeSubscriptionId;
        
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
        const teamId = userProfile.team_id || userProfile.teamId || userId;
        const userProperties = await db.getPropertiesByTeam(teamId);
        const userGroups = await db.getGroupsByOwner(userId);
        
        // Calculer les nouvelles quantités
        const quantities = calculateBillingQuantities(userProperties, userGroups);
        
        // Si aucune propriété, on commence avec 1 propriété principale
        if (quantities.quantityPrincipal === 0 && quantities.quantityChild === 0) {
            quantities.quantityPrincipal = 1;
        }
        
        // Récupérer les items d'abonnement existants
        const subscriptionItems = subscription.items.data;
        
        // Récupérer les Product IDs pour identifier les items (plus fiable que les Price IDs)
        const parentProductId = process.env.STRIPE_PRODUCT_PARENT_ID || process.env.STRIPE_PRODUCT_PRINCIPAL_ID;
        const childProductId = process.env.STRIPE_PRODUCT_CHILD_ID;
        const parentPriceId = process.env.STRIPE_PRICE_PARENT_ID || process.env.STRIPE_PRICE_PRINCIPAL_ID;
        const childPriceId = process.env.STRIPE_PRICE_CHILD_ID;
        
        // Récupérer la devise de l'abonnement (depuis le premier item ou la devise par défaut)
        let subscriptionCurrency = 'eur'; // Par défaut
        if (subscriptionItems.length > 0) {
            const firstPrice = subscriptionItems[0].price;
            if (typeof firstPrice !== 'string' && firstPrice.currency) {
                subscriptionCurrency = firstPrice.currency.toLowerCase();
            }
        }
        
        // Trouver les items existants par Product ID (plus fiable que Price ID) ou par Price ID en fallback
        let principalItem = null;
        let childItem = null;
        
        if (parentProductId) {
            principalItem = subscriptionItems.find(item => {
                const productId = typeof item.price.product === 'string' 
                    ? item.price.product 
                    : item.price.product.id;
                return productId === parentProductId;
            });
        }
        
        // Si pas trouvé par Product ID, essayer par Price ID
        if (!principalItem && parentPriceId) {
            principalItem = subscriptionItems.find(item => {
                const priceId = typeof item.price === 'string' ? item.price : item.price.id;
                return priceId === parentPriceId;
            });
        }
        
        if (childProductId) {
            childItem = subscriptionItems.find(item => {
                const productId = typeof item.price.product === 'string' 
                    ? item.price.product 
                    : item.price.product.id;
                return productId === childProductId;
            });
        }
        
        // Si pas trouvé par Product ID, essayer par Price ID
        if (!childItem && childPriceId) {
            childItem = subscriptionItems.find(item => {
                const priceId = typeof item.price === 'string' ? item.price : item.price.id;
                return priceId === childPriceId;
            });
        }
        
        // Construire les items à mettre à jour
        const itemsToUpdate = [];
        
        if (principalItem) {
            itemsToUpdate.push({
                id: principalItem.id,
                quantity: quantities.quantityPrincipal
            });
        } else if (quantities.quantityPrincipal > 0) {
            // Si l'item n'existe pas, on doit trouver un prix compatible avec la devise de l'abonnement
            let priceToUse = null;
            
            if (parentProductId) {
                try {
                    // Récupérer tous les prix du produit parent
                    const allParentPrices = await stripe.prices.list({
                        product: parentProductId,
                        limit: 100
                    });
                    
                    // Trouver un prix avec la même devise que l'abonnement
                    priceToUse = allParentPrices.data.find(price => 
                        price.currency.toLowerCase() === subscriptionCurrency.toLowerCase()
                    );
                } catch (err) {
                    console.warn(`[End Trial] Erreur lors de la récupération des prix du produit parent:`, err.message);
                }
            }
            
            // Si pas de prix trouvé par Product ID, vérifier le prix par défaut
            if (!priceToUse && parentPriceId) {
                try {
                    const defaultPrice = await stripe.prices.retrieve(parentPriceId);
                    if (defaultPrice.currency.toLowerCase() === subscriptionCurrency.toLowerCase()) {
                        priceToUse = defaultPrice;
                    } else {
                        console.warn(`[End Trial] Le prix par défaut (${parentPriceId}) est en ${defaultPrice.currency}, mais l'abonnement est en ${subscriptionCurrency}`);
                    }
                } catch (err) {
                    console.warn(`[End Trial] Erreur lors de la récupération du prix par défaut:`, err.message);
                }
            }
            
            if (priceToUse) {
                itemsToUpdate.push({
                    price: priceToUse.id,
                    quantity: quantities.quantityPrincipal
                });
            } else {
                throw new Error(`Impossible de trouver un prix compatible pour le produit parent avec la devise ${subscriptionCurrency}. Veuillez configurer les prix Stripe correctement.`);
            }
        }
        
        if (childItem) {
            itemsToUpdate.push({
                id: childItem.id,
                quantity: quantities.quantityChild
            });
        } else if (quantities.quantityChild > 0) {
            // Si l'item n'existe pas, on doit trouver un prix compatible avec la devise de l'abonnement
            let priceToUse = null;
            
            if (childProductId) {
                try {
                    // Récupérer tous les prix du produit enfant
                    const allChildPrices = await stripe.prices.list({
                        product: childProductId,
                        limit: 100
                    });
                    
                    // Trouver un prix avec la même devise que l'abonnement
                    priceToUse = allChildPrices.data.find(price => 
                        price.currency.toLowerCase() === subscriptionCurrency.toLowerCase()
                    );
                } catch (err) {
                    console.warn(`[End Trial] Erreur lors de la récupération des prix du produit enfant:`, err.message);
                }
            }
            
            // Si pas de prix trouvé par Product ID, vérifier le prix par défaut
            if (!priceToUse && childPriceId) {
                try {
                    const defaultPrice = await stripe.prices.retrieve(childPriceId);
                    if (defaultPrice.currency.toLowerCase() === subscriptionCurrency.toLowerCase()) {
                        priceToUse = defaultPrice;
                    } else {
                        console.warn(`[End Trial] Le prix par défaut (${childPriceId}) est en ${defaultPrice.currency}, mais l'abonnement est en ${subscriptionCurrency}`);
                    }
                } catch (err) {
                    console.warn(`[End Trial] Erreur lors de la récupération du prix par défaut:`, err.message);
                }
            }
            
            if (priceToUse) {
                itemsToUpdate.push({
                    price: priceToUse.id,
                    quantity: quantities.quantityChild
                });
            } else {
                throw new Error(`Impossible de trouver un prix compatible pour le produit enfant avec la devise ${subscriptionCurrency}. Veuillez configurer les prix Stripe correctement.`);
            }
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
        await db.updateUser(userId, {
            subscription_status: updatedSubscription.status,
            trial_ended_at: new Date().toISOString()
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
        const userId = req.user.uid;
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        
        // Récupérer le profil utilisateur
        const userProfile = await db.getUser(userId);
        
        if (!userProfile) {
            return res.status(404).send({ error: 'Profil utilisateur non trouvé.' });
        }
        
        const customerId = userProfile.stripe_customer_id;
        
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
        const userId = req.user.uid;
        
        // Vérifier que la clé Stripe est configurée
        if (!process.env.STRIPE_SECRET_KEY) {
            console.error('[Checkout] STRIPE_SECRET_KEY non configuré dans les variables d\'environnement');
            return res.status(500).send({ error: 'Configuration Stripe manquante. Contactez le support.' });
        }
        
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        const stripeManager = require('./integrations/stripeManager');
        
        // Récupérer le profil utilisateur
        const userProfile = await db.getUser(userId);
        
        if (!userProfile) {
            return res.status(404).send({ error: 'Profil utilisateur non trouvé.' });
        }
        
        // Vérifier si l'utilisateur a déjà un abonnement actif (payant)
        // Si en période d'essai, rediriger vers le portail client
        const subscriptionId = userProfile.stripe_subscription_id || userProfile.subscription_id;
        if (subscriptionId) {
            try {
                const existingSubscription = await stripe.subscriptions.retrieve(subscriptionId);
                // Ne bloquer que si l'abonnement est actif (payant)
                // Les utilisateurs en période d'essai ('trialing') peuvent créer une session checkout
                if (existingSubscription.status === 'active') {
                    return res.status(400).send({ error: 'Vous avez déjà un abonnement actif.' });
                }
                // Si l'abonnement est en période d'essai, rediriger vers le portail client
                // Stripe ne permet pas de créer une nouvelle session checkout quand il y a déjà un abonnement
                if (existingSubscription.status === 'trialing') {
                    console.log(`[Checkout] Abonnement existant en période d'essai détecté. Redirection vers le portail client.`);
                    const customerId = userProfile.stripe_customer_id;
                    
                    if (customerId) {
                        // Créer une session du portail client au lieu d'une session checkout
                        const frontendUrl = process.env.FRONTEND_URL || 'https://pric-eye.vercel.app';
                        try {
                            const portalSession = await stripe.billingPortal.sessions.create({
                                customer: customerId,
                                return_url: `${frontendUrl}/billing`
                            });
                            console.log(`[Checkout] Session portail créée pour ${userId}: ${portalSession.url}`);
                            return res.status(200).json({
                                url: portalSession.url,
                                sessionId: portalSession.id,
                                isPortal: true,
                                message: 'Vous avez déjà un abonnement en période d\'essai. Utilisez le portail client pour gérer votre abonnement.'
                            });
                        } catch (portalError) {
                            console.error(`[Checkout] Erreur lors de la création de la session portail:`, portalError);
                            return res.status(400).send({ 
                                error: 'Vous avez déjà un abonnement en période d\'essai. Veuillez utiliser le portail client pour gérer votre abonnement.',
                                shouldUsePortal: true
                            });
                        }
                    } else {
                        return res.status(400).send({ 
                            error: 'Vous avez déjà un abonnement en période d\'essai. Veuillez contacter le support pour gérer votre abonnement.'
                        });
                    }
                }
            } catch (error) {
                console.log(`[Checkout] L'abonnement existant ${subscriptionId} n'est plus valide.`);
            }
        }
        
        // 1. Récupérer toutes les propriétés de l'utilisateur
        const teamId = userProfile.team_id || userId;
        const userProperties = await db.getPropertiesByTeam(teamId);
        
        // 2. Récupérer tous les groupes de l'utilisateur
        const userGroups = await db.getGroupsByOwner(userId);
        
        // 3. Calculer les buckets Parent/Enfant
        const quantities = calculateBillingQuantities(userProperties, userGroups);
        
        // Si aucune propriété, on commence avec 1 propriété principale
        if (quantities.quantityPrincipal === 0 && quantities.quantityChild === 0) {
            quantities.quantityPrincipal = 1;
        }
        
        // 4. Vérifier l'anti-abus des essais gratuits (listing IDs)
        let trialPeriodDays = 30; // Par défaut, essai gratuit de 30 jours
        
        // Extraire tous les listing IDs (pms_id) des propriétés importées
        const listingIds = userProperties
            .filter(p => p.pms_id)
            .map(p => p.pms_id);
        
        if (listingIds.length > 0) {
            const hasAbuse = await checkListingIdsAbuse(listingIds);
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
            userProfile.stripe_customer_id
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
        
        // Stripe ne permet pas de spécifier à la fois customer et customer_email
        // Si on a un customerId, on utilise seulement customer
        // Sinon, on utilise customer_email pour créer automatiquement un customer
        const sessionParams = {
            mode: 'subscription',
            line_items: lineItems,
            subscription_data: {
                trial_period_days: trialPeriodDays,
                metadata: {
                    userId: userId
                }
            },
            success_url: `${frontendUrl}/?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${frontendUrl}/?canceled=true`
        };
        
        // Ajouter customer ou customer_email (mais pas les deux)
        if (customerId) {
            sessionParams.customer = customerId;
        } else {
            sessionParams.customer_email = userProfile.email || req.user.email;
        }
        
        const session = await stripe.checkout.sessions.create(sessionParams);
        
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
 * GET /api/checkout/verify-session - Vérifie le statut d'une session Stripe Checkout
 * Permet de vérifier rapidement si une session a été complétée et mettre à jour le profil
 */
app.get('/api/checkout/verify-session', authenticateToken, async (req, res) => {
    try {
        const { session_id } = req.query;
        
        if (!session_id) {
            return res.status(400).send({ error: 'session_id est requis' });
        }
        
        const userId = req.user.uid;
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        
        // Récupérer la session depuis Stripe
        const session = await stripe.checkout.sessions.retrieve(session_id);
        
        console.log(`[Checkout Verify] Session ${session_id}: status=${session.status}, payment_status=${session.payment_status}, subscription=${session.subscription}`);
        
        // Vérifier si la session est complétée (pour les essais gratuits, payment_status peut être 'no_payment_required')
        const isSessionComplete = session.status === 'complete' && 
                                  (session.payment_status === 'paid' || session.payment_status === 'no_payment_required');
        
        if (isSessionComplete) {
            const subscriptionId = session.subscription;
            
            if (subscriptionId) {
                console.log(`[Checkout Verify] Session complétée, récupération de l'abonnement ${subscriptionId}`);
                
                // Récupérer l'abonnement pour obtenir le statut
                const subscription = await stripe.subscriptions.retrieve(subscriptionId);
                console.log(`[Checkout Verify] Statut de l'abonnement: ${subscription.status}`);
                
                // Mettre à jour le profil utilisateur directement (au cas où le webhook n'aurait pas encore été traité)
                console.log(`[Checkout Verify] Mise à jour du profil utilisateur ${userId} avec subscription ${subscriptionId}`);
                console.log(`[Checkout Verify] Données à mettre à jour:`, {
                    stripe_customer_id: session.customer,
                    stripe_subscription_id: subscriptionId,
                    subscription_status: subscription.status,
                    subscription_created_at: new Date().toISOString(),
                    access_disabled: false,
                    pms_sync_enabled: true
                });
                
                try {
                    const updateResult = await db.updateUser(userId, {
                        stripe_customer_id: session.customer,
                        stripe_subscription_id: subscriptionId,
                        subscription_status: subscription.status, // 'trialing' ou 'active'
                        subscription_created_at: new Date().toISOString(),
                        access_disabled: false,
                        pms_sync_enabled: true
                    });
                    console.log(`[Checkout Verify] ✅ Mise à jour réussie:`, updateResult);
                } catch (updateError) {
                    console.error(`[Checkout Verify] ❌ Erreur lors de la mise à jour:`, updateError);
                    // Essayer avec setUser au cas où l'utilisateur n'existe pas encore
                    try {
                        const userProfile = await db.getUser(userId);
                        if (userProfile) {
                            // L'utilisateur existe, réessayer avec updateUser
                            throw updateError; // Re-lancer l'erreur
                        } else {
                            // L'utilisateur n'existe pas, créer avec setUser
                            console.log(`[Checkout Verify] Utilisateur non trouvé, création avec setUser`);
                            await db.setUser(userId, {
                                stripe_customer_id: session.customer,
                                stripe_subscription_id: subscriptionId,
                                subscription_status: subscription.status,
                                subscription_created_at: new Date().toISOString(),
                                access_disabled: false,
                                pms_sync_enabled: true
                            });
                            console.log(`[Checkout Verify] ✅ Utilisateur créé avec succès`);
                        }
                    } catch (setUserError) {
                        console.error(`[Checkout Verify] ❌ Erreur lors de la création:`, setUserError);
                        throw setUserError;
                    }
                }
                
                // Récupérer le profil mis à jour pour vérification
                const updatedProfile = await db.getUser(userId);
                if (!updatedProfile) {
                    throw new Error(`Impossible de récupérer le profil utilisateur ${userId} après la mise à jour`);
                }
                console.log(`[Checkout Verify] ✅ Profil récupéré. subscription_status: ${updatedProfile.subscription_status || updatedProfile.subscriptionStatus}, stripe_subscription_id: ${updatedProfile.stripe_subscription_id || updatedProfile.stripeSubscriptionId}`);
                
                // Formater le profil pour le frontend (comme dans /api/users/profile)
                const formattedProfile = {
                    ...updatedProfile,
                    subscriptionStatus: updatedProfile.subscription_status || updatedProfile.subscriptionStatus || subscription.status,
                    stripeCustomerId: updatedProfile.stripe_customer_id || updatedProfile.stripeCustomerId,
                    stripeSubscriptionId: updatedProfile.stripe_subscription_id || updatedProfile.stripeSubscriptionId,
                    notificationPreferences: updatedProfile.notification_preferences,
                    reportFrequency: updatedProfile.report_frequency,
                    teamId: updatedProfile.team_id,
                    createdAt: updatedProfile.created_at
                };
                
                console.log(`[Checkout Verify] Profil formaté. subscriptionStatus: ${formattedProfile.subscriptionStatus}`);
                
                return res.status(200).json({
                    success: true,
                    sessionStatus: session.status,
                    paymentStatus: session.payment_status,
                    subscriptionId: subscriptionId,
                    subscriptionStatus: subscription.status,
                    profile: formattedProfile
                });
            } else {
                console.warn(`[Checkout Verify] Session complétée mais pas d'abonnement trouvé`);
            }
        } else {
            console.log(`[Checkout Verify] Session pas encore complétée. Status: ${session.status}, Payment: ${session.payment_status}`);
        }
        
        // Session pas encore complétée
        return res.status(200).json({
            success: false,
            sessionStatus: session.status,
            paymentStatus: session.payment_status,
            message: 'La session n\'est pas encore complétée'
        });
        
    } catch (error) {
        console.error('[Checkout Verify] ❌ Erreur lors de la vérification de la session:', error);
        console.error('[Checkout Verify] Stack:', error.stack);
        
        // Si c'est une erreur de mise à jour, essayer quand même de retourner les infos de la session
        if (error.message && error.message.includes('update') || error.message.includes('column')) {
            console.error('[Checkout Verify] ⚠️ Erreur de mise à jour détectée. Vérifiez que les colonnes existent dans la table users:');
            console.error('[Checkout Verify] Colonnes requises: stripe_customer_id, stripe_subscription_id, subscription_status, subscription_created_at, access_disabled, pms_sync_enabled');
        }
        
        res.status(500).json({ 
            error: `Erreur lors de la vérification: ${error.message}`,
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
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
        const requestedUserId = req.params.userId;
        const authenticatedUserId = req.user.uid;

        // Vérifier que l'utilisateur ne peut consulter que son propre profil
        if (requestedUserId !== authenticatedUserId) {
            return res.status(403).send({ 
                error: 'Vous n\'êtes pas autorisé à consulter les préférences d\'un autre utilisateur.' 
            });
        }

        const userData = await db.getUser(requestedUserId);

        // Vérifier que l'utilisateur existe
        if (!userData) {
            return res.status(404).send({ 
                error: 'Utilisateur non trouvé.' 
            });
        }

        const autoPricing = userData.auto_pricing || {};

        // Retourner l'état actuel avec des valeurs par défaut si non défini
        const response = {
            enabled: autoPricing.enabled || false,
            timezone: autoPricing.timezone || userData.timezone || 'Europe/Paris',
            lastRun: autoPricing.lastRun || autoPricing.last_run || null,
            enabledAt: autoPricing.enabledAt || autoPricing.enabled_at || null,
            updatedAt: autoPricing.updatedAt || autoPricing.updated_at || null
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

        const userData = await db.getUser(requestedUserId);

        // Vérifier que l'utilisateur existe
        if (!userData) {
            return res.status(404).send({ 
                error: 'Utilisateur non trouvé.' 
            });
        }

        // Préparer les données à mettre à jour
        const currentAutoPricing = userData.auto_pricing || {};
        const updateData = {
            auto_pricing: {
                ...currentAutoPricing,
                enabled: enabled,
                timezone: timezone,
                updated_at: new Date().toISOString(),
                enabled_at: enabled && !currentAutoPricing.enabled ? new Date().toISOString() : currentAutoPricing.enabled_at
            }
        };

        // Si la génération automatique est activée, enregistrer aussi la date d'activation
        if (enabled) {
            if (!currentAutoPricing.enabled) {
                updateData.auto_pricing.enabled_at = new Date().toISOString();
                // Initialiser le compteur d'échecs à 0 lors de l'activation
                updateData.auto_pricing.failed_attempts = 0;
            } else {
                // Conserver la date d'activation existante si elle existe
                updateData.auto_pricing.enabled_at = currentAutoPricing.enabled_at || new Date().toISOString();
            }
        } else {
            // Si désactivé, on peut optionnellement enregistrer la date de désactivation
            updateData.auto_pricing.disabled_at = new Date().toISOString();
        }

        // Mettre à jour le document utilisateur
        await db.updateUser(requestedUserId, updateData);

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
        const userId = req.user.uid;
        const integrations = await db.getIntegrationsByUser(userId);

        if (!integrations || integrations.length === 0) {
            return res.status(200).json(null); // Pas d'intégration
        }

        // Renvoie la première intégration trouvée (en supposant un seul PMS à la fois)
        const integration = integrations[0];
        res.status(200).json({
            type: integration.type,
            credentials: integration.credentials,
            connectedAt: integration.connected_at,
            lastSync: integration.last_sync
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
        await db.upsertIntegration(userId, type, {
            credentials: credentials, // NOTE: Pour une production réelle, ceci devrait être chiffré.
            last_sync: null
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
        // 1. Get user's teamId
        const { teamId, userProfile } = await getOrInitializeTeamId(userId);
        
        // 2. Vérification de la limite de 10 propriétés pendant l'essai gratuit
        const subscriptionId = userProfile.stripe_subscription_id || userProfile.subscription_id;
        if (subscriptionId) {
            // Compter les propriétés actuelles
            const currentProperties = await db.getPropertiesByTeam(teamId);
            const currentPropertyCount = currentProperties.length;
            
            // Compter les nouvelles propriétés à importer
            const newPropertiesCount = propertiesToImport.filter(p => p.pmsId && p.name).length;
            
            // Vérifier la limite
            const limitCheck = await checkTrialPropertyLimit(
                userId, 
                subscriptionId, 
                currentPropertyCount, 
                newPropertiesCount
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
        
        // 3. Créer les propriétés en batch
        let importedCount = 0;
        const propertiesToCreate = [];
        
        for (const prop of propertiesToImport) {
            if (!prop.pmsId || !prop.name) {
                console.warn('[Import] Propriété ignorée, pmsId or name manquant:', prop);
                continue;
            }

            const newPropertyData = {
                // PMS Info
                pms_id: prop.pmsId,
                pms_type: pmsType,
                
                // User/Team Info
                owner_id: userId,
                team_id: teamId,
                
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

            propertiesToCreate.push(newPropertyData);
        }

        // 4. Insérer toutes les propriétés en une seule requête
        if (propertiesToCreate.length > 0) {
            const { data: createdProperties, error: createError } = await supabase
                .from('properties')
                .insert(propertiesToCreate)
                .select();
            
            if (createError) throw createError;
            
            importedCount = createdProperties.length;
            
            // 5. Log les créations
            const logsToCreate = createdProperties.map(property => ({
                property_id: property.id,
                user_id: userId,
                user_email: userEmail,
                action: 'import:pms',
                changes: { pms_id: property.pms_id, pms_type: property.pms_type, name: property.address }
            }));
            
            if (logsToCreate.length > 0) {
                await supabase
                    .from('property_logs')
                    .insert(logsToCreate);
            }
        }

        // 5bis. Enregistrer les listing IDs pour l'anti-abus des essais gratuits
        // (Même si l'utilisateur n'a pas encore fait de checkout, on enregistre les IDs)
        const listingIdsToRegister = propertiesToImport
            .filter(p => p.pmsId && p.name)
            .map(p => p.pmsId);
        
        if (listingIdsToRegister.length > 0) {
            try {
                // Vérifier quels listing IDs ne sont pas déjà enregistrés
                const { data: existing } = await supabase
                    .from('used_listing_ids')
                    .select('listing_id')
                    .in('listing_id', listingIdsToRegister);
                
                const existingIds = new Set((existing || []).map(e => e.listing_id));
                const newListingIds = listingIdsToRegister.filter(id => !existingIds.has(id));
                
                if (newListingIds.length > 0) {
                    // Enregistrer les nouveaux listing IDs
                    const listingIdsToInsert = newListingIds.map(listingId => ({
                        listing_id: listingId,
                        user_id: userId,
                        source: 'import_properties',
                        property_count: listingIdsToRegister.length
                    }));
                    
                    await supabase
                        .from('used_listing_ids')
                        .insert(listingIdsToInsert);
                }
            } catch (error) {
                // Si la table n'existe pas, on ignore l'erreur (pas critique)
                if (error.code === 'PGRST204' || error.message.includes('does not exist')) {
                    console.log('[Import] Table used_listing_ids non trouvée. Enregistrement ignoré.');
                } else {
                    console.error('[Import] Erreur lors de l\'enregistrement des listing IDs:', error);
                }
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
            await recalculateAndUpdateBilling(userId);
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
        const integration = await db.getIntegrationByUserAndType(userId, type);
        if (!integration) {
            return res.status(404).send({ error: 'Aucune intégration de ce type n\'a été trouvée.' });
        }

        await db.deleteIntegration(userId, type);
        
        res.status(200).send({ message: 'Déconnexion réussie.' });
    } catch (error) {
        console.error("Erreur lors de la déconnexion du PMS:", error.message);
        res.status(500).send({ error: error.message });
    }
});



// --- ROUTES DE L'API POUR LES PROPRIÉTÉS (SÉCURISÉES) ---
app.get('/api/properties', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        
        const { teamId, userProfile } = await getOrInitializeTeamId(userId);
        const properties = await db.getPropertiesByTeam(teamId);
        
        // Filtrer les propriétés avec des IDs invalides (UUIDs tronqués)
        const validProperties = properties.filter(prop => {
            if (!prop.id || typeof prop.id !== 'string') {
                console.warn(`[getProperties] Propriété sans ID valide ignorée:`, prop);
                return false;
            }
            const uuidLength = prop.id.replace(/-/g, '').length;
            if (uuidLength < 32) {
                console.warn(`[getProperties] Propriété avec UUID invalide ignorée: ID="${prop.id}" (${uuidLength} caractères), Adresse="${prop.address || 'N/A'}"`);
                return false;
            }
            return true;
        });
        
        res.status(200).json(validProperties);
    } catch (error) {
        console.error('Erreur lors de la récupération des propriétés:', error);
        res.status(500).send({ error: 'Erreur lors de la récupération des propriétés.' });
    }
});

app.post('/api/properties', authenticateToken, async (req, res) => {
    try {
        const newPropertyData = req.body;
        const userId = req.user.uid;
        if (!newPropertyData || !newPropertyData.address || !newPropertyData.location) {
            return res.status(400).send({ error: 'Les données fournies sont incomplètes.' });
        }
        
        const userProfile = await db.getUser(userId);
        if (!userProfile) {
            return res.status(404).send({ error: 'Profil utilisateur non trouvé.' });
        }
        const teamId = userProfile.team_id || userId;
        
        // Vérification de la limite de 10 propriétés pendant l'essai gratuit
        const subscriptionId = userProfile.stripe_subscription_id || userProfile.subscription_id;
        if (subscriptionId) {
            // Compter les propriétés actuelles
            const currentProperties = await db.getPropertiesByTeam(teamId);
            const currentPropertyCount = currentProperties.length;
            
            // Vérifier la limite
            const limitCheck = await checkTrialPropertyLimit(
                userId, 
                subscriptionId, 
                currentPropertyCount, 
                1 // 1 nouvelle propriété
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

        // Les champs acceptés incluent : name, address, location, description, property_type,
        // surface, capacity, daily_revenue, min_stay, amenities, etc.
        // Adapter les noms de champs pour PostgreSQL (snake_case)
        const propertyWithOwner = { 
            name: newPropertyData.name,
            address: newPropertyData.address,
            location: newPropertyData.location,
            description: newPropertyData.description,
            property_type: newPropertyData.property_type || newPropertyData.type || 'villa',
            surface: newPropertyData.surface,
            capacity: newPropertyData.capacity,
            daily_revenue: newPropertyData.daily_revenue,
            min_stay: newPropertyData.min_stay || 1,
            max_stay: newPropertyData.max_stay || null,
            amenities: newPropertyData.amenities || [],
            owner_id: userId, 
            team_id: teamId, 
            status: 'active', // Statut par défaut
            strategy: newPropertyData.strategy || 'Équilibré',
            floor_price: newPropertyData.floor_price || 0,
            base_price: newPropertyData.base_price || 100,
            ceiling_price: newPropertyData.ceiling_price || null,
            weekly_discount_percent: newPropertyData.weekly_discount_percent || null,
            monthly_discount_percent: newPropertyData.monthly_discount_percent || null,
            weekend_markup_percent: newPropertyData.weekend_markup_percent || null
        };
        
        const createdProperty = await db.createProperty(propertyWithOwner);
        
        // Log de la création
        await logPropertyChange(createdProperty.id, req.user.uid, req.user.email, 'create', propertyWithOwner);
        
        // Recalculer et mettre à jour la facturation Stripe
        await recalculateAndUpdateBilling(userId);
        
        res.status(201).send({ message: 'Propriété ajoutée avec succès', id: createdProperty.id });
    } catch (error) {
        console.error('Erreur lors de l\'ajout de la propriété:', error);
        res.status(500).send({ error: 'Erreur lors de l\'ajout de la propriété.' });
    }
});

app.put('/api/properties/:id', authenticateToken, async (req, res) => {
    try {
        const propertyId = req.params.id;
        const userId = req.user.uid;
        const updatedData = req.body;

        const property = await db.getProperty(propertyId);
        if (!property) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }
        
        const userProfile = await db.getUser(userId);
        if (!userProfile) {
            return res.status(404).send({ error: 'Profil utilisateur non trouvé.' });
        }
        
        const propertyTeamId = property.team_id || property.owner_id; 
        if (userProfile.team_id !== propertyTeamId) {
             return res.status(403).send({ error: 'Action non autorisée (pas dans la bonne équipe).' });
        }
        if (userProfile.role !== 'admin' && userProfile.role !== 'manager') {
             return res.status(403).send({ error: 'Action non autorisée (rôle insuffisant).' });
        }
        
        // Adapter les noms de champs pour PostgreSQL
        const dataToUpdate = {};
        Object.keys(updatedData).forEach(key => {
            // Convertir camelCase en snake_case si nécessaire
            const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
            dataToUpdate[snakeKey] = updatedData[key];
        });
        
        // Log de la modification
        await logPropertyChange(propertyId, req.user.uid, req.user.email, 'update:details', updatedData);
        
        await db.updateProperty(propertyId, dataToUpdate);
        res.status(200).send({ message: 'Propriété mise à jour avec succès', id: propertyId });
    } catch (error) {
        console.error('Erreur lors de la mise à jour de la propriété:', error);
        res.status(500).send({ error: 'Erreur lors de la mise à jour de la propriété.' });
    }
});

app.delete('/api/properties/:id', authenticateToken, async (req, res) => {
    try {
        const propertyId = req.params.id;
        const userId = req.user.uid;
        
        const property = await db.getProperty(propertyId);
        if (!property) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }
        
        const userProfile = await db.getUser(userId);
        if (!userProfile) {
            return res.status(404).send({ error: 'Profil utilisateur non trouvé.' });
        }
        
        const propertyTeamId = property.team_id || property.owner_id;
        if (userProfile.team_id !== propertyTeamId) {
             return res.status(403).send({ error: 'Action non autorisée (pas dans la bonne équipe).' });
        }
        if (userProfile.role !== 'admin') {
             return res.status(403).send({ error: 'Action non autorisée (rôle admin requis).' });
        }
        
        // Log de la suppression
        await logPropertyChange(propertyId, req.user.uid, req.user.email, 'delete', { name: property.address });

        await db.deleteProperty(propertyId);
        
        // Recalculer et mettre à jour la facturation Stripe
        await recalculateAndUpdateBilling(userId);
        
        res.status(200).send({ message: 'Propriété supprimée avec succès', id: propertyId });
    } catch (error) {
        console.error('Erreur lors de la suppression de la propriété:', error);
        res.status(500).send({ error: 'Erreur lors de la suppression de la propriété.' });
    }
});

app.post('/api/properties/:id/sync', authenticateToken, async (req, res) => {
    try {
        const { id: propertyId } = req.params;
        const userId = req.user.uid;

        // 1. Vérifier les droits
        const property = await db.getProperty(propertyId);
        if (!property) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }
        
        const userProfile = await db.getUser(userId);
        if (!userProfile) {
            return res.status(404).send({ error: 'Profil utilisateur non trouvé.' });
        }
        
        const propertyTeamId = property.team_id || property.owner_id; 
        if (userProfile.team_id !== propertyTeamId) {
             return res.status(403).send({ error: 'Action non autorisée (pas dans la bonne équipe).' });
        }
        if (userProfile.role !== 'admin' && userProfile.role !== 'manager') {
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

        const property = await db.getProperty(id);
        if (!property) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }
        
        const userProfile = await db.getUser(userId);
        if (!userProfile) {
            return res.status(404).send({ error: 'Profil utilisateur non trouvé.' });
        }
        
        const propertyTeamId = property.team_id || property.owner_id;
        if (userProfile.team_id !== propertyTeamId) {
             return res.status(403).send({ error: 'Action non autorisée (pas dans la bonne équipe).' });
        }
        if (userProfile.role !== 'admin' && userProfile.role !== 'manager') {
             return res.status(403).send({ error: 'Action non autorisée (rôle insuffisant).' });
        }

        const strategyData = {
            strategy,
            floor_price: floorPriceNum,
            base_price: basePriceNum,
            ceiling_price: ceilingPriceNum,
        };
        
        // 1. Sauvegarder dans Supabase (et log)
        await logPropertyChange(id, req.user.uid, req.user.email, 'update:strategy', strategyData);
        await db.updateProperty(id, strategyData);
        
        // 2. Vérifier si la propriété est liée au PMS
        if (property.pms_id && property.pms_type) {
            // Vérifier si la synchronisation PMS est activée
            const syncEnabled = await isPMSSyncEnabled(userId);
            if (!syncEnabled) {
                console.log(`[PMS Sync] Synchronisation PMS désactivée pour l'utilisateur ${userId}. Synchronisation ignorée.`);
            } else {
                console.log(`[PMS Sync] Propriété ${id} (PMS ID: ${property.pms_id}) est liée. Synchronisation des paramètres...`);
                try {
                    // 3. Récupérer le client PMS
                    const client = await getUserPMSClient(userId); 
                    
                    // 4. Appeler updatePropertySettings
                    const settingsToSync = {
                        base_price: strategyData.base_price,
                        floor_price: strategyData.floor_price,
                        ceiling_price: strategyData.ceiling_price
                    };
                    await client.updatePropertySettings(property.pms_id, settingsToSync);
                    
                    console.log(`[PMS Sync] Paramètres de stratégie synchronisés avec ${property.pms_type} pour ${id}.`);
                    
                } catch (pmsError) {
                    console.error(`[PMS Sync] ERREUR: Échec de la synchronisation des paramètres pour ${id}. Raison: ${pmsError.message}`);
                    // Renvoyer une erreur au client, même si Supabase a réussi
                    return res.status(500).send({ error: `Sauvegarde Supabase réussie, mais échec de la synchronisation PMS: ${pmsError.message}` });
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

        const property = await db.getProperty(id);
        if (!property) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }
        
        const userProfile = await db.getUser(userId);
        if (!userProfile) {
            return res.status(404).send({ error: 'Profil utilisateur non trouvé.' });
        }
        
        const propertyTeamId = property.team_id || property.owner_id;
        if (userProfile.team_id !== propertyTeamId) {
             return res.status(403).send({ error: 'Action non autorisée (pas dans la bonne équipe).' });
        }
        if (userProfile.role !== 'admin' && userProfile.role !== 'manager') {
             return res.status(403).send({ error: 'Action non autorisée (rôle insuffisant).' });
        }
        
        // 1. Sauvegarder dans Supabase (et log)
        await logPropertyChange(id, req.user.uid, req.user.email, 'update:rules', cleanRulesData);
        await db.updateProperty(id, cleanRulesData);
        
        // 2. Vérifier si la propriété est liée au PMS
        if (property.pms_id && property.pms_type) {
            // Vérifier si la synchronisation PMS est activée
            const syncEnabled = await isPMSSyncEnabled(userId);
            if (!syncEnabled) {
                console.log(`[PMS Sync] Synchronisation PMS désactivée pour l'utilisateur ${userId}. Synchronisation ignorée.`);
            } else {
                console.log(`[PMS Sync] Propriété ${id} (PMS ID: ${property.pms_id}) est liée. Synchronisation des règles...`);
                try {
                    // 3. Récupérer le client PMS
                    const client = await getUserPMSClient(userId);
                    
                    // 4. Appeler updatePropertySettings
                    // Les 'cleanRulesData' (min_stay, etc.) sont exactement ce que nous voulons synchroniser
                    await client.updatePropertySettings(property.pms_id, cleanRulesData);
                    
                    console.log(`[PMS Sync] Règles synchronisées avec ${property.pms_type} pour ${id}.`);
                    
                } catch (pmsError) {
                    console.error(`[PMS Sync] ERREUR: Échec de la synchronisation des règles pour ${id}. Raison: ${pmsError.message}`);
                    // Renvoyer une erreur au client
                    return res.status(500).send({ error: `Sauvegarde Supabase réussie, mais échec de la synchronisation PMS: ${pmsError.message}` });
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
        const { id } = req.params;
        const { status } = req.body;
        const userId = req.user.uid;

        // 1. Valider le statut
        const allowedStatus = ['active', 'archived', 'error'];
        if (!status || !allowedStatus.includes(status)) {
            return res.status(400).send({ error: 'Statut invalide. Les valeurs autorisées sont : active, archived, error.' });
        }

        // 2. Vérifier la propriété et les permissions
        const property = await db.getProperty(id);
        if (!property) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }

        const userProfile = await db.getUser(userId);
        if (!userProfile) {
            return res.status(404).send({ error: 'Profil utilisateur non trouvé.' });
        }
        
        const propertyTeamId = property.team_id || property.owner_id;
        if (userProfile.team_id !== propertyTeamId) {
            return res.status(403).send({ error: 'Action non autorisée (pas dans la bonne équipe).' });
        }
        
        if (userProfile.role !== 'admin' && userProfile.role !== 'manager') {
             return res.status(403).send({ error: 'Action non autorisée (rôle insuffisant).' });
        }

        // 3. Log et mise à jour du statut
        await logPropertyChange(id, req.user.uid, req.user.email, 'update:status', { status: status });
        await db.updateProperty(id, { status: status });

        res.status(200).send({ message: 'Statut de la propriété mis à jour avec succès.' });

    } catch (error) {
        console.error('Erreur lors de la mise à jour du statut:', error);
        res.status(500).send({ error: 'Erreur serveur lors de la mise à jour du statut.' });
    }
});


// POST /api/properties/:id/bookings - Ajouter une réservation
app.post('/api/properties/:id/bookings', authenticateToken, async (req, res) => {
    try {
        const { id: propertyId } = req.params;
        const userId = req.user.uid;
        const { startDate, endDate, pricePerNight, totalPrice, channel, guestName, numberOfGuests } = req.body;

        if (!startDate || !endDate || typeof pricePerNight !== 'number' || pricePerNight <= 0) {
            return res.status(400).send({ error: 'Dates de début/fin et prix par nuit valides sont requis.' });
        }

        const property = await db.getProperty(propertyId);
        if (!property) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }
        
        const userProfile = await db.getUser(userId);
        if (!userProfile) {
            return res.status(404).send({ error: 'Profil utilisateur non trouvé.' });
        }
        
        const propertyTeamId = property.team_id || property.owner_id;
        if (userProfile.team_id !== propertyTeamId) {
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
            // Vérifier s'il y a un price override pour cette date
            const priceOverrides = await db.getPriceOverrides(propertyId, startDate, startDate);
            if (priceOverrides && Array.isArray(priceOverrides) && priceOverrides.length > 0) {
                const override = priceOverrides[0];
                if (override && override.reason === 'Manuel') {
                    pricingMethod = 'manuelle';
                }
            }
        } catch (e) {
            // Si l'erreur est liée à db.collection, c'est qu'il y a un problème de migration
            if (e.message && e.message.includes('collection')) {
                console.error("Erreur: Code Firestore détecté. Vérifiez que toutes les références Firestore ont été migrées vers Supabase.");
            }
            console.error("Erreur lors de la vérification de la méthode de prix:", e);
            // Continuer avec la méthode par défaut
        }

        // Utiliser la propriété récupérée (pas propertyDoc qui n'existe pas)
        let pmsReservationId = null;

        // Synchronisation avec PMS si la propriété est liée
        if (property.pms_id && property.pms_type) {
            try {
                console.log(`[PMS Sync] Propriété ${propertyId} (PMS ID: ${property.pms_id}) est liée. Création de la réservation...`);
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

                const pmsReservation = await client.createReservation(property.pms_id, reservationData);
                pmsReservationId = pmsReservation.pmsId;
                console.log(`[PMS Sync] Réservation créée dans ${property.pms_type} avec l'ID: ${pmsReservationId}`);
            } catch (pmsError) {
                console.error(`[PMS Sync] ERREUR lors de la création de la réservation pour ${propertyId}:`, pmsError.message);
                // On continue quand même avec la sauvegarde Supabase
            }
        }

        // Construire l'objet de réservation selon le schéma Supabase
        // Schéma: id, property_id, start_date, end_date, guest_name, guest_email, revenue, 
        //         source, pms_booking_id, synced_at, created_at, updated_at, channel, 
        //         pricing_method, price_per_night, status
        const newBooking = {
            start_date: startDate,
            end_date: endDate,
            price_per_night: pricePerNight,
            revenue: totalPrice || pricePerNight * nights, // 'revenue' au lieu de 'total_price'
            status: 'confirmé', // Statut par défaut
            // Champs optionnels selon le schéma
            ...(channel && { channel: channel }),
            ...(pricingMethod && { pricing_method: pricingMethod }),
            ...(guestName && { guest_name: guestName }),
            ...(pmsReservationId && { pms_booking_id: pmsReservationId }), // 'pms_booking_id' au lieu de 'pms_id'
            // Note: number_of_guests n'existe pas dans le schéma, donc on ne l'inclut pas
        };

        const createdBooking = await db.createBooking(propertyId, newBooking);

        res.status(201).send({ 
            message: 'Réservation ajoutée avec succès.', 
            bookingId: createdBooking.id,
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
        const { id: propertyId } = req.params;
        const userId = req.user.uid;
        const { year, month } = req.query; 

        const yearNum = parseInt(year);
        const monthNum = parseInt(month); // Attend 1-12
        if (isNaN(yearNum) || isNaN(monthNum) || monthNum < 1 || monthNum > 12) {
            return res.status(400).send({ error: 'Année et mois (1-12) valides sont requis.' });
        }

        const property = await db.getProperty(propertyId);
        if (!property) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }
       
        const userProfile = await db.getUser(userId);
        if (!userProfile) {
            return res.status(404).send({ error: 'Profil utilisateur non trouvé.' });
        }
        
        const propertyTeamId = property.team_id || property.owner_id;
        if (userProfile.team_id !== propertyTeamId) {
             return res.status(403).send({ error: 'Action non autorisée (pas dans la bonne équipe).' });
        }

        // Utiliser le helper pour récupérer les réservations
        const bookings = await db.getBookingsForMonth(propertyId, yearNum, monthNum);
        
        // Adapter le format pour compatibilité avec le frontend
        // Schéma: id, property_id, start_date, end_date, guest_name, guest_email, revenue, 
        //         source, pms_booking_id, synced_at, created_at, updated_at, channel, 
        //         pricing_method, price_per_night, status
        const formattedBookings = bookings.map(booking => ({
            id: booking.id,
            startDate: booking.start_date,
            endDate: booking.end_date,
            pricePerNight: booking.price_per_night || (booking.revenue ? booking.revenue / Math.ceil((new Date(booking.end_date) - new Date(booking.start_date)) / (1000 * 60 * 60 * 24)) : 0),
            totalPrice: booking.revenue, // 'revenue' dans le schéma
            channel: booking.channel || booking.source, // Utiliser 'channel' si disponible, sinon 'source' en fallback
            guestName: booking.guest_name,
            pmsId: booking.pms_booking_id, // 'pms_booking_id' dans le schéma
            status: booking.status,
            pricingMethod: booking.pricing_method
        }));

        res.status(200).json(formattedBookings);

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
        const userId = req.user.uid;
        const { startDate, endDate } = req.query; 

        if (!startDate || !endDate) {
            return res.status(400).send({ error: 'Les dates de début et de fin sont requises (startDate, endDate).' });
        }

        // 1. Récupérer le teamId de l'utilisateur
        const { teamId } = await getOrInitializeTeamId(userId);

        // 2. Interroger toutes les réservations de l'équipe qui chevauchent la période
        const bookings = await db.getBookingsByTeamAndDateRange(teamId, startDate, endDate);

        if (!bookings || bookings.length === 0) {
             return res.status(200).json([]); // Renvoyer un tableau vide
        }
        
        // 3. Mapper les résultats pour compatibilité avec le frontend
        // Schéma: id, property_id, start_date, end_date, guest_name, guest_email, revenue, 
        //         source, pms_booking_id, synced_at, created_at, updated_at, channel, 
        //         pricing_method, price_per_night, status
        const formattedBookings = bookings.map(booking => ({
            id: booking.id,
            propertyId: booking.property_id,
            startDate: booking.start_date,
            endDate: booking.end_date,
            pricePerNight: booking.price_per_night || (booking.revenue ? booking.revenue / Math.ceil((new Date(booking.end_date) - new Date(booking.start_date)) / (1000 * 60 * 60 * 24)) : 0),
            totalPrice: booking.revenue, // 'revenue' dans le schéma
            channel: booking.channel || booking.source, // Utiliser 'channel' si disponible, sinon 'source' en fallback
            guestName: booking.guest_name,
            pmsId: booking.pms_booking_id, // 'pms_booking_id' dans le schéma
            status: booking.status || 'confirmé',
            pricingMethod: booking.pricing_method
        }));

        res.status(200).json(formattedBookings);

    } catch (error) {
        console.error('Erreur lors de la récupération de toutes les réservations:', error);
        res.status(500).send({ error: 'Erreur serveur lors de la récupération des réservations.' });
    }
});

// PUT /api/properties/:id/bookings/:bookingId - Modifier une réservation
app.put('/api/properties/:id/bookings/:bookingId', authenticateToken, async (req, res) => {
    try {
        const { id: propertyId, bookingId } = req.params;
        const userId = req.user.uid;
        const { startDate, endDate, pricePerNight, totalPrice, channel, guestName, numberOfGuests, status } = req.body;

        const property = await db.getProperty(propertyId);
        if (!property) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }

        const userProfile = await db.getUser(userId);
        if (!userProfile) {
            return res.status(404).send({ error: 'Profil utilisateur non trouvé.' });
        }
        
        const propertyTeamId = property.team_id || property.owner_id;
        if (userProfile.team_id !== propertyTeamId) {
            return res.status(403).send({ error: 'Action non autorisée (pas dans la bonne équipe).' });
        }

        const booking = await db.getBooking(bookingId);
        if (!booking) {
            return res.status(404).send({ error: 'Réservation non trouvée.' });
        }

        // Préparer les données de mise à jour selon le schéma Supabase
        const updateData = {};
        if (startDate) updateData.start_date = startDate;
        if (endDate) updateData.end_date = endDate;
        if (pricePerNight != null) updateData.price_per_night = pricePerNight;
        if (totalPrice != null) updateData.revenue = totalPrice; // 'revenue' au lieu de 'total_price'
        if (channel) updateData.channel = channel; // 'channel' au lieu de 'source'
        if (guestName) updateData.guest_name = guestName;
        // Note: number_of_guests n'existe pas dans le schéma, donc on ne l'inclut pas
        if (status) updateData.status = status;

        // Synchronisation avec PMS si la propriété est liée et la réservation a un pmsId
        if (property.pms_id && property.pms_type && booking.pms_booking_id) {
            try {
                console.log(`[PMS Sync] Mise à jour de la réservation ${bookingId} (PMS ID: ${booking.pms_booking_id})...`);
                const client = await getUserPMSClient(userId);
                
                const reservationData = {};
                if (startDate) reservationData.startDate = startDate;
                if (endDate) reservationData.endDate = endDate;
                if (totalPrice != null) reservationData.totalPrice = totalPrice;
                if (guestName) reservationData.guestName = guestName;
                if (numberOfGuests != null) reservationData.numberOfGuests = numberOfGuests;
                if (channel) reservationData.channel = channel;
                if (status) reservationData.status = status === 'confirmé' ? 'confirmed' : status;

                await client.updateReservation(booking.pms_booking_id, reservationData);
                console.log(`[PMS Sync] Réservation mise à jour dans ${property.pms_type}.`);
            } catch (pmsError) {
                console.error(`[PMS Sync] ERREUR lors de la mise à jour de la réservation pour ${propertyId}:`, pmsError.message);
                // On continue quand même avec la sauvegarde Supabase
            }
        }

        await db.updateBooking(bookingId, updateData);

        res.status(200).send({ message: 'Réservation modifiée avec succès.' });
    } catch (error) {
        console.error('Erreur lors de la modification de la réservation:', error);
        res.status(500).send({ error: 'Erreur serveur lors de la modification de la réservation.' });
    }
});

// DELETE /api/properties/:id/bookings/:bookingId - Supprimer une réservation
app.delete('/api/properties/:id/bookings/:bookingId', authenticateToken, async (req, res) => {
    try {
        const { id: propertyId, bookingId } = req.params;
        const userId = req.user.uid;

        const property = await db.getProperty(propertyId);
        if (!property) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }

        const userProfile = await db.getUser(userId);
        if (!userProfile) {
            return res.status(404).send({ error: 'Profil utilisateur non trouvé.' });
        }
        
        const propertyTeamId = property.team_id || property.owner_id;
        if (userProfile.team_id !== propertyTeamId) {
            return res.status(403).send({ error: 'Action non autorisée (pas dans la bonne équipe).' });
        }

        const booking = await db.getBooking(bookingId);
        if (!booking) {
            return res.status(404).send({ error: 'Réservation non trouvée.' });
        }
        // Synchronisation avec PMS si la propriété est liée et la réservation a un pmsId
        if (property.pms_id && property.pms_type && booking.pms_booking_id) {
            try {
                console.log(`[PMS Sync] Suppression de la réservation ${bookingId} (PMS ID: ${booking.pms_booking_id})...`);
                const client = await getUserPMSClient(userId);
                await client.deleteReservation(booking.pms_booking_id);
                console.log(`[PMS Sync] Réservation supprimée dans ${property.pms_type}.`);
            } catch (pmsError) {
                console.error(`[PMS Sync] ERREUR lors de la suppression de la réservation pour ${propertyId}:`, pmsError.message);
                // On continue quand même avec la suppression Supabase
            }
        }

        await db.deleteBooking(bookingId);

        res.status(200).send({ message: 'Réservation supprimée avec succès.' });
    } catch (error) {
        console.error('Erreur lors de la suppression de la réservation:', error);
        res.status(500).send({ error: 'Erreur serveur lors de la suppression de la réservation.' });
    }
});

// POST /api/properties/:id/bookings/sync - Synchroniser les réservations depuis le PMS
app.post('/api/properties/:id/bookings/sync', authenticateToken, async (req, res) => {
    try {
        const { id: propertyId } = req.params;
        const userId = req.user.uid;
        const { startDate, endDate } = req.body;

        if (!startDate || !endDate) {
            return res.status(400).send({ error: 'Les dates de début et de fin sont requises.' });
        }

        const property = await db.getProperty(propertyId);
        if (!property) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }

        const userProfile = await db.getUser(userId);
        if (!userProfile) {
            return res.status(404).send({ error: 'Profil utilisateur non trouvé.' });
        }
        
        const propertyTeamId = property.team_id || property.owner_id;
        if (userProfile.team_id !== propertyTeamId) {
            return res.status(403).send({ error: 'Action non autorisée (pas dans la bonne équipe).' });
        }

        if (!property.pms_id || !property.pms_type) {
            return res.status(400).send({ error: 'Cette propriété n\'est pas liée à un PMS.' });
        }

        try {
            console.log(`[PMS Sync] Synchronisation des réservations depuis ${property.pms_type} pour ${propertyId}...`);
            const client = await getUserPMSClient(userId);
            const pmsReservations = await client.getReservations(startDate, endDate);

            // Filtrer les réservations pour cette propriété uniquement
            const propertyReservations = pmsReservations.filter(
                res => res.propertyId === property.pms_id
            );

            let importedCount = 0;
            let updatedCount = 0;

            for (const pmsReservation of propertyReservations) {
                // Chercher si une réservation avec ce pms_booking_id existe déjà
                const { data: existing } = await supabase
                    .from('bookings')
                    .select('id')
                    .eq('property_id', propertyId)
                    .eq('pms_booking_id', pmsReservation.pmsId)
                    .limit(1);

                const nights = Math.max(1, Math.round((new Date(pmsReservation.endDate) - new Date(pmsReservation.startDate)) / (1000 * 60 * 60 * 24)));
                const pricePerNight = pmsReservation.totalPrice ? Math.round(pmsReservation.totalPrice / nights) : 0;

                const reservationData = {
                    property_id: propertyId,
                    start_date: pmsReservation.startDate,
                    end_date: pmsReservation.endDate,
                    price_per_night: pricePerNight,
                    revenue: pmsReservation.totalPrice || 0,
                    source: pmsReservation.channel || 'Direct',
                    guest_name: pmsReservation.guestName || null,
                    pms_booking_id: pmsReservation.pmsId,
                    synced_at: new Date().toISOString()
                };

                if (!existing || existing.length === 0) {
                    // Nouvelle réservation
                    await db.createBooking(propertyId, reservationData);
                    importedCount++;
                } else {
                    // Mise à jour de la réservation existante
                    await db.updateBooking(existing[0].id, reservationData);
                    updatedCount++;
                }
            }

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
        const { id: propertyId } = req.params;
        const userId = req.user.uid;

        // 1. Vérifier la propriété et les droits
        const property = await db.getProperty(propertyId);
        if (!property) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }
        
        const userProfile = await db.getUser(userId);
        if (!userProfile) {
            return res.status(404).send({ error: 'Profil utilisateur non trouvé.' });
        }
        
        const propertyTeamId = property.team_id || property.owner_id; 
        if (userProfile.team_id !== propertyTeamId) { 
             return res.status(403).send({ error: 'Action non autorisée sur cette propriété (pas dans la bonne équipe).' });
        }
        
        const fullLocation = property.location || 'France';
        const city = fullLocation.split(',')[0].trim();

        // 2. Vérifier le cache de cette propriété (avec langue)
        const language = req.query.language || userProfile?.language || 'fr';
        
        // Note: Le cache par propriété n'est pas encore implémenté dans Supabase
        // Pour l'instant, on ignore le cache et on génère toujours les actualités
        // TODO: Implémenter un système de cache par propriété dans Supabase si nécessaire

        // 3. Si cache vide ou expiré, appeler l'IA
        const isFrench = language === 'fr' || language === 'fr-FR';
        console.log(`Génération des actualités pour ${propertyId} (ville: ${city}, langue: ${language}), appel de recherche web...`);
        
        const prompt = isFrench ? `
            Tu es un analyste de marché expert pour la location saisonnière.
            Utilise l'outil de recherche pour trouver 2-3 actualités ou événements 
            très récents (moins de 7 jours) OU à venir (6 prochains mois)
            spécifiques à la ville : "${city}".
            Concentre-toi sur les événements (concerts, festivals, salons) ou
            les tendances qui impactent la demande de location dans cette ville.

            Pour chaque actualité/événement:
            1. Fournis un titre concis en français.
            2. Fais un résumé d'une phrase en français.
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
        ` : `
            You are an expert market analyst for seasonal rentals.
            Use the search tool to find 2-3 very recent news items or events 
            (less than 7 days old) OR upcoming (next 6 months)
            specific to the city: "${city}".
            Focus on events (concerts, festivals, trade shows) or
            trends that impact rental demand in this city.

            For each news item/event:
            1. Provide a concise title in English.
            2. Write a one-sentence summary in English.
            3. Estimate the impact on prices as a percentage (e.g., 15 for +15%, -5 for -5%).
            4. Categorize this impact as "high", "medium", or "low".

            Respond ONLY with a valid JSON array. 
            Do not include any text before or after the array, not even \`\`\`json.
            The format should be:
            [
                {
                    "title": "News title",
                    "summary": "News summary.",
                    "source": "Source name (e.g., 'Le Monde')",
                    "impact_percentage": 15,
                    "impact_category": "high"
                }
            ]
        `;

        const newsData = await callGeminiWithSearch(prompt, 10, language);
        const newsDataArray = Array.isArray(newsData) ? newsData : (newsData ? [newsData] : []);

        if (newsDataArray.length === 0) {
             console.warn("Aucune actualité pertinente trouvée pour", city);
        }

        // 4. Log de l'action (le cache sera implémenté plus tard si nécessaire)
        await logPropertyChange(propertyId, "system", "auto-update", 'update:news-cache', { count: newsDataArray.length });


        res.status(200).json(newsDataArray);

    } catch (error) {
        console.error(`Erreur lors de la récupération des actualités pour ${req.params.id}:`, error);
         if (error.message.includes('403') || error.message.includes('API key not valid')) {
             res.status(500).send({ error: "L'API de recherche (Perplexity/ChatGPT) n'est pas correctement configurée." });
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
        const { name } = req.body;
        const userId = req.user.uid;
        if (!name) {
            return res.status(400).send({ error: 'Le nom du groupe est requis.' });
        }
        const newGroup = {
            name,
            owner_id: userId,
            sync_prices: false
        };
        const createdGroup = await db.createGroup(newGroup);
        
        // Recalculer et mettre à jour la facturation Stripe
        await recalculateAndUpdateBilling(userId);
        
        res.status(201).send({ message: 'Groupe créé avec succès', id: createdGroup.id });
    } catch (error) {
        console.error('Erreur lors de la création du groupe:', error);
        res.status(500).send({ error: 'Erreur lors de la création du groupe.' });
    }
});

app.get('/api/groups', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const groups = await db.getGroupsByOwner(userId);
        
        // Adapter le format pour compatibilité avec le frontend
        const formattedGroups = groups.map(group => {
            // Valider et nettoyer main_property_id
            let mainPropertyId = group.main_property_id;
            if (mainPropertyId && typeof mainPropertyId === 'string') {
                const uuidLength = mainPropertyId.replace(/-/g, '').length;
                if (uuidLength < 32) {
                    console.warn(`[getGroups] UUID main_property_id invalide pour le groupe ${group.id}: "${mainPropertyId}" (${uuidLength} caractères). Ignoré.`);
                    mainPropertyId = null; // Ignorer les UUIDs invalides
                }
            }
            
            // Valider et nettoyer les propriétés
            const validProperties = (group.properties || [])
                .map(p => {
                    const propId = p.id || p;
                    if (typeof propId === 'string') {
                        const uuidLength = propId.replace(/-/g, '').length;
                        if (uuidLength < 32) {
                            console.warn(`[getGroups] UUID propriété invalide dans le groupe ${group.id}: "${propId}" (${uuidLength} caractères). Ignoré.`);
                            return null;
                        }
                    }
                    return propId;
                })
                .filter(Boolean); // Retirer les nulls
            
            return {
                id: group.id,
                name: group.name,
                ownerId: group.owner_id,
                owner_id: group.owner_id, // Garder les deux formats
                properties: validProperties,
                syncPrices: group.sync_prices || false,
                sync_prices: group.sync_prices || false,
                mainPropertyId: mainPropertyId,
                main_property_id: mainPropertyId,
                strategy: group.strategy,
                rules: group.rules,
                createdAt: group.created_at,
                created_at: group.created_at
            };
        });
        
        res.status(200).json(formattedGroups);
    } catch (error) {
        console.error('Erreur lors de la récupération des groupes:', error);
        res.status(500).send({ error: 'Erreur lors de la récupération des groupes.' });
    }
});

app.put('/api/groups/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, syncPrices, mainPropertyId } = req.body; 
        const userId = req.user.uid;

        const group = await db.getGroup(id);

        if (!group) {
            return res.status(404).send({ error: 'Groupe non trouvé.' });
        }

        if (group.owner_id !== userId) {
            return res.status(403).send({ error: 'Action non autorisée sur ce groupe.' });
        }

        const dataToUpdate = {};
        if (name) {
            dataToUpdate.name = name;
        }
        if (syncPrices != null && typeof syncPrices === 'boolean') {
            dataToUpdate.sync_prices = syncPrices;
        }
        if (mainPropertyId) {
            // Vérifier que la propriété est dans le groupe
            const propertyIds = (group.properties || []).map(p => p.id || p);
            if (propertyIds.includes(mainPropertyId)) {
                dataToUpdate.main_property_id = mainPropertyId;
            } else {
                return res.status(400).send({ error: 'La propriété principale doit faire partie du groupe.' });
            }
        }

        if (Object.keys(dataToUpdate).length === 0) {
             return res.status(400).send({ error: 'Aucune donnée valide à mettre à jour (name, syncPrices ou mainPropertyId requis).' });
        }

        await db.updateGroup(id, dataToUpdate);

        res.status(200).send({ message: 'Groupe mis à jour avec succès', id });
    } catch (error) {
        console.error('Erreur lors de la mise à jour du groupe:', error);
        res.status(500).send({ error: 'Erreur lors de la mise à jour du groupe.' });
    }
});

app.delete('/api/groups/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.uid;
        
        const group = await db.getGroup(id);
        if (!group) {
            return res.status(404).send({ error: 'Groupe non trouvé.' });
        }
        if (group.owner_id !== userId) {
            return res.status(403).send({ error: 'Action non autorisée sur ce groupe.' });
        }
        await db.deleteGroup(id);
        
        // Recalculer et mettre à jour la facturation Stripe
        await recalculateAndUpdateBilling(userId);
        
        res.status(200).send({ message: 'Groupe supprimé avec succès', id });
    } catch (error) {
        console.error('Erreur lors de la suppression du groupe:', error);
        res.status(500).send({ error: 'Erreur lors de la suppression du groupe.' });
    }
});

app.put('/api/groups/:id/properties', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { propertyIds } = req.body;
        const userId = req.user.uid;
        if (!propertyIds || !Array.isArray(propertyIds)) {
            return res.status(400).send({ error: 'Un tableau d\'IDs de propriétés est requis.' });
        }
        
        const group = await db.getGroup(id);
        if (!group) {
            return res.status(404).send({ error: 'Groupe non trouvé.' });
        }
        if (group.owner_id !== userId) {
            return res.status(403).send({ error: 'Action non autorisée sur ce groupe.' });
        }

        const userProfile = await db.getUser(userId);
        const teamId = userProfile ? (userProfile.team_id || userId) : userId;
        
        const existingPropertiesInGroup = (group.properties || []).map(p => typeof p === 'string' ? p : (p.id || p.property_id));
        let templatePropertyData = null;

        // 1. Définir le "modèle" de propriété (si le groupe n'est pas vide)
        if (existingPropertiesInGroup.length > 0) {
            const templatePropertyId = group.main_property_id || existingPropertiesInGroup[0]; 
            const templateProperty = await db.getProperty(templatePropertyId);
            
            if (templateProperty) {
                templatePropertyData = templateProperty;
            } else {
                for (const propId of existingPropertiesInGroup) {
                     const tempProp = await db.getProperty(propId);
                     if (tempProp) {
                         templatePropertyData = tempProp;
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
            const property = await db.getProperty(propId);
            
            const propTeamId = property ? (property.team_id || property.owner_id) : null;
            if (!property || propTeamId !== teamId) { 
                return res.status(403).send({ error: `La propriété ${propId} est invalide ou n'appartient pas à votre équipe.` });
            }

            if (!templatePropertyData) {
                // C'est la première propriété ajoutée. Elle devient le modèle.
                templatePropertyData = property;
            } else {
                // Vérification géofencing : distance < 500m
                if (templatePropertyData.location && property.location) {
                    // Extraire les coordonnées (format peut varier)
                    let templateLat, templateLon, newLat, newLon;
                    
                    let templateLoc = null;
                    if (typeof templatePropertyData.location === 'object') {
                        templateLoc = templatePropertyData.location;
                    } else if (typeof templatePropertyData.location === 'string') {
                        try {
                            templateLoc = JSON.parse(templatePropertyData.location);
                        } catch (e) {
                            // Si ce n'est pas du JSON valide, on traite comme une chaîne de coordonnées
                            templateLoc = null;
                        }
                    }
                    
                    let newLoc = null;
                    if (typeof property.location === 'object') {
                        newLoc = property.location;
                    } else if (typeof property.location === 'string') {
                        try {
                            newLoc = JSON.parse(property.location);
                        } catch (e) {
                            // Si ce n'est pas du JSON valide, on traite comme une chaîne de coordonnées
                            newLoc = null;
                        }
                    }
                    
                    if (templateLoc?.latitude && templateLoc?.longitude) {
                        templateLat = templateLoc.latitude;
                        templateLon = templateLoc.longitude;
                    } else if (typeof templatePropertyData.location === 'string') {
                        const coords = templatePropertyData.location.split(',').map(c => parseFloat(c.trim()));
                        if (coords.length >= 2) {
                            templateLat = coords[0];
                            templateLon = coords[1];
                        }
                    }
                    
                    if (newLoc?.latitude && newLoc?.longitude) {
                        newLat = newLoc.latitude;
                        newLon = newLoc.longitude;
                    } else if (typeof property.location === 'string') {
                        const coords = property.location.split(',').map(c => parseFloat(c.trim()));
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
                    if (property[field] !== templatePropertyData[field]) {
                        return res.status(400).send({ 
                            error: `Échec d'ajout : La propriété "${property.address || property.name}" a un champ '${field}' (${property[field] || 'N/A'}) 
                                    qui ne correspond pas au modèle du groupe (${templatePropertyData[field] || 'N/A'}). 
                                    Toutes les propriétés d'un groupe doivent avoir une capacité, une surface et un type identiques.`
                        });
                    }
                }
            }
        }
        
        // Ajouter les propriétés au groupe via la table de relation
        await db.addPropertiesToGroup(id, propertyIds);
        
        // Recalculer et mettre à jour la facturation Stripe
        await recalculateAndUpdateBilling(userId);
        
        res.status(200).send({ message: 'Propriétés ajoutées au groupe avec succès.' });
    } catch (error) {
        console.error('Erreur lors de l\'ajout de propriétés au groupe:', error);
        res.status(500).send({ error: 'Erreur lors de l\'ajout de propriétés au groupe.' });
    }
});

app.delete('/api/groups/:id/properties', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { propertyIds } = req.body;
        const userId = req.user.uid;
        if (!propertyIds || !Array.isArray(propertyIds) || propertyIds.length === 0) {
            return res.status(400).send({ error: 'Un tableau d\'IDs de propriétés est requis.' });
        }
        
        const group = await db.getGroup(id);
        if (!group) {
            return res.status(404).send({ error: 'Groupe non trouvé.' });
        }
        if (group.owner_id !== userId) { 
            return res.status(403).send({ error: 'Action non autorisée sur ce groupe.' });
        }
        
        const currentPropertiesInGroup = (group.properties || []).map(p => typeof p === 'string' ? p : (p.id || p.property_id));
        const propertiesToRemove = propertyIds.filter(propId => currentPropertiesInGroup.includes(propId));
        
        const mainPropertyId = group.main_property_id;
        let needsMainPropReset = false;
        if (mainPropertyId && propertiesToRemove.includes(mainPropertyId)) {
            needsMainPropReset = true;
        }

        if (propertiesToRemove.length === 0) {
            return res.status(404).send({ error: 'Aucune des propriétés spécifiées n\'a été trouvée dans ce groupe.' });
        }
        
        // Retirer les propriétés du groupe via la table de relation
        await db.removePropertiesFromGroup(id, propertiesToRemove);
        
        // Si la propriété principale est retirée, la réinitialiser
        if (needsMainPropReset) {
            await db.updateGroup(id, { main_property_id: null });
        }
        
        // Recalculer et mettre à jour la facturation Stripe
        await recalculateAndUpdateBilling(userId);
        
        res.status(200).send({ message: 'Propriétés retirées du groupe avec succès.' });
    } catch (error) {
        console.error('Erreur lors du retrait de propriétés du groupe:', error);
        res.status(500).send({ error: 'Erreur lors de la mise à jour des règles.' });
    }
});

app.put('/api/groups/:id/strategy', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.uid;
        const { strategy, floor_price, base_price, ceiling_price } = req.body;

        const group = await db.getGroup(id);
        if (!group) {
            return res.status(404).send({ error: 'Groupe non trouvé.' });
        }
        if (group.owner_id !== userId) {
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

        const strategyData = {
            strategy,
            floor_price: floorPriceNum,
            base_price: basePriceNum,
            ceiling_price: ceilingPriceNum,
        };

        const propertiesInGroup = (group.properties || []).map(p => typeof p === 'string' ? p : (p.id || p.property_id));
        if (propertiesInGroup.length === 0) {
            return res.status(400).send({ error: 'Ce groupe ne contient aucune propriété.' });
        }
        
        // Mettre à jour le document du groupe lui-même avec la stratégie
        await db.updateGroup(id, strategyData);
        
        // Mettre à jour toutes les propriétés du groupe
        for (const propId of propertiesInGroup) {
            await db.updateProperty(propId, strategyData);
            // Log de l'action
            await logPropertyChange(propId, req.user.uid, req.user.email, 'update:strategy:group', { ...strategyData, groupId: id });
        }
        
        res.status(200).send({ message: `Stratégie appliquée au groupe et à ${propertiesInGroup.length} propriété(s).` });
        
    } catch (error) {
        console.error('Erreur lors de la mise à jour de la stratégie de groupe:', error);
        res.status(500).send({ error: 'Erreur lors de la mise à jour de la stratégie de groupe.' });
    }
});

app.put('/api/groups/:id/rules', authenticateToken, async (req, res) => {
     try {
        const { id } = req.params;
        const userId = req.user.uid;
        
        const group = await db.getGroup(id);
        if (!group) {
            return res.status(404).send({ error: 'Groupe non trouvé.' });
        }
        if (group.owner_id !== userId) {
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

        const propertiesInGroup = (group.properties || []).map(p => typeof p === 'string' ? p : (p.id || p.property_id));
        if (propertiesInGroup.length === 0) {
            return res.status(400).send({ error: 'Ce groupe ne contient aucune propriété.' });
        }
        
        // Mettre à jour toutes les propriétés du groupe
        for (const propId of propertiesInGroup) {
            await db.updateProperty(propId, cleanRulesData);
            // Log de l'action
            await logPropertyChange(propId, req.user.uid, req.user.email, 'update:rules:group', { ...cleanRulesData, groupId: id });
        }
        
        res.status(200).send({ message: `Règles appliquées à ${propertiesInGroup.length} propriétés.` });
        
    } catch (error) {
        console.error('Erreur lors de la mise à jour des règles de groupe:', error);
        res.status(500).send({ error: 'Erreur lors de la mise à jour des règles de groupe.' });
    }
});


// --- ROUTES DE GESTION D'ÉQUIPE (SÉCURISÉES) ---
app.post('/api/teams/invites', authenticateToken, async (req, res) => {
    try {
        const { email: inviteeEmail, role = 'member' } = req.body;
        const inviterId = req.user.uid;

        if (!inviteeEmail) {
            return res.status(400).send({ error: 'L\'adresse e-mail de l\'invité est requise.' });
        }
        
        const allowedRoles = ['admin', 'manager', 'member'];
        if (!allowedRoles.includes(role)) {
            return res.status(400).send({ error: 'Rôle invalide.' });
        }

        const inviterData = await db.getUser(inviterId);
        if (!inviterData || !inviterData.team_id) {
             return res.status(404).send({ error: 'Profil de l\'inviteur ou ID d\'équipe non trouvé.' });
        }
        const teamId = inviterData.team_id;

        if (inviterData.role !== 'admin') {
             return res.status(403).send({ error: 'Seul un administrateur peut inviter des membres.' });
        }
        
        // Vérifier si l'utilisateur existe dans Supabase Auth
        let inviteeUser;
        try {
            const { data: { users }, error: listError } = await supabase.auth.admin.listUsers();
            if (!listError) {
                inviteeUser = users.find(u => u.email === inviteeEmail);
            }
            
            if (inviteeUser) {
                const inviteeProfile = await db.getUser(inviteeUser.id);
                if (inviteeProfile && inviteeProfile.team_id) {
                    return res.status(409).send({ error: 'Cet utilisateur fait déjà partie d\'une équipe.' });
                }
            }
        } catch (error) {
            // Si l'utilisateur n'existe pas, on continue (il pourra être créé lors de l'acceptation de l'invitation)
        }

        // Vérifier s'il existe déjà une invitation en attente
        const { data: existing } = await supabase
            .from('invitations')
            .select('id')
            .eq('team_id', teamId)
            .eq('invitee_email', inviteeEmail)
            .eq('status', 'pending')
            .limit(1);
        
        if (existing && existing.length > 0) {
            return res.status(409).send({ error: 'Une invitation est déjà en attente pour cet utilisateur et cette équipe.' });
        }

        // Créer l'invitation
        const { data: invitation, error: inviteError } = await supabase
            .from('invitations')
            .insert({
                team_id: teamId,
                invitee_email: inviteeEmail,
                inviter_id: inviterId,
                role: role,
                status: 'pending'
            })
            .select()
            .single();
        
        if (inviteError) throw inviteError;

        console.log(`SIMULATION: Envoi d'un email d'invitation à ${inviteeEmail} pour rejoindre l'équipe ${teamId} avec le rôle ${role}. Invitation ID: ${invitation.id}`);

        res.status(201).send({
            message: 'Invitation envoyée avec succès (simulation)',
            inviteId: invitation.id
        });

    } catch (error) {
        console.error('Erreur lors de l\'invitation:', error);
        res.status(500).send({ error: 'Erreur interne du serveur lors de l\'invitation.' });
    }
});

app.get('/api/teams/members', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.uid;

        const { teamId, userProfile } = await getOrInitializeTeamId(userId);

        // Récupérer tous les membres de l'équipe
        const { data: members, error } = await supabase
            .from('users')
            .select('id, name, email, role')
            .eq('team_id', teamId);

        if (error) throw error;

        res.status(200).json(members || []);

    } catch (error) {
        console.error('Erreur lors de la récupération des membres de l\'équipe:', error);
        res.status(500).send({ error: 'Erreur lors de la récupération des membres de l\'équipe.' });
    }
});

app.put('/api/teams/members/:memberId/role', authenticateToken, async (req, res) => {
    try {
        const { memberId } = req.params;
        const { role: newRole } = req.body;
        const adminId = req.user.uid;

        const allowedRoles = ['admin', 'manager', 'member'];
        if (!newRole || !allowedRoles.includes(newRole)) {
            return res.status(400).send({ error: 'Rôle invalide.' });
        }

        const adminProfile = await db.getUser(adminId);
        if (!adminProfile || adminProfile.role !== 'admin') {
            return res.status(403).send({ error: 'Action non autorisée. Seul un administrateur peut modifier les rôles.' });
        }
        const teamId = adminProfile.team_id;

        if (adminId === memberId) {
             return res.status(400).send({ error: 'Vous ne pouvez pas modifier votre propre rôle.' });
        }

        const memberProfile = await db.getUser(memberId);
        if (!memberProfile) {
            return res.status(404).send({ error: 'Membre non trouvé.' });
        }
        if (memberProfile.team_id !== teamId) {
            return res.status(403).send({ error: 'Ce membre ne fait pas partie de votre équipe.' });
        }

        await db.updateUser(memberId, { role: newRole });

        res.status(200).send({ message: 'Rôle du membre mis à jour avec succès.' });

    } catch (error) {
        console.error('Erreur lors de la modification du rôle:', error);
        res.status(500).send({ error: 'Erreur interne du serveur lors de la modification du rôle.' });
    }
});

app.delete('/api/teams/members/:memberId', authenticateToken, async (req, res) => {
    try {
        const { memberId } = req.params;
        const adminId = req.user.uid;

        const adminProfile = await db.getUser(adminId);
        if (!adminProfile || adminProfile.role !== 'admin') {
            return res.status(403).send({ error: 'Action non autorisée. Seul un administrateur peut supprimer des membres.' });
        }
        const teamId = adminProfile.team_id;

        if (adminId === memberId) {
             return res.status(400).send({ error: 'Vous ne pouvez pas vous supprimer vous-même de l\'équipe.' });
        }

        const memberProfile = await db.getUser(memberId);
        if (!memberProfile) {
            return res.status(404).send({ error: 'Membre non trouvé.' });
        }
        if (memberProfile.team_id !== teamId) {
            return res.status(403).send({ error: 'Ce membre ne fait pas partie de votre équipe.' });
        }

        // Retirer le membre de l'équipe en mettant team_id et role à null
        await db.updateUser(memberId, {
             team_id: null, 
             role: null 
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
        const userId = req.user.uid;
        const { startDate, endDate } = req.query; // ex: '2025-01-01', '2025-01-31'

        if (!startDate || !endDate) {
            return res.status(400).send({ error: 'Les dates de début et de fin sont requises.' });
        }

        // 1. Récupérer le teamId de l'utilisateur
        const { teamId } = await getOrInitializeTeamId(userId);

        // 2. Récupérer les données des propriétés (pour le prix de base)
        const properties = await db.getPropertiesByTeam(teamId);
        if (!properties || properties.length === 0) {
            return res.status(200).json({ totalRevenue: 0, totalNightsBooked: 0, adr: 0, occupancy: 0, totalNightsAvailable: 0, iaGain: 0, iaScore: 0, revPar: 0 });
        }
        
        const propertyBasePrices = new Map();
        properties.forEach(prop => {
            propertyBasePrices.set(prop.id, prop.base_price || 0); // Utiliser 0 si non défini
        });
        
        const totalPropertiesInTeam = properties.length;

        // 3. Calculer le nombre de jours dans la période
        const start = new Date(startDate);
        const end = new Date(endDate);
        const daysInPeriod = Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1; // +1 pour inclure le dernier jour
        const totalNightsAvailable = totalPropertiesInTeam * daysInPeriod;

        // 4. Interroger toutes les réservations de l'équipe qui chevauchent la période
        const bookings = await db.getBookingsByTeamAndDateRange(teamId, startDate, endDate);

        if (!bookings || bookings.length === 0) {
             return res.status(200).json({ totalRevenue: 0, totalNightsBooked: 0, adr: 0, occupancy: 0, totalNightsAvailable: totalNightsAvailable, iaGain: 0, iaScore: 0, revPar: 0 });
        }

        let totalRevenue = 0;
        let totalNightsBooked = 0;
        let totalBaseRevenue = 0; // Pour calculer le gain IA
        let premiumNights = 0; // Pour le score IA

        // 5. Calculer les KPIs
        bookings.forEach(booking => {
            const propertyId = booking.property_id;
            const basePrice = propertyBasePrices.get(propertyId) || 0; // Récupérer le prix de base

            const bookingStart = new Date(booking.start_date);
            const bookingEnd = new Date(booking.end_date);

            const effectiveStart = new Date(Math.max(bookingStart.getTime(), start.getTime()));
            const effectiveEnd = new Date(Math.min(bookingEnd.getTime(), end.getTime()));
            
            let nightsInPeriod = 0;
            let currentDate = new Date(effectiveStart);
            while(currentDate < effectiveEnd && currentDate <= end) { 
                nightsInPeriod++;
                currentDate.setDate(currentDate.getDate() + 1);
            }
            
            const pricePerNight = booking.price_per_night || (booking.revenue ? booking.revenue / Math.ceil((bookingEnd - bookingStart) / (1000 * 60 * 60 * 24)) : 0);
            
            totalNightsBooked += nightsInPeriod;
            totalRevenue += pricePerNight * nightsInPeriod;
            
            // Nouveaux calculs
            totalBaseRevenue += (basePrice || 0) * nightsInPeriod;
            if (pricePerNight > basePrice) {
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
        console.error('Erreur lors du calcul des KPIs:', error);
        res.status(500).send({ error: 'Erreur serveur lors du calcul des KPIs.' });
    }
});

// GET /api/reports/revenue-over-time
app.get('/api/reports/revenue-over-time', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const { startDate, endDate } = req.query;

        if (!startDate || !endDate) {
            return res.status(400).send({ error: 'Les dates de début et de fin sont requises.' });
        }

        // 1. Trouver le teamId et le nombre total de propriétés
        const { teamId } = await getOrInitializeTeamId(userId);

        const properties = await db.getPropertiesByTeam(teamId);
        const totalPropertiesInTeam = properties.length;

        // 2. Initialiser une carte de dates
        const datesMap = new Map();
        let currentDate = new Date(startDate + 'T00:00:00Z'); // Forcer UTC
        const finalDate = new Date(endDate + 'T00:00:00Z');

        while (currentDate <= finalDate) {
            datesMap.set(currentDate.toISOString().split('T')[0], { revenue: 0, nightsBooked: 0 }); // Stocker un objet
            currentDate.setUTCDate(currentDate.getUTCDate() + 1);
        }

        // 3. Récupérer les réservations qui chevauchent la période
        const bookings = await db.getBookingsByTeamAndDateRange(teamId, startDate, endDate);

        // 4. Itérer sur chaque réservation et chaque jour de la réservation
        bookings.forEach(booking => {
            const pricePerNight = booking.price_per_night || (booking.revenue ? booking.revenue / Math.ceil((new Date(booking.end_date) - new Date(booking.start_date)) / (1000 * 60 * 60 * 24)) : 0);
            
            let bookingDay = new Date(booking.start_date + 'T00:00:00Z');
            const bookingEnd = new Date(booking.end_date + 'T00:00:00Z');

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

// GET /api/reports/market-demand-snapshot - Indicateurs de demande sur les dernières 24h
app.get('/api/reports/market-demand-snapshot', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const { timezone } = req.query;

        // 1. Récupérer le teamId de l'utilisateur
        const { teamId } = await getOrInitializeTeamId(userId);

        // 2. Déterminer la fenêtre temporelle (24h glissantes)
        const now = new Date();
        const end = new Date(now);
        const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);

        // 3. Pour une première version, on s'appuie sur les réservations récentes
        //    comme proxy de la demande (faute de logs de recherches/visites détaillées).
        // Récupérer les propriétés de l'équipe
        const properties = await db.getPropertiesByTeam(teamId);
        
        if (!properties || properties.length === 0) {
            return res.status(200).json({
                activeSearches: 0,
                listingViews: 0,
                conversionRate: 0,
                windowStart: start.toISOString(),
                windowEnd: end.toISOString(),
                timezone: timezone || 'UTC'
            });
        }
        
        const propertyIds = properties.map(p => p.id);
        
        // Récupérer les réservations créées dans les dernières 24h
        // Note: Si la table bookings n'a pas de created_at, on utilise start_date comme approximation
        const startDateStr = start.toISOString().split('T')[0];
        const endDateStr = end.toISOString().split('T')[0];
        
        const { data: bookings, error: bookingsError } = await supabase
            .from('bookings')
            .select('id')
            .in('property_id', propertyIds)
            .gte('start_date', startDateStr)
            .lte('start_date', endDateStr);
        
        if (bookingsError) throw bookingsError;

        const totalBookings = bookings ? bookings.length : 0;

        // Heuristique simple :
        // - "recherches actives" ≈ 20x le nombre de réservations créées
        // - "visites annonces" ≈ 10x le nombre de réservations
        // - "taux de conversion" = bookings / visites * 100
        const listingViews = totalBookings * 10;
        const activeSearches = totalBookings * 20;
        const conversionRate = listingViews > 0 ? (totalBookings / listingViews) * 100 : 0;

        res.status(200).json({
            activeSearches,
            listingViews,
            conversionRate,
            windowStart: start.toISOString(),
            windowEnd: end.toISOString(),
            timezone: timezone || 'UTC'
        });

    } catch (error) {
        console.error('Erreur lors du calcul du snapshot de demande marché:', error);
        res.status(500).send({ error: 'Erreur serveur lors du calcul du snapshot de demande marché.' });
    }
});

// GET /api/reports/positioning - ADR vs marché + distribution prix concurrents (avec IA)
app.get('/api/reports/positioning', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const { startDate, endDate } = req.query;

        if (!startDate || !endDate) {
            return res.status(400).send({ error: 'Les dates de début et de fin sont requises.' });
        }

        // 1. Récupérer le teamId et les propriétés
        const { teamId, userProfile } = await getOrInitializeTeamId(userId);

        const propertiesList = await db.getPropertiesByTeam(teamId);
        if (propertiesList.length === 0) {
            return res.status(200).json({
                adrVsMarket: { labels: [], yourAdrData: [], marketAdrData: [] },
                priceDistribution: { labels: [], data: [] }
            });
        }

        const properties = [];
        const propertyIdIndexMap = new Map();
        let index = 0;
        propertiesList.forEach(prop => {
            properties.push({
                id: prop.id,
                name: prop.address || prop.name || 'Propriété',
                location: prop.location || '',
                type: prop.property_type || 'appartement',
                basePrice: prop.base_price || 0,
                capacity: prop.capacity || 2
            });
            propertyIdIndexMap.set(prop.id, index++);
        });

        // 2. Agréger ADR par propriété sur la période (basé sur les réservations)
        const start = new Date(startDate + 'T00:00:00Z');
        const end = new Date(endDate + 'T00:00:00Z');

        const adrStats = properties.map(p => ({
            id: p.id,
            name: p.name,
            revenue: 0,
            nights: 0
        }));

        // Récupérer toutes les réservations de l'équipe pour la période
        const bookings = await db.getBookingsByTeamAndDateRange(teamId, startDate, endDate);

        bookings.forEach(booking => {
            const propertyId = booking.property_id;
            if (!propertyId || !propertyIdIndexMap.has(propertyId)) return;

            const statIndex = propertyIdIndexMap.get(propertyId);
            const stat = adrStats[statIndex];

            const bookingStart = new Date(booking.start_date + 'T00:00:00Z');
            const bookingEnd = new Date(booking.end_date + 'T00:00:00Z');

            const effectiveStart = bookingStart < start ? start : bookingStart;
            const effectiveEnd = bookingEnd > end ? end : bookingEnd;

            let currentDate = new Date(effectiveStart);
            while (currentDate < effectiveEnd) {
                stat.nights += 1;
                stat.revenue += booking.price_per_night || (booking.revenue ? booking.revenue / Math.ceil((bookingEnd - bookingStart) / (1000 * 60 * 60 * 24)) : 0);
                currentDate.setUTCDate(currentDate.getUTCDate() + 1);
            }
        });

        const propertyStats = adrStats.map((s, i) => {
            const prop = properties[i];
            const yourAdr = s.nights > 0 ? s.revenue / s.nights : prop.basePrice || 0;
            return {
                id: prop.id,
                name: prop.name,
                location: prop.location,
                type: prop.type,
                capacity: prop.capacity,
                basePrice: prop.basePrice,
                yourAdr: Math.round(yourAdr)
            };
        });

        // 3. Construire le prompt IA pour obtenir ADR marché + distribution prix concurrents
        const today = new Date().toISOString().split('T')[0];
        const isFrench = (req.query.language || userProfile?.language || 'fr') === 'fr' || (req.query.language || userProfile?.language || 'fr') === 'fr-FR';
        const positioningPrompt = isFrench ? `
Tu es un moteur de benchmarking tarifaire pour la location courte durée.

Contexte:
- Date d'exécution: ${today}
- Période analysée: du ${startDate} au ${endDate}
- Marché principal: ${propertyStats[0]?.location || 'Non spécifié'}

Voici les propriétés de mon portefeuille et leur ADR observé sur la période:
${JSON.stringify(propertyStats, null, 2)}

Ta mission:
1) Utilise des recherches web pour trouver les prix moyens réels du marché pour des propriétés comparables dans ${propertyStats[0]?.location || 'cette zone'}.
2) Pour chaque propriété ci-dessus, estime l'ADR moyen du marché pour des concurrents directs comparables (marketAdr) basé sur les données réelles trouvées.
3) Construis également une distribution agrégée des prix concurrents sur ce marché (histogramme) en euros basée sur les données réelles.

Contraintes:
- Utilise uniquement des valeurs entières en euros.
- Ne renvoie AUCUN texte en dehors du JSON.
- La réponse DOIT être un objet JSON STRICTEMENT VALIDE au format:
{
  "adrVsMarket": {
    "labels": ["Nom propriété 1", "Nom propriété 2", "..."],
    "yourAdrData": [120, 95, 140],
    "marketAdrData": [110, 100, 130]
  },
  "priceDistribution": {
    "labels": ["0-100", "100-150", "150-200", "200-250", "250-300", "300+"],
    "data": [8, 12, 18, 15, 10, 5]
  }
}

RAPPEL CRITIQUE: Réponds UNIQUEMENT avec ce JSON, sans commentaire, sans texte autour, sans markdown.` : `
You are a pricing benchmarking engine for short-term rentals.

Context:
- Execution date: ${today}
- Analysis period: from ${startDate} to ${endDate}
- Main market: ${propertyStats[0]?.location || 'Not specified'}

Here are my portfolio properties and their observed ADR over the period:
${JSON.stringify(propertyStats, null, 2)}

Your mission:
1) Use web searches to find real average market prices for comparable properties in ${propertyStats[0]?.location || 'this area'}.
2) For each property above, estimate the average market ADR for comparable direct competitors (marketAdr) based on real data found.
3) Also build an aggregated distribution of competitor prices in this market (histogram) in euros based on real data.

Constraints:
- Use only integer values in euros.
- Return NO text outside the JSON.
- The response MUST be a STRICTLY VALID JSON object in the format:
{
  "adrVsMarket": {
    "labels": ["Property name 1", "Property name 2", "..."],
    "yourAdrData": [120, 95, 140],
    "marketAdrData": [110, 100, 130]
  },
  "priceDistribution": {
    "labels": ["0-100", "100-150", "150-200", "200-250", "250-300", "300+"],
    "data": [8, 12, 18, 15, 10, 5]
  }
}

CRITICAL REMINDER: Respond ONLY with this JSON, no comments, no text around, no markdown.`;

        // Récupérer la langue de l'utilisateur
        const language = req.query.language || userProfile?.language || 'fr';
        
        let iaResult = null;
        try {
            iaResult = await callGeminiWithSearch(positioningPrompt, 10, language);
        } catch (e) {
            console.error('Erreur lors de l\'appel IA pour le positionnement:', e);
        }

        // 4. Fallback local si l’IA ne renvoie rien d’exploitable
        if (!iaResult || !iaResult.adrVsMarket || !Array.isArray(iaResult.adrVsMarket.labels)) {
            const labels = propertyStats.map(p => p.name);
            const yourAdrData = propertyStats.map(p => p.yourAdr);
            const marketAdrData = yourAdrData.map(v => Math.round(v * 0.9 + 10)); // heuristique simple

            iaResult = {
                adrVsMarket: {
                    labels,
                    yourAdrData,
                    marketAdrData
                },
                priceDistribution: {
                    labels: ['0-100', '100-150', '150-200', '200-250', '250-300', '300+'],
                    data: [8, 12, 18, 15, 10, 5]
                }
            };
        }

        res.status(200).json(iaResult);

    } catch (error) {
        console.error('Erreur lors du calcul du rapport de positionnement:', error);
        res.status(500).send({ error: 'Erreur serveur lors du calcul du rapport de positionnement.' });
    }
});

// GET /api/reports/performance-over-time
app.get('/api/reports/performance-over-time', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const { startDate, endDate } = req.query;

        if (!startDate || !endDate) {
            return res.status(400).send({ error: 'Les dates de début et de fin sont requises.' });
        }

        // 1. Find teamId and total properties
        const { teamId } = await getOrInitializeTeamId(userId);

        const propertiesList = await db.getPropertiesByTeam(teamId);
        const totalPropertiesInTeam = propertiesList.length;

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
        const bookings = await db.getBookingsByTeamAndDateRange(teamId, startDate, endDate);

        // 5. Populate dailyData map
        bookings.forEach(booking => {
            const bookingStartDateStr = booking.start_date;
            
            // A. Count new bookings (bookingCount)
            if (dailyData.has(bookingStartDateStr)) {
                dailyData.get(bookingStartDateStr).newBookings += 1;
            }
            
            // B. Count occupied nights (occupancyRate)
            let bookingDay = new Date(booking.start_date + 'T00:00:00Z');
            const bookingEnd = new Date(booking.end_date + 'T00:00:00Z');
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

// Fonctions utilitaires pour les prévisions
/**
 * Calcule la moyenne mobile d'un tableau de valeurs
 * @param {Array<number>} data - Tableau de valeurs
 * @param {number} window - Taille de la fenêtre (nombre d'éléments)
 * @returns {number} - Moyenne mobile
 */
function calculateMovingAverage(data, window) {
    if (!data || data.length === 0) return 0;
    if (data.length < window) {
        // Si pas assez de données, retourner la moyenne simple
        const sum = data.reduce((acc, val) => acc + val, 0);
        return sum / data.length;
    }
    // Prendre les N derniers éléments
    const recentData = data.slice(-window);
    const sum = recentData.reduce((acc, val) => acc + val, 0);
    return sum / window;
}

/**
 * Calcule la tendance linéaire (pente) d'un tableau de valeurs
 * @param {Array<number>} data - Tableau de valeurs
 * @returns {number} - Pente de la tendance (peut être négative)
 */
function calculateLinearTrend(data) {
    if (!data || data.length < 2) return 0;
    
    const n = data.length;
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumX2 = 0;
    
    // Calculer les sommes pour la régression linéaire
    for (let i = 0; i < n; i++) {
        const x = i + 1; // Position (1, 2, 3, ...)
        const y = data[i];
        sumX += x;
        sumY += y;
        sumXY += x * y;
        sumX2 += x * x;
    }
    
    // Formule de la pente: slope = (n*ΣXY - ΣX*ΣY) / (n*ΣX² - (ΣX)²)
    const denominator = (n * sumX2) - (sumX * sumX);
    if (denominator === 0) return 0;
    
    const slope = ((n * sumXY) - (sumX * sumY)) / denominator;
    return slope;
}

/**
 * Groupe les données journalières par semaine
 * @param {Object} dailyData - Objet avec labels (dates) et data (valeurs)
 * @returns {Object} - Objet avec labels (semaines) et data (valeurs agrégées)
 */
function groupByWeek(dailyData) {
    if (!dailyData || !dailyData.labels || !dailyData.data || dailyData.labels.length === 0) {
        return { labels: [], data: [] };
    }
    
    const weeklyData = new Map();
    
    dailyData.labels.forEach((dateStr, index) => {
        const date = new Date(dateStr + 'T00:00:00Z');
        const weekId = getWeekId(date);
        const value = dailyData.data[index] || 0;
        
        if (!weeklyData.has(weekId)) {
            weeklyData.set(weekId, { sum: 0, count: 0 });
        }
        
        const week = weeklyData.get(weekId);
        week.sum += value;
        week.count += 1;
    });
    
    // Convertir en tableaux triés
    const sortedWeeks = Array.from(weeklyData.keys()).sort();
    const labels = sortedWeeks;
    const data = sortedWeeks.map(weekId => {
        const week = weeklyData.get(weekId);
        return week.count > 0 ? week.sum / week.count : 0; // Moyenne par semaine
    });
    
    return { labels, data };
}

/**
 * Calcule l'ADR à partir du revenu, de l'occupation et du nombre de propriétés
 * @param {number} revenue - Revenu total
 * @param {number} occupancy - Taux d'occupation (en pourcentage)
 * @param {number} totalProperties - Nombre total de propriétés
 * @returns {number} - ADR calculé
 */
function calculateAdr(revenue, occupancy, totalProperties) {
    if (!totalProperties || totalProperties === 0) return 0;
    const occupancyDecimal = occupancy / 100;
    const nightsBooked = occupancyDecimal * totalProperties * 7; // Pour une semaine
    if (nightsBooked === 0) return 0;
    return revenue / nightsBooked;
}

// GET /api/reports/forecast-revenue
app.get('/api/reports/forecast-revenue', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const { startDate, endDate, forecastPeriod = 4 } = req.query;

        if (!startDate || !endDate) {
            return res.status(400).send({ error: 'Les dates de début et de fin sont requises.' });
        }

        const forecastWeeks = parseInt(forecastPeriod, 10) || 4;
        if (forecastWeeks < 1 || forecastWeeks > 12) {
            return res.status(400).send({ error: 'Le nombre de semaines à prévoir doit être entre 1 et 12.' });
        }

        // 1. Récupérer le teamId et le nombre de propriétés
        const { teamId, userProfile } = await getOrInitializeTeamId(userId);

        const properties = await db.getPropertiesByTeam(teamId);
        const totalPropertiesInTeam = properties.length;

        if (totalPropertiesInTeam === 0) {
            return res.status(200).json({
                labels: Array.from({ length: forecastWeeks }, (_, i) => `Sem ${i + 1}`),
                revenueData: Array(forecastWeeks).fill(0),
                occupancyData: Array(forecastWeeks).fill(0),
                adrData: Array(forecastWeeks).fill(0),
                revparData: Array(forecastWeeks).fill(0),
                metadata: {
                    forecastMethod: 'no_data',
                    historicalWeeks: 0,
                    confidence: 'none'
                }
            });
        }

        // 2. Récupérer les données historiques de revenus
        const start = new Date(startDate + 'T00:00:00Z');
        const end = new Date(endDate + 'T00:00:00Z');
        
        // Initialiser une carte de dates pour les revenus
        const datesMap = new Map();
        let currentDate = new Date(start);
        while (currentDate <= end) {
            datesMap.set(currentDate.toISOString().split('T')[0], { revenue: 0, nightsBooked: 0 });
            currentDate.setUTCDate(currentDate.getUTCDate() + 1);
        }

        // Récupérer les réservations
        const bookings = await db.getBookingsByTeamAndDateRange(teamId, startDate, endDate);

        // Calculer les revenus par jour
        bookings.forEach(booking => {
            const pricePerNight = booking.price_per_night || 
                (booking.revenue ? booking.revenue / Math.ceil((new Date(booking.end_date) - new Date(booking.start_date)) / (1000 * 60 * 60 * 24)) : 0);
            
            let bookingDay = new Date(booking.start_date + 'T00:00:00Z');
            const bookingEnd = new Date(booking.end_date + 'T00:00:00Z');

            while (bookingDay < bookingEnd) {
                const dateStr = bookingDay.toISOString().split('T')[0];
                if (datesMap.has(dateStr)) {
                    const current = datesMap.get(dateStr);
                    current.revenue += pricePerNight;
                    current.nightsBooked += 1;
                }
                bookingDay.setUTCDate(bookingDay.getUTCDate() + 1);
            }
        });

        // 3. Grouper les données par semaine
        const dailyRevenueData = {
            labels: Array.from(datesMap.keys()),
            data: Array.from(datesMap.values()).map(d => d.revenue)
        };

        const dailyOccupancyData = {
            labels: Array.from(datesMap.keys()),
            data: Array.from(datesMap.values()).map(d => {
                return totalPropertiesInTeam > 0 ? (d.nightsBooked / totalPropertiesInTeam) * 100 : 0;
            })
        };

        const weeklyRevenue = groupByWeek(dailyRevenueData);
        const weeklyOccupancy = groupByWeek(dailyOccupancyData);

        // 4. Vérifier si on a assez de données
        if (weeklyRevenue.data.length < 2) {
            // Pas assez de données historiques, utiliser la moyenne simple
            const avgRevenue = weeklyRevenue.data.length > 0 
                ? weeklyRevenue.data[0] 
                : 0;
            const avgOccupancy = weeklyOccupancy.data.length > 0 
                ? weeklyOccupancy.data[0] 
                : 0;

            const forecasts = [];
            for (let week = 1; week <= forecastWeeks; week++) {
                forecasts.push({
                    label: `Sem ${week}`,
                    revenue: Math.max(0, avgRevenue),
                    occupancy: Math.min(100, Math.max(0, avgOccupancy)),
                    adr: calculateAdr(avgRevenue, avgOccupancy, totalPropertiesInTeam),
                    revpar: totalPropertiesInTeam > 0 ? avgRevenue / (totalPropertiesInTeam * 7) : 0
                });
            }

            return res.status(200).json({
                labels: forecasts.map(f => f.label),
                revenueData: forecasts.map(f => f.revenue),
                occupancyData: forecasts.map(f => f.occupancy),
                adrData: forecasts.map(f => f.adr),
                revparData: forecasts.map(f => f.revpar),
                metadata: {
                    forecastMethod: 'simple_average',
                    historicalWeeks: weeklyRevenue.data.length,
                    confidence: 'low'
                }
            });
        }

        // 5. Calculer les moyennes mobiles (4 semaines ou toutes les semaines disponibles si moins)
        const movingAvgWindow = Math.min(4, weeklyRevenue.data.length);
        const movingAvgRevenue = calculateMovingAverage(weeklyRevenue.data, movingAvgWindow);
        const movingAvgOccupancy = calculateMovingAverage(weeklyOccupancy.data, movingAvgWindow);

        // 6. Calculer les tendances linéaires
        const revenueTrend = calculateLinearTrend(weeklyRevenue.data);
        const occupancyTrend = calculateLinearTrend(weeklyOccupancy.data);

        // 7. Générer les prévisions
        const forecasts = [];
        for (let week = 1; week <= forecastWeeks; week++) {
            // Prévision basée sur moyenne mobile + tendance
            let forecastRevenue = movingAvgRevenue + (revenueTrend * week);
            let forecastOccupancy = movingAvgOccupancy + (occupancyTrend * week);

            // Validation et limites
            forecastRevenue = Math.max(0, forecastRevenue);
            forecastOccupancy = Math.min(100, Math.max(0, forecastOccupancy));

            const forecastAdr = calculateAdr(forecastRevenue, forecastOccupancy, totalPropertiesInTeam);
            const forecastRevpar = totalPropertiesInTeam > 0 
                ? forecastRevenue / (totalPropertiesInTeam * 7) 
                : 0;

            forecasts.push({
                label: `Sem ${week}`,
                revenue: forecastRevenue,
                occupancy: forecastOccupancy,
                adr: forecastAdr,
                revpar: forecastRevpar
            });
        }

        // 8. Déterminer le niveau de confiance
        let confidence = 'medium';
        if (weeklyRevenue.data.length >= 8) {
            confidence = 'high';
        } else if (weeklyRevenue.data.length < 4) {
            confidence = 'low';
        }

        res.status(200).json({
            labels: forecasts.map(f => f.label),
            revenueData: forecasts.map(f => f.revenue),
            occupancyData: forecasts.map(f => f.occupancy),
            adrData: forecasts.map(f => f.adr),
            revparData: forecasts.map(f => f.revpar),
            metadata: {
                forecastMethod: 'linear_trend',
                historicalWeeks: weeklyRevenue.data.length,
                confidence: confidence
            }
        });

    } catch (error) {
        console.error('Erreur lors du calcul des prévisions de revenus:', error);
        res.status(500).send({ error: 'Erreur serveur lors du calcul des prévisions de revenus.' });
    }
});

// GET /api/reports/forecast-scenarios
app.get('/api/reports/forecast-scenarios', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const { startDate, endDate, forecastPeriod = 4 } = req.query;

        if (!startDate || !endDate) {
            return res.status(400).send({ error: 'Les dates de début et de fin sont requises.' });
        }

        const forecastWeeks = parseInt(forecastPeriod, 10) || 4;
        if (forecastWeeks < 1 || forecastWeeks > 12) {
            return res.status(400).send({ error: 'Le nombre de semaines à prévoir doit être entre 1 et 12.' });
        }

        // 1. Récupérer le teamId et le nombre de propriétés
        const { teamId, userProfile } = await getOrInitializeTeamId(userId);

        const properties = await db.getPropertiesByTeam(teamId);
        const totalPropertiesInTeam = properties.length;

        if (totalPropertiesInTeam === 0) {
            return res.status(200).json({
                labels: Array.from({ length: forecastWeeks }, (_, i) => `Sem ${i + 1}`),
                baselineData: Array(forecastWeeks).fill(0),
                optimisticData: Array(forecastWeeks).fill(0),
                pessimisticData: Array(forecastWeeks).fill(0),
                metadata: {
                    forecastMethod: 'no_data',
                    historicalWeeks: 0,
                    confidence: 'none'
                }
            });
        }

        // 2. Récupérer les données historiques de revenus (même logique que forecast-revenue)
        const start = new Date(startDate + 'T00:00:00Z');
        const end = new Date(endDate + 'T00:00:00Z');
        
        const datesMap = new Map();
        let currentDate = new Date(start);
        while (currentDate <= end) {
            datesMap.set(currentDate.toISOString().split('T')[0], { revenue: 0, nightsBooked: 0 });
            currentDate.setUTCDate(currentDate.getUTCDate() + 1);
        }

        const bookings = await db.getBookingsByTeamAndDateRange(teamId, startDate, endDate);

        bookings.forEach(booking => {
            const pricePerNight = booking.price_per_night || 
                (booking.revenue ? booking.revenue / Math.ceil((new Date(booking.end_date) - new Date(booking.start_date)) / (1000 * 60 * 60 * 24)) : 0);
            
            let bookingDay = new Date(booking.start_date + 'T00:00:00Z');
            const bookingEnd = new Date(booking.end_date + 'T00:00:00Z');

            while (bookingDay < bookingEnd) {
                const dateStr = bookingDay.toISOString().split('T')[0];
                if (datesMap.has(dateStr)) {
                    const current = datesMap.get(dateStr);
                    current.revenue += pricePerNight;
                    current.nightsBooked += 1;
                }
                bookingDay.setUTCDate(bookingDay.getUTCDate() + 1);
            }
        });

        // 3. Grouper par semaine
        const dailyRevenueData = {
            labels: Array.from(datesMap.keys()),
            data: Array.from(datesMap.values()).map(d => d.revenue)
        };

        const weeklyRevenue = groupByWeek(dailyRevenueData);

        // 4. Calculer le baseline (scénario de base)
        let baselineForecasts = [];
        let movingAvgRevenue = 0;
        let revenueTrend = 0;

        if (weeklyRevenue.data.length < 2) {
            // Pas assez de données, utiliser moyenne simple
            const avgRevenue = weeklyRevenue.data.length > 0 ? weeklyRevenue.data[0] : 0;
            for (let week = 1; week <= forecastWeeks; week++) {
                baselineForecasts.push(Math.max(0, avgRevenue));
            }
        } else {
            // Calculer moyenne mobile et tendance
            const movingAvgWindow = Math.min(4, weeklyRevenue.data.length);
            movingAvgRevenue = calculateMovingAverage(weeklyRevenue.data, movingAvgWindow);
            revenueTrend = calculateLinearTrend(weeklyRevenue.data);

            // Générer prévisions baseline
            for (let week = 1; week <= forecastWeeks; week++) {
                const forecastRevenue = movingAvgRevenue + (revenueTrend * week);
                baselineForecasts.push(Math.max(0, forecastRevenue));
            }
        }

        // 5. Calculer les scénarios optimiste et pessimiste
        // Optimiste : +10% par rapport au baseline
        // Pessimiste : -10% par rapport au baseline
        const optimisticForecasts = baselineForecasts.map(revenue => Math.round(revenue * 1.1));
        const pessimisticForecasts = baselineForecasts.map(revenue => Math.round(revenue * 0.9));

        // 6. Générer les labels
        const labels = Array.from({ length: forecastWeeks }, (_, i) => `Sem ${i + 1}`);

        // 7. Déterminer le niveau de confiance
        let confidence = 'medium';
        if (weeklyRevenue.data.length >= 8) {
            confidence = 'high';
        } else if (weeklyRevenue.data.length < 4) {
            confidence = 'low';
        }

        res.status(200).json({
            labels: labels,
            baselineData: baselineForecasts,
            optimisticData: optimisticForecasts,
            pessimisticData: pessimisticForecasts,
            metadata: {
                forecastMethod: weeklyRevenue.data.length < 2 ? 'simple_average' : 'linear_trend',
                historicalWeeks: weeklyRevenue.data.length,
                confidence: confidence,
                optimisticMultiplier: 1.1,
                pessimisticMultiplier: 0.9
            }
        });

    } catch (error) {
        console.error('Erreur lors du calcul des scénarios de prévision:', error);
        res.status(500).send({ error: 'Erreur serveur lors du calcul des scénarios de prévision.' });
    }
});

// GET /api/reports/forecast-radar
app.get('/api/reports/forecast-radar', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const { startDate, endDate, propertyId } = req.query;

        if (!startDate || !endDate) {
            return res.status(400).send({ error: 'Les dates de début et de fin sont requises.' });
        }

        // 1. Récupérer le teamId
        const { teamId, userProfile } = await getOrInitializeTeamId(userId);

        const properties = await db.getPropertiesByTeam(teamId);
        if (properties.length === 0) {
            return res.status(200).json({
                labels: ['Revenue', 'Occupancy', 'ADR', 'AI Score', 'ROI'],
                data: [0, 0, 0, 0, 0]
            });
        }

        // 2. Récupérer les KPIs pour la période
        const start = new Date(startDate + 'T00:00:00Z');
        const end = new Date(endDate + 'T00:00:00Z');
        const daysInPeriod = Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1;
        const totalPropertiesInTeam = properties.length;

        // Calculer les KPIs (même logique que /api/reports/kpis)
        const propertyBasePrices = new Map();
        properties.forEach(prop => {
            propertyBasePrices.set(prop.id, prop.base_price || 0);
        });

        const bookings = await db.getBookingsByTeamAndDateRange(teamId, startDate, endDate);

        let totalRevenue = 0;
        let totalNightsBooked = 0;
        let totalBaseRevenue = 0;
        let premiumNights = 0;

        bookings.forEach(booking => {
            const propertyId = booking.property_id;
            const basePrice = propertyBasePrices.get(propertyId) || 0;

            const bookingStart = new Date(booking.start_date);
            const bookingEnd = new Date(booking.end_date);

            const effectiveStart = new Date(Math.max(bookingStart.getTime(), start.getTime()));
            const effectiveEnd = new Date(Math.min(bookingEnd.getTime(), end.getTime()));
            
            let nightsInPeriod = 0;
            let currentDate = new Date(effectiveStart);
            while(currentDate < effectiveEnd && currentDate <= end) { 
                nightsInPeriod++;
                currentDate.setDate(currentDate.getDate() + 1);
            }
            
            const pricePerNight = booking.price_per_night || (booking.revenue ? booking.revenue / Math.ceil((bookingEnd - bookingStart) / (1000 * 60 * 60 * 24)) : 0);
            
            totalNightsBooked += nightsInPeriod;
            totalRevenue += pricePerNight * nightsInPeriod;
            totalBaseRevenue += (basePrice || 0) * nightsInPeriod;
            if (pricePerNight > basePrice) {
                premiumNights += nightsInPeriod;
            }
        });

        const adr = totalNightsBooked > 0 ? totalRevenue / totalNightsBooked : 0;
        const occupancy = totalPropertiesInTeam > 0 ? (totalNightsBooked / (totalPropertiesInTeam * daysInPeriod)) * 100 : 0;
        const iaScore = totalNightsBooked > 0 ? (premiumNights / totalNightsBooked) * 100 : 0;

        // 3. Calculer les scores normalisés (0-100)

        // Score Revenue: basé sur revenu vs objectif (ou heuristique)
        let revenueScore = 50; // Par défaut
        if (userProfile.revenue_targets && typeof userProfile.revenue_targets === 'object') {
            // Calculer l'objectif pour la période (approximation mensuelle)
            const monthKey = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
            const monthlyTarget = userProfile.revenue_targets[monthKey] || 0;
            if (monthlyTarget > 0) {
                // Projeter l'objectif mensuel sur la période
                const daysInMonth = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
                const periodTarget = (monthlyTarget / daysInMonth) * daysInPeriod;
                revenueScore = Math.min(100, (totalRevenue / periodTarget) * 100);
            }
        } else {
            // Heuristique: comparer avec la moyenne historique (si disponible)
            // Pour l'instant, utiliser une estimation basée sur le revenu moyen par nuit
            const avgRevenuePerNight = totalRevenue / Math.max(1, daysInPeriod);
            // Estimation: objectif = 150€/nuit/propriété (ajustable)
            const estimatedTarget = 150 * totalPropertiesInTeam * daysInPeriod;
            if (estimatedTarget > 0) {
                revenueScore = Math.min(100, (totalRevenue / estimatedTarget) * 100);
            }
        }

        // Score Occupancy: déjà en pourcentage (0-100)
        const occupancyScore = Math.min(100, Math.max(0, occupancy));

        // Score ADR: comparer avec l'ADR marché
        let adrScore = 50; // Par défaut
        try {
            // Essayer de récupérer les données de positionnement
            // Note: On pourrait optimiser en réutilisant les données déjà calculées
            const positioningData = await new Promise((resolve) => {
                // Simuler un appel interne (pour éviter la complexité, on calcule directement)
                resolve(null);
            });

            // Calculer l'ADR marché moyen (heuristique basée sur l'ADR actuel)
            // En production, on utiliserait les données de getPositioningReport
            const estimatedMarketAdr = adr > 0 ? adr * 0.9 : 100; // Estimation: marché à 90% de notre ADR
            if (estimatedMarketAdr > 0) {
                adrScore = Math.min(100, (adr / estimatedMarketAdr) * 100);
            }
        } catch (e) {
            // Fallback: utiliser une heuristique simple
            adrScore = adr > 0 ? Math.min(100, (adr / 150) * 100) : 0; // 150€ = référence
        }

        // Score AI Score: déjà en pourcentage (0-100)
        const aiScoreValue = Math.min(100, Math.max(0, iaScore));

        // Score ROI: basé sur revenus vs coûts
        let roiScore = 50; // Par défaut
        let totalCosts = 0;
        
        // Essayer de calculer les coûts si disponibles
        properties.forEach(prop => {
            // Si la propriété a un coût par nuit défini
            if (prop.operating_cost || prop.cost_per_night) {
                const costPerNight = prop.operating_cost || prop.cost_per_night || 0;
                totalCosts += costPerNight * daysInPeriod;
            }
        });

        if (totalCosts > 0) {
            const roi = ((totalRevenue - totalCosts) / totalCosts) * 100;
            // Normaliser ROI sur 0-100 (ROI de 0% = 50, ROI de 100% = 100, ROI négatif = 0-50)
            roiScore = Math.min(100, Math.max(0, 50 + (roi / 2))); // ROI de 100% = score de 100
        } else {
            // Heuristique: estimer les coûts à 30% des revenus
            const estimatedCosts = totalRevenue * 0.3;
            if (estimatedCosts > 0) {
                const estimatedRoi = ((totalRevenue - estimatedCosts) / estimatedCosts) * 100;
                roiScore = Math.min(100, Math.max(0, 50 + (estimatedRoi / 2)));
            }
        }

        // 4. Arrondir les scores
        const scores = [
            Math.round(revenueScore),
            Math.round(occupancyScore),
            Math.round(adrScore),
            Math.round(aiScoreValue),
            Math.round(roiScore)
        ];

        res.status(200).json({
            labels: ['Revenue', 'Occupancy', 'ADR', 'AI Score', 'ROI'],
            data: scores,
            metadata: {
                rawValues: {
                    revenue: totalRevenue,
                    occupancy: occupancy,
                    adr: adr,
                    aiScore: iaScore,
                    roi: totalCosts > 0 ? ((totalRevenue - totalCosts) / totalCosts) * 100 : null
                },
                hasRevenueTarget: !!userProfile.revenue_targets,
                hasCosts: totalCosts > 0
            }
        });

    } catch (error) {
        console.error('Erreur lors du calcul des prévisions radar:', error);
        res.status(500).send({ error: 'Erreur serveur lors du calcul des prévisions radar.' });
    }
});

// GET /api/reports/revenue-vs-target
app.get('/api/reports/revenue-vs-target', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const { startDate, endDate } = req.query;

        if (!startDate || !endDate) {
            return res.status(400).send({ error: 'Les dates de début et de fin sont requises.' });
        }

        // 1. Récupérer le teamId
        const { teamId, userProfile } = await getOrInitializeTeamId(userId);

        const properties = await db.getPropertiesByTeam(teamId);
        if (properties.length === 0) {
            return res.status(200).json({
                labels: [],
                targetData: [],
                revenueData: []
            });
        }

        // 2. Récupérer les objectifs de revenus
        const revenueTargets = userProfile.revenue_targets || {};
        
        // 3. Calculer les revenus réels par mois
        const start = new Date(startDate + 'T00:00:00Z');
        const end = new Date(endDate + 'T00:00:00Z');

        // Initialiser une carte pour les revenus par mois
        const monthlyRevenue = new Map();
        let currentMonth = new Date(start);
        
        while (currentMonth <= end) {
            const monthKey = `${currentMonth.getUTCFullYear()}-${String(currentMonth.getUTCMonth() + 1).padStart(2, '0')}`;
            monthlyRevenue.set(monthKey, 0);
            // Passer au mois suivant
            currentMonth = new Date(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth() + 1, 1);
        }

        // 4. Récupérer les réservations et calculer les revenus par mois
        const bookings = await db.getBookingsByTeamAndDateRange(teamId, startDate, endDate);

        bookings.forEach(booking => {
            const pricePerNight = booking.price_per_night || 
                (booking.revenue ? booking.revenue / Math.ceil((new Date(booking.end_date) - new Date(booking.start_date)) / (1000 * 60 * 60 * 24)) : 0);
            
            let bookingDay = new Date(booking.start_date + 'T00:00:00Z');
            const bookingEnd = new Date(booking.end_date + 'T00:00:00Z');

            while (bookingDay < bookingEnd) {
                // Vérifier si le jour est dans la plage de dates
                if (bookingDay >= start && bookingDay <= end) {
                    const monthKey = `${bookingDay.getUTCFullYear()}-${String(bookingDay.getUTCMonth() + 1).padStart(2, '0')}`;
                    if (monthlyRevenue.has(monthKey)) {
                        monthlyRevenue.set(monthKey, monthlyRevenue.get(monthKey) + pricePerNight);
                    }
                }
                bookingDay.setUTCDate(bookingDay.getUTCDate() + 1);
            }
        });

        // 5. Générer les labels et les données
        const sortedMonths = Array.from(monthlyRevenue.keys()).sort();
        const labels = [];
        const targetData = [];
        const revenueData = [];

        // Déterminer la locale selon la langue de l'utilisateur
        const language = userProfile.language || 'fr';
        const locale = language === 'fr' || language === 'fr-FR' ? 'fr-FR' : 'en-US';

        sortedMonths.forEach(monthKey => {
            const [year, month] = monthKey.split('-');
            const monthIndex = parseInt(month, 10) - 1;
            const date = new Date(parseInt(year, 10), monthIndex, 1);
            
            // Générer le label du mois (format court)
            const monthLabel = date.toLocaleDateString(locale, { month: 'short' });
            labels.push(monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1));

            // Récupérer l'objectif pour ce mois
            const target = revenueTargets[monthKey] || 0;
            targetData.push(target);

            // Récupérer le revenu réel
            const revenue = monthlyRevenue.get(monthKey) || 0;
            revenueData.push(Math.round(revenue));
        });

        res.status(200).json({
            labels: labels,
            targetData: targetData,
            revenueData: revenueData,
            metadata: {
                hasTargets: Object.keys(revenueTargets).length > 0,
                monthsWithTargets: Object.keys(revenueTargets).length,
                totalMonths: sortedMonths.length
            }
        });

    } catch (error) {
        console.error('Erreur lors du calcul du revenu vs objectif:', error);
        res.status(500).send({ error: 'Erreur serveur lors du calcul du revenu vs objectif.' });
    }
});

// GET /api/reports/gross-margin
app.get('/api/reports/gross-margin', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const { startDate, endDate } = req.query;

        if (!startDate || !endDate) {
            return res.status(400).send({ error: 'Les dates de début et de fin sont requises.' });
        }

        // 1. Récupérer le teamId
        const { teamId, userProfile } = await getOrInitializeTeamId(userId);

        const properties = await db.getPropertiesByTeam(teamId);
        if (properties.length === 0) {
            return res.status(200).json({
                labels: [],
                data: [],
                metadata: {
                    hasCosts: false,
                    message: 'Aucune propriété trouvée'
                }
            });
        }

        // 2. Calculer les revenus et coûts par mois
        const start = new Date(startDate + 'T00:00:00Z');
        const end = new Date(endDate + 'T00:00:00Z');

        // Initialiser une carte pour les revenus et coûts par mois
        const monthlyData = new Map();
        let currentMonth = new Date(start);
        
        while (currentMonth <= end) {
            const monthKey = `${currentMonth.getUTCFullYear()}-${String(currentMonth.getUTCMonth() + 1).padStart(2, '0')}`;
            monthlyData.set(monthKey, { revenue: 0, costs: 0 });
            // Passer au mois suivant
            currentMonth = new Date(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth() + 1, 1);
        }

        // 3. Récupérer les réservations et calculer les revenus par mois
        const bookings = await db.getBookingsByTeamAndDateRange(teamId, startDate, endDate);

        bookings.forEach(booking => {
            const pricePerNight = booking.price_per_night || 
                (booking.revenue ? booking.revenue / Math.ceil((new Date(booking.end_date) - new Date(booking.start_date)) / (1000 * 60 * 60 * 24)) : 0);
            
            let bookingDay = new Date(booking.start_date + 'T00:00:00Z');
            const bookingEnd = new Date(booking.end_date + 'T00:00:00Z');

            while (bookingDay < bookingEnd) {
                if (bookingDay >= start && bookingDay <= end) {
                    const monthKey = `${bookingDay.getUTCFullYear()}-${String(bookingDay.getUTCMonth() + 1).padStart(2, '0')}`;
                    if (monthlyData.has(monthKey)) {
                        monthlyData.get(monthKey).revenue += pricePerNight;
                    }
                }
                bookingDay.setUTCDate(bookingDay.getUTCDate() + 1);
            }
        });

        // 4. Calculer les coûts par mois
        let hasCosts = false;
        const propertyCosts = new Map();
        
        properties.forEach(prop => {
            // Vérifier si la propriété a un coût défini
            const costPerNight = prop.operating_cost || prop.cost_per_night || 0;
            if (costPerNight > 0) {
                hasCosts = true;
                propertyCosts.set(prop.id, costPerNight);
            }
        });

        // Si des coûts sont disponibles, les calculer par mois
        if (hasCosts) {
            monthlyData.forEach((data, monthKey) => {
                const [year, month] = monthKey.split('-');
                const monthIndex = parseInt(month, 10) - 1;
                const monthStart = new Date(parseInt(year, 10), monthIndex, 1);
                const monthEnd = new Date(parseInt(year, 10), monthIndex + 1, 0);
                
                // Calculer le nombre de jours dans le mois qui sont dans la plage
                const effectiveStart = monthStart < start ? start : monthStart;
                const effectiveEnd = monthEnd > end ? end : monthEnd;
                const daysInMonth = Math.max(0, Math.round((effectiveEnd - effectiveStart) / (1000 * 60 * 60 * 24)) + 1);
                
                // Calculer les coûts totaux pour ce mois
                let totalCosts = 0;
                propertyCosts.forEach((costPerNight, propertyId) => {
                    totalCosts += costPerNight * daysInMonth;
                });
                
                data.costs = totalCosts;
            });
        }

        // 5. Calculer les marges brutes par mois
        const sortedMonths = Array.from(monthlyData.keys()).sort();
        const labels = [];
        const marginData = [];

        // Déterminer la locale selon la langue de l'utilisateur
        const language = userProfile.language || 'fr';
        const locale = language === 'fr' || language === 'fr-FR' ? 'fr-FR' : 'en-US';

        sortedMonths.forEach(monthKey => {
            const [year, month] = monthKey.split('-');
            const monthIndex = parseInt(month, 10) - 1;
            const date = new Date(parseInt(year, 10), monthIndex, 1);
            
            // Générer le label du mois (format court)
            const monthLabel = date.toLocaleDateString(locale, { month: 'short' });
            labels.push(monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1));

            const data = monthlyData.get(monthKey);
            const revenue = data.revenue;
            const costs = data.costs;

            // Calculer la marge brute: (revenus - coûts) / revenus * 100
            let margin = null;
            if (hasCosts && revenue > 0) {
                margin = ((revenue - costs) / revenue) * 100;
                margin = Math.max(0, Math.min(100, margin)); // Limiter entre 0 et 100%
            } else if (!hasCosts) {
                // Si pas de coûts, on ne peut pas calculer la marge
                margin = null;
            }

            marginData.push(margin);
        });

        // 6. Retourner les résultats
        if (!hasCosts) {
            // Si pas de coûts disponibles, retourner null pour indiquer que les données ne sont pas disponibles
            return res.status(200).json({
                labels: labels,
                data: marginData, // Tous null
                metadata: {
                    hasCosts: false,
                    message: 'Les coûts opérationnels ne sont pas configurés. Veuillez ajouter operating_cost ou cost_per_night dans les propriétés.'
                }
            });
        }

        res.status(200).json({
            labels: labels,
            data: marginData.map(m => m !== null ? Math.round(m) : null),
            metadata: {
                hasCosts: true,
                totalProperties: properties.length,
                propertiesWithCosts: propertyCosts.size
            }
        });

    } catch (error) {
        console.error('Erreur lors du calcul de la marge brute:', error);
        res.status(500).send({ error: 'Erreur serveur lors du calcul de la marge brute.' });
    }
});

// GET /api/reports/adr-by-channel
app.get('/api/reports/adr-by-channel', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const { startDate, endDate } = req.query;

        if (!startDate || !endDate) {
            return res.status(400).send({ error: 'Les dates de début et de fin sont requises.' });
        }

        // 1. Récupérer le teamId
        const { teamId, userProfile } = await getOrInitializeTeamId(userId);

        const properties = await db.getPropertiesByTeam(teamId);
        if (properties.length === 0) {
            return res.status(200).json({
                labels: [],
                data: [],
                variations: []
            });
        }

        // 2. Calculer les dates de la période précédente pour les variations
        const start = new Date(startDate + 'T00:00:00Z');
        const end = new Date(endDate + 'T00:00:00Z');
        const periodDuration = end - start;
        const prevStart = new Date(start.getTime() - periodDuration);
        const prevEnd = new Date(start);
        const prevStartDate = prevStart.toISOString().split('T')[0];
        const prevEndDate = prevEnd.toISOString().split('T')[0];

        // 3. Récupérer les réservations pour la période actuelle et précédente
        const [currentBookings, prevBookings] = await Promise.all([
            db.getBookingsByTeamAndDateRange(teamId, startDate, endDate),
            db.getBookingsByTeamAndDateRange(teamId, prevStartDate, prevEndDate)
        ]);

        // 4. Grouper les réservations par canal pour la période actuelle
        const channelStats = new Map(); // channel -> { revenue: 0, nights: 0 }

        currentBookings.forEach(booking => {
            const channel = booking.channel || booking.source || 'Unknown';
            const pricePerNight = booking.price_per_night || 
                (booking.revenue ? booking.revenue / Math.ceil((new Date(booking.end_date) - new Date(booking.start_date)) / (1000 * 60 * 60 * 24)) : 0);
            
            const bookingStart = new Date(booking.start_date + 'T00:00:00Z');
            const bookingEnd = new Date(booking.end_date + 'T00:00:00Z');
            
            const effectiveStart = bookingStart < start ? start : bookingStart;
            const effectiveEnd = bookingEnd > end ? end : bookingEnd;
            
            let nightsInPeriod = 0;
            let currentDate = new Date(effectiveStart);
            while (currentDate < effectiveEnd && currentDate <= end) {
                nightsInPeriod++;
                currentDate.setUTCDate(currentDate.getUTCDate() + 1);
            }
            
            if (!channelStats.has(channel)) {
                channelStats.set(channel, { revenue: 0, nights: 0 });
            }
            
            const stats = channelStats.get(channel);
            stats.revenue += pricePerNight * nightsInPeriod;
            stats.nights += nightsInPeriod;
        });

        // 5. Grouper les réservations par canal pour la période précédente
        const prevChannelStats = new Map();

        prevBookings.forEach(booking => {
            const channel = booking.channel || booking.source || 'Unknown';
            const pricePerNight = booking.price_per_night || 
                (booking.revenue ? booking.revenue / Math.ceil((new Date(booking.end_date) - new Date(booking.start_date)) / (1000 * 60 * 60 * 24)) : 0);
            
            const bookingStart = new Date(booking.start_date + 'T00:00:00Z');
            const bookingEnd = new Date(booking.end_date + 'T00:00:00Z');
            
            const effectiveStart = bookingStart < prevStart ? prevStart : bookingStart;
            const effectiveEnd = bookingEnd > prevEnd ? prevEnd : bookingEnd;
            
            let nightsInPeriod = 0;
            let currentDate = new Date(effectiveStart);
            while (currentDate < effectiveEnd && currentDate <= prevEnd) {
                nightsInPeriod++;
                currentDate.setUTCDate(currentDate.getUTCDate() + 1);
            }
            
            if (!prevChannelStats.has(channel)) {
                prevChannelStats.set(channel, { revenue: 0, nights: 0 });
            }
            
            const stats = prevChannelStats.get(channel);
            stats.revenue += pricePerNight * nightsInPeriod;
            stats.nights += nightsInPeriod;
        });

        // 6. Calculer l'ADR pour chaque canal et les variations
        const labels = [];
        const data = [];
        const variations = [];

        // Trier les canaux par ADR décroissant
        const sortedChannels = Array.from(channelStats.entries())
            .map(([channel, stats]) => {
                const adr = stats.nights > 0 ? stats.revenue / stats.nights : 0;
                return { channel, adr, stats };
            })
            .sort((a, b) => b.adr - a.adr);

        sortedChannels.forEach(({ channel, adr, stats }) => {
            labels.push(channel);
            data.push(Math.round(adr));

            // Calculer la variation vs période précédente
            const prevStats = prevChannelStats.get(channel);
            const prevAdr = prevStats && prevStats.nights > 0 ? prevStats.revenue / prevStats.nights : 0;
            
            let variation = 0;
            if (prevAdr > 0) {
                variation = ((adr - prevAdr) / prevAdr) * 100;
            } else if (adr > 0) {
                variation = 100; // Nouveau canal ou augmentation significative
            }
            
            variations.push(parseFloat(variation.toFixed(1)));
        });

        res.status(200).json({
            labels: labels,
            data: data,
            variations: variations,
            metadata: {
                currentPeriod: { startDate, endDate },
                previousPeriod: { startDate: prevStartDate, endDate: prevEndDate },
                totalChannels: labels.length
            }
        });

    } catch (error) {
        console.error('Erreur lors du calcul de l\'ADR par canal:', error);
        res.status(500).send({ error: 'Erreur serveur lors du calcul de l\'ADR par canal.' });
    }
});

// PUT /api/users/revenue-targets
app.put('/api/users/revenue-targets', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const { revenueTargets } = req.body;

        if (!revenueTargets || typeof revenueTargets !== 'object') {
            return res.status(400).send({ error: 'Les objectifs de revenus doivent être un objet JSON valide.' });
        }

        // Valider le format : { "2025-01": 20000, "2025-02": 25000, ... }
        const validKeys = Object.keys(revenueTargets).every(key => {
            // Format attendu : YYYY-MM
            const monthPattern = /^\d{4}-\d{2}$/;
            if (!monthPattern.test(key)) {
                return false;
            }
            // Vérifier que la valeur est un nombre positif
            const value = revenueTargets[key];
            return typeof value === 'number' && value >= 0 && !isNaN(value);
        });

        if (!validKeys) {
            return res.status(400).send({ 
                error: 'Format invalide. Les clés doivent être au format YYYY-MM (ex: "2025-01") et les valeurs doivent être des nombres positifs.' 
            });
        }

        // Récupérer le profil utilisateur actuel
        const userProfile = await db.getUser(userId);
        if (!userProfile) {
            return res.status(404).send({ error: 'Utilisateur non trouvé.' });
        }

        // Mettre à jour les objectifs de revenus
        await db.updateUser(userId, {
            revenue_targets: revenueTargets
        });

        res.status(200).json({
            message: 'Objectifs de revenus mis à jour avec succès.',
            revenueTargets: revenueTargets
        });

    } catch (error) {
        console.error('Erreur lors de la mise à jour des objectifs de revenus:', error);
        res.status(500).send({ error: 'Erreur serveur lors de la mise à jour des objectifs de revenus.' });
    }
});

// POST /api/reports/analyze-date
app.post('/api/reports/analyze-date', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const { propertyId, date } = req.body;

        if (!propertyId || !date) {
            return res.status(400).send({ error: 'Un ID de propriété et une date (YYYY-MM-DD) sont requis.' });
        }

        // 1. Vérifier la propriété et les droits
        const property = await db.getProperty(propertyId);
        if (!property) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }
        
        const userProfile = await db.getUser(userId);
        if (!userProfile) {
            return res.status(404).send({ error: 'Profil utilisateur non trouvé.' });
        }
        
        const propertyTeamId = property.team_id || property.owner_id; 
        if (userProfile.team_id !== propertyTeamId) { 
             return res.status(403).send({ error: 'Action non autorisée sur cette propriété.' });
        }
        
        const location = property.location || 'France';
        const city = location.split(',')[0].trim();
        const capacity = property.capacity || 2;
        
        // Récupérer la langue de l'utilisateur
        const language = req.query.language || userProfile?.language || 'fr';
        const isFrench = language === 'fr' || language === 'fr-FR';

        // 2. Construire le prompt pour ChatGPT
        const prompt = isFrench ? `
            Tu es un analyste de marché expert pour la location saisonnière.
            Analyse la demande du marché pour la date spécifique: **${date}**
            dans la ville de: **${city}**
            pour un logement de type "${property.property_type || 'appartement'}" pouvant accueillir **${capacity} personnes**.

            Utilise l'outil de recherche Google pour trouver:
            1.  Les événements locaux (concerts, salons, matchs, vacances scolaires, jours fériés) ayant lieu à cette date ou ce week-end là.
            2.  Une estimation de la demande du marché (ex: "Faible", "Moyenne", "Élevée", "Très Élevée").
            3.  Une suggestion de fourchette de prix pour une nuit à cette date, basée sur le marché (ex: "120€ - 140€").

            Réponds UNIQUEMENT avec un objet JSON valide en français (pas de texte avant ou après, pas de markdown \`\`\`json).
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
        ` : `
            You are an expert market analyst for seasonal rentals.
            Analyze market demand for the specific date: **${date}**
            in the city of: **${city}**
            for a "${property.property_type || property.propertyType || 'apartment'}" type accommodation that can accommodate **${capacity} people**.

            Use the Google search tool to find:
            1.  Local events (concerts, trade shows, matches, school holidays, public holidays) taking place on this date or that weekend.
            2.  A market demand estimate (e.g., "Low", "Medium", "High", "Very High").
            3.  A price range suggestion for one night on this date, based on the market (e.g., "€120 - €140").

            Respond ONLY with a valid JSON object in English (no text before or after, no markdown \`\`\`json).
            The format should be:
            {
              "marketDemand": "...",
              "events": [
                "Event 1 (if found)",
                "Event 2 (if found)"
              ],
              "priceSuggestion": "...",
              "analysisSummary": "Short phrase summarizing why demand is what it is."
            }
        `;

        // 3. Appeler Perplexity/ChatGPT avec recherche web
        const analysisResult = await callGeminiWithSearch(prompt, 10, language);

        if (!analysisResult || !analysisResult.marketDemand) {
            // Renvoyer un objet JSON d'erreur contrôlée au lieu de planter
            return res.status(503).send({ error: "L'analyse IA n'a pas pu générer de réponse valide." });
        }

        // 4. Renvoyer le résultat
        res.status(200).json(analysisResult);

    } catch (error) {
        console.error(`Erreur lors de l'analyse de la date ${req.body.date}:`, error);
         if (error.message.includes('403') || error.message.includes('API key not valid')) {
             res.status(500).send({ error: "L'API de recherche (Perplexity/ChatGPT) n'est pas correctement configurée." });
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
        const userId = req.user.uid;

        // 1. Trouver le teamId de l'utilisateur
        const { teamId, userProfile } = await getOrInitializeTeamId(userId);

        // 2. Récupérer toutes les propriétés de l'équipe
        const properties = await db.getPropertiesByTeam(teamId);
        if (!properties || properties.length === 0) {
            return res.status(200).json([]); // Pas de propriétés, pas de recommandations
        }

        // 3. Récupérer tous les groupes et les propriétés déjà groupées
        const groups = await db.getGroupsByOwner(userId);
        const groupedPropertyIds = new Set();
        groups.forEach(group => {
            const propertiesInGroup = group.properties || [];
            propertiesInGroup.forEach(prop => {
                const propId = typeof prop === 'string' ? prop : (prop.id || prop.property_id);
                if (propId) {
                    groupedPropertyIds.add(propId);
                }
            });
        });

        // 4. Filtrer les propriétés qui ne sont dans AUCUN groupe
        const ungroupedProperties = properties.filter(prop => !groupedPropertyIds.has(prop.id));

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
 * Fonction helper pour appeler l'API ChatGPT avec retry et backoff exponentiel
 * @param {string} prompt - Le prompt à envoyer à l'IA
 * @param {number} maxRetries - Nombre maximum de tentatives
 * @param {string} language - Langue de sortie souhaitée (ex: 'fr', 'en', 'es'). Par défaut 'fr'
 */
async function callGeminiAPI(prompt, maxRetries = 10, language = 'fr') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        console.error("OPENAI_API_KEY non trouvée dans .env");
        throw new Error("Clé API OpenAI non configurée sur le serveur.");
    }
    
    const openai = new OpenAI({ apiKey });
    
    // Déterminer la langue de sortie
    const isFrench = language === 'fr' || language === 'fr-FR';
    const languageInstruction = isFrench 
        ? "IMPORTANT: Réponds UNIQUEMENT en français. Tous les textes, labels, et descriptions doivent être en français."
        : `IMPORTANT: Respond ONLY in ${language === 'en' || language === 'en-US' ? 'English' : language}. All texts, labels, and descriptions must be in ${language === 'en' || language === 'en-US' ? 'English' : language}.`;
    
    // Ajouter l'instruction de langue au prompt
    const enhancedPrompt = `${prompt}\n\n${languageInstruction}`;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: [
                    {
                        role: "user",
                        content: enhancedPrompt
                    }
                ],
                response_format: { type: "json_object" },
                temperature: 0.7
            });

            const textPart = response.choices[0]?.message?.content;

            // Extraire les informations de tokens
            if (response.usage) {
                const inputTokens = response.usage.prompt_tokens || 0;
                const outputTokens = response.usage.completion_tokens || 0;
                const totalTokens = response.usage.total_tokens || (inputTokens + outputTokens);
                console.log(`[ChatGPT Tokens] Entrée: ${inputTokens}, Sortie: ${outputTokens}, Total: ${totalTokens}`);
            }

            if (textPart) {
                try {
                    return JSON.parse(textPart);
                } catch (parseError) {
                    console.error("Erreur de parsing JSON de la réponse ChatGPT:", textPart);
                    throw new Error("Réponse de l'API ChatGPT reçue mais n'est pas un JSON valide.");
                }
            } else {
                console.error("Réponse ChatGPT inattendue:", response);
                throw new Error("Réponse de l'API ChatGPT malformée ou vide.");
            }
        } catch (error) {
            // Gérer les erreurs de rate limit (429)
            if (error.status === 429 || (error.response && error.response.status === 429)) {
                const waitTime = Math.min(Math.pow(2, attempt - 1) * 1000, 60000);
                console.warn(`Tentative ${attempt}/${maxRetries}: API ChatGPT surchargée (429). Nouvel essai dans ${waitTime / 1000} seconde(s)...`);
                if (attempt < maxRetries) {
                    await delay(waitTime);
                    continue;
                }
            }
            
            if (attempt === maxRetries) {
                console.error(`Erreur API ChatGPT (Tentative ${attempt}):`, error.message);
                throw new Error(`Erreur de l'API ChatGPT: ${error.message || 'Erreur inconnue'}`);
            }
            
            console.error(`Erreur lors de la tentative ${attempt} d'appel à ChatGPT:`, error.message);
            // Backoff exponentiel: 2^(attempt-1) secondes, avec un maximum de 60 secondes
            const waitTime = Math.min(Math.pow(2, attempt - 1) * 1000, 60000);
            console.log(`Nouvelle tentative dans ${waitTime / 1000} seconde(s)...`);
            await delay(waitTime);
        }
    }
    throw new Error(`Échec de l'appel à l'API ChatGPT après ${maxRetries} tentatives.`);
}

/**
 * Fonction helper pour appeler l'API Perplexity avec recherche web en temps réel
 * Utilise Perplexity Sonar API qui est compatible avec OpenAI et permet les recherches web
 * @param {string} prompt - Le prompt à envoyer à l'IA
 * @param {number} maxRetries - Nombre maximum de tentatives
 * @param {string} language - Langue de sortie souhaitée (ex: 'fr', 'en', 'es'). Par défaut 'fr'
 */
async function callGeminiWithSearch(prompt, maxRetries = 10, language = 'fr') {
    // Utiliser Perplexity si la clé est configurée, sinon fallback sur OpenAI
    const perplexityApiKey = process.env.PERPLEXITY_API_KEY;
    const openaiApiKey = process.env.OPENAI_API_KEY;
    
    if (!perplexityApiKey && !openaiApiKey) {
        throw new Error("Aucune clé API configurée. Veuillez configurer PERPLEXITY_API_KEY ou OPENAI_API_KEY.");
    }
    
    // Préférer Perplexity pour les recherches en temps réel
    const usePerplexity = !!perplexityApiKey;
    const apiKey = usePerplexity ? perplexityApiKey : openaiApiKey;
    
    const openai = usePerplexity 
        ? new OpenAI({ 
            apiKey, 
            baseURL: "https://api.perplexity.ai" 
          })
        : new OpenAI({ apiKey });
    
    // Déterminer la langue de sortie
    const isFrench = language === 'fr' || language === 'fr-FR';
    const targetLanguage = isFrench ? 'français' : (language === 'en' || language === 'en-US' ? 'anglais' : language);
    
    // Instruction de langue renforcée pour Perplexity (qui fait des recherches web)
    const languageInstruction = isFrench 
        ? "CRITIQUE: Réponds UNIQUEMENT en français, même si les sources trouvées sont dans d'autres langues. Tous les textes, titres, résumés, labels, catégories, et descriptions DOIVENT être en français. Traduis toutes les informations trouvées en français."
        : `CRITICAL: Respond ONLY in ${language === 'en' || language === 'en-US' ? 'English' : language}, even if the sources found are in other languages. All texts, titles, summaries, labels, categories, and descriptions MUST be in ${language === 'en' || language === 'en-US' ? 'English' : language}. Translate all found information to ${language === 'en' || language === 'en-US' ? 'English' : language}.`;
    
    // Instruction JSON pour Perplexity (qui ne supporte pas response_format comme OpenAI)
    const jsonInstruction = isFrench
        ? "IMPORTANT: Réponds UNIQUEMENT avec un JSON valide, sans texte avant ou après, sans markdown ```json, et SANS citations numérotées comme [1] ou [2]. Le format doit être un objet JSON ou un tableau JSON valide, sans références de sources dans le contenu."
        : "IMPORTANT: Respond ONLY with valid JSON, no text before or after, no markdown ```json, and NO numbered citations like [1] or [2]. The format must be a valid JSON object or JSON array, without source references in the content.";
    
    // Instruction spécifique pour Perplexity avec recherche web
    const perplexitySearchInstruction = isFrench
        ? "Note: Tu fais des recherches web en temps réel. Peu importe la langue des sources trouvées, tu DOIS répondre en français. Traduis tous les contenus (titres, résumés, etc.) en français. NE PAS inclure de citations numérotées [1], [2], etc. dans le JSON - supprime-les complètement du contenu."
        : `Note: You are doing real-time web searches. Regardless of the language of the sources found, you MUST respond in ${language === 'en' || language === 'en-US' ? 'English' : language}. Translate all content (titles, summaries, etc.) to ${language === 'en' || language === 'en-US' ? 'English' : language}. DO NOT include numbered citations [1], [2], etc. in the JSON - remove them completely from the content.`;
    
    // Ajouter les instructions selon l'API utilisée
    const enhancedPrompt = usePerplexity
        ? `${prompt}\n\n${languageInstruction}\n\n${perplexitySearchInstruction}\n\n${jsonInstruction}`
        : `${prompt}\n\n${languageInstruction}`;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const requestParams = {
                model: usePerplexity ? "sonar-pro" : "gpt-4o",
                messages: [
                    {
                        role: "user",
                        content: enhancedPrompt
                    }
                ],
                temperature: 0.7
            };
            
            // Paramètres spécifiques à Perplexity pour les recherches récentes
            if (usePerplexity) {
                requestParams.search_recency_filter = "week"; // Rechercher dans les 7 derniers jours
                requestParams.search_mode = "web"; // Mode recherche web
                // Perplexity ne supporte pas response_format, on utilise l'instruction JSON dans le prompt
            } else {
                // OpenAI supporte response_format pour forcer le JSON
                requestParams.response_format = { type: "json_object" };
            }
            
            const response = await openai.chat.completions.create(requestParams);

            const textPart = response.choices[0]?.message?.content;
            
            // Extraire les informations de tokens
            if (response.usage) {
                const inputTokens = response.usage.prompt_tokens || 0;
                const outputTokens = response.usage.completion_tokens || 0;
                const totalTokens = response.usage.total_tokens || (inputTokens + outputTokens);
                const apiName = usePerplexity ? "Perplexity" : "ChatGPT";
                console.log(`[${apiName} Tokens (Search)] Entrée: ${inputTokens}, Sortie: ${outputTokens}, Total: ${totalTokens}`);
                
                // Afficher les sources si disponibles (Perplexity)
                if (usePerplexity && response.search_results) {
                    console.log(`[Perplexity] ${response.search_results.length} sources trouvées`);
                }
            }
            
            if (textPart) {
                try {
                    let cleanText = textPart.replace(/^```json\n?/, '').replace(/\n?```$/, '');
                    
                    // Nettoyer les citations de Perplexity (ex: [1], [2], etc.) qui peuvent apparaître
                    if (usePerplexity) {
                        // Supprimer les références numérotées à la fin (ex: [1][2] ou [1] [2])
                        cleanText = cleanText.replace(/\s*\[\d+\](\s*\[\d+\])*\s*$/g, '');
                        // Supprimer les références dans les chaînes JSON (dans les valeurs)
                        // On fait cela après le parsing pour éviter de casser le JSON
                    }
                    
                    const apiName = usePerplexity ? "Perplexity" : "ChatGPT";
                    console.log(`Texte JSON nettoyé reçu de ${apiName} (Search):`, cleanText); // Log pour débogage
                    const parsedData = JSON.parse(cleanText);
                    
                    // Nettoyer les citations dans les données parsées pour Perplexity
                    if (usePerplexity && parsedData) {
                        const cleanCitations = (obj) => {
                            if (Array.isArray(obj)) {
                                return obj.map(cleanCitations);
                            } else if (obj && typeof obj === 'object') {
                                const cleaned = {};
                                for (const [key, value] of Object.entries(obj)) {
                                    if (typeof value === 'string') {
                                        // Supprimer les citations [1], [2], etc. dans les chaînes
                                        cleaned[key] = value.replace(/\s*\[\d+\](\s*\[\d+\])*\s*/g, ' ').trim();
                                    } else {
                                        cleaned[key] = cleanCitations(value);
                                    }
                                }
                                return cleaned;
                            }
                            return obj;
                        };
                        return cleanCitations(parsedData);
                    }
                    
                    return parsedData; 
                } catch (parseError) {
                    const apiName = usePerplexity ? "Perplexity" : "ChatGPT";
                    console.error(`Erreur de parsing JSON de la réponse ${apiName} (Search):`, textPart);
                    throw new Error(`Réponse de l'API ${apiName} (Search) reçue mais n'est pas un JSON valide.`);
                }
            } else {
                const apiName = usePerplexity ? "Perplexity" : "ChatGPT";
                console.error(`Réponse ${apiName} (Search) inattendue:`, response);
                throw new Error(`Réponse de l'API ${apiName} (Search) malformée ou vide.`);
            }
        } catch (error) {
            const apiName = usePerplexity ? "Perplexity" : "ChatGPT";
            
            // Extraire le statut HTTP de l'erreur
            const errorStatus = error.status || error.response?.status || error.statusCode;
            // Essayer plusieurs façons d'extraire le message d'erreur
            let errorMessage = error.message || error.toString() || String(error) || '';
            // Si l'erreur est directement une string (peut arriver avec certains SDK)
            if (typeof error === 'string') {
                errorMessage = error;
            }
            
            // Debug : logger l'erreur complète pour les erreurs suspectes
            if (attempt === 1 || errorMessage.includes('401') || errorMessage.includes('<html>')) {
                console.error(`[DEBUG ${apiName}] Type d'erreur:`, typeof error);
                console.error(`[DEBUG ${apiName}] error.status:`, error.status);
                console.error(`[DEBUG ${apiName}] error.message (premiers 200 chars):`, errorMessage.substring(0, 200));
            }
            
            // Détecter si c'est une réponse HTML (comme les pages Cloudflare 401)
            const isHtmlResponse = typeof errorMessage === 'string' && 
                (errorMessage.includes('<html>') || errorMessage.includes('<title>') || 
                 errorMessage.includes('openresty') || errorMessage.includes('Cloudflare') ||
                 errorMessage.includes('<head>') || errorMessage.includes('Authorization Required'));
            
            // Détecter spécifiquement les erreurs 401 dans le message (même si errorStatus n'est pas défini)
            // DÉTECTION ULTRA-SIMPLIFIÉE : Si "401" est présent dans le message, c'est une 401
            const errorMsgStr = String(errorMessage);
            const has401InMessage = errorMsgStr.includes('401');
            const hasAuthRequired = errorMsgStr.toLowerCase().includes('authorization required');
            
            // Gérer les erreurs d'authentification (401) - ARRÊTER IMMÉDIATEMENT, ne pas retry
            // Si on voit "401" dans le message OU "Authorization Required", c'est une 401 - POINT FINAL
            // Plus de conditions complexes - si "401" est là, on arrête
            if (errorStatus === 401 || has401InMessage || hasAuthRequired) {
                const authErrorMsg = usePerplexity
                    ? `ERREUR D'AUTHENTIFICATION PERPLEXITY (401): La clé API PERPLEXITY_API_KEY est invalide, manquante ou expirée. Vérifiez votre fichier .env et votre compte Perplexity.`
                    : `ERREUR D'AUTHENTIFICATION OPENAI (401): La clé API OPENAI_API_KEY est invalide, manquante ou expirée. Vérifiez votre fichier .env et votre compte OpenAI.`;
                
                console.error(`[${apiName} (Search)] ${authErrorMsg}`);
                if (isHtmlResponse) {
                    console.error(`[${apiName} (Search)] Réponse HTML 401 détectée - blocage d'authentification. Arrêt immédiat des tentatives.`);
                    // Logger un extrait du HTML pour debug
                    const htmlPreview = errorMessage.substring(0, 300).replace(/\n/g, ' ');
                    console.error(`[${apiName} (Search)] Extrait de la réponse: ${htmlPreview}...`);
                }
                // Arrêter immédiatement - ne pas faire de retry
                throw new Error(authErrorMsg);
            }
            
            // Gérer les erreurs de rate limit (429)
            if (errorStatus === 429) {
                const waitTime = Math.min(Math.pow(2, attempt - 1) * 1000, 60000);
                console.warn(`Tentative ${attempt}/${maxRetries}: API ${apiName} (Search) surchargée (429). Nouvel essai dans ${waitTime / 1000} seconde(s)...`);
                if (attempt < maxRetries) {
                    await delay(waitTime);
                    continue;
                }
            }
            
            // Ne pas retry sur les erreurs 4xx (sauf 429) - erreurs client
            if (errorStatus && errorStatus >= 400 && errorStatus < 500 && errorStatus !== 429) {
                const clientErrorMsg = `Erreur client ${apiName} (${errorStatus}): ${isHtmlResponse ? 'Réponse HTML reçue (possible blocage ou clé API invalide)' : errorMessage}`;
                console.error(`[${apiName} (Search)] ${clientErrorMsg}`);
                throw new Error(clientErrorMsg);
            }
            
            if (attempt === maxRetries) {
                console.error(`Erreur API ${apiName} (Search) (Tentative ${attempt}):`, errorMessage.substring(0, 200));
                throw new Error(`Échec de l'appel à l'API ${apiName} (Search) après ${maxRetries} tentatives. ${isHtmlResponse ? 'Réponse HTML reçue au lieu de JSON.' : errorMessage.substring(0, 200)}`);
            }
            
            // Pour les autres erreurs (5xx, réseau, etc.), retry avec backoff
            console.error(`Erreur (Search) Tentative ${attempt}:`, errorMessage.substring(0, 200));
            if (isHtmlResponse) {
                console.error(`[${apiName} (Search)] Réponse HTML détectée - possible problème d'authentification ou blocage.`);
            }
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
        const { id } = req.params;
        const userId = req.user.uid;
        const { useMarketData = 'true', useAI = 'hybrid' } = req.query; // Nouveaux paramètres

        const property = await db.getProperty(id);
        if (!property) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }
        
        const userProfile = await db.getUser(userId);
        if (!userProfile) {
            return res.status(404).send({ error: 'Profil utilisateur non trouvé.' });
        }
        
        const propertyTeamId = property.team_id || property.owner_id; 
        if (userProfile.team_id !== propertyTeamId) { 
             return res.status(403).send({ error: 'Action non autorisée sur cette propriété (pas dans la bonne équipe).' });
        }
        
        const today = new Date().toISOString().split('T')[0];
        
        // Récupérer la langue de l'utilisateur
        const language = req.query.language || userProfile?.language || 'fr';
        
        // Extraire city et country depuis property.location
        const location = property.location || '';
        const city = location.split(',')[0].trim() || '';
        const country = property.country || 'FR';
        
        // Essayer d'abord le pricing déterministe basé sur market_features
        const shouldUseMarketData = useMarketData === 'true' || useMarketData === true;
        let strategyResult = null; // Déclarer en dehors pour être accessible partout
        
        if (shouldUseMarketData && city) {
            try {
                const deterministicPricing = require('./utils/deterministic_pricing');
                
                // Date range: aujourd'hui + 180 jours
                const endDate = new Date();
                endDate.setDate(endDate.getDate() + 180);
                const endDateStr = endDate.toISOString().split('T')[0];
                
                console.log(`[Pricing] Utilisation du pricing déterministe pour ${city}, ${country} (${today} à ${endDateStr})`);
                
                const calendar = await deterministicPricing.generateDeterministicPricingCalendar({
                    property,
                    startDate: today,
                    endDate: endDateStr,
                    city,
                    country
                });
                
                if (calendar && calendar.length > 0) {
                    console.log(`[Pricing] ✓ Pricing déterministe généré: ${calendar.length} jours`);
                    
                    // Convertir au format attendu
                    const daily_prices = calendar.map(day => ({
                        date: day.date,
                        price: day.price,
                        reason: day.reasoning || "Tarification basée sur données marché"
                    }));
                    
                    strategyResult = {
                        strategy_summary: `Tarification déterministe basée sur ${calendar.filter(d => d.market_data_used?.competitor_avg_price).length}/${calendar.length} jours de données marché`,
                        daily_prices,
                        method: 'deterministic',
                        raw: {
                            calendar: calendar.map(day => ({
                                date: day.date,
                                final_suggested_price: day.price,
                                price_breakdown: day.breakdown,
                                reasoning: day.reasoning,
                                market_data_used: day.market_data_used
                            }))
                        }
                    };
                    
                    // Pricing déterministe réussi, on skip l'IA et on continue avec la sauvegarde
                    console.log(`[Pricing] ✓ Pricing déterministe réussi, skip de l'IA`);
                }
            } catch (marketDataError) {
                console.error(`[Pricing] Erreur pricing déterministe, fallback sur IA:`, marketDataError);
                // Continuer avec l'IA comme fallback
                strategyResult = null; // S'assurer qu'on n'utilise pas un résultat partiel
            }
        }

        // Si pas de stratégie déterministe, utiliser l'IA
        if (!strategyResult) {
            console.log(`[Pricing] Utilisation de l'IA pour générer les prix`);
            
            // Nouveau prompt : moteur de tarification intelligente (Revenue Management complet)
            const prompt = `
### RÔLE DU SYSTÈME : MOTEUR DE TARIFICATION INTELLIGENTE 

Tu es l'IA centrale d'un système de Revenue Management (Yield Management) comparable aux leaders mondiaux (PriceLabs, Wheelhouse, Beyond). Ta capacité d'analyse dépasse celle d'un humain : tu croises des millions de signaux faibles pour déterminer le "Prix Juste" (Fair Price) à l'instant T.

PARAMÈTRES DE LA MISSION :

- **Lieu :** ${property.location}
- **Date d'exécution :** ${today}
- **Horizon :** 180 jours
- **Objectif :** Maximisation du RevPAR (Revenu par chambre disponible) + Taux de Conversion.

---

### PARTIE 1 : INGESTION PROFONDE DU CONTEXTE (INPUTS)

**1. PROFILAGE DE L'ACTIF (PROPERTY SCORING)**

Analyse la valeur perçue de ce bien spécifique par rapport au marché local :

${JSON.stringify({
    address: property.address,
    type: property.property_type,
    capacity: property.capacity,
    surface: property.surface,
    amenities: property.amenities || [],
    listing_quality_assessment:
      "AUTO-ÉVALUATION REQUISE : Détermine si ce bien est 'Économique', 'Standard', 'Premium' ou 'Luxe' en fonction des équipements (Piscine ? Vue ? AC ?) et de la surface vs capacité."
  }, null, 2)}

**2. RÈGLES FINANCIÈRES INVIOLABLES (HARD CONSTRAINTS)**

Ces bornes sont des "Kill Switches". Si ton calcul théorique les dépasse, tu dois couper.

- **Floor Price (Plancher Absolu):** ${property.floor_price} € (Ligne de survie).
- **Base Price (Pivot):** ${property.base_price} € (Prix de référence neutre).
- **Ceiling Price (Plafond):** ${property.ceiling_price || property.base_price * 4} € (Sécurité anti-aberration).
- **Min Stay:** ${property.min_stay || 1} nuits.
- **Réductions:** Semaine -${property.weekly_discount_percent || 0}%, Mois -${property.monthly_discount_percent || 0}%.
- **Majoration Week-end:** Ven/Sam +${property.weekend_markup_percent || 0}%.

**3. STRATÉGIE UTILISATEUR : [ ${property.strategy || 'Équilibré'} ]**

Tu dois moduler ton agressivité selon ce profil :

* **PRUDENT :** "Occupation First". Tu préfères louer à -15% que de rester vide. Tu es très réactif à la baisse en dernière minute (Last Minute).
* **ÉQUILIBRÉ :** "Market Follower". Tu cherches le ratio parfait. Tu ne prends pas de risques inutiles.
* **AGRESSIF :** "Yield First". Tu vises l'ADR (Prix Moyen) maximum. Tu ne brades pas. Tu sais que ton bien est unique et tu le fais payer. Tu acceptes d'avoir des jours vides pour vendre très cher les jours pleins.

---

### PARTIE 2 : LE "PIPELINE" DE CALCUL (8 ÉTAPES OBLIGATOIRES)

Pour **CHAQUE JOUR** du calendrier, tu dois exécuter mentalement cette séquence précise. Ne saute aucune étape.

**ÉTAPE 1 : ANALYSE MACRO-ÉCONOMIQUE & TENDANCES (MARKET HEALTH)**

* Prends en compte l'inflation actuelle en zone Euro/Locale.
* Analyse la "Force de la destination" : Est-ce que ${property.location} est "tendance" cette année ? (Basé sur tes données d'entraînement).
* *Impact :* Ajuste le Prix de Base global de +/- 5% selon la santé économique du tourisme.

**ÉTAPE 2 : COURBE DE SAISONNALITÉ HYPER-LOCALE (SEASONAL WAVE)**

* Ne fais pas juste "Été vs Hiver". Fais une analyse mois par mois fine.
* Identifie les "Saisons d'épaule" (Shoulder Seasons) où les opportunités sont les meilleures.
* *Calcul :* Applique un coefficient multiplicateur (ex: x0.6 en Janvier, x1.8 en Août).

**ÉTAPE 3 : JOUR DE LA SEMAINE (DOW - DAY OF WEEK)**

* Analyse la typologie de la ville :
    * Ville Affaires ? (Mardi/Mercredi chers, Week-end moins cher).
    * Ville Loisirs ? (Vendredi/Samedi explosifs, Dimanche modéré).
* *Action :* Applique la majoration week-end définie, ou ajuste selon la logique locale.

**ÉTAPE 4 : INTELLIGENCE ÉVÉNEMENTIELLE (DEMAND SPIKES)**

* Effectue une recherche approfondie des événements à ${property.location} sur les 180 jours :
    * Vacances Scolaires (Toutes zones + Pays limitrophes).
    * Jours Fériés et "Ponts" (Gaps entre férié et week-end).
    * Événements "Tier 1" : Grands concerts, Festivals, Compétitions sportives, Foires commerciales majeures.
* *Règle :* Si un Événement Tier 1 est détecté -> Ignore le "Prix Plafond" habituel (sauf si contrainte stricte) et passe en mode "Yield Maximization" (x2 à x4 le prix de base).

**ÉTAPE 5 : PRESSION CONCURRENTIELLE SIMULÉE (COMPSET)**

* Simule le comportement de 10 concurrents directs.
* Si la date est dans < 14 jours et que la demande est faible : Tes concurrents vont baisser. Tu dois anticiper.
* Si la date est très demandée : Tes concurrents sont déjà pleins (Sold Out). Tu es le dernier choix, tu as le "Pricing Power". Augmente le prix.

**ÉTAPE 6 : FACTEUR TEMPOREL (BOOKING WINDOW / LEAD TIME)**

* **Far Out (90j+) :** Ajoute une prime (+10%). Les gens qui réservent tôt sont moins sensibles au prix ou cherchent la sécurité.
* **Mid Range (21-90j) :** Prix de marché ("Fair Price").
* **Close In (0-21j) :**
    * Si Stratégie = Prudent : Baisse progressive (jusqu'au Floor Price).
    * Si Stratégie = Agressif : Maintien du prix (on ne dévalorise pas le bien).

**ÉTAPE 7 : GESTION DES JOURS ISOLÉS (ORPHAN DAYS LOGIC)**

* *Concept :* Bien que tu génères un calendrier neuf, simule cette logique : Si un mardi est isolé entre deux dates à forte probabilité de réservation (ex: Lundi férié et Mercredi business), baisse son prix pour inciter à combler le trou, ou augmente-le si c'est une date "pivot".

**ÉTAPE 8 : PSYCHOLOGIE DES PRIX (CHARM PRICING)**

* Nettoyage final du chiffre.
* JAMAIS de centimes.
* Évite les chiffres ronds "trop parfaits" comme 100€ (ça fait amateur). Préfère 99€ ou 105€.
* Règles : Terminaisons en 5, 9, ou 0.
* *Cohérence (Smoothing) :* Vérifie que le prix du jour J n'est pas > 50% plus cher que J-1 sans raison majeure (événement). Lisse la courbe.

---

### PARTIE 3 : FORMAT DE SORTIE (JSON ULTRA-RICHE)

Tu dois répondre UNIQUEMENT par un JSON valide. Ce JSON servira à alimenter un Dashboard professionnel.

Structure attendue :

{
  "audit_metadata": {
    "generated_at": "${today}",
    "property_grade": "Luxe/Standard/Éco",
    "market_sentiment": "Bullish (Hausier) ou Bearish (Baissier) - Courte explication.",
    "top_demand_drivers": ["Liste des 3 événements majeurs identifiés"],
    "strategy_active": "${property.strategy || 'Équilibré'}"
  },
  "calendar": [
    {
      "date": "YYYY-MM-DD",
      "weekday": "String",
      "final_suggested_price": 0,
      "currency": "EUR",
      "price_breakdown": {
        "base": ${property.base_price},
        "seasonality_impact": "+0%",
        "event_impact": "+0%",
        "lead_time_impact": "+0%"
      },
      "demand_score": 0,
      "competition_status": "High/Medium/Low (Pression concurrentielle)",
      "tags": [],
      "reasoning": "Phrase concise mais technique expliquant le prix."
    }
    // ... Répéter pour les 180 jours, en produisant des objets complets et cohérents
  ]
}

RAPPEL CRITIQUE : La réponse finale doit être UNIQUEMENT ce JSON, sans texte additionnel, sans commentaires, sans markdown.
            `;

            let iaResult;
            try {
                iaResult = await callGeminiWithSearch(prompt, 10, language);
            } catch (iaError) {
                console.error(`[Pricing] Erreur lors de l'appel IA:`, iaError.message);
                // Si l'IA échoue (refuse de générer du JSON), utiliser le pricing déterministe comme fallback
                console.log(`[Pricing] L'IA a refusé de générer du JSON. Utilisation du pricing déterministe comme fallback...`);
                
                // Essayer de générer un calendrier avec le pricing déterministe
                try {
                    const deterministicPricing = require('./utils/deterministic_pricing');
                    const endDate = new Date();
                    endDate.setDate(endDate.getDate() + 180);
                    const endDateStr = endDate.toISOString().split('T')[0];
                    
                    const calendar = await deterministicPricing.generateDeterministicPricingCalendar({
                        property,
                        startDate: today,
                        endDate: endDateStr,
                        city,
                        country
                    });
                    
                    if (calendar && calendar.length > 0) {
                        const daily_prices = calendar.map(day => ({
                            date: day.date,
                            price: day.price,
                            reason: day.reasoning || "Tarification basée sur données marché (fallback après échec IA)"
                        }));
                        
                        strategyResult = {
                            strategy_summary: `Tarification déterministe (fallback après échec IA) - ${calendar.filter(d => d.market_data_used?.competitor_avg_price).length}/${calendar.length} jours avec données marché`,
                            daily_prices,
                            method: 'deterministic',
                            raw: {
                                calendar: calendar.map(day => ({
                                    date: day.date,
                                    final_suggested_price: day.price,
                                    price_breakdown: day.breakdown,
                                    reasoning: day.reasoning,
                                    market_data_used: day.market_data_used
                                }))
                            }
                        };
                        console.log(`[Pricing] ✓ Pricing déterministe de secours généré: ${calendar.length} jours`);
                        // Skip le reste du traitement IA
                        iaResult = null;
                    } else {
                        throw new Error("L'IA a échoué et le pricing déterministe n'a pas pu générer de calendrier.");
                    }
                } catch (fallbackError) {
                    console.error(`[Pricing] Erreur pricing déterministe de secours:`, fallbackError);
                    throw new Error(`Échec de l'IA (refus de générer du JSON) et du pricing déterministe. Veuillez vérifier vos données marché ou réessayer plus tard.`);
                }
            }

            // Si on a déjà un strategyResult du fallback, on skip le traitement IA
            if (!strategyResult && iaResult) {
                if (!iaResult || !Array.isArray(iaResult.calendar) || iaResult.calendar.length === 0) {
                    // Si l'IA a répondu mais sans JSON valide, utiliser le pricing déterministe
                    console.log(`[Pricing] Réponse IA invalide, utilisation du pricing déterministe comme fallback...`);
                    try {
                        const deterministicPricing = require('./utils/deterministic_pricing');
                        const endDate = new Date();
                        endDate.setDate(endDate.getDate() + 180);
                        const endDateStr = endDate.toISOString().split('T')[0];
                        
                        const calendar = await deterministicPricing.generateDeterministicPricingCalendar({
                            property,
                            startDate: today,
                            endDate: endDateStr,
                            city,
                            country
                        });
                        
                        if (calendar && calendar.length > 0) {
                            const daily_prices = calendar.map(day => ({
                                date: day.date,
                                price: day.price,
                                reason: day.reasoning || "Tarification basée sur données marché (fallback après réponse IA invalide)"
                            }));
                            
                            strategyResult = {
                                strategy_summary: `Tarification déterministe (fallback après réponse IA invalide) - ${calendar.filter(d => d.market_data_used?.competitor_avg_price).length}/${calendar.length} jours avec données marché`,
                                daily_prices,
                                method: 'deterministic',
                                raw: {
                                    calendar: calendar.map(day => ({
                                        date: day.date,
                                        final_suggested_price: day.price,
                                        price_breakdown: day.breakdown,
                                        reasoning: day.reasoning,
                                        market_data_used: day.market_data_used
                                    }))
                                }
                            };
                            console.log(`[Pricing] ✓ Pricing déterministe de secours généré: ${calendar.length} jours`);
                            iaResult = null; // Skip le reste
                        } else {
                            throw new Error("La réponse de l'IA est invalide et le pricing déterministe n'a pas pu générer de calendrier.");
                        }
                    } catch (fallbackError) {
                        throw new Error("La réponse de l'IA est invalide ou ne contient pas de calendrier de prix.");
                    }
                }

            // Adapter le nouveau format (calendar) en daily_prices pour le reste du backend
            const daily_prices = iaResult.calendar.map(day => {
                const rawPrice = day.final_suggested_price;
                let priceNum = Number(rawPrice);
                if (isNaN(priceNum)) {
                    priceNum = property.base_price;
                }
                return {
                    date: day.date,
                    price: priceNum,
                    reason: day.reasoning || "Tarification IA dynamique"
                };
            });

            strategyResult = {
                strategy_summary: iaResult.audit_metadata?.market_sentiment || "Stratégie IA dynamique générée.",
                daily_prices,
                method: 'ai',
                raw: iaResult
            };
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
                const allOverrides = await db.getPriceOverrides(id);
                const lockedDates = new Set();
                allOverrides.forEach(override => {
                    if (override.is_locked) {
                        lockedDates.add(override.date);
                    }
                });
                
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

        // Récupérer les prix verrouillés existants
        const floor = property.floor_price;
        const ceiling = property.ceiling_price;

        // Récupérer tous les price_overrides pour cette propriété pour trouver les prix verrouillés
        const allOverrides = await db.getPriceOverrides(id);
        const lockedPrices = new Map();
        allOverrides.forEach(override => {
            if (override.is_locked) {
                lockedPrices.set(override.date, override.price);
            }
        });
        console.log(`Trouvé ${lockedPrices.size} prix verrouillés pour ${id}. Ils ne seront pas modifiés.`);

        // Préparer les overrides à sauvegarder
        const overridesToSave = [];
        for (const day of strategyResult.daily_prices) {
            const priceNum = Number(day.price);
            if (isNaN(priceNum)) {
                console.warn(`Prix invalide reçu pour ${day.date}: ${day.price}. Utilisation du prix plancher.`);
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
            
            overridesToSave.push({
                date: day.date,
                price: finalPrice,
                reason: day.reason || (strategyResult.method === 'deterministic' ? "Tarification basée sur données marché" : "Stratégie IA"),
                isLocked: false,
                updatedBy: req.user.uid
            });
        }
        
        // Sauvegarder tous les overrides en une seule opération
        if (overridesToSave.length > 0) {
            await db.upsertPriceOverrides(id, overridesToSave);
            const methodLabel = strategyResult.method === 'deterministic' ? 'déterministe' : 'IA';
            console.log(`Stratégie ${methodLabel} sauvegardée pour ${id} (${overridesToSave.length} jours, en respectant les prix verrouillés).`);
        } else {
            console.log(`Aucun prix à sauvegarder pour ${id} (tous verrouillés ou invalides).`);
        }
        
        // Log de l'action
        const actionType = strategyResult.method === 'deterministic' ? 'update:deterministic-pricing' : 'update:ia-pricing';
        await logPropertyChange(id, req.user.uid, req.user.email, actionType, {
            summary: strategyResult.strategy_summary,
            days: overridesToSave.length,
            lockedPricesIgnored: lockedPrices.size,
            method: strategyResult.method || 'ai'
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
        const userId = req.user.uid;
        
        // Récupérer la langue : query param > profil utilisateur > français par défaut
        const userProfile = await db.getUser(userId);
        const language = req.query.language || userProfile?.language || 'fr';
        const forceRefresh = req.query.forceRefresh === 'true';
        
        const cacheKey = `marketNews_${language}`;
        const newsDoc = await db.getSystemCache(cacheKey);
        
        // Si forceRefresh est activé, régénérer le cache immédiatement
        if (forceRefresh) {
            console.log(`Régénération forcée du cache des actualités pour la langue ${language}...`);
            try {
                await updateMarketNewsCache(language);
                const refreshedNewsDoc = await db.getSystemCache(cacheKey);
                if (refreshedNewsDoc && refreshedNewsDoc.data) {
                    return res.status(200).json(refreshedNewsDoc.data);
                }
            } catch (refreshError) {
                console.error(`Erreur lors de la régénération forcée pour ${language}:`, refreshError);
                // Continuer avec le cache existant si la régénération échoue
            }
        }

        // Vérifier si le cache existe et est à jour (moins de 24h)
        const oneDay = 24 * 60 * 60 * 1000;
        let cacheIsValid = false;
        let cacheAge = null;
        
        if (newsDoc && newsDoc.data) {
            // Vérifier que le cache correspond à la langue demandée
            const cacheLanguage = newsDoc.language;
            if (cacheLanguage && cacheLanguage !== language) {
                console.log(`Cache trouvé pour une autre langue (${cacheLanguage} au lieu de ${language}), invalide.`);
            } else if (newsDoc.updated_at) {
                cacheAge = Date.now() - new Date(newsDoc.updated_at).getTime();
                // Le cache est valide s'il existe, a des données, correspond à la langue, et est récent (< 24h)
                cacheIsValid = cacheAge < oneDay;
            } else {
                // Cache sans date de mise à jour, considérer comme invalide
                console.log(`Cache sans date de mise à jour pour ${language}, invalide.`);
            }
        }
        
        // Si le cache n'existe pas ou est invalide, régénérer automatiquement
        if (!cacheIsValid) {
            // Essayer d'abord l'ancien format de cache (marketNews sans suffixe) comme fallback temporaire
            if (language === 'fr' && !forceRefresh && newsDoc && newsDoc.data) {
                const oldCacheDoc = await db.getSystemCache('marketNews');
                if (oldCacheDoc && oldCacheDoc.data) {
                    const oldData = Array.isArray(oldCacheDoc.data) ? oldCacheDoc.data : oldCacheDoc.data;
                    if (Array.isArray(oldData)) {
                        console.log(`Utilisation de l'ancien format de cache pour migration...`);
                        // Migrer vers le nouveau format en arrière-plan (ne bloque pas la réponse)
                        updateMarketNewsCache(language).catch(err => 
                            console.error(`Erreur lors de la migration du cache:`, err)
                        );
                        return res.status(200).json(oldData);
                    }
                }
            }
            
            // Si le cache est expiré, régénérer automatiquement
            if (newsDoc && newsDoc.data && cacheAge) {
                console.log(`Cache expiré pour ${language} (${Math.round(cacheAge / (60 * 60 * 1000))}h), régénération automatique...`);
            } else {
                console.log(`Génération des actualités pour la langue ${language}${forceRefresh ? ' (force refresh)' : ' (cache manquant)'}...`);
            }
            
            try {
                await updateMarketNewsCache(language);
                // Réessayer après génération
                const newNewsDoc = await db.getSystemCache(cacheKey);
                if (newNewsDoc && newNewsDoc.data) {
                    return res.status(200).json(newNewsDoc.data);
                }
            } catch (genError) {
                console.error(`Erreur lors de la génération des actualités pour ${language}:`, genError);
                // Si le cache existant est disponible même s'il est expiré, l'utiliser comme fallback
                if (newsDoc && newsDoc.data) {
                    console.log(`Utilisation du cache expiré comme fallback après erreur de régénération.`);
                    return res.status(200).json(newsDoc.data);
                }
                // Fallback sur le français si disponible
                if (language !== 'fr') {
                    const fallbackDoc = await db.getSystemCache('marketNews_fr');
                    if (fallbackDoc && fallbackDoc.data) {
                        return res.status(200).json(fallbackDoc.data);
                    }
                }
                // Fallback sur l'ancien format de cache
                const oldCacheDoc = await db.getSystemCache('marketNews');
                if (oldCacheDoc && oldCacheDoc.data) {
                    const oldData = Array.isArray(oldCacheDoc.data) ? oldCacheDoc.data : oldCacheDoc.data;
                    if (Array.isArray(oldData)) {
                        return res.status(200).json(oldData);
                    }
                }
                return res.status(404).send({ error: 'Cache d\'actualités non encore généré. Veuillez patienter.' });
            }
        }
        
        // Vérifier que le document a bien des données
        const docData = newsDoc;
        if (!docData || !docData.data) {
            // Fallback sur l'ancien format de cache
            const oldCacheDoc = await db.getSystemCache('marketNews');
            if (oldCacheDoc && oldCacheDoc.data) {
                const oldData = Array.isArray(oldCacheDoc.data) ? oldCacheDoc.data : oldCacheDoc.data;
                if (Array.isArray(oldData)) {
                    return res.status(200).json(oldData);
                }
            }
            return res.status(404).send({ error: 'Cache d\'actualités non encore généré. Veuillez patienter.' });
        }

        // Récupérer les actualités
        const newsData = docData.data;
        if (!Array.isArray(newsData)) {
            console.error(`Format de cache invalide pour marketNews_${language}:`, docData);
            return res.status(500).send({ error: 'Format de cache invalide. Veuillez réessayer plus tard.' });
        }

        res.status(200).json(newsData); 

    } catch (error) {
        console.error('Erreur lors de la récupération des actualités depuis le cache:', error);
         res.status(500).send({ error: `Erreur serveur lors de la récupération des actualités: ${error.message}` });
    }
});

// GET /api/properties/:id/news - Récupérer les actualités spécifiques (avec cache par propriété)
app.get('/api/properties/:id/news', authenticateToken, async (req, res) => {
    try {
        const { id: propertyId } = req.params;
        const userId = req.user.uid;

        // 1. Vérifier la propriété et les droits
        const property = await db.getProperty(propertyId);
        if (!property) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }
        
        const userProfile = await db.getUser(userId);
        if (!userProfile) {
            return res.status(404).send({ error: 'Profil utilisateur non trouvé.' });
        }
        
        const propertyTeamId = property.team_id || property.owner_id; 
        if (userProfile.team_id !== propertyTeamId) { 
             return res.status(403).send({ error: 'Action non autorisée sur cette propriété (pas dans la bonne équipe).' });
        }
        
        const fullLocation = property.location || 'France';
        const city = fullLocation.split(',')[0].trim();

        // 2. Vérifier le cache de cette propriété (avec langue)
        const language = req.query.language || userProfile?.language || 'fr';
        
        // Note: Le cache par propriété n'est pas encore implémenté dans Supabase
        // Pour l'instant, on ignore le cache et on génère toujours les actualités
        // TODO: Implémenter un système de cache par propriété dans Supabase si nécessaire

        // 3. Si cache vide ou expiré, appeler l'IA
        const isFrench = language === 'fr' || language === 'fr-FR';
        console.log(`Génération des actualités pour ${propertyId} (ville: ${city}, langue: ${language}), appel de recherche web...`);
        
        const prompt = isFrench ? `
            Tu es un analyste de marché expert pour la location saisonnière.
            Utilise l'outil de recherche pour trouver 2-3 actualités ou événements 
            très récents (moins de 7 jours) OU à venir (6 prochains mois)
            spécifiques à la ville : "${city}".
            Concentre-toi sur les événements (concerts, festivals, salons) ou
            les tendances qui impactent la demande de location dans cette ville.

            Pour chaque actualité/événement:
            1. Fournis un titre concis en français.
            2. Fais un résumé d'une phrase en français.
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
        ` : `
            You are an expert market analyst for seasonal rentals.
            Use the search tool to find 2-3 very recent news items or events 
            (less than 7 days old) OR upcoming (next 6 months)
            specific to the city: "${city}".
            Focus on events (concerts, festivals, trade shows) or
            trends that impact rental demand in this city.

            For each news item/event:
            1. Provide a concise title in English.
            2. Write a one-sentence summary in English.
            3. Estimate the impact on prices as a percentage (e.g., 15 for +15%, -5 for -5%).
            4. Categorize this impact as "high", "medium", or "low".

            Respond ONLY with a valid JSON array. 
            Do not include any text before or after the array, not even \`\`\`json.
            The format should be:
            [
                {
                    "title": "News title",
                    "summary": "News summary.",
                    "source": "Source name (e.g., 'Le Monde')",
                    "impact_percentage": 15,
                    "impact_category": "high"
                }
            ]
        `;

        const newsData = await callGeminiWithSearch(prompt, 10, language);
        const newsDataArray = Array.isArray(newsData) ? newsData : (newsData ? [newsData] : []);

        if (newsDataArray.length === 0) {
             console.warn("Aucune actualité pertinente trouvée pour", city);
        }

        // 4. Log de l'action (le cache sera implémenté plus tard si nécessaire)
        await logPropertyChange(propertyId, "system", "auto-update", 'update:news-cache', { count: newsDataArray.length });


        res.status(200).json(newsDataArray);

    } catch (error) {
        console.error(`Erreur lors de la récupération des actualités pour ${req.params.id}:`, error);
         if (error.message.includes('403') || error.message.includes('API key not valid')) {
             res.status(500).send({ error: "L'API de recherche (Perplexity/ChatGPT) n'est pas correctement configurée." });
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
async function updateMarketNewsCache(language = 'fr') {
    console.log(`Tâche planifiée : Démarrage de la mise à jour des actualités (${language})...`);
    try {
        const isFrench = language === 'fr' || language === 'fr-FR';
        
        const prompt = isFrench ? `
            Tu es un analyste de marché expert pour la location saisonnière en France.
            Utilise l'outil de recherche pour trouver les 3-4 actualités ou tendances 
            les plus récentes et pertinentes (moins de 7 jours) qui impactent 
            le marché de la location (type Airbnb, Booking) en France.
            Recherche aussi des événements majeurs (concerts, festivals, salons) 
            annoncés récemment en France pour les 6 prochains mois.

            Pour chaque actualité:
            1. Fournis un titre concis en français.
            2. Fais un résumé d'une phrase en français.
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
        ` : `
            You are an expert market analyst for seasonal rentals in France.
            Use the search tool to find the 3-4 most recent and relevant news or trends 
            (less than 7 days old) that impact the rental market (Airbnb, Booking type) in France.
            Also search for major events (concerts, festivals, trade shows) 
            recently announced in France for the next 6 months.

            For each news item:
            1. Provide a concise title in English.
            2. Write a one-sentence summary in English.
            3. Estimate the impact on prices as a percentage (e.g., 15 for +15%, -5 for -5%).
            4. Categorize this impact as "high", "medium", or "low".

            Respond ONLY with a valid JSON array in English. 
            Do not include any text before or after the array, not even \`\`\`json.
            The format should be:
            [
                {
                    "title": "News title",
                    "summary": "News summary.",
                    "source": "Source name (e.g., 'Le Monde')",
                    "impact_percentage": 15,
                    "impact_category": "high"
                }
            ]
        `;
        
        const newsData = await callGeminiWithSearch(prompt, 10, language); // Appelle la fonction avec retry

        if (!newsData || !Array.isArray(newsData)) {
             throw new Error("Données d'actualités invalides reçues de l'API de recherche.");
        }

        const cacheKey = `marketNews_${language}`;
        await db.setSystemCache(cacheKey, newsData, {
            language: language
        });
        console.log(`Mise à jour du cache des actualités (${language}) terminée avec succès.`);

    } catch (error) {
        console.error(`Erreur lors de la mise à jour du cache des actualités (${language}):`, error.message);
    }
}

// Planifier la tâche pour s'exécuter tous les jours à 3h00 du matin
// Ne générer que les langues qui ont un cache existant (langues réellement utilisées)
console.log("Mise en place de la tâche planifiée pour les actualités (tous les jours à 3h00).");
// --- CRON JOBS ---

// ============================================================================
// PIPELINE QUOTIDIEN DE DONNÉES MARCHÉ (ÉTAPES 0.5, 0.6, 0.7)
// ============================================================================

/**
 * Exécute le pipeline complet de données marché en séquence.
 * ÉTAPE 0.5 : Collecte données marché
 * ÉTAPE 0.6 : Enrichissement IA données marché
 * ÉTAPE 0.7 : Construction features marché
 */
async function runMarketDataPipeline() {
    const pipelineStartTime = Date.now();
    const pipelineStats = {
        startTime: new Date().toISOString(),
        steps: {
            collect: { success: false, duration: 0, error: null },
            enrich: { success: false, duration: 0, error: null },
            buildFeatures: { success: false, duration: 0, error: null }
        },
        totalDuration: 0
    };

    console.log('[Market Data Pipeline] ========================================');
    console.log('[Market Data Pipeline] Démarrage du pipeline quotidien de données marché');
    console.log('[Market Data Pipeline] ========================================');

    // Date range par défaut : aujourd'hui + 90 jours
    const today = new Date();
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + 90);
    const dateRange = {
        startDate: today.toISOString().split('T')[0],
        endDate: endDate.toISOString().split('T')[0]
    };

    // ÉTAPE 0.5 : Collecte données marché
    console.log('[Market Data Pipeline] ÉTAPE 0.5 : Collecte de données marché...');
    try {
        const collectStartTime = Date.now();
        const collectResult = await collectMarketData({
            dateRange
        });
        const collectDuration = (Date.now() - collectStartTime) / 1000;

        pipelineStats.steps.collect = {
            success: collectResult.success,
            duration: collectDuration,
            error: collectResult.error || null,
            stats: collectResult.report
        };

        if (collectResult.success) {
            console.log(`[Market Data Pipeline] ✓ ÉTAPE 0.5 terminée: ${collectResult.report?.total_records || 0} records collectés en ${collectDuration.toFixed(2)}s`);
        } else {
            console.warn(`[Market Data Pipeline] ⚠ ÉTAPE 0.5 terminée avec erreurs: ${collectResult.error}`);
            // On continue quand même, la collecte n'est pas bloquante
        }
    } catch (error) {
        const collectDuration = (Date.now() - Date.now()) / 1000;
        pipelineStats.steps.collect = {
            success: false,
            duration: collectDuration,
            error: error.message
        };
        console.error('[Market Data Pipeline] ✗ ERREUR CRITIQUE ÉTAPE 0.5:', error);
        // On continue quand même
    }

    // ÉTAPE 0.6 : Enrichissement IA données marché
    console.log('[Market Data Pipeline] ÉTAPE 0.6 : Enrichissement IA des données marché...');
    try {
        const enrichStartTime = Date.now();
        const enrichResult = await enrichMarketData({
            dateRange
        });
        const enrichDuration = (Date.now() - enrichStartTime) / 1000;

        pipelineStats.steps.enrich = {
            success: enrichResult.success,
            duration: enrichDuration,
            error: enrichResult.error || null,
            stats: enrichResult.report
        };

        if (enrichResult.success) {
            console.log(`[Market Data Pipeline] ✓ ÉTAPE 0.6 terminée: ${enrichResult.report?.total_enriched || 0} records enrichis en ${enrichDuration.toFixed(2)}s`);
        } else {
            console.warn(`[Market Data Pipeline] ⚠ ÉTAPE 0.6 terminée avec erreurs: ${enrichResult.error}`);
            // On continue quand même, l'enrichissement n'est pas bloquante
        }
    } catch (error) {
        const enrichDuration = (Date.now() - Date.now()) / 1000;
        pipelineStats.steps.enrich = {
            success: false,
            duration: enrichDuration,
            error: error.message
        };
        console.error('[Market Data Pipeline] ✗ ERREUR CRITIQUE ÉTAPE 0.6:', error);
        // On continue quand même
    }

    // ÉTAPE 0.7 : Construction features marché
    console.log('[Market Data Pipeline] ÉTAPE 0.7 : Construction des features marché...');
    try {
        const buildStartTime = Date.now();
        const buildResult = await buildMarketFeatures({
            dateRange,
            updatePricing: true
        });
        const buildDuration = (Date.now() - buildStartTime) / 1000;

        pipelineStats.steps.buildFeatures = {
            success: buildResult.success,
            duration: buildDuration,
            error: buildResult.error || null,
            stats: buildResult.report
        };

        if (buildResult.success) {
            const featuresBuilt = buildResult.report?.build_features?.features_built || 0;
            const propertiesUpdated = buildResult.report?.update_pricing?.properties_updated || 0;
            console.log(`[Market Data Pipeline] ✓ ÉTAPE 0.7 terminée: ${featuresBuilt} features construites, ${propertiesUpdated} propriétés mises à jour en ${buildDuration.toFixed(2)}s`);
        } else {
            console.warn(`[Market Data Pipeline] ⚠ ÉTAPE 0.7 terminée avec erreurs: ${buildResult.error}`);
            // On continue quand même, la construction n'est pas bloquante
        }
    } catch (error) {
        const buildDuration = (Date.now() - Date.now()) / 1000;
        pipelineStats.steps.buildFeatures = {
            success: false,
            duration: buildDuration,
            error: error.message
        };
        console.error('[Market Data Pipeline] ✗ ERREUR CRITIQUE ÉTAPE 0.7:', error);
        // On continue quand même
    }

    // Résumé final
    pipelineStats.totalDuration = (Date.now() - pipelineStartTime) / 1000;
    const allSuccess = pipelineStats.steps.collect.success && 
                       pipelineStats.steps.enrich.success && 
                       pipelineStats.steps.buildFeatures.success;
    
    console.log('[Market Data Pipeline] ========================================');
    console.log('[Market Data Pipeline] Pipeline terminé');
    console.log(`[Market Data Pipeline] Durée totale: ${pipelineStats.totalDuration.toFixed(2)}s`);
    console.log(`[Market Data Pipeline] Statut: ${allSuccess ? '✓ SUCCÈS' : '⚠ ERREURS PARTIELLES'}`);
    console.log(`[Market Data Pipeline] - Collecte: ${pipelineStats.steps.collect.success ? '✓' : '✗'} (${pipelineStats.steps.collect.duration.toFixed(2)}s)`);
    console.log(`[Market Data Pipeline] - Enrichissement: ${pipelineStats.steps.enrich.success ? '✓' : '✗'} (${pipelineStats.steps.enrich.duration.toFixed(2)}s)`);
    console.log(`[Market Data Pipeline] - Construction features: ${pipelineStats.steps.buildFeatures.success ? '✓' : '✗'} (${pipelineStats.steps.buildFeatures.duration.toFixed(2)}s)`);
    console.log('[Market Data Pipeline] ========================================');

    return pipelineStats;
}

// Job quotidien du pipeline de données marché (2h UTC, avant le pipeline de pricing)
cron.schedule('0 2 * * *', async () => {
    await runMarketDataPipeline();
}, {
    scheduled: true,
    timezone: "UTC"
});

cron.schedule('0 3 * * *', async () => {
    // Vérifier quelles langues sont réellement utilisées (ont un cache existant)
    const frCache = await db.getSystemCache('marketNews_fr');
    const enCache = await db.getSystemCache('marketNews_en');
    
    // Ne générer que pour les langues qui ont déjà été utilisées
    if (frCache && frCache.data) {
        console.log('[Cron] Régénération des actualités en français (cache existant détecté)');
        updateMarketNewsCache('fr').catch(err => 
            console.error('[Cron] Erreur lors de la régénération des actualités FR:', err)
        );
    }
    
    if (enCache && enCache.data) {
        console.log('[Cron] Régénération des actualités en anglais (cache existant détecté)');
        updateMarketNewsCache('en').catch(err => 
            console.error('[Cron] Erreur lors de la régénération des actualités EN:', err)
        );
    }
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


// Ne plus générer automatiquement au démarrage
// Les actualités seront générées à la demande lors de la première connexion d'un utilisateur
// et seulement pour sa langue, une fois par jour maximum
console.log("Génération des actualités désactivée au démarrage. Génération à la demande uniquement.");


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
    try {
        const today = new Date().toISOString().split('T')[0];
        
        // Récupérer la langue de l'utilisateur
        const userProfile = await db.getUser(userId);
        const language = userProfile?.language || 'fr';

        // Construire le nouveau prompt pour l'IA (identique à l'endpoint de pricing-strategy)
        const prompt = `
### RÔLE DU SYSTÈME : MOTEUR DE TARIFICATION INTELLIGENTE 

Tu es l'IA centrale d'un système de Revenue Management (Yield Management) comparable aux leaders mondiaux (PriceLabs, Wheelhouse, Beyond). Ta capacité d'analyse dépasse celle d'un humain : tu croises des millions de signaux faibles pour déterminer le "Prix Juste" (Fair Price) à l'instant T.

PARAMÈTRES DE LA MISSION :

- **Lieu :** ${property.location}
- **Date d'exécution :** ${today}
- **Horizon :** 180 jours
- **Objectif :** Maximisation du RevPAR (Revenu par chambre disponible) + Taux de Conversion.

---

### PARTIE 1 : INGESTION PROFONDE DU CONTEXTE (INPUTS)

**1. PROFILAGE DE L'ACTIF (PROPERTY SCORING)**

Analyse la valeur perçue de ce bien spécifique par rapport au marché local :

${JSON.stringify({
    address: property.address,
    type: property.property_type,
    capacity: property.capacity,
    surface: property.surface,
    amenities: property.amenities || [],
    listing_quality_assessment:
      "AUTO-ÉVALUATION REQUISE : Détermine si ce bien est 'Économique', 'Standard', 'Premium' ou 'Luxe' en fonction des équipements (Piscine ? Vue ? AC ?) et de la surface vs capacité."
  }, null, 2)}

**2. RÈGLES FINANCIÈRES INVIOLABLES (HARD CONSTRAINTS)**

Ces bornes sont des "Kill Switches". Si ton calcul théorique les dépasse, tu dois couper.

- **Floor Price (Plancher Absolu):** ${property.floor_price} € (Ligne de survie).
- **Base Price (Pivot):** ${property.base_price} € (Prix de référence neutre).
- **Ceiling Price (Plafond):** ${property.ceiling_price || property.base_price * 4} € (Sécurité anti-aberration).
- **Min Stay:** ${property.min_stay || 1} nuits.
- **Réductions:** Semaine -${property.weekly_discount_percent || 0}%, Mois -${property.monthly_discount_percent || 0}%.
- **Majoration Week-end:** Ven/Sam +${property.weekend_markup_percent || 0}%.

**3. STRATÉGIE UTILISATEUR : [ ${property.strategy || 'Équilibré'} ]**

Tu dois moduler ton agressivité selon ce profil :

* **PRUDENT :** "Occupation First". Tu préfères louer à -15% que de rester vide. Tu es très réactif à la baisse en dernière minute (Last Minute).
* **ÉQUILIBRÉ :** "Market Follower". Tu cherches le ratio parfait. Tu ne prends pas de risques inutiles.
* **AGRESSIF :** "Yield First". Tu vises l'ADR (Prix Moyen) maximum. Tu ne brades pas. Tu sais que ton bien est unique et tu le fais payer. Tu acceptes d'avoir des jours vides pour vendre très cher les jours pleins.

---

### PARTIE 2 : LE "PIPELINE" DE CALCUL (8 ÉTAPES OBLIGATOIRES)

Pour **CHAQUE JOUR** du calendrier, tu dois exécuter mentalement cette séquence précise. Ne saute aucune étape.

**ÉTAPE 1 : ANALYSE MACRO-ÉCONOMIQUE & TENDANCES (MARKET HEALTH)**

* Prends en compte l'inflation actuelle en zone Euro/Locale.
* Analyse la "Force de la destination" : Est-ce que ${property.location} est "tendance" cette année ? (Basé sur tes données d'entraînement).
* *Impact :* Ajuste le Prix de Base global de +/- 5% selon la santé économique du tourisme.

**ÉTAPE 2 : COURBE DE SAISONNALITÉ HYPER-LOCALE (SEASONAL WAVE)**

* Ne fais pas juste "Été vs Hiver". Fais une analyse mois par mois fine.
* Identifie les "Saisons d'épaule" (Shoulder Seasons) où les opportunités sont les meilleures.
* *Calcul :* Applique un coefficient multiplicateur (ex: x0.6 en Janvier, x1.8 en Août).

**ÉTAPE 3 : JOUR DE LA SEMAINE (DOW - DAY OF WEEK)**

* Analyse la typologie de la ville :
    * Ville Affaires ? (Mardi/Mercredi chers, Week-end moins cher).
    * Ville Loisirs ? (Vendredi/Samedi explosifs, Dimanche modéré).
* *Action :* Applique la majoration week-end définie, ou ajuste selon la logique locale.

**ÉTAPE 4 : INTELLIGENCE ÉVÉNEMENTIELLE (DEMAND SPIKES)**

* Effectue une recherche approfondie des événements à ${property.location} sur les 180 jours :
    * Vacances Scolaires (Toutes zones + Pays limitrophes).
    * Jours Fériés et "Ponts" (Gaps entre férié et week-end).
    * Événements "Tier 1" : Grands concerts, Festivals, Compétitions sportives, Foires commerciales majeures.
* *Règle :* Si un Événement Tier 1 est détecté -> Ignore le "Prix Plafond" habituel (sauf si contrainte stricte) et passe en mode "Yield Maximization" (x2 à x4 le prix de base).

**ÉTAPE 5 : PRESSION CONCURRENTIELLE SIMULÉE (COMPSET)**

* Simule le comportement de 10 concurrents directs.
* Si la date est dans < 14 jours et que la demande est faible : Tes concurrents vont baisser. Tu dois anticiper.
* Si la date est très demandée : Tes concurrents sont déjà pleins (Sold Out). Tu es le dernier choix, tu as le "Pricing Power". Augmente le prix.

**ÉTAPE 6 : FACTEUR TEMPOREL (BOOKING WINDOW / LEAD TIME)**

* **Far Out (90j+) :** Ajoute une prime (+10%). Les gens qui réservent tôt sont moins sensibles au prix ou cherchent la sécurité.
* **Mid Range (21-90j) :** Prix de marché ("Fair Price").
* **Close In (0-21j) :**
    * Si Stratégie = Prudent : Baisse progressive (jusqu'au Floor Price).
    * Si Stratégie = Agressif : Maintien du prix (on ne dévalorise pas le bien).

**ÉTAPE 7 : GESTION DES JOURS ISOLÉS (ORPHAN DAYS LOGIC)**

* *Concept :* Bien que tu génères un calendrier neuf, simule cette logique : Si un mardi est isolé entre deux dates à forte probabilité de réservation (ex: Lundi férié et Mercredi business), baisse son prix pour inciter à combler le trou, ou augmente-le si c'est une date "pivot".

**ÉTAPE 8 : PSYCHOLOGIE DES PRIX (CHARM PRICING)**

* Nettoyage final du chiffre.
* JAMAIS de centimes.
* Évite les chiffres ronds "trop parfaits" comme 100€ (ça fait amateur). Préfère 99€ ou 105€.
* Règles : Terminaisons en 5, 9, ou 0.
* *Cohérence (Smoothing) :* Vérifie que le prix du jour J n'est pas > 50% plus cher que J-1 sans raison majeure (événement). Lisse la courbe.

---

### PARTIE 3 : FORMAT DE SORTIE (JSON ULTRA-RICHE)

Tu dois répondre UNIQUEMENT par un JSON valide. Ce JSON servira à alimenter un Dashboard professionnel.

Structure attendue :

{
  "audit_metadata": {
    "generated_at": "${today}",
    "property_grade": "Luxe/Standard/Éco",
    "market_sentiment": "Bullish (Hausier) ou Bearish (Baissier) - Courte explication.",
    "top_demand_drivers": ["Liste des 3 événements majeurs identifiés"],
    "strategy_active": "${property.strategy || 'Équilibré'}"
  },
  "calendar": [
    {
      "date": "YYYY-MM-DD",
      "weekday": "String",
      "final_suggested_price": 0,
      "currency": "EUR",
      "price_breakdown": {
        "base": ${property.base_price},
        "seasonality_impact": "+0%",
        "event_impact": "+0%",
        "lead_time_impact": "+0%"
      },
      "demand_score": 0,
      "competition_status": "High/Medium/Low (Pression concurrentielle)",
      "tags": [],
      "reasoning": "Phrase concise mais technique expliquant le prix."
    }
    // ... Répéter pour les 180 jours, en produisant des objets complets et cohérents
  ]
}

RAPPEL CRITIQUE : La réponse finale doit être UNIQUEMENT ce JSON, sans texte additionnel, sans commentaires, sans markdown.
        `;

        // Appeler l'API ChatGPT
        const iaResult = await callGeminiWithSearch(prompt, 10, language);

        if (!iaResult || !Array.isArray(iaResult.calendar) || iaResult.calendar.length === 0) {
            throw new Error("La réponse de l'IA est invalide ou ne contient pas de calendrier de prix.");
        }

        // Adapter le nouveau format (calendar) en daily_prices pour le reste du backend
        const daily_prices = iaResult.calendar.map(day => {
            const rawPrice = day.final_suggested_price;
            let priceNum = Number(rawPrice);
            if (isNaN(priceNum)) {
                priceNum = property.base_price;
            }
            return {
                date: day.date,
                price: priceNum,
                reason: day.reasoning || "Tarification IA dynamique (auto)"
            };
        });

        const strategyResult = {
            strategy_summary: iaResult.audit_metadata?.market_sentiment || "Stratégie IA dynamique générée (auto).",
            daily_prices,
            raw: iaResult
        };

        // Synchronisation PMS si nécessaire
        if (property.pmsId && property.pmsType) {
            // Vérifier si la synchronisation PMS est activée
            const syncEnabled = await isPMSSyncEnabled(userId, db);
            if (!syncEnabled) {
                console.log(`[Auto-Pricing] [PMS Sync] Synchronisation PMS désactivée pour l'utilisateur ${userId}. Synchronisation ignorée.`);
            } else {
                try {
                    const client = await getUserPMSClient(userId);
                    const allOverrides = await db.getPriceOverrides(propertyId);
                    const lockedDates = new Set();
                    allOverrides.forEach(override => {
                        if (override.is_locked) {
                            lockedDates.add(override.date);
                        }
                    });
                    
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

        // Sauvegarder les prix dans Supabase
        const floor = property.floor_price;
        const ceiling = property.ceiling_price;

        // Récupérer tous les price_overrides pour cette propriété pour trouver les prix verrouillés
        const allOverrides = await db.getPriceOverrides(propertyId);
        const lockedPrices = new Map();
        allOverrides.forEach(override => {
            if (override.is_locked) {
                lockedPrices.set(override.date, override.price);
            }
        });

        // Préparer les overrides à sauvegarder
        const overridesToSave = [];
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

            overridesToSave.push({
                date: day.date,
                price: finalPrice,
                reason: day.reason || "Stratégie IA (Auto)",
                isLocked: false,
                updatedBy: userId
            });
            pricesApplied++;
        }

        // Sauvegarder tous les overrides en une seule opération
        if (overridesToSave.length > 0) {
            await db.upsertPriceOverrides(propertyId, overridesToSave);
        }

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
    const startTime = new Date();

    try {
        console.log(`[Auto-Pricing] Début du traitement pour l'utilisateur ${userId} (${userData.email || 'N/A'})`);

        // Récupérer toutes les propriétés de l'utilisateur
        // Les propriétés peuvent être liées par owner_id ou team_id
        const teamId = userData.team_id || userId;
        
        // Récupérer les propriétés par owner_id
        const { data: propertiesByOwner } = await supabase
            .from('properties')
            .select('*')
            .eq('owner_id', userId);
        
        // Récupérer les propriétés par team_id (si différent de userId)
        let propertiesByTeam = [];
        if (teamId !== userId) {
            const { data: teamProps } = await supabase
                .from('properties')
                .select('*')
                .eq('team_id', teamId);
            propertiesByTeam = teamProps || [];
        }

        // Combiner les résultats et éviter les doublons
        const propertiesMap = new Map();
        (propertiesByOwner || []).forEach(prop => {
            propertiesMap.set(prop.id, prop);
        });
        propertiesByTeam.forEach(prop => {
            if (!propertiesMap.has(prop.id)) {
                propertiesMap.set(prop.id, prop);
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
        const groups = await db.getGroupsByOwner(userId);

        const results = [];

        // Traiter les groupes avec synchronisation activée
        const groupsWithSync = groups.filter(g => g.sync_prices && g.main_property_id);
        if (groupsWithSync.length > 0) {
            const groupResults = await generatePricingForGroups(userId, userData.email, groupsWithSync, properties);
            results.push(...groupResults);
        }

        // Traiter les propriétés individuelles (non dans un groupe avec sync)
        const propertiesInSyncedGroups = new Set();
        groupsWithSync.forEach(group => {
            const groupProps = (group.properties || []).map(p => typeof p === 'string' ? p : (p.id || p.property_id));
            groupProps.forEach(propId => propertiesInSyncedGroups.add(propId));
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
        const now = new Date().toISOString();
        const updateData = {
            auto_pricing: {
                ...(userData.auto_pricing || {}),
                last_run: now,
                last_attempt: now
            }
        };

        // Si toutes les propriétés ont réussi, mettre à jour lastSuccessfulRun
        if (failureCount === 0 && results.length > 0) {
            updateData.auto_pricing.last_successful_run = now;
            updateData.auto_pricing.failed_attempts = 0; // Réinitialiser le compteur d'échecs
            console.log(`[Auto-Pricing] Traitement terminé avec succès pour ${userId}: ${successCount} succès (${duration}s)`);
        } else if (failureCount > 0) {
            // Incrémenter le compteur d'échecs
            updateData.auto_pricing.failed_attempts = ((userData.auto_pricing?.failed_attempts || 0) + 1);
            console.log(`[Auto-Pricing] Traitement terminé avec échecs pour ${userId}: ${successCount} succès, ${failureCount} échecs (${duration}s) - Tentative ${updateData.auto_pricing.failed_attempts}`);
        }

        await db.updateUser(userId, updateData);

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
    const now = new Date();

    try {
        console.log(`[Auto-Pricing] Vérification des utilisateurs éligibles à ${now.toISOString()}`);

        // Récupérer tous les utilisateurs avec auto_pricing.enabled = true
        const { data: users, error } = await supabase
            .from('users')
            .select('*')
            .eq('auto_pricing->enabled', true);

        if (error) {
            console.error('[Auto-Pricing] Erreur lors de la récupération des utilisateurs:', error);
            return;
        }

        if (!users || users.length === 0) {
            console.log(`[Auto-Pricing] Aucun utilisateur avec génération automatique activée.`);
            return;
        }

        const eligibleUsers = [];

        users.forEach(user => {
            const autoPricing = user.auto_pricing || {};
            const timezone = autoPricing.timezone || user.timezone || 'Europe/Paris';

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
                    userId: user.id,
                    userData: user,
                    timezone: timezone,
                    isRetry: shouldRetry && !isScheduledTime
                });
                const reason = isScheduledTime ? 'Heure prévue (00h00)' : `Réessai après échec (tentative ${failedAttempts})`;
                console.log(`[Auto-Pricing] Utilisateur ${user.id} (${user.email || 'N/A'}) éligible - ${reason} - Fuseau: ${timezone}`);
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
        let propertyId = req.params.id;
        const userId = req.user.uid;
        const { startDate, endDate } = req.query;

        // Valider que propertyId est un UUID valide (32 caractères hexadécimaux, avec ou sans tirets)
        // Un UUID fait 32 caractères hex (sans tirets) ou 36 avec tirets
        if (!propertyId || propertyId.length < 32) {
            console.error('UUID invalide reçu pour price-overrides:', propertyId, 'Longueur:', propertyId?.length);
            return res.status(400).send({ error: 'ID de propriété invalide.' });
        }

        // Vérifier que la propriété appartient à l'utilisateur
        const property = await db.getProperty(propertyId);
        if (!property) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }

        const userProfile = await db.getUser(userId);
        if (!userProfile) {
            return res.status(404).send({ error: 'Profil utilisateur non trouvé.' });
        }
        
        const propertyTeamId = property.team_id || property.owner_id;
        if (userProfile.team_id !== propertyTeamId) {
            return res.status(403).send({ error: 'Action non autorisée.' });
        }

        // Récupérer les price overrides
        const overrides = await db.getPriceOverrides(propertyId, startDate, endDate);

        // Transformer le tableau en objet indexé par date pour compatibilité avec le frontend
        const overridesByDate = {};
        overrides.forEach(override => {
            overridesByDate[override.date] = {
                price: override.price,
                isLocked: override.is_locked || false,
                reason: override.reason || 'Manuel'
            };
        });

        res.status(200).json(overridesByDate);
    } catch (error) {
        console.error('Erreur lors de la récupération des price overrides:', error);
        res.status(500).send({ error: 'Erreur lors de la récupération des price overrides.' });
    }
});

// PUT /api/properties/:id/price-overrides - Mettre à jour les price overrides en batch
app.put('/api/properties/:id/price-overrides', authenticateToken, async (req, res) => {
    try {
        const propertyId = req.params.id;
        const userId = req.user.uid;
        const { overrides } = req.body; // Array of { date, price, isLocked }

        if (!Array.isArray(overrides)) {
            return res.status(400).send({ error: 'Le paramètre "overrides" doit être un tableau.' });
        }

        // Vérifier que la propriété appartient à l'utilisateur
        const property = await db.getProperty(propertyId);
        
        if (!property) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }

        const userProfile = await db.getUser(userId);
        if (!userProfile) {
            return res.status(404).send({ error: 'Profil utilisateur non trouvé.' });
        }
        
        const propertyTeamId = property.team_id || property.owner_id;
        
        if (userProfile.team_id !== propertyTeamId) {
            return res.status(403).send({ error: 'Action non autorisée.' });
        }

        // Préparer les données pour Supabase
        const overridesToUpsert = overrides
            .filter(override => override.date)
            .map(override => ({
                date: override.date,
                price: Number(override.price),
                is_locked: override.isLocked !== undefined ? Boolean(override.isLocked) : false,
                reason: 'Manuel',
                updated_by: userId
            }));

        // Utiliser le helper pour upsert les price overrides
        await db.upsertPriceOverrides(propertyId, overridesToUpsert);

        // Synchronisation avec PMS si la propriété est liée à un PMS
        if (property.pms_id && property.pms_type) {
            // Vérifier si la synchronisation PMS est activée
            const syncEnabled = await isPMSSyncEnabled(userId);
            if (!syncEnabled) {
                console.log(`[PMS Sync] Synchronisation PMS désactivée pour l'utilisateur ${userId}. Synchronisation ignorée.`);
            } else {
                try {
                    console.log(`[PMS Sync] Propriété ${propertyId} (PMS ID: ${property.pms_id}) est liée. Synchronisation des prix...`);
                    
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
                        await client.updateBatchRates(property.pms_id, pricesToSync);
                        console.log(`[PMS Sync] ${pricesToSync.length} prix synchronisés avec ${property.pms_type} pour ${propertyId}.`);
                    } else {
                        console.log(`[PMS Sync] Aucun prix à synchroniser (tous les prix sont verrouillés ou invalides).`);
                    }
                } catch (pmsError) {
                    console.error(`[PMS Sync] ERREUR lors de la synchronisation des prix pour ${propertyId}:`, pmsError.message);
                    // On continue quand même car les prix sont déjà sauvegardés dans Supabase
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

// --- COLLECTE DE DONNÉES MARCHÉ ---

/**
 * Exécute le script Python de collecte de données marché.
 * 
 * @param {Object} options - Options pour la collecte
 * @param {Array<string>} options.countries - Liste de codes pays (optionnel)
 * @param {Array<string>} options.cities - Liste de villes (optionnel)
 * @param {Object} options.dateRange - Plage de dates {startDate, endDate} (optionnel)
 * @param {boolean} options.skipCompetitors - Si true, skip la collecte concurrents
 * @param {boolean} options.skipWeather - Si true, skip la collecte météo
 * @returns {Promise<Object>} Rapport de collecte
 */
async function collectMarketData(options = {}) {
    const {
        countries = null,
        cities = null,
        dateRange = null,
        skipCompetitors = false,
        skipWeather = false
    } = options;

    try {
        // Construire la commande Python
        let command = 'python -m market_data_pipeline.jobs.collect_market_data --json';
        
        // Ajouter les arguments
        if (countries && countries.length > 0) {
            command += ` --countries ${countries.join(' ')}`;
        }
        
        if (cities && cities.length > 0) {
            command += ` --cities ${cities.join(' ')}`;
        }
        
        if (dateRange && dateRange.startDate) {
            command += ` --start-date ${dateRange.startDate}`;
        }
        
        if (dateRange && dateRange.endDate) {
            command += ` --end-date ${dateRange.endDate}`;
        }
        
        if (skipCompetitors) {
            command += ' --skip-competitors';
        }
        
        if (skipWeather) {
            command += ' --skip-weather';
        }

        console.log(`[Market Data] Exécution de la collecte: ${command}`);
        
        // Exécuter le script Python
        // Note: Sur Windows, on peut utiliser 'python', sur Linux/Mac 'python3'
        const pythonCommand = process.platform === 'win32' ? 'python' : 'python3';
        command = command.replace('python', pythonCommand);
        
        const { stdout, stderr } = await execAsync(command, {
            cwd: __dirname,
            maxBuffer: 10 * 1024 * 1024, // 10MB buffer pour les grandes sorties
            env: {
                ...process.env, // Hériter des variables d'environnement
                PYTHONUNBUFFERED: '1' // Désactiver le buffering Python pour voir les logs en temps réel
            }
        });

        // Parser la sortie JSON
        let report;
        try {
            // La sortie peut contenir des logs avant le JSON, chercher le JSON
            const jsonMatch = stdout.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                report = JSON.parse(jsonMatch[0]);
            } else {
                throw new Error('No JSON output found in stdout');
            }
        } catch (parseError) {
            console.error('[Market Data] Erreur de parsing JSON:', parseError);
            console.error('[Market Data] stdout:', stdout);
            console.error('[Market Data] stderr:', stderr);
            
            // Retourner un rapport d'erreur
            return {
                success: false,
                error: 'Failed to parse Python script output',
                stdout: stdout,
                stderr: stderr,
                parseError: parseError.message
            };
        }

        // Si stderr contient des erreurs mais que le script a retourné un JSON, 
        // c'est peut-être juste des warnings
        if (stderr) {
            console.warn('[Market Data] Warnings/Errors from Python script:', stderr);
        }

        console.log(`[Market Data] Collecte terminée: ${report.status || 'unknown'}, ${report.total_records || 0} records`);
        
        return {
            success: report.status !== 'failed',
            report: report
        };

    } catch (error) {
        console.error('[Market Data] Erreur lors de l\'exécution du script Python:', error);
        
        return {
            success: false,
            error: error.message,
            code: error.code,
            signal: error.signal
        };
    }
}

/**
 * Endpoint API pour déclencher la collecte de données marché.
 * POST /api/market-data/collect
 */
app.post('/api/market-data/collect', authenticateToken, async (req, res) => {
    try {
        const { countries, cities, dateRange, skipCompetitors, skipWeather } = req.body;

        console.log('[Market Data] Collecte déclenchée via API par utilisateur:', req.user.uid);

        const startTime = Date.now();
        const result = await collectMarketData({
            countries,
            cities,
            dateRange,
            skipCompetitors,
            skipWeather
        });
        const duration = (Date.now() - startTime) / 1000;

        if (result.success) {
            res.status(200).json({
                success: true,
                message: 'Collecte de données marché terminée avec succès',
                stats: {
                    status: result.report.status,
                    totalRecords: result.report.total_records || 0,
                    duration: result.report.duration_seconds || duration,
                    sources: result.report.sources
                },
                duration: duration,
                report: result.report
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error || 'Erreur lors de la collecte',
                duration: duration,
                report: result.report || null,
                details: result
            });
        }

    } catch (error) {
        console.error('[Market Data] Erreur dans l\'endpoint API:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur interne lors de la collecte de données marché',
            message: error.message
        });
    }
});

/**
 * Exécute le script Python d'enrichissement IA des données marché.
 * 
 * @param {Object} options - Options pour l'enrichissement
 * @param {Object} options.dateRange - Plage de dates {startDate, endDate} (optionnel)
 * @returns {Promise<Object>} Rapport d'enrichissement
 */
async function enrichMarketData(options = {}) {
    const {
        dateRange = null
    } = options;

    try {
        // Construire la commande Python
        let command = 'python -m market_data_pipeline.jobs.enrich_market_data --json';
        
        // Ajouter les arguments
        if (dateRange && dateRange.startDate) {
            command += ` --start-date ${dateRange.startDate}`;
        }
        
        if (dateRange && dateRange.endDate) {
            command += ` --end-date ${dateRange.endDate}`;
        }

        console.log(`[Market Data] Exécution de l'enrichissement: ${command}`);
        
        // Exécuter le script Python
        const pythonCommand = process.platform === 'win32' ? 'python' : 'python3';
        command = command.replace('python', pythonCommand);
        
        const { stdout, stderr } = await execAsync(command, {
            cwd: __dirname,
            maxBuffer: 10 * 1024 * 1024,
            env: {
                ...process.env,
                PYTHONUNBUFFERED: '1'
            }
        });

        // Parser la sortie JSON
        let report;
        try {
            const jsonMatch = stdout.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                report = JSON.parse(jsonMatch[0]);
            } else {
                throw new Error('No JSON output found in stdout');
            }
        } catch (parseError) {
            console.error('[Market Data] Erreur de parsing JSON:', parseError);
            console.error('[Market Data] stdout:', stdout);
            console.error('[Market Data] stderr:', stderr);
            
            return {
                success: false,
                error: 'Failed to parse Python script output',
                stdout: stdout,
                stderr: stderr,
                parseError: parseError.message
            };
        }

        if (stderr) {
            console.warn('[Market Data] Warnings/Errors from Python script:', stderr);
        }

        console.log(`[Market Data] Enrichissement terminé: ${report.status || 'unknown'}`);
        
        return {
            success: report.status !== 'failed',
            report: report
        };

    } catch (error) {
        console.error('[Market Data] Erreur lors de l\'exécution du script Python:', error);
        
        return {
            success: false,
            error: error.message,
            code: error.code,
            signal: error.signal
        };
    }
}

/**
 * Exécute le script Python de construction des features marché.
 * 
 * @param {Object} options - Options pour la construction
 * @param {Array<string>} options.cities - Liste de villes (optionnel)
 * @param {Object} options.dateRange - Plage de dates {startDate, endDate} (optionnel)
 * @param {boolean} options.updatePricing - Si true, met à jour features_pricing_daily (défaut: true)
 * @returns {Promise<Object>} Rapport de construction
 */
async function buildMarketFeatures(options = {}) {
    const {
        cities = null,
        dateRange = null,
        updatePricing = true
    } = options;

    try {
        // Construire la commande Python
        let command = 'python -m market_data_pipeline.jobs.build_market_features';
        
        // Ajouter les arguments
        if (dateRange && dateRange.startDate) {
            command += ` --start-date ${dateRange.startDate}`;
        } else {
            // Par défaut, construire pour les 90 prochains jours
            const today = new Date();
            const endDate = new Date();
            endDate.setDate(endDate.getDate() + 90);
            command += ` --start-date ${today.toISOString().split('T')[0]}`;
            command += ` --end-date ${endDate.toISOString().split('T')[0]}`;
        }
        
        if (dateRange && dateRange.endDate) {
            command += ` --end-date ${dateRange.endDate}`;
        }
        
        if (cities && cities.length > 0) {
            command += ` --cities ${cities.join(' ')}`;
        }
        
        if (!updatePricing) {
            command += ' --no-update-pricing';
        }
        
        command += ' --json';

        console.log(`[Market Data] Exécution de la construction des features: ${command}`);
        
        // Exécuter le script Python
        const pythonCommand = process.platform === 'win32' ? 'python' : 'python3';
        command = command.replace('python', pythonCommand);
        
        const { stdout, stderr } = await execAsync(command, {
            cwd: __dirname,
            maxBuffer: 10 * 1024 * 1024,
            env: {
                ...process.env,
                PYTHONUNBUFFERED: '1'
            }
        });

        // Parser la sortie JSON
        let report;
        try {
            const jsonMatch = stdout.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                report = JSON.parse(jsonMatch[0]);
            } else {
                throw new Error('No JSON output found in stdout');
            }
        } catch (parseError) {
            console.error('[Market Data] Erreur de parsing JSON:', parseError);
            console.error('[Market Data] stdout:', stdout);
            console.error('[Market Data] stderr:', stderr);
            
            return {
                success: false,
                error: 'Failed to parse Python script output',
                stdout: stdout,
                stderr: stderr,
                parseError: parseError.message
            };
        }

        if (stderr) {
            console.warn('[Market Data] Warnings/Errors from Python script:', stderr);
        }

        console.log(`[Market Data] Construction des features terminée: ${report.status || 'unknown'}`);
        
        return {
            success: report.status !== 'failed',
            report: report
        };

    } catch (error) {
        console.error('[Market Data] Erreur lors de l\'exécution du script Python:', error);
        
        return {
            success: false,
            error: error.message,
            code: error.code,
            signal: error.signal
        };
    }
}

/**
 * Endpoint API pour déclencher l'enrichissement IA des données marché.
 * POST /api/market-data/enrich
 */
app.post('/api/market-data/enrich', authenticateToken, async (req, res) => {
    try {
        const { dateRange } = req.body;

        console.log('[Market Data] Enrichissement déclenché via API par utilisateur:', req.user.uid);

        const startTime = Date.now();
        const result = await enrichMarketData({
            dateRange
        });
        const duration = (Date.now() - startTime) / 1000;

        if (result.success) {
            res.status(200).json({
                success: true,
                message: 'Enrichissement IA terminé avec succès',
                stats: {
                    status: result.report.status,
                    enrichedRecords: result.report.total_enriched || 0,
                    duration: result.report.duration_seconds || duration
                },
                duration: duration,
                report: result.report
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error || 'Erreur lors de l\'enrichissement',
                duration: duration,
                report: result.report || null,
                details: result
            });
        }

    } catch (error) {
        console.error('[Market Data] Erreur dans l\'endpoint API:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur interne lors de l\'enrichissement des données marché',
            message: error.message
        });
    }
});

/**
 * Endpoint API pour déclencher la construction des features marché.
 * POST /api/market-data/build-features
 */
app.post('/api/market-data/build-features', authenticateToken, async (req, res) => {
    try {
        const { cities, dateRange, updatePricing = true } = req.body;

        console.log('[Market Data] Construction des features déclenchée via API par utilisateur:', req.user.uid);

        const startTime = Date.now();
        const result = await buildMarketFeatures({
            cities,
            dateRange,
            updatePricing
        });
        const duration = (Date.now() - startTime) / 1000;

        if (result.success) {
            res.status(200).json({
                success: true,
                message: 'Construction des features terminée avec succès',
                stats: {
                    status: result.report.status,
                    featuresBuilt: result.report.build_features?.features_built || 0,
                    propertiesUpdated: result.report.update_pricing?.properties_updated || 0,
                    duration: result.report.build_features?.duration_seconds || duration
                },
                duration: duration,
                report: result.report
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error || 'Erreur lors de la construction des features',
                duration: duration,
                report: result.report || null,
                details: result
            });
        }

    } catch (error) {
        console.error('[Market Data] Erreur dans l\'endpoint API:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur interne lors de la construction des features marché',
            message: error.message
        });
    }
});

/**
 * Endpoint API pour récupérer le statut global du pipeline marché.
 * GET /api/market-data/status
 */
app.get('/api/market-data/status', authenticateToken, async (req, res) => {
    try {
        console.log('[Market Data] Statut demandé par utilisateur:', req.user.uid);

        // Récupérer les dernières exécutions de chaque job depuis pipeline_logs_market
        const { data: collectJobs, error: collectError } = await supabase
            .from('pipeline_logs_market')
            .select('*')
            .eq('job_name', 'collect_market_data')
            .order('start_time', { ascending: false })
            .limit(5);

        const { data: enrichJobs, error: enrichError } = await supabase
            .from('pipeline_logs_market')
            .select('*')
            .eq('job_name', 'enrich_market_data')
            .order('start_time', { ascending: false })
            .limit(5);

        const { data: buildJobs, error: buildError } = await supabase
            .from('pipeline_logs_market')
            .select('*')
            .eq('job_name', 'build_market_features')
            .order('start_time', { ascending: false })
            .limit(5);

        // Récupérer les jobs en cours
        const { data: runningJobs, error: runningError } = await supabase
            .from('pipeline_logs_market')
            .select('*')
            .eq('status', 'running')
            .order('start_time', { ascending: true });

        // Calculer les statistiques globales
        const lastCollect = collectJobs && collectJobs.length > 0 ? collectJobs[0] : null;
        const lastEnrich = enrichJobs && enrichJobs.length > 0 ? enrichJobs[0] : null;
        const lastBuild = buildJobs && buildJobs.length > 0 ? buildJobs[0] : null;

        // Statistiques de succès (7 derniers jours)
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const { data: recentJobs, error: recentError } = await supabase
            .from('pipeline_logs_market')
            .select('job_name, status')
            .gte('start_time', sevenDaysAgo.toISOString());

        const stats = {
            collect: {
                total: 0,
                success: 0,
                failed: 0,
                partial: 0
            },
            enrich: {
                total: 0,
                success: 0,
                failed: 0,
                partial: 0
            },
            build: {
                total: 0,
                success: 0,
                failed: 0,
                partial: 0
            }
        };

        if (recentJobs) {
            recentJobs.forEach(job => {
                let jobStats = null;
                
                // Déterminer le type de job
                if (job.job_name === 'collect_market_data') {
                    jobStats = stats.collect;
                } else if (job.job_name === 'enrich_market_data') {
                    jobStats = stats.enrich;
                } else if (job.job_name === 'build_market_features') {
                    jobStats = stats.build;
                }
                
                if (jobStats) {
                    jobStats.total++;
                    if (job.status === 'success') jobStats.success++;
                    else if (job.status === 'failed') jobStats.failed++;
                    else if (job.status === 'partial') jobStats.partial++;
                }
            });
        }

        res.status(200).json({
            success: true,
            status: {
                lastCollect: lastCollect ? {
                    status: lastCollect.status,
                    startTime: lastCollect.start_time,
                    endTime: lastCollect.end_time,
                    duration: lastCollect.duration_seconds,
                    recordsProcessed: lastCollect.records_processed,
                    recordsSuccess: lastCollect.records_success,
                    recordsFailed: lastCollect.records_failed
                } : null,
                lastEnrich: lastEnrich ? {
                    status: lastEnrich.status,
                    startTime: lastEnrich.start_time,
                    endTime: lastEnrich.end_time,
                    duration: lastEnrich.duration_seconds,
                    recordsProcessed: lastEnrich.records_processed,
                    recordsSuccess: lastEnrich.records_success,
                    recordsFailed: lastEnrich.records_failed
                } : null,
                lastBuild: lastBuild ? {
                    status: lastBuild.status,
                    startTime: lastBuild.start_time,
                    endTime: lastBuild.end_time,
                    duration: lastBuild.duration_seconds,
                    recordsProcessed: lastBuild.records_processed,
                    recordsSuccess: lastBuild.records_success,
                    recordsFailed: lastBuild.records_failed
                } : null,
                runningJobs: runningJobs ? runningJobs.map(job => ({
                    jobName: job.job_name,
                    jobType: job.job_type,
                    startTime: job.start_time
                })) : [],
                stats: stats
            }
        });

    } catch (error) {
        console.error('[Market Data] Erreur dans l\'endpoint status:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur interne lors de la récupération du statut',
            message: error.message
        });
    }
});

/**
 * Endpoint API pour récupérer les features marché.
 * GET /api/market-data/features
 */
app.get('/api/market-data/features', authenticateToken, async (req, res) => {
    try {
        const { city, country, date, neighborhood } = req.query;

        // Validation des paramètres requis
        if (!city || !country || !date) {
            return res.status(400).json({
                success: false,
                error: 'Paramètres manquants: city, country et date sont requis',
                required: ['city', 'country', 'date']
            });
        }

        // Validation du format de date
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(date)) {
            return res.status(400).json({
                success: false,
                error: 'Format de date invalide. Utilisez YYYY-MM-DD'
            });
        }

        console.log(`[Market Data] Features demandées: city=${city}, country=${country}, date=${date}, neighborhood=${neighborhood || 'all'}`);

        // Construire la requête
        let query = supabase
            .from('market_features')
            .select('*')
            .eq('city', city)
            .eq('country', country)
            .eq('date', date);

        if (neighborhood) {
            query = query.eq('neighborhood', neighborhood);
        }

        const { data: features, error } = await query.order('created_at', { ascending: false }).limit(1);

        if (error) {
            console.error('[Market Data] Erreur Supabase:', error);
            return res.status(500).json({
                success: false,
                error: 'Erreur lors de la récupération des features',
                details: error.message
            });
        }

        if (!features || features.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Aucune feature trouvée pour les critères spécifiés',
                query: { city, country, date, neighborhood: neighborhood || 'all' }
            });
        }

        res.status(200).json({
            success: true,
            features: features[0],
            query: { city, country, date, neighborhood: neighborhood || 'all' }
        });

    } catch (error) {
        console.error('[Market Data] Erreur dans l\'endpoint features:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur interne lors de la récupération des features',
            message: error.message
        });
    }
});

/**
 * Endpoint API pour récupérer les prix concurrents.
 * GET /api/market-data/competitor-prices
 */
app.get('/api/market-data/competitor-prices', authenticateToken, async (req, res) => {
    try {
        const { city, country, date } = req.query;

        // Validation des paramètres requis
        if (!city || !country || !date) {
            return res.status(400).json({
                success: false,
                error: 'Paramètres manquants: city, country et date sont requis',
                required: ['city', 'country', 'date']
            });
        }

        // Validation du format de date
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(date)) {
            return res.status(400).json({
                success: false,
                error: 'Format de date invalide. Utilisez YYYY-MM-DD'
            });
        }

        console.log(`[Market Data] Prix concurrents demandés: city=${city}, country=${country}, date=${date}`);

        // Récupérer depuis enriched_competitor_data ou raw_competitor_data
        // On essaie d'abord enriched_competitor_data pour avoir les données enrichies
        let { data: enrichedData, error: enrichedError } = await supabase
            .from('enriched_competitor_data')
            .select('*')
            .eq('city', city)
            .eq('country', country)
            .eq('date', date)
            .order('created_at', { ascending: false })
            .limit(10);

        // Si pas de données enrichies, essayer raw_competitor_data
        if ((!enrichedData || enrichedData.length === 0) && enrichedError === null) {
            const { data: rawData, error: rawError } = await supabase
                .from('raw_competitor_data')
                .select('*')
                .eq('city', city)
                .eq('country', country)
                .eq('date', date)
                .order('collected_at', { ascending: false })
                .limit(10);

            if (rawError) {
                console.error('[Market Data] Erreur Supabase (raw):', rawError);
                return res.status(500).json({
                    success: false,
                    error: 'Erreur lors de la récupération des prix concurrents',
                    details: rawError.message
                });
            }

            enrichedData = rawData;
        } else if (enrichedError) {
            console.error('[Market Data] Erreur Supabase (enriched):', enrichedError);
            return res.status(500).json({
                success: false,
                error: 'Erreur lors de la récupération des prix concurrents',
                details: enrichedError.message
            });
        }

        if (!enrichedData || enrichedData.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Aucun prix concurrent trouvé pour les critères spécifiés',
                query: { city, country, date }
            });
        }

        // Agréger les prix si plusieurs résultats
        const prices = enrichedData.map(item => ({
            avgPrice: item.avg_price || item.price_data?.avg_price,
            minPrice: item.min_price || item.price_data?.min_price,
            maxPrice: item.max_price || item.price_data?.max_price,
            currency: item.currency || 'EUR',
            sampleSize: item.sample_size || item.price_data?.sample_size || 0,
            propertyType: item.property_type,
            neighborhood: item.neighborhood,
            collectedAt: item.collected_at || item.created_at
        }));

        res.status(200).json({
            success: true,
            prices: prices,
            summary: {
                count: prices.length,
                avgPrice: prices.reduce((sum, p) => sum + (p.avgPrice || 0), 0) / prices.length,
                minPrice: Math.min(...prices.map(p => p.minPrice || Infinity).filter(p => p !== Infinity)),
                maxPrice: Math.max(...prices.map(p => p.maxPrice || 0).filter(p => p > 0))
            },
            query: { city, country, date }
        });

    } catch (error) {
        console.error('[Market Data] Erreur dans l\'endpoint competitor-prices:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur interne lors de la récupération des prix concurrents',
            message: error.message
        });
    }
});

// --- DÉMARRAGE DU SERVEUR ---
// GET /api/reports/market-kpis - KPIs du marché basés sur market_features
app.get('/api/reports/market-kpis', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const { startDate, endDate, city, country } = req.query;

        if (!startDate || !endDate) {
            return res.status(400).send({ error: 'Les dates de début et de fin sont requises.' });
        }

        // 1. Récupérer le teamId et les propriétés de l'utilisateur
        const { teamId, userProfile } = await getOrInitializeTeamId(userId);

        // 2. Récupérer les propriétés actives pour obtenir leurs villes/pays
        const properties = await db.getPropertiesByTeam(teamId);
        if (!properties || properties.length === 0) {
            return res.status(200).json({
                competitor_avg_price: 0,
                market_demand_level: 'unknown',
                weather_score: 0,
                event_impact_score: 0,
                trend_score: 0,
                data_quality_score: 0
            });
        }

        // 3. Extraire les villes/pays uniques des propriétés
        const locations = new Set();
        properties.forEach(prop => {
            // Extraire city et country (peuvent être dans différents champs)
            const propCity = prop.city || prop.location || (prop.address?.city);
            const propCountry = prop.country || (prop.address?.country) || 'FR';
            
            if (propCity && propCountry) {
                locations.add(`${propCountry}:${propCity}`);
            }
        });

        // 4. Filtrer par ville/pays si spécifié
        let targetLocations = Array.from(locations);
        if (city && country) {
            targetLocations = targetLocations.filter(loc => loc === `${country}:${city}`);
        }

        if (targetLocations.length === 0) {
            return res.status(200).json({
                competitor_avg_price: 0,
                market_demand_level: 'unknown',
                weather_score: 0,
                event_impact_score: 0,
                trend_score: 0,
                data_quality_score: 0
            });
        }

        // 5. Construire la requête Supabase pour récupérer les market_features
        // Récupérer les features pour la plage de dates
        let allFeatures = [];
        
        for (const loc of targetLocations) {
            const [locCountry, locCity] = loc.split(':');
            
            const { data: features, error } = await supabase
                .from('market_features')
                .select('*')
                .eq('country', locCountry)
                .eq('city', locCity)
                .gte('date', startDate)
                .lte('date', endDate)
                .order('date', { ascending: true });

            if (error) {
                console.error(`Error fetching market features for ${locCity}, ${locCountry}:`, error);
                continue;
            }

            if (features && features.length > 0) {
                allFeatures = allFeatures.concat(features);
            }
        }

        if (allFeatures.length === 0) {
            return res.status(200).json({
                competitor_avg_price: 0,
                market_demand_level: 'unknown',
                weather_score: 0,
                event_impact_score: 0,
                trend_score: 0,
                data_quality_score: 0,
                message: 'Aucune donnée marché disponible pour cette période'
            });
        }

        // 6. Calculer les KPIs agrégés
        const featuresWithPrice = allFeatures.filter(f => f.competitor_avg_price != null);
        const avgCompetitorPrice = featuresWithPrice.length > 0
            ? featuresWithPrice.reduce((sum, f) => sum + (f.competitor_avg_price || 0), 0) / featuresWithPrice.length
            : 0;

        const featuresWithWeather = allFeatures.filter(f => f.weather_score != null);
        const avgWeatherScore = featuresWithWeather.length > 0
            ? featuresWithWeather.reduce((sum, f) => sum + (f.weather_score || 0), 0) / featuresWithWeather.length
            : 0;

        const featuresWithEvent = allFeatures.filter(f => f.expected_demand_impact != null);
        const avgEventImpact = featuresWithEvent.length > 0
            ? featuresWithEvent.reduce((sum, f) => sum + (f.expected_demand_impact || 0), 0) / featuresWithEvent.length
            : 0;

        const featuresWithTrend = allFeatures.filter(f => f.market_trend_score != null);
        const avgTrendScore = featuresWithTrend.length > 0
            ? featuresWithTrend.reduce((sum, f) => sum + (f.market_trend_score || 0), 0) / featuresWithTrend.length
            : 0;

        const featuresWithQuality = allFeatures.filter(f => f.data_quality_score != null);
        const avgDataQuality = featuresWithQuality.length > 0
            ? featuresWithQuality.reduce((sum, f) => sum + (f.data_quality_score || 0), 0) / featuresWithQuality.length
            : 0;

        // Déterminer le niveau de demande moyen
        // market_demand_level n'existe pas directement dans market_features, on le calcule
        // à partir des signaux disponibles (tendance, événements, météo)
        let marketDemandLevel = 'unknown';
        const demandSignals = {
            trend: avgTrendScore > 0.3 ? 1 : (avgTrendScore < -0.3 ? -1 : 0),
            events: avgEventImpact > 20 ? 1 : (avgEventImpact < -20 ? -1 : 0),
            weather: avgWeatherScore > 70 ? 1 : (avgWeatherScore < 40 ? -1 : 0)
        };
        const totalSignal = demandSignals.trend + demandSignals.events + demandSignals.weather;
        
        if (totalSignal >= 2) {
            marketDemandLevel = 'very_high';
        } else if (totalSignal >= 1) {
            marketDemandLevel = 'high';
        } else if (totalSignal >= -1) {
            marketDemandLevel = 'medium';
        } else {
            marketDemandLevel = 'low';
        }

        // 7. Statistiques additionnelles
        const competitorStats = {
            avg: avgCompetitorPrice,
            min: featuresWithPrice.length > 0 
                ? Math.min(...featuresWithPrice.map(f => f.competitor_min_price || f.competitor_avg_price))
                : null,
            max: featuresWithPrice.length > 0
                ? Math.max(...featuresWithPrice.map(f => f.competitor_max_price || f.competitor_avg_price))
                : null,
            median: featuresWithPrice.length > 0
                ? featuresWithPrice.reduce((sum, f) => sum + (f.competitor_p50_price || f.competitor_avg_price || 0), 0) / featuresWithPrice.length
                : 0
        };

        const totalEvents = allFeatures.reduce((sum, f) => sum + (f.event_count || 0), 0);
        const majorEventsCount = allFeatures.filter(f => f.has_major_event === true).length;

        res.status(200).json({
            // KPIs principaux
            competitor_avg_price: Math.round(avgCompetitorPrice * 100) / 100,
            market_demand_level: marketDemandLevel,
            weather_score: Math.round(avgWeatherScore * 100) / 100,
            event_impact_score: Math.round(avgEventImpact * 100) / 100,
            trend_score: Math.round(avgTrendScore * 100) / 100,
            data_quality_score: Math.round(avgDataQuality * 100) / 100,

            // Statistiques détaillées
            competitor_stats: {
                avg: Math.round(competitorStats.avg * 100) / 100,
                min: competitorStats.min !== null && competitorStats.min !== Infinity ? Math.round(competitorStats.min * 100) / 100 : null,
                max: competitorStats.max !== null && competitorStats.max !== -Infinity ? Math.round(competitorStats.max * 100) / 100 : null,
                median: Math.round(competitorStats.median * 100) / 100
            },

            // Événements
            total_events: totalEvents,
            major_events_count: majorEventsCount,

            // Métadonnées
            locations_analyzed: targetLocations.length,
            date_range: { start: startDate, end: endDate },
            data_points: allFeatures.length
        });

    } catch (error) {
        console.error('Erreur lors du calcul des KPIs marché:', error);
        res.status(500).send({ error: 'Erreur serveur lors du calcul des KPIs marché.' });
    }
});

app.listen(port, () => {
  console.log(`Le serveur écoute sur le port ${port}`);
});