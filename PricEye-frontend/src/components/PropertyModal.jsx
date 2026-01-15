import React, { useState, useEffect } from 'react';
import { addProperty, updateProperty, syncPropertyData } from '../services/api.js';
import { useLanguage } from '../contexts/LanguageContext.jsx';
import TrialLimitModal from './TrialLimitModal.jsx';
import CustomScrollbar from './CustomScrollbar.jsx';

// Liste des équipements disponibles (équipements de base)
const availableAmenities = [
  "wifi", "piscine", "parking gratuit", "climatisation", "jacuzzi",
  "salle de sport", "animaux acceptés", "lave-linge", "cuisine équipée",
  "télévision", "cheminée", "espace de travail", "vue sur mer"
];

// Équipements cuisine
const kitchenAmenities = [
  "four", "micro-ondes", "lave-vaisselle", "réfrigérateur", "congélateur",
  "grille-pain", "cafetière", "bouilloire"
];

// Sécurité et accessibilité
const securityAmenities = [
  "coffre-fort", "interphone", "caméras de sécurité", "alarme", "ascenseur",
  "accès PMR", "lit bébé", "chaise haute"
];

// Types de vue
const viewTypes = [
  "mer", "jardin", "cours", "montagne", "dégagée"
];

// Niveaux sonores
const noiseLevels = [
  "très calme", "calme", "modéré", "animé", "bruyant"
];

function PropertyModal({ token, onClose, onSave, property, initialStep = 1 }) {
  const { t } = useLanguage();
  const [currentStep, setCurrentStep] = useState(initialStep);
  const [formData, setFormData] = useState({
    // Étape 1: Informations de base
    name: '',
    address: '',
    location: '',
    description: '',
    property_type: 'villa',
    // Étape 2: Caractéristiques du logement
    surface: '',
    bedrooms: '',
    bathrooms: '',
    floor: '',
    construction_year: '',
    renovation_year: '',
    view_type: '',
    // Étape 3: Localisation et environnement
    neighborhood: '',
    city_center_distance: '',
    noise_level: '',
    public_transport: '',
    nearby_attractions: '',
    // Étape 4: Equipements (sera géré séparément)
    amenities: [],
    kitchen_amenities: [],
    security_amenities: [],
    // Étape 5: Tarification et conditions
    base_price: '',
    weekend_surcharge: '',
    cleaning_fee: '',
    deposit: '',
    cost_per_night: '',
    min_stay: '',
    max_stay: '',
    check_in_time: '',
    check_out_time: '',
    weekly_discount_percent: '',
    monthly_discount_percent: '',
    weekend_markup_percent: '',
    // Stratégie IA
    strategy: 'Équilibré',
    floor_price: '',
    ceiling_price: '',
    // Étape 6: Politique et règles
    smoking_allowed: false,
    pets_allowed: false,
    events_allowed: false,
    children_welcome: false,
    instant_booking: false,
    license_number: '',
    insurance: '',
    tax_info: '',
    // Champs existants pour compatibilité
    capacity: '',
    daily_revenue: '',
  });
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');
  const [showTrialLimitModal, setShowTrialLimitModal] = useState(false);
  const [trialLimitData, setTrialLimitData] = useState({ currentCount: 0, maxAllowed: 10 });

  const isEditing = !!property; 
  const totalSteps = 6; 

  useEffect(() => {
    if (isEditing && property) {
      setFormData({
        name: property.name || '',
        address: property.address || '',
        location: property.location || '',
        description: property.description || '',
        property_type: property.property_type || property.type || 'villa',
        surface: property.surface || '',
        bedrooms: property.bedrooms || '',
        bathrooms: property.bathrooms || '',
        floor: property.floor || '',
        construction_year: property.construction_year || '',
        renovation_year: property.renovation_year || '',
        view_type: property.view_type || '',
        neighborhood: property.neighborhood || '',
        city_center_distance: property.city_center_distance || '',
        noise_level: property.noise_level || '',
        public_transport: property.public_transport || '',
        nearby_attractions: property.nearby_attractions || '',
        amenities: property.amenities || [],
        kitchen_amenities: property.kitchen_amenities || [],
        security_amenities: property.security_amenities || [],
        base_price: property.base_price || property.daily_revenue || '',
        weekend_surcharge: property.weekend_surcharge || '',
        cleaning_fee: property.cleaning_fee || '',
        deposit: property.deposit || '',
        cost_per_night: property.cost_per_night || property.operating_cost || '',
        min_stay: property.min_stay || '',
        max_stay: property.max_stay || '',
        check_in_time: property.check_in_time || '',
        check_out_time: property.check_out_time || '',
        weekly_discount_percent: property.weekly_discount_percent || '',
        monthly_discount_percent: property.monthly_discount_percent || '',
        weekend_markup_percent: property.weekend_markup_percent || '',
        strategy: property.strategy || 'Équilibré',
        floor_price: property.floor_price || '',
        ceiling_price: property.ceiling_price || '',
        smoking_allowed: property.smoking_allowed || false,
        pets_allowed: property.pets_allowed || false,
        events_allowed: property.events_allowed || false,
        children_welcome: property.children_welcome || false,
        instant_booking: property.instant_booking || false,
        license_number: property.license_number || '',
        insurance: property.insurance || '',
        tax_info: property.tax_info || '',
        capacity: property.capacity || '',
        daily_revenue: property.daily_revenue || '',
      });
    } else {
       setFormData({
        name: '', address: '', location: '', description: '', property_type: 'villa',
        surface: '', bedrooms: '', bathrooms: '', floor: '', construction_year: '', renovation_year: '', view_type: '',
        neighborhood: '', city_center_distance: '', noise_level: '', public_transport: '', nearby_attractions: '',
        amenities: [], kitchen_amenities: [], security_amenities: [],
        base_price: '100', weekend_surcharge: '', cleaning_fee: '', deposit: '', cost_per_night: '', min_stay: '2', max_stay: '',
        check_in_time: '', check_out_time: '',
        weekly_discount_percent: '', monthly_discount_percent: '', weekend_markup_percent: '',
        strategy: 'Équilibré', floor_price: '', ceiling_price: '',
        smoking_allowed: false, pets_allowed: false, events_allowed: false, children_welcome: false, instant_booking: false,
        license_number: '', insurance: '', tax_info: '',
        capacity: '', daily_revenue: '100',
      });
    }
    setError('');
    setSyncMessage('');
    setCurrentStep(initialStep);
  }, [property, isEditing, initialStep]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prevData => ({
      ...prevData,
      [name]: type === 'checkbox' ? checked : value
    }));
  };

  const handleAmenityChange = (category, value, checked) => {
      setFormData(prevData => {
      const currentAmenities = prevData[category] || [];
          if (checked) {
              if (!currentAmenities.includes(value)) {
          return { ...prevData, [category]: [...currentAmenities, value] };
              }
          } else {
        return { ...prevData, [category]: currentAmenities.filter(item => item !== value) };
          }
          return prevData; 
      });
  };

  const nextStep = () => {
    if (currentStep < totalSteps) {
      setCurrentStep(currentStep + 1);
      setError('');
    }
  };

  const prevStep = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
      setError('');
    }
  };


  const handleSubmit = async (e) => {
    e.preventDefault();
    
    // En mode création, passer à l'étape suivante si ce n'est pas la dernière
    if (!isEditing && currentStep < totalSteps) {
      nextStep();
      return;
    }

    // En mode édition, on peut sauvegarder depuis n'importe quelle étape
    setError('');
    setSyncMessage('');
    setIsLoading(true);
    try {
      // Combiner tous les équipements
      const allAmenities = [
        ...(formData.amenities || []),
        ...(formData.kitchen_amenities || []),
        ...(formData.security_amenities || [])
      ];

      const propertyData = {
        name: formData.name || formData.address,
        address: formData.address,
        location: formData.location,
        description: formData.description || '',
        property_type: formData.property_type,
        surface: parseInt(formData.surface, 10) || 0,
        bedrooms: formData.bedrooms ? parseInt(formData.bedrooms, 10) : null,
        bathrooms: formData.bathrooms ? parseInt(formData.bathrooms, 10) : null,
        floor: formData.floor ? parseInt(formData.floor, 10) : null,
        construction_year: formData.construction_year ? parseInt(formData.construction_year, 10) : null,
        renovation_year: formData.renovation_year ? parseInt(formData.renovation_year, 10) : null,
        view_type: formData.view_type || null,
        neighborhood: formData.neighborhood || null,
        city_center_distance: formData.city_center_distance ? parseFloat(formData.city_center_distance) : null,
        noise_level: formData.noise_level || null,
        public_transport: formData.public_transport || null,
        nearby_attractions: formData.nearby_attractions || null,
        amenities: allAmenities,
        kitchen_amenities: formData.kitchen_amenities || [],
        security_amenities: formData.security_amenities || [],
        base_price: parseFloat(formData.base_price) || 100,
        weekend_surcharge: formData.weekend_surcharge ? parseFloat(formData.weekend_surcharge) : null,
        cleaning_fee: formData.cleaning_fee ? parseFloat(formData.cleaning_fee) : null,
        deposit: formData.deposit ? parseFloat(formData.deposit) : null,
        cost_per_night: formData.cost_per_night ? parseFloat(formData.cost_per_night) : null,
        min_stay: parseInt(formData.min_stay, 10) || 1,
        max_stay: formData.max_stay ? parseInt(formData.max_stay, 10) : null,
        check_in_time: formData.check_in_time || null,
        check_out_time: formData.check_out_time || null,
        weekly_discount_percent: formData.weekly_discount_percent !== '' ? parseInt(formData.weekly_discount_percent, 10) : null,
        monthly_discount_percent: formData.monthly_discount_percent !== '' ? parseInt(formData.monthly_discount_percent, 10) : null,
        weekend_markup_percent: formData.weekend_markup_percent !== '' ? parseInt(formData.weekend_markup_percent, 10) : null,
        strategy: formData.strategy || 'Équilibré',
        floor_price: formData.floor_price ? parseInt(formData.floor_price, 10) : 0,
        ceiling_price: formData.ceiling_price ? parseInt(formData.ceiling_price, 10) : null,
        smoking_allowed: formData.smoking_allowed || false,
        pets_allowed: formData.pets_allowed || false,
        events_allowed: formData.events_allowed || false,
        children_welcome: formData.children_welcome || false,
        instant_booking: formData.instant_booking || false,
        license_number: formData.license_number || null,
        insurance: formData.insurance || null,
        tax_info: formData.tax_info || null,
        // Champs de compatibilité
        capacity: parseInt(formData.capacity, 10) || 0,
        daily_revenue: parseFloat(formData.base_price) || 100,
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
      
      // Vérifier si c'est une erreur de limite d'essai
      if (errorMessage.includes('LIMIT_EXCEEDED') || errorMessage.includes('limite')) {
        try {
          // Essayer d'extraire les données de l'erreur
          // L'erreur peut être dans err.errorData ou dans le message
          let errorData = {};
          
          // Si err a une propriété errorData (retournée par apiRequest)
          if (err.errorData) {
            errorData = err.errorData;
          } else {
            // Sinon, essayer de parser le message
            try {
              const jsonMatch = errorMessage.match(/\{.*\}/);
              if (jsonMatch) {
                errorData = JSON.parse(jsonMatch[0]);
              }
            } catch (parseError) {
              console.warn('Impossible de parser les données d\'erreur:', parseError);
            }
          }
          
          // Afficher la modal de limite
          setTrialLimitData({
            currentCount: errorData.currentCount || 10,
            maxAllowed: errorData.maxAllowed || 10
          });
          setShowTrialLimitModal(true);
        } catch (modalError) {
          console.error('Erreur lors de l\'affichage de la modal:', modalError);
          setError('Vous avez atteint la limite de 10 propriétés pendant votre essai gratuit. Veuillez passer à l\'abonnement payant pour continuer.');
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


  const handleStepClick = (stepNumber) => {
    if (isEditing) {
      setCurrentStep(stepNumber);
      setError('');
    }
  };

  const renderStepIndicator = () => {
    const steps = [
      t('propertyModal.steps.basicInfo'),
      t('propertyModal.steps.characteristics'),
      t('propertyModal.steps.location'),
      t('propertyModal.steps.amenities'),
      t('propertyModal.steps.pricing'),
      t('propertyModal.steps.policies')
    ];

  return (
      <div className="flex items-center justify-between mb-6 pb-4 border-b border-global-stroke-box">
        {steps.map((stepName, index) => {
          const stepNumber = index + 1;
          const isClickable = isEditing;
          const isActive = currentStep === stepNumber;
          const isCompleted = currentStep > stepNumber;
          
          return (
            <div key={index} className="flex items-center flex-1">
              <div 
                className={`flex flex-col items-center flex-1 ${isClickable ? 'cursor-pointer' : ''}`}
                onClick={() => isClickable && handleStepClick(stepNumber)}
                title={isClickable ? t('propertyModal.clickToNavigate') : ''}
              >
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold transition-colors ${
                  isCompleted
                    ? 'bg-green-600 text-white' 
                    : isActive
                    ? 'bg-gradient-to-r from-[#155dfc] to-[#12a1d5] text-white' 
                    : 'bg-global-bg-small-box border border-global-stroke-box text-global-inactive'
                } ${isClickable && !isActive ? 'hover:border-global-content-highlight-2nd hover:text-global-blanc' : ''}`}>
                  {isCompleted ? '✓' : stepNumber}
                </div>
                <span className={`text-xs mt-2 text-center ${isActive ? 'text-global-blanc' : 'text-global-inactive'}`}>
                  {stepName}
                </span>
              </div>
              {index < steps.length - 1 && (
                <div className={`flex-1 h-0.5 mx-2 ${isCompleted ? 'bg-green-600' : 'bg-global-stroke-box'}`} />
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const renderStepContent = () => {
    switch (currentStep) {
      case 1:
        return (
          <div className="space-y-4">
            <h4 className="text-lg font-semibold text-global-blanc mb-4">{t('propertyModal.steps.basicInfo')}</h4>
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
                <div>
                  <label htmlFor="capacity" className="block text-sm font-medium text-global-inactive">{t('propertyModal.capacity')}</label>
                  <input name="capacity" id="capacity" type="number" placeholder={t('propertyModal.capacity')} value={formData.capacity} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" required />
                </div>
          </div>
        );
                
      case 2:
        return (
          <div className="space-y-4">
            <h4 className="text-lg font-semibold text-global-blanc mb-4">{t('propertyModal.steps.characteristics')}</h4>
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label htmlFor="surface" className="block text-sm font-medium text-global-inactive">{t('propertyModal.surface')}</label>
                        <input name="surface" id="surface" type="number" placeholder={t('propertyModal.surface')} value={formData.surface} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" required />
                    </div>
                    <div>
                <label htmlFor="bedrooms" className="block text-sm font-medium text-global-inactive">{t('propertyModal.bedrooms')}</label>
                <input name="bedrooms" id="bedrooms" type="number" placeholder={t('propertyModal.bedrooms')} value={formData.bedrooms} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" required />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="bathrooms" className="block text-sm font-medium text-global-inactive">{t('propertyModal.bathrooms')}</label>
                <input name="bathrooms" id="bathrooms" type="number" placeholder={t('propertyModal.bathrooms')} value={formData.bathrooms} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" required />
              </div>
              <div>
                <label htmlFor="floor" className="block text-sm font-medium text-global-inactive">{t('propertyModal.floor')} <span className="text-xs text-global-inactive">({t('propertyModal.optional')})</span></label>
                <input name="floor" id="floor" type="number" placeholder={t('propertyModal.floor')} value={formData.floor} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" />
                    </div>
                </div>
                 <div className="grid grid-cols-2 gap-4">
                     <div>
                <label htmlFor="construction_year" className="block text-sm font-medium text-global-inactive">{t('propertyModal.constructionYear')} <span className="text-xs text-global-inactive">({t('propertyModal.optional')})</span></label>
                <input name="construction_year" id="construction_year" type="number" placeholder={t('propertyModal.constructionYear')} value={formData.construction_year} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" />
              </div>
              <div>
                <label htmlFor="renovation_year" className="block text-sm font-medium text-global-inactive">{t('propertyModal.renovationYear')} <span className="text-xs text-global-inactive">({t('propertyModal.optional')})</span></label>
                <input name="renovation_year" id="renovation_year" type="number" placeholder={t('propertyModal.renovationYear')} value={formData.renovation_year} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" />
              </div>
            </div>
            <div>
              <label htmlFor="view_type" className="block text-sm font-medium text-global-inactive">{t('propertyModal.viewType')}</label>
              <select name="view_type" id="view_type" value={formData.view_type} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors [&>option]:bg-global-bg-box [&>option]:text-global-blanc">
                <option value="">{t('propertyModal.selectViewType')}</option>
                {viewTypes.map(type => (
                  <option key={type} value={type}>{type.charAt(0).toUpperCase() + type.slice(1)}</option>
                ))}
              </select>
            </div>
          </div>
        );

      case 3:
        return (
          <div className="space-y-4">
            <h4 className="text-lg font-semibold text-global-blanc mb-4">{t('propertyModal.steps.location')}</h4>
            <div>
              <label htmlFor="neighborhood" className="block text-sm font-medium text-global-inactive">{t('propertyModal.neighborhood')}</label>
              <input name="neighborhood" id="neighborhood" type="text" placeholder={t('propertyModal.neighborhood')} value={formData.neighborhood} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" required />
            </div>
            <div>
              <label htmlFor="city_center_distance" className="block text-sm font-medium text-global-inactive">{t('propertyModal.cityCenterDistance')} <span className="text-xs text-global-inactive">({t('propertyModal.optional')})</span></label>
              <input name="city_center_distance" id="city_center_distance" type="number" step="0.1" placeholder={t('propertyModal.cityCenterDistance')} value={formData.city_center_distance} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" />
            </div>
            <div>
              <label htmlFor="noise_level" className="block text-sm font-medium text-global-inactive">{t('propertyModal.noiseLevel')} <span className="text-xs text-global-inactive">({t('propertyModal.optional')})</span></label>
              <select name="noise_level" id="noise_level" value={formData.noise_level} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors [&>option]:bg-global-bg-box [&>option]:text-global-blanc">
                <option value="">{t('propertyModal.selectNoiseLevel')}</option>
                {noiseLevels.map(level => (
                  <option key={level} value={level}>{level.charAt(0).toUpperCase() + level.slice(1)}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="public_transport" className="block text-sm font-medium text-global-inactive">{t('propertyModal.publicTransport')} <span className="text-xs text-global-inactive">({t('propertyModal.optional')})</span></label>
              <input name="public_transport" id="public_transport" type="text" placeholder={t('propertyModal.publicTransport')} value={formData.public_transport} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" />
                    </div>
                     <div>
              <label htmlFor="nearby_attractions" className="block text-sm font-medium text-global-inactive">{t('propertyModal.nearbyAttractions')} <span className="text-xs text-global-inactive">({t('propertyModal.optional')})</span></label>
              <textarea name="nearby_attractions" id="nearby_attractions" rows="3" placeholder={t('propertyModal.nearbyAttractions')} value={formData.nearby_attractions} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors resize-none" />
                    </div>
                 </div>
        );

      case 4:
        return (
          <div className="space-y-4">
            <h4 className="text-lg font-semibold text-global-blanc mb-4">{t('propertyModal.steps.amenities')}</h4>
                
                <fieldset className="border border-global-stroke-box p-4 rounded-[8px]">
              <legend className="text-md font-semibold px-2 text-global-blanc">{t('propertyModal.baseAmenities')}</legend>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mt-2 max-h-48 overflow-y-auto">
                    {availableAmenities.map(amenity => (
                      <label key={amenity} className="flex items-center gap-2 text-sm text-global-inactive cursor-pointer hover:text-global-blanc transition-colors">
                        <input
                          type="checkbox"
                      checked={(formData.amenities || []).includes(amenity)}
                      onChange={(e) => handleAmenityChange('amenities', amenity, e.target.checked)}
                      className="cursor-pointer"
                    />
                    {amenity.charAt(0).toUpperCase() + amenity.slice(1)}
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="border border-global-stroke-box p-4 rounded-[8px]">
              <legend className="text-md font-semibold px-2 text-global-blanc">{t('propertyModal.kitchenAmenities')}</legend>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mt-2 max-h-48 overflow-y-auto">
                {kitchenAmenities.map(amenity => (
                  <label key={amenity} className="flex items-center gap-2 text-sm text-global-inactive cursor-pointer hover:text-global-blanc transition-colors">
                    <input
                      type="checkbox"
                      checked={(formData.kitchen_amenities || []).includes(amenity)}
                      onChange={(e) => handleAmenityChange('kitchen_amenities', amenity, e.target.checked)}
                          className="cursor-pointer"
                        />
                        {amenity.charAt(0).toUpperCase() + amenity.slice(1)}
                      </label>
                    ))}
                  </div>
                </fieldset>
                
            <fieldset className="border border-global-stroke-box p-4 rounded-[8px]">
              <legend className="text-md font-semibold px-2 text-global-blanc">{t('propertyModal.securityAmenities')}</legend>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mt-2 max-h-48 overflow-y-auto">
                {securityAmenities.map(amenity => (
                  <label key={amenity} className="flex items-center gap-2 text-sm text-global-inactive cursor-pointer hover:text-global-blanc transition-colors">
                    <input
                      type="checkbox"
                      checked={(formData.security_amenities || []).includes(amenity)}
                      onChange={(e) => handleAmenityChange('security_amenities', amenity, e.target.checked)}
                      className="cursor-pointer"
                    />
                    {amenity.charAt(0).toUpperCase() + amenity.slice(1)}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        );

      case 5:
        return (
          <div className="space-y-4">
            <h4 className="text-lg font-semibold text-global-blanc mb-4">{t('propertyModal.steps.pricing')}</h4>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="base_price" className="block text-sm font-medium text-global-inactive">{t('propertyModal.basePrice')}</label>
                <input name="base_price" id="base_price" type="number" step="0.01" placeholder={t('propertyModal.basePrice')} value={formData.base_price} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" required />
              </div>
              <div>
                <label htmlFor="weekend_surcharge" className="block text-sm font-medium text-global-inactive">{t('propertyModal.weekendSurcharge')} (%)</label>
                <input name="weekend_surcharge" id="weekend_surcharge" type="number" step="0.1" placeholder={t('propertyModal.weekendSurcharge')} value={formData.weekend_surcharge} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="cleaning_fee" className="block text-sm font-medium text-global-inactive">{t('propertyModal.cleaningFee')}</label>
                <input name="cleaning_fee" id="cleaning_fee" type="number" step="0.01" placeholder={t('propertyModal.cleaningFee')} value={formData.cleaning_fee} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" />
              </div>
              <div>
                <label htmlFor="deposit" className="block text-sm font-medium text-global-inactive">{t('propertyModal.deposit')}</label>
                <input name="deposit" id="deposit" type="number" step="0.01" placeholder={t('propertyModal.deposit')} value={formData.deposit} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" />
              </div>
            </div>
            <div>
              <label htmlFor="cost_per_night" className="block text-sm font-medium text-global-inactive">
                Coût opérationnel par nuit <span className="text-xs text-global-inactive">({t('propertyModal.optional')})</span>
              </label>
              <input name="cost_per_night" id="cost_per_night" type="number" step="0.01" placeholder="Ex: 25.00" value={formData.cost_per_night} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" />
              <p className="text-xs text-global-inactive mt-1">Utilisé pour calculer la marge brute dans les rapports</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="min_stay" className="block text-sm font-medium text-global-inactive">{t('propertyModal.minStay')}</label>
                <input name="min_stay" id="min_stay" type="number" placeholder={t('propertyModal.minStay')} value={formData.min_stay} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" required />
              </div>
              <div>
                <label htmlFor="max_stay" className="block text-sm font-medium text-global-inactive">{t('propertyModal.maxStay')}</label>
                <input name="max_stay" id="max_stay" type="number" placeholder={t('propertyModal.maxStay')} value={formData.max_stay} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="check_in_time" className="block text-sm font-medium text-global-inactive">{t('propertyModal.checkInTime')}</label>
                <input name="check_in_time" id="check_in_time" type="time" value={formData.check_in_time} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" />
              </div>
              <div>
                <label htmlFor="check_out_time" className="block text-sm font-medium text-global-inactive">{t('propertyModal.checkOutTime')}</label>
                <input name="check_out_time" id="check_out_time" type="time" value={formData.check_out_time} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" />
              </div>
            </div>

            <fieldset className="border border-global-stroke-box p-4 rounded-[8px] mt-4">
              <legend className="text-md font-semibold px-2 text-global-blanc">{t('rulesModal.longTermDiscounts')}</legend>
              <div className="grid grid-cols-2 gap-4 mt-2">
                <div>
                  <label htmlFor="weekly_discount_percent" className="block text-sm font-medium text-global-inactive">{t('rulesModal.weeklyDiscount')}</label>
                  <input name="weekly_discount_percent" id="weekly_discount_percent" type="number" placeholder="Ex: 10" value={formData.weekly_discount_percent} onChange={handleChange} min="0" max="100" className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" />
                </div>
                <div>
                  <label htmlFor="monthly_discount_percent" className="block text-sm font-medium text-global-inactive">{t('rulesModal.monthlyDiscount')}</label>
                  <input name="monthly_discount_percent" id="monthly_discount_percent" type="number" placeholder="Ex: 20" value={formData.monthly_discount_percent} onChange={handleChange} min="0" max="100" className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" />
                </div>
              </div>
            </fieldset>

            <fieldset className="border border-global-stroke-box p-4 rounded-[8px] mt-4">
              <legend className="text-md font-semibold px-2 text-global-blanc">{t('strategyModal.title')}</legend>
              <div className="space-y-4 mt-2">
                <div>
                  <label htmlFor="strategy" className="block text-sm font-medium text-global-inactive mb-1">{t('strategyModal.strategy')}</label>
                  <select 
                    name="strategy" 
                    id="strategy"
                    value={formData.strategy} 
                    onChange={handleChange} 
                    className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors [&>option]:bg-global-bg-box [&>option]:text-global-blanc"
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
                      id="floor_price"
                      type="number" 
                      placeholder="Ex: 80" 
                      value={formData.floor_price} 
                      onChange={handleChange} 
                      className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" 
                      required 
                    />
                  </div>
                  <div>
                    <label htmlFor="base_price_strategy" className="block text-sm font-medium text-global-inactive mb-1">{t('strategyModal.basePrice')}</label>
                    <input 
                      name="base_price" 
                      id="base_price_strategy"
                      type="number" 
                      placeholder="Ex: 120" 
                      value={formData.base_price} 
                      onChange={handleChange} 
                      className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" 
                      required 
                    />
                  </div>
                  <div>
                    <label htmlFor="ceiling_price" className="block text-sm font-medium text-global-inactive mb-1">{t('strategyModal.ceilingPrice')} <span className="text-xs text-global-inactive">({t('strategyModal.optional')})</span></label>
                    <input 
                      name="ceiling_price" 
                      id="ceiling_price"
                      type="number" 
                      placeholder={t('strategyModal.optional')} 
                      value={formData.ceiling_price} 
                      onChange={handleChange} 
                      className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" 
                    />
                  </div>
                </div>
              </div>
            </fieldset>
          </div>
        );

      case 6:
        return (
          <div className="space-y-4">
            <h4 className="text-lg font-semibold text-global-blanc mb-4">{t('propertyModal.steps.policies')}</h4>
            
            <fieldset className="border border-global-stroke-box p-4 rounded-[8px]">
              <legend className="text-md font-semibold px-2 text-global-blanc">{t('propertyModal.authorizations')}</legend>
              <div className="space-y-2 mt-2">
                <label className="flex items-center gap-2 text-sm text-global-inactive cursor-pointer hover:text-global-blanc transition-colors">
                  <input type="checkbox" name="smoking_allowed" checked={formData.smoking_allowed} onChange={handleChange} className="cursor-pointer" />
                  {t('propertyModal.smokingAllowed')}
                </label>
                <label className="flex items-center gap-2 text-sm text-global-inactive cursor-pointer hover:text-global-blanc transition-colors">
                  <input type="checkbox" name="pets_allowed" checked={formData.pets_allowed} onChange={handleChange} className="cursor-pointer" />
                  {t('propertyModal.petsAllowed')}
                </label>
                <label className="flex items-center gap-2 text-sm text-global-inactive cursor-pointer hover:text-global-blanc transition-colors">
                  <input type="checkbox" name="events_allowed" checked={formData.events_allowed} onChange={handleChange} className="cursor-pointer" />
                  {t('propertyModal.eventsAllowed')}
                </label>
                <label className="flex items-center gap-2 text-sm text-global-inactive cursor-pointer hover:text-global-blanc transition-colors">
                  <input type="checkbox" name="children_welcome" checked={formData.children_welcome} onChange={handleChange} className="cursor-pointer" />
                  {t('propertyModal.childrenWelcome')}
                </label>
                <label className="flex items-center gap-2 text-sm text-global-inactive cursor-pointer hover:text-global-blanc transition-colors">
                  <input type="checkbox" name="instant_booking" checked={formData.instant_booking} onChange={handleChange} className="cursor-pointer" />
                  {t('propertyModal.instantBooking')}
                </label>
              </div>
            </fieldset>

            <fieldset className="border border-global-stroke-box p-4 rounded-[8px]">
              <legend className="text-md font-semibold px-2 text-global-blanc">{t('propertyModal.legalDocuments')}</legend>
              <div className="space-y-4 mt-2">
                <div>
                  <label htmlFor="license_number" className="block text-sm font-medium text-global-inactive">{t('propertyModal.licenseNumber')}</label>
                  <input name="license_number" id="license_number" type="text" placeholder={t('propertyModal.licenseNumber')} value={formData.license_number} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" />
                </div>
                <div>
                  <label htmlFor="insurance" className="block text-sm font-medium text-global-inactive">{t('propertyModal.insurance')}</label>
                  <input name="insurance" id="insurance" type="text" placeholder={t('propertyModal.insurance')} value={formData.insurance} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors" />
                </div>
                <div>
                  <label htmlFor="tax_info" className="block text-sm font-medium text-global-inactive">{t('propertyModal.taxInfo')}</label>
                  <textarea name="tax_info" id="tax_info" rows="3" placeholder={t('propertyModal.taxInfo')} value={formData.tax_info} onChange={handleChange} className="w-full bg-global-bg-small-box border border-global-stroke-box text-global-blanc p-2.5 rounded-[8px] mt-1 focus:outline-none focus:border-global-content-highlight-2nd transition-colors resize-none" />
                </div>
              </div>
            </fieldset>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <>
      <TrialLimitModal
        isOpen={showTrialLimitModal}
        onClose={() => {
          setShowTrialLimitModal(false);
          // Rafraîchir le compteur de propriétés après la fermeture de la modale
          if (typeof window !== 'undefined') {
            try {
              window.dispatchEvent(new CustomEvent('refreshPropertyCount'));
            } catch (error) {
              console.error('Erreur lors de l\'envoi de l\'événement refreshPropertyCount:', error);
            }
          }
        }}
        currentCount={trialLimitData.currentCount}
        maxAllowed={trialLimitData.maxAllowed}
        token={token}
      />
      <div 
        className="fixed inset-0 flex items-center justify-center p-4 z-50"
        style={{ backgroundColor: 'rgba(0, 0, 0, 0.85)' }}
        onClick={(e) => {
          // Fermer seulement si on clique sur le backdrop (pas sur le contenu)
          if (e.target === e.currentTarget) {
            onClose();
          }
        }}
      >
        <div 
          className="border border-global-stroke-box rounded-[14px] shadow-xl w-full max-w-5xl max-h-[90vh] flex flex-col backdrop-blur-md overflow-hidden"
          style={{ backgroundColor: 'rgba(15, 23, 43, 0.75)' }}
          onClick={(e) => e.stopPropagation()}
        >
            {/* Header (Fixe) */}
            <div className="p-6 border-b border-global-stroke-box shrink-0">
              <div className="flex justify-between items-center">
                <h3 className="text-xl font-bold text-global-blanc">{isEditing ? t('propertyModal.editTitle') : t('propertyModal.title')}</h3>
                {isEditing && (
                  <button
                    type="button"
                    onClick={handleSyncData}
                    disabled={isSyncing}
                    className="px-4 py-2 text-sm font-semibold text-white bg-teal-600 rounded-[8px] hover:bg-teal-700 disabled:bg-gray-500 transition-colors"
                  >
                    {isSyncing ? t('common.loading') : t('propertyModal.sync')}
                  </button>
                )}
              </div>
              {syncMessage && <p className="text-sm text-green-400 mt-2 text-center">{syncMessage}</p>}
              {renderStepIndicator()}
            </div>

            {/* Corps (Scrollable) */}
            {/* flex-1 permet de prendre l'espace restant, min-h-0 est crucial pour le flex nesting */}
            <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0 relative">
              
              {/* On passe w-full h-full pour que le conteneur relative prenne tout l'espace */}
              <CustomScrollbar className="w-full h-full">
                <div className="p-6">
                  {renderStepContent()}
                  
                  {error && (
                    <p className="text-sm text-red-400 bg-red-900/50 p-3 rounded-[8px] border border-red-500/20 mt-4">
                      {error}
                    </p>
                  )}
                </div>
              </CustomScrollbar>

              {/* Footer (Fixe) */}
              <div className="p-6 border-t border-global-stroke-box bg-global-bg-box/50 shrink-0 z-10 relative">
                <div className="flex justify-between gap-4">
                  <button 
                    type="button" 
                    onClick={currentStep === 1 ? onClose : prevStep} 
                    className="px-4 py-2 font-semibold text-global-inactive bg-global-bg-small-box border border-global-stroke-box rounded-[8px] hover:border-global-content-highlight-2nd hover:text-global-blanc transition-colors"
                  >
                    {currentStep === 1 ? t('propertyModal.cancel') : t('propertyModal.previous')}
                  </button>
                  <button 
                    type="submit" 
                    disabled={isLoading || isSyncing} 
                    className="px-4 py-2 font-semibold text-white bg-gradient-to-r from-[#155dfc] to-[#12a1d5] rounded-[8px] hover:opacity-90 disabled:bg-gray-500 disabled:opacity-50 transition-opacity"
                  >
                    {isLoading 
                      ? t('common.saving') 
                      : isEditing 
                        ? t('propertyModal.save') 
                        : currentStep === totalSteps 
                          ? t('propertyModal.save') 
                          : t('propertyModal.next')}
                  </button>
                </div>
              </div>
            </form>
        </div>
    </div>
    </>
  );
}

export default PropertyModal;


