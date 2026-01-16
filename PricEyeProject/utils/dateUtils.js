/**
 * Utilitaires de gestion de dates.
 * Version "Zero-Dependency" (Native JS) pour éviter les erreurs de module manquant.
 */

/**
 * Génère un tableau de toutes les dates (YYYY-MM-DD) entre le début et la fin inclus.
 * @param {string} startDateStr - Date de début (YYYY-MM-DD)
 * @param {string} endDateStr - Date de fin (YYYY-MM-DD)
 * @returns {string[]} Tableau de dates
 */
function getDatesBetween(startDateStr, endDateStr) {
    const dates = [];
    
    // Création des objets Date (ajout de 'T00:00:00' pour forcer le local time et éviter les décalages UTC)
    // Ou utilisation simple de split pour être sûr
    const startParts = startDateStr.split('-').map(Number);
    const endParts = endDateStr.split('-').map(Number);
    
    // Note: Mois est 0-indexé en JS (0 = Janvier)
    const currentDate = new Date(startParts[0], startParts[1] - 1, startParts[2]);
    const stopDate = new Date(endParts[0], endParts[1] - 1, endParts[2]);

    // Boucle tant que la date courante est <= date de fin
    while (currentDate <= stopDate) {
        // Formatage manuel YYYY-MM-DD
        const year = currentDate.getFullYear();
        const month = String(currentDate.getMonth() + 1).padStart(2, '0');
        const day = String(currentDate.getDate()).padStart(2, '0');
        
        dates.push(`${year}-${month}-${day}`);

        // Ajouter 1 jour
        currentDate.setDate(currentDate.getDate() + 1);
    }
    
    return dates;
}

module.exports = { getDatesBetween };
