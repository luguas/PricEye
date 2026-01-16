/**
 * Module de sécurité pour le moteur de pricing.
 * Agit comme un pare-feu final avant l'application d'un prix.
 */

/**
 * Valide et corrige un prix proposé par l'IA ou un algorithme.
 * @param {number|string} proposedPrice - Le prix suggéré par l'IA
 * @param {Object} context - Le contexte de la propriété
 * @param {number} context.base_price - Le prix de base de la propriété (obligatoire)
 * @param {number} [context.min_price] - Le prix minimum absolu (Hard Limit)
 * @param {number} [context.max_price] - Le prix maximum absolu (Hard Limit)
 * @param {boolean} [context.allow_override=false] - Si true, ignore le sanity check (50%)
 * @param {number} [context.sanity_threshold=0.5] - Pourcentage de variation autorisé (défaut 50%)
 * @returns {{ safePrice: number, wasAdjusted: boolean, reason: string }}
 */
function validatePrice(proposedPrice, context) {
    const {
        base_price,
        min_price = 0,
        max_price = Infinity,
        allow_override = false,
        sanity_threshold = 0.5 // 50% de variation max par défaut
    } = context;

    // Conversion en nombres pour éviter les erreurs de comparaison string vs number
    let safePrice = parseFloat(proposedPrice);
    const basePriceNum = parseFloat(base_price);
    const minPriceNum = parseFloat(min_price);
    const maxPriceNum = parseFloat(max_price);

    // 1. ANTI-CRASH : Vérification des entrées invalides
    if (isNaN(safePrice) || safePrice <= 0) {
        console.warn(`[SAFETY_GUARD] CRITICAL: Prix proposé invalide (${proposedPrice}). Fallback sur prix de base.`);
        return {
            safePrice: basePriceNum,
            wasAdjusted: true,
            reason: 'CRITICAL_INVALID_INPUT'
        };
    }

    if (isNaN(basePriceNum)) {
        console.error(`[SAFETY_GUARD] CRITICAL: Prix de base manquant ou invalide. Impossible de valider.`);
        // En dernier recours, on renvoie le prix proposé s'il est valide, sinon 0 (ce qui devrait être géré plus haut)
        return {
            safePrice: safePrice > 0 ? safePrice : 0,
            wasAdjusted: false, 
            reason: 'MISSING_BASE_PRICE_CONTEXT'
        };
    }

    // 2. HARD LIMITS : Respect strict des bornes min/max définies par l'utilisateur
    if (safePrice < minPriceNum) {
        console.warn(`[SAFETY_GUARD] Prix (${safePrice}) inférieur au minimum (${minPriceNum}). Ajustement.`);
        return {
            safePrice: minPriceNum,
            wasAdjusted: true,
            reason: 'BELOW_MIN_LIMIT'
        };
    }

    if (safePrice > maxPriceNum) {
        console.warn(`[SAFETY_GUARD] Prix (${safePrice}) supérieur au maximum (${maxPriceNum}). Ajustement.`);
        return {
            safePrice: maxPriceNum,
            wasAdjusted: true,
            reason: 'ABOVE_MAX_LIMIT'
        };
    }

    // 3. SANITY CHECK : Détection de volatilité suspecte
    // On ne vérifie que si l'override n'est pas activé
    if (!allow_override) {
        const diff = Math.abs(safePrice - basePriceNum);
        const percentageDiff = diff / basePriceNum;

        if (percentageDiff > sanity_threshold) {
            // Calcul de la borne la plus proche (plafond ou plancher de sécurité)
            const isTooHigh = safePrice > basePriceNum;
            
            // Si trop haut : Prix de base + 50%
            // Si trop bas : Prix de base - 50%
            const clampedPrice = isTooHigh 
                ? basePriceNum * (1 + sanity_threshold)
                : basePriceNum * (1 - sanity_threshold);

            console.warn(`[SAFETY_GUARD] Volatilité suspecte détectée (+/- ${(percentageDiff * 100).toFixed(0)}%). Ajusté de ${safePrice} vers ${clampedPrice}.`);
            
            return {
                safePrice: Number(clampedPrice.toFixed(2)), // Arrondi propre
                wasAdjusted: true,
                reason: isTooHigh ? 'SANITY_CHECK_TOO_HIGH' : 'SANITY_CHECK_TOO_LOW'
            };
        }
    }

    // 4. Si tout va bien
    return {
        safePrice: Number(safePrice.toFixed(2)), // Toujours renvoyer un nombre arrondi à 2 décimales
        wasAdjusted: false,
        reason: 'VALID'
    };
}

module.exports = { validatePrice };
