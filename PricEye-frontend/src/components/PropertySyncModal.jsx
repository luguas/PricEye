import React, { useState, useEffect, useMemo } from 'react';
import { syncProperties, getProperties, importPmsProperties } from '../services/api.js';

/**
 * Une modale qui gère la synchronisation et l'importation de propriétés
 * depuis un PMS connecté.
 * @param {object} props
 * @param {string} props.token - Jeton d'authentification Priceye
 * @param {string} props.pmsType - Le type de PMS (ex: 'smoobu')
 * @param {Function} props.onClose - Fonction pour fermer la modale (passe 'true' si un rafraîchissement est nécessaire)
 */
function PropertySyncModal({ token, pmsType, onClose }) {
  const [isLoading, setIsLoading] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState(null);
  
  const [pmsProperties, setPmsProperties] = useState([]);
  const [priceyeProperties, setPriceyeProperties] = useState([]);

  // Étape 1: Récupérer les deux listes de propriétés au chargement
  useEffect(() => {
    const fetchData = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const [pmsPropsData, priceyePropsData] = await Promise.all([
          syncProperties(token), // 1. Récupère depuis le PMS
          getProperties(token)    // 2. Récupère depuis la BDD Priceye
        ]);
        
        setPmsProperties(pmsPropsData || []);
        setPriceyeProperties(priceyePropsData || []);
        
      } catch (err) {
        setError(err.message);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, [token]);

  // Étape 2: Comparer les listes pour trouver les nouvelles vs. les synchronisées
  const stats = useMemo(() => {
    if (isLoading) return null;

    // Créer un Set des pmsId déjà présents dans Priceye
    const priceyePmsIds = new Set(
      priceyeProperties.map(p => p.pmsId).filter(Boolean)
    );

    const newProperties = [];
    const syncedProperties = [];

    for (const pmsProp of pmsProperties) {
      if (priceyePmsIds.has(pmsProp.pmsId)) {
        syncedProperties.push(pmsProp);
      } else {
        newProperties.push(pmsProp);
      }
    }
    
    return { newProperties, syncedProperties };
  }, [isLoading, pmsProperties, priceyeProperties]);

  // Étape 3: Gérer l'action d'importation
  const handleImport = async () => {
    if (!stats || stats.newProperties.length === 0 || !pmsType) {
      setError("Aucune nouvelle propriété à importer ou type de PMS manquant.");
      return;
    }
    
    setIsImporting(true);
    setError(null);
    
    try {
      const result = await importPmsProperties(stats.newProperties, pmsType, token);
      alert(result.message || 'Importation réussie !');
      onClose(true); // Fermer et signaler qu'il faut rafraîchir
    } catch (err) {
      setError(err.message);
    } finally {
      setIsImporting(false);
    }
  };

  // Rendu du contenu
  const renderContent = () => {
    if (isLoading) {
      return (
        <div className="flex flex-col items-center justify-center h-48">
          <div className="loader"></div>
          <p className="text-text-muted mt-4">Analyse de votre connexion PMS...</p>
        </div>
      );
    }

    if (error) {
      return <p className="text-sm text-red-400 bg-red-900/50 p-3 rounded-md">{error}</p>;
    }

    if (stats) {
      return (
        <div className="space-y-4">
          <div>
            <h4 className="font-semibold text-text-primary">Nouvelles propriétés trouvées ({stats.newProperties.length})</h4>
            {stats.newProperties.length > 0 ? (
              <ul className="list-disc list-inside text-sm text-text-secondary max-h-32 overflow-y-auto bg-bg-muted p-2 rounded-md mt-1">
                {stats.newProperties.map(p => (
                  <li key={p.pmsId}>{p.name} (ID: {p.pmsId})</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-text-muted mt-1">Aucune nouvelle propriété à importer.</p>
            )}
          </div>
          <div>
            <h4 className="font-semibold text-text-primary">Propriétés déjà synchronisées ({stats.syncedProperties.length})</h4>
            <p className="text-sm text-text-muted mt-1">
              {stats.syncedProperties.length > 0 
                ? "Ces propriétés sont déjà liées à votre compte Priceye." 
                : "Aucune propriété n'est encore liée."}
            </p>
          </div>
        </div>
      );
    }
    
    return null;
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center p-4 z-50">
      <div className="bg-bg-secondary rounded-lg shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
        <h3 className="text-xl font-bold mb-6 text-text-primary">Synchroniser les Propriétés</h3>
        
        {renderContent()}
        
        <div className="flex justify-end gap-4 pt-6 mt-6 border-t border-border-primary">
          <button 
            type="button" 
            onClick={() => onClose(false)} // Fermer sans rafraîchir
            className="px-4 py-2 font-semibold text-text-secondary bg-bg-muted rounded-md hover:bg-border-primary"
          >
            Fermer
          </button>
          <button 
            type="button" 
            onClick={handleImport} 
            disabled={isLoading || isImporting || !stats || stats.newProperties.length === 0}
            className="px-4 py-2 font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:bg-gray-500"
          >
            {isImporting ? 'Importation en cours...' : `Importer ${stats?.newProperties.length || 0} nouvelle(s) propriété(s)`}
          </button>
        </div>
      </div>
    </div>
  );
}

export default PropertySyncModal;

