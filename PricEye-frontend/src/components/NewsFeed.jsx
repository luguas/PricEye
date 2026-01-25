import React, { useState, useEffect, useCallback, useRef } from 'react';
import { getMarketNews } from '../services/api.js';
import CustomScrollbar from './CustomScrollbar.jsx';
import { useLanguage } from '../contexts/LanguageContext.jsx';
import { handleQuotaError } from '../utils/quotaErrorHandler.js';

const MIN_NEWS_FETCH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes entre deux appels (sauf changement de langue)

function NewsFeed({ token, userProfile }) {
  const { t, language: contextLanguage } = useLanguage();
  const language = userProfile?.language || contextLanguage || 'fr';
  const prevLanguageRef = useRef(undefined);
  const lastFetchRef = useRef(0);
  const userProfileRef = useRef(userProfile);
  userProfileRef.current = userProfile;
  const [news, setNews] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchNews = useCallback(async (forceRefresh = false) => {
    if (!token) return;
    setIsLoading(true);
    setError('');
    try {
      const data = await getMarketNews(token, language, forceRefresh);
      setNews(data || []);
      lastFetchRef.current = Date.now();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('aiCallCompleted'));
      }
    } catch (err) {
      const isQuotaError = handleQuotaError(err, setError, null, userProfileRef.current, null);
      if (!isQuotaError) {
        setError(t('newsFeed.loadError', { message: err.message }));
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('aiCallFailed'));
      }
    } finally {
      setIsLoading(false);
    }
  }, [token, language, t]);

  useEffect(() => {
    const prev = prevLanguageRef.current;
    const isFirstMount = prev === undefined;
    const isLanguageChange = !isFirstMount && prev !== language;
    prevLanguageRef.current = language;

    if (isLanguageChange) {
      fetchNews(true);
      return;
    }
    if (isFirstMount) {
      fetchNews(false);
      return;
    }
    const elapsed = Date.now() - lastFetchRef.current;
    if (elapsed >= MIN_NEWS_FETCH_INTERVAL_MS) {
      fetchNews(false);
    }
  }, [language, fetchNews]);

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

  const translateImpactCategory = (category) => {
    if (!category) return 'N/A';
    const categoryKey = category.toLowerCase();
    return t(`newsFeed.impactCategories.${categoryKey}`, category);
  };

  const getImpactSign = (percentage) => {
    if (typeof percentage !== 'number') return 'N/A';
    return percentage > 0 ? `+${percentage}%` : `${percentage}%`;
  };

  const formatDate = (dateInput) => {
    if (dateInput == null || dateInput === '') return '';
    try {
      let date;
      if (typeof dateInput === 'number') {
        const ms = dateInput < 1e12 ? dateInput * 1000 : dateInput;
        date = new Date(ms);
      } else {
        date = new Date(dateInput);
      }
      if (Number.isNaN(date.getTime())) return '';
      const locale = language === 'en' ? 'en-US' : 'fr-FR';
      return new Intl.DateTimeFormat(locale, {
        day: '2-digit',
        month: 'short',
      }).format(date);
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
        {news.map((item, index) => {
          const dateStr = formatDate(item.published_at);
          return (
          <div
            key={`${item.id || item.title}-${index}`}
            className="bg-global-bg-small-box border border-global-stroke-box rounded-[12px] p-4 flex flex-col gap-3"
          >
            <div className="flex items-center justify-between gap-4">
              <h4 className="text-global-blanc font-h4-font-family text-h4-font-size leading-h4-line-height font-h4-font-weight">
                {item.title}
              </h4>
              {dateStr ? (
                <span className="text-xs text-global-inactive whitespace-nowrap">
                  {dateStr}
                </span>
              ) : null}
            </div>
            <p className="text-sm text-global-inactive">{item.summary}</p>
            <div className="flex items-center justify-between text-sm">
              <span className={`font-semibold ${getImpactColor(item.impact_category)}`}>
                {t('newsFeed.estimatedImpact')}: {getImpactSign(item.impact_percentage)} ({translateImpactCategory(item.impact_category)})
              </span>
              {item.source && (
                <span className="text-xs text-global-inactive">{t('newsFeed.source')}: {item.source}</span>
              )}
            </div>
          </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="bg-global-bg-box border border-global-stroke-box rounded-[14px] p-6 shadow-[0_15px_60px_rgba(0,0,0,0.35)] flex flex-col h-full max-h-[800px]">
      <div className="shrink-0 mb-4">
        <p className="text-sm uppercase tracking-[0.3em] text-global-inactive">{t('newsFeed.insights')}</p>
        <h2 className="text-2xl font-h2-font-family text-global-blanc">{t('newsFeed.title')}</h2>
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

