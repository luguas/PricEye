import React, { useState, useEffect } from 'react';
import { getPropertySpecificNews } from '../services/api.js';

function PropertyNewsFeed({ token, propertyId }) {
  const [news, setNews] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchNews = async () => {
      if (!token || !propertyId) {
          setNews([]); // Vider les actualités si aucune propriété n'est sélectionnée
          setIsLoading(false);
          return;
      }
      setIsLoading(true);
      setError('');
      try {
        const data = await getPropertySpecificNews(propertyId, token);
        setNews(data); 
      } catch (err) {
        setError(`Impossible de charger les actualités: ${err.message}`);
      } finally {
        setIsLoading(false);
      }
    };

    fetchNews();
  }, [token, propertyId]); // Se redéclenche si l'ID de la propriété change

  // Fonction pour déterminer la couleur de l'impact
  const getImpactColor = (category) => {
    switch (category) {
      case 'élevé': return 'text-red-400';
      case 'modéré': return 'text-yellow-400';
      case 'faible': return 'text-green-400';
      default: return 'text-gray-400';
    }
  };

  const getImpactSign = (percentage) => {
      if (percentage > 0) return `+${percentage}%`;
      if (percentage < 0) return `${percentage}%`;
      return 'Nul'; 
  }

  const renderContent = () => {
    if (isLoading) {
      return (
        <div className="flex justify-center items-center h-24">
          <div className="loader"></div>
        </div>
      );
    }
    if (error) {
      return <p className="text-xs text-red-400">{error}</p>;
    }
    if (!news || !Array.isArray(news) || news.length === 0) {
      return <p className="text-xs text-gray-500">Aucune actualité spécifique trouvée pour cette localisation.</p>;
    }

    // Afficher les données structurées
    return (
      <div className="space-y-3">
        {news.map((item, index) => (
          <div key={index} className="bg-gray-700/50 p-2 rounded-md">
            <h4 className="font-semibold text-white text-sm">{item.title}</h4>
            <p className="text-xs text-gray-300 mt-1">{item.summary}</p>
            <div className={`text-xs font-bold mt-2 ${getImpactColor(item.impact_category)}`}>
                Impact estimé : {getImpactSign(item.impact_percentage)} ({item.impact_category})
            </div>
             <p className="text-[10px] text-gray-500 mt-1">Source: {item.source || 'Inconnue'}</p>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="bg-gray-800 p-4 rounded-lg h-full max-h-64 overflow-y-auto">
      {renderContent()}
    </div>
  );
}

export default PropertyNewsFeed;
