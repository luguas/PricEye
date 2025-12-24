// L'URL de base de notre serveur backend
const API_BASE_URL = 'https://priceye.onrender.com';

// Importer Supabase (client) pour l'authentification
import { supabase } from '../config/supabase.js';


/**
 * Fonction générique pour gérer les requêtes fetch vers NOTRE backend.
 */
async function apiRequest(endpoint, options = {}) {
  const token = options.token;
  const headers = {
    'Content-Type': options.headers?.['Content-Type'] ?? 'application/json', 
    ...options.headers, 
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  
  const finalOptions = {
      ...options,
      headers,
  };
  delete finalOptions.token;

  const response = await fetch(`${API_BASE_URL}${endpoint}`, finalOptions);
  
  const contentType = response.headers.get('content-type');

  if (!response.ok) {
    // Si le token est expiré ou invalide (401 ou 403), déclencher la déconnexion
    if (response.status === 401 || response.status === 403) {
      // Nettoyer le token du localStorage
      localStorage.removeItem('authToken');
      // Déclencher un événement personnalisé pour notifier App.jsx
      if (typeof window !== 'undefined') {
        try {
          window.dispatchEvent(new CustomEvent('tokenExpired'));
        } catch (error) {
          console.error('Erreur lors de l\'envoi de l\'événement tokenExpired:', error);
        }
      }
    }
    
    let errorData = { error: `Erreur ${response.status} sur l'endpoint ${endpoint}`};
    if (contentType && contentType.includes('application/json')) {
      try {
        errorData = await response.json();
      } catch (e) { /* Ignorer */ }
    } else {
        const textError = await response.text();
        if (textError) {
             errorData.error = textError;
        }
    }
    console.error(`Erreur API (${response.status}):`, errorData.error); 
    throw new Error(errorData.error);
  }

  if (response.status === 204 || (response.status === 200 && (!contentType?.includes('application/json') || response.headers.get('content-length') === '0'))) {
    return { message: 'Opération réussie.' };
  }
  
   if (contentType && (contentType.includes('text/html') || contentType.includes('text/plain'))) {
       const text = await response.text();
       return { message: text }; 
   }

  try {
      const data = await response.json();
      return data;
  } catch (e) {
       console.error("Erreur de parsing JSON pour une réponse OK:", e, "Réponse:", await response.text());
       throw new Error("Réponse du serveur reçue mais invalide (pas un JSON).");
  }
}


/**
 * Fonctions d'authentification
 */
export async function login(email, password) {
  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email,
      password: password
    });

    if (error) {
      console.error("Erreur de connexion Supabase:", error.message);
      if (error.message.includes('Invalid login credentials') || error.message.includes('Email not confirmed')) {
        throw new Error("Email ou mot de passe invalide.");
      }
      throw new Error(error.message);
    }

    if (!data.session) {
      throw new Error("Aucune session créée.");
    }

    // Retourner l'access_token comme idToken pour compatibilité avec le backend
    return { idToken: data.session.access_token, message: "Connexion réussie" };
  } catch (error) {
    throw error;
  }
}

export function register(userData) {
  return apiRequest('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(userData),
  });
}

export async function changeUserPassword(oldPassword, newPassword) {
    try {
        // Vérifier que l'utilisateur est connecté
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
            throw new Error("Utilisateur non connecté ou session invalide. Veuillez vous reconnecter.");
        }

        // Vérifier l'ancien mot de passe en se reconnectant
        const { error: signInError } = await supabase.auth.signInWithPassword({
            email: user.email,
            password: oldPassword
        });

        if (signInError) {
            if (signInError.message.includes('Invalid login credentials')) {
                throw new Error("L'ancien mot de passe est incorrect.");
            }
            throw new Error(signInError.message);
        }

        // Mettre à jour le mot de passe
        const { error: updateError } = await supabase.auth.updateUser({
            password: newPassword
        });

        if (updateError) {
            if (updateError.message.includes('Password should be at least')) {
                throw new Error("Le nouveau mot de passe est trop faible (6 caractères min).");
            }
            throw new Error(updateError.message);
        }
    } catch (error) {
        console.error("Erreur lors du changement de mot de passe:", error);
        throw error;
    }
}


/**
 * Fonctions de profil (utilisent NOTRE backend)
 */
export function getUserProfile(token) {
  return apiRequest('/api/users/profile', { token });
}

export function updateUserProfile(profileData, token) {
  return apiRequest('/api/users/profile', {
    method: 'PUT',
    token,
    body: JSON.stringify(profileData),
  });
}

// --- Fonctions d'intégration PMS ---

/**
 * Récupère l'intégration PMS active de l'utilisateur.
 * @param {string} token - Jeton d'authentification Priceye
 */
export function getIntegrations(token) {
    return apiRequest('/api/integrations', {
        token: token,
    });
}

/**
 * Teste une connexion PMS avant de la sauvegarder.
 * @param {string} type - 'smoobu', 'beds24', etc.
 * @param {object} credentials - Les clés API
 * @param {string} token - Jeton d'authentification Priceye
 */
export function testConnection(type, credentials, token) {
    return apiRequest('/api/integrations/test-connection', {
        method: 'POST',
        token: token,
        body: JSON.stringify({ type: type, credentials: credentials }),
    });
}

/**
 * Sauvegarde les identifiants PMS après un test réussi.
 * @param {string} type - 'smoobu', 'beds24', etc.
 * @param {object} credentials - Les clés API
 * @param {string} token - Jeton d'authentification Priceye
 */
export function connectPMS(type, credentials, token) {
    return apiRequest('/api/integrations/connect', {
        method: 'POST',
        token: token,
        body: JSON.stringify({ type: type, credentials: credentials }),
    });
}

/**
 * Demande au backend de synchroniser les propriétés du PMS connecté.
 * @param {string} token - Jeton d'authentification Priceye
 */
export function syncProperties(token) {
     return apiRequest('/api/integrations/sync-properties', {
        method: 'POST',
        token: token,
    });
}

export function disconnectPMS(type, token) {
    return apiRequest(`/api/integrations/${type}`, {
        method: 'DELETE',
        token: token,
    });
}

/**
 * (NOUVEAU) Importe les propriétés sélectionnées du PMS dans la base de données Priceye.
 * @param {Array<object>} propertiesToImport - Liste des propriétés normalisées à importer.
 * @param {string} pmsType - Le type de PMS (ex: 'smoobu')
 * @param {string} token - Jeton d'authentification Priceye
 */
export function importPmsProperties(propertiesToImport, pmsType, token) {
     return apiRequest('/api/integrations/import-properties', {
        method: 'POST',
        token: token,
        body: JSON.stringify({ 
            propertiesToImport: propertiesToImport,
            pmsType: pmsType 
        }),
    });
}


/**
 * Fonctions des Propriétés
 */
export function getProperties(token) {
  return apiRequest('/api/properties', { token }); 
}

export function addProperty(propertyData, token) {
  return apiRequest('/api/properties', {
    method: 'POST',
    token,
    body: JSON.stringify(propertyData),
  });
}

export function updateProperty(id, propertyData, token) {
  return apiRequest(`/api/properties/${id}`, {
    method: 'PUT',
    token,
    body: JSON.stringify(propertyData),
  });
}

export function deleteProperty(id, token) {
  return apiRequest(`/api/properties/${id}`, {
    method: 'DELETE',
    token,
  });
}

export function syncPropertyData(id, token) {
  return apiRequest(`/api/properties/${id}/sync`, {
    method: 'POST',
    token,
  });
}

export function updatePropertyStrategy(propertyId, strategyData, token) {
  return apiRequest(`/api/properties/${propertyId}/strategy`, {
    method: 'PUT',
    token,
    body: JSON.stringify(strategyData),
  });
}

export function updatePropertyRules(propertyId, rulesData, token) {
    return apiRequest(`/api/properties/${propertyId}/rules`, {
        method: 'PUT',
        token,
        body: JSON.stringify(rulesData),
    });
}

export function updatePropertyStatus(id, status, token) {
  return apiRequest(`/api/properties/${id}/status`, {
    method: 'PUT',
    token,
    body: JSON.stringify({ status: status }),
  });
}


/**
 * Fonctions pour la gestion des groupes
 */
export function getGroups(token) {
    return apiRequest('/api/groups', { token });
}

export function createGroup(groupData, token) {
    return apiRequest('/api/groups', {
        method: 'POST',
        token,
        body: JSON.stringify(groupData),
    });
}

export function updateGroup(groupId, groupData, token) {
    return apiRequest(`/api/groups/${groupId}`, {
        method: 'PUT',
        token,
        body: JSON.stringify(groupData), 
    });
}

export function deleteGroup(groupId, token) {
    return apiRequest(`/api/groups/${groupId}`, {
        method: 'DELETE',
        token,
    });
}

export function addPropertiesToGroup(groupId, propertyIds, token) {
    return apiRequest(`/api/groups/${groupId}/properties`, {
        method: 'PUT',
        token,
        body: JSON.stringify({ propertyIds }),
    });
}

export function removePropertiesFromGroup(groupId, propertyIds, token) {
    return apiRequest(`/api/groups/${groupId}/properties`, {
        method: 'DELETE',
        token,
        body: JSON.stringify({ propertyIds }),
    });
}

export function updateGroupStrategy(groupId, strategyData, token) {
  return apiRequest(`/api/groups/${groupId}/strategy`, {
    method: 'PUT',
    token,
    body: JSON.stringify(strategyData),
  });
}

export function updateGroupRules(groupId, rulesData, token) {
    return apiRequest(`/api/groups/${groupId}/rules`, {
        method: 'PUT',
        token,
        body: JSON.stringify(rulesData),
    });
}


/**
 * Fonctions de Pricing & Réservations
 */
export function generatePricingStrategy(propertyId, token) {
  return apiRequest(`/api/properties/${propertyId}/pricing-strategy`, {
    method: 'POST',
    token,
  });
}

export function addBooking(propertyId, bookingData, token) {
  return apiRequest(`/api/properties/${propertyId}/bookings`, {
    method: 'POST',
    token,
    body: JSON.stringify(bookingData),
  });
}

export function getBookingsForMonth(propertyId, year, month, token) {
  const monthApi = month + 1; 
  return apiRequest(`/api/properties/${propertyId}/bookings?year=${year}&month=${monthApi}`, {
    token,
  });
}

export function getTeamBookings(token, startDate, endDate) {
    const params = new URLSearchParams({ startDate, endDate });
    return apiRequest(`/api/bookings?${params.toString()}`, {
        token,
    });
}

/**
 * Synchronise les réservations depuis le PMS pour une propriété donnée.
 * @param {string} propertyId - L'ID de la propriété
 * @param {string} startDate - Date de début (YYYY-MM-DD)
 * @param {string} endDate - Date de fin (YYYY-MM-DD)
 * @param {string} token - Jeton d'authentification
 */
export function syncBookingsFromPMS(propertyId, startDate, endDate, token) {
    return apiRequest(`/api/properties/${propertyId}/bookings/sync`, {
        method: 'POST',
        token,
        body: JSON.stringify({ startDate, endDate }),
    });
}

/**
 * Met à jour une réservation existante.
 * @param {string} propertyId - L'ID de la propriété
 * @param {string} bookingId - L'ID de la réservation
 * @param {object} bookingData - Les données à mettre à jour
 * @param {string} token - Jeton d'authentification
 */
export function updateBooking(propertyId, bookingId, bookingData, token) {
    return apiRequest(`/api/properties/${propertyId}/bookings/${bookingId}`, {
        method: 'PUT',
        token,
        body: JSON.stringify(bookingData),
    });
}

/**
 * Supprime une réservation.
 * @param {string} propertyId - L'ID de la propriété
 * @param {string} bookingId - L'ID de la réservation
 * @param {string} token - Jeton d'authentification
 */
export function deleteBooking(propertyId, bookingId, token) {
    return apiRequest(`/api/properties/${propertyId}/bookings/${bookingId}`, {
        method: 'DELETE',
        token,
    });
}


/**
 * Fonctions de Gestion d'Équipe
 */
export function inviteMember(inviteData, token) {
    return apiRequest('/api/teams/invites', {
        method: 'POST',
        token,
        body: JSON.stringify(inviteData),
    });
}

export function getTeamMembers(token) {
    return apiRequest('/api/teams/members', { token });
}

export function updateMemberRole(memberId, newRole, token) {
    return apiRequest(`/api/teams/members/${memberId}/role`, {
        method: 'PUT',
        token,
        body: JSON.stringify({ role: newRole }),
    });
}

export function removeMember(memberId, token) {
    return apiRequest(`/api/teams/members/${memberId}`, {
        method: 'DELETE',
        token,
    });
}

/**
 * Fonctions des Rapports et Actualités
 */
export function getReportKpis(token, startDate, endDate) {
    const params = new URLSearchParams({ startDate, endDate });
    return apiRequest(`/api/reports/kpis?${params.toString()}`, {
        token,
    });
}

export function getRevenueOverTime(token, startDate, endDate) {
    const params = new URLSearchParams({ startDate, endDate });
    return apiRequest(`/api/reports/revenue-over-time?${params.toString()}`, {
        token,
    });
}

export function getPerformanceOverTime(token, startDate, endDate) {
    const params = new URLSearchParams({ startDate, endDate });
    return apiRequest(`/api/reports/performance-over-time?${params.toString()}`, {
        token,
    });
}

export function getMarketDemandSnapshot(token, timezone) {
    const params = new URLSearchParams({ timezone });
    return apiRequest(`/api/reports/market-demand-snapshot?${params.toString()}`, {
        token,
    });
}

export function getPositioningReport(token, startDate, endDate) {
    const params = new URLSearchParams({ startDate, endDate });
    return apiRequest(`/api/reports/positioning?${params.toString()}`, {
        token,
    });
}

export function getDateAnalysis(propertyId, date, token) {
    return apiRequest(`/api/reports/analyze-date`, {
        method: 'POST',
        token,
        body: JSON.stringify({ propertyId: propertyId, date: date }),
    });
}

export function getGroupRecommendations(token) {
    return apiRequest('/api/recommendations/group-candidates', {
        token,
    });
}

export function getMarketNews(token, language = 'fr', forceRefresh = false) {
    const params = new URLSearchParams({ language });
    if (forceRefresh) {
        params.append('forceRefresh', 'true');
    }
    return apiRequest(`/api/news?${params.toString()}`, {
        token,
    });
}

export function getPropertySpecificNews(propertyId, token, language = 'fr') {
    return apiRequest(`/api/properties/${propertyId}/news?language=${language}`, {
        token,
    });
}

/**
 * Récupère l'état actuel de la génération automatique des prix IA
 * @param {string} userId - ID de l'utilisateur
 * @param {string} token - Token d'authentification
 * @returns {Promise<{enabled: boolean, timezone: string, lastRun: Date|null}>}
 */
export function getAutoPricingStatus(userId, token) {
    return apiRequest(`/api/users/auto-pricing/${userId}`, {
        token,
    });
}

/**
 * Active ou désactive la génération automatique des prix IA
 * @param {string} userId - ID de l'utilisateur
 * @param {boolean} enabled - État d'activation
 * @param {string} timezone - Fuseau horaire (format IANA, ex: "Europe/Paris")
 * @param {string} token - Token d'authentification
 * @returns {Promise<{message: string, autoPricing: {enabled: boolean, timezone: string}}>}
 */
export function enableAutoPricing(userId, enabled, timezone, token) {
    return apiRequest(`/api/users/auto-pricing/${userId}`, {
        method: 'PUT',
        token,
        body: JSON.stringify({ enabled, timezone }),
    });
}

// GET /api/properties/:id/price-overrides - Récupérer les price overrides
export function getPriceOverrides(propertyId, token, startDate, endDate) {
    // Valider que propertyId est un UUID valide
    if (!propertyId || typeof propertyId !== 'string') {
        console.error('getPriceOverrides: propertyId invalide', propertyId);
        return Promise.reject(new Error('ID de propriété invalide'));
    }
    
    // Un UUID fait au moins 32 caractères (sans tirets) ou 36 avec tirets
    // Vérifier la longueur sans les tirets pour être plus flexible
    const uuidLength = propertyId.replace(/-/g, '').length;
    if (uuidLength < 32) {
        console.error('getPriceOverrides: UUID trop court', propertyId, 'Longueur:', propertyId.length, 'UUID length (sans tirets):', uuidLength);
        return Promise.reject(new Error(`ID de propriété invalide (trop court: ${uuidLength} caractères)`));
    }
    
    const params = new URLSearchParams();
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);
    
    // Encoder l'UUID pour éviter les problèmes d'URL
    const encodedPropertyId = encodeURIComponent(propertyId);
    return apiRequest(`/api/properties/${encodedPropertyId}/price-overrides?${params.toString()}`, {
        token,
    });
}

// PUT /api/properties/:id/price-overrides - Mettre à jour les price overrides en batch
export function updatePriceOverrides(propertyId, overrides, token) {
    return apiRequest(`/api/properties/${propertyId}/price-overrides`, {
        method: 'PUT',
        token,
        body: JSON.stringify({ overrides }),
    });
}

// ===== FONCTIONS STRIPE BILLING =====

/**
 * Crée une session Stripe Checkout pour l'onboarding
 * @param {string} token - Jeton d'authentification Priceye
 * @returns {Promise<{url: string, sessionId: string}>}
 */
export async function createCheckoutSession(token) {
  return apiRequest('/api/checkout/create-session', {
    method: 'POST',
    token: token,
  });
}

/**
 * Termine l'essai gratuit et facture immédiatement
 * @param {string} token - Jeton d'authentification Priceye
 * @returns {Promise<{message: string, subscriptionId: string, invoiceId: string, status: string}>}
 */
export async function endTrialAndBill(token) {
  return apiRequest('/api/subscriptions/end-trial-and-bill', {
    method: 'POST',
    token: token,
  });
}

/**
 * Crée une session Stripe Customer Portal
 * @param {string} token - Jeton d'authentification Priceye
 * @returns {Promise<{url: string}>}
 */
export async function createPortalSession(token) {
  return apiRequest('/api/billing/portal-session', {
    method: 'POST',
    token: token,
  });
}

