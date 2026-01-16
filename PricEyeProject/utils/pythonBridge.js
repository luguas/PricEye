/**
 * Bridge Node.js ↔ Python avec processus persistant
 * 
 * Ce module utilise child_process.spawn pour maintenir un processus Python
 * persistant qui reste en mémoire, réduisant la latence de ~3-5 secondes à ~100-200ms.
 * 
 * Le processus Python charge les modèles une seule fois au démarrage et attend
 * les requêtes via stdin/stdout (communication JSON ligne par ligne).
 */

const { spawn } = require('child_process');
const path = require('path');

// Configuration
const PYTHON_SCRIPT_PATH = path.join(__dirname, '../pricing_engine/server.py');
const PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3';

let pythonProcess = null;
let requestQueue = [];
let isRestarting = false;
let requestIdCounter = 0;

/**
 * Démarre ou redémarre le processus Python.
 */
function startPythonProcess() {
    if (pythonProcess) return;

    console.log('🔄 Démarrage du moteur de pricing Python (processus persistant)...');
    
    try {
        pythonProcess = spawn(PYTHON_CMD, [PYTHON_SCRIPT_PATH], {
            cwd: path.join(__dirname, '..'),
            env: {
                ...process.env,
                PYTHONUNBUFFERED: '1' // Désactiver le buffering Python pour voir les logs en temps réel
            }
        });

        // Gestion des données reçues (Réponses JSON)
        let buffer = '';
        pythonProcess.stdout.on('data', (data) => {
            buffer += data.toString();
            
            // Traiter les lignes complètes (JSON séparés par \n)
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Garder la dernière ligne incomplète dans le buffer
            
            lines.forEach(line => {
                if (!line.trim()) return;

                // On récupère la plus vieille requête en attente (FIFO)
                const currentRequest = requestQueue.shift();
                
                if (currentRequest) {
                    try {
                        const response = JSON.parse(line);
                        if (response.error) {
                            currentRequest.reject(new Error(`Erreur Python: ${response.error}`));
                        } else {
                            currentRequest.resolve(response);
                        }
                    } catch (err) {
                        console.error('❌ Erreur parsing JSON Python:', err, line);
                        currentRequest.reject(new Error("Réponse Python invalide"));
                    }
                } else {
                    // Réponse reçue sans requête correspondante (ne devrait pas arriver)
                    console.warn('⚠️ Réponse Python reçue sans requête correspondante:', line);
                }
            });
        });

        // Logs d'erreur du script Python
        pythonProcess.stderr.on('data', (data) => {
            const logLine = data.toString().trim();
            if (logLine) {
                console.log(`🐍 [LOG PYTHON]: ${logLine}`);
            }
        });

        // Gestion du crash / fermeture
        pythonProcess.on('close', (code) => {
            console.warn(`⚠️ Processus Python arrêté (code ${code}).`);
            pythonProcess = null;
            
            // Rejeter toutes les requêtes en attente
            while (requestQueue.length > 0) {
                const req = requestQueue.shift();
                req.reject(new Error("Le moteur de pricing a redémarré pendant la requête."));
            }

            // Redémarrage automatique si ce n'était pas prévu
            if (!isRestarting) {
                console.log('🔄 Redémarrage automatique du processus Python dans 1 seconde...');
                setTimeout(startPythonProcess, 1000);
            }
        });

        // Gestion des erreurs de spawn
        pythonProcess.on('error', (error) => {
            console.error('❌ Erreur lors du lancement du processus Python:', error);
            pythonProcess = null;
            
            // Rejeter toutes les requêtes en attente
            while (requestQueue.length > 0) {
                const req = requestQueue.shift();
                req.reject(new Error(`Impossible de lancer Python: ${error.message}`));
            }
        });

    } catch (error) {
        console.error("❌ Impossible de lancer Python:", error);
        pythonProcess = null;
    }
}

/**
 * Envoie une charge utile au moteur Python et attend la réponse.
 * 
 * @param {Object} payload - Les données à envoyer
 *   Format: {
 *     propertyId: string,
 *     roomType?: string (défaut: 'default'),
 *     date: string (YYYY-MM-DD),
 *     capacityRemaining?: number,
 *     contextFeatures?: object
 *   }
 * @returns {Promise<Object>} - La réponse du modèle
 *   Format: {
 *     status: 'success',
 *     propertyId: string,
 *     price: number,
 *     expected_revenue?: number,
 *     predicted_demand?: number,
 *     strategy: string,
 *     details: object
 *   }
 */
function getPricingPrediction(payload) {
    return new Promise((resolve, reject) => {
        if (!pythonProcess) {
            startPythonProcess();
        }

        // Vérifier que le processus est toujours actif
        if (!pythonProcess || pythonProcess.killed) {
            reject(new Error("Le processus Python n'est pas disponible"));
            return;
        }

        // Ajout à la file d'attente
        requestQueue.push({ resolve, reject });

        // Envoi des données (JSON + saut de ligne obligatoire)
        try {
            const message = JSON.stringify(payload) + '\n';
            pythonProcess.stdin.write(message, (error) => {
                if (error) {
                    // En cas d'erreur d'écriture (pipe fermé), on nettoie
                    const req = requestQueue.pop();
                    if (req) req.reject(error);
                }
            });
        } catch (error) {
            // En cas d'erreur d'écriture (pipe fermé), on nettoie
            const req = requestQueue.pop();
            if (req) req.reject(error);
        }
    });
}

/**
 * Obtient un prix recommandé pour une propriété/date donnée.
 * 
 * @param {string} propertyId - UUID de la propriété
 * @param {string} date - Date de séjour (YYYY-MM-DD)
 * @param {string} [roomType='default'] - Type de chambre
 * @param {number} [capacityRemaining] - Capacité restante (optionnel)
 * @param {Object} [contextFeatures] - Features contextuelles (optionnel)
 * @returns {Promise<Object|null>} Recommandation ou null si erreur
 */
async function getRecommendedPrice(propertyId, date, roomType = 'default', capacityRemaining = null, contextFeatures = null) {
    if (!propertyId || !date) {
        console.error('[Python Bridge] propertyId et date sont requis');
        return null;
    }
    
    // Validation du format de date
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
        console.error('[Python Bridge] Format de date invalide:', date);
        return null;
    }
    
    try {
        const payload = {
            propertyId: propertyId,
            roomType: roomType,
            date: date
        };
        
        if (capacityRemaining !== null && capacityRemaining !== undefined) {
            payload.capacityRemaining = capacityRemaining;
        }
        
        if (contextFeatures !== null && contextFeatures !== undefined) {
            payload.contextFeatures = contextFeatures;
        }
        
        const result = await getPricingPrediction(payload);
        
        // Vérifier que le résultat a la structure attendue
        if (typeof result.price === 'undefined') {
            console.error('[Python Bridge] Résultat invalide (pas de champ price):', result);
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
        console.error(`[Python Bridge] Erreur lors de la recommandation:`, error.message);
        return null;
    }
}

/**
 * Simule la demande et le revenu pour une grille de prix.
 * 
 * Note: Cette fonction n'est pas encore implémentée dans le serveur persistant.
 * Pour l'instant, elle retourne null et devrait utiliser l'ancien bridge.
 * 
 * @param {string} propertyId - UUID de la propriété
 * @param {string} date - Date de séjour (YYYY-MM-DD)
 * @param {Array<number>} priceGrid - Grille de prix à tester
 * @param {string} [roomType='default'] - Type de chambre
 * @returns {Promise<Array<Object>|null>} Tableau de simulations ou null si erreur
 */
async function simulatePrices(propertyId, date, priceGrid, roomType = 'default') {
    // TODO: Implémenter la simulation dans le serveur persistant si nécessaire
    // Pour l'instant, on retourne null pour forcer l'utilisation de l'ancien bridge
    console.warn('[Python Bridge] simulatePrices n\'est pas encore implémentée dans le serveur persistant');
    return null;
}

/**
 * Vérifie si un modèle de demande existe pour une propriété donnée.
 * 
 * @param {string} propertyId - UUID de la propriété
 * @returns {Promise<boolean>} true si le modèle existe, false sinon
 */
async function checkModelExists(propertyId) {
    const fs = require('fs').promises;
    const modelPath = path.join(__dirname, '..', 'pricing_models', `demand_model_${propertyId}.json`);
    const metaPath = path.join(__dirname, '..', 'pricing_models', `demand_model_${propertyId}.meta.json`);
    
    try {
        await fs.access(modelPath);
        await fs.access(metaPath);
        return true;
    } catch {
        return false;
    }
}

// Initialisation au chargement du module
startPythonProcess();

// Gestion propre à la fermeture de Node
process.on('exit', () => {
    isRestarting = true;
    if (pythonProcess) {
        pythonProcess.kill();
    }
});

process.on('SIGINT', () => {
    isRestarting = true;
    if (pythonProcess) {
        pythonProcess.kill();
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    isRestarting = true;
    if (pythonProcess) {
        pythonProcess.kill();
    }
    process.exit(0);
});

module.exports = { 
    getPricingPrediction,
    getRecommendedPrice,
    simulatePrices,
    checkModelExists
};
