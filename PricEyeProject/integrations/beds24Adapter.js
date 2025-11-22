import PMSBase from './pmsBase.js';

// Exporter le type pour l'auto-détection
export const type = 'beds24';

/**
 * @file integrations/beds24Adapter.js
 * @description Implémentation concrète de l'adaptateur pour l'API JSON-RPC de Beds24.
 */

const BEDS24_API_URL = 'https://api.beds24.com/json';

class Beds24Adapter extends PMSBase {
  /**
   * Constructeur de l'adaptateur Beds24.
   * @param {object} credentials - Contient 'apiKey' et 'propKey'.
   */
  constructor(credentials) {
    if (!credentials || !credentials.apiKey || !credentials.propKey) {
      throw new Error("Identifiants (apiKey, propKey) manquants pour l'initialisation de Beds24.");
    }
    super(credentials); // Ne configure pas apiClient, géré par _makeRequest
    console.log("Classe Beds24Adapter initialisée.");
  }

  /**
   * Beds24 n'utilise pas de client stateful, donc cette méthode est vide.
   * L'authentification est envoyée dans chaque payload.
   */
  setupApiClient(credentials) {
    // Pas de client persistant pour l'API JSON-RPC de Beds24
    // Les 'credentials' sont stockés dans 'this.credentials' par le parent
    return null; 
  }

  /**
   * Fonction helper pour effectuer les requêtes JSON-RPC à Beds24.
   * @param {string} method - Le nom de la méthode API (ex: "getProperties")
   * @param {object} params - Les paramètres spécifiques à cette méthode
   * @returns {Promise<object>} - Le résultat de l'API
   */
  async _makeRequest(method, params = {}) {
    const payload = {
      auth: {
        apiKey: this.credentials.apiKey,
        propKey: this.credentials.propKey
      },
      method: method,
      ...params
    };

    try {
      const response = await fetch(BEDS24_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (data.error) {
        throw new Error(data.error.message || 'Erreur inconnue de Beds24');
      }
      if (!response.ok) {
           throw new Error(`Erreur réseau: ${response.statusText}`);
      }

      return data.result || data; // L'API V3 renvoie 'result', l'ancienne renvoie directement

    } catch (error) {
      console.error(`Erreur Beds24 (${method}):`, error.message);
      throw new Error(`Échec de l'appel Beds24 (${method}) : ${error.message}`);
    }
  }

  // --- Fonctions privées de normalisation ---

  /**
   * Normalise un objet propriété de Beds24.
   * @param {object} beds24Prop - L'objet de l'API Beds24 (issu de getProperties)
   * @returns {object} - Une propriété normalisée
   */
  _normalizeProperty(beds24Prop) {
    return {
      pmsId: beds24Prop.propId.toString(),
      name: beds24Prop.name || 'Propriété sans nom',
      capacity: beds24Prop.maxPeople || 2,
    };
  }

  /**
   * Normalise un objet réservation de Beds24.
   * @param {object} beds24Res - L'objet de l'API Beds24 (issu de getBookings)
   * @returns {object} - Une réservation normalisée
   */
  _normalizeReservation(beds24Res) {
    return {
      pmsId: beds24Res.bookId.toString(),
      propertyId: beds24Res.propId.toString(),
      startDate: beds24Res.firstNight, // Format YYYY-MM-DD
      endDate: beds24Res.lastNight, // NOTE: Beds24 renvoie la *dernière nuit*. Il faut ajouter 1 jour.
      status: beds24Res.status, // ex: 'confirmed'
      guestName: `${beds24Res.guestFirstName || ''} ${beds24Res.guestLastName || ''}`.trim(),
      totalPrice: parseFloat(beds24Res.price || 0),
      channel: beds24Res.apiSource || 'Direct',
    };
  }


  // --- Implémentation des méthodes de l'interface ---

  /**
   * Teste la connexion en appelant getProperties.
   * @returns {Promise<boolean>}
   */
  async testConnection() {
    try {
      console.log("Test de la connexion Beds24 (appel getProperties)...");
      const response = await this._makeRequest('getProperties');
      if (Array.isArray(response)) {
        console.log("Connexion Beds24 réussie.");
        return true;
      }
      return false;
    } catch (error) {
       console.error("Erreur de connexion Beds24:", error.message);
       throw new Error(`Échec de la connexion Beds24 : ${error.message}`);
    }
  }

  /**
   * Récupère la liste des propriétés depuis Beds24.
   * @returns {Promise<Array<object>>}
   */
  async getProperties() {
    try {
      console.log("Récupération des propriétés Beds24...");
      const response = await this._makeRequest('getProperties');
      if (Array.isArray(response)) {
        return response.map(this._normalizeProperty);
      }
      return [];
    } catch (error) {
       throw new Error(`Échec de la récupération des propriétés Beds24 : ${error.message}`);
    }
  }

  /**
   * Met à jour le tarif pour une propriété à une date donnée.
   * @param {string} propertyId - L'ID de la propriété (ID Beds24 'propId')
   * @param {string} date - La date (YYYY-MM-DD).
   * @param {number} price - Le nouveau prix.
   * @returns {Promise<object>}
   */
  async updateRate(propertyId, date, price) {
    try {
      console.log(`Mise à jour du tarif Beds24 pour ${propertyId} le ${date} à ${price}€...`);
      
      const payload = {
        propId: propertyId,
        dateFrom: date,
        dateTo: date,
        minStay: 1, // Le setRates nécessite un minStay
        price: price
      };

      const response = await this._makeRequest('setRates', payload);
      
      return { success: true, data: response };
    } catch (error) {
      throw new Error(`Échec de la mise à jour du tarif Beds24 : ${error.message}`);
    }
  }

  /**
   * Met à jour les paramètres de base d'une propriété (prix de base, séjour min, etc.).
   * @param {string} pmsPropertyId - L'ID PMS de la propriété.
   * @param {object} settings - Un objet contenant les paramètres à mettre à jour.
   * @returns {Promise<object>} - Une confirmation de succès.
   */
  async updatePropertySettings(pmsPropertyId, settings) {
    // TODO: Implémenter la logique d'appel API réelle pour Beds24
    // Il faudrait mapper 'base_price' -> 'price' dans setRates pour une longue plage
    // et 'min_stay' -> 'minStay', etc.
    
    // Pour l'instant, simulation :
    console.log(`[SYNC vers Beds24 pour ${pmsPropertyId}]:`, settings);
    
    // Simuler une réponse API
    return Promise.resolve({ 
      success: true, 
      mock: true, 
      message: `Simulation de la mise à jour des paramètres pour la propriété Beds24 ${pmsPropertyId}.`
    });
  }

  /**
   * (NOUVEAU) Met à jour plusieurs tarifs (prix) en une seule fois.
   * @param {string} pmsPropertyId - L'ID PMS de la propriété.
   * @param {Array<object>} ratesArray - Un tableau d'objets { date: 'YYYY-MM-DD', price: 150 }
   * @returns {Promise<object>} - Une confirmation de succès.
   */
  async updateBatchRates(pmsPropertyId, ratesArray) {
    if (!ratesArray || ratesArray.length === 0) {
      return { success: true, message: 'Aucun tarif à mettre à jour.' };
    }
    
    console.log(`[Beds24] Début de la mise à jour de ${ratesArray.length} tarifs (un par un) pour ${pmsPropertyId}...`);
    let successCount = 0;
    let errors = [];

    // L'API Beds24 (setRates) ne gère qu'un prix à la fois (ou une plage au même prix).
    // Nous devons boucler et appeler updateRate pour chaque jour.
    for (const rate of ratesArray) {
        try {
            // Appelle la méthode updateRate déjà existante
            await this.updateRate(pmsPropertyId, rate.date, rate.price);
            successCount++;
        } catch (error) {
            console.error(`Erreur Beds24 (batch) setRates pour ${rate.date}: ${error.message}`);
            errors.push({ date: rate.date, error: error.message });
            // On continue même en cas d'erreur
        }
    }

    if (errors.length > 0) {
        throw new Error(`${errors.length} sur ${ratesArray.length} mises à jour de tarif ont échoué pour Beds24.`);
    }
    
    return { success: true, message: `${successCount} tarifs mis à jour avec succès.` };
  }


  /**
   * Récupère les réservations pour une plage de dates donnée.
   * @param {string} startDate - Date de début (YYYY-MM-DD).
   * @param {string} endDate - Date de fin (YYYY-MM-DD).
   * @returns {Promise<Array<object>>} - Liste des réservations normalisées.
   */
  async createReservation(pmsPropertyId, reservationData) {
    throw new Error("La création de réservations n'est pas encore implémentée pour Beds24.");
  }

  async updateReservation(pmsReservationId, reservationData) {
    throw new Error("La mise à jour de réservations n'est pas encore implémentée pour Beds24.");
  }

  async deleteReservation(pmsReservationId) {
    throw new Error("La suppression de réservations n'est pas encore implémentée pour Beds24.");
  }

  /**
   * Récupère les réservations pour une plage de dates donnée.
   * @param {string} startDate - Date de début (YYYY-MM-DD).
   * @param {string} endDate - Date de fin (YYYY-MM-DD).
   * @returns {Promise<Array<object>>} - Liste des réservations normalisées.
   */
  async getReservations(startDate, endDate) {
    console.log(`Récupération des réservations Beds24 du ${startDate} au ${endDate}...`);
    
    const payload = {
      arrivalFrom: startDate,
      arrivalTo: endDate,
    };
    
    // 3. Envoyer la requête
    const response = await this._makeRequest('getBookings', payload);
    
    // 4. Normaliser
    if (Array.isArray(response)) {
      return response.map(this._normalizeReservation);
    }
    return [];
  }
}

export default Beds24Adapter;

