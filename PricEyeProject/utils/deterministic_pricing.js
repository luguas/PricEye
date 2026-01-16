/**
 * Moteur de pricing déterministe basé sur les données structurées du marché
 * Version améliorée avec Saisonnalité Synthétique et Génération de Calendrier.
 */

const { supabase } = require('../config/supabase');
const { getDatesBetween } = require('./dateUtils'); // Assurez-vous que ce fichier existe

/**
 * Calcule un multiplicateur de saisonnalité simple (Sinusoïdale)
 * Pico en Août (été) et Décembre (fêtes), Creux en Novembre/Février
 */
function getSeasonalityMultiplier(dateStr) {
    const date = new Date(dateStr);
    const month = date.getMonth(); // 0 = Janvier, 11 = Décembre
    
    // Facteurs mensuels approximatifs (Hémisphère Nord)
    const factors = [0.90, 0.90, 1.00, 1.05, 1.10, 1.20, 1.30, 1.35, 1.15, 1.00, 0.85, 1.25];
    
    return factors[month] || 1.0;
}

/**
 * Calcule le prix pour UNE SEULE date donnée
 */
async function calculateDeterministicPrice({ property, date, marketFeatures = null, city, country }) {
    // Valeurs par défaut sécurisées
    const basePrice = Number(property.base_price) || 100;
    const floorPrice = Number(property.floor_price) || Math.round(basePrice * 0.7);
    const ceilingPrice = Number(property.ceiling_price) || Math.round(basePrice * 3);
    
    // --- 1. DONNÉES MARCHÉ (Récupération optionnelle) ---
    if (!marketFeatures && city && country) {
        const { data, error } = await supabase
            .from('market_features')
            .select('*')
            .eq('country', country)
            .eq('city', city)
            .eq('date', date)
            .maybeSingle();
        
        if (!error && data) {
            marketFeatures = data;
        }
    }
    
    let currentPrice = basePrice;
    const breakdown = {
        base: basePrice,
        seasonality: 0,
        details: [] 
    };
    
    // --- 2. SAISONNALITÉ (Le cœur de la variation) ---
    const seasonalityMult = getSeasonalityMultiplier(date);
    const seasonalPrice = basePrice * seasonalityMult;
    breakdown.seasonality = seasonalPrice - basePrice;
    currentPrice = seasonalPrice;
    
    if (seasonalityMult > 1.05) breakdown.details.push(`Haute saison (+${Math.round((seasonalityMult-1)*100)}%)`);
    else if (seasonalityMult < 0.95) breakdown.details.push(`Basse saison (${Math.round((seasonalityMult-1)*100)}%)`);

    // --- 3. WEEK-END (Variation Hebdomadaire) ---
    const targetDate = new Date(date);
    const weekday = targetDate.getDay(); // 0=Dim, 6=Sam
    const isWeekend = (weekday === 5 || weekday === 6); // Vendredi et Samedi
    
    // La bonne façon de récupérer le markup, avec une valeur par défaut de 15%
    const weekendMarkup = property.weekend_markup_percent !== undefined 
        ? Number(property.weekend_markup_percent) 
        : 15; 
    
    // Si property.weekend_markup_percent vaut 0 en base de données, cela fera 0% d'augmentation.
    // Vérifiez dans votre base Supabase que ce champ n'est pas à 0. 

    if (isWeekend && weekendMarkup > 0) {
        const adjustment = currentPrice * (weekendMarkup / 100);
        currentPrice += adjustment;
        breakdown.details.push(`Week-end (+${weekendMarkup}%)`);
    }

    // --- 4. LEAD TIME (Anticipation) ---
    const today = new Date();
    const daysUntil = Math.ceil((targetDate - today) / (1000 * 60 * 60 * 24));
    
    if (daysUntil > 90) {
        const adjustment = currentPrice * 0.10; // +10% très à l'avance
        currentPrice += adjustment;
        breakdown.details.push('Réservation anticipée (+10%)');
    }

    // --- 5. CONTRAINTES ---
    if (currentPrice < floorPrice) {
        currentPrice = floorPrice;
        breakdown.details.push('Minimum atteint');
    }
    if (ceilingPrice && currentPrice > ceilingPrice) {
        currentPrice = ceilingPrice;
        breakdown.details.push('Plafond atteint');
    }

    // Arrondi
    currentPrice = Math.round(currentPrice);

    return {
        price: currentPrice,
        breakdown: breakdown,
        reasoning: breakdown.details.join(' • ') || 'Tarif standard',
        market_data_used: !!marketFeatures
    };
}

/**
 * Génère le calendrier complet pour une plage de dates
 */
async function generateDeterministicPricingCalendar({ property, startDate, endDate, city, country }) {
    // 1. Obtenir la liste de tous les jours
    const allDates = getDatesBetween(startDate, endDate);
    
    const calendar = [];

    // 2. Boucler sur chaque jour et calculer le prix
    // On utilise une boucle for...of pour gérer l'async proprement
    for (const dateStr of allDates) {
        const result = await calculateDeterministicPrice({
            property,
            date: dateStr,
            city,
            country
        });

        calendar.push({
            date: dateStr,
            price: result.price,
            breakdown: result.breakdown,
            reasoning: result.reasoning,
            market_data_used: result.market_data_used
        });
    }

    return calendar;
}

module.exports = {
    calculateDeterministicPrice,
    generateDeterministicPricingCalendar
};