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

// Helper pour savoir si on est sur Windows (pour la commande python)
const PYTHON_COMMAND = process.platform === 'win32' ? 'python' : 'python3';

// --- IMPORT DES UTILITAIRES DE SANITISATION ---
const { sanitizeForPrompt, validateAndSanitizeDate, validateDateRange, validateDateFormat, validateNumber, sanitizeNumber, sanitizeArray, validateStringLength, sanitizeUrl, sanitizeFilename, safeJSONStringify, validatePropertyObject, validatePropertyId, validatePrice, validatePercentage, validateCapacity, validateInteger, validateEnum, validateTimezone } = require('./utils/promptSanitizer');
const { ALLOWED_STRATEGIES } = require('./utils/whitelists');
const { sanitizePropertyId: sanitizePropertyIdStrict, sanitizeDate: sanitizeDateStrict, sanitizePricingParams, ValidationError: InputValidationError } = require('./utils/input_sanitizer');

// --- IMPORT DU SYSTÈME DE MONITORING DES INJECTIONS ---
const { 
    checkInjectionMiddleware, 
    getUserStats, 
    resetUserAttempts,
    analyzeInput 
} = require('./utils/injectionMonitor');

// --- IMPORT DU BRIDGE PRICING ENGINE (Processus Persistant) ---
const pricingBridge = require('./utils/pythonBridge');
// Fallback vers l'ancien bridge pour simulatePrices si nécessaire
const oldPricingBridge = require('./pricing_engine_bridge');

// --- IMPORT DU MODULE DE SÉCURITÉ POUR LES PRIX ---
const { validatePrice: validatePriceSafety } = require('./utils/safety_guardrails');

// --- IMPORT DU MODULE DE PRICING DÉTERMINISTE (Fallback) ---
const deterministicPricing = require('./utils/deterministic_pricing');

// --- IMPORT DES UTILITAIRES DE DATES ---
const { getDatesBetween } = require('./utils/dateUtils');

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

// --- MIDDLEWARE DE MONITORING DES INJECTIONS ---
// Enregistrer l'endpoint actuel dans le contexte global pour le monitoring
app.use((req, res, next) => {
    global.currentRequestEndpoint = req.path || req.route?.path || 'unknown';
    next();
});

// Appliquer le middleware de monitoring des injections sur toutes les routes API
app.use('/api', checkInjectionMiddleware);

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

/**
 * Middleware Express pour valider et sanitizer les requêtes de pricing
 * Valide propertyId, dates, et paramètres optionnels selon une whitelist stricte
 * Remplace req.body par une version sécurisée
 */
const validatePricingRequest = (req, res, next) => {
  try {
    const { property_id, propertyId, date, startDate, endDate, ...otherParams } = req.body;

    // Support des deux formats: property_id et propertyId
    const propertyIdToValidate = property_id || propertyId;
    
    // 1. Validation ID
    const safePropertyId = sanitizePropertyIdStrict(propertyIdToValidate);

    // 2. Validation Date (pour /api/pricing/recommend et /api/pricing/simulate)
    let safeDate = null;
    if (date) {
      safeDate = sanitizeDateStrict(date);
    }

    // 3. Validation Dates de plage (pour les futures routes avec dateRange)
    let safeStartDate = null;
    let safeEndDate = null;
    if (startDate) {
      safeStartDate = sanitizeDateStrict(startDate);
    }
    if (endDate) {
      safeEndDate = sanitizeDateStrict(endDate);
      // Vérifier que la date de fin est après la date de début
      if (safeStartDate && safeEndDate < safeStartDate) {
        throw new InputValidationError("La date de fin doit être après la date de début.", "endDate");
      }
    }

    // 4. Validation Paramètres optionnels (Whitelist)
    const safeParams = sanitizePricingParams(otherParams);

    // 5. Remplacement du body par les données sécurisées
    // On écrase req.body pour être sûr que le contrôleur suivant n'utilise QUE des données propres
    const sanitizedBody = {
      property_id: safePropertyId,
      propertyId: safePropertyId, // Support des deux formats
    };

    if (safeDate) {
      sanitizedBody.date = safeDate;
    }

    if (safeStartDate || safeEndDate) {
      sanitizedBody.dateRange = {};
      if (safeStartDate) sanitizedBody.dateRange.start = safeStartDate;
      if (safeEndDate) sanitizedBody.dateRange.end = safeEndDate;
    }

    // Ajouter les paramètres optionnels sanitizés
    Object.assign(sanitizedBody, safeParams);

    // Préserver les champs spéciaux qui ne sont pas dans la whitelist mais nécessaires
    // (ex: room_type, price_grid pour simulate)
    if (otherParams.room_type && typeof otherParams.room_type === 'string') {
      sanitizedBody.room_type = otherParams.room_type.trim();
    }
    if (Array.isArray(otherParams.price_grid)) {
      // Validation basique de la grille de prix (nombres positifs)
      const validPriceGrid = otherParams.price_grid
        .map(p => parseFloat(p))
        .filter(p => !isNaN(p) && p > 0 && p < 100000);
      if (validPriceGrid.length > 0) {
        sanitizedBody.price_grid = validPriceGrid;
      }
    }

    req.body = sanitizedBody;
    next();

  } catch (error) {
    if (error instanceof InputValidationError) {
      return res.status(400).json({
        status: 'error',
        code: 'VALIDATION_ERROR',
        field: error.field,
        message: error.message
      });
    }
    // Erreur technique imprévue
    console.error("Erreur Sanitization:", error);
    return res.status(500).json({ 
      status: 'error',
      code: 'INTERNAL_ERROR',
      message: "Erreur interne lors de la validation des données." 
    });
  }
};

// Importer les helpers Supabase
const db = require('./helpers/supabaseDb.js');

/**
 * Middleware Express pour vérifier et incrémenter le quota IA avant un appel IA
 * Doit être placé APRÈS authenticateToken mais AVANT l'appel à l'IA
 * @param {Request} req - Objet request Express
 * @param {Response} res - Objet response Express
 * @param {Function} next - Fonction next Express
 */
const checkAIQuota = async (req, res, next) => {
    try {
        // 1. Extraire le userId de req.user.uid (après authenticateToken)
        const userId = req.user?.uid;
        
        if (!userId) {
            return res.status(401).send({ error: 'Utilisateur non authentifié.' });
        }
        
        // 2. Appeler checkAndIncrementAIQuota AVANT l'appel IA
        // Note: On incrémente AVANT l'appel car si l'appel échoue, on ne veut pas compter dans le quota
        // Mais on peut aussi incrémenter APRÈS si on préfère ne compter que les appels réussis
        // Pour l'instant, on incrémente AVANT comme spécifié dans le prompt
        const quotaResult = await checkAndIncrementAIQuota(userId, 0); // tokensUsed sera mis à jour après l'appel
        
        // 3. Si allowed: false, retourner une réponse 429
        if (!quotaResult.allowed) {
            // Calculer l'heure de réinitialisation (minuit UTC du jour suivant)
            const now = new Date();
            const tomorrow = new Date(now);
            tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
            tomorrow.setUTCHours(0, 0, 0, 0);
            const resetAt = tomorrow.toISOString();
            
            return res.status(429).send({
                error: "Quota IA atteint",
                message: "Vous avez atteint votre limite quotidienne d'appels IA",
                limit: quotaResult.limit || 0,
                used: quotaResult.callsToday || 0,
                remaining: 0,
                resetAt: resetAt,
                resetAtHuman: "demain à minuit UTC"
            });
        }
        
        // 4. Si allowed: true, attacher aiQuota à req.aiQuota et passer au middleware suivant
        req.aiQuota = {
            ...quotaResult,
            userId: userId
        };
        
        next();
        
    } catch (error) {
        console.error('[AI Quota Middleware] Erreur lors de la vérification du quota:', error);
        // En cas d'erreur, refuser l'accès par sécurité
        return res.status(500).send({
            error: "Erreur lors de la vérification du quota IA",
            message: "Une erreur est survenue lors de la vérification de votre quota. Veuillez réessayer."
        });
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
 * ⚠️ IMPORTANT : Mettez à jour les valeurs ci-dessous si vos tarifs Stripe changent !
 * 
 * Paliers de tarification (PRIX EN CENTIMES) :
 * - 1ère unité : €13.99/mo (1399 centimes)
 * - Unités 2-5 : €11.99/mo (1199 centimes) - 4 unités
 * - Unités 6-15 : €8.99/mo (899 centimes) - 10 unités
 * - Unités 16-30 : €5.49/mo (549 centimes) - 15 unités
 * - 30+ unités : €3.99/mo (399 centimes)
 * 
 * Pour modifier les tarifs :
 * 1. Mettez à jour les valeurs dans le tableau TIERS ci-dessous
 * 2. Mettez à jour les commentaires pour refléter les nouveaux prix
 * 3. Vérifiez que les valeurs correspondent exactement à vos produits Stripe
 * 
 * @param {number} quantityPrincipal - Nombre total de Parent Units
 * @returns {Object} - { totalAmount, breakdown } où totalAmount est en centimes et breakdown détaille chaque palier
 */
function calculateTieredPricing(quantityPrincipal) {
    if (quantityPrincipal === 0) {
        return { totalAmount: 0, breakdown: [] };
    }
    
    // ⚠️ CONFIGURATION DES TARIFS - MODIFIEZ ICI SI VOS PRIX STRIPE CHANGENT ⚠️
    // Prix en centimes par palier (ex: 1399 = 13.99€)
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
 * NOUVELLE LOGIQUE EN 3 ÉTAPES (basée sur l'état "Activé/Désactivé") :
 * 
 * 1. PRIORITÉ AUX GROUPES ACTIFS (Le "Tarif Famille")
 *    - Vérifie si "Pricing Automatique" (sync_prices) est activé au niveau du groupe
 *    - Si OUI : Première propriété = Principale, autres = Enfants (marquées comme "traitées")
 *    - Si NON : Le groupe est ignoré, propriétés passent à l'étape 2
 * 
 * 2. PROPRIÉTÉS INDIVIDUELLES (Le "Tarif Solo")
 *    - Pour les propriétés non traitées (sans groupe actif ou groupe inactif)
 *    - Vérifie si "Pricing Automatique" (auto_pricing_enabled) est activé individuellement
 *    - Si OUI : Propriété = Principale (fonctionne en autonomie)
 *    - Si NON : Propriété inactive (coût 0)
 * 
 * 3. EXCLUSION (Coût Zéro)
 *    - Propriétés ni dans un groupe actif ni activées individuellement = coût 0€
 * 
 * @param {Array} userProperties - Liste des propriétés de l'utilisateur (avec auto_pricing_enabled)
 * @param {Array} userGroups - Liste des groupes de l'utilisateur (avec sync_prices et propriétés incluses)
 * @returns {Object} - { quantityPrincipal, quantityChild }
 */
function calculateBillingQuantities(userProperties, userGroups) {
    let quantityPrincipal = 0; 
    let quantityChild = 0;     

    // Set pour marquer les propriétés déjà traitées (dans un groupe actif)
    const processedProperties = new Set();
    
    // Créer un Map pour accéder rapidement aux propriétés par ID
    const propertiesMap = new Map();
    userProperties.forEach(prop => {
        const propId = typeof prop === 'string' ? prop : (prop.id || prop.property_id);
        if (propId) {
            propertiesMap.set(propId, typeof prop === 'string' ? {} : prop);
        }
    });
    
    // ÉTAPE 1 : Priorité aux Groupes Actifs (Le "Tarif Famille")
    userGroups.forEach(group => {
        // Vérifier si le "Pricing Automatique" est activé au niveau du groupe
        const syncPrices = group.sync_prices || group.syncPrices || false;
        
        if (!syncPrices) {
            // Groupe inactif : ignorer pour l'instant, les propriétés passeront à l'étape 2
            return;
        }
        
        const groupProperties = group.properties || [];
        
        if (groupProperties.length === 0) {
            return; // Groupe vide, ignorer
        }
        
        // Convertir toutes les propriétés en IDs
        const groupPropertyIds = groupProperties.map(prop => {
            return typeof prop === 'string' ? prop : (prop.id || prop.property_id);
        }).filter(Boolean);
        
        if (groupPropertyIds.length === 0) {
            return; // Aucune propriété valide dans le groupe
        }
        
        // Identifier la propriété principale du groupe
        const mainPropertyId = group.mainPropertyId || group.main_property_id;
        let principalPropertyId;
        
        if (mainPropertyId && groupPropertyIds.includes(mainPropertyId)) {
            principalPropertyId = mainPropertyId;
        } else {
            // Fallback : utiliser la première propriété
            principalPropertyId = groupPropertyIds[0];
        }
        
        // Compter la propriété principale comme PROPRIÉTÉ PRINCIPALE (tarif plein)
        if (principalPropertyId) {
            quantityPrincipal += 1;
            processedProperties.add(principalPropertyId);
        }
        
        // Compter les autres propriétés du groupe comme PROPRIÉTÉS ENFANTS (tarif réduit)
        const childPropertyIds = groupPropertyIds.filter(id => id !== principalPropertyId);
        quantityChild += childPropertyIds.length;
        
        // Marquer toutes les propriétés du groupe comme "traitées"
        groupPropertyIds.forEach(propId => {
            processedProperties.add(propId);
        });
    });

    // ÉTAPE 2 : Propriétés Individuelles (Le "Tarif Solo")
    // Traiter uniquement les propriétés non traitées à l'étape 1
    userProperties.forEach(prop => {
        const propId = typeof prop === 'string' ? prop : (prop.id || prop.property_id);
        
        if (!propId || processedProperties.has(propId)) {
            return; // Propriété déjà traitée ou ID invalide
        }
        
        // Vérifier si le "Pricing Automatique" est activé individuellement
        const autoPricingEnabled = prop.auto_pricing_enabled || prop.autoPricingEnabled || false;
        
        if (autoPricingEnabled) {
            // Propriété activée individuellement = PROPRIÉTÉ PRINCIPALE (tarif plein)
            quantityPrincipal += 1;
            processedProperties.add(propId);
        }
        // Si non activée : propriété inactive (coût 0), on ne fait rien
    });

    // ÉTAPE 3 : Exclusion (Coût Zéro)
    // Les propriétés qui ne sont ni dans un groupe actif ni activées individuellement
    // ne sont pas comptées (déjà géré par la logique ci-dessus)

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
            
            // ⚠️ CONFIGURATION DU PRIX DES PROPRIÉTÉS ENFANTS (Child Units)
            // Prix fixe pour les Child Units (en centimes)
            // ⚠️ IMPORTANT : Modifiez cette valeur si votre tarif pour les propriétés enfants change dans Stripe
            // Cette valeur doit correspondre à CHILD_UNIT_PRICE_CENTS dans /api/reports/kpis
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

/** Verrous par langue pour éviter les régénérations concurrentes des actualités (GET /api/news). */
const ongoingGenerations = {};

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
        
        // Récupérer le prix de l'abonnement depuis Stripe si disponible
        let subscriptionPrice = null;
        const subscriptionId = userData.stripe_subscription_id || userData.stripeSubscriptionId;
        if (subscriptionId) {
            try {
                const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
                const subscription = await stripe.subscriptions.retrieve(subscriptionId);
                
                // Calculer le prix total mensuel de l'abonnement
                if (subscription.items && subscription.items.data && subscription.items.data.length > 0) {
                    console.log(`[Profile] ${subscription.items.data.length} item(s) d'abonnement trouvé(s)`);
                    let totalAmount = 0;
                    const userCurrency = userData.currency || 'EUR';
                    
                    subscription.items.data.forEach((item, index) => {
                        console.log(`[Profile] Item ${index + 1}:`, {
                            priceId: item.price?.id,
                            unitAmount: item.price?.unit_amount,
                            currency: item.price?.currency,
                            quantity: item.quantity,
                            interval: item.price?.recurring?.interval
                        });
                        if (item.price && item.price.unit_amount) {
                            // unit_amount est en centimes, on le convertit en unité de devise
                            let itemPrice = (item.price.unit_amount / 100) * (item.quantity || 1);
                            const itemCurrency = item.price.currency?.toUpperCase() || 'EUR';
                            
                            // Convertir en euros si nécessaire (taux de change approximatif, à améliorer avec une API)
                            if (itemCurrency !== 'EUR') {
                                if (itemCurrency === 'USD') {
                                    // Taux de change USD vers EUR (approximatif, idéalement utiliser une API de taux de change)
                                    const usdToEurRate = 0.92; // Taux approximatif janvier 2025
                                    const originalPrice = itemPrice;
                                    itemPrice = itemPrice * usdToEurRate;
                                    console.log(`[Profile] Conversion ${itemCurrency} -> EUR: ${originalPrice.toFixed(2)} ${itemCurrency} = ${itemPrice.toFixed(2)} EUR (taux: ${usdToEurRate})`);
                                } else {
                                    console.warn(`[Profile] Devise non supportée pour conversion: ${itemCurrency}. Utilisation de la valeur brute (peut être incorrecte).`);
                                }
                            }
                            
                            // Prendre en compte la périodicité (interval) du prix
                            // Si l'abonnement est annuel, diviser par 12 pour obtenir le prix mensuel
                            if (item.price.recurring && item.price.recurring.interval) {
                                const interval = item.price.recurring.interval;
                                const originalPrice = itemPrice;
                                
                                if (interval === 'year') {
                                    itemPrice = itemPrice / 12; // Convertir le prix annuel en mensuel
                                } else if (interval === 'week') {
                                    itemPrice = itemPrice * (52 / 12); // Convertir le prix hebdomadaire en mensuel (approximatif)
                                } else if (interval === 'day') {
                                    itemPrice = itemPrice * 30; // Convertir le prix journalier en mensuel (approximatif)
                                }
                                // Si interval === 'month', on garde le prix tel quel
                                
                                console.log(`[Profile] Item: ${itemPrice.toFixed(2)}€/mois (${originalPrice.toFixed(2)}€/${interval}, quantité: ${item.quantity || 1})`);
                            } else {
                                console.log(`[Profile] Item: ${itemPrice.toFixed(2)}€ (quantité: ${item.quantity || 1}, devise originale: ${itemCurrency})`);
                            }
                            
                            totalAmount += itemPrice;
                        }
                    });
                    subscriptionPrice = Math.round(totalAmount * 100) / 100; // Arrondir à 2 décimales
                    console.log(`[Profile] Prix total mensuel calculé: ${subscriptionPrice}€ (devise préférée utilisateur: ${userCurrency})`);
                }
            } catch (stripeError) {
                console.warn(`[Profile] Erreur lors de la récupération du prix de l'abonnement:`, stripeError.message);
                // Continuer sans le prix si l'erreur n'est pas critique
            }
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
            stripeSubscriptionId: userData.stripe_subscription_id || userData.stripeSubscriptionId,
            subscriptionPrice: subscriptionPrice,
            monthlyPrice: subscriptionPrice // Alias pour compatibilité
        };
        
        res.status(200).json(formattedData);
    } catch (error) {
        console.error('Erreur lors de la récupération du profil:', error);
        res.status(500).send({ error: 'Erreur lors de la récupération du profil.' });
    }
});

/**
 * GET /api/users/mon-cout-abonnement
 * Retourne le coût mensuel réel de l'abonnement pour l'utilisateur connecté,
 * calculé à partir de ses propriétés, groupes et de la grille tarifaire (paliers + enfants).
 * Utilisé par le frontend (ex: graphique ROI) pour afficher un coût exact au lieu d'une estimation.
 */
app.get('/api/users/mon-cout-abonnement', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const userProfile = await db.getUser(userId);
        if (!userProfile) {
            return res.status(404).json({ error: 'Profil utilisateur non trouvé.' });
        }

        const teamId = userProfile.team_id || userId;
        const userProperties = await db.getPropertiesByTeam(teamId);
        const userGroups = await db.getGroupsByOwner(userId);

        const quantities = calculateBillingQuantities(userProperties || [], userGroups || []);
        const { totalAmount: principalCents } = calculateTieredPricing(quantities.quantityPrincipal);

        const CHILD_UNIT_PRICE_CENTS = 399; // 3.99€ par unité enfant par mois
        const childCents = quantities.quantityChild * CHILD_UNIT_PRICE_CENTS;
        const totalCents = principalCents + childCents;
        const amountEur = Math.round(totalCents) / 100;

        res.status(200).json({
            amountEur,
            quantityPrincipal: quantities.quantityPrincipal,
            quantityChild: quantities.quantityChild
        });
    } catch (error) {
        console.error('[mon-cout-abonnement] Erreur:', error);
        res.status(500).json({ error: 'Erreur lors du calcul du coût d\'abonnement.', details: error.message });
    }
});

// GET /api/users/ai-quota - Récupérer le quota IA de l'utilisateur
/**
 * GET /api/users/injection-stats - Récupère les statistiques de monitoring des injections pour l'utilisateur
 */
app.get('/api/users/injection-stats', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const stats = getUserStats(userId);
        
        res.json({
            success: true,
            stats: stats
        });
    } catch (error) {
        console.error('[Injection Stats] Erreur:', error);
        res.status(500).json({ error: 'Erreur lors de la récupération des statistiques' });
    }
});

/**
 * POST /api/admin/reset-injection-attempts/:userId - Réinitialise les tentatives d'injection d'un utilisateur (admin seulement)
 */
app.post('/api/admin/reset-injection-attempts/:userId', authenticateToken, async (req, res) => {
    try {
        const adminUserId = req.user.uid;
        const targetUserId = req.params.userId;
        
        // TODO: Vérifier que l'utilisateur est admin
        // Pour l'instant, on permet à n'importe quel utilisateur authentifié de réinitialiser ses propres tentatives
        if (adminUserId !== targetUserId) {
            // Vérifier si l'utilisateur est admin (vous pouvez ajouter cette vérification)
            // const userProfile = await db.getUser(adminUserId);
            // if (!userProfile || userProfile.role !== 'admin') {
            //     return res.status(403).json({ error: 'Accès refusé. Admin seulement.' });
            // }
            return res.status(403).json({ error: 'Vous ne pouvez réinitialiser que vos propres tentatives.' });
        }
        
        resetUserAttempts(targetUserId);
        
        res.json({
            success: true,
            message: `Tentatives d'injection réinitialisées pour l'utilisateur ${targetUserId}`
        });
    } catch (error) {
        console.error('[Reset Injection Attempts] Erreur:', error);
        res.status(500).json({ error: 'Erreur lors de la réinitialisation' });
    }
});

app.get('/api/users/ai-quota', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        
        // Appeler getUserAIQuota pour récupérer les informations du quota
        const quotaInfo = await getUserAIQuota(userId);
        
        // Calculer l'heure de réinitialisation (minuit UTC du jour suivant)
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        tomorrow.setUTCHours(0, 0, 0, 0);
        const resetAt = tomorrow.toISOString();
        
        // Retourner le JSON au format demandé
        res.status(200).json({
            callsToday: quotaInfo.callsToday || 0,
            maxCalls: quotaInfo.maxCalls || 10,
            remaining: quotaInfo.remaining || 0,
            tokensUsed: quotaInfo.tokensUsed || 0,
            maxTokens: quotaInfo.maxTokens || 100000,
            resetAt: resetAt,
            subscriptionStatus: quotaInfo.subscriptionStatus || 'none'
        });
    } catch (error) {
        console.error('[AI Quota] Erreur lors de la récupération du quota:', error);
        res.status(500).send({ 
            error: 'Erreur lors de la récupération du quota IA',
            message: error.message 
        });
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

/**
 * Fonction helper pour supprimer un utilisateur (réutilisable)
 */
async function deleteUserAccount(userId) {
    // Récupérer le profil utilisateur avant suppression pour vérifier qu'il existe
    const userProfile = await db.getUser(userId);
    if (!userProfile) {
        throw new Error('Utilisateur non trouvé.');
    }

    // Annuler l'abonnement Stripe si présent
    const subscriptionId = userProfile.stripe_subscription_id || userProfile.subscription_id;
    if (subscriptionId) {
        try {
            const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
            const subscription = await stripe.subscriptions.retrieve(subscriptionId);
            
            // Annuler l'abonnement immédiatement
            if (subscription.status !== 'canceled' && subscription.status !== 'incomplete_expired') {
                await stripe.subscriptions.cancel(subscriptionId);
                console.log(`[Delete User] Abonnement Stripe ${subscriptionId} annulé pour l'utilisateur ${userId}`);
            }
        } catch (stripeError) {
            console.error(`[Delete User] Erreur lors de l'annulation de l'abonnement Stripe pour ${userId}:`, stripeError);
            // Continuer même si l'annulation Stripe échoue
        }
    }

    // Supprimer toutes les données associées dans la base de données
    await db.deleteUser(userId);

    // Supprimer l'utilisateur dans Supabase Auth
    const { error: authDeleteError } = await supabase.auth.admin.deleteUser(userId);
    
    if (authDeleteError) {
        console.error(`[Delete User] Erreur lors de la suppression de l'utilisateur dans Auth:`, authDeleteError);
        // Si la suppression dans Auth échoue, on retourne une erreur
        // Mais les données sont déjà supprimées de la base de données
        throw new Error(`Erreur lors de la suppression de l'utilisateur dans Supabase Auth: ${authDeleteError.message}`);
    }

    console.log(`[Delete User] Utilisateur ${userId} supprimé avec succès`);
}

/**
 * DELETE /api/users/account - Supprime le compte de l'utilisateur actuellement authentifié
 * ATTENTION: Cette route supprime définitivement l'utilisateur et toutes ses données
 */
app.delete('/api/users/account', authenticateToken, async (req, res) => {
    try {
        const currentUserId = req.user.uid;
        
        await deleteUserAccount(currentUserId);
        
        res.status(200).send({ message: 'Utilisateur supprimé avec succès.' });
    } catch (error) {
        console.error('Erreur lors de la suppression de l\'utilisateur:', error);
        res.status(500).send({ 
            error: 'Erreur lors de la suppression de l\'utilisateur.',
            message: error.message || 'Database error deleting user'
        });
    }
});

/**
 * DELETE /api/users/:userId - Supprime un utilisateur et toutes ses données
 * ATTENTION: Cette route supprime définitivement l'utilisateur et toutes ses données
 * NOTE: Pour la suppression de son propre compte, utiliser /api/users/account
 */
app.delete('/api/users/:userId', authenticateToken, async (req, res) => {
    try {
        const currentUserId = req.user.uid;
        const targetUserId = req.params.userId;

        // Vérifier que l'utilisateur supprime son propre compte ou est admin
        // Pour l'instant, on permet uniquement la suppression de son propre compte
        if (currentUserId !== targetUserId) {
            return res.status(403).send({ error: 'Vous ne pouvez supprimer que votre propre compte.' });
        }

        // TODO: Ajouter vérification du rôle admin si nécessaire
        // const userProfile = await db.getUser(currentUserId);
        // if (currentUserId !== targetUserId && userProfile.role !== 'admin') {
        //     return res.status(403).send({ error: 'Accès refusé. Admin seulement.' });
        // }

        await deleteUserAccount(targetUserId);
        
        res.status(200).send({ message: 'Utilisateur supprimé avec succès.' });
    } catch (error) {
        console.error('Erreur lors de la suppression de l\'utilisateur:', error);
        if (error.message === 'Utilisateur non trouvé.') {
            return res.status(404).send({ error: error.message });
        }
        res.status(500).send({ 
            error: 'Erreur lors de la suppression de l\'utilisateur.',
            message: error.message || 'Database error deleting user'
        });
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
        
        // Récupérer tous les produits et prix déjà présents dans l'abonnement pour référence
        const existingProducts = new Set();
        const existingPrices = new Map(); // Map: productId -> price avec la bonne devise
        subscriptionItems.forEach(item => {
            const price = typeof item.price === 'string' ? null : item.price;
            if (price) {
                const productId = typeof price.product === 'string' ? price.product : price.product.id;
                existingProducts.add(productId);
                // Si ce prix a la bonne devise, l'enregistrer comme référence
                if (price.currency.toLowerCase() === subscriptionCurrency.toLowerCase()) {
                    existingPrices.set(productId, price);
                }
            }
        });
        
        console.log(`[End Trial] Abonnement en ${subscriptionCurrency}. Produits existants: ${Array.from(existingProducts).join(', ')}`);
        
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
        
        // Si toujours pas trouvé, chercher parmi tous les items existants pour trouver un prix compatible
        if (!principalItem && subscriptionItems.length > 0) {
            // Chercher un item avec un prix dans la bonne devise
            principalItem = subscriptionItems.find(item => {
                const price = typeof item.price === 'string' ? null : item.price;
                return price && price.currency.toLowerCase() === subscriptionCurrency.toLowerCase();
            });
            if (principalItem) {
                console.log(`[End Trial] Item principal trouvé parmi les items existants de l'abonnement`);
            }
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
        
        // Si toujours pas trouvé, chercher parmi tous les items existants pour trouver un prix compatible
        if (!childItem && subscriptionItems.length > 0) {
            // Chercher un item avec un prix dans la bonne devise (différent du principal si déjà trouvé)
            childItem = subscriptionItems.find(item => {
                const price = typeof item.price === 'string' ? null : item.price;
                const itemId = item.id;
                return price && 
                       price.currency.toLowerCase() === subscriptionCurrency.toLowerCase() &&
                       (!principalItem || itemId !== principalItem.id);
            });
            if (childItem) {
                console.log(`[End Trial] Item enfant trouvé parmi les items existants de l'abonnement`);
            }
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
            let productIdToSearch = parentProductId;
            
            // Si pas de Product ID mais qu'on a un Price ID, récupérer le produit depuis le prix
            if (!productIdToSearch && parentPriceId) {
                try {
                    const defaultPrice = await stripe.prices.retrieve(parentPriceId);
                    productIdToSearch = typeof defaultPrice.product === 'string' 
                        ? defaultPrice.product 
                        : defaultPrice.product.id;
                    console.log(`[End Trial] Product ID récupéré depuis le prix par défaut: ${productIdToSearch}`);
                } catch (err) {
                    console.warn(`[End Trial] Erreur lors de la récupération du produit depuis le prix par défaut:`, err.message);
                }
            }
            
            // Chercher tous les prix du produit avec la bonne devise
            if (productIdToSearch) {
                try {
                    // Récupérer tous les prix du produit parent
                    const allParentPrices = await stripe.prices.list({
                        product: productIdToSearch,
                        limit: 100
                    });
                    
                    console.log(`[End Trial] Trouvé ${allParentPrices.data.length} prix pour le produit parent. Recherche d'un prix en ${subscriptionCurrency}...`);
                    
                    // Trouver un prix avec la même devise que l'abonnement
                    priceToUse = allParentPrices.data.find(price => 
                        price.currency.toLowerCase() === subscriptionCurrency.toLowerCase() && price.active
                    );
                    
                    if (priceToUse) {
                        console.log(`[End Trial] Prix compatible trouvé: ${priceToUse.id} (${priceToUse.currency})`);
                    } else {
                        console.warn(`[End Trial] Aucun prix actif en ${subscriptionCurrency} trouvé pour le produit parent. Prix disponibles:`, 
                            allParentPrices.data.map(p => `${p.id} (${p.currency}, active: ${p.active})`).join(', '));
                    }
                } catch (err) {
                    console.warn(`[End Trial] Erreur lors de la récupération des prix du produit parent:`, err.message);
                }
            }
            
            // Si pas de prix trouvé, vérifier le prix par défaut (fallback)
            if (!priceToUse && parentPriceId) {
                try {
                    const defaultPrice = await stripe.prices.retrieve(parentPriceId);
                    if (defaultPrice.currency.toLowerCase() === subscriptionCurrency.toLowerCase()) {
                        priceToUse = defaultPrice;
                        console.log(`[End Trial] Utilisation du prix par défaut compatible: ${parentPriceId}`);
                    } else {
                        console.warn(`[End Trial] Le prix par défaut (${parentPriceId}) est en ${defaultPrice.currency}, mais l'abonnement est en ${subscriptionCurrency}`);
                    }
                } catch (err) {
                    console.warn(`[End Trial] Erreur lors de la récupération du prix par défaut:`, err.message);
                }
            }
            
            // Dernier recours : utiliser un prix existant de l'abonnement avec la bonne devise
            if (!priceToUse && existingPrices.size > 0) {
                // Utiliser le premier prix existant avec la bonne devise
                const existingPrice = Array.from(existingPrices.values())[0];
                console.log(`[End Trial] Utilisation d'un prix existant de l'abonnement comme référence: ${existingPrice.id} (${existingPrice.currency})`);
                // Récupérer le produit de ce prix et chercher un prix compatible
                const existingProductId = typeof existingPrice.product === 'string' 
                    ? existingPrice.product 
                    : existingPrice.product.id;
                
                // Si c'est le même produit, utiliser ce prix
                if (productIdToSearch && existingProductId === productIdToSearch) {
                    priceToUse = existingPrice;
                    console.log(`[End Trial] Le prix existant correspond au produit parent, utilisation de ce prix`);
                } else {
                    // Sinon, chercher dans tous les prix de ce produit
                    try {
                        const allPrices = await stripe.prices.list({
                            product: existingProductId,
                            limit: 100
                        });
                        priceToUse = allPrices.data.find(price => 
                            price.currency.toLowerCase() === subscriptionCurrency.toLowerCase() && price.active
                        );
                        if (priceToUse) {
                            console.log(`[End Trial] Prix compatible trouvé via le produit de référence: ${priceToUse.id}`);
                        }
                    } catch (err) {
                        console.warn(`[End Trial] Erreur lors de la recherche via le produit de référence:`, err.message);
                    }
                }
            }
            
            if (priceToUse) {
                itemsToUpdate.push({
                    price: priceToUse.id,
                    quantity: quantities.quantityPrincipal
                });
            } else {
                // Message d'erreur plus détaillé avec instructions
                throw new Error(
                    `Impossible de trouver un prix compatible pour le produit parent avec la devise ${subscriptionCurrency}. ` +
                    `L'abonnement utilise ${subscriptionCurrency.toUpperCase()} mais les prix configurés sont en USD. ` +
                    `Veuillez créer un prix ${subscriptionCurrency.toUpperCase()} pour le produit parent dans Stripe, ou ` +
                    `configurer STRIPE_PRICE_PARENT_ID avec un prix ${subscriptionCurrency.toUpperCase()}.`
                );
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
            let productIdToSearch = childProductId;
            
            // Si pas de Product ID mais qu'on a un Price ID, récupérer le produit depuis le prix
            if (!productIdToSearch && childPriceId) {
                try {
                    const defaultPrice = await stripe.prices.retrieve(childPriceId);
                    productIdToSearch = typeof defaultPrice.product === 'string' 
                        ? defaultPrice.product 
                        : defaultPrice.product.id;
                    console.log(`[End Trial] Product ID récupéré depuis le prix enfant par défaut: ${productIdToSearch}`);
                } catch (err) {
                    console.warn(`[End Trial] Erreur lors de la récupération du produit depuis le prix enfant par défaut:`, err.message);
                }
            }
            
            // Chercher tous les prix du produit avec la bonne devise
            if (productIdToSearch) {
                try {
                    // Récupérer tous les prix du produit enfant
                    const allChildPrices = await stripe.prices.list({
                        product: productIdToSearch,
                        limit: 100
                    });
                    
                    console.log(`[End Trial] Trouvé ${allChildPrices.data.length} prix pour le produit enfant. Recherche d'un prix en ${subscriptionCurrency}...`);
                    
                    // Trouver un prix avec la même devise que l'abonnement
                    priceToUse = allChildPrices.data.find(price => 
                        price.currency.toLowerCase() === subscriptionCurrency.toLowerCase() && price.active
                    );
                    
                    if (priceToUse) {
                        console.log(`[End Trial] Prix compatible trouvé: ${priceToUse.id} (${priceToUse.currency})`);
                    } else {
                        console.warn(`[End Trial] Aucun prix actif en ${subscriptionCurrency} trouvé pour le produit enfant. Prix disponibles:`, 
                            allChildPrices.data.map(p => `${p.id} (${p.currency}, active: ${p.active})`).join(', '));
                    }
                } catch (err) {
                    console.warn(`[End Trial] Erreur lors de la récupération des prix du produit enfant:`, err.message);
                }
            }
            
            // Si pas de prix trouvé, vérifier le prix par défaut (fallback)
            if (!priceToUse && childPriceId) {
                try {
                    const defaultPrice = await stripe.prices.retrieve(childPriceId);
                    if (defaultPrice.currency.toLowerCase() === subscriptionCurrency.toLowerCase()) {
                        priceToUse = defaultPrice;
                        console.log(`[End Trial] Utilisation du prix enfant par défaut compatible: ${childPriceId}`);
                    } else {
                        console.warn(`[End Trial] Le prix enfant par défaut (${childPriceId}) est en ${defaultPrice.currency}, mais l'abonnement est en ${subscriptionCurrency}`);
                    }
                } catch (err) {
                    console.warn(`[End Trial] Erreur lors de la récupération du prix enfant par défaut:`, err.message);
                }
            }
            
            // Dernier recours : utiliser un prix existant de l'abonnement avec la bonne devise
            if (!priceToUse && existingPrices.size > 0) {
                // Utiliser le premier prix existant avec la bonne devise
                const existingPrice = Array.from(existingPrices.values())[0];
                console.log(`[End Trial] Utilisation d'un prix existant de l'abonnement comme référence pour l'enfant: ${existingPrice.id} (${existingPrice.currency})`);
                // Récupérer le produit de ce prix et chercher un prix compatible
                const existingProductId = typeof existingPrice.product === 'string' 
                    ? existingPrice.product 
                    : existingPrice.product.id;
                
                // Si c'est le même produit, utiliser ce prix
                if (productIdToSearch && existingProductId === productIdToSearch) {
                    priceToUse = existingPrice;
                    console.log(`[End Trial] Le prix existant correspond au produit enfant, utilisation de ce prix`);
                } else {
                    // Sinon, chercher dans tous les prix de ce produit
                    try {
                        const allPrices = await stripe.prices.list({
                            product: existingProductId,
                            limit: 100
                        });
                        priceToUse = allPrices.data.find(price => 
                            price.currency.toLowerCase() === subscriptionCurrency.toLowerCase() && price.active
                        );
                        if (priceToUse) {
                            console.log(`[End Trial] Prix compatible trouvé via le produit de référence pour l'enfant: ${priceToUse.id}`);
                        }
                    } catch (err) {
                        console.warn(`[End Trial] Erreur lors de la recherche via le produit de référence pour l'enfant:`, err.message);
                    }
                }
            }
            
            if (priceToUse) {
                itemsToUpdate.push({
                    price: priceToUse.id,
                    quantity: quantities.quantityChild
                });
            } else {
                // Message d'erreur plus détaillé avec instructions
                throw new Error(
                    `Impossible de trouver un prix compatible pour le produit enfant avec la devise ${subscriptionCurrency}. ` +
                    `L'abonnement utilise ${subscriptionCurrency.toUpperCase()} mais les prix configurés sont en USD. ` +
                    `Veuillez créer un prix ${subscriptionCurrency.toUpperCase()} pour le produit enfant dans Stripe, ou ` +
                    `configurer STRIPE_PRICE_CHILD_ID avec un prix ${subscriptionCurrency.toUpperCase()}.`
                );
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

/**
 * Endpoint pour récupérer le statut du pricing automatique d'une propriété
 * GET /api/properties/:id/auto-pricing
 */
app.get('/api/properties/:id/auto-pricing', authenticateToken, async (req, res) => {
    try {
        const propertyId = req.params.id;
        const userId = req.user.uid;

        // Vérifier que la propriété existe et appartient à l'utilisateur
        const property = await db.getProperty(propertyId);
        if (!property) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }

        if (property.owner_id !== userId) {
            return res.status(403).send({ error: 'Vous n\'êtes pas autorisé à accéder à cette propriété.' });
        }

        // Récupérer le statut du pricing automatique (par défaut false si non défini)
        const autoPricingEnabled = property.auto_pricing_enabled || false;

        res.status(200).send({
            enabled: autoPricingEnabled
        });

    } catch (error) {
        console.error('Erreur lors de la récupération du statut de pricing automatique:', error);
        res.status(500).send({ 
            error: 'Erreur interne du serveur lors de la récupération du statut de pricing automatique.' 
        });
    }
});

/**
 * Endpoint pour activer/désactiver le pricing automatique d'une propriété
 * PUT /api/properties/:id/auto-pricing
 * Body: { enabled: boolean }
 */
app.put('/api/properties/:id/auto-pricing', authenticateToken, async (req, res) => {
    try {
        const propertyId = req.params.id;
        const userId = req.user.uid;
        const { enabled } = req.body;

        // Validation
        if (typeof enabled !== 'boolean') {
            return res.status(400).send({ 
                error: 'Le champ "enabled" doit être un booléen (true ou false).' 
            });
        }

        // Vérifier que la propriété existe et appartient à l'utilisateur
        const property = await db.getProperty(propertyId);
        if (!property) {
            return res.status(404).send({ error: 'Propriété non trouvée.' });
        }

        if (property.owner_id !== userId) {
            return res.status(403).send({ error: 'Vous n\'êtes pas autorisé à modifier cette propriété.' });
        }

        // Mettre à jour le statut
        await db.updateProperty(propertyId, {
            auto_pricing_enabled: enabled,
            auto_pricing_updated_at: new Date().toISOString()
        });

        res.status(200).send({ 
            message: enabled 
                ? 'Pricing automatique activé pour cette propriété.' 
                : 'Pricing automatique désactivé pour cette propriété.',
            enabled: enabled
        });

    } catch (error) {
        console.error('Erreur lors de la mise à jour du statut de pricing automatique:', error);
        res.status(500).send({ 
            error: 'Erreur interne du serveur lors de la mise à jour du statut de pricing automatique.' 
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
        
        // 1. Valider strictement tous les inputs avant traitement
        if (!newPropertyData || typeof newPropertyData !== 'object') {
            return res.status(400).json({ 
                error: 'Données invalides', 
                message: 'Les données fournies doivent être un objet valide.' 
            });
        }
        
        // Validation stricte de l'objet property avec validatePropertyObject
        const validationResult = validatePropertyObject(newPropertyData, userId);
        if (!validationResult.valid) {
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: 'Les données fournies ne respectent pas les règles de validation.',
                validationErrors: validationResult.errors 
            });
        }
        
        // Validation des champs obligatoires supplémentaires (address, location)
        if (!newPropertyData.address || !newPropertyData.location) {
            return res.status(400).json({ 
                error: 'Champs manquants', 
                message: 'Les champs "address" et "location" sont obligatoires.' 
            });
        }
        
        // Valider address et location avec validateStringLength
        try {
            validateStringLength(newPropertyData.address, 1, 500, 'address', userId);
            validateStringLength(newPropertyData.location, 1, 200, 'location', userId);
        } catch (error) {
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: error.message 
            });
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

        // Utiliser les données validées et sanitizées
        const propertyWithOwner = { 
            name: newPropertyData.name,
            address: String(newPropertyData.address).trim(),
            location: String(newPropertyData.location).trim(),
            description: newPropertyData.description ? String(newPropertyData.description).trim() : null,
            property_type: validationResult.sanitized.property_type || newPropertyData.property_type || newPropertyData.type || 'villa',
            surface: newPropertyData.surface || null,
            capacity: validationResult.sanitized.capacity || newPropertyData.capacity || null,
            daily_revenue: newPropertyData.daily_revenue || null,
            min_stay: newPropertyData.min_stay || 1,
            max_stay: newPropertyData.max_stay || null,
            amenities: newPropertyData.amenities || [],
            owner_id: userId, 
            team_id: teamId, 
            status: 'active', // Statut par défaut
            strategy: validationResult.sanitized.strategy || newPropertyData.strategy || 'Équilibré',
            floor_price: validationResult.sanitized.floor_price !== undefined ? validationResult.sanitized.floor_price : (newPropertyData.floor_price || 0),
            base_price: validationResult.sanitized.base_price !== undefined ? validationResult.sanitized.base_price : (newPropertyData.base_price || 100),
            ceiling_price: validationResult.sanitized.ceiling_price !== undefined ? validationResult.sanitized.ceiling_price : (newPropertyData.ceiling_price || null),
            weekly_discount_percent: validationResult.sanitized.weekly_discount_percent !== undefined ? validationResult.sanitized.weekly_discount_percent : (newPropertyData.weekly_discount_percent || null),
            monthly_discount_percent: validationResult.sanitized.monthly_discount_percent !== undefined ? validationResult.sanitized.monthly_discount_percent : (newPropertyData.monthly_discount_percent || null),
            weekend_markup_percent: validationResult.sanitized.weekend_markup_percent !== undefined ? validationResult.sanitized.weekend_markup_percent : (newPropertyData.weekend_markup_percent || null)
        };
        
        const createdProperty = await db.createProperty(propertyWithOwner);
        
        // Log de la création
        await logPropertyChange(createdProperty.id, req.user.uid, req.user.email, 'create', propertyWithOwner);
        
        // Recalculer et mettre à jour la facturation Stripe
        await recalculateAndUpdateBilling(userId);
        
        res.status(201).send({ message: 'Propriété ajoutée avec succès', id: createdProperty.id });
    } catch (error) {
        // 3. Retourner des erreurs 400 avec messages clairs si validation échoue
        // 4. Logger toutes les erreurs de validation avec userId
        if (error.message && (error.message.includes('Le champ') || error.message.includes('doit être'))) {
            console.error(`[Validation Error] [userId: ${req.user?.uid || 'unknown'}] ${error.message}`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: error.message 
            });
        }
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
        
        // 1. Valider strictement l'ID de propriété
        try {
            validatePropertyId(propertyId, 'propertyId', userId);
        } catch (error) {
            console.error(`[Validation Error] [userId: ${userId}] ${error.message}`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: error.message 
            });
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
        
        // 1. Valider strictement l'ID de propriété
        try {
            validatePropertyId(propertyId, 'propertyId', userId);
        } catch (error) {
            console.error(`[Validation Error] [userId: ${userId}] ${error.message}`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: error.message 
            });
        }

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
        
        // 1. Valider strictement l'ID de propriété
        try {
            validatePropertyId(id, 'propertyId', userId);
        } catch (error) {
            console.error(`[Validation Error] [userId: ${userId}] ${error.message}`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: error.message 
            });
        }
        
        // 1. Valider strictement tous les inputs avant traitement
        const allowedStrategies = ['Prudent', 'Équilibré', 'Agressif'];
        
        // Validation de la stratégie avec validateEnum
        try {
            validateEnum(strategy, allowedStrategies, 'strategy', userId);
        } catch (error) {
            console.error(`[Validation Error] [userId: ${userId}] ${error.message}`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: error.message 
            });
        }
        
        // Validation des prix avec validatePrice
        let validatedFloorPrice, validatedBasePrice, validatedCeilingPrice;
        try {
            validatedFloorPrice = validatePrice(floor_price, 0, Infinity, 'floor_price', userId);
            validatedBasePrice = validatePrice(base_price, 0, Infinity, 'base_price', userId);
            if (ceiling_price != null && ceiling_price !== undefined) {
                validatedCeilingPrice = validatePrice(ceiling_price, 0, Infinity, 'ceiling_price', userId);
            }
        } catch (error) {
            console.error(`[Validation Error] [userId: ${userId}] ${error.message}`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: error.message 
            });
        }
        
        // Validation des plages de prix
        if (validatedFloorPrice >= validatedBasePrice) {
            const errorMsg = `Le prix plancher (${validatedFloorPrice}) doit être strictement inférieur au prix de base (${validatedBasePrice}).`;
            console.error(`[Validation Error] [userId: ${userId}] ${errorMsg}`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: errorMsg 
            });
        }
        
        if (validatedCeilingPrice !== undefined && validatedBasePrice >= validatedCeilingPrice) {
            const errorMsg = `Le prix de base (${validatedBasePrice}) doit être strictement inférieur au prix plafond (${validatedCeilingPrice}).`;
            console.error(`[Validation Error] [userId: ${userId}] ${errorMsg}`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: errorMsg 
            });
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
        // 3. Retourner des erreurs 400 avec messages clairs si validation échoue
        // 4. Logger toutes les erreurs de validation avec userId
        if (error.message && (error.message.includes('Le champ') || error.message.includes('doit être'))) {
            console.error(`[Validation Error] [userId: ${req.user?.uid || 'unknown'}] ${error.message}`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: error.message 
            });
        }
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
        
        // 1. Valider strictement l'ID de propriété
        try {
            validatePropertyId(id, 'propertyId', userId);
        } catch (error) {
            console.error(`[Validation Error] [userId: ${userId}] ${error.message}`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: error.message 
            });
        }
        
        // 1. Valider strictement tous les inputs avant traitement
        const rulesData = {};
        const validationErrors = [];
        
        // Validation de min_stay (entier positif)
        if (min_stay != null && min_stay !== '') {
            try {
                rulesData.min_stay = validateInteger(min_stay, 1, Infinity, 'min_stay', userId);
            } catch (error) {
                validationErrors.push(error.message);
            }
        }
        
        // Validation de max_stay (entier positif, >= min_stay)
        if (max_stay != null && max_stay !== '') {
            try {
                const minValue = rulesData.min_stay || 1;
                rulesData.max_stay = validateInteger(max_stay, minValue, Infinity, 'max_stay', userId);
            } catch (error) {
                validationErrors.push(error.message);
            }
        }
        
        // Validation des pourcentages avec validatePercentage
        if (weekly_discount_percent != null && weekly_discount_percent !== '') {
            try {
                rulesData.weekly_discount_percent = validatePercentage(weekly_discount_percent, 'weekly_discount_percent', userId);
            } catch (error) {
                validationErrors.push(error.message);
            }
        }
        
        if (monthly_discount_percent != null && monthly_discount_percent !== '') {
            try {
                rulesData.monthly_discount_percent = validatePercentage(monthly_discount_percent, 'monthly_discount_percent', userId);
            } catch (error) {
                validationErrors.push(error.message);
            }
        }
        
        if (weekend_markup_percent != null && weekend_markup_percent !== '') {
            try {
                rulesData.weekend_markup_percent = validatePercentage(weekend_markup_percent, 'weekend_markup_percent', userId);
            } catch (error) {
                validationErrors.push(error.message);
            }
        }
        
        // Si des erreurs de validation, retourner les erreurs
        if (validationErrors.length > 0) {
            console.error(`[Validation Error] [userId: ${userId}] Erreurs: ${validationErrors.join('; ')}`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: 'Les données fournies ne respectent pas les règles de validation.',
                validationErrors: validationErrors 
            });
        }

        const cleanRulesData = Object.entries(rulesData)
          .filter(([_, value]) => value !== null && value !== undefined)
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
        // 3. Retourner des erreurs 400 avec messages clairs si validation échoue
        // 4. Logger toutes les erreurs de validation avec userId
        if (error.message && (error.message.includes('Le champ') || error.message.includes('doit être'))) {
            console.error(`[Validation Error] [userId: ${req.user?.uid || 'unknown'}] ${error.message}`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: error.message 
            });
        }
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
app.get('/api/properties/:id/news', authenticateToken, checkAIQuota, async (req, res) => {
    let tokensUsed = 0;
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
        
        // 1.1. Sanitiser la ville avant injection dans le prompt IA
        const fullLocation = property.location || 'France';
        const rawCity = fullLocation.split(',')[0].trim();
        let city = sanitizeForPrompt(rawCity, 100); // Limiter à 100 caractères
        
        // Utiliser une valeur par défaut si la ville est vide après sanitisation
        if (!city || city.trim().length === 0) {
            console.warn(`[Sanitization] Ville vide après sanitisation, utilisation de la valeur par défaut. Raw: "${rawCity}"`);
            city = 'France'; // Valeur par défaut
        }
        
        console.log(`[Sanitization] Ville sanitizée: "${rawCity}" → "${city}"`);

        // 2. Vérifier le cache de cette propriété (avec langue)
        // IMPORTANT: Le quota est vérifié AVANT la vérification du cache (via le middleware checkAIQuota)
        // Cela garantit qu'on ne consomme pas le quota si on utilise le cache
        const language = req.query.language || userProfile?.language || 'fr';
        
        // Note: Le cache par propriété n'est pas encore implémenté dans Supabase
        // Pour l'instant, on ignore le cache et on génère toujours les actualités
        // TODO: Implémenter un système de cache par propriété dans Supabase si nécessaire
        // Quand le cache sera implémenté, on devra vérifier le quota AVANT de vérifier le cache

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

        // 4. Appeler l'IA et capturer les tokens
        const aiResponse = await callGeminiWithSearch(prompt, 10, language);
        
        // Gérer le nouveau format de retour { data, tokens } ou l'ancien format (rétrocompatibilité)
        let newsData;
        if (aiResponse && typeof aiResponse === 'object' && 'data' in aiResponse) {
            // Nouveau format : { data, tokens }
            newsData = aiResponse.data;
            tokensUsed = aiResponse.tokens || 0;
        } else {
            // Ancien format : données directement
            newsData = aiResponse;
            tokensUsed = 2000; // Estimation par défaut si les tokens ne sont pas disponibles
        }
        
        const newsDataArray = Array.isArray(newsData) ? newsData : (newsData ? [newsData] : []);

        if (newsDataArray.length === 0) {
             console.warn("Aucune actualité pertinente trouvée pour", city);
        }

        // 5. Mettre à jour le quota avec les tokens réels utilisés
        const today = new Date().toISOString().split('T')[0];
        const { data: currentQuota } = await supabase
            .from('user_ai_usage')
            .select('tokens_used')
            .eq('user_id', userId)
            .eq('date', today)
            .single();
        
        if (currentQuota) {
            await supabase
                .from('user_ai_usage')
                .update({
                    tokens_used: (currentQuota.tokens_used || 0) + tokensUsed,
                    updated_at: new Date().toISOString()
                })
                .eq('user_id', userId)
                .eq('date', today);
        }

        // 6. Logger l'utilisation
        const quotaInfo = req.aiQuota || {};
        console.log(`[AI Quota] User ${userId} used ${tokensUsed} tokens for property news, remaining: ${quotaInfo.remaining || 0} calls`);

        // 7. Log de l'action (le cache sera implémenté plus tard si nécessaire)
        await logPropertyChange(propertyId, "system", "auto-update", 'update:news-cache', { count: newsDataArray.length });

        // 8. Renvoyer le résultat
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

/**
 * Endpoint pour récupérer le statut du pricing automatique d'un groupe
 * GET /api/groups/:id/auto-pricing
 * IMPORTANT: Cette route doit être définie AVANT /api/groups/:id pour éviter les conflits
 */
app.get('/api/groups/:id/auto-pricing', authenticateToken, async (req, res) => {
    try {
        const groupId = req.params.id;
        const userId = req.user.uid;

        // Récupérer le groupe
        const groups = await db.getGroupsByOwner(userId);
        const group = groups.find(g => String(g.id) === String(groupId));
        
        if (!group) {
            return res.status(404).send({ error: 'Groupe non trouvé.' });
        }

        // Pour un groupe, on utilise la propriété principale
        const mainPropertyId = group.main_property_id || group.mainPropertyId;
        if (!mainPropertyId) {
            return res.status(200).send({ enabled: false });
        }

        // Récupérer le statut de la propriété principale
        const property = await db.getProperty(mainPropertyId);
        if (!property) {
            return res.status(200).send({ enabled: false });
        }

        const autoPricingEnabled = property.auto_pricing_enabled || false;

        res.status(200).send({
            enabled: autoPricingEnabled
        });

    } catch (error) {
        console.error('Erreur lors de la récupération du statut de pricing automatique du groupe:', error);
        res.status(500).send({ 
            error: 'Erreur interne du serveur lors de la récupération du statut de pricing automatique.' 
        });
    }
});

/**
 * Endpoint pour activer/désactiver le pricing automatique d'un groupe
 * PUT /api/groups/:id/auto-pricing
 * Body: { enabled: boolean }
 * IMPORTANT: Cette route doit être définie AVANT /api/groups/:id pour éviter les conflits
 */
app.put('/api/groups/:id/auto-pricing', authenticateToken, async (req, res) => {
    try {
        const groupId = req.params.id;
        const userId = req.user.uid;
        const { enabled } = req.body;

        // Validation
        if (typeof enabled !== 'boolean') {
            return res.status(400).send({ 
                error: 'Le champ "enabled" doit être un booléen (true ou false).' 
            });
        }

        // Récupérer le groupe
        const groups = await db.getGroupsByOwner(userId);
        const group = groups.find(g => String(g.id) === String(groupId));
        
        if (!group) {
            return res.status(404).send({ error: 'Groupe non trouvé.' });
        }

        // Pour un groupe, on utilise la propriété principale
        const mainPropertyId = group.main_property_id || group.mainPropertyId;
        if (!mainPropertyId) {
            return res.status(400).send({ error: 'Ce groupe n\'a pas de propriété principale.' });
        }

        // Vérifier que la propriété principale existe
        const property = await db.getProperty(mainPropertyId);
        if (!property) {
            return res.status(404).send({ error: 'Propriété principale non trouvée.' });
        }

        // Mettre à jour le statut de la propriété principale
        await db.updateProperty(mainPropertyId, {
            auto_pricing_enabled: enabled,
            auto_pricing_updated_at: new Date().toISOString()
        });

        // Mettre à jour aussi auto_pricing_updated_at sur le groupe
        if (enabled) {
            try {
                await db.updateGroup(groupId, {
                    auto_pricing_updated_at: new Date().toISOString()
                });
                console.log(`[Auto-Pricing] auto_pricing_updated_at mis à jour pour le groupe ${groupId}`);
            } catch (updateError) {
                console.error(`[Auto-Pricing] Erreur lors de la mise à jour de auto_pricing_updated_at pour le groupe ${groupId}:`, updateError);
                // Ne pas faire échouer la requête si la mise à jour du groupe échoue
            }
        }

        res.status(200).send({ 
            message: enabled 
                ? 'Pricing automatique activé pour ce groupe.' 
                : 'Pricing automatique désactivé pour ce groupe.',
            enabled: enabled
        });

    } catch (error) {
        console.error('Erreur lors de la mise à jour du statut de pricing automatique du groupe:', error);
        res.status(500).send({ 
            error: 'Erreur interne du serveur lors de la mise à jour du statut de pricing automatique.' 
        });
    }
});

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

// --- MISE À JOUR GROUPE (Général) ---
app.put('/api/groups/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, syncPrices, mainPropertyId, sync_prices, main_property_id } = req.body;

        // On gère les deux formats (camelCase et snake_case)
        const updateData = {
            name,
            sync_prices: syncPrices !== undefined ? syncPrices : sync_prices,
            main_property_id: mainPropertyId !== undefined ? mainPropertyId : main_property_id,
            updated_at: new Date()
        };

        // Nettoyage des undefined
        Object.keys(updateData).forEach(key => updateData[key] === undefined && delete updateData[key]);

        const { data, error } = await supabase
            .from('groups')
            .update(updateData)
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error("Erreur update groupe:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- MISE À JOUR STRATÉGIE GROUPE ---
// NOTE: Cette route a été déplacée plus bas dans le fichier (ligne ~5058)
// pour une gestion plus complète avec mise à jour des propriétés du groupe
// Cette route obsolète est conservée pour référence mais ne sera jamais atteinte
// car la route plus complète est définie en premier dans le code actuel

// --- MISE À JOUR RÈGLES GROUPE (JSONB) ---
app.put('/api/groups/:id/rules', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { 
            min_stay, max_stay, 
            weekly_discount_percent, monthly_discount_percent, 
            weekend_markup_percent 
        } = req.body;

        // On construit l'objet JSON à stocker dans la colonne 'rules'
        const rulesPayload = {
            min_stay,
            max_stay,
            weekly_discount_percent,
            monthly_discount_percent,
            weekend_markup_percent
        };

        const { data, error } = await supabase
            .from('groups')
            .update({ 
                rules: rulesPayload, // C'est ici qu'on cible la colonne JSONB
                updated_at: new Date()
            })
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;
        res.json(data);
    } catch (error) {
        console.error("Erreur update règles:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- Route pour récupérer les groupes (Avec aplatissement des règles) ---
app.get('/api/groups', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    
    // Récupérer uniquement les groupes de l'utilisateur connecté
    const groups = await db.getGroupsByOwner(userId);
    
    // On fusionne le contenu de la colonne 'rules' avec l'objet principal
    // Ainsi, le frontend recevra { id: 1, min_stay: 2, ... } au lieu de { id: 1, rules: { min_stay: 2 } }
    const formattedGroups = groups.map(g => ({
        ...g,
        ...(g.rules || {}) // Fusionne les propriétés de 'rules' s'il existe
    }));
    
    console.log(`[API] ${formattedGroups.length} groupes trouvés pour l'utilisateur ${userId}.`);
    res.json(formattedGroups);
  } catch (error) {
    console.error('Erreur API Groups:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- Route pour mettre à jour un groupe (PUT /api/groups/:groupId) ---
// Reconstruit explicitement les objets JSON strategy et rules avant sauvegarde.
app.put('/api/groups/:groupId', authenticateToken, async (req, res) => {
    try {
        const groupId = req.params.groupId;
        const userId = req.user.uid;
        const input = req.body;

        const existing = await db.getGroup(groupId);
        if (!existing) {
            return res.status(404).json({ error: 'Groupe non trouvé.' });
        }
        if (existing.owner_id !== userId) {
            return res.status(403).json({ error: 'Action non autorisée sur ce groupe.' });
        }

        // DEBUG : voir exactement ce que le front envoie
        console.log(`[Update Group] Payload reçu pour ${groupId}:`, JSON.stringify(input, null, 2));

        // 1. Détection intelligente du nom de la stratégie
        let strategyName = 'dynamic';
        if (typeof input.strategy === 'string') {
            strategyName = input.strategy;
        } else if (typeof input.strategy === 'object' && input.strategy !== null) {
            strategyName = input.strategy.strategy || input.strategy.value || input.strategy.name || input.strategy.type || 'dynamic';
        } else if (input.strategy_type) {
            strategyName = input.strategy_type;
        }
        console.log(`[Update Group] Stratégie détectée : ${strategyName}`);

        // 2. Reconstruire l'objet 'strategy' pour la base de données
        const strategyData = {
            strategy: strategyName,
            base_price: input.base_price,
            floor_price: input.floor_price,
            ceiling_price: input.ceiling_price,
        };

        const rulesData = {
            min_stay: input.min_stay ?? input.min_stay_duration,
            max_stay: input.max_stay ?? input.max_stay_duration,
            weekend_markup_percent: input.weekend_markup_percent ?? input.markup,
            long_stay_discount: input.long_stay_discount,
            weekly_discount_percent: input.weekly_discount_percent,
            monthly_discount_percent: input.monthly_discount_percent,
        };

        const syncPrices = input.sync_prices ?? input.syncPrices ?? input.auto_pricing_enabled === true;
        const groupUpdatePayload = {
            name: input.name,
            color: input.color,
            strategy: strategyData,
            rules: rulesData,
            main_property_id: input.main_property_id ?? input.mainPropertyId ?? existing.main_property_id ?? existing.mainPropertyId,
            sync_prices: !!syncPrices,
            auto_pricing_updated_at: syncPrices ? new Date().toISOString() : null,
            updated_at: new Date().toISOString(),
        };

        const updatedGroup = await db.updateGroup(groupId, groupUpdatePayload);
        res.status(200).json(updatedGroup);
    } catch (error) {
        console.error('Erreur update group:', error);
        res.status(500).json({ error: error.message });
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
        
        console.log(`[Groups] Groupe récupéré pour mise à jour stratégie:`, {
            id: group.id,
            has_strategy_raw: !!group._strategy_raw,
            has_rules_raw: !!group._rules_raw,
            strategy_raw_type: typeof group._strategy_raw,
            rules_raw_type: typeof group._rules_raw
        });
        
        // Valider les données (copié de /api/properties/:id/strategy)
        const allowedStrategies = ['Prudent', 'Équilibré', 'Agressif'];
        if (!strategy || !allowedStrategies.includes(strategy)) {
            return res.status(400).send({ error: 'Stratégie invalide ou manquante.' });
        }
        
        // Récupérer les valeurs existantes de la stratégie pour les conserver si non fournies
        let existingStrategy = {};
        if (group._strategy_raw && typeof group._strategy_raw === 'object' && !Array.isArray(group._strategy_raw)) {
            existingStrategy = group._strategy_raw;
        } else if (group.strategy && typeof group.strategy === 'object' && !Array.isArray(group.strategy)) {
            existingStrategy = group.strategy;
        }
        
        // Valider et convertir les prix seulement s'ils sont fournis
        // Si non fournis, on garde les valeurs existantes
        let floorPriceNum = existingStrategy.floor_price || null;
        let basePriceNum = existingStrategy.base_price || null;
        let ceilingPriceNum = existingStrategy.ceiling_price || null;
        
        // Si des prix sont fournis, les valider et les utiliser
        if (floor_price != null && floor_price !== '') {
            floorPriceNum = Number(floor_price);
            if (isNaN(floorPriceNum) || floorPriceNum < 0) {
                return res.status(400).send({ error: 'Le prix plancher doit être un nombre positif.' });
            }
        }
        
        if (base_price != null && base_price !== '') {
            basePriceNum = Number(base_price);
            if (isNaN(basePriceNum) || basePriceNum < 0) {
                return res.status(400).send({ error: 'Le prix de base doit être un nombre positif.' });
            }
        }
        
        if (ceiling_price != null && ceiling_price !== '') {
            ceilingPriceNum = Number(ceiling_price);
            if (isNaN(ceilingPriceNum) || ceilingPriceNum < 0) {
                return res.status(400).send({ error: 'Le prix plafond doit être un nombre positif.' });
            }
        }

        // Construire l'objet JSONB strategy pour la table groups
        // La table groups a une colonne JSONB 'strategy', pas des colonnes directes
        // Fusionner avec les données existantes si elles existent
        // Note: existingStrategy a déjà été récupéré plus haut
        const strategyJsonb = {
            ...existingStrategy, // Conserver les autres champs du JSONB s'ils existent
            strategy, // Toujours mettre à jour le nom de la stratégie
            floor_price: floorPriceNum, // Utiliser la valeur fournie ou existante
            base_price: basePriceNum, // Utiliser la valeur fournie ou existante
            ceiling_price: ceilingPriceNum, // Utiliser la valeur fournie ou existante
        };

        // Les données pour mettre à jour les propriétés du groupe (colonnes directes)
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
        
        // Mettre à jour le document du groupe avec le JSONB strategy
        try {
            await db.updateGroup(id, { strategy: strategyJsonb });
            console.log(`[Groups] Stratégie mise à jour pour le groupe ${id}:`, JSON.stringify(strategyJsonb));
        } catch (updateError) {
            console.error(`[Groups] Erreur lors de la mise à jour de la stratégie pour le groupe ${id}:`, updateError);
            throw updateError;
        }
        
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

        console.log(`[Groups] Groupe récupéré pour mise à jour règles:`, {
            id: group.id,
            has_strategy_raw: !!group._strategy_raw,
            has_rules_raw: !!group._rules_raw,
            strategy_raw_type: typeof group._strategy_raw,
            rules_raw_type: typeof group._rules_raw
        });

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
        
        // Mettre à jour le groupe avec les règles (dans un champ JSONB rules)
        // Fusionner avec les règles existantes si elles existent
        // Note: getGroup retourne _rules_raw qui contient le JSONB brut de Supabase
        let existingRules = {};
        if (group._rules_raw && typeof group._rules_raw === 'object' && !Array.isArray(group._rules_raw)) {
            existingRules = group._rules_raw;
        } else if (group.rules && typeof group.rules === 'object' && !Array.isArray(group.rules)) {
            existingRules = group.rules;
        } else {
            existingRules = {};
        }
        
        const rulesJsonb = {
            ...existingRules, // Conserver les autres champs du JSONB s'ils existent
            ...cleanRulesData
        };
        
        // Mettre à jour le groupe avec les règles
        try {
            await db.updateGroup(id, { rules: rulesJsonb });
            console.log(`[Groups] Règles mises à jour pour le groupe ${id}:`, JSON.stringify(rulesJsonb));
        } catch (updateError) {
            console.error(`[Groups] Erreur lors de la mise à jour des règles pour le groupe ${id}:`, updateError);
            throw updateError;
        }
        
        // Mettre à jour toutes les propriétés du groupe
        for (const propId of propertiesInGroup) {
            await db.updateProperty(propId, cleanRulesData);
            // Log de l'action
            await logPropertyChange(propId, req.user.uid, req.user.email, 'update:rules:group', { ...cleanRulesData, groupId: id });
        }
        
        res.status(200).send({ message: `Règles appliquées au groupe et à ${propertiesInGroup.length} propriétés.` });
        
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
    const endpoint = '/api/reports/kpis';
    try {
        const userId = req.user.uid;
        const { startDate, endDate, propertyType, channel, status, location } = req.query; // ex: '2025-01-01', '2025-01-31'

        // 1. Valider strictement les dates (format, plage, validité)
        if (!startDate || !endDate) {
            console.error(`[Validation Error] [Endpoint: ${endpoint}] [userId: ${userId}] Les dates de début et de fin sont requises.`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: 'Les dates de début et de fin sont requises.' 
            });
        }

        let validatedStartDate, validatedEndDate;
        try {
            validatedStartDate = validateAndSanitizeDate(startDate, 'startDate', userId);
            validatedEndDate = validateAndSanitizeDate(endDate, 'endDate', userId);
        } catch (dateError) {
            console.error(`[Validation Error] [Endpoint: ${endpoint}] [userId: ${userId}] ${dateError.message}`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: dateError.message 
            });
        }

        // Valider la plage de dates (startDate <= endDate)
        const start = new Date(validatedStartDate + 'T00:00:00Z');
        const end = new Date(validatedEndDate + 'T00:00:00Z');
        if (start > end) {
            const errorMsg = `La date de début (${validatedStartDate}) doit être antérieure ou égale à la date de fin (${validatedEndDate}).`;
            console.error(`[Validation Error] [Endpoint: ${endpoint}] [userId: ${userId}] ${errorMsg}`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: errorMsg 
            });
        }

        // 2. Récupérer le teamId de l'utilisateur
        const { teamId } = await getOrInitializeTeamId(userId);

        // 2. Récupérer les données des propriétés (pour le prix de base)
        let properties = await db.getPropertiesByTeam(teamId);
        if (!properties || properties.length === 0) {
            return res.status(200).json({ totalRevenue: 0, totalNightsBooked: 0, adr: 0, occupancy: 0, totalNightsAvailable: 0, iaGain: 0, iaScore: 0, revPar: 0, roi: 0 });
        }
        
        // 2.5 Appliquer les filtres sur les propriétés
        if (propertyType) {
            properties = properties.filter(p => p.property_type === propertyType);
        }
        if (channel) {
            properties = properties.filter(p => p.channel === channel);
        }
        if (status) {
            properties = properties.filter(p => p.status === status);
        }
        if (location) {
            const locLower = location.toLowerCase();
            properties = properties.filter(p => 
                (p.location && p.location.toLowerCase().includes(locLower)) || 
                (p.address && p.address.toLowerCase().includes(locLower))
            );
        }
        
        if (properties.length === 0) {
            return res.status(200).json({ totalRevenue: 0, totalNightsBooked: 0, adr: 0, occupancy: 0, totalNightsAvailable: 0, iaGain: 0, iaScore: 0, revPar: 0, roi: 0 });
        }
        
        const propertyBasePrices = new Map();
        const filteredPropertyIds = new Set();
        properties.forEach(prop => {
            propertyBasePrices.set(prop.id, prop.base_price || 0); // Utiliser 0 si non défini
            filteredPropertyIds.add(prop.id);
        });
        
        const totalPropertiesInTeam = properties.length;

        // 3. Calculer le nombre de jours dans la période
        const daysInPeriod = Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1; // +1 pour inclure le dernier jour
        const totalNightsAvailable = totalPropertiesInTeam * daysInPeriod;

        // 4. Interroger toutes les réservations de l'équipe qui chevauchent la période
        let bookings = await db.getBookingsByTeamAndDateRange(teamId, validatedStartDate, validatedEndDate);
        
        // 4.5 Filtrer les bookings pour ne garder que ceux des propriétés filtrées
        bookings = bookings.filter(booking => filteredPropertyIds.has(booking.property_id));

        if (!bookings || bookings.length === 0) {
             return res.status(200).json({ totalRevenue: 0, totalNightsBooked: 0, adr: 0, occupancy: 0, totalNightsAvailable: totalNightsAvailable, iaGain: 0, iaScore: 0, revPar: 0, roi: 0 });
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

        // --- NOUVEAU : Intégration des Coûts PricEye ---
        
        // 1. Récupérer la structure des groupes pour calculer le coût exact
        const { data: groups } = await supabase
            .from('groups')
            .select('*')
            .eq('team_id', teamId);

        // 2. Calculer le nombre d'unités facturables (Parent vs Enfant)
        const { quantityPrincipal, quantityChild } = calculateBillingQuantities(properties, groups || []);
        
        // 3. Calculer le coût mensuel théorique
        // ⚠️ IMPORTANT : Vérifiez que ces valeurs correspondent à vos tarifs Stripe réels !
        const { totalAmount: monthlyCostCents } = calculateTieredPricing(quantityPrincipal);
        
        // ⚠️ CONFIGURATION DU PRIX DES PROPRIÉTÉS ENFANTS (Child Units)
        // Prix fixe pour les Child Units (en centimes)
        // Modifiez cette valeur si votre tarif pour les propriétés enfants change dans Stripe
        const CHILD_UNIT_PRICE_CENTS = 399; // 3.99€ par unité enfant par mois
        
        // Calculer le coût total mensuel (Parent Units + Child Units)
        const monthlyChildCostCents = quantityChild * CHILD_UNIT_PRICE_CENTS;
        const totalMonthlyCostCents = monthlyCostCents + monthlyChildCostCents;
        const monthlyCost = totalMonthlyCostCents / 100; // Conversion en euros
        
        // 4. Ramener ce coût à la période sélectionnée (Prorata)
        // ex: Si on regarde 15 jours, le coût est moitié du mois
        const priceyeCost = monthlyCost * (daysInPeriod / 30);


        // --- Calcul des KPIs Finaux ---

        const adr = totalNightsBooked > 0 ? totalRevenue / totalNightsBooked : 0;
        const occupancy = totalNightsAvailable > 0 ? (totalNightsBooked / totalNightsAvailable) * 100 : 0;
        const revPar = totalNightsAvailable > 0 ? totalRevenue / totalNightsAvailable : 0;

        // Gain Brut (Revenu Réel - Revenu Base)
        const grossIaGain = totalRevenue - totalBaseRevenue;
        
        // Gain Net (Gain Brut - Coût Outil)
        const netIaGain = grossIaGain - priceyeCost;

        // ROI (Retour sur Investissement)
        // Formule : (Gain Net / Coût) * 100
        // Si le coût est 0 (période d'essai), le ROI est infini (on met 0 ou 999 par sécurité)
        let roi = 0;
        if (priceyeCost > 0) {
            roi = (netIaGain / priceyeCost) * 100;
        }

        // Score IA (Qualité de la stratégie : % de nuits vendues au-dessus du prix de base)
        const iaScore = totalNightsBooked > 0 ? (premiumNights / totalNightsBooked) * 100 : 0;

        res.status(200).json({
            totalRevenue: Math.round(totalRevenue),
            totalNightsBooked,
            adr: Math.round(adr),
            occupancy: Math.round(occupancy * 10) / 10,
            totalNightsAvailable,
            
            // Nouveaux indicateurs financiers
            iaGain: Math.round(netIaGain), // Gain NET affiché
            grossIaGain: Math.round(grossIaGain), // Gain Brut (dispo si besoin)
            priceyeCost: Math.round(priceyeCost), // Coût pour la période
            
            iaScore: Math.round(iaScore),
            roi: Math.round(roi), // Pourcentage ROI réel
            revPar: Math.round(revPar)
        });

    } catch (error) {
        console.error(`[API Error] [Endpoint: ${endpoint}]`, error);
        res.status(500).json({ error: 'Erreur interne du serveur', details: error.message });
    }
});

// GET /api/reports/revenue-over-time
app.get('/api/reports/revenue-over-time', authenticateToken, async (req, res) => {
    const endpoint = '/api/reports/revenue-over-time';
    try {
        const userId = req.user.uid;
        const { startDate, endDate, propertyType, channel, status, location } = req.query;

        // 1. Valider strictement les dates (format, plage, validité)
        if (!startDate || !endDate) {
            console.error(`[Validation Error] [Endpoint: ${endpoint}] [userId: ${userId}] Les dates de début et de fin sont requises.`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: 'Les dates de début et de fin sont requises.' 
            });
        }

        let validatedStartDate, validatedEndDate;
        try {
            validatedStartDate = validateAndSanitizeDate(startDate, 'startDate', userId);
            validatedEndDate = validateAndSanitizeDate(endDate, 'endDate', userId);
        } catch (dateError) {
            console.error(`[Validation Error] [Endpoint: ${endpoint}] [userId: ${userId}] ${dateError.message}`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: dateError.message 
            });
        }

        // Valider la plage de dates (startDate <= endDate)
        const start = new Date(validatedStartDate + 'T00:00:00Z');
        const end = new Date(validatedEndDate + 'T00:00:00Z');
        if (start > end) {
            const errorMsg = `La date de début (${validatedStartDate}) doit être antérieure ou égale à la date de fin (${validatedEndDate}).`;
            console.error(`[Validation Error] [Endpoint: ${endpoint}] [userId: ${userId}] ${errorMsg}`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: errorMsg 
            });
        }

        // 2. Trouver le teamId et le nombre total de propriétés
        const { teamId } = await getOrInitializeTeamId(userId);

        let properties = await db.getPropertiesByTeam(teamId);
        
        // 2.5 Appliquer les filtres sur les propriétés
        if (propertyType) {
            properties = properties.filter(p => p.property_type === propertyType);
        }
        if (channel) {
            properties = properties.filter(p => p.channel === channel);
        }
        if (status) {
            properties = properties.filter(p => p.status === status);
        }
        if (location) {
            const locLower = location.toLowerCase();
            properties = properties.filter(p => 
                (p.location && p.location.toLowerCase().includes(locLower)) || 
                (p.address && p.address.toLowerCase().includes(locLower))
            );
        }
        
        const filteredPropertyIds = new Set(properties.map(p => p.id));
        const totalPropertiesInTeam = properties.length;

        // 3. Initialiser une carte de dates
        const datesMap = new Map();
        let currentDate = new Date(validatedStartDate + 'T00:00:00Z'); // Forcer UTC
        const finalDate = new Date(validatedEndDate + 'T00:00:00Z');

        while (currentDate <= finalDate) {
            datesMap.set(currentDate.toISOString().split('T')[0], { revenue: 0, nightsBooked: 0 }); // Stocker un objet
            currentDate.setUTCDate(currentDate.getUTCDate() + 1);
        }

        // 4. Récupérer les réservations qui chevauchent la période
        let bookings = await db.getBookingsByTeamAndDateRange(teamId, validatedStartDate, validatedEndDate);
        
        // 4.5 Filtrer les bookings pour ne garder que ceux des propriétés filtrées
        bookings = bookings.filter(booking => filteredPropertyIds.has(booking.property_id));

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
        // 5. Logger toutes les erreurs avec userId et endpoint
        const userId = req.user?.uid || 'unknown';
        console.error(`[Validation Error] [Endpoint: ${endpoint}] [userId: ${userId}] Erreur lors du calcul des revenus journaliers:`, error);
        res.status(500).json({ error: 'Erreur serveur lors du calcul des revenus journaliers.' });
    }
});

// GET /api/reports/market-demand-snapshot - Indicateurs de demande sur les dernières 24h
app.get('/api/reports/market-demand-snapshot', authenticateToken, async (req, res) => {
    const endpoint = '/api/reports/market-demand-snapshot';
    try {
        const userId = req.user.uid;
        const { timezone } = req.query;

        // 3. Valider les paramètres de requête (timezone)
        let validatedTimezone = 'UTC'; // Valeur par défaut
        if (timezone) {
            try {
                validatedTimezone = validateTimezone(timezone, 'timezone', userId);
            } catch (timezoneError) {
                console.error(`[Validation Error] [Endpoint: ${endpoint}] [userId: ${userId}] ${timezoneError.message}`);
                return res.status(400).json({ 
                    error: 'Validation échouée', 
                    message: timezoneError.message 
                });
            }
        }

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
                timezone: validatedTimezone
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
        // 5. Logger toutes les erreurs avec userId et endpoint
        const userId = req.user?.uid || 'unknown';
        console.error(`[Validation Error] [Endpoint: ${endpoint}] [userId: ${userId}] Erreur lors du calcul du snapshot de demande marché:`, error);
        res.status(500).json({ error: 'Erreur serveur lors du calcul du snapshot de demande marché.' });
    }
});

// GET /api/reports/positioning - ADR vs marché + distribution prix concurrents (avec IA)
app.get('/api/reports/positioning', authenticateToken, checkAIQuota, async (req, res) => {
    const endpoint = '/api/reports/positioning';
    let tokensUsed = 0;
    let aiCallSucceeded = false;
    try {
        const userId = req.user.uid;
        const { startDate, endDate, propertyType, channel, status, location } = req.query;

        // 1. Valider strictement les dates (format, plage, validité)
        if (!startDate || !endDate) {
            console.error(`[Validation Error] [Endpoint: ${endpoint}] [userId: ${userId}] Les dates de début et de fin sont requises.`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: 'Les dates de début et de fin sont requises.' 
            });
        }

        let sanitizedStartDate, sanitizedEndDate;
        try {
            sanitizedStartDate = validateAndSanitizeDate(startDate, 'startDate', userId);
            sanitizedEndDate = validateAndSanitizeDate(endDate, 'endDate', userId);
        } catch (dateError) {
            console.error(`[Validation Error] [Endpoint: ${endpoint}] [userId: ${userId}] ${dateError.message}`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: dateError.message 
            });
        }

        // Vérifier que la plage de dates est raisonnable (max 2 ans)
        const start = new Date(sanitizedStartDate + 'T00:00:00Z');
        const end = new Date(sanitizedEndDate + 'T00:00:00Z');
        const diffTime = Math.abs(end - start);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        const maxDays = 2 * 365; // 2 ans

        if (diffDays > maxDays) {
            const errorMsg = `La plage de dates ne peut pas dépasser 2 ans. Plage demandée: ${diffDays} jours.`;
            console.error(`[Validation Error] [Endpoint: ${endpoint}] [userId: ${userId}] ${errorMsg}`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: errorMsg 
            });
        }

        if (start > end) {
            const errorMsg = `La date de début (${sanitizedStartDate}) doit être antérieure ou égale à la date de fin (${sanitizedEndDate}).`;
            console.error(`[Validation Error] [Endpoint: ${endpoint}] [userId: ${userId}] ${errorMsg}`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: errorMsg 
            });
        }

        // 1. Récupérer le teamId et les propriétés
        const { teamId, userProfile } = await getOrInitializeTeamId(userId);

        let propertiesList = await db.getPropertiesByTeam(teamId);
        
        // 1.5 Appliquer les filtres sur les propriétés
        if (propertyType) {
            propertiesList = propertiesList.filter(p => p.property_type === propertyType);
        }
        if (channel) {
            propertiesList = propertiesList.filter(p => p.channel === channel);
        }
        if (status) {
            propertiesList = propertiesList.filter(p => p.status === status);
        }
        if (location) {
            const locLower = location.toLowerCase();
            propertiesList = propertiesList.filter(p => 
                (p.location && p.location.toLowerCase().includes(locLower)) || 
                (p.address && p.address.toLowerCase().includes(locLower))
            );
        }
        
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
        // Utiliser les dates sanitizées

        const adrStats = properties.map(p => ({
            id: p.id,
            name: p.name,
            revenue: 0,
            nights: 0
        }));

        // Récupérer toutes les réservations de l'équipe pour la période
        const bookings = await db.getBookingsByTeamAndDateRange(teamId, sanitizedStartDate, sanitizedEndDate);

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

        // Whitelist des types de propriétés autorisés
        const allowedPropertyTypes = ['appartement', 'maison', 'villa', 'studio', 'chambre', 'loft', 'penthouse', 'chalet', 'gîte', 'apartment', 'house', 'villa', 'studio', 'room', 'loft', 'penthouse', 'chalet', 'cottage'];
        
        // Sanitiser propertyStats avant injection dans le prompt
        const propertyStats = adrStats.map((s, i) => {
            const prop = properties[i];
            const yourAdr = s.nights > 0 ? s.revenue / s.nights : prop.basePrice || 0;
            
            // Sanitiser le nom (limiter à 100 caractères)
            const sanitizedName = sanitizeForPrompt(prop.name || 'Propriété', 100);
            
            // Sanitiser la location (limiter à 100 caractères)
            const sanitizedLocation = sanitizeForPrompt(prop.location || '', 100);
            
            // Valider le type avec whitelist
            const rawType = (prop.type || 'appartement').toLowerCase().trim();
            const sanitizedType = allowedPropertyTypes.includes(rawType) ? rawType : 'appartement';
            
            if (rawType !== sanitizedType) {
                console.warn(`[Sanitization] Type de propriété non autorisé: "${rawType}" → "${sanitizedType}"`);
            }
            
            return {
                id: prop.id,
                name: sanitizedName,
                location: sanitizedLocation,
                type: sanitizedType,
                capacity: prop.capacity,
                basePrice: prop.basePrice,
                yourAdr: Math.round(yourAdr)
            };
        });
        
        console.log(`[Sanitization] ${propertyStats.length} propriétés sanitizées pour le prompt IA`);

        // 3. Construire le prompt IA pour obtenir ADR marché + distribution prix concurrents
        const today = new Date().toISOString().split('T')[0];
        const isFrench = (req.query.language || userProfile?.language || 'fr') === 'fr' || (req.query.language || userProfile?.language || 'fr') === 'fr-FR';
        const positioningPrompt = isFrench ? `
Tu es un moteur de benchmarking tarifaire pour la location courte durée.

Contexte:
- Date d'exécution: ${today}
- Période analysée: du ${sanitizedStartDate} au ${sanitizedEndDate}
- Marché principal: ${propertyStats[0]?.location || 'Non spécifié'}

Voici les propriétés de mon portefeuille et leur ADR observé sur la période:
${safeJSONStringify(propertyStats, 3, 2)}

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
- Analysis period: from ${sanitizedStartDate} to ${sanitizedEndDate}
- Main market: ${propertyStats[0]?.location || 'Not specified'}

Here are my portfolio properties and their observed ADR over the period:
${safeJSONStringify(propertyStats, 3, 2)}

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
        let aiCallSucceeded = false;
        try {
            // Appeler l'IA et capturer les tokens
            const aiResponse = await callGeminiWithSearch(positioningPrompt, 10, language);
            
            // Gérer le nouveau format de retour { data, tokens } ou l'ancien format (rétrocompatibilité)
            if (aiResponse && typeof aiResponse === 'object' && 'data' in aiResponse) {
                // Nouveau format : { data, tokens }
                iaResult = aiResponse.data;
                tokensUsed = aiResponse.tokens || 0;
            } else {
                // Ancien format : données directement
                iaResult = aiResponse;
                tokensUsed = 2000; // Estimation par défaut si les tokens ne sont pas disponibles
            }
            
            aiCallSucceeded = true;
        } catch (e) {
            console.error('Erreur lors de l\'appel IA pour le positionnement:', e);
            aiCallSucceeded = false;
            // Si l'appel IA échoue complètement, on ne compte pas dans le quota
            // On va annuler l'incrémentation faite par le middleware
            // Note: Le middleware a déjà incrémenté calls_count, on va le décrémenter
            const today = new Date().toISOString().split('T')[0];
            const { data: currentQuota } = await supabase
                .from('user_ai_usage')
                .select('calls_count')
                .eq('user_id', userId)
                .eq('date', today)
                .single();
            
            if (currentQuota && currentQuota.calls_count > 0) {
                await supabase
                    .from('user_ai_usage')
                    .update({
                        calls_count: Math.max(0, currentQuota.calls_count - 1),
                        updated_at: new Date().toISOString()
                    })
                    .eq('user_id', userId)
                    .eq('date', today);
                console.log(`[AI Quota] Annulation de l'incrémentation pour l'utilisateur ${userId} (appel IA échoué)`);
            }
        }

        // 4. Fallback local si l'IA ne renvoie rien d'exploitable
        // Si on utilise le fallback mais que l'appel a réussi, on compte quand même (l'appel a été fait)
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
            
            // Si on utilise le fallback mais que l'appel a réussi, on compte quand même
            // (l'appel IA a été fait, même si les données ne sont pas exploitables)
            if (aiCallSucceeded) {
                console.log(`[AI Quota] Appel IA réussi mais données invalides, utilisation du fallback (quota compté)`);
            }
        }

        // 5. Mettre à jour le quota avec les tokens réels utilisés (seulement si l'appel a réussi)
        if (aiCallSucceeded && tokensUsed > 0) {
            const today = new Date().toISOString().split('T')[0];
            const { data: currentQuota } = await supabase
                .from('user_ai_usage')
                .select('tokens_used')
                .eq('user_id', userId)
                .eq('date', today)
                .single();
            
            if (currentQuota) {
                await supabase
                    .from('user_ai_usage')
                    .update({
                        tokens_used: (currentQuota.tokens_used || 0) + tokensUsed,
                        updated_at: new Date().toISOString()
                    })
                    .eq('user_id', userId)
                    .eq('date', today);
            }

            // Logger l'utilisation
            const quotaInfo = req.aiQuota || {};
            console.log(`[AI Quota] User ${userId} used ${tokensUsed} tokens for positioning report, remaining: ${quotaInfo.remaining || 0} calls`);
        }

        res.status(200).json(iaResult);

    } catch (error) {
        // 5. Logger toutes les erreurs avec userId et endpoint
        const userId = req.user?.uid || 'unknown';
        console.error(`[Validation Error] [Endpoint: ${endpoint}] [userId: ${userId}] Erreur lors du calcul du rapport de positionnement:`, error);
        res.status(500).json({ error: 'Erreur serveur lors du calcul du rapport de positionnement.' });
    }
});

// GET /api/reports/performance-over-time
app.get('/api/reports/performance-over-time', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const { startDate, endDate, propertyType, channel, status, location } = req.query;

        if (!startDate || !endDate) {
            return res.status(400).send({ error: 'Les dates de début et de fin sont requises.' });
        }

        // 1. Find teamId and total properties
        const { teamId } = await getOrInitializeTeamId(userId);

        let propertiesList = await db.getPropertiesByTeam(teamId);
        
        // 1.5 Appliquer les filtres sur les propriétés
        if (propertyType) {
            propertiesList = propertiesList.filter(p => p.property_type === propertyType);
        }
        if (channel) {
            propertiesList = propertiesList.filter(p => p.channel === channel);
        }
        if (status) {
            propertiesList = propertiesList.filter(p => p.status === status);
        }
        if (location) {
            const locLower = location.toLowerCase();
            propertiesList = propertiesList.filter(p => 
                (p.location && p.location.toLowerCase().includes(locLower)) || 
                (p.address && p.address.toLowerCase().includes(locLower))
            );
        }
        
        const filteredPropertyIds = new Set(propertiesList.map(p => p.id));
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
        let bookings = await db.getBookingsByTeamAndDateRange(teamId, startDate, endDate);
        
        // 4.5 Filtrer les bookings pour ne garder que ceux des propriétés filtrées
        bookings = bookings.filter(booking => filteredPropertyIds.has(booking.property_id));

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
        const { startDate, endDate, propertyType, channel, status, location } = req.query;

        if (!startDate || !endDate) {
            return res.status(400).send({ error: 'Les dates de début et de fin sont requises.' });
        }

        // 1. Récupérer le teamId
        const { teamId, userProfile } = await getOrInitializeTeamId(userId);

        let properties = await db.getPropertiesByTeam(teamId);
        
        // 1.5 Appliquer les filtres sur les propriétés
        if (propertyType) {
            properties = properties.filter(p => p.property_type === propertyType);
        }
        if (channel) {
            properties = properties.filter(p => p.channel === channel);
        }
        if (status) {
            properties = properties.filter(p => p.status === status);
        }
        if (location) {
            const locLower = location.toLowerCase();
            properties = properties.filter(p => 
                (p.location && p.location.toLowerCase().includes(locLower)) || 
                (p.address && p.address.toLowerCase().includes(locLower))
            );
        }
        
        const filteredPropertyIds = new Set(properties.map(p => p.id));
        
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
        let bookings = await db.getBookingsByTeamAndDateRange(teamId, startDate, endDate);
        
        // 4.5 Filtrer les bookings pour ne garder que ceux des propriétés filtrées
        bookings = bookings.filter(booking => filteredPropertyIds.has(booking.property_id));

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
        const { startDate, endDate, propertyType, channel, status, location } = req.query;

        if (!startDate || !endDate) {
            return res.status(400).send({ error: 'Les dates de début et de fin sont requises.' });
        }

        // 1. Récupérer le teamId
        const { teamId, userProfile } = await getOrInitializeTeamId(userId);

        let properties = await db.getPropertiesByTeam(teamId);
        
        // 1.5 Appliquer les filtres sur les propriétés
        if (propertyType) {
            properties = properties.filter(p => p.property_type === propertyType);
        }
        if (channel) {
            properties = properties.filter(p => p.channel === channel);
        }
        if (status) {
            properties = properties.filter(p => p.status === status);
        }
        if (location) {
            const locLower = location.toLowerCase();
            properties = properties.filter(p => 
                (p.location && p.location.toLowerCase().includes(locLower)) || 
                (p.address && p.address.toLowerCase().includes(locLower))
            );
        }
        
        const filteredPropertyIds = new Set(properties.map(p => p.id));
        
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
        let bookings = await db.getBookingsByTeamAndDateRange(teamId, startDate, endDate);
        
        // 3.5 Filtrer les bookings pour ne garder que ceux des propriétés filtrées
        bookings = bookings.filter(booking => filteredPropertyIds.has(booking.property_id));

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
        const { startDate, endDate, propertyType, channel, status, location } = req.query;

        if (!startDate || !endDate) {
            return res.status(400).send({ error: 'Les dates de début et de fin sont requises.' });
        }

        // 1. Récupérer le teamId
        const { teamId, userProfile } = await getOrInitializeTeamId(userId);

        let properties = await db.getPropertiesByTeam(teamId);
        
        // 1.5 Appliquer les filtres sur les propriétés
        if (propertyType) {
            properties = properties.filter(p => p.property_type === propertyType);
        }
        if (channel) {
            properties = properties.filter(p => p.channel === channel);
        }
        if (status) {
            properties = properties.filter(p => p.status === status);
        }
        if (location) {
            const locLower = location.toLowerCase();
            properties = properties.filter(p => 
                (p.location && p.location.toLowerCase().includes(locLower)) || 
                (p.address && p.address.toLowerCase().includes(locLower))
            );
        }
        
        const filteredPropertyIds = new Set(properties.map(p => p.id));
        
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
        let [currentBookings, prevBookings] = await Promise.all([
            db.getBookingsByTeamAndDateRange(teamId, startDate, endDate),
            db.getBookingsByTeamAndDateRange(teamId, prevStartDate, prevEndDate)
        ]);
        
        // 3.5 Filtrer les bookings pour ne garder que ceux des propriétés filtrées
        currentBookings = currentBookings.filter(booking => filteredPropertyIds.has(booking.property_id));
        prevBookings = prevBookings.filter(booking => filteredPropertyIds.has(booking.property_id));

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
app.post('/api/reports/analyze-date', authenticateToken, checkAIQuota, async (req, res) => {
    let tokensUsed = 0;
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
        
        // 2. Sanitiser et valider les inputs avant injection dans le prompt IA
        // 2.1. Valider et sanitiser la date
        let sanitizedDate;
        try {
            sanitizedDate = validateAndSanitizeDate(date);
        } catch (dateError) {
            console.error(`[Sanitization] Erreur de validation de date: ${dateError.message}`);
            return res.status(400).send({ error: `Date invalide: ${dateError.message}` });
        }
        
        // 2.2. Sanitiser la location
        const rawLocation = property.location || 'France';
        const sanitizedLocation = sanitizeForPrompt(rawLocation, 100);
        const city = sanitizedLocation.split(',')[0].trim();
        
        // 2.3. Sanitiser le type de propriété
        const rawPropertyType = property.property_type || property.propertyType || 'appartement';
        const sanitizedPropertyType = sanitizeForPrompt(rawPropertyType, 50);
        
        // 2.4. Sanitiser la capacité (convertir en nombre sécurisé)
        const rawCapacity = property.capacity || 2;
        let capacity;
        try {
            capacity = sanitizeNumber(rawCapacity, 1, 50, 'capacity', userId, { mustBeInteger: true, mustBePositive: true });
        } catch (capacityError) {
            console.error(`[Sanitization] Erreur de validation de capacité: ${capacityError.message}`);
            return res.status(400).send({ error: `Capacité invalide: ${capacityError.message}` });
        }
        
        // 2.5. Logger les valeurs sanitizées pour debugging
        console.log(`[Sanitization] Inputs sanitizés pour l'analyse de date:`);
        console.log(`  - Date: ${date} → ${sanitizedDate}`);
        console.log(`  - Location: ${rawLocation} → ${sanitizedLocation} (city: ${city})`);
        console.log(`  - Property Type: ${rawPropertyType} → ${sanitizedPropertyType}`);
        console.log(`  - Capacity: ${rawCapacity} → ${capacity}`);
        
        // Récupérer la langue de l'utilisateur
        const language = req.query.language || userProfile?.language || 'fr';
        const isFrench = language === 'fr' || language === 'fr-FR';

        // 3. Construire le prompt pour ChatGPT avec les valeurs sanitizées
        const prompt = isFrench ? `
            Tu es un analyste de marché expert pour la location saisonnière.
            Analyse la demande du marché pour la date spécifique: **${sanitizedDate}**
            dans la ville de: **${city}**
            pour un logement de type "${sanitizedPropertyType}" pouvant accueillir **${capacity} personnes**.

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
            Analyze market demand for the specific date: **${sanitizedDate}**
            in the city of: **${city}**
            for a "${sanitizedPropertyType}" type accommodation that can accommodate **${capacity} people**.

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

        // 4. Appeler Perplexity/ChatGPT avec recherche web et capturer les tokens
        const aiResponse = await callGeminiWithSearch(prompt, 10, language);
        
        // Gérer le nouveau format de retour { data, tokens } ou l'ancien format (rétrocompatibilité)
        let analysisResult;
        if (aiResponse && typeof aiResponse === 'object' && 'data' in aiResponse) {
            // Nouveau format : { data, tokens }
            analysisResult = aiResponse.data;
            tokensUsed = aiResponse.tokens || 0;
        } else {
            // Ancien format : données directement
            analysisResult = aiResponse;
            tokensUsed = 2000; // Estimation par défaut si les tokens ne sont pas disponibles
        }

        if (!analysisResult || !analysisResult.marketDemand) {
            // Si l'appel IA échoue, ne pas incrémenter le quota (déjà fait par le middleware)
            // Mais on peut annuler l'incrémentation si nécessaire
            return res.status(503).send({ error: "L'analyse IA n'a pas pu générer de réponse valide." });
        }

        // 5. Mettre à jour le quota avec les tokens réels utilisés
        // Note: Le quota a déjà été incrémenté par le middleware, on doit juste mettre à jour les tokens
        // On va récupérer la valeur actuelle puis l'incrémenter
        const today = new Date().toISOString().split('T')[0];
        const { data: currentQuota } = await supabase
            .from('user_ai_usage')
            .select('tokens_used')
            .eq('user_id', userId)
            .eq('date', today)
            .single();
        
        if (currentQuota) {
            await supabase
                .from('user_ai_usage')
                .update({
                    tokens_used: (currentQuota.tokens_used || 0) + tokensUsed,
                    updated_at: new Date().toISOString()
                })
                .eq('user_id', userId)
                .eq('date', today);
        }

        // 6. Logger l'utilisation
        const quotaInfo = req.aiQuota || {};
        console.log(`[AI Quota] User ${userId} used ${tokensUsed} tokens, remaining: ${quotaInfo.remaining || 0} calls`);

        // 7. Renvoyer le résultat
        res.status(200).json(analysisResult);

    } catch (error) {
        console.error(`Erreur lors de l'analyse de la date ${req.body?.date}:`, error);
        
        // Si l'appel IA échoue, on a déjà incrémenté le quota dans le middleware
        // On pourrait annuler l'incrémentation, mais pour l'instant on la garde
        // (l'utilisateur a consommé son quota même si l'appel a échoué)
        
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
 * Récupère ou crée le quota IA d'un utilisateur et retourne les informations de quota
 * @param {string} userId - ID de l'utilisateur
 * @returns {Promise<{callsToday: number, maxCalls: number, tokensUsed: number, maxTokens: number, canMakeCall: boolean}>}
 */
async function getUserAIQuota(userId) {
    try {
        const today = new Date().toISOString().split('T')[0]; // Format YYYY-MM-DD
        
        // 1. Récupérer ou créer un enregistrement dans user_ai_usage pour aujourd'hui
        // Utiliser la fonction SQL get_or_create_ai_quota ou faire un INSERT ON CONFLICT
        const { data: quotaData, error: quotaError } = await supabase
            .from('user_ai_usage')
            .select('*')
            .eq('user_id', userId)
            .eq('date', today)
            .single();
        
        let callsToday = 0;
        let tokensUsed = 0;
        
        if (quotaError && quotaError.code === 'PGRST116') {
            // Aucun enregistrement trouvé, créer un nouveau
            const { data: newQuota, error: insertError } = await supabase
                .from('user_ai_usage')
                .insert({
                    user_id: userId,
                    date: today,
                    calls_count: 0,
                    tokens_used: 0
                })
                .select()
                .single();
            
            if (insertError) {
                console.error('[AI Quota] Erreur lors de la création du quota:', insertError);
                throw new Error('Erreur lors de la création du quota IA');
            }
            
            callsToday = newQuota.calls_count || 0;
            tokensUsed = newQuota.tokens_used || 0;
        } else if (quotaError) {
            console.error('[AI Quota] Erreur lors de la récupération du quota:', quotaError);
            throw new Error('Erreur lors de la récupération du quota IA');
        } else {
            callsToday = quotaData.calls_count || 0;
            tokensUsed = quotaData.tokens_used || 0;
        }
        
        // 2. Récupérer le profil utilisateur pour déterminer la limite
        const userProfile = await db.getUser(userId);
        if (!userProfile) {
            throw new Error('Profil utilisateur non trouvé');
        }
        
        // 3. Déterminer la limite selon le statut d'abonnement
        const subscriptionStatus = userProfile.subscription_status || 'none';
        let maxCalls = 10; // Par défaut : sans abonnement
        let maxTokens = 100000; // Par défaut : 100k tokens/jour
        
        if (subscriptionStatus === 'trialing') {
            // Essai gratuit : 50 appels/jour
            maxCalls = 50;
            maxTokens = 500000; // 500k tokens/jour
        } else if (subscriptionStatus === 'active') {
            // Abonné actif : 200 appels/jour
            maxCalls = 200;
            maxTokens = 2000000; // 2M tokens/jour
        }
        // Sinon : sans abonnement (déjà défini par défaut)
        
        // 4. Calculer si l'utilisateur peut faire un appel
        const canMakeCall = callsToday < maxCalls;
        
        // 5. Retourner l'objet avec toutes les informations
        return {
            callsToday,
            maxCalls,
            tokensUsed,
            maxTokens,
            canMakeCall,
            remaining: Math.max(0, maxCalls - callsToday),
            subscriptionStatus
        };
        
    } catch (error) {
        console.error('[AI Quota] Erreur dans getUserAIQuota:', error);
        // En cas d'erreur, retourner des valeurs par défaut sécurisées (fail-safe)
        return {
            callsToday: 0,
            maxCalls: 10, // Limite minimale
            tokensUsed: 0,
            maxTokens: 100000,
            canMakeCall: true, // Autoriser par défaut en cas d'erreur
            remaining: 10,
            subscriptionStatus: 'none'
        };
    }
}

/**
 * Vérifie et incrémente le quota IA d'un utilisateur de manière atomique
 * Utilise une condition WHERE pour éviter les race conditions
 * @param {string} userId - ID de l'utilisateur
 * @param {number} tokensUsed - Nombre de tokens utilisés (par défaut 0)
 * @returns {Promise<{allowed: boolean, remaining: number, limit?: number, callsToday?: number}>}
 */
async function checkAndIncrementAIQuota(userId, tokensUsed = 0) {
    try {
        // 1. Obtenir les quotas actuels
        const quota = await getUserAIQuota(userId);
        
        // 2. Vérifier si l'utilisateur peut faire un appel
        if (!quota.canMakeCall || quota.callsToday >= quota.maxCalls) {
            // Quota atteint
            return {
                allowed: false,
                remaining: 0,
                limit: quota.maxCalls,
                callsToday: quota.callsToday
            };
        }
        
        // 3. Incrémenter atomiquement avec une condition WHERE pour éviter les race conditions
        // On utilise UPDATE avec WHERE calls_count < max_calls pour garantir l'atomicité
        const today = new Date().toISOString().split('T')[0];
        
        // UPDATE atomique : seulement si calls_count < maxCalls
        // Cela garantit qu'on ne peut pas dépasser la limite même avec des requêtes simultanées
        const { data: updatedData, error: updateError } = await supabase
            .from('user_ai_usage')
            .update({
                calls_count: quota.callsToday + 1,
                tokens_used: quota.tokensUsed + tokensUsed,
                updated_at: new Date().toISOString()
            })
            .eq('user_id', userId)
            .eq('date', today)
            .lt('calls_count', quota.maxCalls) // Condition atomique : seulement si calls_count < maxCalls
            .select();
        
        if (updateError) {
            console.error('[AI Quota] Erreur lors de l\'incrémentation du quota:', updateError);
            throw new Error('Erreur lors de l\'incrémentation du quota IA');
        }
        
        // Vérifier si l'UPDATE a réellement mis à jour une ligne
        // Si updatedData est vide ou null, c'est que la condition WHERE n'a pas été satisfaite
        // (race condition : le quota a été atteint entre la vérification et l'incrémentation)
        if (!updatedData || updatedData.length === 0) {
            // Race condition détectée : le quota a été atteint par une autre requête
            console.warn(`[AI Quota] Race condition détectée pour l'utilisateur ${userId}. Quota atteint entre la vérification et l'incrémentation.`);
            // Re-récupérer le quota actuel pour avoir les vraies valeurs
            const currentQuota = await getUserAIQuota(userId);
            return {
                allowed: false,
                remaining: 0,
                limit: currentQuota.maxCalls,
                callsToday: currentQuota.callsToday
            };
        }
        
        // 4. Calculer les appels restants après l'incrémentation
        const updatedRecord = updatedData[0];
        const newCallsToday = updatedRecord.calls_count;
        const remaining = Math.max(0, quota.maxCalls - newCallsToday);
        
        // 5. Retourner le résultat
        return {
            allowed: true,
            remaining: remaining,
            callsToday: newCallsToday,
            tokensUsed: updatedRecord.tokens_used,
            limit: quota.maxCalls
        };
        
    } catch (error) {
        console.error('[AI Quota] Erreur dans checkAndIncrementAIQuota:', error);
        // En cas d'erreur, refuser l'accès par sécurité (fail-safe)
        return {
            allowed: false,
            remaining: 0,
            limit: 0
        };
    }
}

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
                        const cleanedData = cleanCitations(parsedData);
                        
                        // Retourner les données avec les tokens si disponibles
                        if (response.usage) {
                            return {
                                data: cleanedData,
                                tokens: response.usage.total_tokens || 0
                            };
                        }
                        return cleanedData;
                    }
                    
                    // Retourner les données avec les tokens si disponibles
                    if (response.usage) {
                        return {
                            data: parsedData,
                            tokens: response.usage.total_tokens || 0
                        };
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

// POST /api/properties/:id/pricing-strategy - Générer une stratégie de prix (HYBRIDE)
app.post('/api/properties/:id/pricing-strategy', authenticateToken, async (req, res) => {
    // 1. Initialisation et Variables
    const { id } = req.params;
    const userId = req.user.uid;
    const userEmail = req.user.email;
    // On récupère le flag 'force' et le contexte de groupe
    const { useMarketData, group_context, force } = req.body;
    let tokensUsed = 0;
    
    try {
        // --- NOUVEAU BLOC : VÉRIFICATION ANTI-DOUBLON ---
        if (!force) {
            let lastUpdate = null;

            if (group_context && group_context.id) {
                // Si c'est un groupe, on vérifie la date du groupe
                const { data: groupCheck } = await supabase
                    .from('groups')
                    .select('last_pricing_update')
                    .eq('id', group_context.id)
                    .single();
                lastUpdate = groupCheck?.last_pricing_update;
            } else {
                // Sinon on vérifie la propriété
                const { data: propCheck } = await supabase
                    .from('properties')
                    .select('last_pricing_update')
                    .eq('id', id)
                    .single();
                lastUpdate = propCheck?.last_pricing_update;
            }

            if (lastUpdate) {
                const lastDate = new Date(lastUpdate).toDateString();
                const todayDate = new Date().toDateString();

                if (lastDate === todayDate) {
                    console.log(`[Pricing] ⏩ Génération ignorée : Déjà mis à jour aujourd'hui (${lastDate}).`);
                    return res.status(200).json({
                        message: "Stratégie déjà à jour pour aujourd'hui.",
                        skipped: true, // Indicateur pour le frontend
                        days_generated: 0
                    });
                }
            }
        }
        // -----------------------------------------------------

        // 2. Récupérer la propriété
        const property = await db.getProperty(id);
        if (!property) return res.status(404).send({ error: 'Propriété non trouvée.' });

        // 3. Préparation des dates (6 mois)
        const today = new Date().toISOString().split('T')[0];
        const endDate = new Date();
        endDate.setDate(endDate.getDate() + 180);
        const endDateStr = endDate.toISOString().split('T')[0];
        const city = property.location?.split(',')[0].trim() || '';
        const country = property.country || 'FR';

        // =================================================================
        // ÉTAPE A : CALCUL DÉTERMINISTE (SOCLE STABLE)
        // =================================================================
        console.log(`[Pricing] 1. Calcul du socle déterministe...`);
        const deterministicPricing = require('./utils/deterministic_pricing');
        
        // On génère TOUJOURS le calendrier déterministe en premier
        // Il servira de "Base" pour l'IA ou de "Fallback" si l'IA échoue
        const deterministicCalendar = await deterministicPricing.generateDeterministicPricingCalendar({ 
            property, 
            startDate: today, 
            endDate: endDateStr, 
            city, 
            country 
        });

        // =================================================================
        // ÉTAPE B : INTELLIGENCE ARTIFICIELLE (AJUSTEMENT DYNAMIQUE)
        // =================================================================
        let finalCalendar = [];
        let method = 'deterministic';
        let aiSummary = '';

        // On tente l'IA sauf si quota dépassé (vérifié par middleware idéalement, ou ici)
        try {
            console.log(`[Pricing] 2. Appel de l'IA pour optimisation...`);
            
            // On prépare un prompt qui connaît DÉJÀ le prix déterministe
            // Cela aide l'IA à ne pas partir de zéro mais à "critiquer" et "ajuster"
            const sampleBasePrice = deterministicCalendar[0]?.price || property.base_price;
            const language = property.language || 'fr';
            
            const prompt = `
            CONTEXTE:
            Tu es un expert Revenue Manager. Je vais te fournir un calendrier de prix de base calculé mathématiquement (saisonnalité simple).
            Ta mission est d'optimiser ces prix en fonction de la demande réelle, des événements à ${city} et de la psychologie.
            
            DONNÉES:
            - Propriété: ${property.name} (${property.property_type}, ${property.capacity} pers) à ${city}.
            - Prix de Base Mathématique (Moyenne): ${sampleBasePrice}€
            - Stratégie: ${property.strategy || 'Équilibré'}
            
            INSTRUCTIONS:
            Génère une liste de prix optimisés pour les 180 prochains jours.
            - Si un événement majeur a lieu à ${city}, augmente fortement le prix (+50% à +200%).
            - Si c'est une période creuse, baisse légèrement pour attirer (-10%).
            - Garde la logique Week-end (plus cher) sauf si demande très faible.
            
            FORMAT DE RÉPONSE ATTENDU (JSON PUR, pas de texte):
            {
                "market_sentiment": "Court résumé de la tendance (ex: Forte demande due aux JO)",
                "calendar": [
                    { "date": "YYYY-MM-DD", "price": 120, "reason": "Weekend + Concert" }
                    // ... suite du calendrier
                ]
            }
            `;

            // Appel IA (Simulé ici par votre fonction existante)
            const aiResponseRaw = await callGeminiWithSearch(prompt, 10, language); // Fonction existante
            
            // Gérer le nouveau format de retour { data, tokens } ou l'ancien format (rétrocompatibilité)
            let aiResponse;
            if (aiResponseRaw && typeof aiResponseRaw === 'object' && 'data' in aiResponseRaw) {
                // Nouveau format : { data, tokens }
                aiResponse = aiResponseRaw.data;
                tokensUsed = aiResponseRaw.tokens || 1000;
            } else {
                // Ancien format : données directement
                aiResponse = aiResponseRaw;
                tokensUsed = 1000; // Estimation par défaut
            }
            
            if (aiResponse && aiResponse.calendar) {
                console.log(`[Pricing] ✓ IA Réussie. Fusion des stratégies.`);
                
                // =================================================================
                // ÉTAPE C : FUSION HYBRIDE (MERGE)
                // =================================================================
                // On prend le prix IA, mais on le garde dans les bornes min/max de la propriété
                
                const aiMap = new Map(aiResponse.calendar.map(d => [d.date, d]));
                
                finalCalendar = deterministicCalendar.map(detDay => {
                    const aiDay = aiMap.get(detDay.date);
                    
                    let finalPrice = detDay.price;
                    let reason = detDay.reasoning;
                    
                    if (aiDay) {
                        // L'IA a une opinion -> On l'utilise
                        finalPrice = aiDay.price;
                        reason = `IA: ${aiDay.reason}`;
                    }
                    
                    // SAFETY CHECK (Guardrails ultimes)
                    // On s'assure que l'IA ne descend pas sous le plancher ou ne crève pas le plafond
                    const min = property.floor_price || 0;
                    const max = property.ceiling_price || 9999;
                    
                    if (finalPrice < min) { finalPrice = min; reason += " (Plancher)"; }
                    if (finalPrice > max) { finalPrice = max; reason += " (Plafond)"; }
                    
                    return {
                        date: detDay.date,
                        price: Math.round(finalPrice),
                        reason: reason
                    };
                });
                
                method = 'ai_hybrid';
                aiSummary = aiResponse.market_sentiment;
                tokensUsed = aiResponse.tokens || 1000;
            } else {
                throw new Error("Format réponse IA invalide");
            }

        } catch (aiError) {
            console.warn(`[Pricing] ⚠️ Échec IA (${aiError.message}). Repli sur le déterministe pur.`);
            // Fallback : on utilise le calendrier déterministe tel quel
            finalCalendar = deterministicCalendar.map(d => ({
                date: d.date,
                price: d.price,
                reason: d.reasoning || "Prix calculé (Algorithme)"
            }));
            
            // On annule le débit de quota puisque l'IA a échoué
            // (Insérer ici logique d'annulation quota si nécessaire)
        }

        // 4. Sauvegarde en base
        const overridesToSave = finalCalendar.map(day => ({
            date: day.date,
            price: day.price,
            reason: day.reason,
            isLocked: false,
            updatedBy: userId
        }));

        if (overridesToSave.length > 0) {
            await db.upsertPriceOverrides(id, overridesToSave);
        }

        // Si le pricing automatique est activé pour cette propriété, mettre à jour auto_pricing_updated_at
        if (property.auto_pricing_enabled) {
            await db.updateProperty(id, {
                auto_pricing_updated_at: new Date().toISOString()
            });
        }

        // =================================================================
        // ÉTAPE D : PROPAGATION AUX GROUPES (SYNC) ET MISE À JOUR GROUPE
        // =================================================================
        
        // 1. Chercher si c'est une propriété principale de groupe
        const { data: groupData, error: groupError } = await supabase
            .from('groups') 
            .select('*') 
            .eq('main_property_id', id)
            .single();

        let syncCount = 0;

        if (groupData) {
            console.log(`[Pricing] 🔄 Mise à jour des infos du groupe "${groupData.name}"...`);

            // 2. MISE À JOUR DE LA TABLE GROUPS
            // On enregistre la date, la stratégie utilisée et le résumé
            const updatePayload = {
                last_pricing_update: new Date().toISOString(),
                pricing_strategy: method, // 'deterministic' ou 'ai_hybrid'
                strategy_summary: aiSummary || "Mise à jour automatique",
                // CORRECTION ICI : Utilisation du nom de colonne 'auto_pricing_enabled'
                auto_pricing_enabled: true 
            };

            const { error: updateGroupError } = await supabase
                .from('groups')
                .update(updatePayload)
                .eq('id', groupData.id);

            if (updateGroupError) {
                console.error("Erreur mise à jour table groups:", updateGroupError);
            }

            // 3. PROPAGATION AUX ENFANTS (Si la synchro est activée)
            if (groupData.sync_prices) {
                const { data: children } = await supabase
                    .from('group_members')
                    .select('property_id')
                    .eq('group_id', groupData.id);

                if (children && children.length > 0) {
                    const bulkOverrides = [];
                    for (const child of children) {
                        // On copie les prix calculés
                        overridesToSave.forEach(day => {
                            bulkOverrides.push({
                                ...day,
                                property_id: child.property_id,
                                updatedBy: userId
                            });
                        });
                    }

                    if (bulkOverrides.length > 0) {
                        const { error: syncError } = await supabase
                            .from('price_overrides')
                            .upsert(bulkOverrides, { onConflict: 'property_id, date' });
                        
                        if (syncError) console.error("Erreur sync enfants:", syncError);
                        else syncCount = children.length;
                    }
                }
            }
        }

        // 5. Réponse Client (Mise à jour pour inclure l'info de sync)
        res.status(200).json({
            strategy_summary: aiSummary || "Stratégie algorithmique standard",
            daily_prices: finalCalendar,
            method: method,
            days_generated: finalCalendar.length,
            synced_properties: syncCount // Feedback pour le frontend
        });

    } catch (error) {
        console.error("Erreur critique pricing:", error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/pricing/recommend
 * Retourne un prix recommandé par le moteur de pricing IA pour une propriété / date donnée.
 * 
 * Cette version intègre les trois couches de sécurité :
 * 1. Sanitizer (validation et nettoyage des entrées)
 * 2. Bridge (communication avec le processus Python persistant)
 * 3. Guardrails (validation finale du prix avant retour)
 */
app.post('/api/pricing/recommend', authenticateToken, validatePricingRequest, async (req, res) => {
    const userId = req.user.uid;
    const { property_id, room_type = 'default', date, dateRange, options } = req.body;
    
    try {
        // -----------------------------------------------------------
        // 1. VALIDATION ET SANITIZATION (Pare-feu entrée)
        // -----------------------------------------------------------
        // Note: Le middleware validatePricingRequest a déjà fait une première sanitization
        // On fait une sanitization supplémentaire avec les fonctions strictes
        const safePropertyId = sanitizePropertyIdStrict(property_id);
        const safeOptions = sanitizePricingParams({ room_type, ...options });
        
        // Support de deux formats : date unique (compatibilité) ou dateRange
        let safeStartDate, safeEndDate;
        if (dateRange && dateRange.start && dateRange.end) {
            safeStartDate = sanitizeDateStrict(dateRange.start);
            safeEndDate = sanitizeDateStrict(dateRange.end);
        } else if (date) {
            // Compatibilité : si date unique fournie, on crée une plage d'un jour
            safeStartDate = sanitizeDateStrict(date);
            safeEndDate = safeStartDate;
        } else {
            return res.status(400).json({
                status: 'error',
                code: 'VALIDATION_ERROR',
                message: 'date ou dateRange (avec start et end) est requis'
            });
        }

        if (!safeStartDate || !safeEndDate) {
            return res.status(400).json({
                status: 'error',
                code: 'VALIDATION_ERROR',
                message: 'Dates invalides'
            });
        }

        // -----------------------------------------------------------
        // 2. VÉRIFICATION DES PERMISSIONS UTILISATEUR
        // CORRECTION 1 : On récupère city et country pour que l'algo puisse chercher la météo/événements
        // -----------------------------------------------------------
        const { data: property, error: propError } = await supabase
            .from('properties')
            .select('id, base_price, min_price, max_price, name, city, country, weekend_markup_percent, floor_price, ceiling_price, strategy, team_id, owner_id')
            .eq('id', safePropertyId)
            .single();

        if (propError || !property) {
            return res.status(404).json({ 
                status: 'error',
                code: 'PROPERTY_NOT_FOUND',
                message: 'Propriété introuvable.' 
            });
        }

        const userProfile = await db.getUser(userId);
        if (!userProfile) {
            return res.status(404).json({ 
                status: 'error',
                code: 'USER_NOT_FOUND',
                message: 'Profil utilisateur non trouvé.' 
            });
        }

        const propertyTeamId = property.team_id || property.owner_id;
        if (userProfile.team_id !== propertyTeamId) {
            return res.status(403).json({ 
                status: 'error',
                code: 'UNAUTHORIZED',
                message: 'Action non autorisée sur cette propriété (pas dans la bonne équipe).' 
            });
        }

        // -----------------------------------------------------------
        // 3. RÉCUPÉRATION DU CONTEXTE (Pour Safety Guardrails)
        // -----------------------------------------------------------
        const propertyContext = {
            base_price: property.base_price || 100,
            min_price: property.min_price || property.floor_price || 0,
            max_price: property.max_price || property.ceiling_price || Infinity,
            ...safeOptions
        };

        // -----------------------------------------------------------
        // 4. GÉNÉRATION DE LA LISTE DES JOURS
        // -----------------------------------------------------------
        const allDates = getDatesBetween(safeStartDate, safeEndDate);

        // -----------------------------------------------------------
        // 5. CALCUL DÉTERMINISTE POUR CHAQUE JOUR
        // CORRECTION 2 : Utilisation de Promise.all pour attendre les résultats asynchrones
        // CORRECTION 3 : Passage des bons arguments sous forme d'objet
        // -----------------------------------------------------------
        const deterministicPricing = require('./utils/deterministic_pricing');
        const dailyPricesAlgo = await Promise.all(allDates.map(async (dateStr) => {
            const result = await deterministicPricing.calculateDeterministicPrice({
                property: property,
                date: dateStr,
                city: property.city,
                country: property.country
            });
            return { 
                date: dateStr, 
                price: result.price, 
                details: result.reasoning || result.breakdown || {}
            };
        }));

        // -----------------------------------------------------------
        // 6. APPEL IA (Tendance globale)
        // -----------------------------------------------------------
        let aiFactor = 1.0;
        let aiConfidence = 0;
        let source = 'deterministic';

        try {
            const pricingBridge = require('./pricing_engine/bridge');
            const aiResult = await pricingBridge.getPricingPrediction({
                propertyId: safePropertyId,
                dateRange: { start: safeStartDate, end: safeEndDate },
                context: { base_price: property.base_price }
            });

            if (aiResult && (aiResult.recommended_price || aiResult.price)) {
                const aiPrice = aiResult.recommended_price || aiResult.price;
                aiFactor = aiPrice / property.base_price;
                aiConfidence = aiResult.confidence || aiResult.confidence_score || 0;
                source = 'hybrid';
            }
        } catch (err) {
            console.warn("IA non disponible, utilisation courbe déterministe pure.");
        }

        // -----------------------------------------------------------
        // 7. FUSION & CALCUL FINAL PAR JOUR
        // -----------------------------------------------------------
        const finalCalendar = dailyPricesAlgo.map(dayItem => {
            // Prix Algo (qui contient déjà la logique Weekend/Saison)
            const algoPrice = dayItem.price;

            // Prix Hybride : On applique le facteur IA pondéré par la confiance
            // Formule : Prix = PrixAlgo * (1 + (VariationIA * Confiance))
            // C'est une façon simple de dire : "Garde la forme de la courbe Algo (Weekends chers), mais monte/descend le niveau selon l'IA"
            
            let finalDailyPrice = algoPrice;
            
            if (source === 'hybrid') {
                // Exemple : Algo dit 100 (lundi), IA facteur 1.2 (demande forte), Confiance 0.8
                // Ajustement = 100 * (1 + (0.2 * 0.8)) = 100 * 1.16 = 116€
                const adjustmentRatio = (aiFactor - 1) * aiConfidence;
                finalDailyPrice = algoPrice * (1 + adjustmentRatio);
            }

            // Guardrails (Min/Max)
            const safety = validatePriceSafety(finalDailyPrice, propertyContext);

            return {
                date: dayItem.date,
                price: safety.safePrice,
                source: source,
                is_adjusted: safety.wasAdjusted,
                details: dayItem.details // Garde les infos "Pourquoi" (ex: "Weekend")
            };
        });

        // -----------------------------------------------------------
        // 8. LOGGING (Traçabilité - pour chaque jour)
        // -----------------------------------------------------------
        // On log chaque jour dans la base (fire and forget)
        finalCalendar.forEach(day => {
            // Log asynchrone (ne bloque pas la réponse)
            db.upsertPriceOverrides(safePropertyId, [{
                date: day.date,
                price: day.price,
                reason: day.details || 'Prix recommandé',
                isLocked: false,
                updatedBy: userId
            }]).catch(err => {
                console.error(`[Pricing Recommend] Erreur lors de la sauvegarde du prix pour ${day.date}:`, err);
            });
        });

        // -----------------------------------------------------------
        // 9. RÉPONSE FINALE
        // -----------------------------------------------------------
        res.status(200).json({
            status: 'success',
            property_id: safePropertyId,
            date_range: {
                start: safeStartDate,
                end: safeEndDate
            },
            calendar: finalCalendar,
            method: source,
            summary: {
                days_count: finalCalendar.length,
                avg_price: Math.round(finalCalendar.reduce((sum, d) => sum + d.price, 0) / finalCalendar.length),
                min_price: Math.min(...finalCalendar.map(d => d.price)),
                max_price: Math.max(...finalCalendar.map(d => d.price))
            }
        });

    } catch (error) {
        console.error('[Pricing Recommend] Erreur:', error);
        res.status(500).json({
            status: 'error',
            code: 'INTERNAL_ERROR',
            message: error.message || 'Erreur interne du serveur'
        });
    }
});

/**
 * POST /api/pricing/simulate
        let sanitizedCapacity;
        try {
            sanitizedCapacity = validateCapacity(rawCapacity, 'property.capacity', userId);
        } catch (capacityError) {
            console.error(`[Validation Error] [Endpoint: ${endpoint}] [userId: ${userId}] ${capacityError.message}`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: capacityError.message 
            });
        }
        if (rawCapacity !== sanitizedCapacity) {
            sanitizationWarnings.push(`Capacity: ${rawCapacity} → ${sanitizedCapacity}`);
        }
        
        // Valider surface (nombre positif ou zéro)
        const rawSurface = property.surface || 0;
        let sanitizedSurface;
        try {
            sanitizedSurface = sanitizeNumber(rawSurface, 0, Infinity, 'surface', userId);
        } catch (surfaceError) {
            console.error(`[Sanitization] Erreur de validation de surface: ${surfaceError.message}`);
            return res.status(400).send({ error: `Surface invalide: ${surfaceError.message}` });
        }
        if (rawSurface !== sanitizedSurface) {
            sanitizationWarnings.push(`Surface: ${rawSurface} → ${sanitizedSurface}`);
        }
        
        // Sanitiser amenities (tableau)
        const rawAmenities = property.amenities || [];
        const sanitizedAmenities = sanitizeArray(rawAmenities, 50, (item) => sanitizeForPrompt(String(item), 50));
        if (JSON.stringify(rawAmenities) !== JSON.stringify(sanitizedAmenities)) {
            sanitizationWarnings.push(`Amenities: ${rawAmenities.length} items → ${sanitizedAmenities.length} items sanitizés`);
        }
        
        // Valider strategy avec validateEnum
        const rawStrategy = property.strategy || 'Équilibré';
        let sanitizedStrategy;
        try {
            sanitizedStrategy = validateEnum(rawStrategy, ALLOWED_STRATEGIES, 'property.strategy', userId);
        } catch (strategyError) {
            console.error(`[Validation Error] [Endpoint: ${endpoint}] [userId: ${userId}] ${strategyError.message}`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: strategyError.message 
            });
        }
        if (rawStrategy !== sanitizedStrategy) {
            sanitizationWarnings.push(`Strategy: "${rawStrategy}" → "${sanitizedStrategy}"`);
        }
        
        // Valider base_price, floor_price, ceiling_price avec validatePrice
        const rawBasePrice = property.base_price || 100;
        let sanitizedBasePrice;
        try {
            sanitizedBasePrice = validatePrice(rawBasePrice, 0, Infinity, 'property.base_price', userId);
        } catch (basePriceError) {
            console.error(`[Validation Error] [Endpoint: ${endpoint}] [userId: ${userId}] ${basePriceError.message}`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: basePriceError.message 
            });
        }
        if (rawBasePrice !== sanitizedBasePrice) {
            sanitizationWarnings.push(`Base Price: ${rawBasePrice} → ${sanitizedBasePrice}`);
        }
        
        const rawFloorPrice = property.floor_price || 50;
        let sanitizedFloorPrice;
        try {
            sanitizedFloorPrice = validatePrice(rawFloorPrice, 0, Infinity, 'property.floor_price', userId);
        } catch (floorPriceError) {
            console.error(`[Validation Error] [Endpoint: ${endpoint}] [userId: ${userId}] ${floorPriceError.message}`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: floorPriceError.message 
            });
        }
        if (rawFloorPrice !== sanitizedFloorPrice) {
            sanitizationWarnings.push(`Floor Price: ${rawFloorPrice} → ${sanitizedFloorPrice}`);
        }
        
        const rawCeilingPrice = property.ceiling_price || null;
        let sanitizedCeilingPrice = null;
        if (rawCeilingPrice !== null && rawCeilingPrice !== undefined) {
            try {
                sanitizedCeilingPrice = validatePrice(rawCeilingPrice, 0, Infinity, 'property.ceiling_price', userId);
            } catch (ceilingPriceError) {
                console.error(`[Validation Error] [Endpoint: ${endpoint}] [userId: ${userId}] ${ceilingPriceError.message}`);
                return res.status(400).json({ 
                    error: 'Validation échouée', 
                    message: ceilingPriceError.message 
                });
            }
        }
        if (rawCeilingPrice !== sanitizedCeilingPrice) {
            sanitizationWarnings.push(`Ceiling Price: ${rawCeilingPrice} → ${sanitizedCeilingPrice}`);
        }
        
        // 2. Valider les plages de prix (floor_price < base_price < ceiling_price)
        if (sanitizedFloorPrice >= sanitizedBasePrice) {
            const errorMsg = `Le prix plancher (${sanitizedFloorPrice}) doit être strictement inférieur au prix de base (${sanitizedBasePrice}).`;
            console.error(`[Validation Error] [Endpoint: ${endpoint}] [userId: ${userId}] ${errorMsg}`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: errorMsg 
            });
        }
        
        if (sanitizedCeilingPrice !== null && sanitizedBasePrice >= sanitizedCeilingPrice) {
            const errorMsg = `Le prix de base (${sanitizedBasePrice}) doit être strictement inférieur au prix plafond (${sanitizedCeilingPrice}).`;
            console.error(`[Validation Error] [Endpoint: ${endpoint}] [userId: ${userId}] ${errorMsg}`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: errorMsg 
            });
        }
        
        // 3. Valider tous les pourcentages (0-100) avec validatePercentage
        const rawWeeklyDiscount = property.weekly_discount_percent || 0;
        let sanitizedWeeklyDiscount;
        try {
            sanitizedWeeklyDiscount = validatePercentage(rawWeeklyDiscount, 'property.weekly_discount_percent', userId);
        } catch (weeklyDiscountError) {
            console.error(`[Validation Error] [Endpoint: ${endpoint}] [userId: ${userId}] ${weeklyDiscountError.message}`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: weeklyDiscountError.message 
            });
        }
        if (rawWeeklyDiscount !== sanitizedWeeklyDiscount) {
            sanitizationWarnings.push(`Weekly Discount: ${rawWeeklyDiscount}% → ${sanitizedWeeklyDiscount}%`);
        }
        
        const rawMonthlyDiscount = property.monthly_discount_percent || 0;
        let sanitizedMonthlyDiscount;
        try {
            sanitizedMonthlyDiscount = validatePercentage(rawMonthlyDiscount, 'property.monthly_discount_percent', userId);
        } catch (monthlyDiscountError) {
            console.error(`[Validation Error] [Endpoint: ${endpoint}] [userId: ${userId}] ${monthlyDiscountError.message}`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: monthlyDiscountError.message 
            });
        }
        if (rawMonthlyDiscount !== sanitizedMonthlyDiscount) {
            sanitizationWarnings.push(`Monthly Discount: ${rawMonthlyDiscount}% → ${sanitizedMonthlyDiscount}%`);
        }
        
        const rawWeekendMarkup = property.weekend_markup_percent || 0;
        let sanitizedWeekendMarkup;
        try {
            sanitizedWeekendMarkup = validatePercentage(rawWeekendMarkup, 'property.weekend_markup_percent', userId);
        } catch (weekendMarkupError) {
            console.error(`[Validation Error] [Endpoint: ${endpoint}] [userId: ${userId}] ${weekendMarkupError.message}`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: weekendMarkupError.message 
            });
        }
        if (rawWeekendMarkup !== sanitizedWeekendMarkup) {
            sanitizationWarnings.push(`Weekend Markup: ${rawWeekendMarkup}% → ${sanitizedWeekendMarkup}%`);
        }
        
        // Logger les avertissements si des valeurs ont été modifiées
        if (sanitizationWarnings.length > 0) {
            console.warn(`[Sanitization] ${sanitizationWarnings.length} valeur(s) modifiée(s) pour la propriété ${id}:`);
            sanitizationWarnings.forEach(warning => console.warn(`  - ${warning}`));
        }
        
        // Extraire city et country depuis property.location sanitizée
        const city = sanitizedLocation.split(',')[0].trim() || '';
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
                    
                    // Décrémenter le quota car on n'a pas utilisé l'IA
                    // Le middleware checkAIQuota a déjà incrémenté le quota, on doit l'annuler
                    try {
                        const today = new Date().toISOString().split('T')[0];
                        const { data: currentQuota } = await supabase
                            .from('user_ai_usage')
                            .select('calls_count')
                            .eq('user_id', userId)
                            .eq('date', today)
                            .single();
                        
                        if (currentQuota && currentQuota.calls_count > 0) {
                            await supabase
                                .from('user_ai_usage')
                                .update({
                                    calls_count: Math.max(0, currentQuota.calls_count - 1),
                                    updated_at: new Date().toISOString()
                                })
                                .eq('user_id', userId)
                                .eq('date', today);
                            console.log(`[AI Quota] Quota annulé pour ${userId} (pricing déterministe utilisé)`);
                        }
                    } catch (quotaError) {
                        console.error(`[AI Quota] Erreur lors de l'annulation du quota:`, quotaError);
                        // Ne pas bloquer la requête si l'annulation échoue
                    }
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

- **Lieu :** ${sanitizedLocation}
- **Date d'exécution :** ${today}
- **Horizon :** 180 jours
- **Objectif :** Maximisation du RevPAR (Revenu par chambre disponible) + Taux de Conversion.

---

### PARTIE 1 : INGESTION PROFONDE DU CONTEXTE (INPUTS)

**1. PROFILAGE DE L'ACTIF (PROPERTY SCORING)**

Analyse la valeur perçue de ce bien spécifique par rapport au marché local :

${safeJSONStringify({
    address: sanitizedAddress,
    type: sanitizedPropertyType,
    capacity: sanitizedCapacity,
    surface: sanitizedSurface,
    amenities: sanitizedAmenities,
    listing_quality_assessment:
      "AUTO-ÉVALUATION REQUISE : Détermine si ce bien est 'Économique', 'Standard', 'Premium' ou 'Luxe' en fonction des équipements (Piscine ? Vue ? AC ?) et de la surface vs capacité."
  }, 3, 2)}

**2. RÈGLES FINANCIÈRES INVIOLABLES (HARD CONSTRAINTS)**

Ces bornes sont des "Kill Switches". Si ton calcul théorique les dépasse, tu dois couper.

- **Floor Price (Plancher Absolu):** ${sanitizedFloorPrice} € (Ligne de survie).
- **Base Price (Pivot):** ${sanitizedBasePrice} € (Prix de référence neutre).
- **Ceiling Price (Plafond):** ${sanitizedCeilingPrice || sanitizedBasePrice * 4} € (Sécurité anti-aberration).
- **Min Stay:** ${property.min_stay || 1} nuits.
- **Réductions:** Semaine -${sanitizedWeeklyDiscount}%, Mois -${sanitizedMonthlyDiscount}%.
- **Majoration Week-end:** Ven/Sam +${sanitizedWeekendMarkup}%.

**3. STRATÉGIE UTILISATEUR : [ ${sanitizedStrategy} ]**

Tu dois moduler ton agressivité selon ce profil :

* **PRUDENT :** "Occupation First". Tu préfères louer à -15% que de rester vide. Tu es très réactif à la baisse en dernière minute (Last Minute).
* **ÉQUILIBRÉ :** "Market Follower". Tu cherches le ratio parfait. Tu ne prends pas de risques inutiles.
* **AGRESSIF :** "Yield First". Tu vises l'ADR (Prix Moyen) maximum. Tu ne brades pas. Tu sais que ton bien est unique et tu le fais payer. Tu acceptes d'avoir des jours vides pour vendre très cher les jours pleins.

---

### PARTIE 2 : LE "PIPELINE" DE CALCUL (8 ÉTAPES OBLIGATOIRES)

Pour **CHAQUE JOUR** du calendrier, tu dois exécuter mentalement cette séquence précise. Ne saute aucune étape.

**ÉTAPE 1 : ANALYSE MACRO-ÉCONOMIQUE & TENDANCES (MARKET HEALTH)**

* Prends en compte l'inflation actuelle en zone Euro/Locale.
* Analyse la "Force de la destination" : Est-ce que ${sanitizedLocation} est "tendance" cette année ? (Basé sur tes données d'entraînement).
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

* Effectue une recherche approfondie des événements à ${sanitizedLocation} sur les 180 jours :
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
    "strategy_active": "${sanitizedStrategy}"
  },
  "calendar": [
    {
      "date": "YYYY-MM-DD",
      "weekday": "String",
      "final_suggested_price": 0,
      "currency": "EUR",
      "price_breakdown": {
        "base": ${sanitizedBasePrice},
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
                const aiResponse = await callGeminiWithSearch(prompt, 10, language);
                
                // Gérer le nouveau format de retour { data, tokens } ou l'ancien format (rétrocompatibilité)
                if (aiResponse && typeof aiResponse === 'object' && 'data' in aiResponse) {
                    // Nouveau format : { data, tokens }
                    iaResult = aiResponse.data;
                    tokensUsed = aiResponse.tokens || 0;
                } else {
                    // Ancien format : données directement
                    iaResult = aiResponse;
                    tokensUsed = 2000; // Estimation par défaut si les tokens ne sont pas disponibles
                }
                
                aiCallSucceeded = true;
            } catch (iaError) {
                console.error(`[Pricing] Erreur lors de l'appel IA:`, iaError.message);
                
                // Décrémenter le quota car l'appel IA a échoué
                try {
                    const today = new Date().toISOString().split('T')[0];
                    const { data: currentQuota } = await supabase
                        .from('user_ai_usage')
                        .select('calls_count')
                        .eq('user_id', userId)
                        .eq('date', today)
                        .single();
                    
                    if (currentQuota && currentQuota.calls_count > 0) {
                        await supabase
                            .from('user_ai_usage')
                            .update({
                                calls_count: Math.max(0, currentQuota.calls_count - 1),
                                updated_at: new Date().toISOString()
                            })
                            .eq('user_id', userId)
                            .eq('date', today);
                        console.log(`[AI Quota] Quota annulé pour ${userId} (appel IA échoué)`);
                    }
                } catch (quotaError) {
                    console.error(`[AI Quota] Erreur lors de l'annulation du quota:`, quotaError);
                    // Ne pas bloquer la requête si l'annulation échoue
                }
                
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
                } else {
                    // Adapter le nouveau format (calendar) en daily_prices pour le reste du backend
                    // Utiliser safety_guardrails dès l'extraction pour sécuriser les prix de l'IA
                    const daily_prices = iaResult.calendar.map(day => {
                        const rawPrice = day.final_suggested_price;
                        // Validation initiale avec safety_guardrails
                        const validationResult = validatePriceSafety(rawPrice, {
                            base_price: property.base_price,
                            min_price: property.floor_price || 0,
                            max_price: property.ceiling_price || Infinity,
                            allow_override: false,
                            sanity_threshold: 0.5
                        });
                        
                        if (validationResult.wasAdjusted) {
                            console.log(`[SAFETY_GUARD] Prix IA ajusté pour ${day.date}: ${rawPrice} → ${validationResult.safePrice} (${validationResult.reason})`);
                        }
                        
                        return {
                            date: day.date,
                            price: validationResult.safePrice,
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
            }
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

        // Préparer les overrides à sauvegarder avec validation via safety_guardrails
        const overridesToSave = [];
        for (const day of strategyResult.daily_prices) {
            // Ignorer les prix verrouillés
            if (lockedPrices.has(day.date)) {
                console.log(`Ignoré ${day.date}: prix verrouillé manuellement.`);
                continue; 
            }

            // Utiliser le module safety_guardrails pour valider et sécuriser le prix
            const validationResult = validatePriceSafety(day.price, {
                base_price: property.base_price,
                min_price: floor || 0,
                max_price: ceiling || Infinity,
                allow_override: false,
                sanity_threshold: 0.5 // 50% de variation max par défaut
            });

            if (validationResult.wasAdjusted) {
                console.log(`[SAFETY_GUARD] Prix ajusté pour ${day.date}: ${day.price} → ${validationResult.safePrice} (${validationResult.reason})`);
            }
            
            overridesToSave.push({
                date: day.date,
                price: validationResult.safePrice,
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

        // Mettre à jour le quota avec les tokens réels utilisés (seulement si l'appel IA a réussi)
        if (aiCallSucceeded && tokensUsed > 0) {
            try {
                const today = new Date().toISOString().split('T')[0];
                const { data: currentQuota } = await supabase
                    .from('user_ai_usage')
                    .select('tokens_used')
                    .eq('user_id', userId)
                    .eq('date', today)
                    .single();
                
                if (currentQuota) {
                    await supabase
                        .from('user_ai_usage')
                        .update({
                            tokens_used: (currentQuota.tokens_used || 0) + tokensUsed,
                            updated_at: new Date().toISOString()
                        })
                        .eq('user_id', userId)
                        .eq('date', today);
                }
            } catch (quotaError) {
                console.error(`[AI Quota] Erreur lors de la mise à jour des tokens:`, quotaError);
                // Ne pas bloquer la requête si la mise à jour échoue
            }
        }

        // Logger l'utilisation pour monitoring
        if (aiCallSucceeded) {
            const quotaInfo = req.aiQuota || {};
            console.log(`[AI Quota] User ${userId} used ${tokensUsed} tokens for pricing strategy, remaining: ${quotaInfo.remaining || 0} calls`);
        }

        res.status(200).json(strategyResult); 

    } catch (error) {
        // 4. Retourner des erreurs 400 avec détails si validation échoue
        // 5. Logger toutes les erreurs avec userId et endpoint
        const endpoint = '/api/properties/:id/pricing-strategy';
        const userId = req.user?.uid || 'unknown';
        
        if (error.message && (error.message.includes('Le champ') || error.message.includes('doit être') || error.message.includes('Validation échouée'))) {
            console.error(`[Validation Error] [Endpoint: ${endpoint}] [userId: ${userId}] ${error.message}`);
            return res.status(400).json({ 
                error: 'Validation échouée', 
                message: error.message 
            });
        }
        
        console.error(`[Validation Error] [Endpoint: ${endpoint}] [userId: ${userId}] Erreur lors de la génération de la stratégie de prix:`, error);
        if (error.message && (error.message.includes('429') || error.message.includes('overloaded'))) {
             res.status(503).send({ error: `L'API de génération de prix est temporairement surchargée. Veuillez réessayer plus tard.` });
        } else {
             res.status(500).send({ error: `Erreur du serveur lors de la génération de la stratégie: ${error.message || 'Erreur inconnue'}` });
        }
    }
});

/**
 * POST /api/pricing/simulate
 * Simule la demande et le revenu pour une grille de prix.
 */
app.post('/api/pricing/simulate', authenticateToken, validatePricingRequest, async (req, res) => {
    try {
        const userId = req.user.uid;
        // req.body est déjà sanitizé par validatePricingRequest
        const { property_id, room_type = 'default', date, price_grid } = req.body;

        // Vérification que les champs requis sont présents (après sanitization)
        if (!date) {
            return res.status(400).json({
                error: 'Paramètres manquants',
                message: 'date est requis'
            });
        }

        // Vérification que price_grid est présent et valide (déjà validé par le middleware mais on vérifie quand même)
        if (!Array.isArray(price_grid) || price_grid.length === 0) {
            return res.status(400).json({
                error: 'Paramètres manquants',
                message: 'price_grid non vide est requis'
            });
        }

        const property = await db.getProperty(property_id);
        if (!property) {
            return res.status(404).json({ error: 'Propriété non trouvée.' });
        }

        const userProfile = await db.getUser(userId);
        if (!userProfile) {
            return res.status(404).json({ error: 'Profil utilisateur non trouvé.' });
        }

        const propertyTeamId = property.team_id || property.owner_id;
        if (userProfile.team_id !== propertyTeamId) {
            return res.status(403).json({ error: 'Action non autorisée sur cette propriété (pas dans la bonne équipe).' });
        }

        // Vérifier si un modèle existe pour cette propriété
        const modelExists = await pricingBridge.checkModelExists(property_id);
        
        if (!modelExists) {
            console.log(`[Pricing IA] [${property_id}] Aucun modèle entraîné pour la simulation, retour tableau vide`);
            return res.status(200).json({
                simulations: [],
                message: 'Aucun modèle IA entraîné pour cette propriété. Veuillez entraîner un modèle avant de simuler des prix.',
                model_available: false
            });
        }

        // Validation de la grille de prix
        if (!price_grid.every(p => typeof p === 'number' && p > 0 && p < 100000)) {
            console.error(`[Pricing IA] [${property_id}] Grille de prix invalide:`, price_grid);
            return res.status(400).json({
                error: 'Grille de prix invalide',
                message: 'La grille de prix doit contenir uniquement des nombres positifs inférieurs à 100000',
                price_grid: price_grid
            });
        }

        console.log(`[Pricing IA] [${property_id}] Début de simulation pour ${price_grid.length} prix (date: ${date})`);
        
        // Mesurer le temps de computation
        const simulationStartTime = Date.now();
        
        // Utiliser le nouveau bridge persistant pour la simulation
        let simulations = await pricingBridge.simulatePrices(
            property_id,
            date,
            price_grid,
            room_type
        );
        
        // Fallback vers l'ancien bridge si le nouveau bridge ne supporte pas encore simulatePrices
        if (simulations === null) {
            console.log(`[Pricing IA] [${property_id}] Nouveau bridge ne supporte pas encore simulatePrices, utilisation de l'ancien bridge`);
            simulations = await oldPricingBridge.simulatePrices(
                property_id,
                date,
                price_grid,
                room_type
            );
        }
        
        const simulationComputationTime = Date.now() - simulationStartTime;

        // Si le bridge retourne null, retourner un tableau vide avec un message d'erreur
        if (simulations === null) {
            console.error(`[Pricing IA] [${property_id}] Bridge simulation retourné null, erreur lors de la simulation`);
            return res.status(500).json({
                error: 'Erreur lors de la simulation',
                message: 'Une erreur est survenue lors de la simulation des prix. Le modèle peut être corrompu ou les données insuffisantes.',
                simulations: [],
                model_available: modelExists
            });
        }

        if (!Array.isArray(simulations) || simulations.length === 0) {
            console.warn(`[Pricing IA] [${property_id}] Simulation retournée vide ou invalide`);
            return res.status(200).json({
                simulations: [],
                message: 'Aucun résultat de simulation disponible',
                model_available: modelExists
            });
        }

        console.log(`[Pricing IA] [${property_id}] Simulation réussie: ${simulations.length} résultats`);
        
        // Logger la simulation dans pricing_simulations
        // (simulationComputationTime a déjà été calculé plus haut)
        
        try {
            const { error: simLogError, data: simLogData } = await supabase
                .from('pricing_simulations')
                .insert({
                    property_id: property_id,
                    user_id: userId,
                    room_type: room_type,
                    stay_date: date,
                    price_grid: price_grid,
                    simulations: simulations,
                    model_available: modelExists,
                    computation_time_ms: simulationComputationTime,
                    context: {
                        price_grid_size: price_grid.length,
                        simulations_count: simulations.length
                    }
                })
                .select()
                .single();

            if (simLogError) {
                console.error(`[Pricing IA] [${property_id}] Erreur lors du logging de la simulation:`, simLogError);
                console.error(`[Pricing IA] [${property_id}] Détails de l'erreur:`, JSON.stringify(simLogError, null, 2));
                // Ne pas faire échouer la requête si le logging échoue
            } else {
                console.log(`[Pricing IA] [${property_id}] Simulation loggée avec succès (id: ${simLogData?.id})`);
            }
        } catch (simLogError) {
            // Gestion d'erreur robuste : ne pas faire échouer la requête
            console.error(`[Pricing IA] [${property_id}] Exception lors du logging de la simulation:`, simLogError);
            console.error(`[Pricing IA] [${property_id}] Stack trace:`, simLogError.stack);
        }
        
        return res.status(200).json({
            simulations: simulations,
            count: simulations.length,
            model_available: modelExists
        });
    } catch (error) {
        console.error(`[Pricing IA] [${req.body?.property_id || 'unknown'}] Erreur dans /api/pricing/simulate:`, error);
        console.error(`[Pricing IA] Stack trace:`, error.stack);
        
        // Détecter le type d'erreur pour un code HTTP approprié
        let statusCode = 500;
        let errorMessage = 'Erreur interne du serveur lors de la simulation de prix';
        
        if (error.message && error.message.includes('validation')) {
            statusCode = 400;
            errorMessage = 'Erreur de validation: ' + error.message;
        } else if (error.message && error.message.includes('not found')) {
            statusCode = 404;
            errorMessage = 'Ressource non trouvée: ' + error.message;
        } else if (error.message && error.message.includes('timeout')) {
            statusCode = 504;
            errorMessage = 'Timeout lors de la simulation. Le modèle prend trop de temps à répondre.';
        }
        
        return res.status(statusCode).json({
            error: errorMessage,
            message: error.message,
            property_id: req.body?.property_id || null,
            date: req.body?.date || null,
            price_grid: req.body?.price_grid || null
        });
    }
});

/**
 * GET /api/pricing/metrics/:property_id
 * Récupère les métriques du modèle de pricing pour une propriété.
 * 
 * Query params:
 * - latest: si true, retourne seulement la dernière métrique (défaut: false)
 */
app.get('/api/pricing/metrics/:property_id', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const { property_id } = req.params;
        const { latest } = req.query;

        // Validation du property_id
        try {
            validatePropertyId(property_id, 'propertyId', userId);
        } catch (validationError) {
            console.error(`[Validation Error] [Endpoint: /api/pricing/metrics/:property_id] [userId: ${userId}] ${validationError.message}`);
            return res.status(400).json({
                error: 'Validation échouée',
                message: validationError.message
            });
        }

        // Vérifier que la propriété existe
        const property = await db.getProperty(property_id);
        if (!property) {
            return res.status(404).json({ error: 'Propriété non trouvée.' });
        }

        // Vérifier les droits d'accès
        const userProfile = await db.getUser(userId);
        if (!userProfile) {
            return res.status(404).json({ error: 'Profil utilisateur non trouvé.' });
        }

        const propertyTeamId = property.team_id || property.owner_id;
        if (userProfile.team_id !== propertyTeamId) {
            return res.status(403).json({ error: 'Action non autorisée sur cette propriété (pas dans la bonne équipe).' });
        }

        // Récupérer les métriques depuis Supabase
        let query = supabase
            .from('pricing_model_metrics')
            .select('*')
            .eq('property_id', property_id)
            .order('trained_at', { ascending: false });

        const { data: metrics, error: metricsError } = await query;

        if (metricsError) {
            console.error(`[Pricing Metrics] [${property_id}] Erreur Supabase:`, metricsError);
            return res.status(500).json({
                error: 'Erreur lors de la récupération des métriques',
                message: metricsError.message
            });
        }

        // Préparer la réponse
        const hasModel = metrics && metrics.length > 0;
        const latestMetrics = hasModel ? metrics[0] : null;

        const response = {
            property_id: property_id,
            has_model: hasModel,
            latest_metrics: latestMetrics ? {
                model_version: latestMetrics.model_version,
                train_rmse: latestMetrics.train_rmse,
                val_rmse: latestMetrics.val_rmse,
                train_mae: latestMetrics.train_mae,
                val_mae: latestMetrics.val_mae,
                n_train_samples: latestMetrics.n_train_samples,
                n_val_samples: latestMetrics.n_val_samples,
                feature_importance: latestMetrics.feature_importance,
                model_path: latestMetrics.model_path,
                trained_at: latestMetrics.trained_at,
                trained_by: latestMetrics.trained_by,
                metadata: latestMetrics.metadata
            } : null
        };

        // Si latest=false ou non spécifié, inclure toutes les métriques
        if (latest !== 'true') {
            response.all_metrics = metrics || [];
        }

        return res.status(200).json(response);

    } catch (error) {
        console.error(`[Pricing Metrics] [${req.params?.property_id || 'unknown'}] Erreur:`, error);
        console.error(`[Pricing Metrics] Stack trace:`, error.stack);
        
        return res.status(500).json({
            error: 'Erreur interne du serveur',
            message: error.message
        });
    }
});

/**
 * GET /api/pricing/metrics
 * Récupère un résumé global des métriques de pricing (dashboard admin).
 */
app.get('/api/pricing/metrics', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.uid;

        // Vérifier que l'utilisateur est admin (optionnel, à adapter selon votre logique)
        // Pour l'instant, on permet à tous les utilisateurs authentifiés
        // Vous pouvez ajouter une vérification de rôle admin ici si nécessaire

        // Récupérer un résumé des métriques
        const { data: allMetrics, error: metricsError } = await supabase
            .from('pricing_model_metrics')
            .select('property_id, model_version, train_rmse, val_rmse, trained_at, trained_by')
            .order('trained_at', { ascending: false });

        if (metricsError) {
            console.error(`[Pricing Metrics] Erreur Supabase (résumé global):`, metricsError);
            return res.status(500).json({
                error: 'Erreur lors de la récupération des métriques',
                message: metricsError.message
            });
        }

        if (!allMetrics || allMetrics.length === 0) {
            return res.status(200).json({
                total_properties_with_model: 0,
                total_models_trained: 0,
                average_train_rmse: null,
                average_val_rmse: null,
                models_by_method: {},
                recent_models: []
            });
        }

        // Calculer les statistiques
        const uniqueProperties = new Set(allMetrics.map(m => m.property_id));
        const totalPropertiesWithModel = uniqueProperties.size;
        const totalModelsTrained = allMetrics.length;

        // Calculer les moyennes de RMSE
        const validTrainRmse = allMetrics.filter(m => m.train_rmse != null).map(m => parseFloat(m.train_rmse));
        const validValRmse = allMetrics.filter(m => m.val_rmse != null).map(m => parseFloat(m.val_rmse));

        const averageTrainRmse = validTrainRmse.length > 0
            ? validTrainRmse.reduce((a, b) => a + b, 0) / validTrainRmse.length
            : null;

        const averageValRmse = validValRmse.length > 0
            ? validValRmse.reduce((a, b) => a + b, 0) / validValRmse.length
            : null;

        // Compter par méthode d'entraînement
        const modelsByMethod = {};
        allMetrics.forEach(metric => {
            const method = metric.trained_by || 'unknown';
            modelsByMethod[method] = (modelsByMethod[method] || 0) + 1;
        });

        // Derniers modèles entraînés (10 plus récents)
        const recentModels = allMetrics.slice(0, 10).map(m => ({
            property_id: m.property_id,
            model_version: m.model_version,
            train_rmse: m.train_rmse,
            val_rmse: m.val_rmse,
            trained_at: m.trained_at,
            trained_by: m.trained_by
        }));

        return res.status(200).json({
            total_properties_with_model: totalPropertiesWithModel,
            total_models_trained: totalModelsTrained,
            average_train_rmse: averageTrainRmse ? parseFloat(averageTrainRmse.toFixed(4)) : null,
            average_val_rmse: averageValRmse ? parseFloat(averageValRmse.toFixed(4)) : null,
            models_by_method: modelsByMethod,
            recent_models: recentModels
        });

    } catch (error) {
        console.error(`[Pricing Metrics] Erreur dans /api/pricing/metrics:`, error);
        console.error(`[Pricing Metrics] Stack trace:`, error.stack);
        
        return res.status(500).json({
            error: 'Erreur interne du serveur',
            message: error.message
        });
    }
});

/**
 * POST /api/pricing/retrain
 * Déclenche manuellement le réentraînement des modèles de pricing.
 * 
 * Body (optionnel):
 * - days: Nombre de jours d'historique (défaut: 180)
 * - minNewRecommendations: Minimum de nouvelles recommandations (défaut: 50)
 * - minDaysSinceTraining: Minimum de jours depuis dernier entraînement (défaut: 30)
 * - minImprovement: Amélioration minimale pour remplacer (défaut: 0.05)
 * - force: Forcer le réentraînement (défaut: false)
 */
app.post('/api/pricing/retrain', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const {
            days = 180,
            minNewRecommendations = 50,
            minDaysSinceTraining = 30,
            minImprovement = 0.05,
            force = false
        } = req.body || {};

        console.log('[Pricing Retrain] Réentraînement déclenché via API par utilisateur:', userId);

        // Validation des paramètres
        if (typeof days !== 'number' || days < 1 || days > 365) {
            return res.status(400).json({
                error: 'Paramètre invalide',
                message: 'days doit être un nombre entre 1 et 365'
            });
        }

        if (typeof minNewRecommendations !== 'number' || minNewRecommendations < 1) {
            return res.status(400).json({
                error: 'Paramètre invalide',
                message: 'minNewRecommendations doit être un nombre positif'
            });
        }

        if (typeof minDaysSinceTraining !== 'number' || minDaysSinceTraining < 1) {
            return res.status(400).json({
                error: 'Paramètre invalide',
                message: 'minDaysSinceTraining doit être un nombre positif'
            });
        }

        if (typeof minImprovement !== 'number' || minImprovement < 0 || minImprovement > 1) {
            return res.status(400).json({
                error: 'Paramètre invalide',
                message: 'minImprovement doit être un nombre entre 0 et 1'
            });
        }

        const startTime = Date.now();
        const result = await retrainPricingModels({
            days,
            minNewRecommendations,
            minDaysSinceTraining,
            minImprovement,
            force
        });
        const duration = (Date.now() - startTime) / 1000;

        if (result.success) {
            res.status(200).json({
                success: true,
                message: 'Réentraînement terminé avec succès',
                duration: duration,
                summary: result.report?.summary || {},
                results_count: result.report?.results?.length || 0
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Erreur lors du réentraînement',
                message: result.error,
                duration: duration
            });
        }

    } catch (error) {
        console.error('[Pricing Retrain] Erreur dans /api/pricing/retrain:', error);
        console.error('[Pricing Retrain] Stack trace:', error.stack);
        
        return res.status(500).json({
            error: 'Erreur interne du serveur',
            message: error.message
        });
    }
});

/**
 * GET /api/pricing/logs
 * Récupère les logs de pricing (recommandations et simulations) pour monitoring.
 * 
 * Query params:
 * - property_id: Filtrer par propriété (optionnel)
 * - date: Filtrer par date (optionnel, format: YYYY-MM-DD)
 * - limit: Nombre de résultats à retourner (défaut: 50, max: 200)
 * - type: Type de logs ("recommendations", "simulations", ou "all" - défaut: "all")
 */
app.get('/api/pricing/logs', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.uid;
        const { property_id, date, limit = '50', type = 'all' } = req.query;

        // Validation du limit
        const limitNum = Math.min(parseInt(limit, 10) || 50, 200);
        if (limitNum < 1) {
            return res.status(400).json({
                error: 'Paramètre invalide',
                message: 'limit doit être un nombre positif'
            });
        }

        // Validation du type
        if (!['recommendations', 'simulations', 'all'].includes(type)) {
            return res.status(400).json({
                error: 'Paramètre invalide',
                message: 'type doit être "recommendations", "simulations" ou "all"'
            });
        }

        // Validation du property_id si fourni
        if (property_id) {
            try {
                validatePropertyId(property_id, 'propertyId', userId);
            } catch (validationError) {
                return res.status(400).json({
                    error: 'Validation échouée',
                    message: validationError.message
                });
            }

            // Vérifier les droits d'accès
            const property = await db.getProperty(property_id);
            if (!property) {
                return res.status(404).json({ error: 'Propriété non trouvée.' });
            }

            const userProfile = await db.getUser(userId);
            if (!userProfile) {
                return res.status(404).json({ error: 'Profil utilisateur non trouvé.' });
            }

            const propertyTeamId = property.team_id || property.owner_id;
            if (userProfile.team_id !== propertyTeamId) {
                return res.status(403).json({ error: 'Action non autorisée sur cette propriété.' });
            }
        }

        const results = {
            recommendations: [],
            simulations: []
        };

        // Récupérer les recommandations si demandé
        if (type === 'recommendations' || type === 'all') {
            let recQuery = supabase
                .from('pricing_recommendations')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(limitNum);

            if (property_id) {
                recQuery = recQuery.eq('property_id', property_id);
            }

            if (date) {
                recQuery = recQuery.eq('stay_date', date);
            }

            const { data: recommendations, error: recError } = await recQuery;

            if (recError) {
                console.error(`[Pricing Logs] Erreur lors de la récupération des recommandations:`, recError);
                // Ne pas faire échouer la requête, retourner un tableau vide
                results.recommendations = [];
            } else {
                results.recommendations = recommendations || [];
            }
        }

        // Récupérer les simulations si demandé
        if (type === 'simulations' || type === 'all') {
            let simQuery = supabase
                .from('pricing_simulations')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(limitNum);

            if (property_id) {
                simQuery = simQuery.eq('property_id', property_id);
            }

            if (date) {
                simQuery = simQuery.eq('stay_date', date);
            }

            const { data: simulations, error: simError } = await simQuery;

            if (simError) {
                console.error(`[Pricing Logs] Erreur lors de la récupération des simulations:`, simError);
                // Ne pas faire échouer la requête, retourner un tableau vide
                results.simulations = [];
            } else {
                results.simulations = simulations || [];
            }
        }

        // Si type est "all", retourner les deux
        // Sinon, retourner seulement le type demandé
        if (type === 'all') {
            return res.status(200).json({
                recommendations: results.recommendations,
                simulations: results.simulations,
                total_recommendations: results.recommendations.length,
                total_simulations: results.simulations.length
            });
        } else if (type === 'recommendations') {
            return res.status(200).json({
                recommendations: results.recommendations,
                total: results.recommendations.length
            });
        } else {
            return res.status(200).json({
                simulations: results.simulations,
                total: results.simulations.length
            });
        }

    } catch (error) {
        console.error(`[Pricing Logs] Erreur dans /api/pricing/logs:`, error);
        console.error(`[Pricing Logs] Stack trace:`, error.stack);
        
        return res.status(500).json({
            error: 'Erreur interne du serveur',
            message: error.message
        });
    }
});

// GET /api/news - Récupérer les actualités du marché (depuis le cache)
app.get('/api/news', authenticateToken, async (req, res) => {
    let tokensUsed = 0;
    try {
        const userId = req.user.uid;
        
        // 0. Sanitiser et valider les paramètres de la requête
        // Whitelist des langues autorisées
        const allowedLanguages = ['fr', 'en', 'es', 'de', 'it', 'pt', 'nl', 'pl', 'ru', 'ja', 'zh', 'ko', 'ar', 'hi'];
        
        // Récupérer et valider la langue : query param > profil utilisateur > français par défaut
        const userProfile = await db.getUser(userId);
        const rawLanguage = req.query.language || userProfile?.language || 'fr';
        const language = allowedLanguages.includes(rawLanguage.toLowerCase()) ? rawLanguage.toLowerCase() : 'fr';
        
        if (rawLanguage !== language) {
            console.warn(`[Sanitization] Langue non autorisée: "${rawLanguage}" → "${language}"`);
        }
        
        // Sanitiser le paramètre city s'il est fourni
        let city = null;
        if (req.query.city) {
            const rawCity = req.query.city;
            city = sanitizeForPrompt(rawCity, 100);
            
            // Utiliser une valeur par défaut si la ville est vide après sanitisation
            if (!city || city.trim().length === 0) {
                console.warn(`[Sanitization] Ville vide après sanitisation, utilisation de la valeur par défaut. Raw: "${rawCity}"`);
                city = 'France'; // Valeur par défaut sécurisée
            }
            
            console.log(`[Sanitization] Ville sanitizée: "${rawCity}" → "${city}"`);
        }
        
        const forceRefresh = req.query.forceRefresh === 'true';
        
        const cacheKey = `marketNews_${language}`;
        const newsDoc = await db.getSystemCache(cacheKey);
        const oneDayMs = 24 * 60 * 60 * 1000; // 86 400 000 ms

        function updatedAtToMs(raw) {
            if (raw == null) return null;
            try {
                const ms = typeof raw === 'number'
                    ? (raw < 1e12 ? raw * 1000 : raw)
                    : new Date(raw).getTime();
                return Number.isNaN(ms) ? null : ms;
            } catch {
                return null;
            }
        }

        let cacheAgeMs = null;
        const cacheLanguage = newsDoc?.language;
        const sameLanguage = !cacheLanguage || cacheLanguage === language;
        const updatedMs = updatedAtToMs(newsDoc?.updated_at ?? newsDoc?.updatedAt);
        if (updatedMs != null) cacheAgeMs = Date.now() - updatedMs;

        if (newsDoc && newsDoc.data && sameLanguage) {
            if (cacheAgeMs != null && cacheAgeMs >= 0 && cacheAgeMs < oneDayMs) {
                if (!Array.isArray(newsDoc.data)) {
                    console.error(`Format de cache invalide pour marketNews_${language}:`, newsDoc);
                    return res.status(500).send({ error: 'Format de cache invalide. Veuillez réessayer plus tard.' });
                }
                console.log(`[AI Quota] Cache valide retourné pour ${userId} (langue: ${language}) - aucun quota consommé`);
                return res.status(200).json(newsDoc.data);
            }
        }
        if (cacheLanguage && !sameLanguage) {
            console.log(`Cache trouvé pour une autre langue (${cacheLanguage} au lieu de ${language}), invalide.`);
        }

        const cacheIsValid = false;

        // IMPORTANT: Vérifier le quota SEULEMENT si on doit appeler l'IA (forceRefresh OU cache invalide)
        // Si le cache est valide et forceRefresh=false, on retourne directement sans consommer le quota
        let quotaResult = null;
        if (forceRefresh || !cacheIsValid) {
            // Vérifier et incrémenter le quota AVANT l'appel IA
            quotaResult = await checkAndIncrementAIQuota(userId, 0);
            
            if (!quotaResult.allowed) {
                // Quota atteint, retourner le cache existant si disponible (même expiré)
                if (newsDoc && newsDoc.data) {
                    console.log(`[AI Quota] Quota atteint, retour du cache existant (même expiré) pour ${userId}`);
                    return res.status(200).json(newsDoc.data);
                }
                
                // Calculer l'heure de réinitialisation
                const now = new Date();
                const tomorrow = new Date(now);
                tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
                tomorrow.setUTCHours(0, 0, 0, 0);
                
                return res.status(429).send({
                    error: "Quota IA atteint",
                    message: "Vous avez atteint votre limite quotidienne d'appels IA",
                    limit: quotaResult.limit || 0,
                    used: quotaResult.callsToday || 0,
                    remaining: 0,
                    resetAt: tomorrow.toISOString(),
                    resetAtHuman: "demain à minuit UTC"
                });
            }
        }
        
        // Si forceRefresh est activé, régénérer le cache immédiatement
        if (forceRefresh) {
            if (ongoingGenerations[language]) {
                console.log(`[News] Génération déjà en cours pour ${language}, requête mise en attente...`);
                if (newsDoc && newsDoc.data) {
                    return res.status(200).json(newsDoc.data);
                }
                return res.status(429).json({ error: 'Génération en cours, réessayez dans 5 secondes' });
            }
            ongoingGenerations[language] = true;
            try {
                console.log(`Régénération forcée du cache des actualités pour la langue ${language}...`);
                const refreshedNewsDoc = await updateMarketNewsCache(language);
                if (refreshedNewsDoc && refreshedNewsDoc.data) {
                    // Mettre à jour les tokens après l'appel IA réussi
                    // Note: updateMarketNewsCache ne retourne pas les tokens, on doit les estimer
                    tokensUsed = 2000; // Estimation par défaut
                    const today = new Date().toISOString().split('T')[0];
                    const { data: currentQuota } = await supabase
                        .from('user_ai_usage')
                        .select('tokens_used')
                        .eq('user_id', userId)
                        .eq('date', today)
                        .single();
                    
                    if (currentQuota) {
                        await supabase
                            .from('user_ai_usage')
                            .update({
                                tokens_used: (currentQuota.tokens_used || 0) + tokensUsed,
                                updated_at: new Date().toISOString()
                            })
                            .eq('user_id', userId)
                            .eq('date', today);
                    }
                    
                    console.log(`[AI Quota] User ${userId} used ${tokensUsed} tokens for market news (forceRefresh), remaining: ${quotaResult?.remaining || 0} calls`);
                    
                    return res.status(200).json(refreshedNewsDoc.data);
                }
            } catch (refreshError) {
                console.error(`Erreur lors de la régénération forcée pour ${language}:`, refreshError);
                // Si l'appel IA échoue, annuler l'incrémentation
                const today = new Date().toISOString().split('T')[0];
                const { data: currentQuota } = await supabase
                    .from('user_ai_usage')
                    .select('calls_count')
                    .eq('user_id', userId)
                    .eq('date', today)
                    .single();
                
                if (currentQuota && currentQuota.calls_count > 0) {
                    await supabase
                        .from('user_ai_usage')
                        .update({
                            calls_count: Math.max(0, currentQuota.calls_count - 1),
                            updated_at: new Date().toISOString()
                        })
                        .eq('user_id', userId)
                        .eq('date', today);
                    console.log(`[AI Quota] Annulation de l'incrémentation pour l'utilisateur ${userId} (appel IA échoué lors du forceRefresh)`);
                }
                // Continuer avec le cache existant si la régénération échoue
            } finally {
                ongoingGenerations[language] = false;
                console.log(`[News] Verrou libéré pour ${language}`);
            }
        }

        // Si le cache n'existe pas ou est invalide, régénérer automatiquement
        // (cacheIsValid a déjà été calculé plus haut)
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
            if (newsDoc && newsDoc.data && cacheAgeMs != null) {
                console.log(`Cache expiré pour ${language} (${Math.round(cacheAgeMs / (60 * 60 * 1000))}h), régénération automatique...`);
            } else {
                console.log(`Génération des actualités pour la langue ${language}${forceRefresh ? ' (force refresh)' : ' (cache manquant)'}...`);
            }

            if (ongoingGenerations[language]) {
                console.log(`[News] Génération déjà en cours pour ${language}, requête mise en attente...`);
                if (newsDoc && newsDoc.data) {
                    return res.status(200).json(newsDoc.data);
                }
                return res.status(429).json({ error: 'Génération en cours, réessayez dans 5 secondes' });
            }
            ongoingGenerations[language] = true;

            try {
                const newNewsDoc = await updateMarketNewsCache(language);
                if (newNewsDoc && newNewsDoc.data) {
                    // Mettre à jour les tokens après l'appel IA réussi
                    tokensUsed = 2000; // Estimation par défaut
                    const today = new Date().toISOString().split('T')[0];
                    const { data: currentQuota } = await supabase
                        .from('user_ai_usage')
                        .select('tokens_used')
                        .eq('user_id', userId)
                        .eq('date', today)
                        .single();
                    
                    if (currentQuota) {
                        await supabase
                            .from('user_ai_usage')
                            .update({
                                tokens_used: (currentQuota.tokens_used || 0) + tokensUsed,
                                updated_at: new Date().toISOString()
                            })
                            .eq('user_id', userId)
                            .eq('date', today);
                    }
                    
                    const quotaInfo = await getUserAIQuota(userId);
                    console.log(`[AI Quota] User ${userId} used ${tokensUsed} tokens for market news (auto-regeneration), remaining: ${quotaInfo.remaining || 0} calls`);
                    
                    return res.status(200).json(newNewsDoc.data);
                }
                if (newsDoc && newsDoc.data) {
                    console.log(`Régénération OK mais doc invalide, utilisation du cache existant.`);
                    return res.status(200).json(newsDoc.data);
                }
                if (language !== 'fr') {
                    const frDoc = await db.getSystemCache('marketNews_fr');
                    if (frDoc && frDoc.data && Array.isArray(frDoc.data)) return res.status(200).json(frDoc.data);
                }
                const oldDoc = await db.getSystemCache('marketNews');
                if (oldDoc && oldDoc.data) {
                    const arr = Array.isArray(oldDoc.data) ? oldDoc.data : oldDoc.data;
                    if (Array.isArray(arr)) return res.status(200).json(arr);
                }
                return res.status(404).send({ error: 'Cache d\'actualités non encore généré. Veuillez patienter.' });
            } catch (genError) {
                console.error(`Erreur lors de la génération des actualités pour ${language}:`, genError);
                // Si l'appel IA échoue, annuler l'incrémentation
                const today = new Date().toISOString().split('T')[0];
                const { data: currentQuota } = await supabase
                    .from('user_ai_usage')
                    .select('calls_count')
                    .eq('user_id', userId)
                    .eq('date', today)
                    .single();
                
                if (currentQuota && currentQuota.calls_count > 0) {
                    await supabase
                        .from('user_ai_usage')
                        .update({
                            calls_count: Math.max(0, currentQuota.calls_count - 1),
                            updated_at: new Date().toISOString()
                        })
                        .eq('user_id', userId)
                        .eq('date', today);
                    console.log(`[AI Quota] Annulation de l'incrémentation pour l'utilisateur ${userId} (appel IA échoué lors de la régénération automatique)`);
                }
                
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
            } finally {
                ongoingGenerations[language] = false;
                console.log(`[News] Verrou libéré pour ${language}`);
            }
        }
        
    } catch (error) {
        console.error('Erreur lors de la récupération des actualités depuis le cache:', error);
         res.status(500).send({ error: `Erreur serveur lors de la récupération des actualités: ${error.message}` });
    }
});

// GET /api/properties/:id/news - Récupérer les actualités spécifiques (avec cache par propriété)
app.get('/api/properties/:id/news', authenticateToken, checkAIQuota, async (req, res) => {
    let tokensUsed = 0;
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
        
        // 1.1. Sanitiser la ville avant injection dans le prompt IA
        const fullLocation = property.location || 'France';
        const rawCity = fullLocation.split(',')[0].trim();
        let city = sanitizeForPrompt(rawCity, 100); // Limiter à 100 caractères
        
        // Utiliser une valeur par défaut si la ville est vide après sanitisation
        if (!city || city.trim().length === 0) {
            console.warn(`[Sanitization] Ville vide après sanitisation, utilisation de la valeur par défaut. Raw: "${rawCity}"`);
            city = 'France'; // Valeur par défaut
        }
        
        console.log(`[Sanitization] Ville sanitizée: "${rawCity}" → "${city}"`);

        // 2. Vérifier le cache de cette propriété (avec langue)
        // IMPORTANT: Le quota est vérifié AVANT la vérification du cache (via le middleware checkAIQuota)
        // Cela garantit qu'on ne consomme pas le quota si on utilise le cache
        const language = req.query.language || userProfile?.language || 'fr';
        
        // Note: Le cache par propriété n'est pas encore implémenté dans Supabase
        // Pour l'instant, on ignore le cache et on génère toujours les actualités
        // TODO: Implémenter un système de cache par propriété dans Supabase si nécessaire
        // Quand le cache sera implémenté, on devra vérifier le quota AVANT de vérifier le cache

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

        // 4. Appeler l'IA et capturer les tokens
        const aiResponse = await callGeminiWithSearch(prompt, 10, language);
        
        // Gérer le nouveau format de retour { data, tokens } ou l'ancien format (rétrocompatibilité)
        let newsData;
        if (aiResponse && typeof aiResponse === 'object' && 'data' in aiResponse) {
            // Nouveau format : { data, tokens }
            newsData = aiResponse.data;
            tokensUsed = aiResponse.tokens || 0;
        } else {
            // Ancien format : données directement
            newsData = aiResponse;
            tokensUsed = 2000; // Estimation par défaut si les tokens ne sont pas disponibles
        }
        
        const newsDataArray = Array.isArray(newsData) ? newsData : (newsData ? [newsData] : []);

        if (newsDataArray.length === 0) {
             console.warn("Aucune actualité pertinente trouvée pour", city);
        }

        // 5. Mettre à jour le quota avec les tokens réels utilisés
        const today = new Date().toISOString().split('T')[0];
        const { data: currentQuota } = await supabase
            .from('user_ai_usage')
            .select('tokens_used')
            .eq('user_id', userId)
            .eq('date', today)
            .single();
        
        if (currentQuota) {
            await supabase
                .from('user_ai_usage')
                .update({
                    tokens_used: (currentQuota.tokens_used || 0) + tokensUsed,
                    updated_at: new Date().toISOString()
                })
                .eq('user_id', userId)
                .eq('date', today);
        }

        // 6. Logger l'utilisation
        const quotaInfo = req.aiQuota || {};
        console.log(`[AI Quota] User ${userId} used ${tokensUsed} tokens for property news, remaining: ${quotaInfo.remaining || 0} calls`);

        // 7. Log de l'action (le cache sera implémenté plus tard si nécessaire)
        await logPropertyChange(propertyId, "system", "auto-update", 'update:news-cache', { count: newsDataArray.length });

        // 8. Renvoyer le résultat
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
        
        const newsData = await callGeminiWithSearch(prompt, 10, language);

        if (!newsData || !Array.isArray(newsData)) {
            throw new Error("Données d'actualités invalides reçues de l'API de recherche.");
        }

        const cacheKey = `marketNews_${language}`;
        const payload = {
            key: cacheKey,
            data: newsData,
            language,
            updated_at: new Date().toISOString()
        };
        const result = await db.upsertSystemCache(payload);
        console.log(`Mise à jour du cache des actualités (${language}) terminée avec succès.`);
        return result;

    } catch (error) {
        console.error(`Erreur lors de la mise à jour du cache des actualités (${language}):`, error.message);
        throw error;
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

// Job hebdomadaire de réentraînement des modèles de pricing (dimanche à 4h UTC)
cron.schedule('0 4 * * 0', async () => {
    console.log('[Pricing Retrain] Démarrage du job de réentraînement automatique des modèles de pricing...');
    try {
        const result = await retrainPricingModels({
            minNewRecommendations: 50,
            minDaysSinceTraining: 30,
            minImprovement: 0.05,
            force: false
        });
        
        if (result.success) {
            console.log('[Pricing Retrain] ✅ Réentraînement terminé avec succès');
            console.log(`[Pricing Retrain] - Propriétés traitées: ${result.report?.summary?.total_processed || 0}`);
            console.log(`[Pricing Retrain] - Modèles remplacés: ${result.report?.summary?.model_replaced || 0}`);
        } else {
            console.error('[Pricing Retrain] ❌ Erreur lors du réentraînement:', result.error);
        }
    } catch (error) {
        console.error('[Pricing Retrain] ❌ Exception lors du réentraînement:', error);
        // Ne pas faire planter le serveur
    }
}, {
    scheduled: true,
    timezone: "UTC"
});

console.log('[Pricing Retrain] Job de réentraînement planifié: tous les dimanches à 4h UTC');

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

// Tâche cron pour réinitialiser les quotas IA quotidiens (tous les jours à minuit)
console.log("Mise en place de la tâche planifiée pour la réinitialisation des quotas IA (tous les jours à minuit).");
cron.schedule('0 0 * * *', async () => {
    console.log('[Cron] Démarrage de la réinitialisation des quotas IA quotidiens...');
    try {
        const { data, error } = await supabase.rpc('reset_daily_ai_quotas');
        if (error) {
            console.error('[Cron] Erreur lors de la réinitialisation des quotas IA:', error);
        } else {
            // La fonction retourne maintenant un tableau avec updated_count, deleted_count, reset_date
            const result = Array.isArray(data) && data.length > 0 ? data[0] : { updated_count: 0, deleted_count: 0 };
            console.log(`[Cron] Quotas IA réinitialisés avec succès. ${result.updated_count || 0} enregistrements mis à jour, ${result.deleted_count || 0} enregistrements supprimés.`);
        }
    } catch (error) {
        console.error('[Cron] Erreur lors de la réinitialisation des quotas IA:', error);
    }
}, {
    scheduled: true,
    timezone: "UTC" // Minuit UTC pour une réinitialisation globale
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
 * Récupère les paramètres de pricing (strategy, rules) pour une propriété.
 * Si la propriété appartient à un groupe avec sync_prices activé, utilise la config du groupe.
 * @param {string} propertyId - ID de la propriété
 * @returns {Promise<{ strategy: object, rules: object }>}
 */
async function getPricingParamsForProperty(propertyId) {
    const property = await db.getProperty(propertyId);
    if (!property) return { strategy: null, rules: null };

    const propStrategy = typeof property.strategy === 'object' && property.strategy && !Array.isArray(property.strategy)
        ? property.strategy
        : { strategy: property.strategy || 'Équilibré', base_price: property.base_price, floor_price: property.floor_price, ceiling_price: property.ceiling_price };
    const propRules = property.rules && typeof property.rules === 'object' && !Array.isArray(property.rules)
        ? property.rules
        : {
            min_stay: property.min_stay_duration ?? property.min_stay,
            max_stay: property.max_stay_duration ?? property.max_stay,
            weekend_markup_percent: property.weekend_markup_percent ?? property.markup,
            long_stay_discount: property.long_stay_discount ?? property.weekly_discount_percent,
            weekly_discount_percent: property.weekly_discount_percent,
            monthly_discount_percent: property.monthly_discount_percent,
        };

    let finalStrategy = propStrategy;
    let finalRules = propRules;

    const { data: relation, error: relError } = await supabase
        .from('group_properties')
        .select('group_id')
        .eq('property_id', propertyId)
        .maybeSingle();

    if (!relError && relation?.group_id) {
        const group = await db.getGroup(relation.group_id);
        const syncPrices = group && (group.sync_prices === true || group.syncPrices === true);
        if (syncPrices) {
            console.log(`[Pricing] Utilisation de la stratégie du groupe ${group.name} pour la propriété ${propertyId}`);
            finalStrategy = group._strategy_raw || group.strategy || finalStrategy;
            finalRules = group._rules_raw || group.rules || finalRules;
        }
    }

    return { strategy: finalStrategy, rules: finalRules };
}

/**
 * Génère et applique les prix IA pour une propriété
 * @param {string} propertyId - ID de la propriété
 * @param {object} property - Données de la propriété
 * @param {string} userId - ID de l'utilisateur
 * @param {string} userEmail - Email de l'utilisateur
 * @param {object} groupContext - Contexte du groupe (optionnel) avec strategy et rules
 * @returns {Promise<{success: boolean, propertyId: string, message: string}>}
 */
async function generateAndApplyPricingForProperty(propertyId, property, userId, userEmail, groupContext = null) {
    try {
        // Récupérer la propriété complète depuis la base de données pour s'assurer d'avoir tous les champs à jour
        const fullProperty = await db.getProperty(propertyId);
        if (!fullProperty) {
            throw new Error(`Propriété ${propertyId} non trouvée`);
        }
        
        // Utiliser la propriété complète pour les vérifications
        const propertyToUse = fullProperty || property;
        
        // Récupérer le profil utilisateur une seule fois
        const userProfile = await db.getUser(userId);
        const language = userProfile?.language || 'fr';
        
        // Vérifier si le pricing automatique est activé et si une génération a déjà eu lieu aujourd'hui
        if (propertyToUse.auto_pricing_enabled) {
            const timezone = userProfile?.auto_pricing?.timezone || userProfile?.timezone || 'Europe/Paris';
            const { hour, minute } = getCurrentTimeInTimezone(timezone);
            const isScheduledTime = hour === 0 && minute === 0;
            
            console.log(`[Auto-Pricing] Vérification pour ${propertyId}: auto_pricing_enabled=${propertyToUse.auto_pricing_enabled}, auto_pricing_updated_at=${propertyToUse.auto_pricing_updated_at}, heure=${hour}:${minute}, isScheduledTime=${isScheduledTime}`);
            
            // Si ce n'est pas l'heure prévue (00h00) et qu'une date de mise à jour existe, vérifier si une génération a eu lieu aujourd'hui
            if (!isScheduledTime && propertyToUse.auto_pricing_updated_at) {
                try {
                    const updatedAt = new Date(propertyToUse.auto_pricing_updated_at);
                    const now = new Date();
                    
                    // Utiliser Intl.DateTimeFormat pour obtenir les dates dans le fuseau horaire de l'utilisateur
                    const dateFormatter = new Intl.DateTimeFormat('en-CA', { 
                        timeZone: timezone, 
                        year: 'numeric', 
                        month: '2-digit', 
                        day: '2-digit' 
                    });
                    
                    const updatedAtDateStr = dateFormatter.format(updatedAt);
                    const nowDateStr = dateFormatter.format(now);
                    
                    console.log(`[Auto-Pricing] Comparaison dates pour ${propertyId}: updatedAt=${updatedAtDateStr}, now=${nowDateStr}`);
                    
                    // Comparer les dates (format: YYYY-MM-DD)
                    if (updatedAtDateStr === nowDateStr) {
                        // Si une génération a eu lieu aujourd'hui et qu'on n'est pas à 00h00, ne pas régénérer
                        console.log(`[Auto-Pricing] ⏭️ Propriété ${propertyId} ignorée: génération déjà effectuée aujourd'hui (${updatedAt.toISOString()}) - Fuseau: ${timezone} - Date locale: ${updatedAtDateStr}`);
                        return {
                            success: false,
                            propertyId: propertyId,
                            message: `Pricing déjà généré aujourd'hui. Prochaine génération automatique à 00h00 (${timezone}).`,
                            skipped: true
                        };
                    }
                } catch (dateError) {
                    console.error(`[Auto-Pricing] Erreur lors de la comparaison de dates pour ${propertyId}:`, dateError);
                    // En cas d'erreur, continuer la génération (fail-safe)
                }
            } else if (!isScheduledTime && !propertyToUse.auto_pricing_updated_at) {
                console.log(`[Auto-Pricing] ⚠️ Propriété ${propertyId}: auto_pricing_enabled=true mais auto_pricing_updated_at est null/undefined. Génération autorisée.`);
            }
        }
        
        // Utiliser la propriété complète pour le reste de la fonction
        const property = propertyToUse;
        const today = new Date().toISOString().split('T')[0];

        const pricingParams = await getPricingParamsForProperty(propertyId);
        const strat = pricingParams.strategy;
        const rul = pricingParams.rules || {};
        const effectiveStrategy = (typeof strat === 'object' && strat?.strategy) || (typeof strat === 'string' ? strat : null) || (groupContext?.strategy?.strategy ?? (typeof groupContext?.strategy === 'string' ? groupContext.strategy : null)) || property.strategy || 'Équilibré';
        const effectiveRules = rul && typeof rul === 'object' ? rul : (groupContext?.rules || property.rules || {});
        const effectiveBasePrice = (typeof strat === 'object' && strat?.base_price != null) ? strat.base_price : (groupContext?.strategy?.base_price ?? property.base_price ?? 100);
        const effectiveFloorPrice = (typeof strat === 'object' && strat?.floor_price != null) ? strat.floor_price : (groupContext?.strategy?.floor_price ?? property.floor_price ?? 50);
        const effectiveCeilingPrice = (typeof strat === 'object' && strat?.ceiling_price != null) ? strat.ceiling_price : (groupContext?.strategy?.ceiling_price ?? property.ceiling_price ?? effectiveBasePrice * 4);

        // Définir les variables sanitized pour le prompt (utiliser les valeurs effectives)
        const sanitizedStrategy = effectiveStrategy;
        const sanitizedBasePrice = effectiveBasePrice;
        const sanitizedFloorPrice = effectiveFloorPrice;
        const sanitizedCeilingPrice = effectiveCeilingPrice;
        
        // Sanitiser les autres champs de la propriété pour le prompt (règles depuis effectiveRules si groupe)
        const sanitizedAddress = (property.address || property.location || '').substring(0, 200);
        const sanitizedPropertyType = (property.property_type || 'Appartement').substring(0, 50);
        const sanitizedCapacity = property.capacity || 2;
        const sanitizedSurface = property.surface || 0;
        const sanitizedAmenities = Array.isArray(property.amenities) ? property.amenities.slice(0, 50) : [];
        const sanitizedLocation = (property.location || property.city || '').substring(0, 100);
        const sanitizedWeeklyDiscount = effectiveRules.weekly_discount_percent ?? effectiveRules.long_stay_discount ?? property.weekly_discount ?? property.weeklyDiscount ?? 0;
        const sanitizedMonthlyDiscount = effectiveRules.monthly_discount_percent ?? property.monthly_discount ?? property.monthlyDiscount ?? 0;
        const sanitizedWeekendMarkup = effectiveRules.weekend_markup_percent ?? effectiveRules.markup ?? property.weekend_markup_percent ?? property.weekendMarkupPercent ?? 0;
        const effectiveMinStay = effectiveRules.min_stay ?? effectiveRules.min_stay_duration ?? property.min_stay ?? 1;

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

${safeJSONStringify({
    address: sanitizedAddress,
    type: sanitizedPropertyType,
    capacity: sanitizedCapacity,
    surface: sanitizedSurface,
    amenities: sanitizedAmenities,
    listing_quality_assessment:
      "AUTO-ÉVALUATION REQUISE : Détermine si ce bien est 'Économique', 'Standard', 'Premium' ou 'Luxe' en fonction des équipements (Piscine ? Vue ? AC ?) et de la surface vs capacité."
  }, 3, 2)}

**2. RÈGLES FINANCIÈRES INVIOLABLES (HARD CONSTRAINTS)**

Ces bornes sont des "Kill Switches". Si ton calcul théorique les dépasse, tu dois couper.

- **Floor Price (Plancher Absolu):** ${sanitizedFloorPrice} € (Ligne de survie).
- **Base Price (Pivot):** ${sanitizedBasePrice} € (Prix de référence neutre).
- **Ceiling Price (Plafond):** ${sanitizedCeilingPrice || sanitizedBasePrice * 4} € (Sécurité anti-aberration).
- **Min Stay:** ${effectiveMinStay} nuits.
- **Réductions:** Semaine -${sanitizedWeeklyDiscount}%, Mois -${sanitizedMonthlyDiscount}%.
- **Majoration Week-end:** Ven/Sam +${sanitizedWeekendMarkup}%.

**3. STRATÉGIE UTILISATEUR : [ ${sanitizedStrategy} ]**

Tu dois moduler ton agressivité selon ce profil :

* **PRUDENT :** "Occupation First". Tu préfères louer à -15% que de rester vide. Tu es très réactif à la baisse en dernière minute (Last Minute).
* **ÉQUILIBRÉ :** "Market Follower". Tu cherches le ratio parfait. Tu ne prends pas de risques inutiles.
* **AGRESSIF :** "Yield First". Tu vises l'ADR (Prix Moyen) maximum. Tu ne brades pas. Tu sais que ton bien est unique et tu le fais payer. Tu acceptes d'avoir des jours vides pour vendre très cher les jours pleins.

---

### PARTIE 2 : LE "PIPELINE" DE CALCUL (8 ÉTAPES OBLIGATOIRES)

Pour **CHAQUE JOUR** du calendrier, tu dois exécuter mentalement cette séquence précise. Ne saute aucune étape.

**ÉTAPE 1 : ANALYSE MACRO-ÉCONOMIQUE & TENDANCES (MARKET HEALTH)**

* Prends en compte l'inflation actuelle en zone Euro/Locale.
* Analyse la "Force de la destination" : Est-ce que ${sanitizedLocation} est "tendance" cette année ? (Basé sur tes données d'entraînement).
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

* Effectue une recherche approfondie des événements à ${sanitizedLocation} sur les 180 jours :
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
    "strategy_active": "${sanitizedStrategy}"
  },
  "calendar": [
    {
      "date": "YYYY-MM-DD",
      "weekday": "String",
      "final_suggested_price": 0,
      "currency": "EUR",
      "price_breakdown": {
        "base": ${sanitizedBasePrice},
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
        // Utiliser safety_guardrails dès l'extraction pour sécuriser les prix de l'IA
        const daily_prices = iaResult.calendar.map(day => {
            const rawPrice = day.final_suggested_price;
            // Validation initiale avec safety_guardrails
            const validationResult = validatePriceSafety(rawPrice, {
                base_price: effectiveBasePrice,
                min_price: effectiveFloorPrice || 0,
                max_price: effectiveCeilingPrice || Infinity,
                allow_override: false,
                sanity_threshold: 0.5
            });
            
            if (validationResult.wasAdjusted) {
                console.log(`[Auto-Pricing] [SAFETY_GUARD] Prix IA ajusté pour ${day.date}: ${rawPrice} → ${validationResult.safePrice} (${validationResult.reason})`);
            }
            
            return {
                date: day.date,
                price: validationResult.safePrice,
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
        const floor = effectiveFloorPrice;
        const ceiling = effectiveCeilingPrice;

        // Récupérer tous les price_overrides pour cette propriété pour trouver les prix verrouillés
        const allOverrides = await db.getPriceOverrides(propertyId);
        const lockedPrices = new Map();
        allOverrides.forEach(override => {
            if (override.is_locked) {
                lockedPrices.set(override.date, override.price);
            }
        });

        // Préparer les overrides à sauvegarder avec validation via safety_guardrails
        const overridesToSave = [];
        let pricesApplied = 0;
        for (const day of strategyResult.daily_prices) {
            // Ignorer les prix verrouillés
            if (lockedPrices.has(day.date)) {
                continue; // Ignorer les prix verrouillés
            }

            // Utiliser le module safety_guardrails pour valider et sécuriser le prix
            const validationResult = validatePriceSafety(day.price, {
                base_price: property.base_price,
                min_price: floor || 0,
                max_price: ceiling || Infinity,
                allow_override: false,
                sanity_threshold: 0.5 // 50% de variation max par défaut
            });

            if (validationResult.wasAdjusted) {
                console.log(`[Auto-Pricing] [SAFETY_GUARD] Prix ajusté pour ${propertyId} - ${day.date}: ${day.price} → ${validationResult.safePrice} (${validationResult.reason})`);
            }

            overridesToSave.push({
                date: day.date,
                price: validationResult.safePrice,
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

        // Si le pricing automatique est activé pour cette propriété, mettre à jour auto_pricing_updated_at
        if (property.auto_pricing_enabled) {
            await db.updateProperty(propertyId, {
                auto_pricing_updated_at: new Date().toISOString()
            });
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

            // Préparer le contexte du groupe avec stratégie et règles
            const groupContext = {
                strategy: group.strategy || group._strategy_raw || {},
                rules: group.rules || {}
            };

            // Générer les prix pour la propriété principale avec le contexte du groupe
            const result = await generateAndApplyPricingForProperty(
                group.mainPropertyId,
                mainProperty,
                userId,
                userEmail,
                groupContext
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
                        userEmail,
                        groupContext
                    );
                }

                // Mettre à jour auto_pricing_updated_at sur le groupe
                try {
                    await db.updateGroup(group.id, {
                        auto_pricing_updated_at: new Date().toISOString()
                    });
                    console.log(`[Auto-Pricing] auto_pricing_updated_at mis à jour pour le groupe ${group.id}`);
                } catch (updateError) {
                    console.error(`[Auto-Pricing] Erreur lors de la mise à jour de auto_pricing_updated_at pour le groupe ${group.id}:`, updateError);
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
        // Filtrer les groupes dont la propriété principale a auto_pricing_enabled activé
        const groupsWithSync = groups.filter(g => {
            if (!g.sync_prices || !g.main_property_id) return false;
            const mainProperty = properties.find(p => p.id === g.main_property_id);
            return mainProperty && mainProperty.auto_pricing_enabled === true;
        });
        
        if (groupsWithSync.length > 0) {
            // Vérifier pour chaque groupe si la propriété principale doit être traitée
            const { hour, minute } = getCurrentTimeInTimezone(userData.auto_pricing?.timezone || userData.timezone || 'Europe/Paris');
            const isScheduledTime = hour === 0 && minute === 0;
            
            const eligibleGroups = [];
            for (const group of groupsWithSync) {
                const mainProperty = properties.find(p => p.id === group.main_property_id);
                if (!mainProperty) continue;
                
                // Si ce n'est pas l'heure prévue (00h00), vérifier si une génération a eu lieu aujourd'hui
                if (!isScheduledTime) {
                    // Vérifier d'abord sur le groupe, puis sur la propriété principale
                    const groupUpdatedAt = group.auto_pricing_updated_at;
                    const propertyUpdatedAt = mainProperty.auto_pricing_updated_at;
                    const updatedAt = groupUpdatedAt || propertyUpdatedAt;
                    
                    if (updatedAt) {
                        const updatedAtDate = new Date(updatedAt);
                        const now = new Date();
                        
                        // Utiliser Intl.DateTimeFormat pour obtenir les dates dans le fuseau horaire de l'utilisateur
                        const dateFormatter = new Intl.DateTimeFormat('en-CA', { 
                            timeZone: timezone, 
                            year: 'numeric', 
                            month: '2-digit', 
                            day: '2-digit' 
                        });
                        
                        const updatedAtDateStr = dateFormatter.format(updatedAtDate);
                        const nowDateStr = dateFormatter.format(now);
                        
                        // Comparer les dates (format: YYYY-MM-DD)
                        if (updatedAtDateStr === nowDateStr) {
                            // Si une génération a eu lieu aujourd'hui et qu'on n'est pas à 00h00, ne pas régénérer
                            console.log(`[Auto-Pricing] Groupe ${group.id} ignoré: génération déjà effectuée aujourd'hui (${updatedAtDate.toISOString()}) - Fuseau: ${timezone} - Date locale: ${updatedAtDateStr}`);
                            continue;
                        }
                    }
                }
                
                eligibleGroups.push(group);
            }
            
            if (eligibleGroups.length > 0) {
                const groupResults = await generatePricingForGroups(userId, userData.email, eligibleGroups, properties);
                results.push(...groupResults);
            }
        }

        // Traiter les propriétés individuelles (non dans un groupe avec sync)
        const propertiesInSyncedGroups = new Set();
        groupsWithSync.forEach(group => {
            const groupProps = (group.properties || []).map(p => typeof p === 'string' ? p : (p.id || p.property_id));
            groupProps.forEach(propId => propertiesInSyncedGroups.add(propId));
        });

        const individualProperties = properties.filter(p => !propertiesInSyncedGroups.has(p.id));
        
        // Filtrer les propriétés avec pricing automatique activé
        const propertiesWithAutoPricing = individualProperties.filter(p => p.auto_pricing_enabled === true);
        
        // Vérifier pour chaque propriété si elle doit être traitée
        const { hour, minute } = getCurrentTimeInTimezone(userData.auto_pricing?.timezone || userData.timezone || 'Europe/Paris');
        const isScheduledTime = hour === 0 && minute === 0;
        
        for (const property of propertiesWithAutoPricing) {
            // Si ce n'est pas l'heure prévue (00h00), vérifier si une génération a eu lieu aujourd'hui
            if (!isScheduledTime && property.auto_pricing_updated_at) {
                const updatedAt = new Date(property.auto_pricing_updated_at);
                const now = new Date();
                
                // Vérifier si la mise à jour a eu lieu aujourd'hui (même jour)
                const isToday = updatedAt.getFullYear() === now.getFullYear() &&
                               updatedAt.getMonth() === now.getMonth() &&
                               updatedAt.getDate() === now.getDate();
                
                if (isToday) {
                    // Si une génération a eu lieu aujourd'hui et qu'on n'est pas à 00h00, ne pas régénérer
                    console.log(`[Auto-Pricing] Propriété ${property.id} ignorée: génération déjà effectuée aujourd'hui (${updatedAt.toISOString()})`);
                    continue;
                }
            }
            
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
        command = command.replace('python', PYTHON_COMMAND);
        
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
        command = command.replace('python', PYTHON_COMMAND);
        
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
 * Exécute le script Python de réentraînement des modèles de demande.
 * 
 * @param {Object} options - Options pour le réentraînement
 * @param {number} options.days - Nombre de jours d'historique à utiliser (défaut: 180)
 * @param {number} options.minNewRecommendations - Minimum de nouvelles recommandations (défaut: 50)
 * @param {number} options.minDaysSinceTraining - Minimum de jours depuis dernier entraînement (défaut: 30)
 * @param {number} options.minImprovement - Amélioration minimale pour remplacer (défaut: 0.05)
 * @param {boolean} options.force - Forcer le réentraînement même si critères non remplis (défaut: false)
 * @returns {Promise<Object>} Rapport de réentraînement
 */
async function retrainPricingModels(options = {}) {
    const {
        days = 180,
        minNewRecommendations = 50,
        minDaysSinceTraining = 30,
        minImprovement = 0.05,
        force = false
    } = options;

    const startTime = new Date().toISOString();
    let jobId = null;

    try {
        // Logger le début du job dans pipeline_logs_market
        const { data: logData, error: logError } = await supabase
            .from('pipeline_logs_market')
            .insert({
                job_name: 'retrain_pricing_models',
                status: 'running',
                start_time: startTime,
                parameters: {
                    days,
                    minNewRecommendations,
                    minDaysSinceTraining,
                    minImprovement,
                    force
                }
            })
            .select()
            .single();

        if (logData) {
            jobId = logData.id;
        }

        // Construire la commande Python
        let command = 'python -m scripts.retrain_demand_models_from_logs';
        command += ` --days ${days}`;
        command += ` --min-new-recommendations ${minNewRecommendations}`;
        command += ` --min-days-since-training ${minDaysSinceTraining}`;
        command += ` --min-improvement ${minImprovement}`;
        
        if (force) {
            command += ' --force';
        }

        // Ajouter --output pour capturer le rapport JSON
        const outputFile = path.join(__dirname, 'temp', `retrain_report_${Date.now()}.json`);
        const tempDir = path.join(__dirname, 'temp');
        const fs = require('fs');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        command += ` --output "${outputFile}"`;

        console.log(`[Pricing Retrain] Exécution du réentraînement: ${command}`);
        
        // Exécuter le script Python
        command = command.replace('python', PYTHON_COMMAND);
        
        const { stdout, stderr } = await execAsync(command, {
            cwd: __dirname,
            maxBuffer: 10 * 1024 * 1024,
            env: {
                ...process.env,
                PYTHONUNBUFFERED: '1'
            }
        });

        // Lire le rapport JSON depuis le fichier
        let report = null;
        try {
            if (fs.existsSync(outputFile)) {
                const reportContent = fs.readFileSync(outputFile, 'utf-8');
                report = JSON.parse(reportContent);
                // Nettoyer le fichier temporaire
                fs.unlinkSync(outputFile);
            } else {
                // Essayer de parser depuis stdout
                const jsonMatch = stdout.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    report = JSON.parse(jsonMatch[0]);
                } else {
                    throw new Error('No JSON output found');
                }
            }
        } catch (parseError) {
            console.error('[Pricing Retrain] Erreur de parsing JSON:', parseError);
            console.error('[Pricing Retrain] stdout:', stdout);
            console.error('[Pricing Retrain] stderr:', stderr);
            
            // Mettre à jour le log avec l'erreur
            if (jobId) {
                await supabase
                    .from('pipeline_logs_market')
                    .update({
                        status: 'failed',
                        end_time: new Date().toISOString(),
                        error_message: `Failed to parse Python script output: ${parseError.message}`,
                        output: stdout.substring(0, 10000) // Limiter la taille
                    })
                    .eq('id', jobId);
            }
            
            return {
                success: false,
                error: 'Failed to parse Python script output',
                stdout: stdout,
                stderr: stderr,
                parseError: parseError.message
            };
        }

        if (stderr) {
            console.warn('[Pricing Retrain] Warnings/Errors from Python script:', stderr);
        }

        const endTime = new Date().toISOString();
        const duration = (new Date(endTime) - new Date(startTime)) / 1000;

        // Mettre à jour le log avec le succès
        if (jobId) {
            await supabase
                .from('pipeline_logs_market')
                .update({
                    status: report.summary?.errors > 0 ? 'completed_with_errors' : 'completed',
                    end_time: endTime,
                    duration_seconds: duration,
                    output: JSON.stringify({
                        summary: report.summary,
                        total_processed: report.results?.length || 0
                    }, null, 2).substring(0, 10000)
                })
                .eq('id', jobId);
        }

        console.log(`[Pricing Retrain] Réentraînement terminé: ${report.summary?.total_processed || 0} propriété(s) traitée(s)`);
        
        return {
            success: report.summary?.errors === 0,
            report: report
        };

    } catch (error) {
        console.error('[Pricing Retrain] Erreur lors de l\'exécution du script Python:', error);
        
        const endTime = new Date().toISOString();
        
        // Mettre à jour le log avec l'erreur
        if (jobId) {
            await supabase
                .from('pipeline_logs_market')
                .update({
                    status: 'failed',
                    end_time: endTime,
                    error_message: error.message,
                    duration_seconds: (new Date(endTime) - new Date(startTime)) / 1000
                })
                .eq('id', jobId);
        }
        
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
        command = command.replace('python', PYTHON_COMMAND);
        
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
 * @deprecated Cette fonction est remplacée par pricingBridge.getRecommendedPrice()
 * Conservée pour référence / débogage uniquement.
 * 
 * Exécute le script Python de recommandation de prix pour une propriété/date.
 *
 * @param {Object} options
 * @param {string} options.propertyId
 * @param {string} options.date
 * @param {string} [options.roomType]
 * @returns {Promise<Object>} Recommandation de prix retournée par le script Python
 */
/*
async function runPythonPriceRecommendation(options = {}) {
    const {
        propertyId,
        date,
        roomType = 'default'
    } = options;

    if (!propertyId || !date) {
        throw new Error('propertyId et date sont requis pour la recommandation de prix');
    }

    // Sécurité basique sur le format de date
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
        throw new Error('Format de date invalide. Utilisez YYYY-MM-DD');
    }

    try {
        // Script Python: scripts/demo_optimize_price.py
        let command = `python -m scripts.demo_optimize_price --property-id ${propertyId} --date ${date} --room-type ${roomType}`;

        console.log(`[Pricing IA] Exécution de la recommandation de prix: ${command}`);

        command = command.replace('python', PYTHON_COMMAND);

        const { stdout, stderr } = await execAsync(command, {
            cwd: __dirname,
            maxBuffer: 10 * 1024 * 1024,
            env: {
                ...process.env,
                PYTHONUNBUFFERED: '1'
            }
        });

        if (stderr) {
            console.warn('[Pricing IA] Warnings/Errors from Python script:', stderr);
        }

        let recommendation;
        try {
            const jsonMatch = stdout.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                recommendation = JSON.parse(jsonMatch[0]);
            } else {
                throw new Error('No JSON output found in stdout');
            }
        } catch (parseError) {
            console.error('[Pricing IA] Erreur de parsing JSON:', parseError);
            console.error('[Pricing IA] stdout:', stdout);
            console.error('[Pricing IA] stderr:', stderr);
            throw new Error('Failed to parse Python price recommendation output');
        }

        return recommendation;
    } catch (error) {
        console.error('[Pricing IA] Erreur lors de l’exécution du script Python:', error);
        throw error;
    }
}
*/

/**
 * @deprecated Cette fonction est remplacée par pricingBridge.simulatePrices()
 * Conservée pour référence / débogage uniquement.
 * 
 * Exécute le moteur de simulation Python pour une grille de prix.
 *
 * @param {Object} options
 * @param {string} options.propertyId
 * @param {string} options.date
 * @param {string} [options.roomType]
 * @param {Array<number>} options.priceGrid
 * @returns {Promise<Array<Object>>} Liste { price, predicted_demand, expected_revenue }
 */
/*
async function runPythonPriceSimulation(options = {}) {
    const {
        propertyId,
        date,
        roomType = 'default',
        priceGrid
    } = options;

    if (!propertyId || !date || !Array.isArray(priceGrid) || priceGrid.length === 0) {
        throw new Error('propertyId, date et une priceGrid non vide sont requis pour la simulation');
    }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
        throw new Error('Format de date invalide. Utilisez YYYY-MM-DD');
    }

    try {
        const pricesArg = priceGrid.join(',');

        // On exécute un petit script Python inline qui importe l’optimizer
        let command = `python - << "EOF"
from pricing_engine.optimizer import simulate_revenue_for_price_grid

property_id = "${propertyId}"
room_type = "${roomType}"
date = "${date}"
price_grid = [${pricesArg}]

results = simulate_revenue_for_price_grid(
    property_id=property_id,
    room_type=room_type,
    date=date,
    price_grid=price_grid,
    capacity_remaining=10,
    context_features={},
)

import json
print(json.dumps(results, ensure_ascii=False))
EOF`;

        console.log(`[Pricing IA] Exécution de la simulation de prix (inline Python)`);

        const { stdout, stderr } = await execAsync(command, {
            cwd: __dirname,
            maxBuffer: 10 * 1024 * 1024,
            env: {
                ...process.env,
                PYTHONUNBUFFERED: '1'
            },
            shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash'
        });

        if (stderr) {
            console.warn('[Pricing IA] Warnings/Errors from inline Python simulation:', stderr);
        }

        let results;
        try {
            results = JSON.parse(stdout);
        } catch (parseError) {
            console.error('[Pricing IA] Erreur de parsing JSON simulation:', parseError);
            console.error('[Pricing IA] stdout:', stdout);
            console.error('[Pricing IA] stderr:', stderr);
            throw new Error('Failed to parse Python price simulation output');
        }

        return results;
    } catch (error) {
        console.error('[Pricing IA] Erreur lors de la simulation de prix:', error);
        throw error;
    }
}
*/

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