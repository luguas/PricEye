/**
 * Système de monitoring et de détection des tentatives d'injection de prompt IA
 * Détecte, log et bloque les tentatives d'injection malveillantes
 */

/**
 * Patterns suspects à détecter dans les inputs utilisateur
 */
const SUSPICIOUS_PATTERNS = [
    /ignore\s+(les\s+)?instructions/gi,
    /forget\s+(les\s+)?instructions/gi,
    /override\s+(les\s+)?instructions/gi,
    /disregard\s+(the\s+)?previous/gi,
    /ignore\s+(the\s+)?previous/gi,
    /forget\s+(the\s+)?previous/gi,
    /you\s+are\s+now/gi,
    /you\s+must\s+now/gi,
    /system\s*:\s*ignore/gi,
    /new\s+instructions/gi,
    /previous\s+instructions\s+are\s+wrong/gi,
    /disregard\s+above/gi,
    /ignore\s+above/gi,
    /forget\s+everything/gi,
    /start\s+over/gi,
    /reset\s+context/gi
];

/**
 * Configuration du système de monitoring
 */
const MONITORING_CONFIG = {
    // Nombre de tentatives avant alerte
    ALERT_THRESHOLD: 3,
    // Nombre de tentatives avant blocage temporaire
    BLOCK_THRESHOLD: 5,
    // Durée du blocage en millisecondes (1 heure par défaut)
    BLOCK_DURATION: 60 * 60 * 1000,
    // Fenêtre de temps pour compter les tentatives (1 heure)
    TIME_WINDOW: 60 * 60 * 1000,
    // Durée de rétention des logs en millisecondes (24 heures)
    LOG_RETENTION: 24 * 60 * 60 * 1000
};

/**
 * Stockage en mémoire des tentatives d'injection
 * Structure: { userId: { attempts: [...], blockedUntil: timestamp } }
 */
const injectionAttempts = new Map();

/**
 * Nettoyage périodique des anciennes tentatives
 */
setInterval(() => {
    const now = Date.now();
    for (const [userId, data] of injectionAttempts.entries()) {
        // Supprimer les tentatives anciennes (hors fenêtre de temps)
        data.attempts = data.attempts.filter(attempt => now - attempt.timestamp < MONITORING_CONFIG.TIME_WINDOW);
        
        // Supprimer l'entrée si plus de tentatives et pas de blocage actif
        if (data.attempts.length === 0 && (!data.blockedUntil || data.blockedUntil < now)) {
            injectionAttempts.delete(userId);
        }
    }
}, 5 * 60 * 1000); // Nettoyage toutes les 5 minutes

/**
 * Détecte les patterns suspects dans un input
 * 
 * @param {string} input - L'input à analyser
 * @returns {Array<{pattern: RegExp, match: string}>} - Liste des patterns détectés
 */
function detectSuspiciousPatterns(input) {
    if (!input || typeof input !== 'string') {
        return [];
    }
    
    const detected = [];
    for (const pattern of SUSPICIOUS_PATTERNS) {
        const matches = input.match(pattern);
        if (matches) {
            detected.push({
                pattern: pattern.toString(),
                matches: matches
            });
        }
    }
    
    return detected;
}

/**
 * Enregistre une tentative d'injection
 * 
 * @param {string} userId - ID de l'utilisateur
 * @param {string} endpoint - Endpoint de l'API appelé
 * @param {string} fieldName - Nom du champ concerné
 * @param {string} input - L'input suspect
 * @param {Array} detectedPatterns - Patterns détectés
 * @returns {Object} - Résultat de l'analyse { isBlocked, attemptsCount, blockedUntil }
 */
function recordInjectionAttempt(userId, endpoint, fieldName, input, detectedPatterns) {
    const now = Date.now();
    const timestamp = new Date().toISOString();
    
    // Initialiser l'entrée pour cet utilisateur si nécessaire
    if (!injectionAttempts.has(userId)) {
        injectionAttempts.set(userId, {
            attempts: [],
            blockedUntil: null
        });
    }
    
    const userData = injectionAttempts.get(userId);
    
    // Vérifier si l'utilisateur est actuellement bloqué
    if (userData.blockedUntil && userData.blockedUntil > now) {
        const remainingTime = Math.ceil((userData.blockedUntil - now) / 1000 / 60); // en minutes
        console.error(`[Injection Monitor] ⛔ Tentative d'injection bloquée pour userId: ${userId} (bloqué pendant encore ${remainingTime} minutes)`);
        return {
            isBlocked: true,
            attemptsCount: userData.attempts.length,
            blockedUntil: new Date(userData.blockedUntil).toISOString(),
            remainingMinutes: remainingTime
        };
    }
    
    // Nettoyer les tentatives anciennes (hors fenêtre de temps)
    userData.attempts = userData.attempts.filter(attempt => now - attempt.timestamp < MONITORING_CONFIG.TIME_WINDOW);
    
    // Ajouter la nouvelle tentative
    const attempt = {
        timestamp: now,
        endpoint,
        fieldName,
        input: input.substring(0, 200), // Limiter la longueur pour le log
        detectedPatterns: detectedPatterns.map(p => p.pattern),
        detectedAt: timestamp
    };
    
    userData.attempts.push(attempt);
    
    const attemptsCount = userData.attempts.length;
    
    // Logger la tentative
    console.warn(`[Injection Monitor] 🚨 Tentative d'injection détectée | userId: ${userId} | endpoint: ${endpoint} | champ: ${fieldName} | patterns: ${detectedPatterns.map(p => p.pattern).join(', ')} | tentatives: ${attemptsCount}`);
    
    // Vérifier si on doit envoyer une alerte
    if (attemptsCount >= MONITORING_CONFIG.ALERT_THRESHOLD && attemptsCount < MONITORING_CONFIG.BLOCK_THRESHOLD) {
        sendAlert(userId, attemptsCount, endpoint);
    }
    
    // Vérifier si on doit bloquer l'utilisateur
    if (attemptsCount >= MONITORING_CONFIG.BLOCK_THRESHOLD) {
        userData.blockedUntil = now + MONITORING_CONFIG.BLOCK_DURATION;
        const blockedUntilDate = new Date(userData.blockedUntil).toISOString();
        console.error(`[Injection Monitor] ⛔ Utilisateur bloqué | userId: ${userId} | tentatives: ${attemptsCount} | bloqué jusqu'à: ${blockedUntilDate}`);
        sendBlockAlert(userId, attemptsCount, endpoint, blockedUntilDate);
        
        return {
            isBlocked: true,
            attemptsCount,
            blockedUntil: blockedUntilDate,
            remainingMinutes: Math.ceil(MONITORING_CONFIG.BLOCK_DURATION / 1000 / 60)
        };
    }
    
    return {
        isBlocked: false,
        attemptsCount,
        blockedUntil: null,
        remainingMinutes: 0
    };
}

/**
 * Envoie une alerte pour plusieurs tentatives d'injection
 * 
 * @param {string} userId - ID de l'utilisateur
 * @param {number} attemptsCount - Nombre de tentatives
 * @param {string} endpoint - Endpoint concerné
 */
function sendAlert(userId, attemptsCount, endpoint) {
    console.error(`[Injection Monitor] ⚠️ ALERTE: ${attemptsCount} tentatives d'injection détectées pour userId: ${userId} sur endpoint: ${endpoint}`);
    // TODO: Envoyer une notification (email, Slack, etc.) si nécessaire
    // Exemple: await sendEmailToAdmin(userId, attemptsCount, endpoint);
}

/**
 * Envoie une alerte de blocage d'utilisateur
 * 
 * @param {string} userId - ID de l'utilisateur
 * @param {number} attemptsCount - Nombre de tentatives
 * @param {string} endpoint - Endpoint concerné
 * @param {string} blockedUntil - Date de fin de blocage
 */
function sendBlockAlert(userId, attemptsCount, endpoint, blockedUntil) {
    console.error(`[Injection Monitor] 🚫 BLOQUAGE: Utilisateur ${userId} bloqué après ${attemptsCount} tentatives sur ${endpoint}. Bloqué jusqu'à: ${blockedUntil}`);
    // TODO: Envoyer une notification critique (email, Slack, etc.) si nécessaire
    // Exemple: await sendCriticalAlertToAdmin(userId, attemptsCount, endpoint, blockedUntil);
}

/**
 * Vérifie si un utilisateur est actuellement bloqué
 * 
 * @param {string} userId - ID de l'utilisateur
 * @returns {Object|null} - Informations de blocage ou null si non bloqué
 */
function isUserBlocked(userId) {
    if (!injectionAttempts.has(userId)) {
        return null;
    }
    
    const userData = injectionAttempts.get(userId);
    const now = Date.now();
    
    if (userData.blockedUntil && userData.blockedUntil > now) {
        const remainingTime = Math.ceil((userData.blockedUntil - now) / 1000 / 60); // en minutes
        return {
            isBlocked: true,
            blockedUntil: new Date(userData.blockedUntil).toISOString(),
            remainingMinutes: remainingTime
        };
    }
    
    // Si le blocage est expiré, le supprimer
    if (userData.blockedUntil && userData.blockedUntil <= now) {
        userData.blockedUntil = null;
    }
    
    return null;
}

/**
 * Analyse un input et enregistre les tentatives d'injection détectées
 * 
 * @param {string} userId - ID de l'utilisateur
 * @param {string} endpoint - Endpoint de l'API appelé
 * @param {string} fieldName - Nom du champ concerné
 * @param {string} input - L'input à analyser
 * @returns {Object} - Résultat de l'analyse { hasSuspiciousPatterns, detectedPatterns, isBlocked, attemptsCount }
 */
function analyzeInput(userId, endpoint, fieldName, input) {
    // 1. Vérifier si l'utilisateur est déjà bloqué
    const blockStatus = isUserBlocked(userId);
    if (blockStatus) {
        return {
            hasSuspiciousPatterns: true,
            detectedPatterns: [],
            isBlocked: true,
            attemptsCount: 0,
            blockedUntil: blockStatus.blockedUntil,
            remainingMinutes: blockStatus.remainingMinutes
        };
    }
    
    // 2. Détecter les patterns suspects
    const detectedPatterns = detectSuspiciousPatterns(input);
    
    if (detectedPatterns.length === 0) {
        return {
            hasSuspiciousPatterns: false,
            detectedPatterns: [],
            isBlocked: false,
            attemptsCount: 0
        };
    }
    
    // 3. Enregistrer la tentative d'injection
    const result = recordInjectionAttempt(userId, endpoint, fieldName, input, detectedPatterns);
    
    return {
        hasSuspiciousPatterns: true,
        detectedPatterns: detectedPatterns.map(p => p.pattern),
        isBlocked: result.isBlocked,
        attemptsCount: result.attemptsCount,
        blockedUntil: result.blockedUntil,
        remainingMinutes: result.remainingMinutes
    };
}

/**
 * Middleware Express pour vérifier les tentatives d'injection avant le traitement
 * À utiliser avant les endpoints qui acceptent des inputs utilisateur
 * 
 * @param {Request} req - Objet request Express
 * @param {Response} res - Objet response Express
 * @param {Function} next - Fonction next Express
 */
function checkInjectionMiddleware(req, res, next) {
    try {
        const userId = req.user?.uid;
        if (!userId) {
            // Si pas d'utilisateur authentifié, passer au suivant
            return next();
        }
        
        const endpoint = req.path || req.route?.path || 'unknown';
        
        // Vérifier si l'utilisateur est bloqué
        const blockStatus = isUserBlocked(userId);
        if (blockStatus) {
            return res.status(429).json({
                error: 'Accès temporairement bloqué',
                message: `Votre compte a été temporairement bloqué en raison de tentatives d'injection détectées. Réessayez dans ${blockStatus.remainingMinutes} minutes.`,
                blockedUntil: blockStatus.blockedUntil,
                remainingMinutes: blockStatus.remainingMinutes
            });
        }
        
        // Analyser le body de la requête pour détecter les patterns suspects
        if (req.body && typeof req.body === 'object') {
            const bodyStr = JSON.stringify(req.body);
            const analysis = analyzeInput(userId, endpoint, 'request_body', bodyStr);
            
            if (analysis.isBlocked) {
                return res.status(429).json({
                    error: 'Accès temporairement bloqué',
                    message: `Votre compte a été temporairement bloqué en raison de tentatives d'injection détectées. Réessayez dans ${analysis.remainingMinutes} minutes.`,
                    blockedUntil: analysis.blockedUntil,
                    remainingMinutes: analysis.remainingMinutes
                });
            }
        }
        
        // Analyser les query parameters
        if (req.query && typeof req.query === 'object') {
            const queryStr = JSON.stringify(req.query);
            const analysis = analyzeInput(userId, endpoint, 'query_params', queryStr);
            
            if (analysis.isBlocked) {
                return res.status(429).json({
                    error: 'Accès temporairement bloqué',
                    message: `Votre compte a été temporairement bloqué en raison de tentatives d'injection détectées. Réessayez dans ${analysis.remainingMinutes} minutes.`,
                    blockedUntil: analysis.blockedUntil,
                    remainingMinutes: analysis.remainingMinutes
                });
            }
        }
        
        next();
    } catch (error) {
        console.error('[Injection Monitor] Erreur dans le middleware:', error);
        // En cas d'erreur, autoriser la requête (fail-safe)
        next();
    }
}

/**
 * Obtient les statistiques de monitoring pour un utilisateur
 * 
 * @param {string} userId - ID de l'utilisateur
 * @returns {Object} - Statistiques de l'utilisateur
 */
function getUserStats(userId) {
    if (!injectionAttempts.has(userId)) {
        return {
            attemptsCount: 0,
            isBlocked: false,
            blockedUntil: null,
            recentAttempts: []
        };
    }
    
    const userData = injectionAttempts.get(userId);
    const now = Date.now();
    
    // Nettoyer les tentatives anciennes
    userData.attempts = userData.attempts.filter(attempt => now - attempt.timestamp < MONITORING_CONFIG.TIME_WINDOW);
    
    return {
        attemptsCount: userData.attempts.length,
        isBlocked: userData.blockedUntil && userData.blockedUntil > now,
        blockedUntil: userData.blockedUntil ? new Date(userData.blockedUntil).toISOString() : null,
        remainingMinutes: userData.blockedUntil && userData.blockedUntil > now 
            ? Math.ceil((userData.blockedUntil - now) / 1000 / 60) 
            : 0,
        recentAttempts: userData.attempts.slice(-10).map(attempt => ({
            timestamp: new Date(attempt.timestamp).toISOString(),
            endpoint: attempt.endpoint,
            fieldName: attempt.fieldName,
            detectedPatterns: attempt.detectedPatterns
        }))
    };
}

/**
 * Réinitialise les tentatives d'un utilisateur (pour les admins)
 * 
 * @param {string} userId - ID de l'utilisateur
 */
function resetUserAttempts(userId) {
    if (injectionAttempts.has(userId)) {
        injectionAttempts.delete(userId);
        console.log(`[Injection Monitor] ✅ Tentatives réinitialisées pour userId: ${userId}`);
    }
}

module.exports = {
    analyzeInput,
    detectSuspiciousPatterns,
    recordInjectionAttempt,
    isUserBlocked,
    checkInjectionMiddleware,
    getUserStats,
    resetUserAttempts,
    MONITORING_CONFIG,
    SUSPICIOUS_PATTERNS
};






