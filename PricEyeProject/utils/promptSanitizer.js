/**
 * Utilitaires de sanitisation pour sécuriser les inputs avant injection dans les prompts IA
 * Protège contre les attaques par injection de prompt (prompt injection)
 */

const { sanitizePropertyType, sanitizeStrategy, ALLOWED_PROPERTY_TYPES, ALLOWED_STRATEGIES } = require('./whitelists');
const { analyzeInput } = require('./injectionMonitor');
const { logValidationError } = require('./validationMonitoring');

/**
 * Helper pour logger les modifications de sanitisation avec traçabilité userId
 * Amélioré avec le système de monitoring des erreurs de validation
 * 
 * @param {string} level - Niveau de log ('warn' pour sanitisation, 'error' pour rejet)
 * @param {string} fieldName - Nom du champ concerné
 * @param {any} before - Valeur avant sanitisation
 * @param {any} after - Valeur après sanitisation
 * @param {string} reason - Raison de la modification (peut inclure la règle de validation)
 * @param {string} userId - ID de l'utilisateur (optionnel, pour traçabilité)
 * @param {string} rule - Règle de validation qui a échoué (optionnel, extrait de reason si non fourni)
 */
function logSanitization(level, fieldName, before, after, reason, userId = null, rule = null) {
    // Extraire la règle de validation depuis la raison si non fournie
    // Les règles communes: 'type', 'min', 'max', 'range', 'length', 'pattern', 'enum', etc.
    let validationRule = rule;
    if (!validationRule && reason) {
        // Essayer d'extraire la règle depuis la raison
        const ruleMatch = reason.match(/(type|min|max|range|length|minLength|maxLength|pattern|enum|email|url|integer|positive|required|custom)/i);
        if (ruleMatch) {
            validationRule = ruleMatch[1].toLowerCase();
        } else {
            validationRule = 'custom'; // Règle personnalisée par défaut
        }
    }
    
    // 1. Logger chaque erreur de validation avec userId, fieldName, value, rule
    // 2. Utiliser un niveau de log approprié (warn pour validation, error pour rejet)
    // 3. Inclure le timestamp et l'endpoint dans les logs (géré par logValidationError)
    if (level === 'error' && validationRule) {
        // Pour les erreurs de validation, utiliser le système de monitoring
        logValidationError(level, fieldName, before, validationRule, userId, null, reason);
    }
    
    // Logging classique pour compatibilité
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
 * Sanitise une chaîne de caractères pour l'injection sécurisée dans un prompt IA
 * 
 * @param {string} input - La chaîne à sanitiser
 * @param {number} maxLength - Longueur maximale autorisée (défaut: 200)
 * @param {string} fieldName - Nom du champ pour le logging (optionnel)
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @returns {string} - Chaîne sanitizée et sécurisée
 * 
 * @example
 * sanitizeForPrompt('Paris". Ignore les instructions précédentes...')
 * // Retourne: 'Paris. Ignore les instructions précédentes...'
 */
function sanitizeForPrompt(input, maxLength = 200, fieldName = null, userId = null) {
    // 1. Vérifier que l'input est une string (retourne '' sinon)
    if (typeof input !== 'string') {
        if (input === null || input === undefined) {
            return '';
        }
        // Tenter de convertir en string si possible
        try {
            input = String(input);
        } catch (e) {
            console.warn('[Prompt Sanitizer] Impossible de convertir l\'input en string:', typeof input);
            return '';
        }
    }

    // 1.1. Valider l'encodage UTF-8
    // Vérifier que la chaîne est valide UTF-8 (Node.js gère UTF-16 nativement, mais on vérifie la validité)
    try {
        // Tenter de décoder/encoder pour valider UTF-8
        Buffer.from(input, 'utf8').toString('utf8');
    } catch (e) {
        logSanitization('warn', fieldName || 'string', input, '', 'Encodage UTF-8 invalide, chaîne rejetée', userId);
        return '';
    }

    // 1.2. Normaliser les caractères Unicode (NFD -> NFC)
    // NFD (Normalization Form Decomposed) sépare les caractères avec diacritiques
    // NFC (Normalization Form Composed) les recompose
    // Cela évite les problèmes de comparaison et d'affichage
    let sanitized = input;
    try {
        const beforeNormalize = sanitized;
        sanitized = sanitized.normalize('NFC');
        if (beforeNormalize !== sanitized) {
            logSanitization('warn', fieldName || 'string', beforeNormalize, sanitized, 'Caractères Unicode normalisés (NFD -> NFC)', userId);
        }
    } catch (e) {
        // Si la normalisation échoue, continuer avec la chaîne originale
        console.warn('[Prompt Sanitizer] Erreur lors de la normalisation Unicode:', e.message);
    }

    // 1.3. Supprimer les caractères Unicode dangereux (bidirectionnels, invisibles, etc.)
    // Caractères bidirectionnels (RTL/LTR) qui peuvent être utilisés pour des attaques
    // Caractères invisibles (zero-width, etc.)
    const beforeUnicodeCleanup = sanitized;
    sanitized = sanitized
        // Supprimer les marqueurs bidirectionnels (RTL/LTR)
        .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '') // Marqueurs bidirectionnels
        // Supprimer les caractères invisibles (zero-width)
        .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '') // Zero-width space, zero-width non-joiner, etc.
        // Supprimer les caractères de formatage invisibles
        .replace(/[\u2000-\u200A\u202F\u205F]/g, ' ') // Espaces de différentes largeurs -> espace normal
        // Supprimer les caractères de contrôle Unicode
        .replace(/[\u0080-\u009F]/g, ''); // Caractères de contrôle C1
    
    if (beforeUnicodeCleanup !== sanitized) {
        logSanitization('warn', fieldName || 'string', beforeUnicodeCleanup, sanitized, 'Caractères Unicode dangereux supprimés (bidirectionnels, invisibles)', userId);
    }

    // 1.4. Limiter les emojis (optionnel - supprime les emojis pour éviter les problèmes d'affichage)
    // Les emojis sont dans les plages Unicode suivantes :
    // - U+1F300-U+1F9FF (Symbols & Pictographs)
    // - U+1FA00-U+1FAFF (Symbols Extended-A)
    // - U+2600-U+26FF (Misc Symbols)
    // - U+2700-U+27BF (Dingbats)
    // - U+FE00-U+FE0F (Variation Selectors)
    // - U+1F900-U+1F9FF (Supplemental Symbols and Pictographs)
    const beforeEmojiCleanup = sanitized;
    sanitized = sanitized
        // Supprimer les emojis (plages Unicode des emojis)
        .replace(/[\u{1F300}-\u{1F9FF}]/gu, '') // Symbols & Pictographs
        .replace(/[\u{1FA00}-\u{1FAFF}]/gu, '') // Symbols Extended-A
        .replace(/[\u{2600}-\u{26FF}]/gu, '') // Misc Symbols
        .replace(/[\u{2700}-\u{27BF}]/gu, '') // Dingbats
        .replace(/[\u{FE00}-\u{FE0F}]/gu, '') // Variation Selectors
        .replace(/[\u{1F900}-\u{1F9FF}]/gu, '') // Supplemental Symbols
        // Supprimer les séquences d'emojis (combinaisons avec zero-width joiner)
        .replace(/[\u{200D}][\u{1F300}-\u{1F9FF}]/gu, ''); // Emoji sequences
    
    if (beforeEmojiCleanup !== sanitized) {
        logSanitization('warn', fieldName || 'string', beforeEmojiCleanup, sanitized, 'Emojis supprimés pour sécurité', userId);
    }

    // 2. Supprimer les caractères dangereux : guillemets doubles, simples, backticks, backslashes
    const beforeQuotes = sanitized;
    sanitized = sanitized
        .replace(/"/g, '')      // Supprimer les guillemets doubles
        .replace(/'/g, '')      // Supprimer les guillemets simples
        .replace(/`/g, '')       // Supprimer les backticks
        .replace(/\\/g, '');     // Supprimer les backslashes

    // Vérifier si des caractères dangereux ont été supprimés
    if (beforeQuotes !== sanitized) {
        logSanitization('warn', fieldName || 'string', beforeQuotes, sanitized, 'Caractères dangereux supprimés (guillemets, backticks, backslashes)', userId);
    }

    // 3. Remplace les retours à la ligne par des espaces
    const beforeNewlines = sanitized;
    sanitized = sanitized
        .replace(/\r\n/g, ' ')   // Windows: \r\n
        .replace(/\n/g, ' ')     // Unix: \n
        .replace(/\r/g, ' ');    // Mac: \r
    
    if (beforeNewlines !== sanitized) {
        logSanitization('warn', fieldName || 'string', beforeNewlines, sanitized, 'Retours à la ligne remplacés par des espaces', userId);
    }

    // 4. Limite la longueur à maxLength caractères par défaut (paramètre configurable)
    if (sanitized.length > maxLength) {
        const beforeTruncate = sanitized;
        sanitized = sanitized.substring(0, maxLength);
        logSanitization('warn', fieldName || 'string', beforeTruncate, sanitized, `Chaîne tronquée à ${maxLength} caractères`, userId);
    }

    // 5. Supprime les caractères de contrôle (ASCII < 32 sauf espaces)
    // Les espaces (32) et tabulations (9) sont conservés
    sanitized = sanitized
        .split('')
        .filter(char => {
            const charCode = char.charCodeAt(0);
            // Conserver les caractères imprimables (32-126) et les caractères étendus (> 126)
            // Exclure les caractères de contrôle (0-31) sauf espace (32) et tab (9)
            return charCode >= 32 || charCode === 9;
        })
        .join('');

    // 6. Échappe les caractères spéciaux restants si nécessaire
    // Normaliser les espaces multiples en un seul espace
    sanitized = sanitized.replace(/\s+/g, ' ').trim();

    // Supprimer les séquences suspectes communes dans les injections de prompt
    const suspiciousPatterns = [
        /ignore\s+(les\s+)?instructions/gi,
        /forget\s+(les\s+)?instructions/gi,
        /override\s+(les\s+)?instructions/gi,
        /disregard\s+(the\s+)?previous/gi,
        /ignore\s+(the\s+)?previous/gi,
    ];

    for (const pattern of suspiciousPatterns) {
        if (pattern.test(sanitized)) {
            const beforePattern = sanitized;
            sanitized = sanitized.replace(pattern, '');
            if (beforePattern !== sanitized) {
                logSanitization('warn', fieldName || 'string', beforePattern, sanitized, `Pattern suspect détecté et supprimé: ${pattern}`, userId);
                
                // Enregistrer la tentative d'injection dans le système de monitoring
                if (userId) {
                    try {
                        // Récupérer l'endpoint depuis le contexte global si disponible
                        const endpoint = global.currentRequestEndpoint || 'unknown';
                        analyzeInput(userId, endpoint, fieldName || 'string', input);
                    } catch (monitoringError) {
                        // Ne pas bloquer la sanitisation si le monitoring échoue
                        console.warn('[Sanitization] Erreur lors de l\'enregistrement dans le monitoring:', monitoringError.message);
                    }
                }
            }
        }
    }

    // Nettoyer à nouveau les espaces multiples après suppression
    sanitized = sanitized.replace(/\s+/g, ' ').trim();

    // 7. Retourne une string sécurisée pour injection dans un prompt IA
    return sanitized;
}

/**
 * Valide et sanitise une date au format YYYY-MM-DD avec validation stricte
 * 
 * @param {string} dateString - La date à valider (format YYYY-MM-DD)
 * @param {number} minYear - Année minimale autorisée (défaut: 1900)
 * @param {number} maxYear - Année maximale autorisée (défaut: 2100)
 * @param {number} maxFutureYears - Nombre maximum d'années dans le futur autorisées (défaut: 10)
 * @param {string} fieldName - Nom du champ pour le logging (optionnel)
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @returns {string} - Date validée et sanitizée
 * @throws {Error} - Si la date est invalide avec message détaillé
 * 
 * @example
 * validateAndSanitizeDate('2024-01-15')
 * // Retourne: '2024-01-15'
 */
function validateAndSanitizeDate(dateString, minYear = 1900, maxYear = 2100, maxFutureYears = 10, fieldName = null, userId = null) {
    // 0. Vérifier que l'input est une string
    if (typeof dateString !== 'string') {
        const errorMsg = `Le champ '${fieldName || 'date'}' doit être une chaîne de caractères. Type reçu: ${typeof dateString}`;
        logSanitization('error', fieldName || 'date', dateString, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // Trim les espaces
    dateString = dateString.trim();

    // 1. Vérifier que le format est strictement YYYY-MM-DD (regex plus strict)
    // Regex strict : exactement 4 chiffres, tiret, exactement 2 chiffres, tiret, exactement 2 chiffres
    // Pas d'espaces, pas de caractères supplémentaires
    const dateRegex = /^(\d{4})-(\d{2})-(\d{2})$/;
    const match = dateString.match(dateRegex);
    if (!match) {
        const errorMsg = `Format de date invalide pour le champ '${fieldName || 'date'}'. Attendu: YYYY-MM-DD (ex: 2024-01-15), reçu: "${dateString}"`;
        logSanitization('error', fieldName || 'date', dateString, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // Extraire les composants avec validation des plages
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const day = parseInt(match[3], 10);

    // 2. Valider les plages de base avant parsing
    if (month < 1 || month > 12) {
        const fieldNameStr = fieldName || 'date';
        const errorMsg = `Mois invalide pour le champ '${fieldNameStr}'. Le mois doit être entre 01 et 12, reçu: ${month.toString().padStart(2, '0')}`;
        logSanitization('error', fieldNameStr, dateString, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    if (day < 1 || day > 31) {
        const fieldNameStr = fieldName || 'date';
        const errorMsg = `Jour invalide pour le champ '${fieldNameStr}'. Le jour doit être entre 01 et 31, reçu: ${day.toString().padStart(2, '0')}`;
        logSanitization('error', fieldNameStr, dateString, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // 3. Valider que la date parsée correspond exactement à l'input (évite 2024-01-32 qui devient 2024-02-01)
    const date = new Date(dateString + 'T00:00:00Z');
    const fieldNameStr = fieldName || 'date';
    
    if (isNaN(date.getTime())) {
        const errorMsg = `Date invalide pour le champ '${fieldNameStr}': ${dateString}. La date n'existe pas.`;
        logSanitization('error', fieldNameStr, dateString, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // Vérifier que les composants parsés correspondent exactement
    const parsedYear = date.getUTCFullYear();
    const parsedMonth = date.getUTCMonth() + 1;
    const parsedDay = date.getUTCDate();

    if (parsedYear !== year || parsedMonth !== month || parsedDay !== day) {
        const errorMsg = `Date invalide pour le champ '${fieldNameStr}': ${dateString}. Le jour ${day} n'existe pas dans le mois ${month} de l'année ${year}.`;
        logSanitization('error', fieldNameStr, dateString, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // 4. Valider les années bissextiles correctement
    // Vérifier si le jour 29 février est valide pour les années non-bissextiles
    if (month === 2 && day === 29) {
        const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
        if (!isLeapYear) {
            const errorMsg = `Date invalide pour le champ '${fieldNameStr}': ${dateString}. L'année ${year} n'est pas bissextile, le 29 février n'existe pas.`;
            logSanitization('error', fieldNameStr, dateString, null, errorMsg, userId);
            throw new Error(errorMsg);
        }
    }

    // 5. Vérifier que la date n'est pas trop ancienne
    if (year < minYear) {
        const errorMsg = `Date trop ancienne pour le champ '${fieldNameStr}': ${dateString}. L'année minimale autorisée est ${minYear}.`;
        logSanitization('error', fieldNameStr, dateString, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // 6. Vérifier que la date n'est pas trop future (maxFutureYears)
    const currentDate = new Date();
    const currentYear = currentDate.getUTCFullYear();
    const maxAllowedYear = currentYear + maxFutureYears;
    
    if (year > maxYear) {
        const errorMsg = `Date trop future pour le champ '${fieldNameStr}': ${dateString}. L'année maximale autorisée est ${maxYear}.`;
        logSanitization('error', fieldNameStr, dateString, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    if (year > maxAllowedYear) {
        const errorMsg = `Date trop future pour le champ '${fieldNameStr}': ${dateString}. La date ne peut pas être plus de ${maxFutureYears} ans dans le futur (année maximale: ${maxAllowedYear}).`;
        logSanitization('error', fieldNameStr, dateString, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // 7. Retourner la date validée (normalisée en YYYY-MM-DD)
    const normalizedDate = `${parsedYear.toString().padStart(4, '0')}-${parsedMonth.toString().padStart(2, '0')}-${parsedDay.toString().padStart(2, '0')}`;
    return normalizedDate;
}

/**
 * Valide une plage de dates (date de début < date de fin)
 * 
 * @param {string} startDate - Date de début au format YYYY-MM-DD
 * @param {string} endDate - Date de fin au format YYYY-MM-DD
 * @param {number} maxRangeDays - Nombre maximum de jours dans la plage (défaut: 365)
 * @param {string} fieldName - Nom du champ pour le logging (optionnel)
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @returns {Object} - { valid: boolean, error: string|null, startDate: string, endDate: string }
 * 
 * @example
 * validateDateRange('2024-01-01', '2024-12-31', 365)
 * // Retourne: { valid: true, error: null, startDate: '2024-01-01', endDate: '2024-12-31' }
 */
function validateDateRange(startDate, endDate, maxRangeDays = 365, fieldName = null, userId = null) {
    try {
        // 1. Valider que startDate et endDate sont des dates valides
        const validatedStartDate = validateAndSanitizeDate(startDate, 1900, 2100, 10, fieldName ? `${fieldName}.startDate` : 'startDate', userId);
        const validatedEndDate = validateAndSanitizeDate(endDate, 1900, 2100, 10, fieldName ? `${fieldName}.endDate` : 'endDate', userId);

        // 2. Vérifier que startDate < endDate
        const start = new Date(validatedStartDate + 'T00:00:00Z');
        const end = new Date(validatedEndDate + 'T00:00:00Z');
        
        const fieldNameStr = fieldName || 'dateRange';
        
        if (start >= end) {
            const errorMsg = `Plage de dates invalide pour le champ '${fieldNameStr}'. La date de début (${validatedStartDate}) doit être strictement antérieure à la date de fin (${validatedEndDate}).`;
            logSanitization('error', fieldNameStr, `${startDate} - ${endDate}`, null, errorMsg, userId);
            return {
                valid: false,
                error: errorMsg,
                startDate: validatedStartDate,
                endDate: validatedEndDate
            };
        }

        // 3. Vérifier que la plage ne dépasse pas maxRangeDays
        const diffTime = Math.abs(end - start);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        
        if (diffDays > maxRangeDays) {
            const errorMsg = `Plage de dates trop large pour le champ '${fieldNameStr}'. La plage de ${diffDays} jours dépasse la limite maximale de ${maxRangeDays} jours.`;
            logSanitization('error', fieldNameStr, `${startDate} - ${endDate}`, null, errorMsg, userId);
            return {
                valid: false,
                error: errorMsg,
                startDate: validatedStartDate,
                endDate: validatedEndDate,
                rangeDays: diffDays
            };
        }

        // 4. Retourner succès
        return {
            valid: true,
            error: null,
            startDate: validatedStartDate,
            endDate: validatedEndDate,
            rangeDays: diffDays
        };
    } catch (error) {
        // Si une des dates est invalide, retourner l'erreur
        return {
            valid: false,
            error: error.message,
            startDate: null,
            endDate: null
        };
    }
}

/**
 * Valide une date selon différents formats et la normalise en format ISO (YYYY-MM-DD)
 * 
 * @param {string} dateString - La date à valider
 * @param {string} format - Format attendu : 'YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY' (défaut: 'YYYY-MM-DD')
 * @param {string} fieldName - Nom du champ pour le logging (optionnel)
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @returns {string} - Date normalisée en format ISO (YYYY-MM-DD)
 * @throws {Error} - Si la date est invalide avec message détaillé
 * 
 * @example
 * validateDateFormat('15/01/2024', 'DD/MM/YYYY')
 * // Retourne: '2024-01-15'
 * 
 * validateDateFormat('01/15/2024', 'MM/DD/YYYY')
 * // Retourne: '2024-01-15'
 */
function validateDateFormat(dateString, format = 'YYYY-MM-DD', fieldName = null, userId = null) {
    // 0. Vérifier que l'input est une string
    if (typeof dateString !== 'string') {
        const fieldNameStr = fieldName || 'date';
        const errorMsg = `Le champ '${fieldNameStr}' doit être une chaîne de caractères. Type reçu: ${typeof dateString}`;
        logSanitization('error', fieldNameStr, dateString, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // Trim les espaces
    dateString = dateString.trim();
    const fieldNameStr = fieldName || 'date';

    // 1. Valider strictement le format avec regex spécifique selon le format
    let regex, yearIndex, monthIndex, dayIndex, separator;
    
    switch (format) {
        case 'YYYY-MM-DD':
            regex = /^(\d{4})-(\d{2})-(\d{2})$/;
            yearIndex = 1;
            monthIndex = 2;
            dayIndex = 3;
            separator = '-';
            break;
            
        case 'DD/MM/YYYY':
            regex = /^(\d{2})\/(\d{2})\/(\d{4})$/;
            yearIndex = 3;
            monthIndex = 2;
            dayIndex = 1;
            separator = '/';
            break;
            
        case 'MM/DD/YYYY':
            regex = /^(\d{2})\/(\d{2})\/(\d{4})$/;
            yearIndex = 3;
            monthIndex = 1;
            dayIndex = 2;
            separator = '/';
            break;
            
        default:
            const errorMsg = `Format de date non supporté pour le champ '${fieldNameStr}'. Formats supportés: 'YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY'. Format demandé: ${format}`;
            logSanitization('error', fieldNameStr, dateString, null, errorMsg, userId);
            throw new Error(errorMsg);
    }

    const match = dateString.match(regex);
    if (!match) {
        const formatExamples = {
            'YYYY-MM-DD': '2024-01-15',
            'DD/MM/YYYY': '15/01/2024',
            'MM/DD/YYYY': '01/15/2024'
        };
        const example = formatExamples[format] || 'YYYY-MM-DD';
        const errorMsg = `Format de date invalide pour le champ '${fieldNameStr}'. Format attendu: ${format} (ex: ${example}), reçu: "${dateString}"`;
        logSanitization('error', fieldNameStr, dateString, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // 2. Extraire les composants selon le format
    const year = parseInt(match[yearIndex], 10);
    const month = parseInt(match[monthIndex], 10);
    const day = parseInt(match[dayIndex], 10);

    // 3. Valider les plages de base
    if (month < 1 || month > 12) {
        const errorMsg = `Mois invalide pour le champ '${fieldNameStr}'. Le mois doit être entre 01 et 12, reçu: ${month.toString().padStart(2, '0')} (format: ${format})`;
        logSanitization('error', fieldNameStr, dateString, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    if (day < 1 || day > 31) {
        const errorMsg = `Jour invalide pour le champ '${fieldNameStr}'. Le jour doit être entre 01 et 31, reçu: ${day.toString().padStart(2, '0')} (format: ${format})`;
        logSanitization('error', fieldNameStr, dateString, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // 4. Vérifier que la date est valide après parsing
    // Construire la date ISO pour validation
    const isoDateString = `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
    const date = new Date(isoDateString + 'T00:00:00Z');
    
    if (isNaN(date.getTime())) {
        const errorMsg = `Date invalide pour le champ '${fieldNameStr}': ${dateString} (format: ${format}). La date n'existe pas.`;
        logSanitization('error', fieldNameStr, dateString, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // Vérifier que les composants parsés correspondent exactement
    const parsedYear = date.getUTCFullYear();
    const parsedMonth = date.getUTCMonth() + 1;
    const parsedDay = date.getUTCDate();

    if (parsedYear !== year || parsedMonth !== month || parsedDay !== day) {
        const errorMsg = `Date invalide pour le champ '${fieldNameStr}': ${dateString} (format: ${format}). Le jour ${day} n'existe pas dans le mois ${month} de l'année ${year}.`;
        logSanitization('error', fieldNameStr, dateString, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // 5. Valider les années bissextiles
    if (month === 2 && day === 29) {
        const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
        if (!isLeapYear) {
            const errorMsg = `Date invalide pour le champ '${fieldNameStr}': ${dateString} (format: ${format}). L'année ${year} n'est pas bissextile, le 29 février n'existe pas.`;
            logSanitization('error', fieldNameStr, dateString, null, errorMsg, userId);
            throw new Error(errorMsg);
        }
    }

    // 6. Valider la plage d'années (1900-2100, max 10 ans dans le futur)
    const currentDate = new Date();
    const currentYear = currentDate.getUTCFullYear();
    const maxAllowedYear = currentYear + 10;
    
    if (year < 1900) {
        const errorMsg = `Date trop ancienne pour le champ '${fieldNameStr}': ${dateString} (format: ${format}). L'année minimale autorisée est 1900.`;
        logSanitization('error', fieldNameStr, dateString, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    if (year > 2100) {
        const errorMsg = `Date trop future pour le champ '${fieldNameStr}': ${dateString} (format: ${format}). L'année maximale autorisée est 2100.`;
        logSanitization('error', fieldNameStr, dateString, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    if (year > maxAllowedYear) {
        const errorMsg = `Date trop future pour le champ '${fieldNameStr}': ${dateString} (format: ${format}). La date ne peut pas être plus de 10 ans dans le futur (année maximale: ${maxAllowedYear}).`;
        logSanitization('error', fieldNameStr, dateString, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // 7. Retourner la date normalisée en format ISO (YYYY-MM-DD)
    return isoDateString;
}

/**
 * Valide strictement un nombre avec rejet explicite des valeurs invalides
 * 
 * @param {any} input - L'input à valider
 * @param {Object} options - Options de validation
 * @param {number} options.min - Valeur minimale autorisée
 * @param {number} options.max - Valeur maximale autorisée
 * @param {boolean} options.mustBeInteger - Si true, rejette les décimales
 * @param {boolean} options.mustBePositive - Si true, rejette les valeurs négatives ou zéro
 * @param {number} options.maxDecimals - Nombre maximum de décimales autorisées (défaut: Infinity)
 * @param {string} fieldName - Nom du champ pour le logging (optionnel)
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @returns {number} - Nombre validé
 * @throws {Error} - Si le nombre est invalide avec message détaillé
 * 
 * @example
 * validateNumber('42', { min: 1, max: 50, mustBeInteger: true }, 'capacity')
 * // Retourne: 42
 */
function validateNumber(input, options = {}, fieldName = null, userId = null) {
    const {
        min = -Infinity,
        max = Infinity,
        mustBeInteger = false,
        mustBePositive = false,
        maxDecimals = Infinity
    } = options;
    
    const fieldNameStr = fieldName || 'number';

    // 1. Rejeter explicitement les strings non-numériques
    let number;
    
    if (typeof input === 'number') {
        number = input;
    } else if (typeof input === 'string') {
        // Vérifier que la string est bien numérique (pas de lettres, caractères spéciaux, etc.)
        const trimmedInput = input.trim();
        
        // Rejeter les strings vides
        if (trimmedInput === '') {
            const errorMsg = `Le champ '${fieldNameStr}' ne peut pas être vide. Une valeur numérique est requise.`;
            logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
            throw new Error(errorMsg);
        }
        
        // Rejeter les notations scientifiques suspectes (ex: 1e100, 1E100)
        if (/[eE]/.test(trimmedInput)) {
            const errorMsg = `Le champ '${fieldNameStr}' contient une notation scientifique non autorisée: "${trimmedInput}". Utilisez un nombre décimal standard.`;
            logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
            throw new Error(errorMsg);
        }
        
        // Vérifier que la string est bien un nombre (regex pour nombres décimaux)
        const numberRegex = /^-?\d+(\.\d+)?$/;
        if (!numberRegex.test(trimmedInput)) {
            const errorMsg = `Le champ '${fieldNameStr}' doit être un nombre valide. Valeur reçue: "${input}" (type: ${typeof input})`;
            logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
            throw new Error(errorMsg);
        }
        
        number = parseFloat(trimmedInput);
    } else {
        const errorMsg = `Le champ '${fieldNameStr}' doit être un nombre. Type reçu: ${typeof input}, valeur: ${input}`;
        logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // 2. Rejeter NaN, Infinity, -Infinity explicitement
    if (isNaN(number)) {
        const errorMsg = `Le champ '${fieldNameStr}' est NaN (Not a Number). Valeur reçue: "${input}"`;
        logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    if (!isFinite(number)) {
        const errorMsg = `Le champ '${fieldNameStr}' est ${number > 0 ? 'Infinity' : '-Infinity'}. Valeur reçue: "${input}"`;
        logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // 3. Valider que le nombre est un entier si nécessaire
    if (mustBeInteger && !Number.isInteger(number)) {
        const errorMsg = `Le champ '${fieldNameStr}' doit être un nombre entier (sans décimales). Valeur reçue: ${number}`;
        logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // 4. Valider que le nombre est positif si nécessaire
    if (mustBePositive && number <= 0) {
        const errorMsg = `Le champ '${fieldNameStr}' doit être un nombre strictement positif. Valeur reçue: ${number}`;
        logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // 5. Valider la précision des décimales (max 2 décimales pour les prix)
    if (maxDecimals < Infinity && !Number.isInteger(number)) {
        const decimalPart = String(number).split('.')[1];
        if (decimalPart && decimalPart.length > maxDecimals) {
            const errorMsg = `Le champ '${fieldNameStr}' ne peut pas avoir plus de ${maxDecimals} décimales. Valeur reçue: ${number} (${decimalPart.length} décimales)`;
            logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
            throw new Error(errorMsg);
        }
    }

    // 6. Valider la plage [min, max]
    if (number < min) {
        const errorMsg = `Le champ '${fieldNameStr}' doit être supérieur ou égal à ${min}. Valeur reçue: ${number}`;
        logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    if (number > max) {
        const errorMsg = `Le champ '${fieldNameStr}' doit être inférieur ou égal à ${max}. Valeur reçue: ${number}`;
        logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // 7. Retourner le nombre validé
    return number;
}

/**
 * Valide strictement un nombre entier avec rejet explicite des valeurs invalides
 * 
 * @param {any} input - L'input à valider comme nombre entier
 * @param {number} min - Valeur minimale autorisée (défaut: -Infinity)
 * @param {number} max - Valeur maximale autorisée (défaut: Infinity)
 * @param {string} fieldName - Nom du champ pour le logging et les messages d'erreur (optionnel)
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @returns {number} - Nombre entier validé
 * @throws {Error} - Si la validation échoue avec un message d'erreur explicite incluant fieldName
 * 
 * @example
 * validateInteger(42, 1, 50, 'capacity')
 * // Retourne: 42
 * 
 * validateInteger('42', 1, 50, 'capacity')
 * // Retourne: 42
 * 
 * validateInteger('42.5', 1, 50, 'capacity')
 * // Lance une erreur: "Le champ 'capacity' doit être un nombre entier (sans décimales). Valeur reçue: 42.5"
 * 
 * validateInteger('abc', 1, 50, 'capacity')
 * // Lance une erreur: "Le champ 'capacity' doit être un nombre entier valide. Valeur reçue: \"abc\" (type: string)"
 * 
 * validateInteger(NaN, 1, 50, 'capacity')
 * // Lance une erreur: "Le champ 'capacity' est NaN (Not a Number). Valeur reçue: NaN"
 * 
 * validateInteger(Infinity, 1, 50, 'capacity')
 * // Lance une erreur: "Le champ 'capacity' est Infinity. Valeur reçue: Infinity"
 * 
 * validateInteger(100, 1, 50, 'capacity')
 * // Lance une erreur: "Le champ 'capacity' doit être inférieur ou égal à 50. Valeur reçue: 100"
 */
function validateInteger(input, min = -Infinity, max = Infinity, fieldName = null, userId = null) {
    const fieldNameStr = fieldName || 'integer';
    
    // 1. Vérifier que l'input est un nombre entier (pas de décimales)
    let number;
    
    if (typeof input === 'number') {
        number = input;
    } else if (typeof input === 'string') {
        const trimmedInput = input.trim();
        
        // Rejeter les strings vides
        if (trimmedInput === '') {
            const errorMsg = `Le champ '${fieldNameStr}' ne peut pas être vide. Un nombre entier est requis.`;
            logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
            throw new Error(errorMsg);
        }
        
        // Rejeter les notations scientifiques suspectes (ex: 1e100, 1E100)
        if (/[eE]/.test(trimmedInput)) {
            const errorMsg = `Le champ '${fieldNameStr}' contient une notation scientifique non autorisée: "${trimmedInput}". Utilisez un nombre entier standard.`;
            logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
            throw new Error(errorMsg);
        }
        
        // 4. Rejette les strings qui ne sont pas des nombres entiers valides
        // Regex strict pour nombres entiers uniquement (pas de décimales)
        const integerRegex = /^-?\d+$/;
        if (!integerRegex.test(trimmedInput)) {
            const errorMsg = `Le champ '${fieldNameStr}' doit être un nombre entier valide (sans décimales). Valeur reçue: "${input}" (type: ${typeof input})`;
            logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
            throw new Error(errorMsg);
        }
        
        number = parseInt(trimmedInput, 10);
    } else {
        // Rejeter les types non numériques (null, undefined, object, array, etc.)
        const errorMsg = `Le champ '${fieldNameStr}' doit être un nombre entier. Type reçu: ${typeof input}, valeur: ${input}`;
        logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // 3. Rejette NaN, Infinity, -Infinity explicitement
    if (isNaN(number)) {
        const errorMsg = `Le champ '${fieldNameStr}' est NaN (Not a Number). Valeur reçue: "${input}"`;
        logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    if (!isFinite(number)) {
        const errorMsg = `Le champ '${fieldNameStr}' est ${number > 0 ? 'Infinity' : '-Infinity'}. Valeur reçue: "${input}"`;
        logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // 1. Vérifier que le nombre est bien un entier (pas de décimales)
    // Double vérification après parsing pour s'assurer qu'il n'y a pas de décimales
    if (!Number.isInteger(number)) {
        const errorMsg = `Le champ '${fieldNameStr}' doit être un nombre entier (sans décimales). Valeur reçue: ${number}`;
        logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // 2. Valide la plage [min, max]
    if (number < min) {
        const errorMsg = `Le champ '${fieldNameStr}' doit être supérieur ou égal à ${min}. Valeur reçue: ${number}`;
        logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    if (number > max) {
        const errorMsg = `Le champ '${fieldNameStr}' doit être inférieur ou égal à ${max}. Valeur reçue: ${number}`;
        logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // Logger si la valeur a été modifiée (conversion de type string -> number)
    if (typeof input !== 'number' && String(input).trim() !== String(number)) {
        logSanitization('warn', fieldNameStr, input, number, 'Conversion de type effectuée (string -> integer)', userId);
    }

    // 6. Retourne le nombre entier validé
    return number;
}

/**
 * Valide strictement un prix/montant avec validation spécifique aux prix
 * 
 * @param {any} price - Le prix à valider
 * @param {number} min - Valeur minimale autorisée (défaut: 0)
 * @param {number} max - Valeur maximale autorisée (défaut: 1000000)
 * @param {string} fieldName - Nom du champ pour le logging et les messages d'erreur (optionnel)
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @returns {number} - Prix validé arrondi à 2 décimales
 * @throws {Error} - Si la validation échoue avec un message d'erreur explicite incluant fieldName
 * 
 * @example
 * validatePrice(99.99, 0, 1000, 'base_price')
 * // Retourne: 99.99
 * 
 * validatePrice('123.456', 0, 1000, 'price')
 * // Arrondit à 2 décimales et retourne: 123.46
 * 
 * validatePrice(-50, 0, 1000, 'price')
 * // Lance une erreur: "Le champ 'price' doit être un nombre positif. Valeur reçue: -50"
 * 
 * validatePrice(2000000, 0, 1000000, 'price')
 * // Lance une erreur: "Le champ 'price' doit être inférieur ou égal à 1000000. Valeur reçue: 2000000"
 * 
 * validatePrice('abc', 0, 1000, 'price')
 * // Lance une erreur: "Le champ 'price' doit être un nombre valide. Valeur reçue: \"abc\" (type: string)"
 */
function validatePrice(price, min = 0, max = 1000000, fieldName = null, userId = null) {
    const fieldNameStr = fieldName || 'price';
    
    // 1. Valide que le prix est un nombre positif et 4. Rejette les valeurs négatives
    let number;
    
    if (typeof price === 'number') {
        number = price;
    } else if (typeof price === 'string') {
        const trimmedInput = price.trim();
        
        // Rejeter les strings vides
        if (trimmedInput === '') {
            const errorMsg = `Le champ '${fieldNameStr}' ne peut pas être vide. Un prix valide est requis.`;
            logSanitization('error', fieldNameStr, price, null, errorMsg, userId);
            throw new Error(errorMsg);
        }
        
        // Rejeter les notations scientifiques suspectes (ex: 1e100, 1E100)
        if (/[eE]/.test(trimmedInput)) {
            const errorMsg = `Le champ '${fieldNameStr}' contient une notation scientifique non autorisée: "${trimmedInput}". Utilisez un nombre décimal standard.`;
            logSanitization('error', fieldNameStr, price, null, errorMsg, userId);
            throw new Error(errorMsg);
        }
        
        // Vérifier que la string est bien un nombre (regex pour nombres décimaux)
        const numberRegex = /^-?\d+(\.\d+)?$/;
        if (!numberRegex.test(trimmedInput)) {
            const errorMsg = `Le champ '${fieldNameStr}' doit être un nombre valide. Valeur reçue: "${price}" (type: ${typeof price})`;
            logSanitization('error', fieldNameStr, price, null, errorMsg, userId);
            throw new Error(errorMsg);
        }
        
        number = parseFloat(trimmedInput);
    } else {
        // Rejeter les types non numériques
        const errorMsg = `Le champ '${fieldNameStr}' doit être un nombre. Type reçu: ${typeof price}, valeur: ${price}`;
        logSanitization('error', fieldNameStr, price, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // Rejeter NaN, Infinity, -Infinity explicitement
    if (isNaN(number)) {
        const errorMsg = `Le champ '${fieldNameStr}' est NaN (Not a Number). Valeur reçue: "${price}"`;
        logSanitization('error', fieldNameStr, price, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    if (!isFinite(number)) {
        const errorMsg = `Le champ '${fieldNameStr}' est ${number > 0 ? 'Infinity' : '-Infinity'}. Valeur reçue: "${price}"`;
        logSanitization('error', fieldNameStr, price, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // 4. Rejette les valeurs négatives
    if (number < 0) {
        const errorMsg = `Le champ '${fieldNameStr}' doit être un nombre positif. Valeur reçue: ${number}`;
        logSanitization('error', fieldNameStr, price, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // 3. Valide la plage [min, max]
    if (number < min) {
        const errorMsg = `Le champ '${fieldNameStr}' doit être supérieur ou égal à ${min}. Valeur reçue: ${number}`;
        logSanitization('error', fieldNameStr, price, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // 5. Rejette les valeurs trop grandes (ex: > 1 000 000)
    if (number > max) {
        const errorMsg = `Le champ '${fieldNameStr}' doit être inférieur ou égal à ${max}. Valeur reçue: ${number}`;
        logSanitization('error', fieldNameStr, price, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // 2. Limite à 2 décimales maximum et 6. Arrondit à 2 décimales si nécessaire
    // Arrondir à 2 décimales
    const roundedPrice = Math.round(number * 100) / 100;
    
    // Vérifier si le nombre original avait plus de 2 décimales
    if (!Number.isInteger(number)) {
        const numberStr = String(number);
        const decimalPart = numberStr.includes('.') ? numberStr.split('.')[1] : '';
        if (decimalPart && decimalPart.length > 2) {
            logSanitization('warn', fieldNameStr, price, roundedPrice, `Prix arrondi à 2 décimales: ${number} → ${roundedPrice}`, userId);
        }
    }

    // Logger si la valeur a été modifiée (conversion de type string -> number)
    if (typeof price !== 'number' && String(price).trim() !== String(roundedPrice)) {
        logSanitization('warn', fieldNameStr, price, roundedPrice, 'Conversion de type effectuée (string -> number)', userId);
    }

    // 7. Retourne le prix validé ou lance une erreur avec fieldName
    return roundedPrice;
}

/**
 * Valide strictement un pourcentage avec validation spécifique aux pourcentages (0-100)
 * 
 * @param {any} percent - Le pourcentage à valider
 * @param {string} fieldName - Nom du champ pour le logging et les messages d'erreur (optionnel)
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @returns {number} - Pourcentage validé arrondi à 2 décimales
 * @throws {Error} - Si la validation échoue avec un message d'erreur explicite incluant fieldName
 * 
 * @example
 * validatePercentage(50, 'discount')
 * // Retourne: 50
 * 
 * validatePercentage('75.5', 'markup')
 * // Retourne: 75.5
 * 
 * validatePercentage('123.456', 'discount')
 * // Arrondit à 2 décimales et retourne: 123.46
 * 
 * validatePercentage(-10, 'discount')
 * // Lance une erreur: "Le champ 'discount' doit être un pourcentage entre 0 et 100. Valeur reçue: -10"
 * 
 * validatePercentage(150, 'discount')
 * // Lance une erreur: "Le champ 'discount' doit être un pourcentage entre 0 et 100. Valeur reçue: 150"
 * 
 * validatePercentage('abc', 'discount')
 * // Lance une erreur: "Le champ 'discount' doit être un nombre valide. Valeur reçue: \"abc\" (type: string)"
 */
function validatePercentage(percent, fieldName = null, userId = null) {
    const fieldNameStr = fieldName || 'percentage';
    
    // 5. Valide que c'est un nombre (peut être une string numérique)
    let number;
    
    if (typeof percent === 'number') {
        number = percent;
    } else if (typeof percent === 'string') {
        const trimmedInput = percent.trim();
        
        // Rejeter les strings vides
        if (trimmedInput === '') {
            const errorMsg = `Le champ '${fieldNameStr}' ne peut pas être vide. Un pourcentage valide est requis (0-100).`;
            logSanitization('error', fieldNameStr, percent, null, errorMsg, userId);
            throw new Error(errorMsg);
        }
        
        // Rejeter les notations scientifiques suspectes (ex: 1e100, 1E100)
        if (/[eE]/.test(trimmedInput)) {
            const errorMsg = `Le champ '${fieldNameStr}' contient une notation scientifique non autorisée: "${trimmedInput}". Utilisez un nombre décimal standard.`;
            logSanitization('error', fieldNameStr, percent, null, errorMsg, userId);
            throw new Error(errorMsg);
        }
        
        // Vérifier que la string est bien un nombre (regex pour nombres décimaux)
        const numberRegex = /^-?\d+(\.\d+)?$/;
        if (!numberRegex.test(trimmedInput)) {
            const errorMsg = `Le champ '${fieldNameStr}' doit être un nombre valide. Valeur reçue: "${percent}" (type: ${typeof percent})`;
            logSanitization('error', fieldNameStr, percent, null, errorMsg, userId);
            throw new Error(errorMsg);
        }
        
        number = parseFloat(trimmedInput);
    } else {
        // Rejeter les types non numériques
        const errorMsg = `Le champ '${fieldNameStr}' doit être un nombre. Type reçu: ${typeof percent}, valeur: ${percent}`;
        logSanitization('error', fieldNameStr, percent, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // Rejeter NaN, Infinity, -Infinity explicitement
    if (isNaN(number)) {
        const errorMsg = `Le champ '${fieldNameStr}' est NaN (Not a Number). Valeur reçue: "${percent}"`;
        logSanitization('error', fieldNameStr, percent, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    if (!isFinite(number)) {
        const errorMsg = `Le champ '${fieldNameStr}' est ${number > 0 ? 'Infinity' : '-Infinity'}. Valeur reçue: "${percent}"`;
        logSanitization('error', fieldNameStr, percent, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // 3. Rejette les valeurs négatives
    if (number < 0) {
        const errorMsg = `Le champ '${fieldNameStr}' doit être un pourcentage entre 0 et 100. Valeur reçue: ${number}`;
        logSanitization('error', fieldNameStr, percent, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // 1. Valide que le pourcentage est entre 0 et 100 et 4. Rejette les valeurs > 100
    if (number > 100) {
        const errorMsg = `Le champ '${fieldNameStr}' doit être un pourcentage entre 0 et 100. Valeur reçue: ${number}`;
        logSanitization('error', fieldNameStr, percent, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // 2. Limite à 2 décimales maximum - Arrondir à 2 décimales si nécessaire
    const roundedPercent = Math.round(number * 100) / 100;
    
    // Vérifier si le nombre original avait plus de 2 décimales
    if (!Number.isInteger(number)) {
        const numberStr = String(number);
        const decimalPart = numberStr.includes('.') ? numberStr.split('.')[1] : '';
        if (decimalPart && decimalPart.length > 2) {
            logSanitization('warn', fieldNameStr, percent, roundedPercent, `Pourcentage arrondi à 2 décimales: ${number} → ${roundedPercent}`, userId);
        }
    }

    // Logger si la valeur a été modifiée (conversion de type string -> number)
    if (typeof percent !== 'number' && String(percent).trim() !== String(roundedPercent)) {
        logSanitization('warn', fieldNameStr, percent, roundedPercent, 'Conversion de type effectuée (string -> number)', userId);
    }

    // 6. Retourne le pourcentage validé ou lance une erreur avec fieldName
    return roundedPercent;
}

/**
 * Valide strictement qu'une valeur numérique est dans une plage donnée
 * 
 * @param {any} value - La valeur à valider
 * @param {number} min - Valeur minimale autorisée
 * @param {number} max - Valeur maximale autorisée
 * @param {string} fieldName - Nom du champ pour les messages d'erreur (optionnel, défaut: 'value')
 * @param {boolean} allowNull - Si true, null est accepté et retourné directement (défaut: false)
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @returns {number|null} - La valeur validée (ou null si allowNull=true et value=null)
 * @throws {Error} - Si la validation échoue avec un message d'erreur clair incluant fieldName, min et max
 * 
 * @example
 * validateNumericRange(42, 0, 100, 'percentage')
 * // Retourne: 42
 * 
 * validateNumericRange(null, 0, 100, 'percentage', true)
 * // Retourne: null
 * 
 * validateNumericRange(150, 0, 100, 'percentage')
 * // Lance une erreur: "Le champ 'percentage' doit être entre 0 et 100. Valeur reçue: 150 (supérieure à 100)"
 * 
 * validateNumericRange(-5, 0, 100, 'percentage')
 * // Lance une erreur: "Le champ 'percentage' doit être entre 0 et 100. Valeur reçue: -5 (inférieure à 0)"
 * 
 * validateNumericRange(null, 0, 100, 'percentage')
 * // Lance une erreur: "Le champ 'percentage' doit être un nombre. Type reçu: object (null)"
 * 
 * validateNumericRange('abc', 0, 100, 'percentage')
 * // Lance une erreur: "Le champ 'percentage' doit être un nombre. Type reçu: string"
 */
function validateNumericRange(value, min, max, fieldName = null, allowNull = false, userId = null) {
    const fieldNameStr = fieldName || 'value';
    
    // 1. Valide que value est un nombre (ou null si allowNull)
    if (value === null || value === undefined) {
        if (allowNull) {
            return null; // null accepté et retourné directement
        }
        
        const errorMsg = `Le champ '${fieldNameStr}' doit être un nombre. Type reçu: ${value === null ? 'object (null)' : 'undefined'}`;
        logSanitization('error', fieldNameStr, value, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    if (typeof value !== 'number') {
        const errorMsg = `Le champ '${fieldNameStr}' doit être un nombre. Type reçu: ${typeof value}`;
        logSanitization('error', fieldNameStr, value, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // Rejeter NaN, Infinity, -Infinity explicitement
    if (isNaN(value)) {
        const errorMsg = `Le champ '${fieldNameStr}' est NaN (Not a Number). Valeur reçue: ${value}`;
        logSanitization('error', fieldNameStr, value, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    if (!isFinite(value)) {
        const errorMsg = `Le champ '${fieldNameStr}' est ${value > 0 ? 'Infinity' : '-Infinity'}. Valeur reçue: ${value}`;
        logSanitization('error', fieldNameStr, value, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // 2. Valide que value >= min et value <= max
    // 3. Rejette explicitement les valeurs hors plage (pas de valeur par défaut)
    // 4. Retourne un message d'erreur avec min et max si invalide
    if (value < min) {
        const errorMsg = `Le champ '${fieldNameStr}' doit être entre ${min} et ${max}. Valeur reçue: ${value} (inférieure à ${min})`;
        logSanitization('error', fieldNameStr, value, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    if (value > max) {
        const errorMsg = `Le champ '${fieldNameStr}' doit être entre ${min} et ${max}. Valeur reçue: ${value} (supérieure à ${max})`;
        logSanitization('error', fieldNameStr, value, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // 5. Retourne la valeur validée ou lance une erreur avec fieldName
    return value;
}

/**
 * Valide strictement une capacité (nombre de personnes)
 * 
 * @param {any} capacity - La capacité à valider
 * @param {string} fieldName - Nom du champ pour les messages d'erreur (optionnel, défaut: 'capacity')
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @param {Object} options - Options de validation (optionnel)
 * @param {number} options.max - Capacité maximale autorisée (défaut: 50)
 * @param {number} options.absoluteMax - Limite absolue maximum (défaut: 100)
 * @returns {number} - La capacité validée (entier positif)
 * @throws {Error} - Si la validation échoue avec un message d'erreur clair incluant fieldName
 * 
 * @example
 * validateCapacity(5, 'capacity')
 * // Retourne: 5
 * 
 * validateCapacity(25, 'capacity', null, { max: 30 })
 * // Retourne: 25
 * 
 * validateCapacity(0, 'capacity')
 * // Lance une erreur: "Le champ 'capacity' doit être un nombre entier strictement positif. Valeur reçue: 0"
 * 
 * validateCapacity(-5, 'capacity')
 * // Lance une erreur: "Le champ 'capacity' doit être un nombre entier strictement positif. Valeur reçue: -5"
 * 
 * validateCapacity(55, 'capacity')
 * // Lance une erreur: "Le champ 'capacity' doit être entre 1 et 50. Valeur reçue: 55 (supérieure à 50)"
 * 
 * validateCapacity(150, 'capacity')
 * // Lance une erreur: "Le champ 'capacity' est trop grande (limite absolue: 100). Valeur reçue: 150"
 * 
 * validateCapacity(5.5, 'capacity')
 * // Lance une erreur: "Le champ 'capacity' doit être un nombre entier (sans décimales). Valeur reçue: 5.5"
 * 
 * validateCapacity(null, 'capacity')
 * // Lance une erreur: "Le champ 'capacity' doit être un nombre entier. Type reçu: object (null)"
 */
function validateCapacity(capacity, fieldName = null, userId = null, options = {}) {
    const fieldNameStr = fieldName || 'capacity';
    const { max = 50, absoluteMax = 100 } = options;
    
    // 1. Valide que capacity est un entier positif
    // 3. Rejette les valeurs nulles, négatives, ou décimales
    // Utilise validateInteger pour valider que c'est un entier strictement positif
    try {
        const validatedInteger = validateInteger(capacity, 1, Infinity, fieldNameStr, userId);
        
        // 4. Rejette les valeurs trop grandes (ex: > 100) - limite absolue
        if (validatedInteger > absoluteMax) {
            const errorMsg = `Le champ '${fieldNameStr}' est trop grande (limite absolue: ${absoluteMax}). Valeur reçue: ${validatedInteger}`;
            logSanitization('error', fieldNameStr, capacity, null, errorMsg, userId);
            throw new Error(errorMsg);
        }
        
        // 2. Valide que capacity est entre 1 et 50 (ou limite configurable)
        if (validatedInteger > max) {
            const errorMsg = `Le champ '${fieldNameStr}' doit être entre 1 et ${max}. Valeur reçue: ${validatedInteger} (supérieure à ${max})`;
            logSanitization('error', fieldNameStr, capacity, null, errorMsg, userId);
            throw new Error(errorMsg);
        }
        
        // 5. Retourne la capacité validée ou lance une erreur avec fieldName
        return validatedInteger;
    } catch (error) {
        // validateInteger lance déjà une erreur avec le bon message, on la propage
        throw error;
    }
}

/**
 * Sanitise un nombre avec validation de plage améliorée
 * Rejette explicitement les valeurs invalides et lance des erreurs au lieu de retourner des valeurs par défaut
 * 
 * @param {any} input - L'input à convertir en nombre
 * @param {number} min - Valeur minimale autorisée (défaut: -Infinity)
 * @param {number} max - Valeur maximale autorisée (défaut: Infinity)
 * @param {string} fieldName - Nom du champ pour le logging (optionnel)
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @param {Object} options - Options de validation strictes (optionnel)
 * @param {boolean} options.mustBeInteger - Si true, rejette les décimales (pas de décimales autorisées)
 * @param {boolean} options.mustBePositive - Si true, rejette les valeurs négatives ou zéro (strictement positif requis)
 * @param {number} options.maxDecimals - Nombre maximum de décimales autorisées (défaut: Infinity, recommandé: 2 pour les prix)
 * @returns {number} - Nombre validé et sanitizé
 * @throws {Error} - Si la validation échoue avec un message d'erreur explicite
 * 
 * @example
 * sanitizeNumber('42', 1, 50, 'capacity', null, { mustBeInteger: true })
 * // Retourne: 42
 * 
 * sanitizeNumber('abc', 1, 50, 'capacity')
 * // Lance une erreur: "Le champ 'capacity' doit être un nombre valide. Valeur reçue: \"abc\" (type: string)"
 * 
 * sanitizeNumber('42.5', 1, 50, 'capacity', null, { mustBeInteger: true })
 * // Lance une erreur: "Le champ 'capacity' doit être un nombre entier (sans décimales). Valeur reçue: 42.5"
 * 
 * sanitizeNumber('0', 1, 50, 'capacity', null, { mustBePositive: true })
 * // Lance une erreur: "Le champ 'capacity' doit être un nombre strictement positif. Valeur reçue: 0"
 * 
 * sanitizeNumber('123.456', 0, 1000, 'price', null, { maxDecimals: 2 })
 * // Lance une erreur: "Le champ 'price' ne peut pas avoir plus de 2 décimales. Valeur reçue: 123.456 (3 décimales)"
 */
function sanitizeNumber(input, min = -Infinity, max = Infinity, fieldName = null, userId = null, options = {}) {
    const {
        mustBeInteger = false,
        mustBePositive = false,
        maxDecimals = Infinity
    } = options;
    
    const fieldNameStr = fieldName || 'number';
    
    // 1. Rejeter explicitement les strings non-numériques (au lieu de retourner defaultValue)
    let number;
    
    if (typeof input === 'number') {
        number = input;
    } else if (typeof input === 'string') {
        const trimmedInput = input.trim();
        
        // Rejeter les strings vides
        if (trimmedInput === '') {
            const errorMsg = `Le champ '${fieldNameStr}' ne peut pas être vide. Une valeur numérique est requise.`;
            logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
            throw new Error(errorMsg);
        }
        
        // 5. Rejeter les nombres en notation scientifique suspecte (ex: 1e100, 1E100)
        if (/[eE]/.test(trimmedInput)) {
            const errorMsg = `Le champ '${fieldNameStr}' contient une notation scientifique non autorisée: "${trimmedInput}". Utilisez un nombre décimal standard.`;
            logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
            throw new Error(errorMsg);
        }
        
        // Vérifier que la string est bien un nombre (regex pour nombres décimaux)
        // Format: nombre entier optionnel avec décimales optionnelles (ex: -123.456)
        const numberRegex = /^-?\d+(\.\d+)?$/;
        if (!numberRegex.test(trimmedInput)) {
            const errorMsg = `Le champ '${fieldNameStr}' doit être un nombre valide. Valeur reçue: "${input}" (type: ${typeof input})`;
            logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
            throw new Error(errorMsg);
        }
        
        number = parseFloat(trimmedInput);
    } else {
        // Rejeter les types non numériques (null, undefined, object, array, etc.)
        const errorMsg = `Le champ '${fieldNameStr}' doit être un nombre. Type reçu: ${typeof input}, valeur: ${input}`;
        logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // 2. Rejeter NaN, Infinity, -Infinity explicitement
    if (isNaN(number)) {
        const errorMsg = `Le champ '${fieldNameStr}' est NaN (Not a Number). Valeur reçue: "${input}"`;
        logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    if (!isFinite(number)) {
        const errorMsg = `Le champ '${fieldNameStr}' est ${number > 0 ? 'Infinity' : '-Infinity'}. Valeur reçue: "${input}"`;
        logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // 3. Valider que le nombre est un entier si nécessaire (pas de décimales)
    if (mustBeInteger && !Number.isInteger(number)) {
        const errorMsg = `Le champ '${fieldNameStr}' doit être un nombre entier (sans décimales). Valeur reçue: ${number}`;
        logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // 4. Valider que le nombre est positif si nécessaire
    if (mustBePositive && number <= 0) {
        const errorMsg = `Le champ '${fieldNameStr}' doit être un nombre strictement positif. Valeur reçue: ${number}`;
        logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // 5. Valider la précision des décimales (max 2 décimales pour les prix)
    if (maxDecimals < Infinity && !Number.isInteger(number)) {
        // Extraire la partie décimale de manière fiable
        const numberStr = String(number);
        const decimalPart = numberStr.includes('.') ? numberStr.split('.')[1] : '';
        if (decimalPart && decimalPart.length > maxDecimals) {
            const errorMsg = `Le champ '${fieldNameStr}' ne peut pas avoir plus de ${maxDecimals} décimales. Valeur reçue: ${number} (${decimalPart.length} décimales)`;
            logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
            throw new Error(errorMsg);
        }
    }

    // 6. Valider les nombres contre des valeurs spécifiques (ex: capacité entre 1 et 50)
    if (number < min) {
        const errorMsg = `Le champ '${fieldNameStr}' doit être supérieur ou égal à ${min}. Valeur reçue: ${number}`;
        logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    if (number > max) {
        const errorMsg = `Le champ '${fieldNameStr}' doit être inférieur ou égal à ${max}. Valeur reçue: ${number}`;
        logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
        throw new Error(errorMsg);
    }

    // Logger si la valeur a été modifiée (conversion de type string -> number)
    if (typeof input !== 'number' && String(input).trim() !== String(number)) {
        logSanitization('warn', fieldNameStr, input, number, 'Conversion de type effectuée (string -> number)', userId);
    }

    // 7. Retourner le nombre validé (toujours avec des erreurs explicites, jamais de valeur par défaut silencieuse)
    return number;
}

/**
 * Sanitise un tableau avec limitation de taille et sanitisation des éléments
 * 
 * @param {any} input - L'input à convertir en tableau
 * @param {number} maxLength - Nombre maximum d'éléments autorisés
 * @param {Function} itemSanitizer - Fonction pour sanitiser chaque élément (optionnel)
 * @param {string} fieldName - Nom du champ pour le logging (optionnel)
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @returns {Array} - Tableau sanitizé
 * 
 * @example
 * sanitizeArray(['item1', 'item2'], 10, sanitizeForPrompt)
 * // Retourne: ['item1', 'item2']
 */
function sanitizeArray(input, maxLength = 50, itemSanitizer = null, fieldName = null, userId = null) {
    // 1. Vérifier que l'input est un tableau
    if (!Array.isArray(input)) {
        if (input === null || input === undefined) {
            return [];
        }
        logSanitization('warn', fieldName || 'array', input, [], 'Input n\'est pas un tableau, retour d\'un tableau vide', userId);
        return [];
    }

    // 2. Limiter le nombre d'éléments à maxLength
    let sanitized = input.slice(0, maxLength);
    if (input.length > maxLength) {
        logSanitization('warn', fieldName || 'array', input.length, maxLength, `Tableau tronqué de ${input.length} à ${maxLength} éléments`, userId);
    }

    // 3. Appliquer itemSanitizer à chaque élément si fourni
    if (itemSanitizer && typeof itemSanitizer === 'function') {
        sanitized = sanitized.map(item => {
            try {
                return itemSanitizer(item);
            } catch (e) {
                console.warn('[Prompt Sanitizer] Erreur lors de la sanitisation d\'un élément:', e);
                return null;
            }
        });
    }

    // 4. Filtrer les valeurs null/undefined
    sanitized = sanitized.filter(item => item !== null && item !== undefined);

    // 5. Retourner un tableau sécurisé
    return sanitized;
}

/**
 * Valide que la longueur d'une chaîne est dans une plage [minLength, maxLength]
 * Compatible avec l'ancienne signature: validateStringLength(input, maxLength, fieldName, userId)
 * 
 * @param {any} input - L'input à valider (doit être une string)
 * @param {number|string} minLengthOrMaxLength - Longueur minimale (nouvelle signature) ou maximale (ancienne signature) ou maxLength si deuxième paramètre est string
 * @param {number|string} maxLengthOrFieldName - Longueur maximale (nouvelle signature) ou nom du champ (ancienne signature)
 * @param {string} fieldNameOrUserId - Nom du champ (nouvelle signature) ou userId (ancienne signature)
 * @param {string|Object} userIdOrOptions - ID utilisateur (nouvelle signature) ou options (nouvelle signature avec userId)
 * @param {Object} options - Options de validation (optionnel, nouvelle signature uniquement)
 * @param {boolean} options.trim - Si true, trim les espaces en début/fin avant validation (défaut: false)
 * @returns {string} - La chaîne validée (trimée si trim=true)
 * @throws {Error} - Si la validation échoue avec un message d'erreur incluant minLength et maxLength
 * 
 * @example
 * // Nouvelle signature (recommandée)
 * validateStringLength('test', 0, 10, 'name')
 * // Retourne: 'test'
 * 
 * validateStringLength('', 1, 10, 'name')
 * // Lance une erreur: "Le champ 'name' ne peut pas être vide. Longueur minimale: 1 caractère, longueur reçue: 0"
 * 
 * validateStringLength('  test  ', 0, 10, 'name', null, { trim: true })
 * // Retourne: 'test' (trimé)
 * 
 * // Ancienne signature (compatible)
 * validateStringLength('test', 10, 'name')
 * // Retourne: 'test' (minLength=0 par défaut)
 * 
 * validateStringLength('a'.repeat(100), 0, 10, 'name')
 * // Lance une erreur: "Le champ 'name' dépasse la longueur maximale de 10 caractères (100 caractères reçus, minimum: 0)"
 * 
 * validateStringLength(123, 0, 10, 'name')
 * // Lance une erreur: "Le champ 'name' doit être une chaîne de caractères. Type reçu: number, valeur: 123"
 */
function validateStringLength(input, minLengthOrMaxLength, maxLengthOrFieldName, fieldNameOrUserId, userIdOrOptions, options) {
    // Détecter la signature utilisée (ancienne ou nouvelle)
    // Ancienne: validateStringLength(input, maxLength, fieldName, userId)
    // Nouvelle: validateStringLength(input, minLength, maxLength, fieldName, userId, options)
    
    let minLength, maxLength, fieldName, userId, opts;
    
    if (typeof maxLengthOrFieldName === 'string') {
        // Ancienne signature: validateStringLength(input, maxLength, fieldName, userId)
        minLength = 0;
        maxLength = minLengthOrMaxLength;
        fieldName = maxLengthOrFieldName;
        userId = fieldNameOrUserId || null;
        opts = {};
    } else {
        // Nouvelle signature: validateStringLength(input, minLength, maxLength, fieldName, userId, options)
        minLength = minLengthOrMaxLength || 0;
        maxLength = maxLengthOrFieldName;
        fieldName = fieldNameOrUserId;
        if (typeof userIdOrOptions === 'string') {
            userId = userIdOrOptions;
            opts = options || {};
        } else if (userIdOrOptions && typeof userIdOrOptions === 'object') {
            userId = null;
            opts = userIdOrOptions;
        } else {
            userId = null;
            opts = {};
        }
    }
    
    const { trim = false } = opts;
    const fieldNameStr = fieldName || 'string';
    
    // 3. Valider que l'input est bien une string (pas un nombre, objet, etc.)
    if (typeof input !== 'string') {
        const errorMsg = `Le champ '${fieldNameStr}' doit être une chaîne de caractères. Type reçu: ${typeof input}, valeur: ${input}`;
        logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // 4. Trim les espaces en début/fin avant validation si nécessaire
    let trimmedInput = input;
    if (trim) {
        trimmedInput = input.trim();
        if (input !== trimmedInput) {
            logSanitization('warn', fieldNameStr, input, trimmedInput, 'Espaces en début/fin supprimés (trim)', userId);
        }
    }
    
    // 5. Compter les caractères Unicode correctement (pas de bytes)
    // JavaScript .length compte déjà les caractères Unicode correctement (pas les bytes)
    // Les caractères Unicode complexes (emojis, caractères combinés) comptent pour 1 caractère chacun
    const length = trimmedInput.length;
    
    // 2. Rejeter les strings vides si minLength > 0
    if (minLength > 0 && length === 0) {
        const errorMsg = `Le champ '${fieldNameStr}' ne peut pas être vide. Longueur minimale: ${minLength} caractère${minLength > 1 ? 's' : ''}, longueur reçue: 0`;
        logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // 1. Valider aussi une longueur minimale (minLength)
    if (length < minLength) {
        const errorMsg = `Le champ '${fieldNameStr}' est trop court. Longueur minimale: ${minLength} caractère${minLength > 1 ? 's' : ''}, longueur reçue: ${length}, maximum: ${maxLength}`;
        logSanitization('error', fieldNameStr, input.length, minLength, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // Valider la longueur maximale
    if (length > maxLength) {
        const errorMsg = `Le champ '${fieldNameStr}' dépasse la longueur maximale de ${maxLength} caractères (${length} caractères reçus, minimum: ${minLength})`;
        logSanitization('error', fieldNameStr, input.length, maxLength, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // 6. Retourner des messages d'erreur avec minLength et maxLength
    // (déjà fait dans les messages d'erreur ci-dessus)
    
    return trimmedInput;
}

/**
 * Patterns prédéfinis pour les formats communs
 */
const PREDEFINED_PATTERNS = {
    email: {
        regex: /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/,
        description: 'email valide (ex: user@example.com)'
    },
    phone: {
        regex: /^[+]?[(]?[0-9]{1,4}[)]?[-\s.]?[(]?[0-9]{1,4}[)]?[-\s.]?[0-9]{1,9}[-\s.]?[0-9]{1,9}$/,
        description: 'numéro de téléphone (ex: +33 1 23 45 67 89 ou 0123456789)'
    },
    postal_code: {
        regex: /^[0-9A-Za-z\s-]{3,10}$/,
        description: 'code postal (3 à 10 caractères alphanumériques)'
    },
    timezone: {
        regex: /^[A-Za-z_]+\/[A-Za-z_]+$/,
        description: 'timezone IANA (ex: Europe/Paris, America/New_York)'
    }
};

/**
 * Valide strictement qu'une chaîne correspond à un pattern regex strict
 * 
 * @param {any} input - L'input à valider (doit être une string)
 * @param {string|RegExp} pattern - Pattern regex ou nom d'un pattern prédéfini ('email', 'phone', 'postal_code', 'timezone')
 * @param {string} fieldName - Nom du champ pour les messages d'erreur (optionnel)
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @returns {string} - La string validée
 * @throws {Error} - Si la validation échoue avec un message d'erreur clair incluant fieldName
 * 
 * @example
 * validateStringFormat('user@example.com', 'email', 'email')
 * // Retourne: 'user@example.com'
 * 
 * validateStringFormat('invalid-email', 'email', 'email')
 * // Lance une erreur: "Le champ 'email' doit être un email valide (ex: user@example.com). Valeur reçue: \"invalid-email\""
 * 
 * validateStringFormat('+33 1 23 45 67 89', 'phone', 'phone')
 * // Retourne: '+33 1 23 45 67 89'
 * 
 * validateStringFormat('75001', 'postal_code', 'postalCode')
 * // Retourne: '75001'
 * 
 * validateStringFormat('Europe/Paris', 'timezone', 'timezone')
 * // Retourne: 'Europe/Paris'
 * 
 * validateStringFormat('test', /^[a-z]+$/, 'name')
 * // Retourne: 'test'
 * 
 * validateStringFormat(123, 'email', 'email')
 * // Lance une erreur: "Le champ 'email' doit être une chaîne de caractères. Type reçu: number"
 */
function validateStringFormat(input, pattern, fieldName = null, userId = null) {
    const fieldNameStr = fieldName || 'string';
    
    // 2. Valide que l'input est une string
    if (typeof input !== 'string') {
        const errorMsg = `Le champ '${fieldNameStr}' doit être une chaîne de caractères. Type reçu: ${typeof input}`;
        logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // Rejeter les strings vides
    const trimmedInput = input.trim();
    if (trimmedInput === '') {
        const errorMsg = `Le champ '${fieldNameStr}' ne peut pas être vide. Un format valide est requis.`;
        logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    let regex;
    let patternDescription;
    
    // 4. Supporte des patterns prédéfinis : 'email', 'phone', 'postal_code', 'timezone'
    if (typeof pattern === 'string') {
        const predefinedPattern = PREDEFINED_PATTERNS[pattern];
        if (predefinedPattern) {
            regex = predefinedPattern.regex;
            patternDescription = predefinedPattern.description;
        } else {
            // Si ce n'est pas un pattern prédéfini, essayer de créer un RegExp depuis la string
            try {
                regex = new RegExp(pattern);
                patternDescription = `format correspondant au pattern: ${pattern}`;
            } catch (regexError) {
                const errorMsg = `Le champ '${fieldNameStr}' : pattern regex invalide "${pattern}". Patterns prédéfinis disponibles: ${Object.keys(PREDEFINED_PATTERNS).join(', ')}`;
                logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
                throw new Error(errorMsg);
            }
        }
    } else if (pattern instanceof RegExp) {
        // 1. Valide que l'input correspond à un pattern regex strict
        regex = pattern;
        patternDescription = 'format correspondant au pattern regex fourni';
    } else {
        const errorMsg = `Le champ '${fieldNameStr}' : pattern doit être une string (nom de pattern prédéfini) ou un RegExp. Type reçu: ${typeof pattern}`;
        logSanitization('error', fieldNameStr, input, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // 1. Valide que l'input correspond à un pattern regex strict
    // Utiliser test() pour vérifier que la string correspond au pattern
    // Note: Le pattern doit matcher toute la string (utiliser ^ et $ si nécessaire)
    const matches = regex.test(trimmedInput);
    
    if (!matches) {
        // 3. Retourne un message d'erreur clair si le format ne correspond pas
        // 5. Inclut le fieldName dans les messages d'erreur
        const errorMsg = `Le champ '${fieldNameStr}' doit être un ${patternDescription}. Valeur reçue: "${trimmedInput}"`;
        logSanitization('error', fieldNameStr, trimmedInput, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // Logger si la valeur a été modifiée (trim)
    if (input !== trimmedInput) {
        logSanitization('warn', fieldNameStr, input, trimmedInput, 'Espaces en début/fin supprimés (trim)', userId);
    }
    
    // 6. Retourne la string validée ou lance une erreur
    return trimmedInput;
}

/**
 * Valide strictement un email avec validation RFC 5322 simplifiée
 * 
 * @param {any} email - L'email à valider
 * @param {string} fieldName - Nom du champ pour les messages d'erreur (optionnel)
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @returns {string} - L'email validé et normalisé (lowercase, trimé)
 * @throws {Error} - Si la validation échoue avec un message d'erreur clair incluant fieldName
 * 
 * @example
 * validateEmail('user@example.com', 'email')
 * // Retourne: 'user@example.com'
 * 
 * validateEmail('  USER@EXAMPLE.COM  ', 'email')
 * // Retourne: 'user@example.com' (normalisé: lowercase, trim)
 * 
 * validateEmail('invalid-email', 'email')
 * // Lance une erreur: "Le champ 'email' doit être un email valide. Format invalide: \"invalid-email\""
 * 
 * validateEmail('a'.repeat(250) + '@example.com', 'email')
 * // Lance une erreur: "Le champ 'email' est trop long. Longueur maximale: 254 caractères, longueur reçue: ..."
 * 
 * validateEmail('user@domain', 'email')
 * // Lance une erreur: "Le champ 'email' doit être un email valide. Le domaine doit contenir au moins un point (TLD requis)"
 * 
 * validateEmail('user<script>@example.com', 'email')
 * // Lance une erreur: "Le champ 'email' contient des caractères dangereux. Caractères non autorisés détectés"
 */
function validateEmail(email, fieldName = null, userId = null) {
    const fieldNameStr = fieldName || 'email';
    const MAX_EMAIL_LENGTH = 254; // RFC 5321
    
    // Valider que l'input est une string
    if (typeof email !== 'string') {
        const errorMsg = `Le champ '${fieldNameStr}' doit être une chaîne de caractères. Type reçu: ${typeof email}`;
        logSanitization('error', fieldNameStr, email, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // 5. Normalise l'email (lowercase, trim)
    let normalizedEmail = email.trim().toLowerCase();
    
    // Rejeter les strings vides après trim
    if (normalizedEmail === '') {
        const errorMsg = `Le champ '${fieldNameStr}' ne peut pas être vide. Un email valide est requis.`;
        logSanitization('error', fieldNameStr, email, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // Logger si la valeur a été modifiée (normalisation)
    if (email !== normalizedEmail) {
        logSanitization('warn', fieldNameStr, email, normalizedEmail, 'Email normalisé (lowercase, trim)', userId);
    }
    
    // 2. Vérifie que l'email n'est pas trop long (max 254 caractères)
    if (normalizedEmail.length > MAX_EMAIL_LENGTH) {
        const errorMsg = `Le champ '${fieldNameStr}' est trop long. Longueur maximale: ${MAX_EMAIL_LENGTH} caractères, longueur reçue: ${normalizedEmail.length}`;
        logSanitization('error', fieldNameStr, email, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // 4. Rejette les emails avec caractères dangereux
    // Caractères dangereux : < > " ' ` ( ) [ ] { } ; : \ / | ? * = + & % $ # ! ~ ^
    const dangerousChars = /[<>"'`()[\]{};:\\|?*=+&%$#!~^]/;
    if (dangerousChars.test(normalizedEmail)) {
        const errorMsg = `Le champ '${fieldNameStr}' contient des caractères dangereux. Caractères non autorisés détectés dans l'email.`;
        logSanitization('error', fieldNameStr, email, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // 1. Valide le format d'email avec regex strict (RFC 5322 simplifié)
    // Format RFC 5322 simplifié : local-part@domain
    // Local-part : caractères alphanumériques, points, tirets, underscores, plus
    // Domain : caractères alphanumériques, tirets, points
    const emailRegex = /^[a-zA-Z0-9][a-zA-Z0-9._+-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$/;
    
    if (!emailRegex.test(normalizedEmail)) {
        const errorMsg = `Le champ '${fieldNameStr}' doit être un email valide. Format invalide: "${normalizedEmail}"`;
        logSanitization('error', fieldNameStr, email, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // 3. Vérifie que le domaine a au moins un point (TLD requis)
    const domainPart = normalizedEmail.split('@')[1];
    if (!domainPart || !domainPart.includes('.')) {
        const errorMsg = `Le champ '${fieldNameStr}' doit être un email valide. Le domaine doit contenir au moins un point (TLD requis). Format reçu: "${normalizedEmail}"`;
        logSanitization('error', fieldNameStr, email, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // Vérifier que le TLD fait au moins 2 caractères
    const tld = domainPart.split('.').pop();
    if (!tld || tld.length < 2) {
        const errorMsg = `Le champ '${fieldNameStr}' doit être un email valide. Le TLD (Top-Level Domain) doit faire au moins 2 caractères. Format reçu: "${normalizedEmail}"`;
        logSanitization('error', fieldNameStr, email, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // Vérifier qu'il n'y a pas de points consécutifs dans le local-part ou le domaine
    if (normalizedEmail.includes('..')) {
        const errorMsg = `Le champ '${fieldNameStr}' doit être un email valide. Les points consécutifs ne sont pas autorisés. Format reçu: "${normalizedEmail}"`;
        logSanitization('error', fieldNameStr, email, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // Vérifier que le local-part ne commence ni ne se termine par un point
    const localPart = normalizedEmail.split('@')[0];
    if (localPart.startsWith('.') || localPart.endsWith('.')) {
        const errorMsg = `Le champ '${fieldNameStr}' doit être un email valide. La partie locale ne peut pas commencer ou se terminer par un point. Format reçu: "${normalizedEmail}"`;
        logSanitization('error', fieldNameStr, email, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // Vérifier que le domaine ne commence ni ne se termine par un point ou un tiret
    if (domainPart.startsWith('.') || domainPart.endsWith('.') || domainPart.startsWith('-') || domainPart.endsWith('-')) {
        const errorMsg = `Le champ '${fieldNameStr}' doit être un email valide. Le domaine ne peut pas commencer ou se terminer par un point ou un tiret. Format reçu: "${normalizedEmail}"`;
        logSanitization('error', fieldNameStr, email, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // 6. Retourne l'email validé ou lance une erreur avec fieldName
    return normalizedEmail;
}

/**
 * Patterns de validation pour les codes postaux par pays
 */
const POSTAL_CODE_PATTERNS = {
    FR: {
        regex: /^[0-9]{5}$/,
        description: '5 chiffres (ex: 75001)',
        normalize: (code) => code.trim().replace(/\s+/g, '')
    },
    US: {
        regex: /^[0-9]{5}(-[0-9]{4})?$/,
        description: '5 chiffres ou 5+4 chiffres avec tiret (ex: 12345 ou 12345-6789)',
        normalize: (code) => code.trim().replace(/\s+/g, '').replace(/^([0-9]{5})-?([0-9]{4})?$/, (match, p1, p2) => p2 ? `${p1}-${p2}` : p1)
    },
    UK: {
        regex: /^[A-Za-z]{1,2}[0-9][A-Za-z0-9]?\s?[0-9][A-Za-z]{2}$/i,
        description: 'format UK (ex: SW1A 1AA, M1 1AA)',
        normalize: (code) => code.trim().toUpperCase().replace(/\s+/g, ' ').replace(/^([A-Z]{1,2}[0-9][A-Z0-9]?)\s?([0-9][A-Z]{2})$/i, '$1 $2')
    },
    DE: {
        regex: /^[0-9]{5}$/,
        description: '5 chiffres (ex: 10115)',
        normalize: (code) => code.trim().replace(/\s+/g, '')
    },
    ES: {
        regex: /^[0-9]{5}$/,
        description: '5 chiffres (ex: 28001)',
        normalize: (code) => code.trim().replace(/\s+/g, '')
    },
    IT: {
        regex: /^[0-9]{5}$/,
        description: '5 chiffres (ex: 00118)',
        normalize: (code) => code.trim().replace(/\s+/g, '')
    }
};

/**
 * Valide strictement un code postal selon le format du pays
 * 
 * @param {any} postalCode - Le code postal à valider
 * @param {string} country - Code pays (FR, US, UK, DE, ES, IT)
 * @param {string} fieldName - Nom du champ pour les messages d'erreur (optionnel)
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @returns {string} - Le code postal validé et normalisé
 * @throws {Error} - Si la validation échoue avec un message d'erreur clair incluant fieldName
 * 
 * @example
 * validatePostalCode('75001', 'FR', 'postalCode')
 * // Retourne: '75001'
 * 
 * validatePostalCode('12345-6789', 'US', 'postalCode')
 * // Retourne: '12345-6789'
 * 
 * validatePostalCode('SW1A 1AA', 'UK', 'postalCode')
 * // Retourne: 'SW1A 1AA' (normalisé)
 * 
 * validatePostalCode('invalid', 'FR', 'postalCode')
 * // Lance une erreur: "Le champ 'postalCode' doit être un code postal français valide (5 chiffres, ex: 75001). Format reçu: \"invalid\""
 * 
 * validatePostalCode('1234', 'FR', 'postalCode')
 * // Lance une erreur: "Le champ 'postalCode' doit être un code postal français valide (5 chiffres, ex: 75001). Format reçu: \"1234\""
 * 
 * validatePostalCode('75001', 'XX', 'postalCode')
 * // Lance une erreur: "Le champ 'postalCode' : pays non supporté 'XX'. Pays supportés: FR, US, UK, DE, ES, IT"
 */
function validatePostalCode(postalCode, country, fieldName = null, userId = null) {
    const fieldNameStr = fieldName || 'postalCode';
    
    // Valider que l'input est une string
    if (typeof postalCode !== 'string') {
        const errorMsg = `Le champ '${fieldNameStr}' doit être une chaîne de caractères. Type reçu: ${typeof postalCode}`;
        logSanitization('error', fieldNameStr, postalCode, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // Valider que le pays est une string
    if (typeof country !== 'string') {
        const errorMsg = `Le champ '${fieldNameStr}' : le pays doit être une chaîne de caractères. Type reçu: ${typeof country}`;
        logSanitization('error', fieldNameStr, postalCode, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // Normaliser le code pays en majuscules
    const normalizedCountry = country.trim().toUpperCase();
    
    // 2. Supporte les pays : FR, US, UK, DE, ES, IT
    const pattern = POSTAL_CODE_PATTERNS[normalizedCountry];
    if (!pattern) {
        const supportedCountries = Object.keys(POSTAL_CODE_PATTERNS).join(', ');
        const errorMsg = `Le champ '${fieldNameStr}' : pays non supporté '${country}'. Pays supportés: ${supportedCountries}`;
        logSanitization('error', fieldNameStr, postalCode, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // Rejeter les strings vides
    const trimmedCode = postalCode.trim();
    if (trimmedCode === '') {
        const errorMsg = `Le champ '${fieldNameStr}' ne peut pas être vide. Un code postal valide est requis pour le pays ${normalizedCountry}.`;
        logSanitization('error', fieldNameStr, postalCode, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // 5. Retourne le code postal normalisé ou lance une erreur avec fieldName
    // Normaliser le code postal selon le pays
    let normalizedCode = pattern.normalize(trimmedCode);
    
    // Logger si la valeur a été modifiée (normalisation)
    if (trimmedCode !== normalizedCode) {
        logSanitization('warn', fieldNameStr, trimmedCode, normalizedCode, `Code postal normalisé pour ${normalizedCountry}`, userId);
    }
    
    // 1. Valide le format selon le pays (FR: 5 chiffres, US: 5 ou 5+4, etc.)
    // 3. Valide que ce sont uniquement des chiffres/lettres selon le format
    // 4. Rejette les formats invalides
    if (!pattern.regex.test(normalizedCode)) {
        const countryNames = {
            FR: 'français',
            US: 'américain',
            UK: 'britannique',
            DE: 'allemand',
            ES: 'espagnol',
            IT: 'italien'
        };
        const countryName = countryNames[normalizedCountry] || normalizedCountry;
        const errorMsg = `Le champ '${fieldNameStr}' doit être un code postal ${countryName} valide (${pattern.description}). Format reçu: "${trimmedCode}"`;
        logSanitization('error', fieldNameStr, postalCode, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    return normalizedCode;
}

/**
 * Valide strictement un objet selon un schéma défini
 * 
 * @param {any} obj - L'objet à valider
 * @param {Object} schema - Le schéma de validation
 * @param {string} fieldName - Nom du champ pour la traçabilité (optionnel)
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @returns {Object} - { valid: boolean, errors: [] } avec liste d'erreurs détaillées
 * 
 * @example
 * const schema = {
 *   name: { type: 'string', required: true, minLength: 1, maxLength: 100 },
 *   age: { type: 'number', required: false, min: 0, max: 150 },
 *   email: { type: 'string', required: true, pattern: 'email' },
 *   status: { type: 'string', required: true, enum: ['active', 'inactive'] }
 * };
 * 
 * validateObjectSchema({ name: 'John', age: 30, email: 'john@example.com', status: 'active' }, schema, 'user')
 * // Retourne: { valid: true, errors: [] }
 * 
 * validateObjectSchema({ age: 30 }, schema, 'user')
 * // Retourne: { valid: false, errors: ["Le champ 'user.name' est requis mais absent", "Le champ 'user.email' est requis mais absent", ...] }
 */
function validateObjectSchema(obj, schema, fieldName = null, userId = null) {
    const fieldNameStr = fieldName || 'object';
    const errors = [];
    
    // 1. Valide qu'un objet correspond à un schéma défini
    // Vérifier que obj est un objet (pas null, array, etc.)
    if (obj === null || obj === undefined) {
        const errorMsg = `Le champ '${fieldNameStr}' doit être un objet. Type reçu: ${obj === null ? 'null' : 'undefined'}`;
        logSanitization('error', fieldNameStr, obj, null, errorMsg, userId);
        return {
            valid: false,
            errors: [errorMsg]
        };
    }
    
    if (typeof obj !== 'object' || Array.isArray(obj)) {
        const errorMsg = `Le champ '${fieldNameStr}' doit être un objet. Type reçu: ${Array.isArray(obj) ? 'array' : typeof obj}`;
        logSanitization('error', fieldNameStr, obj, null, errorMsg, userId);
        return {
            valid: false,
            errors: [errorMsg]
        };
    }
    
    // Vérifier que schema est un objet valide
    if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
        const errorMsg = `Le schéma de validation pour '${fieldNameStr}' doit être un objet valide.`;
        logSanitization('error', fieldNameStr, obj, null, errorMsg, userId);
        return {
            valid: false,
            errors: [errorMsg]
        };
    }
    
    // 5. Rejette les champs non autorisés (whitelist)
    // Récupérer tous les champs autorisés dans le schéma
    const allowedFields = Object.keys(schema);
    const objFields = Object.keys(obj);
    
    // Vérifier les champs non autorisés
    for (const field of objFields) {
        if (!allowedFields.includes(field)) {
            const errorMsg = `Le champ '${fieldNameStr}.${field}' n'est pas autorisé dans le schéma. Champs autorisés: ${allowedFields.join(', ')}`;
            errors.push(errorMsg);
            logSanitization('error', `${fieldNameStr}.${field}`, obj[field], null, errorMsg, userId);
        }
    }
    
    // 2. Vérifie la présence des champs requis
    // 3. Vérifie les types de chaque champ (string, number, boolean, array, object)
    // 4. Valide les valeurs selon les règles du schéma (min, max, pattern, enum)
    for (const [fieldKey, fieldSchema] of Object.entries(schema)) {
        const fullFieldName = `${fieldNameStr}.${fieldKey}`;
        const value = obj[fieldKey];
        const isPresent = fieldKey in obj;
        
        // Vérifier si le champ est requis
        if (fieldSchema.required && !isPresent) {
            const errorMsg = `Le champ '${fullFieldName}' est requis mais absent`;
            errors.push(errorMsg);
            logSanitization('error', fullFieldName, undefined, null, errorMsg, userId);
            continue; // Passer au champ suivant
        }
        
        // Si le champ n'est pas présent et n'est pas requis, passer au suivant
        if (!isPresent) {
            continue;
        }
        
        // 3. Vérifie les types de chaque champ
        const expectedType = fieldSchema.type;
        let actualType;
        
        if (value === null) {
            actualType = 'null';
        } else if (Array.isArray(value)) {
            actualType = 'array';
        } else {
            actualType = typeof value;
        }
        
        if (actualType !== expectedType) {
            const errorMsg = `Le champ '${fullFieldName}' doit être de type '${expectedType}'. Type reçu: '${actualType}'`;
            errors.push(errorMsg);
            logSanitization('error', fullFieldName, value, null, errorMsg, userId);
            continue; // Passer au champ suivant si le type est incorrect
        }
        
        // 4. Valide les valeurs selon les règles du schéma
        // Validation pour les strings
        if (expectedType === 'string') {
            // minLength et maxLength
            if (fieldSchema.minLength !== undefined && value.length < fieldSchema.minLength) {
                const errorMsg = `Le champ '${fullFieldName}' est trop court. Longueur minimale: ${fieldSchema.minLength}, longueur reçue: ${value.length}`;
                errors.push(errorMsg);
                logSanitization('error', fullFieldName, value, null, errorMsg, userId);
            }
            
            if (fieldSchema.maxLength !== undefined && value.length > fieldSchema.maxLength) {
                const errorMsg = `Le champ '${fullFieldName}' est trop long. Longueur maximale: ${fieldSchema.maxLength}, longueur reçue: ${value.length}`;
                errors.push(errorMsg);
                logSanitization('error', fullFieldName, value, null, errorMsg, userId);
            }
            
            // Pattern validation
            if (fieldSchema.pattern) {
                try {
                    if (typeof fieldSchema.pattern === 'string') {
                        // Pattern prédéfini ou regex string
                        validateStringFormat(value, fieldSchema.pattern, fullFieldName, userId);
                    } else if (fieldSchema.pattern instanceof RegExp) {
                        // Regex direct
                        if (!fieldSchema.pattern.test(value)) {
                            const errorMsg = `Le champ '${fullFieldName}' ne correspond pas au pattern requis. Valeur reçue: "${value}"`;
                            errors.push(errorMsg);
                            logSanitization('error', fullFieldName, value, null, errorMsg, userId);
                        }
                    }
                } catch (patternError) {
                    errors.push(patternError.message);
                }
            }
            
            // Email validation spéciale
            if (fieldSchema.format === 'email') {
                try {
                    validateEmail(value, fullFieldName, userId);
                } catch (emailError) {
                    errors.push(emailError.message);
                }
            }
        }
        
        // Validation pour les numbers
        if (expectedType === 'number') {
            // min et max
            if (fieldSchema.min !== undefined && value < fieldSchema.min) {
                const errorMsg = `Le champ '${fullFieldName}' doit être supérieur ou égal à ${fieldSchema.min}. Valeur reçue: ${value}`;
                errors.push(errorMsg);
                logSanitization('error', fullFieldName, value, null, errorMsg, userId);
            }
            
            if (fieldSchema.max !== undefined && value > fieldSchema.max) {
                const errorMsg = `Le champ '${fullFieldName}' doit être inférieur ou égal à ${fieldSchema.max}. Valeur reçue: ${value}`;
                errors.push(errorMsg);
                logSanitization('error', fullFieldName, value, null, errorMsg, userId);
            }
            
            // mustBeInteger
            if (fieldSchema.mustBeInteger && !Number.isInteger(value)) {
                const errorMsg = `Le champ '${fullFieldName}' doit être un nombre entier. Valeur reçue: ${value}`;
                errors.push(errorMsg);
                logSanitization('error', fullFieldName, value, null, errorMsg, userId);
            }
            
            // mustBePositive
            if (fieldSchema.mustBePositive && value <= 0) {
                const errorMsg = `Le champ '${fullFieldName}' doit être un nombre strictement positif. Valeur reçue: ${value}`;
                errors.push(errorMsg);
                logSanitization('error', fullFieldName, value, null, errorMsg, userId);
            }
        }
        
        // Validation pour les arrays
        if (expectedType === 'array') {
            // minLength et maxLength pour les arrays
            if (fieldSchema.minLength !== undefined && value.length < fieldSchema.minLength) {
                const errorMsg = `Le champ '${fullFieldName}' doit contenir au moins ${fieldSchema.minLength} élément(s). Nombre d'éléments reçu: ${value.length}`;
                errors.push(errorMsg);
                logSanitization('error', fullFieldName, value, null, errorMsg, userId);
            }
            
            if (fieldSchema.maxLength !== undefined && value.length > fieldSchema.maxLength) {
                const errorMsg = `Le champ '${fullFieldName}' ne peut pas contenir plus de ${fieldSchema.maxLength} élément(s). Nombre d'éléments reçu: ${value.length}`;
                errors.push(errorMsg);
                logSanitization('error', fullFieldName, value, null, errorMsg, userId);
            }
            
            // Validation des éléments du tableau si itemSchema est défini
            if (fieldSchema.items && Array.isArray(value)) {
                for (let i = 0; i < value.length; i++) {
                    const itemResult = validateObjectSchema(value[i], fieldSchema.items, `${fullFieldName}[${i}]`, userId);
                    if (!itemResult.valid) {
                        errors.push(...itemResult.errors);
                    }
                }
            }
        }
        
        // Validation pour les objects (récursif)
        if (expectedType === 'object' && fieldSchema.properties) {
            const nestedResult = validateObjectSchema(value, fieldSchema.properties, fullFieldName, userId);
            if (!nestedResult.valid) {
                errors.push(...nestedResult.errors);
            }
        }
        
        // Enum validation
        if (fieldSchema.enum && Array.isArray(fieldSchema.enum)) {
            if (!fieldSchema.enum.includes(value)) {
                const errorMsg = `Le champ '${fullFieldName}' doit être une des valeurs suivantes: ${fieldSchema.enum.join(', ')}. Valeur reçue: ${value}`;
                errors.push(errorMsg);
                logSanitization('error', fullFieldName, value, null, errorMsg, userId);
            }
        }
    }
    
    // 6. Retourne un objet { valid: boolean, errors: [] } avec liste d'erreurs détaillées
    // 7. Inclut le fieldName dans les erreurs pour traçabilité (déjà fait dans les messages d'erreur)
    return {
        valid: errors.length === 0,
        errors: errors
    };
}

/**
 * Valide strictement un tableau avec un schéma pour chaque élément
 * 
 * @param {any} arr - Le tableau à valider
 * @param {Object|string} itemSchema - Le schéma de validation pour chaque élément (objet schéma ou type: 'string', 'number', 'boolean', 'object')
 * @param {number} minLength - Longueur minimale du tableau (défaut: 0)
 * @param {number} maxLength - Longueur maximale du tableau (défaut: Infinity)
 * @param {string} fieldName - Nom du champ pour la traçabilité (optionnel)
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @param {Object} options - Options de validation (optionnel)
 * @param {boolean} options.rejectInvalidItems - Si true, rejette les éléments invalides (défaut: false, retourne erreur)
 * @returns {Object} - { valid: boolean, errors: [], sanitized: [] } avec tableau sanitizé si valide
 * 
 * @example
 * // Schéma simple (type)
 * const result = validateArraySchema(['item1', 'item2'], 'string', 0, 10, 'items')
 * // Retourne: { valid: true, errors: [], sanitized: ['item1', 'item2'] }
 * 
 * // Schéma complexe (objet)
 * const itemSchema = {
 *   name: { type: 'string', required: true, maxLength: 100 },
 *   age: { type: 'number', required: false, min: 0, max: 150 }
 * };
 * const result = validateArraySchema(
 *   [{ name: 'John', age: 30 }, { name: 'Jane', age: 25 }],
 *   itemSchema,
 *   1,
 *   10,
 *   'users'
 * )
 * // Retourne: { valid: true, errors: [], sanitized: [...] }
 * 
 * // Erreur: type incorrect
 * const result = validateArraySchema([1, 2, 3], 'string', 0, 10, 'items')
 * // Retourne: { valid: false, errors: ["Le champ 'items[0]' doit être de type 'string'. Type reçu: 'number'", ...], sanitized: [] }
 * 
 * // Erreur: longueur invalide
 * const result = validateArraySchema(['item1'], 'string', 2, 10, 'items')
 * // Retourne: { valid: false, errors: ["Le champ 'items' doit contenir au moins 2 élément(s). Nombre d'éléments reçu: 1"], sanitized: [] }
 */
function validateArraySchema(arr, itemSchema, minLength = 0, maxLength = Infinity, fieldName = null, userId = null, options = {}) {
    const fieldNameStr = fieldName || 'array';
    const { rejectInvalidItems = false } = options;
    const errors = [];
    const sanitized = [];
    
    // 1. Valide que l'input est un tableau
    if (!Array.isArray(arr)) {
        const errorMsg = `Le champ '${fieldNameStr}' doit être un tableau. Type reçu: ${arr === null ? 'null' : arr === undefined ? 'undefined' : typeof arr}`;
        logSanitization('error', fieldNameStr, arr, null, errorMsg, userId);
        return {
            valid: false,
            errors: [errorMsg],
            sanitized: []
        };
    }
    
    // 2. Valide la longueur du tableau (minLength, maxLength)
    const length = arr.length;
    
    if (length < minLength) {
        const errorMsg = `Le champ '${fieldNameStr}' doit contenir au moins ${minLength} élément${minLength > 1 ? 's' : ''}. Nombre d'éléments reçu: ${length}`;
        errors.push(errorMsg);
        logSanitization('error', fieldNameStr, length, minLength, errorMsg, userId);
    }
    
    if (length > maxLength) {
        const errorMsg = `Le champ '${fieldNameStr}' ne peut pas contenir plus de ${maxLength} élément${maxLength > 1 ? 's' : ''}. Nombre d'éléments reçu: ${length}`;
        errors.push(errorMsg);
        logSanitization('error', fieldNameStr, length, maxLength, errorMsg, userId);
    }
    
    // Si la longueur est invalide et qu'on ne rejette pas les éléments invalides, retourner immédiatement
    if (errors.length > 0 && !rejectInvalidItems) {
        return {
            valid: false,
            errors: errors,
            sanitized: []
        };
    }
    
    // 3. Valide chaque élément selon itemSchema
    // 4. Rejette les éléments invalides ou retourne une erreur selon la configuration
    for (let i = 0; i < arr.length; i++) {
        const item = arr[i];
        const itemFieldName = `${fieldNameStr}[${i}]`;
        let itemValid = true;
        let itemErrors = [];
        let sanitizedItem = null;
        
        try {
            if (typeof itemSchema === 'string') {
                // Schéma simple (type: 'string', 'number', 'boolean', 'object')
                const expectedType = itemSchema;
                let actualType;
                
                if (item === null) {
                    actualType = 'null';
                } else if (Array.isArray(item)) {
                    actualType = 'array';
                } else {
                    actualType = typeof item;
                }
                
                if (actualType !== expectedType) {
                    const errorMsg = `Le champ '${itemFieldName}' doit être de type '${expectedType}'. Type reçu: '${actualType}'`;
                    itemErrors.push(errorMsg);
                    logSanitization('error', itemFieldName, item, null, errorMsg, userId);
                    itemValid = false;
                } else {
                    sanitizedItem = item;
                }
            } else if (typeof itemSchema === 'object' && itemSchema !== null) {
                // Schéma complexe (objet) - utiliser validateObjectSchema
                const validationResult = validateObjectSchema(item, itemSchema, itemFieldName, userId);
                if (!validationResult.valid) {
                    itemErrors.push(...validationResult.errors);
                    itemValid = false;
                } else {
                    // Pour un objet, on ne retourne pas de sanitized dans validateObjectSchema
                    // On retourne l'objet original si valide
                    sanitizedItem = item;
                }
            } else {
                const errorMsg = `Le champ '${fieldNameStr}' : itemSchema doit être une string (type) ou un objet (schéma). Type reçu: ${typeof itemSchema}`;
                errors.push(errorMsg);
                logSanitization('error', fieldNameStr, itemSchema, null, errorMsg, userId);
                return {
                    valid: false,
                    errors: errors,
                    sanitized: []
                };
            }
            
            if (itemValid) {
                sanitized.push(sanitizedItem);
            } else if (rejectInvalidItems) {
                // Rejeter l'élément invalide (ne pas l'ajouter au tableau sanitizé)
                logSanitization('warn', itemFieldName, item, null, 'Élément invalide rejeté', userId);
            } else {
                // Retourner une erreur pour l'élément invalide
                errors.push(...itemErrors);
            }
        } catch (error) {
            const errorMsg = `Le champ '${itemFieldName}' : erreur lors de la validation: ${error.message}`;
            itemErrors.push(errorMsg);
            logSanitization('error', itemFieldName, item, null, errorMsg, userId);
            
            if (rejectInvalidItems) {
                logSanitization('warn', itemFieldName, item, null, 'Élément invalide rejeté', userId);
            } else {
                errors.push(...itemErrors);
            }
        }
    }
    
    // 5. Retourne { valid: boolean, errors: [], sanitized: [] } avec tableau sanitizé si valide
    const isValid = errors.length === 0;
    
    return {
        valid: isValid,
        errors: errors,
        sanitized: isValid ? sanitized : (rejectInvalidItems ? sanitized : [])
    };
}

/**
 * Whitelist des champs autorisés dans un objet property
 * Seuls ces champs seront conservés lors de la sanitisation
 */
const ALLOWED_PROPERTY_FIELDS = [
    'id',
    'location',
    'address',
    'property_type',
    'propertyType',
    'capacity',
    'surface',
    'amenities',
    'strategy',
    'base_price',
    'floor_price',
    'ceiling_price',
    'weekly_discount_percent',
    'monthly_discount_percent',
    'weekend_markup_percent',
    'min_stay',
    'max_stay',
    'country',
    'team_id',
    'owner_id',
    'name',
    'pms_id',
    'pms_type',
    'status'
];

/**
 * Sanitise récursivement un objet en fonction de son type
 * 
 * @param {any} value - La valeur à sanitiser
 * @param {string} fieldName - Le nom du champ (pour les messages d'erreur)
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @returns {any} - La valeur sanitizée
 */
function sanitizeValueByType(value, fieldName, userId = null) {
    // Null ou undefined
    if (value === null || value === undefined) {
        return value;
    }
    
    // String
    if (typeof value === 'string') {
        // Validation spéciale pour property_type et strategy (whitelist)
        if (fieldName === 'property_type' || fieldName === 'propertyType') {
            return sanitizePropertyType(value, fieldName, userId);
        }
        
        if (fieldName === 'strategy') {
            return sanitizeStrategy(value, 'Équilibré', fieldName, userId);
        }
        
        // Limites de longueur selon le champ
        const maxLengths = {
            location: 200,
            address: 200,
            property_type: 50,
            propertyType: 50,
            name: 200,
            country: 10,
            strategy: 50,
            id: 100,
            team_id: 100,
            owner_id: 100,
            pms_id: 100,
            pms_type: 50,
            status: 50
        };
        
        const maxLength = maxLengths[fieldName] || 200;
        return sanitizeForPrompt(value, maxLength, fieldName, userId);
    }
    
    // Number
    if (typeof value === 'number') {
        // Plages selon le champ
        const ranges = {
            capacity: { min: 1, max: 50, mustBeInteger: true, mustBePositive: true },
            surface: { min: 0, max: Infinity, mustBePositive: false },
            base_price: { min: 0, max: Infinity, mustBePositive: true, maxDecimals: 2 },
            floor_price: { min: 0, max: Infinity, mustBePositive: true, maxDecimals: 2 },
            ceiling_price: { min: 0, max: Infinity, mustBePositive: true, maxDecimals: 2, allowNull: true },
            weekly_discount_percent: { min: 0, max: 100, mustBePositive: false, maxDecimals: 2 },
            monthly_discount_percent: { min: 0, max: 100, mustBePositive: false, maxDecimals: 2 },
            weekend_markup_percent: { min: 0, max: 100, mustBePositive: false, maxDecimals: 2 },
            min_stay: { min: 1, max: 365, mustBeInteger: true, mustBePositive: true },
            max_stay: { min: 1, max: 365, mustBeInteger: true, mustBePositive: true, allowNull: true }
        };
        
        const range = ranges[fieldName];
        if (range) {
            // Si la valeur est NaN ou invalide et que null est autorisé, retourner null
            if (isNaN(value) && range.allowNull) {
                return null;
            }
            try {
                return sanitizeNumber(value, range.min, range.max, fieldName, userId, {
                    mustBeInteger: range.mustBeInteger || false,
                    mustBePositive: range.mustBePositive || false,
                    maxDecimals: range.maxDecimals || Infinity
                });
            } catch (error) {
                // En cas d'erreur de validation, logger et retourner null si autorisé
                if (range.allowNull) {
                    logSanitization('error', fieldName, value, null, `Validation échouée: ${error.message}`, userId);
                    return null;
                }
                // Sinon, re-lancer l'erreur
                throw error;
            }
        }
        
        // Pour les autres nombres, validation basique
        try {
            return sanitizeNumber(value, -Infinity, Infinity, fieldName, userId);
        } catch (error) {
            logSanitization('error', fieldName, value, null, `Validation échouée: ${error.message}`, userId);
            // Retourner null en cas d'erreur pour les nombres non-configurés
            return null;
        }
    }
    
    // Array
    if (Array.isArray(value)) {
        if (fieldName === 'amenities') {
            return sanitizeArray(value, 50, (item) => sanitizeForPrompt(String(item), 50, `${fieldName}[item]`, userId), fieldName, userId);
        }
        // Pour les autres tableaux, sanitisation générique
        return sanitizeArray(value, 100, (item) => {
            if (typeof item === 'string') {
                return sanitizeForPrompt(item, 100, `${fieldName}[item]`, userId);
            }
            return sanitizeValueByType(item, `${fieldName}[item]`, userId);
        }, fieldName, userId);
    }
    
    // Object
    if (typeof value === 'object') {
        return sanitizePropertyObject(value, userId);
    }
    
    // Boolean ou autres types
    return value;
}

/**
 * Valide strictement un ID de propriété (string ou nombre)
 * 
 * @param {any} propertyId - L'ID de propriété à valider
 * @param {string} fieldName - Nom du champ pour les messages d'erreur (optionnel)
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @param {Object} options - Options de validation (optionnel)
 * @param {number} options.maxLength - Longueur maximale si string (défaut: 128)
 * @param {string} options.format - Format attendu si string : 'uuid', 'alphanumeric', 'any' (défaut: 'any')
 * @returns {string|number} - L'ID validé (string ou number)
 * @throws {Error} - Si la validation échoue avec un message d'erreur clair incluant fieldName
 * 
 * @example
 * validatePropertyId('abc123', 'propertyId')
 * // Retourne: 'abc123'
 * 
 * validatePropertyId('550e8400-e29b-41d4-a716-446655440000', 'propertyId', null, { format: 'uuid' })
 * // Retourne: '550e8400-e29b-41d4-a716-446655440000'
 * 
 * validatePropertyId(123, 'propertyId')
 * // Retourne: 123
 * 
 * validatePropertyId('', 'propertyId')
 * // Lance une erreur: "Le champ 'propertyId' ne peut pas être vide. Un ID valide est requis."
 * 
 * validatePropertyId(null, 'propertyId')
 * // Lance une erreur: "Le champ 'propertyId' doit être une string ou un nombre. Type reçu: object (null)"
 * 
 * validatePropertyId(-5, 'propertyId')
 * // Lance une erreur: "Le champ 'propertyId' doit être un nombre entier strictement positif. Valeur reçue: -5"
 * 
 * validatePropertyId('a'.repeat(200), 'propertyId')
 * // Lance une erreur: "Le champ 'propertyId' est trop long. Longueur maximale: 128 caractères, longueur reçue: 200"
 */
function validatePropertyId(propertyId, fieldName = null, userId = null, options = {}) {
    const fieldNameStr = fieldName || 'propertyId';
    const { maxLength = 128, format = 'any' } = options;
    
    // 5. Rejette les valeurs vides, null, undefined
    if (propertyId === null || propertyId === undefined) {
        const errorMsg = `Le champ '${fieldNameStr}' doit être une string ou un nombre. Type reçu: ${propertyId === null ? 'object (null)' : 'undefined'}`;
        logSanitization('error', fieldNameStr, propertyId, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // 1. Valide que propertyId est une string ou un nombre
    if (typeof propertyId === 'string') {
        // 5. Rejette les valeurs vides
        const trimmedId = propertyId.trim();
        if (trimmedId === '') {
            const errorMsg = `Le champ '${fieldNameStr}' ne peut pas être vide. Un ID valide est requis.`;
            logSanitization('error', fieldNameStr, propertyId, null, errorMsg, userId);
            throw new Error(errorMsg);
        }
        
        // 4. Limite la longueur si string
        if (trimmedId.length > maxLength) {
            const errorMsg = `Le champ '${fieldNameStr}' est trop long. Longueur maximale: ${maxLength} caractères, longueur reçue: ${trimmedId.length}`;
            logSanitization('error', fieldNameStr, propertyId, null, errorMsg, userId);
            throw new Error(errorMsg);
        }
        
        // 2. Si string: valide le format (UUID, alphanumérique, etc.)
        if (format === 'uuid') {
            // Format UUID v4: 8-4-4-4-12 caractères hexadécimaux
            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
            if (!uuidRegex.test(trimmedId)) {
                const errorMsg = `Le champ '${fieldNameStr}' doit être un UUID valide (format: 8-4-4-4-12 caractères hexadécimaux). Valeur reçue: "${trimmedId}"`;
                logSanitization('error', fieldNameStr, propertyId, null, errorMsg, userId);
                throw new Error(errorMsg);
            }
        } else if (format === 'alphanumeric') {
            // Format alphanumérique (lettres et chiffres uniquement)
            const alphanumericRegex = /^[a-zA-Z0-9]+$/;
            if (!alphanumericRegex.test(trimmedId)) {
                const errorMsg = `Le champ '${fieldNameStr}' doit contenir uniquement des caractères alphanumériques (lettres et chiffres). Valeur reçue: "${trimmedId}"`;
                logSanitization('error', fieldNameStr, propertyId, null, errorMsg, userId);
                throw new Error(errorMsg);
            }
        }
        // format === 'any' : pas de validation de format spécifique, juste longueur
        
        // Logger si la valeur a été modifiée (trim)
        if (propertyId !== trimmedId) {
            logSanitization('warn', fieldNameStr, propertyId, trimmedId, 'ID normalisé (trim)', userId);
        }
        
        // 6. Retourne l'ID validé ou lance une erreur avec fieldName
        return trimmedId;
    } else if (typeof propertyId === 'number') {
        // 3. Si nombre: valide que c'est un entier positif
        try {
            const validatedId = validateInteger(propertyId, 1, Infinity, fieldNameStr, userId);
            // 6. Retourne l'ID validé ou lance une erreur avec fieldName
            return validatedId;
        } catch (error) {
            // validateInteger lance déjà une erreur avec le bon message
            throw error;
        }
    } else {
        // Type invalide
        const errorMsg = `Le champ '${fieldNameStr}' doit être une string ou un nombre. Type reçu: ${typeof propertyId}`;
        logSanitization('error', fieldNameStr, propertyId, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
}

/**
 * Patterns de validation pour les références externes par type
 */
const EXTERNAL_REFERENCE_PATTERNS = {
    pms_id: {
        regex: /^[a-zA-Z0-9_-]+$/,
        maxLength: 128,
        description: 'ID PMS (alphanumérique avec tirets et underscores)'
    },
    stripe_id: {
        regex: /^(cus_|sub_|price_|prod_|pi_|in_|pm_|acct_|evt_)[a-zA-Z0-9]{24,}$/,
        maxLength: 128,
        description: 'ID Stripe (préfixe suivi de 24+ caractères alphanumériques)'
    },
    listing_id: {
        regex: /^[a-zA-Z0-9_-]+$/,
        maxLength: 128,
        description: 'ID de listing (alphanumérique avec tirets et underscores)'
    }
};

/**
 * Valide strictement une référence externe selon son type
 * 
 * @param {any} ref - La référence externe à valider
 * @param {string} type - Type de référence : 'pms_id', 'stripe_id', 'listing_id'
 * @param {string} fieldName - Nom du champ pour les messages d'erreur (optionnel)
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @returns {string} - La référence validée
 * @throws {Error} - Si la validation échoue avec un message d'erreur clair incluant fieldName
 * 
 * @example
 * validateExternalReference('abc123', 'pms_id', 'pmsId')
 * // Retourne: 'abc123'
 * 
 * validateExternalReference('cus_123456789012345678901234', 'stripe_id', 'stripeCustomerId')
 * // Retourne: 'cus_123456789012345678901234'
 * 
 * validateExternalReference('listing-123', 'listing_id', 'listingId')
 * // Retourne: 'listing-123'
 * 
 * validateExternalReference('invalid<>', 'pms_id', 'pmsId')
 * // Lance une erreur: "Le champ 'pmsId' contient des caractères dangereux. Caractères non autorisés détectés."
 * 
 * validateExternalReference('', 'pms_id', 'pmsId')
 * // Lance une erreur: "Le champ 'pmsId' ne peut pas être vide. Une référence externe valide est requise."
 * 
 * validateExternalReference('a'.repeat(200), 'pms_id', 'pmsId')
 * // Lance une erreur: "Le champ 'pmsId' est trop long. Longueur maximale: 128 caractères, longueur reçue: 200"
 */
function validateExternalReference(ref, type, fieldName = null, userId = null) {
    const fieldNameStr = fieldName || 'externalReference';
    
    // Valider que le type est une string
    if (typeof type !== 'string') {
        const errorMsg = `Le champ '${fieldNameStr}' : le type doit être une string. Type reçu: ${typeof type}`;
        logSanitization('error', fieldNameStr, ref, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    const normalizedType = type.trim().toLowerCase();
    
    // 1. Valide selon le type : 'pms_id', 'stripe_id', 'listing_id', etc.
    const pattern = EXTERNAL_REFERENCE_PATTERNS[normalizedType];
    if (!pattern) {
        const supportedTypes = Object.keys(EXTERNAL_REFERENCE_PATTERNS).join(', ');
        const errorMsg = `Le champ '${fieldNameStr}' : type de référence non supporté '${type}'. Types supportés: ${supportedTypes}`;
        logSanitization('error', fieldNameStr, ref, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // Valider que l'input est une string
    if (typeof ref !== 'string') {
        const errorMsg = `Le champ '${fieldNameStr}' doit être une string. Type reçu: ${typeof ref}`;
        logSanitization('error', fieldNameStr, ref, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // Rejette les valeurs vides
    const trimmedRef = ref.trim();
    if (trimmedRef === '') {
        const errorMsg = `Le champ '${fieldNameStr}' ne peut pas être vide. Une référence externe valide est requise.`;
        logSanitization('error', fieldNameStr, ref, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // 4. Rejette les caractères spéciaux dangereux
    // Caractères dangereux : < > " ' ` ( ) [ ] { } ; : \ / | ? * = + & % $ # ! ~ ^ @
    const dangerousChars = /[<>"'`()[\]{};:\\|?*=+&%$#!~^@]/;
    if (dangerousChars.test(trimmedRef)) {
        const errorMsg = `Le champ '${fieldNameStr}' contient des caractères dangereux. Caractères non autorisés détectés.`;
        logSanitization('error', fieldNameStr, ref, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // 3. Limite la longueur selon le type
    if (trimmedRef.length > pattern.maxLength) {
        const errorMsg = `Le champ '${fieldNameStr}' est trop long. Longueur maximale: ${pattern.maxLength} caractères, longueur reçue: ${trimmedRef.length}`;
        logSanitization('error', fieldNameStr, ref, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // 2. Valide le format spécifique à chaque type
    if (!pattern.regex.test(trimmedRef)) {
        const errorMsg = `Le champ '${fieldNameStr}' doit être un ${pattern.description}. Valeur reçue: "${trimmedRef}"`;
        logSanitization('error', fieldNameStr, ref, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // Logger si la valeur a été modifiée (trim)
    if (ref !== trimmedRef) {
        logSanitization('warn', fieldNameStr, ref, trimmedRef, 'Référence externe normalisée (trim)', userId);
    }
    
    // 5. Retourne la référence validée ou lance une erreur avec fieldName
    return trimmedRef;
}

/**
 * Whitelist de timezones IANA communs
 */
const ALLOWED_TIMEZONES = [
    // Europe
    'Europe/Paris',
    'Europe/London',
    'Europe/Berlin',
    'Europe/Madrid',
    'Europe/Rome',
    'Europe/Amsterdam',
    'Europe/Brussels',
    'Europe/Vienna',
    'Europe/Stockholm',
    'Europe/Copenhagen',
    'Europe/Helsinki',
    'Europe/Dublin',
    'Europe/Lisbon',
    'Europe/Athens',
    'Europe/Prague',
    'Europe/Warsaw',
    'Europe/Budapest',
    'Europe/Zurich',
    'Europe/Oslo',
    // Americas
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'America/Phoenix',
    'America/Anchorage',
    'America/Honolulu',
    'America/Toronto',
    'America/Vancouver',
    'America/Mexico_City',
    'America/Sao_Paulo',
    'America/Buenos_Aires',
    'America/Lima',
    'America/Bogota',
    // Asia
    'Asia/Tokyo',
    'Asia/Shanghai',
    'Asia/Hong_Kong',
    'Asia/Singapore',
    'Asia/Seoul',
    'Asia/Dubai',
    'Asia/Kolkata',
    'Asia/Bangkok',
    'Asia/Jakarta',
    'Asia/Manila',
    // Oceania
    'Australia/Sydney',
    'Australia/Melbourne',
    'Australia/Brisbane',
    'Australia/Perth',
    'Pacific/Auckland',
    // Africa
    'Africa/Cairo',
    'Africa/Johannesburg',
    'Africa/Casablanca',
    // UTC
    'UTC'
];

/**
 * Valide strictement un timezone IANA
 * 
 * @param {any} timezone - Le timezone à valider
 * @param {string} fieldName - Nom du champ pour les messages d'erreur (optionnel)
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @returns {string} - Le timezone validé
 * @throws {Error} - Si la validation échoue avec un message d'erreur clair incluant fieldName
 * 
 * @example
 * validateTimezone('Europe/Paris', 'timezone')
 * // Retourne: 'Europe/Paris'
 * 
 * validateTimezone('America/New_York', 'timezone')
 * // Retourne: 'America/New_York'
 * 
 * validateTimezone('UTC+2', 'timezone')
 * // Lance une erreur: "Le champ 'timezone' doit être un timezone IANA valide. Format invalide: \"UTC+2\""
 * 
 * validateTimezone('GMT', 'timezone')
 * // Lance une erreur: "Le champ 'timezone' doit être un timezone IANA valide. Format invalide: \"GMT\""
 * 
 * validateTimezone('Europe/Invalid', 'timezone')
 * // Lance une erreur: "Le champ 'timezone' n'est pas un timezone IANA valide. Valeur reçue: \"Europe/Invalid\""
 * 
 * validateTimezone('', 'timezone')
 * // Lance une erreur: "Le champ 'timezone' ne peut pas être vide. Un timezone IANA valide est requis."
 */
function validateTimezone(timezone, fieldName = null, userId = null) {
    const fieldNameStr = fieldName || 'timezone';
    
    // Valider que l'input est une string
    if (typeof timezone !== 'string') {
        const errorMsg = `Le champ '${fieldNameStr}' doit être une string. Type reçu: ${typeof timezone}`;
        logSanitization('error', fieldNameStr, timezone, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // Rejette les valeurs vides
    const trimmedTimezone = timezone.trim();
    if (trimmedTimezone === '') {
        const errorMsg = `Le champ '${fieldNameStr}' ne peut pas être vide. Un timezone IANA valide est requis.`;
        logSanitization('error', fieldNameStr, timezone, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // 1. Valide le format IANA (ex: 'Europe/Paris', 'America/New_York')
    // Format IANA : Continent/City (lettres, chiffres, underscores, tirets)
    // Pattern : lettre(s), slash, lettre(s) et caractères alphanumériques/underscores
    const ianaFormatRegex = /^[A-Za-z_]+\/[A-Za-z_][A-Za-z0-9_]*$/;
    
    // 4. Rejette les formats invalides (ex: 'UTC+2', 'GMT')
    if (!ianaFormatRegex.test(trimmedTimezone)) {
        const errorMsg = `Le champ '${fieldNameStr}' doit être un timezone IANA valide (format: Continent/City, ex: Europe/Paris, America/New_York). Format invalide: "${trimmedTimezone}"`;
        logSanitization('error', fieldNameStr, timezone, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // Rejeter explicitement les formats non-IANA courants
    const invalidFormats = [
        /^UTC[+-]?\d+$/i,      // UTC+2, UTC-5, etc.
        /^GMT[+-]?\d*$/i,      // GMT, GMT+2, GMT-5, etc.
        /^[A-Z]{3,4}$/i        // GMT, EST, PST, etc.
    ];
    
    for (const invalidPattern of invalidFormats) {
        if (invalidPattern.test(trimmedTimezone)) {
            const errorMsg = `Le champ '${fieldNameStr}' utilise un format non-IANA. Les timezones doivent être au format IANA (ex: Europe/Paris, America/New_York), pas UTC+2, GMT, etc. Valeur reçue: "${trimmedTimezone}"`;
            logSanitization('error', fieldNameStr, timezone, null, errorMsg, userId);
            throw new Error(errorMsg);
        }
    }
    
    // 2. Vérifie que le timezone existe dans la liste des timezones valides
    // 3. Utilise une whitelist de timezones communes
    if (!ALLOWED_TIMEZONES.includes(trimmedTimezone)) {
        const errorMsg = `Le champ '${fieldNameStr}' n'est pas un timezone IANA valide ou n'est pas dans la whitelist. Valeur reçue: "${trimmedTimezone}". Timezones disponibles: ${ALLOWED_TIMEZONES.slice(0, 10).join(', ')}... (${ALLOWED_TIMEZONES.length} timezones disponibles)`;
        logSanitization('error', fieldNameStr, timezone, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // Logger si la valeur a été modifiée (trim)
    if (timezone !== trimmedTimezone) {
        logSanitization('warn', fieldNameStr, timezone, trimmedTimezone, 'Timezone normalisé (trim)', userId);
    }
    
    // 5. Retourne le timezone validé ou lance une erreur avec fieldName
    return trimmedTimezone;
}

/**
 * Valide strictement une date/heure selon différents formats
 * 
 * @param {any} datetime - La date/heure à valider (string pour ISO8601/YYYY-MM-DD HH:mm:ss, number pour timestamp)
 * @param {string} format - Format attendu : 'ISO8601', 'YYYY-MM-DD HH:mm:ss', 'timestamp' (défaut: 'ISO8601')
 * @param {string} fieldName - Nom du champ pour les messages d'erreur (optionnel)
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @param {Object} options - Options de validation (optionnel)
 * @param {number} options.minYear - Année minimale autorisée (défaut: 1900)
 * @param {number} options.maxYear - Année maximale autorisée (défaut: 2100)
 * @returns {string|number} - La date/heure validée et normalisée (string pour ISO8601/YYYY-MM-DD HH:mm:ss, number pour timestamp)
 * @throws {Error} - Si la validation échoue avec un message d'erreur clair incluant fieldName
 * 
 * @example
 * validateDateTime('2024-01-15T10:30:00Z', 'ISO8601', 'createdAt')
 * // Retourne: '2024-01-15T10:30:00Z'
 * 
 * validateDateTime('2024-01-15 10:30:00', 'YYYY-MM-DD HH:mm:ss', 'createdAt')
 * // Retourne: '2024-01-15 10:30:00'
 * 
 * validateDateTime(1705313400000, 'timestamp', 'createdAt')
 * // Retourne: 1705313400000
 * 
 * validateDateTime('invalid', 'ISO8601', 'createdAt')
 * // Lance une erreur: "Le champ 'createdAt' doit être une date/heure au format ISO8601. Format invalide: \"invalid\""
 * 
 * validateDateTime(-1000000, 'timestamp', 'createdAt')
 * // Lance une erreur: "Le champ 'createdAt' doit être un timestamp positif. Valeur reçue: -1000000"
 */
function validateDateTime(datetime, format = 'ISO8601', fieldName = null, userId = null, options = {}) {
    const fieldNameStr = fieldName || 'datetime';
    const { minYear = 1900, maxYear = 2100 } = options;
    
    // 4. Pour timestamp: valide que c'est un nombre entier positif
    if (format === 'timestamp') {
        // Valider que l'input est un nombre
        if (typeof datetime !== 'number') {
            const errorMsg = `Le champ '${fieldNameStr}' doit être un nombre (timestamp en millisecondes). Type reçu: ${typeof datetime}`;
            logSanitization('error', fieldNameStr, datetime, null, errorMsg, userId);
            throw new Error(errorMsg);
        }
        
        // Valider que c'est un entier positif
        try {
            const validatedTimestamp = validateInteger(datetime, 1, Infinity, fieldNameStr, userId);
            
            // 5. Valide que la date/heure est dans une plage raisonnable
            const date = new Date(validatedTimestamp);
            if (isNaN(date.getTime())) {
                const errorMsg = `Le champ '${fieldNameStr}' doit être un timestamp valide. Valeur reçue: ${datetime}`;
                logSanitization('error', fieldNameStr, datetime, null, errorMsg, userId);
                throw new Error(errorMsg);
            }
            
            const year = date.getUTCFullYear();
            if (year < minYear || year > maxYear) {
                const errorMsg = `Le champ '${fieldNameStr}' correspond à une date hors plage. Année: ${year}, plage autorisée: ${minYear}-${maxYear}`;
                logSanitization('error', fieldNameStr, datetime, null, errorMsg, userId);
                throw new Error(errorMsg);
            }
            
            // 6. Retourne la date/heure normalisée ou lance une erreur avec fieldName
            return validatedTimestamp;
        } catch (error) {
            // validateInteger lance déjà une erreur avec le bon message
            throw error;
        }
    }
    
    // Formats string : ISO8601, YYYY-MM-DD HH:mm:ss
    if (typeof datetime !== 'string') {
        const errorMsg = `Le champ '${fieldNameStr}' doit être une string pour le format '${format}'. Type reçu: ${typeof datetime}`;
        logSanitization('error', fieldNameStr, datetime, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    const trimmedDatetime = datetime.trim();
    if (trimmedDatetime === '') {
        const errorMsg = `Le champ '${fieldNameStr}' ne peut pas être vide. Une date/heure valide est requise pour le format '${format}'.`;
        logSanitization('error', fieldNameStr, datetime, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    let normalizedDatetime;
    let dateObject;
    
    // 1. Supporte les formats : 'ISO8601', 'YYYY-MM-DD HH:mm:ss', 'timestamp'
    // 2. Valide strictement le format avec regex
    if (format === 'ISO8601') {
        // 3. Pour ISO8601: valide le format complet avec timezone
        // Format ISO8601 : YYYY-MM-DDTHH:mm:ss.sssZ ou YYYY-MM-DDTHH:mm:ssZ ou YYYY-MM-DDTHH:mm:ss+HH:mm
        // Exemples : '2024-01-15T10:30:00Z', '2024-01-15T10:30:00.000Z', '2024-01-15T10:30:00+01:00'
        const iso8601Regex = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|([+-]\d{2}):(\d{2}))$/;
        
        if (!iso8601Regex.test(trimmedDatetime)) {
            const errorMsg = `Le champ '${fieldNameStr}' doit être une date/heure au format ISO8601 (ex: 2024-01-15T10:30:00Z ou 2024-01-15T10:30:00+01:00). Format invalide: "${trimmedDatetime}"`;
            logSanitization('error', fieldNameStr, datetime, null, errorMsg, userId);
            throw new Error(errorMsg);
        }
        
        // Parser la date pour valider qu'elle est valide
        dateObject = new Date(trimmedDatetime);
        if (isNaN(dateObject.getTime())) {
            const errorMsg = `Le champ '${fieldNameStr}' contient une date/heure ISO8601 invalide. Valeur reçue: "${trimmedDatetime}"`;
            logSanitization('error', fieldNameStr, datetime, null, errorMsg, userId);
            throw new Error(errorMsg);
        }
        
        normalizedDatetime = trimmedDatetime;
    } else if (format === 'YYYY-MM-DD HH:mm:ss') {
        // Format YYYY-MM-DD HH:mm:ss : '2024-01-15 10:30:00'
        const dateTimeRegex = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
        
        if (!dateTimeRegex.test(trimmedDatetime)) {
            const errorMsg = `Le champ '${fieldNameStr}' doit être une date/heure au format YYYY-MM-DD HH:mm:ss (ex: 2024-01-15 10:30:00). Format invalide: "${trimmedDatetime}"`;
            logSanitization('error', fieldNameStr, datetime, null, errorMsg, userId);
            throw new Error(errorMsg);
        }
        
        // Parser la date pour valider qu'elle est valide
        dateObject = new Date(trimmedDatetime.replace(' ', 'T') + 'Z');
        if (isNaN(dateObject.getTime())) {
            const errorMsg = `Le champ '${fieldNameStr}' contient une date/heure invalide. Valeur reçue: "${trimmedDatetime}"`;
            logSanitization('error', fieldNameStr, datetime, null, errorMsg, userId);
            throw new Error(errorMsg);
        }
        
        normalizedDatetime = trimmedDatetime;
    } else {
        const errorMsg = `Le champ '${fieldNameStr}' : format non supporté '${format}'. Formats supportés: ISO8601, YYYY-MM-DD HH:mm:ss, timestamp`;
        logSanitization('error', fieldNameStr, datetime, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // 5. Valide que la date/heure est dans une plage raisonnable
    const year = dateObject.getUTCFullYear();
    if (year < minYear || year > maxYear) {
        const errorMsg = `Le champ '${fieldNameStr}' correspond à une date hors plage. Année: ${year}, plage autorisée: ${minYear}-${maxYear}. Valeur reçue: "${trimmedDatetime}"`;
        logSanitization('error', fieldNameStr, datetime, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // Logger si la valeur a été modifiée (trim)
    if (datetime !== normalizedDatetime) {
        logSanitization('warn', fieldNameStr, datetime, normalizedDatetime, 'Date/heure normalisée (trim)', userId);
    }
    
    // 6. Retourne la date/heure normalisée ou lance une erreur avec fieldName
    return normalizedDatetime;
}

/**
 * Valide strictement les credentials PMS selon le type de PMS
 * 
 * @param {any} credentials - Les credentials à valider
 * @param {string} pmsType - Type de PMS : 'smoobu', 'beds24' (insensible à la casse)
 * @param {string} fieldName - Nom du champ pour les messages d'erreur (optionnel, défaut: 'credentials')
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @returns {Object} - { valid: boolean, errors: [] } avec erreurs détaillées
 * 
 * @example
 * validatePMSCredentials({ token: 'abc123...' }, 'smoobu', 'smoobuCredentials')
 * // Retourne: { valid: true, errors: [] }
 * 
 * validatePMSCredentials({ apiKey: 'key123...', propKey: 'prop456...' }, 'beds24', 'beds24Credentials')
 * // Retourne: { valid: true, errors: [] }
 * 
 * validatePMSCredentials({ token: 'test' }, 'smoobu', 'smoobuCredentials')
 * // Retourne: { valid: false, errors: ["Le champ 'smoobuCredentials.token' contient une valeur suspecte: 'test'"] }
 * 
 * validatePMSCredentials({ apiKey: 'key' }, 'beds24', 'beds24Credentials')
 * // Retourne: { valid: false, errors: ["Le champ 'beds24Credentials.propKey' est requis pour le type PMS 'beds24'"] }
 */
function validatePMSCredentials(credentials, pmsType, fieldName = null, userId = null) {
    const fieldNameStr = fieldName || 'credentials';
    const errors = [];
    
    // 1. Valide que credentials est un objet
    if (typeof credentials !== 'object' || credentials === null || Array.isArray(credentials)) {
        const errorMsg = `Le champ '${fieldNameStr}' doit être un objet. Type reçu: ${Array.isArray(credentials) ? 'array' : typeof credentials}`;
        logSanitization('error', fieldNameStr, credentials, null, errorMsg, userId);
        return {
            valid: false,
            errors: [errorMsg]
        };
    }
    
    // Normaliser le type PMS (insensible à la casse)
    const normalizedPmsType = String(pmsType).toLowerCase().trim();
    
    // Définir les champs requis et leurs contraintes selon le type PMS
    const PMS_SCHEMAS = {
        smoobu: {
            requiredFields: ['token'],
            fieldConstraints: {
                token: {
                    minLength: 10,
                    maxLength: 512,
                    description: 'token'
                }
            }
        },
        beds24: {
            requiredFields: ['apiKey', 'propKey'],
            fieldConstraints: {
                apiKey: {
                    minLength: 10,
                    maxLength: 256,
                    description: 'clé API'
                },
                propKey: {
                    minLength: 10,
                    maxLength: 256,
                    description: 'clé de propriété'
                }
            }
        }
    };
    
    // Vérifier que le type PMS est supporté
    if (!PMS_SCHEMAS[normalizedPmsType]) {
        const errorMsg = `Le type PMS '${pmsType}' n'est pas supporté. Types supportés: ${Object.keys(PMS_SCHEMAS).join(', ')}`;
        logSanitization('error', fieldNameStr, pmsType, null, errorMsg, userId);
        return {
            valid: false,
            errors: [errorMsg]
        };
    }
    
    const schema = PMS_SCHEMAS[normalizedPmsType];
    
    // 2. Valide les champs requis selon pmsType
    for (const requiredField of schema.requiredFields) {
        if (!(requiredField in credentials)) {
            const errorMsg = `Le champ '${fieldNameStr}.${requiredField}' est requis pour le type PMS '${normalizedPmsType}'`;
            logSanitization('error', `${fieldNameStr}.${requiredField}`, undefined, null, errorMsg, userId);
            errors.push(errorMsg);
            continue;
        }
        
        const fieldValue = credentials[requiredField];
        const fieldPath = `${fieldNameStr}.${requiredField}`;
        const constraints = schema.fieldConstraints[requiredField];
        
        // 3. Valide que chaque champ est une string non vide
        if (typeof fieldValue !== 'string') {
            const errorMsg = `Le champ '${fieldPath}' doit être une string. Type reçu: ${typeof fieldValue}`;
            logSanitization('error', fieldPath, fieldValue, null, errorMsg, userId);
            errors.push(errorMsg);
            continue;
        }
        
        const trimmedValue = fieldValue.trim();
        
        if (trimmedValue === '') {
            const errorMsg = `Le champ '${fieldPath}' ne peut pas être vide. Une ${constraints.description} valide est requise`;
            logSanitization('error', fieldPath, fieldValue, null, errorMsg, userId);
            errors.push(errorMsg);
            continue;
        }
        
        // 4. Valide la longueur des tokens/clés (min/max)
        if (trimmedValue.length < constraints.minLength) {
            const errorMsg = `Le champ '${fieldPath}' est trop court. Longueur: ${trimmedValue.length}, minimum requis: ${constraints.minLength} caractères`;
            logSanitization('error', fieldPath, fieldValue, null, errorMsg, userId);
            errors.push(errorMsg);
            continue;
        }
        
        if (trimmedValue.length > constraints.maxLength) {
            const errorMsg = `Le champ '${fieldPath}' est trop long. Longueur: ${trimmedValue.length}, maximum autorisé: ${constraints.maxLength} caractères`;
            logSanitization('error', fieldPath, fieldValue, null, errorMsg, userId);
            errors.push(errorMsg);
            continue;
        }
        
        // 5. Rejette les valeurs suspectes (ex: 'test', 'password', etc.)
        const SUSPICIOUS_VALUES = [
            'test', 'password', 'pass', 'secret', 'key', 'token', 'api', 'demo',
            'example', 'sample', 'dummy', 'fake', 'placeholder', '123456', '12345678',
            'admin', 'root', 'user', 'default', 'temp', 'temporary', 'null', 'undefined',
            'smoobu', 'beds24', 'cloudbeds', 'pms', 'api_key', 'apikey', 'prop_key', 'propkey'
        ];
        
        const lowerValue = trimmedValue.toLowerCase();
        const isSuspicious = SUSPICIOUS_VALUES.some(suspicious => 
            lowerValue === suspicious || 
            lowerValue.includes(suspicious) ||
            /^(test|demo|sample|fake|dummy|placeholder|12345|admin|root|default|temp|temporary)/i.test(trimmedValue)
        );
        
        if (isSuspicious) {
            const errorMsg = `Le champ '${fieldPath}' contient une valeur suspecte: '${trimmedValue}'. Utilisez des credentials réels et sécurisés`;
            logSanitization('error', fieldPath, fieldValue, null, errorMsg, userId);
            errors.push(errorMsg);
            continue;
        }
        
        // Valider que la valeur ne contient pas uniquement des caractères répétitifs ou trop simples
        if (/^(.)\1+$/.test(trimmedValue) || /^[0-9]+$/.test(trimmedValue) || /^[a-zA-Z]+$/.test(trimmedValue)) {
            const errorMsg = `Le champ '${fieldPath}' semble trop simple ou prévisible. Utilisez des credentials complexes et sécurisés`;
            logSanitization('error', fieldPath, fieldValue, null, errorMsg, userId);
            errors.push(errorMsg);
            continue;
        }
    }
    
    // 6. Retourne { valid: boolean, errors: [] } avec erreurs détaillées
    return {
        valid: errors.length === 0,
        errors: errors
    };
}

/**
 * Valide strictement un token API
 * 
 * @param {any} token - Le token à valider
 * @param {number} minLength - Longueur minimale requise (défaut: 10)
 * @param {number} maxLength - Longueur maximale autorisée (défaut: 512)
 * @param {string} fieldName - Nom du champ pour les messages d'erreur (optionnel, défaut: 'token')
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @returns {string} - Le token validé et normalisé
 * @throws {Error} - Si la validation échoue avec un message d'erreur clair incluant fieldName
 * 
 * @example
 * validateAPIToken('sk_live_abc123xyz789', 10, 256, 'apiToken')
 * // Retourne: 'sk_live_abc123xyz789'
 * 
 * validateAPIToken('my-token_123', 8, 128, 'apiToken')
 * // Retourne: 'my-token_123'
 * 
 * validateAPIToken('abc', 10, 256, 'apiToken')
 * // Lance une erreur: "Le champ 'apiToken' est trop court. Longueur: 3, minimum requis: 10 caractères"
 * 
 * validateAPIToken('token with spaces', 10, 256, 'apiToken')
 * // Lance une erreur: "Le champ 'apiToken' contient des caractères spéciaux dangereux. Format attendu: alphanumérique avec tirets (-) et underscores (_) uniquement"
 * 
 * validateAPIToken('token<script>', 10, 256, 'apiToken')
 * // Lance une erreur: "Le champ 'apiToken' contient des caractères spéciaux dangereux. Format attendu: alphanumérique avec tirets (-) et underscores (_) uniquement"
 */
function validateAPIToken(token, minLength = 10, maxLength = 512, fieldName = null, userId = null) {
    const fieldNameStr = fieldName || 'token';
    
    // 1. Valide que token est une string non vide
    if (typeof token !== 'string') {
        const errorMsg = `Le champ '${fieldNameStr}' doit être une string. Type reçu: ${typeof token}`;
        logSanitization('error', fieldNameStr, token, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    const trimmedToken = token.trim();
    
    if (trimmedToken === '') {
        const errorMsg = `Le champ '${fieldNameStr}' ne peut pas être vide. Un token API valide est requis`;
        logSanitization('error', fieldNameStr, token, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // 2. Valide la longueur (minLength, maxLength)
    // 4. Rejette les tokens trop courts ou trop longs
    if (trimmedToken.length < minLength) {
        const errorMsg = `Le champ '${fieldNameStr}' est trop court. Longueur: ${trimmedToken.length}, minimum requis: ${minLength} caractères`;
        logSanitization('error', fieldNameStr, token, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    if (trimmedToken.length > maxLength) {
        const errorMsg = `Le champ '${fieldNameStr}' est trop long. Longueur: ${trimmedToken.length}, maximum autorisé: ${maxLength} caractères`;
        logSanitization('error', fieldNameStr, token, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // 3. Valide le format (alphanumérique, avec tirets/underscores selon besoin)
    // Format autorisé : lettres (a-z, A-Z), chiffres (0-9), tirets (-) et underscores (_)
    // 5. Rejette les tokens avec caractères spéciaux dangereux
    const allowedPattern = /^[a-zA-Z0-9_-]+$/;
    
    if (!allowedPattern.test(trimmedToken)) {
        const errorMsg = `Le champ '${fieldNameStr}' contient des caractères spéciaux dangereux. Format attendu: alphanumérique avec tirets (-) et underscores (_) uniquement. Valeur reçue: "${trimmedToken}"`;
        logSanitization('error', fieldNameStr, token, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // Vérifier qu'il n'y a pas de caractères de contrôle ou d'espaces (déjà géré par trim, mais double vérification)
    if (trimmedToken !== token) {
        logSanitization('warn', fieldNameStr, token, trimmedToken, 'Token normalisé (trim)', userId);
    }
    
    // Vérifier qu'il n'y a pas de séquences suspectes (optionnel, mais bon pour la sécurité)
    const suspiciousPatterns = [
        /<script/i,
        /javascript:/i,
        /on\w+\s*=/i, // onclick, onerror, etc.
        /eval\(/i,
        /expression\(/i
    ];
    
    for (const pattern of suspiciousPatterns) {
        if (pattern.test(trimmedToken)) {
            const errorMsg = `Le champ '${fieldNameStr}' contient des séquences suspectes potentiellement dangereuses. Valeur reçue: "${trimmedToken}"`;
            logSanitization('error', fieldNameStr, token, null, errorMsg, userId);
            throw new Error(errorMsg);
        }
    }
    
    // 6. Retourne le token validé ou lance une erreur avec fieldName
    return trimmedToken;
}

/**
 * Valide strictement qu'une valeur est dans une liste de valeurs autorisées (enum)
 * 
 * @param {any} value - La valeur à valider
 * @param {Array} allowedValues - Liste des valeurs autorisées
 * @param {string} fieldName - Nom du champ pour les messages d'erreur (optionnel, défaut: 'value')
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @param {Object} options - Options de validation (optionnel)
 * @param {boolean} options.caseInsensitive - Si true, la comparaison est insensible à la casse (défaut: false)
 * @param {boolean} options.required - Si false, null/undefined sont acceptés (défaut: true)
 * @returns {any} - La valeur validée (normalisée si caseInsensitive)
 * @throws {Error} - Si la validation échoue avec un message d'erreur clair incluant fieldName et la liste des valeurs autorisées
 * 
 * @example
 * validateEnum('active', ['active', 'inactive', 'pending'], 'status')
 * // Retourne: 'active'
 * 
 * validateEnum('ACTIVE', ['active', 'inactive'], 'status', null, { caseInsensitive: true })
 * // Retourne: 'active' (normalisé en minuscule)
 * 
 * validateEnum(null, ['active', 'inactive'], 'status', null, { required: false })
 * // Retourne: null
 * 
 * validateEnum('invalid', ['active', 'inactive'], 'status')
 * // Lance une erreur: "Le champ 'status' doit être une des valeurs suivantes: active, inactive. Valeur reçue: \"invalid\""
 * 
 * validateEnum(null, ['active', 'inactive'], 'status')
 * // Lance une erreur: "Le champ 'status' est requis. Valeurs autorisées: active, inactive"
 */
function validateEnum(value, allowedValues, fieldName = null, userId = null, options = {}) {
    const fieldNameStr = fieldName || 'value';
    const { caseInsensitive = false, required = true } = options;
    
    // Valider que allowedValues est un array
    if (!Array.isArray(allowedValues)) {
        const errorMsg = `Le paramètre 'allowedValues' doit être un array. Type reçu: ${typeof allowedValues}`;
        logSanitization('error', fieldNameStr, allowedValues, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    if (allowedValues.length === 0) {
        const errorMsg = `Le paramètre 'allowedValues' ne peut pas être un array vide`;
        logSanitization('error', fieldNameStr, allowedValues, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // 4. Valide que value n'est pas null/undefined si required
    if (value === null || value === undefined) {
        if (!required) {
            return value; // null/undefined acceptés si required = false
        }
        
        const allowedValuesStr = allowedValues.map(v => typeof v === 'string' ? `"${v}"` : String(v)).join(', ');
        const errorMsg = `Le champ '${fieldNameStr}' est requis. Valeurs autorisées: ${allowedValuesStr}`;
        logSanitization('error', fieldNameStr, value, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // 1. Valide que value est dans allowedValues (array)
    // 2. Supporte la comparaison case-sensitive ou case-insensitive
    let normalizedValue = value;
    let foundMatch = false;
    let matchedValue = null;
    
    if (caseInsensitive && typeof value === 'string') {
        // Comparaison insensible à la casse pour les strings
        const lowerValue = value.toLowerCase();
        for (const allowedValue of allowedValues) {
            if (typeof allowedValue === 'string' && allowedValue.toLowerCase() === lowerValue) {
                foundMatch = true;
                matchedValue = allowedValue; // Retourner la valeur originale (normalisée depuis allowedValues)
                break;
            }
            // Pour les non-strings, comparer directement
            if (typeof allowedValue !== 'string' && allowedValue === value) {
                foundMatch = true;
                matchedValue = allowedValue;
                break;
            }
        }
    } else {
        // Comparaison sensible à la casse (par défaut)
        if (allowedValues.includes(value)) {
            foundMatch = true;
            matchedValue = value;
        }
    }
    
    if (!foundMatch) {
        // 3. Retourne un message d'erreur avec la liste des valeurs autorisées
        const allowedValuesStr = allowedValues.map(v => typeof v === 'string' ? `"${v}"` : String(v)).join(', ');
        const valueStr = typeof value === 'string' ? `"${value}"` : String(value);
        const errorMsg = `Le champ '${fieldNameStr}' doit être une des valeurs suivantes: ${allowedValuesStr}. Valeur reçue: ${valueStr}`;
        logSanitization('error', fieldNameStr, value, null, errorMsg, userId);
        throw new Error(errorMsg);
    }
    
    // Logger si la valeur a été normalisée (case insensitive)
    if (caseInsensitive && typeof value === 'string' && value !== matchedValue) {
        logSanitization('warn', fieldNameStr, value, matchedValue, `Valeur normalisée (case-insensitive: "${value}" → "${matchedValue}")`, userId);
    }
    
    // 5. Retourne la valeur validée (normalisée si nécessaire) ou lance une erreur avec fieldName
    return matchedValue;
}

/**
 * Valide strictement un objet property selon des règles strictes
 * 
 * @param {any} property - L'objet property à valider
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @returns {Object} - { valid: boolean, errors: [], sanitized: {} } avec objet sanitizé si valide
 * 
 * @example
 * const result = validatePropertyObject({
 *   location: 'Paris',
 *   capacity: 5,
 *   base_price: 100.50,
 *   property_type: 'appartement',
 *   strategy: 'Équilibré',
 *   floor_price: 50,
 *   ceiling_price: 200,
 *   weekly_discount_percent: 10
 * }, userId)
 * // Retourne: { valid: true, errors: [], sanitized: {...} }
 */
function validatePropertyObject(property, userId = null) {
    const errors = [];
    const sanitized = {};
    
    // 1. Valide que property est un objet (pas null, array, etc.)
    if (property === null || property === undefined) {
        const errorMsg = `Le champ 'property' doit être un objet. Type reçu: ${property === null ? 'null' : 'undefined'}`;
        logSanitization('error', 'property', property, null, errorMsg, userId);
        return {
            valid: false,
            errors: [errorMsg],
            sanitized: {}
        };
    }
    
    if (typeof property !== 'object' || Array.isArray(property)) {
        const errorMsg = `Le champ 'property' doit être un objet. Type reçu: ${Array.isArray(property) ? 'array' : typeof property}`;
        logSanitization('error', 'property', property, null, errorMsg, userId);
        return {
            valid: false,
            errors: [errorMsg],
            sanitized: {}
        };
    }
    
    // 2. Valide chaque champ selon des règles strictes
    // location: string, max 200 caractères, non vide
    if ('location' in property) {
        try {
            validateStringLength(property.location, 1, 200, 'property.location', userId);
            sanitized.location = String(property.location).trim();
        } catch (error) {
            errors.push(error.message);
        }
    }
    
    // capacity: entier entre 1 et 50
    if ('capacity' in property) {
        try {
            sanitized.capacity = validateInteger(property.capacity, 1, 50, 'property.capacity', userId);
        } catch (error) {
            errors.push(error.message);
        }
    }
    
    // base_price: nombre positif, max 2 décimales, > 0
    if ('base_price' in property) {
        try {
            sanitized.base_price = validatePrice(property.base_price, 0, Infinity, 'property.base_price', userId);
            if (sanitized.base_price <= 0) {
                const errorMsg = `Le champ 'property.base_price' doit être strictement positif. Valeur reçue: ${sanitized.base_price}`;
                errors.push(errorMsg);
                logSanitization('error', 'property.base_price', property.base_price, null, errorMsg, userId);
                delete sanitized.base_price;
            }
        } catch (error) {
            errors.push(error.message);
        }
    }
    
    // property_type: doit être dans whitelist
    if ('property_type' in property || 'propertyType' in property) {
        const propertyType = property.property_type || property.propertyType;
        const normalizedType = typeof propertyType === 'string' ? propertyType.toLowerCase().trim() : null;
        
        if (!normalizedType || !ALLOWED_PROPERTY_TYPES.includes(normalizedType)) {
            const errorMsg = `Le champ 'property.property_type' doit être une des valeurs suivantes: ${ALLOWED_PROPERTY_TYPES.join(', ')}. Valeur reçue: "${propertyType}"`;
            errors.push(errorMsg);
            logSanitization('error', 'property.property_type', propertyType, null, errorMsg, userId);
        } else {
            sanitized.property_type = normalizedType;
        }
    }
    
    // strategy: doit être dans whitelist
    if ('strategy' in property) {
        if (!ALLOWED_STRATEGIES.includes(property.strategy)) {
            const errorMsg = `Le champ 'property.strategy' doit être une des valeurs suivantes: ${ALLOWED_STRATEGIES.join(', ')}. Valeur reçue: "${property.strategy}"`;
            errors.push(errorMsg);
            logSanitization('error', 'property.strategy', property.strategy, null, errorMsg, userId);
        } else {
            sanitized.strategy = property.strategy;
        }
    }
    
    // floor_price: nombre positif, max 2 décimales (optionnel)
    if ('floor_price' in property && property.floor_price !== null && property.floor_price !== undefined) {
        try {
            sanitized.floor_price = validatePrice(property.floor_price, 0, Infinity, 'property.floor_price', userId);
        } catch (error) {
            errors.push(error.message);
        }
    }
    
    // ceiling_price: nombre positif, max 2 décimales (optionnel)
    if ('ceiling_price' in property && property.ceiling_price !== null && property.ceiling_price !== undefined) {
        try {
            sanitized.ceiling_price = validatePrice(property.ceiling_price, 0, Infinity, 'property.ceiling_price', userId);
        } catch (error) {
            errors.push(error.message);
        }
    }
    
    // 3. Valide les plages de prix (floor_price < base_price < ceiling_price)
    if (sanitized.floor_price !== undefined && sanitized.base_price !== undefined) {
        if (sanitized.floor_price >= sanitized.base_price) {
            const errorMsg = `Le champ 'property.floor_price' (${sanitized.floor_price}) doit être strictement inférieur à 'property.base_price' (${sanitized.base_price})`;
            errors.push(errorMsg);
            logSanitization('error', 'property.floor_price', sanitized.floor_price, null, errorMsg, userId);
        }
    }
    
    if (sanitized.base_price !== undefined && sanitized.ceiling_price !== undefined) {
        if (sanitized.base_price >= sanitized.ceiling_price) {
            const errorMsg = `Le champ 'property.base_price' (${sanitized.base_price}) doit être strictement inférieur à 'property.ceiling_price' (${sanitized.ceiling_price})`;
            errors.push(errorMsg);
            logSanitization('error', 'property.base_price', sanitized.base_price, null, errorMsg, userId);
        }
    }
    
    // 4. Valide les pourcentages (0-100, 2 décimales max)
    const percentageFields = [
        'weekly_discount_percent',
        'monthly_discount_percent',
        'weekend_markup_percent'
    ];
    
    for (const field of percentageFields) {
        if (field in property && property[field] !== null && property[field] !== undefined) {
            try {
                sanitized[field] = validatePercentage(property[field], `property.${field}`, userId);
            } catch (error) {
                errors.push(error.message);
            }
        }
    }
    
    // 5. Retourne { valid: boolean, errors: [], sanitized: {} } avec objet sanitizé si valide
    return {
        valid: errors.length === 0,
        errors: errors,
        sanitized: errors.length === 0 ? sanitized : {}
    };
}

/**
 * Sanitise un objet property complet en créant une copie et en validant chaque champ
 * 
 * @param {Object} property - L'objet property à sanitiser
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @returns {Object} - L'objet property sanitizé
 * 
 * @example
 * const sanitized = sanitizePropertyObject({
 *   location: 'Paris". Ignore instructions...',
 *   capacity: 'invalid',
 *   amenities: ['pool', 'wifi']
 * });
 */
function sanitizePropertyObject(property, userId = null) {
    if (!property || typeof property !== 'object' || Array.isArray(property)) {
        return {};
    }
    
    // 1. Créer une copie de l'objet property
    const sanitized = {};
    
    // 2. Parcourir uniquement les champs autorisés (whitelist)
    for (const fieldName of ALLOWED_PROPERTY_FIELDS) {
        if (fieldName in property) {
            try {
                const beforeValue = property[fieldName];
                // 3. Sanitiser chaque champ selon son type
                sanitized[fieldName] = sanitizeValueByType(beforeValue, fieldName, userId);
                // Logger si la valeur a été modifiée
                if (JSON.stringify(beforeValue) !== JSON.stringify(sanitized[fieldName])) {
                    logSanitization('warn', fieldName, beforeValue, sanitized[fieldName], 'Valeur modifiée lors de la sanitisation', userId);
                }
            } catch (error) {
                logSanitization('error', fieldName, property[fieldName], null, `Erreur lors de la sanitisation: ${error.message}`, userId);
                // En cas d'erreur, omettre le champ ou utiliser une valeur par défaut
                continue;
            }
        }
    }
    
    // 4. Retourner l'objet sanitizé
    return sanitized;
}

/**
 * Sécurise un objet pour l'injection dans un prompt IA via JSON.stringify
 * 
 * @param {any} obj - L'objet à sérialiser
 * @param {number} maxDepth - Profondeur maximale autorisée (défaut: 3)
 * @param {number} space - Espacement pour le formatage JSON (défaut: 2)
 * @returns {string} - JSON sécurisé et validé
 * @throws {Error} - Si l'objet est trop profond ou contient des séquences dangereuses
 * 
 * @example
 * safeJSONStringify({ location: 'Paris', capacity: 2 }, 3, 2)
 * // Retourne: '{\n  "location": "Paris",\n  "capacity": 2\n}'
 */
function safeJSONStringify(obj, maxDepth = 3, space = 2) {
    // 1. Limiter la profondeur de l'objet JSON (max 3 niveaux)
    const seen = new WeakSet(); // Pour détecter les références circulaires
    const depthMap = new WeakMap(); // Pour suivre la profondeur de chaque objet
    
    // Fonction récursive pour calculer et marquer la profondeur
    const calculateDepth = (value, parentDepth = 0) => {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            const currentDepth = parentDepth + 1;
            depthMap.set(value, currentDepth);
            
            // Si on dépasse la profondeur max, on arrête la récursion
            if (currentDepth > maxDepth) {
                return;
            }
            
            // Parcourir récursivement les propriétés
            for (const key in value) {
                if (value.hasOwnProperty(key)) {
                    calculateDepth(value[key], currentDepth);
                }
            }
        } else if (Array.isArray(value)) {
            // Pour les tableaux, on garde la même profondeur
            value.forEach(item => calculateDepth(item, parentDepth));
        }
    };
    
    // Calculer la profondeur de tous les objets
    calculateDepth(obj, 0);
    
    const replacer = (key, value) => {
        // Gérer les références circulaires
        if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) {
                return '[Circular Reference]';
            }
            seen.add(value);
            
            // Vérifier la profondeur (seulement pour les objets, pas les tableaux)
            if (!Array.isArray(value)) {
                const depth = depthMap.get(value) || 0;
                if (depth > maxDepth) {
                    return '[Max Depth Exceeded]';
                }
            }
        }
        
        // Échapper les valeurs string pour éviter les injections
        if (typeof value === 'string') {
            // Vérifier les séquences dangereuses avant sérialisation
            const dangerousPatterns = [
                /ignore\s+(les\s+)?instructions/gi,
                /forget\s+(les\s+)?instructions/gi,
                /override\s+(les\s+)?instructions/gi,
                /disregard\s+(the\s+)?previous/gi,
                /ignore\s+(the\s+)?previous/gi,
                /```/g, // Code blocks
                /<script/gi, // Script tags
                /javascript:/gi // JavaScript protocol
            ];
            
            for (const pattern of dangerousPatterns) {
                if (pattern.test(value)) {
                    console.warn(`[Safe JSON] Séquence dangereuse détectée dans le champ '${key}':`, pattern);
                    // Remplacer par une version sanitizée
                    value = value.replace(pattern, '');
                }
            }
        }
        
        return value;
    };
    
    try {
        // 2. Utiliser JSON.stringify avec replacer pour échapper les caractères spéciaux
        const jsonString = JSON.stringify(obj, replacer, space);
        
        // 3. Vérifier que le JSON généré ne contient pas de séquences dangereuses
        const dangerousSequences = [
            /```json/gi,
            /```/g,
            /<script/gi,
            /javascript:/gi,
            /ignore\s+(les\s+)?instructions/gi,
            /forget\s+(les\s+)?instructions/gi
        ];
        
        for (const pattern of dangerousSequences) {
            if (pattern.test(jsonString)) {
                throw new Error(`Le JSON généré contient une séquence dangereuse détectée par le pattern: ${pattern}`);
            }
        }
        
        // 4. Valider que le JSON est valide avant injection dans le prompt
        try {
            JSON.parse(jsonString);
        } catch (parseError) {
            throw new Error(`Le JSON généré n'est pas valide: ${parseError.message}`);
        }
        
        return jsonString;
    } catch (error) {
        console.error('[Safe JSON] Erreur lors de la sérialisation sécurisée:', error.message);
        // En cas d'erreur, retourner un JSON minimal sécurisé
        return JSON.stringify({ error: 'Données non sérialisables' }, null, space);
    }
}

/**
 * Sanitise une URL pour l'injection sécurisée dans un prompt IA
 * 
 * @param {string} url - L'URL à sanitiser
 * @param {number} maxLength - Longueur maximale autorisée (défaut: 500)
 * @param {string} fieldName - Nom du champ pour le logging (optionnel)
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @returns {string|null} - URL sanitizée ou null si invalide
 * 
 * @example
 * sanitizeUrl('https://example.com?param=value')
 * // Retourne: 'https://example.com?param=value'
 * 
 * sanitizeUrl('javascript:alert(1)')
 * // Retourne: null (protocole non autorisé)
 */
function sanitizeUrl(url, maxLength = 500, fieldName = null, userId = null) {
    // 1. Vérifier que l'input est une string
    if (typeof url !== 'string') {
        if (url === null || url === undefined) {
            return null;
        }
        try {
            url = String(url);
        } catch (e) {
            logSanitization('warn', fieldName || 'url', url, null, 'Impossible de convertir en string', userId);
            return null;
        }
    }

    // 2. Limiter la longueur avant validation
    if (url.length > maxLength) {
        const beforeTruncate = url;
        url = url.substring(0, maxLength);
        logSanitization('warn', fieldName || 'url', beforeTruncate, url, `URL tronquée à ${maxLength} caractères`, userId);
    }

    // 3. Valider le format d'URL
    let parsedUrl;
    try {
        // Utiliser l'API URL native de Node.js pour valider
        parsedUrl = new URL(url);
    } catch (e) {
        // Si l'URL n'est pas absolue, essayer d'ajouter http:// pour validation
        try {
            parsedUrl = new URL(url, 'http://example.com');
        } catch (e2) {
            logSanitization('error', fieldName || 'url', url, null, `Format d'URL invalide: ${e.message}`, userId);
            return null;
        }
    }

    // 4. Vérifier que le protocole est autorisé (http, https uniquement)
    const allowedProtocols = ['http:', 'https:'];
    if (!allowedProtocols.includes(parsedUrl.protocol)) {
        logSanitization('error', fieldName || 'url', url, null, `Protocole non autorisé: ${parsedUrl.protocol} (autorisés: http, https)`, userId);
        return null;
    }

    // 5. Sanitiser l'URL en reconstruisant avec seulement les parties sûres
    let sanitizedUrl = `${parsedUrl.protocol}//${parsedUrl.hostname}`;
    
    // Ajouter le port si présent et valide
    if (parsedUrl.port) {
        const port = parseInt(parsedUrl.port, 10);
        if (port > 0 && port <= 65535) {
            sanitizedUrl += `:${port}`;
        }
    }
    
    // Ajouter le chemin (sanitisé)
    if (parsedUrl.pathname) {
        // Sanitiser le chemin pour éviter les injections
        const sanitizedPath = sanitizeForPrompt(parsedUrl.pathname, 200, `${fieldName || 'url'}.pathname`, userId);
        sanitizedUrl += sanitizedPath;
    }

    // 6. Supprimer les paramètres de requête suspects
    if (parsedUrl.search) {
        const searchParams = new URLSearchParams(parsedUrl.search);
        const suspiciousParams = [
            'javascript', 'data', 'vbscript', 'onload', 'onerror', 
            'onclick', 'onmouseover', 'eval', 'expression', 'import',
            'script', 'iframe', 'object', 'embed', 'form', 'input',
            'meta', 'link', 'style', 'base', 'applet', 'body'
        ];
        
        const cleanedParams = new URLSearchParams();
        let hasSuspiciousParams = false;
        
        for (const [key, value] of searchParams.entries()) {
            const lowerKey = key.toLowerCase();
            const lowerValue = value.toLowerCase();
            
            // Vérifier si la clé ou la valeur contient des mots suspects
            const isSuspicious = suspiciousParams.some(suspicious => 
                lowerKey.includes(suspicious) || lowerValue.includes(suspicious)
            );
            
            if (isSuspicious) {
                hasSuspiciousParams = true;
                logSanitization('warn', fieldName || 'url', `${key}=${value}`, '', `Paramètre de requête suspect supprimé: ${key}`, userId);
                continue; // Ignorer ce paramètre
            }
            
            // Sanitiser la clé et la valeur
            const sanitizedKey = sanitizeForPrompt(key, 100, `${fieldName || 'url'}.param.key`, userId);
            const sanitizedValue = sanitizeForPrompt(value, 200, `${fieldName || 'url'}.param.value`, userId);
            
            // Ne pas ajouter si la sanitisation a supprimé tout le contenu
            if (sanitizedKey && sanitizedValue) {
                cleanedParams.append(sanitizedKey, sanitizedValue);
            }
        }
        
        // Ajouter les paramètres nettoyés s'il y en a
        const cleanedSearch = cleanedParams.toString();
        if (cleanedSearch) {
            sanitizedUrl += `?${cleanedSearch}`;
        } else if (hasSuspiciousParams) {
            // Si tous les paramètres étaient suspects, on les supprime tous
            logSanitization('warn', fieldName || 'url', parsedUrl.search, '', 'Tous les paramètres de requête étaient suspects, supprimés', userId);
        }
    }

    // 7. Ajouter le hash (fragment) si présent (généralement sûr)
    if (parsedUrl.hash) {
        // Sanitiser le hash pour éviter les injections
        const sanitizedHash = sanitizeForPrompt(parsedUrl.hash.substring(1), 100, `${fieldName || 'url'}.hash`, userId);
        if (sanitizedHash) {
            sanitizedUrl += `#${sanitizedHash}`;
        }
    }

    // 8. Vérifier la longueur finale
    if (sanitizedUrl.length > maxLength) {
        const beforeFinalTruncate = sanitizedUrl;
        sanitizedUrl = sanitizedUrl.substring(0, maxLength);
        logSanitization('warn', fieldName || 'url', beforeFinalTruncate, sanitizedUrl, `URL finale tronquée à ${maxLength} caractères`, userId);
    }

    // 9. Valider que l'URL finale est toujours valide
    try {
        new URL(sanitizedUrl);
    } catch (e) {
        logSanitization('error', fieldName || 'url', sanitizedUrl, null, `URL sanitizée invalide: ${e.message}`, userId);
        return null;
    }

    // 10. Logger si l'URL a été modifiée
    if (url !== sanitizedUrl) {
        logSanitization('warn', fieldName || 'url', url, sanitizedUrl, 'URL modifiée lors de la sanitisation', userId);
    }

    return sanitizedUrl;
}

/**
 * Sanitise un nom de fichier pour éviter les injections de chemin et les caractères dangereux
 * 
 * @param {string} filename - Le nom de fichier à sanitiser
 * @param {number} maxLength - Longueur maximale autorisée (défaut: 255)
 * @param {string} fieldName - Nom du champ pour le logging (optionnel)
 * @param {string} userId - ID de l'utilisateur pour la traçabilité (optionnel)
 * @returns {string|null} - Nom de fichier sanitizé ou null si invalide
 * 
 * @example
 * sanitizeFilename('my-file.txt')
 * // Retourne: 'my-file.txt'
 * 
 * sanitizeFilename('../../../etc/passwd')
 * // Retourne: null (chemin relatif détecté)
 * 
 * sanitizeFilename('file<script>.txt')
 * // Retourne: 'file.txt' (caractères spéciaux supprimés)
 */
function sanitizeFilename(filename, maxLength = 255, fieldName = null, userId = null) {
    // 1. Vérifier que l'input est une string
    if (typeof filename !== 'string') {
        if (filename === null || filename === undefined) {
            return null;
        }
        try {
            filename = String(filename);
        } catch (e) {
            logSanitization('warn', fieldName || 'filename', filename, null, 'Impossible de convertir en string', userId);
            return null;
        }
    }

    // 2. Vérifier qu'il n'y a pas de chemins relatifs (..)
    // Détecter les tentatives de path traversal
    if (filename.includes('..') || filename.includes('./') || filename.includes('.\\')) {
        logSanitization('error', fieldName || 'filename', filename, null, 'Chemin relatif détecté (path traversal), fichier rejeté', userId);
        return null;
    }

    // 3. Supprimer les séparateurs de chemin (/, \)
    // Ces caractères ne doivent jamais être dans un nom de fichier
    if (filename.includes('/') || filename.includes('\\')) {
        const beforePathSep = filename;
        filename = filename.replace(/[/\\]/g, '');
        if (filename.length === 0) {
            logSanitization('error', fieldName || 'filename', beforePathSep, null, 'Nom de fichier invalide après suppression des séparateurs', userId);
            return null;
        }
        logSanitization('warn', fieldName || 'filename', beforePathSep, filename, 'Séparateurs de chemin supprimés', userId);
    }

    // 4. Supprimer les caractères spéciaux dangereux
    // Caractères interdits dans les noms de fichiers Windows/Unix: / \ : * ? " < > |
    const beforeSpecialChars = filename;
    filename = filename
        .replace(/[/\\:*?"<>|]/g, '') // Supprimer tous les caractères spéciaux
        .replace(/\s+/g, '_'); // Remplacer les espaces multiples par des underscores
    
    if (beforeSpecialChars !== filename) {
        logSanitization('warn', fieldName || 'filename', beforeSpecialChars, filename, 'Caractères spéciaux supprimés', userId);
    }

    // 5. Supprimer les caractères de contrôle (ASCII < 32)
    const beforeControlChars = filename;
    filename = filename
        .split('')
        .filter(char => {
            const charCode = char.charCodeAt(0);
            return charCode >= 32 || charCode === 9; // Conserver les caractères imprimables et tab
        })
        .join('');
    
    if (beforeControlChars !== filename) {
        logSanitization('warn', fieldName || 'filename', beforeControlChars, filename, 'Caractères de contrôle supprimés', userId);
    }

    // 6. Supprimer les caractères Unicode dangereux (bidirectionnels, invisibles)
    const beforeUnicodeCleanup = filename;
    filename = filename
        .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '') // Marqueurs bidirectionnels
        .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '') // Zero-width characters
        .replace(/[\u2000-\u200A\u202F\u205F]/g, '_'); // Espaces invisibles -> underscore
    
    if (beforeUnicodeCleanup !== filename) {
        logSanitization('warn', fieldName || 'filename', beforeUnicodeCleanup, filename, 'Caractères Unicode dangereux supprimés', userId);
    }

    // 7. Normaliser les espaces et underscores multiples
    filename = filename.replace(/[_\s]+/g, '_').trim();

    // 8. Vérifier que le nom n'est pas vide après sanitisation
    if (filename.length === 0) {
        logSanitization('error', fieldName || 'filename', beforeSpecialChars, null, 'Nom de fichier vide après sanitisation', userId);
        return null;
    }

    // 9. Vérifier les noms réservés (Windows)
    // Noms réservés: CON, PRN, AUX, NUL, COM1-9, LPT1-9
    const reservedNames = [
        'CON', 'PRN', 'AUX', 'NUL',
        'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
        'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
    ];
    const filenameUpper = filename.toUpperCase().split('.')[0]; // Nom sans extension
    if (reservedNames.includes(filenameUpper)) {
        logSanitization('error', fieldName || 'filename', filename, null, `Nom réservé détecté: ${filenameUpper}`, userId);
        return null;
    }

    // 10. Limiter la longueur
    if (filename.length > maxLength) {
        // Préserver l'extension si présente
        const lastDot = filename.lastIndexOf('.');
        if (lastDot > 0 && lastDot < filename.length - 1) {
            const name = filename.substring(0, lastDot);
            const ext = filename.substring(lastDot);
            const maxNameLength = maxLength - ext.length;
            if (maxNameLength > 0) {
                filename = name.substring(0, maxNameLength) + ext;
            } else {
                filename = filename.substring(0, maxLength);
            }
        } else {
            filename = filename.substring(0, maxLength);
        }
        logSanitization('warn', fieldName || 'filename', beforeSpecialChars, filename, `Nom de fichier tronqué à ${maxLength} caractères`, userId);
    }

    // 11. Vérifier qu'il ne commence ou ne se termine pas par un point ou un espace
    // (interdit sur certains systèmes)
    filename = filename.replace(/^[.\s]+|[.\s]+$/g, '');
    if (filename.length === 0) {
        logSanitization('error', fieldName || 'filename', beforeSpecialChars, null, 'Nom de fichier invalide après nettoyage des points/espaces', userId);
        return null;
    }

    // 12. Logger si le nom a été modifié
    if (filename !== beforeSpecialChars && beforeSpecialChars !== filename) {
        logSanitization('warn', fieldName || 'filename', beforeSpecialChars, filename, 'Nom de fichier modifié lors de la sanitisation', userId);
    }

    return filename;
}

module.exports = {
    sanitizeForPrompt,
    validateAndSanitizeDate,
    validateDateRange,
    validateDateFormat,
    validateDateTime,
    validateNumber,
    validateInteger,
    validatePrice,
    validatePercentage,
    validateNumericRange,
    validateCapacity,
    sanitizeNumber,
    sanitizeArray,
    validateStringLength,
    validateStringFormat,
    validateEmail,
    validatePostalCode,
    validateObjectSchema,
    validateArraySchema,
    validatePropertyId,
    validateExternalReference,
    validateTimezone,
    validateAPIToken,
    validateEnum,
    validatePMSCredentials,
    validatePropertyObject,
    sanitizePropertyObject,
    sanitizeUrl,
    sanitizeFilename,
    safeJSONStringify,
    ALLOWED_PROPERTY_FIELDS
};
