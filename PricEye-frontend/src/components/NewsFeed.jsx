import React, { useState, useEffect } from 'react';
import { getMarketNews } from '../services/api.js';

function NewsFeed({ token }) {
  const [news, setNews] = useState([]); // Attendre un tableau
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchNews = async () => {
      if (!token) return;
      setIsLoading(true);
      setError('');
      try {
        // L'API renvoie maintenant directement un tableau d'objets
        const data = await getMarketNews(token);
        setNews(data); 
      } catch (err) {
        setError(`Impossible de charger les actualités: ${err.message}`);
      } finally {
        setIsLoading(false);
      }
    };

    fetchNews();
  }, [token]);

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
      return percentage > 0 ? `+${percentage}%` : `${percentage}%`;
  }

  const renderContent = () => {
    if (isLoading) {
      return (
        <div className="flex justify-center items-center h-48">
          <div className="loader"></div>
        </div>
      );
    }
    if (error) {
      return <p className="text-sm text-red-400">{error}</p>;
    }
    if (!news || !Array.isArray(news) || news.length === 0) {
      return <p className="text-sm text-gray-500">Aucune actualité pertinente trouvée.</p>;
    }

    // Afficher les données structurées
    return (
      <div className="space-y-4">
        {news.map((item, index) => (
          <div key={index} className="bg-gray-700/50 p-3 rounded-md">
            <h4 className="font-semibold text-white">{item.title}</h4>
            <p className="text-sm text-gray-300 mt-1">{item.summary}</p>
            <div className={`text-sm font-bold mt-2 ${getImpactColor(item.impact_category)}`}>
                Impact estimé : {getImpactSign(item.impact_percentage)} ({item.impact_category})
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="bg-gray-800 p-6 rounded-lg h-full">
      <h2 className="text-xl font-bold mb-4">Actualités du Marché</h2>
      <div className="space-y-4 max-h-[600px] overflow-y-auto pr-2">
        {renderContent()}
      </div>
    </div>
  );
}

export default NewsFeed;

