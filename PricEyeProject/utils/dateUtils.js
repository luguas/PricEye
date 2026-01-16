/**
 * Utilitaires pour la manipulation de dates
 */

const { addDays, format, parseISO } = require('date-fns');

/**
 * Génère la liste de toutes les dates entre startDateStr et endDateStr (inclus)
 * @param {string} startDateStr - Date de début au format YYYY-MM-DD
 * @param {string} endDateStr - Date de fin au format YYYY-MM-DD
 * @returns {Array<string>} Tableau de dates au format YYYY-MM-DD
 */
function getDatesBetween(startDateStr, endDateStr) {
    const dates = [];
    let currentDate = parseISO(startDateStr);
    const stopDate = parseISO(endDateStr);

    while (currentDate <= stopDate) {
        dates.push(format(currentDate, 'yyyy-MM-dd'));
        currentDate = addDays(currentDate, 1);
    }
    return dates;
}

module.exports = { getDatesBetween };
