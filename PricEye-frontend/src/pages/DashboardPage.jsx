import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { getProperties, deleteProperty, getReportKpis, getUserProfile, updatePropertyStatus, getGroupRecommendations, getGroups } from '../services/api.js'; 
import PropertyModal from '../components/PropertyModal.jsx';
import GroupsManager from '../components/GroupsManager.jsx';
import StrategyModal from '../components/StrategyModal.jsx';
import RulesModal from '../components/RulesModal.jsx';
import NewsFeed from '../components/NewsFeed.jsx';
import GroupRecommendations from '../components/GroupRecommendations.jsx'; 
import { getDatesFromRange } from '../utils/dateUtils.js'; 

function DashboardPage({ token, userProfile }) { 
  const [properties, setProperties] = useState([]);
  const [allGroups, setAllGroups] = useState([]);
  const [isLoading, setIsLoading] = useState(true); 
  const [isKpiLoading, setIsKpiLoading] = useState(true); 
  const [error, setError] = useState('');
  
  const [editingProperty, setEditingProperty] = useState(null);
  const [editingGroup, setEditingGroup] = useState(null); 
  const [isPropertyModalOpen, setIsPropertyModalOpen] = useState(false);
  const [isStrategyModalOpen, setIsStrategyModalOpen] = useState(false);
  const [isRulesModalOpen, setIsRulesModalOpen] = useState(false);
  
  const [openMenuId, setOpenMenuId] = useState(null);

  const [kpis, setKpis] = useState({
    totalRevenue: 0,
    avgOccupancy: 0,
    adr: 0,
    iaGain: 0, // Utiliser les données réelles
    iaScore: 0, // Utiliser les données réelles
  });
  
  const [recommendations, setRecommendations] = useState([]);
  const [isRecLoading, setIsRecLoading] = useState(true);
  
  const [selectedStatus, setSelectedStatus] = useState('active'); 
  const [selectedGroupId, setSelectedGroupId] = useState(''); 


  const fetchInitialData = useCallback(async () => {
    if (isPropertyModalOpen || isStrategyModalOpen || isRulesModalOpen) return;
    setIsLoading(true);
    setIsKpiLoading(true); 
    setIsRecLoading(true);
    try {
      const [propertiesData, groupsData] = await Promise.all([
          getProperties(token),
          getGroups(token) 
      ]);
      
      setProperties(propertiesData);
      setAllGroups(groupsData); 
      setError('');

      if (userProfile) {
          const { startDate, endDate } = getDatesFromRange('1m', userProfile.timezone); 
          const kpiData = await getReportKpis(token, startDate, endDate);
          setKpis({
              totalRevenue: kpiData.totalRevenue || 0,
              avgOccupancy: kpiData.occupancy || 0,
              adr: kpiData.adr || 0,
              iaGain: kpiData.iaGain || 0, // Utiliser les données réelles
              iaScore: kpiData.iaScore || 0, // Utiliser les données réelles
          });
      }
      
      const recs = await getGroupRecommendations(token);
      setRecommendations(recs);

    } catch (err) {
      setError(err.message);
      setProperties([]);
      setKpis({ totalRevenue: 0, avgOccupancy: 0, adr: 0, iaGain: 0, iaScore: 0 });
      setRecommendations([]);
    } finally {
      setIsLoading(false);
      setIsKpiLoading(false);
      setIsRecLoading(false);
    }
  }, [token, isPropertyModalOpen, isStrategyModalOpen, isRulesModalOpen, userProfile]); 

  useEffect(() => {
    fetchInitialData();
  }, [fetchInitialData]); 
  
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (openMenuId && !event.target.closest('.action-menu-container')) {
        setOpenMenuId(null);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [openMenuId]);

  const filteredProperties = useMemo(() => {
      let filtered = properties;
      
      if (selectedStatus) {
          filtered = filtered.filter(p => (p.status || 'active') === selectedStatus);
      }
      
      if (selectedGroupId) {
          const group = allGroups.find(g => g.id === selectedGroupId);
          const propertyIdsInGroup = group?.properties || [];
          filtered = filtered.filter(p => propertyIdsInGroup.includes(p.id));
      }
      
      return filtered;
  }, [properties, selectedStatus, selectedGroupId, allGroups]);
  
  const getGroupForProperty = (propertyId) => {
      return allGroups.find(g => g.properties?.includes(propertyId));
  };


  const handleOpenAddModal = () => {
    setEditingProperty(null);
    setIsPropertyModalOpen(true);
  };

  const handleOpenEditModal = (property) => {
    setEditingProperty(property);
    setIsPropertyModalOpen(true);
    setOpenMenuId(null); 
  };

  const handleOpenStrategyModal = (item) => {
    if (item.address) { 
      setEditingProperty(item);
    } else { 
      setEditingGroup(item);
    }
    setIsStrategyModalOpen(true);
    setOpenMenuId(null);
  };

   const handleOpenRulesModal = (item) => {
    if (item.address) { 
      setEditingProperty(item);
    } else { 
      setEditingGroup(item);
    }
    setIsRulesModalOpen(true);
    setOpenMenuId(null);
  };

  const handleDelete = async (propertyId) => {
    setOpenMenuId(null);
    if (window.confirm("Êtes-vous sûr de vouloir supprimer cette propriété ?")) {
      try {
        await deleteProperty(propertyId, token);
        fetchInitialData(); 
      } catch (err) {
        setError(err.message);
      }
    }
  };
  
  const handleSetStatus = async (propertyId, status) => {
      setOpenMenuId(null);
      try {
          await updatePropertyStatus(propertyId, status, token);
          fetchInitialData(); 
      } catch (err) {
          setError(err.message);
      }
  };


  const handleModalSave = () => {
    setIsPropertyModalOpen(false);
    setIsStrategyModalOpen(false);
    setIsRulesModalOpen(false);
    setEditingProperty(null); 
    setEditingGroup(null);
    fetchInitialData(); 
  };
  
  const handleModalClose = () => {
    setIsPropertyModalOpen(false);
    setIsStrategyModalOpen(false);
    setIsRulesModalOpen(false);
    setEditingProperty(null); 
    setEditingGroup(null);
  }
  
  const formatCurrency = (amount) => {
      return (amount || 0).toLocaleString('fr-FR', { 
          style: 'currency', 
          currency: userProfile?.currency || 'EUR', 
          minimumFractionDigits: 0, 
          maximumFractionDigits: 0 
      });
  };
   const formatCurrencyAdr = (amount) => {
      return (amount || 0).toLocaleString('fr-FR', { 
          style: 'currency', 
          currency: userProfile?.currency || 'EUR', 
          minimumFractionDigits: 2 
      });
  };
  
  const getStatusBadge = (status) => {
      switch(status) {
          case 'active':
              return <span className="px-2 py-0.5 text-xs font-semibold bg-green-700 text-green-100 rounded-full flex items-center gap-1">🏡 Actif</span>;
          case 'archived':
              return <span className="px-2 py-0.5 text-xs font-semibold bg-gray-600 text-gray-200 rounded-full flex items-center gap-1">🗄️ Archivé</span>;
          case 'error':
              return <span className="px-2 py-0.5 text-xs font-semibold bg-red-700 text-red-100 rounded-full flex items-center gap-1">⚠️ Erreur</span>;
          default:
              return <span className="px-2 py-0.5 text-xs font-semibold bg-yellow-700 text-yellow-100 rounded-full flex items-center gap-1">? Inconnu</span>;
      }
  };

  const renderPropertyCards = () => {
    if (isLoading) {
      return <p className="text-center text-text-muted col-span-full">Chargement des propriétés...</p>;
    }

    if (error && properties.length === 0) { 
      return <p className="text-center text-red-400 col-span-full">Erreur : {error}</p>;
    }

    if (properties.length === 0) {
      return (
        <div className="text-center bg-bg-secondary p-8 rounded-lg col-span-full">
          <h3 className="text-xl font-semibold text-text-primary">Aucune propriété trouvée</h3>
          <p className="text-text-muted mt-2">Commencez par ajouter votre première propriété !</p>
        </div>
      );
    }
    
    if (filteredProperties.length === 0) {
       return (
        <div className="text-center bg-bg-secondary p-8 rounded-lg col-span-full">
          <h3 className="text-xl font-semibold text-text-primary">Aucune propriété ne correspond à vos filtres</h3>
          <p className="text-text-muted mt-2">Essayez de changer votre sélection de groupe ou de statut.</p>
        </div>
      );
    }

    return filteredProperties.map((prop) => {
      const group = getGroupForProperty(prop.id);
      const isSynced = group && group.syncPrices;
    
      return (
      <div key={prop.id} className="bg-bg-secondary rounded-lg shadow-lg p-4 flex flex-col">
        <div className="flex-grow">
          <div className="flex justify-between items-start">
             <h3 className="font-bold text-lg text-text-primary flex items-center gap-2">
                {prop.address}
                {isSynced && <span title={`Synchronisé avec le groupe "${group.name}"`}>⚙️</span>}
             </h3>
             {getStatusBadge(prop.status || 'active')}
          </div>
          <p className="text-sm text-text-muted">{prop.location}</p>
          <div className="text-xs mt-2 text-text-muted space-x-2">
            <span>
              Stratégie: <span className="font-semibold text-text-secondary">{prop.strategy || 'N/A'}</span>
            </span>
            <span>|</span>
            <span>
              Équip.: <span className="font-semibold text-text-secondary">{prop.amenities?.length || 0}</span>
            </span>
          </div>
        </div>
        <div className="mt-4 pt-4 border-t border-border-primary flex flex-wrap justify-end gap-2">
          <button onClick={() => handleOpenStrategyModal(prop)} className="text-xs px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded-md">Stratégie IA</button>
          <button onClick={() => handleOpenRulesModal(prop)} className="text-xs px-3 py-1 bg-purple-600 hover:bg-purple-500 text-white rounded-md">Règles Perso.</button>
          
          <div className="relative action-menu-container">
             <button 
                onClick={() => setOpenMenuId(openMenuId === prop.id ? null : prop.id)} 
                className="text-xs px-3 py-1 bg-bg-muted hover:bg-border-primary text-text-secondary rounded-md"
             >
                Actions ▼
             </button>
             {openMenuId === prop.id && (
                <div className="absolute right-0 mt-2 w-48 bg-bg-tertiary rounded-md shadow-lg z-20 border border-border-primary">
                    <button onClick={() => handleOpenEditModal(prop)} className="block w-full text-left px-4 py-2 text-sm text-text-secondary hover:bg-bg-muted">
                        Modifier
                    </button>
                    {prop.status !== 'active' && (
                        <button onClick={() => handleSetStatus(prop.id, 'active')} className="block w-full text-left px-4 py-2 text-sm text-text-secondary hover:bg-bg-muted">
                            Activer
                        </button>
                    )}
                     {prop.status === 'active' && (
                        <button onClick={() => handleSetStatus(prop.id, 'archived')} className="block w-full text-left px-4 py-2 text-sm text-text-secondary hover:bg-bg-muted">
                            Archiver
                        </button>
                     )}
                     <button onClick={() => handleSetStatus(prop.id, 'error')} className="block w-full text-left px-4 py-2 text-sm text-yellow-400 hover:bg-bg-muted">
                        Marquer Erreur
                    </button>
                    <button onClick={() => handleDelete(prop.id)} className="block w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-bg-muted">
                        Supprimer
                    </button>
                </div>
             )}
          </div>
          
        </div>
      </div>
    )});
  };

  return (
    <div className="p-4 md:p-8">
      {/* Header */}
      <div className="flex flex-wrap justify-between items-center gap-4 mb-8">
        <h1 className="text-3xl font-bold text-text-primary">Tableau de Bord</h1>
        <div className="flex items-center gap-4">
          <button 
            onClick={handleOpenAddModal}
            className="px-4 py-2 font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700"
          >
            Ajouter une propriété
          </button>
        </div>
      </div>
      
       {error && <p className="bg-red-900/50 text-red-300 p-3 rounded-md text-sm mb-6">{error}</p>}
       
       {!isRecLoading && recommendations.length > 0 ? (
           <GroupRecommendations 
                token={token} 
                recommendations={recommendations} 
                onGroupCreated={fetchInitialData} 
           />
       ) : (
           !isRecLoading && (
                 <div className="bg-bg-secondary p-4 rounded-lg mb-6 shadow">
                     <p className="text-sm text-text-muted text-center">
                         (Aucune nouvelle suggestion de groupe pour le moment. L'IA n'a pas trouvé de propriétés similaires non groupées.)
                     </p>
                 </div>
           )
       )}
      
      {/* Section des KPIs Réels (MISE À JOUR) */}
      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-6 mb-8">
          {isKpiLoading ? (
            <>
              <div className="bg-bg-secondary p-5 rounded-xl shadow-lg"><p className="text-sm text-text-muted">Revenu Total (30j)</p><p className="text-2xl font-bold text-text-muted animate-pulse">Chargement...</p></div>
              <div className="bg-bg-secondary p-5 rounded-xl shadow-lg"><p className="text-sm text-text-muted">Taux d'occupation</p><p className="text-2xl font-bold text-text-muted animate-pulse">Chargement...</p></div>
              <div className="bg-bg-secondary p-5 rounded-xl shadow-lg"><p className="text-sm text-text-muted">ADR</p><p className="text-2xl font-bold text-text-muted animate-pulse">Chargement...</p></div>
              <div className="bg-bg-secondary p-5 rounded-xl shadow-lg"><p className="text-sm text-text-muted">Gains par l'IA</p><p className="text-2xl font-bold text-text-muted animate-pulse">Chargement...</p></div>
              <div className="bg-bg-secondary p-5 rounded-xl shadow-lg"><p className="text-sm text-text-muted">Score IA</p><p className="text-2xl font-bold text-text-muted animate-pulse">Chargement...</p></div>
            </>
          ) : (
             <>
              <div className="bg-bg-secondary p-5 rounded-xl shadow-lg"><p className="text-sm text-text-muted">Revenu Total (30j Réel)</p><p className="text-2xl font-bold text-text-primary">{formatCurrency(kpis.totalRevenue)}</p></div>
              <div className="bg-bg-secondary p-5 rounded-xl shadow-lg"><p className="text-sm text-text-muted">Taux d'occupation (Réel)</p><p className="text-2xl font-bold text-text-primary">{kpis.avgOccupancy.toFixed(1)}%</p></div>
              <div className="bg-bg-secondary p-5 rounded-xl shadow-lg"><p className="text-sm text-text-muted">ADR (Réel)</p><p className="text-2xl font-bold text-text-primary">{formatCurrencyAdr(kpis.adr)}</p></div>
              <div className="bg-bg-secondary p-5 rounded-xl shadow-lg"><p className="text-sm text-text-muted">Gains par l'IA (Réel)</p><p className="text-2xl font-bold text-text-primary">{formatCurrency(kpis.iaGain)}</p></div>
              <div className="bg-bg-secondary p-5 rounded-xl shadow-lg"><p className="text-sm text-text-muted">Score IA (Réel)</p><p className="text-2xl font-bold text-text-primary">{kpis.iaScore.toFixed(0)}%</p></div>
            </>
          )}
      </div>

      {/* Contenu principal (groupes + propriétés) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-6">
              <GroupsManager 
                token={token} 
                properties={properties} 
                onGroupChange={fetchInitialData} 
                onEditStrategy={handleOpenStrategyModal} 
                onEditRules={handleOpenRulesModal} 
              />
              
              {/* Entête de la liste des propriétés avec filtres */}
              <div className="flex justify-between items-center mt-6">
                  <h2 className="text-2xl font-bold text-text-primary">
                    Mes Propriétés ({filteredProperties.length})
                  </h2>
                  <div className="flex gap-4">
                      {/* Filtre par Groupe */}
                      <select 
                        value={selectedGroupId} 
                        onChange={(e) => setSelectedGroupId(e.target.value)}
                        className="form-input bg-bg-secondary border-border-primary rounded-md p-2 text-sm text-text-primary"
                      >
                         <option value="">Tous les groupes</option>
                         {allGroups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                      </select>
                      
                      {/* Filtre par Statut */}
                      <select 
                        value={selectedStatus} 
                        onChange={(e) => setSelectedStatus(e.target.value)}
                        className="form-input bg-bg-secondary border-border-primary rounded-md p-2 text-sm text-text-primary"
                      >
                          <option value="active">Actives</option>
                          <option value="archived">Archivées</option>
                          <option value="error">Erreur</option>
                           <option value="">Toutes</option>
                      </select>
                  </div>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {renderPropertyCards()}
              </div>
          </div>
          <div className="lg:col-span-1">
              <NewsFeed token={token} />
          </div>
      </div>


      {/* Modales (logique mise à jour) */}
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
          item={editingGroup || editingProperty} 
          itemType={editingGroup ? 'group' : 'property'} 
        />
      )}
      {isRulesModalOpen && (
        <RulesModal
          token={token}
          onClose={handleModalClose}
          onSave={handleModalSave}
          item={editingGroup || editingProperty} 
          itemType={editingGroup ? 'group' : 'property'} 
        />
      )}
    </div>
  );
}

export default DashboardPage;

