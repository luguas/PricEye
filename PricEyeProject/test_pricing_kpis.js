/**
 * Script de test pour vérifier que le pricing et les KPIs fonctionnent
 * 
 * Usage:
 *   node test_pricing_kpis.js YOUR_TOKEN [propertyId]
 * 
 * Exemple:
 *   node test_pricing_kpis.js eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9... abc-123-def
 */

const BASE_URL = process.env.API_URL || 'http://localhost:3000';

// Couleurs pour la console
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSuccess(message) {
  log(`✅ ${message}`, 'green');
}

function logError(message) {
  log(`❌ ${message}`, 'red');
}

function logInfo(message) {
  log(`ℹ️  ${message}`, 'blue');
}

function logWarning(message) {
  log(`⚠️  ${message}`, 'yellow');
}

async function testEndpoint(name, url, method = 'GET', body = null) {
  try {
    const options = {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    };
    
    if (body) {
      options.body = JSON.stringify(body);
    }
    
    const response = await fetch(url, options);
    const data = await response.json();
    
    if (response.ok) {
      logSuccess(`${name}: OK (${response.status})`);
      return { success: true, data };
    } else {
      logError(`${name}: FAILED (${response.status}) - ${data.error || JSON.stringify(data)}`);
      return { success: false, error: data.error || data };
    }
  } catch (error) {
    logError(`${name}: ERROR - ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function runTests() {
  log('\n' + '='.repeat(60), 'cyan');
  log('🧪 TESTS PRICING & KPIs', 'cyan');
  log('='.repeat(60) + '\n', 'cyan');
  
  const today = new Date();
  const startDate = new Date(today);
  startDate.setMonth(startDate.getMonth() - 1);
  const endDate = new Date(today);
  endDate.setMonth(endDate.getMonth() + 1);
  
  const startDateStr = startDate.toISOString().split('T')[0];
  const endDateStr = endDate.toISOString().split('T')[0];
  
  logInfo(`Période de test: ${startDateStr} à ${endDateStr}\n`);
  
  // Tests KPIs
  log('📊 TESTS KPIs', 'yellow');
  log('-'.repeat(60));
  
  const kpisResult = await testEndpoint(
    'KPIs de base',
    `${BASE_URL}/api/reports/kpis?startDate=${startDateStr}&endDate=${endDateStr}`
  );
  
  if (kpisResult.success) {
    const kpis = kpisResult.data;
    logInfo(`  Revenue: ${kpis.revenue || 0}`);
    logInfo(`  Occupancy: ${kpis.occupancy || 0}%`);
    logInfo(`  ADR: ${kpis.adr || 0}`);
    logInfo(`  RevPAR: ${kpis.revpar || 0}`);
    logInfo(`  AI Gain: ${kpis.iaGain || 0}`);
    logInfo(`  AI Score: ${kpis.iaScore || 0}%`);
  }
  
  await testEndpoint(
    'Revenus dans le temps',
    `${BASE_URL}/api/reports/revenue-over-time?startDate=${startDateStr}&endDate=${endDateStr}`
  );
  
  await testEndpoint(
    'Prévisions de revenus',
    `${BASE_URL}/api/reports/forecast-revenue?startDate=${startDateStr}&endDate=${endDateStr}&forecastPeriod=4`
  );
  
  await testEndpoint(
    'Scénarios de prévision',
    `${BASE_URL}/api/reports/forecast-scenarios?startDate=${startDateStr}&endDate=${endDateStr}&forecastPeriod=4`
  );
  
  await testEndpoint(
    'Radar de prévisions',
    `${BASE_URL}/api/reports/forecast-radar?startDate=${startDateStr}&endDate=${endDateStr}`
  );
  
  await testEndpoint(
    'Revenu vs Objectif',
    `${BASE_URL}/api/reports/revenue-vs-target?startDate=${startDateStr}&endDate=${endDateStr}`
  );
  
  await testEndpoint(
    'ADR par canal',
    `${BASE_URL}/api/reports/adr-by-channel?startDate=${startDateStr}&endDate=${endDateStr}`
  );
  
  await testEndpoint(
    'Marge brute',
    `${BASE_URL}/api/reports/gross-margin?startDate=${startDateStr}&endDate=${endDateStr}`
  );
  
  log('\n');
  
  // Tests Pricing
  if (propertyId) {
    log('💰 TESTS PRICING', 'yellow');
    log('-'.repeat(60));
    
    const pricingResult = await testEndpoint(
      'Génération de stratégie de pricing',
      `${BASE_URL}/api/properties/${propertyId}/pricing-strategy`,
      'POST'
    );
    
    if (pricingResult.success && pricingResult.data.daily_prices) {
      const prices = pricingResult.data.daily_prices;
      logInfo(`  ${prices.length} prix générés`);
      if (prices.length > 0) {
        logInfo(`  Premier prix: ${prices[0].date} = ${prices[0].price}€`);
        logInfo(`  Dernier prix: ${prices[prices.length - 1].date} = ${prices[prices.length - 1].price}€`);
      }
    } else {
      logWarning('  Pas de propertyId fourni, test de pricing ignoré');
    }
  } else {
    logWarning('💰 TESTS PRICING: Ignorés (pas de propertyId fourni)');
  }
  
  log('\n' + '='.repeat(60), 'cyan');
  log('✨ Tests terminés', 'cyan');
  log('='.repeat(60) + '\n', 'cyan');
}

// Récupérer les arguments
const token = process.argv[2];
const propertyId = process.argv[3];

if (!token) {
  logError('❌ Token manquant!');
  logInfo('Usage: node test_pricing_kpis.js YOUR_TOKEN [propertyId]');
  process.exit(1);
}

// Vérifier que fetch est disponible (Node.js 18+)
if (typeof fetch === 'undefined') {
  logError('❌ fetch n\'est pas disponible. Utilisez Node.js 18+ ou installez node-fetch');
  process.exit(1);
}

// Lancer les tests
runTests().catch(error => {
  logError(`Erreur fatale: ${error.message}`);
  process.exit(1);
});

