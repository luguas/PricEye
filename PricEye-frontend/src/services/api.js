// L'URL de base de notre serveur backend
const API_BASE_URL = 'https://priceye.onrender.com';

// Importer Firebase (client) pour l'authentification
import { initializeApp } from "firebase/app";
import { 
    getAuth, 
    EmailAuthProvider, 
    reauthenticateWithCredential, 
    updatePassword,
    signInWithEmailAndPassword 
} from "firebase/auth";

// Configuration Firebase (côté client)
const firebaseConfig = {
    apiKey: "AIzaSyCqdbT96st3gc9bQ9A4Yk7uxU-Dfuzyiuc",
    authDomain: "priceye-6f81a.firebaseapp.com",
    databaseURL: "https://priceye-6f81a-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "priceye-6f81a",
    storageBucket: "priceye-6f81a.appspot.com",
    messagingSenderId: "244431363759",
    appId: "1:244431363759:web:c2f600581f341fbca63e5a",
    measurementId: "G-QC6JW8HXBE"
};

// Initialiser l'Auth de Firebase (côté client)
let auth;
try {
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app);
} catch (error) {
    console.error("Erreur d'initialisation Firebase (client) dans api.js:", error);
    if (error.code === 'duplicate-app') {
         const existingApp = initializeApp(firebaseConfig, "default"); 
         auth = getAuth(existingApp);
    } else {
         console.error("Firebase n'a pas pu s'initialiser. L'authentification client échouera.");
    }
}


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
      window.dispatchEvent(new CustomEvent('tokenExpired'));
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
  if (!auth) {
    throw new Error("Service d'authentification Firebase non initialisé.");
  }
  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const idToken = await userCredential.user.getIdToken();
    return { idToken: idToken, message: "Connexion réussie" };
  } catch (error) {
    console.error("Erreur de connexion (SDK client):", error.code);
    if (error.code === 'auth/user-not-found' || error.code === 'auth/wrong-password' || error.code === 'auth/invalid-credential') {
        throw new Error("Email ou mot de passe invalide.");
    }
    throw new Error(error.message);
  }
}

export function register(userData) {
  return apiRequest('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(userData),
  });
}

export async function changeUserPassword(oldPassword, newPassword) {
    if (!auth || !auth.currentUser) {
        console.error("changeUserPassword: auth.currentUser est nul.");
        throw new Error("Utilisateur non connecté ou session invalide. Veuillez vous reconnecter.");
    }
    
    const user = auth.currentUser;
    const credential = EmailAuthProvider.credential(user.email, oldPassword);
    
    try {
        await reauthenticateWithCredential(user, credential);
        await updatePassword(user, newPassword);
        
    } catch (error) {
        console.error("Erreur lors du changement de mot de passe:", error.code);
        if (error.code === 'auth/wrong-password' || error.code === 'auth/invalid-credential') {
            throw new Error("L'ancien mot de passe est incorrect.");
        } else if (error.code === 'auth/weak-password') {
             throw new Error("Le nouveau mot de passe est trop faible (6 caractères min).");
        }
        throw new Error(error.message);
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

export function getMarketNews(token) {
    return apiRequest('/api/news', {
        token,
    });
}

export function getPropertySpecificNews(propertyId, token) {
    return apiRequest(`/api/properties/${propertyId}/news`, {
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
    const params = new URLSearchParams();
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);
    return apiRequest(`/api/properties/${propertyId}/price-overrides?${params.toString()}`, {
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

