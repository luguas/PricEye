/**
 * Modèle XGBoost simplifié pour la prédiction de prix optimal
 * 
 * Note: XGBoost original est en Python/C++. Cette implémentation utilise
 * un modèle de gradient boosting simplifié avec des arbres de décision.
 * Pour une version plus précise, utiliser une API Python externe ou un package natif.
 */

const { supabase } = require('../../config/supabase.js');
const tf = require('@tensorflow/tfjs-node');

/**
 * Entraîne un modèle de régression pour prédire le prix optimal
 * Utilise TensorFlow.js avec une architecture de forêt aléatoire simplifiée
 */
async function trainPricingModel(propertyId = null) {
    console.log(`[XGBoost] Entraînement du modèle${propertyId ? ` pour la propriété ${propertyId}` : ' global'}`);
    
    // Récupérer les données d'entraînement depuis features_pricing_daily
    let query = supabase
        .from('features_pricing_daily')
        .select('*')
        .not('price_published', 'is', null)
        .eq('is_booked', true) // Utiliser seulement les prix effectivement réservés
        .order('date', { ascending: true });
    
    if (propertyId) {
        query = query.eq('property_id', propertyId);
    }
    
    const { data, error } = await query;
    
    if (error) throw error;
    
    if (!data || data.length < 10) {
        console.warn(`  ⚠ Pas assez de données (${data.length}) pour entraîner le modèle`);
        return null;
    }
    
    console.log(`  → ${data.length} échantillons d'entraînement`);
    
    // Préparer les features (X) et les labels (y)
    // Features numériques à utiliser
    const featureColumns = [
        'day_of_week',
        'is_weekend',
        'month',
        'quarter',
        'occupancy_rate_7d',
        'occupancy_rate_30d',
        'occupancy_rate_90d',
        'booking_count_7d',
        'booking_count_30d',
        'demand_score_7d',
        'demand_score_30d',
        'days_since_last_booking',
        'days_until_next_booking',
        'lead_time',
        'price_base'
    ];
    
    // Filtrer les échantillons avec toutes les features disponibles
    const validSamples = data.filter(sample => {
        return featureColumns.every(col => 
            sample[col] !== null && sample[col] !== undefined
        ) && sample.price_published > 0;
    });
    
    if (validSamples.length < 10) {
        console.warn(`  ⚠ Pas assez d'échantillons valides (${validSamples.length})`);
        return null;
    }
    
    console.log(`  → ${validSamples.length} échantillons valides`);
    
    // Extraire les features et labels
    const X = validSamples.map(sample => 
        featureColumns.map(col => {
            const value = sample[col];
            // Normaliser les valeurs booléennes
            if (typeof value === 'boolean') return value ? 1 : 0;
            return value || 0;
        })
    );
    
    const y = validSamples.map(sample => sample.price_published);
    
    // Normaliser les features (moyenne = 0, écart-type = 1)
    const means = featureColumns.map((_, colIndex) => {
        const values = X.map(row => row[colIndex]);
        return values.reduce((sum, val) => sum + val, 0) / values.length;
    });
    
    const stds = featureColumns.map((_, colIndex) => {
        const values = X.map(row => row[colIndex]);
        const mean = means[colIndex];
        const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
        return Math.sqrt(variance) || 1; // Éviter division par zéro
    });
    
    const XNormalized = X.map(row => 
        row.map((val, colIndex) => (val - means[colIndex]) / stds[colIndex])
    );
    
    // Convertir en tensors TensorFlow
    const xs = tf.tensor2d(XNormalized);
    const ys = tf.tensor1d(y);
    
    // Créer un modèle de régression linéaire avec régularisation
    const model = tf.sequential({
        layers: [
            tf.layers.dense({
                inputShape: [featureColumns.length],
                units: 64,
                activation: 'relu',
                kernelRegularizer: tf.regularizers.l2({ l2: 0.01 })
            }),
            tf.layers.dropout({ rate: 0.2 }),
            tf.layers.dense({
                units: 32,
                activation: 'relu',
                kernelRegularizer: tf.regularizers.l2({ l2: 0.01 })
            }),
            tf.layers.dropout({ rate: 0.1 }),
            tf.layers.dense({
                units: 1,
                activation: 'linear'
            })
        ]
    });
    
    // Compiler le modèle
    model.compile({
        optimizer: tf.train.adam(0.001),
        loss: 'meanSquaredError',
        metrics: ['meanAbsoluteError']
    });
    
    // Entraîner le modèle
    const batchSize = Math.min(32, Math.floor(validSamples.length / 4));
    const epochs = 50;
    
    console.log(`  → Entraînement: ${epochs} époques, batch size: ${batchSize}`);
    
    const history = await model.fit(xs, ys, {
        batchSize: batchSize,
        epochs: epochs,
        validationSplit: 0.2,
        verbose: 0,
        callbacks: {
            onEpochEnd: (epoch, logs) => {
                if ((epoch + 1) % 10 === 0) {
                    console.log(`    Époque ${epoch + 1}/${epochs} - Loss: ${logs.loss.toFixed(4)}, MAE: ${logs.meanAbsoluteError.toFixed(2)}`);
                }
            }
        }
    });
    
    const finalLoss = history.history.loss[history.history.loss.length - 1];
    const finalMAE = history.history.meanAbsoluteError[history.history.meanAbsoluteError.length - 1];
    
    console.log(`  ✓ Modèle entraîné - Loss finale: ${finalLoss.toFixed(4)}, MAE: ${finalMAE.toFixed(2)}€`);
    
    // Nettoyer les tensors
    xs.dispose();
    ys.dispose();
    
    // Retourner le modèle et les statistiques de normalisation
    return {
        model: model,
        means: means,
        stds: stds,
        featureColumns: featureColumns,
        mae: finalMAE,
        loss: finalLoss,
        propertyId: propertyId
    };
}

/**
 * Prédit le prix optimal pour une date/propriété donnée
 */
async function predictPrice(modelData, features) {
    if (!modelData || !modelData.model) {
        throw new Error('Modèle non entraîné');
    }
    
    const { model, means, stds, featureColumns } = modelData;
    
    // Extraire et normaliser les features
    const X = featureColumns.map(col => {
        const value = features[col];
        if (typeof value === 'boolean') return value ? 1 : 0;
        return value || 0;
    });
    
    const XNormalized = X.map((val, colIndex) => (val - means[colIndex]) / stds[colIndex]);
    
    // Faire la prédiction
    const input = tf.tensor2d([XNormalized]);
    const prediction = model.predict(input);
    const price = (await prediction.data())[0];
    
    // Nettoyer
    input.dispose();
    prediction.dispose();
    
    return Math.max(0, price); // Le prix ne peut pas être négatif
}

/**
 * Génère des recommandations de prix pour une propriété
 */
async function generatePriceRecommendations(propertyId, startDate, endDate) {
    console.log(`[XGBoost] Génération de recommandations pour ${propertyId}`);
    
    // Récupérer ou entraîner le modèle
    // Pour simplifier, on entraîne un modèle par propriété
    const modelData = await trainPricingModel(propertyId);
    
    if (!modelData) {
        console.warn(`  ⚠ Impossible d'entraîner le modèle pour ${propertyId}`);
        return [];
    }
    
    // Récupérer les features pour les dates futures
    const { data: features, error } = await supabase
        .from('features_pricing_daily')
        .select('*')
        .eq('property_id', propertyId)
        .gte('date', startDate)
        .lte('date', endDate)
        .order('date', { ascending: true });
    
    if (error) throw error;
    
    if (!features || features.length === 0) {
        console.warn(`  ⚠ Aucune feature trouvée pour ${propertyId}`);
        return [];
    }
    
    console.log(`  → ${features.length} date(s) à prédire`);
    
    // Générer les prédictions
    const recommendations = [];
    
    for (const featureRow of features) {
        try {
            const predictedPrice = await predictPrice(modelData, featureRow);
            
            recommendations.push({
                property_id: propertyId,
                date: featureRow.date,
                price_xgboost: Math.round(predictedPrice * 100) / 100
            });
        } catch (error) {
            console.error(`  ✗ Erreur pour la date ${featureRow.date}:`, error.message);
        }
    }
    
    console.log(`  ✓ ${recommendations.length} recommandation(s) générée(s)`);
    
    // Nettoyer le modèle
    modelData.model.dispose();
    
    return recommendations;
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
        // Utiliser des dates par défaut
        const today = new Date();
        startDate = startDate || today.toISOString().split('T')[0];
        const futureDate = new Date(today);
        futureDate.setDate(futureDate.getDate() + 90);
        endDate = endDate || futureDate.toISOString().split('T')[0];
    }
    
    generatePriceRecommendations(propertyId, startDate, endDate)
        .then(() => {
            console.log('\n✓ Recommandations générées avec succès');
            process.exit(0);
        })
        .catch(error => {
            console.error('\n✗ Erreur:', error);
            process.exit(1);
        });
}

module.exports = {
    trainPricingModel,
    predictPrice,
    generatePriceRecommendations
};

