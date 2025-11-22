import React, { useState, useEffect } from 'react';
import { getDateAnalysis } from '../services/api.js';

/**
 * Affiche l'analyse du marché (événements, demande, prix) pour une date spécifique.
 * @param {object} props
 * @param {string} props.token - Le jeton d'authentification.
 * @param {string} props.propertyId - L'ID de la propriété sélectionnée.
 * @param {string | null} props.date - La date sélectionnée (YYYY-MM-DD) ou null.
 * @param {number | null} props.currentPrice - Le prix actuel de la propriété pour cette date.
 * @param {object} props.userProfile - Le profil de l'utilisateur (pour la devise).
 */
function DateAnalysis({ token, propertyId, date, currentPrice, userProfile }) {
  const [analysis, setAnalysis] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    // Ne rien faire si aucune date n'est sélectionnée
    if (!date || !propertyId) {
      setAnalysis(null);
      setError('');
      return;
    }

    const fetchAnalysis = async () => {
      setIsLoading(true);
      setError('');
      setAnalysis(null); // Réinitialiser l'analyse précédente
      try {
        const data = await getDateAnalysis(propertyId, date, token);
        setAnalysis(data);
      } catch (err) {
        setError(err.message);
      } finally {
        setIsLoading(false);
      }
    };

    fetchAnalysis();
  }, [token, propertyId, date]); // Se redéclenche si la date ou la propriété change

  // Helper pour extraire un prix moyen de la suggestion (ex: "120€ - 140€")
  const parsePriceSuggestion = (suggestionStr) => {
    if (!suggestionStr) return null;
    const numbers = suggestionStr.match(/\d+/g); // Trouve tous les nombres
    if (!numbers) return null;
    if (numbers.length === 1) return parseFloat(numbers[0]);
    if (numbers.length >= 2) {
      return (parseFloat(numbers[0]) + parseFloat(numbers[1])) / 2; // Moyenne
    }
    return null;
  };
  
  // Helper pour formater la devise
  const formatCurrency = (amount) => {
      if (amount == null) return 'N/A';
      const currency = userProfile?.currency || 'EUR'; // EUR par défaut
      return (amount).toLocaleString('fr-FR', { 
          style: 'currency', 
          currency: currency, 
          minimumFractionDigits: 0, 
          maximumFractionDigits: 0 
      });
  };

  const renderContent = () => {
    if (!date) {
      return (
        <div className="border-solid border-global-stroke-box border-t pt-4 flex flex-row gap-6 items-start justify-center self-stretch shrink-0 relative">
          <div className="text-global-inactive text-left font-h4-font-family text-h4-font-size leading-h4-line-height font-h4-font-weight relative self-stretch">
            Cliquez sur une date du calendrier pour l'analyser.
          </div>
        </div>
      );
    }
    if (isLoading) {
      return (
        <div className="flex justify-center items-center h-32">
          <div className="w-8 h-8 border-2 border-global-content-highlight-2nd border-t-transparent rounded-full animate-spin"></div>
        </div>
      );
    }
    if (error) {
      return (
        <div className="border-solid border-global-stroke-box border-t pt-4">
          <p className="text-sm text-red-400 text-center">{error}</p>
        </div>
      );
    }
    if (!analysis) {
      return (
        <div className="border-solid border-global-stroke-box border-t pt-4">
          <p className="text-global-inactive text-left font-h4-font-family text-h4-font-size leading-h4-line-height font-h4-font-weight">
            Aucune analyse disponible pour cette date.
          </p>
        </div>
      );
    }

    // Calculer l'écart de prix
    const marketPrice = parsePriceSuggestion(analysis.priceSuggestion);
    let trend = null;
    if (marketPrice != null && currentPrice != null) {
        const diff = ((currentPrice - marketPrice) / marketPrice) * 100;
        const trendColor = diff > 5 ? 'text-global-positive-impact' : (diff < -5 ? 'text-global-negative-impact' : 'text-global-inactive');
        const trendSign = diff > 0 ? '+' : '';
        trend = (
            <span className={`text-sm font-semibold ${trendColor}`}>
                ({trendSign}{diff.toFixed(0)}% vs Marché)
            </span>
        );
    }


    // Afficher les résultats de l'analyse
    return (
      <div className="border-solid border-global-stroke-box border-t pt-4 flex flex-col gap-3 self-stretch">
        <div>
          <h5 className="text-xs font-bold text-global-inactive uppercase tracking-wider mb-1">Demande du Marché</h5>
          <p className="text-lg font-semibold text-global-blanc">{analysis.marketDemand || 'N/A'}</p>
        </div>
        
        {/* Affichage du prix actuel et de l'écart */}
        <div>
          <h5 className="text-xs font-bold text-global-inactive uppercase tracking-wider mb-1">Votre Prix Actuel</h5>
          <div className="flex items-baseline gap-2">
            <p className="text-lg font-semibold text-global-blanc">{formatCurrency(currentPrice)}</p>
            {trend}
          </div>
        </div>

        <div>
          <h5 className="text-xs font-bold text-global-inactive uppercase tracking-wider mb-1">Suggestion de Prix (Marché)</h5>
          <p className="text-lg font-semibold text-global-blanc">{analysis.priceSuggestion || 'N/A'}</p>
        </div>
        
        <div>
          <h5 className="text-xs font-bold text-global-inactive uppercase tracking-wider mb-1">Événements Locaux</h5>
          {analysis.events && analysis.events.length > 0 ? (
            <ul className="list-disc list-inside text-sm text-global-inactive space-y-1 mt-1">
              {analysis.events.map((event, index) => (
                <li key={index}>{event}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-global-inactive mt-1">Aucun événement majeur trouvé.</p>
          )}
        </div>
         <div>
          <h5 className="text-xs font-bold text-global-inactive uppercase tracking-wider mb-1">Résumé de l'IA</h5>
          <p className="text-sm text-global-inactive italic mt-1">"{analysis.analysisSummary || 'Analyse non disponible.'}"</p>
        </div>
      </div>
    );
  };

  return (
    <div className="bg-global-bg-box rounded-[14px] border border-solid border-global-stroke-box p-6 flex flex-col gap-3 items-start justify-start shrink-0 w-full relative">
      <div className="text-global-blanc text-left font-h2-font-family text-h2-font-size font-h2-font-weight relative">
        Analyse du Marché
      </div>
      {renderContent()}
    </div>
  );
}

export default DateAnalysis;

