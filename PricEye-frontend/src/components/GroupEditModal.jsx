import React, { useState, useEffect } from 'react';
import { updateGroup, updateGroupStrategy, updateGroupRules, addPropertiesToGroup, removePropertiesFromGroup } from '../services/api.js';
import CustomScrollbar from './CustomScrollbar.jsx';
import { useLanguage } from '../contexts/LanguageContext.jsx';

// Composant CheckProperty1On (checkbox avec état on/off)
const CheckProperty1On = ({ property1 = 'off', className = '', onChange }) => {
  const isOn = property1 === 'on';
  
  return (
    <div className={`relative w-5 h-5 shrink-0 ${className}`}>
      {isOn ? (
        <div 
          className="w-5 h-5 bg-global-content-highlight-2nd rounded flex items-center justify-center cursor-pointer"
          onClick={() => onChange && onChange('off')}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M10 3L4.5 8.5L2 6" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      ) : (
        <div 
          className="w-5 h-5 border border-global-content-highlight-2nd rounded bg-transparent cursor-pointer"
          onClick={() => onChange && onChange('on')}
        />
      )}
    </div>
  );
};

// Icônes SVG
const CloseIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
    <path d="M15 5L5 15M5 5L15 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

function GroupEditModal({ token, onClose, onSave, group, properties, userProfile }) {
  const { t, language } = useLanguage();
  const [activeTab, setActiveTab] = useState('general');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  // État général
  const [groupName, setGroupName] = useState('');
  const [syncPrices, setSyncPrices] = useState(false);

  // État stratégie
  const [strategyData, setStrategyData] = useState({
    strategy: t('strategyModal.balanced'),
    floor_price: '',
    base_price: '',
    ceiling_price: '',
  });

  // État règles
  const [rulesData, setRulesData] = useState({
    min_stay: '',
    max_stay: '',
    weekly_discount_percent: '',
    monthly_discount_percent: '',
    weekend_markup_percent: '',
  });

  // État propriétés
  const [selectedPropertiesToAdd, setSelectedPropertiesToAdd] = useState([]);
  const [mainPropertyId, setMainPropertyId] = useState(null);
  const [propertiesInGroupIds, setPropertiesInGroupIds] = useState([]);

  useEffect(() => {
    if (group) {
      setGroupName(group.name || '');
      setSyncPrices(group.syncPrices || false);
      setMainPropertyId(group.mainPropertyId || null);
      setPropertiesInGroupIds(group.properties || []);

      // Initialiser la stratégie
      setStrategyData({
        strategy: group.strategy || t('strategyModal.balanced'),
        floor_price: group.floor_price != null ? String(group.floor_price) : '',
        base_price: group.base_price != null ? String(group.base_price) : '',
        ceiling_price: group.ceiling_price != null ? String(group.ceiling_price) : '',
      });

      // Initialiser les règles
      setRulesData({
        min_stay: group.min_stay != null ? String(group.min_stay) : '',
        max_stay: group.max_stay != null ? String(group.max_stay) : '',
        weekly_discount_percent: group.weekly_discount_percent != null ? String(group.weekly_discount_percent) : '',
        monthly_discount_percent: group.monthly_discount_percent != null ? String(group.monthly_discount_percent) : '',
        weekend_markup_percent: group.weekend_markup_percent != null ? String(group.weekend_markup_percent) : '',
      });
    }
  }, [group, t]);

  const propertiesInGroup = propertiesInGroupIds
    .map(propId => properties.find(p => p.id === propId))
    .filter(Boolean);
  const availableProperties = properties.filter(p => !propertiesInGroupIds.includes(p.id));

  const handleSave = async () => {
    setError('');
    setIsLoading(true);

    try {
      // 1. Mettre à jour le nom et la synchronisation
      await updateGroup(group.id, { 
        name: groupName.trim(),
        syncPrices: syncPrices,
        mainPropertyId: mainPropertyId
      }, token);

      // 2. Mettre à jour la stratégie
      if (strategyData.floor_price && strategyData.base_price) {
        await updateGroupStrategy(group.id, {
          strategy: strategyData.strategy,
          floor_price: parseInt(strategyData.floor_price, 10),
          base_price: parseInt(strategyData.base_price, 10),
          ceiling_price: strategyData.ceiling_price ? parseInt(strategyData.ceiling_price, 10) : null,
        }, token);
      }

      // 3. Mettre à jour les règles
      await updateGroupRules(group.id, {
        min_stay: rulesData.min_stay !== '' ? parseInt(rulesData.min_stay, 10) : null,
        max_stay: rulesData.max_stay !== '' ? parseInt(rulesData.max_stay, 10) : null,
        weekly_discount_percent: rulesData.weekly_discount_percent !== '' ? parseInt(rulesData.weekly_discount_percent, 10) : null,
        monthly_discount_percent: rulesData.monthly_discount_percent !== '' ? parseInt(rulesData.monthly_discount_percent, 10) : null,
        weekend_markup_percent: rulesData.weekend_markup_percent !== '' ? parseInt(rulesData.weekend_markup_percent, 10) : null,
      }, token);

      // 4. Ajouter les propriétés sélectionnées
      if (selectedPropertiesToAdd.length > 0) {
        await addPropertiesToGroup(group.id, selectedPropertiesToAdd, token);
      }

      onSave();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRemoveProperty = async (propertyId) => {
    try {
      setIsLoading(true);
      await removePropertiesFromGroup(group.id, [propertyId], token);
      // Mettre à jour l'état local immédiatement
      setPropertiesInGroupIds(prev => prev.filter(id => id !== propertyId));
      setSelectedPropertiesToAdd([]);
      // Rafraîchir les données dans le parent
      if (onSave) {
        onSave();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const tabs = [
    { id: 'general', label: t('groupEditModal.general') },
    { id: 'strategy', label: t('groupEditModal.strategy') },
    { id: 'rules', label: t('groupEditModal.rules') },
    { id: 'properties', label: t('groupEditModal.properties') },
  ];

  return (
    <div className="fixed inset-0 bg-black bg-opacity-90 flex items-center justify-center p-4 z-50">
      <div className="bg-global-bg-box rounded-[14px] border border-solid border-global-stroke-box w-full max-w-4xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-global-stroke-box shrink-0">
          <h2 className="text-xl font-bold text-global-blanc">{t('groupEditModal.title')}</h2>
          <button
            onClick={onClose}
            className="text-global-inactive hover:text-global-blanc transition-colors"
            aria-label={t('common.close')}
          >
            <CloseIcon />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-global-stroke-box shrink-0">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-6 py-3 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? 'text-global-blanc border-b-2 border-global-content-highlight-2nd'
                  : 'text-global-inactive hover:text-global-blanc'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <CustomScrollbar className="flex-1 min-h-0">
          <div className="p-6 space-y-6">
            {error && (
              <div className="p-3 bg-red-900/40 border border-red-500/40 rounded-lg">
                <p className="text-sm text-red-300">{error}</p>
              </div>
            )}

            {/* Tab: General */}
            {activeTab === 'general' && (
              <div className="space-y-4">
                <div>
                  <label htmlFor="groupName" className="block text-sm font-medium text-global-inactive mb-2">
                    {t('groupEditModal.groupName')}
                  </label>
                  <input
                    id="groupName"
                    type="text"
                    value={groupName}
                    onChange={(e) => setGroupName(e.target.value)}
                    className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc rounded-[10px] px-3 py-2 focus:outline-none focus:border-global-content-highlight-2nd"
                    placeholder={t('groupEditModal.groupNamePlaceholder')}
                  />
                </div>

                <div className="flex items-center gap-3 p-4 bg-global-bg-small-box rounded-[10px] border border-global-stroke-box">
                  <CheckProperty1On 
                    property1={syncPrices ? 'on' : 'off'} 
                    onChange={(value) => setSyncPrices(value === 'on')}
                  />
                  <label className="text-global-blanc cursor-pointer flex-1">
                    {t('groupsManager.syncPrices')}
                  </label>
                </div>
              </div>
            )}

            {/* Tab: Strategy */}
            {activeTab === 'strategy' && (
              <div className="space-y-4">
                <div>
                  <label htmlFor="strategy" className="block text-sm font-medium text-global-inactive mb-2">
                    {t('strategyModal.strategy')}
                  </label>
                  <select
                    id="strategy"
                    value={strategyData.strategy}
                    onChange={(e) => setStrategyData({ ...strategyData, strategy: e.target.value })}
                    className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc rounded-[10px] px-3 py-2 focus:outline-none focus:border-global-content-highlight-2nd"
                  >
                    <option value="Prudent">{t('strategyModal.prudent')}</option>
                    <option value="Équilibré">{t('strategyModal.balanced')}</option>
                    <option value="Agressif">{t('strategyModal.aggressive')}</option>
                  </select>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label htmlFor="floor_price" className="block text-sm font-medium text-global-inactive mb-2">
                      {t('strategyModal.floorPrice')}
                    </label>
                    <input
                      id="floor_price"
                      type="number"
                      value={strategyData.floor_price}
                      onChange={(e) => setStrategyData({ ...strategyData, floor_price: e.target.value })}
                      className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc rounded-[10px] px-3 py-2 focus:outline-none focus:border-global-content-highlight-2nd"
                      placeholder="Ex: 80"
                    />
                  </div>
                  <div>
                    <label htmlFor="base_price" className="block text-sm font-medium text-global-inactive mb-2">
                      {t('strategyModal.basePrice')}
                    </label>
                    <input
                      id="base_price"
                      type="number"
                      value={strategyData.base_price}
                      onChange={(e) => setStrategyData({ ...strategyData, base_price: e.target.value })}
                      className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc rounded-[10px] px-3 py-2 focus:outline-none focus:border-global-content-highlight-2nd"
                      placeholder="Ex: 120"
                    />
                  </div>
                  <div>
                    <label htmlFor="ceiling_price" className="block text-sm font-medium text-global-inactive mb-2">
                      {t('strategyModal.ceilingPrice')}
                    </label>
                    <input
                      id="ceiling_price"
                      type="number"
                      value={strategyData.ceiling_price}
                      onChange={(e) => setStrategyData({ ...strategyData, ceiling_price: e.target.value })}
                      className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc rounded-[10px] px-3 py-2 focus:outline-none focus:border-global-content-highlight-2nd"
                      placeholder={t('strategyModal.optional')}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Tab: Rules */}
            {activeTab === 'rules' && (
              <div className="space-y-6">
                <fieldset className="border border-global-stroke-box p-4 rounded-md">
                  <legend className="text-lg font-semibold px-2 text-global-blanc">{t('rulesModal.stayDuration')}</legend>
                  <div className="grid grid-cols-2 gap-4 mt-2">
                    <div>
                      <label htmlFor="min_stay" className="block text-sm font-medium text-global-inactive mb-2">
                        {t('rulesModal.minStay')}
                      </label>
                      <input
                        id="min_stay"
                        type="number"
                        value={rulesData.min_stay}
                        onChange={(e) => setRulesData({ ...rulesData, min_stay: e.target.value })}
                        className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc rounded-[10px] px-3 py-2 focus:outline-none focus:border-global-content-highlight-2nd"
                        placeholder="Ex: 2"
                        min="0"
                      />
                    </div>
                    <div>
                      <label htmlFor="max_stay" className="block text-sm font-medium text-global-inactive mb-2">
                        {t('rulesModal.maxStay')}
                      </label>
                      <input
                        id="max_stay"
                        type="number"
                        value={rulesData.max_stay}
                        onChange={(e) => setRulesData({ ...rulesData, max_stay: e.target.value })}
                        className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc rounded-[10px] px-3 py-2 focus:outline-none focus:border-global-content-highlight-2nd"
                        placeholder="Ex: 90"
                        min="0"
                      />
                    </div>
                  </div>
                </fieldset>

                <fieldset className="border border-global-stroke-box p-4 rounded-md">
                  <legend className="text-lg font-semibold px-2 text-global-blanc">{t('rulesModal.longTermDiscounts')}</legend>
                  <div className="grid grid-cols-2 gap-4 mt-2">
                    <div>
                      <label htmlFor="weekly_discount_percent" className="block text-sm font-medium text-global-inactive mb-2">
                        {t('rulesModal.weeklyDiscount')}
                      </label>
                      <input
                        id="weekly_discount_percent"
                        type="number"
                        value={rulesData.weekly_discount_percent}
                        onChange={(e) => setRulesData({ ...rulesData, weekly_discount_percent: e.target.value })}
                        className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc rounded-[10px] px-3 py-2 focus:outline-none focus:border-global-content-highlight-2nd"
                        placeholder="Ex: 10"
                        min="0"
                        max="100"
                      />
                    </div>
                    <div>
                      <label htmlFor="monthly_discount_percent" className="block text-sm font-medium text-global-inactive mb-2">
                        {t('rulesModal.monthlyDiscount')}
                      </label>
                      <input
                        id="monthly_discount_percent"
                        type="number"
                        value={rulesData.monthly_discount_percent}
                        onChange={(e) => setRulesData({ ...rulesData, monthly_discount_percent: e.target.value })}
                        className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc rounded-[10px] px-3 py-2 focus:outline-none focus:border-global-content-highlight-2nd"
                        placeholder="Ex: 20"
                        min="0"
                        max="100"
                      />
                    </div>
                  </div>
                </fieldset>

                <fieldset className="border border-global-stroke-box p-4 rounded-md">
                  <legend className="text-lg font-semibold px-2 text-global-blanc">{t('rulesModal.markups')}</legend>
                  <div>
                    <label htmlFor="weekend_markup_percent" className="block text-sm font-medium text-global-inactive mb-2">
                      {t('rulesModal.weekendMarkup')}
                    </label>
                    <input
                      id="weekend_markup_percent"
                      type="number"
                      value={rulesData.weekend_markup_percent}
                      onChange={(e) => setRulesData({ ...rulesData, weekend_markup_percent: e.target.value })}
                      className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc rounded-[10px] px-3 py-2 focus:outline-none focus:border-global-content-highlight-2nd"
                      placeholder="Ex: 15"
                      min="0"
                    />
                    <p className="text-xs text-global-inactive mt-1">{t('rulesModal.weekendMarkupNote')}</p>
                  </div>
                </fieldset>
              </div>
            )}

            {/* Tab: Properties */}
            {activeTab === 'properties' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-lg font-semibold text-global-blanc mb-4">
                    {t('groupsManager.propertiesInGroup')} ({propertiesInGroup.length})
                  </h3>
                  {propertiesInGroup.length > 0 ? (
                    <ul className="space-y-2">
                      {propertiesInGroup.map(prop => (
                        <li key={prop.id} className="flex justify-between items-center bg-global-bg-small-box border border-global-stroke-box p-3 rounded-lg">
                          <div className="flex items-center gap-3 flex-1">
                            <input
                              type="radio"
                              name="mainProperty"
                              checked={mainPropertyId === prop.id}
                              onChange={() => setMainPropertyId(prop.id)}
                              className="w-4 h-4 text-blue-600"
                            />
                            <span className="text-global-blanc">{prop.address || prop.name}</span>
                            {mainPropertyId === prop.id && (
                              <span className="px-2 py-0.5 bg-blue-600 text-white rounded-full text-xs font-bold">
                                {t('groupsManager.main')}
                              </span>
                            )}
                          </div>
                          <button
                            onClick={() => handleRemoveProperty(prop.id)}
                            className="px-3 py-1 bg-red-800 hover:bg-red-700 text-white rounded text-sm transition-colors"
                          >
                            {t('groupsManager.removeProperty')}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-global-inactive">{t('groupsManager.noProperties')}</p>
                  )}
                </div>

                {availableProperties.length > 0 && (
                  <div>
                    <h3 className="text-lg font-semibold text-global-blanc mb-4">{t('groupsManager.addProperties')}</h3>
                    <div className="flex gap-2">
                      <select
                        multiple
                        value={selectedPropertiesToAdd}
                        onChange={(e) => setSelectedPropertiesToAdd(Array.from(e.target.selectedOptions, option => option.value))}
                        className="flex-grow bg-global-bg-small-box border border-global-stroke-box rounded-[10px] text-sm h-32 text-global-blanc focus:outline-none p-2"
                        size={Math.min(availableProperties.length, 5)}
                      >
                        {availableProperties.map(prop => (
                          <option key={prop.id} value={prop.id}>
                            {prop.address || prop.name}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={async () => {
                          if (selectedPropertiesToAdd.length > 0) {
                            try {
                              setIsLoading(true);
                              await addPropertiesToGroup(group.id, selectedPropertiesToAdd, token);
                              // Mettre à jour l'état local immédiatement
                              setPropertiesInGroupIds(prev => [...prev, ...selectedPropertiesToAdd]);
                              setSelectedPropertiesToAdd([]);
                              if (onSave) onSave();
                            } catch (err) {
                              setError(err.message);
                            } finally {
                              setIsLoading(false);
                            }
                          }
                        }}
                        disabled={isLoading || selectedPropertiesToAdd.length === 0}
                        className="px-4 py-2 font-semibold text-white bg-gradient-to-r from-[#155dfc] to-[#12a1d5] rounded-md self-start hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {t('groupsManager.add')}
                      </button>
                    </div>
                    <p className="text-xs text-global-inactive mt-2">
                      {t('groupEditModal.selectMultipleHint')}
                    </p>
                  </div>
                )}
                {availableProperties.length === 0 && propertiesInGroup.length > 0 && (
                  <p className="text-sm text-global-inactive">{t('groupsManager.allPropertiesInGroup')}</p>
                )}
              </div>
            )}
          </div>
        </CustomScrollbar>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 p-6 border-t border-global-stroke-box shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 border border-global-stroke-box rounded-[10px] bg-transparent text-global-blanc hover:opacity-90 transition-opacity"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={isLoading || !groupName.trim()}
            className="px-4 py-2 rounded-[10px] bg-gradient-to-r from-[#155dfc] to-[#12a1d5] text-global-blanc hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default GroupEditModal;

