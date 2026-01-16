/**
 * Module de sanitization stricte pour les entrées du moteur de pricing.
 * Version "Zero-Dependency" (Native JS).
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
 */
function sanitizePropertyId(id) {
  if (!id || typeof id !== 'string') {
    throw new ValidationError("L'ID de propriété est requis et doit être une chaîne.", "propertyId");
  }
  const cleanId = id.trim();
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const alphaNumRegex = /^[a-zA-Z0-9]+$/;

  if (!uuidRegex.test(cleanId) && !alphaNumRegex.test(cleanId)) {
    throw new ValidationError("Format d'ID invalide (UUID ou Alphanumérique requis).", "propertyId");
  }
  if (cleanId.length > 64) throw new ValidationError("ID trop long.", "propertyId");

  return cleanId;
}

/**
 * Valide une date au format YYYY-MM-DD (Sans date-fns)
 */
function sanitizeDate(dateStr, allowPast = false) {
  if (!dateStr || typeof dateStr !== 'string') {
    throw new ValidationError("La date est requise (format YYYY-MM-DD).", "date");
  }

  // 1. Vérification Regex stricte YYYY-MM-DD
  const formatRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!formatRegex.test(dateStr)) {
    throw new ValidationError("Format de date invalide. Attendu: YYYY-MM-DD", "date");
  }

  // 2. Vérification de la validité réelle (ex: pas de 30 février)
  const [year, month, day] = dateStr.split('-').map(Number);
  // Note: en JS, month est indexé de 0 à 11
  const dateObj = new Date(year, month - 1, day);

  if (
    dateObj.getFullYear() !== year || 
    dateObj.getMonth() !== month - 1 || 
    dateObj.getDate() !== day
  ) {
    throw new ValidationError("Date invalide (jour inexistant).", "date");
  }

  // 3. Vérification temporelle (pas dans le passé)
  if (!allowPast) {
    const today = new Date();
    today.setHours(0, 0, 0, 0); // On remet l'heure à minuit pour comparer juste les jours
    
    // On compare avec dateObj (qui est aussi à minuit par défaut via le constructeur new Date(y,m,d))
    if (dateObj < today) {
      throw new ValidationError("La date ne peut pas être dans le passé.", "date");
    }
  }

  return dateStr;
}

/**
 * Whitelist et typage des paramètres de pricing
 */
function sanitizePricingParams(params) {
  if (!params || typeof params !== 'object') return {};
  const cleanParams = {};

  const whitelist = {
    'min_price': (v) => Math.max(0, parseFloat(v)),
    'max_price': (v) => Math.max(0, parseFloat(v)),
    'base_price': (v) => Math.max(0, parseFloat(v)),
    'floor_price': (v) => Math.max(0, parseFloat(v)),
    'ceiling_price': (v) => Math.max(0, parseFloat(v)),
    'sensitivity': (v) => parseFloat(v),
    'occupancy_target': (v) => Math.min(100, Math.max(0, parseInt(v, 10))),
    'strategy': (v) => {
        const allowed = ['conservative', 'balanced', 'aggressive', 'custom'];
        const normalized = String(v).toLowerCase();
        return allowed.includes(normalized) ? normalized : 'balanced';
    }
  };

  Object.keys(params).forEach(key => {
    if (whitelist[key] !== undefined && params[key] !== undefined && params[key] !== null) {
      try {
        const val = whitelist[key](params[key]);
        if (typeof val === 'number' && !isNaN(val)) {
            cleanParams[key] = val;
        } else if (typeof val === 'string') {
            cleanParams[key] = val;
        }
      } catch (e) {}
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
