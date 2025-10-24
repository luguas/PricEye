import React, { useState, useEffect, useCallback } from 'react';
import { getProperties, deleteProperty } from '../services/api';
import PropertyModal from '../components/PropertyModal';
import GroupsManager from '../components/GroupsManager';
import StrategyModal from '../components/StrategyModal';
import RulesModal from '../components/RulesModal';
import { exportToExcel } from '../utils/exportUtils'; // Importer la fonction d'export

function DashboardPage({ token, onLogout }) {
  const [properties, setProperties] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  // State pour les modales
  const [editingProperty, setEditingProperty] = useState(null);
  const [isPropertyModalOpen, setIsPropertyModalOpen] = useState(false);
  
  const [configuringStrategyProperty, setConfiguringStrategyProperty] = useState(null);
  const [isStrategyModalOpen, setIsStrategyModalOpen] = useState(false);
  
  const [configuringRulesProperty, setConfiguringRulesProperty] = useState(null);
  const [isRulesModalOpen, setIsRulesModalOpen] = useState(false);

  const fetchProperties = useCallback(async () => {
    if (isPropertyModalOpen || isStrategyModalOpen || isRulesModalOpen) return;
    setIsLoading(true);
    try {
      const data = await getProperties(token);
      setProperties(data);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  }, [token, isPropertyModalOpen, isStrategyModalOpen, isRulesModalOpen]);

  useEffect(() => {
    fetchProperties();
  }, [fetchProperties]);

  const handleOpenAddModal = () => {
    setEditingProperty(null);
    setIsPropertyModalOpen(true);
  };

  const handleOpenEditModal = (property) => {
    setEditingProperty(property);
    setIsPropertyModalOpen(true);
  };

  const handleOpenStrategyModal = (property) => {
    setConfiguringStrategyProperty(property);
    setIsStrategyModalOpen(true);
  };

   const handleOpenRulesModal = (property) => {
    setConfiguringRulesProperty(property);
    setIsRulesModalOpen(true);
  };

  const handleDelete = async (propertyId) => {
    if (window.confirm("Êtes-vous sûr de vouloir supprimer cette propriété ?")) {
      try {
        await deleteProperty(propertyId, token);
        fetchProperties();
      } catch (err) {
        setError(err.message);
      }
    }
  };

  const handleModalSave = () => {
    setIsPropertyModalOpen(false);
    setIsStrategyModalOpen(false);
    setIsRulesModalOpen(false);
    fetchProperties();
  };
  
  const handleModalClose = () => {
    setIsPropertyModalOpen(false);
    setIsStrategyModalOpen(false);
    setIsRulesModalOpen(false);
  }

  // Fonction pour gérer l'export Excel
  const handleExport = () => {
    if (properties.length === 0) {
      alert("Aucune donnée à exporter.");
      return;
    }
    // Pour l'instant, on exporte la liste brute des propriétés.
    // On pourrait ajouter plus de données calculées plus tard.
    exportToExcel(properties, 'Rapport_Proprietes');
  };


  const renderPropertyCards = () => {
    if (isLoading) {
      return <p className="text-center text-gray-400 col-span-full">Chargement des propriétés...</p>;
    }

    if (error) {
      return <p className="text-center text-red-400 col-span-full">Erreur : {error}</p>;
    }

    if (properties.length === 0) {
      return (
        <div className="text-center bg-gray-800 p-8 rounded-lg col-span-full">
          <h3 className="text-xl font-semibold">Aucune propriété trouvée</h3>
          <p className="text-gray-400 mt-2">Commencez par ajouter votre première propriété !</p>
        </div>
      );
    }

    return properties.map((prop) => (
      <div key={prop.id} className="bg-gray-800 rounded-lg shadow-lg p-4 flex flex-col">
        <div className="flex-grow">
          <h3 className="font-bold text-lg">{prop.address}</h3>
          <p className="text-sm text-gray-400">{prop.location}</p>
          <div className="text-xs mt-2 text-gray-500">
            Stratégie: <span className="font-semibold text-gray-300">{prop.strategy || 'Non définie'}</span>
             | Min Stay: <span className="font-semibold text-gray-300">{prop.min_stay != null ? prop.min_stay : 'N/A'}</span>
          </div>
        </div>
        <div className="mt-4 pt-4 border-t border-gray-700 flex justify-end gap-2">
          <button onClick={() => handleOpenStrategyModal(prop)} className="text-xs px-3 py-1 bg-indigo-600 hover:bg-indigo-500 rounded-md">Stratégie IA</button>
          <button onClick={() => handleOpenRulesModal(prop)} className="text-xs px-3 py-1 bg-purple-600 hover:bg-purple-500 rounded-md">Règles Perso.</button>
          <button onClick={() => handleOpenEditModal(prop)} className="text-xs px-3 py-1 bg-gray-600 hover:bg-gray-500 rounded-md">Modifier</button>
          <button onClick={() => handleDelete(prop.id)} className="text-xs px-3 py-1 bg-red-800 hover:bg-red-700 rounded-md">Supprimer</button>
        </div>
      </div>
    ));
  };

  return (
    <div className="p-4 md:p-8">
      {/* Header */}
      <div className="flex flex-wrap justify-between items-center gap-4 mb-8">
        <h1 className="text-3xl font-bold">Tableau de Bord</h1>
        <div className="flex items-center gap-4">
          <button 
            onClick={handleOpenAddModal}
            className="px-4 py-2 font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700"
          >
            Ajouter une propriété
          </button>
          {/* Bouton d'export */}
          <button
            onClick={handleExport}
            className="px-4 py-2 font-semibold text-white bg-green-600 rounded-md hover:bg-green-700"
          >
            Exporter (.xlsx)
          </button>
          <button
            onClick={onLogout}
            className="px-4 py-2 font-semibold text-white bg-red-600 rounded-md hover:bg-red-700"
          >
            Déconnexion
          </button>
        </div>
      </div>
      
      {/* Contenu principal (groupes + propriétés) */}
      <div className="my-8"><GroupsManager token={token} properties={properties} /></div>
      <h2 className="text-2xl font-bold mb-4">Mes Propriétés</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {renderPropertyCards()}
      </div>

      {/* Modales */}
      {isPropertyModalOpen && (
        <PropertyModal 
          token={token}
          onClose={handleModalClose}
          onSave={handleModalSave}
          property={editingProperty}
        />
      )}
      {isStrategyModalOpen && (
        <StrategyModal
          token={token}
          onClose={handleModalClose}
          onSave={handleModalSave}
          property={configuringStrategyProperty}
        />
      )}
      {isRulesModalOpen && (
        <RulesModal
          token={token}
          onClose={handleModalClose}
          onSave={handleModalSave}
          property={configuringRulesProperty}
        />
      )}
    </div>
  );
}

export default DashboardPage;

