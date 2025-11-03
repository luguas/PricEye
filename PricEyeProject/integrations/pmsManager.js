/**
 * @file integrations/pmsManager.js
 * @description Point d'entrée (Factory) pour la gestion des différentes intégrations PMS.
 * Ce fichier scanne son propre dossier pour trouver tous les adaptateurs
 * et les charge dynamiquement.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 1. Obtenir le chemin du répertoire actuel dans un module ES
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Mappage centralisé des types de PMS vers leur classe d'adaptateur.
 */
const pmsAdapters = {};

/**
 * (CORRECTION) Promise qui résout une fois que les adaptateurs sont chargés.
 * Cela empêche le serveur d'appeler getPMSClient avant que le chargement ne soit terminé.
 */
let adaptersLoadedPromise = null;

/**
 * Fonction d'auto-chargement des adaptateurs.
 */
async function loadAdapters() {
  console.log("[PMSManager] Détection et chargement des adaptateurs...");
  const files = fs.readdirSync(__dirname);
  
  for (const file of files) {
    // On cherche les adaptateurs, en excluant ce fichier et la classe de base
    if (file.endsWith('Adapter.js') && file !== 'pmsManager.js' && file !== 'pmsBase.js') {
      try {
        // Importer le module dynamiquement (le './' est crucial)
        const module = await import(`./${file}`);
        
        const AdapterClass = module.default;
        const type = module.type; // Récupère la constante 'type' exportée

        if (AdapterClass && type) {
          console.log(`[PMSManager] Adaptateur trouvé et chargé : ${type} (depuis ${file})`);
          pmsAdapters[type] = AdapterClass;
        } else {
          console.warn(`[PMSManager] Fichier ${file} semble être un adaptateur mais n'exporte pas 'default' ou 'type'.`);
        }
      } catch (error) {
        console.error(`[PMSManager] Erreur lors du chargement de l'adaptateur ${file}:`, error);
      }
    }
  }
  console.log(`[PMSManager] Chargement terminé. Adaptateurs chargés: ${Object.keys(pmsAdapters).join(', ')}`);
}

/**
 * (CORRECTION) Fonction "singleton" pour s'assurer que loadAdapters n'est appelé qu'une seule fois.
 */
function ensureAdaptersLoaded() {
  if (!adaptersLoadedPromise) {
    adaptersLoadedPromise = loadAdapters();
  }
  return adaptersLoadedPromise;
}

/**
 * Fonction "Factory" qui crée et retourne une instance du client PMS approprié.
 * (CORRECTION) Doit être async pour 'await' le chargement.
 * * @param {string} type - Le type de PMS (ex: 'smoobu', 'beds24').
 * @param {object} credentials - Les identifiants (clé API, etc.) requis pour ce PMS.
 * @returns {Promise<PMSBase>} - Une instance de l'adaptateur PMS correct (ex: SmoobuAdapter).
 * @throws {Error} - Si le type de PMS n'est pas reconnu ou supporté.
 */
export async function getPMSClient(type, credentials) {
  // 1. S'assurer que le chargement est terminé
  await ensureAdaptersLoaded();

  // 2. Récupérer l'adaptateur
  const AdapterClass = pmsAdapters[type];

  if (!AdapterClass) {
    throw new Error(`Type de PMS non reconnu ou non supporté : '${type}'. Adaptateurs chargés: ${Object.keys(pmsAdapters).join(', ')}`);
  }

  // 3. Crée et retourne une nouvelle instance
  return new AdapterClass(credentials);
}

