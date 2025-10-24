import * as XLSX from 'xlsx';

/**
 * Exporte un tableau de données au format Excel (.xlsx).
 * @param {Array<object>} data - Le tableau d'objets à exporter.
 * @param {string} fileName - Le nom du fichier Excel (sans l'extension).
 */
export function exportToExcel(data, fileName) {
  if (!Array.isArray(data) || data.length === 0) {
    console.error("Impossible d'exporter : les données sont vides ou invalides.");
    return;
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
  } catch (error) {
    console.error("Erreur lors de la génération du fichier Excel:", error);
    alert("Une erreur est survenue lors de l'exportation des données.");
  }
}
