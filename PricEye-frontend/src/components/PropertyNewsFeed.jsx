import React, { useState, useEffect } from 'react';
import { getPropertySpecificNews } from '../services/api.js';
import CustomScrollbar from './CustomScrollbar.jsx';
import { useLanguage } from '../contexts/LanguageContext.jsx';

// Icônes pour les impacts
const NegativeImpactIcon = ({ className = '' }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className={className}>
    <path d="M8 12V4M4 8H12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const PositiveImpactIcon = ({ className = '' }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className={className}>
    <path d="M8 4V12M4 8H12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const MidImpactIcon = ({ className = '' }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className={className}>
    <path d="M8 4V12M4 8H12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

// Fonction pour formater la date relative (sera utilisée dans le composant avec t)

function PropertyNewsFeed({ token, propertyId }) {
  const { t, language } = useLanguage();
  const [news, setNews] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  // Fonction pour formater la date relative
  const formatRelativeTime = (dateString) => {
    if (!dateString) return t('propertyNewsFeed.unknownDate');
    
    try {
      const date = new Date(dateString);
      const now = new Date();
      const diffMs = now - date;
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);
      const diffMonths = Math.floor(diffDays / 30);
      const diffYears = Math.floor(diffMonths / 12);

      if (diffMins < 60) {
        return diffMins > 1 
          ? t('propertyNewsFeed.timeAgo.minutesPlural', { count: diffMins })
          : t('propertyNewsFeed.timeAgo.minutes', { count: diffMins });
      } else if (diffHours < 24) {
        return diffHours > 1
          ? t('propertyNewsFeed.timeAgo.hoursPlural', { count: diffHours })
          : t('propertyNewsFeed.timeAgo.hours', { count: diffHours });
      } else if (diffDays < 30) {
        return diffDays > 1
          ? t('propertyNewsFeed.timeAgo.daysPlural', { count: diffDays })
          : t('propertyNewsFeed.timeAgo.days', { count: diffDays });
      } else if (diffMonths < 12) {
        return t('propertyNewsFeed.timeAgo.months', { count: diffMonths });
      } else {
        return diffYears > 1
          ? t('propertyNewsFeed.timeAgo.yearsPlural', { count: diffYears })
          : t('propertyNewsFeed.timeAgo.years', { count: diffYears });
      }
    } catch (error) {
      return t('propertyNewsFeed.unknownDate');
    }
  };

  useEffect(() => {
    const fetchNews = async () => {
      if (!token || !propertyId) {
          setNews([]);
          setIsLoading(false);
          return;
      }
      setIsLoading(true);
      setError('');
      try {
        const data = await getPropertySpecificNews(propertyId, token, language);
        setNews(data); 
      } catch (err) {
        setError(t('propertyNewsFeed.error', { message: err.message }));
      } finally {
        setIsLoading(false);
      }
    };

    fetchNews();
  }, [token, propertyId, language, t]);

  // Fonction pour déterminer la couleur et l'icône de l'impact
  const getImpactStyle = (percentage, category) => {
    if (percentage > 0) {
      return {
        color: 'text-global-positive-impact',
        icon: <PositiveImpactIcon className="w-4 h-4 shrink-0" />,
        sign: `+${percentage}%`
      };
    } else if (percentage < 0) {
      return {
        color: 'text-global-negative-impact',
        icon: <NegativeImpactIcon className="w-4 h-4 shrink-0" />,
        sign: `${percentage}%`
      };
    } else {
      return {
        color: 'text-global-mid-impact',
        icon: <MidImpactIcon className="w-4 h-4 shrink-0" />,
        sign: '0%'
      };
    }
  };

  const renderContent = () => {
    if (isLoading) {
      return (
        <div className="flex justify-center items-center h-24 w-full">
          <div className="w-8 h-8 border-2 border-global-content-highlight-2nd border-t-transparent rounded-full animate-spin"></div>
        </div>
      );
    }
    if (error) {
      return (
        <p className="text-global-inactive text-left font-p1-font-family text-p1-font-size font-p1-font-weight break-words">
          {error}
        </p>
      );
    }
    if (!news || !Array.isArray(news) || news.length === 0) {
      return (
        <p className="text-global-inactive text-left font-p1-font-family text-p1-font-size font-p1-font-weight break-words">
          {t('propertyNewsFeed.noNews')}
        </p>
      );
    }

    return (
      <div className="flex flex-col gap-3 items-start justify-start w-full">
        {news.map((item, index) => {
          const impactStyle = getImpactStyle(item.impact_percentage || 0, item.impact_category);
          const relativeTime = formatRelativeTime(item.publishedAt || item.date);

          return (
            <div 
              key={index} 
              className="bg-global-bg-small-box rounded-[14px] pt-3 pr-4 pb-3 pl-4 flex flex-row gap-3 items-start justify-start self-stretch shrink-0 relative w-full min-w-0"
            >
              <div className="flex flex-col gap-1 items-start justify-start flex-1 relative min-w-0 w-full">
                <div className="text-global-blanc text-left font-h4-font-family text-h4-font-size leading-h4-line-height font-h4-font-weight relative self-stretch break-words w-full">
                  {item.title || t('propertyNewsFeed.noTitle')}
                </div>
                <div className="text-global-inactive text-left font-p2-font-family text-p2-font-size font-p2-font-weight relative self-stretch break-words whitespace-normal w-full">
                  {item.summary || item.description || t('propertyNewsFeed.noDescription')}
                </div>
                <div className="flex flex-row items-center justify-between self-stretch shrink-0 relative flex-wrap gap-2 w-full">
                  <div className="flex flex-row gap-1 items-center justify-start shrink-0 relative flex-wrap min-w-0">
                    <div className={`${impactStyle.color} text-left font-p1-font-family text-p1-font-size font-p1-font-weight relative whitespace-nowrap`}>
                      {t('propertyNewsFeed.estimatedImpact')}
                    </div>
                    {impactStyle.icon}
                    <div className={`${impactStyle.color} text-left font-p1-font-family text-p1-font-size font-p1-font-weight relative whitespace-nowrap`}>
                      {impactStyle.sign}
                    </div>
                  </div>
                  <div className="text-global-inactive text-left font-p1-font-family text-p1-font-size font-p1-font-weight relative whitespace-nowrap shrink-0">
                    {relativeTime}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="bg-global-bg-box rounded-[14px] border border-solid border-global-stroke-box p-6 flex flex-col gap-3 items-start justify-start self-stretch shrink-0 h-[389px] relative w-full min-w-0 overflow-hidden">
      <div className="text-global-blanc text-left font-h2-font-family text-h2-font-size font-h2-font-weight relative w-full shrink-0">
        {t('propertyNewsFeed.title')}
      </div>
      <div className="flex-1 relative w-full min-h-0 overflow-hidden flex flex-col">
        <CustomScrollbar className="flex-1 min-h-0">
          {renderContent()}
        </CustomScrollbar>
      </div>
    </div>
  );
}

export default PropertyNewsFeed;
