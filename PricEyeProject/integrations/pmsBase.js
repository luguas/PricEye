/**
 * @file integrations/pmsBase.js
 * @description Classe de base abstraite pour les adaptateurs PMS.
 * Définit l'interface requise pour toute intégration PMS.
 */
class PMSBase {
  /**
   * @param {object} credentials - Les identifiants (clé API, etc.)
   */
  constructor(credentials) {
    if (this.constructor === PMSBase) {
      throw new Error("La classe abstraite 'PMSBase' ne peut pas être instanciée directement.");
    }
    this.credentials = credentials;
    this.apiClient = this.setupApiClient(credentials);
  }

  /**
   * Configure le client API (ex: Axios) avec les identifiants.
   * @param {object} credentials 
   * @returns {object} - Le client API configuré.
   */
  setupApiClient(credentials) {
    throw new Error("La méthode 'setupApiClient()' doit être implémentée par la classe enfant.");
  }

  /**
   * Teste la validité des identifiants et la connexion à l'API.
   * @returns {Promise<boolean>}
   */
  async testConnection() {
    throw new Error("La méthode 'testConnection()' doit être implémentée par la classe enfant.");
  }

  /**
   * Récupère la liste des propriétés (logements) depuis le PMS.
   * @returns {Promise<Array<object>>} - Une liste de propriétés normalisées.
   */
  async getProperties() {
    throw new Error("La méthode 'getProperties()' doit être implémentée par la classe enfant.");
  }

  /**
   * Met à jour le tarif (prix) pour une propriété à une date donnée.
   * @param {string} propertyId - L'ID PMS de la propriété.
   * @param {string} date - La date (YYYY-MM-DD).
   * @param {number} price - Le nouveau prix.
   * @returns {Promise<object>} - Une confirmation de succès.
   */
  async updateRate(propertyId, date, price) {
    throw new Error("La méthode 'updateRate()' doit être implémentée par la classe enfant.");
  }
  
  /**
   * Met à jour les paramètres de base d'une propriété (prix de base, séjour min, etc.).
   * @param {string} pmsPropertyId - L'ID PMS de la propriété.
   * @param {object} settings - Un objet contenant les paramètres à mettre à jour.
   * (ex: { basePrice: 150, minStay: 2, weeklyDiscount: 10 })
   * @returns {Promise<object>} - Une confirmation de succès.
   */
  async updatePropertySettings(pmsPropertyId, settings) {
    throw new Error("La méthode 'updatePropertySettings()' doit être implémentée par la classe enfant.");
  }

  /**
   * (NOUVEAU) Met à jour plusieurs tarifs (prix) en une seule fois.
   * @param {string} pmsPropertyId - L'ID PMS de la propriété.
   * @param {Array<object>} ratesArray - Un tableau d'objets { date: 'YYYY-MM-DD', price: 150 }
   * @returns {Promise<object>} - Une confirmation de succès.
   */
  async updateBatchRates(pmsPropertyId, ratesArray) {
    throw new Error("La méthode 'updateBatchRates()' doit être implémentée par la classe enfant.");
  }

  /**
   * Récupère les réservations pour une plage de dates donnée.
   * @param {string} startDate - Date de début (YYYY-MM-DD).
   * @param {string} endDate - Date de fin (YYYY-MM-DD).
   * @returns {Promise<Array<object>>} - Une liste de réservations normalisées.
   */
  async getReservations(startDate, endDate) {
    throw new Error("La méthode 'getReservations()' doit être implémentée par la classe enfant.");
  }

  /**
   * Crée une nouvelle réservation dans le PMS.
   * @param {string} pmsPropertyId - L'ID PMS de la propriété.
   * @param {object} reservationData - Les données de la réservation.
   * @returns {Promise<object>} - La réservation créée avec son pmsId
   */
  async createReservation(pmsPropertyId, reservationData) {
    throw new Error("La méthode 'createReservation()' doit être implémentée par la classe enfant.");
  }

  /**
   * Met à jour une réservation existante dans le PMS.
   * @param {string} pmsReservationId - L'ID PMS de la réservation.
   * @param {object} reservationData - Les données à mettre à jour.
   * @returns {Promise<object>} - La réservation mise à jour
   */
  async updateReservation(pmsReservationId, reservationData) {
    throw new Error("La méthode 'updateReservation()' doit être implémentée par la classe enfant.");
  }

  /**
   * Supprime une réservation dans le PMS.
   * @param {string} pmsReservationId - L'ID PMS de la réservation.
   * @returns {Promise<object>} - Confirmation de suppression
   */
  async deleteReservation(pmsReservationId) {
    throw new Error("La méthode 'deleteReservation()' doit être implémentée par la classe enfant.");
  }
}

export default PMSBase;

