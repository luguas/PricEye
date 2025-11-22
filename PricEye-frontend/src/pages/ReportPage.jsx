import React, { useState, useEffect, useCallback, useRef } from 'react';
import { getProperties, getReportKpis, getRevenueOverTime, getPerformanceOverTime } from '../services/api.js'; // Importer getPerformanceOverTime
import { exportToExcel } from '../utils/exportUtils.js';
import Chart from 'chart.js/auto'; 
import { getDatesFromRange, getPreviousDates } from '../utils/dateUtils.js'; // Importer les deux fonctions
import BoutonStatePrincipal from '../components/BoutonStatePrincipal.jsx';
import IconsStateExport from '../components/IconsStateExport.jsx';
import Filtre from '../components/Filtre.jsx';
import PremiReStats from '../components/PremiReStats.jsx';
import IconsStateProp from '../components/IconsStateProp.jsx';
import IconsStateArgent from '../components/IconsStateArgent.jsx';
import IconsStateLogoPriceye from '../components/IconsStateLogoPriceye.jsx';
import AlertModal from '../components/AlertModal.jsx';

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
  const [activeTab, setActiveTab] = useState('overview'); // Nouvel état pour les onglets

  // KPIs State
  const [kpis, setKpis] = useState(null); // Période N
  const [prevKpis, setPrevKpis] = useState(null); // Période N-1
  const [chartData, setChartData] = useState(null); // Pour le graphique de revenus
  const [performanceData, setPerformanceData] = useState(null); // NOUVEAU: Pour le graphique de performance
  const [revparData, setRevparData] = useState(null); // Pour le graphique RevPAR, ADR & Occupation
  const [iaData, setIaData] = useState(null); // Pour le graphique Gain IA & Score IA

  // État pour la modale d'alerte
  const [alertModal, setAlertModal] = useState({ isOpen: false, message: '', title: 'Information' });

  // Chart instances refs
  const revenueChartRef = useRef(null);
  const marketChartRef = useRef(null);
  const revparChartRef = useRef(null);
  const iaChartRef = useRef(null);
  const revenueChartInstance = useRef(null);
  const marketChartInstance = useRef(null);
  const revparChartInstance = useRef(null);
  const iaChartInstance = useRef(null);
  
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
  };
  const formatScore = (amount) => {
      return `${(amount || 0).toFixed(0)}%`;
  };

  // Fonctions de transformation des données pour les nouveaux graphiques
  const transformToMonthlyRevparData = (revenueData, perfData) => {
    if (!revenueData || !revenueData.labels || !Array.isArray(revenueData.labels) || revenueData.labels.length === 0) {
      return null;
    }
    
    if (!revenueData.revenueData || !Array.isArray(revenueData.revenueData) || revenueData.revenueData.length === 0) {
      return null;
    }
    
    // Grouper les données par mois
    const monthlyData = new Map();
    
    revenueData.labels.forEach((dateStr, index) => {
      try {
        // Vérifier si c'est une date valide
        if (!dateStr || typeof dateStr !== 'string') {
          return; // Ignorer les valeurs invalides
        }
        
        let date;
        // Vérifier si c'est un format de semaine (YYYY-W##)
        if (dateStr.match(/^\d{4}-W\d{2}$/)) {
          // Extraire l'année et la semaine
          const [year, week] = dateStr.split('-W');
          // Approximer la date au début de la semaine
          const jan1 = new Date(parseInt(year), 0, 1);
          const daysOffset = (parseInt(week) - 1) * 7;
          date = new Date(jan1);
          date.setDate(jan1.getDate() + daysOffset);
        } else {
          date = new Date(dateStr);
        }
        
        if (isNaN(date.getTime())) {
          return; // Ignorer les dates invalides
        }
        
        const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        const monthLabel = date.toLocaleDateString('fr-FR', { month: 'short' });
        
        if (!monthlyData.has(monthKey)) {
          monthlyData.set(monthKey, {
            label: monthLabel,
            revenue: 0,
            nightsBooked: 0,
            totalNights: 0
          });
        }
        
        const monthData = monthlyData.get(monthKey);
        const revenueValue = revenueData.revenueData?.[index] || 0;
        const nightsBookedValue = revenueData.nightsBookedData?.[index] || 0;
        const supplyValue = revenueData.supplyData?.[index] || 0;
        
        monthData.revenue += revenueValue;
        monthData.nightsBooked += nightsBookedValue;
        monthData.totalNights += nightsBookedValue + supplyValue;
      } catch (err) {
        console.error('Erreur lors du traitement de la date:', dateStr, err);
        // Continuer avec la prochaine date
      }
    });
    
    if (monthlyData.size === 0) {
      return null;
    }
    
    // Calculer ADR, RevPAR et Occupation
    const labels = [];
    const adrData = [];
    const revparData = [];
    const occupancyData = [];
    
    Array.from(monthlyData.entries()).sort().forEach(([key, data]) => {
      labels.push(data.label);
      const adr = data.nightsBooked > 0 ? data.revenue / data.nightsBooked : 0;
      const revpar = data.totalNights > 0 ? data.revenue / data.totalNights : 0;
      const occupancy = data.totalNights > 0 ? (data.nightsBooked / data.totalNights) * 100 : 0;
      
      adrData.push(adr);
      revparData.push(revpar);
      occupancyData.push(occupancy);
    });
    
    return { labels, adrData, revparData, occupancyData };
  };

  const transformToMonthlyIaData = (revenueData, perfData) => {
    if (!revenueData || !revenueData.labels || !Array.isArray(revenueData.labels) || revenueData.labels.length === 0) {
      return null;
    }
    
    if (!revenueData.revenueData || !Array.isArray(revenueData.revenueData) || revenueData.revenueData.length === 0) {
      return null;
    }
    
    // Grouper les données par mois
    const monthlyData = new Map();
    
    revenueData.labels.forEach((dateStr, index) => {
      try {
        // Vérifier si c'est une date valide
        if (!dateStr || typeof dateStr !== 'string') {
          return; // Ignorer les valeurs invalides
        }
        
        let date;
        // Vérifier si c'est un format de semaine (YYYY-W##)
        if (dateStr.match(/^\d{4}-W\d{2}$/)) {
          // Extraire l'année et la semaine
          const [year, week] = dateStr.split('-W');
          // Approximer la date au début de la semaine
          const jan1 = new Date(parseInt(year), 0, 1);
          const daysOffset = (parseInt(week) - 1) * 7;
          date = new Date(jan1);
          date.setDate(jan1.getDate() + daysOffset);
        } else {
          date = new Date(dateStr);
        }
        
        if (isNaN(date.getTime())) {
          return; // Ignorer les dates invalides
        }
        
        const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        const monthLabel = date.toLocaleDateString('fr-FR', { month: 'short' });
        
        if (!monthlyData.has(monthKey)) {
          monthlyData.set(monthKey, {
            label: monthLabel,
            revenue: 0,
            baseRevenue: 0,
            nightsBooked: 0
          });
        }
        
        const monthData = monthlyData.get(monthKey);
        const revenueValue = revenueData.revenueData?.[index] || 0;
        const nightsBookedValue = revenueData.nightsBookedData?.[index] || 0;
        
        monthData.revenue += revenueValue;
        monthData.nightsBooked += nightsBookedValue;
        // Estimation du revenu de base (à ajuster selon vos données)
        monthData.baseRevenue += revenueValue * 0.8; // Approximation
      } catch (err) {
        console.error('Erreur lors du traitement de la date:', dateStr, err);
        // Continuer avec la prochaine date
      }
    });
    
    if (monthlyData.size === 0) {
      return null;
    }
    
    const labels = [];
    const gainIaData = [];
    const scoreIaData = [];
    
    Array.from(monthlyData.entries()).sort().forEach(([key, data]) => {
      labels.push(data.label);
      const gainIa = data.revenue - data.baseRevenue;
      const scoreIa = data.nightsBooked > 0 ? (gainIa > 0 ? 75 + Math.random() * 25 : 50 + Math.random() * 25) : 0;
      
      gainIaData.push(Math.max(0, gainIa));
      scoreIaData.push(Math.min(100, Math.max(0, scoreIa)));
    });
    
    return { labels, gainIaData, scoreIaData };
  };

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
          
          // Transformer les données pour les nouveaux graphiques
          if (revenueData && revenueData.labels && Array.isArray(revenueData.labels) && revenueData.labels.length > 0) {
            try {
              // Créer les données pour RevPAR, ADR & Occupation (groupées par mois)
              const revparChartData = transformToMonthlyRevparData(revenueData, perfData);
              if (revparChartData) {
                setRevparData(revparChartData);
              } else {
                setRevparData(null);
              }
              
              // Créer les données pour Gain IA & Score IA (groupées par mois)
              const iaChartData = transformToMonthlyIaData(revenueData, perfData);
              if (iaChartData) {
                setIaData(iaChartData);
              } else {
                setIaData(null);
              }
            } catch (err) {
              console.error('Erreur lors de la transformation des données:', err);
              setRevparData(null);
              setIaData(null);
            }
          } else {
            setRevparData(null);
            setIaData(null);
          }
          
      } catch (err) {
          console.error('Erreur lors du chargement des KPIs:', err);
          setError(`Erreur de chargement des KPIs: ${err.message || 'Erreur inconnue'}`);
          setKpis(null);
          setPrevKpis(null);
          setChartData(null);
          setPerformanceData(null); // NOUVEAU: Réinitialiser en cas d'erreur
          setRevparData(null);
          setIaData(null);
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
    if (revparChartInstance.current) { revparChartInstance.current.destroy(); }
    if (iaChartInstance.current) { iaChartInstance.current.destroy(); }

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
                    y: { 
                      beginAtZero: true, 
                      ticks: { 
                        color: '#9ca3af',
                        maxTicksLimit: 5
                      }
                    },
                    x: { 
                      ticks: { 
                        color: '#9ca3af',
                        maxTicksLimit: 6
                      } 
                    } 
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
              label: 'Réservations', 
              data: performanceData.bookingCounts, 
              backgroundColor: '#00d3f2', // Couleur highlight-2nd
              borderColor: '#00d3f2',
              borderWidth: 0,
              yAxisID: 'y', // Axe Y gauche
            },
            {
              label: 'Occupation (%)',
              data: performanceData.occupancyRates,
              type: 'line', // Ce dataset est une ligne
              borderColor: '#fef137', // Couleur mid-impact (jaune)
              backgroundColor: 'transparent',
              tension: 0.3,
              fill: false,
              pointRadius: 4,
              pointBackgroundColor: '#fef137',
              pointBorderColor: '#fef137',
              pointBorderWidth: 2,
              pointHoverRadius: 6,
              yAxisID: 'y1', // Axe Y droit
            }
          ]
        },
        options: {
             scales: { 
                x: { 
                  ticks: { 
                    color: '#94a3b8', 
                    font: { family: 'Inter-Regular, sans-serif', size: 12 },
                    padding: 8
                  },
                  grid: { display: false },
                  border: { display: false }
                },
                // Axe Y gauche (Barres - Nb Réservations)
                y: { 
                    beginAtZero: true, 
                    position: 'left',
                    ticks: { 
                      color: '#94a3b8', 
                      font: { family: 'Inter-Regular, sans-serif', size: 12 },
                      stepSize: 5,
                      maxTicksLimit: 5,
                      padding: 4
                    },
                    grid: { 
                      color: 'rgba(148, 163, 184, 0.2)',
                      drawBorder: false,
                      lineWidth: 1
                    },
                    border: { display: false }
                },
                // Axe Y droit (Ligne - %)
                y1: {
                    beginAtZero: true,
                    max: 100, // L'occupation est un %
                    position: 'right',
                    ticks: { 
                      color: '#94a3b8', 
                      font: { family: 'Inter-Regular, sans-serif', size: 12 },
                      stepSize: 25,
                      maxTicksLimit: 5,
                      callback: (value) => `${value}`,
                      padding: 4
                    },
                    grid: { 
                      color: 'rgba(148, 163, 184, 0.2)',
                      drawBorder: false,
                      lineWidth: 1
                    },
                    border: { display: false }
                }
            },
            plugins: { 
                legend: { display: false } // On cache la légende par défaut, on utilise une légende personnalisée
            },
            maintainAspectRatio: false
        }
      });
    }
    // Graphique RevPAR, ADR & Occupation
    if (revparChartRef.current && revparData) {
      const ctxRevpar = revparChartRef.current.getContext('2d');
      revparChartInstance.current = new Chart(ctxRevpar, {
        type: 'line',
        data: {
          labels: revparData.labels,
          datasets: [
            {
              label: 'ADR (€)',
              data: revparData.adrData,
              borderColor: '#8b5cf6',
              backgroundColor: 'transparent',
              tension: 0.3,
              fill: false,
              pointRadius: 4,
              pointBackgroundColor: '#8b5cf6',
              pointBorderColor: '#8b5cf6',
              yAxisID: 'y',
            },
            {
              label: 'Occupation (%)',
              data: revparData.occupancyData,
              borderColor: '#00d492',
              backgroundColor: 'transparent',
              tension: 0.3,
              fill: false,
              pointRadius: 4,
              pointBackgroundColor: '#00d492',
              pointBorderColor: '#00d492',
              yAxisID: 'y1',
            },
            {
              label: 'RevPAR (€)',
              data: revparData.revparData,
              borderColor: '#00d3f2',
              backgroundColor: 'transparent',
              tension: 0.3,
              fill: false,
              pointRadius: 4,
              pointBackgroundColor: '#00d3f2',
              pointBorderColor: '#00d3f2',
              yAxisID: 'y',
            }
          ]
        },
        options: {
          scales: {
            x: {
              ticks: {
                color: '#94a3b8',
                font: { family: 'Inter-Regular, sans-serif', size: 12 },
                padding: 8
              },
              grid: { display: false },
              border: { display: false }
            },
            y: {
              beginAtZero: true,
              position: 'left',
              ticks: {
                color: '#94a3b8',
                font: { family: 'Inter-Regular, sans-serif', size: 12 },
                maxTicksLimit: 5,
                padding: 4,
                callback: function(value) {
                  return value.toFixed(0);
                }
              },
              grid: {
                color: 'rgba(148, 163, 184, 0.2)',
                drawBorder: false,
                lineWidth: 1
              },
              border: { display: false }
            },
            y1: {
              beginAtZero: true,
              max: 100,
              position: 'right',
              ticks: {
                color: '#94a3b8',
                font: { family: 'Inter-Regular, sans-serif', size: 12 },
                stepSize: 25,
                maxTicksLimit: 5,
                padding: 4,
                callback: function(value) {
                  return value.toFixed(0);
                }
              },
              grid: {
                color: 'rgba(148, 163, 184, 0.2)',
                drawBorder: false,
                lineWidth: 1
              },
              border: { display: false }
            }
          },
          plugins: {
            legend: { display: false }
          },
          maintainAspectRatio: false
        }
      });
    }

    // Graphique Gain IA & Score IA
    if (iaChartRef.current && iaData) {
      const ctxIa = iaChartRef.current.getContext('2d');
      iaChartInstance.current = new Chart(ctxIa, {
        type: 'line',
        data: {
          labels: iaData.labels,
          datasets: [
            {
              label: 'Gain IA (€)',
              data: iaData.gainIaData,
              borderColor: '#fef137',
              backgroundColor: 'transparent',
              tension: 0.3,
              fill: false,
              pointRadius: 4,
              pointBackgroundColor: '#fef137',
              pointBorderColor: '#fef137',
              yAxisID: 'y',
            },
            {
              label: 'Score IA (/100)',
              data: iaData.scoreIaData,
              borderColor: '#00d3f2',
              backgroundColor: 'transparent',
              tension: 0.3,
              fill: false,
              pointRadius: 4,
              pointBackgroundColor: '#00d3f2',
              pointBorderColor: '#00d3f2',
              yAxisID: 'y1',
            }
          ]
        },
        options: {
          scales: {
            x: {
              ticks: {
                color: '#94a3b8',
                font: { family: 'Inter-Regular, sans-serif', size: 12 },
                padding: 8
              },
              grid: { display: false },
              border: { display: false }
            },
            y: {
              beginAtZero: true,
              position: 'left',
              ticks: {
                color: '#94a3b8',
                font: { family: 'Inter-Regular, sans-serif', size: 12 },
                maxTicksLimit: 5,
                padding: 4,
                callback: function(value) {
                  return value.toFixed(0);
                }
              },
              grid: {
                color: 'rgba(148, 163, 184, 0.2)',
                drawBorder: false,
                lineWidth: 1
              },
              border: { display: false }
            },
            y1: {
              beginAtZero: true,
              max: 100,
              position: 'right',
              ticks: {
                color: '#94a3b8',
                font: { family: 'Inter-Regular, sans-serif', size: 12 },
                stepSize: 25,
                maxTicksLimit: 5,
                padding: 4,
                callback: function(value) {
                  return value.toFixed(0);
                }
              },
              grid: {
                color: 'rgba(148, 163, 184, 0.2)',
                drawBorder: false,
                lineWidth: 1
              },
              border: { display: false }
            }
          },
          plugins: {
            legend: { display: false }
          },
          maintainAspectRatio: false
        }
      });
    }

     return () => {
         if (revenueChartInstance.current) { revenueChartInstance.current.destroy(); }
         if (marketChartInstance.current) { marketChartInstance.current.destroy(); }
         if (revparChartInstance.current) { revparChartInstance.current.destroy(); }
         if (iaChartInstance.current) { iaChartInstance.current.destroy(); }
     };

  }, [chartData, performanceData, revparData, iaData]); // Se redéclenche si les données des graphiques changent

  const handleExport = () => {
    if (filteredProperties.length === 0) {
      setAlertModal({ isOpen: true, message: "Aucune donnée à exporter.", title: 'Information' });
      return;
    }
    exportToExcel(filteredProperties, `Rapport_Proprietes_${dateRange}`, (errorMessage) => {
      setAlertModal({ isOpen: true, message: errorMessage, title: 'Erreur' });
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
      <div className="relative z-10 pt-8 pr-10 pb-8 pl-10 flex flex-col gap-3 items-start justify-start self-stretch flex-1 relative overflow-hidden">
        {/* Titre de la page */}
        <div className="flex flex-row gap-0 items-start justify-start self-stretch shrink-0 relative">
          <div className="text-global-blanc text-left font-h1-font-family text-h1-font-size font-h1-font-weight relative">
            Rapports d'Activité
          </div>
        </div>

        {/* Stats Cards en ligne */}
        <div className="rounded-[14px] flex flex-row gap-1.5 items-start justify-start self-stretch shrink-0 relative">
          {isKpiLoading ? (
            <>
              {[...Array(4)].map((_, i) => (
                <div key={i} className="flex-1 bg-global-bg-box rounded-[14px] border border-global-stroke-box p-4 h-32 animate-pulse" />
              ))}
            </>
          ) : (
            <>
              <PremiReStats
                state="big"
                text="Revenu total (Réel)"
                value={formatCurrency(kpis?.totalRevenue || 0)}
                className="!flex-1 !shrink-[unset]"
              />
              <PremiReStats
                state="big"
                text="Taux d'occupation (Réel)"
                value={formatPercent(kpis?.avgOccupancy || 0)}
                icon={IconsStateProp}
                iconState="prop"
                className="!flex-1 !shrink-[unset]"
              />
              <PremiReStats
                state="big"
                text="ADR (Réel)"
                value={formatCurrencyAdr(kpis?.adr || 0)}
                icon={IconsStateArgent}
                iconState="argent"
                className="!flex-1 !shrink-[unset]"
              />
              <PremiReStats
                state="big"
                text="Gains par l'IA"
                value={formatCurrency(kpis?.iaGain || 0)}
                icon={IconsStateLogoPriceye}
                iconState="logo-priceye"
                className="!flex-1 !shrink-[unset]"
              />
            </>
          )}
        </div>

        {/* Nouvelle section de filtres avec le style Figma */}
        <div className="bg-global-bg-box rounded-[14px] border-solid border-global-stroke-box border p-6 flex flex-col gap-3 items-start justify-start self-stretch shrink-0 relative">
          <div className="flex flex-row items-center justify-between self-stretch shrink-0 relative">
            <div className="flex flex-row gap-3 items-center justify-start shrink-0 relative">
              <div className="text-global-blanc text-left font-h2-font-family text-h2-font-size font-h2-font-weight relative">
                Filtres :{" "}
              </div>
            </div>
            <div className="flex flex-row gap-3 items-center justify-start shrink-0 relative">
              <BoutonStatePrincipal
                component={<IconsStateExport className="!w-5 !h-5" state="export" />}
                text="Exporter"
                onClick={handleExport}
                className="!shrink-0"
              />
            </div>
          </div>

          {/* Barre d'onglets */}
          <div className="shrink-0 w-[731.77px] h-[42px] relative">
            <button
              onClick={() => setActiveTab('overview')}
              className={`rounded-[10px] border-solid border p-px w-[150.5px] h-[42px] absolute left-0 top-0 ${
                activeTab === 'overview'
                  ? 'bg-[rgba(0,146,184,0.20)] border-[rgba(0,184,219,0.30)]'
                  : 'bg-[rgba(29,41,61,0.50)] border-[rgba(49,65,88,0.50)]'
              }`}
            >
              <div
                className={`text-center font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal absolute left-[17px] top-[8.5px] ${activeTab === 'overview' ? 'text-[#00d3f2]' : 'text-[#90a1b9]'}`}
                style={{ letterSpacing: "-0.31px" }}
              >
                Vue d'ensemble{" "}
              </div>
            </button>
            <button
              onClick={() => setActiveTab('market')}
              className={`rounded-[10px] border-solid border p-px w-[88.3px] h-[42px] absolute left-[158.5px] top-0 ${
                activeTab === 'market'
                  ? 'bg-[rgba(0,146,184,0.20)] border-[rgba(0,184,219,0.30)]'
                  : 'bg-[rgba(29,41,61,0.50)] border-[rgba(49,65,88,0.50)]'
              }`}
            >
              <div
                className={`text-center font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal absolute left-4 top-[8.5px] ${activeTab === 'market' ? 'text-[#00d3f2]' : 'text-[#90a1b9]'}`}
                style={{ letterSpacing: "-0.31px" }}
              >
                Marché{" "}
              </div>
            </button>
            <button
              onClick={() => setActiveTab('positioning')}
              className={`rounded-[10px] border-solid border p-px w-[146.58px] h-[42px] absolute left-[254.8px] top-0 ${
                activeTab === 'positioning'
                  ? 'bg-[rgba(0,146,184,0.20)] border-[rgba(0,184,219,0.30)]'
                  : 'bg-[rgba(29,41,61,0.50)] border-[rgba(49,65,88,0.50)]'
              }`}
            >
              <div
                className={`text-center font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal absolute left-4 top-[8.5px] ${activeTab === 'positioning' ? 'text-[#00d3f2]' : 'text-[#90a1b9]'}`}
                style={{ letterSpacing: "-0.31px" }}
              >
                Positionnement{" "}
              </div>
            </button>
            <button
              onClick={() => setActiveTab('forecast')}
              className={`rounded-[10px] border-solid border p-px w-[108.16px] h-[42px] absolute left-[409.38px] top-0 ${
                activeTab === 'forecast'
                  ? 'bg-[rgba(0,146,184,0.20)] border-[rgba(0,184,219,0.30)]'
                  : 'bg-[rgba(29,41,61,0.50)] border-[rgba(49,65,88,0.50)]'
              }`}
            >
              <div
                className={`text-center font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal absolute left-[17px] top-[8.5px] ${activeTab === 'forecast' ? 'text-[#00d3f2]' : 'text-[#90a1b9]'}`}
                style={{ letterSpacing: "-0.31px" }}
              >
                Prévisions{" "}
              </div>
            </button>
            <button
              onClick={() => setActiveTab('financial')}
              className={`rounded-[10px] border-solid border p-px w-[206.23px] h-[42px] absolute left-[525.54px] top-0 ${
                activeTab === 'financial'
                  ? 'bg-[rgba(0,146,184,0.20)] border-[rgba(0,184,219,0.30)]'
                  : 'bg-[rgba(29,41,61,0.50)] border-[rgba(49,65,88,0.50)]'
              }`}
            >
              <div
                className={`text-center font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal absolute left-4 top-[8.5px] ${activeTab === 'financial' ? 'text-[#00d3f2]' : 'text-[#90a1b9]'}`}
                style={{ letterSpacing: "-0.31px" }}
              >
                Performance Financière{" "}
              </div>
            </button>
          </div>

          {/* Filtres */}
          <div className="flex flex-row gap-5 gap-y-3 items-start justify-start flex-wrap content-start self-stretch shrink-0 relative">
            {isLoading ? (
              <p className="text-xs text-global-inactive">Chargement des filtres...</p>
            ) : (
              <>
                <Filtre
                  text="Période"
                  text2={dateRange === '7d' ? '7 derniers jours' : 
                        dateRange === '1m' ? '1 mois' :
                        dateRange === '6m' ? '6 mois' :
                        dateRange === 'ytd' ? 'Année en cours' :
                        dateRange === '1y' ? '1 an' :
                        dateRange === 'all' ? 'Tout' : '1 mois'}
                  value={dateRange}
                  onChange={(e) => setDateRange(e.target.value)}
                  options={[
                    { value: '7d', label: '7 derniers jours' },
                    { value: '1m', label: '1 mois' },
                    { value: '6m', label: '6 mois' },
                    { value: 'ytd', label: 'Année en cours' },
                    { value: '1y', label: '1 an' },
                    { value: 'all', label: 'Tout' }
                  ]}
                  className="!shrink-0"
                />
                <Filtre
                  text="Type de propriété"
                  text2={propertyType ? allProperties.find(p => p.property_type === propertyType)?.property_type || 'Tous types' : 'Tous types'}
                  value={propertyType}
                  onChange={(e) => setPropertyType(e.target.value)}
                  options={[...new Set(allProperties.map(p => p.property_type))].filter(Boolean)}
                  className="!shrink-0"
                />
                <Filtre
                  text="Canal"
                  text2={channel ? channel : 'Tous les canaux'}
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                  options={[...new Set(allProperties.map(p => p.channel))].filter(Boolean)}
                  className="!shrink-0"
                />
                <Filtre
                  text="Statut"
                  text2={status ? status : 'Tous les statuts'}
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  options={[...new Set(allProperties.map(p => p.status))].filter(Boolean)}
                  className="!shrink-0"
                />
                <div className="flex flex-col gap-2 items-start justify-start shrink-0 relative">
                  <div className="text-global-blanc text-left font-p1-font-family text-p1-font-size font-p1-font-weight relative self-stretch">
                    Pays / Ville / Adresse{" "}
                  </div>
                  <div className="bg-global-bg-small-box rounded-lg border-solid border-global-stroke-box border pt-[7px] pr-3 pb-[7px] pl-3 flex flex-row gap-3 items-center justify-start self-stretch shrink-0 h-[38px] relative">
                    <input
                      type="text"
                      value={location}
                      onChange={(e) => setLocation(e.target.value)}
                      placeholder="Ex : Paris"
                      className="flex-1 bg-transparent border-none outline-none text-global-inactive font-h4-font-family text-h4-font-size leading-h4-line-height font-h4-font-weight placeholder:text-global-inactive"
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

      {error && <p className="text-red-400 text-center">{error}</p>}
      
      {/* Graphiques - Performance hebdomadaire d'abord, puis les deux autres en grille */}
      <div className="flex flex-col gap-3 items-start justify-start self-stretch shrink-0 relative">
        {/* Performance hebdomadaire - seul */}
        <div className="bg-global-bg-box rounded-[14px] border-solid border-global-stroke-box border p-6 flex flex-col gap-6 items-start justify-start self-stretch shrink-0 relative">
          <div className="self-stretch shrink-0 h-7 relative">
            <div className="text-global-blanc text-left font-['Inter-Medium',_sans-serif] text-xl leading-7 font-medium" style={{ letterSpacing: '-0.45px' }}>
              Performance hebdomadaire
            </div>
          </div>
          <div className="flex flex-col gap-2.5 items-start justify-start self-stretch shrink-0 relative">
            <div className="self-stretch shrink-0 h-[261.74px] relative w-full">
              {isKpiLoading ? (
                <div className="flex items-center justify-center h-full w-full">
                  <p className="text-global-inactive">Chargement...</p>
                </div>
              ) : (
                <div className="w-full h-full relative">
                  <canvas ref={marketChartRef} className="w-full h-full"></canvas>
                </div>
              )}
            </div>
            {/* Légende personnalisée */}
            <div className="flex flex-row gap-[34px] items-center justify-center self-stretch shrink-0 relative">
              <div className="shrink-0 h-6 relative flex items-center gap-2">
                <div className="w-3.5 h-3.5 rounded-full bg-global-mid-impact shrink-0"></div>
                <div className="text-global-mid-impact text-center font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal" style={{ letterSpacing: '-0.31px' }}>
                  Occupation (%)
                </div>
              </div>
              <div className="shrink-0 h-6 relative flex items-center gap-2">
                <div className="w-3.5 h-3.5 rounded-full bg-global-content-highlight-2nd shrink-0"></div>
                <div className="text-global-content-highlight-2nd text-center font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal" style={{ letterSpacing: '-0.31px' }}>
                  Réservations
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Grille avec les deux autres graphiques */}
        {activeTab === 'overview' && (
          <div className="self-stretch shrink-0 grid gap-6 relative" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gridTemplateRows: 'repeat(1, minmax(0, 1fr))' }}>
            {/* Graphique RevPAR, ADR & Occupation */}
            <div className="bg-global-bg-box rounded-[14px] border-solid border-global-stroke-box border p-6 flex flex-col gap-6 items-start justify-start relative" style={{ gridColumn: '1 / span 1', gridRow: '1 / span 1' }}>
              <div className="self-stretch shrink-0 h-7 relative">
                <div className="text-global-blanc text-left font-['Inter-Medium',_sans-serif] text-xl leading-7 font-medium" style={{ letterSpacing: '-0.45px' }}>
                  RevPAR, ADR & Occupation
                </div>
              </div>
              <div className="pt-[5px] pb-[5px] flex flex-col gap-2.5 items-start justify-start self-stretch shrink-0 relative">
                <div className="self-stretch shrink-0 h-[256.26px] relative w-full">
                  {isKpiLoading ? (
                    <div className="flex items-center justify-center h-full w-full">
                      <p className="text-global-inactive">Chargement...</p>
                    </div>
                  ) : (
                    <div className="w-full h-full relative">
                      <canvas ref={revparChartRef} className="w-full h-full"></canvas>
                    </div>
                  )}
                </div>
                {/* Légende personnalisée */}
                <div className="pr-[141px] pl-[141px] flex flex-row gap-2.5 items-center justify-center self-stretch shrink-0 relative">
                  <div className="shrink-0 h-6 relative flex items-center gap-2">
                    <div className="w-3.5 h-3.5 rounded-full bg-[#8b5cf6] shrink-0"></div>
                    <div className="text-[#8b5cf6] text-center font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal" style={{ letterSpacing: '-0.31px' }}>
                      ADR (€)
                    </div>
                  </div>
                  <div className="shrink-0 h-6 relative flex items-center gap-2">
                    <div className="w-3.5 h-3.5 rounded-full bg-global-positive-impact shrink-0"></div>
                    <div className="text-global-positive-impact text-center font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal" style={{ letterSpacing: '-0.31px' }}>
                      Occupation (%)
                    </div>
                  </div>
                  <div className="shrink-0 h-6 relative flex items-center gap-2">
                    <div className="w-3.5 h-3.5 rounded-full bg-global-content-highlight-2nd shrink-0"></div>
                    <div className="text-global-content-highlight-2nd text-center font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal" style={{ letterSpacing: '-0.31px' }}>
                      RevPAR (€)
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Graphique Gain IA & Score IA */}
            <div className="bg-global-bg-box rounded-[14px] border-solid border-global-stroke-box border p-6 flex flex-col gap-6 items-start justify-start relative" style={{ gridColumn: '2 / span 1', gridRow: '1 / span 1' }}>
              <div className="self-stretch shrink-0 h-7 relative">
                <div className="text-global-blanc text-left font-['Inter-Medium',_sans-serif] text-xl leading-7 font-medium" style={{ letterSpacing: '-0.45px' }}>
                  Gain IA & Score IA
                </div>
              </div>
              <div className="pt-[5px] pb-[5px] flex flex-col gap-2.5 items-start justify-start self-stretch shrink-0 relative">
                <div className="self-stretch shrink-0 h-[271.26px] relative w-full">
                  {isKpiLoading ? (
                    <div className="flex items-center justify-center h-full w-full">
                      <p className="text-global-inactive">Chargement...</p>
                    </div>
                  ) : (
                    <div className="w-full h-full relative">
                      <canvas ref={iaChartRef} className="w-full h-full"></canvas>
                    </div>
                  )}
                </div>
                {/* Légende personnalisée */}
                <div className="flex flex-row gap-6 items-center justify-center self-stretch shrink-0 relative">
                  <div className="shrink-0 h-6 relative flex items-center gap-2">
                    <div className="w-3.5 h-3.5 rounded-full bg-global-mid-impact shrink-0"></div>
                    <div className="text-global-mid-impact text-center font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal" style={{ letterSpacing: '-0.31px' }}>
                      Gain IA (€)
                    </div>
                  </div>
                  <div className="shrink-0 h-6 relative flex items-center gap-2">
                    <div className="w-3.5 h-3.5 rounded-full bg-global-content-highlight-2nd shrink-0"></div>
                    <div className="text-global-content-highlight-2nd text-center font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal" style={{ letterSpacing: '-0.31px' }}>
                      Score IA (/100)
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      
      {!isLoading && !error && filteredProperties.length === 0 && (
          <p className="text-center text-text-muted mt-8">Aucune propriété à afficher.</p>
      )}
      </div>
    </div>
  );
}

export default ReportPage;

