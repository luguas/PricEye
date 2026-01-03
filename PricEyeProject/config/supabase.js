// Configuration Supabase (côté serveur)
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ ERREUR: Variables d\'environnement Supabase manquantes');
  console.error('📝 Veuillez configurer SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY dans votre fichier .env');
  process.exit(1);
}

// Créer le client Supabase avec la clé de service (permissions admin)
// Note: Utilisez cette clé uniquement côté serveur, jamais côté client
const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

module.exports = { supabase };






