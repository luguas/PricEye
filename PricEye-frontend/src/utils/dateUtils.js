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
  
  const dateString = formatter.format(new Date());
  
  // Crée un nouvel objet Date basé sur la date UTC pour éviter les décalages
  return new Date(Date.UTC(
      parseInt(dateString.substring(0, 4)),
      parseInt(dateString.substring(5, 7)) - 1, // Mois est 0-indexé
      parseInt(dateString.substring(8, 10))
  ));
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
      startDate.setUTCDate(endDate.getUTCDate() - 7);
      break;
    case '1m':
      startDate.setUTCMonth(endDate.getUTCMonth() - 1);
      break;
    case '6m':
      startDate.setUTCMonth(endDate.getUTCMonth() - 6);
      break;
    case 'ytd': // Year To Date
      startDate = new Date(Date.UTC(endDate.getUTCFullYear(), 0, 1));
      break;
    case '1y':
      startDate.setUTCFullYear(endDate.getUTCFullYear() - 1);
      break;
    case 'all':
      startDate.setUTCFullYear(endDate.getUTCFullYear() - 2); // Limité à 2 ans maximum (contrainte API)
      break;
    default:
      startDate.setUTCMonth(endDate.getUTCMonth() - 1);
  }
  
  return {
    startDate: formatDate(startDate),
    endDate: formatDate(endDate),
  };
};

/**
 * Calcule la période N-1 basée sur les dates de la période N.
 * @param {string} startDate - Date de début de la période N (YYYY-MM-DD)
 * @param {string} endDate - Date de fin de la période N (YYYY-MM-DD)
 * @returns {{startDate: string, endDate: string}}
 */
export const getPreviousDates = (startDate, endDate) => {
    const startN = new Date(startDate + 'T00:00:00Z'); // Interpréter comme UTC
    const endN = new Date(endDate + 'T00:00:00Z');
    
    // Calculer la durée de la période N en millisecondes
    const durationMs = endN.getTime() - startN.getTime();
    
    // La date de fin de N-1 est la veille du début de N
    const endN_1 = new Date(startN.getTime() - (24 * 60 * 60 * 1000));
    
    // La date de début de N-1 est la date de fin de N-1 moins la durée
    const startN_1 = new Date(endN_1.getTime() - durationMs);
    
    return {
        startDate: formatDate(startN_1),
        endDate: formatDate(endN_1),
    };
};

