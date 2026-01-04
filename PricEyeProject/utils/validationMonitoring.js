/**
 * Système de monitoring et de logging des erreurs de validation
 * Traque les erreurs fréquentes, les patterns suspects et génère des alertes
 */

/**
 * Configuration du système de monitoring
 */
const MONITORING_CONFIG = {
    // Nombre d'erreurs avant alerte pour un utilisateur
    USER_ALERT_THRESHOLD: 10,
    // Nombre d'erreurs avant alerte pour un champ spécifique
    FIELD_ALERT_THRESHOLD: 20,
    // Fenêtre de temps pour compter les erreurs (1 heure)
    TIME_WINDOW: 60 * 60 * 1000,
    // Durée de rétention des logs en millisecondes (24 heures)
    LOG_RETENTION: 24 * 60 * 60 * 1000,
    // Intervalle de nettoyage (5 minutes)
    CLEANUP_INTERVAL: 5 * 60 * 1000
};

/**
 * Stockage en mémoire des erreurs de validation
 * Structure: {
 *   userErrors: Map<userId, Array<{timestamp, fieldName, value, rule, endpoint}>>,
 *   fieldErrors: Map<fieldName, Array<{timestamp, userId, value, rule, endpoint}>>,
 *   ruleErrors: Map<rule, Array<{timestamp, userId, fieldName, value, endpoint}>>
 * }
 */
const validationErrors = {
    userErrors: new Map(), // Erreurs par utilisateur
    fieldErrors: new Map(), // Erreurs par champ
    ruleErrors: new Map()   // Erreurs par règle
};

/**
 * Nettoyage périodique des anciennes erreurs
 */
setInterval(() => {
    const now = Date.now();
    const cutoffTime = now - MONITORING_CONFIG.LOG_RETENTION;
    
    // Nettoyer les erreurs utilisateur
    for (const [userId, errors] of validationErrors.userErrors.entries()) {
        const filtered = errors.filter(err => err.timestamp > cutoffTime);
        if (filtered.length === 0) {
            validationErrors.userErrors.delete(userId);
        } else {
            validationErrors.userErrors.set(userId, filtered);
        }
    }
    
    // Nettoyer les erreurs par champ
    for (const [fieldName, errors] of validationErrors.fieldErrors.entries()) {
        const filtered = errors.filter(err => err.timestamp > cutoffTime);
        if (filtered.length === 0) {
            validationErrors.fieldErrors.delete(fieldName);
        } else {
            validationErrors.fieldErrors.set(fieldName, filtered);
        }
    }
    
    // Nettoyer les erreurs par règle
    for (const [rule, errors] of validationErrors.ruleErrors.entries()) {
        const filtered = errors.filter(err => err.timestamp > cutoffTime);
        if (filtered.length === 0) {
            validationErrors.ruleErrors.delete(rule);
        } else {
            validationErrors.ruleErrors.set(rule, filtered);
        }
    }
}, MONITORING_CONFIG.CLEANUP_INTERVAL);

/**
 * Obtient l'endpoint actuel depuis le contexte global
 * @returns {string} - L'endpoint actuel ou 'unknown'
 */
function getCurrentEndpoint() {
    return global.currentRequestEndpoint || 'unknown';
}

/**
 * Formate une valeur pour le logging (tronque si trop longue)
 * @param {any} value - La valeur à formater
 * @param {number} maxLength - Longueur maximale (défaut: 100)
 * @returns {string} - Valeur formatée
 */
function formatValueForLog(value, maxLength = 100) {
    if (value === null || value === undefined) {
        return String(value);
    }
    const str = typeof value === 'string' ? value : String(value);
    if (str.length > maxLength) {
        return `${str.substring(0, maxLength)}...`;
    }
    return str;
}

/**
 * Enregistre une erreur de validation
 * 
 * @param {string} level - Niveau de log ('warn' pour validation, 'error' pour rejet)
 * @param {string} fieldName - Nom du champ concerné
 * @param {any} value - Valeur qui a échoué la validation
 * @param {string} rule - Règle de validation qui a échoué
 * @param {string} userId - ID de l'utilisateur (optionnel)
 * @param {string} endpoint - Endpoint de l'API (optionnel, récupéré automatiquement si non fourni)
 * @param {string} message - Message d'erreur (optionnel)
 */
function logValidationError(level, fieldName, value, rule, userId = null, endpoint = null, message = null) {
    const timestamp = new Date().toISOString();
    const currentEndpoint = endpoint || getCurrentEndpoint();
    const formattedValue = formatValueForLog(value);
    
    // 1. Logger chaque erreur de validation avec userId, fieldName, value, rule
    // 2. Utiliser un niveau de log approprié (warn pour validation, error pour rejet)
    // 3. Inclure le timestamp et l'endpoint dans les logs
    const logMessage = `[Validation ${level.toUpperCase()}] [${timestamp}] [Endpoint: ${currentEndpoint}]${userId ? ` [userId: ${userId}]` : ''} Champ '${fieldName}' (règle: ${rule}): ${message || 'Erreur de validation'} | Valeur: "${formattedValue}"`;
    
    if (level === 'error') {
        console.error(logMessage);
    } else {
        console.warn(logMessage);
    }
    
    // Enregistrer l'erreur dans le système de monitoring
    if (userId) {
        if (!validationErrors.userErrors.has(userId)) {
            validationErrors.userErrors.set(userId, []);
        }
        validationErrors.userErrors.get(userId).push({
            timestamp: Date.now(),
            fieldName,
            value: formattedValue,
            rule,
            endpoint: currentEndpoint
        });
    }
    
    // Enregistrer par champ
    if (!validationErrors.fieldErrors.has(fieldName)) {
        validationErrors.fieldErrors.set(fieldName, []);
    }
    validationErrors.fieldErrors.get(fieldName).push({
        timestamp: Date.now(),
        userId,
        value: formattedValue,
        rule,
        endpoint: currentEndpoint
    });
    
    // Enregistrer par règle
    if (!validationErrors.ruleErrors.has(rule)) {
        validationErrors.ruleErrors.set(rule, []);
    }
    validationErrors.ruleErrors.get(rule).push({
        timestamp: Date.now(),
        userId,
        fieldName,
        value: formattedValue,
        endpoint: currentEndpoint
    });
    
    // 5. Alerter si un utilisateur a trop d'erreurs de validation
    if (userId) {
        checkUserErrorThreshold(userId);
    }
    
    // 4. Créer un système de monitoring des erreurs de validation fréquentes
    checkFrequentErrors(fieldName, rule);
}

/**
 * Vérifie si un utilisateur dépasse le seuil d'erreurs
 * @param {string} userId - ID de l'utilisateur
 */
function checkUserErrorThreshold(userId) {
    const errors = validationErrors.userErrors.get(userId) || [];
    const now = Date.now();
    const windowStart = now - MONITORING_CONFIG.TIME_WINDOW;
    
    // Compter les erreurs dans la fenêtre de temps
    const recentErrors = errors.filter(err => err.timestamp >= windowStart);
    const errorCount = recentErrors.length;
    
    if (errorCount >= MONITORING_CONFIG.USER_ALERT_THRESHOLD) {
        console.error(`[VALIDATION ALERT] Utilisateur ${userId} a dépassé le seuil d'erreurs: ${errorCount} erreurs dans les ${MONITORING_CONFIG.TIME_WINDOW / 60000} dernières minutes`);
        
        // Log des détails des erreurs récentes
        const errorDetails = recentErrors.reduce((acc, err) => {
            const key = `${err.fieldName}:${err.rule}`;
            acc[key] = (acc[key] || 0) + 1;
            return acc;
        }, {});
        
        console.error(`[VALIDATION ALERT] Détails des erreurs pour ${userId}:`, errorDetails);
    }
}

/**
 * Vérifie les erreurs fréquentes par champ et règle
 * @param {string} fieldName - Nom du champ
 * @param {string} rule - Règle de validation
 */
function checkFrequentErrors(fieldName, rule) {
    const now = Date.now();
    const windowStart = now - MONITORING_CONFIG.TIME_WINDOW;
    
    // Vérifier les erreurs pour ce champ
    const fieldErrors = validationErrors.fieldErrors.get(fieldName) || [];
    const recentFieldErrors = fieldErrors.filter(err => err.timestamp >= windowStart);
    
    if (recentFieldErrors.length >= MONITORING_CONFIG.FIELD_ALERT_THRESHOLD) {
        console.warn(`[VALIDATION MONITORING] Champ '${fieldName}' a ${recentFieldErrors.length} erreurs dans les ${MONITORING_CONFIG.TIME_WINDOW / 60000} dernières minutes`);
        
        // Analyser les erreurs par règle
        const ruleCounts = recentFieldErrors.reduce((acc, err) => {
            acc[err.rule] = (acc[err.rule] || 0) + 1;
            return acc;
        }, {});
        
        console.warn(`[VALIDATION MONITORING] Erreurs par règle pour '${fieldName}':`, ruleCounts);
    }
    
    // Vérifier les erreurs pour cette règle
    const ruleErrors = validationErrors.ruleErrors.get(rule) || [];
    const recentRuleErrors = ruleErrors.filter(err => err.timestamp >= windowStart);
    
    if (recentRuleErrors.length >= MONITORING_CONFIG.FIELD_ALERT_THRESHOLD) {
        console.warn(`[VALIDATION MONITORING] Règle '${rule}' a ${recentRuleErrors.length} erreurs dans les ${MONITORING_CONFIG.TIME_WINDOW / 60000} dernières minutes`);
        
        // Analyser les erreurs par champ
        const fieldCounts = recentRuleErrors.reduce((acc, err) => {
            acc[err.fieldName] = (acc[err.fieldName] || 0) + 1;
            return acc;
        }, {});
        
        console.warn(`[VALIDATION MONITORING] Erreurs par champ pour la règle '${rule}':`, fieldCounts);
    }
}

/**
 * Obtient les statistiques d'erreurs pour un utilisateur
 * @param {string} userId - ID de l'utilisateur
 * @param {number} timeWindow - Fenêtre de temps en millisecondes (optionnel)
 * @returns {Object} - Statistiques d'erreurs
 */
function getUserErrorStats(userId, timeWindow = MONITORING_CONFIG.TIME_WINDOW) {
    const errors = validationErrors.userErrors.get(userId) || [];
    const now = Date.now();
    const windowStart = now - timeWindow;
    
    const recentErrors = errors.filter(err => err.timestamp >= windowStart);
    
    const stats = {
        totalErrors: recentErrors.length,
        errorsByField: {},
        errorsByRule: {},
        errorsByEndpoint: {},
        recentErrors: recentErrors.slice(-10) // 10 dernières erreurs
    };
    
    recentErrors.forEach(err => {
        stats.errorsByField[err.fieldName] = (stats.errorsByField[err.fieldName] || 0) + 1;
        stats.errorsByRule[err.rule] = (stats.errorsByRule[err.rule] || 0) + 1;
        stats.errorsByEndpoint[err.endpoint] = (stats.errorsByEndpoint[err.endpoint] || 0) + 1;
    });
    
    return stats;
}

/**
 * Obtient les statistiques d'erreurs globales
 * @param {number} timeWindow - Fenêtre de temps en millisecondes (optionnel)
 * @returns {Object} - Statistiques globales
 */
function getGlobalErrorStats(timeWindow = MONITORING_CONFIG.TIME_WINDOW) {
    const now = Date.now();
    const windowStart = now - timeWindow;
    
    const stats = {
        totalErrors: 0,
        errorsByField: {},
        errorsByRule: {},
        errorsByUser: {},
        errorsByEndpoint: {}
    };
    
    // Compter toutes les erreurs dans la fenêtre de temps
    for (const errors of validationErrors.userErrors.values()) {
        errors.filter(err => err.timestamp >= windowStart).forEach(err => {
            stats.totalErrors++;
            stats.errorsByField[err.fieldName] = (stats.errorsByField[err.fieldName] || 0) + 1;
            stats.errorsByRule[err.rule] = (stats.errorsByRule[err.rule] || 0) + 1;
            stats.errorsByEndpoint[err.endpoint] = (stats.errorsByEndpoint[err.endpoint] || 0) + 1;
        });
    }
    
    // Compter les erreurs par utilisateur
    for (const [userId, errors] of validationErrors.userErrors.entries()) {
        const userErrors = errors.filter(err => err.timestamp >= windowStart);
        if (userErrors.length > 0) {
            stats.errorsByUser[userId] = userErrors.length;
        }
    }
    
    return stats;
}

/**
 * Réinitialise les statistiques d'erreurs pour un utilisateur
 * @param {string} userId - ID de l'utilisateur
 */
function resetUserErrors(userId) {
    validationErrors.userErrors.delete(userId);
}

module.exports = {
    logValidationError,
    getUserErrorStats,
    getGlobalErrorStats,
    resetUserErrors,
    MONITORING_CONFIG
};



