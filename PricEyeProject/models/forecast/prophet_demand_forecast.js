/**
 * Modèle Prophet (version simplifiée en JavaScript) pour le forecasting de demande
 * 
 * Note: Prophet original est en Python. Cette implémentation utilise des techniques
 * de forecasting simplifiées (moving average, linear regression, saisonnalité).
 * Pour une version plus précise, utiliser une API Python externe.
 */

const { supabase } = require('../../config/supabase.js');
const ss = require('simple-statistics');

/**
 * Régression linéaire simple (implémentation basique)
 */
class SimpleLinearRegression {
    constructor(x, y) {
        if (x.length !== y.length) {
            throw new Error('Les tableaux x et y doivent avoir la même longueur');
        }
        
        const n = x.length;
        const sumX = ss.sum(x);
        const sumY = ss.sum(y);
        const sumXY = ss.sum(x.map((xi, i) => xi * y[i]));
        const sumXX = ss.sum(x.map(xi => xi * xi));
        
        this.slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
        this.intercept = (sumY - this.slope * sumX) / n;
    }
    
    predict(x) {
        return this.slope * x + this.intercept;
    }
}

/**
 * Calcule une moyenne mobile
 */
function movingAverage(data, window) {
    const result = [];
    for (let i = 0; i < data.length; i++) {
        if (i < window - 1) {
            result.push(null);
        } else {
            const slice = data.slice(i - window + 1, i + 1);
            result.push(ss.mean(slice));
        }
    }
    return result;
}

/**
 * Détecte la saisonnalité dans les données (hebdomadaire, mensuelle)
 */
function detectSeasonality(demandData) {
    // Pour l'instant, on assume une saisonnalité hebdomadaire (7 jours)
    return 7;
}

/**
 * Calcule un forecast de demande pour une série temporelle
 * 
 * @param {Array} historicalData - Données historiques [{date, demand}, ...]
 * @param {number} forecastDays - Nombre de jours à prévoir
 * @returns {Array} Prévisions [{date, demand, lower, upper}, ...]
 */
function forecastDemand(historicalData, forecastDays = 90) {
    if (!historicalData || historicalData.length < 7) {
        // Pas assez de données, retourner une moyenne
        const avgDemand = historicalData.length > 0 
            ? ss.mean(historicalData.map(d => d.demand || 0))
            : 50;
        
        const forecasts = [];
        const lastDate = historicalData.length > 0 
            ? new Date(historicalData[historicalData.length - 1].date)
            : new Date();
        
        for (let i = 0; i < forecastDays; i++) {
            const date = new Date(lastDate);
            date.setDate(date.getDate() + i + 1);
            forecasts.push({
                date: date.toISOString().split('T')[0],
                demand: avgDemand,
                lower: Math.max(0, avgDemand * 0.7),
                upper: avgDemand * 1.3
            });
        }
        return forecasts;
    }
    
    // Extraire les valeurs de demande
    const demands = historicalData.map(d => d.demand || 0);
    const dates = historicalData.map(d => new Date(d.date).getTime());
    
    // 1. Détendre la tendance avec une moyenne mobile
    const trendWindow = Math.min(14, Math.floor(historicalData.length / 3));
    const trend = movingAverage(demands, trendWindow);
    
    // 2. Calculer la saisonnalité hebdomadaire
    const seasonality = detectSeasonality(historicalData);
    const seasonalComponents = new Array(seasonality).fill(0);
    const seasonalCounts = new Array(seasonality).fill(0);
    
    for (let i = seasonality; i < demands.length; i++) {
        const dayOfWeek = new Date(historicalData[i].date).getDay();
        const detrended = demands[i] - (trend[i] || demands[i]);
        seasonalComponents[dayOfWeek] += detrended;
        seasonalCounts[dayOfWeek]++;
    }
    
    // Normaliser les composantes saisonnières
    for (let i = 0; i < seasonality; i++) {
        if (seasonalCounts[i] > 0) {
            seasonalComponents[i] /= seasonalCounts[i];
        }
    }
    
    // 3. Régression linéaire pour la tendance
    const validTrendData = trend.map((t, i) => ({ x: i, y: t })).filter(d => d.y !== null);
    
    if (validTrendData.length < 2) {
        // Pas assez de données pour la régression, utiliser la moyenne
        const avgDemand = ss.mean(demands);
        const forecasts = [];
        const lastDate = new Date(historicalData[historicalData.length - 1].date);
        
        for (let i = 0; i < forecastDays; i++) {
            const date = new Date(lastDate);
            date.setDate(date.getDate() + i + 1);
            const dayOfWeek = date.getDay();
            const seasonal = seasonalComponents[dayOfWeek] || 0;
            
            forecasts.push({
                date: date.toISOString().split('T')[0],
                demand: Math.max(0, avgDemand + seasonal),
                lower: Math.max(0, (avgDemand + seasonal) * 0.7),
                upper: (avgDemand + seasonal) * 1.3
            });
        }
        return forecasts;
    }
    
    const regression = new SimpleLinearRegression(
        validTrendData.map(d => d.x),
        validTrendData.map(d => d.y)
    );
    
    // 4. Générer les prévisions
    const forecasts = [];
    const lastIndex = historicalData.length - 1;
    const lastDate = new Date(historicalData[lastIndex].date);
    const stdDev = ss.standardDeviation(demands);
    
    for (let i = 0; i < forecastDays; i++) {
        const date = new Date(lastDate);
        date.setDate(date.getDate() + i + 1);
        const dayOfWeek = date.getDay();
        
        // Tendance future
        const futureIndex = lastIndex + i + 1;
        const trendValue = regression.predict(futureIndex);
        
        // Ajouter la saisonnalité
        const seasonal = seasonalComponents[dayOfWeek] || 0;
        const demand = Math.max(0, trendValue + seasonal);
        
        // Intervalle de confiance (approximatif)
        const lower = Math.max(0, demand - 1.96 * stdDev);
        const upper = demand + 1.96 * stdDev;
        
        forecasts.push({
            date: date.toISOString().split('T')[0],
            demand: Math.round(demand * 100) / 100,
            lower: Math.round(lower * 100) / 100,
            upper: Math.round(upper * 100) / 100
        });
    }
    
    return forecasts;
}

/**
 * Agrége les données de demande depuis les features_pricing_daily
 */
async function getDemandDataByCity(city, propertyType = null, daysBack = 90) {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);
    
    let query = supabase
        .from('features_pricing_daily')
        .select('date, occupancy_rate_30d, demand_score_30d, city, property_type')
        .eq('city', city)
        .gte('date', startDate.toISOString().split('T')[0])
        .lte('date', endDate.toISOString().split('T')[0])
        .order('date', { ascending: true });
    
    if (propertyType) {
        query = query.eq('property_type', propertyType);
    }
    
    const { data, error } = await query;
    
    if (error) throw error;
    
    // Agréger par date et calculer la demande moyenne
    const demandByDate = new Map();
    
    (data || []).forEach(row => {
        const date = row.date;
        // Utiliser demand_score_30d comme indicateur de demande, ou occupancy_rate_30d
        const demand = row.demand_score_30d || row.occupancy_rate_30d || 0;
        
        if (!demandByDate.has(date)) {
            demandByDate.set(date, { date, demands: [] });
        }
        demandByDate.get(date).demands.push(demand);
    });
    
    // Calculer la moyenne par date
    const result = Array.from(demandByDate.values()).map(item => ({
        date: item.date,
        demand: ss.mean(item.demands) || 0
    })).sort((a, b) => a.date.localeCompare(b.date));
    
    return result;
}

/**
 * Génère les prévisions de demande pour une ville/property_type
 */
async function generateDemandForecast(city, propertyType = null, forecastDays = 90) {
    console.log(`[Prophet] Génération de prévision pour ${city}${propertyType ? ` (${propertyType})` : ''}`);
    
    // Récupérer les données historiques
    const historicalData = await getDemandDataByCity(city, propertyType, 180); // 6 mois d'historique
    
    if (historicalData.length === 0) {
        console.warn(`  ⚠ Aucune donnée historique trouvée pour ${city}`);
        return null;
    }
    
    console.log(`  → ${historicalData.length} jours de données historiques`);
    
    // Générer les prévisions
    const forecasts = forecastDemand(historicalData, forecastDays);
    
    // Stocker dans la base de données
    const records = forecasts.map(f => ({
        city: city,
        property_type: propertyType,
        forecast_date: f.date,
        demand_score: Math.min(100, Math.max(0, f.demand)), // Limiter entre 0 et 100
        confidence_interval_lower: Math.min(100, Math.max(0, f.lower)),
        confidence_interval_upper: Math.min(100, Math.max(0, f.upper)),
        model_version: '1.0-js'
    }));
    
    // Upsert dans la base de données
    const { error } = await supabase
        .from('demand_forecasts')
        .upsert(records, {
            onConflict: 'city,property_type,forecast_date'
        });
    
    if (error) {
        console.error(`  ✗ Erreur lors du stockage: ${error.message}`);
        throw error;
    }
    
    console.log(`  ✓ ${records.length} prévision(s) générée(s) et stockée(s)`);
    
    return forecasts;
}

/**
 * Génère les prévisions pour toutes les villes/property_types dans la base
 */
async function generateAllDemandForecasts(forecastDays = 90) {
    console.log(`\n[Prophet] Démarrage de la génération des prévisions de demande`);
    
    // Récupérer toutes les villes uniques
    const { data: cities, error: citiesError } = await supabase
        .from('features_pricing_daily')
        .select('city, property_type')
        .not('city', 'is', null);
    
    if (citiesError) throw citiesError;
    
    // Grouper par ville et property_type
    const groups = new Map();
    
    (cities || []).forEach(row => {
        const key = `${row.city}|${row.property_type || 'all'}`;
        if (!groups.has(key)) {
            groups.set(key, {
                city: row.city,
                propertyType: row.property_type || null
            });
        }
    });
    
    console.log(`  ${groups.size} groupe(s) (ville/property_type) à traiter\n`);
    
    const results = [];
    const errors = [];
    
    for (const [key, group] of groups) {
        try {
            const forecasts = await generateDemandForecast(
                group.city,
                group.propertyType,
                forecastDays
            );
            if (forecasts) {
                results.push({ city: group.city, propertyType: group.propertyType, count: forecasts.length });
            }
        } catch (error) {
            console.error(`  ✗ Erreur pour ${key}:`, error.message);
            errors.push({ city: group.city, propertyType: group.propertyType, error: error.message });
        }
    }
    
    console.log(`\n[Prophet] Terminé`);
    console.log(`  ✓ ${results.length} groupe(s) traité(s) avec succès`);
    console.log(`  ✗ ${errors.length} erreur(s)`);
    
    return { results, errors };
}

// Si le script est exécuté directement
if (require.main === module) {
    const args = process.argv.slice(2);
    
    let city = null;
    let propertyType = null;
    let forecastDays = 90;
    
    args.forEach(arg => {
        if (arg.startsWith('--city=')) {
            city = arg.split('=')[1];
        } else if (arg.startsWith('--property-type=')) {
            propertyType = arg.split('=')[1];
        } else if (arg.startsWith('--days=')) {
            forecastDays = parseInt(arg.split('=')[1]);
        }
    });
    
    if (city) {
        generateDemandForecast(city, propertyType, forecastDays)
            .then(() => {
                console.log('\n✓ Prévision générée avec succès');
                process.exit(0);
            })
            .catch(error => {
                console.error('\n✗ Erreur:', error);
                process.exit(1);
            });
    } else {
        generateAllDemandForecasts(forecastDays)
            .then(() => {
                console.log('\n✓ Toutes les prévisions générées avec succès');
                process.exit(0);
            })
            .catch(error => {
                console.error('\n✗ Erreur:', error);
                process.exit(1);
            });
    }
}

module.exports = {
    generateDemandForecast,
    generateAllDemandForecasts,
    forecastDemand
};

