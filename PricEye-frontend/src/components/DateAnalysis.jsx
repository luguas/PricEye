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
      return <p className="text-sm text-text-muted text-center">Cliquez sur une date du calendrier pour l'analyser.</p>;
    }
    if (isLoading) {
      return (
        <div className="flex justify-center items-center h-32">
          <div className="loader-small"></div>
        </div>
      );
    }
    if (error) {
      return <p className="text-sm text-red-400 text-center">{error}</p>;
    }
    if (!analysis) {
      return <p className="text-sm text-text-muted text-center">Aucune analyse disponible pour cette date.</p>;
    }

    // Calculer l'écart de prix
    const marketPrice = parsePriceSuggestion(analysis.priceSuggestion);
    let trend = null;
    if (marketPrice != null && currentPrice != null) {
        const diff = ((currentPrice - marketPrice) / marketPrice) * 100;
        const trendColor = diff > 5 ? 'text-green-400' : (diff < -5 ? 'text-red-400' : 'text-text-muted');
        const trendSign = diff > 0 ? '+' : '';
        trend = (
            <span className={`text-sm font-semibold ${trendColor}`}>
                ({trendSign}{diff.toFixed(0)}% vs Marché)
            </span>
        );
    }


    // Afficher les résultats de l'analyse
    return (
      <div className="space-y-3">
        <div>
          <h5 className="text-xs font-bold text-text-muted uppercase tracking-wider">Demande du Marché</h5>
          <p className="text-lg font-semibold text-text-primary">{analysis.marketDemand || 'N/A'}</p>
        </div>
        
        {/* NOUVEAU: Affichage du prix actuel et de l'écart */}
        <div>
          <h5 className="text-xs font-bold text-text-muted uppercase tracking-wider">Votre Prix Actuel</h5>
          <div className="flex items-baseline gap-2">
            <p className="text-lg font-semibold text-text-primary">{formatCurrency(currentPrice)}</p>
            {trend}
          </div>
        </div>

        <div>
          <h5 className="text-xs font-bold text-text-muted uppercase tracking-wider">Suggestion de Prix (Marché)</h5>
          <p className="text-lg font-semibold text-text-primary">{analysis.priceSuggestion || 'N/A'}</p>
        </div>
        
        <div>
          <h5 className="text-xs font-bold text-text-muted uppercase tracking-wider">Événements Locaux</h5>
          {analysis.events && analysis.events.length > 0 ? (
            <ul className="list-disc list-inside text-sm text-text-secondary space-y-1 mt-1">
              {analysis.events.map((event, index) => (
                <li key={index}>{event}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-text-secondary mt-1">Aucun événement majeur trouvé.</p>
          )}
        </div>
         <div>
          <h5 className="text-xs font-bold text-text-muted uppercase tracking-wider">Résumé de l'IA</h5>
          <p className="text-sm text-text-secondary italic mt-1">"{analysis.analysisSummary || 'Analyse non disponible.'}"</p>
        </div>
      </div>
    );
  };

  return (
    <div className="bg-bg-secondary p-4 rounded-lg shadow-lg">
      <h4 className="text-lg font-semibold text-text-primary mb-3 border-b border-border-primary pb-2">
        Analyse du Marché
      </h4>
      {renderContent()}
    </div>
  );
}

export default DateAnalysis;

