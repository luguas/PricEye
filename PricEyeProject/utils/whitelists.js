/**
 * Whitelists et fonctions de validation pour les inputs utilisateur
 * Centralise les listes de valeurs autorisées pour éviter la duplication
 */

/**
 * Helper pour logger les modifications de sanitisation avec traçabilité userId
 * (Défini localement pour éviter la dépendance circulaire avec promptSanitizer)
 * 
 * @param {string} level - Niveau de log ('warn' pour sanitisation, 'error' pour rejet)
 * @param {string} fieldName - Nom du champ concerné
 * @param {any} before - Valeur avant sanitisation
 * @param {any} after - Valeur après sanitisation
 * @param {string} reason - Raison de la modification
 * @param {string} userId - ID de l'utilisateur (optionnel, pour traçabilité)
 */
function logSanitization(level, fieldName, before, after, reason, userId = null) {
    const userIdStr = userId ? ` [userId: ${userId}]` : '';
    const beforeStr = typeof before === 'string' && before.length > 100 
        ? `${before.substring(0, 100)}...` 
        : String(before);
    const afterStr = typeof after === 'string' && after.length > 100 
        ? `${after.substring(0, 100)}...` 
        : String(after);
    
    const message = `[Sanitization]${userIdStr} Champ '${fieldName}': ${reason} | Avant: "${beforeStr}" → Après: "${afterStr}"`;
    
    if (level === 'error') {
        console.error(message);
    } else {
        console.warn(message);
    }
}

/**
 * Types de propriétés autorisés dans le système
 */
const ALLOWED_PROPERTY_TYPES = [
    'appartement',
    'maison',
    'villa',
    'studio',
    'chambre',
    'autre'
];

/**
 * Stratégies de pricing autorisées dans le système
 */
const ALLOWED_STRATEGIES = [
    'Prudent',
    'Équilibré',
    'Agressif'
];

/**
 * Langues autorisées dans le système
 */
const ALLOWED_LANGUAGES = [
    'fr',
    'en',
    'es',
    'de',
    'it'
];

/**
 * Vérifie si un type de propriété est dans la whitelist
 * 
 * @param {string} type - Le type de propriété à vérifier
 * @returns {boolean} - true si le type est valide, false sinon
 * 
 * @example
 * isValidPropertyType('appartement') // true
 * isValidPropertyType('invalid') // false
 */
function isValidPropertyType(type) {
    if (!type || typeof type !== 'string') {
        return false;
    }
    
    // Normaliser le type (minuscules, trim)
    const normalizedType = type.toLowerCase().trim();
    
    return ALLOWED_PROPERTY_TYPES.includes(normalizedType);
}

/**
 * Valide strictement un type de propriété selon la whitelist
 * 
 * @param {string} type - Le type de propriété à valider
 * @param {string} fieldName - Nom du champ pour les messages d'erreur (optionnel, défaut: 'property_type')
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @returns {string} - Le type validé et normalisé
 * @throws {Error} - Si la validation échoue avec un message d'erreur clair incluant fieldName et la liste des types autorisés
 * 
 * @example
 * sanitizePropertyType('appartement', 'property_type')
 * // Retourne: 'appartement'
 * 
 * sanitizePropertyType('Appartement', 'property_type')
 * // Retourne: 'appartement' (normalisé en minuscule)
 * 
 * sanitizePropertyType('invalid', 'property_type')
 * // Lance une erreur: "Le champ 'property_type' doit être un des types suivants: appartement, maison, villa, studio, chambre, autre. Valeur reçue: \"invalid\""
 * 
 * sanitizePropertyType('', 'property_type')
 * // Lance une erreur: "Le champ 'property_type' ne peut pas être vide. Un type de propriété valide est requis"
 */
function sanitizePropertyType(type, fieldName = null, userId = null) {
    const fieldNameStr = fieldName || 'property_type';
    
    // 3. Valide que le type n'est pas une string vide
    if (typeof type !== 'string') {
        const errorMsg = `Le champ '${fieldNameStr}' doit être une string. Type reçu: ${typeof type}`;
        logSanitization('error', fieldNameStr, type, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    const trimmedType = type.trim();
    
    if (trimmedType === '') {
        const errorMsg = `Le champ '${fieldNameStr}' ne peut pas être vide. Un type de propriété valide est requis`;
        logSanitization('error', fieldNameStr, type, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // Normaliser le type (minuscules, trim)
    const normalizedType = trimmedType.toLowerCase();
    
    // 1. Rejeter explicitement les valeurs non autorisées (au lieu de retourner defaultValue)
    // 2. Retourner une erreur avec la liste des types autorisés
    if (!ALLOWED_PROPERTY_TYPES.includes(normalizedType)) {
        const allowedTypesStr = ALLOWED_PROPERTY_TYPES.map(t => `"${t}"`).join(', ');
        const errorMsg = `Le champ '${fieldNameStr}' doit être un des types suivants: ${allowedTypesStr}. Valeur reçue: "${trimmedType}"`;
        logSanitization('error', fieldNameStr, type, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // Logger si le type a été normalisé (trim ou lowercase)
    if (type !== normalizedType) {
        logSanitization('warn', fieldNameStr, type, normalizedType, 'Type normalisé (trim/lowercase)', userId);
    }
    
    // 5. Retourner le type validé ou lancer une erreur avec fieldName
    return normalizedType;
}

/**
 * Sanitise une stratégie de pricing en retournant la stratégie si valide, ou une valeur par défaut si invalide
 * 
 * @param {string} strategy - La stratégie à sanitiser
 * @param {string} defaultValue - La valeur par défaut à retourner si la stratégie est invalide (défaut: 'Équilibré')
 * @param {string} fieldName - Nom du champ pour le logging (optionnel)
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @returns {string} - La stratégie validée ou la valeur par défaut
 * 
 * @example
 * sanitizeStrategy('Prudent') // 'Prudent'
 * sanitizeStrategy('invalid') // 'Équilibré' (valeur par défaut)
 * sanitizeStrategy('invalid', 'Prudent') // 'Prudent'
 */
function sanitizeStrategy(strategy, defaultValue = 'Équilibré', fieldName = null, userId = null) {
    if (!strategy || typeof strategy !== 'string') {
        if (strategy !== null && strategy !== undefined) {
            logSanitization('warn', fieldName || 'strategy', strategy, defaultValue, 'Stratégie non-string, utilisation de la valeur par défaut', userId);
        }
        return defaultValue;
    }
    
    // Vérifier si la stratégie est dans la whitelist (comparaison exacte, sensible à la casse)
    if (ALLOWED_STRATEGIES.includes(strategy)) {
        return strategy;
    }
    
    // Retourner la valeur par défaut si invalide
    logSanitization('warn', fieldName || 'strategy', strategy, defaultValue, 'Stratégie non autorisée (whitelist), utilisation de la valeur par défaut', userId);
    return defaultValue;
}

/**
 * Sanitise une langue en retournant la langue si valide, ou une valeur par défaut si invalide
 * 
 * @param {string} language - La langue à sanitiser
 * @param {string} defaultValue - La valeur par défaut à retourner si la langue est invalide (défaut: 'fr')
 * @param {string} fieldName - Nom du champ pour le logging (optionnel)
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @returns {string} - La langue validée ou la valeur par défaut
 * 
 * @example
 * sanitizeLanguage('fr') // 'fr'
 * sanitizeLanguage('invalid') // 'fr' (valeur par défaut)
 * sanitizeLanguage('invalid', 'en') // 'en'
 */
function sanitizeLanguage(language, defaultValue = 'fr', fieldName = null, userId = null) {
    if (!language || typeof language !== 'string') {
        if (language !== null && language !== undefined) {
            logSanitization('warn', fieldName || 'language', language, defaultValue, 'Langue non-string, utilisation de la valeur par défaut', userId);
        }
        return defaultValue;
    }
    
    // Normaliser la langue (minuscules, trim)
    const normalizedLanguage = language.toLowerCase().trim();
    
    // Vérifier si la langue est dans la whitelist
    if (ALLOWED_LANGUAGES.includes(normalizedLanguage)) {
        // Logger si la langue a été normalisée
        if (language !== normalizedLanguage) {
            logSanitization('warn', fieldName || 'language', language, normalizedLanguage, 'Langue normalisée (trim/lowercase)', userId);
        }
        return normalizedLanguage;
    }
    
    // Retourner la valeur par défaut si invalide
    logSanitization('warn', fieldName || 'language', language, defaultValue, 'Langue non autorisée (whitelist), utilisation de la valeur par défaut', userId);
    return defaultValue;
}

module.exports = {
    ALLOWED_PROPERTY_TYPES,
    isValidPropertyType,
    sanitizePropertyType,
    ALLOWED_STRATEGIES,
    sanitizeStrategy,
    ALLOWED_LANGUAGES,
    sanitizeLanguage
};

