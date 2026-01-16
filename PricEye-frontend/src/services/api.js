// L'URL de base de notre serveur backend
const API_BASE_URL = 'https://priceye.onrender.com';

// Importer Supabase (client) pour l'authentification
import { supabase } from '../config/supabase.js';

// Variable locale pour stocker le token en mémoire (évite les accès lents au localStorage)
let globalAuthToken = localStorage.getItem('authToken');

/**
 * Met à jour le token utilisé par le service API.
 * Cette fonction est appelée par AuthContext lors du login/logout.
 */
export const setApiToken = (token) => {
  globalAuthToken = token;
};

/**
 * Fonction générique pour gérer les requêtes fetch vers NOTRE backend.
 * Version améliorée : Gestion robuste des erreurs 429 et 401.
 */
async function apiRequest(endpoint, options = {}) {
  // Récupération du token (supporte l'injection manuelle ou via variable globale si implémentée précédemment)
  const token = options.token || (typeof globalAuthToken !== 'undefined' ? globalAuthToken : null);
  
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

  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, finalOptions);
    const contentType = response.headers.get('content-type');

    // ---------------------------------------------------------
    // GESTION DES ERREURS (Si response.ok est false)
    // ---------------------------------------------------------
    if (!response.ok) {
      let errorData = { error: `Erreur ${response.status} sur l'endpoint ${endpoint}` };

      // Tentative de parsing de l'erreur (JSON ou Texte)
      if (contentType && contentType.includes('application/json')) {
        try {
          errorData = await response.json();
        } catch (e) { /* Echec silencieux parsing JSON */ }
      } else {
        const textError = await response.text();
        if (textError) errorData.error = textError;
      }

      // --- 1. Détection Typée des Erreurs ---
      
      // Est-ce un problème de Quota ? (429 standard OU ancien 403 avec message spécifique)
      const isQuotaExceeded = 
        response.status === 429 || 
        (response.status === 403 && (
          errorData.error === 'LIMIT_EXCEEDED' || 
          errorData.message?.includes('limite') ||
          errorData.message?.includes('LIMIT_EXCEEDED') ||
          errorData.error === 'Quota IA atteint'
        ));

      // Est-ce une expiration de session ? (401 Strict uniquement)
      const isAuthError = response.status === 401;

      // --- 2. Actions Spécifiques ---

      // Déconnexion automatique UNIQUEMENT sur 401 (Jeton invalide/expiré)
      if (isAuthError) {
        console.warn(`Session expirée (401) sur ${endpoint}. Déconnexion déclenchée.`);
        localStorage.removeItem('authToken');
        // Dispatch event pour que l'UI réagisse (App.jsx ou AuthContext)
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('tokenExpired'));
        }
      }

      console.error(`Erreur API (${response.status}):`, errorData.error || errorData.message);

      // --- 3. Construction de l'objet Error pour le catch() appelant ---
      
      const errorMessage = errorData.error || errorData.message || `Erreur HTTP ${response.status}`;
      const error = new Error(errorMessage);
      
      // Enrichissement de l'erreur pour un traitement facile côté UI
      error.status = response.status;           // Code HTTP (ex: 429, 403)
      error.errorData = errorData;              // Payload complet du backend (compatibilité)
      error.isQuotaExceeded = isQuotaExceeded;  // Flag facile à vérifier
      error.isAuthError = isAuthError;          // Flag facile à vérifier

      // Si c'est une erreur de quota, on attache les infos utiles si disponibles
      if (isQuotaExceeded && errorData.resetAt) {
          error.quotaInfo = {
            limit: errorData.limit,
            used: errorData.used,
            remaining: errorData.remaining,
            resetAt: errorData.resetAt
          };
      }

      throw error;
    }

    // ---------------------------------------------------------
    // TRAITEMENT DU SUCCÈS (Si response.ok est true)
    // ---------------------------------------------------------

    // Cas 204 No Content ou Body vide
    if (response.status === 204 || (response.status === 200 && (!contentType?.includes('application/json') || response.headers.get('content-length') === '0'))) {
      return { message: 'Opération réussie.' };
    }

    // Cas Texte brut
    if (contentType && (contentType.includes('text/html') || contentType.includes('text/plain'))) {
      const text = await response.text();
      return { message: text };
    }

    // Cas JSON standard
    try {
      const data = await response.json();
      return data;
    } catch (e) {
      console.error("Erreur de parsing JSON pour une réponse OK:", e);
      throw new Error("Réponse du serveur reçue mais invalide (pas un JSON).");
    }

  } catch (error) {
    // Si c'est déjà notre erreur formatée, on la relance
    if (error.status || error.isQuotaExceeded) {
      throw error;
    }
    // Sinon c'est une erreur réseau (fetch failed) ou de code
    console.error("Erreur Réseau/Système:", error);
    throw new Error(error.message || "Erreur de communication avec le serveur.");
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

/**
 * Supprime le compte utilisateur
 * @param {string} userId - ID de l'utilisateur à supprimer
 * @param {string} token - Jeton d'authentification
 * @returns {Promise<{message: string}>}
 */
export function deleteUserAccount(userId, token) {
  return apiRequest(`/api/users/${userId}`, {
    method: 'DELETE',
    token,
  });
}

/**
 * Récupère le quota IA de l'utilisateur
 * @param {string} token - Jeton d'authentification Priceye
 * @returns {Promise<{callsToday: number, maxCalls: number, remaining: number, tokensUsed: number, maxTokens: number, resetAt: string, subscriptionStatus: string}>}
 * @throws {Error} Si le quota est atteint (429) ou en cas d'autre erreur
 */
export async function getAIQuota(token) {
  try {
    const quotaData = await apiRequest('/api/users/ai-quota', {
      token,
    });
    return quotaData;
  } catch (error) {
    // Gérer spécifiquement l'erreur 429 (quota atteint)
    // Vérifier soit le message d'erreur, soit les données d'erreur
    const isQuotaExceeded = error.errorData && (
      error.errorData.error === 'Quota IA atteint' ||
      error.errorData.message?.includes('limite quotidienne') ||
      error.message?.includes('429') ||
      error.message?.includes('Quota IA atteint')
    );
    
    if (isQuotaExceeded) {
      // Attacher les informations du quota à l'erreur pour que le frontend puisse les afficher
      error.quotaInfo = {
        limit: error.errorData?.limit || 0,
        used: error.errorData?.used || 0,
        remaining: error.errorData?.remaining || 0,
        resetAt: error.errorData?.resetAt,
        resetAtHuman: error.errorData?.resetAtHuman || 'demain à minuit UTC'
      };
      // Marquer l'erreur comme étant une erreur de quota
      error.isQuotaExceeded = true;
      throw error;
    }
    // Propager les autres erreurs telles quelles
    throw error;
  }
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

export function getMarketKpis(token, startDate, endDate, city = null, country = null) {
    const params = new URLSearchParams({ startDate, endDate });
    if (city) params.append('city', city);
    if (country) params.append('country', country);
    return apiRequest(`/api/reports/market-kpis?${params.toString()}`, {
        token,
    });
}

export function getForecastRevenue(token, startDate, endDate, forecastPeriod = 4) {
    const params = new URLSearchParams({ startDate, endDate });
    if (forecastPeriod) params.append('forecastPeriod', forecastPeriod);
    return apiRequest(`/api/reports/forecast-revenue?${params.toString()}`, {
        token,
    });
}

export function getForecastScenarios(token, startDate, endDate, forecastPeriod = 4) {
    const params = new URLSearchParams({ startDate, endDate });
    if (forecastPeriod) params.append('forecastPeriod', forecastPeriod);
    return apiRequest(`/api/reports/forecast-scenarios?${params.toString()}`, {
        token,
    });
}

export function getForecastRadar(token, startDate, endDate, propertyId = null) {
    const params = new URLSearchParams({ startDate, endDate });
    if (propertyId) params.append('propertyId', propertyId);
    return apiRequest(`/api/reports/forecast-radar?${params.toString()}`, {
        token,
    });
}

export function getRevenueVsTarget(token, startDate, endDate) {
    const params = new URLSearchParams({ startDate, endDate });
    return apiRequest(`/api/reports/revenue-vs-target?${params.toString()}`, {
        token,
    });
}

export function getGrossMargin(token, startDate, endDate) {
    const params = new URLSearchParams({ startDate, endDate });
    return apiRequest(`/api/reports/gross-margin?${params.toString()}`, {
        token,
    });
}

export function getAdrByChannel(token, startDate, endDate) {
    const params = new URLSearchParams({ startDate, endDate });
    return apiRequest(`/api/reports/adr-by-channel?${params.toString()}`, {
        token,
    });
}

export function updateRevenueTargets(token, revenueTargets) {
    return apiRequest('/api/users/revenue-targets', {
        method: 'PUT',
        token,
        body: JSON.stringify({ revenueTargets }),
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
 * Vérifie le statut d'une session Stripe Checkout et met à jour le profil si nécessaire
 * @param {string} sessionId - ID de la session Stripe Checkout
 * @param {string} token - Jeton d'authentification Priceye
 * @returns {Promise<{success: boolean, subscriptionStatus?: string, profile?: object}>}
 */
export async function verifyCheckoutSession(sessionId, token) {
  return apiRequest(`/api/checkout/verify-session?session_id=${encodeURIComponent(sessionId)}`, {
    method: 'GET',
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

/**
 * Applique une stratégie de pricing à une propriété (avec support des groupes)
 * @param {string} propertyId - ID de la propriété principale
 * @param {object|null} groupContext - Contexte du groupe si c'est une synchronisation de groupe
 * @param {string} token - Jeton d'authentification
 * @returns {Promise<{strategy_summary: string, daily_prices: Array, method: string, days_generated: number, synced_properties?: number}>}
 */
export const applyPricingStrategy = async (propertyId, groupContext = null, token) => {
  // Utiliser API_BASE_URL défini en haut du fichier
  const authToken = token || globalAuthToken || localStorage.getItem('authToken');

  const response = await fetch(`${API_BASE_URL}/api/properties/${propertyId}/pricing-strategy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
    },
    body: JSON.stringify({
      useMarketData: true,
      group_context: groupContext // On passe les infos du groupe si c'est une synchro
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    const error = new Error(data.error || data.message || 'Erreur lors de la génération de la stratégie');
    // On marque l'erreur si c'est un problème de quota pour l'interface
    if (response.status === 402 || data.code === 'QUOTA_EXCEEDED') {
        error.isQuotaExceeded = true;
    }
    throw error;
  }

  return data;
};
