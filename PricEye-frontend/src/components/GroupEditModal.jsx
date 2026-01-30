import React, { useState, useEffect } from 'react';
import { updateGroup, updateGroupStrategy, updateGroupRules, addPropertiesToGroup, removePropertiesFromGroup, deleteGroup } from '../services/api.js';
import CustomScrollbar from './CustomScrollbar.jsx';
import { useLanguage } from '../contexts/LanguageContext.jsx';
import ConfirmModal from './ConfirmModal.jsx';
import BoutonStateSecondaire from './BoutonStateSecondaire.jsx';
import BoutonStatePrincipal from './BoutonStatePrincipal.jsx';
import IconsStateFiltre from './IconsStateFiltre.jsx';
import IconsStateAdd from './IconsStateAdd.jsx';
import IconsStateFlCheBas from './IconsStateFlCheBas.jsx';

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

const DeleteIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M2 4H14M12.6667 4V13.3333C12.6667 14 12 14.6667 11.3333 14.6667H4.66667C4 14.6667 3.33333 14 3.33333 13.3333V4M5.33333 4V2.66667C5.33333 2 6 1.33333 6.66667 1.33333H9.33333C10 1.33333 10.6667 2 10.6667 2.66667V4M6.66667 7.33333V11.3333M9.33333 7.33333V11.3333" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

function GroupEditModal({ token, onClose, onSave, group, properties, userProfile }) {
  const { t, language } = useLanguage();
  const [activeTab, setActiveTab] = useState('general');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  // Vérifier si l'utilisateur a un abonnement actif
  const subscriptionStatus = userProfile?.subscriptionStatus || 'none';
  const hasActiveSubscription = subscriptionStatus === 'active' || subscriptionStatus === 'trialing';
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // État général
  const [groupName, setGroupName] = useState('');
  const [syncPrices, setSyncPrices] = useState(false);

  // État stratégie
  const [strategyData, setStrategyData] = useState({
    strategy: group?.strategy || (group?._strategy_raw?.strategy) || 'Équilibré',
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
      // CORRECTION : Lecture robuste des champs (snake_case ou camelCase)
      setSyncPrices(group.sync_prices || group.syncPrices || false);
      setMainPropertyId(group.main_property_id || group.mainPropertyId || null);
      setPropertiesInGroupIds(group.properties || []);

      // Initialiser la stratégie
      // La stratégie peut être dans group.strategy (aplatie) ou dans group._strategy_raw.strategy (JSONB brut)
      const strategyName = group.strategy || 
                          (group._strategy_raw && typeof group._strategy_raw === 'object' ? group._strategy_raw.strategy : null) ||
                          'Équilibré'; // Valeur par défaut (pas la traduction, mais la valeur réelle)
      
      setStrategyData({
        strategy: strategyName,
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
      // 1. Mettre à jour le groupe (CORRECTION : Envoi des noms de colonnes DB corrects)
      await updateGroup(group.id, { 
        name: groupName.trim(),
        sync_prices: syncPrices,          // Snake_case pour la DB
        main_property_id: mainPropertyId  // Snake_case pour la DB
      }, token);

      // 2. Mettre à jour la stratégie (nom + prix si fournis)
      // Envoyer la mise à jour si le nom de la stratégie a changé OU si des prix ont été renseignés
      const strategyNameChanged = strategyData.strategy && strategyData.strategy !== (group?.strategy || (group?._strategy_raw?.strategy) || 'Équilibré');
      const hasPriceData = strategyData.floor_price !== '' || strategyData.base_price !== '' || strategyData.ceiling_price !== '';
      
      if (strategyNameChanged || hasPriceData) {
        await updateGroupStrategy(group.id, {
          strategy: strategyData.strategy,
          floor_price: strategyData.floor_price !== '' ? parseFloat(strategyData.floor_price) : null,
          base_price: strategyData.base_price !== '' ? parseFloat(strategyData.base_price) : null,
          ceiling_price: strategyData.ceiling_price !== '' ? parseFloat(strategyData.ceiling_price) : null,
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

  const handleDeleteGroup = async () => {
    try {
      setIsLoading(true);
      setError('');
      await deleteGroup(group.id, token);
      // Rafraîchir les données dans le parent
      if (onSave) {
        onSave();
      }
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
      setShowDeleteConfirm(false);
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
        {activeTab === 'properties' ? (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="p-6">
              {error && (
                <div className="p-3 bg-red-900/40 border border-red-500/40 rounded-lg mb-6">
                  <p className="text-sm text-red-300">{error}</p>
                </div>
              )}
              {/* Tab: Properties sera rendu plus bas */}
            </div>
          </div>
        ) : (
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

                {/* Section de suppression */}
                <div className="pt-4 border-t border-global-stroke-box">
                  <h3 className="text-sm font-medium text-global-inactive mb-3">
                    {t('groupEditModal.dangerZone')}
                  </h3>
                  <button
                    type="button"
                    onClick={() => setShowDeleteConfirm(true)}
                    disabled={isLoading}
                    className="px-4 py-2 bg-red-800 hover:bg-red-700 text-white rounded-[10px] text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {t('groupEditModal.deleteGroup')}
                  </button>
                  <p className="text-xs text-global-inactive mt-2">
                    {t('groupEditModal.deleteGroupHint')}
                  </p>
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

            </div>
          </CustomScrollbar>
        )}
        
        {/* Tab: Properties - rendu séparément sans scroll global */}
        {activeTab === 'properties' && (
          <div className="flex-1 min-h-0 flex flex-col">
            {error && (
              <div className="p-3 bg-red-900/40 border border-red-500/40 rounded-lg m-6 mb-0">
                <p className="text-sm text-red-300">{error}</p>
              </div>
            )}
            <div className="flex-1 min-h-0 overflow-y-auto p-6">
              <div className="bg-global-bg-box rounded-[14px] border-solid border-global-stroke-box border p-6 flex flex-col gap-3 items-start justify-start relative w-full">
                <div className="text-global-blanc text-left font-h2-font-family text-h2-font-size font-h2-font-weight relative">
                  {t('groupsManager.propertiesInGroup')} ({propertiesInGroup.length})
                </div>

                {/* Propriétés dans le groupe */}
                {propertiesInGroup.length > 0 ? (
                  propertiesInGroup.map(prop => (
                    <div key={prop.id} className="bg-[rgba(29,41,61,0.50)] rounded-[10px] border-solid border-[rgba(49,65,88,0.50)] border p-4 flex flex-col gap-4 items-start justify-start self-stretch shrink-0 relative">
                      <div className="flex flex-row items-center justify-between self-stretch shrink-0 relative">
                        <div className="text-[#ffffff] text-left font-h3-font-family text-h3-font-size font-h3-font-weight relative flex-1">
                          {prop.name || prop.address}
                        </div>
                        <div className="flex flex-row gap-2 items-start justify-end shrink-0 relative">
                          <button
                            onClick={() => setMainPropertyId(prop.id)}
                            disabled={mainPropertyId === prop.id || isLoading}
                            className={`bg-global-bg-small-box rounded-lg border-solid border-global-stroke-box border pt-3 pr-4 pb-3 pl-4 flex flex-row gap-4 items-center justify-start shrink-0 relative transition-opacity ${
                              mainPropertyId === prop.id 
                                ? 'opacity-50 cursor-not-allowed' 
                                : 'hover:opacity-90 cursor-pointer'
                            }`}
                          >
                            <div className="text-[#ffffff] text-center font-['Arial-Regular',_sans-serif] text-sm leading-5 font-normal relative">
                              {t('groupsManager.setAsMain') || 'Définir comme principal'}
                            </div>
                          </button>
                          <button
                            onClick={() => handleRemoveProperty(prop.id)}
                            disabled={isLoading}
                            className="bg-global-bg-small-box rounded-lg border-solid border-global-stroke-box border flex flex-row gap-0 items-center justify-center self-stretch shrink-0 w-11 relative hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                            style={{ aspectRatio: "1" }}
                          >
                            <DeleteIcon className="shrink-0 w-4 h-4 relative overflow-visible text-global-blanc" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-global-inactive">{t('groupsManager.noProperties')}</p>
                )}

                {/* Section Ajouter des propriétés disponibles */}
                {availableProperties.length > 0 && (
                  <div className="bg-[rgba(29,41,61,0.50)] rounded-[10px] border-solid border-[rgba(49,65,88,0.50)] border p-4 flex flex-col gap-4 items-start justify-start self-stretch shrink-0 relative overflow-hidden">
                    <div className="text-[#ffffff] text-left font-h3-font-family text-h3-font-size font-h3-font-weight relative self-stretch">
                      {t('groupsManager.addProperties')}
                    </div>
                    <div className="self-stretch shrink-0 relative overflow-hidden" style={{ height: '256px' }}>
                      <CustomScrollbar className="h-full w-full">
                        <div className="flex flex-col gap-3 items-start justify-start pr-2">
                          {availableProperties.map(prop => (
                            <div key={prop.id} className="bg-global-bg-small-box rounded-lg border-solid border-global-stroke-box border pt-3 pr-4 pb-3 pl-5 flex flex-row items-center justify-between w-full shrink-0 relative">
                              <div className="text-global-blanc text-left font-h4-font-family text-h4-font-size leading-h4-line-height font-h4-font-weight relative flex-1 min-w-0">
                                {prop.name || prop.address}
                              </div>
                              <BoutonStatePrincipal
                                component={<IconsStateAdd className="!w-5 !self-[unset]" state="add" />}
                                text={t('groupsManager.add')}
                                className="!shrink-0"
                                onClick={async () => {
                                  if (!hasActiveSubscription) {
                                    setError(t('groupsManager.subscriptionRequired') || 'Un abonnement actif est requis pour ajouter des propriétés à un groupe.');
                                    return;
                                  }
                                  try {
                                    setIsLoading(true);
                                    setError('');
                                    await addPropertiesToGroup(group.id, [prop.id], token);
                                    setPropertiesInGroupIds(prev => [...prev, prop.id]);
                                    if (onSave) onSave();
                                  } catch (err) {
                                    setError(err.message);
                                  } finally {
                                    setIsLoading(false);
                                  }
                                }}
                                disabled={isLoading || !hasActiveSubscription}
                              />
                            </div>
                          ))}
                        </div>
                      </CustomScrollbar>
                    </div>
                  </div>
                )}
                {availableProperties.length === 0 && propertiesInGroup.length > 0 && (
                  <p className="text-sm text-global-inactive">{t('groupsManager.allPropertiesInGroup')}</p>
                )}
              </div>
            </div>
          </div>
        )}

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

      {/* Modale de confirmation de suppression */}
      <ConfirmModal
        isOpen={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDeleteGroup}
        title={t('groupEditModal.deleteConfirmTitle')}
        message={t('groupEditModal.deleteConfirmMessage', { groupName: group?.name || '' })}
        confirmText={t('groupEditModal.deleteConfirm')}
        cancelText={t('common.cancel')}
      />
    </div>
  );
}

export default GroupEditModal;

