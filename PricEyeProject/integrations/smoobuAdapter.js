import PMSBase from './pmsBase.js';
import axios from 'axios';

/**
 * @file integrations/smoobuAdapter.js
 * @description Implémentation concrète de l'adaptateur pour l'API Smoobu (V2).
 */

// Exporter le type pour l'auto-détection
export const type = 'smoobu';

// L'URL de base se termine par /api, comme demandé.
const SMOOBU_API_BASE = 'https://login.smoobu.com/api';

class SmoobuAdapter extends PMSBase {
  /**
   * Constructeur de l'adaptateur Smoobu.
   * @param {object} credentials - Contient le 'token' (clé API) pour Smoobu.
   */
  constructor(credentials) {
    if (!credentials || !credentials.token) {
      throw new Error("Identifiants (token) manquants pour l'initialisation de Smoobu.");
    }
    super(credentials); // Appelle setupApiClient
    console.log("Classe SmoobuAdapter V2 initialisée.");
  }

  /**
   * Configure le client API pour Smoobu.
   * @param {object} credentials 
   * @returns {object} - Le client Axios configuré.
   */
  setupApiClient(credentials) {
    const client = axios.create({
      baseURL: SMOOBU_API_BASE,
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': credentials.token // Authentification via Api-Key
      }
    });
    return client;
  }

  // --- Fonctions privées de normalisation ---

  /**
   * Normalise un objet propriété de Smoobu vers notre format interne.
   * @param {object} smoobuProp - L'objet de l'API Smoobu
   * @returns {object} - Une propriété normalisée
   */
  _normalizeProperty(smoobuProp) {
    return {
      pmsId: smoobuProp.id.toString(), // S'assurer que l'ID est une chaîne
      name: smoobuProp.name,
      capacity: smoobuProp.maxOccupancy || 2,
    };
  }

  /**
   * Normalise un objet réservation de Smoobu vers notre format interne.
   * @param {object} smoobuRes - L'objet de l'API Smoobu
   * @returns {object} - Une réservation normalisée
   */
  _normalizeReservation(smoobuRes) {
    return {
      pmsId: smoobuRes.id.toString(),
      propertyId: smoobuRes.apartmentId.toString(),
      startDate: smoobuRes.arrival, // Format YYYY-MM-DD
      endDate: smoobuRes.departure, // Format YYYY-MM-DD
      status: smoobuRes.status, // ex: 'confirmed'
      guestName: `${smoobuRes.customer?.firstName || ''} ${smoobuRes.customer?.lastName || ''}`.trim(),
      totalPrice: parseFloat(smoobuRes.price || 0),
      channel: smoobuRes.portal || 'Direct',
    };
  }

  // --- Implémentation des méthodes de l'interface ---

  /**
   * Teste la connexion à l'API Smoobu en récupérant les logements.
   * @returns {Promise<boolean>}
   */
  async testConnection() {
    try {
      console.log("Test de la connexion Smoobu (GET /apartments)...");
      // Utilisation de la route /apartments (sans /v1/)
      const response = await this.apiClient.get('/apartments');
      
      // Si l'API renvoie une donnée (même un tableau vide), la clé est bonne.
      if (response.data && Array.isArray(response.data.apartments)) {
        console.log(`Connexion Smoobu réussie.`);
        return true;
      }
      // Gère le cas où /apartments ne renvoie pas la structure attendue
      if (response.data) {
        console.warn("Connexion Smoobu réussie, mais la réponse de /apartments n'est pas celle attendue.", response.data);
        return true; // Connexion OK, mais structure de données inattendue
      }
      
      return false;
    } catch (error) {
      console.error("Erreur de connexion Smoobu:", error.response?.data || error.message);
      throw new Error(`Échec de la connexion Smoobu : ${error.response?.data?.message || error.message}`);
    }
  }

  /**
   * Récupère la liste des propriétés (logements) depuis Smoobu.
   * @returns {Promise<Array<object>>}
   */
  async getProperties() {
    try {
      console.log("Récupération des propriétés Smoobu (GET /apartments)...");
      const response = await this.apiClient.get('/apartments');
      
      if (response.data && Array.isArray(response.data.apartments)) {
        return response.data.apartments.map(this._normalizeProperty);
      }
      return [];
    } catch (error) {
      console.error("Erreur GetProperties (Smoobu):", error.response?.data || error.message);
      throw new Error(`Échec de la récupération des propriétés Smoobu : ${error.message}`);
    }
  }

  /**
   * Met à jour le tarif (prix) pour une propriété spécifique à une date donnée.
   * @param {string} propertyId - L'ID de la propriété (ID Smoobu 'apartmentId')
   * @param {string} date - La date (YYYY-MM-DD).
   * @param {number} price - Le nouveau prix.
   * @returns {Promise<object>}
   */
  async updateRate(propertyId, date, price) {
    // Appelle la méthode batch avec un seul élément
    return this.updateBatchRates(propertyId, [{ date, price }]);
  }

  /**
   * Met à jour les paramètres de base d'une propriété (prix de base, séjour min, etc.).
   * @param {string} pmsPropertyId - L'ID PMS de la propriété.
   * @param {object} settings - Un objet contenant les paramètres à mettre à jour.
   * (ex: { base_price: 150, min_stay: 2 })
   * @returns {Promise<object>} - Une confirmation de succès.
   */
  async updatePropertySettings(pmsPropertyId, settings) {
    // La route V2 POST /rates permet de mettre à jour le min_length_of_stay
    // Nous ne pouvons pas mettre à jour le prix de base (base_price) ici.
    
    if (settings.min_stay) {
      console.log(`[SYNC vers Smoobu pour ${pmsPropertyId}]: Mise à jour du séjour minimum non implémentée (nécessite une plage de dates).`);
    }
    if (settings.base_price) {
      console.log(`[SYNC vers Smoobu pour ${pmsPropertyId}]: Mise à jour du prix de base non implémentée.`);
    }

    // Pour l'instant, simulation :
    console.log(`[SYNC vers Smoobu pour ${pmsPropertyId}]:`, settings);
    return Promise.resolve({ 
      success: true, 
      mock: true, 
      message: `Simulation (V2) de la mise à jour des paramètres pour la propriété Smoobu ${pmsPropertyId}.`
    });
  }

  /**
   * (CORRIGÉ V2) Met à jour plusieurs tarifs (prix) en une seule fois.
   * @param {string} pmsPropertyId - L'ID PMS de la propriété.
   * @param {Array<object>} ratesArray - Un tableau d'objets { date: 'YYYY-MM-DD', price: 150 }
   * @returns {Promise<object>} - Une confirmation de succès.
   */
  async updateBatchRates(pmsPropertyId, ratesArray) {
    if (!ratesArray || ratesArray.length === 0) {
      return { success: true, message: 'Aucun tarif à mettre à jour.' };
    }
    
    try {
      console.log(`[Smoobu V2] Mise à jour en lot de ${ratesArray.length} tarifs pour ${pmsPropertyId}...`);
      
      // 1. Regrouper les dates par prix (ex: 150€ -> [dates...], 200€ -> [dates...])
      // (L'API V2 de Smoobu ne gère pas les "date ranges" pour des prix différents dans la *même* opération)
      // (L'exemple que vous avez donné montre des opérations séparées pour des prix différents)
      // Nous allons donc créer une opération par prix unique.

      const priceMap = new Map();
      for (const rate of ratesArray) {
          if (!priceMap.has(rate.price)) {
              priceMap.set(rate.price, []);
          }
          priceMap.get(rate.price).push(rate.date);
      }

      // 2. Créer le payload "operations"
      const operations = [];
      priceMap.forEach((dates, price) => {
          operations.push({
              dates: dates, // Envoi des dates individuelles
              daily_price: price
              // On pourrait aussi ajouter 'min_length_of_stay' ici si on le gérait
          });
      });

      // 3. Créer le payload final
      const payload = {
        apartments: [parseInt(pmsPropertyId, 10)], // S'assurer que c'est un nombre
        operations: operations
      };

      // 4. Appeler la route POST /rates
      const response = await this.apiClient.post(`/rates`, payload);
      
      return { success: true, data: response.data };
    } catch (error) {
      console.error("Erreur UpdateBatchRates (Smoobu V2):", error.response?.data || error.message);
      throw new Error(`Échec de la mise à jour des tarifs en lot pour Smoobu V2 : ${error.message}`);
    }
  }

  /**
   * Récupère les réservations pour une plage de dates donnée.
   * @param {string} startDate - Date de début (YYYY-MM-DD).
   * @param {string} endDate - Date de fin (YYYY-MM-DD).
   * @returns {Promise<Array<object>>}
   */
  async getReservations(startDate, endDate) {
    try {
      console.log(`Récupération des réservations Smoobu du ${startDate} au ${endDate}...`);
      
      // Utilisation de la route /reservations (sans /v1/)
      const response = await this.apiClient.get(`/reservations?from=${startDate}&to=${endDate}`);
      
      if (response.data && Array.isArray(response.data.bookings)) {
         return response.data.bookings.map(this._normalizeReservation);
      }
      return [];
    } catch (error) {
      console.error("Erreur GetReservations (Smoobu):", error.response?.data || error.message);
      throw new Error(`Échec de la récupération des réservations Smoobu : ${error.message}`);
    }
  }

  /**
   * Crée une nouvelle réservation dans Smoobu.
   * @param {string} pmsPropertyId - L'ID PMS de la propriété.
   * @param {object} reservationData - Les données de la réservation { startDate, endDate, guestName, totalPrice, numberOfGuests, channel }
   * @returns {Promise<object>} - La réservation créée avec son pmsId
   */
  async createReservation(pmsPropertyId, reservationData) {
    try {
      console.log(`[Smoobu] Création d'une réservation pour la propriété ${pmsPropertyId}...`);
      
      // Préparer le payload selon l'API Smoobu
      // Note: L'API Smoobu attend probablement un format spécifique
      const payload = {
        apartmentId: parseInt(pmsPropertyId, 10),
        arrival: reservationData.startDate, // Format YYYY-MM-DD
        departure: reservationData.endDate, // Format YYYY-MM-DD
        price: reservationData.totalPrice || 0,
        ...(reservationData.guestName && {
          customer: {
            firstName: reservationData.guestName.split(' ')[0] || '',
            lastName: reservationData.guestName.split(' ').slice(1).join(' ') || ''
          }
        }),
        ...(reservationData.numberOfGuests && { numberOfGuests: reservationData.numberOfGuests }),
        ...(reservationData.channel && { portal: reservationData.channel }),
        status: reservationData.status || 'confirmed'
      };

      const response = await this.apiClient.post('/reservations', payload);
      
      // Retourner la réservation normalisée
      if (response.data && response.data.booking) {
        return this._normalizeReservation(response.data.booking);
      }
      throw new Error('Réponse de l\'API Smoobu invalide lors de la création de réservation.');
    } catch (error) {
      console.error("Erreur CreateReservation (Smoobu):", error.response?.data || error.message);
      throw new Error(`Échec de la création de la réservation Smoobu : ${error.message}`);
    }
  }

  /**
   * Met à jour une réservation existante dans Smoobu.
   * @param {string} pmsReservationId - L'ID PMS de la réservation.
   * @param {object} reservationData - Les données à mettre à jour { startDate, endDate, guestName, totalPrice, numberOfGuests, channel, status }
   * @returns {Promise<object>} - La réservation mise à jour
   */
  async updateReservation(pmsReservationId, reservationData) {
    try {
      console.log(`[Smoobu] Mise à jour de la réservation ${pmsReservationId}...`);
      
      const payload = {};
      if (reservationData.startDate) payload.arrival = reservationData.startDate;
      if (reservationData.endDate) payload.departure = reservationData.endDate;
      if (reservationData.totalPrice != null) payload.price = reservationData.totalPrice;
      if (reservationData.guestName) {
        payload.customer = {
          firstName: reservationData.guestName.split(' ')[0] || '',
          lastName: reservationData.guestName.split(' ').slice(1).join(' ') || ''
        };
      }
      if (reservationData.numberOfGuests != null) payload.numberOfGuests = reservationData.numberOfGuests;
      if (reservationData.channel) payload.portal = reservationData.channel;
      if (reservationData.status) payload.status = reservationData.status;

      const response = await this.apiClient.put(`/reservations/${pmsReservationId}`, payload);
      
      if (response.data && response.data.booking) {
        return this._normalizeReservation(response.data.booking);
      }
      throw new Error('Réponse de l\'API Smoobu invalide lors de la mise à jour de réservation.');
    } catch (error) {
      console.error("Erreur UpdateReservation (Smoobu):", error.response?.data || error.message);
      throw new Error(`Échec de la mise à jour de la réservation Smoobu : ${error.message}`);
    }
  }

  /**
   * Supprime une réservation dans Smoobu.
   * @param {string} pmsReservationId - L'ID PMS de la réservation.
   * @returns {Promise<object>} - Confirmation de suppression
   */
  async deleteReservation(pmsReservationId) {
    try {
      console.log(`[Smoobu] Suppression de la réservation ${pmsReservationId}...`);
      
      await this.apiClient.delete(`/reservations/${pmsReservationId}`);
      
      return { success: true, message: 'Réservation supprimée avec succès.' };
    } catch (error) {
      console.error("Erreur DeleteReservation (Smoobu):", error.response?.data || error.message);
      throw new Error(`Échec de la suppression de la réservation Smoobu : ${error.message}`);
    }
  }
}

export default SmoobuAdapter;

