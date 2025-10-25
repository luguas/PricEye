// L'URL de base de notre serveur backend
const API_BASE_URL = 'http://localhost:5000';

/**
 * Fonction générique pour gérer les requêtes fetch.
 * @param {string} endpoint - Le chemin de l'API (ex: '/api/auth/login').
 * @param {object} options - Les options de la requête fetch (method, headers, body).
 * @returns {Promise<object>} Les données JSON de la réponse ou un objet de succès.
 */
async function apiRequest(endpoint, options = {}) {
  // Ajouter le token d'authentification s'il est fourni dans les options
  const token = options.token;
  const headers = {
    // Par défaut 'Content-Type': 'application/json' sauf si spécifié autrement
    'Content-Type': options.headers?.['Content-Type'] ?? 'application/json', 
    ...options.headers, // Garder les headers existants
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  
  const finalOptions = {
      ...options,
      headers,
  };
  // Supprimer la clé 'token' des options avant l'appel fetch
  delete finalOptions.token;


  const response = await fetch(`${API_BASE_URL}${endpoint}`, finalOptions);
  
  // Vérifier si la réponse a un corps avant d'essayer de la parser en JSON
  const contentType = response.headers.get('content-type');

  if (!response.ok) {
    // Essayer de lire l'erreur JSON si possible, sinon utiliser le statut
    let errorData = { error: `Erreur ${response.status} sur l'endpoint ${endpoint}`};
    if (contentType && contentType.includes('application/json')) {
      try {
        errorData = await response.json();
      } catch (e) { /* Ignorer l'erreur de parsing si le JSON est invalide */ }
    } else {
        // Essayer de lire comme texte si ce n'est pas du JSON
        const textError = await response.text();
        if (textError) {
             errorData.error = textError;
        }
    }
    console.error(`Erreur API (${response.status}):`, errorData.error); // Log détaillé
    throw new Error(errorData.error);
  }

  // --- CORRECTION DE LA LOGIQUE ---
  
  // 1. Si la réponse est OK et de type JSON (cas le plus courant)
  if (contentType && contentType.includes('application/json')) {
       try {
          const data = await response.json();
          return data;
      } catch (e) {
           console.error("Erreur de parsing JSON pour une réponse OK:", e);
           throw new Error("Réponse du serveur reçue mais invalide (pas un JSON).");
      }
  }
  
  // 2. Si la réponse est OK et de type HTML (ANCIENNE LOGIQUE - n'est plus utilisée)
   if (contentType && contentType.includes('text/html')) {
       const text = await response.text();
       return { message: text }; // Renvoyé comme objet pour la cohérence
   }

  // 3. Si la réponse est OK mais n'a pas de contenu (ex: 204 No Content, ou un DELETE)
  // C'est le fallback pour les requêtes de succès sans corps de réponse.
  return { message: 'Opération réussie.' };
}


/**
 * Fonction pour se connecter à l'API.
 * @param {string} email 
 * @param {string} password 
 * @returns {Promise<object>} Les données de la réponse (contenant idToken).
 */
export function login(email, password) {
  return apiRequest('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

/**
 * Fonction pour inscrire un nouvel utilisateur.
 * @param {object} userData - Contient name, email, password
 * @returns {Promise<object>} Les données de la réponse de succès.
 */
export function register(userData) {
  return apiRequest('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(userData),
  });
}

/**
 * Fonction pour récupérer le profil de l'utilisateur connecté.
 * @param {string} token - Le jeton d'authentification.
 * @returns {Promise<object>} Les données du profil utilisateur.
 */
export function getUserProfile(token) {
  return apiRequest('/api/users/profile', { token });
}

/**
 * Fonction pour mettre à jour le profil de l'utilisateur connecté.
 * @param {object} profileData - Les données à mettre à jour.
 * @param {string} token - Le jeton d'authentification.
 * @returns {Promise<object>} La réponse de l'API.
 */
export function updateUserProfile(profileData, token) {
  return apiRequest('/api/users/profile', {
    method: 'PUT',
    token,
    body: JSON.stringify(profileData),
  });
}


/**
 * Fonction pour récupérer les propriétés de l'utilisateur connecté.
 * @param {string} token - Le jeton d'authentification de l'utilisateur.
 * @returns {Promise<Array>} Un tableau des propriétés de l'utilisateur.
 */
export function getProperties(token) {
  return apiRequest('/api/properties', { token }); // Passer le token ici
}

/**
 * Fonction pour ajouter une nouvelle propriété.
 * @param {object} propertyData - Les données de la nouvelle propriété.
 * @param {string} token - Le jeton d'authentification de l'utilisateur.
 * @returns {Promise<object>} La réponse de l'API.
 */
export function addProperty(propertyData, token) {
  return apiRequest('/api/properties', {
    method: 'POST',
    token,
    body: JSON.stringify(propertyData),
  });
}

/**
 * Fonction pour mettre à jour une propriété existante.
 * @param {string} id - L'ID de la propriété à mettre à jour.
 * @param {object} propertyData - Les nouvelles données de la propriété.
 * @param {string} token - Le jeton d'authentification.
 * @returns {Promise<object>} La réponse de l'API.
 */
export function updateProperty(id, propertyData, token) {
  return apiRequest(`/api/properties/${id}`, {
    method: 'PUT',
    token,
    body: JSON.stringify(propertyData),
  });
}

/**
 * Fonction pour supprimer une propriété.
 * @param {string} id - L'ID de la propriété à supprimer.
 * @param {string} token - Le jeton d'authentification.
 * @returns {Promise<object>} La réponse de l'API.
 */
export function deleteProperty(id, token) {
  return apiRequest(`/api/properties/${id}`, {
    method: 'DELETE',
    token,
  });
}

/**
 * Fonction pour sauvegarder la stratégie de prix d'une propriété.
 * @param {string} propertyId - L'ID de la propriété.
 * @param {object} strategyData - Les données de la stratégie.
 * @param {string} token - Le jeton d'authentification.
 * @returns {Promise<object>} La réponse de l'API.
 */
export function updatePropertyStrategy(propertyId, strategyData, token) {
  return apiRequest(`/api/properties/${propertyId}/strategy`, {
    method: 'PUT',
    token,
    body: JSON.stringify(strategyData),
  });
}

/**
 * Fonction pour sauvegarder les règles personnalisées d'une propriété.
 * @param {string} propertyId - L'ID de la propriété.
 * @param {object} rulesData - Les données des règles.
 * @param {string} token - Le jeton d'authentification.
 * @returns {Promise<object>} La réponse de l'API.
 */
export function updatePropertyRules(propertyId, rulesData, token) {
    return apiRequest(`/api/properties/${propertyId}/rules`, {
        method: 'PUT',
        token,
        body: JSON.stringify(rulesData),
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

/**
 * Fonction pour mettre à jour un groupe existant.
 * @param {string} groupId - L'ID du groupe à modifier.
 * @param {object} groupData - Les nouvelles données du groupe (ex: { name: 'Nouveau Nom', syncPrices: true, mainPropertyId: '...' }).
 * @param {string} token - Le jeton d'authentification.
 * @returns {Promise<object>} La réponse de l'API.
 */
export function updateGroup(groupId, groupData, token) {
    return apiRequest(`/api/groups/${groupId}`, {
        method: 'PUT',
        token,
        body: JSON.stringify(groupData), // Envoie l'objet groupData complet
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

/**
 * Fonction pour générer la stratégie de prix via l'IA.
 * @param {string} propertyId - L'ID de la propriété.
 * @param {string} token - Le jeton d'authentification.
 * @returns {Promise<object>} La stratégie générée par l'IA.
 */
export function generatePricingStrategy(propertyId, token) {
  return apiRequest(`/api/properties/${propertyId}/pricing-strategy`, {
    method: 'POST',
    token,
  });
}

/**
 * Fonction pour ajouter une réservation à une propriété.
 * @param {string} propertyId - L'ID de la propriété.
 * @param {object} bookingData - Les données de la réservation { startDate, endDate, pricePerNight, channel, etc. }.
 * @param {string} token - Le jeton d'authentification.
 * @returns {Promise<object>} La réponse de l'API.
 */
export function addBooking(propertyId, bookingData, token) {
  return apiRequest(`/api/properties/${propertyId}/bookings`, {
    method: 'POST',
    token,
    body: JSON.stringify(bookingData),
  });
}

/**
 * Fonction pour récupérer les réservations d'un mois donné pour une propriété.
 * @param {string} propertyId - L'ID de la propriété.
 * @param {number} year - L'année.
 * @param {number} month - Le mois (0-11).
 * @param {string} token - Le jeton d'authentification.
 * @returns {Promise<Array>} Un tableau des réservations pour ce mois.
 */
export function getBookingsForMonth(propertyId, year, month, token) {
  const monthApi = month + 1; 
  return apiRequest(`/api/properties/${propertyId}/bookings?year=${year}&month=${monthApi}`, {
    token,
  });
}


/**
 * Fonctions pour la gestion d'équipe
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
 * Fonctions pour les Rapports
 */
export function getReportKpis(token, startDate, endDate) {
    const params = new URLSearchParams({ startDate, endDate });
    return apiRequest(`/api/reports/kpis?${params.toString()}`, {
        token,
    });
}

/**
 * Récupère les actualités du marché via le backend.
 * @param {string} token - Le jeton d'authentification.
 * @returns {Promise<Array>} Un tableau d'objets d'actualité.
 */
export function getMarketNews(token) {
    return apiRequest('/api/news', {
        token,
    });
}

