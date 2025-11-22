import * as XLSX from 'xlsx';

/**
 * Exporte un tableau de données au format Excel (.xlsx).
 * @param {Array<object>} data - Le tableau d'objets à exporter.
 * @param {string} fileName - Le nom du fichier Excel (sans l'extension).
 * @param {Function} onError - Fonction de callback appelée en cas d'erreur (optionnel).
 * @returns {boolean} - Retourne true si l'exportation a réussi, false sinon.
 */
export function exportToExcel(data, fileName, onError = null) {
  if (!Array.isArray(data) || data.length === 0) {
    console.error("Impossible d'exporter : les données sont vides ou invalides.");
    if (onError) {
      onError("Impossible d'exporter : les données sont vides ou invalides.");
    }
    return false;
  }

  try {
    // Créer une nouvelle feuille de calcul à partir du tableau de données JSON
    const worksheet = XLSX.utils.json_to_sheet(data);

    // Créer un nouveau classeur
    const workbook = XLSX.utils.book_new();

    // Ajouter la feuille de calcul au classeur
    // Le troisième argument est le nom de l'onglet dans Excel
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Données');

    // Générer le fichier Excel et déclencher le téléchargement
    // Le nom du fichier sera "fileName.xlsx"
    XLSX.writeFile(workbook, `${fileName}.xlsx`);
    return true;
  } catch (error) {
    console.error("Erreur lors de la génération du fichier Excel:", error);
    if (onError) {
      onError("Une erreur est survenue lors de l'exportation des données.");
    }
    return false;
  }
}
