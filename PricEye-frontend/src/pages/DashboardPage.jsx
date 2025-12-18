import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { getProperties, deleteProperty, getReportKpis, updatePropertyStatus, getGroupRecommendations, getGroups } from '../services/api.js'; 
import PropertyModal from '../components/PropertyModal.jsx';
import GroupsManager from '../components/GroupsManager.jsx';
import StrategyModal from '../components/StrategyModal.jsx';
import RulesModal from '../components/RulesModal.jsx';
import ConfirmModal from '../components/ConfirmModal.jsx';
import NewsFeed from '../components/NewsFeed.jsx';
import GroupRecommendations from '../components/GroupRecommendations.jsx'; 
import { getDatesFromRange } from '../utils/dateUtils.js';
import { useLanguage } from '../contexts/LanguageContext.jsx';

/**
 * Generates AI-related prompts and messages in the user's language
 * @param {string} language - User's language code (e.g., 'fr', 'en')
 * @returns {Object} Object containing localized AI prompts and messages
 */
const getAIPrompts = (language = 'en') => {
  const prompts = {
    fr: {
      errorRefreshing: "Erreur lors du rafraîchissement",
      errorFetchingGroup: "Erreur lors de la récupération du groupe",
      loadingKPIs: "Chargement des indicateurs de performance IA",
      loadingRecommendations: "Chargement des recommandations IA",
      aiGainDescription: "Gains générés par l'IA sur la période",
      aiScoreDescription: "Score de performance de l'IA (sur 100)",
      aiRecommendationsTitle: "Recommandations de l'IA",
      aiStrategyDescription: "Stratégie optimisée par l'IA pour maximiser les revenus",
      errorFetchingData: "Erreur lors de la récupération des données",
      refreshing: "Rafraîchissement en cours..."
    },
    en: {
      errorRefreshing: "Error refreshing",
      errorFetchingGroup: "Error fetching group",
      loadingKPIs: "Loading AI performance indicators",
      loadingRecommendations: "Loading AI recommendations",
      aiGainDescription: "AI-generated gains over the period",
      aiScoreDescription: "AI performance score (out of 100)",
      aiRecommendationsTitle: "AI Recommendations",
      aiStrategyDescription: "AI-optimized strategy to maximize revenue",
      errorFetchingData: "Error fetching data",
      refreshing: "Refreshing..."
    }
  };
  
  return prompts[language] || prompts.en;
}; 

const fallbackPropertyImages = [
  'https://images.unsplash.com/photo-1505691938895-1758d7feb511?auto=format&fit=crop&w=900&q=60',
  'https://images.unsplash.com/photo-1493809842364-78817add7ffb?auto=format&fit=crop&w=900&q=60',
  'https://images.unsplash.com/photo-1505691723518-36a5ac3be353?auto=format&fit=crop&w=900&q=60',
  'https://images.unsplash.com/photo-1505852679233-d9fd70aff56d?auto=format&fit=crop&w=900&q=60',
  'https://images.unsplash.com/photo-1484154218962-a197022b5858?auto=format&fit=crop&w=900&q=60',
];

// --- Icônes SVG ---
const LocationIcon = ({ className = '' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={`w-4 h-4 ${className}`}>
    <path d="M12 21s7-4.35 7-11a7 7 0 0 0-14 0c0 6.65 7 11 7 11z" />
    <circle cx="12" cy="10" r="3" />
  </svg>
);

const HomeIcon = ({ className = '' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={`w-4 h-4 ${className}`}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 10.5V21h5v-6h4v6h5v-10.5" />
  </svg>
);

const UsersIcon = ({ className = '' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={`w-4 h-4 ${className}`}>
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

const TrendIcon = ({ className = '' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={`w-3.5 h-3.5 ${className}`}>
    <polyline points="17 11 21 7 23 9" />
    <path d="M3 17l6-6 4 4 8-8" />
  </svg>
);

const RevenueIcon = ({ className = '' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={`w-6 h-6 ${className}`}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 6v12" />
    <path d="M16 8H9.5a2.5 2.5 0 0 0 0 5H14a2.5 2.5 0 0 1 0 5H8" />
  </svg>
);

const OccupancyIcon = ({ className = '' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={`w-6 h-6 ${className}`}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18" />
    <path d="M9 21V9" />
    <path d="M15 21V9" />
  </svg>
);

const AdrIcon = ({ className = '' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={`w-6 h-6 ${className}`}>
    <path d="M3 6l3 0" />
    <path d="M3 10l5 0" />
    <path d="M3 14l3 0" />
    <path d="M3 18l5 0" />
    <path d="M12 4h9v16h-9z" />
    <path d="M16 8h.01" />
    <path d="M16 12h.01" />
    <path d="M16 16h.01" />
  </svg>
);

const AiIcon = ({ className = '' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={`w-6 h-6 ${className}`}>
    <path d="M12 3 1 9l11 6 9-4.91V17" />
    <path d="M5 10.74v4.55c0 .16.08.31.21.4l6.79 4.53a.5.5 0 0 0 .54 0l6.79-4.54a.5.5 0 0 0 .21-.41V10.7" />
    <path d="M9 21h6" />
  </svg>
);

const PlusIcon = ({ className = '' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`w-4 h-4 ${className}`}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

function DashboardPage({ token, userProfile }) { 
  const { t, language } = useLanguage();
  const [properties, setProperties] = useState([]);
  const [allGroups, setAllGroups] = useState([]);
  const [isLoading, setIsLoading] = useState(true); 
  const [isKpiLoading, setIsKpiLoading] = useState(true); 
  const [error, setError] = useState('');
  
  const [editingProperty, setEditingProperty] = useState(null);
  const [editingGroup, setEditingGroup] = useState(null);
  const [groupsRefreshKey, setGroupsRefreshKey] = useState(0); 
  const [isPropertyModalOpen, setIsPropertyModalOpen] = useState(false);
  const [isStrategyModalOpen, setIsStrategyModalOpen] = useState(false);
  const [isRulesModalOpen, setIsRulesModalOpen] = useState(false);
  
  const [openMenuId, setOpenMenuId] = useState(null);

  const [kpis, setKpis] = useState({
    totalRevenue: 0,
    avgOccupancy: 0,
    adr: 0,
    iaGain: 0, 
    iaScore: 0, 
  });
  
  const [recommendations, setRecommendations] = useState([]);
  const [isRecLoading, setIsRecLoading] = useState(true);
  
  const [selectedStatus, setSelectedStatus] = useState('active'); 
  const [selectedGroupId, setSelectedGroupId] = useState('');

  // État pour la modale de confirmation
  const [confirmModal, setConfirmModal] = useState({ isOpen: false, message: '', onConfirm: null }); 


  // Fonction de rafraîchissement des groupes et propriétés (sans condition de modale)
  const refreshGroupsAndProperties = useCallback(async () => {
    if (!token) return;
    const currentLanguage = userProfile?.language || language || 'en';
    const prompts = getAIPrompts(currentLanguage);
    try {
      const [propertiesData, groupsData] = await Promise.all([
          getProperties(token),
          getGroups(token) 
      ]);
      
      setProperties(propertiesData);
      setAllGroups(groupsData); 
    } catch (err) {
      console.error(`${prompts.errorRefreshing}:`, err);
    }
  }, [token, userProfile?.language, language]);

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

      const currentLanguage = userProfile?.language || language || 'en';
      const prompts = getAIPrompts(currentLanguage);
      
      if (userProfile) {
          const { startDate, endDate } = getDatesFromRange('1m', userProfile.timezone); 
          try {
            const kpiData = await getReportKpis(token, startDate, endDate);
            setKpis({
                totalRevenue: kpiData.totalRevenue || 0,
                avgOccupancy: kpiData.occupancy || 0,
                adr: kpiData.adr || 0,
                iaGain: kpiData.iaGain || 0,
                iaScore: kpiData.iaScore || 0,
            });
          } catch (kpiError) {
            console.error(`${prompts.errorFetchingData} (KPIs):`, kpiError);
          }
      }
      
      try {
        const recs = await getGroupRecommendations(token);
        setRecommendations(recs);
      } catch (recError) {
        console.error(`${prompts.errorFetchingData} (${prompts.aiRecommendationsTitle}):`, recError);
        setRecommendations([]);
      }

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

  const handleOpenStrategyModal = async (item) => {
    setOpenMenuId(null);
    const currentLanguage = userProfile?.language || language || 'en';
    const prompts = getAIPrompts(currentLanguage);
    // Si c'est un groupe, récupérer les données les plus récentes depuis le serveur
    if (!item.address && item.id) {
      try {
        const groups = await getGroups(token);
        const updatedGroup = groups.find(g => g.id === item.id);
        if (updatedGroup) {
          setEditingGroup(updatedGroup);
        } else {
          setEditingGroup(item);
        }
      } catch (err) {
        console.error(`${prompts.errorFetchingGroup}:`, err);
        setEditingGroup(item);
      }
    } else {
      setEditingProperty(item);
    }
    setIsStrategyModalOpen(true);
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
    setConfirmModal({
      isOpen: true,
      message: t('dashboard.property.deleteConfirm'),
      onConfirm: async () => {
        try {
          await deleteProperty(propertyId, token);
          fetchInitialData(); 
        } catch (err) {
          setError(err.message);
        }
      }
    });
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


  const handleModalSave = async () => {
    setIsPropertyModalOpen(false);
    setIsStrategyModalOpen(false);
    setIsRulesModalOpen(false);
    setEditingProperty(null); 
    setEditingGroup(null);
    // Rafraîchir immédiatement les groupes et propriétés
    await refreshGroupsAndProperties();
    // Forcer le rafraîchissement de GroupsManager
    setGroupsRefreshKey(prev => prev + 1);
  };
  
  const handleModalClose = () => {
    setIsPropertyModalOpen(false);
    setIsStrategyModalOpen(false);
    setIsRulesModalOpen(false);
    setEditingProperty(null); 
    setEditingGroup(null);
  }
  
  const formatCurrency = (amount) => {
      const locale = language === 'en' ? 'en-US' : 'fr-FR';
      return (amount || 0).toLocaleString(locale, { 
          style: 'currency', 
          currency: userProfile?.currency || 'EUR', 
          minimumFractionDigits: 0, 
          maximumFractionDigits: 0 
      });
  };
   const formatCurrencyAdr = (amount) => {
      const locale = language === 'en' ? 'en-US' : 'fr-FR';
      return (amount || 0).toLocaleString(locale, { 
          style: 'currency', 
          currency: userProfile?.currency || 'EUR', 
          minimumFractionDigits: 2 
      });
  };
  
  const statsCards = useMemo(() => {
    const currentLanguage = userProfile?.language || language || 'en';
    const prompts = getAIPrompts(currentLanguage);
    return [
      {
        id: 'totalRevenue',
        title: t('dashboard.kpi.revenue'),
        value: formatCurrency(kpis.totalRevenue),
        helper: t('dashboard.kpi.revenueHelper'),
        icon: RevenueIcon,
      },
      {
        id: 'avgOccupancy',
        title: t('dashboard.kpi.occupancy'),
        value: `${(kpis.avgOccupancy || 0).toFixed(1)}%`,
        helper: t('dashboard.kpi.occupancyHelper'),
        icon: OccupancyIcon,
      },
      {
        id: 'adr',
        title: t('dashboard.kpi.adr'),
        value: formatCurrencyAdr(kpis.adr),
        helper: t('dashboard.kpi.adrHelper'),
        icon: AdrIcon,
      },
      {
        id: 'iaGain',
        title: t('dashboard.kpi.iaGain'),
        value: formatCurrency(kpis.iaGain),
        helper: prompts.aiGainDescription || t('dashboard.kpi.iaGainHelper'),
        icon: AiIcon,
      },
    ];
  }, [kpis, userProfile?.language, language, t]);
  
  const renderStatsCards = () => (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
      {statsCards.map(({ id, title, value, helper, icon: Icon }) => (
        <div
          key={id}
          className="bg-global-bg-box rounded-[14px] border border-solid border-global-stroke-box p-4 flex flex-col gap-2 items-start justify-center flex-1 relative overflow-hidden"
        >
          <div className="flex flex-row items-center justify-between self-stretch shrink-0 relative w-full">
            <div className="flex flex-col gap-0 items-start justify-start flex-1 relative min-w-0">
              <div className="text-global-inactive text-left font-p1-font-family text-p1-font-size font-p1-font-weight relative">
                {title}
              </div>
              <div className="text-global-blanc text-left font-h1-font-family text-h1-font-size font-h1-font-weight font-bold relative">
                {value || '—'}
              </div>
              {helper && (
                <div className="text-global-inactive text-left text-xs font-normal relative mt-1">
                  {helper}
                </div>
              )}
            </div>
            <div
              className="rounded-[10px] border border-solid border-global-stroke-highlight-2nd flex flex-col gap-2.5 items-center justify-center shrink-0 w-[50px] h-[50px] relative"
              style={{
                background: 'linear-gradient(90deg, rgba(21, 93, 252, 0.20) 0%, rgba(0, 146, 184, 0.20) 100%)',
                aspectRatio: '1',
              }}
            >
              <Icon className="w-6 h-6 text-global-content-highlight-2nd" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
  
  const getStatusBadge = (status) => {
      const statusMap = {
        active: {
          label: t('dashboard.statusLabels.active'),
          className: 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
        },
        archived: {
          label: t('dashboard.statusLabels.archived'),
          className: 'bg-gray-500/10 border border-gray-500/20 text-gray-400'
        },
        error: {
          label: t('dashboard.statusLabels.error'),
          className: 'bg-red-500/10 border border-red-500/20 text-red-400'
        },
        default: {
          label: t('dashboard.statusLabels.unknown'),
          className: 'bg-yellow-500/10 border border-yellow-500/20 text-yellow-400'
        }
      };
      const { label, className } = statusMap[status] || statusMap.default;
      return (
        <span className={`px-2.5 py-0.5 text-[10px] font-semibold rounded-full uppercase tracking-wide ${className}`}>
          {label}
        </span>
      );
  };

  const renderPropertyCards = () => {
    if (isLoading) {
      return <p className="text-center text-text-muted col-span-full py-8">{t('dashboard.loadingProperties')}</p>;
    }

    if (error && properties.length === 0) { 
      return <p className="text-center text-red-400 col-span-full py-8">{t('common.error')}: {error}</p>;
    }

    if (properties.length === 0) {
      return (
        <div className="text-center bg-global-bg-box border border-global-stroke-box p-8 rounded-[14px] col-span-full">
          <h3 className="text-xl font-semibold text-global-blanc">{t('dashboard.noProperties')}</h3>
          <p className="text-global-inactive mt-2">{t('dashboard.noPropertiesMessage')}</p>
        </div>
      );
    }
    
    if (filteredProperties.length === 0) {
       return (
        <div className="text-center bg-global-bg-box border border-global-stroke-box p-8 rounded-[14px] col-span-full">
          <h3 className="text-xl font-semibold text-global-blanc">{t('dashboard.noFilteredProperties')}</h3>
          <p className="text-global-inactive mt-2">{t('dashboard.noFilteredPropertiesMessage')}</p>
        </div>
      );
    }

    return filteredProperties.map((prop, index) => {
      const group = getGroupForProperty(prop.id);
      const isSynced = group && group.syncPrices;
      const coverImage = prop.coverImage || prop.imageUrl || prop.photoUrl || fallbackPropertyImages[index % fallbackPropertyImages.length];
      const propertyType = prop.property_type || prop.type || 'Villa';
      const capacityLabel = prop.capacity ? `${prop.capacity} ${t('dashboard.property.capacity')}` : t('dashboard.property.capacityNA');
      const monthlyRevenue = Number(prop.monthly_revenue ?? prop.monthlyRevenue ?? prop.metrics?.monthlyRevenue ?? (prop.daily_revenue ? prop.daily_revenue * 30 : 0));
      const targetRevenueRaw = Number(prop.target_revenue ?? prop.targetRevenue ?? prop.metrics?.targetRevenue ?? (monthlyRevenue ? monthlyRevenue * 1.15 : 0));
      const targetRevenue = Number.isFinite(targetRevenueRaw) ? targetRevenueRaw : 0;
      const revenueTrendValue = typeof prop.revenueGrowth === 'number'
        ? prop.revenueGrowth
        : typeof prop.metrics?.revenueGrowth === 'number'
          ? prop.metrics.revenueGrowth
          : null;
      const revenueTrendLabel = revenueTrendValue !== null ? `${revenueTrendValue > 0 ? '+' : ''}${revenueTrendValue.toFixed(1)}%` : null;
      const revenueTrendClass = revenueTrendValue !== null && revenueTrendValue >= 0 ? 'text-global-positive-impact' : 'text-red-400';
      const progress = targetRevenue ? Math.min(100, Math.round((monthlyRevenue / targetRevenue) * 100)) : 0;
    
      return (
        <div
          key={prop.id}
          className="bg-global-bg-box border border-global-stroke-box rounded-[14px] overflow-hidden shadow-lg flex flex-col group hover:border-global-content-highlight-2nd/30 transition-colors duration-300"
        >
          <div className="relative h-48 shrink-0 overflow-hidden">
            <img
              src={coverImage}
              alt={prop.address || 'Propriété'}
              className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
              loading="lazy"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
            
            <div className="absolute top-3 right-3">
               {getStatusBadge(prop.status || 'active')}
            </div>

            {isSynced && (
              <div className="absolute top-3 left-3 bg-blue-600/90 backdrop-blur-md px-2.5 py-1 rounded-full text-[10px] font-bold text-white flex items-center gap-1.5 border border-blue-400/30 shadow-lg">
                <span className="text-xs">⚙️</span>
                {t('dashboard.property.sync')} {group?.name}
              </div>
            )}
            
            <div className="absolute bottom-3 left-4 right-4">
               <h3 className="text-white font-bold text-lg truncate shadow-black drop-shadow-md">
                  {prop.address || t('dashboard.property.propertyNoName')}
                </h3>
                 <div className="flex items-center gap-2 text-gray-300 text-xs mt-0.5 truncate">
                  <LocationIcon className="w-3 h-3" />
                  <span>{prop.location || t('dashboard.property.locationUnknown')}</span>
                </div>
            </div>
          </div>

          <div className="p-5 flex flex-col gap-5 flex-1">
            <div className="flex items-center justify-between text-xs text-global-inactive border-b border-global-stroke-box pb-4">
                <div className="flex items-center gap-4">
                    <span className="flex items-center gap-1.5">
                    <HomeIcon className="w-3.5 h-3.5" />
                    {propertyType}
                    </span>
                    <span className="flex items-center gap-1.5">
                    <UsersIcon className="w-3.5 h-3.5" />
                    {capacityLabel}
                    </span>
                </div>
                <span className="bg-global-bg-small-box px-2 py-1 rounded text-[10px]">
                  {prop.amenities?.length || 0} {t('dashboard.property.equipment')}
                </span>
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-global-inactive">{t('dashboard.property.monthlyRevenue')}</span>
                {revenueTrendLabel && (
                  <span className={`flex items-center gap-1 text-xs font-medium ${revenueTrendClass}`}>
                    <TrendIcon className="w-3 h-3" />
                    {revenueTrendLabel}
                  </span>
                )}
              </div>
              <div className="flex items-baseline gap-2 mb-1">
                <span className="text-global-blanc font-bold text-xl">
                  {formatCurrency(monthlyRevenue)}
                </span>
                {targetRevenue > 0 && (
                  <span className="text-global-inactive text-xs">
                    / {formatCurrency(targetRevenue)}
                  </span>
                )}
              </div>
              <div className="w-full h-1.5 rounded-full bg-global-bg-muted overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-[#155dfc] to-[#12a1d5] rounded-full"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>

            <div className="flex items-center gap-2 mt-auto pt-2">
              <button
                onClick={() => handleOpenStrategyModal(prop)}
                className="flex-1 bg-global-bg-small-box border border-global-stroke-box hover:border-global-content-highlight-2nd text-global-blanc text-xs font-medium py-2 rounded-[8px] transition-colors"
              >
                {t('dashboard.property.strategyAI')}
              </button>
              <button
                onClick={() => handleOpenRulesModal(prop)}
                className="flex-1 bg-global-bg-small-box border border-global-stroke-box hover:border-purple-500/50 text-global-blanc text-xs font-medium py-2 rounded-[8px] transition-colors"
              >
                {t('dashboard.property.rules')}
              </button>
              <div className="relative action-menu-container">
                <button
                  type="button"
                  onClick={() => setOpenMenuId(openMenuId === prop.id ? null : prop.id)}
                  className="w-9 h-9 flex items-center justify-center bg-global-bg-small-box border border-global-stroke-box rounded-[8px] text-global-inactive hover:text-white hover:border-global-content-highlight-2nd transition-colors"
                >
                  ⋮
                </button>
                {openMenuId === prop.id && (
                  <div className="absolute right-0 bottom-full mb-2 w-40 bg-global-bg-box border border-global-stroke-box rounded-lg shadow-xl z-20 py-1 overflow-hidden">
                    <button onClick={() => handleOpenEditModal(prop)} className="block w-full text-left px-4 py-2 text-xs text-global-inactive hover:bg-global-bg-small-box hover:text-white transition-colors">
                        {t('dashboard.property.edit')}
                    </button>
                    {prop.status !== 'active' && (
                        <button onClick={() => handleSetStatus(prop.id, 'active')} className="block w-full text-left px-4 py-2 text-xs text-green-400 hover:bg-global-bg-small-box transition-colors">
                            {t('dashboard.property.activate')}
                        </button>
                    )}
                     {prop.status === 'active' && (
                        <button onClick={() => handleSetStatus(prop.id, 'archived')} className="block w-full text-left px-4 py-2 text-xs text-global-inactive hover:bg-global-bg-small-box transition-colors">
                            {t('dashboard.property.archive')}
                        </button>
                     )}
                     <button onClick={() => handleSetStatus(prop.id, 'error')} className="block w-full text-left px-4 py-2 text-xs text-yellow-400 hover:bg-global-bg-small-box transition-colors">
                        {t('dashboard.property.markError')}
                    </button>
                    <div className="h-px bg-global-stroke-box my-1" />
                    <button onClick={() => handleDelete(prop.id)} className="block w-full text-left px-4 py-2 text-xs text-red-400 hover:bg-red-500/10 transition-colors">
                        {t('dashboard.property.delete')}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      );
    });
  };

  return (
    <div className="relative min-h-screen">
      {/* Fond qui couvre tout l'écran avec le même dégradé qu'avant */}
      <div
        className="fixed inset-0"
        style={{
          background:
            'linear-gradient(135deg, rgba(2,6,24,1) 0%, rgba(22,36,86,1) 45%, rgba(15,23,43,1) 100%)',
          zIndex: 0,
        }}
      />
      <div className="relative z-10 p-4 md:p-6 lg:p-8 space-y-6 lg:space-y-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-global-inactive mb-1">
              {t('dashboard.overview')}
            </p>
            <h1 className="text-3xl md:text-4xl font-h1-font-family font-bold text-global-blanc">
              {t('dashboard.title')}
            </h1>
          </div>
          <button
            onClick={handleOpenAddModal}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-[12px] text-white font-semibold bg-gradient-to-r from-[#155dfc] to-[#12a1d5] shadow-lg hover:opacity-90 transition-opacity text-sm"
          >
            <PlusIcon />
            {t('dashboard.addProperty')}
          </button>
        </div>
        
        {error && (
          <div className="bg-red-900/20 border border-red-500/30 p-4 rounded-[12px] text-red-200 text-sm">
            {error}
          </div>
        )}

        {/* Stats Cards */}
        {isKpiLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            {[...Array(4)].map((_, index) => (
              <div
                key={index}
                className="bg-global-bg-box border border-global-stroke-box rounded-[14px] p-5 animate-pulse h-32"
              />
            ))}
          </div>
        ) : (
          renderStatsCards()
        )}

        {/* IA Recommendations */}
        {!isRecLoading && recommendations.length > 0 && (
          <div className="bg-global-bg-box border border-global-stroke-box rounded-[14px] p-6 shadow-lg">
            <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-global-inactive mb-1">
                  {t('dashboard.aiRecommendations')}
                </p>
                <h2 className="text-xl font-bold text-global-blanc">
                  {t('dashboard.groupSuggestions')}
                </h2>
              </div>
              <button
                onClick={fetchInitialData}
                className="text-xs px-4 py-2 rounded-full border border-global-stroke-box text-global-inactive hover:text-global-blanc hover:border-global-content-highlight-2nd transition-colors"
              >
                {t('dashboard.refresh')}
              </button>
            </div>
            <div>
                <GroupRecommendations
                  token={token}
                  recommendations={recommendations}
                  onGroupCreated={fetchInitialData}
                />
            </div>
          </div>
        )}

        {/* Main Content Area */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-8 items-stretch">
          
          {/* Left Column: Groups & Properties */}
          <div className="xl:col-span-2 flex flex-col gap-8">
            
            {/* Groups Manager */}
            <GroupsManager
              token={token}
              properties={properties}
              onGroupChange={fetchInitialData}
              onEditStrategy={handleOpenStrategyModal}
              onEditRules={handleOpenRulesModal}
              userProfile={userProfile}
              refreshKey={groupsRefreshKey}
            />

            {/* Properties List */}
            <div className="bg-global-bg-box border border-global-stroke-box rounded-[14px] p-6 shadow-lg">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.2em] text-global-inactive mb-1">
                    {t('dashboard.inventory')}
                  </p>
                  <h2 className="text-xl font-bold text-global-blanc">
                    {t('dashboard.propertiesTitle')} ({filteredProperties.length})
                  </h2>
                </div>
                <div className="flex flex-wrap gap-3 w-full sm:w-auto">
                  <select
                    value={selectedGroupId}
                    onChange={(e) => setSelectedGroupId(e.target.value)}
                    className="flex-1 sm:flex-none bg-global-bg-small-box border border-global-stroke-box rounded-[10px] px-3 py-2 text-xs text-global-blanc focus:outline-none focus:border-global-content-highlight-2nd transition-colors cursor-pointer"
                  >
                    <option value="">{t('dashboard.allGroups')}</option>
                    {allGroups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={selectedStatus}
                    onChange={(e) => setSelectedStatus(e.target.value)}
                    className="flex-1 sm:flex-none bg-global-bg-small-box border border-global-stroke-box rounded-[10px] px-3 py-2 text-xs text-global-blanc focus:outline-none focus:border-global-content-highlight-2nd transition-colors cursor-pointer"
                  >
                    <option value="active">{t('dashboard.status.active')}</option>
                    <option value="archived">{t('dashboard.status.archived')}</option>
                    <option value="error">{t('dashboard.status.error')}</option>
                    <option value="">{t('dashboard.status.all')}</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {renderPropertyCards()}
              </div>
            </div>
          </div>

          {/* Right Column: News Feed */}
          <div className="xl:col-span-1 flex flex-col h-full">
             <NewsFeed token={token} userProfile={userProfile} />
          </div>

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
          item={editingGroup || editingProperty} 
          itemType={editingGroup ? 'group' : 'property'}
          onGroupStrategyUpdated={editingGroup ? async (updatedGroup) => {
            // Rafraîchir les données depuis le serveur
            await refreshGroupsAndProperties();
            // Forcer le rafraîchissement de GroupsManager
            setGroupsRefreshKey(prev => prev + 1);
          } : undefined}
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
      <ConfirmModal
        isOpen={confirmModal.isOpen}
        onClose={() => setConfirmModal({ isOpen: false, message: '', onConfirm: null })}
        onConfirm={confirmModal.onConfirm || (() => {})}
        title={t('confirmModal.title')}
        message={confirmModal.message}
        confirmText={t('common.confirm')}
        cancelText={t('common.cancel')}
      />
    </div>
  );
}

export default DashboardPage;