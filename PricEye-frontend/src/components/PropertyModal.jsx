import React, { useState, useEffect } from 'react';
import { addProperty, updateProperty, syncPropertyData } from '../services/api.js';

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
    amenities: [], 
  });
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false); // Pour la sauvegarde
  const [isSyncing, setIsSyncing] = useState(false); // Pour le bouton Sync
  const [syncMessage, setSyncMessage] = useState(''); // "Toast" pour le sync

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
        amenities: property.amenities || [], 
      });
    } else {
       setFormData({
            address: '', location: '', surface: '', capacity: '',
            daily_revenue: '100', occupancy: '75', min_stay: '2',
            amenities: [],
       });
    }
    // Réinitialiser les messages à chaque ouverture
    setError('');
    setSyncMessage('');
  }, [property, isEditing]);

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleAmenityChange = (e) => {
      const { value, checked } = e.target;
      setFormData(prevData => {
          const currentAmenities = prevData.amenities || [];
          if (checked) {
              if (!currentAmenities.includes(value)) {
                  return { ...prevData, amenities: [...currentAmenities, value] };
              }
          } else {
              return { ...prevData, amenities: currentAmenities.filter(item => item !== value) };
          }
          return prevData; 
      });
  };


  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSyncMessage('');
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
        amenities: formData.amenities, 
      };

      if (isEditing) {
        await updateProperty(property.id, propertyData, token);
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

  // NOUVELLE FONCTION: Handler pour le bouton "Synchroniser"
  const handleSyncData = async () => {
      if (!property) return;

      setIsSyncing(true);
      setSyncMessage('');
      setError('');
      try {
          // Appelle la nouvelle fonction de l'API
          const result = await syncPropertyData(property.id, token);
          setSyncMessage(result.message || 'Données synchronisées avec succès !');
          onSave(); // Force un rafraîchissement des données du dashboard
      } catch (err) {
          setError(err.message); // Affiche l'erreur dans le toast d'erreur principal
      } finally {
          setIsSyncing(false);
          // Effacer le message de succès après 3 secondes
          setTimeout(() => setSyncMessage(''), 3000);
      }
  };


  return (
    <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center p-4 z-50">
        <div className="bg-bg-secondary rounded-lg shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
            <h3 className="text-xl font-bold mb-6 text-text-primary">{isEditing ? 'Modifier la propriété' : 'Ajouter une nouvelle propriété'}</h3>
            
            {/* Bouton de Synchronisation (uniquement en mode édition) */}
            {isEditing && (
              <div className="border-b border-border-primary pb-4 mb-4">
                <button
                    type="button"
                    onClick={handleSyncData}
                    disabled={isSyncing}
                    className="w-full flex justify-center items-center gap-2 px-4 py-2 font-semibold text-white bg-teal-600 rounded-md hover:bg-teal-700 disabled:bg-gray-500"
                >
                    {isSyncing ? (
                        <>
                            <div className="loader-small"></div>
                            Synchronisation en cours...
                        </>
                    ) : (
                        'Synchroniser les données (ex: iCal/API)'
                    )}
                </button>
                {syncMessage && <p className="text-sm text-green-400 mt-2 text-center">{syncMessage}</p>}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label htmlFor="address" className="block text-sm font-medium text-text-secondary">Adresse</label>
                  <input name="address" id="address" type="text" placeholder="Adresse" value={formData.address} onChange={handleChange} className="w-full bg-bg-muted border-border-primary text-text-primary p-2 rounded-md mt-1" required />
                </div>
                <div>
                  <label htmlFor="location" className="block text-sm font-medium text-text-secondary">Ville, Pays</label>
                  <input name="location" id="location" type="text" placeholder="Ville, Pays" value={formData.location} onChange={handleChange} className="w-full bg-bg-muted border-border-primary text-text-primary p-2 rounded-md mt-1" required />
                </div>
                
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label htmlFor="surface" className="block text-sm font-medium text-text-secondary">Surface (m²)</label>
                        <input name="surface" id="surface" type="number" placeholder="Surface (m²)" value={formData.surface} onChange={handleChange} className="w-full bg-bg-muted border-border-primary text-text-primary p-2 rounded-md mt-1" required />
                    </div>
                    <div>
                        <label htmlFor="capacity" className="block text-sm font-medium text-text-secondary">Capacité</label>
                        <input name="capacity" id="capacity" type="number" placeholder="Capacité d'accueil" value={formData.capacity} onChange={handleChange} className="w-full bg-bg-muted border-border-primary text-text-primary p-2 rounded-md mt-1" required />
                    </div>
                </div>
                 <div className="grid grid-cols-3 gap-4">
                     <div>
                        <label htmlFor="daily_revenue" className="block text-sm font-medium text-text-secondary">Prix/nuit (€)</label>
                        <input name="daily_revenue" id="daily_revenue" type="number" placeholder="Prix/nuit défaut (€)" value={formData.daily_revenue} onChange={handleChange} className="w-full bg-bg-muted border-border-primary text-text-primary p-2 rounded-md mt-1" required />
                    </div>
                     <div>
                        <label htmlFor="occupancy" className="block text-sm font-medium text-text-secondary">Occup. %</label>
                        <input name="occupancy" id="occupancy" type="number" placeholder="Occup. % (ex: 80)" value={formData.occupancy} onChange={handleChange} className="w-full bg-bg-muted border-border-primary text-text-primary p-2 rounded-md mt-1" required />
                    </div>
                     <div>
                        <label htmlFor="min_stay" className="block text-sm font-medium text-text-secondary">Séjour min.</label>
                        <input name="min_stay" id="min_stay" type="number" placeholder="Séjour min. (nuits)" value={formData.min_stay} onChange={handleChange} className="w-full bg-bg-muted border-border-primary text-text-primary p-2 rounded-md mt-1" required />
                    </div>
                 </div>
                
                <fieldset className="border border-border-secondary p-4 rounded-md">
                  <legend className="text-lg font-semibold px-2 text-text-primary">Équipements</legend>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mt-2 max-h-48 overflow-y-auto">
                    {availableAmenities.map(amenity => (
                      <label key={amenity} className="flex items-center gap-2 text-sm text-text-secondary">
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
                    <button type="button" onClick={onClose} className="px-4 py-2 font-semibold text-text-secondary bg-bg-muted rounded-md hover:bg-border-primary">
                        Annuler
                    </button>
                    <button type="submit" disabled={isLoading || isSyncing} className="px-4 py-2 font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:bg-gray-500">
                        {isLoading ? 'Sauvegarde...' : 'Sauvegarder'}
                    </button>
                </div>
            </form>
        </div>
    </div>
  );
}

export default PropertyModal;

