/**
 * Tests pour la fonction validateNumber (validation stricte)
 */

const assert = require('assert');
const { validateNumber } = require('../../utils/promptSanitizer');

console.log('🧪 Tests pour validateNumber (validation stricte)...\n');

// Test 1: Nombre valide
function testValidNumber() {
    const result = validateNumber(42, { min: 1, max: 50 }, 'capacity');
    assert.strictEqual(result, 42, 'Nombre valide doit être retourné tel quel');
    console.log('  ✅ Test nombre valide: OK');
}

// Test 2: String non-numérique rejetée
function testNonNumericString() {
    try {
        validateNumber('abc', { min: 1, max: 50 }, 'capacity');
        assert.fail('String non-numérique doit être rejetée');
    } catch (error) {
        assert(error.message.includes('doit être un nombre valide'), 'Message d\'erreur doit mentionner que c\'est invalide');
        console.log('  ✅ Test string non-numérique rejetée: OK');
    }
}

// Test 3: Nombre avec décimales (mustBeInteger: true)
function testDecimalWithIntegerRequired() {
    try {
        validateNumber(42.5, { min: 1, max: 50, mustBeInteger: true }, 'capacity');
        assert.fail('Nombre décimal doit être rejeté si mustBeInteger est true');
    } catch (error) {
        assert(error.message.includes('nombre entier'), 'Message d\'erreur doit mentionner nombre entier');
        console.log('  ✅ Test décimales rejetées (mustBeInteger): OK');
    }
}

// Test 4: Nombre négatif (mustBePositive: true)
function testNegativeWithPositiveRequired() {
    try {
        validateNumber(-5, { min: 1, max: 50, mustBePositive: true }, 'capacity');
        assert.fail('Nombre négatif doit être rejeté si mustBePositive est true');
    } catch (error) {
        assert(error.message.includes('strictement positif'), 'Message d\'erreur doit mentionner strictement positif');
        console.log('  ✅ Test nombre négatif rejeté (mustBePositive): OK');
    }
}

// Test 5: Trop de décimales (maxDecimals: 2)
function testTooManyDecimals() {
    try {
        validateNumber(42.123, { min: 1, max: 50, maxDecimals: 2 }, 'price');
        assert.fail('Nombre avec trop de décimales doit être rejeté');
    } catch (error) {
        assert(error.message.includes('décimales'), 'Message d\'erreur doit mentionner décimales');
        console.log('  ✅ Test trop de décimales rejeté: OK');
    }
}

// Test 6: Notation scientifique rejetée
function testScientificNotation() {
    try {
        validateNumber('1e100', { min: 1, max: 50 }, 'capacity');
        assert.fail('Notation scientifique doit être rejetée');
    } catch (error) {
        assert(error.message.includes('notation scientifique'), 'Message d\'erreur doit mentionner notation scientifique');
        console.log('  ✅ Test notation scientifique rejetée: OK');
    }
}

// Test 7: Nombre hors plage (min)
function testNumberBelowMin() {
    try {
        validateNumber(0, { min: 1, max: 50 }, 'capacity');
        assert.fail('Nombre en dessous du minimum doit être rejeté');
    } catch (error) {
        assert(error.message.includes('supérieur ou égal'), 'Message d\'erreur doit mentionner minimum');
        console.log('  ✅ Test nombre en dessous du minimum: OK');
    }
}

// Test 8: Nombre hors plage (max)
function testNumberAboveMax() {
    try {
        validateNumber(100, { min: 1, max: 50 }, 'capacity');
        assert.fail('Nombre au-dessus du maximum doit être rejeté');
    } catch (error) {
        assert(error.message.includes('inférieur ou égal'), 'Message d\'erreur doit mentionner maximum');
        console.log('  ✅ Test nombre au-dessus du maximum: OK');
    }
}

// Test 9: NaN rejeté
function testNaN() {
    try {
        validateNumber(NaN, { min: 1, max: 50 }, 'capacity');
        assert.fail('NaN doit être rejeté');
    } catch (error) {
        assert(error.message.includes('NaN'), 'Message d\'erreur doit mentionner NaN');
        console.log('  ✅ Test NaN rejeté: OK');
    }
}

// Test 10: Infinity rejeté
function testInfinity() {
    try {
        validateNumber(Infinity, { min: 1, max: 50 }, 'capacity');
        assert.fail('Infinity doit être rejeté');
    } catch (error) {
        assert(error.message.includes('Infinity'), 'Message d\'erreur doit mentionner Infinity');
        console.log('  ✅ Test Infinity rejeté: OK');
    }
}

// Test 11: Nombre avec 2 décimales valide (maxDecimals: 2)
function testValidDecimals() {
    const result = validateNumber(42.12, { min: 1, max: 50, maxDecimals: 2 }, 'price');
    assert.strictEqual(result, 42.12, 'Nombre avec 2 décimales doit être accepté');
    console.log('  ✅ Test nombre avec 2 décimales valide: OK');
}

// Test 12: Nombre entier valide (mustBeInteger: true)
function testValidInteger() {
    const result = validateNumber(42, { min: 1, max: 50, mustBeInteger: true }, 'capacity');
    assert.strictEqual(result, 42, 'Nombre entier doit être accepté');
    console.log('  ✅ Test nombre entier valide: OK');
}

// Exécution des tests
console.log('🚀 Démarrage des tests...\n');

try {
    testValidNumber();
    testNonNumericString();
    testDecimalWithIntegerRequired();
    testNegativeWithPositiveRequired();
    testTooManyDecimals();
    testScientificNotation();
    testNumberBelowMin();
    testNumberAboveMax();
    testNaN();
    testInfinity();
    testValidDecimals();
    testValidInteger();
    
    console.log('\n✅ Tous les tests sont passés avec succès !');
    process.exit(0);
} catch (error) {
    console.error('\n❌ Erreur lors des tests:', error.message);
    console.error(error.stack);
    process.exit(1);
}




