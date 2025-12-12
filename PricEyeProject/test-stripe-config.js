/**
 * Script de test pour valider la configuration Stripe
 * Exécutez : node test-stripe-config.js
 */

require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

async function testStripeConfig() {
  console.log('🔍 Test de configuration Stripe...\n');
  
  // Test 1 : Vérifier que les variables sont chargées
  console.log('1️⃣ Vérification des variables d\'environnement :');
  const requiredVars = [
    'STRIPE_SECRET_KEY',
    'STRIPE_PUBLISHABLE_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_PRODUCT_PARENT_ID',
    'STRIPE_PRICE_PARENT_ID',
    'STRIPE_PRODUCT_CHILD_ID',
    'STRIPE_PRICE_CHILD_ID'
  ];
  
  let allVarsPresent = true;
  requiredVars.forEach(varName => {
    const value = process.env[varName];
    if (value) {
      // Masquer les valeurs sensibles
      const displayValue = varName.includes('SECRET') || varName.includes('KEY') 
        ? value.substring(0, 10) + '...' 
        : value;
      console.log(`   ✅ ${varName}: ${displayValue}`);
    } else {
      console.log(`   ❌ ${varName}: MANQUANT`);
      allVarsPresent = false;
    }
  });
  
  if (!allVarsPresent) {
    console.log('\n❌ Certaines variables sont manquantes. Vérifiez votre fichier .env');
    return;
  }
  
  console.log('\n2️⃣ Test de connexion à Stripe :');
  try {
    const products = await stripe.products.list({ limit: 5 });
    console.log(`   ✅ Connexion Stripe OK (${products.data.length} produits trouvés)`);
  } catch (error) {
    console.log(`   ❌ Erreur de connexion: ${error.message}`);
    return;
  }
  
  console.log('\n3️⃣ Vérification des IDs produits/prix :');
  
  try {
    // Vérifier le produit parent
    const parentProduct = await stripe.products.retrieve(process.env.STRIPE_PRODUCT_PARENT_ID);
    console.log(`   ✅ Produit Parent: ${parentProduct.name} (${parentProduct.id})`);
    
    // Vérifier le prix parent
    const parentPrice = await stripe.prices.retrieve(process.env.STRIPE_PRICE_PARENT_ID);
    const parentAmount = parentPrice.unit_amount ? (parentPrice.unit_amount / 100) : 'N/A';
    console.log(`   ✅ Prix Parent: ${parentAmount}€ (${parentPrice.id})`);
    
    // Vérifier que le prix appartient au produit
    const parentPriceProductId = typeof parentPrice.product === 'string' 
      ? parentPrice.product 
      : parentPrice.product.id;
    if (parentPriceProductId === process.env.STRIPE_PRODUCT_PARENT_ID) {
      console.log(`   ✅ Le prix parent correspond au produit parent`);
    } else {
      console.log(`   ⚠️  ATTENTION: Le prix parent ne correspond pas au produit parent`);
    }
    
    // Vérifier le produit enfant
    const childProduct = await stripe.products.retrieve(process.env.STRIPE_PRODUCT_CHILD_ID);
    console.log(`   ✅ Produit Enfant: ${childProduct.name} (${childProduct.id})`);
    
    // Vérifier le prix enfant
    const childPrice = await stripe.prices.retrieve(process.env.STRIPE_PRICE_CHILD_ID);
    const childAmount = childPrice.unit_amount ? (childPrice.unit_amount / 100) : 'N/A';
    console.log(`   ✅ Prix Enfant: ${childAmount}€ (${childPrice.id})`);
    
    // Vérifier que le prix appartient au produit
    const childPriceProductId = typeof childPrice.product === 'string' 
      ? childPrice.product 
      : childPrice.product.id;
    if (childPriceProductId === process.env.STRIPE_PRODUCT_CHILD_ID) {
      console.log(`   ✅ Le prix enfant correspond au produit enfant`);
    } else {
      console.log(`   ⚠️  ATTENTION: Le prix enfant ne correspond pas au produit enfant`);
    }
    
    console.log('\n✅ Configuration Stripe validée avec succès !');
    console.log('\n📝 Prochaines étapes :');
    console.log('   1. Configurez le webhook dans Stripe Dashboard');
    console.log('   2. Récupérez le STRIPE_WEBHOOK_SECRET');
    console.log('   3. Passez à la Phase 2 : Onboarding & Stripe Checkout');
    
  } catch (error) {
    console.log(`   ❌ Erreur lors de la vérification: ${error.message}`);
    if (error.type === 'StripeInvalidRequestError') {
      console.log('   💡 Vérifiez que les IDs produits/prix sont corrects dans votre .env');
    }
  }
}

testStripeConfig().catch(console.error);


