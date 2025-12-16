import React, { useState } from 'react';
import { createGroup, addPropertiesToGroup } from '../services/api.js';
import { useLanguage } from '../contexts/LanguageContext.jsx';

/**
 * Displays property grouping suggestions.
 * @param {object} props
 * @param {string} props.token - Authentication token.
 * @param {Array} props.recommendations - Array of recommendations.
 * @param {Function} props.onGroupCreated - Callback to refresh the dashboard.
 */
function GroupRecommendations({ token, recommendations, onGroupCreated }) {
  const { t } = useLanguage();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  if (!recommendations || recommendations.length === 0) {
    return null; // Don't display anything if there are no suggestions
  }

  const handleCreateGroup = async (recommendation) => {
    if (!recommendation || !recommendation.properties || recommendation.properties.length < 2) {
      setError(t('groupRecommendations.invalidRecommendation'));
      return;
    }
    
    setIsLoading(true);
    setError('');

    try {
      // 1. Create a group name (e.g., "Similar Group - Paris")
      const firstPropAddress = recommendation.properties[0].address;
      const groupName = `${t('groupRecommendations.groupNamePrefix')} (${firstPropAddress.split(',')[0]})`;
      
      // 2. Create the group
      const newGroup = await createGroup({ name: groupName }, token);
      
      // 3. Add properties to the group
      const propertyIds = recommendation.properties.map(p => p.id);
      await addPropertiesToGroup(newGroup.id, propertyIds, token);
      
      // 4. Refresh the dashboard
      onGroupCreated();
      
    } catch (err) {
      console.error("Error creating suggested group:", err);
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <p className="text-sm text-red-400 bg-red-900/30 border border-red-500/40 p-3 rounded-[10px]">
          {error}
        </p>
      )}
      <div className="space-y-3">
        {recommendations.map((rec) => (
          <div
            key={rec.key}
            className="bg-global-bg-small-box border border-global-stroke-box rounded-[12px] p-4 flex flex-col gap-4 md:flex-row md:items-center md:justify-between"
          >
            <div className="text-sm text-global-inactive">
              <p className="text-global-blanc font-semibold mb-1">
                {rec.properties.length} {t('groupRecommendations.similarProperties')}
              </p>
              <ul className="list-disc list-inside text-xs space-y-1">
                {rec.properties.map((p) => (
                  <li key={p.id}>{p.address}</li>
                ))}
              </ul>
            </div>
            <button
              onClick={() => handleCreateGroup(rec)}
              disabled={isLoading}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-[10px] font-semibold text-white bg-gradient-to-r from-[#155dfc] to-[#12a1d5] shadow-lg hover:opacity-90 disabled:opacity-50"
            >
              {isLoading ? t('groupRecommendations.creating') : t('groupRecommendations.createGroup')}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default GroupRecommendations;
