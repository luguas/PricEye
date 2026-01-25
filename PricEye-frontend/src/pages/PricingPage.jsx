import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { getProperties, getGroups, addBooking, getBookingsForMonth, getAutoPricingStatus, enableAutoPricing, getPriceOverrides, updatePriceOverrides, applyPricingStrategy, getPropertyAutoPricingStatus, enablePropertyAutoPricing, getGroupAutoPricingStatus, enableGroupAutoPricing } from '../services/api.js';
import { jwtDecode } from 'jwt-decode'; 
import Bouton from '../components/Bouton.jsx';
import AlertModal from '../components/AlertModal.jsx';
import { useLanguage } from '../contexts/LanguageContext.jsx';
import { handleQuotaError, checkQuotaStatus } from '../utils/quotaErrorHandler.js';
import { supabase } from '../config/supabase.js'; 

// Icônes SVG intégrées (Style conservé)
const ArrowLeftIcon = () => <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>;
const ArrowRightIcon = () => <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>;
const ArrowDownIcon = () => <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>;

function PricingPage({ token, userProfile }) {
  const { t, language } = useLanguage();
  
  // --- STATES ---
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
  
  // Auto-Pricing
  const [isAutoGenerationEnabled, setIsAutoGenerationEnabled] = useState(false);
  const [autoPricingTimezone, setAutoPricingTimezone] = useState('Europe/Paris');
  const [autoPricingLastRun, setAutoPricingLastRun] = useState(null);
  const [isLoadingAutoPricing, setIsLoadingAutoPricing] = useState(true);
  const [autoPricingSuccess, setAutoPricingSuccess] = useState('');
  const [autoPricingError, setAutoPricingError] = useState('');
  const [isQuotaReached, setIsQuotaReached] = useState(false); 

  // Sélection Manuelle
  const [selectionStart, setSelectionStart] = useState(null);
  const [selectionEnd, setSelectionEnd] = useState(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionMode, setSelectionMode] = useState('booking');
  
  // Dates éditables pour les formulaires
  const [editableStartDate, setEditableStartDate] = useState('');
  const [editableEndDate, setEditableEndDate] = useState(''); 
  
  // Formulaires
  const [bookingPrice, setBookingPrice] = useState('');
  const [bookingChannel, setBookingChannel] = useState('Direct');
  const [manualPrice, setManualPrice] = useState('');
  const [isPriceLocked, setIsPriceLocked] = useState(true); 
  const [selectedDateForAnalysis, setSelectedDateForAnalysis] = useState(null);

  // Modale
  const [alertModal, setAlertModal] = useState({ isOpen: false, message: '', title: 'Information' });

  /** Retourne le groupe auquel appartient une propriété (si elle est dans un groupe). Les prix du groupe = propriété principale. */
  const getGroupForProperty = useCallback((propertyId) => {
    if (!propertyId || !allGroups.length) return null;
    const sid = String(propertyId);
    const g = allGroups.find((group) => {
      const ids = (group.properties || []).map((p) => String(typeof p === 'object' ? p?.id ?? p?.property_id : p));
      return ids.includes(sid);
    });
    if (!g) return null;
    const mainId = g.main_property_id; // Utiliser uniquement le format Supabase
    const syncPrices = g.sync_prices ?? g.syncPrices ?? false;
    const propertyIds = (g.properties || []).map((p) => (typeof p === 'object' ? p?.id ?? p?.property_id : p)).filter(Boolean);
    return { group: g, mainId, syncPrices, propertyIds };
  }, [allGroups]);

  // --- 1. CHARGEMENT INITIAL (Logique Backend Prioritaire) ---
  const fetchInitialData = useCallback(async () => {
    if (!token) return; 
    setIsLoading(true);
    setError(''); 
    try {
      // A. Récupérer les Propriétés
      const propsData = await getProperties(token);
      const validProperties = propsData.filter(prop => prop.id && typeof prop.id === 'string');
      
      // B. Récupérer les Groupes (Via API Backend pour contourner RLS)
      let groupsData = [];
      try {
          // On tente via le backend (droits élevés) - filtre automatiquement par utilisateur
          const apiGroups = await getGroups(token);
          if (apiGroups) {
              groupsData = Array.isArray(apiGroups) ? apiGroups : [];
          } else {
              // Si apiGroups est null (404), on tente le fallback Supabase direct (droits limités)
              // IMPORTANT: Les RLS de Supabase devraient filtrer automatiquement par utilisateur
              console.warn("API Groups non disponible, fallback Supabase...");
              const userId = jwtDecode(token)?.sub;
              if (userId) {
                  // Filtrer explicitement par owner_id pour sécurité
                  const { data, error } = await supabase
                      .from('groups')
                      .select('*')
                      .eq('owner_id', userId);
                  if (error) throw error;
                  groupsData = Array.isArray(data) ? data : [];
              } else {
                  console.error("Impossible de récupérer l'ID utilisateur pour filtrer les groupes");
                  groupsData = [];
              }
          }
      } catch (e) {
          console.error("Erreur récupération groupes:", e);
          // Dernier recours avec filtre par utilisateur
          try {
              const userId = jwtDecode(token)?.sub;
              if (userId) {
                  const { data, error } = await supabase
                      .from('groups')
                      .select('*')
                      .eq('owner_id', userId);
                  if (!error && data) {
                      groupsData = Array.isArray(data) ? data : [];
                  } else {
                      groupsData = [];
                  }
              } else {
                  groupsData = [];
              }
          } catch (fallbackError) {
              console.error("Erreur fallback groupes:", fallbackError);
              groupsData = [];
          }
      }
      console.log('Groupes récupérés (bruts):', groupsData); // Debug
      setAllGroups(groupsData);

      // C. Formatage des données pour le selecteur
      const formattedGroups = groupsData
        .filter(g => g && g.id) // Filtrer les groupes invalides
        .map(g => {
          // Utiliser main_property_id (format Supabase)
          const mainId = g.main_property_id;
          const groupName = g.name || 'Sans nom'; // Valeur par défaut si name est manquant
          return {
            uniqueId: `group-${g.id}`, 
            realId: g.id,              
            type: 'group',
            name: `👥 Groupe: ${groupName}`, 
            mainPropertyId: mainId, // Garder pour compatibilité interne
            main_property_id: mainId, // Format Supabase
            ...g
          };
        });
      
      console.log('Groupes formatés:', formattedGroups); // Debug

      // On cache les propriétés qui sont déjà "Chefs de groupe" pour éviter les doublons visuels
      // Note : On ne filtre PLUS les groupes sans propriété principale, ils s'affichent quand même.
      const groupMainPropertyIds = new Set(
          formattedGroups
            .filter(g => g.main_property_id)
            .map(g => g.main_property_id)
      );

      const formattedProps = validProperties
        .filter(p => !groupMainPropertyIds.has(p.id))
        .map(p => ({
            uniqueId: `property-${p.id}`,
            realId: p.id,
            type: 'property',
            ...p
        }));

      const finalList = [...formattedGroups, ...formattedProps];
      console.log('Liste finale (groupes + propriétés):', finalList); // Debug
      console.log('Nombre de groupes:', formattedGroups.length); // Debug
      console.log('Nombre de propriétés:', formattedProps.length); // Debug
      setProperties(finalList);

      // D. Sélection par défaut
      if (finalList.length > 0 && !selectedId) {
        const first = finalList[0];
        setSelectedId(first.realId);
        setSelectedView(first.type);
      }
      
    } catch (err) {
      console.error('Erreur chargement:', err);
      setError(t('pricing.errors.loadData', { message: err.message }));
    } finally {
      setIsLoading(false);
    }
  }, [token, t]); 

  useEffect(() => { fetchInitialData(); }, [fetchInitialData]);

  // --- AUTO PRICING STATUS (par propriété/groupe) ---
  useEffect(() => {
    const loadAutoPricingStatus = async () => {
      if (!token || !selectedId) { setIsLoadingAutoPricing(false); return; }
      setIsLoadingAutoPricing(true);
      try {
        if (selectedView === 'group') {
          const status = await getGroupAutoPricingStatus(selectedId, token);
          setIsAutoGenerationEnabled(status.enabled || false);
        } else {
          const status = await getPropertyAutoPricingStatus(selectedId, token);
          setIsAutoGenerationEnabled(status.enabled || false);
        }
        // Récupérer aussi le timezone depuis le profil utilisateur (pour compatibilité)
        let userId = jwtDecode(token)?.sub;
        if (userId) {
          const userStatus = await getAutoPricingStatus(userId, token).catch(() => null);
          if (userStatus) {
            setAutoPricingTimezone(userStatus.timezone || userProfile?.timezone || 'Europe/Paris');
            setAutoPricingLastRun(userStatus.lastRun || null);
          }
        }
      } catch (err) { 
        console.error('Erreur chargement statut pricing automatique:', err);
        setIsAutoGenerationEnabled(false); 
      } 
      finally { setIsLoadingAutoPricing(false); }
    };
    loadAutoPricingStatus();
  }, [token, userProfile, selectedId, selectedView]);

  useEffect(() => {
    const checkQuota = async () => {
      if (!token) return;
      const { isQuotaReached } = await checkQuotaStatus(token);
      setIsQuotaReached(isQuotaReached);
    };
    checkQuota();
  }, [token]);

  // --- 2. CHARGEMENT CALENDRIER ---
  const fetchCalendarData = useCallback(async () => {
    if (!selectedId) {
      setIsCalendarLoading(false); setPriceOverrides({}); setBookings({}); return;
    }
    
    let overridesTargetId = selectedId;
    let bookingsTargetId = selectedId;

    if (selectedView === 'group') {
        const group = allGroups.find(g => String(g.id) === String(selectedId));
        const mainId = group?.main_property_id; // Utiliser uniquement le format Supabase
        overridesTargetId = mainId;
        bookingsTargetId = mainId;
    } else {
        // Propriété : si elle est dans un groupe, les prix viennent du groupe (propriété principale)
        const groupInfo = getGroupForProperty(selectedId);
        if (groupInfo?.mainId) {
            overridesTargetId = groupInfo.mainId;
        }
        bookingsTargetId = selectedId; // Les résas restent par propriété
    }

    if (!overridesTargetId) {
        setIsCalendarLoading(false); return;
    }

    setIsCalendarLoading(true);
    setError('');

    try {
      const year = currentCalendarDate.getFullYear();
      const month = currentCalendarDate.getMonth();
      const startOfMonth = `${year}-${String(month + 1).padStart(2, '0')}-01`;
      const lastDay = new Date(year, month + 1, 0).getDate();
      const endOfMonth = `${year}-${String(month + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      
      const overridesData = await getPriceOverrides(overridesTargetId, token, startOfMonth, endOfMonth).catch(()=>({}));
      const newOverrides = {};
      if (Array.isArray(overridesData)) {
        overridesData.forEach(o => { 
          if (o.date) {
            newOverrides[o.date] = {
              price: o.price,
              isLocked: o.isLocked || o.is_locked || false
            };
          }
        });
      } else {
        Object.keys(overridesData || {}).forEach(d => {
             const val = overridesData[d];
             if (typeof val === 'object') {
               newOverrides[d] = {
                 price: val.price,
                 isLocked: val.isLocked !== undefined ? val.isLocked : (val.is_locked || false)
               };
             } else {
               // Format ancien (juste le prix) - compatibilité
               newOverrides[d] = {
                 price: val,
                 isLocked: false
               };
             }
        });
      }
      setPriceOverrides(newOverrides);

      const bookingsData = await getBookingsForMonth(bookingsTargetId, year, month, token).catch(()=>[]);
      const newBookings = {};
      if (Array.isArray(bookingsData)) {
        bookingsData.forEach(b => {
            if (!b.startDate || !b.endDate) return;
            let cur = new Date(b.startDate);
            const end = new Date(b.endDate);
            if (cur > end) return;
            while (cur < end) { 
                const dStr = cur.toISOString().split('T')[0];
                newBookings[dStr] = b;
                cur.setDate(cur.getDate() + 1);
            }
        });
      }
      setBookings(newBookings);
      
    } catch (err) {
      console.error("Erreur calendrier:", err);
    } finally {
      setIsCalendarLoading(false);
    }
  }, [selectedId, selectedView, currentCalendarDate, token, allGroups, getGroupForProperty]); 

  useEffect(() => { fetchCalendarData(); }, [fetchCalendarData]);

  // Synchroniser les dates éditables avec la sélection
  useEffect(() => {
    if (selectionStart) {
      setEditableStartDate(selectionStart);
    }
    if (selectionEnd) {
      setEditableEndDate(selectionEnd);
    }
  }, [selectionStart, selectionEnd]);


  // --- HANDLERS ---
  const handleViewChange = (e) => {
       const selectedValue = e.target.value; 
       const item = properties.find(p => p.uniqueId === selectedValue);
       if (item) {
           setPriceOverrides({});
           setBookings({});
           setSelectedView(item.type); 
           setSelectedId(item.realId);
       }
  };

  // Ajoutez le paramètre 'isManualClick' par défaut à true
  const handleGenerateStrategy = async (isManualClick = true) => {
    let targetId = selectedId;
    let groupContext = null;

    if (selectedView === 'group') {
        const group = allGroups.find(g => String(g.id) === String(selectedId));
        targetId = group?.main_property_id; // Utiliser uniquement le format Supabase
        groupContext = group;
        if (!targetId) {
             setAlertModal({ isOpen: true, message: t('pricing.errors.noMainProperty'), title: t('pricing.modal.attention') });
             return;
        }
    }

    if (!targetId) { setError(t('pricing.errors.invalidSelection')); return; }

    const { isQuotaReached } = await checkQuotaStatus(token);
    if (isQuotaReached) {
      setIsQuotaReached(true);
      handleQuotaError(new Error('Quota IA atteint'), setError, setAlertModal, userProfile, null);
      return;
    }

    setIaLoading(true);
    try {
      // ON PASSE 'isManualClick' COMME PARAMÈTRE 'FORCE'
      // Si c'est un clic manuel -> true (on force le recalcul)
      // Si ça vient du toggle auto -> false (on vérifie la date)
      const result = await applyPricingStrategy(targetId, groupContext, token, isManualClick);
      
      if (result.skipped) {
          // Si le backend a ignoré la demande
          setAlertModal({ 
              isOpen: true, 
              message: "Les prix sont déjà à jour pour aujourd'hui. (Utilisez le bouton 'Générer' pour forcer)", 
              title: "Déjà à jour" 
          });
      } else {
          setAlertModal({ 
              isOpen: true, 
              message: t('pricing.errors.strategySuccess', { count: result.days_generated || 180 }), 
              title: t('pricing.modal.success') 
          });
          fetchCalendarData();
      }
      
      window.dispatchEvent(new CustomEvent('aiCallCompleted'));
    } catch (err) {
      if (!err.isQuotaExceeded) setError(t('pricing.errors.strategyError', { message: err.message }));
      window.dispatchEvent(new CustomEvent('aiCallFailed'));
    } finally {
      setIaLoading(false);
    }
  };

  const handleToggleAutoGeneration = async (newEnabled) => {
    if (!selectedId) {
      setAutoPricingError('Veuillez sélectionner une propriété ou un groupe.');
      return;
    }

    setAutoPricingSuccess(''); setAutoPricingError('');
    if (newEnabled) {
      const { isQuotaReached } = await checkQuotaStatus(token);
      if (isQuotaReached) {
        setIsQuotaReached(true);
        handleQuotaError(new Error('Quota IA atteint'), null, setAlertModal, userProfile, null);
        return;
      }
    }
    setIsAutoGenerationEnabled(newEnabled); 
    
    try {
        // Sauvegarder le statut pour la propriété/groupe sélectionnée
        if (selectedView === 'group') {
          await enableGroupAutoPricing(selectedId, newEnabled, token);
        } else {
          await enablePropertyAutoPricing(selectedId, newEnabled, token);
        }

        // Mettre à jour aussi le timezone au niveau utilisateur (pour compatibilité)
        const userId = jwtDecode(token)?.sub;
        if (userId) {
          await enableAutoPricing(userId, newEnabled, autoPricingTimezone, token).catch(() => {
            // Ignorer les erreurs au niveau utilisateur si le pricing est géré par propriété/groupe
          });
        }

        if (newEnabled) {
            // Passer 'false' pour ne PAS forcer si déjà fait aujourd'hui
            handleGenerateStrategy(false); 
            // Déterminer le nombre de propriétés affectées
            let propertyCount = 1; // Par défaut, une propriété
            if (selectedView === 'group') {
                const group = allGroups.find(g => String(g.id) === String(selectedId));
                // Pour un groupe, on compte 1 (propriété principale) ou on pourrait compter toutes les propriétés du groupe
                propertyCount = 1;
            }
            setAutoPricingSuccess(t('pricing.autoPricing.success', { 
                count: propertyCount, 
                timezone: autoPricingTimezone 
            }));
        } else {
            setAutoPricingSuccess(t('pricing.autoPricing.disabled'));
        }
        setTimeout(() => setAutoPricingSuccess(''), 5000);
    } catch (err) {
        setIsAutoGenerationEnabled(!newEnabled); 
        setAutoPricingError(err.message);
    }
  };

  // --- GESTION SOURIS ---
  const handleMouseDown = (dateStr) => {
    setIsSelecting(true);
    setSelectionStart(dateStr);
    setSelectionEnd(dateStr);
    setSelectedDateForAnalysis(dateStr); 
    setBookingPrice('');
    
    // Pré-remplir le prix manuel si un prix existe déjà pour ce jour
    const existingOverride = priceOverrides[dateStr];
    const existingPrice = existingOverride ? (typeof existingOverride === 'object' ? existingOverride.price : existingOverride) : null;
    setManualPrice(existingPrice ? String(Math.round(existingPrice)) : '');
    // Initialiser le statut de verrouillage avec la valeur existante, ou true par défaut
    const existingIsLocked = existingOverride && typeof existingOverride === 'object' ? existingOverride.isLocked : true;
    setIsPriceLocked(existingIsLocked);
  };
  const handleMouseOver = (dateStr) => { if (isSelecting) setSelectionEnd(dateStr); };
  const handleMouseUp = () => { setIsSelecting(false); };
  useEffect(() => {
        window.addEventListener('mouseup', handleMouseUp);
        return () => window.removeEventListener('mouseup', handleMouseUp);
  }, []);
  const clearSelection = () => { 
    setSelectionStart(null); 
    setSelectionEnd(null); 
    setEditableStartDate('');
    setEditableEndDate('');
  };

  // Handlers pour les dates éditables - onChange pour la saisie libre
  const handleStartDateChange = (e) => {
    const newDate = e.target.value;
    setEditableStartDate(newDate);
    // Ne pas mettre à jour selectionStart immédiatement, attendre onBlur
  };

  const handleEndDateChange = (e) => {
    const newDate = e.target.value;
    setEditableEndDate(newDate);
    // Ne pas mettre à jour selectionEnd immédiatement, attendre onBlur
  };

  // Validation et mise à jour de la sélection après saisie complète
  const handleStartDateBlur = (e) => {
    const newDate = e.target.value;
    if (newDate) {
      setSelectionStart(newDate);
      // Si la date de fin est antérieure à la nouvelle date de début, mettre à jour la date de fin
      if (editableEndDate && newDate > editableEndDate) {
        setSelectionEnd(newDate);
        setEditableEndDate(newDate);
      }
    } else {
      // Si le champ est vide, réinitialiser à la valeur de sélection actuelle
      setEditableStartDate(selectionStart || '');
    }
  };

  const handleEndDateBlur = (e) => {
    const newDate = e.target.value;
    if (newDate) {
      setSelectionEnd(newDate);
      // Si la date de début est postérieure à la nouvelle date de fin, mettre à jour la date de début
      if (editableStartDate && newDate < editableStartDate) {
        setSelectionStart(newDate);
        setEditableStartDate(newDate);
      }
    } else {
      // Si le champ est vide, réinitialiser à la valeur de sélection actuelle
      setEditableEndDate(selectionEnd || '');
    }
  };

  // --- SAUVEGARDES ---
  const handleSaveBooking = async (e) => {
      e.preventDefault();
      
      // Valider et mettre à jour les dates éditables avant la soumission
      const startDate = editableStartDate || selectionStart;
      const endDate = editableEndDate || selectionEnd;
      
      if (!startDate || !endDate) {
          setError(t('pricing.errors.invalidDates') || 'Veuillez sélectionner une période valide');
          return;
      }
      
      // Mettre à jour la sélection avec les dates éditables
      setSelectionStart(startDate);
      setSelectionEnd(endDate);
      
      let pid = selectedId;
      if (selectedView === 'group') {
          const group = allGroups.find(g => String(g.id) === String(selectedId));
          pid = group?.main_property_id; // Utiliser uniquement le format Supabase
      }
      
      const start = new Date(startDate);
      const end = new Date(endDate);
      end.setDate(end.getDate() + 1);
      const nights = Math.max(1, Math.ceil((end - start) / (1000 * 60 * 60 * 24)));
      
      setIsLoading(true);
      try {
          await addBooking(pid, {
              startDate: startDate,
              endDate: end.toISOString().split('T')[0],
              pricePerNight: Number(bookingPrice),
              totalPrice: Number(bookingPrice) * nights,
              channel: bookingChannel,
              bookedAt: new Date().toISOString()
          }, token);
          setAlertModal({ isOpen: true, message: t('pricing.errors.bookingSuccess'), title: t('pricing.modal.success') });
          clearSelection();
          fetchCalendarData();
      } catch(e) { setError(e.message); } finally { setIsLoading(false); }
  };

  const handleSavePriceOverride = async (e) => {
      e.preventDefault();
      
      // Valider et mettre à jour les dates éditables avant la soumission
      const startDate = editableStartDate || selectionStart;
      const endDate = editableEndDate || selectionEnd;
      
      if (!startDate || !endDate) {
          setError(t('pricing.errors.invalidDates') || 'Veuillez sélectionner une période valide');
          return;
      }
      
      // Mettre à jour la sélection avec les dates éditables
      setSelectionStart(startDate);
      setSelectionEnd(endDate);
      
      let targets = [];

      if (selectedView === 'group') {
          const g = allGroups.find(x => String(x.id) === String(selectedId));
          const mainId = g?.main_property_id; // Utiliser uniquement le format Supabase
          if (!mainId) {
              setAlertModal({ isOpen: true, message: t('pricing.errors.noMainProperty'), title: t('pricing.modal.attention') });
              return;
          }
          const syncPrices = g?.sync_prices ?? g?.syncPrices ?? false;
          const propertyIds = (g?.properties || []).map(p => (typeof p === 'object' ? p?.id ?? p?.property_id : p)).filter(Boolean);
          targets = syncPrices && propertyIds.length
              ? [mainId, ...propertyIds.filter(pid => String(pid) !== String(mainId))]
              : [mainId];
      } else {
          const groupInfo = getGroupForProperty(selectedId);
          if (groupInfo?.mainId) {
              targets = groupInfo.syncPrices && groupInfo.propertyIds?.length
                  ? [groupInfo.mainId, ...groupInfo.propertyIds.filter(pid => String(pid) !== String(groupInfo.mainId))]
                  : [groupInfo.mainId];
          } else {
              targets = [selectedId];
          }
      }

      targets = targets.filter(Boolean);
      if (!targets.length) return;

      setIsLoading(true);
      try {
          const overrides = [];
          let cur = new Date(startDate);
          const end = new Date(endDate);
          while(cur <= end) {
              overrides.push({ date: cur.toISOString().split('T')[0], price: Number(manualPrice), isLocked: isPriceLocked });
              cur.setDate(cur.getDate() + 1);
          }
          await Promise.all(targets.map(pid => updatePriceOverrides(pid, overrides, token)));
          setAlertModal({ isOpen: true, message: t('pricing.errors.priceSuccess', { count: targets.length }), title: t('pricing.modal.success') });
          clearSelection();
          fetchCalendarData();
      } catch(e) { setError(e.message); } finally { setIsLoading(false); }
  };

  // --- RENDU CALENDRIER ---
  const renderCalendar = () => {
    if (isLoading && !selectedId) return <div className="col-span-7 text-center text-gray-500 py-10">Chargement...</div>;

    const year = currentCalendarDate.getFullYear();
    const month = currentCalendarDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const startOffset = firstDay === 0 ? 6 : firstDay - 1; 
    
    const prevCells = [];
    const prevMonthDays = new Date(year, month, 0).getDate();
    for (let i=0; i<startOffset; i++) {
        prevCells.unshift(
            <div key={`prev-${i}`} className="w-full h-full flex items-center justify-center bg-global-bg-small-box rounded-[10px] border border-global-stroke-box opacity-30">
                <span className="text-global-inactive font-h3-font-family">{prevMonthDays - i}</span>
            </div>
        );
    }

    const cells = [];
    const todayStr = new Date().toISOString().split('T')[0];

    for (let d=1; d<=daysInMonth; d++) {
        const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const bk = bookings[dateStr];
        const overrideData = priceOverrides[dateStr];
        const pr = overrideData ? (typeof overrideData === 'object' ? overrideData.price : overrideData) : null;
        const isPast = dateStr < todayStr;
        
        let bg = 'bg-global-bg-small-box';
        let border = 'border-global-stroke-box';
        let txt = 'text-global-blanc';
        let cursor = isPast ? 'cursor-not-allowed' : 'cursor-pointer hover:border-global-content-highlight-2nd hover:shadow-lg hover:scale-105';
        let opacity = isPast ? 'opacity-40' : 'opacity-100';

        const isSel = selectionStart && dateStr >= selectionStart && dateStr <= (selectionEnd||selectionStart);
        const isClickedDate = dateStr === selectedDateForAnalysis; // Jour actuellement cliqué
        
        if (isSel) {
             bg = selectionMode === 'booking' ? 'bg-calendrierbg-bleu' : 'bg-calendrierbg-vert';
             border = selectionMode === 'booking' ? 'border-calendrierstroke-bleu' : 'border-calendrierstroke-vert';
             // Effet spécial pour le jour cliqué dans la sélection
             if (isClickedDate) {
                border = selectionMode === 'booking' ? 'border-calendrierstroke-bleu border-2 shadow-xl' : 'border-calendrierstroke-vert border-2 shadow-xl';
             }
        } else if (bk) {
             bg = 'bg-calendrierbg-orange';
             border = 'border-calendrierstroke-orange';
             cursor = 'cursor-not-allowed'; 
        } else if (pr) {
             bg = 'bg-calendrierbg-vert'; // Style vert si prix défini
             border = 'border-calendrierstroke-vert';
        }

        cells.push(
            <div key={dateStr} 
                 className={`w-full h-full flex flex-col items-center justify-center ${bg} rounded-[10px] border ${border} ${cursor} transition-all duration-200 relative ${opacity}`}
                 onMouseDown={!isPast && !bk ? () => handleMouseDown(dateStr) : undefined}
                 onMouseEnter={!isPast && !bk ? () => handleMouseOver(dateStr) : undefined}
            >
                <span className={`${txt} font-h3-font-family font-h3-font-weight text-h3-font-size`}>{d}</span>
                {pr && !bk && (
                  <span className={`${txt} font-h4-font-family text-xs flex items-center gap-1`}>
                    {Math.round(pr)}€
                    {overrideData && typeof overrideData === 'object' && overrideData.isLocked && (
                      <span className="text-yellow-400" title={t('pricing.lockPrice')}>🔒</span>
                    )}
                  </span>
                )}
                {bk && <span className="text-[10px] text-white">Réservé</span>}
                {/* Indicateur visuel pour le jour sélectionné */}
                {isClickedDate && !isSel && (
                    <div className="absolute top-1 right-1 w-2 h-2 rounded-full bg-blue-400 animate-pulse"></div>
                )}
            </div>
        );
    }
    return [...prevCells, ...cells];
  };

  const renderBookingForm = () => (
    <form onSubmit={handleSaveBooking} className="flex flex-col gap-3 text-left">
        <div>
            <label className="text-xs text-global-inactive block mb-1">{t('pricing.selectedPeriod')}</label>
            <div className="flex gap-2">
                <input 
                    type="date" 
                    value={editableStartDate} 
                    onChange={handleStartDateChange}
                    onBlur={handleStartDateBlur}
                    className="flex-1 bg-global-bg-small-box border border-global-stroke-box rounded-[10px] p-2 text-sm text-white outline-none focus:border-global-content-highlight-2nd"
                />
                <span className="text-white self-center">→</span>
                <input 
                    type="date" 
                    value={editableEndDate} 
                    onChange={handleEndDateChange}
                    onBlur={handleEndDateBlur}
                    min={editableStartDate || undefined}
                    className="flex-1 bg-global-bg-small-box border border-global-stroke-box rounded-[10px] p-2 text-sm text-white outline-none focus:border-global-content-highlight-2nd"
                />
            </div>
        </div>
        <div>
            <label className="text-xs text-global-inactive block mb-1">{t('pricing.pricePerNight')}</label>
            <input type="number" value={bookingPrice} onChange={e=>setBookingPrice(e.target.value)} className="w-full bg-global-bg-small-box border border-global-stroke-box rounded-[10px] p-2 text-white outline-none focus:border-global-content-highlight-2nd" placeholder="Ex: 150"/>
        </div>
        <div>
            <label className="text-xs text-global-inactive block mb-1">{t('pricing.channel')}</label>
            <select value={bookingChannel} onChange={e=>setBookingChannel(e.target.value)} className="w-full bg-global-bg-small-box border border-global-stroke-box rounded-[10px] p-2 text-white outline-none">
                <option>Direct</option><option>Airbnb</option><option>Booking</option>
            </select>
        </div>
        <div className="flex gap-2 pt-2">
            <button type="submit" className="flex-1 bg-gradient-to-r from-[#155dfc] to-[#12a1d5] text-white py-2 rounded-[10px] font-bold text-sm hover:opacity-90">{t('pricing.saveBooking')}</button>
            <button type="button" onClick={clearSelection} className="px-3 py-2 border border-gray-600 text-gray-400 rounded-[10px] text-xs hover:text-white">{t('pricing.cancel')}</button>
        </div>
    </form>
  );

  const renderPriceForm = () => {
    // Vérifier si on modifie un prix existant ou si on en ajoute un nouveau
    const existingOverride = selectionStart ? priceOverrides[selectionStart] : null;
    const hasExistingPrice = existingOverride !== null && existingOverride !== undefined;
    const existingPriceValue = hasExistingPrice ? (typeof existingOverride === 'object' ? existingOverride.price : existingOverride) : null;
    const isModifying = hasExistingPrice && manualPrice;
    
    return (
        <form onSubmit={handleSavePriceOverride} className="flex flex-col gap-3 text-left">
            <div>
                <label className="text-xs text-global-inactive block mb-1">{t('pricing.selectedPeriod')}</label>
                <div className="flex gap-2">
                    <input 
                        type="date" 
                        value={editableStartDate} 
                        onChange={handleStartDateChange}
                        onBlur={handleStartDateBlur}
                        className="flex-1 bg-global-bg-small-box border border-global-stroke-box rounded-[10px] p-2 text-sm text-white outline-none focus:border-global-content-highlight-2nd"
                    />
                    <span className="text-white self-center">→</span>
                    <input 
                        type="date" 
                        value={editableEndDate} 
                        onChange={handleEndDateChange}
                        onBlur={handleEndDateBlur}
                        min={editableStartDate || undefined}
                        className="flex-1 bg-global-bg-small-box border border-global-stroke-box rounded-[10px] p-2 text-sm text-white outline-none focus:border-global-content-highlight-2nd"
                    />
                </div>
            </div>
            {hasExistingPrice && existingPriceValue && (
                <div className="bg-blue-900/20 border border-blue-500/30 rounded-[10px] p-2">
                    <span className="text-blue-300 text-xs">
                        💡 {t('pricing.currentPrice')} : {Math.round(existingPriceValue)}€
                        {existingOverride && typeof existingOverride === 'object' && existingOverride.isLocked && (
                            <span className="ml-2 text-yellow-300">🔒 {t('pricing.lockPrice')}</span>
                        )}
                    </span>
                </div>
            )}
            <div>
                <label className="text-xs text-global-inactive block mb-1">
                    {isModifying ? `✏️ ${t('pricing.modifyPricePerNight')}` : t('pricing.newPricePerNight')}
                </label>
                <input 
                    type="number" 
                    value={manualPrice} 
                    onChange={e=>setManualPrice(e.target.value)} 
                    className="w-full bg-global-bg-small-box border border-global-stroke-box rounded-[10px] p-2 text-white outline-none focus:border-global-content-highlight-2nd" 
                    placeholder={hasExistingPrice ? t('pricing.enterNewPrice') : "Ex: 175"}
                />
            </div>
            <div className="flex items-center gap-2">
                <input type="checkbox" checked={isPriceLocked} onChange={e=>setIsPriceLocked(e.target.checked)} className="accent-blue-500"/>
                <label className="text-xs text-gray-400">{t('pricing.lockPrice')}</label>
            </div>
            <div className="flex gap-2 pt-2">
                <button 
                    type="submit" 
                    className="flex-1 bg-gradient-to-r from-[#155dfc] to-[#12a1d5] text-white py-2 rounded-[10px] font-bold text-sm hover:opacity-90"
                >
                    {isModifying ? `✓ ${t('pricing.modifyPrice')}` : t('pricing.applyPrice')}
                </button>
                <button type="button" onClick={clearSelection} className="px-3 py-2 border border-gray-600 text-gray-400 rounded-[10px] text-xs hover:text-white">{t('pricing.cancel')}</button>
            </div>
        </form>
    );
  };

  return (
    <div className="relative min-h-screen">
      <div className="fixed inset-0" style={{ background: 'linear-gradient(135deg, rgba(2,6,24,1) 0%, rgba(22,36,86,1) 45%, rgba(15,23,43,1) 100%)', zIndex: 0 }} />
      
      <div className="relative z-10 space-y-6 p-4 md:p-6 lg:p-8">
        {error && <div className="bg-red-900/50 text-red-300 p-3 rounded-md text-sm border border-red-500/50">{error}</div>}
      
        <div className="md:flex gap-6">
          {/* COLONNE GAUCHE */}
          <div className="flex-grow self-stretch p-8 bg-global-bg-box rounded-[14px] border border-solid border-global-stroke-box flex flex-col items-start gap-6">
            <header className="flex items-center justify-between relative self-stretch w-full flex-[0_0_auto]">
              
              <div className="relative w-80">
                  <select 
                    id="view-selector" 
                    value={selectedId ? (selectedView==='group'?`group-${selectedId}`:`property-${selectedId}`) : ''}
                    onChange={handleViewChange}
                    className="w-full h-9 bg-global-bg-small-box rounded-lg border border-solid border-global-stroke-box px-3 py-0 text-center font-h3-font-family font-h3-font-weight text-global-blanc text-h3-font-size appearance-none cursor-pointer focus:outline-none"
                  >
                    <option value="" disabled>{t('pricing.select')}</option>
                    {properties.map(item => (
                        <option key={item.uniqueId} value={item.uniqueId}>
                            {item.name}
                        </option>
                    ))}
                  </select>
                  <div className="absolute right-3 top-2 pointer-events-none"><ArrowDownIcon/></div>
              </div>
              
              <nav className="inline-flex h-8 items-center gap-3 relative flex-[0_0_auto]">
                <button onClick={() => setCurrentCalendarDate(new Date(currentCalendarDate.setMonth(currentCalendarDate.getMonth() - 1)))} className="hover:opacity-70"><ArrowLeftIcon/></button>
                <time className="relative w-[150px] font-h4-font-family font-h4-font-weight text-global-blanc text-h4-font-size text-center capitalize">
                    {currentCalendarDate.toLocaleDateString(language === 'en' ? 'en-US' : 'fr-FR', { month: 'long', year: 'numeric' })}
                </time>
                <button onClick={() => setCurrentCalendarDate(new Date(currentCalendarDate.setMonth(currentCalendarDate.getMonth() + 1)))} className="hover:opacity-70"><ArrowRightIcon/></button>
              </nav>
            </header>

            <section className="flex flex-col items-start gap-3 relative self-stretch w-full flex-[0_0_auto]">
                <header className="flex items-center justify-between px-9 py-0 relative self-stretch w-full flex-[0_0_auto]">
                    {(language==='en'?['Mon','Tue','Wed','Thu','Fri','Sat','Sun']:['Lun','Mar','Mer','Jeu','Ven','Sam','Dim']).map((d,i)=>(
                        <div key={i} className="text-global-inactive font-p1-font-family font-bold">{d}</div>
                    ))}
                </header>
                
                <div className="self-stretch h-[458px] grid grid-cols-7 gap-2 select-none relative">
                    {renderCalendar()}
                    {iaLoading && (
                        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm z-50 flex flex-col items-center justify-center rounded-[10px]">
                            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mb-4"></div>
                            <p className="text-white font-bold">{t('pricing.strategy.generating')}</p>
                        </div>
                    )}
                </div>
            </section>

            <section className="flex flex-col gap-3 pt-4 border-t border-global-stroke-box w-full">
                <div className="flex items-start justify-center gap-6">
                    <div className="flex items-center gap-2"><div className="w-3 h-3 bg-calendrierbg-vert rounded border border-calendrierstroke-vert"/> <span className="text-gray-400 text-xs">{t('pricing.legend.priceDefined')}</span></div>
                    <div className="flex items-center gap-2"><div className="w-3 h-3 bg-calendrierbg-orange rounded border border-calendrierstroke-orange"/> <span className="text-gray-400 text-xs">{t('pricing.legend.reserved')}</span></div>
                    <div className="flex items-center gap-2"><div className="w-3 h-3 bg-global-bg-small-box rounded border border-global-stroke-box"/> <span className="text-gray-400 text-xs">{t('pricing.legend.empty')}</span></div>
                </div>
                {!selectionStart && (
                    <div className="text-center text-gray-500 text-xs italic">
                        💡 {t('pricing.clickToAddOrModifyPrice')}
                    </div>
                )}
            </section>
          </div>
          
          {/* COLONNE DROITE */}
          <div id="edit-panel" className="flex flex-col gap-4 w-full md:w-[394px]">
             {/* PANEL STRATÉGIE IA */}
             <div className="bg-global-bg-box rounded-[14px] border border-global-stroke-box p-6 flex flex-col gap-3">
                <div className="text-white font-h2-font-family text-lg">{t('pricing.strategy.title')}</div>
                <div className="text-gray-400 text-sm">{t('pricing.strategy.description')}</div>
                
                {autoPricingSuccess && <div className="text-green-400 text-xs bg-green-900/20 p-2 rounded border border-green-500/30">{autoPricingSuccess}</div>}
                {autoPricingError && <div className="text-red-400 text-xs bg-red-900/20 p-2 rounded border border-red-500/30">{autoPricingError}</div>}

                <div 
                    onClick={iaLoading ? undefined : () => handleToggleAutoGeneration(!isAutoGenerationEnabled)}
                    className={`bg-global-stroke-highlight-2nd rounded-[10px] border border-global-content-highlight-2nd p-3 flex items-center justify-center gap-3 cursor-pointer hover:opacity-90 ${iaLoading ? 'opacity-50' : ''}`}
                >
                    <div className={`w-5 h-5 rounded border ${isAutoGenerationEnabled ? 'bg-blue-500 border-blue-500' : 'border-gray-400'} flex items-center justify-center`}>
                        {isAutoGenerationEnabled && <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M10 3L4.5 8.5L2 6" stroke="white" strokeWidth="2"/></svg>}
                    </div>
                    <span className="text-white font-bold text-sm">{t('pricing.strategy.automate')}</span>
                </div>

                <div className="flex gap-3">
                    <Bouton state="principal" text={t('pricing.strategy.addBooking')} onClick={()=>{setSelectionMode('booking'); setBookingPrice(''); setManualPrice('');}} className={`${selectionMode==='booking'?'opacity-100':'opacity-60'} !text-xs whitespace-normal leading-tight !px-2`} />
                    <button onClick={()=>{setSelectionMode('price'); setBookingPrice(''); setManualPrice('');}} className={`flex-1 border border-blue-500 rounded-[10px] text-white text-xs py-2 px-2 hover:bg-blue-500/10 whitespace-normal leading-tight ${selectionMode==='price'?'bg-blue-500/20':''}`}>{t('pricing.strategy.setPrice')}</button>
                </div>

                <div className="border-t border-global-stroke-box pt-4 mt-2">
                    {!selectionStart ? (
                        <div className="text-gray-500 text-sm text-center">{t('pricing.selectPeriod')}</div>
                    ) : (
                        selectionMode === 'booking' ? renderBookingForm() : renderPriceForm()
                    )}
                </div>
             </div>
          </div>
        </div>
      </div>

      <AlertModal isOpen={alertModal.isOpen} onClose={()=>setAlertModal({...alertModal, isOpen:false})} title={alertModal.title} message={alertModal.message} buttonText="OK" />
    </div>
  );
}

export default PricingPage;