import React, { useState, useEffect } from 'react';
import { updatePropertyStrategy } from '../services/api';

function StrategyModal({ token, onClose, onSave, property }) {
  const [formData, setFormData] = useState({
    strategy: 'Équilibré',
    floor_price: '',
    base_price: '',
    ceiling_price: '',
  });
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (property) {
      setFormData({
        strategy: property.strategy || 'Équilibré',
        floor_price: property.floor_price || '',
        base_price: property.base_price || '',
        ceiling_price: property.ceiling_price || '',
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

    // Valider que le prix plancher est obligatoire
    if (!formData.floor_price || !formData.base_price) {
        setError('Le prix plancher et le prix de base sont obligatoires.');
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

      await updatePropertyStrategy(property.id, strategyData, token);
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
      <div className="bg-gray-800 rounded-lg shadow-xl w-full max-w-lg p-6">
        <h3 className="text-xl font-bold mb-2">Définir la Stratégie IA</h3>
        <p className="text-sm text-gray-400 mb-6">Pour {property.address}</p>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="strategy" className="block text-sm font-medium text-gray-300">Style de l'IA</label>
            <select name="strategy" value={formData.strategy} onChange={handleChange} className="w-full bg-gray-700 p-2 rounded-md mt-1">
              <option value="Prudent">Prudent (maximiser l'occupation)</option>
              <option value="Équilibré">Équilibré (défaut)</option>
              <option value="Agressif">Agressif (maximiser le revenu/nuit)</option>
            </select>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label htmlFor="floor_price" className="block text-sm font-medium text-gray-300">Prix Plancher (€)</label>
              <input name="floor_price" type="number" placeholder="Ex: 80" value={formData.floor_price} onChange={handleChange} className="w-full bg-gray-700 p-2 rounded-md mt-1" required />
            </div>
            <div>
              <label htmlFor="base_price" className="block text-sm font-medium text-gray-300">Prix de Base (€)</label>
              <input name="base_price" type="number" placeholder="Ex: 120" value={formData.base_price} onChange={handleChange} className="w-full bg-gray-700 p-2 rounded-md mt-1" required />
            </div>
            <div>
              <label htmlFor="ceiling_price" className="block text-sm font-medium text-gray-300">Prix Plafond (€)</label>
              <input name="ceiling_price" type="number" placeholder="Optionnel" value={formData.ceiling_price} onChange={handleChange} className="w-full bg-gray-700 p-2 rounded-md mt-1" />
            </div>
          </div>
          
          {error && <p className="text-sm text-red-400 bg-red-900/50 p-3 rounded-md">{error}</p>}
          
          <div className="flex justify-end gap-4 pt-4">
            <button type="button" onClick={onClose} className="px-4 py-2 font-semibold text-gray-300 bg-gray-600 rounded-md hover:bg-gray-500">
              Annuler
            </button>
            <button type="submit" disabled={isLoading} className="px-4 py-2 font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:bg-gray-500">
              {isLoading ? 'Sauvegarde...' : 'Sauvegarder la Stratégie'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default StrategyModal;
