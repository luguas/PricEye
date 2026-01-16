const { parseISO, isBefore, isValid, startOfDay } = require('date-fns');

/**
 * Module de sanitization stricte pour les entrées du moteur de pricing.
 * Empêche les injections et garantit l'intégrité des types.
 */

class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
  }
}

/**
 * Valide un ID de propriété (UUID v4 ou Alphanumérique strict)
 * @param {string} id 
 * @returns {string} L'ID nettoyé
 */
function sanitizePropertyId(id) {
  if (!id || typeof id !== 'string') {
    throw new ValidationError("L'ID de propriété est requis et doit être une chaîne.", "propertyId");
  }

  // Nettoyage basique
  const cleanId = id.trim();

  // Regex UUID v4 (Standard Supabase)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  // Regex Alphanumérique (Fallback pour IDs legacy ou tests)
  const alphaNumRegex = /^[a-zA-Z0-9]+$/;

  if (!uuidRegex.test(cleanId) && !alphaNumRegex.test(cleanId)) {
    throw new ValidationError("Format d'ID invalide (UUID ou Alphanumérique requis).", "propertyId");
  }

  // Protection supplémentaire contre la longueur excessive (Buffer Overflow prevention)
  if (cleanId.length > 64) {
    throw new ValidationError("ID trop long.", "propertyId");
  }

  return cleanId;
}

/**
 * Valide une date au format YYYY-MM-DD et vérifie qu'elle n'est pas passée
 * @param {string} dateStr 
 * @param {boolean} allowPast - Si false, rejette les dates passées (par défaut)
 * @returns {string} La date validée
 */
function sanitizeDate(dateStr, allowPast = false) {
  if (!dateStr || typeof dateStr !== 'string') {
    throw new ValidationError("La date est requise (format YYYY-MM-DD).", "date");
  }

  // Vérification format strict YYYY-MM-DD
  const formatRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!formatRegex.test(dateStr)) {
    throw new ValidationError("Format de date invalide. Attendu: YYYY-MM-DD", "date");
  }

  const dateObj = parseISO(dateStr);
  
  if (!isValid(dateObj)) {
    throw new ValidationError("Date inexistante ou invalide.", "date");
  }

  // Vérification temporelle (pas dans le passé)
  if (!allowPast) {
    const today = startOfDay(new Date()); // Début de la journée actuelle (00:00:00)
    const checkDate = startOfDay(dateObj);
    
    if (isBefore(checkDate, today)) {
      throw new ValidationError("La date ne peut pas être dans le passé.", "date");
    }
  }

  return dateStr; // On renvoie la string d'origine validée
}

/**
 * Whitelist et typage des paramètres de pricing
 * @param {Object} params - Objet brut (req.body)
 * @returns {Object} Objet nettoyé contenant uniquement les champs autorisés
 */
function sanitizePricingParams(params) {
  if (!params || typeof params !== 'object') return {};

  const cleanParams = {};

  // Définition des champs autorisés et leur transformateur
  const whitelist = {
    // Nombres flottants (Prix)
    'min_price': (v) => Math.max(0, parseFloat(v)),
    'max_price': (v) => Math.max(0, parseFloat(v)),
    'base_price': (v) => Math.max(0, parseFloat(v)),
    'floor_price': (v) => Math.max(0, parseFloat(v)),
    'ceiling_price': (v) => Math.max(0, parseFloat(v)),
    
    // Pourcentages / Facteurs (0-1 ou 0-100)
    'sensitivity': (v) => parseFloat(v),
    'occupancy_target': (v) => Math.min(100, Math.max(0, parseInt(v, 10))),
    
    // Chaînes spécifiques (Enum)
    'strategy': (v) => {
        const allowed = ['conservative', 'balanced', 'aggressive', 'custom'];
        // Mapping simple si l'input est différent (ex: majuscules)
        const normalized = String(v).toLowerCase();
        return allowed.includes(normalized) ? normalized : 'balanced';
    }
  };

  Object.keys(params).forEach(key => {
    if (whitelist[key] !== undefined && params[key] !== undefined && params[key] !== null) {
      try {
        const val = whitelist[key](params[key]);
        // On ne garde que si le résultat n'est pas NaN
        if (typeof val === 'number' && !isNaN(val)) {
            cleanParams[key] = val;
        } else if (typeof val === 'string') {
            cleanParams[key] = val;
        }
      } catch (e) {
        // En cas d'erreur de conversion, on ignore le champ (fail-safe)
      }
    }
  });

  return cleanParams;
}

module.exports = {
  sanitizePropertyId,
  sanitizeDate,
  sanitizePricingParams,
  ValidationError
};
