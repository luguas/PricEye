/**
 * Script pour tester les imports du pipeline
 * Usage: node test-pipeline-imports.js
 */

console.log('🔍 Test des imports du pipeline...\n');

try {
    console.log('1. Test import supabase...');
    const { supabase } = require('./config/supabase.js');
    console.log('   ✅ supabase importé');
} catch (error) {
    console.log('   ❌ Erreur:', error.message);
}

try {
    console.log('2. Test import supabaseDb...');
    const db = require('./helpers/supabaseDb.js');
    console.log('   ✅ supabaseDb importé');
    console.log('   Fonctions disponibles:', Object.keys(db).slice(0, 5).join(', '), '...');
} catch (error) {
    console.log('   ❌ Erreur:', error.message);
}

try {
    console.log('3. Test import ingestCalendarData...');
    const { ingestCalendarData } = require('./data/ingest_calendar_from_existing.js');
    console.log('   ✅ ingestCalendarData importé');
} catch (error) {
    console.log('   ❌ Erreur:', error.message);
}

try {
    console.log('4. Test import buildFeaturesPricingDaily...');
    const { buildFeaturesPricingDaily } = require('./features/build_features_pricing_daily.js');
    console.log('   ✅ buildFeaturesPricingDaily importé');
} catch (error) {
    console.log('   ❌ Erreur:', error.message);
}

try {
    console.log('5. Test import generateAllDemandForecasts...');
    const { generateAllDemandForecasts } = require('./models/forecast/prophet_demand_forecast.js');
    console.log('   ✅ generateAllDemandForecasts importé');
} catch (error) {
    console.log('   ❌ Erreur:', error.message);
}

try {
    console.log('6. Test import XGBoost...');
    const xgboost = require('./models/pricing/xgboost_pricing.js');
    console.log('   ✅ xgboost_pricing importé');
    console.log('   Fonctions disponibles:', Object.keys(xgboost).join(', '));
    if (!xgboost.generatePriceRecommendations) {
        console.log('   ⚠️  generatePriceRecommendations NON disponible');
    } else {
        console.log('   ✅ generatePriceRecommendations disponible');
    }
} catch (error) {
    console.log('   ❌ Erreur:', error.message);
}

try {
    console.log('7. Test import Neural Network...');
    const nn = require('./models/pricing/neural_network_pricing.js');
    console.log('   ✅ neural_network_pricing importé');
    console.log('   Fonctions disponibles:', Object.keys(nn).join(', '));
    if (!nn.generatePriceRecommendations) {
        console.log('   ⚠️  generatePriceRecommendations NON disponible');
    } else {
        console.log('   ✅ generatePriceRecommendations disponible');
    }
} catch (error) {
    console.log('   ❌ Erreur:', error.message);
}

try {
    console.log('8. Test import GPT-4...');
    const gpt4 = require('./models/pricing/gpt4_pricing_explainer.js');
    console.log('   ✅ gpt4_pricing_explainer importé');
    console.log('   Fonctions disponibles:', Object.keys(gpt4).join(', '));
    if (!gpt4.generatePriceRecommendations) {
        console.log('   ⚠️  generatePriceRecommendations NON disponible');
    } else {
        console.log('   ✅ generatePriceRecommendations disponible');
    }
} catch (error) {
    console.log('   ❌ Erreur:', error.message);
}

try {
    console.log('9. Test import Ensemble...');
    const { generateFinalRecommendations } = require('./models/pricing/ensemble_pricing.js');
    console.log('   ✅ generateFinalRecommendations importé');
} catch (error) {
    console.log('   ❌ Erreur:', error.message);
}

try {
    console.log('10. Test import pipeline complet...');
    const { runDailyPricingPipeline } = require('./jobs/run_daily_pricing_pipeline.js');
    console.log('   ✅ runDailyPricingPipeline importé');
    console.log('   Type:', typeof runDailyPricingPipeline);
} catch (error) {
    console.log('   ❌ Erreur:', error.message);
    console.log('   Stack:', error.stack);
}

console.log('\n✅ Test terminé\n');

