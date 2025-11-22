import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { getProperties, generatePricingStrategy, addBooking, getBookingsForMonth, getGroups, updateGroup, getUserProfile, getPropertySpecificNews, getAutoPricingStatus, enableAutoPricing, getPriceOverrides, updatePriceOverrides } from '../services/api.js';
import { jwtDecode } from 'jwt-decode'; 
// Firebase n'est plus utilisé directement 
import PropertyNewsFeed from '../components/PropertyNewsFeed.jsx';
import DateAnalysis from '../components/DateAnalysis.jsx';
import Bouton from '../components/Bouton.jsx';
import AlertModal from '../components/AlertModal.jsx'; 

// Firebase n'est plus utilisé directement côté client pour les price_overrides
// On utilise maintenant l'API backend


function PricingPage({ token, userProfile }) {
  const [properties, setProperties] = useState([]);
  const [allGroups, setAllGroups] = useState([]);
  const [selectedView, setSelectedView] = useState('property'); 
  const [selectedId, setSelectedId] = useState(''); 

  const [currentCalendarDate, setCurrentCalendarDate] = useState(new Date());
  const [priceOverrides, setPriceOverrides] = useState({});
  const [bookings, setBookings] = useState({}); 
  const [isLoading, setIsLoading] = useState(true); 
  const [error, setError] = useState('');
  const [iaLoading, setIaLoading] = useState(false);
  const [isAutoGenerationEnabled, setIsAutoGenerationEnabled] = useState(false);
  const [autoPricingTimezone, setAutoPricingTimezone] = useState('Europe/Paris');
  const [autoPricingLastRun, setAutoPricingLastRun] = useState(null);
  const [isLoadingAutoPricing, setIsLoadingAutoPricing] = useState(true);
  const [autoPricingSuccess, setAutoPricingSuccess] = useState('');
  const [autoPricingError, setAutoPricingError] = useState(''); 

  const [selectionStart, setSelectionStart] = useState(null);
  const [selectionEnd, setSelectionEnd] = useState(null);
  const [isSelecting, setIsSelecting] = useState(false);
  
  const [selectionMode, setSelectionMode] = useState('booking'); 
  
  // States pour les formulaires
  const [bookingPrice, setBookingPrice] = useState('');
  const [bookingChannel, setBookingChannel] = useState('Direct');
  const [manualPrice, setManualPrice] = useState('');
  const [isPriceLocked, setIsPriceLocked] = useState(true); 

  // State pour les actualités spécifiques
  const [propertyNews, setPropertyNews] = useState([]);
  const [isNewsLoading, setIsNewsLoading] = useState(false);
  const [newsError, setNewsError] = useState('');

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
      const [propertiesData, groupsData] = await Promise.all([
          getProperties(token),
          getGroups(token)
      ]);
      
      setProperties(propertiesData);
      setAllGroups(groupsData);
      
      if (propertiesData.length > 0) {
        setSelectedView('property');
        setSelectedId(propertiesData[0].id);
      } else if (groupsData.length > 0) {
           setSelectedView('group');
           setSelectedId(groupsData[0].id);
      }
      
    } catch (err) {
      setError(`Erreur de chargement des données: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  }, [token, userProfile]); 

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
        let userId = null;
        try {
          const decodedToken = jwtDecode(token);
          userId = decodedToken?.user_id || decodedToken?.uid;
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
        setAutoPricingError(`Erreur lors du chargement: ${err.message || 'Impossible de charger l\'état actuel.'}`);
        // En cas d'erreur, on garde les valeurs par défaut
        setIsAutoGenerationEnabled(false);
        setAutoPricingTimezone(userProfile?.timezone || 'Europe/Paris');
      } finally {
        setIsLoadingAutoPricing(false);
      }
    };

    loadAutoPricingStatus();
  }, [token, userProfile]);

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
      const formatter = new Intl.DateTimeFormat('fr-FR', {
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
      return 'demain à 00h00';
    }
  }, [isAutoGenerationEnabled, autoPricingTimezone]);

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
      const formatter = new Intl.DateTimeFormat('fr-FR', {
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
  }, [autoPricingLastRun, autoPricingTimezone, userProfile?.timezone]);

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
               Object.keys(overridesData).forEach(date => {
                   if (overridesData[date].isLocked) {
                       lockedPricesMap.set(`${propId}-${date}`, overridesData[date].price);
                   }
               });
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
      return { success: true, propertyCount: propertyIdsToUpdate.length, summary: strategy.strategy_summary };
    } catch (err) {
      console.error("Erreur lors de l'application de la stratégie:", err);
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

    const newTimezone = autoPricingTimezone || userProfile?.timezone || 'Europe/Paris';
    
    // Mettre à jour l'état local immédiatement pour une meilleure UX
    setIsAutoGenerationEnabled(newEnabled);
    
    try {
      // Obtenir l'userId depuis le token
      let userId = null;
      try {
        const decodedToken = jwtDecode(token);
        userId = decodedToken?.user_id || decodedToken?.uid;
      } catch (decodeError) {
        console.error("Erreur de décodage du token:", decodeError);
        setAutoPricingError("Erreur d'authentification. Veuillez vous reconnecter.");
        setIsAutoGenerationEnabled(!newEnabled); // Revenir à l'état précédent
        return;
      }

      if (!userId) {
        setAutoPricingError("Impossible de récupérer l'identifiant utilisateur.");
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
                          setAutoPricingError("Veuillez définir une propriété principale pour ce groupe avant d'activer la génération automatique.");
                          setIsAutoGenerationEnabled(false);
                          return;
                      }
                      propertyIdToAnalyze = group.mainPropertyId;
                      groupToSync = null;
                  } else {
                      if (!group.mainPropertyId) {
                          setAutoPricingError("Veuillez définir une propriété principale pour ce groupe avant d'activer la génération automatique.");
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
                      setAutoPricingError("Aucune propriété disponible pour générer les prix.");
                      setIsAutoGenerationEnabled(false);
                      return;
                  }
              }
          }

          if (!propertyIdToAnalyze) {
              setAutoPricingError("Veuillez sélectionner une propriété ou un groupe valide.");
              setIsAutoGenerationEnabled(false);
              return;
          }

          // Appliquer la stratégie immédiatement
          setAutoPricingSuccess('Génération automatique activée. Génération des prix en cours...');
          const result = await applyPricingStrategy(propertyIdToAnalyze, groupToSync);
          
          setAutoPricingSuccess(`Génération automatique activée. Prix mis à jour pour ${result.propertyCount} propriété(s). Les prix seront régénérés tous les jours à 00h00 (${timezoneToUse}).`);
        } catch (pricingError) {
          console.error("Erreur lors de la génération immédiate des prix:", pricingError);
          setAutoPricingError(`Génération automatique activée, mais erreur lors de la génération immédiate: ${pricingError.message}`);
          // On garde le toggle activé même si la génération immédiate échoue
          // car la génération automatique quotidienne fonctionnera quand même
        }
      } else {
        setAutoPricingSuccess('Génération automatique désactivée.');
      }

      // Effacer le message de succès après 5 secondes
      setTimeout(() => {
        setAutoPricingSuccess('');
      }, 5000);

    } catch (err) {
      console.error("Erreur lors de la mise à jour de la génération automatique:", err);
      setAutoPricingError(`Erreur: ${err.message || 'Impossible de sauvegarder la préférence.'}`);
      // Revenir à l'état précédent en cas d'erreur
      setIsAutoGenerationEnabled(!newEnabled);
      
      // Effacer le message d'erreur après 7 secondes
      setTimeout(() => {
        setAutoPricingError('');
      }, 7000);
    }
  }; 


  const fetchCalendarData = useCallback(async () => {
    if (!selectedId || isLoading) return; 
    
    let propertyIdToFetch;
    let currentProperty; 

    if (selectedView === 'property') {
        propertyIdToFetch = selectedId;
        currentProperty = properties.find(p => p.id === selectedId);
    } else { 
        const group = allGroups.find(g => g.id === selectedId);
        if (!group) return;
        propertyIdToFetch = group.mainPropertyId || group.properties?.[0];
        currentProperty = properties.find(p => p.id === propertyIdToFetch);
    }

    if (!propertyIdToFetch || !currentProperty) {
         setPriceOverrides({});
         setBookings({});
         return; 
    }

    // Lancer le fetch des actualités spécifiques en parallèle
    fetchSpecificNews(propertyIdToFetch);

    try {
      const year = currentCalendarDate.getFullYear();
      const month = currentCalendarDate.getMonth();
      const startOfMonth = `${year}-${String(month + 1).padStart(2, '0')}-01`;
      const endOfMonth = `${year}-${String(month + 1).padStart(2, '0')}-31`;
      
      // Fetch Overrides via API backend
      const overridesData = await getPriceOverrides(propertyIdToFetch, token, startOfMonth, endOfMonth);
      const newOverrides = {};
      Object.keys(overridesData).forEach(date => {
        newOverrides[date] = overridesData[date].price;
      });
      setPriceOverrides(newOverrides);

      // Fetch Bookings
      const bookingsData = await getBookingsForMonth(propertyIdToFetch, year, month, token);
      const newBookings = {};
      bookingsData.forEach(booking => {
          let currentDate = new Date(booking.startDate);
          const endDate = new Date(booking.endDate);
          while (currentDate < endDate) { 
              const dateStr = currentDate.toISOString().split('T')[0];
              newBookings[dateStr] = booking;
              currentDate.setDate(currentDate.getDate() + 1);
          }
      });
      setBookings(newBookings);
      
    } catch (err) {
      console.error("Erreur de chargement des données calendrier:", err);
      setError(`Erreur calendrier: ${err.message}`);
      setPriceOverrides({});
      setBookings({});
    }
  }, [selectedId, selectedView, currentCalendarDate, token, properties, allGroups, isLoading]); 

   useEffect(() => {
      fetchCalendarData();
  }, [fetchCalendarData]); 

  // Nouvelle fonction pour charger les actualités spécifiques
  const fetchSpecificNews = useCallback(async (propertyId) => {
    if (!propertyId || !token) {
        setPropertyNews([]); // Vider si pas d'ID
        return;
    }
    setIsNewsLoading(true);
    setNewsError('');
    try {
        const data = await getPropertySpecificNews(propertyId, token);
        setPropertyNews(data);
    } catch (err) {
        setNewsError(`Erreur actus: ${err.message}`);
    } finally {
        setIsNewsLoading(false);
    }
  }, [token]);


  const handleGenerateStrategy = async () => {
    let propertyIdToAnalyze;
    let groupToSync = null;

    if (selectedView === 'property') {
        propertyIdToAnalyze = selectedId;
    } else { // 'group'
        const group = allGroups.find(g => g.id === selectedId);
        if (!group) {
             setError("Groupe non trouvé.");
             return;
        }
        if (!group.syncPrices) {
             setAlertModal({ isOpen: true, message: "La synchronisation des prix n'est pas activée pour ce groupe. La stratégie ne sera appliquée qu'à la propriété principale.", title: 'Information' });
             if (!group.mainPropertyId) {
                 setAlertModal({ isOpen: true, message: "Veuillez définir une propriété principale pour ce groupe avant de générer une stratégie.", title: 'Attention' });
                 return;
             }
             propertyIdToAnalyze = group.mainPropertyId;
             groupToSync = null; // Ne pas synchroniser si la case n'est pas cochée
        } else {
            // Synchro activée
             if (!group.mainPropertyId) {
                 setAlertModal({ isOpen: true, message: "Veuillez définir une propriété principale pour ce groupe (dans l'onglet Dashboard) avant de générer une stratégie.", title: 'Attention' });
                 return;
             }
            propertyIdToAnalyze = group.mainPropertyId;
            groupToSync = group; // Passer le groupe pour la synchro
        }
    }
    
    if (!propertyIdToAnalyze) {
      setError('Veuillez sélectionner une propriété ou un groupe valide.');
      return;
    }
    if (!token) {
       setError("Connexion non prête. Veuillez patienter.");
       return;
    }

    try {
      const result = await applyPricingStrategy(propertyIdToAnalyze, groupToSync);
      setAlertModal({ isOpen: true, message: `Stratégie IA appliquée avec succès à ${result.propertyCount} propriété(s) ! ${result.summary || ''}`, title: 'Succès' });
    } catch (err) {
      setError(`Erreur de génération de stratégie: ${err.message}`);
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
        const startDate = new Date(selectionStart);
        const hoverDate = new Date(dateStr);
        let currentDateCheck = new Date(Math.min(startDate, hoverDate));
        const endDateCheck = new Date(Math.max(startDate, hoverDate));
        
        if (selectionMode === 'booking') {
            let hasBookingInRange = false;
            while(currentDateCheck <= endDateCheck){
                const checkDateStr = currentDateCheck.toISOString().split('T')[0];
                if(bookings[checkDateStr]){
                    hasBookingInRange = true;
                    break;
                }
                currentDateCheck.setDate(currentDateCheck.getDate() + 1);
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
                setError("Veuillez définir une propriété principale pour ce groupe avant d'ajouter une réservation.");
                return;
           }
           propertyIdForBooking = group.mainPropertyId;
       }
       
      if (!selectionStart || !selectionEnd || !bookingPrice || !propertyIdForBooking) return;
      
      const pricePerNightNum = parseInt(bookingPrice, 10);
      if (isNaN(pricePerNightNum) || pricePerNightNum <= 0) {
          setError("Veuillez entrer un prix par nuit valide.");
          return;
      }
      
       const start = new Date(selectionStart);
       const end = new Date(selectionEnd);
       
       let currentDateCheck = new Date(start);
       while(currentDateCheck <= end) {
           const dateStr = currentDateCheck.toISOString().split('T')[0];
           if (bookings[dateStr]) {
               setError(`La période sélectionnée contient des jours déjà réservés (${dateStr}). Veuillez choisir une autre période.`);
               return;
           }
           currentDateCheck.setDate(currentDateCheck.getDate() + 1);
       }
       
       const endDateForCalc = new Date(end);
       endDateForCalc.setDate(endDateForCalc.getDate() + 1); 
       const nights = Math.round((endDateForCalc - start) / (1000 * 60 * 60 * 24));
       if (nights <= 0) {
            setError("La date de fin doit être après la date de début.");
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
          
          setAlertModal({ isOpen: true, message: 'Réservation ajoutée avec succès !', title: 'Succès' });
          clearSelection();
          fetchCalendarData(); 
      } catch (err) {
          setError(`Erreur lors de l'ajout de la réservation: ${err.message}`);
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
              setError("Groupe non trouvé.");
              return;
          }
          if (!group.syncPrices) {
              setAlertModal({ isOpen: true, message: "La synchronisation des prix n'est pas activée pour ce groupe. Le prix ne sera appliqué qu'à la propriété principale.", title: 'Information' });
              propertyIdsToUpdate = [group.mainPropertyId].filter(Boolean); 
          } else {
              propertyIdsToUpdate = group.properties || []; 
          }
      }

      if (!selectionStart || !selectionEnd || !manualPrice || propertyIdsToUpdate.length === 0) {
          setError("Sélection de dates, prix, et propriété/groupe valide requis.");
          return;
      }
      
      const priceNum = parseInt(manualPrice, 10);
      if (isNaN(priceNum) || priceNum < 0) {
          setError("Veuillez entrer un prix valide (0 ou plus).");
          return;
      }

      setIsLoading(true);
      setError('');
      try {
          // Préparer les overrides pour chaque propriété
          let currentDate = new Date(selectionStart);
          const endDate = new Date(selectionEnd);
          
          // Mettre à jour chaque propriété via l'API backend
          for (const propId of propertyIdsToUpdate) {
              const overridesToUpdate = [];
              let dateIterator = new Date(selectionStart);
              
              while(dateIterator <= endDate) {
                  const dateStr = dateIterator.toISOString().split('T')[0];
                  overridesToUpdate.push({
                      date: dateStr,
                      price: priceNum,
                      isLocked: isPriceLocked,
                      reason: "Manuel"
                  });
                  dateIterator.setDate(dateIterator.getDate() + 1);
              }
              
              if (overridesToUpdate.length > 0) {
                  await updatePriceOverrides(propId, overridesToUpdate, token);
              }
          }
          setAlertModal({ isOpen: true, message: `Prix manuels appliqués à ${propertyIdsToUpdate.length} propriété(s) !`, title: 'Succès' });
          clearSelection();
          fetchCalendarData(); 
      } catch (err) {
          setError(`Erreur lors de la sauvegarde des prix: ${err.message}`);
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
      return (amount || 0).toLocaleString('fr-FR', { 
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
    
    if (isLoading || !selectedId || !currentProperty) {
         return <div className="grid grid-cols-7 gap-3"><p className="text-center p-4 text-global-inactive col-span-7">Chargement ou sélection requise...</p></div>;
    }
    
    const year = currentCalendarDate.getFullYear();
    const month = currentCalendarDate.getMonth();
    const grid = [];

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
        const isBooked = !!bookings[dateStr];
        const price = isBooked ? bookings[dateStr].pricePerNight : (priceOverrides[dateStr] ?? currentProperty.daily_revenue);
        const currency = userProfile?.currency || 'EUR';
        const priceFormatted = price != null ? `${Math.round(price)}${currency === 'EUR' ? '€' : currency === 'USD' ? '$US' : currency}` : '';
        
        let bgClass = 'bg-global-bg-small-box';
        let borderClass = 'border-global-stroke-box';
        let textColor = 'text-global-blanc';
        let isInSelection = false;
        let isDisabled = false;
        
        // Vérifier si dans la sélection
        if (selectionStart && selectionEnd) {
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
                onMouseDown={!isDisabled ? () => handleMouseDown(dateStr) : undefined}
                onMouseEnter={!isDisabled ? () => handleMouseOver(dateStr) : undefined}
            >
                <div className={`${textColor} relative w-fit font-h3-font-family font-h3-font-weight text-h3-font-size text-center leading-h3-line-height`}>
                  {day}
                </div>
                {priceFormatted && (
                  <div className={`relative w-fit font-h4-font-family font-h4-font-weight text-global-blanc text-h4-font-size text-center leading-h4-line-height whitespace-nowrap`}>
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
                <label className="text-xs font-medium text-global-inactive mb-1 block">Période sélectionnée</label>
                <p className="text-sm font-medium text-global-blanc bg-global-bg-small-box border border-global-stroke-box rounded-[10px] p-2 mt-1">
                  {selectionStart} au {selectionEnd}
                </p>
            </div>
            <div>
                <label className="text-xs font-medium text-global-inactive mb-1 block">Prix / Nuit ({currencyLabel})</label>
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
                <label className="text-xs font-medium text-global-inactive mb-1 block">Canal</label>
                <select 
                  value={bookingChannel} 
                  onChange={(e) => setBookingChannel(e.target.value)} 
                  className="w-full bg-global-bg-small-box border border-global-stroke-box rounded-[10px] px-3 py-2 text-global-blanc focus:outline-none focus:ring-2 focus:ring-global-content-highlight-2nd mt-1"
                >
                    <option value="Direct">Direct</option>
                    <option value="Airbnb">Airbnb</option>
                    <option value="Booking">Booking.com</option>
                    <option value="VRBO">VRBO</option>
                    <option value="Autre">Autre</option>
                </select>
            </div>
            <div className="flex gap-2 pt-2">
                <button 
                  type="submit" 
                  disabled={isLoading} 
                  className="flex-grow bg-gradient-to-r from-[#155dfc] to-[#12a1d5] hover:opacity-90 text-white font-h3-font-family font-h3-font-weight text-h3-font-size py-2 px-4 rounded-[10px] transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {isLoading ? 'Sauvegarde...' : 'Enregistrer Résa.'}
                </button>
                 <button 
                   type="button" 
                   onClick={clearSelection} 
                   className="px-3 py-2 bg-transparent border border-global-stroke-highlight-2nd text-global-inactive hover:text-global-blanc rounded-[10px] text-xs transition-colors"
                 >
                   Annuler
                 </button>
            </div>
        </form>
   );
   
   const renderPriceForm = () => (
        <form onSubmit={handleSavePriceOverride} className="flex flex-col gap-3 text-left">
            {selectedView === 'group' && (
              <p className="text-xs text-global-inactive font-p1-font-family">
                Le prix sera appliqué à toutes les propriétés synchronisées de ce groupe.
              </p>
            )}
            <div>
              <label className="text-xs font-medium text-global-inactive mb-1 block">Période sélectionnée</label>
              <p className="text-sm font-medium text-global-blanc bg-global-bg-small-box border border-global-stroke-box rounded-[10px] p-2 mt-1">
                {selectionStart} au {selectionEnd}
              </p>
            </div>
            <div>
                <label className="text-xs font-medium text-global-inactive mb-1 block">Nouveau Prix / Nuit ({currencyLabel})</label>
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
                    Verrouiller ce prix (l'IA ne le modifiera pas)
                </label>
            </div>
            <div className="flex gap-2 pt-2">
                <button 
                  type="submit" 
                  disabled={isLoading} 
                  className="flex-grow bg-gradient-to-r from-[#155dfc] to-[#12a1d5] hover:opacity-90 text-white font-h3-font-family font-h3-font-weight text-h3-font-size py-2 px-4 rounded-[10px] transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {isLoading ? 'Sauvegarde...' : 'Appliquer Prix'}
                </button>
                 <button 
                   type="button" 
                   onClick={clearSelection} 
                   className="px-3 py-2 bg-transparent border border-global-stroke-highlight-2nd text-global-inactive hover:text-global-blanc rounded-[10px] text-xs transition-colors"
                 >
                   Annuler
                 </button>
            </div>
        </form>
   );

   
   const handleViewChange = (e) => {
       const [type, id] = e.target.value.split('-');
       if (!type || !id) {
           setSelectedView('property'); // Fallback
           setSelectedId('');
           return;
       }
       setSelectedView(type);
       setSelectedId(id);
       clearSelection();
       setSelectedDateForAnalysis(null); // Réinitialiser l'analyse
   };
   
   const getSelectedValue = () => {
       if (!selectedId) return '';
       return `${selectedView}-${selectedId}`;
   };


  const getSelectedPropertyName = () => {
    if (!selectedId) return 'Sélectionnez une propriété';
    if (selectedView === 'property') {
      const prop = properties.find(p => p.id === selectedId);
      return prop?.address || 'Propriété inconnue';
    } else {
      const group = allGroups.find(g => g.id === selectedId);
      return group?.name || 'Groupe inconnu';
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
              <option value="">-- Sélectionnez --</option>
              <optgroup label="Groupes">
                {allGroups.map(g => <option key={g.id} value={`group-${g.id}`}>{g.name}</option>)}
              </optgroup>
              <optgroup label="Propriétés Individuelles">
                {properties.map(p => <option key={p.id} value={`property-${p.id}`}>{p.address}</option>)}
              </optgroup>
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
                {currentCalendarDate.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })}
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
              {['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'].map((day, index) => (
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
                Sélection prix
              </span>
            </div>
            <div className="inline-flex items-center gap-2 relative flex-[0_0_auto]">
              <div className="w-3 h-3 bg-calendrierbg-orange rounded border border-solid border-calendrierstroke-orange relative" role="img" aria-label="Réservé indicator" />
              <span className="relative w-fit mt-[-1.00px] font-p1-font-family font-p1-font-weight text-global-inactive text-p1-font-size leading-p1-line-height">
                Réservé
              </span>
            </div>
            <div className="inline-flex items-center gap-2 relative flex-[0_0_auto]">
              <div className="w-3 h-3 bg-calendrierbg-bleu rounded border border-solid border-calendrierstroke-bleu relative" role="img" aria-label="Sélection résa indicator" />
              <span className="relative w-fit mt-[-1.00px] font-p1-font-family font-p1-font-weight text-global-inactive text-p1-font-size leading-p1-line-height">
                Sélection résa
              </span>
            </div>
          </section>
        </div>
        
        {/* Zone Outils - Layout Figma */}
        <div id="edit-panel" className="flex flex-col gap-1 items-start justify-start self-stretch shrink-0 relative w-full md:w-[394px]">
          {/* 1. Analyse du Marché */}
          <DateAnalysis
            token={token}
            date={selectedDateForAnalysis}
            propertyId={propertyIdForAnalysis}
            currentPrice={currentPriceForAnalysis}
            userProfile={userProfile}
          />

          {/* 2. Stratégie IA (Prix) */}
          <div className="bg-global-bg-box rounded-[14px] border border-solid border-global-stroke-box p-6 flex flex-col gap-3 items-start justify-start shrink-0 w-full relative">
            <div className="text-global-blanc text-left font-h2-font-family text-h2-font-size font-h2-font-weight relative">
              Stratégie IA (Prix)
            </div>
            <div className="text-global-inactive text-left font-h4-font-family text-h4-font-size leading-h4-line-height font-h4-font-weight relative self-stretch">
              Générez et appliquez des prix suggérés sur 6 mois.
            </div>
            
            {/* Toggle "Automatiser le pricing" */}
            <div 
              className={`bg-global-stroke-highlight-2nd rounded-[10px] border border-solid border-global-content-highlight-2nd pt-2 pr-3 pb-2 pl-3 flex flex-row gap-3 items-center justify-center self-stretch shrink-0 h-[46px] relative cursor-pointer hover:opacity-90 transition-opacity ${isAutoGenerationEnabled ? 'opacity-100' : 'opacity-70'}`}
              onClick={() => handleToggleAutoGeneration(!isAutoGenerationEnabled)}
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
                Automatiser le pricing
              </div>
            </div>

            {/* Boutons Ajouter Réservation et Définir Prix */}
            <div className="flex flex-row gap-3 items-start justify-start self-stretch shrink-0 relative">
              <Bouton
                state="principal"
                text="Ajouter Réservation"
                onClick={() => { setSelectionMode('booking'); clearSelection(); }}
                className={selectionMode === 'booking' ? 'opacity-100' : 'opacity-70'}
              />
              
              <button
                onClick={() => { setSelectionMode('price'); clearSelection(); }}
                className={`inline-flex items-center justify-center gap-2 px-3 py-2 relative flex-1 rounded-[10px] border border-solid border-global-stroke-highlight-2nd cursor-pointer hover:opacity-90 transition-opacity ${
                  selectionMode === 'price' 
                    ? 'bg-global-stroke-highlight-2nd text-global-blanc' 
                    : 'bg-transparent text-global-inactive'
                }`}
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="w-5 h-5">
                  <path d="M10 2L2 7L10 12L18 7L10 2Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M2 13L10 18L18 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M2 10L10 15L18 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <span className="relative w-fit font-h3-font-family font-h3-font-weight text-h3-font-size leading-h3-line-height">
                  Définir Prix
                </span>
              </button>
            </div>

            {/* Zone de formulaire (réservation ou prix) */}
            <div className="border-t border-solid border-global-stroke-box pt-4 flex flex-row gap-6 items-start justify-center self-stretch shrink-0 relative">
              {!selectionStart ? (
                <div className="text-global-inactive text-left font-h4-font-family text-h4-font-size leading-h4-line-height font-h4-font-weight relative self-stretch">
                  Sélectionnez une période sur le calendrier pour commencer.
                </div>
              ) : (
                <div className="self-stretch w-full">
                  {selectionMode === 'booking' ? renderBookingForm() : renderPriceForm()}
                </div>
              )}
            </div>
          </div>

          {/* 3. Actualité du marché */}
          <PropertyNewsFeed 
            token={token} 
            propertyId={propertyIdForAnalysis} 
          />
        </div>
      </div>
      </div>

      {/* Modale d'alerte */}
      <AlertModal
        isOpen={alertModal.isOpen}
        onClose={() => setAlertModal({ isOpen: false, message: '', title: 'Information' })}
        title={alertModal.title}
        message={alertModal.message}
        buttonText="OK"
      />
    </div>
  );
}

export default PricingPage;


