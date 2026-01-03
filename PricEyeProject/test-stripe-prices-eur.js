/**
 * Script de diagnostic pour vérifier la configuration des prix EUR dans Stripe
 * 
 * Usage: node test-stripe-prices-eur.js
 */

require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

async function diagnoseStripePrices() {
    console.log('🔍 Diagnostic des prix Stripe EUR\n');
    console.log('='.repeat(60));
    
    // 1. Vérifier les variables d'environnement
    console.log('\n1️⃣ Vérification des variables d\'environnement:');
    const parentPriceId = process.env.STRIPE_PRICE_PARENT_ID || process.env.STRIPE_PRICE_PRINCIPAL_ID;
    const childPriceId = process.env.STRIPE_PRICE_CHILD_ID;
    const parentProductId = process.env.STRIPE_PRODUCT_PARENT_ID || process.env.STRIPE_PRODUCT_PRINCIPAL_ID;
    const childProductId = process.env.STRIPE_PRODUCT_CHILD_ID;
    
    console.log(`   STRIPE_PRICE_PARENT_ID: ${parentPriceId || '❌ NON DÉFINI'}`);
    console.log(`   STRIPE_PRICE_CHILD_ID: ${childPriceId || '❌ NON DÉFINI'}`);
    console.log(`   STRIPE_PRODUCT_PARENT_ID: ${parentProductId || '❌ NON DÉFINI'}`);
    console.log(`   STRIPE_PRODUCT_CHILD_ID: ${childProductId || '❌ NON DÉFINI'}`);
    
    if (!parentPriceId || !childPriceId) {
        console.log('\n❌ ERREUR: Les Price IDs ne sont pas tous définis dans .env');
        return;
    }
    
    // 2. Vérifier les prix configurés
    console.log('\n2️⃣ Vérification des prix configurés:');
    
    try {
        const parentPrice = await stripe.prices.retrieve(parentPriceId);
        console.log(`   ✅ Prix Parent trouvé: ${parentPriceId}`);
        console.log(`      - Devise: ${parentPrice.currency.toUpperCase()}`);
        console.log(`      - Montant: ${parentPrice.unit_amount / 100} ${parentPrice.currency.toUpperCase()}`);
        console.log(`      - Actif: ${parentPrice.active ? '✅ Oui' : '❌ Non'}`);
        console.log(`      - Type: ${parentPrice.type}`);
        console.log(`      - Produit: ${typeof parentPrice.product === 'string' ? parentPrice.product : parentPrice.product.id}`);
        
        const childPrice = await stripe.prices.retrieve(childPriceId);
        console.log(`   ✅ Prix Child trouvé: ${childPriceId}`);
        console.log(`      - Devise: ${childPrice.currency.toUpperCase()}`);
        console.log(`      - Montant: ${childPrice.unit_amount / 100} ${childPrice.currency.toUpperCase()}`);
        console.log(`      - Actif: ${childPrice.active ? '✅ Oui' : '❌ Non'}`);
        console.log(`      - Type: ${childPrice.type}`);
        console.log(`      - Produit: ${typeof childPrice.product === 'string' ? childPrice.product : childPrice.product.id}`);
        
        // Vérifier si les prix sont en EUR
        if (parentPrice.currency.toLowerCase() !== 'eur') {
            console.log(`\n⚠️  ATTENTION: Le prix Parent est en ${parentPrice.currency.toUpperCase()}, pas en EUR!`);
        }
        if (childPrice.currency.toLowerCase() !== 'eur') {
            console.log(`\n⚠️  ATTENTION: Le prix Child est en ${childPrice.currency.toUpperCase()}, pas en EUR!`);
        }
        
    } catch (error) {
        console.log(`   ❌ Erreur lors de la récupération des prix: ${error.message}`);
        return;
    }
    
    // 3. Lister tous les prix pour chaque produit
    console.log('\n3️⃣ Liste de tous les prix pour chaque produit:');
    
    // Récupérer le Product ID depuis le prix si non défini
    let actualParentProductId = parentProductId;
    let actualChildProductId = childProductId;
    
    if (!actualParentProductId) {
        try {
            const parentPrice = await stripe.prices.retrieve(parentPriceId);
            actualParentProductId = typeof parentPrice.product === 'string' ? parentPrice.product : parentPrice.product.id;
            console.log(`   Product ID Parent récupéré depuis le prix: ${actualParentProductId}`);
        } catch (error) {
            console.log(`   ❌ Impossible de récupérer le Product ID Parent: ${error.message}`);
        }
    }
    
    if (!actualChildProductId) {
        try {
            const childPrice = await stripe.prices.retrieve(childPriceId);
            actualChildProductId = typeof childPrice.product === 'string' ? childPrice.product : childPrice.product.id;
            console.log(`   Product ID Child récupéré depuis le prix: ${actualChildProductId}`);
        } catch (error) {
            console.log(`   ❌ Impossible de récupérer le Product ID Child: ${error.message}`);
        }
    }
    
    // Lister les prix du produit Parent
    if (actualParentProductId) {
        try {
            const allParentPrices = await stripe.prices.list({
                product: actualParentProductId,
                limit: 100
            });
            
            console.log(`\n   📦 Produit Parent (${actualParentProductId}):`);
            console.log(`      Total de prix: ${allParentPrices.data.length}`);
            
            const eurPrices = allParentPrices.data.filter(p => p.currency.toLowerCase() === 'eur');
            const usdPrices = allParentPrices.data.filter(p => p.currency.toLowerCase() === 'usd');
            
            console.log(`      Prix EUR: ${eurPrices.length}`);
            eurPrices.forEach(price => {
                console.log(`         - ${price.id}: ${price.unit_amount / 100} EUR (${price.active ? 'Actif' : 'Inactif'})`);
            });
            
            console.log(`      Prix USD: ${usdPrices.length}`);
            usdPrices.forEach(price => {
                console.log(`         - ${price.id}: ${price.unit_amount / 100} USD (${price.active ? 'Actif' : 'Inactif'})`);
            });
            
            if (eurPrices.length === 0) {
                console.log(`      ❌ AUCUN PRIX EUR TROUVÉ pour ce produit!`);
            } else {
                const activeEurPrices = eurPrices.filter(p => p.active);
                if (activeEurPrices.length === 0) {
                    console.log(`      ⚠️  Des prix EUR existent mais aucun n'est actif!`);
                } else {
                    console.log(`      ✅ ${activeEurPrices.length} prix EUR actif(s) trouvé(s)`);
                }
            }
            
        } catch (error) {
            console.log(`   ❌ Erreur lors de la récupération des prix du produit Parent: ${error.message}`);
        }
    }
    
    // Lister les prix du produit Child
    if (actualChildProductId) {
        try {
            const allChildPrices = await stripe.prices.list({
                product: actualChildProductId,
                limit: 100
            });
            
            console.log(`\n   📦 Produit Child (${actualChildProductId}):`);
            console.log(`      Total de prix: ${allChildPrices.data.length}`);
            
            const eurPrices = allChildPrices.data.filter(p => p.currency.toLowerCase() === 'eur');
            const usdPrices = allChildPrices.data.filter(p => p.currency.toLowerCase() === 'usd');
            
            console.log(`      Prix EUR: ${eurPrices.length}`);
            eurPrices.forEach(price => {
                console.log(`         - ${price.id}: ${price.unit_amount / 100} EUR (${price.active ? 'Actif' : 'Inactif'})`);
            });
            
            console.log(`      Prix USD: ${usdPrices.length}`);
            usdPrices.forEach(price => {
                console.log(`         - ${price.id}: ${price.unit_amount / 100} USD (${price.active ? 'Actif' : 'Inactif'})`);
            });
            
            if (eurPrices.length === 0) {
                console.log(`      ❌ AUCUN PRIX EUR TROUVÉ pour ce produit!`);
            } else {
                const activeEurPrices = eurPrices.filter(p => p.active);
                if (activeEurPrices.length === 0) {
                    console.log(`      ⚠️  Des prix EUR existent mais aucun n'est actif!`);
                } else {
                    console.log(`      ✅ ${activeEurPrices.length} prix EUR actif(s) trouvé(s)`);
                }
            }
            
        } catch (error) {
            console.log(`   ❌ Erreur lors de la récupération des prix du produit Child: ${error.message}`);
        }
    }
    
    // 4. Recommandations
    console.log('\n4️⃣ Recommandations:');
    
    if (parentPriceId && childPriceId) {
        try {
            const parentPrice = await stripe.prices.retrieve(parentPriceId);
            const childPrice = await stripe.prices.retrieve(childPriceId);
            
            if (parentPrice.currency.toLowerCase() !== 'eur') {
                console.log(`   ⚠️  Le prix Parent configuré (${parentPriceId}) est en ${parentPrice.currency.toUpperCase()}`);
                console.log(`      → Mettez à jour STRIPE_PRICE_PARENT_ID avec un Price ID EUR`);
            }
            
            if (childPrice.currency.toLowerCase() !== 'eur') {
                console.log(`   ⚠️  Le prix Child configuré (${childPriceId}) est en ${childPrice.currency.toUpperCase()}`);
                console.log(`      → Mettez à jour STRIPE_PRICE_CHILD_ID avec un Price ID EUR`);
            }
            
            if (parentPrice.currency.toLowerCase() === 'eur' && childPrice.currency.toLowerCase() === 'eur') {
                console.log(`   ✅ Les prix configurés sont en EUR`);
            }
        } catch (error) {
            console.log(`   ❌ Erreur lors de la vérification: ${error.message}`);
        }
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('✅ Diagnostic terminé\n');
}

// Exécuter le diagnostic
diagnoseStripePrices().catch(error => {
    console.error('❌ Erreur fatale:', error);
    process.exit(1);
});

