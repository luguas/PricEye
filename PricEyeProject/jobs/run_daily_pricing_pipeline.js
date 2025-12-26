/**
 * Pipeline quotidien pour le système de pricing dynamique
 * 
 * Ce script orchestre toutes les étapes :
 * 1. Ingestion des données
 * 2. Feature engineering
 * 3. Forecasting de demande (Prophet)
 * 4. Prédictions de prix (XGBoost, Neural Network, GPT-4)
 * 5. Combinaison (Ensemble)
 * 6. Application des prix recommandés (si auto-pricing activé)
 * 7. Logging et monitoring
 */

const { supabase } = require('../config/supabase.js');
const db = require('../helpers/supabaseDb.js');

// Importer les modules nécessaires
const { ingestCalendarData } = require('../data/ingest_calendar_from_existing.js');
const { buildFeaturesPricingDaily } = require('../features/build_features_pricing_daily.js');
const { generateAllDemandForecasts } = require('../models/forecast/prophet_demand_forecast.js');
const { generatePriceRecommendations: generateXGBoostRecommendations } = require('../models/pricing/xgboost_pricing.js');
const { generatePriceRecommendations: generateNNRecommendations } = require('../models/pricing/neural_network_pricing.js');
const { generatePriceRecommendations: generateGPT4Recommendations } = require('../models/pricing/gpt4_pricing_explainer.js');
const { generateFinalRecommendations } = require('../models/pricing/ensemble_pricing.js');

/**
 * Formate une date au format YYYY-MM-DD
 */
function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Récupère toutes les propriétés des utilisateurs avec auto-pricing activé
 */
async function getPropertiesWithAutoPricing() {
    // Récupérer tous les utilisateurs avec auto_pricing.enabled = true
    const { data: users, error } = await supabase
        .from('users')
        .select('id, auto_pricing')
        .not('auto_pricing', 'is', null);
    
    if (error) {
        console.error('[Pipeline] Erreur lors de la récupération des utilisateurs:', error);
        return [];
    }
    
    // Filtrer les utilisateurs avec auto_pricing.enabled = true
    const usersWithAutoPricing = (users || []).filter(user => {
        const autoPricing = user.auto_pricing;
        return autoPricing && (autoPricing.enabled === true || autoPricing.enabled === 'true');
    });
    
    if (usersWithAutoPricing.length === 0) {
        return [];
    }
    
    const userIds = usersWithAutoPricing.map(u => u.id);
    
    // Récupérer toutes les propriétés de ces utilisateurs
    const allProperties = [];
    
    for (const userId of userIds) {
        try {
            // Récupérer les propriétés par owner_id
            const ownerProperties = await db.getPropertiesByOwner(userId);
            allProperties.push(...ownerProperties);
        } catch (error) {
            console.error(`[Pipeline] Erreur lors de la récupération des propriétés pour ${userId}:`, error);
        }
    }
    
    return allProperties;
}

/**
 * Applique les prix recommandés aux propriétés avec auto-pricing activé
 */
async function applyRecommendedPrices() {
    console.log(`\n[Pipeline] Application des prix recommandés...`);
    
    const properties = await getPropertiesWithAutoPricing();
    
    if (properties.length === 0) {
        console.log(`  → Aucune propriété avec auto-pricing activé`);
        return { applied: 0, skipped: 0, errors: [] };
    }
    
    console.log(`  → ${properties.length} propriété(s) avec auto-pricing activé`);
    
    const today = new Date();
    const futureDate = new Date(today);
    futureDate.setDate(futureDate.getDate() + 90);
    
    const startDate = formatDate(today);
    const endDate = formatDate(futureDate);
    
    let appliedCount = 0;
    let skippedCount = 0;
    const errors = [];
    
    for (const property of properties) {
        try {
            // Récupérer les recommandations pour cette propriété
            const { data: recommendations, error: recError } = await supabase
                .from('pricing_recommendations')
                .select('date, price_recommended')
                .eq('property_id', property.id)
                .gte('date', startDate)
                .lte('date', endDate)
                .not('price_recommended', 'is', null);
            
            if (recError) {
                throw new Error(`Erreur lors de la récupération des recommandations: ${recError.message}`);
            }
            
            if (!recommendations || recommendations.length === 0) {
                console.log(`  → ${property.id}: Aucune recommandation disponible`);
                continue;
            }
            
            // Récupérer les price_overrides existants pour vérifier les verrouillages
            const { data: existingOverrides, error: overrideError } = await supabase
                .from('price_overrides')
                .select('date, is_locked')
                .eq('property_id', property.id)
                .gte('date', startDate)
                .lte('date', endDate);
            
            if (overrideError) {
                console.warn(`  ⚠ Erreur lors de la récupération des overrides pour ${property.id}: ${overrideError.message}`);
            }
            
            const lockedDates = new Set(
                (existingOverrides || [])
                    .filter(o => o.is_locked === true)
                    .map(o => o.date)
            );
            
            // Créer les price_overrides (sauf pour les dates verrouillées)
            const overridesToApply = recommendations
                .filter(rec => !lockedDates.has(rec.date))
                .map(rec => ({
                    property_id: property.id,
                    date: rec.date,
                    price: rec.price_recommended,
                    is_locked: false,
                    reason: 'Auto-pricing ML',
                    updated_by: 'system-pipeline'
                }));
            
            if (overridesToApply.length === 0) {
                skippedCount += recommendations.length;
                console.log(`  → ${property.id}: Toutes les dates sont verrouillées`);
                continue;
            }
            
            // Appliquer les prix
            const { error: applyError } = await supabase
                .from('price_overrides')
                .upsert(overridesToApply, {
                    onConflict: 'property_id,date'
                });
            
            if (applyError) {
                throw new Error(`Erreur lors de l'application: ${applyError.message}`);
            }
            
            appliedCount += overridesToApply.length;
            skippedCount += recommendations.length - overridesToApply.length;
            
            console.log(`  ✓ ${property.id}: ${overridesToApply.length} prix appliqué(s), ${recommendations.length - overridesToApply.length} ignoré(s) (verrouillés)`);
            
        } catch (error) {
            console.error(`  ✗ Erreur pour ${property.id}:`, error.message);
            errors.push({
                propertyId: property.id,
                error: error.message
            });
        }
    }
    
    console.log(`\n[Pipeline] Prix appliqués: ${appliedCount} appliqué(s), ${skippedCount} ignoré(s), ${errors.length} erreur(s)`);
    
    return { applied: appliedCount, skipped: skippedCount, errors };
}

/**
 * Enregistre une exécution du pipeline dans model_runs
 */
async function logPipelineRun(stats) {
    const runDate = formatDate(new Date());
    
    const runData = {
        run_date: runDate,
        run_type: 'daily',
        properties_processed: stats.propertiesProcessed || 0,
        recommendations_generated: stats.recommendationsGenerated || 0,
        errors_count: stats.errorsCount || 0,
        execution_time_seconds: stats.executionTimeSeconds || 0,
        model_versions: {
            prophet: '1.0-js',
            xgboost: '1.0-tfjs',
            neuralNetwork: '1.0-tfjs',
            gpt4: 'gpt-4o',
            ensemble: '1.0'
        },
        errors: stats.errors || []
    };
    
    const { error } = await supabase
        .from('model_runs')
        .insert(runData);
    
    if (error) {
        console.error('[Pipeline] Erreur lors de l''enregistrement du log:', error);
    } else {
        console.log(`\n[Pipeline] Exécution loggée: ${runDate}`);
    }
}

/**
 * Fonction principale du pipeline quotidien
 */
async function runDailyPricingPipeline(options = {}) {
    const startTime = Date.now();
    const stats = {
        propertiesProcessed: 0,
        recommendationsGenerated: 0,
        errorsCount: 0,
        errors: []
    };
    
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  PIPELINE QUOTIDIEN DE PRICING DYNAMIQUE');
    console.log('═══════════════════════════════════════════════════════════════\n');
    
    // Calculer les dates
    const today = new Date();
    const futureDate = new Date(today);
    futureDate.setDate(futureDate.getDate() + 90);
    
    const startDate = options.startDate || formatDate(today);
    const endDate = options.endDate || formatDate(futureDate);
    
    // Calculer la date de début pour l'historique (12 mois en arrière pour calendar)
    const historicalStart = new Date(today);
    historicalStart.setMonth(historicalStart.getMonth() - 12);
    const historicalStartDate = formatDate(historicalStart);
    
    try {
        // ============================================================
        // ÉTAPE 1 : Ingestion des données
        // ============================================================
        console.log('📥 ÉTAPE 1/7 : Ingestion des données Calendar');
        console.log('─────────────────────────────────────────────────────────\n');
        
        try {
            const ingestResult = await ingestCalendarData({
                startDate: historicalStartDate,
                endDate: endDate
            });
            
            stats.propertiesProcessed += ingestResult.processed || 0;
            if (ingestResult.errors && ingestResult.errors.length > 0) {
                stats.errorsCount += ingestResult.errors.length;
                stats.errors.push(...ingestResult.errors.map(e => ({
                    step: 'ingestion',
                    error: e.error || e
                })));
            }
        } catch (error) {
            console.error('  ✗ Erreur fatale lors de l\'ingestion:', error.message);
            stats.errorsCount++;
            stats.errors.push({ step: 'ingestion', error: error.message });
        }
        
        // ============================================================
        // ÉTAPE 2 : Feature Engineering
        // ============================================================
        console.log('\n\n🔧 ÉTAPE 2/7 : Feature Engineering');
        console.log('─────────────────────────────────────────────────────────\n');
        
        try {
            const featuresResult = await buildFeaturesPricingDaily({
                startDate: startDate,
                endDate: endDate
            });
            
            stats.propertiesProcessed += featuresResult.processed || 0;
            if (featuresResult.errors && featuresResult.errors.length > 0) {
                stats.errorsCount += featuresResult.errors.length;
                stats.errors.push(...featuresResult.errors.map(e => ({
                    step: 'feature_engineering',
                    error: e.error || e
                })));
            }
        } catch (error) {
            console.error('  ✗ Erreur fatale lors du feature engineering:', error.message);
            stats.errorsCount++;
            stats.errors.push({ step: 'feature_engineering', error: error.message });
        }
        
        // ============================================================
        // ÉTAPE 3 : Forecasting de demande (Prophet)
        // ============================================================
        console.log('\n\n📈 ÉTAPE 3/7 : Forecasting de demande (Prophet)');
        console.log('─────────────────────────────────────────────────────────\n');
        
        try {
            const forecastResult = await generateAllDemandForecasts(90);
            
            if (forecastResult.errors && forecastResult.errors.length > 0) {
                stats.errorsCount += forecastResult.errors.length;
                stats.errors.push(...forecastResult.errors.map(e => ({
                    step: 'prophet_forecast',
                    error: e.error || e
                })));
            }
        } catch (error) {
            console.error('  ✗ Erreur fatale lors du forecasting Prophet:', error.message);
            stats.errorsCount++;
            stats.errors.push({ step: 'prophet_forecast', error: error.message });
        }
        
        // ============================================================
        // ÉTAPE 4 : Prédictions de prix (modèles individuels)
        // ============================================================
        console.log('\n\n💰 ÉTAPE 4/7 : Prédictions de prix (modèles individuels)');
        console.log('─────────────────────────────────────────────────────────\n');
        
        // Récupérer toutes les propriétés à traiter
        const properties = await getPropertiesWithAutoPricing();
        
        if (properties.length === 0) {
            console.log('  → Aucune propriété avec auto-pricing activé, passage des prédictions individuelles');
        } else {
            console.log(`  → ${properties.length} propriété(s) à traiter\n`);
            
            for (const property of properties) {
                try {
                    // XGBoost
                    console.log(`  [XGBoost] ${property.id}...`);
                    try {
                        await generateXGBoostRecommendations(property.id, startDate, endDate);
                    } catch (error) {
                        console.error(`    ✗ Erreur XGBoost: ${error.message}`);
                        stats.errorsCount++;
                        stats.errors.push({ step: 'xgboost', propertyId: property.id, error: error.message });
                    }
                    
                    // Neural Network
                    console.log(`  [Neural Network] ${property.id}...`);
                    try {
                        await generateNNRecommendations(property.id, startDate, endDate);
                    } catch (error) {
                        console.error(`    ✗ Erreur Neural Network: ${error.message}`);
                        stats.errorsCount++;
                        stats.errors.push({ step: 'neural_network', propertyId: property.id, error: error.message });
                    }
                    
                    // GPT-4 (peut être long)
                    console.log(`  [GPT-4] ${property.id}...`);
                    try {
                        await generateGPT4Recommendations(property.id, startDate, endDate);
                    } catch (error) {
                        console.error(`    ✗ Erreur GPT-4: ${error.message}`);
                        stats.errorsCount++;
                        stats.errors.push({ step: 'gpt4', propertyId: property.id, error: error.message });
                    }
                    
                } catch (error) {
                    console.error(`  ✗ Erreur pour la propriété ${property.id}:`, error.message);
                    stats.errorsCount++;
                    stats.errors.push({ step: 'pricing_models', propertyId: property.id, error: error.message });
                }
            }
        }
        
        // ============================================================
        // ÉTAPE 5 : Combinaison (Ensemble Learning)
        // ============================================================
        console.log('\n\n🎯 ÉTAPE 5/7 : Combinaison des prédictions (Ensemble)');
        console.log('─────────────────────────────────────────────────────────\n');
        
        if (properties.length > 0) {
            for (const property of properties) {
                try {
                    const ensembleResult = await generateFinalRecommendations(property.id, startDate, endDate);
                    stats.recommendationsGenerated += ensembleResult.length || 0;
                } catch (error) {
                    console.error(`  ✗ Erreur Ensemble pour ${property.id}:`, error.message);
                    stats.errorsCount++;
                    stats.errors.push({ step: 'ensemble', propertyId: property.id, error: error.message });
                }
            }
        } else {
            console.log('  → Aucune propriété à traiter');
        }
        
        // ============================================================
        // ÉTAPE 6 : Application des prix recommandés
        // ============================================================
        console.log('\n\n✅ ÉTAPE 6/7 : Application des prix recommandés');
        console.log('─────────────────────────────────────────────────────────\n');
        
        try {
            const applyResult = await applyRecommendedPrices();
            stats.propertiesProcessed += applyResult.applied || 0;
            if (applyResult.errors && applyResult.errors.length > 0) {
                stats.errorsCount += applyResult.errors.length;
                stats.errors.push(...applyResult.errors.map(e => ({
                    step: 'apply_prices',
                    error: e.error || e
                })));
            }
        } catch (error) {
            console.error('  ✗ Erreur fatale lors de l\'application des prix:', error.message);
            stats.errorsCount++;
            stats.errors.push({ step: 'apply_prices', error: error.message });
        }
        
        // ============================================================
        // ÉTAPE 7 : Logging et monitoring
        // ============================================================
        console.log('\n\n📊 ÉTAPE 7/7 : Logging et monitoring');
        console.log('─────────────────────────────────────────────────────────\n');
        
        const executionTime = Math.floor((Date.now() - startTime) / 1000);
        stats.executionTimeSeconds = executionTime;
        
        await logPipelineRun(stats);
        
        // Résumé final
        console.log('\n═══════════════════════════════════════════════════════════════');
        console.log('  PIPELINE TERMINÉ');
        console.log('═══════════════════════════════════════════════════════════════');
        console.log(`  ✓ Propriétés traitées: ${stats.propertiesProcessed}`);
        console.log(`  ✓ Recommandations générées: ${stats.recommendationsGenerated}`);
        console.log(`  ✗ Erreurs: ${stats.errorsCount}`);
        console.log(`  ⏱ Temps d'exécution: ${executionTime}s`);
        console.log('═══════════════════════════════════════════════════════════════\n');
        
        return {
            success: stats.errorsCount === 0,
            stats: stats
        };
        
    } catch (error) {
        console.error('\n\n❌ ERREUR FATALE DANS LE PIPELINE:', error);
        stats.errorsCount++;
        stats.errors.push({ step: 'pipeline', error: error.message });
        
        // Logger quand même
        const executionTime = Math.floor((Date.now() - startTime) / 1000);
        stats.executionTimeSeconds = executionTime;
        await logPipelineRun(stats);
        
        throw error;
    }
}

// Si le script est exécuté directement
if (require.main === module) {
    const args = process.argv.slice(2);
    
    const options = {};
    
    args.forEach(arg => {
        if (arg.startsWith('--start-date=')) {
            options.startDate = arg.split('=')[1];
        } else if (arg.startsWith('--end-date=')) {
            options.endDate = arg.split('=')[1];
        }
    });
    
    runDailyPricingPipeline(options)
        .then(result => {
            if (result.success) {
                console.log('\n✓ Pipeline exécuté avec succès');
                process.exit(0);
            } else {
                console.log('\n⚠ Pipeline terminé avec des erreurs');
                process.exit(1);
            }
        })
        .catch(error => {
            console.error('\n✗ Erreur fatale:', error);
            process.exit(1);
        });
}

module.exports = {
    runDailyPricingPipeline
};

