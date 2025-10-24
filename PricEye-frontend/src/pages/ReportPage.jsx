import React, { useState, useEffect, useCallback, useRef } from 'react';
import { getProperties, getReportKpis, getUserProfile } from '../services/api.js'; // Importer getUserProfile
import { exportToExcel } from '../utils/exportUtils.js';
import Chart from 'chart.js/auto'; 
import { getDatesFromRange } from '../utils/dateUtils.js'; 

function ReportPage({ token }) {
  const [allProperties, setAllProperties] = useState([]);
  const [filteredProperties, setFilteredProperties] = useState([]);
  const [userProfile, setUserProfile] = useState(null); // État pour le profil utilisateur
  const [isLoading, setIsLoading] = useState(true);
  const [isKpiLoading, setIsKpiLoading] = useState(true);
  const [error, setError] = useState('');

  // Filters State
  const [dateRange, setDateRange] = useState('1m'); 
  const [propertyType, setPropertyType] = useState('');
  const [channel, setChannel] = useState('');
  const [status, setStatus] = useState('');
  const [location, setLocation] = useState('');
  const [occupancyThreshold, setOccupancyThreshold] = useState(0);

  // KPIs State
  const [kpis, setKpis] = useState({
    totalRevenue: 0,
    iaGain: 0, 
    avgOccupancy: 0,
    adr: 0,
    iaScore: 0, 
  });

  // Chart instances refs
  const revenueChartRef = useRef(null);
  const marketChartRef = useRef(null);
  const revenueChartInstance = useRef(null);
  const marketChartInstance = useRef(null);

  // Fonction unifiée pour charger les données initiales
  const fetchInitialData = useCallback(async () => {
    setIsLoading(true);
    try {
      // Récupérer le profil et les propriétés en parallèle
      const [profileData, propertiesData] = await Promise.all([
        getUserProfile(token),
        getProperties(token)
      ]);
      
      setUserProfile(profileData);
      setAllProperties(propertiesData);
      setError('');

    } catch (err) {
      setError(`Erreur de chargement des données: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchInitialData();
  }, [fetchInitialData]);

  // Fetch KPIs (Données Réelles)
  const fetchKpis = useCallback(async () => {
      // Attendre que le profil utilisateur soit chargé pour avoir le fuseau horaire
      if (!userProfile) return;

      setIsKpiLoading(true);
      setError('');
      try {
          // Utiliser le fuseau horaire du profil pour calculer les dates
          const { startDate, endDate } = getDatesFromRange(dateRange, userProfile.timezone);
          const kpiData = await getReportKpis(token, startDate, endDate);
          
          setKpis({
              totalRevenue: kpiData.totalRevenue || 0,
              avgOccupancy: kpiData.occupancy || 0,
              adr: kpiData.adr || 0,
              iaGain: (kpiData.totalRevenue || 0) * (0.05 + Math.random() * 0.10), 
              iaScore: 70 + Math.random() * 25, 
          });
          
      } catch (err) {
          setError(`Erreur de chargement des KPIs: ${err.message}`);
          setKpis({ totalRevenue: 0, iaGain: 0, avgOccupancy: 0, adr: 0, iaScore: 0 });
      } finally {
          setIsKpiLoading(false);
      }
  }, [token, dateRange, userProfile]); // Se déclenche si le profil ou la période change

  useEffect(() => {
    fetchKpis();
  }, [fetchKpis]);


  // Apply filters
  useEffect(() => {
    let filtered = allProperties;

    if (propertyType) filtered = filtered.filter(p => p.property_type === propertyType);
    if (channel) filtered = filtered.filter(p => p.channel === channel);
    if (status) filtered = filtered.filter(p => p.status === status);
    if (location) {
        const locLower = location.toLowerCase();
        filtered = filtered.filter(p => 
            p.location?.toLowerCase().includes(locLower) || 
            p.address?.toLowerCase().includes(locLower));
    }
    filtered = filtered.filter(p => ((p.occupancy || 0) * 100) >= occupancyThreshold); 

    setFilteredProperties(filtered);
    
  }, [allProperties, propertyType, channel, status, location, occupancyThreshold]);


  // --- Chart Rendering ---
  useEffect(() => {
    if (revenueChartInstance.current) { revenueChartInstance.current.destroy(); }
    if (marketChartInstance.current) { marketChartInstance.current.destroy(); }

    if (revenueChartRef.current) {
        const ctxRevenue = revenueChartRef.current.getContext('2d');
        const labels = Array.from({length: 30}, (_, i) => `J-${30-i}`); 
        const revenueData = labels.map(() => kpis.totalRevenue * (0.8 + Math.random() * 0.4) / 30); 
        
        revenueChartInstance.current = new Chart(ctxRevenue, { 
            type: 'line', 
            data: { 
                labels: labels, 
                datasets: [{ 
                    label: 'Revenus Estimés', 
                    data: revenueData, 
                    borderColor: '#3b82f6', 
                    backgroundColor: 'rgba(59, 130, 246, 0.1)', 
                    fill: true, 
                    tension: 0.4 
                }] 
            }, 
            options: { 
                scales: { 
                    y: { beginAtZero: true, ticks: { color: '#9ca3af' } },
                    x: { ticks: { color: '#9ca3af' } } 
                },
                plugins: { legend: { labels: { color: '#9ca3af' }}}
            } 
        });
    }

    if (marketChartRef.current) {
      const ctxMarket = marketChartRef.current.getContext('2d');
      const labelsMarket = ['-30j', '-15j', 'Auj.', '+15j', '+30j'];
      marketChartInstance.current = new Chart(ctxMarket, {
        type: 'line',
        data: {
          labels: labelsMarket,
          datasets: [
            { label: 'Demande Estimée', data: [60, 75, 80, 85, 70], borderColor: '#10b981', fill: false, tension: 0.3 },
            { label: 'Offre Estimée', data: [85, 80, 78, 75, 80], borderColor: '#ef4444', fill: false, tension: 0.3 }
          ]
        },
        options: {
             scales: { 
                y: { beginAtZero: false, ticks: { color: '#9ca3af' } },
                x: { ticks: { color: '#9ca3af' } } 
            },
            plugins: { legend: { labels: { color: '#9ca3af' }}}
        }
      });
    }
     return () => {
         if (revenueChartInstance.current) { revenueChartInstance.current.destroy(); }
         if (marketChartInstance.current) { marketChartInstance.current.destroy(); }
     };

  }, [kpis.totalRevenue]); 

  const handleExport = () => {
    if (filteredProperties.length === 0) {
      alert("Aucune donnée à exporter.");
      return;
    }
    exportToExcel(filteredProperties, `Rapport_Proprietes_${dateRange}`);
  };
  
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


  return (
    <div className="space-y-8">
      <div className="flex flex-wrap justify-between items-center gap-4">
        <h2 className="text-3xl font-bold text-white">Rapport d'Activité</h2>
        <div className="flex items-center gap-4">
          <select 
            id="date-range-selector" 
            value={dateRange} 
            onChange={(e) => setDateRange(e.target.value)} 
            className="bg-gray-800 border-gray-700 rounded-md p-2 focus:ring-blue-500 text-white"
          >
            <option value="7d">7 derniers jours</option>
            <option value="1m">Ce mois (30j)</option>
            <option value="6m">6 mois</option>
            <option value="ytd">Cette année (YTD)</option>
            <option value="1y">1 an</option>
            <option value="all">Tout (5 ans)</option>
          </select>
          <button onClick={handleExport} className="bg-green-600 hover:bg-green-700 text-white font-semibold py-2 px-4 rounded-lg transition">Exporter (.xlsx)</button>
        </div>
      </div>

      <div className="bg-gray-800 p-4 rounded-lg">
         <h3 className="font-semibold mb-3 text-lg">Filtres (pour l'export)</h3>
         {isLoading && <p className="text-xs text-gray-400">Chargement des filtres...</p>}
         {!isLoading && 
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 text-sm">
                <select value={propertyType} onChange={(e) => setPropertyType(e.target.value)} className="filter-input bg-gray-700 border-gray-600 rounded-md p-2 text-white"><option value="">Type de propriété</option>{[...new Set(allProperties.map(p=>p.property_type))].filter(Boolean).map(type => <option key={type} value={type}>{type}</option>)}</select>
                <select value={channel} onChange={(e) => setChannel(e.target.value)} className="filter-input bg-gray-700 border-gray-600 rounded-md p-2 text-white"><option value="">Canal</option>{[...new Set(allProperties.map(p=>p.channel))].filter(Boolean).map(c => <option key={c} value={c}>{c}</option>)}</select>
                <select value={status} onChange={(e) => setStatus(e.target.value)} className="filter-input bg-gray-700 border-gray-600 rounded-md p-2 text-white"><option value="">Statut</option>{[...new Set(allProperties.map(p=>p.status))].filter(Boolean).map(s => <option key={s} value={s}>{s}</option>)}</select>
                <input type="text" value={location} onChange={(e) => setLocation(e.target.value)} className="filter-input bg-gray-700 border-gray-600 rounded-md p-2 text-white" placeholder="Pays / Ville / Adresse" />
                <div className="flex flex-col">
                   <label htmlFor="filter-occupancy" className="text-xs text-gray-400">Taux d'occup. (Base) &gt; <span id="occupancy-value">{occupancyThreshold}</span>%</label>
                   <input type="range" id="filter-occupancy" min="0" max="100" value={occupancyThreshold} onChange={(e) => setOccupancyThreshold(parseInt(e.target.value, 10))} className="filter-input w-full h-2 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-blue-500" />
                </div>
            </div>
         }
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-6">
        {isKpiLoading || isLoading ? (
            <div className="col-span-full text-center text-gray-400">Chargement des KPIs réels...</div>
        ) : (
            <>
                <div className="bg-gray-800 p-5 rounded-xl"><p className="text-sm text-gray-400">Revenu Total (Réel)</p><p className="text-2xl font-bold">{formatCurrency(kpis.totalRevenue)}</p></div>
                <div className="bg-gray-800 p-5 rounded-xl"><p className="text-sm text-gray-400">Gains par l'IA (Simulé)</p><p className="text-2xl font-bold">{formatCurrency(kpis.iaGain)}</p></div>
                <div className="bg-gray-800 p-5 rounded-xl"><p className="text-sm text-gray-400">Taux d'occupation (Réel)</p><p className="text-2xl font-bold">{kpis.avgOccupancy.toFixed(1)}%</p></div>
                <div className="bg-gray-800 p-5 rounded-xl"><p className="text-sm text-gray-400">Prix Moyen / Nuit (ADR Réel)</p><p className="text-2xl font-bold">{formatCurrencyAdr(kpis.adr)}</p></div>
                <div className="bg-gray-800 p-5 rounded-xl"><p className="text-sm text-gray-400">Score IA (Simulé)</p><p className="text-2xl font-bold">{kpis.iaScore.toFixed(0)} / 100</p></div>
            </>
        )}
      </div>

      {error && <p className="text-red-400 text-center">{error}</p>}
      {!error && (isLoading || filteredProperties.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-gray-800 p-5 rounded-xl"><h4 className="font-semibold mb-4 text-white">Évolution des revenus (Simulé)</h4>{isLoading ? <p>Chargement...</p> : <canvas ref={revenueChartRef}></canvas>}</div>
          <div className="bg-gray-800 p-5 rounded-xl"><h4 className="font-semibold mb-4 text-white">Tendance du Marché (Simulé)</h4>{isLoading ? <p>Chargement...</p> : <canvas ref={marketChartRef}></canvas>}</div>
        </div>
      )}
      {!isLoading && !error && filteredProperties.length === 0 && (
          <p className="text-center text-gray-500 mt-8">Aucune propriété à afficher.</p>
      )}

    </div>
  );
}

export default ReportPage;

