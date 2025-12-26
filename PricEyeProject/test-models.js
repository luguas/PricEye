/**
 * Script de test rapide pour vérifier que les modèles d'IA fonctionnent
 * 
 * Usage: node test-models.js
 */

const { supabase } = require('./config/supabase.js');

async function testModels() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  🧪 TEST DES MODÈLES D\'IA POUR LE PRICING DYNAMIQUE');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  try {
    // 1. Vérifier les tables
    console.log('📋 1. Vérification des tables...');
    const tables = [
      { name: 'calendar', description: 'Données calendar' },
      { name: 'features_pricing_daily', description: 'Features ML' },
      { name: 'demand_forecasts', description: 'Prévisions Prophet' },
      { name: 'pricing_recommendations', description: 'Recommandations ML' },
      { name: 'model_runs', description: 'Logs d\'exécution' }
    ];
    
    for (const table of tables) {
      const { count, error } = await supabase
        .from(table.name)
        .select('*', { count: 'exact', head: true });
      
      if (error) {
        if (error.code === 'PGRST204' || error.message.includes('does not exist')) {
          console.log(`   ❌ Table ${table.name}: N'EXISTE PAS (exécutez la migration SQL)`);
        } else {
          console.log(`   ⚠️  Table ${table.name}: ${error.message}`);
        }
      } else {
        console.log(`   ✅ Table ${table.name}: ${count || 0} entrées`);
      }
    }
    
    // 2. Vérifier les données de base
    console.log('\n📊 2. Vérification des données de base...');
    
    const { data: properties, error: propsError } = await supabase
      .from('properties')
      .select('id, name, address')
      .limit(5);
    
    if (propsError) {
      console.log(`   ❌ Erreur lors de la récupération des propriétés: ${propsError.message}`);
      return;
    }
    
    if (!properties || properties.length === 0) {
      console.log('   ❌ Aucune propriété trouvée dans la base de données');
      console.log('   💡 Créez au moins une propriété avant de tester les modèles');
      return;
    }
    
    console.log(`   ✅ ${properties.length} propriété(s) trouvée(s)`);
    const testProperty = properties[0];
    const propertyId = testProperty.id;
    const propertyName = testProperty.name || testProperty.address || propertyId;
    console.log(`   📍 Propriété de test: ${propertyName}`);
    console.log(`      ID: ${propertyId}`);
    
    // Vérifier les réservations
    const { count: bookingsCount, error: bookingsError } = await supabase
      .from('bookings')
      .select('*', { count: 'exact', head: true })
      .eq('property_id', propertyId);
    
    if (!bookingsError) {
      console.log(`   📅 Réservations pour cette propriété: ${bookingsCount || 0}`);
      if (bookingsCount < 10) {
        console.log('      ⚠️  Attention: Moins de 10 réservations peuvent limiter l\'entraînement des modèles');
      }
    }
    
    // 3. Vérifier les données calendar
    console.log('\n📅 3. Vérification des données Calendar...');
    const { count: calendarCount, error: calendarError } = await supabase
      .from('calendar')
      .select('*', { count: 'exact', head: true })
      .eq('property_id', propertyId);
    
    if (calendarError && calendarError.code !== 'PGRST204') {
      console.log(`   ⚠️  Erreur: ${calendarError.message}`);
    } else {
      console.log(`   📅 Entrées calendar: ${calendarCount || 0}`);
      if (calendarCount === 0) {
        console.log('      💡 Exécutez: node data/ingest_calendar_from_existing.js');
      }
    }
    
    // 4. Vérifier les features
    console.log('\n🔧 4. Vérification des Features...');
    const { count: featuresCount, error: featuresError } = await supabase
      .from('features_pricing_daily')
      .select('*', { count: 'exact', head: true })
      .eq('property_id', propertyId);
    
    if (featuresError && featuresError.code !== 'PGRST204') {
      console.log(`   ⚠️  Erreur: ${featuresError.message}`);
    } else {
      console.log(`   🔧 Entrées features: ${featuresCount || 0}`);
      if (featuresCount === 0) {
        console.log('      💡 Exécutez: node features/build_features_pricing_daily.js');
      } else {
        // Afficher un exemple de feature
        const { data: sampleFeature } = await supabase
          .from('features_pricing_daily')
          .select('date, occupancy_rate_30d, demand_score_30d')
          .eq('property_id', propertyId)
          .not('occupancy_rate_30d', 'is', null)
          .limit(1)
          .single();
        
        if (sampleFeature) {
          console.log(`   ✅ Exemple de feature (${sampleFeature.date}):`);
          console.log(`      - Occupancy 30d: ${sampleFeature.occupancy_rate_30d}%`);
          console.log(`      - Demand score 30d: ${sampleFeature.demand_score_30d}`);
        }
      }
    }
    
    // 5. Vérifier les prévisions Prophet
    console.log('\n📈 5. Vérification des prévisions Prophet...');
    const { count: forecastCount, error: forecastError } = await supabase
      .from('demand_forecasts')
      .select('*', { count: 'exact', head: true });
    
    if (forecastError && forecastError.code !== 'PGRST204') {
      console.log(`   ⚠️  Erreur: ${forecastError.message}`);
    } else {
      console.log(`   📈 Prévisions de demande: ${forecastCount || 0}`);
      if (forecastCount === 0) {
        console.log('      💡 Exécutez: node models/forecast/prophet_demand_forecast.js');
      }
    }
    
    // 6. Vérifier les recommandations ML
    console.log('\n💰 6. Vérification des Recommandations ML...');
    const { count: recCount, error: recError } = await supabase
      .from('pricing_recommendations')
      .select('*', { count: 'exact', head: true })
      .eq('property_id', propertyId);
    
    if (recError && recError.code !== 'PGRST204') {
      console.log(`   ⚠️  Erreur: ${recError.message}`);
    } else {
      console.log(`   💰 Recommandations: ${recCount || 0}`);
      
      if (recCount > 0) {
        // Compter par modèle
        const { count: xgboostCount } = await supabase
          .from('pricing_recommendations')
          .select('*', { count: 'exact', head: true })
          .eq('property_id', propertyId)
          .not('price_xgboost', 'is', null);
        
        const { count: nnCount } = await supabase
          .from('pricing_recommendations')
          .select('*', { count: 'exact', head: true })
          .eq('property_id', propertyId)
          .not('price_neural_network', 'is', null);
        
        const { count: gpt4Count } = await supabase
          .from('pricing_recommendations')
          .select('*', { count: 'exact', head: true })
          .eq('property_id', propertyId)
          .not('price_gpt4', 'is', null);
        
        const { count: ensembleCount } = await supabase
          .from('pricing_recommendations')
          .select('*', { count: 'exact', head: true })
          .eq('property_id', propertyId)
          .not('price_recommended', 'is', null);
        
        console.log(`      - XGBoost: ${xgboostCount || 0}`);
        console.log(`      - Neural Network: ${nnCount || 0}`);
        console.log(`      - GPT-4: ${gpt4Count || 0}`);
        console.log(`      - Ensemble (final): ${ensembleCount || 0}`);
        
        // Afficher un exemple
        const { data: sampleRec } = await supabase
          .from('pricing_recommendations')
          .select('*')
          .eq('property_id', propertyId)
          .not('price_recommended', 'is', null)
          .limit(1)
          .single();
        
        if (sampleRec) {
          console.log(`\n   ✅ Exemple de recommandation (${sampleRec.date}):`);
          console.log(`      - Prix recommandé: ${sampleRec.price_recommended}€`);
          console.log(`      - Confiance: ${sampleRec.confidence_score}%`);
          if (sampleRec.explanation_text) {
            const explanation = sampleRec.explanation_text.substring(0, 150);
            console.log(`      - Explication: ${explanation}...`);
          }
        }
      } else {
        console.log('      💡 Exécutez les modèles de pricing pour générer des recommandations');
        console.log('         - node models/pricing/xgboost_pricing.js --property-id=' + propertyId);
        console.log('         - node models/pricing/neural_network_pricing.js --property-id=' + propertyId);
        console.log('         - node models/pricing/gpt4_pricing_explainer.js --property-id=' + propertyId);
        console.log('         - node models/pricing/ensemble_pricing.js --property-id=' + propertyId);
      }
    }
    
    // 7. Vérifier les logs d'exécution
    console.log('\n📊 7. Vérification des logs d\'exécution...');
    const { count: runsCount, error: runsError } = await supabase
      .from('model_runs')
      .select('*', { count: 'exact', head: true });
    
    if (runsError && runsError.code !== 'PGRST204') {
      console.log(`   ⚠️  Erreur: ${runsError.message}`);
    } else {
      console.log(`   📊 Exécutions loggées: ${runsCount || 0}`);
      
      if (runsCount > 0) {
        const { data: lastRun } = await supabase
          .from('model_runs')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(1)
          .single();
        
        if (lastRun) {
          console.log(`   ✅ Dernière exécution: ${lastRun.run_date}`);
          console.log(`      - Propriétés traitées: ${lastRun.properties_processed}`);
          console.log(`      - Recommandations générées: ${lastRun.recommendations_generated}`);
          console.log(`      - Erreurs: ${lastRun.errors_count}`);
          console.log(`      - Temps: ${lastRun.execution_time_seconds}s`);
        }
      }
    }
    
    // 8. Vérifier la configuration
    console.log('\n⚙️  8. Vérification de la configuration...');
    const hasOpenAIKey = !!process.env.OPENAI_API_KEY;
    console.log(`   ${hasOpenAIKey ? '✅' : '❌'} OPENAI_API_KEY: ${hasOpenAIKey ? 'Configurée' : 'NON configurée'}`);
    
    if (!hasOpenAIKey) {
      console.log('      💡 Ajoutez OPENAI_API_KEY dans votre fichier .env pour utiliser GPT-4');
    }
    
    // Résumé et prochaines étapes
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  📋 RÉSUMÉ ET PROCHAINES ÉTAPES');
    console.log('═══════════════════════════════════════════════════════════════\n');
    
    const steps = [];
    
    if (calendarCount === 0) {
      steps.push('1. Exécutez: node data/ingest_calendar_from_existing.js --property-id=' + propertyId);
    }
    
    if (featuresCount === 0) {
      steps.push('2. Exécutez: node features/build_features_pricing_daily.js --property-id=' + propertyId);
    }
    
    if (forecastCount === 0) {
      steps.push('3. Exécutez: node models/forecast/prophet_demand_forecast.js');
    }
    
    if (recCount === 0) {
      steps.push('4. Exécutez les modèles de pricing (voir ci-dessus)');
      steps.push('5. Exécutez: node models/pricing/ensemble_pricing.js --property-id=' + propertyId);
    }
    
    if (steps.length > 0) {
      console.log('📝 Prochaines étapes à exécuter:\n');
      steps.forEach((step, index) => {
        console.log(`   ${index + 1}. ${step}`);
      });
    } else {
      console.log('✅ Tous les modèles semblent fonctionner !');
      console.log('\n💡 Pour tester le pipeline complet:');
      console.log('   node jobs/run_daily_pricing_pipeline.js');
    }
    
    console.log('\n═══════════════════════════════════════════════════════════════\n');
    
  } catch (error) {
    console.error('\n❌ Erreur lors du test:', error);
    console.error(error.stack);
    process.exit(1);
  }
}

// Exécuter le test
testModels()
  .then(() => {
    console.log('✅ Test terminé');
    process.exit(0);
  })
  .catch(error => {
    console.error('❌ Erreur fatale:', error);
    process.exit(1);
  });

