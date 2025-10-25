import React, { useState, useEffect, useCallback } from 'react';
import { getProperties, generatePricingStrategy, addBooking, getBookingsForMonth, getGroups, updateGroup, getUserProfile } from '../services/api.js';
import { getFirestore, doc, setDoc, writeBatch, collection, query, where, getDocs, addDoc } from "firebase/firestore"; 
import { initializeApp } from "firebase/app"; 

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


function PricingPage({ token }) {
  const [properties, setProperties] = useState([]);
  const [allGroups, setAllGroups] = useState([]);
  const [userProfile, setUserProfile] = useState(null); // État pour le profil utilisateur
  const [selectedView, setSelectedView] = useState('property'); 
  const [selectedId, setSelectedId] = useState(''); 

  const [currentCalendarDate, setCurrentCalendarDate] = useState(new Date());
  const [priceOverrides, setPriceOverrides] = useState({});
  const [bookings, setBookings] = useState({}); 
  const [isLoading, setIsLoading] = useState(true); // Loader unique pour les données initiales
  const [error, setError] = useState('');
  const [iaLoading, setIaLoading] = useState(false); 

  const [selectionStart, setSelectionStart] = useState(null);
  const [selectionEnd, setSelectionEnd] = useState(null);
  const [isSelecting, setIsSelecting] = useState(false);
  
  const [bookingPrice, setBookingPrice] = useState('');
  const [bookingChannel, setBookingChannel] = useState('Direct');


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
      const [profileData, propertiesData, groupsData] = await Promise.all([
          getUserProfile(token),
          getProperties(token),
          getGroups(token)
      ]);
      
      setUserProfile(profileData);
      setProperties(propertiesData);
      setAllGroups(groupsData);
      
      // Sélectionner la première propriété par défaut si elle existe
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
  }, [token]);

  useEffect(() => {
    fetchInitialData();
  }, [fetchInitialData]); 


  const fetchCalendarData = useCallback(async () => {
    if (!selectedId || !db || isLoading) return; // Ne pas fetcher si on charge déjà les données initiales
    
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
  }, [fetchCalendarData]); // Déclenché par les changements dans ses dépendances


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
             alert("La synchronisation des prix n'est pas activée pour ce groupe. Veuillez l'activer dans l'onglet Dashboard.");
             return;
        }
        if (!group.mainPropertyId) {
             alert("Veuillez définir une propriété principale pour ce groupe (dans l'onglet Dashboard) avant de générer une stratégie.");
             return;
        }
        propertyIdToAnalyze = group.mainPropertyId;
        groupToSync = group;
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

      strategy.daily_prices.forEach(dayPrice => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dayPrice.date)) return; 
        if (typeof dayPrice.price !== 'number' || isNaN(dayPrice.price)) return;
        
        const dataToSet = { 
            date: dayPrice.date, 
            price: dayPrice.price, 
            reason: dayPrice.reason || "Stratégie IA Groupe" 
        };
        
        propertyIdsToUpdate.forEach(propId => {
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
    setSelectionMode('booking'); 
  };

  const handleMouseOver = (dateStr) => {
    if (isSelecting) {
        const startDate = new Date(selectionStart);
        const hoverDate = new Date(dateStr);
        let currentDateCheck = new Date(Math.min(startDate, hoverDate));
        const endDateCheck = new Date(Math.max(startDate, hoverDate));
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
      setError(''); 
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

  const renderCalendar = () => {
    let currentProperty;
    if (selectedView === 'property') {
        currentProperty = properties.find(p => p.id === selectedId);
    } else {
        const group = allGroups.find(g => g.id === selectedId);
        if (group) {
            currentProperty = properties.find(p => p.id === group.mainPropertyId) || 
                              properties.find(p => p.id === group.properties?.[0]);
        }
    }
    
    if (isLoading || !selectedId || !currentProperty) {
         return <div className="grid grid-cols-7 gap-1"><p className="text-center p-4 text-gray-500 col-span-7">Chargement ou sélection requise...</p></div>;
    }
    
    const year = currentCalendarDate.getFullYear();
    const month = currentCalendarDate.getMonth();
    const grid = [];

    ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'].forEach(day => {
        grid.push(<div key={day} className="text-center font-semibold text-xs text-gray-500">{day}</div>);
    });

    const firstDayOfMonth = new Date(year, month, 1);
    const firstDayWeekday = firstDayOfMonth.getDay(); 
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const dayOffset = (firstDayWeekday === 0) ? 6 : firstDayWeekday - 1;

    for (let i = 0; i < dayOffset; i++) { grid.push(<div key={`empty-${i}`}></div>); }

    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const isBooked = !!bookings[dateStr];
        const price = isBooked ? bookings[dateStr].pricePerNight : (priceOverrides[dateStr] ?? currentProperty.daily_revenue); 
        
        let bgColor = 'bg-gray-800'; 
        let textColor = 'text-gray-200';
        let borderColor = 'border-transparent';
        let isDisabled = isBooked; 
        
        if (isBooked) {
            bgColor = 'bg-red-900 opacity-60'; 
            textColor = 'text-red-300';
        }
        
        if (selectionStart && selectionEnd) {
             const dayTime = new Date(dateStr).getTime();
             const startTime = new Date(selectionStart).getTime();
             const endTime = new Date(selectionEnd).getTime();
             
             if (!isNaN(startTime) && !isNaN(endTime) && dayTime >= startTime && dayTime <= endTime) {
                  bgColor = 'bg-yellow-700'; 
                  textColor = 'text-white';
                  isDisabled = true; 
             }
             if (dateStr === selectionStart || dateStr === selectionEnd) {
                  bgColor = 'bg-yellow-600';
                  borderColor = 'border-yellow-400';
             }
        }

        grid.push(
            <div 
                key={dateStr} 
                data-date={dateStr} 
                className={`calendar-day p-2 rounded-md text-center border ${borderColor} ${bgColor} ${textColor} ${isDisabled ? 'cursor-not-allowed' : 'cursor-pointer hover:opacity-80'}`}
                onMouseDown={!isDisabled ? () => handleMouseDown(dateStr) : undefined}
                onMouseEnter={!isDisabled ? () => handleMouseOver(dateStr) : undefined}
            >
                <div className="text-sm">{day}</div>
                {/* Utilisation du formateur de devise */}
                <div className={`text-xs font-bold mt-1 ${isBooked ? 'opacity-70' : ''}`}>{price != null ? formatCurrency(price) : '-'}</div>
                 {isBooked && <div className="text-[10px] opacity-60 truncate">{bookings[dateStr].channel}</div>}
            </div>
        );
    }
    return grid;
  };

   const renderEditPanel = () => {
       const currencyLabel = userProfile?.currency || 'EUR';
       
       if (selectionStart && selectionEnd) {
           return (
                <form onSubmit={handleSaveBooking} className="space-y-3 text-left">
                    <h5 className="text-md font-semibold text-white mb-2">Ajouter Réservation Manuelle</h5>
                    <p className="text-xs text-gray-400">La réservation sera ajoutée à la propriété principale du groupe sélectionné (ou à la propriété unique).</p>
                    <div><label className="text-xs text-gray-400">Période sélectionnée</label>
                        <p className="text-sm font-medium bg-gray-700 p-1 rounded mt-1">{selectionStart} au {selectionEnd}</p>
                    </div>
                    <div>
                        {/* Mise à jour du label avec la devise dynamique */}
                        <label className="text-xs text-gray-400">Prix / Nuit ({currencyLabel})</label>
                        <input 
                            type="number" 
                            value={bookingPrice} 
                            onChange={(e) => setBookingPrice(e.target.value)}
                            className="w-full bg-gray-700 p-1 rounded text-sm mt-1" 
                            placeholder="Ex: 150" 
                            required 
                            min="1"
                        />
                    </div>
                     <div>
                        <label className="text-xs text-gray-400">Canal</label>
                        <select 
                            value={bookingChannel} 
                            onChange={(e) => setBookingChannel(e.target.value)}
                            className="w-full bg-gray-700 p-1 rounded text-sm mt-1"
                        >
                            <option value="Direct">Direct</option> <option value="Airbnb">Airbnb</option> <option value="Booking">Booking.com</option> <option value="VRBO">VRBO</option> <option value="Autre">Autre</option>
                        </select>
                    </div>
                    <div className="flex gap-2 pt-2">
                        <button type="submit" disabled={isLoading} className="flex-grow bg-green-600 hover:bg-green-700 text-white font-semibold py-2 px-4 rounded-lg transition text-sm disabled:bg-gray-500">
                            {isLoading ? 'Sauvegarde...' : 'Enregistrer Résa.'}
                        </button>
                         <button type="button" onClick={clearSelection} className="px-3 py-2 bg-gray-600 hover:bg-gray-500 rounded text-xs">Annuler</button>
                    </div>
                </form>
           );
       } else {
           return <p>Sélectionnez une période sur le calendrier pour ajouter une réservation.</p>;
       }
   };
   
   const handleViewChange = (e) => {
       const [type, id] = e.target.value.split('-');
       setSelectedView(type);
       setSelectedId(id);
       clearSelection();
   };
   
   const getSelectedValue = () => {
       if (!selectedId) return '';
       return `${selectedView}-${selectedId}`;
   };


  return (
    <div className="space-y-6">
      <h2 className="text-3xl font-bold text-white">Calendrier de Tarification & Réservations</h2>
       {error && <p className="bg-red-900/50 text-red-300 p-3 rounded-md text-sm my-4">{error}</p>}
      
      <div className="md:flex gap-6">
        <div className="flex-grow bg-gray-900 p-4 rounded-lg">
          <div className="flex justify-between items-center mb-4">
            
            <select 
              id="view-selector" 
              value={getSelectedValue()} 
              onChange={handleViewChange}
              className="bg-gray-800 border-gray-700 rounded-md p-2 focus:ring-blue-500"
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
            
            <div className="flex items-center gap-2">
              <button id="prev-month-btn" onClick={() => { setCurrentCalendarDate(prev => new Date(prev.getFullYear(), prev.getMonth() - 1, 1)); clearSelection(); }} className="bg-gray-700 p-2 rounded-md">&lt;</button>
              <h3 id="calendar-month-year" className="text-lg font-semibold w-32 text-center">
                {currentCalendarDate.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })}
              </h3>
              <button id="next-month-btn" onClick={() => { setCurrentCalendarDate(prev => new Date(prev.getFullYear(), prev.getMonth() + 1, 1)); clearSelection(); }} className="bg-gray-700 p-2 rounded-md">&gt;</button>
            </div>
          </div>
          <div id="calendar-grid" className="grid grid-cols-7 gap-1 select-none">
            {renderCalendar()}
          </div>
           <div className="flex flex-wrap justify-end gap-x-4 gap-y-1 text-xs mt-4 text-gray-400">
               <span><span className="inline-block w-3 h-3 bg-blue-700 rounded-sm mr-1 align-middle"></span>Prix Modifié (IA/Manuel)</span>
               <span><span className="inline-block w-3 h-3 bg-red-900 opacity-60 rounded-sm mr-1 align-middle"></span>Réservé</span>
               <span><span className="inline-block w-3 h-3 bg-yellow-700 rounded-sm mr-1 align-middle"></span>Sélection Résa</span>
           </div>
        </div>
        <div id="edit-panel" className="w-full md:w-80 bg-gray-900 p-4 rounded-lg mt-6 md:mt-0">
          <h4 className="font-semibold mb-4">Outils</h4>
          <div className="space-y-4">
            <div id="ia-strategy-section">
              <h5 className="text-md font-semibold text-white mb-2">Stratégie IA (Prix)</h5>
              <p className="text-xs text-gray-400 mb-3">Générez et appliquez des prix suggérés sur 6 mois.</p>
              <button 
                id="generate-ia-strategy-btn" 
                onClick={handleGenerateStrategy}
                disabled={iaLoading || !selectedId || !db}
                className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2 px-4 rounded-lg transition flex items-center justify-center gap-2 disabled:bg-gray-500"
              >
                <span id="ia-btn-text">{iaLoading ? 'Analyse en cours...' : 'Générer Prix IA'}</span>
                {iaLoading && <div id="ia-loader" className="loader"></div>}
              </button>
            </div>
            <div className="border-t border-gray-700 pt-4">
              <div id="booking-panel-content" className="text-center text-gray-500 text-sm">
                 {renderEditPanel()}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default PricingPage;

