import React, { useState, useEffect } from 'react';
import { updatePropertyRules, updateGroupRules } from '../services/api.js';
import CustomScrollbar from './CustomScrollbar.jsx';
import { useLanguage } from '../contexts/LanguageContext.jsx';

function RulesModal({ token, onClose, onSave, item, itemType }) {
  const { t } = useLanguage();
  const [formData, setFormData] = useState({
    min_stay: '',
    max_stay: '',
    weekly_discount_percent: '',
    monthly_discount_percent: '',
    weekend_markup_percent: '',
  });
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // Déterminer le nom à afficher (Propriété ou Groupe)
  const itemName = item?.address || item?.name || t('rulesModal.for');

  useEffect(() => {
    if (item) {
      setFormData({
        min_stay: item.min_stay != null ? item.min_stay : '',
        max_stay: item.max_stay != null ? item.max_stay : '',
        weekly_discount_percent: item.weekly_discount_percent != null ? item.weekly_discount_percent : '',
        monthly_discount_percent: item.monthly_discount_percent != null ? item.monthly_discount_percent : '',
        weekend_markup_percent: item.weekend_markup_percent != null ? item.weekend_markup_percent : '',
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

    try {
      const rulesData = {
        min_stay: formData.min_stay !== '' ? parseInt(formData.min_stay, 10) : null,
        max_stay: formData.max_stay !== '' ? parseInt(formData.max_stay, 10) : null,
        weekly_discount_percent: formData.weekly_discount_percent !== '' ? parseInt(formData.weekly_discount_percent, 10) : null,
        monthly_discount_percent: formData.monthly_discount_percent !== '' ? parseInt(formData.monthly_discount_percent, 10) : null,
        weekend_markup_percent: formData.weekend_markup_percent !== '' ? parseInt(formData.weekend_markup_percent, 10) : null,
      };

      // Appeler la bonne API en fonction du type
      if (itemType === 'group') {
          await updateGroupRules(item.id, rulesData, token);
      } else {
          await updatePropertyRules(item.id, rulesData, token);
      }

      onSave();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-90 flex items-center justify-center p-4 z-50">
      <div className="bg-bg-secondary rounded-lg shadow-xl w-full max-w-2xl p-6 flex flex-col max-h-[90vh]"> 
        <h3 className="text-xl font-bold mb-2 text-text-primary shrink-0">{t('rulesModal.title')}</h3>
        <p className="text-sm text-text-muted mb-6 shrink-0">{t('rulesModal.for')}: {itemName}</p>
        
        <CustomScrollbar className="flex-1 min-h-0">
          <form onSubmit={handleSubmit} className="space-y-6 pr-2">
          <fieldset className="border border-border-secondary p-4 rounded-md">
            <legend className="text-lg font-semibold px-2 text-text-primary">{t('rulesModal.stayDuration')}</legend>
            <div className="grid grid-cols-2 gap-4 mt-2">
              <div>
                <label htmlFor="min_stay" className="block text-sm font-medium text-text-secondary">{t('rulesModal.minStay')}</label>
                <input name="min_stay" type="number" placeholder="Ex: 2" value={formData.min_stay} onChange={handleChange} className="w-full form-input mt-1" min="0" />
              </div>
              <div>
                <label htmlFor="max_stay" className="block text-sm font-medium text-text-secondary">{t('rulesModal.maxStay')}</label>
                <input name="max_stay" type="number" placeholder="Ex: 90" value={formData.max_stay} onChange={handleChange} className="w-full form-input mt-1" min="0" />
              </div>
            </div>
          </fieldset>

          <fieldset className="border border-border-secondary p-4 rounded-md">
            <legend className="text-lg font-semibold px-2 text-text-primary">{t('rulesModal.longTermDiscounts')}</legend>
            <div className="grid grid-cols-2 gap-4 mt-2">
              <div>
                <label htmlFor="weekly_discount_percent" className="block text-sm font-medium text-text-secondary">{t('rulesModal.weeklyDiscount')}</label>
                <input name="weekly_discount_percent" type="number" placeholder="Ex: 10" value={formData.weekly_discount_percent} onChange={handleChange} className="w-full form-input mt-1" min="0" max="100" />
              </div>
              <div>
                <label htmlFor="monthly_discount_percent" className="block text-sm font-medium text-text-secondary">{t('rulesModal.monthlyDiscount')}</label>
                <input name="monthly_discount_percent" type="number" placeholder="Ex: 20" value={formData.monthly_discount_percent} onChange={handleChange} className="w-full form-input mt-1" min="0" max="100" />
              </div>
            </div>
          </fieldset>
          
           <fieldset className="border border-border-secondary p-4 rounded-md">
            <legend className="text-lg font-semibold px-2 text-text-primary">{t('rulesModal.markups')}</legend>
             <div>
                <label htmlFor="weekend_markup_percent" className="block text-sm font-medium text-text-secondary">{t('rulesModal.weekendMarkup')}</label>
                <input name="weekend_markup_percent" type="number" placeholder="Ex: 15" value={formData.weekend_markup_percent} onChange={handleChange} className="w-full form-input mt-1" min="0"/>
                 <p className="text-xs text-text-muted mt-1">{t('rulesModal.weekendMarkupNote')}</p>
              </div>
          </fieldset>

          {error && <p className="text-sm text-red-400 bg-red-900/50 p-3 rounded-md">{error}</p>}
          
          <div className="flex justify-end gap-4 pt-4">
            <button type="button" onClick={onClose} className="px-4 py-2 font-semibold text-text-secondary bg-bg-muted rounded-md hover:bg-border-primary">
              {t('rulesModal.cancel')}
            </button>
            <button type="submit" disabled={isLoading} className="px-4 py-2 font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:bg-gray-500">
              {isLoading ? t('common.saving') : t('rulesModal.save')}
            </button>
          </div>
          </form>
        </CustomScrollbar>
      </div>
    </div>
  );
}

export default RulesModal;

