/**
 * Classe d'erreur de validation personnalisée
 * Fournit des erreurs structurées pour la validation d'inputs avec traçabilité et traduction
 */

/**
 * Messages d'erreur par défaut (français)
 * Ces messages peuvent être remplacés par des traductions
 */
const DEFAULT_ERROR_MESSAGES = {
    required: (fieldName) => `Le champ '${fieldName}' est requis.`,
    type: (fieldName, expectedType, actualType) => `Le champ '${fieldName}' doit être de type ${expectedType}. Type reçu: ${actualType}`,
    min: (fieldName, min, value) => `Le champ '${fieldName}' doit être supérieur ou égal à ${min}. Valeur reçue: ${value}`,
    max: (fieldName, max, value) => `Le champ '${fieldName}' doit être inférieur ou égal à ${max}. Valeur reçue: ${value}`,
    range: (fieldName, min, max, value) => `Le champ '${fieldName}' doit être entre ${min} et ${max}. Valeur reçue: ${value}`,
    length: (fieldName, minLength, maxLength, actualLength) => `Le champ '${fieldName}' doit avoir entre ${minLength} et ${maxLength} caractères. Longueur reçue: ${actualLength}`,
    minLength: (fieldName, minLength, actualLength) => `Le champ '${fieldName}' doit avoir au moins ${minLength} caractères. Longueur reçue: ${actualLength}`,
    maxLength: (fieldName, maxLength, actualLength) => `Le champ '${fieldName}' doit avoir au maximum ${maxLength} caractères. Longueur reçue: ${actualLength}`,
    pattern: (fieldName, patternDescription) => `Le champ '${fieldName}' ne correspond pas au format requis: ${patternDescription}`,
    enum: (fieldName, allowedValues, value) => `Le champ '${fieldName}' doit être une des valeurs suivantes: ${allowedValues.join(', ')}. Valeur reçue: ${value}`,
    email: (fieldName, value) => `Le champ '${fieldName}' doit être un email valide. Valeur reçue: ${value}`,
    url: (fieldName, value) => `Le champ '${fieldName}' doit être une URL valide. Valeur reçue: ${value}`,
    integer: (fieldName, value) => `Le champ '${fieldName}' doit être un nombre entier. Valeur reçue: ${value}`,
    positive: (fieldName, value) => `Le champ '${fieldName}' doit être un nombre positif. Valeur reçue: ${value}`,
    custom: (fieldName, message) => message
};

/**
 * Fonction de traduction optionnelle
 * Peut être remplacée par un système de traduction (i18n)
 * @type {Function|null}
 */
let translationFunction = null;

/**
 * Définit la fonction de traduction
 * @param {Function} fn - Fonction de traduction (fieldName, rule, params) => string
 */
function setTranslationFunction(fn) {
    translationFunction = fn;
}

/**
 * Classe ValidationError - Erreur de validation personnalisée
 * Étend Error avec des propriétés supplémentaires pour la validation
 */
class ValidationError extends Error {
    /**
     * @param {string} fieldName - Nom du champ qui a échoué la validation
     * @param {any} value - Valeur qui a échoué la validation
     * @param {string} rule - Règle de validation qui a échoué (ex: 'required', 'min', 'max', 'range', 'pattern', 'enum', etc.)
     * @param {any} allowedValues - Valeurs autorisées (pour les règles 'enum' ou 'pattern')
     * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
     * @param {Object} params - Paramètres supplémentaires pour le message d'erreur (ex: { min, max, minLength, maxLength, patternDescription })
     * @param {string} customMessage - Message d'erreur personnalisé (optionnel, prioritaire sur les messages par défaut)
     */
    constructor(fieldName, value, rule, allowedValues = null, userId = null, params = {}, customMessage = null) {
        // 2. Génère des messages d'erreur clairs et spécifiques
        const message = customMessage || ValidationError._generateMessage(fieldName, value, rule, allowedValues, params);
        
        super(message);
        
        // Assurer que le nom de la classe est correct (pour les stacks traces)
        this.name = 'ValidationError';
        
        // 1. Étend Error avec des propriétés : fieldName, value, rule, allowedValues
        this.fieldName = fieldName;
        this.value = value;
        this.rule = rule;
        this.allowedValues = allowedValues;
        
        // 4. Inclut le userId dans les erreurs pour traçabilité
        this.userId = userId;
        
        // Stocker les paramètres supplémentaires
        this.params = params;
        
        // Maintenir la stack trace (pour Node.js et navigateurs)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, ValidationError);
        }
    }
    
    /**
     * Génère un message d'erreur basé sur la règle
     * 3. Supporte la traduction des messages d'erreur
     * 
     * @private
     * @param {string} fieldName - Nom du champ
     * @param {any} value - Valeur invalide
     * @param {string} rule - Règle de validation
     * @param {any} allowedValues - Valeurs autorisées
     * @param {Object} params - Paramètres supplémentaires
     * @returns {string} - Message d'erreur généré
     */
    static _generateMessage(fieldName, value, rule, allowedValues, params) {
        // 3. Supporte la traduction des messages d'erreur
        if (translationFunction && typeof translationFunction === 'function') {
            try {
                const translatedMessage = translationFunction(fieldName, rule, {
                    value,
                    allowedValues,
                    ...params
                });
                if (translatedMessage) {
                    return translatedMessage;
                }
            } catch (error) {
                console.warn('[ValidationError] Erreur lors de la traduction:', error);
                // Continuer avec le message par défaut
            }
        }
        
        // Utiliser les messages par défaut
        const messageGenerator = DEFAULT_ERROR_MESSAGES[rule];
        if (!messageGenerator) {
            // Message générique si la règle n'est pas reconnue
            return `Erreur de validation pour le champ '${fieldName}': ${rule}. Valeur reçue: ${value}`;
        }
        
        // Générer le message selon la règle
        switch (rule) {
            case 'required':
                return messageGenerator(fieldName);
            case 'type':
                return messageGenerator(fieldName, params.expectedType, params.actualType || typeof value);
            case 'min':
                return messageGenerator(fieldName, params.min, value);
            case 'max':
                return messageGenerator(fieldName, params.max, value);
            case 'range':
                return messageGenerator(fieldName, params.min, params.max, value);
            case 'length':
                return messageGenerator(fieldName, params.minLength, params.maxLength, params.actualLength);
            case 'minLength':
                return messageGenerator(fieldName, params.minLength, params.actualLength);
            case 'maxLength':
                return messageGenerator(fieldName, params.maxLength, params.actualLength);
            case 'pattern':
                return messageGenerator(fieldName, params.patternDescription || 'format requis');
            case 'enum':
                const valuesStr = Array.isArray(allowedValues) 
                    ? allowedValues.map(v => typeof v === 'string' ? `"${v}"` : String(v)).join(', ')
                    : String(allowedValues);
                return messageGenerator(fieldName, allowedValues, value);
            case 'email':
            case 'url':
            case 'integer':
            case 'positive':
                return messageGenerator(fieldName, value);
            case 'custom':
                return messageGenerator(fieldName, params.message || 'Erreur de validation');
            default:
                return `Erreur de validation pour le champ '${fieldName}': ${rule}. Valeur reçue: ${value}`;
        }
    }
    
    /**
     * 5. Formate les erreurs pour l'API (JSON)
     * Retourne une représentation JSON de l'erreur
     * 
     * @returns {Object} - Objet JSON représentant l'erreur
     */
    toJSON() {
        const json = {
            name: this.name,
            message: this.message,
            fieldName: this.fieldName,
            rule: this.rule,
            value: this.value
        };
        
        // Ajouter allowedValues si présent
        if (this.allowedValues !== null && this.allowedValues !== undefined) {
            json.allowedValues = this.allowedValues;
        }
        
        // Ajouter userId si présent (pour traçabilité)
        if (this.userId !== null && this.userId !== undefined) {
            json.userId = this.userId;
        }
        
        // Ajouter les paramètres supplémentaires s'ils sont présents
        if (this.params && Object.keys(this.params).length > 0) {
            json.params = this.params;
        }
        
        return json;
    }
    
    /**
     * Retourne une représentation string de l'erreur
     * 
     * @returns {string} - Représentation string de l'erreur
     */
    toString() {
        return this.message;
    }
}

module.exports = {
    ValidationError,
    setTranslationFunction,
    DEFAULT_ERROR_MESSAGES
};








