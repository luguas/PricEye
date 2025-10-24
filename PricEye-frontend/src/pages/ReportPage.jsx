import React, { useState, useEffect, useCallback, useRef } from 'react';
import { getProperties, getReportKpis } from '../services/api';
import { exportToExcel } from '../utils/exportUtils';
import Chart from 'chart.js/auto'; 

// Fonction utilitaire pour formater les dates en YYYY-MM-DD
const formatDate = (date) => date.toISOString().split('T')[0];

/**
 * Calcule les dates de début et de fin en fonction du sélecteur de plage.
 * @param {string} range - "7d", "1m", "6m", "ytd", "1y", "all"
 * @returns {{startDate: string, endDate: string}}
 */
const getDatesFromRange = (range) => {
  const endDate = new Date();
  let startDate = new Date();

  switch (range) {
    case '7d':
      startDate.setDate(endDate.getDate() - 7);
      break;
    case '1m':
      startDate.setMonth(endDate.getMonth() - 1);
      break;
    case '6m':
      startDate.setMonth(endDate.getMonth() - 6);
      break;
    case 'ytd': // Year To Date
      startDate = new Date(endDate.getFullYear(), 0, 1);
      break;
    case '1y':
      startDate.setFullYear(endDate.getFullYear() - 1);
      break;
    case 'all':
      startDate.setFullYear(endDate.getFullYear() - 5); // Simuler "Tout" comme 5 ans
      break;
    default:
      startDate.setMonth(endDate.getMonth() - 1);
  }
  return {
    startDate: formatDate(startDate),
    endDate: formatDate(endDate),
  };
};


function ReportPage({ token }) {
  const [allProperties, setAllProperties] = useState([]);
  const [filteredProperties, setFilteredProperties] = useState([]);
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
    iaGain: 0, // Toujours simulé
    avgOccupancy: 0,
    adr: 0,
    iaScore: 0, // Toujours simulé
  });

  // Chart instances refs
  const revenueChartRef = useRef(null);
  const marketChartRef = useRef(null);
  const revenueChartInstance = useRef(null);
  const marketChartInstance = useRef(null);

  // Fetch all properties (pour les filtres)
  const fetchAllProperties = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await getProperties(token);
      setAllProperties(data);
      setError('');
    } catch (err) {
      setError(`Erreur de chargement des propriétés: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchAllProperties();
  }, [fetchAllProperties]);

  // Fetch KPIs (Données Réelles)
  const fetchKpis = useCallback(async () => {
      setIsKpiLoading(true);
      setError('');
      try {
          const { startDate, endDate } = getDatesFromRange(dateRange);
          // Appeler la nouvelle route API pour les KPIs réels
          const kpiData = await getReportKpis(token, startDate, endDate);
          
          // Mettre à jour les KPIs avec les données réelles
          setKpis({
              totalRevenue: kpiData.totalRevenue || 0,
              avgOccupancy: kpiData.occupancy || 0,
              adr: kpiData.adr || 0,
              // Garder les simulations pour les gains IA et le score IA
              iaGain: (kpiData.totalRevenue || 0) * (0.05 + Math.random() * 0.10), // Simulé 5-15% du revenu réel
              iaScore: 70 + Math.random() * 25, // Simulé 70-95
          });
          
      } catch (err) {
          setError(`Erreur de chargement des KPIs: ${err.message}`);
          // Réinitialiser les KPIs en cas d'erreur
          setKpis({ totalRevenue: 0, iaGain: 0, avgOccupancy: 0, adr: 0, iaScore: 0 });
      } finally {
          setIsKpiLoading(false);
      }
  }, [token, dateRange]); // Se déclenche si le token ou la période change

  useEffect(() => {
    fetchKpis();
  }, [fetchKpis]);


  // Apply filters (pour la liste des propriétés, l'export, et les graphiques simulés)
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
    
    // NOTE: Les KPIs principaux ne sont PAS recalculés ici, car ils viennent du backend.
    // Les filtres ici n'affecteront que les graphiques (simulés) et l'export.

  }, [allProperties, propertyType, channel, status, location, occupancyThreshold]);


  // --- Chart Rendering (Toujours Simulé pour l'instant) ---
  useEffect(() => {
    if (revenueChartInstance.current) { revenueChartInstance.current.destroy(); }
    if (marketChartInstance.current) { marketChartInstance.current.destroy(); }

    // Render Revenue Chart
    if (revenueChartRef.current) {
        const ctxRevenue = revenueChartRef.current.getContext('2d');
        const labels = Array.from({length: 30}, (_, i) => `J-${30-i}`); 
        const revenueData = labels.map(() => kpis.totalRevenue * (0.8 + Math.random() * 0.4) / 30); // Basé sur le KPI réel
        
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

    // Render Market Trend Chart
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

  }, [kpis.totalRevenue]); // Re-render charts when real KPIs change

  const handleExport = () => {
    if (filteredProperties.length === 0) {
      alert("Aucune donnée à exporter.");
      return;
    }
    exportToExcel(filteredProperties, `Rapport_Proprietes_${dateRange}`);
  };

  return (
    <div className="space-y-8">
      {/* Header and Date Range */}
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

      {/* Advanced Filters Section */}
      <div className="bg-gray-800 p-4 rounded-lg">
         <h3 className="font-semibold mb-3 text-lg">Filtres (pour la liste et l'export)</h3>
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

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-6">
        {isKpiLoading ? (
            <div className="col-span-full text-center text-gray-400">Chargement des KPIs réels...</div>
        ) : (
            <>
                <div className="bg-gray-800 p-5 rounded-xl"><p className="text-sm text-gray-400">Revenu Total (Réel)</p><p className="text-2xl font-bold">{kpis.totalRevenue.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 0, maximumFractionDigits: 0 })}</p></div>
                <div className="bg-gray-800 p-5 rounded-xl"><p className="text-sm text-gray-400">Gains par l'IA (Simulé)</p><p className="text-2xl font-bold">{kpis.iaGain.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 0, maximumFractionDigits: 0 })}</p></div>
                <div className="bg-gray-800 p-5 rounded-xl"><p className="text-sm text-gray-400">Taux d'occupation (Réel)</p><p className="text-2xl font-bold">{kpis.avgOccupancy.toFixed(1)}%</p></div>
                <div className="bg-gray-800 p-5 rounded-xl"><p className="text-sm text-gray-400">Prix Moyen / Nuit (ADR Réel)</p><p className="text-2xl font-bold">{kpis.adr.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 })}</p></div>
                <div className="bg-gray-800 p-5 rounded-xl"><p className="text-sm text-gray-400">Score IA (Simulé)</p><p className="text-2xl font-bold">{kpis.iaScore.toFixed(0)} / 100</p></div>
            </>
        )}
      </div>

      {/* Charts */}
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

