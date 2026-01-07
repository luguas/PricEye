/**
 * Script pour installer les dépendances Python nécessaires au moteur de pricing.
 * 
 * Ce script est appelé au démarrage du serveur pour s'assurer que toutes
 * les dépendances Python sont installées.
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs').promises;

const execAsync = promisify(exec);

const PYTHON_COMMAND = process.platform === 'win32' ? 'python' : 'python3';
const REQUIREMENTS_FILE = path.join(__dirname, '..', 'requirements.txt');

async function checkPythonAvailable() {
    try {
        const { stdout } = await execAsync(`${PYTHON_COMMAND} --version`);
        console.log(`[Python Deps] Python disponible: ${stdout.trim()}`);
        return true;
    } catch (error) {
        console.warn(`[Python Deps] Python non disponible: ${error.message}`);
        return false;
    }
}

async function checkDependencyInstalled(moduleName) {
    try {
        const { stdout } = await execAsync(
            `${PYTHON_COMMAND} -c "import ${moduleName}; print('ok')"`,
            { timeout: 5000 }
        );
        return stdout.includes('ok');
    } catch (error) {
        return false;
    }
}

async function installDependencies() {
    try {
        // Vérifier que Python est disponible
        const pythonAvailable = await checkPythonAvailable();
        if (!pythonAvailable) {
            console.warn('[Python Deps] Python non disponible, installation des dépendances ignorée');
            return false;
        }

        // Vérifier que le fichier requirements.txt existe
        try {
            await fs.access(REQUIREMENTS_FILE);
        } catch (error) {
            console.warn(`[Python Deps] Fichier requirements.txt non trouvé: ${REQUIREMENTS_FILE}`);
            return false;
        }

        // Vérifier si supabase est déjà installé
        const supabaseInstalled = await checkDependencyInstalled('supabase');
        if (supabaseInstalled) {
            console.log('[Python Deps] Module supabase déjà installé');
            return true;
        }

        console.log('[Python Deps] Installation des dépendances Python...');
        console.log(`[Python Deps] Fichier: ${REQUIREMENTS_FILE}`);

        // Installer les dépendances
        const installCommand = `${PYTHON_COMMAND} -m pip install --user -r "${REQUIREMENTS_FILE}"`;
        console.log(`[Python Deps] Commande: ${installCommand}`);

        const { stdout, stderr } = await execAsync(installCommand, {
            cwd: path.join(__dirname, '..'),
            timeout: 120000, // 2 minutes
            maxBuffer: 10 * 1024 * 1024 // 10MB
        });

        if (stdout) {
            console.log(`[Python Deps] Sortie: ${stdout.substring(0, 500)}`);
        }
        if (stderr && !stderr.includes('WARNING')) {
            console.warn(`[Python Deps] Warnings: ${stderr.substring(0, 500)}`);
        }

        // Vérifier que supabase est maintenant installé
        const supabaseNowInstalled = await checkDependencyInstalled('supabase');
        if (supabaseNowInstalled) {
            console.log('[Python Deps] ✅ Dépendances Python installées avec succès');
            return true;
        } else {
            console.error('[Python Deps] ❌ Échec de l\'installation (supabase toujours non disponible)');
            return false;
        }

    } catch (error) {
        console.error('[Python Deps] ❌ Erreur lors de l\'installation:', error.message);
        if (error.stdout) {
            console.error('[Python Deps] stdout:', error.stdout.substring(0, 1000));
        }
        if (error.stderr) {
            console.error('[Python Deps] stderr:', error.stderr.substring(0, 1000));
        }
        return false;
    }
}

// Si le script est exécuté directement
if (require.main === module) {
    installDependencies()
        .then(success => {
            process.exit(success ? 0 : 1);
        })
        .catch(error => {
            console.error('[Python Deps] Erreur fatale:', error);
            process.exit(1);
        });
}

module.exports = { installDependencies, checkPythonAvailable, checkDependencyInstalled };

