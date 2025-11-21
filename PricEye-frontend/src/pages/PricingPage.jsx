import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { getProperties, generatePricingStrategy, addBooking, getBookingsForMonth, getGroups, updateGroup, getUserProfile, getPropertySpecificNews, getAutoPricingStatus, enableAutoPricing } from '../services/api.js';
import { getFirestore, doc, setDoc, writeBatch, collection, query, where, getDocs, addDoc } from "firebase/firestore";
import { jwtDecode } from 'jwt-decode'; 
import { initializeApp } from "firebase/app"; 
import PropertyNewsFeed from '../components/PropertyNewsFeed.jsx';
import DateAnalysis from '../components/DateAnalysis.jsx'; 

// Assurez-vous que la configuration Firebase est accessible ici
const firebaseConfig = {
    apiKey: "AIzaSyCqdbT96st3gc9bQ9A4Yk7uxU-Dfuzyiuc",
    authDomain: "priceye-6f81a.firebaseapp.com",
    databaseURL: "https://priceye-6f81a-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "priceye-6f81a",
    storageBucket: "priceye-6f81a.appspot.com",
    messagingSenderId: "244431363759",
    appId: "1:244431363759:web:c2f600581f341fbca63e5a",
    measurementId: "G-QC6JW8HXBE"
};

let db;
let firebaseInitializationError = null; 
try {
    const app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    console.log("Firebase initialisé dans PricingPage."); 
} catch (error) {
    console.error("Erreur d'initialisation Firebase dans PricingPage:", error);
    firebaseInitializationError = error; 
}


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


  useEffect(() => {
    if (firebaseInitializationError) {
        setError(`Erreur critique Firebase: ${firebaseInitializationError.message}. Vérifiez la configuration.`);
        setIsLoading(false); 
    }
  }, []);

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

      // Afficher un message de confirmation
      if (newEnabled) {
        setAutoPricingSuccess(`Génération automatique activée. Les prix seront générés tous les jours à 00h00 (${timezoneToUse}).`);
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
    if (!selectedId || !db || isLoading) return; 
    
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
      
      // Fetch Overrides
      const overridesCol = collection(db, `properties/${propertyIdToFetch}/price_overrides`);
      const qOverrides = query(overridesCol, where("date", ">=", startOfMonth), where("date", "<=", endOfMonth));
      const snapshotOverrides = await getDocs(qOverrides);
      const newOverrides = {};
      snapshotOverrides.forEach(docSnap => newOverrides[docSnap.data().date] = docSnap.data().price);
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
             alert("La synchronisation des prix n'est pas activée pour ce groupe. La stratégie ne sera appliquée qu'à la propriété principale.");
             if (!group.mainPropertyId) {
                 alert("Veuillez définir une propriété principale pour ce groupe avant de générer une stratégie.");
                 return;
             }
             propertyIdToAnalyze = group.mainPropertyId;
             groupToSync = null; // Ne pas synchroniser si la case n'est pas cochée
        } else {
            // Synchro activée
             if (!group.mainPropertyId) {
                 alert("Veuillez définir une propriété principale pour ce groupe (dans l'onglet Dashboard) avant de générer une stratégie.");
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
    if (!db || !token) {
       setError("Connexion non prête. Veuillez patienter.");
       return;
    }

    setIaLoading(true);
    setError('');

    try {
      const strategy = await generatePricingStrategy(propertyIdToAnalyze, token);
      
      if (!strategy.daily_prices || strategy.daily_prices.length === 0) {
          throw new Error("La stratégie générée par l'IA est vide ou mal formée.");
      }
      
      const batch = writeBatch(db);
      
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
           const overridesCol = collection(db, `properties/${propId}/price_overrides`);
           const lockedSnapshot = await getDocs(query(overridesCol, where('isLocked', '==', true)));
           lockedSnapshot.forEach(doc => {
               // Clé = "propertyId-YYYY-MM-DD"
               lockedPricesMap.set(`${propId}-${doc.id}`, doc.data().price); 
           });
      }
      
      console.log(`Trouvé ${lockedPricesMap.size} prix verrouillés pour ${propertyIdsToUpdate.length} propriétés.`);

      strategy.daily_prices.forEach(dayPrice => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dayPrice.date)) return; 
        if (typeof dayPrice.price !== 'number' || isNaN(dayPrice.price)) return;
        
        propertyIdsToUpdate.forEach(propId => {
            // Vérifier si cette date spécifique est verrouillée pour CETTE propriété
            if (lockedPricesMap.has(`${propId}-${dayPrice.date}`)) {
                 console.log(`Ignoré ${dayPrice.date} pour ${propId}: prix verrouillé.`);
                 return; // Ne pas écraser
            }

            const dataToSet = { 
                date: dayPrice.date, 
                price: dayPrice.price, 
                reason: dayPrice.reason || "Stratégie IA Groupe",
                isLocked: false // Les prix de l'IA ne sont pas verrouillés
            };
            const docRef = doc(db, `properties/${propId}/price_overrides`, dayPrice.date);
            batch.set(docRef, dataToSet);
        });
      });
      
      await batch.commit();
      
      alert(`Stratégie IA appliquée avec succès à ${propertyIdsToUpdate.length} propriété(s) ! ${strategy.strategy_summary}`);
      fetchCalendarData(); // Recharger le calendrier

    } catch (err) {
      setError(`Erreur de génération de stratégie: ${err.message}`);
    } finally {
      setIaLoading(false);
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
       
      if (!selectionStart || !selectionEnd || !bookingPrice || !propertyIdForBooking || !db) return;
      
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
          
          alert('Réservation ajoutée avec succès !');
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
              alert("La synchronisation des prix n'est pas activée pour ce groupe. Le prix ne sera appliqué qu'à la propriété principale.");
              propertyIdsToUpdate = [group.mainPropertyId].filter(Boolean); 
          } else {
              propertyIdsToUpdate = group.properties || []; 
          }
      }

      if (!selectionStart || !selectionEnd || !manualPrice || propertyIdsToUpdate.length === 0 || !db) {
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
          const batch = writeBatch(db);
          let currentDate = new Date(selectionStart);
          const endDate = new Date(selectionEnd);
          
          while(currentDate <= endDate) {
              const dateStr = currentDate.toISOString().split('T')[0];
              const dataToSet = { 
                  date: dateStr, 
                  price: priceNum, 
                  reason: "Manuel",
                  isLocked: isPriceLocked 
              };
              
              propertyIdsToUpdate.forEach(propId => {
                  const docRef = doc(db, `properties/${propId}/price_overrides`, dateStr);
                  batch.set(docRef, dataToSet);
              });
              
              currentDate.setDate(currentDate.getDate() + 1);
          }
          
          await batch.commit();
          alert(`Prix manuels appliqués à ${propertyIdsToUpdate.length} propriété(s) !`);
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

   const renderEditPanel = () => {
       const currencyLabel = userProfile?.currency || 'EUR';
       
       const renderBookingForm = () => (
            <form onSubmit={handleSaveBooking} className="space-y-3 text-left">
                <h5 className="text-md font-semibold text-text-primary mb-2">Ajouter Réservation Manuelle</h5>
                <p className="text-xs text-text-muted">La réservation sera ajoutée à la propriété principale du groupe sélectionné (ou à la propriété unique).</p>
                <div><label className="text-xs text-text-secondary">Période sélectionnée</label>
                    <p className="text-sm font-medium bg-bg-muted p-1 rounded mt-1">{selectionStart} au {selectionEnd}</p>
                </div>
                <div>
                    <label className="text-xs text-text-secondary">Prix / Nuit ({currencyLabel})</label>
                    <input 
                        type="number" 
                        value={bookingPrice} 
                        onChange={(e) => setBookingPrice(e.target.value)}
                        className="w-full form-input mt-1" 
                        placeholder="Ex: 150" 
                        required min="1"
                    />
                </div>
                 <div>
                    <label className="text-xs text-text-secondary">Canal</label>
                    <select value={bookingChannel} onChange={(e) => setBookingChannel(e.target.value)} className="w-full form-input mt-1">
                        <option value="Direct">Direct</option> <option value="Airbnb">Airbnb</option> <option value="Booking">Booking.com</option> <option value="VRBO">VRBO</option> <option value="Autre">Autre</option>
                    </select>
                </div>
                <div className="flex gap-2 pt-2">
                    <button type="submit" disabled={isLoading} className="flex-grow bg-green-600 hover:bg-green-700 text-white font-semibold py-2 px-4 rounded-lg transition text-sm disabled:bg-gray-500">
                        {isLoading ? 'Sauvegarde...' : 'Enregistrer Résa.'}
                    </button>
                     <button type="button" onClick={clearSelection} className="px-3 py-2 bg-bg-muted hover:bg-border-primary text-text-secondary rounded text-xs">Annuler</button>
                </div>
            </form>
       );
       
       const renderPriceForm = () => (
            <form onSubmit={handleSavePriceOverride} className="space-y-3 text-left">
                <h5 className="text-md font-semibold text-text-primary mb-2">Définir Prix Manuel</h5>
                {selectedView === 'group' && <p className="text-xs text-text-muted">Le prix sera appliqué à toutes les propriétés synchronisées de ce groupe.</p>}
                <div><label className="text-xs text-text-secondary">Période sélectionnée</label>
                    <p className="text-sm font-medium bg-bg-muted p-1 rounded mt-1">{selectionStart} au {selectionEnd}</p>
                </div>
                <div>
                    <label className="text-xs text-text-secondary">Nouveau Prix / Nuit ({currencyLabel})</label>
                    <input 
                        type="number" 
                        value={manualPrice} 
                        onChange={(e) => setManualPrice(e.target.value)}
                        className="w-full form-input mt-1" 
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
                        className="rounded bg-bg-muted border-border-primary text-blue-500 focus:ring-blue-500"
                    />
                    <label htmlFor="lockPrice" className="text-xs text-text-muted">
                        Verrouiller ce prix (l'IA ne le modifiera pas)
                    </label>
                </div>
                <div className="flex gap-2 pt-2">
                    <button type="submit" disabled={isLoading} className="flex-grow bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-4 rounded-lg transition text-sm disabled:bg-gray-500">
                        {isLoading ? 'Sauvegarde...' : 'Appliquer Prix'}
                    </button>
                     <button type="button" onClick={clearSelection} className="px-3 py-2 bg-bg-muted hover:bg-border-primary text-text-secondary rounded text-xs">Annuler</button>
                </div>
            </form>
       );

       return (
            <div className="space-y-4">
                <div className="flex gap-2">
                     <button 
                        onClick={() => { setSelectionMode('booking'); clearSelection(); }}
                        className={`flex-1 py-2 text-sm rounded-md ${selectionMode === 'booking' ? 'bg-yellow-600 text-white' : 'bg-bg-muted text-text-secondary'}`}
                     >
                        Ajouter Réservation
                     </button>
                     <button 
                        onClick={() => { setSelectionMode('price'); clearSelection(); }}
                        className={`flex-1 py-2 text-sm rounded-md ${selectionMode === 'price' ? 'bg-blue-600 text-white' : 'bg-bg-muted text-text-secondary'}`}
                     >
                        Définir Prix
                     </button>
                </div>
                
                <div className="border-t border-border-primary pt-4">
                    {!selectionStart ? (
                        <p>Sélectionnez une période sur le calendrier pour commencer.</p>
                    ) : selectionMode === 'booking' ? (
                        renderBookingForm()
                    ) : (
                        renderPriceForm()
                    )}
                </div>
            </div>
       );
   };
   
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
            <button
              onClick={() => {}}
              className="flex w-80 h-9 items-center justify-between px-3 py-0 relative bg-global-bg-small-box rounded-lg border border-solid border-global-stroke-box cursor-pointer hover:opacity-90 transition-opacity"
              aria-label="Select address"
            >
              <select 
                id="view-selector" 
                value={getSelectedValue()} 
                onChange={handleViewChange}
                className="flex-1 bg-transparent text-center font-h3-font-family font-h3-font-weight text-global-blanc text-h3-font-size leading-h3-line-height appearance-none cursor-pointer focus:outline-none border-none"
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
              <div className="pointer-events-none">
                <ArrowDownIcon />
              </div>
            </button>
            
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
        
        {/* 4. Afficher le composant dans la barre latérale */}
        <div id="edit-panel" className="w-full md:w-80 bg-bg-secondary p-4 rounded-lg mt-6 md:mt-0 shadow-lg">
          <h4 className="font-semibold mb-4 text-text-primary">Outils</h4>
          <div className="space-y-4">
            
            <div id="news-feed-section" className="border-b border-border-primary pb-4">
                <h5 className="text-md font-semibold text-text-primary mb-2">Infos Marché (Propriété)</h5>
                <PropertyNewsFeed 
                    token={token} 
                    propertyId={propertyIdForAnalysis} 
                />
            </div>

            {/* Panneau d'Analyse de Date */}
            <div id="date-analysis-section" className="border-b border-border-primary pb-4">
                <DateAnalysis
                    token={token}
                    date={selectedDateForAnalysis} // Passe la date sélectionnée
                    propertyId={propertyIdForAnalysis}
                    currentPrice={currentPriceForAnalysis} // NOUVELLE PROP
                    userProfile={userProfile} // NOUVELLE PROP
                />
            </div>
          
            <div id="ia-strategy-section">
              <h5 className="text-md font-semibold text-text-primary mb-2">Stratégie IA (Prix)</h5>
              
              {/* Indicateur visuel de statut */}
              <div className="mb-3 flex items-center gap-2">
                {isAutoGenerationEnabled ? (
                  <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-global-positive-impact/20 border border-global-positive-impact/40 rounded-lg">
                    <div className="w-2 h-2 bg-global-positive-impact rounded-full animate-pulse" />
                    <span className="font-p1-font-family font-p1-font-weight text-global-positive-impact text-p1-font-size leading-p1-line-height">
                      Actif
                    </span>
                    {getNextGenerationTime && (
                      <span className="font-p1-font-family font-p1-font-weight text-global-inactive text-xs leading-p1-line-height">
                        • Prochaine : {getNextGenerationTime}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-global-inactive/20 border border-global-inactive/40 rounded-lg">
                    <div className="w-2 h-2 bg-global-inactive rounded-full" />
                    <span className="font-p1-font-family font-p1-font-weight text-global-inactive text-p1-font-size leading-p1-line-height">
                      Inactif
                    </span>
                  </div>
                )}
              </div>

              {/* Affichage de la dernière génération */}
              {formatLastRun && (
                <div className="mb-3 p-2 bg-global-bg-small-box border border-global-stroke-box rounded-lg">
                  <p className="text-xs text-global-inactive">
                    Dernière génération : <span className="text-global-blanc font-medium">{formatLastRun}</span>
                  </p>
                </div>
              )}

              <p className="text-xs text-text-muted mb-3">
                {isAutoGenerationEnabled 
                  ? 'La génération automatique des prix est activée. Les prix seront générés tous les jours à 00h00.'
                  : 'Activez la génération automatique pour que les prix soient générés tous les jours à 00h00.'}
              </p>

              {/* Messages de succès et d'erreur */}
              {autoPricingSuccess && (
                <div className="mb-3 p-3 bg-green-900/40 border border-green-500/40 rounded-lg">
                  <p className="text-sm text-green-300">{autoPricingSuccess}</p>
                </div>
              )}
              {autoPricingError && (
                <div className="mb-3 p-3 bg-red-900/40 border border-red-500/40 rounded-lg">
                  <p className="text-sm text-red-300">{autoPricingError}</p>
                </div>
              )}
              
              {/* Toggle Switch */}
              <div className="flex items-center justify-between p-4 bg-global-bg-small-box rounded-[10px] border border-solid border-global-stroke-box">
                <div className="flex items-center gap-3 flex-1">
                  <div className="relative inline-block w-12 h-6">
                    <input
                      type="checkbox"
                      id="auto-generation-toggle"
                      checked={isAutoGenerationEnabled}
                      disabled={isLoadingAutoPricing}
                      onChange={(e) => handleToggleAutoGeneration(e.target.checked)}
                      className="sr-only"
                    />
                    <label
                      htmlFor="auto-generation-toggle"
                      className={`block h-6 w-12 rounded-full cursor-pointer transition-all duration-300 ${
                        isAutoGenerationEnabled
                          ? 'bg-gradient-to-r from-[#155dfc] to-[#12a1d5]'
                          : 'bg-global-stroke-box'
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-all duration-300 transform ${
                          isAutoGenerationEnabled ? 'translate-x-6' : 'translate-x-0'
                        }`}
                      />
                    </label>
                  </div>
                  
                  <div className="flex items-center gap-2">
                    {isAutoGenerationEnabled ? (
                      <>
                        <div className="w-2 h-2 bg-global-positive-impact rounded-full animate-pulse" />
                        <span className="font-p1-font-family font-p1-font-weight text-global-positive-impact text-p1-font-size leading-p1-line-height">
                          Génération automatique activée
                        </span>
                      </>
                    ) : (
                      <>
                        <div className="w-2 h-2 bg-global-inactive rounded-full" />
                        <span className="font-p1-font-family font-p1-font-weight text-global-inactive text-p1-font-size leading-p1-line-height">
                          Génération automatique désactivée
                        </span>
                      </>
                    )}
                  </div>
                </div>
                
                {/* Bouton de génération manuelle (toujours disponible) */}
                <button 
                  id="generate-ia-strategy-btn" 
                  onClick={handleGenerateStrategy}
                  disabled={iaLoading || !selectedId || !db}
                  className="ml-4 px-4 py-2 bg-gradient-to-r from-[#155dfc] to-[#12a1d5] hover:opacity-90 text-white font-h3-font-family font-h3-font-weight text-h3-font-size rounded-[10px] transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  <span id="ia-btn-text">{iaLoading ? 'Analyse...' : 'Générer maintenant'}</span>
                  {iaLoading && (
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  )}
                </button>
              </div>
            </div>
            
            <div className="pt-4">
              <div id="booking-panel-content" className="text-center text-text-muted text-sm">
                 {renderEditPanel()}
              </div>
            </div>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}

export default PricingPage;


