import React, { useState, useEffect, useCallback } from 'react';
import { getMarketNews } from '../services/api.js';
import CustomScrollbar from './CustomScrollbar.jsx';
import { useLanguage } from '../contexts/LanguageContext.jsx';

function NewsFeed({ token, userProfile }) {
  const { t, language: contextLanguage } = useLanguage();
  // Utiliser la langue du profil utilisateur en priorité, sinon celle du contexte
  const language = userProfile?.language || contextLanguage || 'fr';
  const [news, setNews] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchNews = useCallback(async (forceRefresh = false) => {
    if (!token) return;
    setIsLoading(true);
    setError('');
    try {
      // Toujours passer la langue explicitement pour s'assurer que le backend l'utilise
      const data = await getMarketNews(token, language, forceRefresh);
      setNews(data || []);
    } catch (err) {
      setError(t('newsFeed.loadError', { message: err.message }));
    } finally {
      setIsLoading(false);
    }
  }, [token, language, t]);

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
      const locale = language === 'en' ? 'en-US' : 'fr-FR';
      return new Intl.DateTimeFormat(locale, {
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
      return <p className="text-sm text-global-inactive">{t('newsFeed.noNews')}</p>;
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
                {t('newsFeed.estimatedImpact')}: {getImpactSign(item.impact_percentage)} ({item.impact_category || 'N/A'})
              </span>
              {item.source && (
                <span className="text-xs text-global-inactive">{t('newsFeed.source')}: {item.source}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="bg-global-bg-box border border-global-stroke-box rounded-[14px] p-6 shadow-[0_15px_60px_rgba(0,0,0,0.35)] flex flex-col h-full max-h-[800px]">
      <div className="flex items-center justify-between gap-4 shrink-0 mb-4">
        <div>
          <p className="text-sm uppercase tracking-[0.3em] text-global-inactive">Insights</p>
          <h2 className="text-2xl font-h2-font-family text-global-blanc">{t('newsFeed.title')}</h2>
        </div>
        <button
          type="button"
          onClick={() => fetchNews(true)}
          className="text-sm px-4 py-2 rounded-full border border-global-stroke-box text-global-inactive hover:text-global-blanc hover:border-global-content-highlight-2nd transition shrink-0"
        >
          {t('dashboard.refresh')}
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        <CustomScrollbar className="flex-1 min-h-0">
          {renderContent()}
        </CustomScrollbar>
      </div>
    </div>
  );
}

export default NewsFeed;

