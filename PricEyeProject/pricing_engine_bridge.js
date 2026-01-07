/**
 * Bridge Node.js ↔ Python pour le moteur de pricing IA
 * 
 * Ce module fournit une interface robuste pour appeler le moteur de pricing Python
 * depuis Node.js, avec gestion d'erreurs, timeout, et fallback.
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs').promises;

const execAsync = promisify(exec);

// Helper pour savoir si on est sur Windows (pour la commande python)
const PYTHON_COMMAND = process.platform === 'win32' ? 'python' : 'python3';

// Timeout par défaut (60 secondes pour permettre le chargement des modèles et les requêtes DB)
const DEFAULT_TIMEOUT = 60000;

/**
 * Vérifie si un modèle de demande existe pour une propriété donnée.
 * 
 * @param {string} propertyId - UUID de la propriété
 * @returns {Promise<boolean>} true si le modèle existe, false sinon
 */
async function checkModelExists(propertyId) {
    try {
        const modelPath = path.join(__dirname, 'pricing_models', `demand_model_${propertyId}.json`);
        const metaPath = path.join(__dirname, 'pricing_models', `demand_model_${propertyId}.meta.json`);
        
        // Vérifier que les deux fichiers existent (modèle + métadonnées)
        try {
            await fs.access(modelPath);
            await fs.access(metaPath);
            return true;
        } catch {
            return false;
        }
    } catch (error) {
        console.error(`[Pricing Bridge] Erreur lors de la vérification du modèle pour ${propertyId}:`, error);
        return false;
    }
}

/**
 * Parse la sortie JSON d'un script Python.
 * 
 * @param {string} stdout - Sortie standard du script Python
 * @param {string} stderr - Sortie d'erreur du script Python
 * @returns {Object|null} Objet JSON parsé ou null si erreur
 */
function parsePythonJSONOutput(stdout, stderr) {
    try {
        // Chercher le JSON dans stdout (peut être précédé de logs)
        const jsonMatch = stdout.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
        
        // Si pas de JSON dans stdout, vérifier stderr (certains scripts écrivent le JSON dans stderr)
        if (stderr) {
            const stderrJsonMatch = stderr.match(/\{[\s\S]*\}/);
            if (stderrJsonMatch) {
                return JSON.parse(stderrJsonMatch[0]);
            }
        }
        
        return null;
    } catch (parseError) {
        console.error('[Pricing Bridge] Erreur de parsing JSON:', parseError);
        console.error('[Pricing Bridge] stdout:', stdout.substring(0, 500));
        if (stderr) {
            console.error('[Pricing Bridge] stderr:', stderr.substring(0, 500));
        }
        return null;
    }
}

/**
 * Détecte le type d'erreur Python pour un fallback approprié.
 * 
 * @param {string} errorMessage - Message d'erreur
 * @param {string} stdout - Sortie standard
 * @param {string} stderr - Sortie d'erreur
 * @returns {string} Type d'erreur : 'model_not_found', 'insufficient_data', 'timeout', 'other'
 */
function detectErrorType(errorMessage, stdout, stderr) {
    const combinedOutput = (stdout + ' ' + stderr).toLowerCase();
    
    if (
        combinedOutput.includes('model not found') ||
        combinedOutput.includes('no model') ||
        combinedOutput.includes('file not found') ||
        combinedOutput.includes('demand_model_') && combinedOutput.includes('does not exist')
    ) {
        return 'model_not_found';
    }
    
    if (
        combinedOutput.includes('insufficient data') ||
        combinedOutput.includes('not enough data') ||
        combinedOutput.includes('empty dataset') ||
        combinedOutput.includes('no data available')
    ) {
        return 'insufficient_data';
    }
    
    if (
        errorMessage.includes('timeout') ||
        errorMessage.includes('ETIMEDOUT') ||
        errorMessage.includes('timed out')
    ) {
        return 'timeout';
    }
    
    return 'other';
}

/**
 * Obtient un prix recommandé pour une propriété/date donnée.
 * 
 * @param {string} propertyId - UUID de la propriété
 * @param {string} date - Date de séjour (YYYY-MM-DD)
 * @param {string} [roomType='default'] - Type de chambre
 * @returns {Promise<Object|null>} Recommandation { price, expected_revenue, predicted_demand, strategy, details } ou null si erreur
 */
async function getRecommendedPrice(propertyId, date, roomType = 'default') {
    if (!propertyId || !date) {
        console.error('[Pricing Bridge] propertyId et date sont requis');
        return null;
    }
    
    // Validation du format de date
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
        console.error('[Pricing Bridge] Format de date invalide:', date);
        return null;
    }
    
    try {
        // Construire la commande Python
        let command = `${PYTHON_COMMAND} -m scripts.demo_optimize_price --property-id ${propertyId} --date ${date} --room-type ${roomType}`;
        
        console.log(`[Pricing Bridge] Exécution: ${command}`);
        
        const startTime = Date.now();
        
        // Exécuter avec timeout
        const { stdout, stderr } = await Promise.race([
            execAsync(command, {
                cwd: __dirname,
                maxBuffer: 10 * 1024 * 1024, // 10MB
                env: {
                    ...process.env,
                    PYTHONUNBUFFERED: '1' // Désactiver le buffering Python pour voir les erreurs en temps réel
                }
            }),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Timeout')), DEFAULT_TIMEOUT)
            )
        ]);
        
        const duration = Date.now() - startTime;
        console.log(`[Pricing Bridge] Commande terminée en ${duration}ms`);
        
        // Parser la sortie JSON
        const result = parsePythonJSONOutput(stdout, stderr);
        
        if (!result) {
            console.error('[Pricing Bridge] Impossible de parser la sortie JSON');
            return null;
        }
        
        // Vérifier que le résultat a la structure attendue
        if (typeof result.price === 'undefined') {
            console.error('[Pricing Bridge] Résultat invalide (pas de champ price):', result);
            return null;
        }
        
        return {
            price: result.price,
            expected_revenue: result.expected_revenue || null,
            predicted_demand: result.predicted_demand || null,
            strategy: result.strategy || 'unknown',
            details: result.details || result
        };
        
    } catch (error) {
        const errorType = detectErrorType(error.message, error.stdout || '', error.stderr || '');
        
        console.error(`[Pricing Bridge] Erreur (${errorType}):`, error.message);
        console.error(`[Pricing Bridge] Code d'erreur:`, error.code);
        
        // Afficher stdout et stderr complets pour debugging
        if (error.stdout) {
            console.error(`[Pricing Bridge] stdout complet:`, error.stdout);
        }
        if (error.stderr) {
            console.error(`[Pricing Bridge] stderr complet:`, error.stderr);
        }
        if (error.stack) {
            console.error(`[Pricing Bridge] Stack trace:`, error.stack);
        }
        
        // Pour les erreurs non-critiques, retourner null (fallback sera utilisé)
        if (errorType === 'model_not_found' || errorType === 'insufficient_data') {
            console.log(`[Pricing Bridge] Modèle non disponible ou données insuffisantes pour ${propertyId}, fallback sera utilisé`);
            return null;
        }
        
        // Pour les autres erreurs (timeout, crash, etc.), on peut aussi retourner null
        // ou re-throw selon la stratégie souhaitée
        console.error(`[Pricing Bridge] Erreur critique pour ${propertyId}:`, error);
        return null;
    }
}

/**
 * Simule la demande et le revenu pour une grille de prix.
 * 
 * @param {string} propertyId - UUID de la propriété
 * @param {string} date - Date de séjour (YYYY-MM-DD)
 * @param {Array<number>} priceGrid - Grille de prix à tester
 * @param {string} [roomType='default'] - Type de chambre
 * @returns {Promise<Array<Object>|null>} Tableau de { price, predicted_demand, expected_revenue } ou null si erreur
 */
async function simulatePrices(propertyId, date, priceGrid, roomType = 'default') {
    if (!propertyId || !date || !Array.isArray(priceGrid) || priceGrid.length === 0) {
        console.error('[Pricing Bridge] propertyId, date et priceGrid non vide sont requis');
        return null;
    }
    
    // Validation du format de date
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
        console.error('[Pricing Bridge] Format de date invalide:', date);
        return null;
    }
    
    // Validation de la grille de prix
    if (!priceGrid.every(p => typeof p === 'number' && p > 0)) {
        console.error('[Pricing Bridge] priceGrid doit contenir uniquement des nombres positifs');
        return null;
    }
    
    try {
        // Utiliser le script Python dédié pour la simulation
        const pricesArg = priceGrid.join(',');
        
        let command = `${PYTHON_COMMAND} -m scripts.simulate_price_grid --property-id ${propertyId} --date ${date} --room-type ${roomType} --price-grid ${pricesArg}`;
        
        console.log(`[Pricing Bridge] Simulation pour ${priceGrid.length} prix`);
        
        const startTime = Date.now();
        
        const { stdout, stderr } = await Promise.race([
            execAsync(command, {
                cwd: __dirname,
                maxBuffer: 10 * 1024 * 1024,
                env: {
                    ...process.env,
                    PYTHONUNBUFFERED: '1'
                }
            }),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Timeout')), DEFAULT_TIMEOUT)
            )
        ]);
        
        const duration = Date.now() - startTime;
        console.log(`[Pricing Bridge] Simulation terminée en ${duration}ms`);
        
        // Parser la sortie JSON
        const result = parsePythonJSONOutput(stdout, stderr);
        
        if (!result || !Array.isArray(result)) {
            console.error('[Pricing Bridge] Résultat de simulation invalide:', result);
            return null;
        }
        
        // Vérifier la structure de chaque élément
        const validSimulations = result.filter(sim => 
            typeof sim.price === 'number' &&
            typeof sim.predicted_demand === 'number' &&
            typeof sim.expected_revenue === 'number'
        );
        
        if (validSimulations.length === 0) {
            console.error('[Pricing Bridge] Aucune simulation valide retournée');
            return null;
        }
        
        return validSimulations.map(sim => ({
            price: sim.price,
            predicted_demand: sim.predicted_demand,
            expected_revenue: sim.expected_revenue
        }));
        
    } catch (error) {
        const errorType = detectErrorType(error.message, error.stdout || '', error.stderr || '');
        
        console.error(`[Pricing Bridge] Erreur simulation (${errorType}):`, error.message);
        
        if (errorType === 'model_not_found' || errorType === 'insufficient_data') {
            console.log(`[Pricing Bridge] Modèle non disponible pour simulation, retour tableau vide`);
            return [];
        }
        
        return null;
    }
}

module.exports = {
    getRecommendedPrice,
    simulatePrices,
    checkModelExists,
    // Exporter aussi les constantes pour les tests
    PYTHON_COMMAND,
    DEFAULT_TIMEOUT
};

