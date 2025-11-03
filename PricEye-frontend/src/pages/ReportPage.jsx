import React, { useState, useEffect, useCallback, useRef } from 'react';
import { getProperties, getReportKpis, getRevenueOverTime, getPerformanceOverTime } from '../services/api.js'; // Importer getPerformanceOverTime
import { exportToExcel } from '../utils/exportUtils.js';
import Chart from 'chart.js/auto'; 
import { getDatesFromRange, getPreviousDates } from '../utils/dateUtils.js'; // Importer les deux fonctions

/**
 * Calcule la tendance entre deux valeurs.
 * @param {number} current - Période N
 * @param {number} previous - Période N-1
 * @returns {{percent: number | null, change: 'increase' | 'decrease' | 'neutral'}}
 */
const calculateTrend = (current, previous) => {
  if (previous === 0 || previous == null) {
      // Si N-1 est 0, toute augmentation est "infinie"
      return { percent: current > 0 ? 100.0 : 0, change: current > 0 ? 'increase' : 'neutral' };
  }
  
  const change = ((current - previous) / previous) * 100;
  
  return {
      percent: change,
      change: change > 0.1 ? 'increase' : (change < -0.1 ? 'decrease' : 'neutral')
  };
};

/**
 * Sous-composant pour afficher un KPI avec sa tendance.
 */
function KpiCard({ title, value, previousValue, formatter, isLoading }) {
    if (isLoading) {
        return (
             <div className="bg-bg-secondary p-5 rounded-xl shadow-lg">
                <p className="text-sm text-text-muted">{title}</p>
                <p className="text-2xl font-bold text-text-muted animate-pulse">Chargement...</p>
                <p className="text-sm text-text-muted h-5"></p>
             </div>
        );
    }
    
    const trend = calculateTrend(value, previousValue);
    
    const trendColor = {
        increase: 'text-green-400',
        decrease: 'text-red-400',
        neutral: 'text-text-muted'
    }[trend.change];
    
    const trendIcon = {
        increase: '↑',
        decrease: '↓',
        neutral: '→'
    }[trend.change];

    return (
        <div className="bg-bg-secondary p-5 rounded-xl shadow-lg">
            <p className="text-sm text-text-muted">{title}</p>
            <p className="text-2xl font-bold text-text-primary">{formatter(value)}</p>
            <div className={`flex items-center text-sm font-semibold ${trendColor}`}>
                {trendIcon} {trend.percent != null ? `${trend.percent.toFixed(1)}%` : '-'}
                <span className="text-text-muted font-normal ml-2">vs {formatter(previousValue)}</span>
            </div>
        </div>
    );
}


function ReportPage({ token, userProfile }) { 
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
  const [kpis, setKpis] = useState(null); // Période N
  const [prevKpis, setPrevKpis] = useState(null); // Période N-1
  const [chartData, setChartData] = useState(null); // Pour le graphique de revenus
  const [performanceData, setPerformanceData] = useState(null); // NOUVEAU: Pour le graphique de performance

  // Chart instances refs
  const revenueChartRef = useRef(null);
  const marketChartRef = useRef(null);
  const revenueChartInstance = useRef(null);
  const marketChartInstance = useRef(null);
  
  // Fonctions de formatage
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
  const formatPercent = (amount) => {
      return `${(amount || 0).toFixed(1)}%`;
  }
   const formatScore = (amount) => {
      return `${(amount || 0).toFixed(0)}%`;
  }


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
  const fetchKpisAndCharts = useCallback(async () => {
      if (!userProfile) return; 

      setIsKpiLoading(true);
      setError('');
      try {
          // 1. Obtenir les dates pour N et N-1
          const { startDate: currentStartDate, endDate: currentEndDate } = getDatesFromRange(dateRange, userProfile.timezone);
          const { startDate: prevStartDate, endDate: prevEndDate } = getPreviousDates(currentStartDate, currentEndDate);

          // 2. Appeler l'API pour les deux périodes en parallèle
          const [currentData, prevData, revenueData, perfData] = await Promise.all([
              getReportKpis(token, currentStartDate, currentEndDate),
              getReportKpis(token, prevStartDate, prevEndDate),
              getRevenueOverTime(token, currentStartDate, currentEndDate),
              getPerformanceOverTime(token, currentStartDate, currentEndDate) // NOUVEL APPEL
          ]);
          
          setKpis(currentData);
          setPrevKpis(prevData);
          setChartData(revenueData); // Sauvegarder les données du graphique de revenus
          setPerformanceData(perfData); // NOUVEAU: Sauvegarder les données du graphique de performance
          
      } catch (err) {
          setError(`Erreur de chargement des KPIs: ${err.message}`);
          setKpis(null);
          setPrevKpis(null);
          setChartData(null);
          setPerformanceData(null); // NOUVEAU: Réinitialiser en cas d'erreur
      } finally {
          setIsKpiLoading(false);
      }
  }, [token, dateRange, userProfile]); 

  useEffect(() => {
    fetchKpisAndCharts();
  }, [fetchKpisAndCharts]);


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

    // Graphique des Revenus (RÉEL)
    if (revenueChartRef.current && chartData) { 
        const ctxRevenue = revenueChartRef.current.getContext('2d');
        revenueChartInstance.current = new Chart(ctxRevenue, { 
            type: 'line', 
            data: { 
                labels: chartData.labels, 
                datasets: [{ 
                    label: 'Revenus Réels', 
                    data: chartData.revenueData, 
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

    // NOUVEAU: Graphique Performance (RÉEL)
    if (marketChartRef.current && performanceData) {
      const ctxMarket = marketChartRef.current.getContext('2d');
      marketChartInstance.current = new Chart(ctxMarket, {
        type: 'bar', // Type principal en barres
        data: {
          labels: performanceData.labels,
          datasets: [
            { 
              label: 'Nb. Réservations', 
              data: performanceData.bookingCounts, 
              backgroundColor: '#3b82f6', // Bleu
              yAxisID: 'y', // Axe Y gauche
            },
            {
              label: 'Taux d\'Occupation (%)',
              data: performanceData.occupancyRates,
              type: 'line', // Ce dataset est une ligne
              borderColor: '#10b981', // Vert
              tension: 0.3,
              fill: false,
              yAxisID: 'y1', // Axe Y droit
            }
          ]
        },
        options: {
             scales: { 
                x: { ticks: { color: '#9ca3af' } },
                // Axe Y gauche (Barres - Nb Réservations)
                y: { 
                    beginAtZero: true, 
                    position: 'left',
                    ticks: { color: '#9ca3af' },
                    grid: { drawOnChartArea: false } // Grille optionnelle
                },
                // Axe Y droit (Ligne - %)
                y1: {
                    beginAtZero: true,
                    max: 100, // L'occupation est un %
                    position: 'right',
                    ticks: { color: '#9ca3af', callback: (value) => `${value}%` },
                    grid: { drawOnChartArea: false } // Ne pas dessiner la grille pour cet axe
                }
            },
            plugins: { 
                legend: { labels: { color: '#9ca3af' }}
            }
        }
      });
    }
     return () => {
         if (revenueChartInstance.current) { revenueChartInstance.current.destroy(); }
         if (marketChartInstance.current) { marketChartInstance.current.destroy(); }
     };

  }, [chartData, performanceData]); // Se redéclenche si les données des deux graphiques changent

  const handleExport = () => {
    if (filteredProperties.length === 0) {
      alert("Aucune donnée à exporter.");
      return;
    }
    exportToExcel(filteredProperties, `Rapport_Proprietes_${dateRange}`);
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap justify-between items-center gap-4">
        <h2 className="text-3xl font-bold text-text-primary">Rapport d'Activité</h2>
        <div className="flex items-center gap-4">
          <select 
            id="date-range-selector" 
            value={dateRange} 
            onChange={(e) => setDateRange(e.target.value)} 
            className="form-input bg-bg-secondary border-border-primary rounded-md p-2 focus:ring-blue-500 text-text-primary"
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

      <div className="bg-bg-secondary p-4 rounded-lg shadow-lg">
         <h3 className="font-semibold mb-3 text-lg text-text-primary">Filtres (pour l'export)</h3>
         {isLoading && <p className="text-xs text-text-muted">Chargement des filtres...</p>}
         {!isLoading && 
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 text-sm">
                <select value={propertyType} onChange={(e) => setPropertyType(e.target.value)} className="form-input"><option value="">Type de propriété</option>{[...new Set(allProperties.map(p=>p.property_type))].filter(Boolean).map(type => <option key={type} value={type}>{type}</option>)}</select>
                <select value={channel} onChange={(e) => setChannel(e.target.value)} className="form-input"><option value="">Canal</option>{[...new Set(allProperties.map(p=>p.channel))].filter(Boolean).map(c => <option key={c} value={c}>{c}</option>)}</select>
                <select value={status} onChange={(e) => setStatus(e.target.value)} className="form-input"><option value="">Statut</option>{[...new Set(allProperties.map(p=>p.status))].filter(Boolean).map(s => <option key={s} value={s}>{s}</option>)}</select>
                <input type="text" value={location} onChange={(e) => setLocation(e.target.value)} className="form-input" placeholder="Pays / Ville / Adresse" />
                <div className="flex flex-col">
                   <label htmlFor="filter-occupancy" className="text-xs text-text-muted">Taux d'occup. (Base) &gt; <span id="occupancy-value">{occupancyThreshold}</span>%</label>
                   <input type="range" id="filter-occupancy" min="0" max="100" value={occupancyThreshold} onChange={(e) => setOccupancyThreshold(parseInt(e.target.value, 10))} className="filter-input w-full h-2 bg-bg-muted rounded-lg appearance-none cursor-pointer accent-blue-500" />
                </div>
            </div>
         }
      </div>

      {/* Grille des KPIs mise à jour (lg:grid-cols-3) */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-6">
        <KpiCard
            title="Revenu Total (Réel)"
            isLoading={isKpiLoading}
            value={kpis?.totalRevenue}
            previousValue={prevKpis?.totalRevenue}
            formatter={formatCurrency}
        />
         <KpiCard
            title="Taux d'occupation (Réel)"
            isLoading={isKpiLoading}
            value={kpis?.avgOccupancy}
            previousValue={prevKpis?.avgOccupancy}
            formatter={formatPercent}
        />
         <KpiCard
            title="ADR (Réel)"
            isLoading={isKpiLoading}
            value={kpis?.adr}
            previousValue={prevKpis?.adr}
            formatter={formatCurrencyAdr}
        />
        <KpiCard
            title="Gains par l'IA (Réel)"
            isLoading={isKpiLoading}
            value={kpis?.iaGain}
            previousValue={prevKpis?.iaGain}
            formatter={formatCurrency}
        />
         <KpiCard
            title="Score IA (Réel)"
            isLoading={isKpiLoading}
            value={kpis?.iaScore}
            previousValue={prevKpis?.iaScore}
            formatter={formatScore}
        />
        {/* NOUVELLE KpiCard pour le RevPAR */}
        <KpiCard
            title="RevPAR (Réel)"
            isLoading={isKpiLoading}
            value={kpis?.revPar}
            previousValue={prevKpis?.revPar}
            formatter={formatCurrencyAdr}
        />
      </div>

      {error && <p className="text-red-400 text-center">{error}</p>}
      
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-bg-secondary p-5 rounded-xl shadow-lg">
            <h4 className="font-semibold mb-4 text-text-primary">Évolution des revenus (Réel)</h4>
            {isKpiLoading ? <p>Chargement...</p> : <canvas ref={revenueChartRef}></canvas>}
        </div>
        <div className="bg-bg-secondary p-5 rounded-xl shadow-lg">
            {/* Titre mis à jour */}
            <h4 className="font-semibold mb-4 text-text-primary">Performance (Résas vs Occupation)</h4>
            {isKpiLoading ? <p>Chargement...</p> : <canvas ref={marketChartRef}></canvas>}
        </div>
      </div>
      
      {!isLoading && !error && filteredProperties.length === 0 && (
          <p className="text-center text-text-muted mt-8">Aucune propriété à afficher.</p>
      )}

    </div>
  );
}

export default ReportPage;

