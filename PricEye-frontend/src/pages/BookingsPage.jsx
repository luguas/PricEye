import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { getProperties, getTeamBookings } from '../services/api.js';
// import { getDatesFromRange } from '../utils/dateUtils.js'; // Remplacé par une logique locale

/**
 * Composant pour le filtre multi-sélection de propriétés
 */
function MultiPropertyFilter({ properties, selectedIds, onChange }) {
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
      return "Toutes les propriétés";
    }
    if (selectedIds.length === 1) {
      const prop = properties.find(p => p.id === selectedIds[0]);
      return prop?.address || "1 propriété";
    }
    return `${selectedIds.length} propriétés sélectionnées`;
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="form-input bg-bg-secondary border-border-primary rounded-md p-2 text-sm text-text-primary w-full text-left flex justify-between items-center"
      >
        <span className="truncate">{getButtonText()}</span>
        <span className="ml-2">▼</span>
      </button>

      {isOpen && (
        <div className="absolute z-10 w-full mt-1 bg-bg-tertiary border border-border-primary rounded-md shadow-lg max-h-60 overflow-y-auto">
          <div className="p-2 border-b border-border-primary">
            <button
              type="button"
              onClick={handleSelectAll}
              className="text-xs text-blue-400 hover:text-blue-300"
            >
              {selectedIds.length === properties.length ? "Tout désélectionner" : "Tout sélectionner"}
            </button>
          </div>
          <div className="p-2 space-y-1">
            {properties.map(prop => (
              <label key={prop.id} className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedIds.includes(prop.id)}
                  onChange={(e) => handleCheckboxChange(e, prop.id)}
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
  const [allProperties, setAllProperties] = useState([]);
  const [allBookings, setAllBookings] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  // États des filtres
  const [dateRange, setDateRange] = useState('next_30d'); // Défaut sur les 30 prochains jours
  const [selectedPropertyIds, setSelectedPropertyIds] = useState([]);
  const [selectedChannel, setSelectedChannel] = useState('');
  const [minPrice, setMinPrice] = useState('');
  const [selectedStatus, setSelectedStatus] = useState(''); // NOUVEAU
  const [selectedPricingMethod, setSelectedPricingMethod] = useState(''); // NOUVEAU

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
      setError(`Erreur de chargement: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  }, [token, dateRange, userProfile]);

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
  }, [allBookings, selectedPropertyIds, propertyMap, selectedChannel, minPrice, selectedStatus, selectedPricingMethod]); // Ajout des dépendances

  // Helper pour formater la devise
  const formatCurrency = (amount) => {
    return (amount || 0).toLocaleString('fr-FR', { 
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

  // NOUVEAU: Helper pour badge de statut
  const getStatusBadge = (status) => {
      status = status || 'confirmé'; // Défaut
      switch(status) {
          case 'confirmé':
              return <span className="px-2 py-0.5 text-xs font-semibold bg-green-700 text-green-100 rounded-full">Confirmé</span>;
          case 'en attente':
              return <span className="px-2 py-0.5 text-xs font-semibold bg-yellow-700 text-yellow-100 rounded-full">En attente</span>;
          case 'annulée':
              return <span className="px-2 py-0.5 text-xs font-semibold bg-red-700 text-red-100 rounded-full">Annulée</span>;
          default:
              return <span className="px-2 py-0.5 text-xs font-semibold bg-gray-600 text-gray-200 rounded-full">{status}</span>;
      }
  };
  
  // NOUVEAU: Helper pour badge de méthode de prix
  const getPricingMethodBadge = (method) => {
      method = method || 'ia'; // Défaut
      switch(method) {
          case 'ia':
              return <span className="px-2 py-0.5 text-xs font-semibold bg-blue-700 text-blue-100 rounded-full">IA</span>;
          case 'manuelle':
              return <span className="px-2 py-0.5 text-xs font-semibold bg-purple-700 text-purple-100 rounded-full">Manuelle</span>;
          default:
              return <span className="px-2 py-0.5 text-xs font-semibold bg-gray-600 text-gray-200 rounded-full">{method}</span>;
      }
  };


  return (
    <div className="space-y-6">
      <h2 className="text-3xl font-bold text-text-primary">Centre de Réservations</h2>

      {/* Barre de Filtres */}
      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4 p-4 bg-bg-secondary rounded-lg shadow-lg">
        <div>
          <label htmlFor="date-range-selector" className="block text-sm font-medium text-text-secondary mb-1">
            Période
          </label>
          <select 
            id="date-range-selector" 
            value={dateRange} 
            onChange={(e) => setDateRange(e.target.value)} 
            className="form-input w-full"
          >
            <option value="next_30d">30 prochains jours</option>
            <option value="next_90d">90 prochains jours</option>
            <option value="this_month">Ce mois-ci</option>
            <option value="last_7d">7 derniers jours</option>
            <option value="last_30d">30 derniers jours</option>
          </select>
        </div>
        
        <div className="lg:col-span-2">
           <label htmlFor="property-filter" className="block text-sm font-medium text-text-secondary mb-1">
            Propriétés
          </label>
          <MultiPropertyFilter
            properties={allProperties}
            selectedIds={selectedPropertyIds}
            onChange={setSelectedPropertyIds}
          />
        </div>
        
        {/* Filtre Canal */}
        <div>
            <label htmlFor="channel-filter" className="block text-sm font-medium text-text-secondary mb-1">
              Canal
            </label>
            <select
              id="channel-filter"
              value={selectedChannel}
              onChange={(e) => setSelectedChannel(e.target.value)}
              className="form-input w-full"
            >
              <option value="">Tous les canaux</option>
              {uniqueChannels.map(channel => (
                <option key={channel} value={channel}>{channel}</option>
              ))}
            </select>
        </div>
        
        {/* Filtre Statut */}
        <div>
            <label htmlFor="status-filter" className="block text-sm font-medium text-text-secondary mb-1">
              Statut
            </label>
            <select
              id="status-filter"
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              className="form-input w-full"
            >
              <option value="">Tous les statuts</option>
              <option value="confirmé">Confirmé</option>
              <option value="en attente">En attente</option>
              <option value="annulée">Annulée</option>
            </select>
        </div>
        
        {/* Filtre Tarification */}
        <div>
            <label htmlFor="pricing-filter" className="block text-sm font-medium text-text-secondary mb-1">
              Tarification
            </label>
            <select
              id="pricing-filter"
              value={selectedPricingMethod}
              onChange={(e) => setSelectedPricingMethod(e.target.value)}
              className="form-input w-full"
            >
              <option value="">Toutes</option>
              <option value="ia">IA</option>
              <option value="manuelle">Manuelle</option>
            </select>
        </div>

        {/* Filtre Prix */}
        <div className="lg:col-start-5">
            <label htmlFor="min-price-filter" className="block text-sm font-medium text-text-secondary mb-1">
              Prix Total (Min)
            </label>
            <input
              type="number"
              id="min-price-filter"
              value={minPrice}
              onChange={(e) => setMinPrice(e.target.value)}
              className="form-input w-full"
              placeholder={`Ex: 100 (${userProfile?.currency || 'EUR'})`}
            />
        </div>
        
      </div>
      
      {error && <p className="text-red-400 text-center">{error}</p>}

      {/* Tableau des réservations */}
      <div className="bg-bg-secondary shadow-lg rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-border-primary">
          <thead className="bg-bg-muted">
            <tr>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">Statut</th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">Date Arrivée</th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">Date Départ</th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">Nuits</th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">Propriété</th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">Prix Total</th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">Canal</th>
              <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-text-secondary uppercase tracking-wider">Tarification</th>
            </tr>
          </thead>
          <tbody className="bg-bg-secondary divide-y divide-border-primary">
            {isLoading ? (
              <tr>
                <td colSpan="8" className="text-center p-8 text-text-muted">
                  <div className="loader mx-auto"></div>
                  Chargement des réservations...
                </td>
              </tr>
            ) : filteredBookings.length === 0 ? (
              <tr>
                <td colSpan="8" className="text-center p-8 text-text-muted">
                  Aucune réservation trouvée pour les filtres sélectionnés.
                </td>
              </tr>
            ) : (
              filteredBookings.map(booking => (
                <tr key={booking.id} className="hover:bg-bg-muted">
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-text-primary">{getStatusBadge(booking.status)}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-text-primary">{booking.startDate}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-text-primary">{booking.endDate}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-text-secondary">{calculateNights(booking.startDate, booking.endDate)}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-text-primary">{propertyMap.get(booking.propertyId) || 'Propriété inconnue'}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-text-secondary">{formatCurrency(booking.totalPrice)}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-text-secondary">{booking.channel}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-text-secondary">{getPricingMethodBadge(booking.pricingMethod)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default BookingsPage;

