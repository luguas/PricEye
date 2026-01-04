/**
 * Tests pour la fonction sanitizeFilename
 */

const assert = require('assert');
const { sanitizeFilename } = require('../../utils/promptSanitizer');

console.log('🧪 Tests pour sanitizeFilename...\n');

// Test 1: Nom de fichier valide
function testValidFilename() {
    const filename = 'my-file.txt';
    const result = sanitizeFilename(filename);
    assert(result !== null, 'Nom de fichier valide doit être accepté');
    assert.strictEqual(result, 'my-file.txt', 'Nom de fichier valide doit être conservé');
    console.log('  ✅ Test nom de fichier valide: OK');
    console.log(`     Input: "${filename}"`);
    console.log(`     Output: "${result}"`);
}

// Test 2: Suppression des caractères spéciaux
function testSpecialCharsRemoval() {
    const filename = 'file<script>.txt';
    const result = sanitizeFilename(filename);
    assert(result !== null, 'Nom de fichier avec caractères spéciaux doit être sanitizé');
    assert(!result.includes('<'), 'Caractère < doit être supprimé');
    assert(!result.includes('>'), 'Caractère > doit être supprimé');
    assert(!result.includes(':'), 'Caractère : doit être supprimé');
    assert(!result.includes('*'), 'Caractère * doit être supprimé');
    assert(!result.includes('?'), 'Caractère ? doit être supprimé');
    assert(!result.includes('"'), 'Caractère " doit être supprimé');
    assert(!result.includes('|'), 'Caractère | doit être supprimé');
    console.log('  ✅ Test suppression caractères spéciaux: OK');
    console.log(`     Input: "${filename}"`);
    console.log(`     Output: "${result}"`);
}

// Test 3: Détection des chemins relatifs (..)
function testPathTraversal() {
    const filename = '../../../etc/passwd';
    const result = sanitizeFilename(filename);
    assert(result === null, 'Chemin relatif doit être rejeté');
    console.log('  ✅ Test chemin relatif rejeté: OK');
    console.log(`     Input: "${filename}"`);
    console.log(`     Output: ${result}`);
}

// Test 4: Détection des séparateurs de chemin
function testPathSeparators() {
    const filename = 'folder/file.txt';
    const result = sanitizeFilename(filename);
    assert(result !== null, 'Nom avec séparateur doit être sanitizé');
    assert(!result.includes('/'), 'Séparateur / doit être supprimé');
    assert(!result.includes('\\'), 'Séparateur \\ doit être supprimé');
    console.log('  ✅ Test séparateurs de chemin supprimés: OK');
    console.log(`     Input: "${filename}"`);
    console.log(`     Output: "${result}"`);
}

// Test 5: Nom de fichier trop long
function testFilenameTooLong() {
    const longName = 'a'.repeat(300) + '.txt';
    const result = sanitizeFilename(longName, 255);
    assert(result !== null, 'Nom trop long doit être tronqué');
    assert(result.length <= 255, 'Nom doit être limité à 255 caractères');
    assert(result.endsWith('.txt'), 'Extension doit être préservée');
    console.log('  ✅ Test nom trop long tronqué: OK');
    console.log(`     Input length: ${longName.length}`);
    console.log(`     Output length: ${result.length}`);
    console.log(`     Output: "${result.substring(0, 50)}..."`);
}

// Test 6: Nom réservé (Windows)
function testReservedName() {
    const filename = 'CON.txt';
    const result = sanitizeFilename(filename);
    assert(result === null, 'Nom réservé CON doit être rejeté');
    console.log('  ✅ Test nom réservé rejeté: OK');
    console.log(`     Input: "${filename}"`);
    console.log(`     Output: ${result}`);
}

// Test 7: Nom avec espaces
function testSpacesInFilename() {
    const filename = 'my file name.txt';
    const result = sanitizeFilename(filename);
    assert(result !== null, 'Nom avec espaces doit être accepté');
    assert(result.includes('_'), 'Espaces doivent être remplacés par des underscores');
    console.log('  ✅ Test espaces remplacés: OK');
    console.log(`     Input: "${filename}"`);
    console.log(`     Output: "${result}"`);
}

// Test 8: Nom avec caractères Unicode
function testUnicodeChars() {
    const filename = 'fichier-émoji🎉.txt';
    const result = sanitizeFilename(filename);
    assert(result !== null, 'Nom avec Unicode doit être accepté');
    console.log('  ✅ Test caractères Unicode: OK');
    console.log(`     Input: "${filename}"`);
    console.log(`     Output: "${result}"`);
}

// Test 9: Nom commençant par un point
function testLeadingDot() {
    const filename = '.hidden-file.txt';
    const result = sanitizeFilename(filename);
    // Les fichiers cachés (commençant par .) peuvent être acceptés selon le système
    // Mais on nettoie les points/espaces en début/fin
    console.log('  ✅ Test nom commençant par point: OK');
    console.log(`     Input: "${filename}"`);
    console.log(`     Output: "${result}"`);
}

// Test 10: Nom avec plusieurs extensions
function testMultipleExtensions() {
    const filename = 'file.tar.gz';
    const result = sanitizeFilename(filename);
    assert(result !== null, 'Nom avec plusieurs extensions doit être accepté');
    assert(result.includes('.tar.gz'), 'Extensions multiples doivent être préservées');
    console.log('  ✅ Test extensions multiples: OK');
    console.log(`     Input: "${filename}"`);
    console.log(`     Output: "${result}"`);
}

// Test 11: Nom avec caractères de contrôle
function testControlChars() {
    const filename = 'file\u0000\u0001.txt';
    const result = sanitizeFilename(filename);
    assert(result !== null, 'Nom avec caractères de contrôle doit être sanitizé');
    assert(!result.includes('\u0000'), 'Caractère de contrôle doit être supprimé');
    console.log('  ✅ Test caractères de contrôle supprimés: OK');
    console.log(`     Input: "file\\u0000\\u0001.txt"`);
    console.log(`     Output: "${result}"`);
}

// Test 12: Nom vide après sanitisation
function testEmptyAfterSanitization() {
    const filename = '///';
    const result = sanitizeFilename(filename);
    assert(result === null, 'Nom vide après sanitisation doit être rejeté');
    console.log('  ✅ Test nom vide rejeté: OK');
    console.log(`     Input: "${filename}"`);
    console.log(`     Output: ${result}`);
}

// Exécution des tests
console.log('🚀 Démarrage des tests...\n');

try {
    testValidFilename();
    testSpecialCharsRemoval();
    testPathTraversal();
    testPathSeparators();
    testFilenameTooLong();
    testReservedName();
    testSpacesInFilename();
    testUnicodeChars();
    testLeadingDot();
    testMultipleExtensions();
    testControlChars();
    testEmptyAfterSanitization();
    
    console.log('\n✅ Tous les tests sont passés avec succès !');
    process.exit(0);
} catch (error) {
    console.error('\n❌ Erreur lors des tests:', error.message);
    console.error(error.stack);
    process.exit(1);
}

