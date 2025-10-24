import React, { useState, useEffect } from 'react';
import { addProperty, updateProperty } from '../services/api';

// This modal is used for both adding a new property and editing an existing one.
function PropertyModal({ token, onClose, onSave, property }) {
  const [formData, setFormData] = useState({
    address: '',
    location: '',
    surface: '',
    capacity: '',
  });
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const isEditing = !!property; // Check if we are in edit mode

  useEffect(() => {
    if (isEditing) {
      // If editing, populate the form with the property's data
      setFormData({
        address: property.address || '',
        location: property.location || '',
        surface: property.surface || '',
        capacity: property.capacity || '',
      });
    }
  }, [property, isEditing]);

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);
    try {
      const propertyData = {
        ...formData,
        surface: parseInt(formData.surface, 10) || 0,
        capacity: parseInt(formData.capacity, 10) || 0,
      };

      if (isEditing) {
        await updateProperty(property.id, propertyData, token);
      } else {
        await addProperty(propertyData, token);
      }

      onSave(); // Trigger a refresh on the dashboard
      onClose(); // Close the modal
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center p-4 z-50">
        <div className="bg-gray-800 rounded-lg shadow-xl w-full max-w-lg p-6">
            <h3 className="text-xl font-bold mb-6">{isEditing ? 'Modifier la propriété' : 'Ajouter une nouvelle propriété'}</h3>
            <form onSubmit={handleSubmit} className="space-y-4">
                <input name="address" type="text" placeholder="Adresse" value={formData.address} onChange={handleChange} className="w-full bg-gray-700 p-2 rounded-md" required />
                <input name="location" type="text" placeholder="Ville, Pays" value={formData.location} onChange={handleChange} className="w-full bg-gray-700 p-2 rounded-md" required />
                <input name="surface" type="number" placeholder="Surface (m²)" value={formData.surface} onChange={handleChange} className="w-full bg-gray-700 p-2 rounded-md" required />
                <input name="capacity" type="number" placeholder="Capacité d'accueil" value={formData.capacity} onChange={handleChange} className="w-full bg-gray-700 p-2 rounded-md" required />
                
                {error && <p className="text-sm text-red-400 bg-red-900/50 p-3 rounded-md">{error}</p>}
                
                <div className="flex justify-end gap-4 pt-4">
                    <button type="button" onClick={onClose} className="px-4 py-2 font-semibold text-gray-300 bg-gray-600 rounded-md hover:bg-gray-500">
                        Annuler
                    </button>
                    <button type="submit" disabled={isLoading} className="px-4 py-2 font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:bg-gray-500">
                        {isLoading ? 'Sauvegarde...' : 'Sauvegarder'}
                    </button>
                </div>
            </form>
        </div>
    </div>
  );
}

export default PropertyModal;

