import React, { useState, useEffect, useCallback } from 'react';
import { getProperties, generatePricingStrategy, addBooking, getBookingsForMonth } from '../services/api';
// Correction des imports Firebase pour utiliser les modules npm
// IMPORTER UNIQUEMENT ce qui est nécessaire pour l'affichage, plus addDoc
import { getFirestore, doc, setDoc, writeBatch, collection, query, where, getDocs, addDoc } from "firebase/firestore"; 
import { initializeApp } from "firebase/app"; 

// Assurez-vous que la configuration Firebase est accessible ici
// Vous pourriez l'importer d'un fichier de configuration central
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

// Initialiser Firebase (une seule fois idéalement, mais ici pour la simplicité)
// Dans une vraie application, cela serait dans main.jsx ou un fichier de config
let db;
let firebaseInitializationError = null; // Pour stocker l'erreur d'initialisation
try {
    const app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    console.log("Firebase initialisé dans PricingPage."); // Log d'initialisation
} catch (error) {
    console.error("Erreur d'initialisation Firebase dans PricingPage:", error);
    firebaseInitializationError = error; // Stocker l'erreur
}


function PricingPage({ token }) {
  const [properties, setProperties] = useState([]);
  const [selectedPropertyId, setSelectedPropertyId] = useState('');
  const [currentCalendarDate, setCurrentCalendarDate] = useState(new Date());
  const [priceOverrides, setPriceOverrides] = useState({});
  const [bookings, setBookings] = useState({}); // Pour stocker les réservations { "YYYY-MM-DD": bookingData }
  const [isLoading, setIsLoading] = useState(false); // Loader général pour les propriétés/données calendrier
  const [error, setError] = useState('');
  const [iaLoading, setIaLoading] = useState(false); // State spécifique pour le loader du bouton IA

  // State pour la sélection de dates (prix ou réservation)
  const [selectionStart, setSelectionStart] = useState(null);
  const [selectionEnd, setSelectionEnd] = useState(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionMode, setSelectionMode] = useState('booking'); // 'price' or 'booking' -> Forcer booking pour l'instant
  
  // State pour le formulaire de réservation
  const [bookingPrice, setBookingPrice] = useState('');
  const [bookingChannel, setBookingChannel] = useState('Direct');


  // Afficher l'erreur d'initialisation Firebase si elle existe
  useEffect(() => {
    if (firebaseInitializationError) {
        setError(`Erreur critique Firebase: ${firebaseInitializationError.message}. Vérifiez la configuration.`);
        setIsLoading(false); // Arrêter le chargement général
    }
  }, []);


  const fetchProperties = useCallback(async () => {
    if (!token) return; // Ne rien faire si pas de token
    try {
      setIsLoading(true);
      setError(''); // Clear error before fetching
      const data = await getProperties(token);
      setProperties(data);
      if (data.length > 0 && !selectedPropertyId) {
        setSelectedPropertyId(data[0].id); // Sélectionner la première propriété par défaut
      }
    } catch (err) {
      setError(`Erreur de chargement des propriétés: ${err.message}`);
      setProperties([]); // Vider les propriétés en cas d'erreur
      setSelectedPropertyId(''); // Désélectionner
    } finally {
      setIsLoading(false);
    }
  }, [token, selectedPropertyId]); // selectedPropertyId est une dépendance pour la sélection par défaut

  const fetchCalendarData = useCallback(async () => {
    if (!selectedPropertyId || !db) {
        console.warn("fetchCalendarData: Ignoré car selectedPropertyId ou db manquant.");
        return;
    }; 
    // console.log(`fetchCalendarData pour ${selectedPropertyId}, mois ${currentCalendarDate.getMonth()}`); // Debug log
    try {
      const year = currentCalendarDate.getFullYear();
      const month = currentCalendarDate.getMonth();
      const startOfMonth = `${year}-${String(month + 1).padStart(2, '0')}-01`;
      const endOfMonth = `${year}-${String(month + 1).padStart(2, '0')}-31`;
      
      // Fetch Overrides
      const overridesCol = collection(db, `properties/${selectedPropertyId}/price_overrides`);
      const qOverrides = query(overridesCol, where("date", ">=", startOfMonth), where("date", "<=", endOfMonth));
      const snapshotOverrides = await getDocs(qOverrides);
      const newOverrides = {};
      snapshotOverrides.forEach(docSnap => newOverrides[docSnap.data().date] = docSnap.data().price);
      // console.log("Overrides fetched:", newOverrides); // Debug log
      setPriceOverrides(newOverrides);

      // Fetch Bookings
      const bookingsData = await getBookingsForMonth(selectedPropertyId, year, month, token);
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
      // console.log("Bookings fetched:", newBookings); // Debug log
      setBookings(newBookings);

      //setError(''); // Ne pas effacer les erreurs potentielles des propriétés ici
      
    } catch (err) {
      console.error("Erreur de chargement des données calendrier:", err);
      setError(`Erreur calendrier: ${err.message}`);
      setPriceOverrides({});
      setBookings({});
    }
  }, [selectedPropertyId, currentCalendarDate, token]); // Inclure token


  useEffect(() => {
    fetchProperties();
  }, [fetchProperties]); // fetchProperties est déjà mémorisé avec useCallback

   useEffect(() => {
    if (selectedPropertyId && !isLoading) { // Charger données calendrier seulement si propriétés chargées et ID sélectionné
      fetchCalendarData();
    }
  }, [selectedPropertyId, currentCalendarDate, fetchCalendarData, isLoading]); // Ajouter isLoading


  const handleGenerateStrategy = async () => {
    console.log("handleGenerateStrategy: Début"); // Log 1: Début de la fonction
    
    if (!selectedPropertyId) {
      setError('Veuillez sélectionner une propriété.');
      console.error("handleGenerateStrategy: Pas de propriété sélectionnée."); // Log Erreur 1
      return;
    }
     if (!db) {
         setError("La connexion à la base de données n'est pas prête. Vérifiez la console pour les erreurs Firebase.");
         console.error("handleGenerateStrategy: Instance Firestore (db) non initialisée."); // Log Erreur 2
         return;
     }
      if (!token) {
           setError("Session invalide. Veuillez vous reconnecter.");
           console.error("handleGenerateStrategy: Token d'authentification manquant."); // Log Erreur 3
           return;
      }

    setIaLoading(true);
    setError('');
    console.log(`handleGenerateStrategy: Appel API pour propertyId: ${selectedPropertyId}`); // Log 2: Avant l'appel API

    try {
      const strategy = await generatePricingStrategy(selectedPropertyId, token);
      console.log("handleGenerateStrategy: Stratégie reçue de l'API:", strategy); // Log 3: Après l'appel API réussi
      
      if (!strategy.daily_prices || !Array.isArray(strategy.daily_prices) || strategy.daily_prices.length === 0) {
          throw new Error("La stratégie générée par l'IA est vide ou mal formée.");
      }

      console.log("handleGenerateStrategy: Début de l'écriture batch dans Firestore..."); // Log 4: Avant écriture batch
      const batch = writeBatch(db);
      strategy.daily_prices.forEach(dayPrice => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dayPrice.date)) {
            console.warn(`Date invalide ignorée dans la stratégie IA: ${dayPrice.date}`);
            return; 
        }
        if (typeof dayPrice.price !== 'number' || isNaN(dayPrice.price) || dayPrice.price < 0) {
             console.warn(`Prix invalide ignoré pour la date ${dayPrice.date}: ${dayPrice.price}`);
             return;
        }
        const docRef = doc(db, `properties/${selectedPropertyId}/price_overrides`, dayPrice.date);
        batch.set(docRef, { date: dayPrice.date, price: dayPrice.price, reason: dayPrice.reason || "IA Suggestion" });
      });
      await batch.commit();
      console.log("handleGenerateStrategy: Écriture batch terminée avec succès."); // Log 5: Après écriture batch

      alert(`Stratégie IA appliquée ! ${strategy.strategy_summary}`);
      fetchCalendarData(); // Recharger le calendrier pour afficher les nouveaux prix

    } catch (err) {
      console.error("handleGenerateStrategy: Erreur capturée:", err); // Log Erreur 4
      setError(`Erreur de génération de stratégie: ${err.message}`);
    } finally {
      console.log("handleGenerateStrategy: Fin, arrêt du loader."); // Log 6: Fin de la fonction
      setIaLoading(false);
    }
  };

  // --- Gestion de la sélection ---
  const handleMouseDown = (dateStr) => {
    setIsSelecting(true);
    setSelectionStart(dateStr);
    setSelectionEnd(dateStr);
    setSelectionMode('booking'); // Activer le mode réservation par défaut au clic
  };

  const handleMouseOver = (dateStr) => {
    if (isSelecting) {
        const startDate = new Date(selectionStart);
        const hoverDate = new Date(dateStr);
        // Empêcher la sélection à travers des jours déjà réservés
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
             // Optionnel: peut-être arrêter la sélection ou juste l'indiquer visuellement plus tard
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
      setBookingPrice(''); // Reset booking form too
      setBookingChannel('Direct');
      setError(''); // Clear potential booking errors
  };

  // --- Sauvegarde de la Réservation ---
  const handleSaveBooking = async (e) => {
      e.preventDefault();
      if (!selectionStart || !selectionEnd || !bookingPrice || !selectedPropertyId || !db) return;
      
      const pricePerNightNum = parseInt(bookingPrice, 10);
      if (isNaN(pricePerNightNum) || pricePerNightNum <= 0) {
          setError("Veuillez entrer un prix par nuit valide.");
          return;
      }
      
       const start = new Date(selectionStart);
       const end = new Date(selectionEnd);
       
       // Vérifier à nouveau si la plage sélectionnée contient des jours déjà réservés
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
          // Le teamId sera ajouté par le backend
      };
      
      setIsLoading(true); 
      setError('');
      try {
          // --- CORRECTION ---
          // Utiliser la fonction 'addBooking' de l'API (de api.js)
          await addBooking(selectedPropertyId, bookingData, token);
          
          alert('Réservation ajoutée avec succès !');
          clearSelection();
          fetchCalendarData(); // Recharger le calendrier
      } catch (err) {
          setError(`Erreur lors de l'ajout de la réservation: ${err.message}`);
      } finally {
          setIsLoading(false);
      }
  };

  const renderCalendar = () => {
    // Vérifier si properties est chargé avant d'essayer de trouver la propriété
    if (isLoading || properties.length === 0 || !selectedPropertyId) return <p>Chargement du calendrier...</p>;

    const property = properties.find(p => p.id === selectedPropertyId);
    // Gérer le cas (peu probable mais possible) où l'ID sélectionné n'est plus dans la liste
    if (!property) { 
        // Désélectionner et afficher un message
        setSelectedPropertyId('');
        return <p>Propriété sélectionnée introuvable. Veuillez re-sélectionner.</p>;
    }
    
    const year = currentCalendarDate.getFullYear();
    const month = currentCalendarDate.getMonth();
    const grid = [];

    ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'].forEach(day => {
        grid.push(<div key={day} className="text-center font-semibold text-xs text-gray-500">{day}</div>);
    });

    const firstDayOfMonth = new Date(year, month, 1);
    const firstDayWeekday = firstDayOfMonth.getDay(); // 0=Dimanche, 1=Lundi..
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    // Ajuster l'offset pour commencer la semaine le Lundi (0 -> 6)
    const dayOffset = (firstDayWeekday === 0) ? 6 : firstDayWeekday - 1;

    for (let i = 0; i < dayOffset; i++) { grid.push(<div key={`empty-${i}`}></div>); }

    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const isBooked = !!bookings[dateStr];
        // Utiliser ?? pour prendre le prix par défaut s'il n'y a pas d'override
        const price = isBooked ? bookings[dateStr].pricePerNight : (priceOverrides[dateStr] ?? property.daily_revenue); 
        
        let bgColor = 'bg-gray-800'; 
        let textColor = 'text-gray-200';
        let borderColor = 'border-transparent';
        let isDisabled = isBooked; 
        
        if (isBooked) {
            bgColor = 'bg-red-900 opacity-60'; 
            textColor = 'text-red-300';
        }
        
        // Appliquer le style de sélection
        if (selectionStart && selectionEnd) {
             const dayTime = new Date(dateStr).getTime();
             // Assurer que les dates de sélection sont valides avant de comparer
             const startTime = new Date(selectionStart).getTime();
             const endTime = new Date(selectionEnd).getTime();
             
             if (!isNaN(startTime) && !isNaN(endTime) && dayTime >= startTime && dayTime <= endTime) {
                  bgColor = 'bg-yellow-700'; // Couleur unique pour la sélection de réservation
                  textColor = 'text-white';
                  isDisabled = true; // Désactiver clic pendant la sélection pour éviter conflits
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
                // Utiliser onMouseDown pour démarrer la sélection
                onMouseDown={!isDisabled ? () => handleMouseDown(dateStr) : undefined}
                // Utiliser onMouseEnter pour continuer la sélection si le bouton est enfoncé
                onMouseEnter={!isDisabled ? () => handleMouseOver(dateStr) : undefined}
            >
                <div className="text-sm">{day}</div>
                <div className={`text-xs font-bold mt-1 ${isBooked ? 'opacity-70' : ''}`}>{price != null ? `${price}€` : '-'}</div>
                 {isBooked && <div className="text-[10px] opacity-60 truncate">{bookings[dateStr].channel}</div>}
            </div>
        );
    }

    return grid;
  };

   const renderEditPanel = () => {
       // Assurer que selectionStart et selectionEnd sont valides
       if (selectionStart && selectionEnd) {
           return (
                <form onSubmit={handleSaveBooking} className="space-y-3 text-left">
                    <h5 className="text-md font-semibold text-white mb-2">Ajouter Réservation Manuelle</h5>
                    <div><label className="text-xs text-gray-400">Période sélectionnée</label>
                        <p className="text-sm font-medium bg-gray-700 p-1 rounded mt-1">{selectionStart} au {selectionEnd}</p>
                    </div>
                    <div>
                        <label className="text-xs text-gray-400">Prix / Nuit (€)</label>
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
                            <option value="Direct">Direct</option>
                            <option value="Airbnb">Airbnb</option>
                            <option value="Booking">Booking.com</option>
                            <option value="VRBO">VRBO</option>
                            <option value="Autre">Autre</option>
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


  return (
    <div className="space-y-6">
      <h2 className="text-3xl font-bold text-white">Calendrier de Tarification & Réservations</h2>
      {/* Afficher l'erreur générale en haut */}
       {error && <p className="bg-red-900/50 text-red-300 p-3 rounded-md text-sm my-4">{error}</p>}
      
      <div className="md:flex gap-6">
        {/* Calendar Section */}
        <div className="flex-grow bg-gray-900 p-4 rounded-lg">
          <div className="flex justify-between items-center mb-4">
            <select 
              id="calendar-property-selector" 
              value={selectedPropertyId} 
              onChange={(e) => { setSelectedPropertyId(e.target.value); clearSelection(); }} // Clear selection on property change
              className="bg-gray-800 border-gray-700 rounded-md p-2 focus:ring-blue-500"
              disabled={isLoading || iaLoading} // Désactiver pendant le chargement
            >
              <option value="">-- Sélectionnez une propriété --</option>
              {properties.map(p => <option key={p.id} value={p.id}>{p.address}</option>)}
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
           {/* Légende */}
           <div className="flex flex-wrap justify-end gap-x-4 gap-y-1 text-xs mt-4 text-gray-400">
               <span><span className="inline-block w-3 h-3 bg-blue-700 rounded-sm mr-1 align-middle"></span>Prix Modifié (IA/Manuel)</span>
               <span><span className="inline-block w-3 h-3 bg-red-900 opacity-60 rounded-sm mr-1 align-middle"></span>Réservé</span>
               <span><span className="inline-block w-3 h-3 bg-yellow-700 rounded-sm mr-1 align-middle"></span>Sélection Résa</span>
           </div>
        </div>
        {/* Editing Panel */}
        <div id="edit-panel" className="w-full md:w-80 bg-gray-900 p-4 rounded-lg mt-6 md:mt-0">
          <h4 className="font-semibold mb-4">Outils</h4>
          <div className="space-y-4">
            {/* IA Strategy Section */}
            <div id="ia-strategy-section">
              <h5 className="text-md font-semibold text-white mb-2">Stratégie IA (Prix)</h5>
              <p className="text-xs text-gray-400 mb-3">Générez et appliquez des prix suggérés sur 6 mois.</p>
              <button 
                id="generate-ia-strategy-btn" 
                onClick={handleGenerateStrategy}
                disabled={iaLoading || !selectedPropertyId || !db}
                className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2 px-4 rounded-lg transition flex items-center justify-center gap-2 disabled:bg-gray-500"
              >
                <span id="ia-btn-text">{iaLoading ? 'Analyse en cours...' : 'Générer Prix IA'}</span>
                {iaLoading && <div id="ia-loader" className="loader"></div>}
              </button>
            </div>
            {/* Manual Booking Section */}
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

