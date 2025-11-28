import React, { useState, useEffect } from 'react';
import { updatePropertyStrategy, updateGroupStrategy } from '../services/api.js';
import CustomScrollbar from './CustomScrollbar.jsx';
import { useLanguage } from '../contexts/LanguageContext.jsx';

// Composant CheckProperty1On (checkbox avec état on/off)
const CheckProperty1On = ({ property1 = 'off', className = '' }) => {
  const isOn = property1 === 'on';
  
  return (
    <div className={`relative w-5 h-5 shrink-0 ${className}`}>
      {isOn ? (
        <div className="w-5 h-5 bg-global-content-highlight-2nd rounded flex items-center justify-center">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M10 3L4.5 8.5L2 6" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      ) : (
        <div className="w-5 h-5 border border-global-content-highlight-2nd rounded bg-transparent" />
      )}
    </div>
  );
};

// Icônes SVG
const AddIcon = ({ className = '' }) => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className={className}>
    <path d="M10 4V16M4 10H16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const PriceyeIcon = ({ className = '' }) => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className={className}>
    <path d="M10 2L2 7L10 12L18 7L10 2Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M2 13L10 18L18 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M2 10L10 15L18 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

function StrategyModal({ token, onClose, onSave, item, itemType, onGroupStrategyUpdated }) {
  const { t } = useLanguage();
  const [formData, setFormData] = useState({
    strategy: t('strategyModal.balanced'),
    floor_price: '',
    base_price: '',
    ceiling_price: '',
  });
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isAutoEnabled, setIsAutoEnabled] = useState(false);

  // Déterminer le nom à afficher (Propriété ou Groupe)
  const itemName = item?.address || item?.name || t('strategyModal.for');

  useEffect(() => {
    if (item) {
      setFormData({
        strategy: item.strategy || t('strategyModal.balanced'),
        floor_price: item.floor_price != null ? String(item.floor_price) : '',
        base_price: item.base_price != null ? String(item.base_price) : '',
        ceiling_price: item.ceiling_price != null ? String(item.ceiling_price) : '',
      });
    }
  }, [item]);

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    if (!formData.floor_price || !formData.base_price) {
        setError(t('strategyModal.required'));
        setIsLoading(false);
        return;
    }

    try {
      const strategyData = {
        strategy: formData.strategy,
        floor_price: parseInt(formData.floor_price, 10),
        base_price: parseInt(formData.base_price, 10),
        ceiling_price: formData.ceiling_price ? parseInt(formData.ceiling_price, 10) : null,
      };

      // Appeler la bonne API en fonction du type (propriété ou groupe)
      if (itemType === 'group') {
        await updateGroupStrategy(item.id, strategyData, token);
        // Appeler le callback pour mettre à jour immédiatement le groupe
        if (onGroupStrategyUpdated) {
          await onGroupStrategyUpdated({ ...item, ...strategyData });
        }
      } else {
        await updatePropertyStrategy(item.id, strategyData, token);
      }

      // Fermer le modal et déclencher le rafraîchissement
      onClose();
      // Appeler onSave après un petit délai pour laisser le modal se fermer
      setTimeout(() => {
        onSave();
      }, 100);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-90 flex items-center justify-center p-4 z-50">
      <div className="bg-global-bg-box rounded-[14px] border border-solid border-global-stroke-box p-6 flex flex-col gap-3 items-start justify-start w-full max-w-lg relative max-h-[90vh]">
        {/* Titre */}
        <div className="text-global-blanc text-left font-h2-font-family text-h2-font-size font-h2-font-weight relative shrink-0">
          {t('strategyModal.title')}
        </div>

        {/* Description */}
        <div className="text-global-inactive text-left font-h4-font-family text-h4-font-size leading-h4-line-height font-h4-font-weight relative self-stretch shrink-0">
          {t('strategyModal.description')}
        </div>

        {/* Toggle Automatiser le pricing */}
        <div 
          className="bg-global-stroke-highlight-2nd rounded-[10px] border border-solid border-global-content-highlight-2nd pt-2 pr-3 pb-2 pl-3 flex flex-row gap-3 items-center justify-center self-stretch shrink-0 h-[46px] relative cursor-pointer hover:opacity-90 transition-opacity"
          onClick={() => setIsAutoEnabled(!isAutoEnabled)}
        >
          <CheckProperty1On property1={isAutoEnabled ? 'on' : 'off'} className="!shrink-0" />
          <div className="text-global-blanc text-left font-h3-font-family text-h3-font-size font-h3-font-weight relative">
            {t('strategyModal.automate')}
          </div>
        </div>

        {/* Formulaire avec scrollbar personnalisée */}
        <CustomScrollbar className="self-stretch flex-1 min-h-0">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4 pr-2">
          <div>
            <label htmlFor="strategy" className="block text-sm font-medium text-global-inactive mb-1">{t('strategyModal.strategy')}</label>
            <select 
              name="strategy" 
              value={formData.strategy} 
              onChange={handleChange} 
              className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc rounded-[10px] px-3 py-2 focus:outline-none focus:border-global-content-highlight-2nd"
            >
              <option value="Prudent">{t('strategyModal.prudent')}</option>
              <option value="Équilibré">{t('strategyModal.balanced')}</option>
              <option value="Agressif">{t('strategyModal.aggressive')}</option>
            </select>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label htmlFor="floor_price" className="block text-sm font-medium text-global-inactive mb-1">{t('strategyModal.floorPrice')}</label>
              <input 
                name="floor_price" 
                type="number" 
                placeholder="Ex: 80" 
                value={formData.floor_price} 
                onChange={handleChange} 
                className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc rounded-[10px] px-3 py-2 focus:outline-none focus:border-global-content-highlight-2nd placeholder:text-global-inactive" 
                required 
              />
            </div>
            <div>
              <label htmlFor="base_price" className="block text-sm font-medium text-global-inactive mb-1">{t('strategyModal.basePrice')}</label>
              <input 
                name="base_price" 
                type="number" 
                placeholder="Ex: 120" 
                value={formData.base_price} 
                onChange={handleChange} 
                className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc rounded-[10px] px-3 py-2 focus:outline-none focus:border-global-content-highlight-2nd placeholder:text-global-inactive" 
                required 
              />
            </div>
            <div>
              <label htmlFor="ceiling_price" className="block text-sm font-medium text-global-inactive mb-1">{t('strategyModal.ceilingPrice')}</label>
              <input 
                name="ceiling_price" 
                type="number" 
                placeholder={t('strategyModal.optional')} 
                value={formData.ceiling_price} 
                onChange={handleChange} 
                className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc rounded-[10px] px-3 py-2 focus:outline-none focus:border-global-content-highlight-2nd placeholder:text-global-inactive" 
              />
            </div>
          </div>
          
          {error && (
            <div className="p-3 bg-red-900/40 border border-red-500/40 rounded-lg">
              <p className="text-sm text-red-300">{error}</p>
            </div>
          )}
          
          {/* Boutons d'action */}
          <div className="flex flex-row gap-3 items-start justify-start self-stretch shrink-0 relative">
            <button 
              type="button" 
              onClick={onClose}
              className="inline-flex items-center justify-center gap-2 px-3 py-2 border border-solid border-global-stroke-highlight-2nd rounded-[10px] bg-transparent text-global-blanc font-h3-font-family text-h3-font-size font-h3-font-weight hover:opacity-90 transition-opacity shrink-0"
            >
              <AddIcon className="w-5 h-5" />
              <span>{t('strategyModal.cancel')}</span>
            </button>
            <button 
              type="submit" 
              disabled={isLoading}
              className="inline-flex items-center justify-center gap-2 px-3 py-2 flex-1 rounded-[10px] bg-gradient-to-r from-[#155dfc] to-[#12a1d5] text-global-blanc font-h3-font-family text-h3-font-size font-h3-font-weight hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? t('common.saving') : t('strategyModal.save')}
            </button>
          </div>
          </form>
        </CustomScrollbar>
      </div>
    </div>
  );
}

export default StrategyModal;

