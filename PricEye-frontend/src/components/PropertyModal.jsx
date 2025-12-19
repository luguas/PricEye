import React, { useState, useEffect } from 'react';
import { addProperty, updateProperty, syncPropertyData } from '../services/api.js';
import CustomScrollbar from './CustomScrollbar.jsx';
import { useLanguage } from '../contexts/LanguageContext.jsx';

// Liste des équipements disponibles
const availableAmenities = [
  "wifi", "piscine", "parking gratuit", "climatisation", "jacuzzi",
  "salle de sport", "animaux acceptés", "lave-linge", "cuisine équipée",
  "télévision", "cheminée", "espace de travail", "vue sur mer"
];

function PropertyModal({ token, onClose, onSave, property }) {
  const { t } = useLanguage();
  const [formData, setFormData] = useState({
    name: '',
    address: '',
    location: '',
    description: '',
    surface: '',
    capacity: '',
    daily_revenue: '',
    property_type: 'villa',
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
        name: property.name || '',
        address: property.address || '',
        location: property.location || '',
        description: property.description || '',
        surface: property.surface || '',
        capacity: property.capacity || '',
        daily_revenue: property.daily_revenue || '',
        property_type: property.property_type || property.type || 'villa',
        min_stay: property.min_stay || '',
        amenities: property.amenities || [], 
      });
    } else {
       setFormData({
            name: '', address: '', location: '', description: '', surface: '', capacity: '',
            daily_revenue: '100', property_type: 'villa', min_stay: '2',
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
        name: formData.name || formData.address,
        address: formData.address,
        location: formData.location,
        description: formData.description || '',
        surface: parseInt(formData.surface, 10) || 0,
        capacity: parseInt(formData.capacity, 10) || 0,
        daily_revenue: parseInt(formData.daily_revenue, 10) || 100,
        property_type: formData.property_type,
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
      // Vérifier si c'est une erreur de limite
      const errorMessage = err.message || '';
      
      if (errorMessage.includes('LIMIT_EXCEEDED')) {
        // Afficher la modale de limite via la fonction globale
        if (window.showLimitExceededModal) {
          // Extraire les données de l'erreur si disponibles
          try {
            const errorData = JSON.parse(errorMessage.split('LIMIT_EXCEEDED')[1] || '{}');
            window.showLimitExceededModal({
              currentCount: errorData.currentCount || 10,
              maxAllowed: errorData.maxAllowed || 10,
            });
          } catch {
            window.showLimitExceededModal({
              currentCount: 10,
              maxAllowed: 10,
            });
          }
        } else {
          // Fallback si la fonction n'est pas disponible
          setError('Vous avez atteint la limite de 10 propriétés pendant votre essai gratuit. Veuillez terminer votre essai pour continuer.');
        }
      } else {
        setError(errorMessage || 'Une erreur est survenue lors de l\'ajout de la propriété.');
      }
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
          setSyncMessage(result.message || t('propertyModal.syncSuccess'));
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
    <div className="fixed inset-0 bg-black bg-opacity-90 flex items-center justify-center p-4 z-50">
        <div className="bg-global-bg-box border border-global-stroke-box rounded-[14px] shadow-xl w-full max-w-4xl p-6 max-h-[90vh] flex flex-col">
            <h3 className="text-xl font-bold mb-6 text-global-blanc shrink-0">{isEditing ? t('propertyModal.editTitle') : t('propertyModal.title')}</h3>
            
            {/* Bouton de Synchronisation (uniquement en mode édition) */}
            {isEditing && (
              <div className="border-b border-global-stroke-box pb-4 mb-4 shrink-0">
                <button
                    type="button"
                    onClick={handleSyncData}
                    disabled={isSyncing}
                    className="w-full flex justify-center items-center gap-2 px-4 py-2 font-semibold text-white bg-teal-600 rounded-[8px] hover:bg-teal-700 disabled:bg-gray-500 transition-colors"
                >
                    {isSyncing ? (
                        <>
                            <div className="loader-small"></div>
                            {t('common.loading')}
                        </>
                    ) : (
                        t('propertyModal.sync')
                    )}
                </button>
                {syncMessage && <p className="text-sm text-green-400 mt-2 text-center">{syncMessage}</p>}
              </div>
            )}

            <CustomScrollbar className="flex-1 min-h-0">
              <form onSubmit={handleSubmit} className="space-y-4 pr-2">
                <div>
                  <label htmlFor="name" className="block text-sm font-medium text-global-inactive">{t('propertyModal.name')}</label>
                  <input name="name" id="name" type="text" placeholder={t('propertyModal.name')} value={formData.name} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" />
                </div>
                <div>
                  <label htmlFor="address" className="block text-sm font-medium text-global-inactive">{t('propertyModal.address')}</label>
                  <input name="address" id="address" type="text" placeholder={t('propertyModal.address')} value={formData.address} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" required />
                </div>
                <div>
                  <label htmlFor="location" className="block text-sm font-medium text-global-inactive">{t('propertyModal.location')}</label>
                  <input name="location" id="location" type="text" placeholder={t('propertyModal.location')} value={formData.location} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" required />
                </div>
                <div>
                  <label htmlFor="description" className="block text-sm font-medium text-global-inactive">{t('propertyModal.description')}</label>
                  <textarea name="description" id="description" rows="4" placeholder={t('propertyModal.description')} value={formData.description} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors resize-none" />
                </div>
                <div>
                  <label htmlFor="property_type" className="block text-sm font-medium text-global-inactive">{t('propertyModal.propertyType')}</label>
                  <select name="property_type" id="property_type" value={formData.property_type} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors [&>option]:bg-global-bg-box [&>option]:text-global-blanc">
                    <option value="appartement">Appartement</option>
                    <option value="villa">Villa</option>
                    <option value="studio">Studio</option>
                    <option value="loft">Loft</option>
                    <option value="maison">Maison</option>
                  </select>
                </div>
                
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label htmlFor="surface" className="block text-sm font-medium text-global-inactive">{t('propertyModal.surface')}</label>
                        <input name="surface" id="surface" type="number" placeholder={t('propertyModal.surface')} value={formData.surface} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" required />
                    </div>
                    <div>
                        <label htmlFor="capacity" className="block text-sm font-medium text-global-inactive">{t('propertyModal.capacity')}</label>
                        <input name="capacity" id="capacity" type="number" placeholder={t('propertyModal.capacity')} value={formData.capacity} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" required />
                    </div>
                </div>
                 <div className="grid grid-cols-2 gap-4">
                     <div>
                        <label htmlFor="daily_revenue" className="block text-sm font-medium text-global-inactive">{t('propertyModal.dailyRevenue')}</label>
                        <input name="daily_revenue" id="daily_revenue" type="number" placeholder={t('propertyModal.dailyRevenue')} value={formData.daily_revenue} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" required />
                    </div>
                     <div>
                        <label htmlFor="min_stay" className="block text-sm font-medium text-global-inactive">{t('propertyModal.minStay')}</label>
                        <input name="min_stay" id="min_stay" type="number" placeholder={t('propertyModal.minStay')} value={formData.min_stay} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" required />
                    </div>
                 </div>
                
                <fieldset className="border border-global-stroke-box p-4 rounded-[8px]">
                  <legend className="text-lg font-semibold px-2 text-global-blanc">{t('propertyModal.amenities')}</legend>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mt-2 max-h-48 overflow-y-auto">
                    {availableAmenities.map(amenity => (
                      <label key={amenity} className="flex items-center gap-2 text-sm text-global-inactive cursor-pointer hover:text-global-blanc transition-colors">
                        <input
                          type="checkbox"
                          name="amenities"
                          value={amenity}
                          checked={formData.amenities.includes(amenity)}
                          onChange={handleAmenityChange}
                          className="cursor-pointer"
                        />
                        {amenity.charAt(0).toUpperCase() + amenity.slice(1)}
                      </label>
                    ))}
                  </div>
                </fieldset>
                
                {error && <p className="text-sm text-red-400 bg-red-900/50 p-3 rounded-[8px] border border-red-500/20">{error}</p>}
                
                <div className="flex justify-end gap-4 pt-4">
                    <button type="button" onClick={onClose} className="px-4 py-2 font-semibold text-global-inactive bg-global-bg-small-box border border-global-stroke-box rounded-[8px] hover:border-global-content-highlight-2nd hover:text-global-blanc transition-colors">
                        {t('propertyModal.cancel')}
                    </button>
                    <button type="submit" disabled={isLoading || isSyncing} className="px-4 py-2 font-semibold text-white bg-gradient-to-r from-[#155dfc] to-[#12a1d5] rounded-[8px] hover:opacity-90 disabled:bg-gray-500 disabled:opacity-50 transition-opacity">
                        {isLoading ? t('common.saving') : t('propertyModal.save')}
                    </button>
                </div>
              </form>
            </CustomScrollbar>
        </div>
    </div>
  );
}

export default PropertyModal;


