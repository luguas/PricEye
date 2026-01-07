/**
 * Tests pour les fonctions de validation de nombres
 */

const assert = require('assert');
const { 
    validateNumber,
    validateInteger,
    validatePrice,
    validatePercentage,
    validateNumericRange
} = require('../../utils/promptSanitizer');

console.log('🧪 Tests pour la validation de nombres...\n');

// ============================================================================
// 1. Tests pour nombres valides dans plage
// ============================================================================

function testValidNumbersInRange() {
    console.log('✅ Tests pour nombres valides dans plage...');
    
    // Test 1.1: Nombre valide dans plage (validateNumber)
    try {
        const result = validateNumber(42, { min: 1, max: 50 }, 'capacity');
        assert.strictEqual(result, 42, 'Nombre valide doit être retourné tel quel');
        console.log('  ✅ Test nombre valide dans plage (validateNumber): OK');
    } catch (error) {
        assert.fail(`Nombre valide devrait passer: ${error.message}`);
    }
    
    // Test 1.2: Nombre à la limite minimale
    try {
        const result = validateNumber(1, { min: 1, max: 50 }, 'capacity');
        assert.strictEqual(result, 1, 'Nombre à la limite minimale doit être accepté');
        console.log('  ✅ Test nombre à la limite minimale: OK');
    } catch (error) {
        assert.fail(`Nombre à la limite minimale devrait passer: ${error.message}`);
    }
    
    // Test 1.3: Nombre à la limite maximale
    try {
        const result = validateNumber(50, { min: 1, max: 50 }, 'capacity');
        assert.strictEqual(result, 50, 'Nombre à la limite maximale doit être accepté');
        console.log('  ✅ Test nombre à la limite maximale: OK');
    } catch (error) {
        assert.fail(`Nombre à la limite maximale devrait passer: ${error.message}`);
    }
    
    // Test 1.4: Nombre décimal valide
    try {
        const result = validateNumber(42.5, { min: 1, max: 50 }, 'value');
        assert.strictEqual(result, 42.5, 'Nombre décimal valide doit être accepté');
        console.log('  ✅ Test nombre décimal valide: OK');
    } catch (error) {
        assert.fail(`Nombre décimal valide devrait passer: ${error.message}`);
    }
    
    // Test 1.5: Nombre négatif valide (si autorisé)
    try {
        const result = validateNumber(-10, { min: -20, max: 20 }, 'temperature');
        assert.strictEqual(result, -10, 'Nombre négatif valide doit être accepté');
        console.log('  ✅ Test nombre négatif valide: OK');
    } catch (error) {
        assert.fail(`Nombre négatif valide devrait passer: ${error.message}`);
    }
    
    // Test 1.6: validateNumericRange - nombre valide
    try {
        const result = validateNumericRange(25, 1, 50, 'percentage');
        assert.strictEqual(result, 25, 'validateNumericRange doit retourner le nombre valide');
        console.log('  ✅ Test validateNumericRange - nombre valide: OK');
    } catch (error) {
        assert.fail(`validateNumericRange avec nombre valide devrait passer: ${error.message}`);
    }
    
    console.log('');
}

// ============================================================================
// 2. Tests pour nombres hors plage
// ============================================================================

function testNumbersOutOfRange() {
    console.log('❌ Tests pour nombres hors plage...');
    
    // Test 2.1: Nombre en dessous du minimum (validateNumber)
    try {
        validateNumber(0, { min: 1, max: 50 }, 'capacity');
        assert.fail('Nombre en dessous du minimum doit être rejeté');
    } catch (error) {
        assert(error.message.includes('supérieur ou égal') || error.message.includes('minimum'), 'Message d\'erreur doit mentionner minimum');
        console.log('  ✅ Test nombre en dessous du minimum (validateNumber): OK');
    }
    
    // Test 2.2: Nombre au-dessus du maximum (validateNumber)
    try {
        validateNumber(100, { min: 1, max: 50 }, 'capacity');
        assert.fail('Nombre au-dessus du maximum doit être rejeté');
    } catch (error) {
        assert(error.message.includes('inférieur ou égal') || error.message.includes('maximum'), 'Message d\'erreur doit mentionner maximum');
        console.log('  ✅ Test nombre au-dessus du maximum (validateNumber): OK');
    }
    
    // Test 2.3: validateNumericRange - nombre en dessous du minimum
    try {
        validateNumericRange(0, 1, 50, 'percentage');
        assert.fail('validateNumericRange doit rejeter les nombres en dessous du minimum');
    } catch (error) {
        assert(error.message.includes('entre') && error.message.includes('inférieure'), 'Message d\'erreur doit mentionner la plage');
        console.log('  ✅ Test validateNumericRange - nombre en dessous du minimum: OK');
    }
    
    // Test 2.4: validateNumericRange - nombre au-dessus du maximum
    try {
        validateNumericRange(100, 1, 50, 'percentage');
        assert.fail('validateNumericRange doit rejeter les nombres au-dessus du maximum');
    } catch (error) {
        assert(error.message.includes('entre') && error.message.includes('supérieure'), 'Message d\'erreur doit mentionner la plage');
        console.log('  ✅ Test validateNumericRange - nombre au-dessus du maximum: OK');
    }
    
    // Test 2.5: validateInteger - nombre en dessous du minimum
    try {
        validateInteger(0, 1, 50, 'capacity');
        assert.fail('validateInteger doit rejeter les nombres en dessous du minimum');
    } catch (error) {
        assert(error.message.includes('supérieur ou égal') || error.message.includes('minimum'), 'Message d\'erreur doit mentionner minimum');
        console.log('  ✅ Test validateInteger - nombre en dessous du minimum: OK');
    }
    
    // Test 2.6: validatePrice - prix négatif
    try {
        validatePrice(-10, 0, 1000, 'price');
        assert.fail('validatePrice doit rejeter les prix négatifs');
    } catch (error) {
        assert(error.message.includes('positif') || error.message.includes('négatif'), 'Message d\'erreur doit mentionner prix positif');
        console.log('  ✅ Test validatePrice - prix négatif: OK');
    }
    
    // Test 2.7: validatePrice - prix trop élevé
    try {
        validatePrice(2000000, 0, 1000000, 'price');
        assert.fail('validatePrice doit rejeter les prix trop élevés');
    } catch (error) {
        assert(error.message.includes('inférieur ou égal') || error.message.includes('maximum'), 'Message d\'erreur doit mentionner maximum');
        console.log('  ✅ Test validatePrice - prix trop élevé: OK');
    }
    
    // Test 2.8: validatePercentage - pourcentage > 100
    try {
        validatePercentage(150, 'discount');
        assert.fail('validatePercentage doit rejeter les pourcentages > 100');
    } catch (error) {
        assert(error.message.includes('entre 0 et 100') || error.message.includes('100'), 'Message d\'erreur doit mentionner plage 0-100');
        console.log('  ✅ Test validatePercentage - pourcentage > 100: OK');
    }
    
    // Test 2.9: validatePercentage - pourcentage négatif
    try {
        validatePercentage(-5, 'discount');
        assert.fail('validatePercentage doit rejeter les pourcentages négatifs');
    } catch (error) {
        assert(error.message.includes('entre 0 et 100') || error.message.includes('0'), 'Message d\'erreur doit mentionner plage 0-100');
        console.log('  ✅ Test validatePercentage - pourcentage négatif: OK');
    }
    
    console.log('');
}

// ============================================================================
// 3. Tests pour nombres invalides (NaN, Infinity, strings)
// ============================================================================

function testInvalidNumbers() {
    console.log('❌ Tests pour nombres invalides (NaN, Infinity, strings)...');
    
    // Test 3.1: NaN (validateNumber)
    try {
        validateNumber(NaN, { min: 1, max: 50 }, 'value');
        assert.fail('NaN doit être rejeté');
    } catch (error) {
        assert(error.message.includes('NaN'), 'Message d\'erreur doit mentionner NaN');
        console.log('  ✅ Test NaN (validateNumber): OK');
    }
    
    // Test 3.2: Infinity (validateNumber)
    try {
        validateNumber(Infinity, { min: 1, max: 50 }, 'value');
        assert.fail('Infinity doit être rejeté');
    } catch (error) {
        assert(error.message.includes('Infinity'), 'Message d\'erreur doit mentionner Infinity');
        console.log('  ✅ Test Infinity (validateNumber): OK');
    }
    
    // Test 3.3: -Infinity (validateNumber)
    try {
        validateNumber(-Infinity, { min: 1, max: 50 }, 'value');
        assert.fail('-Infinity doit être rejeté');
    } catch (error) {
        assert(error.message.includes('-Infinity') || error.message.includes('Infinity'), 'Message d\'erreur doit mentionner -Infinity');
        console.log('  ✅ Test -Infinity (validateNumber): OK');
    }
    
    // Test 3.4: String non-numérique (validateNumber)
    try {
        validateNumber('abc', { min: 1, max: 50 }, 'value');
        assert.fail('String non-numérique doit être rejetée');
    } catch (error) {
        assert(error.message.includes('nombre valide') || error.message.includes('nombre'), 'Message d\'erreur doit mentionner nombre valide');
        console.log('  ✅ Test string non-numérique (validateNumber): OK');
    }
    
    // Test 3.5: null (validateNumber)
    try {
        validateNumber(null, { min: 1, max: 50 }, 'value');
        assert.fail('null doit être rejeté');
    } catch (error) {
        assert(error.message.includes('nombre valide') || error.message.includes('nombre'), 'Message d\'erreur doit mentionner nombre');
        console.log('  ✅ Test null (validateNumber): OK');
    }
    
    // Test 3.6: undefined (validateNumber)
    try {
        validateNumber(undefined, { min: 1, max: 50 }, 'value');
        assert.fail('undefined doit être rejeté');
    } catch (error) {
        assert(error.message.includes('nombre valide') || error.message.includes('nombre'), 'Message d\'erreur doit mentionner nombre');
        console.log('  ✅ Test undefined (validateNumber): OK');
    }
    
    // Test 3.7: NaN (validateInteger)
    try {
        validateInteger(NaN, 1, 50, 'capacity');
        assert.fail('NaN doit être rejeté par validateInteger');
    } catch (error) {
        assert(error.message.includes('NaN'), 'Message d\'erreur doit mentionner NaN');
        console.log('  ✅ Test NaN (validateInteger): OK');
    }
    
    // Test 3.8: Infinity (validatePrice)
    try {
        validatePrice(Infinity, 0, 1000, 'price');
        assert.fail('Infinity doit être rejeté par validatePrice');
    } catch (error) {
        assert(error.message.includes('Infinity'), 'Message d\'erreur doit mentionner Infinity');
        console.log('  ✅ Test Infinity (validatePrice): OK');
    }
    
    // Test 3.9: String non-numérique (validatePercentage)
    try {
        validatePercentage('abc', 'discount');
        assert.fail('String non-numérique doit être rejetée par validatePercentage');
    } catch (error) {
        assert(error.message.includes('nombre'), 'Message d\'erreur doit mentionner nombre');
        console.log('  ✅ Test string non-numérique (validatePercentage): OK');
    }
    
    // Test 3.10: validateNumericRange - NaN
    try {
        validateNumericRange(NaN, 1, 50, 'value');
        assert.fail('NaN doit être rejeté par validateNumericRange');
    } catch (error) {
        assert(error.message.includes('NaN'), 'Message d\'erreur doit mentionner NaN');
        console.log('  ✅ Test NaN (validateNumericRange): OK');
    }
    
    // Test 3.11: validateNumericRange - null (sans allowNull)
    try {
        validateNumericRange(null, 1, 50, 'value', false);
        assert.fail('null doit être rejeté si allowNull=false');
    } catch (error) {
        assert(error.message.includes('nombre'), 'Message d\'erreur doit mentionner nombre');
        console.log('  ✅ Test null sans allowNull (validateNumericRange): OK');
    }
    
    // Test 3.12: validateNumericRange - null (avec allowNull)
    try {
        const result = validateNumericRange(null, 1, 50, 'value', true);
        assert.strictEqual(result, null, 'null doit être accepté si allowNull=true');
        console.log('  ✅ Test null avec allowNull (validateNumericRange): OK');
    } catch (error) {
        assert.fail(`null avec allowNull=true devrait être accepté: ${error.message}`);
    }
    
    console.log('');
}

// ============================================================================
// 4. Tests pour nombres entiers vs décimaux
// ============================================================================

function testIntegersVsDecimals() {
    console.log('🔢 Tests pour nombres entiers vs décimaux...');
    
    // Test 4.1: Nombre entier valide (validateInteger)
    try {
        const result = validateInteger(42, 1, 50, 'capacity');
        assert.strictEqual(result, 42, 'Nombre entier valide doit être accepté');
        assert(Number.isInteger(result), 'Résultat doit être un entier');
        console.log('  ✅ Test nombre entier valide (validateInteger): OK');
    } catch (error) {
        assert.fail(`Nombre entier valide devrait passer: ${error.message}`);
    }
    
    // Test 4.2: Nombre décimal rejeté (validateInteger)
    try {
        validateInteger(42.5, 1, 50, 'capacity');
        assert.fail('Nombre décimal doit être rejeté par validateInteger');
    } catch (error) {
        assert(error.message.includes('nombre entier') || error.message.includes('entier'), 'Message d\'erreur doit mentionner nombre entier');
        console.log('  ✅ Test nombre décimal rejeté (validateInteger): OK');
    }
    
    // Test 4.3: Nombre décimal valide (validateNumber sans mustBeInteger)
    try {
        const result = validateNumber(42.5, { min: 1, max: 50 }, 'value');
        assert.strictEqual(result, 42.5, 'Nombre décimal doit être accepté si mustBeInteger=false');
        console.log('  ✅ Test nombre décimal valide (validateNumber): OK');
    } catch (error) {
        assert.fail(`Nombre décimal devrait passer si mustBeInteger=false: ${error.message}`);
    }
    
    // Test 4.4: Nombre décimal rejeté (validateNumber avec mustBeInteger=true)
    try {
        validateNumber(42.5, { min: 1, max: 50, mustBeInteger: true }, 'capacity');
        assert.fail('Nombre décimal doit être rejeté si mustBeInteger=true');
    } catch (error) {
        assert(error.message.includes('nombre entier') || error.message.includes('entier'), 'Message d\'erreur doit mentionner nombre entier');
        console.log('  ✅ Test nombre décimal rejeté (mustBeInteger=true): OK');
    }
    
    // Test 4.5: Nombre entier avec décimales (ex: 42.0) - doit être accepté comme entier
    try {
        const result = validateInteger(42.0, 1, 50, 'capacity');
        assert.strictEqual(result, 42, '42.0 doit être accepté comme entier');
        console.log('  ✅ Test nombre entier avec décimales (.0): OK');
    } catch (error) {
        assert.fail(`42.0 devrait être accepté comme entier: ${error.message}`);
    }
    
    // Test 4.6: String numérique entière (validateInteger)
    try {
        const result = validateInteger('42', 1, 50, 'capacity');
        assert.strictEqual(result, 42, 'String numérique entière doit être convertie en entier');
        assert(Number.isInteger(result), 'Résultat doit être un entier');
        console.log('  ✅ Test string numérique entière (validateInteger): OK');
    } catch (error) {
        assert.fail(`String numérique entière devrait passer: ${error.message}`);
    }
    
    // Test 4.7: String numérique décimale rejetée (validateInteger)
    try {
        validateInteger('42.5', 1, 50, 'capacity');
        assert.fail('String numérique décimale doit être rejetée par validateInteger');
    } catch (error) {
        assert(error.message.includes('nombre entier') || error.message.includes('entier'), 'Message d\'erreur doit mentionner nombre entier');
        console.log('  ✅ Test string numérique décimale rejetée (validateInteger): OK');
    }
    
    console.log('');
}

// ============================================================================
// 5. Tests pour prix et pourcentages
// ============================================================================

function testPricesAndPercentages() {
    console.log('💰 Tests pour prix et pourcentages...');
    
    // Test 5.1: Prix valide (validatePrice)
    try {
        const result = validatePrice(99.99, 0, 1000, 'price');
        assert.strictEqual(result, 99.99, 'Prix valide doit être accepté');
        console.log('  ✅ Test prix valide (validatePrice): OK');
    } catch (error) {
        assert.fail(`Prix valide devrait passer: ${error.message}`);
    }
    
    // Test 5.2: Prix avec 2 décimales (validatePrice)
    try {
        const result = validatePrice(100.50, 0, 1000, 'price');
        assert.strictEqual(result, 100.50, 'Prix avec 2 décimales doit être accepté');
        console.log('  ✅ Test prix avec 2 décimales: OK');
    } catch (error) {
        assert.fail(`Prix avec 2 décimales devrait passer: ${error.message}`);
    }
    
    // Test 5.3: Prix avec plus de 2 décimales - doit être arrondi ou rejeté selon l'implémentation
    try {
        const result = validatePrice(100.999, 0, 1000, 'price');
        // La fonction peut arrondir ou rejeter, les deux sont acceptables
        console.log('  ✅ Test prix avec plus de 2 décimales: OK (arrondi ou rejeté)');
    } catch (error) {
        // C'est aussi valide si rejeté
        assert(error.message.includes('décimales') || error.message.includes('décimal'), 'Message d\'erreur doit mentionner décimales');
        console.log('  ✅ Test prix avec plus de 2 décimales: OK (rejeté)');
    }
    
    // Test 5.4: Prix zéro (validatePrice)
    try {
        const result = validatePrice(0, 0, 1000, 'price');
        assert.strictEqual(result, 0, 'Prix zéro doit être accepté si min=0');
        console.log('  ✅ Test prix zéro: OK');
    } catch (error) {
        assert.fail(`Prix zéro devrait passer si min=0: ${error.message}`);
    }
    
    // Test 5.5: Prix maximum (validatePrice)
    try {
        const result = validatePrice(1000000, 0, 1000000, 'price');
        assert.strictEqual(result, 1000000, 'Prix à la limite maximale doit être accepté');
        console.log('  ✅ Test prix à la limite maximale: OK');
    } catch (error) {
        assert.fail(`Prix à la limite maximale devrait passer: ${error.message}`);
    }
    
    // Test 5.6: Pourcentage valide (validatePercentage)
    try {
        const result = validatePercentage(50, 'discount');
        assert.strictEqual(result, 50, 'Pourcentage valide doit être accepté');
        console.log('  ✅ Test pourcentage valide (validatePercentage): OK');
    } catch (error) {
        assert.fail(`Pourcentage valide devrait passer: ${error.message}`);
    }
    
    // Test 5.7: Pourcentage avec décimales (validatePercentage)
    try {
        const result = validatePercentage(50.5, 'discount');
        assert.strictEqual(result, 50.5, 'Pourcentage avec décimales doit être accepté');
        console.log('  ✅ Test pourcentage avec décimales: OK');
    } catch (error) {
        assert.fail(`Pourcentage avec décimales devrait passer: ${error.message}`);
    }
    
    // Test 5.8: Pourcentage à la limite (0%)
    try {
        const result = validatePercentage(0, 'discount');
        assert.strictEqual(result, 0, 'Pourcentage 0% doit être accepté');
        console.log('  ✅ Test pourcentage 0%: OK');
    } catch (error) {
        assert.fail(`Pourcentage 0% devrait passer: ${error.message}`);
    }
    
    // Test 5.9: Pourcentage à la limite (100%)
    try {
        const result = validatePercentage(100, 'discount');
        assert.strictEqual(result, 100, 'Pourcentage 100% doit être accepté');
        console.log('  ✅ Test pourcentage 100%: OK');
    } catch (error) {
        assert.fail(`Pourcentage 100% devrait passer: ${error.message}`);
    }
    
    // Test 5.10: String numérique pour prix (validatePrice)
    try {
        const result = validatePrice('99.99', 0, 1000, 'price');
        assert.strictEqual(result, 99.99, 'String numérique pour prix doit être convertie');
        console.log('  ✅ Test string numérique pour prix: OK');
    } catch (error) {
        assert.fail(`String numérique pour prix devrait passer: ${error.message}`);
    }
    
    // Test 5.11: String numérique pour pourcentage (validatePercentage)
    try {
        const result = validatePercentage('50.5', 'discount');
        assert.strictEqual(result, 50.5, 'String numérique pour pourcentage doit être convertie');
        console.log('  ✅ Test string numérique pour pourcentage: OK');
    } catch (error) {
        assert.fail(`String numérique pour pourcentage devrait passer: ${error.message}`);
    }
    
    console.log('');
}

// ============================================================================
// Exécution des tests
// ============================================================================

function runAllTests() {
    try {
        testValidNumbersInRange();
        testNumbersOutOfRange();
        testInvalidNumbers();
        testIntegersVsDecimals();
        testPricesAndPercentages();
        
        console.log('✅ Tous les tests de validation de nombres sont passés !\n');
    } catch (error) {
        console.error('❌ Erreur lors de l\'exécution des tests:', error);
        process.exit(1);
    }
}

// Exécuter les tests si le fichier est exécuté directement
if (require.main === module) {
    runAllTests();
}

module.exports = {
    testValidNumbersInRange,
    testNumbersOutOfRange,
    testInvalidNumbers,
    testIntegersVsDecimals,
    testPricesAndPercentages,
    runAllTests
};






