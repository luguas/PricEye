import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { 
  getProperties, 
  getReportKpis, 
  getRevenueOverTime, 
  getPerformanceOverTime, 
  getMarketDemandSnapshot, 
  getPositioningReport, 
  getMarketKpis,
  getForecastRevenue,
  getForecastScenarios,
  getForecastRadar,
  getRevenueVsTarget,
  getAdrByChannel,
  getGrossMargin,
  getTeamBookings
} from '../services/api.js';
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
import { useLanguage } from '../contexts/LanguageContext.jsx';

/**
 * Generates AI-related prompts and messages in the user's language
 * @param {string} language - User's language code (e.g., 'fr', 'en')
 * @returns {Object} Object containing localized AI prompts and messages
 */
const getAIPrompts = (language = 'en') => {
  const prompts = {
    fr: {
      baseRevenueEstimation: "Estimation du revenu de base (à ajuster selon vos données)",
      approximation: "Approximation",
      aiGainCalculation: "Calcul du gain généré par l'IA",
      aiScoreCalculation: "Calcul du score de performance de l'IA",
      demandExplanation: "Demande = nombre de nuits réservées (nightsBookedData représente la demande satisfaite)",
      supplyExplanation: "Offre = nuits disponibles (supply)",
      groupDataByMonth: "Grouper les données par mois",
      createDataForAI: "Créer les données pour Gain IA & Score IA (groupées par mois)",
      errorProcessingDate: "Erreur lors du traitement de la date",
      continueWithNextDate: "Continuer avec la prochaine date",
      ignoreInvalidValues: "Ignorer les valeurs invalides",
      ignoreInvalidDates: "Ignorer les dates invalides"
    },
    en: {
      baseRevenueEstimation: "Base revenue estimation (to be adjusted according to your data)",
      approximation: "Approximation",
      aiGainCalculation: "AI gain calculation",
      aiScoreCalculation: "AI performance score calculation",
      demandExplanation: "Demand = number of nights booked (nightsBookedData represents satisfied demand)",
      supplyExplanation: "Supply = available nights (supply)",
      groupDataByMonth: "Group data by month",
      createDataForAI: "Create data for AI Gain & AI Score (grouped by month)",
      errorProcessingDate: "Error processing date",
      continueWithNextDate: "Continue with next date",
      ignoreInvalidValues: "Ignore invalid values",
      ignoreInvalidDates: "Ignore invalid dates"
    }
  };
  
  return prompts[language] || prompts.en;
};

/**
 * Calculates the trend between two values.
 * @param {number} current - Period N
 * @param {number} previous - Period N-1
 * @returns {{percent: number | null, change: 'increase' | 'decrease' | 'neutral'}}
 */
const calculateTrend = (current, previous) => {
  if (previous === 0 || previous == null) {
      // If N-1 is 0, any increase is "infinite"
      return { percent: current > 0 ? 100.0 : 0, change: current > 0 ? 'increase' : 'neutral' };
  }
  
  const change = ((current - previous) / previous) * 100;
  
  return {
      percent: change,
      change: change > 0.1 ? 'increase' : (change < -0.1 ? 'decrease' : 'neutral')
  };
};

/**
 * Sub-component to display a KPI with its trend.
 */
function KpiCard({ title, value, previousValue, formatter, isLoading }) {
    const { t } = useLanguage();
    
    if (isLoading) {
        return (
             <div className="bg-bg-secondary p-5 rounded-xl shadow-lg">
                <p className="text-sm text-text-muted">{title}</p>
                <p className="text-2xl font-bold text-text-muted animate-pulse">{t('reports.messages.loading')}</p>
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
  const { t, language: userLanguage } = useLanguage();
  const aiPrompts = getAIPrompts(userProfile?.language || userLanguage || 'en');
  
  const [allProperties, setAllProperties] = useState([]);
  const [filteredProperties, setFilteredProperties] = useState([]);
  const [allBookings, setAllBookings] = useState([]); // NOUVEAU: Pour extraire les canaux
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
  const [marketKpis, setMarketKpis] = useState(null); // KPIs du marché (période N)
  const [prevMarketKpis, setPrevMarketKpis] = useState(null); // KPIs du marché (période N-1)
  const [chartData, setChartData] = useState(null); // Pour le graphique de revenus
  const [performanceData, setPerformanceData] = useState(null); // NOUVEAU: Pour le graphique de performance
  const [revparData, setRevparData] = useState(null); // Pour le graphique RevPAR, ADR & Occupation
  const [iaData, setIaData] = useState(null); // Pour le graphique Gain IA & Score IA
  const [marketData, setMarketData] = useState(null); // Pour le graphique Offre vs Demande
  const [adrVsMarketData, setAdrVsMarketData] = useState(null); // Pour le graphique ADR vs Marché
  const [priceDistributionData, setPriceDistributionData] = useState(null); // Pour le graphique Distribution prix concurrents
  const [forecastRevenueData, setForecastRevenueData] = useState(null); // Pour le graphique Revenus futurs & Occupation prévue
  const [forecastAdrData, setForecastAdrData] = useState(null); // Pour le graphique ADR, RevPAR & Occupation prévus
  const [forecastScenariosData, setForecastScenariosData] = useState(null); // Pour le graphique Scénarios de prévision
  const [forecastRadarData, setForecastRadarData] = useState(null); // Pour le graphique Prévisions synthétiques par propriété
  const [revenueVsTargetData, setRevenueVsTargetData] = useState(null); // Pour le graphique Revenu total vs Objectif
  const [adrByChannelData, setAdrByChannelData] = useState(null); // Pour le graphique ADR par canal
  const [grossMarginData, setGrossMarginData] = useState(null); // Pour le graphique Marge brute (%)
  const [marketSnapshot, setMarketSnapshot] = useState(null); // Pour le bloc Analyse demande 24h (marché)

  // État pour la modale d'alerte
  const [alertModal, setAlertModal] = useState({ isOpen: false, message: '', title: '' });

  // Chart instances refs
  const revenueChartRef = useRef(null);
  const marketChartRef = useRef(null);
  const revparChartRef = useRef(null);
  const iaChartRef = useRef(null);
  const marketTrendChartRef = useRef(null); // NOUVEAU: Pour le graphique Offre vs Demande
  const adrVsMarketChartRef = useRef(null); // Pour le graphique ADR vs Marché
  const priceDistributionChartRef = useRef(null); // Pour le graphique Distribution prix concurrents
  const forecastRevenueChartRef = useRef(null); // Pour le graphique Revenus futurs & Occupation prévue
  const forecastAdrChartRef = useRef(null); // Pour le graphique ADR, RevPAR & Occupation prévus
  const forecastScenariosChartRef = useRef(null); // Pour le graphique Scénarios de prévision
  const forecastRadarChartRef = useRef(null); // Pour le graphique Prévisions synthétiques par propriété
  const revenueVsTargetChartRef = useRef(null); // Pour le graphique Revenu total vs Objectif
  const adrByChannelChartRef = useRef(null); // Pour le graphique ADR par canal
  const grossMarginChartRef = useRef(null); // Pour le graphique Marge brute (%)
  const revenueChartInstance = useRef(null);
  const marketChartInstance = useRef(null);
  const revparChartInstance = useRef(null);
  const iaChartInstance = useRef(null);
  const marketTrendChartInstance = useRef(null); // NOUVEAU: Instance du graphique Offre vs Demande
  const adrVsMarketChartInstance = useRef(null); // Instance du graphique ADR vs Marché
  const priceDistributionChartInstance = useRef(null); // Instance du graphique Distribution prix concurrents
  const forecastRevenueChartInstance = useRef(null); // Instance du graphique Revenus futurs & Occupation prévue
  const forecastAdrChartInstance = useRef(null); // Instance du graphique ADR, RevPAR & Occupation prévus
  const forecastScenariosChartInstance = useRef(null); // Instance du graphique Scénarios de prévision
  const forecastRadarChartInstance = useRef(null); // Instance du graphique Prévisions synthétiques par propriété
  const revenueVsTargetChartInstance = useRef(null); // Instance du graphique Revenu total vs Objectif
  const adrByChannelChartInstance = useRef(null); // Instance du graphique ADR par canal
  const grossMarginChartInstance = useRef(null); // Instance du graphique Marge brute (%)
  
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

  // Fonction pour calculer le ROI réel
  const calculateROI = useMemo(() => {
    if (!kpis || kpis.iaGain === undefined || kpis.iaGain === null) {
      return { roi: 0, cost: 0, gains: 0 };
    }

    const gains = kpis.iaGain || 0;
    
    // Récupérer le prix de l'abonnement depuis le profil utilisateur
    // Si l'utilisateur a un abonnement actif, utiliser le prix réel
    // Sinon, utiliser une valeur par défaut basée sur le statut
    let monthlyCost = 0;
    const subscriptionStatus = userProfile?.subscriptionStatus || 'none';
    
    if (subscriptionStatus === 'active' || subscriptionStatus === 'trialing') {
      // Si l'utilisateur a un prix d'abonnement dans son profil, l'utiliser
      if (userProfile?.subscriptionPrice) {
        monthlyCost = userProfile.subscriptionPrice;
      } else if (userProfile?.monthlyPrice) {
        monthlyCost = userProfile.monthlyPrice;
      } else {
        // Valeur par défaut pour un abonnement actif (peut être ajustée selon vos tarifs)
        // Pour l'instant, on utilise 50€/mois comme estimation
        monthlyCost = 50;
      }
    } else {
      // Pas d'abonnement actif, coût = 0
      monthlyCost = 0;
    }
    
    // Calculer le nombre de mois dans la période sélectionnée
    const { startDate, endDate } = getDatesFromRange(dateRange, userProfile?.timezone || 'UTC');
    const start = new Date(startDate);
    const end = new Date(endDate);
    const monthsDiff = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1;
    
    // Coût total pour la période
    const cost = monthlyCost * monthsDiff;
    
    // Calculer le ROI: (Gains / Coût) * 100
    // Si le coût est 0 (pas d'abonnement), le ROI est infini, on affiche 0 ou un message spécial
    const roi = cost > 0 ? (gains / cost) * 100 : (gains > 0 ? Infinity : 0);
    
    return {
      roi: roi === Infinity ? 0 : Math.max(0, roi), // ROI ne peut pas être négatif, et on gère l'infini
      cost: cost,
      gains: gains
    };
  }, [kpis, dateRange, userProfile]);

  // Fonction utilitaire pour calculer les graduations dynamiques
  const calculateScaleConfig = (dataArray, defaultMax = null, defaultStepSize = null) => {
    if (!dataArray || dataArray.length === 0) {
      return { max: defaultMax || 100, stepSize: defaultStepSize || 25 };
    }
    
    const validValues = dataArray.filter(v => typeof v === 'number' && !isNaN(v) && v >= 0);
    if (validValues.length === 0) {
      return { max: defaultMax || 100, stepSize: defaultStepSize || 25 };
    }
    
    const maxValue = Math.max(...validValues);
    if (maxValue <= 0) {
      return { max: defaultMax || 100, stepSize: defaultStepSize || 25 };
    }
    
    // Calculer un max arrondi vers le haut avec une marge de 10%
    const roundedMax = Math.ceil(maxValue * 1.1);
    
    // Calculer un stepSize approprié pour avoir environ 4-6 graduations
    let stepSize;
    if (defaultStepSize) {
      stepSize = defaultStepSize;
    } else {
      const range = roundedMax;
      // Amélioration de la logique pour des graduations plus fines et cohérentes
      if (range <= 10) {
        stepSize = 2;
      } else if (range <= 25) {
        stepSize = 5;
      } else if (range <= 50) {
        stepSize = 10;
      } else if (range <= 100) {
        stepSize = 20;
      } else if (range <= 200) {
        stepSize = 50;
      } else if (range <= 500) {
        stepSize = 100;
      } else if (range <= 1000) {
        stepSize = 200;
      } else if (range <= 2000) {
        stepSize = 500;
      } else if (range <= 5000) {
        stepSize = 1000;
      } else if (range <= 10000) {
        stepSize = 2000;
      } else if (range <= 20000) {
        stepSize = 5000;
      } else if (range <= 50000) {
        stepSize = 10000;
      } else {
        // Pour les très grandes valeurs, calculer pour avoir environ 5 graduations
        stepSize = Math.ceil(range / 5);
        // Arrondir à une valeur "ronde"
        const magnitude = Math.pow(10, Math.floor(Math.log10(stepSize)));
        stepSize = Math.ceil(stepSize / magnitude) * magnitude;
      }
    }
    
    // Arrondir le max au stepSize supérieur
    const adjustedMax = Math.ceil(roundedMax / stepSize) * stepSize;
    
    return { max: adjustedMax, stepSize };
  };

  // Fonctions de transformation des données pour les nouveaux graphiques
  const transformToMonthlyRevparData = (revenueData, perfData, language = 'en') => {
    const prompts = getAIPrompts(language);
    if (!revenueData || !revenueData.labels || !Array.isArray(revenueData.labels) || revenueData.labels.length === 0) {
      return null;
    }
    
    if (!revenueData.revenueData || !Array.isArray(revenueData.revenueData) || revenueData.revenueData.length === 0) {
      return null;
    }
    
    // Group data by month
    const monthlyData = new Map();
    
    revenueData.labels.forEach((dateStr, index) => {
      try {
        // Check if it's a valid date
        if (!dateStr || typeof dateStr !== 'string') {
          return; // Ignore invalid values
        }
        
        let date;
        // Check if it's a week format (YYYY-W##)
        if (dateStr.match(/^\d{4}-W\d{2}$/)) {
          // Extract year and week
          const [year, week] = dateStr.split('-W');
          // Approximate date to the beginning of the week
          const jan1 = new Date(parseInt(year), 0, 1);
          const daysOffset = (parseInt(week) - 1) * 7;
          date = new Date(jan1);
          date.setDate(jan1.getDate() + daysOffset);
        } else {
          date = new Date(dateStr);
        }
        
        if (isNaN(date.getTime())) {
          return; // Ignore invalid dates
        }
        
        const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        const locale = language === 'fr' ? 'fr-FR' : 'en-US';
        const monthLabel = date.toLocaleDateString(locale, { month: 'short' });
        
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
        console.error(`${prompts.errorProcessingDate}:`, dateStr, err);
        // Continue with next date
      }
    });
    
    if (monthlyData.size === 0) {
      return null;
    }
    
    // Calculate ADR, RevPAR and Occupancy
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

  const transformToMonthlyIaData = (revenueData, perfData, language = 'en', properties = []) => {
    const prompts = getAIPrompts(language);
    if (!revenueData || !revenueData.labels || !Array.isArray(revenueData.labels) || revenueData.labels.length === 0) {
      return null;
    }
    
    if (!revenueData.revenueData || !Array.isArray(revenueData.revenueData) || revenueData.revenueData.length === 0) {
      return null;
    }
    
    // Calculer le base_price moyen des propriétés si disponible
    let averageBasePrice = null;
    if (properties && properties.length > 0) {
      const propertiesWithBasePrice = properties.filter(p => p.base_price && p.base_price > 0);
      if (propertiesWithBasePrice.length > 0) {
        const sumBasePrice = propertiesWithBasePrice.reduce((sum, p) => sum + (p.base_price || 0), 0);
        averageBasePrice = sumBasePrice / propertiesWithBasePrice.length;
      }
    }
    
    // Group data by month
    const monthlyData = new Map();
    
    revenueData.labels.forEach((dateStr, index) => {
      try {
        // Check if it's a valid date
        if (!dateStr || typeof dateStr !== 'string') {
          return; // Ignore invalid values
        }
        
        let date;
        // Check if it's a week format (YYYY-W##)
        if (dateStr.match(/^\d{4}-W\d{2}$/)) {
          // Extract year and week
          const [year, week] = dateStr.split('-W');
          // Approximate date to the beginning of the week
          const jan1 = new Date(parseInt(year), 0, 1);
          const daysOffset = (parseInt(week) - 1) * 7;
          date = new Date(jan1);
          date.setDate(jan1.getDate() + daysOffset);
        } else {
          date = new Date(dateStr);
        }
        
        if (isNaN(date.getTime())) {
          return; // Ignore invalid dates
        }
        
        const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        const locale = language === 'fr' ? 'fr-FR' : 'en-US';
        const monthLabel = date.toLocaleDateString(locale, { month: 'short' });
        
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
        
        // Calculer le base revenue avec les vraies données si disponibles
        if (averageBasePrice && averageBasePrice > 0 && nightsBookedValue > 0) {
          // Utiliser le base_price moyen multiplié par le nombre de nuits réservées
          monthData.baseRevenue += averageBasePrice * nightsBookedValue;
        } else {
          // Fallback : approximation à 80% si pas de base_price disponible
          monthData.baseRevenue += revenueValue * 0.8;
        }
      } catch (err) {
        console.error(`${prompts.errorProcessingDate}:`, dateStr, err);
        // Continue with next date
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

  // NOUVEAU: Transformer les données pour le graphique Offre vs Demande
  const transformToMarketTrendData = (revenueData, perfData, language = 'en') => {
    const prompts = getAIPrompts(language);
    if (!revenueData || !revenueData.labels || !Array.isArray(revenueData.labels) || revenueData.labels.length === 0) {
      return null;
    }
    
    if (!revenueData.supplyData || !Array.isArray(revenueData.supplyData) || revenueData.supplyData.length === 0) {
      return null;
    }
    
    // Group data by month
    const monthlyData = new Map();
    
    revenueData.labels.forEach((dateStr, index) => {
      try {
        if (!dateStr || typeof dateStr !== 'string') {
          return;
        }
        
        let date;
        if (dateStr.match(/^\d{4}-W\d{2}$/)) {
          const [year, week] = dateStr.split('-W');
          const jan1 = new Date(parseInt(year), 0, 1);
          const daysOffset = (parseInt(week) - 1) * 7;
          date = new Date(jan1);
          date.setDate(jan1.getDate() + daysOffset);
        } else {
          date = new Date(dateStr);
        }
        
        if (isNaN(date.getTime())) {
          return;
        }
        
        const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        const locale = language === 'fr' ? 'fr-FR' : 'en-US';
        const monthLabel = date.toLocaleDateString(locale, { month: 'short' });
        
        if (!monthlyData.has(monthKey)) {
          monthlyData.set(monthKey, {
            label: monthLabel,
            demande: 0,
            offre: 0
          });
        }
        
        const monthData = monthlyData.get(monthKey);
        // Demand = number of nights booked (nightsBookedData represents satisfied demand)
        const demandeValue = revenueData.nightsBookedData?.[index] || 0;
        // Supply = available nights (supply)
        const offreValue = revenueData.supplyData?.[index] || 0;
        
        monthData.demande += demandeValue;
        monthData.offre += offreValue;
      } catch (err) {
        console.error(`${prompts.errorProcessingDate}:`, dateStr, err);
      }
    });
    
    if (monthlyData.size === 0) {
      return null;
    }
    
    const labels = [];
    const demandeData = [];
    const offreData = [];
    
    Array.from(monthlyData.entries()).sort().forEach(([key, data]) => {
      labels.push(data.label);
      demandeData.push(data.demande);
      offreData.push(data.offre);
    });
    
    return { labels, demandeData, offreData };
  };

  // Transformer les données pour le graphique ADR vs Marché
  const transformToAdrVsMarketData = (allProperties) => {
    // For now, we use test data based on Figma design
    // Later, this can be replaced with real API data
    if (!allProperties || allProperties.length === 0) {
      // Données de test par défaut
      return {
        labels: ['Villa Luxe', 'Chalet Alpes', 'Villa Sunset', 'Appart Centre'],
        marketAdrData: [120, 95, 140, 80],
        yourAdrData: [150, 110, 165, 100]
      };
    }
    
    // Prendre les 4 premières propriétés pour le graphique
    const properties = allProperties.slice(0, 4);
    
    const labels = properties.map(p => p.name || 'Propriété');
    const marketAdrData = properties.map(p => p.market_adr || Math.floor(Math.random() * 100 + 50));
    const yourAdrData = properties.map(p => p.adr || Math.floor(Math.random() * 100 + 80));
    
    return { labels, marketAdrData, yourAdrData };
  };

  // Transformer les données pour le graphique Distribution prix concurrents
  const transformToPriceDistributionData = () => {
    // Données de test basées sur le design Figma
    // Plus tard, cela pourra être remplacé par de vraies données de l'API
    return {
      labels: ['0-100', '100-150', '150-200', '200-250', '250-300', '300+'],
      data: [8, 12, 18, 15, 10, 5]
    };
  };

  // NOTE: Les fonctions transformToForecastData() et transformToFinancialData() ont été supprimées
  // car les données sont maintenant récupérées directement depuis l'API via les nouveaux endpoints:
  // - getForecastRevenue() pour les prévisions de revenus
  // - getForecastScenarios() pour les scénarios de prévision
  // - getForecastRadar() pour les prévisions radar
  // - getRevenueVsTarget() pour revenu vs objectif
  // - getGrossMargin() pour la marge brute

  // Fetch all properties (pour les filtres)
  const fetchAllProperties = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await getProperties(token);
      setAllProperties(data);
      setError('');
    } catch (err) {
      setError(`Error loading properties: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchAllProperties();
  }, [fetchAllProperties]);

  // NOTE: Les données ADR vs Marché et Distribution prix sont maintenant chargées via getPositioningReport dans fetchKpisAndCharts
  // NOTE: Les données de prévisions et financières sont maintenant chargées via les nouveaux endpoints dans fetchKpisAndCharts
  // Ce useEffect a été supprimé car les données sont maintenant réelles et chargées depuis l'API

  // Créer une liste de canaux uniques depuis les bookings (comme dans BookingsPage)
  const uniqueChannels = useMemo(() => {
    if (!allBookings || allBookings.length === 0) return [];
    const channels = new Set(allBookings.map(b => b.channel).filter(Boolean));
    return Array.from(channels).sort();
  }, [allBookings]);

  // Fetch KPIs (Données Réelles)
  const fetchKpisAndCharts = useCallback(async () => {
      if (!userProfile) return; 

      setIsKpiLoading(true);
      setError('');
      try {
          // 1. Obtenir les dates pour N et N-1
          const { startDate: currentStartDate, endDate: currentEndDate } = getDatesFromRange(dateRange, userProfile.timezone);
          const { startDate: prevStartDate, endDate: prevEndDate } = getPreviousDates(currentStartDate, currentEndDate);

          // 2. Préparer les filtres à passer aux appels API
          const filters = {};
          if (propertyType) filters.propertyType = propertyType;
          if (channel) filters.channel = channel;
          if (status) filters.status = status;
          if (location) filters.location = location;

          // 3. Appeler l'API pour les deux périodes en parallèle
          // NOUVEAU: Récupérer aussi les bookings pour extraire les canaux uniques
          const [
              currentData, 
              prevData, 
              currentMarketKpisData, 
              prevMarketKpisData, 
              revenueData, 
              perfData, 
              marketSnapshotData, 
              positioningReport,
              // NOUVEAUX APPELS pour les prévisions et données financières
              forecastRevenueData,
              forecastScenariosData,
              forecastRadarData,
              revenueVsTargetData,
              adrByChannelData,
              grossMarginData,
              bookingsData // NOUVEAU: Pour extraire les canaux uniques
          ] = await Promise.all([
              getReportKpis(token, currentStartDate, currentEndDate, filters),
              getReportKpis(token, prevStartDate, prevEndDate, filters),
              getMarketKpis(token, currentStartDate, currentEndDate),
              getMarketKpis(token, prevStartDate, prevEndDate),
              getRevenueOverTime(token, currentStartDate, currentEndDate, filters),
              getPerformanceOverTime(token, currentStartDate, currentEndDate, filters),
              getMarketDemandSnapshot(token, userProfile.timezone || 'Europe/Paris'),
              getPositioningReport(token, currentStartDate, currentEndDate, filters),
              // NOUVEAUX APPELS
              getForecastRevenue(token, currentStartDate, currentEndDate, 4, filters),
              getForecastScenarios(token, currentStartDate, currentEndDate, 4, filters),
              getForecastRadar(token, currentStartDate, currentEndDate, null, filters),
              getRevenueVsTarget(token, currentStartDate, currentEndDate, filters),
              getAdrByChannel(token, currentStartDate, currentEndDate, filters),
              getGrossMargin(token, currentStartDate, currentEndDate, filters),
              getTeamBookings(token, currentStartDate, currentEndDate, filters) // NOUVEAU: Pour extraire les canaux
          ]);

          // NOUVEAU: Mettre à jour les bookings pour extraire les canaux
          if (bookingsData && Array.isArray(bookingsData)) {
            setAllBookings(bookingsData);
          }
          
          setKpis(currentData);
          setPrevKpis(prevData);
          setMarketKpis(currentMarketKpisData);
          setPrevMarketKpis(prevMarketKpisData);
          setChartData(revenueData); // Sauvegarder les données du graphique de revenus
          setPerformanceData(perfData); // NOUVEAU: Sauvegarder les données du graphique de performance
          setMarketSnapshot(marketSnapshotData || null);
          if (positioningReport && positioningReport.adrVsMarket) {
            setAdrVsMarketData(positioningReport.adrVsMarket);
          }
          if (positioningReport && positioningReport.priceDistribution) {
            setPriceDistributionData(positioningReport.priceDistribution);
          }
          
          // Transformer les données pour les nouveaux graphiques
          if (revenueData && revenueData.labels && Array.isArray(revenueData.labels) && revenueData.labels.length > 0) {
            try {
              // Create data for RevPAR, ADR & Occupancy (grouped by month)
              const currentLanguage = userProfile?.language || userLanguage || 'en';
              const revparChartData = transformToMonthlyRevparData(revenueData, perfData, currentLanguage);
              if (revparChartData) {
                setRevparData(revparChartData);
              } else {
                setRevparData(null);
              }
              
              // Create data for AI Gain & AI Score (grouped by month)
              // Passer allProperties pour améliorer le calcul du Gain IA avec les base_price réels
              const iaChartData = transformToMonthlyIaData(revenueData, perfData, currentLanguage, allProperties);
              if (iaChartData) {
                setIaData(iaChartData);
              } else {
                setIaData(null);
              }
              
              // NEW: Create data for Supply vs Demand (grouped by month)
              const marketTrendChartData = transformToMarketTrendData(revenueData, perfData, currentLanguage);
              if (marketTrendChartData) {
                setMarketData(marketTrendChartData);
              } else {
                setMarketData(null);
              }
            } catch (err) {
              console.error('Error transforming data:', err);
              setRevparData(null);
              setIaData(null);
              setMarketData(null);
            }
          } else {
            setRevparData(null);
            setIaData(null);
            setMarketData(null);
          }
          
          // NOUVEAU: Mettre à jour les données de prévisions avec les vraies données
          if (forecastRevenueData) {
            // Format: { labels, revenueData, occupancyData, adrData, revparData }
            setForecastRevenueData({
              labels: forecastRevenueData.labels || [],
              revenueData: forecastRevenueData.revenueData || [],
              occupancyData: forecastRevenueData.occupancyData || []
            });
            // ADR forecast utilise les mêmes données mais avec adrData et revparData
            setForecastAdrData({
              labels: forecastRevenueData.labels || [],
              adrData: forecastRevenueData.adrData || [],
              revparData: forecastRevenueData.revparData || [],
              occupancyData: forecastRevenueData.occupancyData || []
            });
          } else {
            setForecastRevenueData(null);
            setForecastAdrData(null);
          }
          
          // NOUVEAU: Mettre à jour les scénarios de prévision
          if (forecastScenariosData) {
            setForecastScenariosData({
              labels: forecastScenariosData.labels || [],
              baselineData: forecastScenariosData.baselineData || [],
              optimisticData: forecastScenariosData.optimisticData || [],
              pessimisticData: forecastScenariosData.pessimisticData || []
            });
          } else {
            setForecastScenariosData(null);
          }
          
          // NOUVEAU: Mettre à jour les prévisions radar
          if (forecastRadarData) {
            setForecastRadarData({
              labels: forecastRadarData.labels || [],
              data: forecastRadarData.data || []
            });
          } else {
            setForecastRadarData(null);
          }
          
          // NOUVEAU: Mettre à jour les données revenu vs objectif
          if (revenueVsTargetData) {
            setRevenueVsTargetData({
              labels: revenueVsTargetData.labels || [],
              targetData: revenueVsTargetData.targetData || [],
              revenueData: revenueVsTargetData.revenueData || []
            });
          } else {
            setRevenueVsTargetData(null);
          }
          
          // NOUVEAU: Mettre à jour les données ADR par canal
          if (adrByChannelData) {
            setAdrByChannelData({
              labels: adrByChannelData.labels || [],
              data: adrByChannelData.data || [],
              variations: adrByChannelData.variations || []
            });
          } else {
            setAdrByChannelData(null);
          }
          
          // NOUVEAU: Mettre à jour les données de marge brute
          if (grossMarginData) {
            setGrossMarginData({
              labels: grossMarginData.labels || [],
              data: grossMarginData.data || []
            });
          } else {
            setGrossMarginData(null);
          }
          
      } catch (err) {
          console.error('Error loading KPIs:', err);
          setError(`${t('reports.messages.errorLoadingKpis')}: ${err.message || t('reports.messages.unknownError')}`);
          setKpis(null);
          setPrevKpis(null);
          setChartData(null);
          setPerformanceData(null); // NOUVEAU: Réinitialiser en cas d'erreur
          setRevparData(null);
          setIaData(null);
          setMarketData(null);
          setMarketSnapshot(null);
          setAdrVsMarketData(null);
          setPriceDistributionData(null);
          // NOUVEAU: Réinitialiser les nouvelles données en cas d'erreur
          setForecastRevenueData(null);
          setForecastAdrData(null);
          setForecastScenariosData(null);
          setForecastRadarData(null);
          setRevenueVsTargetData(null);
          setAdrByChannelData(null);
          setGrossMarginData(null);
      } finally {
          setIsKpiLoading(false);
      }
  }, [token, dateRange, userProfile, propertyType, channel, status, location, occupancyThreshold, allProperties]); 

  useEffect(() => {
    fetchKpisAndCharts();
  }, [fetchKpisAndCharts]);


  // Apply filters
  useEffect(() => {
    let filtered = allProperties;

    if (propertyType) filtered = filtered.filter(p => p.property_type === propertyType);
    if (channel) {
      filtered = filtered.filter(p => {
        const propChannel = p.channel || '';
        return propChannel === channel;
      });
    }
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
    // Fonction helper pour valider les données
    const isValidData = (data, requiredFields) => {
      if (!data) return false;
      for (const field of requiredFields) {
        if (!data[field] || !Array.isArray(data[field]) || data[field].length === 0) {
          return false;
        }
      }
      return true;
    };

    // Nettoyer tous les graphiques d'abord
    const cleanup = () => {
      if (revenueChartInstance.current) { 
        try { revenueChartInstance.current.destroy(); } catch(e) {}
        revenueChartInstance.current = null;
      }
      if (marketChartInstance.current) { 
        try { marketChartInstance.current.destroy(); } catch(e) {}
        marketChartInstance.current = null;
      }
      if (revparChartInstance.current) { 
        try { revparChartInstance.current.destroy(); } catch(e) {}
        revparChartInstance.current = null;
      }
      if (iaChartInstance.current) { 
        try { iaChartInstance.current.destroy(); } catch(e) {}
        iaChartInstance.current = null;
      }
      if (marketTrendChartInstance.current) { 
        try { marketTrendChartInstance.current.destroy(); } catch(e) {}
        marketTrendChartInstance.current = null;
      }
      if (adrVsMarketChartInstance.current) { 
        try { adrVsMarketChartInstance.current.destroy(); } catch(e) {}
        adrVsMarketChartInstance.current = null;
      }
      if (priceDistributionChartInstance.current) { 
        try { priceDistributionChartInstance.current.destroy(); } catch(e) {}
        priceDistributionChartInstance.current = null;
      }
      if (forecastRevenueChartInstance.current) { 
        try { forecastRevenueChartInstance.current.destroy(); } catch(e) {}
        forecastRevenueChartInstance.current = null;
      }
      if (forecastAdrChartInstance.current) { 
        try { forecastAdrChartInstance.current.destroy(); } catch(e) {}
        forecastAdrChartInstance.current = null;
      }
      if (forecastScenariosChartInstance.current) { 
        try { forecastScenariosChartInstance.current.destroy(); } catch(e) {}
        forecastScenariosChartInstance.current = null;
      }
      if (forecastRadarChartInstance.current) { 
        try { forecastRadarChartInstance.current.destroy(); } catch(e) {}
        forecastRadarChartInstance.current = null;
      }
      if (revenueVsTargetChartInstance.current) { 
        try { revenueVsTargetChartInstance.current.destroy(); } catch(e) {}
        revenueVsTargetChartInstance.current = null;
      }
      if (adrByChannelChartInstance.current) { 
        try { adrByChannelChartInstance.current.destroy(); } catch(e) {}
        adrByChannelChartInstance.current = null;
      }
      if (grossMarginChartInstance.current) { 
        try { grossMarginChartInstance.current.destroy(); } catch(e) {}
        grossMarginChartInstance.current = null;
      }
    };

    // Si les données sont en cours de chargement, nettoyer et attendre
    if (isKpiLoading) {
      cleanup();
      return;
    }

    // Utiliser un petit délai pour s'assurer que le DOM est prêt
    const timeoutId = setTimeout(() => {
      // Nettoyer d'abord
      cleanup();

      // Graphique des Revenus (RÉEL)
      if (revenueChartRef.current && isValidData(chartData, ['labels', 'revenueData'])) {
        try {
          const revenueScale = calculateScaleConfig(chartData.revenueData);
          const ctxRevenue = revenueChartRef.current.getContext('2d');
          revenueChartInstance.current = new Chart(ctxRevenue, { 
            type: 'line', 
            data: { 
              labels: chartData.labels, 
              datasets: [{ 
                label: t('reports.legends.realRevenue'), 
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
                  max: revenueScale.max,
                  ticks: { 
                    color: '#9ca3af',
                    stepSize: revenueScale.stepSize,
                    precision: 0,
                    callback: function(value) {
                      return value.toFixed(0);
                    }
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
        } catch (error) {
          console.error('Error creating revenue chart:', error);
        }
      }

      // NOUVEAU: Graphique Performance (RÉEL)
      if (marketChartRef.current && isValidData(performanceData, ['labels', 'bookingCounts', 'occupancyRates'])) {
        try {
          const bookingScale = calculateScaleConfig(performanceData.bookingCounts);
          const ctxMarket = marketChartRef.current.getContext('2d');
          marketChartInstance.current = new Chart(ctxMarket, {
        type: 'bar', // Type principal en barres
        data: {
          labels: performanceData.labels,
          datasets: [
            { 
              label: t('reports.legends.bookings'), 
              data: performanceData.bookingCounts, 
              backgroundColor: '#00d3f2', // Couleur highlight-2nd
              borderColor: '#00d3f2',
              borderWidth: 0,
              yAxisID: 'y', // Axe Y gauche
            },
            {
              label: t('reports.legends.occupancy'),
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
                    max: bookingScale.max,
                    position: 'left',
                    ticks: { 
                      color: '#94a3b8', 
                      font: { family: 'Inter-Regular, sans-serif', size: 12 },
                      stepSize: bookingScale.stepSize,
                      precision: 0,
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
                // Axe Y droit (Ligne - %)
                y1: {
                    beginAtZero: true,
                    max: 100, // L'occupation est un %
                    position: 'right',
                    ticks: { 
                      color: '#94a3b8', 
                      font: { family: 'Inter-Regular, sans-serif', size: 12 },
                      stepSize: 25,
                      precision: 0,
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
        } catch (error) {
          console.error('Error creating market chart:', error);
        }
      }

      // Graphique RevPAR, ADR & Occupation
      if (revparChartRef.current && isValidData(revparData, ['labels', 'adrData', 'revparData', 'occupancyData'])) {
        try {
          // Calculer le max pour ADR et RevPAR (utiliser le max des deux)
          const adrRevparData = [...(revparData.adrData || []), ...(revparData.revparData || [])];
          const adrRevparScale = calculateScaleConfig(adrRevparData);
          const ctxRevpar = revparChartRef.current.getContext('2d');
          revparChartInstance.current = new Chart(ctxRevpar, {
        type: 'line',
        data: {
          labels: revparData.labels,
          datasets: [
            {
              label: t('reports.legends.adr'),
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
              label: t('reports.legends.occupancy'),
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
              max: adrRevparScale.max,
              position: 'left',
              ticks: {
                color: '#94a3b8',
                font: { family: 'Inter-Regular, sans-serif', size: 12 },
                stepSize: adrRevparScale.stepSize,
                precision: 0,
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
                precision: 0,
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
        } catch (error) {
          console.error('Error creating revpar chart:', error);
        }
      }

      // Graphique Gain IA & Score IA
      if (iaChartRef.current && isValidData(iaData, ['labels', 'gainIaData', 'scoreIaData'])) {
        try {
          // Calculer l'échelle pour AI Gain
          const gainScale = calculateScaleConfig(iaData.gainIaData);
          let gainMax = gainScale.max;
          let gainStepSize = gainScale.stepSize;
          let gainMin = 0;
          let gainBeginAtZero = true;
          
          // Calculer l'échelle pour AI Score (0-100)
          let scoreMax = 100;
          let scoreStepSize = 25;
          let scoreMin = 0;
          let scoreBeginAtZero = true;
          
          // Calculer le nombre de graduations pour chaque axe
          const gainRange = gainMax - gainMin;
          const gainNumTicks = Math.ceil(gainRange / gainStepSize) + 1;
          
          const scoreRange = scoreMax - scoreMin;
          const scoreNumTicks = Math.ceil(scoreRange / scoreStepSize) + 1;
          
          // Forcer le même nombre de graduations sur les deux axes pour l'alignement
          const targetNumTicks = Math.max(4, Math.min(6, Math.max(gainNumTicks, scoreNumTicks)));
          
          // Ajuster l'axe Y gauche (AI Gain) pour avoir exactement targetNumTicks graduations
          if (gainNumTicks !== targetNumTicks) {
            gainStepSize = gainRange / (targetNumTicks - 1);
            // Arrondir à une valeur "ronde"
            const magnitude = Math.pow(10, Math.floor(Math.log10(gainStepSize)));
            gainStepSize = Math.ceil(gainStepSize / magnitude) * magnitude;
            gainMax = gainMin + (targetNumTicks - 1) * gainStepSize;
          }
          
          // Ajuster l'axe Y droit (AI Score) pour avoir exactement targetNumTicks graduations
          if (scoreNumTicks !== targetNumTicks) {
            scoreStepSize = scoreRange / (targetNumTicks - 1);
            // Arrondir à une valeur "ronde"
            const magnitude = Math.pow(10, Math.floor(Math.log10(scoreStepSize)));
            scoreStepSize = Math.ceil(scoreStepSize / magnitude) * magnitude;
            scoreMax = scoreMin + (targetNumTicks - 1) * scoreStepSize;
          }
          
          const ctxIa = iaChartRef.current.getContext('2d');
      iaChartInstance.current = new Chart(ctxIa, {
        type: 'line',
        data: {
          labels: iaData.labels,
          datasets: [
            {
              label: t('reports.legends.aiGain'),
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
              label: 'AI Score (/100)',
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
              beginAtZero: gainBeginAtZero,
              min: gainMin,
              max: gainMax,
              position: 'left',
              ticks: {
                color: '#94a3b8',
                font: { family: 'Inter-Regular, sans-serif', size: 12 },
                stepSize: gainStepSize,
                precision: gainStepSize < 1 ? 1 : 0,
                padding: 4,
                callback: function(value) {
                  return value.toFixed(gainStepSize < 1 ? 1 : 0);
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
              beginAtZero: scoreBeginAtZero,
              min: scoreMin,
              max: scoreMax,
              position: 'right',
              ticks: {
                color: '#94a3b8',
                font: { family: 'Inter-Regular, sans-serif', size: 12 },
                stepSize: scoreStepSize,
                precision: scoreStepSize < 1 ? 1 : 0,
                padding: 4,
                callback: function(value) {
                  return value.toFixed(scoreStepSize < 1 ? 1 : 0);
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
        } catch (error) {
          console.error('Error creating IA chart:', error);
        }
      }

      // NOUVEAU: Graphique Tendance marché - Offre vs Demande
      if (marketTrendChartRef.current && isValidData(marketData, ['labels', 'demandeData', 'offreData'])) {
        try {
          const marketTrendData = [...(marketData.demandeData || []), ...(marketData.offreData || [])];
          const marketTrendScale = calculateScaleConfig(marketTrendData);
          const ctxMarketTrend = marketTrendChartRef.current.getContext('2d');
      marketTrendChartInstance.current = new Chart(ctxMarketTrend, {
        type: 'line',
        data: {
          labels: marketData.labels,
          datasets: [
            {
              label: t('reports.legends.demand'),
              data: marketData.demandeData,
              borderColor: '#00d3f2',
              backgroundColor: 'transparent',
              tension: 0.3,
              fill: false,
              pointRadius: 4,
              pointBackgroundColor: '#00d3f2',
              pointBorderColor: '#00d3f2',
              pointBorderWidth: 2,
              pointHoverRadius: 6,
            },
            {
              label: t('reports.legends.supply'),
              data: marketData.offreData,
              borderColor: '#fef137',
              backgroundColor: 'transparent',
              tension: 0.3,
              fill: false,
              pointRadius: 4,
              pointBackgroundColor: '#fef137',
              pointBorderColor: '#fef137',
              pointBorderWidth: 2,
              pointHoverRadius: 6,
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
              max: marketTrendScale.max,
              ticks: {
                color: '#94a3b8',
                font: { family: 'Inter-Regular, sans-serif', size: 12 },
                stepSize: marketTrendScale.stepSize,
                precision: 0,
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
        } catch (error) {
          console.error('Error creating market trend chart:', error);
        }
      }

      // Graphique ADR vs Marché
      if (adrVsMarketChartRef.current && isValidData(adrVsMarketData, ['labels', 'marketAdrData', 'yourAdrData'])) {
        try {
          const adrVsMarketDataCombined = [...(adrVsMarketData.marketAdrData || []), ...(adrVsMarketData.yourAdrData || [])];
          const adrVsMarketScale = calculateScaleConfig(adrVsMarketDataCombined);
          const ctxAdrVsMarket = adrVsMarketChartRef.current.getContext('2d');
          adrVsMarketChartInstance.current = new Chart(ctxAdrVsMarket, {
        type: 'bar',
        data: {
          labels: adrVsMarketData.labels,
          datasets: [
            {
              label: t('reports.legends.marketAdr'),
              data: adrVsMarketData.marketAdrData,
              backgroundColor: 'rgba(148, 163, 184, 0.3)',
              borderColor: '#94a3b8',
              borderWidth: 1,
            },
            {
              label: 'Your ADR',
              data: adrVsMarketData.yourAdrData,
              backgroundColor: '#00d3f2',
              borderColor: '#00d3f2',
              borderWidth: 1,
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
              max: adrVsMarketScale.max,
              ticks: {
                color: '#94a3b8',
                font: { family: 'Inter-Regular, sans-serif', size: 12 },
                stepSize: adrVsMarketScale.stepSize,
                precision: 0,
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
        } catch (error) {
          console.error('Error creating ADR vs Market chart:', error);
        }
      }

      // Graphique Distribution prix concurrents
      if (priceDistributionChartRef.current && isValidData(priceDistributionData, ['labels', 'data'])) {
        try {
          const priceDistributionScale = calculateScaleConfig(priceDistributionData.data);
          const ctxPriceDistribution = priceDistributionChartRef.current.getContext('2d');
          priceDistributionChartInstance.current = new Chart(ctxPriceDistribution, {
        type: 'bar',
        data: {
          labels: priceDistributionData.labels,
          datasets: [
            {
              label: 'Number of competitors',
              data: priceDistributionData.data,
              backgroundColor: '#00d3f2',
              borderColor: '#00d3f2',
              borderWidth: 1,
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
              max: priceDistributionScale.max,
              ticks: {
                color: '#94a3b8',
                font: { family: 'Inter-Regular, sans-serif', size: 12 },
                stepSize: priceDistributionScale.stepSize,
                precision: 0,
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
        } catch (error) {
          console.error('Error creating Price Distribution chart:', error);
        }
      }

      // Graphique Revenus futurs & Occupation prévue
      if (forecastRevenueChartRef.current && isValidData(forecastRevenueData, ['labels', 'revenueData', 'occupancyData'])) {
        try {
          const forecastRevenueScale = calculateScaleConfig(forecastRevenueData.revenueData);
          const ctxForecastRevenue = forecastRevenueChartRef.current.getContext('2d');
          forecastRevenueChartInstance.current = new Chart(ctxForecastRevenue, {
        type: 'bar',
        data: {
          labels: forecastRevenueData.labels,
          datasets: [
            {
              label: t('reports.legends.forecastedRevenue'),
              data: forecastRevenueData.revenueData,
              backgroundColor: '#1e40af',
              borderColor: '#1e40af',
              borderWidth: 1,
              yAxisID: 'y',
            },
            {
              label: t('reports.legends.occupancy'),
              data: forecastRevenueData.occupancyData,
              type: 'line',
              borderColor: '#06b6d4',
              backgroundColor: 'transparent',
              tension: 0.3,
              fill: false,
              pointRadius: 4,
              pointBackgroundColor: '#06b6d4',
              pointBorderColor: '#06b6d4',
              pointBorderWidth: 2,
              pointHoverRadius: 6,
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
              max: forecastRevenueScale.max,
              position: 'left',
              ticks: {
                color: '#94a3b8',
                font: { family: 'Inter-Regular, sans-serif', size: 12 },
                stepSize: forecastRevenueScale.stepSize,
                precision: 0,
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
        } catch (error) {
          console.error('Error creating Forecast Revenue chart:', error);
        }
      }

      // Graphique ADR, RevPAR & Occupation prévus
      if (forecastAdrChartRef.current && isValidData(forecastAdrData, ['labels', 'adrData', 'revparData', 'occupancyData'])) {
        try {
          // Filtrer les valeurs invalides
          const adrValues = (forecastAdrData.adrData || []).filter(v => typeof v === 'number' && !isNaN(v) && v >= 0);
          const revparValues = (forecastAdrData.revparData || []).filter(v => typeof v === 'number' && !isNaN(v) && v >= 0);
          const occupancyValues = (forecastAdrData.occupancyData || []).filter(v => typeof v === 'number' && !isNaN(v) && v >= 0);
          
          // Calculer les max et min pour détecter les grandes différences
          const maxAdr = adrValues.length > 0 ? Math.max(...adrValues) : 0;
          const maxRevpar = revparValues.length > 0 ? Math.max(...revparValues) : 0;
          const minRevpar = revparValues.length > 0 ? Math.min(...revparValues) : 0;
          
          // Calculer l'échelle pour ADR et RevPAR
          const combinedScale = calculateScaleConfig([...adrValues, ...revparValues]);
          let yAxisMax = combinedScale.max;
          let yAxisStepSize = combinedScale.stepSize;
          let yAxisBeginAtZero = true;
          let yAxisMin = 0;
          
          // Calculer l'échelle pour Occupancy de manière adaptative
          const maxOccupancy = occupancyValues.length > 0 ? Math.max(...occupancyValues) : 100;
          const minOccupancy = occupancyValues.length > 0 ? Math.min(...occupancyValues) : 0;
          const occupancyRange = maxOccupancy - minOccupancy;
          
          let occupancyMax = 100;
          let occupancyStepSize = 25;
          let occupancyBeginAtZero = true;
          let occupancyMin = 0;
          
          if (maxOccupancy < 10 && occupancyRange > 0) {
            // Échelle adaptée pour les petites valeurs
            occupancyMax = Math.ceil(maxOccupancy * 1.2);
            occupancyMin = Math.max(0, Math.floor(minOccupancy * 0.9));
            
            const range = occupancyMax - occupancyMin;
            if (range <= 5) {
              occupancyStepSize = 1;
            } else if (range <= 10) {
              occupancyStepSize = 2;
            } else {
              occupancyStepSize = Math.ceil(range / 5);
            }
            
            occupancyMax = Math.ceil(occupancyMax / occupancyStepSize) * occupancyStepSize;
            occupancyBeginAtZero = false;
          }
          
          // Calculer le nombre de graduations pour chaque axe
          const yAxisRange = yAxisMax - yAxisMin;
          const yAxisNumTicks = Math.ceil(yAxisRange / yAxisStepSize) + 1;
          
          const occupancyRange2 = occupancyMax - occupancyMin;
          const occupancyNumTicks = Math.ceil(occupancyRange2 / occupancyStepSize) + 1;
          
          // Forcer le même nombre de graduations sur les deux axes pour l'alignement
          const targetNumTicks = Math.max(4, Math.min(6, Math.max(yAxisNumTicks, occupancyNumTicks)));
          
          // Ajuster l'axe Y gauche pour avoir exactement targetNumTicks graduations
          if (yAxisNumTicks !== targetNumTicks) {
            yAxisStepSize = yAxisRange / (targetNumTicks - 1);
            // Arrondir à une valeur "ronde"
            const magnitude = Math.pow(10, Math.floor(Math.log10(yAxisStepSize)));
            yAxisStepSize = Math.ceil(yAxisStepSize / magnitude) * magnitude;
            yAxisMax = yAxisMin + (targetNumTicks - 1) * yAxisStepSize;
          }
          
          // Ajuster l'axe Y droit pour avoir exactement targetNumTicks graduations
          if (occupancyNumTicks !== targetNumTicks) {
            occupancyStepSize = occupancyRange2 / (targetNumTicks - 1);
            // Arrondir à une valeur "ronde"
            const magnitude = Math.pow(10, Math.floor(Math.log10(occupancyStepSize)));
            occupancyStepSize = Math.ceil(occupancyStepSize / magnitude) * magnitude;
            occupancyMax = occupancyMin + (targetNumTicks - 1) * occupancyStepSize;
          }
          
          const ctxForecastAdr = forecastAdrChartRef.current.getContext('2d');
          forecastAdrChartInstance.current = new Chart(ctxForecastAdr, {
        type: 'line',
        data: {
          labels: forecastAdrData.labels,
          datasets: [
            {
              label: t('reports.legends.adr'),
              data: forecastAdrData.adrData,
              borderColor: '#8b5cf6',
              backgroundColor: 'transparent',
              tension: 0.3,
              fill: false,
              pointRadius: 4,
              pointBackgroundColor: '#8b5cf6',
              pointBorderColor: '#8b5cf6',
              yAxisID: 'y', // Axe Y gauche pour ADR
            },
            {
              label: 'RevPAR (€)',
              data: forecastAdrData.revparData,
              borderColor: '#06b6d4',
              backgroundColor: 'transparent',
              tension: 0.3,
              fill: false,
              pointRadius: 4,
              pointBackgroundColor: '#06b6d4',
              pointBorderColor: '#06b6d4',
              yAxisID: 'y', // Même axe que ADR mais avec échelle adaptée
            },
            {
              label: t('reports.legends.occupancy'),
              data: forecastAdrData.occupancyData,
              borderColor: '#10b981',
              backgroundColor: 'transparent',
              tension: 0.3,
              fill: false,
              pointRadius: 4,
              pointBackgroundColor: '#10b981',
              pointBorderColor: '#10b981',
              yAxisID: 'y1', // Axe Y droit pour Occupancy
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
              beginAtZero: yAxisBeginAtZero,
              min: yAxisMin,
              max: yAxisMax,
              position: 'left',
              ticks: {
                color: '#94a3b8',
                font: { family: 'Inter-Regular, sans-serif', size: 12 },
                stepSize: yAxisStepSize,
                precision: yAxisStepSize < 1 ? 1 : 0,
                padding: 4,
                callback: function(value) {
                  return value.toFixed(yAxisStepSize < 1 ? 1 : 0);
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
              beginAtZero: occupancyBeginAtZero,
              min: occupancyMin,
              max: occupancyMax,
              position: 'right',
              ticks: {
                color: '#94a3b8',
                font: { family: 'Inter-Regular, sans-serif', size: 12 },
                stepSize: occupancyStepSize,
                precision: occupancyStepSize < 1 ? 1 : 0,
                padding: 4,
                callback: function(value) {
                  return value.toFixed(occupancyStepSize < 1 ? 1 : 0);
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
        } catch (error) {
          console.error('Error creating Forecast ADR chart:', error);
        }
      }

      // Graphique Scénarios de prévision
      if (forecastScenariosChartRef.current && isValidData(forecastScenariosData, ['labels', 'baselineData', 'optimisticData', 'pessimisticData'])) {
        try {
          const forecastScenariosDataCombined = [
            ...(forecastScenariosData.baselineData || []),
            ...(forecastScenariosData.optimisticData || []),
            ...(forecastScenariosData.pessimisticData || [])
          ];
          const forecastScenariosScale = calculateScaleConfig(forecastScenariosDataCombined);
          const ctxForecastScenarios = forecastScenariosChartRef.current.getContext('2d');
          forecastScenariosChartInstance.current = new Chart(ctxForecastScenarios, {
        type: 'line',
        data: {
          labels: forecastScenariosData.labels,
          datasets: [
            {
              label: 'Baseline scenario',
              data: forecastScenariosData.baselineData,
              borderColor: '#06b6d4',
              backgroundColor: 'transparent',
              tension: 0.3,
              fill: false,
              pointRadius: 4,
              pointBackgroundColor: '#06b6d4',
              pointBorderColor: '#06b6d4',
              pointBorderWidth: 2,
              pointHoverRadius: 6,
            },
            {
              label: t('reports.scenarios.optimistic'),
              data: forecastScenariosData.optimisticData,
              borderColor: '#10b981',
              backgroundColor: 'transparent',
              tension: 0.3,
              fill: false,
              pointRadius: 4,
              pointBackgroundColor: '#10b981',
              pointBorderColor: '#10b981',
              pointBorderWidth: 2,
              pointHoverRadius: 6,
            },
            {
              label: 'Pessimistic scenario (-10%)',
              data: forecastScenariosData.pessimisticData,
              borderColor: '#ef4444',
              backgroundColor: 'transparent',
              tension: 0.3,
              fill: false,
              pointRadius: 4,
              pointBackgroundColor: '#ef4444',
              pointBorderColor: '#ef4444',
              pointBorderWidth: 2,
              pointHoverRadius: 6,
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
              max: forecastScenariosScale.max,
              ticks: {
                color: '#94a3b8',
                font: { family: 'Inter-Regular, sans-serif', size: 12 },
                stepSize: forecastScenariosScale.stepSize,
                precision: 0,
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
        } catch (error) {
          console.error('Error creating Forecast Scenarios chart:', error);
        }
      }

      // Graphique Prévisions synthétiques par propriété (Radar)
      if (forecastRadarChartRef.current && isValidData(forecastRadarData, ['labels', 'data'])) {
        try {
          const ctxForecastRadar = forecastRadarChartRef.current.getContext('2d');
          forecastRadarChartInstance.current = new Chart(ctxForecastRadar, {
        type: 'radar',
        data: {
          labels: forecastRadarData.labels,
          datasets: [
            {
              label: t('reports.legends.forecasts'),
              data: forecastRadarData.data,
              borderColor: '#00d3f2',
              backgroundColor: 'rgba(0, 211, 242, 0.2)',
              pointBackgroundColor: '#00d3f2',
              pointBorderColor: '#00d3f2',
              pointHoverBackgroundColor: '#fff',
              pointHoverBorderColor: '#00d3f2',
            }
          ]
        },
        options: {
          scales: {
            r: {
              beginAtZero: true,
              max: 100,
              ticks: {
                stepSize: 25,
                color: '#94a3b8',
                font: { family: 'Inter-Regular, sans-serif', size: 12 },
                backdropColor: 'transparent'
              },
              grid: {
                color: 'rgba(148, 163, 184, 0.2)'
              },
              pointLabels: {
                color: '#94a3b8',
                font: { family: 'Inter-Regular, sans-serif', size: 12 }
              }
            }
          },
          plugins: {
            legend: { display: false }
          },
          maintainAspectRatio: false
        }
      });
        } catch (error) {
          console.error('Error creating Forecast Radar chart:', error);
        }
      }

      // Graphique Revenu total vs Objectif
      if (revenueVsTargetChartRef.current && isValidData(revenueVsTargetData, ['labels', 'targetData', 'revenueData'])) {
        try {
          const revenueVsTargetDataCombined = [...(revenueVsTargetData.targetData || []), ...(revenueVsTargetData.revenueData || [])];
          const revenueVsTargetScale = calculateScaleConfig(revenueVsTargetDataCombined);
          const ctxRevenueVsTarget = revenueVsTargetChartRef.current.getContext('2d');
          revenueVsTargetChartInstance.current = new Chart(ctxRevenueVsTarget, {
        type: 'line',
        data: {
          labels: revenueVsTargetData.labels,
          datasets: [
            {
              label: t('reports.legends.target'),
              data: revenueVsTargetData.targetData,
              borderColor: '#64748b',
              backgroundColor: 'transparent',
              tension: 0.3,
              fill: false,
              pointRadius: 4,
              pointBackgroundColor: '#64748b',
              pointBorderColor: '#64748b',
              borderWidth: 2,
              borderDash: [5, 5],
            },
            {
              label: t('reports.legends.realRevenue'),
              data: revenueVsTargetData.revenueData,
              borderColor: '#06b6d4',
              backgroundColor: 'transparent',
              tension: 0.3,
              fill: false,
              pointRadius: 4,
              pointBackgroundColor: '#06b6d4',
              pointBorderColor: '#06b6d4',
              borderWidth: 2,
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
              max: revenueVsTargetScale.max,
              ticks: {
                color: '#94a3b8',
                font: { family: 'Inter-Regular, sans-serif', size: 12 },
                stepSize: revenueVsTargetScale.stepSize,
                precision: 0,
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
        } catch (error) {
          console.error('Error creating Revenue vs Target chart:', error);
        }
      }

      // Graphique ADR par canal (barres horizontales)
      if (adrByChannelChartRef.current && isValidData(adrByChannelData, ['labels', 'data'])) {
        try {
          const adrByChannelScale = calculateScaleConfig(adrByChannelData.data);
          const ctxAdrByChannel = adrByChannelChartRef.current.getContext('2d');
          adrByChannelChartInstance.current = new Chart(ctxAdrByChannel, {
        type: 'bar',
        data: {
          labels: adrByChannelData.labels,
          datasets: [
            {
              label: t('reports.legends.adr'),
              data: adrByChannelData.data,
              backgroundColor: '#00d3f2',
              borderColor: '#00d3f2',
              borderWidth: 1,
            }
          ]
        },
        options: {
          indexAxis: 'y', // Barres horizontales
          scales: {
            x: {
              beginAtZero: true,
              max: adrByChannelScale.max,
              ticks: {
                color: '#94a3b8',
                font: { family: 'Inter-Regular, sans-serif', size: 12 },
                stepSize: adrByChannelScale.stepSize,
                precision: 0,
                padding: 8,
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
            y: {
              ticks: {
                color: '#94a3b8',
                font: { family: 'Inter-Regular, sans-serif', size: 12 },
                padding: 4
              },
              grid: { display: false },
              border: { display: false }
            }
          },
          plugins: {
            legend: { display: false }
          },
          maintainAspectRatio: false
        }
      });
        } catch (error) {
          console.error('Error creating ADR by Channel chart:', error);
        }
      }

      // Graphique Marge brute (%)
      if (grossMarginChartRef.current && isValidData(grossMarginData, ['labels', 'data'])) {
        try {
          // Pour les pourcentages, on utilise un max de 100 si les données sont < 100, sinon on calcule dynamiquement
          const maxMarginValue = Math.max(...(grossMarginData.data || []).filter(v => typeof v === 'number' && !isNaN(v)));
          const grossMarginScale = maxMarginValue <= 100 
            ? { max: 100, stepSize: 25 }
            : calculateScaleConfig(grossMarginData.data);
          const ctxGrossMargin = grossMarginChartRef.current.getContext('2d');
          grossMarginChartInstance.current = new Chart(ctxGrossMargin, {
        type: 'line',
        data: {
          labels: grossMarginData.labels,
          datasets: [
            {
              label: t('reports.charts.grossMargin'),
              data: grossMarginData.data,
              borderColor: '#00d3f2',
              backgroundColor: 'rgba(0, 211, 242, 0.1)',
              tension: 0.3,
              fill: true,
              pointRadius: 4,
              pointBackgroundColor: '#00d3f2',
              pointBorderColor: '#00d3f2',
              pointBorderWidth: 2,
              pointHoverRadius: 6,
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
              max: grossMarginScale.max,
              ticks: {
                color: '#94a3b8',
                font: { family: 'Inter-Regular, sans-serif', size: 12 },
                stepSize: grossMarginScale.stepSize,
                precision: 0,
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
        } catch (error) {
          console.error('Error creating Gross Margin chart:', error);
        }
      }
    }, 100); // Petit délai pour s'assurer que le DOM est prêt

     return () => {
         clearTimeout(timeoutId);
         if (revenueChartInstance.current) { revenueChartInstance.current.destroy(); }
         if (marketChartInstance.current) { marketChartInstance.current.destroy(); }
         if (revparChartInstance.current) { revparChartInstance.current.destroy(); }
         if (iaChartInstance.current) { iaChartInstance.current.destroy(); }
         if (marketTrendChartInstance.current) { marketTrendChartInstance.current.destroy(); }
         if (adrVsMarketChartInstance.current) { adrVsMarketChartInstance.current.destroy(); }
         if (priceDistributionChartInstance.current) { priceDistributionChartInstance.current.destroy(); }
         if (forecastRevenueChartInstance.current) { forecastRevenueChartInstance.current.destroy(); }
         if (forecastAdrChartInstance.current) { forecastAdrChartInstance.current.destroy(); }
         if (forecastScenariosChartInstance.current) { forecastScenariosChartInstance.current.destroy(); }
         if (forecastRadarChartInstance.current) { forecastRadarChartInstance.current.destroy(); }
         if (revenueVsTargetChartInstance.current) { revenueVsTargetChartInstance.current.destroy(); }
         if (adrByChannelChartInstance.current) { adrByChannelChartInstance.current.destroy(); }
         if (grossMarginChartInstance.current) { grossMarginChartInstance.current.destroy(); }
     };

  }, [chartData, performanceData, revparData, iaData, marketData, adrVsMarketData, priceDistributionData, forecastRevenueData, forecastAdrData, forecastScenariosData, forecastRadarData, revenueVsTargetData, adrByChannelData, grossMarginData, isKpiLoading, activeTab]); // Se redéclenche si les données des graphiques changent, si le chargement change, ou si l'onglet change

  const handleExport = () => {
    if (filteredProperties.length === 0) {
      setAlertModal({ isOpen: true, message: t('reports.messages.noDataToExport'), title: t('reports.messages.information') || 'Information' });
      return;
    }
    // Retirer toutes les propriétés id des objets avant l'export
    const dataWithoutIds = filteredProperties.map(property => {
      const cleanedProperty = { ...property };
      // Retirer toutes les clés qui contiennent "id" (insensible à la casse)
      Object.keys(cleanedProperty).forEach(key => {
        if (key.toLowerCase().includes('id')) {
          delete cleanedProperty[key];
        }
      });
      return cleanedProperty;
    });
    exportToExcel(dataWithoutIds, `Rapport_Proprietes_${dateRange}`, (errorMessage) => {
      setAlertModal({ isOpen: true, message: errorMessage, title: t('reports.messages.error') || 'Error' });
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
            {t('reports.title') || 'Activity Reports'}
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
                text={t('reports.stats.totalRevenue')}
                value={formatCurrency(kpis?.totalRevenue || 0)}
                className="!flex-1 !shrink-[unset]"
              />
              <PremiReStats
                state="big"
                text={t('reports.stats.occupancyRate')}
                value={formatPercent(kpis?.avgOccupancy || 0)}
                icon={IconsStateProp}
                iconState="prop"
                className="!flex-1 !shrink-[unset]"
              />
              <PremiReStats
                state="big"
                text={t('reports.stats.adr')}
                value={formatCurrencyAdr(kpis?.adr || 0)}
                icon={IconsStateArgent}
                iconState="argent"
                className="!flex-1 !shrink-[unset]"
              />
              <PremiReStats
                state="big"
                text={t('reports.stats.aiGains')}
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
                {t('reports.filters.title')} :{" "}
              </div>
            </div>
            <div className="flex flex-row gap-3 items-center justify-start shrink-0 relative">
              <BoutonStatePrincipal
                component={<IconsStateExport className="!w-5 !h-5" state="export" />}
                text={t('reports.filters.export')}
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
                {t('reports.tabs.overview')}{" "}
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
                {t('reports.tabs.market')}{" "}
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
                {t('reports.tabs.positioning')}{" "}
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
                {t('reports.tabs.forecast')}{" "}
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
                {t('reports.tabs.financial')}{" "}
              </div>
            </button>
          </div>

          {/* Filtres */}
          <div className="flex flex-row gap-5 gap-y-3 items-start justify-start flex-wrap content-start self-stretch shrink-0 relative">
            {isLoading ? (
              <p className="text-xs text-global-inactive">{t('reports.filters.loading')}</p>
            ) : (
              <>
                <Filtre
                  text={t('reports.filters.period')}
                  text2={dateRange === '7d' ? t('reports.periods.7d') : 
                        dateRange === '1m' ? t('reports.periods.1m') :
                        dateRange === '6m' ? t('reports.periods.6m') :
                        dateRange === 'ytd' ? t('reports.periods.ytd') :
                        dateRange === '1y' ? t('reports.periods.1y') :
                        dateRange === 'all' ? t('reports.periods.all') : t('reports.periods.1m')}
                  value={dateRange}
                  onChange={(value) => setDateRange(value)}
                  options={[
                    { value: '7d', label: t('reports.periods.7d') },
                    { value: '1m', label: t('reports.periods.1m') },
                    { value: '6m', label: t('reports.periods.6m') },
                    { value: 'ytd', label: t('reports.periods.ytd') },
                    { value: '1y', label: t('reports.periods.1y') },
                    { value: 'all', label: t('reports.periods.all') }
                  ]}
                  className="!shrink-0"
                />
                <Filtre
                  text={t('reports.filters.propertyType')}
                  text2={propertyType ? allProperties.find(p => p.property_type === propertyType)?.property_type || t('reports.filters.allTypes') : t('reports.filters.allTypes')}
                  value={propertyType}
                  onChange={(value) => setPropertyType(value)}
                  options={[...new Set(allProperties.map(p => p.property_type))].filter(Boolean)}
                  className="!shrink-0"
                />
                <Filtre
                  text={t('reports.filters.channel')}
                  text2={channel ? channel : t('reports.filters.allChannels')}
                  value={channel || ''}
                  onChange={(value) => {
                    setChannel(value === '' ? '' : value);
                  }}
                  options={uniqueChannels}
                  className="!shrink-0"
                />
                <Filtre
                  text={t('reports.filters.status')}
                  text2={status ? status : t('reports.filters.allStatuses')}
                  value={status}
                  onChange={(value) => setStatus(value)}
                  options={[...new Set(allProperties.map(p => p.status))].filter(Boolean)}
                  className="!shrink-0"
                />
                <div className="flex flex-col gap-2 items-start justify-start shrink-0 relative">
                  <div className="text-global-blanc text-left font-p1-font-family text-p1-font-size font-p1-font-weight relative self-stretch">
                    {t('reports.filters.location')}{" "}
                  </div>
                  <div className="bg-global-bg-small-box rounded-lg border-solid border-global-stroke-box border pt-[7px] pr-3 pb-[7px] pl-3 flex flex-row gap-3 items-center justify-start self-stretch shrink-0 h-[38px] relative">
                    <input
                      type="text"
                      value={location}
                      onChange={(e) => setLocation(e.target.value)}
                      placeholder={t('reports.filters.locationPlaceholder')}
                      className="flex-1 bg-transparent border-none outline-none text-global-inactive font-h4-font-family text-h4-font-size leading-h4-line-height font-h4-font-weight placeholder:text-global-inactive"
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

      {error && <p className="text-red-400 text-center">{error}</p>}
      
      {/* Graphiques selon l'onglet actif */}
      <div className="flex flex-col gap-3 items-start justify-start self-stretch shrink-0 relative">
        {/* Vue d'ensemble - Performance hebdomadaire + RevPAR/ADR/Occupation + Gain IA */}
        {activeTab === 'overview' && (
          <>
            {/* Performance hebdomadaire - seul */}
            <div className="bg-global-bg-box rounded-[14px] border-solid border-global-stroke-box border p-6 flex flex-col gap-6 items-start justify-start self-stretch shrink-0 relative">
              <div className="self-stretch shrink-0 h-7 relative">
                <div className="text-global-blanc text-left font-['Inter-Medium',_sans-serif] text-xl leading-7 font-medium" style={{ letterSpacing: '-0.45px' }}>
                  {t('reports.charts.weeklyPerformance')}
                </div>
              </div>
              <div className="flex flex-col gap-2.5 items-start justify-start self-stretch shrink-0 relative">
                <div className="self-stretch shrink-0 h-[261.74px] relative w-full">
                  {isKpiLoading ? (
                    <div className="flex items-center justify-center h-full w-full">
                      <p className="text-global-inactive">{t('reports.messages.loading')}</p>
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
                      {t('reports.legends.occupancy')}
                    </div>
                  </div>
                  <div className="shrink-0 h-6 relative flex items-center gap-2">
                    <div className="w-3.5 h-3.5 rounded-full bg-global-content-highlight-2nd shrink-0"></div>
                    <div className="text-global-content-highlight-2nd text-center font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal" style={{ letterSpacing: '-0.31px' }}>
                      {t('reports.legends.bookings')}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Grille avec les deux autres graphiques */}
            <div className="self-stretch shrink-0 grid gap-6 relative" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gridTemplateRows: 'repeat(1, minmax(0, 1fr))' }}>
              {/* Graphique RevPAR, ADR & Occupation */}
              <div className="bg-global-bg-box rounded-[14px] border-solid border-global-stroke-box border p-6 flex flex-col gap-6 items-start justify-start relative" style={{ gridColumn: '1 / span 1', gridRow: '1 / span 1' }}>
              <div className="self-stretch shrink-0 h-7 relative">
                <div className="text-global-blanc text-left font-['Inter-Medium',_sans-serif] text-xl leading-7 font-medium" style={{ letterSpacing: '-0.45px' }}>
                  {t('reports.charts.revparAdrOccupancy')}
                </div>
              </div>
              <div className="pt-[5px] pb-[5px] flex flex-col gap-2.5 items-start justify-start self-stretch shrink-0 relative">
                <div className="self-stretch shrink-0 h-[256.26px] relative w-full">
                  {isKpiLoading ? (
                    <div className="flex items-center justify-center h-full w-full">
                      <p className="text-global-inactive">{t('reports.messages.loading')}</p>
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
                      {t('reports.legends.adr')}
                    </div>
                  </div>
                  <div className="shrink-0 h-6 relative flex items-center gap-2">
                    <div className="w-3.5 h-3.5 rounded-full bg-global-positive-impact shrink-0"></div>
                    <div className="text-global-positive-impact text-center font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal" style={{ letterSpacing: '-0.31px' }}>
                      {t('reports.legends.occupancy')}
                    </div>
                  </div>
                  <div className="shrink-0 h-6 relative flex items-center gap-2">
                    <div className="w-3.5 h-3.5 rounded-full bg-global-content-highlight-2nd shrink-0"></div>
                    <div className="text-global-content-highlight-2nd text-center font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal" style={{ letterSpacing: '-0.31px' }}>
                      {t('reports.legends.revpar')}
                    </div>
                  </div>
                </div>
              </div>
              </div>

              {/* Graphique Gain IA & Score IA */}
              <div className="bg-global-bg-box rounded-[14px] border-solid border-global-stroke-box border p-6 flex flex-col gap-6 items-start justify-start relative" style={{ gridColumn: '2 / span 1', gridRow: '1 / span 1' }}>
              <div className="self-stretch shrink-0 h-7 relative">
                <div className="text-global-blanc text-left font-['Inter-Medium',_sans-serif] text-xl leading-7 font-medium" style={{ letterSpacing: '-0.45px' }}>
                  {t('reports.charts.aiGainScore')}
                </div>
              </div>
              <div className="pt-[5px] pb-[5px] flex flex-col gap-2.5 items-start justify-start self-stretch shrink-0 relative">
                <div className="self-stretch shrink-0 h-[271.26px] relative w-full">
                  {isKpiLoading ? (
                    <div className="flex items-center justify-center h-full w-full">
                      <p className="text-global-inactive">{t('reports.messages.loading')}</p>
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
                      {t('reports.legends.aiGain')}
                    </div>
                  </div>
                  <div className="shrink-0 h-6 relative flex items-center gap-2">
                    <div className="w-3.5 h-3.5 rounded-full bg-global-content-highlight-2nd shrink-0"></div>
                    <div className="text-global-content-highlight-2nd text-center font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal" style={{ letterSpacing: '-0.31px' }}>
                      {t('reports.legends.aiScore')}
                    </div>
                  </div>
                </div>
              </div>
              </div>
            </div>
          </>
        )}

        {/* Graphique Tendance marché - Offre vs Demande (onglet Marché) */}
        {activeTab === 'market' && (
          <>
            {/* KPIs du marché */}
            <div className="self-stretch shrink-0 grid gap-4 relative mb-6" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
              <KpiCard
                title={t('reports.marketKpis.avgPrice')}
                value={marketKpis?.competitor_avg_price || 0}
                previousValue={prevMarketKpis?.competitor_avg_price || 0}
                formatter={formatCurrency}
                isLoading={isKpiLoading}
              />
              <KpiCard
                title={t('reports.marketKpis.demandLevel')}
                value={marketKpis?.market_demand_level === 'very_high' ? 100 : 
                      marketKpis?.market_demand_level === 'high' ? 75 :
                      marketKpis?.market_demand_level === 'medium' ? 50 :
                      marketKpis?.market_demand_level === 'low' ? 25 : 0}
                previousValue={prevMarketKpis?.market_demand_level === 'very_high' ? 100 : 
                              prevMarketKpis?.market_demand_level === 'high' ? 75 :
                              prevMarketKpis?.market_demand_level === 'medium' ? 50 :
                              prevMarketKpis?.market_demand_level === 'low' ? 25 : 0}
                formatter={(v) => {
                  const level = marketKpis?.market_demand_level || 'unknown';
                  const labels = {
                    'very_high': t('reports.demandLevels.veryHigh'),
                    'high': t('reports.demandLevels.high'),
                    'medium': t('reports.demandLevels.medium'),
                    'low': t('reports.demandLevels.low'),
                    'unknown': t('reports.demandLevels.unknown')
                  };
                  return labels[level] || t('reports.demandLevels.unknown');
                }}
                isLoading={isKpiLoading}
              />
              <KpiCard
                title={t('reports.marketKpis.weatherScore')}
                value={marketKpis?.weather_score || 0}
                previousValue={prevMarketKpis?.weather_score || 0}
                formatter={(v) => `${Math.round(v || 0)}/100`}
                isLoading={isKpiLoading}
              />
              <KpiCard
                title={t('reports.marketKpis.eventImpact')}
                value={marketKpis?.event_impact_score || 0}
                previousValue={prevMarketKpis?.event_impact_score || 0}
                formatter={(v) => `${v > 0 ? '+' : ''}${Math.round(v || 0)}%`}
                isLoading={isKpiLoading}
              />
            </div>
            
            <div className="self-stretch shrink-0 grid gap-6 relative" style={{ gridTemplateColumns: '2fr 1fr' }}>
            {/* Graphique Tendance marché - Offre vs Demande */}
            <div className="bg-[rgba(15,23,43,0.40)] rounded-[14px] border-solid border-[rgba(49,65,88,0.50)] border pt-[25px] pr-[25px] pb-px pl-[25px] flex flex-col gap-6 items-start justify-start h-[452px] relative">
              <div className="self-stretch shrink-0 h-7 relative">
                <div className="text-[#ffffff] text-left font-['Inter-Medium',_sans-serif] text-xl leading-7 font-medium" style={{ letterSpacing: "-0.45px" }}>
                  {t('reports.charts.marketTrend')}
                </div>
              </div>
              <div className="self-stretch shrink-0 h-[350px] relative">
                {isKpiLoading ? (
                  <div className="flex items-center justify-center h-full w-full">
                    <p className="text-global-inactive">{t('reports.messages.loading')}</p>
                  </div>
                ) : (
                  <div className="w-full h-full relative">
                    <canvas ref={marketTrendChartRef} className="w-full h-full"></canvas>
                  </div>
                )}
              </div>
              {/* Légende personnalisée */}
              <div className="flex flex-row gap-6 items-center justify-center self-stretch shrink-0 relative">
                <div className="shrink-0 h-6 relative flex items-center gap-2">
                  <div className="w-3.5 h-3.5 rounded-full bg-global-content-highlight-2nd shrink-0"></div>
                  <div className="text-global-content-highlight-2nd text-center font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal" style={{ letterSpacing: "-0.31px" }}>
                    {t('reports.legends.demand')}
                  </div>
                </div>
                <div className="shrink-0 h-6 relative flex items-center gap-2">
                  <div className="w-3.5 h-3.5 rounded-full bg-global-mid-impact shrink-0"></div>
                  <div className="text-global-mid-impact text-center font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal" style={{ letterSpacing: "-0.31px" }}>
                    {t('reports.legends.supply')}
                  </div>
                </div>
              </div>
            </div>

            {/* Analyse demande 24h */}
            <div className="bg-[rgba(15,23,43,0.40)] rounded-[14px] border-solid border-[rgba(49,65,88,0.50)] border pt-[25px] pr-[25px] pb-px pl-[25px] flex flex-col gap-6 items-start justify-start h-[352px] relative">
              <div className="self-stretch shrink-0 h-7 relative">
                <div className="text-[#ffffff] text-left font-['Inter-Regular',_sans-serif] text-xl leading-7 font-normal" style={{ letterSpacing: "-0.45px" }}>
                  {t('reports.charts.demandAnalysis24h')}
                </div>
              </div>
              <div className="flex flex-col gap-4 items-start justify-start self-stretch shrink-0 h-56 relative">
                <div className="bg-[rgba(29,41,61,0.50)] rounded-[10px] pr-4 pl-4 flex flex-row items-center justify-between self-stretch shrink-0 h-16 relative">
                  <div className="shrink-0 w-[141.06px] h-6 relative">
                    <div className="text-[#90a1b9] text-left font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal absolute left-0 top-[-0.5px]" style={{ letterSpacing: "-0.31px" }}>
                      {t('reports.demandAnalysis.activeSearches')}
                    </div>
                  </div>
                  <div className="shrink-0 w-[52.02px] h-8 relative">
                    <div className="text-[#00d3f2] text-left font-['Inter-Regular',_sans-serif] text-2xl leading-8 font-normal absolute left-0 top-0" style={{ letterSpacing: "0.07px" }}>
                      {marketSnapshot ? `+${marketSnapshot.activeSearches}` : '+127'}
                    </div>
                  </div>
                </div>
                <div className="bg-[rgba(29,41,61,0.50)] rounded-[10px] pr-4 pl-4 flex flex-row items-center justify-between self-stretch shrink-0 h-16 relative">
                  <div className="shrink-0 w-[122.53px] h-6 relative">
                    <div className="text-[#90a1b9] text-left font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal absolute left-0 top-[-0.5px]" style={{ letterSpacing: "-0.31px" }}>
                      {t('reports.demandAnalysis.listingViews')}
                    </div>
                  </div>
                  <div className="shrink-0 w-[44.08px] h-8 relative">
                    <div className="text-[#51a2ff] text-left font-['Inter-Regular',_sans-serif] text-2xl leading-8 font-normal absolute left-0 top-0" style={{ letterSpacing: "0.07px" }}>
                      {marketSnapshot ? `+${marketSnapshot.listingViews}` : '+84'}
                    </div>
                  </div>
                </div>
                <div className="bg-[rgba(29,41,61,0.50)] rounded-[10px] pr-4 pl-4 flex flex-row items-center justify-between self-stretch shrink-0 h-16 relative">
                  <div className="shrink-0 w-[139.38px] h-6 relative">
                    <div className="text-[#90a1b9] text-left font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal absolute left-0 top-[-0.5px]" style={{ letterSpacing: "-0.31px" }}>
                      {t('reports.demandAnalysis.conversionRate')}
                    </div>
                  </div>
                  <div className="shrink-0 w-[64.31px] h-8 relative">
                    <div className="text-[#00d492] text-left font-['Inter-Regular',_sans-serif] text-2xl leading-8 font-normal absolute left-0 top-0" style={{ letterSpacing: "0.07px" }}>
                      {marketSnapshot ? `${marketSnapshot.conversionRate.toFixed(1)}%` : '18.2%'}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          </>
        )}

        {/* Contenu pour les autres onglets (Positionnement, Prévisions, Performance Financière) */}
        {activeTab === 'positioning' && (
          <div className="self-stretch shrink-0 grid gap-6 relative" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
            {/* Graphique ADR vs Marché */}
            <div className="bg-[rgba(15,23,43,0.40)] rounded-[14px] border-solid border-[rgba(49,65,88,0.50)] border pt-[25px] pr-[25px] pb-px pl-[25px] flex flex-col gap-6 items-start justify-start h-[402px] relative">
              <div className="self-stretch shrink-0 h-7 relative">
                <div className="text-[#ffffff] text-left font-['Inter-Medium',_sans-serif] text-xl leading-7 font-medium" style={{ letterSpacing: "-0.45px" }}>
                  {t('reports.charts.adrVsMarket')}
                </div>
              </div>
              <div className="self-stretch shrink-0 h-[300px] relative">
                {isKpiLoading ? (
                  <div className="flex items-center justify-center h-full w-full">
                    <p className="text-global-inactive">{t('reports.messages.loading')}</p>
                  </div>
                ) : (
                  <div className="w-full h-full relative">
                    <canvas ref={adrVsMarketChartRef} className="w-full h-full"></canvas>
                  </div>
                )}
              </div>
              {/* Légende personnalisée */}
              <div className="flex flex-row gap-6 items-center justify-center self-stretch shrink-0 relative">
                <div className="shrink-0 h-6 relative flex items-center gap-2">
                  <div className="w-3.5 h-3.5 rounded-full bg-[#94a3b8] shrink-0"></div>
                  <div className="text-global-inactive text-center font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal" style={{ letterSpacing: "-0.31px" }}>
                    {t('reports.legends.marketAdr')}
                  </div>
                </div>
                <div className="shrink-0 h-6 relative flex items-center gap-2">
                  <div className="w-3.5 h-3.5 rounded-full bg-global-content-highlight-2nd shrink-0"></div>
                  <div className="text-global-content-highlight-2nd text-center font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal" style={{ letterSpacing: "-0.31px" }}>
                    {t('reports.legends.yourAdr')}
                  </div>
                </div>
              </div>
            </div>

            {/* Graphique Distribution prix concurrents */}
            <div className="bg-[rgba(15,23,43,0.40)] rounded-[14px] border-solid border-[rgba(49,65,88,0.50)] border pt-[25px] pr-[25px] pb-px pl-[25px] flex flex-col gap-6 items-start justify-start h-[402px] relative">
              <div className="self-stretch shrink-0 h-7 relative">
                <div className="text-[#ffffff] text-left font-['Inter-Regular',_sans-serif] text-xl leading-7 font-normal" style={{ letterSpacing: "-0.45px" }}>
                  {t('reports.charts.competitorPriceDistribution')}
                </div>
              </div>
              <div className="self-stretch shrink-0 h-[300px] relative">
                {isKpiLoading ? (
                  <div className="flex items-center justify-center h-full w-full">
                    <p className="text-global-inactive">{t('reports.messages.loading')}</p>
                  </div>
                ) : (
                  <div className="w-full h-full relative">
                    <canvas ref={priceDistributionChartRef} className="w-full h-full"></canvas>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'forecast' && (
          <div className="flex flex-col gap-6 items-start justify-start relative">
            {/* Première ligne : Revenus futurs & Occupation prévue / ADR, RevPAR & Occupation prévus */}
            <div className="self-stretch shrink-0 grid gap-6 relative" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
              {/* Graphique Revenus futurs & Occupation prévue */}
              <div className="bg-[rgba(15,23,43,0.40)] rounded-[14px] border-solid border-[rgba(49,65,88,0.50)] border pt-[25px] pr-[25px] pb-px pl-[25px] flex flex-col gap-6 items-start justify-start h-[402px] relative">
                <div className="self-stretch shrink-0 h-7 relative">
                  <div className="text-[#ffffff] text-left font-['Inter-Medium',_sans-serif] text-xl leading-7 font-medium" style={{ letterSpacing: "-0.45px" }}>
                    {t('reports.charts.futureRevenue')}
                  </div>
                </div>
                <div className="self-stretch shrink-0 h-[300px] relative">
                  {isKpiLoading ? (
                    <div className="flex items-center justify-center h-full w-full">
                      <p className="text-global-inactive">{t('reports.messages.loading')}</p>
                    </div>
                  ) : (
                    <div className="w-full h-full relative">
                      <canvas ref={forecastRevenueChartRef} className="w-full h-full"></canvas>
                    </div>
                  )}
                </div>
                {/* Légende personnalisée */}
                <div className="flex flex-row gap-6 items-center justify-center self-stretch shrink-0 relative">
                  <div className="shrink-0 h-6 relative flex items-center gap-2">
                    <div className="w-3.5 h-3.5 rounded-full bg-[#06b6d4] shrink-0"></div>
                    <div className="text-[#06b6d4] text-center font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal" style={{ letterSpacing: "-0.31px" }}>
                      {t('reports.legends.occupancy')}
                    </div>
                  </div>
                  <div className="shrink-0 h-6 relative flex items-center gap-2">
                    <div className="w-3.5 h-3.5 rounded-full bg-[#1e40af] shrink-0"></div>
                    <div className="text-[#1e40af] text-center font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal" style={{ letterSpacing: "-0.31px" }}>
                      {t('reports.legends.forecastedRevenue')}
                    </div>
                  </div>
                </div>
              </div>

              {/* Graphique ADR, RevPAR & Occupation prévus */}
              <div className="bg-[rgba(15,23,43,0.40)] rounded-[14px] border-solid border-[rgba(49,65,88,0.50)] border pt-[25px] pr-[25px] pb-px pl-[25px] flex flex-col gap-6 items-start justify-start h-[402px] relative">
                <div className="self-stretch shrink-0 h-7 relative">
                  <div className="text-[#ffffff] text-left font-['Inter-Medium',_sans-serif] text-xl leading-7 font-medium" style={{ letterSpacing: "-0.45px" }}>
                    {t('reports.charts.forecastedAdrRevparOccupancy')}
                  </div>
                </div>
                <div className="self-stretch shrink-0 h-[300px] relative">
                  {isKpiLoading ? (
                    <div className="flex items-center justify-center h-full w-full">
                      <p className="text-global-inactive">{t('reports.messages.loading')}</p>
                    </div>
                  ) : (
                    <div className="w-full h-full relative">
                      <canvas ref={forecastAdrChartRef} className="w-full h-full"></canvas>
                    </div>
                  )}
                </div>
                {/* Légende personnalisée */}
                <div className="flex flex-row gap-6 items-center justify-center self-stretch shrink-0 relative">
                  <div className="shrink-0 h-6 relative flex items-center gap-2">
                    <div className="w-3.5 h-3.5 rounded-full bg-[#8b5cf6] shrink-0"></div>
                    <div className="text-[#8b5cf6] text-center font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal" style={{ letterSpacing: "-0.31px" }}>
                      {t('reports.legends.adr')}
                    </div>
                  </div>
                  <div className="shrink-0 h-6 relative flex items-center gap-2">
                    <div className="w-3.5 h-3.5 rounded-full bg-[#10b981] shrink-0"></div>
                    <div className="text-[#10b981] text-center font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal" style={{ letterSpacing: "-0.31px" }}>
                      {t('reports.legends.occupancy')}
                    </div>
                  </div>
                  <div className="shrink-0 h-6 relative flex items-center gap-2">
                    <div className="w-3.5 h-3.5 rounded-full bg-[#06b6d4] shrink-0"></div>
                    <div className="text-[#06b6d4] text-center font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal" style={{ letterSpacing: "-0.31px" }}>
                      {t('reports.legends.revpar')}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Deuxième ligne : Scénarios de prévision */}
            <div className="bg-[rgba(15,23,43,0.40)] rounded-[14px] border-solid border-[rgba(49,65,88,0.50)] border pt-[25px] pr-[25px] pb-px pl-[25px] flex flex-col gap-6 items-start justify-start self-stretch shrink-0 h-[452px] relative">
              <div className="self-stretch shrink-0 h-7 relative">
                <div className="text-[#ffffff] text-left font-['Inter-Medium',_sans-serif] text-xl leading-7 font-medium" style={{ letterSpacing: "-0.45px" }}>
                  {t('reports.charts.forecastScenarios')}
                </div>
              </div>
              <div className="self-stretch shrink-0 h-[350px] relative">
                {isKpiLoading ? (
                  <div className="flex items-center justify-center h-full w-full">
                    <p className="text-global-inactive">{t('reports.messages.loading')}</p>
                  </div>
                ) : (
                  <div className="w-full h-full relative">
                    <canvas ref={forecastScenariosChartRef} className="w-full h-full"></canvas>
                  </div>
                )}
              </div>
              {/* Légende personnalisée */}
              <div className="flex flex-row gap-6 items-center justify-center self-stretch shrink-0 relative">
                <div className="shrink-0 h-6 relative flex items-center gap-2">
                  <div className="w-3.5 h-3.5 rounded-full bg-[#06b6d4] shrink-0"></div>
                  <div className="text-[#06b6d4] text-center font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal" style={{ letterSpacing: "-0.31px" }}>
                    {t('reports.scenarios.baseline')}
                  </div>
                </div>
                <div className="shrink-0 h-6 relative flex items-center gap-2">
                  <div className="w-3.5 h-3.5 rounded-full bg-[#10b981] shrink-0"></div>
                  <div className="text-[#10b981] text-center font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal" style={{ letterSpacing: "-0.31px" }}>
                    {t('reports.scenarios.optimistic')}
                  </div>
                </div>
                <div className="shrink-0 h-6 relative flex items-center gap-2">
                  <div className="w-3.5 h-3.5 rounded-full bg-[#ef4444] shrink-0"></div>
                  <div className="text-[#ef4444] text-center font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal" style={{ letterSpacing: "-0.31px" }}>
                    {t('reports.scenarios.pessimistic')}
                  </div>
                </div>
              </div>
            </div>

            {/* Troisième ligne : Prévisions synthétiques par propriété */}
            <div className="bg-[rgba(15,23,43,0.40)] rounded-[14px] border-solid border-[rgba(49,65,88,0.50)] border pt-[25px] pr-[25px] pb-px pl-[25px] flex flex-col gap-6 items-start justify-start self-stretch shrink-0 h-[452px] relative">
              <div className="self-stretch shrink-0 h-7 relative">
                <div className="text-[#ffffff] text-left font-['Inter-Medium',_sans-serif] text-xl leading-7 font-medium" style={{ letterSpacing: "-0.45px" }}>
                  Synthetic Forecasts by Property
                </div>
              </div>
              <div className="self-stretch shrink-0 h-[350px] relative">
                {isKpiLoading ? (
                  <div className="flex items-center justify-center h-full w-full">
                    <p className="text-global-inactive">{t('reports.messages.loading')}</p>
                  </div>
                ) : (
                  <div className="w-full h-full relative">
                    <canvas ref={forecastRadarChartRef} className="w-full h-full"></canvas>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'financial' && (
          <div className="flex flex-col gap-6 items-start justify-start relative">
            {/* Revenu total vs Objectif */}
            <div className="bg-[rgba(15,23,43,0.40)] rounded-[14px] border-solid border-[rgba(49,65,88,0.50)] border pt-[25px] pr-[25px] pb-px pl-[25px] flex flex-col gap-6 items-start justify-start self-stretch shrink-0 h-[452px] relative">
              <div className="self-stretch shrink-0 h-7 relative">
                <div className="text-[#ffffff] text-left font-['Inter-Medium',_sans-serif] text-xl leading-7 font-medium" style={{ letterSpacing: "-0.45px" }}>
                  {t('reports.charts.revenueVsTarget')}
                </div>
              </div>
              <div className="self-stretch shrink-0 h-[350px] relative">
                {isKpiLoading ? (
                  <div className="flex items-center justify-center h-full w-full">
                    <p className="text-global-inactive">{t('reports.messages.loading')}</p>
                  </div>
                ) : (
                  <div className="w-full h-full relative">
                    <canvas ref={revenueVsTargetChartRef} className="w-full h-full"></canvas>
                  </div>
                )}
              </div>
              {/* Légende personnalisée */}
              <div className="flex flex-row gap-6 items-center justify-center self-stretch shrink-0 relative">
                <div className="shrink-0 h-6 relative flex items-center gap-2">
                  <div className="w-3.5 h-3.5 rounded-full bg-[#64748b] shrink-0"></div>
                  <div className="text-[#64748b] text-center font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal" style={{ letterSpacing: "-0.31px" }}>
                    {t('reports.legends.target')}
                  </div>
                </div>
                <div className="shrink-0 h-6 relative flex items-center gap-2">
                  <div className="w-3.5 h-3.5 rounded-full bg-[#06b6d4] shrink-0"></div>
                  <div className="text-[#06b6d4] text-center font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal" style={{ letterSpacing: "-0.31px" }}>
                    {t('reports.legends.realRevenue')}
                  </div>
                </div>
              </div>
            </div>

            {/* ADR par canal et ROI PricEye */}
            <div className="self-stretch shrink-0 grid gap-6 relative" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
              {/* ADR par canal */}
              <div className="bg-[rgba(15,23,43,0.40)] rounded-[14px] border-solid border-[rgba(49,65,88,0.50)] border pt-[25px] pr-[25px] pb-px pl-[25px] flex flex-col gap-6 items-start justify-start h-[530px] relative">
                <div className="self-stretch shrink-0 h-7 relative">
                  <div className="text-[#ffffff] text-left font-['Inter-Regular',_sans-serif] text-xl leading-7 font-normal" style={{ letterSpacing: "-0.45px" }}>
                    ADR by Channel
                  </div>
                </div>
                <div className="self-stretch shrink-0 h-[300px] relative">
                  {isKpiLoading ? (
                    <div className="flex items-center justify-center h-full w-full">
                      <p className="text-global-inactive">{t('reports.messages.loading')}</p>
                    </div>
                  ) : (
                    <div className="w-full h-full relative">
                      <canvas ref={adrByChannelChartRef} className="w-full h-full"></canvas>
                    </div>
                  )}
                </div>
                {/* Statistics by channel */}
                <div className="flex flex-col gap-2 items-start justify-start self-stretch shrink-0 h-28 relative">
                  {adrByChannelData && adrByChannelData.labels.map((channel, index) => (
                    <div key={channel} className="flex flex-row items-center justify-between self-stretch shrink-0 h-[22px] relative">
                      <div className="shrink-0 relative">
                        <div className="text-[#90a1b9] text-left font-['Inter-Regular',_sans-serif] text-sm leading-5 font-normal" style={{ letterSpacing: "-0.15px" }}>
                          {channel}
                        </div>
                      </div>
                      <div className="bg-[rgba(0,153,102,0.20)] rounded-lg border-solid border-[rgba(0,188,125,0.30)] border pt-0.5 pr-2 pb-0.5 pl-2 flex flex-row gap-1 items-center justify-center shrink-0 h-[22px] relative overflow-hidden">
                        <div className="text-[#00d492] text-left font-['Inter-Medium',_sans-serif] text-xs leading-4 font-medium relative">
                          +{adrByChannelData.variations[index].toFixed(1)}%
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* ROI PricEye */}
              <div className="bg-[rgba(15,23,43,0.40)] rounded-[14px] border-solid border-[rgba(49,65,88,0.50)] border pt-[25px] pr-[25px] pb-px pl-[25px] flex flex-col gap-6 items-start justify-start h-[530px] relative">
                <div className="self-stretch shrink-0 h-7 relative">
                  <div className="text-[#ffffff] text-left font-['Inter-Regular',_sans-serif] text-xl leading-7 font-normal" style={{ letterSpacing: "-0.45px" }}>
                    {t('reports.charts.priceyeRoi')}
                  </div>
                </div>
                {isKpiLoading ? (
                  <div className="flex items-center justify-center h-full w-full">
                    <p className="text-global-inactive">{t('reports.messages.loading')}</p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-6 items-center justify-center self-stretch flex-1 relative">
                    <div className="flex flex-col gap-2 items-start justify-start shrink-0 w-[187.41px] h-[92px] relative">
                      <div className="self-stretch shrink-0 h-[60px] relative">
                        <div className="text-center font-['Inter-Regular',_sans-serif] text-6xl leading-[60px] font-normal absolute left-[13.89px] top-[0.5px]" style={{ background: "linear-gradient(to left, rgba(0, 0, 0, 0.00), rgba(0, 0, 0, 0.00)), linear-gradient(90deg, rgba(81, 162, 255, 1.00) 0%,rgba(0, 211, 242, 1.00) 100%)", backgroundClip: "text", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", letterSpacing: "0.26px" }}>
                          {calculateROI.roi.toFixed(0)}%
                        </div>
                      </div>
                      <div className="self-stretch shrink-0 h-6 relative">
                        <div className="text-[#90a1b9] text-center font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal absolute left-0 top-[-0.5px]" style={{ letterSpacing: "-0.31px" }}>
                          Return on investment
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-col gap-3 items-start justify-start shrink-0 w-96 h-[108px] relative">
                      <div className="bg-[rgba(29,41,61,0.50)] rounded-[10px] pr-3 pl-3 flex flex-row items-center justify-between self-stretch shrink-0 h-12 relative">
                        <div className="shrink-0 w-[82.87px] h-5 relative">
                          <div className="text-[#90a1b9] text-left font-['Inter-Regular',_sans-serif] text-sm leading-5 font-normal absolute left-0 top-[0.5px]" style={{ letterSpacing: "-0.15px" }}>
                            {t('reports.legends.priceyeCost')}
                          </div>
                        </div>
                        <div className="shrink-0 w-[49.59px] h-6 relative">
                          <div className="text-[#00d492] text-left font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal absolute left-0 top-[-0.5px]" style={{ letterSpacing: "-0.31px" }}>
                            {formatCurrency(calculateROI.cost)}
                          </div>
                        </div>
                      </div>
                      <div className="bg-[rgba(29,41,61,0.50)] rounded-[10px] pr-3 pl-3 flex flex-row items-center justify-between self-stretch shrink-0 h-12 relative">
                        <div className="shrink-0 w-[92.27px] h-5 relative">
                          <div className="text-[#90a1b9] text-left font-['Inter-Regular',_sans-serif] text-sm leading-5 font-normal absolute left-0 top-[0.5px]" style={{ letterSpacing: "-0.15px" }}>
                            Generated gains
                          </div>
                        </div>
                        <div className="shrink-0 w-[51.91px] h-6 relative">
                          <div className="text-[#00d3f2] text-left font-['Inter-Regular',_sans-serif] text-base leading-6 font-normal absolute left-0 top-[-0.5px]" style={{ letterSpacing: "-0.31px" }}>
                            {formatCurrency(calculateROI.gains)}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Marge brute (%) */}
            <div className="bg-[rgba(15,23,43,0.40)] rounded-[14px] border-solid border-[rgba(49,65,88,0.50)] border pt-[25px] pr-[25px] pb-px pl-[25px] flex flex-col gap-6 items-start justify-start self-stretch shrink-0 h-[402px] relative">
              <div className="self-stretch shrink-0 h-7 relative">
                <div className="text-[#ffffff] text-left font-['Inter-Medium',_sans-serif] text-xl leading-7 font-medium" style={{ letterSpacing: "-0.45px" }}>
                  {t('reports.charts.grossMargin')}
                </div>
              </div>
              <div className="self-stretch shrink-0 h-[300px] relative">
                {isKpiLoading ? (
                  <div className="flex items-center justify-center h-full w-full">
                    <p className="text-global-inactive">{t('reports.messages.loading')}</p>
                  </div>
                ) : (
                  <div className="w-full h-full relative">
                    <canvas ref={grossMarginChartRef} className="w-full h-full"></canvas>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
      
      {!isLoading && !error && filteredProperties.length === 0 && (
          <p className="text-center text-text-muted mt-8">{t('reports.messages.noProperties')}</p>
      )}
      </div>
    </div>
  );
}

export default ReportPage;

