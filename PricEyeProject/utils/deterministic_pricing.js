/**
 * Moteur de pricing déterministe basé sur les données structurées du marché
 * Version améliorée avec Saisonnalité Synthétique pour éviter les courbes plates.
 */

const { supabase } = require('../config/supabase');

/**
 * Calcule un multiplicateur de saisonnalité simple (Sinusoïdale)
 * Pico en Août (été) et Décembre (fêtes), Creux en Novembre/Février
 */
function getSeasonalityMultiplier(dateStr) {
    const date = new Date(dateStr);
    const month = date.getMonth(); // 0 = Janvier, 11 = Décembre
    
    // Facteurs mensuels approximatifs (Hémisphère Nord)
    // Jan: 0.9, Fév: 0.9, Mar: 1.0, Avr: 1.05, Mai: 1.1, Juin: 1.2
    // Juil: 1.3, Août: 1.35, Sep: 1.15, Oct: 1.0, Nov: 0.85, Déc: 1.2
    const factors = [0.90, 0.90, 1.00, 1.05, 1.10, 1.20, 1.30, 1.35, 1.15, 1.00, 0.85, 1.25];
    
    return factors[month];
}

async function calculateDeterministicPrice({ property, date, marketFeatures = null, city, country }) {
    const basePrice = property.base_price || 100;
    const floorPrice = property.floor_price || Math.round(basePrice * 0.7); // Protection par défaut
    const ceilingPrice = property.ceiling_price || Math.round(basePrice * 3);
    const strategy = property.strategy || 'Équilibré';
    
    // --- 1. DONNÉES MARCHÉ (Récupération) ---
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
        seasonality_adjustment: 0, // Nouveau
        market_adjustment: 0,
        demand_adjustment: 0,
        event_adjustment: 0,
        weather_adjustment: 0,
        strategy_adjustment: 0,
        lead_time_adjustment: 0,
        weekday_adjustment: 0,
        news_sentiment_adjustment: 0
    };
    const reasoning = [];

    // --- 2. SAISONNALITÉ (Le cœur de la variation) ---
    // On l'applique TOUT LE TEMPS, market data ou pas
    const seasonalityMult = getSeasonalityMultiplier(date);
    const seasonalPrice = basePrice * seasonalityMult;
    breakdown.seasonality_adjustment = seasonalPrice - basePrice;
    currentPrice = seasonalPrice;
    
    if (seasonalityMult > 1.05) reasoning.push('Haute saison');
    else if (seasonalityMult < 0.95) reasoning.push('Basse saison');

    // --- 3. WEEK-END (Variation Hebdomadaire) ---
    const targetDate = new Date(date);
    const weekday = targetDate.getDay(); // 0=Dim, 6=Sam
    const isWeekend = (weekday === 5 || weekday === 6);
    
    // Si pas de markup défini, on met +15% par défaut le week-end
    const weekendMarkup = property.weekend_markup_percent !== undefined 
        ? property.weekend_markup_percent 
        : 15; 

    if (isWeekend && weekendMarkup > 0) {
        const adjustment = currentPrice * (weekendMarkup / 100);
        breakdown.weekday_adjustment = adjustment;
        currentPrice += adjustment;
        reasoning.push(`Week-end (+${weekendMarkup}%)`);
    }

    // --- 4. SI DONNÉES MARCHÉ PRÉSENTES ---
    if (marketFeatures) {
        // Ajustement Marché
        if (marketFeatures.competitor_avg_price) {
            const marketPrice = parseFloat(marketFeatures.competitor_avg_price);
            if (marketPrice > 0) {
                // On se rapproche du marché (force de gravité 30%)
                const gap = marketPrice - currentPrice;
                const adjustment = gap * 0.3; 
                breakdown.market_adjustment = adjustment;
                currentPrice += adjustment;
                reasoning.push('Alignement partiel marché');
            }
        }
        
        // Événements
        if (marketFeatures.expected_demand_impact) {
            const impact = parseFloat(marketFeatures.expected_demand_impact); // ex: +20
            const adjustment = currentPrice * (impact / 100);
            breakdown.event_adjustment = adjustment;
            currentPrice += adjustment;
            if (Math.abs(impact) > 5) reasoning.push(`Événement détecté (${impact > 0 ? '+' : ''}${impact}%)`);
        }
        
        // News Sentiment (Actualité locale)
        if (marketFeatures.news_sentiment_score !== undefined && marketFeatures.news_sentiment_score !== null) {
            const sentimentScore = parseFloat(marketFeatures.news_sentiment_score);
            
            if (sentimentScore > 0.5) {
                // Sentiment très positif : augmentation de 5% à 10%
                // On utilise une interpolation linéaire : 0.5 -> 5%, 1.0 -> 10%
                const percentIncrease = 5 + (sentimentScore - 0.5) * 10; // 5% à 10%
                const adjustment = currentPrice * (percentIncrease / 100);
                breakdown.news_sentiment_adjustment = adjustment;
                currentPrice += adjustment;
                reasoning.push(`Actualité locale favorable : +${Math.round(percentIncrease)}%`);
            } else if (sentimentScore < -0.5) {
                // Sentiment très négatif : baisse de 5%
                const adjustment = currentPrice * (-0.05);
                breakdown.news_sentiment_adjustment = adjustment;
                currentPrice += adjustment;
                reasoning.push('Actualité locale défavorable : -5%');
            }
        }
    }

    // --- 5. LEAD TIME (Réservation avance/dernière minute) ---
    const today = new Date();
    const daysUntil = Math.ceil((targetDate - today) / (1000 * 60 * 60 * 24));
    
    let leadTimeMult = 1.0;
    if (daysUntil > 90) {
        leadTimeMult = 1.10; // +10% très à l'avance
        reasoning.push('Réservation anticipée');
    } else if (daysUntil < 10) {
        // Dernière minute : baisse si prudent, hausse si agressif
        if (strategy === 'Prudent') {
            leadTimeMult = 0.90; 
            reasoning.push('Dernière minute (Solde)');
        } else if (strategy === 'Agressif') {
            leadTimeMult = 1.05;
        }
    }
    const leadTimeAdj = currentPrice * (leadTimeMult - 1);
    breakdown.lead_time_adjustment = leadTimeAdj;
    currentPrice += leadTimeAdj;

    // --- 6. CONTRAINTES & CHARM PRICING ---
    // Respect strict du Min/Max
    if (currentPrice < floorPrice) currentPrice = floorPrice;
    if (ceilingPrice && currentPrice > ceilingPrice) currentPrice = ceilingPrice;

    // Arrondi joli (ex: 124.32 -> 125, 129 -> 129)
    currentPrice = applyCharmPricing(currentPrice);

    return {
        price: currentPrice,
        breakdown: { ...breakdown, final: currentPrice },
        reasoning: reasoning.join(' • ') || 'Tarif standard',
        market_data_used: !!marketFeatures
    };
}

function applyCharmPricing(price) {
    return Math.round(price); // Version simple pour commencer
}

async function generateDeterministicPricingCalendar({ property, startDate, endDate, city, country }) {
    // Cette fonction reste similaire, elle appelle calculateDeterministicPrice en boucle
    // ... (Logique de boucle existante)
    // Pour simplifier l'intégration, vous pouvez laisser votre server.js faire la boucle
    return []; 
}

module.exports = {
    calculateDeterministicPrice,
    applyCharmPricing
};
