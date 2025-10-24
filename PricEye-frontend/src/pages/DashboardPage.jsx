import React, { useState, useEffect, useCallback } from 'react';
import { getProperties, deleteProperty, getReportKpis, getUserProfile } from '../services/api.js'; // Importer getReportKpis et getUserProfile
import PropertyModal from '../components/PropertyModal.jsx';
import GroupsManager from '../components/GroupsManager.jsx';
import StrategyModal from '../components/StrategyModal.jsx';
import RulesModal from '../components/RulesModal.jsx';
import NewsFeed from '../components/NewsFeed.jsx';
import { getDatesFromRange } from '../utils/dateUtils.js'; // Importer l'utilitaire de dates

function DashboardPage({ token }) { // onLogout est géré par App.jsx
  const [properties, setProperties] = useState([]);
  const [userProfile, setUserProfile] = useState(null); // État pour le profil
  const [isLoading, setIsLoading] = useState(true); // Loader pour les propriétés
  const [isKpiLoading, setIsKpiLoading] = useState(true); // Loader séparé pour les KPIs
  const [error, setError] = useState('');
  
  // State pour les modales
  const [editingProperty, setEditingProperty] = useState(null);
  const [isPropertyModalOpen, setIsPropertyModalOpen] = useState(false);
  
  const [configuringStrategyProperty, setConfiguringStrategyProperty] = useState(null);
  const [isStrategyModalOpen, setIsStrategyModalOpen] = useState(false);
  
  const [configuringRulesProperty, setConfiguringRulesProperty] = useState(null);
  const [isRulesModalOpen, setIsRulesModalOpen] = useState(false);

  // KPIs réels pour le dashboard
  const [kpis, setKpis] = useState({
    totalRevenue: 0,
    avgOccupancy: 0,
    adr: 0,
  });

  const fetchInitialData = useCallback(async () => {
    // Ne pas rafraîchir si une modale est ouverte
    if (isPropertyModalOpen || isStrategyModalOpen || isRulesModalOpen) return;
    setIsLoading(true);
    setIsKpiLoading(true); // Démarrer les deux chargements
    try {
      // Récupérer le profil et les propriétés en parallèle
      const [profileData, propertiesData] = await Promise.all([
        getUserProfile(token),
        getProperties(token)
      ]);
      
      setUserProfile(profileData);
      setProperties(propertiesData);
      setError('');

      // Une fois le profil chargé, lancer le calcul des KPIs réels
      const { startDate, endDate } = getDatesFromRange('1m', profileData.timezone); // '1m' = 30 derniers jours
      const kpiData = await getReportKpis(token, startDate, endDate);
      setKpis({
          totalRevenue: kpiData.totalRevenue || 0,
          avgOccupancy: kpiData.occupancy || 0,
          adr: kpiData.adr || 0,
      });

    } catch (err) {
      setError(err.message);
      // Réinitialiser en cas d'erreur
      setProperties([]);
      setKpis({ totalRevenue: 0, avgOccupancy: 0, adr: 0 });
    } finally {
      setIsLoading(false);
      setIsKpiLoading(false);
    }
  }, [token, isPropertyModalOpen, isStrategyModalOpen, isRulesModalOpen]); // Dépendances

  useEffect(() => {
    fetchInitialData();
  }, [fetchInitialData]); // Appelé une seule fois au montage (ou si le token change)

  // ... (Fonctions de gestion des modales : handleOpenAddModal, handleOpenEditModal, etc.)
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
        fetchInitialData(); // Recharger toutes les données (propriétés et KPIs)
      } catch (err) {
        setError(err.message);
      }
    }
  };

  const handleModalSave = () => {
    setIsPropertyModalOpen(false);
    setIsStrategyModalOpen(false);
    setIsRulesModalOpen(false);
    fetchInitialData(); // Recharger toutes les données
  };
  
  const handleModalClose = () => {
    setIsPropertyModalOpen(false);
    setIsStrategyModalOpen(false);
    setIsRulesModalOpen(false);
  }
  
  // Formatter pour la devise
  const formatCurrency = (amount) => {
      return (amount || 0).toLocaleString('fr-FR', { 
          style: 'currency', 
          currency: userProfile?.currency || 'EUR', // Utiliser la devise du profil
          minimumFractionDigits: 0, 
          maximumFractionDigits: 0 
      });
  };
   const formatCurrencyAdr = (amount) => {
      return (amount || 0).toLocaleString('fr-FR', { 
          style: 'currency', 
          currency: userProfile?.currency || 'EUR', // Utiliser la devise du profil
          minimumFractionDigits: 2 
      });
  };

  const renderPropertyCards = () => {
    if (isLoading) {
      return <p className="text-center text-gray-400 col-span-full">Chargement des propriétés...</p>;
    }

    if (error && properties.length === 0) { // Afficher l'erreur seulement si on n'a pas de propriétés
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
        <div className="mt-4 pt-4 border-t border-gray-700 flex flex-wrap justify-end gap-2">
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
          {/* Le bouton d'export est maintenant sur la page Rapport */}
        </div>
      </div>
      
       {error && <p className="bg-red-900/50 text-red-300 p-3 rounded-md text-sm mb-6">{error}</p>}
      
      {/* Section des KPIs Réels */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          {isKpiLoading ? (
            <>
              <div className="bg-gray-800 p-5 rounded-xl"><p className="text-sm text-gray-400">Revenu Total (30j)</p><p className="text-2xl font-bold text-gray-600">Chargement...</p></div>
              <div className="bg-gray-800 p-5 rounded-xl"><p className="text-sm text-gray-400">Taux d'occupation</p><p className="text-2xl font-bold text-gray-600">Chargement...</p></div>
              <div className="bg-gray-800 p-5 rounded-xl"><p className="text-sm text-gray-400">ADR</p><p className="text-2xl font-bold text-gray-600">Chargement...</p></div>
            </>
          ) : (
             <>
              <div className="bg-gray-800 p-5 rounded-xl"><p className="text-sm text-gray-400">Revenu Total (30j Réel)</p><p className="text-2xl font-bold">{formatCurrency(kpis.totalRevenue)}</p></div>
              <div className="bg-gray-800 p-5 rounded-xl"><p className="text-sm text-gray-400">Taux d'occupation (Réel)</p><p className="text-2xl font-bold">{kpis.avgOccupancy.toFixed(1)}%</p></div>
              <div className="bg-gray-800 p-5 rounded-xl"><p className="text-sm text-gray-400">ADR (Réel)</p><p className="text-2xl font-bold">{formatCurrencyAdr(kpis.adr)}</p></div>
            </>
          )}
      </div>

      {/* Contenu principal (groupes + propriétés) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-6">
              <GroupsManager token={token} properties={properties} />
              <h2 className="text-2xl font-bold mb-4">Mes Propriétés</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {renderPropertyCards()}
              </div>
          </div>
          <div className="lg:col-span-1">
              <NewsFeed token={token} />
          </div>
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

