/**
 * Moteur de pricing déterministe basé sur les données structurées du marché
 * Utilise les market_features au lieu de se fier uniquement à l'IA
 */

const { supabase } = require('../config/supabase');

/**
 * Calcule le prix recommandé pour une date spécifique basé sur les données marché
 * @param {Object} params
 * @param {Object} params.property - Propriété (avec base_price, floor_price, ceiling_price, strategy, etc.)
 * @param {string} params.date - Date au format YYYY-MM-DD
 * @param {Object} params.marketFeatures - Features marché pour cette date (optionnel, sera récupéré si non fourni)
 * @param {string} params.city - Ville de la propriété
 * @param {string} params.country - Pays de la propriété
 * @returns {Promise<Object>} { price, breakdown, reasoning }
 */
async function calculateDeterministicPrice({ property, date, marketFeatures = null, city, country }) {
    const basePrice = property.base_price || 100;
    const floorPrice = property.floor_price || 0;
    const ceilingPrice = property.ceiling_price || null;
    const strategy = property.strategy || 'Équilibré';
    
    // 1. Récupérer les market_features si non fournies
    if (!marketFeatures) {
        const { data, error } = await supabase
            .from('market_features')
            .select('*')
            .eq('country', country)
            .eq('city', city)
            .eq('date', date)
            .maybeSingle();
        
        if (error) {
            console.error(`[Pricing] Erreur récupération market_features pour ${city}, ${country}, ${date}:`, error);
            // Fallback : retourner le prix de base
            return {
                price: basePrice,
                breakdown: {
                    base: basePrice,
                    market_adjustment: 0,
                    demand_adjustment: 0,
                    event_adjustment: 0,
                    weather_adjustment: 0,
                    strategy_adjustment: 0,
                    lead_time_adjustment: 0,
                    weekday_adjustment: 0
                },
                reasoning: 'Données marché non disponibles, utilisation du prix de base'
            };
        }
        
        marketFeatures = data;
    }
    
    // Si pas de données marché, utiliser prix de base avec ajustements basiques
    if (!marketFeatures) {
        // Même sans données marché, on peut appliquer des ajustements basiques
        let adjustedPrice = basePrice;
        const breakdown = {
            base: basePrice,
            market_adjustment: 0,
            demand_adjustment: 0,
            event_adjustment: 0,
            weather_adjustment: 0,
            strategy_adjustment: 0,
            lead_time_adjustment: 0,
            weekday_adjustment: 0
        };
        const reasoning = [];
        
        // Appliquer au moins les ajustements basiques (stratégie, lead time, week-end)
        // Stratégie
        if (strategy === 'Prudent') {
            adjustedPrice *= 0.95;
            breakdown.strategy_adjustment = adjustedPrice - basePrice;
            reasoning.push('Stratégie prudente: -5%');
        } else if (strategy === 'Agressif') {
            adjustedPrice *= 1.05;
            breakdown.strategy_adjustment = adjustedPrice - basePrice;
            reasoning.push('Stratégie agressive: +5%');
        }
        
        // Lead time
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const targetDate = new Date(date + 'T00:00:00Z');
        const daysUntil = Math.round((targetDate - today) / (1000 * 60 * 60 * 24));
        
        if (daysUntil > 90) {
            adjustedPrice *= 1.10;
            breakdown.lead_time_adjustment = adjustedPrice - (basePrice + breakdown.strategy_adjustment);
            reasoning.push(`Réservation à l'avance (${daysUntil}j): +10%`);
        } else if (daysUntil < 7 && strategy === 'Prudent') {
            adjustedPrice *= 0.85;
            breakdown.lead_time_adjustment = adjustedPrice - (basePrice + breakdown.strategy_adjustment);
            reasoning.push(`Dernière minute (${daysUntil}j): -15%`);
        }
        
        // Week-end
        const weekday = targetDate.getDay();
        if ((weekday === 5 || weekday === 6) && property.weekend_markup_percent) {
            const beforeWeekend = adjustedPrice;
            adjustedPrice *= (1 + property.weekend_markup_percent / 100);
            breakdown.weekday_adjustment = adjustedPrice - beforeWeekend;
            reasoning.push(`Week-end: +${property.weekend_markup_percent}%`);
        }
        
        // Appliquer contraintes
        if (adjustedPrice < floorPrice) adjustedPrice = floorPrice;
        if (ceilingPrice != null && adjustedPrice > ceilingPrice) adjustedPrice = ceilingPrice;
        
        adjustedPrice = applyCharmPricing(adjustedPrice);
        
        return {
            price: Math.round(adjustedPrice),
            breakdown: {
                ...breakdown,
                final: adjustedPrice
            },
            reasoning: reasoning.length > 0 
                ? reasoning.join('; ') + ' (données marché non disponibles)'
                : 'Prix de base (données marché non disponibles)',
            market_data_used: null
        };
    }
    
    let currentPrice = basePrice;
    const breakdown = {
        base: basePrice,
        market_adjustment: 0,
        demand_adjustment: 0,
        event_adjustment: 0,
        weather_adjustment: 0,
        strategy_adjustment: 0,
        lead_time_adjustment: 0,
        weekday_adjustment: 0
    };
    
    const reasoning = [];
    
    // 2. AJUSTEMENT MARCHÉ (basé sur competitor_avg_price)
    if (marketFeatures.competitor_avg_price && marketFeatures.competitor_avg_price > 0) {
        const marketPrice = parseFloat(marketFeatures.competitor_avg_price);
        const marketRatio = marketPrice / basePrice;
        
        // Si le marché est plus cher que notre prix de base, on ajuste
        if (marketRatio > 1.1) {
            // Marché 10%+ plus cher : on peut augmenter
            const adjustment = (marketRatio - 1) * 0.5; // Ajustement modéré (50% de l'écart)
            const priceChange = basePrice * adjustment;
            breakdown.market_adjustment = priceChange;
            currentPrice += priceChange;
            reasoning.push(`Marché ${(marketRatio * 100).toFixed(0)}% du prix de base, ajustement +${(adjustment * 100).toFixed(0)}%`);
        } else if (marketRatio < 0.9) {
            // Marché 10%+ moins cher : on baisse légèrement
            const adjustment = (marketRatio - 1) * 0.3; // Ajustement conservateur
            const priceChange = basePrice * adjustment;
            breakdown.market_adjustment = priceChange;
            currentPrice += priceChange;
            reasoning.push(`Marché ${(marketRatio * 100).toFixed(0)}% du prix de base, ajustement ${(adjustment * 100).toFixed(0)}%`);
        } else {
            reasoning.push(`Prix marché aligné avec prix de base (${marketRatio.toFixed(2)}x)`);
        }
    }
    
    // 3. AJUSTEMENT DEMANDE (basé sur market_trend_score, search_volume_index, booking_volume_estimate)
    let demandMultiplier = 1.0;
    
    // Tendance marché
    if (marketFeatures.market_trend_score != null) {
        const trendScore = parseFloat(marketFeatures.market_trend_score);
        // trend_score: -1 à +1, on applique jusqu'à ±15%
        demandMultiplier += trendScore * 0.15;
        if (trendScore > 0.3) {
            reasoning.push(`Tendance marché haussière (+${(trendScore * 100).toFixed(0)}%)`);
        } else if (trendScore < -0.3) {
            reasoning.push(`Tendance marché baissière (${(trendScore * 100).toFixed(0)}%)`);
        }
    }
    
    // Volume de recherche
    if (marketFeatures.search_volume_index != null) {
        const searchVolume = parseFloat(marketFeatures.search_volume_index);
        // search_volume_index: 0-100, on normalise pour un ajustement ±10%
        const searchMultiplier = (searchVolume - 50) / 50 * 0.1; // -10% à +10%
        demandMultiplier += searchMultiplier;
        if (searchVolume > 70) {
            reasoning.push(`Volume de recherche élevé (${searchVolume})`);
        } else if (searchVolume < 30) {
            reasoning.push(`Volume de recherche faible (${searchVolume})`);
        }
    }
    
    const demandAdjustment = currentPrice * (demandMultiplier - 1);
    breakdown.demand_adjustment = demandAdjustment;
    currentPrice += demandAdjustment;
    
    // 4. AJUSTEMENT ÉVÉNEMENTS (basé sur expected_demand_impact et event_intensity_score)
    if (marketFeatures.expected_demand_impact != null) {
        const eventImpact = parseFloat(marketFeatures.expected_demand_impact);
        // expected_demand_impact: -50 à +50, on convertit en % de prix
        const eventMultiplier = 1 + (eventImpact / 100); // -50% à +50% de prix
        const eventAdjustment = currentPrice * (eventMultiplier - 1);
        breakdown.event_adjustment = eventAdjustment;
        currentPrice += eventAdjustment;
        
        if (eventImpact > 20) {
            reasoning.push(`Événement majeur détecté (+${eventImpact.toFixed(0)}% impact)`);
        } else if (eventImpact < -20) {
            reasoning.push(`Impact événementiel négatif (${eventImpact.toFixed(0)}%)`);
        }
        
        // Si événement majeur, on peut dépasser le plafond habituel
        if (marketFeatures.has_major_event && eventImpact > 30) {
            reasoning.push(`Événement majeur : dépassement plafond autorisé`);
        }
    }
    
    // 5. AJUSTEMENT MÉTÉO (basé sur weather_score)
    if (marketFeatures.weather_score != null) {
        const weatherScore = parseFloat(marketFeatures.weather_score);
        // weather_score: 0-100, on ajuste de -5% à +10%
        const weatherMultiplier = 0.95 + (weatherScore / 100) * 0.15; // 0.95 à 1.10
        const weatherAdjustment = currentPrice * (weatherMultiplier - 1);
        breakdown.weather_adjustment = weatherAdjustment;
        currentPrice += weatherAdjustment;
        
        if (weatherScore > 80) {
            reasoning.push(`Météo excellente (${weatherScore.toFixed(0)}/100)`);
        } else if (weatherScore < 40) {
            reasoning.push(`Météo défavorable (${weatherScore.toFixed(0)}/100)`);
        }
    }
    
    // 6. AJUSTEMENT STRATÉGIE (Prudent/Équilibré/Agressif)
    let strategyMultiplier = 1.0;
    if (strategy === 'Prudent') {
        strategyMultiplier = 0.95; // -5% pour maximiser occupation
        reasoning.push('Stratégie prudente : -5% pour favoriser occupation');
    } else if (strategy === 'Agressif') {
        strategyMultiplier = 1.05; // +5% pour maximiser revenu
        reasoning.push('Stratégie agressive : +5% pour maximiser revenu');
    }
    
    const strategyAdjustment = currentPrice * (strategyMultiplier - 1);
    breakdown.strategy_adjustment = strategyAdjustment;
    currentPrice += strategyAdjustment;
    
    // 7. AJUSTEMENT LEAD TIME (jours jusqu'à la date)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const targetDate = new Date(date + 'T00:00:00Z');
    const daysUntil = Math.round((targetDate - today) / (1000 * 60 * 60 * 24));
    
    let leadTimeMultiplier = 1.0;
    if (daysUntil > 90) {
        // Far out: +10% (réservez tôt, moins sensible au prix)
        leadTimeMultiplier = 1.10;
        reasoning.push(`Réservation à l'avance (${daysUntil}j) : +10%`);
    } else if (daysUntil < 7) {
        // Last minute: ajustement selon stratégie
        if (strategy === 'Prudent') {
            leadTimeMultiplier = 0.85; // -15% pour remplir rapidement
            reasoning.push(`Dernière minute (${daysUntil}j) : -15% (stratégie prudente)`);
        } else if (strategy === 'Agressif') {
            leadTimeMultiplier = 1.0; // Pas de baisse
            reasoning.push(`Dernière minute (${daysUntil}j) : prix maintenu (stratégie agressive)`);
        } else {
            leadTimeMultiplier = 0.90; // -10% par défaut
            reasoning.push(`Dernière minute (${daysUntil}j) : -10%`);
        }
    } else if (daysUntil < 21) {
        // Close in: léger ajustement selon stratégie
        if (strategy === 'Prudent') {
            leadTimeMultiplier = 0.92; // -8%
            reasoning.push(`Court terme (${daysUntil}j) : -8% (stratégie prudente)`);
        }
    }
    
    const leadTimeAdjustment = currentPrice * (leadTimeMultiplier - 1);
    breakdown.lead_time_adjustment = leadTimeAdjustment;
    currentPrice += leadTimeAdjustment;
    
    // 8. AJUSTEMENT JOUR DE LA SEMAINE
    const weekday = targetDate.getDay(); // 0 = Dimanche, 6 = Samedi
    let weekdayMultiplier = 1.0;
    
    // Appliquer weekend_markup_percent si défini
    if ((weekday === 5 || weekday === 6) && property.weekend_markup_percent) {
        weekdayMultiplier = 1 + (property.weekend_markup_percent / 100);
        reasoning.push(`Week-end : +${property.weekend_markup_percent}%`);
    }
    
    const weekdayAdjustment = currentPrice * (weekdayMultiplier - 1);
    breakdown.weekday_adjustment = weekdayAdjustment;
    currentPrice += weekdayAdjustment;
    
    // 9. APPLICATION DES CONTRAINTES (floor/ceiling)
    const priceBeforeConstraints = currentPrice;
    
    if (currentPrice < floorPrice) {
        currentPrice = floorPrice;
        reasoning.push(`Prix ajusté au plancher (${floorPrice}€)`);
    }
    
    // Pour les événements majeurs, on peut dépasser le plafond
    const canExceedCeiling = marketFeatures.has_major_event && 
                             marketFeatures.expected_demand_impact > 30;
    
    if (ceilingPrice != null && currentPrice > ceilingPrice && !canExceedCeiling) {
        currentPrice = ceilingPrice;
        reasoning.push(`Prix ajusté au plafond (${ceilingPrice}€)`);
    }
    
    // 10. CHARM PRICING (arrondir à un prix "psychologique")
    currentPrice = applyCharmPricing(currentPrice);
    
    // 11. SMOOTHING (vérifier que le prix n'est pas trop différent du prix moyen récent)
    // Pour l'instant, on skip le smoothing car on n'a pas accès aux prix précédents ici
    
    const finalReasoning = reasoning.length > 0 
        ? reasoning.join('; ')
        : 'Prix basé sur données marché standard';
    
    return {
        price: Math.round(currentPrice),
        breakdown: {
            ...breakdown,
            final: currentPrice,
            constrained: currentPrice !== priceBeforeConstraints
        },
        reasoning: finalReasoning,
        market_data_used: {
            competitor_avg_price: marketFeatures.competitor_avg_price,
            market_trend_score: marketFeatures.market_trend_score,
            weather_score: marketFeatures.weather_score,
            event_impact: marketFeatures.expected_demand_impact,
            has_major_event: marketFeatures.has_major_event
        }
    };
}

/**
 * Applique le "charm pricing" (prix psychologique)
 * Arrondit à un prix terminant par 5, 9, ou 0
 */
function applyCharmPricing(price) {
    if (price < 10) {
        // Pour les prix < 10€, garder les centimes
        return Math.round(price * 100) / 100;
    } else if (price < 50) {
        // 10-50€ : arrondir à 0.95 ou .00
        const rounded = Math.round(price);
        const lastDigit = rounded % 10;
        if (lastDigit >= 6) return rounded - lastDigit + 9;
        if (lastDigit >= 1) return rounded - lastDigit + 5;
        return rounded;
    } else if (price < 200) {
        // 50-200€ : arrondir à 5 ou 9
        const rounded = Math.round(price);
        const lastDigit = rounded % 10;
        if (lastDigit >= 6) return rounded - lastDigit + 9;
        if (lastDigit >= 1 && lastDigit < 5) return rounded - lastDigit + 5;
        if (lastDigit === 0) return rounded;
        return rounded - lastDigit + 5;
    } else {
        // 200€+ : arrondir à 5 ou 0
        const rounded = Math.round(price);
        const lastDigit = rounded % 10;
        if (lastDigit >= 5) return rounded - lastDigit + 5;
        return rounded - lastDigit;
    }
}

/**
 * Génère un calendrier de prix pour une plage de dates
 * @param {Object} params
 * @param {Object} params.property - Propriété
 * @param {string} params.startDate - Date de début (YYYY-MM-DD)
 * @param {string} params.endDate - Date de fin (YYYY-MM-DD)
 * @param {string} params.city - Ville
 * @param {string} params.country - Pays
 * @returns {Promise<Array>} Tableau de { date, price, breakdown, reasoning }
 */
async function generateDeterministicPricingCalendar({ property, startDate, endDate, city, country }) {
    const calendar = [];
    
    // Récupérer toutes les market_features pour la plage de dates en une seule requête
    const { data: allFeatures, error } = await supabase
        .from('market_features')
        .select('*')
        .eq('country', country)
        .eq('city', city)
        .gte('date', startDate)
        .lte('date', endDate)
        .order('date', { ascending: true });
    
    if (error) {
        console.error(`[Pricing] Erreur récupération market_features pour ${city}, ${country}:`, error);
    }
    
    // Créer une Map pour accès rapide par date
    const featuresMap = new Map();
    if (allFeatures) {
        allFeatures.forEach(f => {
            featuresMap.set(f.date, f);
        });
    }
    
    // Générer les prix pour chaque date
    const start = new Date(startDate + 'T00:00:00Z');
    const end = new Date(endDate + 'T00:00:00Z');
    let currentDate = new Date(start);
    
    const prices = []; // Pour le smoothing
    
    while (currentDate <= end) {
        const dateStr = currentDate.toISOString().split('T')[0];
        const marketFeatures = featuresMap.get(dateStr) || null;
        
        const priceData = await calculateDeterministicPrice({
            property,
            date: dateStr,
            marketFeatures,
            city,
            country
        });
        
        // Appliquer smoothing basé sur les prix précédents
        if (prices.length > 0) {
            const prevPrice = prices[prices.length - 1];
            const priceDiff = Math.abs(priceData.price - prevPrice) / prevPrice;
            
            // Si le prix change de plus de 50% sans événement majeur, lisser
            if (priceDiff > 0.5 && (!marketFeatures || !marketFeatures.has_major_event)) {
                // Lisser progressivement : prendre 70% du nouveau prix + 30% de l'ancien
                priceData.price = Math.round(priceData.price * 0.7 + prevPrice * 0.3);
                priceData.reasoning += ' (lissé pour cohérence)';
            }
        }
        
        prices.push(priceData.price);
        
        calendar.push({
            date: dateStr,
            price: priceData.price,
            breakdown: priceData.breakdown,
            reasoning: priceData.reasoning,
            market_data_used: priceData.market_data_used
        });
        
        currentDate.setUTCDate(currentDate.getUTCDate() + 1);
    }
    
    return calendar;
}

module.exports = {
    calculateDeterministicPrice,
    generateDeterministicPricingCalendar,
    applyCharmPricing
};

