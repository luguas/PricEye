import React, { useState, useEffect } from 'react';
import { addProperty, updateProperty } from '../services/api.js';

// Liste des équipements disponibles
const availableAmenities = [
  "wifi", "piscine", "parking gratuit", "climatisation", "jacuzzi",
  "salle de sport", "animaux acceptés", "lave-linge", "cuisine équipée",
  "télévision", "cheminée", "espace de travail", "vue sur mer"
];

function PropertyModal({ token, onClose, onSave, property }) {
  const [formData, setFormData] = useState({
    address: '',
    location: '',
    surface: '',
    capacity: '',
    daily_revenue: '',
    occupancy: '',
    min_stay: '',
    amenities: [], // Initialiser comme un tableau vide
  });
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const isEditing = !!property; 

  useEffect(() => {
    if (isEditing) {
      setFormData({
        address: property.address || '',
        location: property.location || '',
        surface: property.surface || '',
        capacity: property.capacity || '',
        daily_revenue: property.daily_revenue || '',
        occupancy: (property.occupancy || 0) * 100, 
        min_stay: property.min_stay || '',
        amenities: property.amenities || [], // Charger les équipements existants
      });
    } else {
       // Réinitialiser pour le mode "Ajouter"
       setFormData({
            address: '', location: '', surface: '', capacity: '',
            daily_revenue: '100', occupancy: '75', min_stay: '2',
            amenities: [],
       });
    }
  }, [property, isEditing]);

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  // Gérer les changements sur les checkboxes d'équipements
  const handleAmenityChange = (e) => {
      const { value, checked } = e.target;
      setFormData(prevData => {
          const currentAmenities = prevData.amenities || [];
          if (checked) {
              // Ajouter l'équipement s'il n'est pas déjà présent
              if (!currentAmenities.includes(value)) {
                  return { ...prevData, amenities: [...currentAmenities, value] };
              }
          } else {
              // Retirer l'équipement
              return { ...prevData, amenities: currentAmenities.filter(item => item !== value) };
          }
          return prevData; // Retourner l'état précédent si pas de changement
      });
  };


  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);
    try {
      const propertyData = {
        address: formData.address,
        location: formData.location,
        surface: parseInt(formData.surface, 10) || 0,
        capacity: parseInt(formData.capacity, 10) || 0,
        daily_revenue: parseInt(formData.daily_revenue, 10) || 100,
        occupancy: parseFloat(formData.occupancy) / 100 || 0.7, 
        min_stay: parseInt(formData.min_stay, 10) || 1, 
        amenities: formData.amenities, // Inclure le tableau des équipements
      };

      if (isEditing) {
        // Exclure les champs non modifiables lors de la mise à jour
        const { id, ownerId, teamId, ...existingData } = property;
        await updateProperty(property.id, { ...existingData, ...propertyData }, token);
      } else {
        await addProperty(propertyData, token);
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
    <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center p-4 z-50">
        <div className="bg-gray-800 rounded-lg shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
            <h3 className="text-xl font-bold mb-6">{isEditing ? 'Modifier la propriété' : 'Ajouter une nouvelle propriété'}</h3>
            <form onSubmit={handleSubmit} className="space-y-4">
                <input name="address" type="text" placeholder="Adresse" value={formData.address} onChange={handleChange} className="w-full bg-gray-700 p-2 rounded-md" required />
                <input name="location" type="text" placeholder="Ville, Pays" value={formData.location} onChange={handleChange} className="w-full bg-gray-700 p-2 rounded-md" required />
                <div className="grid grid-cols-2 gap-4">
                    <input name="surface" type="number" placeholder="Surface (m²)" value={formData.surface} onChange={handleChange} className="w-full bg-gray-700 p-2 rounded-md" required />
                    <input name="capacity" type="number" placeholder="Capacité d'accueil" value={formData.capacity} onChange={handleChange} className="w-full bg-gray-700 p-2 rounded-md" required />
                </div>
                 <div className="grid grid-cols-3 gap-4">
                     <input name="daily_revenue" type="number" placeholder="Prix/nuit défaut (€)" value={formData.daily_revenue} onChange={handleChange} className="w-full bg-gray-700 p-2 rounded-md" required />
                     <input name="occupancy" type="number" placeholder="Occup. % (ex: 80)" value={formData.occupancy} onChange={handleChange} className="w-full bg-gray-700 p-2 rounded-md" required />
                     <input name="min_stay" type="number" placeholder="Séjour min. (nuits)" value={formData.min_stay} onChange={handleChange} className="w-full bg-gray-700 p-2 rounded-md" required />
                 </div>
                
                {/* Section des Équipements */}
                <fieldset className="border border-gray-700 p-4 rounded-md">
                  <legend className="text-lg font-semibold px-2">Équipements</legend>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mt-2">
                    {availableAmenities.map(amenity => (
                      <label key={amenity} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          name="amenities"
                          value={amenity}
                          checked={formData.amenities.includes(amenity)}
                          onChange={handleAmenityChange}
                        />
                        {amenity.charAt(0).toUpperCase() + amenity.slice(1)}
                      </label>
                    ))}
                  </div>
                </fieldset>
                
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

