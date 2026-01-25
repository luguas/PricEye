/**
 * Helper Supabase pour remplacer les appels Firestore
 * Fournit des fonctions utilitaires pour faciliter la migration
 */

const { supabase } = require('../config/supabase.js');

/**
 * Récupère un utilisateur par son ID
 */
async function getUser(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .single();
  
  if (error && error.code !== 'PGRST116') { // PGRST116 = not found
    throw error;
  }
  
  return data || null;
}

/**
 * Crée ou met à jour un utilisateur
 */
async function setUser(userId, userData) {
  const { data, error } = await supabase
    .from('users')
    .upsert({ id: userId, ...userData, updated_at: new Date().toISOString() }, { onConflict: 'id' });
  
  if (error) throw error;
  return data;
}

/**
 * Met à jour un utilisateur
 */
async function updateUser(userId, updateData) {
  const { data, error } = await supabase
    .from('users')
    .update({ ...updateData, updated_at: new Date().toISOString() })
    .eq('id', userId)
    .select()
    .single();
  
  if (error) throw error;
  return data;
}

/**
 * Récupère une propriété par son ID
 */
async function getProperty(propertyId) {
  const { data, error } = await supabase
    .from('properties')
    .select('*')
    .eq('id', propertyId)
    .single();
  
  if (error && error.code !== 'PGRST116') {
    throw error;
  }
  
  return data || null;
}

/**
 * Récupère toutes les propriétés d'une équipe
 */
async function getPropertiesByTeam(teamId) {
  const { data, error } = await supabase
    .from('properties')
    .select('*')
    .eq('team_id', teamId);
  
  if (error) throw error;
  return data || [];
}

/**
 * Récupère toutes les propriétés d'un propriétaire
 */
async function getPropertiesByOwner(ownerId) {
  const { data, error } = await supabase
    .from('properties')
    .select('*')
    .eq('owner_id', ownerId);
  
  if (error) throw error;
  return data || [];
}

/**
 * Crée une propriété
 */
async function createProperty(propertyData) {
  const { data, error } = await supabase
    .from('properties')
    .insert(propertyData)
    .select()
    .single();
  
  if (error) throw error;
  return data;
}

/**
 * Met à jour une propriété
 */
async function updateProperty(propertyId, updateData) {
  const { data, error } = await supabase
    .from('properties')
    .update({ ...updateData, updated_at: new Date().toISOString() })
    .eq('id', propertyId)
    .select()
    .single();
  
  if (error) throw error;
  return data;
}

/**
 * Supprime une propriété
 */
async function deleteProperty(propertyId) {
  const { error } = await supabase
    .from('properties')
    .delete()
    .eq('id', propertyId);
  
  if (error) throw error;
}

/**
 * Récupère un groupe par son ID
 */
async function getGroup(groupId) {
  const { data, error } = await supabase
    .from('groups')
    .select(`
      *,
      group_properties (
        property_id,
        properties (*)
      )
    `)
    .eq('id', groupId)
    .single();
  
  if (error && error.code !== 'PGRST116') {
    throw error;
  }
  
  if (!data) return null;
  
  // Extraire les données du JSONB strategy et rules pour les aplatir
  // Conserver les JSONB bruts dans _strategy_raw et _rules_raw pour les mises à jour
  const strategyRaw = data.strategy;
  const rulesRaw = data.rules;
  const strategy = strategyRaw && typeof strategyRaw === 'object' && !Array.isArray(strategyRaw) ? strategyRaw : {};
  const rules = rulesRaw && typeof rulesRaw === 'object' && !Array.isArray(rulesRaw) ? rulesRaw : {};
  
  // Transformer les données pour correspondre au format attendu
  return {
    ...data,
    // Conserver les JSONB bruts pour les mises à jour
    _strategy_raw: strategyRaw,
    _rules_raw: rulesRaw,
    // Aplatir les données du JSONB strategy
    strategy: strategy.strategy || data.strategy_type || null,
    floor_price: strategy.floor_price || null,
    base_price: strategy.base_price || null,
    ceiling_price: strategy.ceiling_price || null,
    // Aplatir les données du JSONB rules
    min_stay_duration: rules.min_stay_duration || rules.min_stay || null,
    max_stay_duration: rules.max_stay_duration || rules.max_stay || null,
    long_stay_discount: rules.long_stay_discount || rules.weekly_discount_percent || null,
    markup: rules.markup || rules.weekend_markup_percent || null,
    properties: (data.group_properties || []).map(gp => gp.property_id).filter(Boolean),
    // Normaliser les noms de champs pour compatibilité frontend
    mainPropertyId: data.main_property_id || null,
    syncPrices: data.sync_prices || false,
    // Normaliser les règles pour compatibilité frontend
    min_stay: rules.min_stay_duration || rules.min_stay || null,
    max_stay: rules.max_stay_duration || rules.max_stay || null,
    weekly_discount_percent: rules.weekly_discount_percent || rules.long_stay_discount || null,
    monthly_discount_percent: rules.monthly_discount_percent || null,
    weekend_markup_percent: rules.weekend_markup_percent || rules.markup || null
  };
}

/**
 * Récupère les groupes d'un propriétaire
 */
async function getGroupsByOwner(ownerId) {
  const { data, error } = await supabase
    .from('groups')
    .select(`
      *,
      group_properties (
        property_id,
        properties (*)
      )
    `)
    .eq('owner_id', ownerId);
  
  if (error) throw error;
  
  // Transformer les données pour correspondre au format attendu
  return (data || []).map(group => {
    // Extraire les données du JSONB strategy et rules pour les aplatir
    // Conserver les JSONB bruts dans _strategy_raw et _rules_raw pour les mises à jour
    const strategyRaw = group.strategy;
    const rulesRaw = group.rules;
    const strategy = strategyRaw && typeof strategyRaw === 'object' && !Array.isArray(strategyRaw) ? strategyRaw : {};
    const rules = rulesRaw && typeof rulesRaw === 'object' && !Array.isArray(rulesRaw) ? rulesRaw : {};
    
    return {
      ...group,
      // Conserver les JSONB bruts pour les mises à jour
      _strategy_raw: strategyRaw,
      _rules_raw: rulesRaw,
      // Aplatir les données du JSONB strategy
      strategy: strategy.strategy || group.strategy_type || null,
      floor_price: strategy.floor_price || null,
      base_price: strategy.base_price || null,
      ceiling_price: strategy.ceiling_price || null,
      // Aplatir les données du JSONB rules
      min_stay_duration: rules.min_stay_duration || rules.min_stay || null,
      max_stay_duration: rules.max_stay_duration || rules.max_stay || null,
      long_stay_discount: rules.long_stay_discount || rules.weekly_discount_percent || null,
      markup: rules.markup || rules.weekend_markup_percent || null,
      properties: (group.group_properties || []).map(gp => gp.property_id).filter(Boolean),
      // Normaliser les noms de champs pour compatibilité frontend
      mainPropertyId: group.main_property_id || null,
      syncPrices: group.sync_prices || false,
      // Normaliser les règles pour compatibilité frontend
      min_stay: rules.min_stay_duration || rules.min_stay || null,
      max_stay: rules.max_stay_duration || rules.max_stay || null,
      weekly_discount_percent: rules.weekly_discount_percent || rules.long_stay_discount || null,
      monthly_discount_percent: rules.monthly_discount_percent || null,
      weekend_markup_percent: rules.weekend_markup_percent || rules.markup || null
    };
  });
}

/**
 * Crée un groupe
 */
async function createGroup(groupData) {
  const { data, error } = await supabase
    .from('groups')
    .insert(groupData)
    .select()
    .single();
  
  if (error) throw error;
  return data;
}

/**
 * Met à jour un groupe
 */
async function updateGroup(groupId, updateData) {
  // Pour les champs JSONB (strategy, rules), Supabase nécessite que les valeurs soient des objets JavaScript valides
  // Les convertir explicitement en objets si nécessaire
  const processedData = { ...updateData };
  
  // S'assurer que les champs JSONB sont bien des objets
  if (processedData.strategy && typeof processedData.strategy === 'object') {
    processedData.strategy = processedData.strategy;
  }
  if (processedData.rules && typeof processedData.rules === 'object') {
    processedData.rules = processedData.rules;
  }
  
  const { data, error } = await supabase
    .from('groups')
    .update({ ...processedData, updated_at: new Date().toISOString() })
    .eq('id', groupId)
    .select()
    .single();
  
  if (error) {
    console.error(`[updateGroup] Erreur lors de la mise à jour du groupe ${groupId}:`, error);
    console.error(`[updateGroup] Données envoyées:`, JSON.stringify(processedData, null, 2));
    throw error;
  }
  
  return data;
}

/**
 * Supprime un groupe
 */
async function deleteGroup(groupId) {
  // Supprimer d'abord les relations dans group_properties
  await supabase
    .from('group_properties')
    .delete()
    .eq('group_id', groupId);
  
  // Puis supprimer le groupe
  const { error } = await supabase
    .from('groups')
    .delete()
    .eq('id', groupId);
  
  if (error) throw error;
}

/**
 * Ajoute des propriétés à un groupe
 */
async function addPropertiesToGroup(groupId, propertyIds) {
  // Vérifier que les propriétés ne sont pas déjà dans le groupe
  const { data: existing, error: checkError } = await supabase
    .from('group_properties')
    .select('property_id')
    .eq('group_id', groupId)
    .in('property_id', propertyIds);
  
  if (checkError) throw checkError;
  
  const existingIds = new Set((existing || []).map(e => e.property_id));
  const newPropertyIds = propertyIds.filter(id => !existingIds.has(id));
  
  if (newPropertyIds.length === 0) {
    return []; // Toutes les propriétés sont déjà dans le groupe
  }
  
  // Insérer les nouvelles relations
  const relationsToInsert = newPropertyIds.map(propertyId => ({
    group_id: groupId,
    property_id: propertyId
  }));
  
  const { data, error } = await supabase
    .from('group_properties')
    .insert(relationsToInsert)
    .select();
  
  if (error) throw error;
  return data || [];
}

/**
 * Retire des propriétés d'un groupe
 */
async function removePropertiesFromGroup(groupId, propertyIds) {
  const { error } = await supabase
    .from('group_properties')
    .delete()
    .eq('group_id', groupId)
    .in('property_id', propertyIds);
  
  if (error) throw error;
}

/**
 * Récupère les intégrations d'un utilisateur
 */
async function getIntegrationsByUser(userId) {
  const { data, error } = await supabase
    .from('integrations')
    .select('*')
    .eq('user_id', userId);
  
  if (error) throw error;
  return data || [];
}

/**
 * Récupère une intégration spécifique d'un utilisateur
 */
async function getIntegrationByUserAndType(userId, type) {
  const { data, error } = await supabase
    .from('integrations')
    .select('*')
    .eq('user_id', userId)
    .eq('type', type)
    .single();
  
  if (error && error.code !== 'PGRST116') {
    throw error;
  }
  
  return data || null;
}

/**
 * Crée ou met à jour une intégration
 */
async function upsertIntegration(userId, type, integrationData) {
  const { data, error } = await supabase
    .from('integrations')
    .upsert({
      user_id: userId,
      type: type,
      ...integrationData,
      connected_at: integrationData.connected_at || new Date().toISOString()
    }, {
      onConflict: 'user_id,type'
    })
    .select()
    .single();
  
  if (error) throw error;
  return data;
}

/**
 * Supprime une intégration
 */
async function deleteIntegration(userId, type) {
  const { error } = await supabase
    .from('integrations')
    .delete()
    .eq('user_id', userId)
    .eq('type', type);
  
  if (error) throw error;
}

/**
 * Récupère toutes les intégrations (pour les tâches cron)
 */
async function getAllIntegrations() {
  const { data, error } = await supabase
    .from('integrations')
    .select(`
      *,
      users!inner(id, email, pms_sync_enabled, pms_sync_stopped_reason)
    `);
  
  if (error) throw error;
  return data || [];
}

/**
 * Enregistre un log de propriété
 */
async function logPropertyChange(propertyId, userId, userEmail, action, changes) {
  try {
    // Vérifier si userId est un UUID valide ou une chaîne système
    // Si c'est "system" ou une autre chaîne non-UUID, mettre user_id à NULL
    let validUserId = userId;
    
    // Expression régulière pour valider un UUID v4
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    
    if (!userId || !uuidRegex.test(userId)) {
      // Si userId n'est pas un UUID valide (ex: "system", "auto-update", etc.), mettre à NULL
      validUserId = null;
    }
    
    const { error } = await supabase
      .from('property_logs')
      .insert({
        property_id: propertyId,
        user_id: validUserId,
        user_email: userEmail || 'Inconnu',
        action: action,
        changes: changes || {},
        timestamp: new Date().toISOString()
      });
    
    if (error) throw error;
    console.log(`Log enregistré pour ${propertyId}: action ${action}`);
  } catch (error) {
    console.error(`Erreur lors de l'enregistrement du log pour ${propertyId}:`, error);
    // Ne pas bloquer la requête principale si le logging échoue
  }
}

/**
 * Récupère les réservations d'une propriété pour un mois
 */
async function getBookingsForMonth(propertyId, year, month) {
  // Calculer le dernier jour réel du mois (gère les années bissextiles)
  // month est 1-indexé (1-12) dans cette fonction
  const lastDayOfMonth = new Date(year, month, 0).getDate();
  
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDayOfMonth).padStart(2, '0')}`;
  
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('property_id', propertyId)
    .gte('start_date', startDate)
    .lte('start_date', endDate)
    .order('start_date', { ascending: true });
  
  if (error) throw error;
  return data || [];
}

/**
 * Récupère les réservations d'une équipe qui chevauchent une période
 */
async function getBookingsByTeamAndDateRange(teamId, startDate, endDate) {
  // Récupérer d'abord les propriétés de l'équipe
  const { data: properties, error: propsError } = await supabase
    .from('properties')
    .select('id')
    .eq('team_id', teamId);
  
  if (propsError) throw propsError;
  if (!properties || properties.length === 0) return [];
  
  const propertyIds = properties.map(p => p.id);
  
  // Récupérer les réservations qui chevauchent la période
  const { data, error } = await supabase
    .from('bookings')
    .select(`
      *,
      properties!inner(team_id)
    `)
    .in('property_id', propertyIds)
    .lte('start_date', endDate)
    .gte('end_date', startDate)
    .order('start_date', { ascending: true });
  
  if (error) throw error;
  return data || [];
}

/**
 * Crée une réservation
 */
async function createBooking(propertyId, bookingData) {
  const { data, error } = await supabase
    .from('bookings')
    .insert({
      property_id: propertyId,
      ...bookingData
    })
    .select()
    .single();
  
  if (error) throw error;
  return data;
}

/**
 * Met à jour une réservation
 */
async function updateBooking(bookingId, updateData) {
  const { data, error } = await supabase
    .from('bookings')
    .update({ ...updateData, updated_at: new Date().toISOString() })
    .eq('id', bookingId)
    .select()
    .single();
  
  if (error) throw error;
  return data;
}

/**
 * Supprime une réservation
 */
async function deleteBooking(bookingId) {
  const { error } = await supabase
    .from('bookings')
    .delete()
    .eq('id', bookingId);
  
  if (error) throw error;
}

/**
 * Récupère les price overrides d'une propriété
 */
async function getPriceOverrides(propertyId, startDate, endDate) {
  // Valider que propertyId est un UUID valide
  if (!propertyId || typeof propertyId !== 'string' || propertyId.length < 32) {
    console.error('getPriceOverrides: UUID invalide reçu', propertyId, 'Longueur:', propertyId?.length);
    throw new Error(`UUID de propriété invalide: ${propertyId}`);
  }
  
  let query = supabase
    .from('price_overrides')
    .select('*')
    .eq('property_id', propertyId);
  
  if (startDate) {
    query = query.gte('date', startDate);
  }
  if (endDate) {
    query = query.lte('date', endDate);
  }
  
  const { data, error } = await query.order('date', { ascending: true });
  
  if (error) {
    console.error('Erreur Supabase getPriceOverrides:', error, 'propertyId:', propertyId);
    throw error;
  }
  return data || [];
}

/**
 * Met à jour les price overrides en batch
 */
async function upsertPriceOverrides(propertyId, overrides) {
  const overridesToInsert = overrides.map(override => ({
    property_id: propertyId,
    date: override.date,
    price: override.price,
    is_locked: override.isLocked || false,
    reason: override.reason || 'Manuel',
    updated_by: override.updatedBy || null
  }));
  
  const { data, error } = await supabase
    .from('price_overrides')
    .upsert(overridesToInsert, {
      onConflict: 'property_id,date'
    })
    .select();
  
  if (error) throw error;
  return data || [];
}

/**
 * Récupère une réservation par son ID
 */
async function getBooking(bookingId) {
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('id', bookingId)
    .single();
  
  if (error && error.code !== 'PGRST116') {
    throw error;
  }
  
  return data || null;
}

/**
 * Récupère le cache système (ex: marketNews)
 */
async function getSystemCache(key) {
  const { data, error } = await supabase
    .from('system_cache')
    .select('*')
    .eq('key', key)
    .single();
  
  if (error && error.code !== 'PGRST116') {
    throw error;
  }
  
  return data || null;
}

/**
 * Upsert du cache système. La date updated_at est TOUJOURS définie côté Node.js,
 * jamais par la base (pas de trigger). Garantit que chaque écriture rafraîchit la date.
 * @param {Object} payload - { key, data, language? }
 * @returns {Promise<Object>} La ligne upsertée (avec data, updated_at, ...)
 */
async function upsertSystemCache(payload) {
  const now = new Date().toISOString();
  const row = {
    key: payload.key,
    data: payload.data,
    ...(payload.language != null && { language: payload.language }),
    updated_at: now
  };
  const { data: result, error } = await supabase
    .from('system_cache')
    .upsert(row, { onConflict: 'key' })
    .select()
    .single();

  if (error) throw error;
  return result;
}

/**
 * Met à jour ou crée un cache système (wrapper vers upsertSystemCache).
 * @deprecated Préférer upsertSystemCache pour le cache actualités.
 */
async function setSystemCache(key, data, metadata = {}) {
  return upsertSystemCache({ key, data, ...metadata });
}

/**
 * Supprime un utilisateur et toutes ses données associées de la base de données
 * ATTENTION: Cette fonction supprime uniquement les données de la base de données
 * La suppression de l'utilisateur dans Supabase Auth doit être faite séparément
 * Utiliser avec précaution!
 * @param {string} userId - L'ID de l'utilisateur à supprimer
 * @returns {Promise<void>}
 */
async function deleteUser(userId) {
  if (!userId) {
    throw new Error('userId est requis pour supprimer un utilisateur');
  }

  // Récupérer le teamId de l'utilisateur avant suppression
  const user = await getUser(userId);
  if (!user) {
    throw new Error(`Utilisateur ${userId} non trouvé`);
  }
  const teamId = user.team_id || userId;

  // Supprimer les données associées dans l'ordre correct pour éviter les violations de contraintes
  
  // 1. Supprimer les réservations (bookings)
  const { data: properties } = await supabase
    .from('properties')
    .select('id')
    .eq('team_id', teamId);
  
  if (properties && properties.length > 0) {
    const propertyIds = properties.map(p => p.id);
    await supabase
      .from('bookings')
      .delete()
      .in('property_id', propertyIds);
  }

  // 2. Supprimer les price_overrides
  if (properties && properties.length > 0) {
    const propertyIds = properties.map(p => p.id);
    await supabase
      .from('price_overrides')
      .delete()
      .in('property_id', propertyIds);
  }

  // 3. Supprimer les relations group_properties
  const { data: groups } = await supabase
    .from('groups')
    .select('id')
    .eq('owner_id', userId);
  
  if (groups && groups.length > 0) {
    const groupIds = groups.map(g => g.id);
    await supabase
      .from('group_properties')
      .delete()
      .in('group_id', groupIds);
  }

  // 4. Supprimer les groupes
  await supabase
    .from('groups')
    .delete()
    .eq('owner_id', userId);

  // 5. Supprimer les propriétés
  await supabase
    .from('properties')
    .delete()
    .eq('team_id', teamId);

  // 6. Supprimer les intégrations
  await supabase
    .from('integrations')
    .delete()
    .eq('user_id', userId);

  // 7. Supprimer les logs de propriétés (property_logs)
  // Note: On peut aussi les anonymiser au lieu de les supprimer pour garder l'historique
  if (properties && properties.length > 0) {
    const propertyIds = properties.map(p => p.id);
    await supabase
      .from('property_logs')
      .delete()
      .in('property_id', propertyIds);
  }

  // 8. Supprimer les quotas IA (user_ai_usage)
  await supabase
    .from('user_ai_usage')
    .delete()
    .eq('user_id', userId);

  // 9. Supprimer l'utilisateur de la table users
  const { error: deleteError } = await supabase
    .from('users')
    .delete()
    .eq('id', userId);
  
  if (deleteError) {
    throw new Error(`Erreur lors de la suppression de l'utilisateur dans la base de données: ${deleteError.message}`);
  }

  // Note: La suppression de l'utilisateur dans Supabase Auth doit être faite séparément
  // via supabase.auth.admin.deleteUser(userId) dans la route API
}

module.exports = {
  getUser,
  setUser,
  updateUser,
  getProperty,
  getPropertiesByTeam,
  getPropertiesByOwner,
  createProperty,
  updateProperty,
  deleteProperty,
  getGroup,
  getGroupsByOwner,
  createGroup,
  updateGroup,
  deleteGroup,
  getIntegrationsByUser,
  getIntegrationByUserAndType,
  upsertIntegration,
  deleteIntegration,
  getAllIntegrations,
  logPropertyChange,
  getBookingsForMonth,
  createBooking,
  updateBooking,
  deleteBooking,
  getPriceOverrides,
  upsertPriceOverrides,
  getSystemCache,
  setSystemCache,
  upsertSystemCache,
  getBooking,
  getBookingsByTeamAndDateRange,
  addPropertiesToGroup,
  removePropertiesFromGroup,
  deleteUser
};

