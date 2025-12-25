// Test de la fonction calculateTieredPricing
function calculateTieredPricing(quantityPrincipal) {
    if (quantityPrincipal === 0) {
        return { totalAmount: 0, breakdown: [] };
    }
    
    // Prix en centimes par palier
    const TIERS = [
        { start: 1, end: 1, pricePerUnit: 1399 },      // 1ère unité : €13.99
        { start: 2, end: 5, pricePerUnit: 1199 },     // Unités 2-5 : €11.99
        { start: 6, end: 15, pricePerUnit: 899 },      // Unités 6-15 : €8.99
        { start: 16, end: 30, pricePerUnit: 549 },    // Unités 16-30 : €5.49
        { start: 31, end: Infinity, pricePerUnit: 399 } // 30+ unités : €3.99
    ];
    
    let totalAmount = 0;
    const breakdown = [];
    
    for (const tier of TIERS) {
        if (quantityPrincipal < tier.start) break;
        
        // Calculer combien d'unités dans ce palier
        const unitsInTier = Math.min(quantityPrincipal, tier.end) - tier.start + 1;
        const tierAmount = unitsInTier * tier.pricePerUnit;
        
        if (unitsInTier > 0) {
            totalAmount += tierAmount;
            breakdown.push({
                range: tier.end === Infinity 
                    ? `${tier.start}+` 
                    : tier.start === tier.end 
                        ? `${tier.start}` 
                        : `${tier.start}-${tier.end}`,
                units: unitsInTier,
                pricePerUnit: tier.pricePerUnit,
                amount: tierAmount
            });
        }
    }
    
    return { totalAmount, breakdown };
}

// Test avec 6 unités
console.log('=== Test avec 6 unités ===');
const result6 = calculateTieredPricing(6);
console.log('Total (centimes):', result6.totalAmount);
console.log('Total (euros):', result6.totalAmount / 100);
console.log('Breakdown:', JSON.stringify(result6.breakdown, null, 2));
console.log('\nCalcul attendu:');
console.log('- 1ère unité: 13.99€');
console.log('- Unités 2-5 (4 unités): 4 × 11.99€ = 47.96€');
console.log('- 6ème unité: 8.99€');
console.log('Total attendu: 13.99€ + 47.96€ + 8.99€ = 70.94€');
console.log('Total calculé:', result6.totalAmount / 100, '€');

// Test avec d'autres quantités
console.log('\n=== Test avec 1 unité ===');
const result1 = calculateTieredPricing(1);
console.log('Total:', result1.totalAmount / 100, '€');

console.log('\n=== Test avec 5 unités ===');
const result5 = calculateTieredPricing(5);
console.log('Total:', result5.totalAmount / 100, '€');

console.log('\n=== Test avec 10 unités ===');
const result10 = calculateTieredPricing(10);
console.log('Total:', result10.totalAmount / 100, '€');

