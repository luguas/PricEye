import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { getProperties, generatePricingStrategy, addBooking, getBookingsForMonth, getGroups, updateGroup, getUserProfile, getAutoPricingStatus, enableAutoPricing, getPriceOverrides, updatePriceOverrides } from '../services/api.js';
import { jwtDecode } from 'jwt-decode'; 
// Firebase n'est plus utilisé directement 
import Bouton from '../components/Bouton.jsx';
import AlertModal from '../components/AlertModal.jsx';
import { useLanguage } from '../contexts/LanguageContext.jsx';
import { handleQuotaError, checkQuotaStatus } from '../utils/quotaErrorHandler.js';
import { supabase } from '../config/supabase.js'; 

// Firebase n'est plus utilisé directement côté client pour les price_overrides
// On utilise maintenant l'API backend


function PricingPage({ token, userProfile }) {
  const { t, language } = useLanguage();
  const [properties, setProperties] = useState([]);
  const [allGroups, setAllGroups] = useState([]);
  const [selectedView, setSelectedView] = useState('property'); 
  const [selectedId, setSelectedId] = useState(''); 

  const [currentCalendarDate, setCurrentCalendarDate] = useState(new Date());
  const [priceOverrides, setPriceOverrides] = useState({});
  const [bookings, setBookings] = useState({}); 
  const [isLoading, setIsLoading] = useState(true);
  const [isCalendarLoading, setIsCalendarLoading] = useState(false); 
  const [error, setError] = useState('');
  const [iaLoading, setIaLoading] = useState(false);
  const [isAutoGenerationEnabled, setIsAutoGenerationEnabled] = useState(false);
  const [autoPricingTimezone, setAutoPricingTimezone] = useState('Europe/Paris');
  const [autoPricingLastRun, setAutoPricingLastRun] = useState(null);
  const [isLoadingAutoPricing, setIsLoadingAutoPricing] = useState(true);
  const [autoPricingSuccess, setAutoPricingSuccess] = useState('');
  const [autoPricingError, setAutoPricingError] = useState('');
  const [isQuotaReached, setIsQuotaReached] = useState(false); 

  const [selectionStart, setSelectionStart] = useState(null);
  const [selectionEnd, setSelectionEnd] = useState(null);
  const [isSelecting, setIsSelecting] = useState(false);
  
  const [selectionMode, setSelectionMode] = useState('booking'); 
  
  // States pour les formulaires
  const [bookingPrice, setBookingPrice] = useState('');
  const [bookingChannel, setBookingChannel] = useState('Direct');
  const [manualPrice, setManualPrice] = useState('');
  const [isPriceLocked, setIsPriceLocked] = useState(true); 

  const [selectedDateForAnalysis, setSelectedDateForAnalysis] = useState(null);

  // État pour la modale d'alerte
  const [alertModal, setAlertModal] = useState({ isOpen: false, message: '', title: 'Information' });


  // Plus besoin de vérifier l'initialisation Firebase

  // Fonction pour charger toutes les données initiales (profil, propriétés, groupes)
  const fetchInitialData = useCallback(async () => {
    if (!token) return; 
    setIsLoading(true);
    setError(''); 
    try {
      // 1. Récupérer les propriétés
      const propsData = await getProperties(token);
      
      // Filtrer les propriétés avec des IDs invalides côté client aussi (double sécurité)
      const validProperties = propsData.filter(prop => {
        if (!prop.id || typeof prop.id !== 'string') return false;
        const uuidLength = prop.id.replace(/-/g, '').length;
        return uuidLength >= 32;
      });
      
      // 2. Récupérer les groupes depuis Supabase
      const { data: groupsData, error: groupsError } = await supabase
        .from('property_groups')
        .select('*');

      if (groupsError) throw groupsError;

      // 3. Fusionner pour l'affichage
      // On ajoute un flag 'isGroup' pour les distinguer
      const formattedGroups = (groupsData || []).map(g => ({
        id: g.main_property_id, // ASTUCE : On utilise l'ID du chef comme valeur !
        name: `👥 Groupe: ${g.name}`, // Préfixe visuel
        isGroup: true,
        groupId: g.id,
        // On garde les autres champs au cas où
        ...g
      }));

      // On combine : D'abord les groupes, ensuite les propriétés individuelles
      // Optionnel : Filtrer les propriétés qui sont déjà dans des groupes pour éviter les doublons
      const mergedList = [...formattedGroups, ...validProperties];
      
      setProperties(mergedList);
      
      // Garder aussi allGroups pour les autres usages dans le composant
      setAllGroups(groupsData || []);
      
      // Sélection par défaut
      if (formattedGroups.length > 0) {
        setSelectedView('property'); // On utilise 'property' car l'ID est celui de la propriété principale
        setSelectedId(formattedGroups[0].id);
      } else if (validProperties.length > 0) {
        setSelectedView('property');
        setSelectedId(validProperties[0].id);
      }
      
    } catch (err) {
      setError(t('pricing.errors.loadData', { message: err.message }));
    } finally {
      setIsLoading(false);
    }
  }, [token, userProfile, t]); 

  useEffect(() => {
    fetchInitialData();
  }, [fetchInitialData]);

  // Charger l'état de la génération automatique au chargement
  useEffect(() => {
    const loadAutoPricingStatus = async () => {
      if (!token) {
        setIsLoadingAutoPricing(false);
        return;
      }

      try {
        // Obtenir l'userId depuis le token
        // Supabase utilise 'sub' comme identifiant utilisateur dans le JWT
        let userId = null;
        try {
          const decodedToken = jwtDecode(token);
          userId = decodedToken?.sub || decodedToken?.user_id || decodedToken?.uid;
        } catch (e) {
          console.error("Erreur de décodage du token:", e);
          setIsLoadingAutoPricing(false);
          return;
        }

        if (!userId) {
          console.warn("Impossible de récupérer l'userId depuis le token");
          setIsLoadingAutoPricing(false);
          return;
        }

        const status = await getAutoPricingStatus(userId, token);
        setIsAutoGenerationEnabled(status.enabled || false);
        // Utiliser le fuseau horaire sauvegardé dans autoPricing, ou celui du profil utilisateur
        setAutoPricingTimezone(status.timezone || userProfile?.timezone || 'Europe/Paris');
        setAutoPricingLastRun(status.lastRun || null);
        setAutoPricingError(''); // Réinitialiser les erreurs
      } catch (err) {
        console.error("Erreur lors du chargement de l'état de génération automatique:", err);
        setAutoPricingError(t('pricing.autoPricing.loadError', { message: err.message || 'Impossible de charger l\'état actuel.' }));
        // En cas d'erreur, on garde les valeurs par défaut
        setIsAutoGenerationEnabled(false);
        setAutoPricingTimezone(userProfile?.timezone || 'Europe/Paris');
      } finally {
        setIsLoadingAutoPricing(false);
      }
    };

    loadAutoPricingStatus();
  }, [token, userProfile, t]);

  // Vérifier le quota IA au chargement et après chaque appel
  useEffect(() => {
    const checkQuota = async () => {
      if (!token) return;
      const { isQuotaReached: quotaReached } = await checkQuotaStatus(token);
      setIsQuotaReached(quotaReached);
    };
    checkQuota();
    
    // Écouter les événements de mise à jour du quota
    const handleQuotaUpdate = () => {
      checkQuota();
    };
    
    window.addEventListener('aiCallCompleted', handleQuotaUpdate);
    window.addEventListener('aiCallFailed', handleQuotaUpdate);
    window.addEventListener('aiQuotaExceeded', handleQuotaUpdate);
    
    return () => {
      window.removeEventListener('aiCallCompleted', handleQuotaUpdate);
      window.removeEventListener('aiCallFailed', handleQuotaUpdate);
      window.removeEventListener('aiQuotaExceeded', handleQuotaUpdate);
    };
  }, [token]);

  // Mettre à jour le fuseau horaire si le profil utilisateur change et que la génération automatique est activée
  useEffect(() => {
    if (userProfile?.timezone && isAutoGenerationEnabled) {
      // Si le fuseau horaire du profil a changé, mettre à jour autoPricingTimezone
      // mais seulement si c'est différent de celui actuellement sauvegardé
      if (userProfile.timezone !== autoPricingTimezone) {
        // Optionnel : on peut mettre à jour automatiquement ou laisser l'utilisateur le faire
        // Pour l'instant, on ne met pas à jour automatiquement pour éviter des appels API non désirés
        // L'utilisateur devra réactiver la génération automatique pour utiliser le nouveau fuseau horaire
      }
    }
  }, [userProfile?.timezone, isAutoGenerationEnabled, autoPricingTimezone]);

  // Fonction pour calculer la prochaine génération prévue
  const getNextGenerationTime = useMemo(() => {
    if (!isAutoGenerationEnabled || !autoPricingTimezone) {
      return null;
    }

    try {
      // Créer une date pour demain à 00h00
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setUTCHours(0, 0, 0, 0);

      // Formater la date selon le fuseau horaire de l'utilisateur
      const locale = language === 'en' ? 'en-US' : 'fr-FR';
      const formatter = new Intl.DateTimeFormat(locale, {
        timeZone: autoPricingTimezone,
        day: 'numeric',
        month: 'long',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });

      return formatter.format(tomorrow);
    } catch (error) {
      console.error("Erreur lors du calcul de la prochaine génération:", error);
      // Fallback simple
      return t('pricing.autoPricing.nextGeneration');
    }
  }, [isAutoGenerationEnabled, autoPricingTimezone, language, t]);

  // Fonction pour formater la date de dernière génération
  const formatLastRun = useMemo(() => {
    if (!autoPricingLastRun) {
      return null;
    }

    try {
      // autoPricingLastRun peut être un timestamp Firestore, une date ISO string, ou un objet
      let date;
      
      if (typeof autoPricingLastRun === 'string') {
        // C'est une string ISO
        date = new Date(autoPricingLastRun);
      } else if (autoPricingLastRun instanceof Date) {
        // C'est déjà une Date
        date = autoPricingLastRun;
      } else if (autoPricingLastRun.toDate && typeof autoPricingLastRun.toDate === 'function') {
        // C'est un Timestamp Firestore (côté client, on reçoit généralement une string)
        date = autoPricingLastRun.toDate();
      } else if (autoPricingLastRun.seconds) {
        // C'est un objet avec seconds (format Firestore)
        date = new Date(autoPricingLastRun.seconds * 1000);
      } else if (autoPricingLastRun._seconds) {
        // Format alternatif Firestore
        date = new Date(autoPricingLastRun._seconds * 1000);
      } else {
        // Essayer de créer une date directement
        date = new Date(autoPricingLastRun);
      }

      // Vérifier que la date est valide
      if (isNaN(date.getTime())) {
        console.warn("Date de dernière génération invalide:", autoPricingLastRun);
        return null;
      }

      // Formater selon le fuseau horaire de l'utilisateur
      const locale = language === 'en' ? 'en-US' : 'fr-FR';
      const formatter = new Intl.DateTimeFormat(locale, {
        timeZone: autoPricingTimezone || userProfile?.timezone || 'Europe/Paris',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });

      return formatter.format(date);
    } catch (error) {
      console.error("Erreur lors du formatage de la dernière génération:", error, autoPricingLastRun);
      return null;
    }
  }, [autoPricingLastRun, autoPricingTimezone, userProfile?.timezone, language]);

  // Fonction réutilisable pour appliquer une stratégie de pricing
  const applyPricingStrategy = async (propertyIdToAnalyze, groupToSync = null) => {
    if (!propertyIdToAnalyze || !token) {
      throw new Error('Propriété ou token manquant.');
    }

    setIaLoading(true);
    setError('');

    try {
      const strategy = await generatePricingStrategy(propertyIdToAnalyze, token);
      
      if (!strategy.daily_prices || strategy.daily_prices.length === 0) {
          throw new Error("La stratégie générée par l'IA est vide ou mal formée.");
      }
      
      let propertyIdsToUpdate = [propertyIdToAnalyze]; 
      if (groupToSync) {
          groupToSync.properties.forEach(propId => {
              if (propId !== propertyIdToAnalyze && !propertyIdsToUpdate.includes(propId)) {
                  propertyIdsToUpdate.push(propId);
              }
          });
      }

      // Pré-charger les prix verrouillés pour toutes les propriétés concernées
      const lockedPricesMap = new Map();
      for (const propId of propertyIdsToUpdate) {
           try {
               const overridesData = await getPriceOverrides(propId, token);
               
               // Gérer à la fois le format tableau (ancien) et objet (nouveau)
               if (Array.isArray(overridesData)) {
                 overridesData.forEach(override => {
                   if (override.date && (override.is_locked || override.isLocked)) {
                     lockedPricesMap.set(`${propId}-${override.date}`, override.price);
                   }
                 });
               } else if (typeof overridesData === 'object' && overridesData !== null) {
                 Object.keys(overridesData).forEach(date => {
                   const override = overridesData[date];
                   if (override && (override.isLocked || override.is_locked)) {
                     lockedPricesMap.set(`${propId}-${date}`, override.price);
                   }
                 });
               }
           } catch (err) {
               console.warn(`Erreur lors de la récupération des prix verrouillés pour ${propId}:`, err);
           }
      }
      
      console.log(`Trouvé ${lockedPricesMap.size} prix verrouillés pour ${propertyIdsToUpdate.length} propriétés.`);

      // Préparer les overrides à mettre à jour pour chaque propriété
      for (const propId of propertyIdsToUpdate) {
          const overridesToUpdate = [];
          
          strategy.daily_prices.forEach(dayPrice => {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dayPrice.date)) return; 
            if (typeof dayPrice.price !== 'number' || isNaN(dayPrice.price)) return;
            
            // Vérifier si cette date spécifique est verrouillée pour CETTE propriété
            if (lockedPricesMap.has(`${propId}-${dayPrice.date}`)) {
                 console.log(`Ignoré ${dayPrice.date} pour ${propId}: prix verrouillé.`);
                 return; // Ne pas écraser
            }

            overridesToUpdate.push({
                date: dayPrice.date,
                price: dayPrice.price,
                isLocked: false,
                reason: dayPrice.reason || "Stratégie IA Automatique"
            });
          });
          
          // Mettre à jour via l'API backend
          if (overridesToUpdate.length > 0) {
              await updatePriceOverrides(propId, overridesToUpdate, token);
          }
      }
      
      fetchCalendarData(); // Recharger le calendrier
      // Déclencher un événement pour mettre à jour l'indicateur de quota
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('aiCallCompleted'));
      }
      return { success: true, propertyCount: propertyIdsToUpdate.length, summary: strategy.strategy_summary };
    } catch (err) {
      console.error("Erreur lors de l'application de la stratégie:", err);
      // Gérer les erreurs de quota IA
      const isQuotaError = handleQuotaError(err, setError, setAlertModal, userProfile, null);
      if (isQuotaError) {
        setIsQuotaReached(true);
      }
      // Déclencher un événement pour mettre à jour l'indicateur de quota
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('aiCallFailed'));
      }
      throw err;
    } finally {
      setIaLoading(false);
    }
  };

  // Fonction pour gérer le toggle de génération automatique
  const handleToggleAutoGeneration = async (newEnabled) => {
    // Réinitialiser les messages
    setAutoPricingSuccess('');
    setAutoPricingError('');

    // Si on active la génération automatique, vérifier le quota
    if (newEnabled) {
      const { isQuotaReached: quotaReached } = await checkQuotaStatus(token);
      if (quotaReached) {
        setIsQuotaReached(true);
        setAutoPricingError(t('pricing.autoPricing.quotaReached'));
        handleQuotaError(
          new Error('Quota IA atteint'),
          null,
          setAlertModal,
          userProfile,
          null
        );
        return; // Ne pas activer si le quota est atteint
      }
    }

    const newTimezone = autoPricingTimezone || userProfile?.timezone || 'Europe/Paris';
    
    // Mettre à jour l'état local immédiatement pour une meilleure UX
    setIsAutoGenerationEnabled(newEnabled);
    
    try {
      // Obtenir l'userId depuis le token
      // Supabase utilise 'sub' comme identifiant utilisateur dans le JWT
      let userId = null;
      try {
        const decodedToken = jwtDecode(token);
        userId = decodedToken?.sub || decodedToken?.user_id || decodedToken?.uid;
      } catch (decodeError) {
        console.error("Erreur de décodage du token:", decodeError);
        setAutoPricingError(t('pricing.autoPricing.authError'));
        setIsAutoGenerationEnabled(!newEnabled); // Revenir à l'état précédent
        return;
      }

      if (!userId) {
        setAutoPricingError(t('pricing.autoPricing.userIdError'));
        setIsAutoGenerationEnabled(!newEnabled);
        return;
      }

      // Utiliser le fuseau horaire du profil utilisateur si disponible, sinon celui sauvegardé
      const timezoneToUse = userProfile?.timezone || autoPricingTimezone || 'Europe/Paris';
      
      // Appeler l'API pour sauvegarder la préférence
      const response = await enableAutoPricing(userId, newEnabled, timezoneToUse, token);
      
      // Mettre à jour le timezone
      setAutoPricingTimezone(timezoneToUse);

      // Si le toggle vient d'être activé, générer et appliquer les prix immédiatement
      if (newEnabled) {
        try {
          // Déterminer la propriété/groupe à utiliser
          let propertyIdToAnalyze;
          let groupToSync = null;

          if (selectedView === 'property') {
              propertyIdToAnalyze = selectedId;
          } else { // 'group'
              const group = allGroups.find(g => g.id === selectedId);
              if (group) {
                  if (!group.syncPrices) {
                      if (!group.mainPropertyId) {
                          setAutoPricingError(t('pricing.autoPricing.noMainProperty'));
                          setIsAutoGenerationEnabled(false);
                          return;
                      }
                      propertyIdToAnalyze = group.mainPropertyId;
                      groupToSync = null;
                  } else {
                      if (!group.mainPropertyId) {
                          setAutoPricingError(t('pricing.autoPricing.noMainProperty'));
                          setIsAutoGenerationEnabled(false);
                          return;
                      }
                      propertyIdToAnalyze = group.mainPropertyId;
                      groupToSync = group;
                  }
              } else {
                  // Si aucun groupe/propriété sélectionné, utiliser la première propriété disponible
                  if (properties.length > 0) {
                      propertyIdToAnalyze = properties[0].id;
                  } else {
                      setAutoPricingError(t('pricing.autoPricing.noProperties'));
                      setIsAutoGenerationEnabled(false);
                      return;
                  }
              }
          }

          if (!propertyIdToAnalyze) {
              setAutoPricingError(t('pricing.autoPricing.invalidSelection'));
              setIsAutoGenerationEnabled(false);
              return;
          }

          // Appliquer la stratégie immédiatement
          setAutoPricingSuccess(t('pricing.autoPricing.generating'));
          const result = await applyPricingStrategy(propertyIdToAnalyze, groupToSync);
          
          setAutoPricingSuccess(t('pricing.autoPricing.success', { count: result.propertyCount, timezone: timezoneToUse }));
        } catch (pricingError) {
          console.error("Erreur lors de la génération immédiate des prix:", pricingError);
          setAutoPricingError(t('pricing.autoPricing.error', { message: pricingError.message }));
          // On garde le toggle activé même si la génération immédiate échoue
          // car la génération automatique quotidienne fonctionnera quand même
        }
      } else {
        setAutoPricingSuccess(t('pricing.autoPricing.disabled'));
      }

      // Effacer le message de succès après 5 secondes
      setTimeout(() => {
        setAutoPricingSuccess('');
      }, 5000);

    } catch (err) {
      console.error("Erreur lors de la mise à jour de la génération automatique:", err);
      setAutoPricingError(t('pricing.autoPricing.saveError', { message: err.message || 'Impossible de sauvegarder la préférence.' }));
      // Revenir à l'état précédent en cas d'erreur
      setIsAutoGenerationEnabled(!newEnabled);
      
      // Effacer le message d'erreur après 7 secondes
      setTimeout(() => {
        setAutoPricingError('');
      }, 7000);
    }
  }; 


  const fetchCalendarData = useCallback(async () => {
    console.log('[fetchCalendarData] Début - selectedId:', selectedId, 'selectedView:', selectedView);
    
    if (!selectedId) {
      console.log('[fetchCalendarData] Pas de selectedId, réinitialisation');
      setIsCalendarLoading(false);
      setPriceOverrides({});
      setBookings({});
      return;
    }
    
    setIsCalendarLoading(true);
    setError('');
    
    let propertyIdToFetch;
    let currentProperty; 

    if (selectedView === 'property') {
        propertyIdToFetch = selectedId;
        // Valider que selectedId est un UUID valide
        const uuidLength = propertyIdToFetch?.replace(/-/g, '').length || 0;
        if (!propertyIdToFetch || typeof propertyIdToFetch !== 'string' || uuidLength < 32) {
          console.error('[fetchCalendarData] UUID invalide pour la propriété:', {
            propertyIdToFetch,
            length: propertyIdToFetch?.length,
            uuidLength
          });
          setError(t('pricing.errors.invalidPropertyId') || 'ID de propriété invalide');
          setIsCalendarLoading(false);
          setPriceOverrides({});
          setBookings({});
          return;
        }
        currentProperty = properties.find(p => p.id === selectedId);
        console.log('[fetchCalendarData] Mode property - propertyIdToFetch:', propertyIdToFetch, 'currentProperty:', currentProperty);
    } else { 
        const group = allGroups.find(g => g.id === selectedId);
        if (!group) {
          console.log('[fetchCalendarData] Groupe non trouvé pour selectedId:', selectedId);
          setIsCalendarLoading(false);
          setPriceOverrides({});
          setBookings({});
          return;
        }
        propertyIdToFetch = group.mainPropertyId || group.properties?.[0];
        console.log('[fetchCalendarData] Mode group - propertyIdToFetch:', propertyIdToFetch, 'mainPropertyId:', group.mainPropertyId, 'properties:', group.properties);
        
        if (!propertyIdToFetch) {
          console.log('[fetchCalendarData] Pas de propertyIdToFetch pour le groupe');
          setIsCalendarLoading(false);
          setPriceOverrides({});
          setBookings({});
          return;
        }
        
        // Valider que propertyIdToFetch est un UUID valide (au moins 32 caractères sans tirets, ou 36 avec tirets)
        const uuidLength = propertyIdToFetch.replace(/-/g, '').length;
        if (typeof propertyIdToFetch !== 'string' || uuidLength < 32) {
          console.error('[fetchCalendarData] UUID invalide pour le groupe:', {
            propertyIdToFetch,
            length: propertyIdToFetch?.length,
            uuidLength,
            mainPropertyId: group.mainPropertyId,
            mainPropertyIdLength: group.mainPropertyId?.replace(/-/g, '').length,
            firstProperty: group.properties?.[0],
            firstPropertyLength: group.properties?.[0]?.replace(/-/g, '').length,
            allProperties: group.properties,
            groupId: group.id,
            groupName: group.name
          });
          setError(t('pricing.errors.invalidGroupPropertyId', { groupName: group.name || group.id }));
          setIsCalendarLoading(false);
          setPriceOverrides({});
          setBookings({});
          return;
        }
        currentProperty = properties.find(p => p.id === propertyIdToFetch);
    }

    if (!propertyIdToFetch) {
         console.log('[fetchCalendarData] propertyIdToFetch est vide après traitement');
         setIsCalendarLoading(false);
         setPriceOverrides({});
         setBookings({});
         return; 
    }
    
    // Si currentProperty n'est pas trouvé, on continue quand même avec propertyIdToFetch
    // car on peut avoir besoin de charger les données même si la propriété n'est pas dans la liste
    console.log('[fetchCalendarData] Chargement des données pour propertyId:', propertyIdToFetch);

    try {
      const year = currentCalendarDate.getFullYear();
      const month = currentCalendarDate.getMonth();
      const startOfMonth = `${year}-${String(month + 1).padStart(2, '0')}-01`;
      // Calculer le dernier jour réel du mois (gère les années bissextiles)
      const lastDayOfMonth = new Date(year, month + 1, 0).getDate();
      const endOfMonth = `${year}-${String(month + 1).padStart(2, '0')}-${String(lastDayOfMonth).padStart(2, '0')}`;
      
      // Fetch Overrides via API backend
      let overridesData = {};
      try {
        overridesData = await getPriceOverrides(propertyIdToFetch, token, startOfMonth, endOfMonth);
      } catch (overrideError) {
        console.error("Erreur lors de la récupération des prix:", overrideError);
        // Continuer avec un objet vide si les prix échouent
        overridesData = {};
      }
      
      const newOverrides = {};
      
      // Gérer à la fois le format tableau (ancien) et objet (nouveau)
      if (Array.isArray(overridesData)) {
        // Format tableau : transformer en objet
        overridesData.forEach(override => {
          if (override.date) {
            newOverrides[override.date] = override.price;
          }
        });
      } else if (typeof overridesData === 'object' && overridesData !== null) {
        // Format objet : déjà dans le bon format
        Object.keys(overridesData).forEach(date => {
          if (overridesData[date] && typeof overridesData[date] === 'object') {
            newOverrides[date] = overridesData[date].price;
          } else {
            // Format simple : { date: price }
            newOverrides[date] = overridesData[date];
          }
        });
      }
      
      setPriceOverrides(newOverrides);

      // Fetch Bookings
      let bookingsData = [];
      try {
        bookingsData = await getBookingsForMonth(propertyIdToFetch, year, month, token);
      } catch (bookingError) {
        console.error("Erreur lors de la récupération des réservations:", bookingError);
        // Continuer même si les réservations échouent
        bookingsData = [];
      }
      
      const newBookings = {};
      if (Array.isArray(bookingsData)) {
        bookingsData.forEach(booking => {
            if (!booking.startDate || !booking.endDate) return;
            
            // Valider et parser les dates de manière sécurisée
            let currentDate = new Date(booking.startDate + 'T00:00:00Z');
            const endDate = new Date(booking.endDate + 'T00:00:00Z');
            
            // Vérifier que les dates sont valides
            if (isNaN(currentDate.getTime()) || isNaN(endDate.getTime())) {
                console.warn('Date invalide dans la réservation:', booking);
                return;
            }
            
            while (currentDate < endDate) { 
                const dateStr = currentDate.toISOString().split('T')[0];
                // Vérifier que la date générée est valide (évite les dates comme 2026-02-31)
                const dateCheck = new Date(dateStr + 'T00:00:00Z');
                if (!isNaN(dateCheck.getTime()) && dateCheck.toISOString().split('T')[0] === dateStr) {
                    newBookings[dateStr] = booking;
                }
                currentDate.setUTCDate(currentDate.getUTCDate() + 1);
            }
        });
      }
      setBookings(newBookings);
      console.log('[fetchCalendarData] Données chargées avec succès - overrides:', Object.keys(newOverrides).length, 'bookings:', Object.keys(newBookings).length);
      
    } catch (err) {
      console.error("[fetchCalendarData] Erreur de chargement des données calendrier:", err);
      setError(t('pricing.errors.calendar', { message: err.message }));
      setPriceOverrides({});
      setBookings({});
    } finally {
      console.log('[fetchCalendarData] Fin - isCalendarLoading mis à false');
      setIsCalendarLoading(false);
    }
  }, [selectedId, selectedView, currentCalendarDate, token, properties, allGroups, t]); 

   useEffect(() => {
      console.log('[useEffect] fetchCalendarData déclenché - selectedId:', selectedId, 'selectedView:', selectedView);
      fetchCalendarData();
  }, [fetchCalendarData, selectedId, selectedView]);


  const handleGenerateStrategy = async () => {
    let propertyIdToAnalyze;
    let groupToSync = null;

    if (selectedView === 'property') {
        propertyIdToAnalyze = selectedId;
    } else { // 'group'
        const group = allGroups.find(g => g.id === selectedId);
        if (!group) {
             setError(t('pricing.errors.groupNotFound'));
             return;
        }
        if (!group.syncPrices) {
             setAlertModal({ isOpen: true, message: t('pricing.errors.syncNotEnabled'), title: t('pricing.modal.information') });
             if (!group.mainPropertyId) {
                 setAlertModal({ isOpen: true, message: t('pricing.errors.noMainProperty'), title: t('pricing.modal.attention') });
                 return;
             }
             propertyIdToAnalyze = group.mainPropertyId;
             groupToSync = null; // Ne pas synchroniser si la case n'est pas cochée
        } else {
            // Synchro activée
             if (!group.mainPropertyId) {
                 setAlertModal({ isOpen: true, message: t('pricing.errors.noMainPropertyDashboard'), title: t('pricing.modal.attention') });
                 return;
             }
            propertyIdToAnalyze = group.mainPropertyId;
            groupToSync = group; // Passer le groupe pour la synchro
        }
    }
    
    if (!propertyIdToAnalyze) {
      setError(t('pricing.errors.invalidSelection'));
      return;
    }
    if (!token) {
       setError(t('pricing.errors.connectionNotReady'));
       return;
    }

    // Vérifier le quota avant de générer la stratégie
    const { isQuotaReached: quotaReached } = await checkQuotaStatus(token);
    if (quotaReached) {
      setIsQuotaReached(true);
      handleQuotaError(
        new Error('Quota IA atteint'),
        setError,
        setAlertModal,
        userProfile,
        null
      );
      return;
    }

    try {
      const result = await applyPricingStrategy(propertyIdToAnalyze, groupToSync);
      setAlertModal({ isOpen: true, message: t('pricing.errors.strategySuccess', { count: result.propertyCount, summary: result.summary || '' }), title: t('pricing.modal.success') });
      // Vérifier le quota après l'appel
      const { isQuotaReached: quotaReachedAfter } = await checkQuotaStatus(token);
      setIsQuotaReached(quotaReachedAfter);
    } catch (err) {
      // handleQuotaError a déjà été appelé dans applyPricingStrategy si c'était une erreur de quota
      if (!err.isQuotaExceeded) {
        setError(t('pricing.errors.strategyError', { message: err.message }));
      }
    }
  };

  // --- Gestion de la sélection ---
  const handleMouseDown = (dateStr) => {
    setIsSelecting(true);
    setSelectionStart(dateStr);
    setSelectionEnd(dateStr);
    
    // Mettre à jour la date pour l'analyse, quel que soit le mode
    setSelectedDateForAnalysis(dateStr); 
    
    // Réinitialiser les formulaires
    setBookingPrice('');
    setManualPrice('');
    setIsPriceLocked(true);
  };

  const handleMouseOver = (dateStr) => {
    if (isSelecting) {
        const startDate = new Date(selectionStart + 'T00:00:00Z');
        const hoverDate = new Date(dateStr + 'T00:00:00Z');
        
        // Vérifier que les dates sont valides
        if (isNaN(startDate.getTime()) || isNaN(hoverDate.getTime())) {
            return;
        }
        
        let currentDateCheck = new Date(Math.min(startDate.getTime(), hoverDate.getTime()));
        const endDateCheck = new Date(Math.max(startDate.getTime(), hoverDate.getTime()));
        
        if (selectionMode === 'booking') {
            let hasBookingInRange = false;
            while(currentDateCheck <= endDateCheck){
                const checkDateStr = currentDateCheck.toISOString().split('T')[0];
                // Vérifier que la date générée est valide
                const dateCheck = new Date(checkDateStr + 'T00:00:00Z');
                if (!isNaN(dateCheck.getTime()) && dateCheck.toISOString().split('T')[0] === checkDateStr) {
                    if(bookings[checkDateStr]){
                        hasBookingInRange = true;
                        break;
                    }
                }
                currentDateCheck.setUTCDate(currentDateCheck.getUTCDate() + 1);
            }
            if(hasBookingInRange){
                 console.warn("La sélection traverse une date réservée.");
            }
        }

        if(hoverDate < startDate) {
            setSelectionEnd(selectionStart);
            setSelectionStart(dateStr);
        } else {
           setSelectionEnd(dateStr);
        }
    }
  };
  
   const handleMouseUp = () => {
    setIsSelecting(false);
  };
  
   useEffect(() => {
        window.addEventListener('mouseup', handleMouseUp);
        return () => window.removeEventListener('mouseup', handleMouseUp);
   }, []);


  const clearSelection = () => {
      setSelectionStart(null);
      setSelectionEnd(null);
      setBookingPrice(''); 
      setBookingChannel('Direct');
      setManualPrice(''); 
      setIsPriceLocked(true); 
      setError(''); 
      // Ne pas réinitialiser selectedDateForAnalysis ici
  };

  // --- Sauvegarde de la Réservation ---
  const handleSaveBooking = async (e) => {
      e.preventDefault();
      
       let propertyIdForBooking = selectedId;
       if (selectedView === 'group') {
           const group = allGroups.find(g => g.id === selectedId);
           if (!group || !group.mainPropertyId) {
                setError(t('pricing.errors.bookingNoMainProperty'));
                return;
           }
           propertyIdForBooking = group.mainPropertyId;
       }
       
      if (!selectionStart || !selectionEnd || !bookingPrice || !propertyIdForBooking) return;
      
      const pricePerNightNum = parseInt(bookingPrice, 10);
      if (isNaN(pricePerNightNum) || pricePerNightNum <= 0) {
          setError(t('pricing.errors.bookingInvalidPrice'));
          return;
      }
      
       // Valider et parser les dates de manière sécurisée
       const start = new Date(selectionStart + 'T00:00:00Z');
       const end = new Date(selectionEnd + 'T00:00:00Z');
       
       // Vérifier que les dates sont valides
       if (isNaN(start.getTime()) || isNaN(end.getTime())) {
           setError(t('pricing.errors.invalidDate'));
           return;
       }
       
       let currentDateCheck = new Date(start);
       while(currentDateCheck <= end) {
           const dateStr = currentDateCheck.toISOString().split('T')[0];
           // Vérifier que la date générée est valide
           const dateCheck = new Date(dateStr + 'T00:00:00Z');
           if (!isNaN(dateCheck.getTime()) && dateCheck.toISOString().split('T')[0] === dateStr) {
               if (bookings[dateStr]) {
                   setError(t('pricing.errors.bookingDateError', { date: dateStr }));
                   return;
               }
           }
           currentDateCheck.setUTCDate(currentDateCheck.getUTCDate() + 1);
       }
       
       const endDateForCalc = new Date(end);
       endDateForCalc.setUTCDate(endDateForCalc.getUTCDate() + 1);
       
       // Vérifier que la date calculée est valide
       if (isNaN(endDateForCalc.getTime())) {
           setError(t('pricing.errors.invalidEndDate'));
           return;
       } 
       const nights = Math.round((endDateForCalc - start) / (1000 * 60 * 60 * 24));
       if (nights <= 0) {
            setError(t('pricing.errors.bookingEndDateError'));
            return;
       }

      const bookingData = {
          startDate: selectionStart,
          endDate: endDateForCalc.toISOString().split('T')[0], 
          pricePerNight: pricePerNightNum,
          totalPrice: pricePerNightNum * nights,
          channel: bookingChannel,
          bookedAt: new Date().toISOString()
      };
      
      setIsLoading(true); 
      setError('');
      try {
          await addBooking(propertyIdForBooking, bookingData, token);
          
          setAlertModal({ isOpen: true, message: t('pricing.errors.bookingSuccess'), title: t('pricing.modal.success') });
          clearSelection();
          fetchCalendarData(); 
      } catch (err) {
          setError(t('pricing.errors.bookingError', { message: err.message }));
      } finally {
          setIsLoading(false);
      }
  };

  // --- Sauvegarde du PRIX MANUEL ---
  const handleSavePriceOverride = async (e) => {
      e.preventDefault();
      
      let propertyIdsToUpdate = [];
      if (selectedView === 'property') {
          propertyIdsToUpdate = [selectedId];
      } else { 
          const group = allGroups.find(g => g.id === selectedId);
          if (!group) {
              setError(t('pricing.errors.groupNotFound'));
              return;
          }
          if (!group.syncPrices) {
              setAlertModal({ isOpen: true, message: t('pricing.errors.syncNotEnabledPrice'), title: t('pricing.modal.information') });
              propertyIdsToUpdate = [group.mainPropertyId].filter(Boolean); 
          } else {
              propertyIdsToUpdate = group.properties || []; 
          }
      }

      if (!selectionStart || !selectionEnd || !manualPrice || propertyIdsToUpdate.length === 0) {
          setError(t('pricing.errors.bookingRequired'));
          return;
      }
      
      const priceNum = parseInt(manualPrice, 10);
      if (isNaN(priceNum) || priceNum < 0) {
          setError(t('pricing.errors.invalidPrice'));
          return;
      }

      setIsLoading(true);
      setError('');
      try {
          // Préparer les overrides pour chaque propriété
          // Valider et parser les dates de manière sécurisée
          const startDate = new Date(selectionStart + 'T00:00:00Z');
          const endDate = new Date(selectionEnd + 'T00:00:00Z');
          
          // Vérifier que les dates sont valides
          if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
              setError(t('pricing.errors.invalidDate'));
              setIsLoading(false);
              return;
          }
          
          // Mettre à jour chaque propriété via l'API backend
          for (const propId of propertyIdsToUpdate) {
              const overridesToUpdate = [];
              let dateIterator = new Date(startDate);
              
              while(dateIterator <= endDate) {
                  const dateStr = dateIterator.toISOString().split('T')[0];
                  // Vérifier que la date générée est valide (évite les dates comme 2026-02-31)
                  const dateCheck = new Date(dateStr + 'T00:00:00Z');
                  if (!isNaN(dateCheck.getTime()) && dateCheck.toISOString().split('T')[0] === dateStr) {
                      overridesToUpdate.push({
                          date: dateStr,
                          price: priceNum,
                          isLocked: isPriceLocked,
                          reason: "Manuel"
                      });
                  }
                  dateIterator.setUTCDate(dateIterator.getUTCDate() + 1);
              }
              
              if (overridesToUpdate.length > 0) {
                  await updatePriceOverrides(propId, overridesToUpdate, token);
              }
          }
          setAlertModal({ isOpen: true, message: t('pricing.errors.priceSuccess', { count: propertyIdsToUpdate.length }), title: t('pricing.modal.success') });
          clearSelection();
          fetchCalendarData(); 
      } catch (err) {
          setError(t('pricing.errors.priceError', { message: err.message }));
      } finally {
          setIsLoading(false);
      }
  };

  // NOUVEAU: Logique pour obtenir la propriété/groupe actuellement affiché
  const currentItem = useMemo(() => {
     if (selectedView === 'property') {
        return properties.find(p => p.id === selectedId);
     } else {
        const group = allGroups.find(g => g.id === selectedId);
        if (!group) return null;
        // Pour un groupe, on utilise les infos de la prop principale (ou de la 1ère)
        return properties.find(p => p.id === group.mainPropertyId) ||
               properties.find(p => p.id === group.properties?.[0]);
     }
  }, [selectedId, selectedView, properties, allGroups]);
  
  // Obtenir le prix de base pour l'affichage (utiliser le prix de la propriété ou une valeur par défaut)
  const getBasePrice = useCallback(() => {
    if (currentItem && currentItem.daily_revenue) {
      return currentItem.daily_revenue;
    }
    // Si pas de propriété trouvée, utiliser le premier prix override comme référence
    const firstOverride = Object.values(priceOverrides)[0];
    if (firstOverride) {
      return firstOverride;
    }
    return 0; // Valeur par défaut
  }, [currentItem, priceOverrides]);
  
  // NOUVEAU: Logique pour obtenir l'ID de la propriété à analyser
  const propertyIdForAnalysis = useMemo(() => {
     if (selectedView === 'property') {
        return selectedId;
     } else {
        const group = allGroups.find(g => g.id === selectedId);
        return group?.mainPropertyId || group?.properties?.[0];
     }
  }, [selectedId, selectedView, allGroups]);

  // NOUVEAU: Calculer le prix actuel pour la date d'analyse
  const currentPriceForAnalysis = useMemo(() => {
    if (!selectedDateForAnalysis || !currentItem) {
      return null;
    }
    // L'ordre de priorité est : prix override, PUIS prix de base de la propriété
    return priceOverrides[selectedDateForAnalysis] ?? currentItem.daily_revenue;
  }, [selectedDateForAnalysis, currentItem, priceOverrides]);


  // Formatter pour la devise (basé sur le profil utilisateur)
  const formatCurrency = (amount) => {
      const currency = userProfile?.currency || 'EUR'; // EUR par défaut
      const locale = language === 'en' ? 'en-US' : 'fr-FR';
      return (amount || 0).toLocaleString(locale, { 
          style: 'currency', 
          currency: currency, 
          minimumFractionDigits: 0, 
          maximumFractionDigits: 0 
      });
  };

  // Icônes pour les flèches (SVG inline)
  const ArrowDownIcon = ({ className = '' }) => (
    <div className={`relative w-5 h-5 ${className}`} role="img" aria-label="Icon">
      <svg
        className="absolute w-full h-full"
        viewBox="0 0 20 20"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <path
          d="M5 7.5L10 12.5L15 7.5"
          stroke="white"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );

  const ArrowLeftIcon = ({ className = '' }) => (
    <div className={`relative w-5 h-5 ${className}`} role="img" aria-label="Previous month">
      <svg
        className="absolute w-full h-full"
        viewBox="0 0 20 20"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <path
          d="M12.5 5L7.5 10L12.5 15"
          stroke="white"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );

  const ArrowRightIcon = ({ className = '' }) => (
    <div className={`relative w-5 h-5 ${className}`} role="img" aria-label="Next month">
      <svg
        className="absolute w-full h-full"
        viewBox="0 0 20 20"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <path
          d="M7.5 5L12.5 10L7.5 15"
          stroke="white"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );

  const renderCalendar = () => {
    const currentProperty = currentItem;
    
    if (isLoading || !selectedId) {
         return <div className="grid grid-cols-7 gap-3"><p className="text-center p-4 text-global-inactive col-span-7">{t('pricing.loading')}</p></div>;
    }
    
    if (isCalendarLoading) {
         return <div className="grid grid-cols-7 gap-3"><p className="text-center p-4 text-global-inactive col-span-7">{t('pricing.loading')}</p></div>;
    }
    
    // Utiliser une valeur par défaut si currentProperty n'existe pas
    const basePrice = currentProperty?.daily_revenue || 0;
    
    const year = currentCalendarDate.getFullYear();
    const month = currentCalendarDate.getMonth();
    const grid = [];

    // Obtenir la date d'aujourd'hui au format YYYY-MM-DD pour comparaison
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const firstDayOfMonth = new Date(year, month, 1);
    const firstDayWeekday = firstDayOfMonth.getDay(); 
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const dayOffset = (firstDayWeekday === 0) ? 6 : firstDayWeekday - 1;

    // Jours du mois précédent (grisés)
    const prevMonth = new Date(year, month, 0);
    const daysInPrevMonth = prevMonth.getDate();
    for (let i = dayOffset - 1; i >= 0; i--) {
      const day = daysInPrevMonth - i;
      const dateStr = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      // Vérifier que la date générée est valide
      const dateCheck = new Date(dateStr + 'T00:00:00Z');
      if (isNaN(dateCheck.getTime()) || dateCheck.toISOString().split('T')[0] !== dateStr) {
        continue; // Ignorer les dates invalides
      }
      grid.push(
        <div 
          key={`prev-${day}`}
          className="w-full h-full flex flex-col items-center justify-center bg-global-bg-small-box rounded-[10px] border border-solid border-global-stroke-box relative"
          style={{ opacity: 0.3 }}
        >
          <div className={`text-global-inactive relative w-fit font-h3-font-family font-h3-font-weight text-h3-font-size text-center leading-h3-line-height`}>
            {day}
          </div>
        </div>
      );
    }

    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        // Vérifier que la date générée est valide (évite les dates comme 2026-02-31)
        const dateCheck = new Date(dateStr + 'T00:00:00Z');
        if (isNaN(dateCheck.getTime()) || dateCheck.toISOString().split('T')[0] !== dateStr) {
          continue; // Ignorer les dates invalides (ex: 31 février)
        }
        const isBooked = !!bookings[dateStr];
        const price = isBooked ? bookings[dateStr].pricePerNight : (priceOverrides[dateStr] ?? basePrice);
        const currency = userProfile?.currency || 'EUR';
        const priceFormatted = price != null ? `${Math.round(price)}${currency === 'EUR' ? '€' : currency === 'USD' ? '$US' : currency}` : '';
        
        // Vérifier si la date est antérieure à aujourd'hui
        const isPastDate = dateStr < todayStr;
        
        let bgClass = 'bg-global-bg-small-box';
        let borderClass = 'border-global-stroke-box';
        let textColor = 'text-global-blanc';
        let isInSelection = false;
        let isDisabled = false;
        let opacity = 1;
        
        // Vérifier si dans la sélection
        if (selectionStart && selectionEnd && !isPastDate) {
             const dayTime = new Date(dateStr).getTime();
             const startTime = new Date(selectionStart).getTime();
             const endTime = new Date(selectionEnd).getTime();
             
             if (!isNaN(startTime) && !isNaN(endTime) && dayTime >= startTime && dayTime <= endTime) {
                  isInSelection = true;
                  if (selectionMode === 'booking') {
                    // Sélection réservation = bleu
                    bgClass = 'bg-calendrierbg-bleu';
                    borderClass = 'border-calendrierstroke-bleu';
                  } else {
                    // Sélection prix = vert
                    bgClass = 'bg-calendrierbg-vert';
                    borderClass = 'border-calendrierstroke-vert';
                  }
             }
        }
        
        if (isBooked) {
            // Réservé = orange
            bgClass = 'bg-calendrierbg-orange';
            borderClass = 'border-calendrierstroke-orange';
            isDisabled = true;
        } else if (isPastDate) {
            // Jours passés = grisés
            isDisabled = true;
            opacity = 0.4;
            textColor = 'text-global-inactive';
        } else if (!isInSelection && !isBooked) {
            // Par défaut, fond normal
            bgClass = 'bg-global-bg-small-box';
            borderClass = 'border-global-stroke-box';
        }

        grid.push(
            <div 
                key={dateStr} 
                data-date={dateStr} 
                className={`w-full h-full flex flex-col items-center justify-center ${priceFormatted ? 'gap-1' : ''} ${bgClass} rounded-[10px] border border-solid ${borderClass} ${textColor} ${isDisabled ? 'cursor-not-allowed' : 'cursor-pointer'} transition-colors relative`}
                style={{ opacity }}
                onMouseDown={!isDisabled ? () => handleMouseDown(dateStr) : undefined}
                onMouseEnter={!isDisabled ? () => handleMouseOver(dateStr) : undefined}
            >
                <div className={`${textColor} relative w-fit font-h3-font-family font-h3-font-weight text-h3-font-size text-center leading-h3-line-height`}>
                  {day}
                </div>
                {priceFormatted && (
                  <div className={`relative w-fit font-h4-font-family font-h4-font-weight ${isPastDate ? 'text-global-inactive' : 'text-global-blanc'} text-h4-font-size text-center leading-h4-line-height whitespace-nowrap`}>
                    {priceFormatted}
                  </div>
                )}
            </div>
        );
    }
    return grid;
  };

   // Fonctions de rendu des formulaires (définies au niveau du composant)
   const currencyLabel = userProfile?.currency || 'EUR';
   
   const renderBookingForm = () => (
        <form onSubmit={handleSaveBooking} className="flex flex-col gap-3 text-left">
            <div>
                <label className="text-xs font-medium text-global-inactive mb-1 block">{t('pricing.selectedPeriod')}</label>
                <p className="text-sm font-medium text-global-blanc bg-global-bg-small-box border border-global-stroke-box rounded-[10px] p-2 mt-1">
                  {selectionStart} {language === 'en' ? 'to' : 'au'} {selectionEnd}
                </p>
            </div>
            <div>
                <label className="text-xs font-medium text-global-inactive mb-1 block">{t('pricing.pricePerNight')} ({currencyLabel})</label>
                <input 
                    type="number" 
                    value={bookingPrice} 
                    onChange={(e) => setBookingPrice(e.target.value)}
                    className="w-full bg-global-bg-small-box border border-global-stroke-box rounded-[10px] px-3 py-2 text-global-blanc placeholder:text-global-inactive focus:outline-none focus:ring-2 focus:ring-global-content-highlight-2nd mt-1" 
                    placeholder="Ex: 150" 
                    required min="1"
                />
            </div>
             <div>
                <label className="text-xs font-medium text-global-inactive mb-1 block">{t('pricing.channel')}</label>
                <select 
                  value={bookingChannel} 
                  onChange={(e) => setBookingChannel(e.target.value)} 
                  className="w-full bg-global-bg-small-box border border-global-stroke-box rounded-[10px] px-3 py-2 text-global-blanc focus:outline-none focus:ring-2 focus:ring-global-content-highlight-2nd mt-1"
                >
                    <option value="Direct">{t('pricing.channels.direct')}</option>
                    <option value="Airbnb">{t('pricing.channels.airbnb')}</option>
                    <option value="Booking">{t('pricing.channels.booking')}</option>
                    <option value="VRBO">{t('pricing.channels.vrbo')}</option>
                    <option value="Autre">{t('pricing.channels.other')}</option>
                </select>
            </div>
            <div className="flex gap-2 pt-2">
                <button 
                  type="submit" 
                  disabled={isLoading} 
                  className="flex-grow bg-gradient-to-r from-[#155dfc] to-[#12a1d5] hover:opacity-90 text-white font-h3-font-family font-h3-font-weight text-h3-font-size py-2 px-4 rounded-[10px] transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {isLoading ? t('pricing.save') : t('pricing.saveBooking')}
                </button>
                 <button 
                   type="button" 
                   onClick={clearSelection} 
                   className="px-3 py-2 bg-transparent border border-global-stroke-highlight-2nd text-global-inactive hover:text-global-blanc rounded-[10px] text-xs transition-colors"
                 >
                   {t('pricing.cancel')}
                 </button>
            </div>
        </form>
   );
   
   const renderPriceForm = () => (
        <form onSubmit={handleSavePriceOverride} className="flex flex-col gap-3 text-left">
            {selectedView === 'group' && (
              <p className="text-xs text-global-inactive font-p1-font-family">
                {t('pricing.groupPriceNote')}
              </p>
            )}
            <div>
              <label className="text-xs font-medium text-global-inactive mb-1 block">{t('pricing.selectedPeriod')}</label>
              <p className="text-sm font-medium text-global-blanc bg-global-bg-small-box border border-global-stroke-box rounded-[10px] p-2 mt-1">
                {selectionStart} {language === 'en' ? 'to' : 'au'} {selectionEnd}
              </p>
            </div>
            <div>
                <label className="text-xs font-medium text-global-inactive mb-1 block">{t('pricing.newPricePerNight')} ({currencyLabel})</label>
                <input 
                    type="number" 
                    value={manualPrice} 
                    onChange={(e) => setManualPrice(e.target.value)}
                    className="w-full bg-global-bg-small-box border border-global-stroke-box rounded-[10px] px-3 py-2 text-global-blanc placeholder:text-global-inactive focus:outline-none focus:ring-2 focus:ring-global-content-highlight-2nd mt-1" 
                    placeholder="Ex: 175" 
                    required 
                    min="0" 
                />
            </div>
             <div className="flex items-center gap-2 pt-1">
                <input
                    type="checkbox"
                    id="lockPrice"
                    checked={isPriceLocked}
                    onChange={(e) => setIsPriceLocked(e.target.checked)}
                    className="w-5 h-5 rounded border border-global-content-highlight-2nd bg-transparent text-global-content-highlight-2nd focus:ring-2 focus:ring-global-content-highlight-2nd cursor-pointer"
                />
                <label htmlFor="lockPrice" className="text-xs text-global-inactive font-p1-font-family cursor-pointer">
                    {t('pricing.lockPrice')}
                </label>
            </div>
            <div className="flex gap-2 pt-2">
                <button 
                  type="submit" 
                  disabled={isLoading} 
                  className="flex-grow bg-gradient-to-r from-[#155dfc] to-[#12a1d5] hover:opacity-90 text-white font-h3-font-family font-h3-font-weight text-h3-font-size py-2 px-4 rounded-[10px] transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {isLoading ? t('pricing.save') : t('pricing.applyPrice')}
                </button>
                 <button 
                   type="button" 
                   onClick={clearSelection} 
                   className="px-3 py-2 bg-transparent border border-global-stroke-highlight-2nd text-global-inactive hover:text-global-blanc rounded-[10px] text-xs transition-colors"
                 >
                   {t('pricing.cancel')}
                 </button>
            </div>
        </form>
   );

   
   const handleViewChange = (e) => {
       console.log('[handleViewChange] Début - value:', e.target.value);
       const [type, id] = e.target.value.split('-');
       if (!type || !id) {
           console.log('[handleViewChange] Valeur invalide, réinitialisation');
           setSelectedView('property'); // Fallback
           setSelectedId('');
           setIsCalendarLoading(false);
           setPriceOverrides({});
           setBookings({});
           return;
       }
       console.log('[handleViewChange] Changement vers - type:', type, 'id:', id);
       
       // Détecter si c'est un groupe en cherchant dans la liste fusionnée
       const selectedItem = properties.find(p => p.id === id);
       const isGroup = selectedItem?.isGroup === true;
       
       // Réinitialiser l'état de chargement et les données avant de changer
       setIsCalendarLoading(true);
       setPriceOverrides({});
       setBookings({});
       clearSelection();
       setSelectedDateForAnalysis(null);
       
       // Changer la sélection (cela déclenchera fetchCalendarData via useEffect)
       if (isGroup) {
           // Pour un groupe, on utilise 'group' comme view et l'ID du groupe
           setSelectedView('group');
           setSelectedId(selectedItem.groupId);
       } else {
           // Pour une propriété, on utilise 'property' comme view et l'ID de la propriété
           setSelectedView('property');
           setSelectedId(id);
       }
       console.log('[handleViewChange] États mis à jour - selectedView:', isGroup ? 'group' : 'property', 'selectedId:', isGroup ? selectedItem.groupId : id);
   };
   
   const getSelectedValue = () => {
       if (!selectedId) return '';
       // Trouver l'item correspondant pour déterminer si c'est un groupe
       let itemId = selectedId;
       if (selectedView === 'group') {
           // Si c'est un groupe, trouver l'item qui correspond à ce groupe
           const group = allGroups.find(g => g.id === selectedId);
           if (group) {
               itemId = group.main_property_id;
           }
       }
       // Toujours utiliser 'property-' car dans le sélecteur, tous les items utilisent ce préfixe
       return `property-${itemId}`;
   };


  const getSelectedPropertyName = () => {
    if (!selectedId) return t('pricing.selectProperty');
    if (selectedView === 'property') {
      const prop = properties.find(p => p.id === selectedId);
      return prop?.address || t('pricing.unknownProperty');
    } else {
      const group = allGroups.find(g => g.id === selectedId);
      return group?.name || t('pricing.unknownGroup');
    }
  };

  return (
    <div className="relative min-h-screen">
      {/* Fond qui couvre tout l'écran avec le même dégradé */}
      <div
        className="fixed inset-0"
        style={{
          background:
            'linear-gradient(135deg, rgba(2,6,24,1) 0%, rgba(22,36,86,1) 45%, rgba(15,23,43,1) 100%)',
          zIndex: 0,
        }}
      />
      <div className="relative z-10 space-y-6 p-4 md:p-6 lg:p-8">
        {error && <p className="bg-red-900/50 text-red-300 p-3 rounded-md text-sm">{error}</p>}
      
      <div className="md:flex gap-6">
        <div className="flex-grow self-stretch p-8 bg-global-bg-box rounded-[14px] border border-solid border-global-stroke-box flex flex-col items-start gap-6">
          {/* Header avec sélecteur et navigation mois */}
          <header className="flex items-center justify-between relative self-stretch w-full flex-[0_0_auto]">
            {/* Sélecteur de propriété */}
            <select 
              id="view-selector" 
              value={getSelectedValue()} 
              onChange={handleViewChange}
              className="w-80 h-9 bg-global-bg-small-box rounded-lg border border-solid border-global-stroke-box px-3 py-0 text-center font-h3-font-family font-h3-font-weight text-global-blanc text-h3-font-size leading-h3-line-height appearance-none cursor-pointer focus:outline-none hover:opacity-90 transition-opacity"
              disabled={isLoading || iaLoading}
            >
              <option value="">{t('pricing.select')}</option>
              {properties.map(item => (
                <option key={item.id} value={`property-${item.id}`}>
                  {item.isGroup ? item.name : (item.address || item.name)}
                </option>
              ))}
            </select>
            
            {/* Navigation mois */}
            <nav
              className="inline-flex h-8 items-center gap-3 relative flex-[0_0_auto]"
              aria-label="Month navigation"
            >
              <button 
                id="prev-month-btn" 
                onClick={() => { setCurrentCalendarDate(prev => new Date(prev.getFullYear(), prev.getMonth() - 1, 1)); clearSelection(); setSelectedDateForAnalysis(null); }} 
                className="cursor-pointer hover:opacity-70 transition-opacity"
                aria-label="Previous month"
              >
                <ArrowLeftIcon />
              </button>
              <time className="relative w-[150px] font-h4-font-family font-h4-font-weight text-global-blanc text-h4-font-size text-center leading-h4-line-height">
                {currentCalendarDate.toLocaleDateString(language === 'en' ? 'en-US' : 'fr-FR', { month: 'long', year: 'numeric' })}
              </time>
              <button 
                id="next-month-btn" 
                onClick={() => { setCurrentCalendarDate(prev => new Date(prev.getFullYear(), prev.getMonth() + 1, 1)); clearSelection(); setSelectedDateForAnalysis(null); }} 
                className="cursor-pointer hover:opacity-70 transition-opacity"
                aria-label="Next month"
              >
                <ArrowRightIcon />
              </button>
            </nav>
          </header>

          {/* Grille calendrier */}
          <section className="flex flex-col items-start gap-3 relative self-stretch w-full flex-[0_0_auto]">
            {/* En-têtes jours */}
            <header className="flex items-center justify-between px-9 py-0 relative self-stretch w-full flex-[0_0_auto]">
              {(language === 'en' ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] : ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim']).map((day, index) => (
                <div
                  key={index}
                  className="relative w-fit mt-[-1.00px] font-p1-font-family font-p1-font-weight text-global-inactive text-p1-font-size text-center leading-p1-line-height"
                >
                  {day}
                </div>
              ))}
            </header>
            
            {/* Grille des jours */}
            <div id="calendar-grid" className="self-stretch h-[458px] grid grid-cols-7 gap-2 select-none relative">
              {renderCalendar()}
              {/* Overlay de chargement sur le calendrier */}
              {iaLoading && (
                <div className="absolute inset-0 bg-black/70 backdrop-blur-sm rounded-[10px] flex items-center justify-center z-10">
                  <div className="bg-global-bg-box border border-global-content-highlight-2nd rounded-[10px] p-4 flex flex-col items-center gap-3">
                    <svg className="animate-spin w-8 h-8 text-global-content-highlight-2nd" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    <span className="text-global-blanc text-sm font-h3-font-family font-h3-font-weight">
                      {t('pricing.strategy.generating')}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Légende */}
          <section
            className="flex items-start justify-center gap-6 pt-4 pb-0 px-0 self-stretch w-full border-t border-solid border-global-stroke-box relative flex-[0_0_auto]"
            role="region"
            aria-label="Calendar legends"
          >
            <div className="inline-flex items-center gap-2 relative flex-[0_0_auto]">
              <div className="w-3 h-3 bg-calendrierbg-vert rounded border border-solid border-calendrierstroke-vert relative" role="img" aria-label="Sélection prix indicator" />
              <span className="relative w-fit mt-[-1.00px] font-p1-font-family font-p1-font-weight text-global-inactive text-p1-font-size leading-p1-line-height">
                {t('pricing.legend.priceSelection')}
              </span>
            </div>
            <div className="inline-flex items-center gap-2 relative flex-[0_0_auto]">
              <div className="w-3 h-3 bg-calendrierbg-orange rounded border border-solid border-calendrierstroke-orange relative" role="img" aria-label="Réservé indicator" />
              <span className="relative w-fit mt-[-1.00px] font-p1-font-family font-p1-font-weight text-global-inactive text-p1-font-size leading-p1-line-height">
                {t('pricing.legend.booked')}
              </span>
            </div>
            <div className="inline-flex items-center gap-2 relative flex-[0_0_auto]">
              <div className="w-3 h-3 bg-calendrierbg-bleu rounded border border-solid border-calendrierstroke-bleu relative" role="img" aria-label="Sélection résa indicator" />
              <span className="relative w-fit mt-[-1.00px] font-p1-font-family font-p1-font-weight text-global-inactive text-p1-font-size leading-p1-line-height">
                {t('pricing.legend.bookingSelection')}
              </span>
            </div>
          </section>
        </div>
        
        {/* Zone Outils - Layout Figma */}
        <div id="edit-panel" className="flex flex-col gap-1 items-start justify-start self-stretch shrink-0 relative w-full md:w-[394px]">
          {/* Stratégie IA (Prix) */}
          <div className="bg-global-bg-box rounded-[14px] border border-solid border-global-stroke-box p-6 flex flex-col gap-3 items-start justify-start shrink-0 w-full relative">
            <div className="text-global-blanc text-left font-h2-font-family text-h2-font-size font-h2-font-weight relative">
              {t('pricing.strategy.title')}
            </div>
            <div className="text-global-inactive text-left font-h4-font-family text-h4-font-size leading-h4-line-height font-h4-font-weight relative self-stretch">
              {t('pricing.strategy.description')}
            </div>
            
            {/* Feedback de chargement du pricing */}
            {iaLoading && (
              <div className="w-full bg-global-bg-small-box border border-global-content-highlight-2nd rounded-[10px] p-4 flex items-center gap-3 animate-pulse">
                <div className="relative w-5 h-5 shrink-0">
                  <svg className="animate-spin w-5 h-5 text-global-content-highlight-2nd" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                </div>
                <div className="flex flex-col gap-1 flex-1">
                  <span className="text-global-blanc text-sm font-h3-font-family font-h3-font-weight">
                    {t('pricing.strategy.generating')}
                  </span>
                  <span className="text-global-inactive text-xs font-p1-font-family">
                    {t('pricing.strategy.generatingDescription')}
                  </span>
                </div>
              </div>
            )}
            
            {/* Messages de succès/erreur pour l'auto-pricing */}
            {autoPricingSuccess && !iaLoading && (
              <div className="w-full bg-green-900/20 border border-green-500/50 rounded-[10px] p-3 flex items-start gap-2">
                <svg className="w-5 h-5 text-green-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-green-300 text-sm font-p1-font-family">{autoPricingSuccess}</span>
              </div>
            )}
            
            {autoPricingError && !iaLoading && (
              <div className="w-full bg-red-900/20 border border-red-500/50 rounded-[10px] p-3 flex items-start gap-2">
                <svg className="w-5 h-5 text-red-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-red-300 text-sm font-p1-font-family">{autoPricingError}</span>
              </div>
            )}
            
            {/* Toggle "Automatiser le pricing" */}
            <div 
              className={`bg-global-stroke-highlight-2nd rounded-[10px] border border-solid border-global-content-highlight-2nd pt-2 pr-3 pb-2 pl-3 flex flex-row gap-3 items-center justify-center self-stretch shrink-0 h-[46px] relative transition-opacity ${iaLoading || isQuotaReached ? 'opacity-50 cursor-not-allowed' : isAutoGenerationEnabled ? 'opacity-100 cursor-pointer hover:opacity-90' : 'opacity-70 cursor-pointer hover:opacity-90'}`}
              onClick={iaLoading || isQuotaReached ? undefined : () => handleToggleAutoGeneration(!isAutoGenerationEnabled)}
            >
              <div className={`relative w-5 h-5 shrink-0`}>
                {isAutoGenerationEnabled ? (
                  <div className="w-5 h-5 bg-global-content-highlight-2nd rounded flex items-center justify-center">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M10 3L4.5 8.5L2 6" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </div>
                ) : (
                  <div className="w-5 h-5 border border-global-content-highlight-2nd rounded bg-transparent" />
                )}
              </div>
              <div className="text-global-blanc text-left font-h3-font-family text-h3-font-size font-h3-font-weight relative">
                {t('pricing.strategy.automate')}
              </div>
            </div>

            {/* Boutons Ajouter Réservation et Définir Prix */}
            <div className="flex flex-row gap-3 items-start justify-start self-stretch shrink-0 relative">
              <Bouton
                state="principal"
                text={t('pricing.strategy.addBooking')}
                onClick={iaLoading ? undefined : () => { 
                  setSelectionMode('booking');
                  // Réinitialiser uniquement les champs du formulaire, pas la sélection
                  setBookingPrice('');
                  setBookingChannel('Direct');
                  setManualPrice('');
                  setIsPriceLocked(true);
                }}
                className={iaLoading ? 'opacity-50 cursor-not-allowed' : selectionMode === 'booking' ? 'opacity-100' : 'opacity-70'}
                disabled={iaLoading}
              />
              
              <button
                onClick={iaLoading ? undefined : () => { 
                  setSelectionMode('price');
                  // Réinitialiser uniquement les champs du formulaire, pas la sélection
                  setBookingPrice('');
                  setBookingChannel('Direct');
                  setManualPrice('');
                  setIsPriceLocked(true);
                }}
                disabled={iaLoading}
                className={`inline-flex items-center justify-center gap-2 px-3 py-2 relative flex-1 rounded-[10px] border border-solid border-global-stroke-highlight-2nd transition-opacity ${
                  iaLoading 
                    ? 'opacity-50 cursor-not-allowed bg-transparent text-global-inactive'
                    : selectionMode === 'price' 
                      ? 'bg-global-stroke-highlight-2nd text-global-blanc cursor-pointer hover:opacity-90' 
                      : 'bg-transparent text-global-inactive cursor-pointer hover:opacity-90'
                }`}
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="w-5 h-5">
                  <path d="M10 2L2 7L10 12L18 7L10 2Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M2 13L10 18L18 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M2 10L10 15L18 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <span className="relative w-fit font-h3-font-family font-h3-font-weight text-h3-font-size leading-h3-line-height">
                  {t('pricing.strategy.setPrice')}
                </span>
              </button>
            </div>

            {/* Zone de formulaire (réservation ou prix) */}
            <div className="border-t border-solid border-global-stroke-box pt-4 flex flex-row gap-6 items-start justify-center self-stretch shrink-0 relative">
              {!selectionStart ? (
                <div className="text-global-inactive text-left font-h4-font-family text-h4-font-size leading-h4-line-height font-h4-font-weight relative self-stretch">
                  {t('pricing.selectPeriod')}
                </div>
              ) : (
                <div className="self-stretch w-full">
                  {selectionMode === 'booking' ? renderBookingForm() : renderPriceForm()}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      </div>

      {/* Modale d'alerte */}
      <AlertModal
        isOpen={alertModal.isOpen}
        onClose={() => setAlertModal({ isOpen: false, message: '', title: t('pricing.modal.information') })}
        title={alertModal.title}
        message={alertModal.message}
        buttonText={t('pricing.modal.ok')}
      />
    </div>
  );
}

export default PricingPage;


