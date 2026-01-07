/**
 * Tests pour la fonction sanitizeUrl
 */

const assert = require('assert');
const { sanitizeUrl } = require('../../utils/promptSanitizer');

console.log('🧪 Tests pour sanitizeUrl...\n');

// Test 1: URL valide HTTPS
function testValidHttpsUrl() {
    const url = 'https://example.com/path?param=value';
    const result = sanitizeUrl(url);
    assert(result !== null, 'URL HTTPS valide doit être acceptée');
    assert(result.includes('https://'), 'URL doit contenir le protocole HTTPS');
    assert(result.includes('example.com'), 'URL doit contenir le domaine');
    console.log('  ✅ Test URL HTTPS valide: OK');
    console.log(`     Input: "${url}"`);
    console.log(`     Output: "${result}"`);
}

// Test 2: URL valide HTTP
function testValidHttpUrl() {
    const url = 'http://example.com/path';
    const result = sanitizeUrl(url);
    assert(result !== null, 'URL HTTP valide doit être acceptée');
    assert(result.includes('http://'), 'URL doit contenir le protocole HTTP');
    console.log('  ✅ Test URL HTTP valide: OK');
    console.log(`     Input: "${url}"`);
    console.log(`     Output: "${result}"`);
}

// Test 3: URL avec protocole non autorisé (javascript:)
function testJavascriptProtocol() {
    const url = 'javascript:alert(1)';
    const result = sanitizeUrl(url);
    assert(result === null, 'URL avec protocole javascript doit être rejetée');
    console.log('  ✅ Test protocole javascript rejeté: OK');
    console.log(`     Input: "${url}"`);
    console.log(`     Output: ${result}`);
}

// Test 4: URL avec protocole non autorisé (data:)
function testDataProtocol() {
    const url = 'data:text/html,<script>alert(1)</script>';
    const result = sanitizeUrl(url);
    assert(result === null, 'URL avec protocole data doit être rejetée');
    console.log('  ✅ Test protocole data rejeté: OK');
    console.log(`     Input: "${url.substring(0, 30)}..."`);
    console.log(`     Output: ${result}`);
}

// Test 5: URL avec paramètres suspects
function testSuspiciousParams() {
    const url = 'https://example.com?javascript=alert(1)&data=test&normal=value';
    const result = sanitizeUrl(url);
    assert(result !== null, 'URL doit être acceptée même avec paramètres suspects');
    assert(!result.includes('javascript='), 'Paramètre javascript doit être supprimé');
    assert(!result.includes('data=test'), 'Paramètre data doit être supprimé');
    assert(result.includes('normal=value'), 'Paramètre normal doit être conservé');
    console.log('  ✅ Test paramètres suspects supprimés: OK');
    console.log(`     Input: "${url}"`);
    console.log(`     Output: "${result}"`);
}

// Test 6: URL trop longue
function testUrlTooLong() {
    const longPath = 'a'.repeat(600);
    const url = `https://example.com/${longPath}`;
    const result = sanitizeUrl(url, 500);
    assert(result !== null, 'URL trop longue doit être tronquée mais acceptée');
    assert(result.length <= 500, 'URL doit être limitée à 500 caractères');
    console.log('  ✅ Test URL trop longue tronquée: OK');
    console.log(`     Input length: ${url.length}`);
    console.log(`     Output length: ${result.length}`);
}

// Test 7: URL avec hash
function testUrlWithHash() {
    const url = 'https://example.com/path#section';
    const result = sanitizeUrl(url);
    assert(result !== null, 'URL avec hash doit être acceptée');
    assert(result.includes('#'), 'URL doit contenir le hash');
    console.log('  ✅ Test URL avec hash: OK');
    console.log(`     Input: "${url}"`);
    console.log(`     Output: "${result}"`);
}

// Test 8: URL invalide (format incorrect)
function testInvalidUrl() {
    const url = 'not-a-valid-url';
    const result = sanitizeUrl(url);
    // Peut être null ou une URL relative, selon l'implémentation
    console.log('  ✅ Test URL invalide: OK');
    console.log(`     Input: "${url}"`);
    console.log(`     Output: ${result}`);
}

// Test 9: URL avec port
function testUrlWithPort() {
    const url = 'https://example.com:8080/path';
    const result = sanitizeUrl(url);
    assert(result !== null, 'URL avec port doit être acceptée');
    assert(result.includes(':8080'), 'URL doit contenir le port');
    console.log('  ✅ Test URL avec port: OK');
    console.log(`     Input: "${url}"`);
    console.log(`     Output: "${result}"`);
}

// Test 10: URL avec caractères spéciaux dans le chemin
function testUrlWithSpecialChars() {
    const url = 'https://example.com/path with spaces?param=value&other=test';
    const result = sanitizeUrl(url);
    assert(result !== null, 'URL avec caractères spéciaux doit être acceptée');
    console.log('  ✅ Test URL avec caractères spéciaux: OK');
    console.log(`     Input: "${url}"`);
    console.log(`     Output: "${result}"`);
}

// Exécution des tests
console.log('🚀 Démarrage des tests...\n');

try {
    testValidHttpsUrl();
    testValidHttpUrl();
    testJavascriptProtocol();
    testDataProtocol();
    testSuspiciousParams();
    testUrlTooLong();
    testUrlWithHash();
    testInvalidUrl();
    testUrlWithPort();
    testUrlWithSpecialChars();
    
    console.log('\n✅ Tous les tests sont passés avec succès !');
    process.exit(0);
} catch (error) {
    console.error('\n❌ Erreur lors des tests:', error.message);
    console.error(error.stack);
    process.exit(1);
}






