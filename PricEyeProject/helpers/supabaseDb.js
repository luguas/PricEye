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
  
  // Transformer les données pour correspondre au format attendu
  return {
    ...data,
    properties: (data.group_properties || []).map(gp => gp.properties).filter(Boolean)
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
  return (data || []).map(group => ({
    ...group,
    properties: (group.group_properties || []).map(gp => gp.properties).filter(Boolean)
  }));
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
  const { data, error } = await supabase
    .from('groups')
    .update({ ...updateData, updated_at: new Date().toISOString() })
    .eq('id', groupId)
    .select()
    .single();
  
  if (error) throw error;
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
    const { error } = await supabase
      .from('property_logs')
      .insert({
        property_id: propertyId,
        user_id: userId,
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
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = `${year}-${String(month).padStart(2, '0')}-31`;
  
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
  
  if (error) throw error;
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
 * Met à jour ou crée un cache système
 */
async function setSystemCache(key, data, metadata = {}) {
  const { data: result, error } = await supabase
    .from('system_cache')
    .upsert({
      key: key,
      data: data,
      ...metadata,
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'key'
    })
    .select()
    .single();
  
  if (error) throw error;
  return result;
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
  getBooking,
  getBookingsByTeamAndDateRange,
  addPropertiesToGroup,
  removePropertiesFromGroup
};

