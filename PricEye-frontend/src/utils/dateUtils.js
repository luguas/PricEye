/**
 * Formate une date en chaîne YYYY-MM-DD
 * @param {Date} date 
 * @returns {string}
 */
const formatDate = (date) => date.toISOString().split('T')[0];

/**
 * Obtient la date "actuelle" dans un fuseau horaire spécifique
 * @param {string} timeZone - Fuseau horaire IANA (ex: "Europe/Paris")
 * @returns {Date}
 */
const getZonedDate = (timeZone) => {
  // Crée un formateur pour la date au format YYYY-MM-DD dans le fuseau horaire donné
  // 'en-CA' est utilisé car il produit le format YYYY-MM-DD
  const formatter = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: timeZone || 'UTC', // Fallback sur UTC si non fourni
  });
  
  // Crée une nouvelle date basée sur cette chaîne pour obtenir le début de journée dans ce fuseau
  // ex: '2025-10-24'
  const dateString = formatter.format(new Date());
  
  // Recrée un objet Date. Note : L'heure sera 00:00 dans le fuseau horaire local
  // mais la *date* sera correcte par rapport au fuseau horaire cible.
  // Pour les calculs de plage, c'est ce qui compte.
  return new Date(dateString + 'T00:00:00Z'); // Interpréter comme UTC pour la cohérence
};


/**
 * Calcule les dates de début et de fin en fonction du sélecteur de plage et du fuseau horaire.
 * @param {string} range - "7d", "1m", "6m", "ytd", "1y", "all"
 * @param {string} timeZone - Fuseau horaire IANA (ex: "Europe/Paris")
 * @returns {{startDate: string, endDate: string}}
 */
export const getDatesFromRange = (range, timeZone = 'UTC') => {
  const endDate = getZonedDate(timeZone);
  let startDate = getZonedDate(timeZone);

  switch (range) {
    case '7d':
      startDate.setDate(endDate.getDate() - 7);
      break;
    case '1m':
      startDate.setMonth(endDate.getMonth() - 1);
      break;
    case '6m':
      startDate.setMonth(endDate.getMonth() - 6);
      break;
    case 'ytd': // Year To Date
      startDate = new Date(Date.UTC(endDate.getUTCFullYear(), 0, 1));
      break;
    case '1y':
      startDate.setFullYear(endDate.getFullYear() - 1);
      break;
    case 'all':
      startDate.setFullYear(endDate.getFullYear() - 5); // Simuler "Tout" comme 5 ans
      break;
    default:
      startDate.setMonth(endDate.getMonth() - 1);
  }
  
  return {
    startDate: formatDate(startDate),
    endDate: formatDate(endDate),
  };
};

