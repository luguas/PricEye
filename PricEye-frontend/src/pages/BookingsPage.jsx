import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { getProperties, getTeamBookings, deleteBooking } from '../services/api.js';
import Pastille from '../components/Pastille.jsx';
import ConfirmModal from '../components/ConfirmModal.jsx';
import RechercheRSa from '../components/RechercheRSa.jsx';
import BookingsCalendar from '../components/BookingsCalendar.jsx';
import { useLanguage } from '../contexts/LanguageContext.jsx';
// import { getDatesFromRange } from '../utils/dateUtils.js'; // Remplacé par une logique locale

/**
 * Composant pour le filtre multi-sélection de propriétés
 */
function MultiPropertyFilter({ properties, selectedIds, onChange }) {
  const { t } = useLanguage();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);

  // Gérer la fermeture au clic extérieur
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('click', handleClickOutside, true);
    return () => document.removeEventListener('click', handleClickOutside, true);
  }, []);

  const handleSelectAll = (e) => {
    e.stopPropagation();
    if (selectedIds.length === properties.length) {
      onChange([]); // Désélectionner tout
    } else {
      onChange(properties.map(p => p.id)); // Sélectionner tout
    }
  };

  const handleCheckboxChange = (e, propertyId) => {
    e.stopPropagation();
    const newSelectedIds = [...selectedIds];
    if (newSelectedIds.includes(propertyId)) {
      onChange(newSelectedIds.filter(id => id !== propertyId));
    } else {
      onChange([...newSelectedIds, propertyId]);
    }
  };

  const getButtonText = () => {
    if (selectedIds.length === 0 || selectedIds.length === properties.length) {
      return t('bookings.allProperties');
    }
    if (selectedIds.length === 1) {
      const prop = properties.find(p => p.id === selectedIds[0]);
      return prop?.address || t('bookings.oneProperty');
    }
    return `${selectedIds.length} ${t('bookings.propertiesSelected')}`;
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full bg-global-bg-small-box border border-global-stroke-box rounded-[10px] px-3 py-2 text-global-blanc font-h4-font-family text-h4-font-size text-left flex justify-between items-center focus:outline-none focus:ring-2 focus:ring-global-content-highlight-2nd"
      >
        <span className="truncate">{getButtonText()}</span>
        <span className="ml-2 text-global-inactive">▼</span>
      </button>

      {isOpen && (
        <div className="absolute z-10 w-full mt-1 bg-global-bg-box border border-global-stroke-box rounded-[10px] shadow-lg max-h-60 overflow-y-auto">
          <div className="p-2 border-b border-global-stroke-box">
            <button
              type="button"
              onClick={handleSelectAll}
              className="text-xs text-global-content-highlight-2nd hover:text-global-blanc font-p1-font-family"
            >
              {selectedIds.length === properties.length ? t('bookings.deselectAll') : t('bookings.selectAll')}
            </button>
          </div>
          <div className="p-2 space-y-1">
            {properties.map(prop => (
              <label key={prop.id} className="flex items-center gap-2 text-sm text-global-blanc cursor-pointer font-p1-font-family hover:bg-global-bg-small-box p-1 rounded">
                <input
                  type="checkbox"
                  checked={selectedIds.includes(prop.id)}
                  onChange={(e) => handleCheckboxChange(e, prop.id)}
                  className="w-4 h-4 rounded border border-global-stroke-box bg-global-bg-small-box text-global-content-highlight-2nd focus:ring-2 focus:ring-global-content-highlight-2nd"
                />
                {prop.address}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}


/**
 * Page principale des Réservations
 */
function BookingsPage({ token, userProfile }) {
  const { t, language } = useLanguage();
  const [allProperties, setAllProperties] = useState([]);
  const [allBookings, setAllBookings] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  // États des filtres
  const [dateRange, setDateRange] = useState('all_time'); // Défaut sur tout le temps
  const [selectedPropertyIds, setSelectedPropertyIds] = useState([]);
  const [selectedChannel, setSelectedChannel] = useState('');
  const [minPrice, setMinPrice] = useState('');
  const [selectedStatus, setSelectedStatus] = useState(''); // NOUVEAU
  const [selectedPricingMethod, setSelectedPricingMethod] = useState(''); // NOUVEAU
  const [searchQuery, setSearchQuery] = useState(''); // Recherche de propriété
  const [showFilters, setShowFilters] = useState(false); // Afficher/masquer les filtres
  const [activeView, setActiveView] = useState('table'); // 'table' ou 'calendar'
  const [selectedDateBookings, setSelectedDateBookings] = useState([]); // Réservations pour la date sélectionnée dans le calendrier
  const [selectedDate, setSelectedDate] = useState(null); // Date sélectionnée dans le calendrier
  const [showBookingDetails, setShowBookingDetails] = useState(false); // Afficher le modal de détails
  const [confirmModal, setConfirmModal] = useState({ isOpen: false, message: '', onConfirm: null });

  // Créer un map pour un accès rapide aux noms des propriétés
  const propertyMap = useMemo(() => {
    return new Map(allProperties.map(p => [p.id, p.address]));
  }, [allProperties]);

  // Créer une liste de canaux uniques
  const uniqueChannels = useMemo(() => {
      const channels = new Set(allBookings.map(b => b.channel));
      return Array.from(channels);
  }, [allBookings]);

  // Récupérer les propriétés (pour le filtre) et les réservations
  const fetchData = useCallback(async () => {
    if (!userProfile) return;
    
    setIsLoading(true);
    setError('');
    try {
      // Logique de date maintenant gérée localement
      const { startDate, endDate } = (() => {
          const timeZone = userProfile.timezone || 'UTC';
          const formatDate = (date) => date.toISOString().split('T')[0];
          
          const getZonedDate = () => {
              const formatter = new Intl.DateTimeFormat('en-CA', {
                  year: 'numeric', month: '2-digit', day: '2-digit', timeZone: timeZone,
              });
              const dateString = formatter.format(new Date());
              return new Date(Date.UTC(
                  parseInt(dateString.substring(0, 4)),
                  parseInt(dateString.substring(5, 7)) - 1, 
                  parseInt(dateString.substring(8, 10))
              ));
          };

          const today = getZonedDate();
          let start = getZonedDate();
          let end = getZonedDate();

          switch (dateRange) {
              case 'all_time':
                  // Pour "tout le temps", on récupère sur une large plage (5 ans passés et 2 ans futurs)
                  start = new Date(Date.UTC(today.getUTCFullYear() - 5, 0, 1));
                  end = new Date(Date.UTC(today.getUTCFullYear() + 2, 11, 31));
                  break;
              case 'next_30d':
                  end.setUTCDate(today.getUTCDate() + 30);
                  break;
              case 'next_90d':
                  end.setUTCDate(today.getUTCDate() + 90);
                  break;
              case 'this_month':
                  start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
                  end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
                  break;
              case 'last_7d':
                  start.setUTCDate(today.getUTCDate() - 7);
                  break;
              case 'last_30d':
              default:
                  start.setUTCDate(today.getUTCDate() - 30);
                  break;
          }
          
          if (dateRange.startsWith('last_')) {
              end = getZonedDate();
          }
          if (dateRange.startsWith('next_')) {
              start = getZonedDate();
          }

          return { startDate: formatDate(start), endDate: formatDate(end) };
      })();
      
      // Récupérer les propriétés et les réservations en parallèle
      const [propertiesData, bookingsData] = await Promise.all([
        getProperties(token),
        getTeamBookings(token, startDate, endDate)
      ]);

      setAllProperties(propertiesData);
      setAllBookings(bookingsData);
      
    } catch (err) {
      setError(t('bookings.errors.loadError', { message: err.message }));
    } finally {
      setIsLoading(false);
    }
  }, [token, dateRange, userProfile, t]);

  useEffect(() => {
    fetchData();
  }, [fetchData]); // Se déclenche au montage et si dateRange ou userProfile change

  // Filtrer les réservations côté client
  const filteredBookings = useMemo(() => {
    
    // 1. Filtrer les réservations orphelines
    const validBookings = allBookings.filter(booking => 
        propertyMap.has(booking.propertyId)
    );

    // 2. Appliquer les filtres de l'utilisateur
    return validBookings.filter(booking => {
        // Filtre Recherche (par nom de propriété)
        if (searchQuery) {
            const propertyName = propertyMap.get(booking.propertyId) || '';
            if (!propertyName.toLowerCase().includes(searchQuery.toLowerCase())) {
                return false;
            }
        }
        // Filtre Propriété
        if (selectedPropertyIds.length > 0 && !selectedPropertyIds.includes(booking.propertyId)) {
            return false;
        }
        // Filtre Canal
        if (selectedChannel && booking.channel !== selectedChannel) {
            return false;
        }
        // Filtre Prix Min
        if (minPrice && (booking.totalPrice || 0) < parseInt(minPrice, 10)) {
            return false;
        }
        // NOUVEAU: Filtre Statut
        if (selectedStatus && (booking.status || 'confirmé') !== selectedStatus) {
            return false;
        }
        // NOUVEAU: Filtre Méthode de Prix
        if (selectedPricingMethod && (booking.pricingMethod || 'ia') !== selectedPricingMethod) {
            return false;
        }
        
        return true; // La réservation passe tous les filtres
    });
  }, [allBookings, selectedPropertyIds, propertyMap, selectedChannel, minPrice, selectedStatus, selectedPricingMethod, searchQuery]); // Ajout de searchQuery

  // Helper pour formater la devise
  const formatCurrency = (amount) => {
    const locale = language === 'en' ? 'en-US' : 'fr-FR';
    return (amount || 0).toLocaleString(locale, { 
        style: 'currency', 
        currency: userProfile?.currency || 'EUR',
        minimumFractionDigits: 2
    });
  };

  // Helper pour calculer les nuits
  const calculateNights = (startDate, endDate) => {
      const start = new Date(startDate);
      const end = new Date(endDate);
      const diffTime = Math.abs(end - start);
      return Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
  };

  // Helper pour formater la date au format DD/MM/YYYY ou MM/DD/YYYY selon la langue
  const formatDate = (dateString) => {
    if (!dateString) return '';
    const date = new Date(dateString);
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    if (language === 'en') {
      return `${month}/${day}/${year}`;
    }
    return `${day}/${month}/${year}`;
  };

  // Helper pour badge de statut avec Pastille
  const getStatusBadge = (status) => {
      status = status || 'confirmé'; // Défaut
      const statusLower = status.toLowerCase();
      let statusText = status;
      
      // Traduire les statuts connus
      if (statusLower === 'confirmé' || statusLower === 'confirmed') {
          statusText = t('bookings.confirmed');
      } else if (statusLower === 'en attente' || statusLower === 'pending') {
          statusText = t('bookings.pending');
      } else if (statusLower === 'annulée' || statusLower === 'annulé' || statusLower === 'cancelled') {
          statusText = t('bookings.cancelled');
      }
      
      switch(statusLower) {
          case 'confirmé':
          case 'confirmed':
              return <Pastille text={statusText} className="!bg-calendrierbg-vert !border-calendrierstroke-vert" />;
          case 'en attente':
          case 'pending':
              return <Pastille text={statusText} className="!bg-calendrierbg-bleu !border-calendrierstroke-bleu" />;
          case 'annulée':
          case 'annulé':
          case 'cancelled':
              return <Pastille text={statusText} className="!bg-calendrierbg-orange !border-calendrierstroke-orange" />;
          default:
              return <Pastille text={statusText} className="!bg-global-bg-small-box !border-global-stroke-box" />;
      }
  };
  
  // Helper pour badge de canal avec Pastille
  const getChannelBadge = (channel) => {
      if (!channel) return null;
      return <Pastille text={channel} className="!bg-global-bg-small-box !border-global-stroke-box" />;
  };
  
  // Gestion du clic sur une date du calendrier
  const handleBookingClick = (bookings, date) => {
    setSelectedDateBookings(bookings);
    setSelectedDate(date);
    setShowBookingDetails(true);
  };

  // Suppression d'une réservation
  const handleDeleteBooking = (booking) => {
    setConfirmModal({
      isOpen: true,
      message: t('bookings.deleteBookingConfirm', {
        start: formatDate(booking.startDate),
        end: formatDate(booking.endDate)
      }),
      onConfirm: async () => {
        try {
          await deleteBooking(booking.propertyId, booking.id, token);
          setError('');
          setShowBookingDetails(false);
          fetchData();
        } catch (err) {
          setError(t('bookings.errors.deleteError', { message: err.message }));
          throw err;
        }
      }
    });
  };

  return (
    <div className="relative min-h-screen">
      {/* Fond qui couvre tout l'écran avec le même dégradé */}
      <div
        className="fixed inset-0"
        style={{
          background:
            'linear-gradient(135deg, rgba(2,6,24,1) 0%, rgba(22,36,86,1) 45%, rgba(15,23,43,1) 100%)',
          zIndex: 0,
        }}
      />
      <div className="relative z-10 space-y-6 p-4 md:p-6 lg:p-8">
        <h2 className="text-3xl font-bold text-text-primary">{t('bookings.title')}</h2>

      {/* Barre de Recherche */}
      <RechercheRSa 
        value={searchQuery}
        onChange={setSearchQuery}
        onFilterClick={() => setShowFilters(!showFilters)}
      />

      {/* Barre de Filtres */}
      {showFilters && (
      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4 p-4 bg-global-bg-box border border-global-stroke-box rounded-[14px]">
        <div>
          <label htmlFor="date-range-selector" className="block text-sm font-medium text-global-inactive mb-1 font-p1-font-family">
            {t('bookings.period')}
          </label>
          <select 
            id="date-range-selector" 
            value={dateRange} 
            onChange={(e) => setDateRange(e.target.value)} 
            className="w-full bg-global-bg-small-box border border-global-stroke-box rounded-[10px] px-3 py-2 text-global-blanc font-h4-font-family text-h4-font-size focus:outline-none focus:ring-2 focus:ring-global-content-highlight-2nd"
          >
            <option value="all_time">{t('bookings.allTime')}</option>
            <option value="next_30d">{t('bookings.next30Days')}</option>
            <option value="next_90d">{t('bookings.next90Days')}</option>
            <option value="this_month">{t('bookings.thisMonth')}</option>
            <option value="last_7d">{t('bookings.last7Days')}</option>
            <option value="last_30d">{t('bookings.last30Days')}</option>
          </select>
        </div>
        
        <div className="lg:col-span-2">
           <label htmlFor="property-filter" className="block text-sm font-medium text-global-inactive mb-1 font-p1-font-family">
            {t('bookings.properties')}
          </label>
          <MultiPropertyFilter
            properties={allProperties}
            selectedIds={selectedPropertyIds}
            onChange={setSelectedPropertyIds}
          />
        </div>
        
        {/* Filtre Canal */}
        <div>
            <label htmlFor="channel-filter" className="block text-sm font-medium text-global-inactive mb-1 font-p1-font-family">
              {t('bookings.channel')}
            </label>
            <select
              id="channel-filter"
              value={selectedChannel}
              onChange={(e) => setSelectedChannel(e.target.value)}
              className="w-full bg-global-bg-small-box border border-global-stroke-box rounded-[10px] px-3 py-2 text-global-blanc font-h4-font-family text-h4-font-size focus:outline-none focus:ring-2 focus:ring-global-content-highlight-2nd"
            >
              <option value="">{t('bookings.allChannels')}</option>
              {uniqueChannels.map(channel => (
                <option key={channel} value={channel}>{channel}</option>
              ))}
            </select>
        </div>
        
        {/* Filtre Statut */}
        <div>
            <label htmlFor="status-filter" className="block text-sm font-medium text-global-inactive mb-1 font-p1-font-family">
              {t('bookings.status')}
            </label>
            <select
              id="status-filter"
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              className="w-full bg-global-bg-small-box border border-global-stroke-box rounded-[10px] px-3 py-2 text-global-blanc font-h4-font-family text-h4-font-size focus:outline-none focus:ring-2 focus:ring-global-content-highlight-2nd"
            >
              <option value="">{t('bookings.allStatuses')}</option>
              <option value="confirmé">{t('bookings.confirmed')}</option>
              <option value="en attente">{t('bookings.pending')}</option>
              <option value="annulée">{t('bookings.cancelled')}</option>
            </select>
        </div>
        
        {/* Filtre Tarification */}
        <div>
            <label htmlFor="pricing-filter" className="block text-sm font-medium text-global-inactive mb-1 font-p1-font-family">
              {t('bookings.pricing')}
            </label>
            <select
              id="pricing-filter"
              value={selectedPricingMethod}
              onChange={(e) => setSelectedPricingMethod(e.target.value)}
              className="w-full bg-global-bg-small-box border border-global-stroke-box rounded-[10px] px-3 py-2 text-global-blanc font-h4-font-family text-h4-font-size focus:outline-none focus:ring-2 focus:ring-global-content-highlight-2nd"
            >
              <option value="">{t('bookings.all')}</option>
              <option value="ia">{t('bookings.ai')}</option>
              <option value="manuelle">{t('bookings.manual')}</option>
            </select>
        </div>

        {/* Filtre Prix */}
        <div className="lg:col-start-5">
            <label htmlFor="min-price-filter" className="block text-sm font-medium text-global-inactive mb-1 font-p1-font-family">
              {t('bookings.minPrice')}
            </label>
            <input
              type="number"
              id="min-price-filter"
              value={minPrice}
              onChange={(e) => setMinPrice(e.target.value)}
              className="w-full bg-global-bg-small-box border border-global-stroke-box rounded-[10px] px-3 py-2 text-global-blanc placeholder:text-global-inactive font-h4-font-family text-h4-font-size focus:outline-none focus:ring-2 focus:ring-global-content-highlight-2nd"
              placeholder={`Ex: 100 (${userProfile?.currency || 'EUR'})`}
            />
        </div>
        
      </div>
      )}
      
      {error && <p className="text-red-400 text-center">{error}</p>}

      {/* Onglets pour basculer entre Tableau et Calendrier */}
      <div className="flex gap-2 border-b border-global-stroke-box">
        <button
          onClick={() => setActiveView('table')}
          className={`px-6 py-3 font-h4-font-family text-h4-font-size transition-colors ${
            activeView === 'table'
              ? 'text-global-content-highlight-2nd border-b-2 border-global-content-highlight-2nd'
              : 'text-global-inactive hover:text-global-blanc'
          }`}
        >
          {t('bookings.viewTable')}
        </button>
        <button
          onClick={() => setActiveView('calendar')}
          className={`px-6 py-3 font-h4-font-family text-h4-font-size transition-colors ${
            activeView === 'calendar'
              ? 'text-global-content-highlight-2nd border-b-2 border-global-content-highlight-2nd'
              : 'text-global-inactive hover:text-global-blanc'
          }`}
        >
          {t('bookings.viewCalendar')}
        </button>
      </div>

      {/* Vue Tableau ou Calendrier */}
      {activeView === 'table' ? (
        /* Tableau des réservations */
      <div className="bg-global-bg-box rounded-[14px] border border-solid border-global-stroke-box flex flex-col gap-0 items-start justify-start self-stretch shrink-0 relative overflow-hidden">
        {/* En-têtes */}
        <div className="border border-solid border-global-stroke-box border-b pt-4 pr-6 pb-4 pl-6 flex flex-row items-center justify-between self-stretch shrink-0 relative">
          <div className="text-global-inactive text-left font-h3-font-family text-h3-font-size font-h3-font-weight relative w-[100px]">
            {t('bookings.property')}
          </div>
          <div className="text-global-inactive text-left font-h3-font-family text-h3-font-size font-h3-font-weight relative w-[100px]">
            {t('bookings.arrivalDate')}
          </div>
          <div className="text-global-inactive text-left font-h3-font-family text-h3-font-size font-h3-font-weight relative w-[100px]">
            {t('bookings.departureDate')}
          </div>
          <div className="text-global-inactive text-left font-h3-font-family text-h3-font-size font-h3-font-weight relative w-[50px]">
            {t('bookings.nights')}
          </div>
          <div className="text-global-inactive text-left font-h3-font-family text-h3-font-size font-h3-font-weight relative w-[100px]">
            {t('bookings.totalPrice')}
          </div>
          <div className="text-global-inactive text-left font-h3-font-family text-h3-font-size font-h3-font-weight relative w-[100px]">
            {t('bookings.pricing')}
          </div>
          <div className="text-global-inactive text-left font-h3-font-family text-h3-font-size font-h3-font-weight relative w-[100px]">
            {t('bookings.channel')}
          </div>
          <div className="text-global-inactive text-left font-h3-font-family text-h3-font-size font-h3-font-weight relative w-[100px]">
            {t('bookings.status')}
          </div>
          <div className="text-global-inactive text-left font-h3-font-family text-h3-font-size font-h3-font-weight relative w-[80px]">
            {t('bookings.deleteBooking')}
          </div>
        </div>

        {/* Contenu */}
        {isLoading ? (
          <div className="border border-solid border-global-stroke-box border-b pt-4 pr-6 pb-4 pl-6 flex flex-row items-center justify-center self-stretch shrink-0 relative">
            <div className="text-center p-8 text-global-inactive">
              <div className="w-8 h-8 border-2 border-global-content-highlight-2nd border-t-transparent rounded-full animate-spin mx-auto mb-2"></div>
              {t('bookings.loading')}
            </div>
          </div>
        ) : filteredBookings.length === 0 ? (
          <div className="border border-solid border-global-stroke-box border-b pt-4 pr-6 pb-4 pl-6 flex flex-row items-center justify-center self-stretch shrink-0 relative">
            <div className="text-center p-8 text-global-inactive">
              {t('bookings.noBookings')}
            </div>
          </div>
        ) : (
          filteredBookings.map((booking, index) => {
            const propertyName = propertyMap.get(booking.propertyId) || t('bookings.unknownProperty');
            const property = allProperties.find(p => p.id === booking.propertyId);
            const propertyAddress = property?.address || propertyName;
            
            return (
              <div 
                key={booking.id} 
                className={`border border-solid border-global-stroke-box ${index < filteredBookings.length - 1 ? 'border-b' : ''} pt-4 pr-6 pb-4 pl-6 flex flex-row items-center justify-between self-stretch shrink-0 relative`}
              >
                <div className="flex flex-col gap-0 items-start justify-start shrink-0 w-[100px] relative">
                  <div className="text-global-blanc text-left font-h3-font-family text-h3-font-size font-h3-font-weight relative">
                    {propertyName}
                  </div>
                  <div className="text-global-inactive text-left font-p1-font-family text-p1-font-size font-p1-font-weight relative self-stretch break-words">
                    {propertyAddress}
                  </div>
                </div>
                <div className="text-global-blanc text-left font-h3-font-family text-h3-font-size font-h3-font-weight relative w-[100px]">
                  {formatDate(booking.startDate)}
                </div>
                <div className="text-global-blanc text-left font-h3-font-family text-h3-font-size font-h3-font-weight relative w-[100px]">
                  {formatDate(booking.endDate)}
                </div>
                <div className="text-global-blanc text-left font-h3-font-family text-h3-font-size font-h3-font-weight relative w-[50px]">
                  {calculateNights(booking.startDate, booking.endDate)}
                </div>
                <div className="text-global-blanc text-left font-h3-font-family text-h3-font-size font-h3-font-weight relative w-[100px]">
                  {formatCurrency(booking.totalPrice)}
                </div>
                <div className="text-global-blanc text-left font-h3-font-family text-h3-font-size font-h3-font-weight relative w-[100px]">
                  {formatCurrency(booking.totalPrice)}
                </div>
                <div className="shrink-0 w-[100px] h-[26px] relative flex items-center">
                  {getChannelBadge(booking.channel)}
                </div>
                <div className="shrink-0 w-[100px] h-[26px] relative flex items-center">
                  {getStatusBadge(booking.status)}
                </div>
                <div className="shrink-0 w-[80px] relative flex items-center">
                  <button
                    type="button"
                    onClick={() => handleDeleteBooking(booking)}
                    className="text-red-400 hover:text-red-300 text-sm px-2 py-1 rounded hover:bg-red-900/20 transition-colors"
                    title={t('bookings.deleteBooking')}
                  >
                    {t('bookings.deleteBooking')}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
      ) : (
        /* Vue Calendrier */
        <div>
          {isLoading ? (
            <div className="bg-global-bg-box rounded-[14px] border border-global-stroke-box p-8 flex items-center justify-center">
              <div className="text-center text-global-inactive">
                <div className="w-8 h-8 border-2 border-global-content-highlight-2nd border-t-transparent rounded-full animate-spin mx-auto mb-2"></div>
                {t('bookings.loading')}
              </div>
            </div>
          ) : (
            <BookingsCalendar
              bookings={filteredBookings}
              propertyMap={propertyMap}
              formatCurrency={formatCurrency}
              formatDate={formatDate}
              onBookingClick={handleBookingClick}
            />
          )}
        </div>
      )}

      {/* Modal de détails des réservations */}
      {showBookingDetails && selectedDateBookings.length > 0 && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={() => setShowBookingDetails(false)}>
          <div className="bg-global-bg-box border border-global-stroke-box rounded-[14px] p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-xl font-bold text-global-blanc font-h3-font-family">
                {t('bookings.property')} - {formatDate(selectedDate.toISOString().split('T')[0])}
              </h3>
              <button
                onClick={() => setShowBookingDetails(false)}
                className="text-global-inactive hover:text-global-blanc text-2xl"
              >
                ×
              </button>
            </div>
            <div className="space-y-4">
              {selectedDateBookings.map((booking, index) => {
                const propertyName = propertyMap.get(booking.propertyId) || t('bookings.unknownProperty');
                return (
                  <div
                    key={index}
                    className="border border-global-stroke-box rounded-[10px] p-4 bg-global-bg-small-box"
                  >
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <div className="text-global-inactive text-sm font-p1-font-family mb-1">{t('bookings.property')}</div>
                        <div className="text-global-blanc font-h4-font-family">{propertyName}</div>
                      </div>
                      <div>
                        <div className="text-global-inactive text-sm font-p1-font-family mb-1">{t('bookings.totalPrice')}</div>
                        <div className="text-global-blanc font-h4-font-family">{formatCurrency(booking.totalPrice)}</div>
                      </div>
                      <div>
                        <div className="text-global-inactive text-sm font-p1-font-family mb-1">{t('bookings.arrivalDate')}</div>
                        <div className="text-global-blanc font-h4-font-family">{formatDate(booking.startDate)}</div>
                      </div>
                      <div>
                        <div className="text-global-inactive text-sm font-p1-font-family mb-1">{t('bookings.departureDate')}</div>
                        <div className="text-global-blanc font-h4-font-family">{formatDate(booking.endDate)}</div>
                      </div>
                      <div>
                        <div className="text-global-inactive text-sm font-p1-font-family mb-1">{t('bookings.channel')}</div>
                        <div className="mt-1">{getChannelBadge(booking.channel)}</div>
                      </div>
                      <div>
                        <div className="text-global-inactive text-sm font-p1-font-family mb-1">{t('bookings.status')}</div>
                        <div className="mt-1">{getStatusBadge(booking.status)}</div>
                      </div>
                    </div>
                    <div className="mt-3 pt-3 border-t border-global-stroke-box flex justify-end">
                      <button
                        type="button"
                        onClick={() => {
                          setShowBookingDetails(false);
                          handleDeleteBooking(booking);
                        }}
                        className="text-red-400 hover:text-red-300 text-sm px-3 py-1.5 rounded border border-red-500/50 hover:bg-red-900/20 transition-colors"
                      >
                        {t('bookings.deleteBooking')}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Modale de confirmation de suppression */}
      <ConfirmModal
        isOpen={confirmModal.isOpen}
        onClose={() => setConfirmModal({ isOpen: false, message: '', onConfirm: null })}
        onConfirm={confirmModal.onConfirm || (() => {})}
        title={t('bookings.deleteBooking')}
        message={confirmModal.message}
        confirmText={t('bookings.deleteConfirm')}
        cancelText={t('common.cancel')}
      />
      </div>
    </div>
  );
}

export default BookingsPage;

