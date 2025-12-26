/**
 * Réseau de neurones profond pour la prédiction de prix optimal
 * Utilise TensorFlow.js avec une architecture multi-couches
 */

const { supabase } = require('../../config/supabase.js');
const tf = require('@tensorflow/tfjs-node');

/**
 * Entraîne un réseau de neurones profond pour prédire le prix optimal
 */
async function trainNeuralNetworkModel(propertyId = null) {
    console.log(`[Neural Network] Entraînement du modèle${propertyId ? ` pour la propriété ${propertyId}` : ' global'}`);
    
    // Récupérer les données d'entraînement (même logique que XGBoost)
    let query = supabase
        .from('features_pricing_daily')
        .select('*')
        .not('price_published', 'is', null)
        .eq('is_booked', true)
        .order('date', { ascending: true });
    
    if (propertyId) {
        query = query.eq('property_id', propertyId);
    }
    
    const { data, error } = await query;
    
    if (error) throw error;
    
    if (!data || data.length < 20) {
        console.warn(`  ⚠ Pas assez de données (${data.length}) pour entraîner le modèle`);
        return null;
    }
    
    console.log(`  → ${data.length} échantillons d'entraînement`);
    
    // Features à utiliser (même que XGBoost)
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
    
    const validSamples = data.filter(sample => {
        return featureColumns.every(col => 
            sample[col] !== null && sample[col] !== undefined
        ) && sample.price_published > 0;
    });
    
    if (validSamples.length < 20) {
        console.warn(`  ⚠ Pas assez d'échantillons valides (${validSamples.length})`);
        return null;
    }
    
    console.log(`  → ${validSamples.length} échantillons valides`);
    
    // Préparer les données
    const X = validSamples.map(sample => 
        featureColumns.map(col => {
            const value = sample[col];
            if (typeof value === 'boolean') return value ? 1 : 0;
            return value || 0;
        })
    );
    
    const y = validSamples.map(sample => sample.price_published);
    
    // Normaliser les features
    const means = featureColumns.map((_, colIndex) => {
        const values = X.map(row => row[colIndex]);
        return values.reduce((sum, val) => sum + val, 0) / values.length;
    });
    
    const stds = featureColumns.map((_, colIndex) => {
        const values = X.map(row => row[colIndex]);
        const mean = means[colIndex];
        const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
        return Math.sqrt(variance) || 1;
    });
    
    const XNormalized = X.map(row => 
        row.map((val, colIndex) => (val - means[colIndex]) / stds[colIndex])
    );
    
    // Normaliser aussi les labels pour améliorer l'entraînement
    const yMean = y.reduce((sum, val) => sum + val, 0) / y.length;
    const yStd = Math.sqrt(y.reduce((sum, val) => sum + Math.pow(val - yMean, 2), 0) / y.length) || 1;
    const yNormalized = y.map(val => (val - yMean) / yStd);
    
    // Convertir en tensors
    const xs = tf.tensor2d(XNormalized);
    const ys = tf.tensor1d(yNormalized);
    
    // Créer un modèle de réseau de neurones profond
    const model = tf.sequential({
        layers: [
            tf.layers.dense({
                inputShape: [featureColumns.length],
                units: 128,
                activation: 'relu',
                kernelRegularizer: tf.regularizers.l2({ l2: 0.01 })
            }),
            tf.layers.batchNormalization(),
            tf.layers.dropout({ rate: 0.3 }),
            
            tf.layers.dense({
                units: 64,
                activation: 'relu',
                kernelRegularizer: tf.regularizers.l2({ l2: 0.01 })
            }),
            tf.layers.batchNormalization(),
            tf.layers.dropout({ rate: 0.2 }),
            
            tf.layers.dense({
                units: 32,
                activation: 'relu',
                kernelRegularizer: tf.regularizers.l2({ l2: 0.01 })
            }),
            tf.layers.dropout({ rate: 0.1 }),
            
            tf.layers.dense({
                units: 1,
                activation: 'linear' // Prix prédit (dénormalisé après)
            })
        ]
    });
    
    // Compiler avec un learning rate adaptatif
    model.compile({
        optimizer: tf.train.adam(0.001),
        loss: 'meanSquaredError',
        metrics: ['meanAbsoluteError']
    });
    
    // Entraîner
    const batchSize = Math.min(32, Math.floor(validSamples.length / 4));
    const epochs = 100;
    
    console.log(`  → Entraînement: ${epochs} époques, batch size: ${batchSize}`);
    
    const history = await model.fit(xs, ys, {
        batchSize: batchSize,
        epochs: epochs,
        validationSplit: 0.2,
        verbose: 0,
        callbacks: {
            onEpochEnd: (epoch, logs) => {
                if ((epoch + 1) % 20 === 0) {
                    console.log(`    Époque ${epoch + 1}/${epochs} - Loss: ${logs.loss.toFixed(4)}, MAE: ${logs.meanAbsoluteError.toFixed(4)}`);
                }
            }
        }
    });
    
    const finalLoss = history.history.loss[history.history.loss.length - 1];
    const finalMAE = history.history.meanAbsoluteError[history.history.meanAbsoluteError.length - 1];
    
    console.log(`  ✓ Modèle entraîné - Loss finale: ${finalLoss.toFixed(4)}, MAE: ${finalMAE.toFixed(4)}`);
    
    // Nettoyer
    xs.dispose();
    ys.dispose();
    
    return {
        model: model,
        means: means,
        stds: stds,
        yMean: yMean,
        yStd: yStd,
        featureColumns: featureColumns,
        mae: finalMAE * yStd, // Dénormaliser pour obtenir le MAE en euros
        loss: finalLoss,
        propertyId: propertyId
    };
}

/**
 * Prédit le prix avec le réseau de neurones
 */
async function predictPrice(modelData, features) {
    if (!modelData || !modelData.model) {
        throw new Error('Modèle non entraîné');
    }
    
    const { model, means, stds, featureColumns, yMean, yStd } = modelData;
    
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
    const priceNormalized = (await prediction.data())[0];
    
    // Dénormaliser le prix
    const price = priceNormalized * yStd + yMean;
    
    // Nettoyer
    input.dispose();
    prediction.dispose();
    
    return Math.max(0, price);
}

/**
 * Génère des recommandations de prix pour une propriété
 */
async function generatePriceRecommendations(propertyId, startDate, endDate) {
    console.log(`[Neural Network] Génération de recommandations pour ${propertyId}`);
    
    // Entraîner le modèle
    const modelData = await trainNeuralNetworkModel(propertyId);
    
    if (!modelData) {
        console.warn(`  ⚠ Impossible d'entraîner le modèle pour ${propertyId}`);
        return [];
    }
    
    // Récupérer les features
    const { data: features, error } = await supabase
        .from('features_pricing_daily')
        .select('*')
        .eq('property_id', propertyId)
        .gte('date', startDate)
        .lte('date', endDate)
        .order('date', { ascending: true });
    
    if (error) throw error;
    
    if (!features || features.length === 0) {
        console.warn(`  ⚠ Aucune feature trouvée`);
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
                price_neural_network: Math.round(predictedPrice * 100) / 100
            });
        } catch (error) {
            console.error(`  ✗ Erreur pour ${featureRow.date}:`, error.message);
        }
    }
    
    console.log(`  ✓ ${recommendations.length} recommandation(s) générée(s)`);
    
    // Nettoyer
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
    trainNeuralNetworkModel,
    predictPrice,
    generatePriceRecommendations
};

