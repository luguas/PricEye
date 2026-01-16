import React, { useState, useEffect, useCallback } from 'react';
import { getProperties, addBooking, getBookingsForMonth, getAutoPricingStatus, getPriceOverrides, updatePriceOverrides, applyPricingStrategy } from '../services/api.js';
import { jwtDecode } from 'jwt-decode'; 
import Bouton from '../components/Bouton.jsx';
import AlertModal from '../components/AlertModal.jsx';
import { useLanguage } from '../contexts/LanguageContext.jsx';
import { handleQuotaError, checkQuotaStatus } from '../utils/quotaErrorHandler.js';
import { supabase } from '../config/supabase.js'; 
import { ArrowLeftIcon, ArrowRightIcon } from '@heroicons/react/24/outline';

function PricingPage({ token, userProfile }) {
  const { t, language } = useLanguage();
  
  // États de données
  const [properties, setProperties] = useState([]);
  const [allGroups, setAllGroups] = useState([]);
  
  // États de sélection
  const [selectedView, setSelectedView] = useState('property'); 
  const [selectedId, setSelectedId] = useState(''); 

  // États du calendrier
  const [currentCalendarDate, setCurrentCalendarDate] = useState(new Date());
  const [priceOverrides, setPriceOverrides] = useState({});
  const [bookings, setBookings] = useState({}); 
  
  // États de chargement et erreurs
  const [isLoading, setIsLoading] = useState(true);
  const [isCalendarLoading, setIsCalendarLoading] = useState(false); 
  const [error, setError] = useState('');
  const [iaLoading, setIaLoading] = useState(false);
  const [isQuotaReached, setIsQuotaReached] = useState(false); 

  // États d'interaction (Sélection multiple)
  const [selectionStart, setSelectionStart] = useState(null);
  const [selectionEnd, setSelectionEnd] = useState(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionMode, setSelectionMode] = useState('booking'); 
  
  // États formulaires
  const [bookingPrice, setBookingPrice] = useState('');
  const [bookingChannel, setBookingChannel] = useState('Direct');
  const [manualPrice, setManualPrice] = useState('');
  const [isPriceLocked, setIsPriceLocked] = useState(true); 

  // Modale
  const [alertModal, setAlertModal] = useState({ isOpen: false, message: '', title: 'Information' });

  // ---------------------------------------------------------------------------
  // 1. CHARGEMENT INITIAL (PROPRIÉTÉS + GROUPES)
  // ---------------------------------------------------------------------------
  const fetchInitialData = useCallback(async () => {
    if (!token) return; 
    setIsLoading(true);
    setError(''); 
    
    try {
      // A. Récupérer les propriétés
      const propsData = await getProperties(token);
      
      // B. Récupérer les groupes
      const { data: groupsData, error: groupsError } = await supabase
        .from('groups') 
        .select('*');

      if (groupsError) console.error("Erreur groupes:", groupsError);

      setAllGroups(groupsData || []);

      // C. Préparer la liste affichée
      // On convertit tout en format standard pour le menu déroulant
      const formattedGroups = (groupsData || [])
        .filter(g => g.main_property_id) // Sécurité : ignorer groupes vides
        .map(g => ({
          uniqueId: `group-${g.id}`, // ID unique pour la liste React
          realId: g.id,              // Vrai ID pour l'API
          type: 'group',
          name: `👥 Groupe: ${g.name}`,
          mainPropertyId: g.main_property_id,
          ...g
        }));

      // On identifie les propriétés qui sont chefs de groupe pour ne pas les afficher en double
      const hiddenPropIds = new Set(formattedGroups.map(g => String(g.mainPropertyId)));

      const formattedProps = (propsData || []).filter(p => !hiddenPropIds.has(String(p.id)))
        .map(p => ({
          uniqueId: `property-${p.id}`,
          realId: p.id,
          type: 'property',
          name: p.name,
          ...p
        }));

      const finalList = [...formattedGroups, ...formattedProps];
      setProperties(finalList);

      // D. Sélection par défaut (si rien n'est sélectionné)
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

  // Déclencheur chargement initial
  useEffect(() => {
    fetchInitialData();
  }, [fetchInitialData]);


  // ---------------------------------------------------------------------------
  // 2. CHARGEMENT DU CALENDRIER (AU CHANGEMENT DE SÉLECTION OU DATE)
  // ---------------------------------------------------------------------------
  const fetchCalendarData = useCallback(async () => {
    if (!selectedId) return;
    
    setIsCalendarLoading(true);
    setError('');
    
    // Déterminer sur quelle propriété on tape
    let targetPropertyId = selectedId; // Par défaut (cas propriété seule)

    if (selectedView === 'group') {
        const group = allGroups.find(g => String(g.id) === String(selectedId));
        if (group) {
            targetPropertyId = group.main_property_id || group.mainPropertyId;
        } else {
            console.warn("Groupe introuvable pour ID:", selectedId);
            setIsCalendarLoading(false);
            return;
        }
    }

    if (!targetPropertyId) {
        setIsCalendarLoading(false);
        return;
    }

    try {
      const year = currentCalendarDate.getFullYear();
      const month = currentCalendarDate.getMonth();
      const startOfMonth = `${year}-${String(month + 1).padStart(2, '0')}-01`;
      const lastDay = new Date(year, month + 1, 0).getDate();
      const endOfMonth = `${year}-${String(month + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      
      // A. Overrides (Prix forcés)
      let overridesData = await getPriceOverrides(targetPropertyId, token, startOfMonth, endOfMonth).catch(() => ({}));
      const newOverrides = {};
      if (Array.isArray(overridesData)) {
        overridesData.forEach(o => { if (o.date) newOverrides[o.date] = o.price; });
      } else if (overridesData && typeof overridesData === 'object') {
        Object.keys(overridesData).forEach(d => { newOverrides[d] = overridesData[d]?.price || overridesData[d]; });
      }
      setPriceOverrides(newOverrides);

      // B. Bookings (Réservations)
      let bookingsData = await getBookingsForMonth(targetPropertyId, year, month, token).catch(() => []);
      const newBookings = {};
      if (Array.isArray(bookingsData)) {
        bookingsData.forEach(b => {
            if (!b.startDate || !b.endDate) return;
            let cur = new Date(b.startDate + 'T00:00:00Z');
            const end = new Date(b.endDate + 'T00:00:00Z');
            while (cur < end) { 
                newBookings[cur.toISOString().split('T')[0]] = b;
                cur.setUTCDate(cur.getUTCDate() + 1);
            }
        });
      }
      setBookings(newBookings);
      
    } catch (err) {
      console.error("Erreur calendrier:", err);
      // On n'affiche pas l'erreur à l'utilisateur pour ne pas bloquer l'UI, juste un log
    } finally {
      setIsCalendarLoading(false);
    }
  }, [selectedId, selectedView, currentCalendarDate, token, allGroups]); 

  useEffect(() => {
      fetchCalendarData();
  }, [fetchCalendarData]);


  // ---------------------------------------------------------------------------
  // 3. HANDLERS ACTIONS
  // ---------------------------------------------------------------------------
  
  // GESTION DU CHANGEMENT DE SÉLECTION (CORRIGÉE)
  const handleSelectionChange = (e) => {
      const selectedValue = e.target.value; // ex: "property-123" ou "group-456"
      
      // On cherche l'objet correspondant dans notre liste unifiée
      const item = properties.find(p => p.uniqueId === selectedValue);
      
      if (item) {
          // On met à jour l'état proprement
          setPriceOverrides({}); // Reset visuel immédiat
          setBookings({});
          
          setSelectedView(item.type); // 'property' ou 'group'
          setSelectedId(item.realId); // L'ID technique
      }
  };

  const handleGenerateStrategy = async () => {
    // Logique de génération IA inchangée mais sécurisée
    let targetId = selectedId;
    if (selectedView === 'group') {
        const g = allGroups.find(x => String(x.id) === String(selectedId));
        targetId = g?.main_property_id;
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
      // CORRECTION ICI : On passe le token en 3ème argument
      const result = await applyPricingStrategy(
          targetId, 
          selectedView === 'group' ? allGroups.find(g => String(g.id) === String(selectedId)) : null,
          token 
      );
      
      setAlertModal({ isOpen: true, message: t('pricing.errors.strategySuccess', { count: result.days_generated || 180 }), title: t('pricing.modal.success') });
      fetchCalendarData(); // Rafraîchir après génération
    } catch (err) {
        if (!err.isQuotaExceeded) setError(t('pricing.errors.strategyError', { message: err.message }));
    } finally {
        setIaLoading(false);
    }
  };

  // ... (Gestion de la souris et des modales de sélection reste identique) ...
  const handleMouseDown = (dateStr) => {
    setIsSelecting(true);
    setSelectionStart(dateStr);
    setSelectionEnd(dateStr);
    setBookingPrice('');
    setManualPrice('');
    setIsPriceLocked(true);
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
  };

  // Sauvegarde Booking (Simplifiée)
  const handleSaveBooking = async (e) => {
      e.preventDefault();
      let pid = selectedId;
      if (selectedView === 'group') pid = allGroups.find(g=>String(g.id)===String(selectedId))?.main_property_id;
      
      const start = new Date(selectionStart);
      const end = new Date(selectionEnd);
      end.setDate(end.getDate() + 1);
      const nights = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
      
      setIsLoading(true);
      try {
          await addBooking(pid, {
              startDate: selectionStart,
              endDate: end.toISOString().split('T')[0],
              pricePerNight: Number(bookingPrice),
              totalPrice: Number(bookingPrice) * nights,
              channel: bookingChannel,
              bookedAt: new Date().toISOString()
          }, token);
          setAlertModal({ isOpen: true, message: 'Réservation ajoutée', title: 'Succès' });
          clearSelection();
          fetchCalendarData();
      } catch(e) { setError(e.message); } finally { setIsLoading(false); }
  };

  // Sauvegarde Prix Manuel (Simplifiée)
  const handleSavePriceOverride = async (e) => {
      e.preventDefault();
      let targets = [selectedId];
      // Logique propagation groupe
      if (selectedView === 'group') {
          const g = allGroups.find(x => String(x.id) === String(selectedId));
          if (g?.sync_prices) {
             const { data: members } = await supabase.from('group_members').select('property_id').eq('group_id', g.id);
             targets = [g.main_property_id, ...(members?.map(m=>m.property_id)||[])];
          } else {
             targets = [g?.main_property_id];
          }
      }

      setIsLoading(true);
      try {
          const overrides = [];
          let cur = new Date(selectionStart);
          const end = new Date(selectionEnd);
          while(cur <= end) {
              overrides.push({ date: cur.toISOString().split('T')[0], price: Number(manualPrice), isLocked: isPriceLocked });
              cur.setDate(cur.getDate() + 1);
          }
          
          await Promise.all(targets.map(pid => pid && updatePriceOverrides(pid, overrides, token)));
          
          setAlertModal({ isOpen: true, message: 'Prix mis à jour', title: 'Succès' });
          clearSelection();
          fetchCalendarData();
      } catch(e) { setError(e.message); } finally { setIsLoading(false); }
  };

  // ---------------------------------------------------------------------------
  // 4. RENDU
  // ---------------------------------------------------------------------------
  const renderCalendar = () => {
    const year = currentCalendarDate.getFullYear();
    const month = currentCalendarDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const startOffset = firstDay === 0 ? 6 : firstDay - 1; 
    
    const cells = [];
    for (let i=0; i<startOffset; i++) cells.push(<div key={`e-${i}`} />);
    
    for (let d=1; d<=daysInMonth; d++) {
        const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const bk = bookings[dateStr];
        const pr = priceOverrides[dateStr];
        const isSel = selectionStart && dateStr >= selectionStart && dateStr <= (selectionEnd||selectionStart);
        
        cells.push(
            <div key={dateStr} 
                 onMouseDown={()=>handleMouseDown(dateStr)} 
                 onMouseOver={()=>handleMouseOver(dateStr)}
                 className={`h-24 border border-global-stroke-box rounded p-1 cursor-pointer relative transition-colors
                    ${isSel ? 'bg-global-active text-white' : (bk ? 'bg-red-900/40 border-red-500/50' : (pr ? 'bg-blue-900/30 border-blue-500/50' : 'bg-global-bg-box hover:border-global-active'))}
                 `}
            >
                <div className="text-xs font-bold opacity-50">{d}</div>
                <div className="flex items-center justify-center h-full pb-4">
                    {bk ? <span className="text-xs text-red-200 truncate px-1">{bk.guest_name || 'Réservé'}</span> 
                        : <span className={`font-bold ${pr ? 'text-lg' : 'text-sm opacity-30'}`}>{pr ? `${pr}€` : '-'}</span>}
                </div>
            </div>
        );
    }
    return cells;
  };

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-global-blanc">{t('pricing.title')}</h1>
        <div className="flex gap-4">
            {/* SÉLECTEUR CORRIGÉ */}
            <select
                value={selectedId ? (selectedView === 'group' ? `group-${selectedId}` : `property-${selectedId}`) : ''}
                onChange={handleSelectionChange}
                className="bg-global-bg-box border border-global-stroke-box rounded-lg p-2 text-global-blanc min-w-[250px]"
            >
                {properties.map(p => (
                    <option key={p.uniqueId} value={p.uniqueId}>{p.name}</option>
                ))}
            </select>
            
            <Bouton variant="principal" onClick={handleGenerateStrategy} disabled={iaLoading || !selectedId}>
                {iaLoading ? 'Génération IA...' : t('pricing.generateButton')}
            </Bouton>
        </div>
      </div>

      <AlertModal isOpen={alertModal.isOpen} onClose={()=>setAlertModal({...alertModal, isOpen:false})} title={alertModal.title} message={alertModal.message} />
      {error && <div className="bg-red-900/50 border-red-500 border text-red-200 p-4 rounded mb-4">{error}</div>}

      <div className="bg-global-bg-box border border-global-stroke-box rounded-xl p-6 select-none">
          <div className="flex justify-between mb-4">
              <button onClick={()=>setCurrentCalendarDate(new Date(currentCalendarDate.setMonth(currentCalendarDate.getMonth()-1)))} className="p-2 hover:bg-white/10 rounded"><ArrowLeftIcon className="w-5 h-5 text-white"/></button>
              <h2 className="text-xl font-bold text-white capitalize">{currentCalendarDate.toLocaleDateString(language==='en'?'en-US':'fr-FR', {month:'long', year:'numeric'})}</h2>
              <button onClick={()=>setCurrentCalendarDate(new Date(currentCalendarDate.setMonth(currentCalendarDate.getMonth()+1)))} className="p-2 hover:bg-white/10 rounded"><ArrowRightIcon className="w-5 h-5 text-white"/></button>
          </div>

          {isCalendarLoading ? <div className="h-64 flex items-center justify-center text-global-inactive">Chargement...</div> : 
              <div className="grid grid-cols-7 gap-2">
                  {['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'].map(d=><div key={d} className="text-center py-2 text-global-inactive font-bold">{d}</div>)}
                  {renderCalendar()}
              </div>
          }
      </div>

      {/* Panel latérale de modification */}
      {isSelecting && (
          <div className="fixed bottom-0 right-0 w-80 bg-global-bg-box border-l border-global-stroke-box p-6 h-screen shadow-2xl z-50">
              <h3 className="text-lg font-bold text-white mb-4">Éditer {selectionStart === selectionEnd ? selectionStart : `${selectionStart} -> ${selectionEnd}`}</h3>
              <div className="flex gap-2 mb-4">
                  <button onClick={()=>setSelectionMode('booking')} className={`flex-1 p-2 rounded ${selectionMode==='booking'?'bg-global-active text-white':'bg-global-bg-small-box text-gray-400'}`}>Réservation</button>
                  <button onClick={()=>setSelectionMode('manual')} className={`flex-1 p-2 rounded ${selectionMode==='manual'?'bg-global-active text-white':'bg-global-bg-small-box text-gray-400'}`}>Prix</button>
              </div>
              
              {selectionMode === 'booking' ? (
                  <form onSubmit={handleSaveBooking} className="flex flex-col gap-3">
                      <input type="number" placeholder="Prix total ou nuit" value={bookingPrice} onChange={e=>setBookingPrice(e.target.value)} className="p-2 rounded bg-global-bg-small-box text-white border border-gray-700"/>
                      <select value={bookingChannel} onChange={e=>setBookingChannel(e.target.value)} className="p-2 rounded bg-global-bg-small-box text-white border border-gray-700">
                          <option>Direct</option><option>Airbnb</option><option>Booking</option>
                      </select>
                      <Bouton type="submit" variant="principal">Sauvegarder</Bouton>
                  </form>
              ) : (
                  <form onSubmit={handleSavePriceOverride} className="flex flex-col gap-3">
                      <input type="number" placeholder="Nouveau prix" value={manualPrice} onChange={e=>setManualPrice(e.target.value)} className="p-2 rounded bg-global-bg-small-box text-white border border-gray-700"/>
                      <label className="flex gap-2 text-white text-sm"><input type="checkbox" checked={isPriceLocked} onChange={e=>setIsPriceLocked(e.target.checked)}/> Verrouiller (Stop IA)</label>
                      <Bouton type="submit" variant="principal">Appliquer</Bouton>
                  </form>
              )}
              <button onClick={clearSelection} className="mt-4 text-gray-500 w-full hover:text-white">Annuler</button>
          </div>
      )}
    </div>
  );
}

export default PricingPage;