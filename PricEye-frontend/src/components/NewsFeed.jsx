import React, { useState, useEffect, useCallback } from 'react';
import { getMarketNews } from '../services/api.js';

function NewsFeed({ token }) {
  const [news, setNews] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchNews = useCallback(async () => {
    if (!token) return;
    setIsLoading(true);
    setError('');
    try {
      const data = await getMarketNews(token);
      setNews(data || []);
    } catch (err) {
      setError(`Impossible de charger les actualités: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchNews();
  }, [fetchNews]);

  const getImpactColor = (category) => {
    switch ((category || '').toLowerCase()) {
      case 'élevé':
      case 'high':
        return 'text-global-negative-impact';
      case 'modéré':
      case 'medium':
        return 'text-global-mid-impact';
      case 'faible':
      case 'low':
        return 'text-global-positive-impact';
      default:
        return 'text-global-inactive';
    }
  };

  const getImpactSign = (percentage) => {
    if (typeof percentage !== 'number') return 'N/A';
    return percentage > 0 ? `+${percentage}%` : `${percentage}%`;
  };

  const formatDate = (dateString) => {
    if (!dateString) return '';
    try {
      return new Intl.DateTimeFormat('fr-FR', {
        day: '2-digit',
        month: 'short',
      }).format(new Date(dateString));
    } catch {
      return '';
    }
  };

  const renderContent = () => {
    if (isLoading) {
      return (
        <div className="flex justify-center items-center h-48">
          <div className="loader" />
        </div>
      );
    }
    if (error) {
      return <p className="text-sm text-red-400">{error}</p>;
    }
    if (!news || news.length === 0) {
      return <p className="text-sm text-global-inactive">Aucune actualité pertinente trouvée.</p>;
    }

    return (
      <div className="space-y-4">
        {news.map((item, index) => (
          <div
            key={`${item.id || item.title}-${index}`}
            className="bg-global-bg-small-box border border-global-stroke-box rounded-[12px] p-4 flex flex-col gap-3"
          >
            <div className="flex items-center justify-between gap-4">
              <h4 className="text-global-blanc font-h4-font-family text-h4-font-size leading-h4-line-height font-h4-font-weight">
                {item.title}
              </h4>
              <span className="text-xs text-global-inactive whitespace-nowrap">
                {formatDate(item.published_at)}
              </span>
            </div>
            <p className="text-sm text-global-inactive">{item.summary}</p>
            <div className="flex items-center justify-between text-sm">
              <span className={`font-semibold ${getImpactColor(item.impact_category)}`}>
                Impact estimé : {getImpactSign(item.impact_percentage)} ({item.impact_category || 'N/A'})
              </span>
              {item.source && (
                <span className="text-xs text-global-inactive">Source : {item.source}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="bg-global-bg-box border border-global-stroke-box rounded-[14px] p-6 h-full shadow-[0_15px_60px_rgba(0,0,0,0.35)]">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm uppercase tracking-[0.3em] text-global-inactive">Insights</p>
          <h2 className="text-2xl font-h2-font-family text-global-blanc">Actualité du marché</h2>
        </div>
        <button
          type="button"
          onClick={fetchNews}
          className="text-sm px-4 py-2 rounded-full border border-global-stroke-box text-global-inactive hover:text-global-blanc hover:border-global-content-highlight-2nd transition"
        >
          Actualiser
        </button>
      </div>
      <div className="space-y-4 max-h-[600px] overflow-y-auto mt-4 pr-2 custom-scrollbar">
        {renderContent()}
      </div>
    </div>
  );
}

export default NewsFeed;

