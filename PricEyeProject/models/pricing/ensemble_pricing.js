/**
 * Système de combinaison (Ensemble Learning) pour combiner les prédictions de tous les modèles
 * Utilise une moyenne pondérée des prédictions avec des poids ajustables
 */

const { supabase } = require('../../config/supabase.js');

// Poids par défaut pour chaque modèle (ajustables selon les performances)
const DEFAULT_WEIGHTS = {
    prophet: 0.15,        // Influence de la demande prévue
    xgboost: 0.35,        // Modèle principal (le plus fiable généralement)
    neuralNetwork: 0.30,  // Patterns complexes
    gpt4: 0.20            // Ajustements contextuels et explicabilité
};

/**
 * Combine les prédictions de tous les modèles pour générer un prix final recommandé
 */
async function combinePredictions(propertyId, startDate, endDate, weights = DEFAULT_WEIGHTS) {
    console.log(`[Ensemble] Combinaison des prédictions pour ${propertyId}`);
    
    // Récupérer les recommandations de tous les modèles
    const { data: recommendations, error } = await supabase
        .from('pricing_recommendations')
        .select('*')
        .eq('property_id', propertyId)
        .gte('date', startDate)
        .lte('date', endDate)
        .order('date', { ascending: true });
    
    if (error) throw error;
    
    if (!recommendations || recommendations.length === 0) {
        console.warn(`  ⚠ Aucune recommandation trouvée`);
        return [];
    }
    
    console.log(`  → ${recommendations.length} recommandation(s) à combiner`);
    
    // Récupérer les prévisions de demande Prophet
    const { data: property, error: propError } = await supabase
        .from('properties')
        .select('city, property_type')
        .eq('id', propertyId)
        .single();
    
    let demandForecasts = [];
    if (property && !propError) {
        let demandQuery = supabase
            .from('demand_forecasts')
            .select('*')
            .eq('city', property.city)
            .gte('forecast_date', startDate)
            .lte('forecast_date', endDate);
        
        if (property.property_type) {
            demandQuery = demandQuery.eq('property_type', property.property_type);
        }
        
        const { data: forecasts, error: forecastError } = await demandQuery;
        if (!forecastError && forecasts) {
            demandForecasts = forecasts;
        }
    }
    
    const demandForecastMap = new Map();
    demandForecasts.forEach(f => {
        demandForecastMap.set(f.forecast_date, f.demand_score);
    });
    
    // Pour chaque recommandation, calculer le prix final combiné
    const combined = [];
    let updatedCount = 0;
    
    for (const rec of recommendations) {
        const prices = [];
        const weightsUsed = [];
        
        // 1. Prix Prophet (basé sur la demande prévue)
        // Convertir le score de demande en prix suggéré
        const demandForecast = demandForecastMap.get(rec.date);
        let prophetPrice = null;
        
        if (demandForecast !== undefined && rec.price_base) {
            // Ajuster le prix de base selon la demande prévue
            // Demande élevée (80-100) : +20% à +30%
            // Demande moyenne (50-80) : +0% à +15%
            // Demande faible (0-50) : -10% à -20%
            const demandRatio = demandForecast / 100;
            let adjustment = 0;
            
            if (demandRatio >= 0.8) {
                adjustment = 0.20 + (demandRatio - 0.8) * 0.5; // +20% à +30%
            } else if (demandRatio >= 0.5) {
                adjustment = (demandRatio - 0.5) * 0.5; // 0% à +15%
            } else {
                adjustment = -0.10 - (0.5 - demandRatio) * 0.4; // -10% à -30%
            }
            
            prophetPrice = rec.price_base * (1 + adjustment);
        } else if (rec.price_prophet) {
            prophetPrice = rec.price_prophet;
        }
        
        // 2. Prix XGBoost
        if (rec.price_xgboost) {
            prices.push(rec.price_xgboost);
            weightsUsed.push(weights.xgboost);
        }
        
        // 3. Prix Neural Network
        if (rec.price_neural_network) {
            prices.push(rec.price_neural_network);
            weightsUsed.push(weights.neuralNetwork);
        }
        
        // 4. Prix GPT-4
        if (rec.price_gpt4) {
            prices.push(rec.price_gpt4);
            weightsUsed.push(weights.gpt4);
        }
        
        // 5. Prix Prophet (si disponible)
        if (prophetPrice !== null) {
            prices.push(prophetPrice);
            weightsUsed.push(weights.prophet);
        }
        
        // Si aucune prédiction n'est disponible, utiliser le prix de base
        if (prices.length === 0) {
            combined.push({
                ...rec,
                price_recommended: rec.price_base || 0,
                confidence_score: 0
            });
            continue;
        }
        
        // Normaliser les poids (somme = 1)
        const totalWeight = weightsUsed.reduce((sum, w) => sum + w, 0);
        const normalizedWeights = weightsUsed.map(w => w / totalWeight);
        
        // Calculer la moyenne pondérée
        let weightedPrice = 0;
        for (let i = 0; i < prices.length; i++) {
            weightedPrice += prices[i] * normalizedWeights[i];
        }
        
        // Calculer le score de confiance
        // Basé sur:
        // - Nombre de modèles disponibles (plus = mieux)
        // - Variance des prédictions (moins = mieux)
        let confidenceScore = 50; // Base
        
        // Bonus pour chaque modèle disponible
        confidenceScore += prices.length * 10;
        
        // Réduction si variance élevée
        if (prices.length > 1) {
            const mean = weightedPrice;
            const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
            const stdDev = Math.sqrt(variance);
            const coefficientOfVariation = stdDev / mean;
            
            // Si CV < 0.1 (10% de variation), confiance élevée
            // Si CV > 0.3 (30% de variation), confiance réduite
            if (coefficientOfVariation < 0.1) {
                confidenceScore += 20;
            } else if (coefficientOfVariation < 0.2) {
                confidenceScore += 10;
            } else if (coefficientOfVariation > 0.3) {
                confidenceScore -= 20;
            }
        }
        
        // Utiliser la confiance de GPT-4 si disponible
        if (rec.confidence) {
            confidenceScore = (confidenceScore + rec.confidence) / 2;
        }
        
        // Limiter entre 0 et 100
        confidenceScore = Math.max(0, Math.min(100, confidenceScore));
        
        // Construire l'explication combinée
        let explanationText = rec.explanation || '';
        if (prices.length > 1) {
            explanationText += ` (Basé sur ${prices.length} modèles: `;
            const modelNames = [];
            if (prophetPrice !== null) modelNames.push('Prophet');
            if (rec.price_xgboost) modelNames.push('XGBoost');
            if (rec.price_neural_network) modelNames.push('Réseau de neurones');
            if (rec.price_gpt4) modelNames.push('GPT-4');
            explanationText += modelNames.join(', ') + ')';
        }
        
        // Mettre à jour la recommandation
        const updated = {
            property_id: propertyId,
            date: rec.date,
            price_prophet: prophetPrice,
            price_xgboost: rec.price_xgboost,
            price_neural_network: rec.price_neural_network,
            price_gpt4: rec.price_gpt4,
            price_recommended: Math.round(weightedPrice * 100) / 100,
            confidence_score: Math.round(confidenceScore * 100) / 100,
            explanation_text: explanationText,
            key_factors: rec.key_factors || {},
            model_versions: {
                prophet: '1.0-js',
                xgboost: '1.0-tfjs',
                neuralNetwork: '1.0-tfjs',
                gpt4: 'gpt-4o'
            }
        };
        
        combined.push(updated);
    }
    
    // Mettre à jour dans la base de données
    if (combined.length > 0) {
        const { error: updateError } = await supabase
            .from('pricing_recommendations')
            .upsert(combined, {
                onConflict: 'property_id,date'
            });
        
        if (updateError) {
            console.error(`  ✗ Erreur lors de la mise à jour: ${updateError.message}`);
            throw updateError;
        }
        
        updatedCount = combined.length;
    }
    
    console.log(`  ✓ ${updatedCount} recommandation(s) combinée(s) et mise(s) à jour`);
    
    return combined;
}

/**
 * Génère les recommandations finales en appelant tous les modèles puis en les combinant
 */
async function generateFinalRecommendations(propertyId, startDate, endDate) {
    console.log(`\n[Ensemble] Génération des recommandations finales pour ${propertyId}`);
    console.log(`  Plage: ${startDate} → ${endDate}\n`);
    
    // Note: Dans un pipeline automatisé, les prédictions individuelles sont déjà calculées
    // Ici, on combine juste les résultats existants
    
    try {
        const combined = await combinePredictions(propertyId, startDate, endDate);
        
        console.log(`\n[Ensemble] Terminé`);
        console.log(`  ✓ ${combined.length} recommandation(s) finale(s) générée(s)`);
        
        return combined;
    } catch (error) {
        console.error(`\n[Ensemble] Erreur:`, error);
        throw error;
    }
}

// Si le script est exécuté directement
if (require.main === module) {
    const args = process.argv.slice(2);
    
    let propertyId = null;
    let startDate = null;
    let endDate = null;
    
    args.forEach(arg => {
        if (arg.startsWith('--property-id=')) {
            propertyId = arg.split('=')[1];
        } else if (arg.startsWith('--start-date=')) {
            startDate = arg.split('=')[1];
        } else if (arg.startsWith('--end-date=')) {
            endDate = arg.split('=')[1];
        }
    });
    
    if (!propertyId) {
        console.error('--property-id est requis');
        process.exit(1);
    }
    
    if (!startDate || !endDate) {
        const today = new Date();
        startDate = startDate || today.toISOString().split('T')[0];
        const futureDate = new Date(today);
        futureDate.setDate(futureDate.getDate() + 90);
        endDate = endDate || futureDate.toISOString().split('T')[0];
    }
    
    generateFinalRecommendations(propertyId, startDate, endDate)
        .then(() => {
            console.log('\n✓ Recommandations finales générées avec succès');
            process.exit(0);
        })
        .catch(error => {
            console.error('\n✗ Erreur:', error);
            process.exit(1);
        });
}

module.exports = {
    combinePredictions,
    generateFinalRecommendations,
    DEFAULT_WEIGHTS
};

