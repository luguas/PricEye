import React, { useState, useEffect } from 'react';
import { updatePropertyRules } from '../services/api';

function RulesModal({ token, onClose, onSave, property }) {
  const [formData, setFormData] = useState({
    min_stay: '',
    max_stay: '',
    weekly_discount_percent: '',
    monthly_discount_percent: '',
    weekend_markup_percent: '',
  });
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (property) {
      setFormData({
        min_stay: property.min_stay != null ? property.min_stay : '',
        max_stay: property.max_stay != null ? property.max_stay : '',
        weekly_discount_percent: property.weekly_discount_percent != null ? property.weekly_discount_percent : '',
        monthly_discount_percent: property.monthly_discount_percent != null ? property.monthly_discount_percent : '',
        weekend_markup_percent: property.weekend_markup_percent != null ? property.weekend_markup_percent : '',
      });
    }
  }, [property]);

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      // Préparer les données pour l'API, en convertissant en nombres ou null
      const rulesData = {
        min_stay: formData.min_stay !== '' ? parseInt(formData.min_stay, 10) : null,
        max_stay: formData.max_stay !== '' ? parseInt(formData.max_stay, 10) : null,
        weekly_discount_percent: formData.weekly_discount_percent !== '' ? parseInt(formData.weekly_discount_percent, 10) : null,
        monthly_discount_percent: formData.monthly_discount_percent !== '' ? parseInt(formData.monthly_discount_percent, 10) : null,
        weekend_markup_percent: formData.weekend_markup_percent !== '' ? parseInt(formData.weekend_markup_percent, 10) : null,
      };

      await updatePropertyRules(property.id, rulesData, token);
      onSave();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center p-4 z-50">
      <div className="bg-gray-800 rounded-lg shadow-xl w-full max-w-2xl p-6"> {/* Larger modal */}
        <h3 className="text-xl font-bold mb-2">Définir les Règles Personnalisées</h3>
        <p className="text-sm text-gray-400 mb-6">Pour {property.address}</p>
        
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Stay Rules */}
          <fieldset className="border border-gray-700 p-4 rounded-md">
            <legend className="text-lg font-semibold px-2">Durée de Séjour</legend>
            <div className="grid grid-cols-2 gap-4 mt-2">
              <div>
                <label htmlFor="min_stay" className="block text-sm font-medium text-gray-300">Minimum (nuits)</label>
                <input name="min_stay" type="number" placeholder="Ex: 2" value={formData.min_stay} onChange={handleChange} className="w-full bg-gray-700 p-2 rounded-md mt-1" min="0" />
              </div>
              <div>
                <label htmlFor="max_stay" className="block text-sm font-medium text-gray-300">Maximum (nuits)</label>
                <input name="max_stay" type="number" placeholder="Ex: 90" value={formData.max_stay} onChange={handleChange} className="w-full bg-gray-700 p-2 rounded-md mt-1" min="0" />
              </div>
            </div>
          </fieldset>

          {/* Discount Rules */}
          <fieldset className="border border-gray-700 p-4 rounded-md">
            <legend className="text-lg font-semibold px-2">Réductions Longue Durée</legend>
            <div className="grid grid-cols-2 gap-4 mt-2">
              <div>
                <label htmlFor="weekly_discount_percent" className="block text-sm font-medium text-gray-300">Hebdomadaire (%)</label>
                <input name="weekly_discount_percent" type="number" placeholder="Ex: 10" value={formData.weekly_discount_percent} onChange={handleChange} className="w-full bg-gray-700 p-2 rounded-md mt-1" min="0" max="100" />
              </div>
              <div>
                <label htmlFor="monthly_discount_percent" className="block text-sm font-medium text-gray-300">Mensuelle (%)</label>
                <input name="monthly_discount_percent" type="number" placeholder="Ex: 20" value={formData.monthly_discount_percent} onChange={handleChange} className="w-full bg-gray-700 p-2 rounded-md mt-1" min="0" max="100" />
              </div>
            </div>
          </fieldset>
          
          {/* Markup Rules */}
           <fieldset className="border border-gray-700 p-4 rounded-md">
            <legend className="text-lg font-semibold px-2">Majorations</legend>
             <div>
                <label htmlFor="weekend_markup_percent" className="block text-sm font-medium text-gray-300">Week-end (%)</label>
                <input name="weekend_markup_percent" type="number" placeholder="Ex: 15" value={formData.weekend_markup_percent} onChange={handleChange} className="w-full bg-gray-700 p-2 rounded-md mt-1" min="0"/>
                 <p className="text-xs text-gray-500 mt-1">Majoration appliquée aux nuits du Vendredi et Samedi.</p>
              </div>
          </fieldset>

          {/* Error and Buttons */}
          {error && <p className="text-sm text-red-400 bg-red-900/50 p-3 rounded-md">{error}</p>}
          
          <div className="flex justify-end gap-4 pt-4">
            <button type="button" onClick={onClose} className="px-4 py-2 font-semibold text-gray-300 bg-gray-600 rounded-md hover:bg-gray-500">
              Annuler
            </button>
            <button type="submit" disabled={isLoading} className="px-4 py-2 font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:bg-gray-500">
              {isLoading ? 'Sauvegarde...' : 'Sauvegarder les Règles'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default RulesModal;
