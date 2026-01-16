import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { getProperties, generatePricingStrategy, addBooking, getBookingsForMonth, getGroups, updateGroup, getUserProfile, getAutoPricingStatus, enableAutoPricing, getPriceOverrides, updatePriceOverrides, applyPricingStrategy } from '../services/api.js';
import { jwtDecode } from 'jwt-decode'; 
import Bouton from '../components/Bouton.jsx';
import AlertModal from '../components/AlertModal.jsx';
import { useLanguage } from '../contexts/LanguageContext.jsx';
import { handleQuotaError, checkQuotaStatus } from '../utils/quotaErrorHandler.js';
import { supabase } from '../config/supabase.js'; 
// Import d'icônes standard (remplacement de Heroicons pour éviter erreur build)
const ArrowLeftIcon = () => <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" /></svg>;
const ArrowRightIcon = () => <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>;

function PricingPage({ token, userProfile }) {
  const { t, language } = useLanguage();
  
  // États de données (Logique Corrigée)
  const [properties, setProperties] = useState([]);
  const [allGroups, setAllGroups] = useState([]);
  
  // États de sélection (Logique Corrigée)
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
  // 1. CHARGEMENT INITIAL (PROPRIÉTÉS + GROUPES) - Logique Corrigée
  // ---------------------------------------------------------------------------
  const fetchInitialData = useCallback(async () => {
    if (!token) return; 
    setIsLoading(true);
    setError(''); 
    
    try {
      const propsData = await getProperties(token);
      const { data: groupsData, error: groupsError } = await supabase
        .from('groups') 
        .select('*');

      if (groupsError) console.error("Erreur groupes:", groupsError);

      setAllGroups(groupsData || []);

      const formattedGroups = (groupsData || [])
        .filter(g => g.main_property_id)
        .map(g => ({
          uniqueId: `group-${g.id}`,
          realId: g.id,
          type: 'group',
          name: `👥 Groupe: ${g.name}`,
          mainPropertyId: g.main_property_id,
          ...g
        }));

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

  useEffect(() => {
    fetchInitialData();
  }, [fetchInitialData]);


  // ---------------------------------------------------------------------------
  // 2. CHARGEMENT DU CALENDRIER - Logique Corrigée
  // ---------------------------------------------------------------------------
  const fetchCalendarData = useCallback(async () => {
    if (!selectedId) return;
    setIsCalendarLoading(true);
    setError('');
    
    let targetPropertyId = selectedId; 

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
      
      let overridesData = await getPriceOverrides(targetPropertyId, token, startOfMonth, endOfMonth).catch(() => ({}));
      const newOverrides = {};
      if (Array.isArray(overridesData)) {
        overridesData.forEach(o => { if (o.date) newOverrides[o.date] = o.price; });
      } else if (overridesData && typeof overridesData === 'object') {
        Object.keys(overridesData).forEach(d => { newOverrides[d] = overridesData[d]?.price || overridesData[d]; });
      }
      setPriceOverrides(newOverrides);

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
    } finally {
      setIsCalendarLoading(false);
    }
  }, [selectedId, selectedView, currentCalendarDate, token, allGroups]); 

  useEffect(() => {
      fetchCalendarData();
  }, [fetchCalendarData]);


  // ---------------------------------------------------------------------------
  // 3. HANDLERS ACTIONS - Logique Corrigée
  // ---------------------------------------------------------------------------
  
  const handleSelectionChange = (e) => {
      const selectedValue = e.target.value;
      const item = properties.find(p => p.uniqueId === selectedValue);
      
      if (item) {
          setPriceOverrides({}); 
          setBookings({});
          setSelectedView(item.type); 
          setSelectedId(item.realId);
      }
  };

  const handleGenerateStrategy = async () => {
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
      const result = await applyPricingStrategy(
          targetId, 
          selectedView === 'group' ? allGroups.find(g => String(g.id) === String(selectedId)) : null,
          token 
      );
      setAlertModal({ isOpen: true, message: t('pricing.errors.strategySuccess', { count: result.days_generated || 180 }), title: t('pricing.modal.success') });
      fetchCalendarData(); 
    } catch (err) {
        if (!err.isQuotaExceeded) setError(t('pricing.errors.strategyError', { message: err.message }));
    } finally {
        setIaLoading(false);
    }
  };

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

  const handleSavePriceOverride = async (e) => {
      e.preventDefault();
      let targets = [selectedId];
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
  // 4. RENDU - Style Restauré (comme votre version originale)
  // ---------------------------------------------------------------------------
  const renderCalendar = () => {
    const year = currentCalendarDate.getFullYear();
    const month = currentCalendarDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const startOffset = firstDay === 0 ? 6 : firstDay - 1; 
    
    const cells = [];
    for (let i=0; i<startOffset; i++) cells.push(<div key={`e-${i}`} className="h-24 bg-transparent"></div>);
    
    for (let d=1; d<=daysInMonth; d++) {
        const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const booking = bookings[dateStr];
        const overridePrice = priceOverrides[dateStr];
        
        let bgColor = 'bg-global-bg-box';
        if (booking) bgColor = 'bg-red-900/50 border-red-500';
        else if (overridePrice) bgColor = 'bg-blue-900/30 border-blue-500';
        
        const isSelected = selectionStart && dateStr >= selectionStart && dateStr <= (selectionEnd || selectionStart);
        if (isSelected) bgColor = 'bg-global-active text-white border-white';

        cells.push(
            <div 
                key={dateStr}
                onMouseDown={() => handleMouseDown(dateStr)}
                onMouseOver={() => handleMouseOver(dateStr)}
                className={`h-24 border border-global-stroke-box rounded p-1 cursor-pointer hover:border-global-active transition-all relative ${bgColor}`}
            >
                <div className="text-xs font-bold text-global-inactive">{d}</div>
                {booking ? (
                    <div className="text-xs mt-2 text-red-200 truncate">{booking.guest_name || 'Réservé'}</div>
                ) : (
                    <div className="mt-2 text-center">
                        {overridePrice ? (
                            <span className="font-bold text-lg text-global-blanc">{overridePrice}€</span>
                        ) : (
                            <span className="text-xs text-global-inactive">-</span>
                        )}
                    </div>
                )}
            </div>
        );
    }
    return cells;
  };

  return (
    <div className="p-6 relative min-h-screen">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-global-blanc">{t('pricing.title')}</h1>
        <div className="flex gap-4 items-center">
            <select
                value={selectedId ? (selectedView === 'group' ? `group-${selectedId}` : `property-${selectedId}`) : ''}
                onChange={handleSelectionChange}
                className="bg-global-bg-box border border-global-stroke-box rounded-lg p-2 text-global-blanc min-w-[250px]"
            >
                {properties.map(p => (
                    <option key={p.uniqueId} value={p.uniqueId}>{p.name}</option>
                ))}
            </select>
            
            <Bouton 
                variant="principal" 
                onClick={handleGenerateStrategy}
                disabled={iaLoading || isCalendarLoading || !selectedId}
            >
                {iaLoading ? 'Génération...' : t('pricing.generateButton')}
            </Bouton>
        </div>
      </div>

      <AlertModal 
        isOpen={alertModal.isOpen} 
        onClose={() => setAlertModal({ ...alertModal, isOpen: false })}
        title={alertModal.title}
        message={alertModal.message}
      />
      {error && (
        <div className="bg-red-900/50 border border-red-500 text-red-200 p-4 rounded-lg mb-6">
            {error}
        </div>
      )}

      <div className="bg-global-bg-box border border-global-stroke-box rounded-xl p-6">
          <div className="flex justify-between mb-4">
              <button onClick={() => setCurrentCalendarDate(new Date(currentCalendarDate.setMonth(currentCalendarDate.getMonth() - 1)))} className="text-global-blanc hover:text-global-active p-2">
                  <ArrowLeftIcon />
              </button>
              <h2 className="text-xl font-bold text-global-blanc capitalize">
                  {currentCalendarDate.toLocaleDateString(language === 'en' ? 'en-US' : 'fr-FR', { month: 'long', year: 'numeric' })}
              </h2>
              <button onClick={() => setCurrentCalendarDate(new Date(currentCalendarDate.setMonth(currentCalendarDate.getMonth() + 1)))} className="text-global-blanc hover:text-global-active p-2">
                  <ArrowRightIcon />
              </button>
          </div>

          {isCalendarLoading ? (
              <div className="h-64 flex items-center justify-center text-global-inactive">Chargement...</div>
          ) : (
              <div className="grid grid-cols-7 gap-2">
                  {['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'].map(d => (
                      <div key={d} className="text-center font-bold text-global-inactive py-2">{d}</div>
                  ))}
                  {renderCalendar()}
              </div>
          )}
      </div>

      {isSelecting && (
          <div className="fixed bottom-0 right-0 w-80 bg-global-bg-box border-l border-global-stroke-box p-6 h-screen shadow-2xl z-50 transform transition-transform translate-x-0">
              <h3 className="text-lg font-bold text-global-blanc mb-4">Modifier la sélection</h3>
              <p className="text-global-inactive mb-4">Du {selectionStart} au {selectionEnd}</p>
              
              <div className="flex gap-2 mb-4">
                  <button 
                    onClick={() => setSelectionMode('booking')} 
                    className={`flex-1 p-2 rounded ${selectionMode === 'booking' ? 'bg-global-active text-white' : 'bg-global-bg-small-box text-global-inactive'}`}
                  >
                      Réservation
                  </button>
                  <button 
                    onClick={() => setSelectionMode('manual')} 
                    className={`flex-1 p-2 rounded ${selectionMode === 'manual' ? 'bg-global-active text-white' : 'bg-global-bg-small-box text-global-inactive'}`}
                  >
                      Prix Manuel
                  </button>
              </div>

              {selectionMode === 'booking' ? (
                  <form onSubmit={handleSaveBooking} className="flex flex-col gap-3">
                      <input 
                        type="number" 
                        placeholder="Prix / Nuit" 
                        value={bookingPrice} 
                        onChange={e => setBookingPrice(e.target.value)} 
                        className="p-2 rounded bg-global-bg-small-box text-global-blanc border border-global-stroke-box outline-none focus:border-global-active"
                      />
                      <select 
                        value={bookingChannel} 
                        onChange={e => setBookingChannel(e.target.value)}
                        className="p-2 rounded bg-global-bg-small-box text-global-blanc border border-global-stroke-box outline-none focus:border-global-active"
                      >
                          <option value="Direct">Direct</option>
                          <option value="Airbnb">Airbnb</option>
                          <option value="Booking">Booking</option>
                      </select>
                      <Bouton type="submit" variant="principal" className="mt-2">Enregistrer</Bouton>
                  </form>
              ) : (
                  <form onSubmit={handleSavePriceOverride} className="flex flex-col gap-3">
                      <input 
                        type="number" 
                        placeholder="Nouveau Prix" 
                        value={manualPrice} 
                        onChange={e => setManualPrice(e.target.value)} 
                        className="p-2 rounded bg-global-bg-small-box text-global-blanc border border-global-stroke-box outline-none focus:border-global-active"
                      />
                      <label className="flex items-center gap-2 text-global-blanc text-sm cursor-pointer">
                          <input 
                            type="checkbox" 
                            checked={isPriceLocked} 
                            onChange={e => setIsPriceLocked(e.target.checked)} 
                            className="accent-global-active"
                          />
                          Verrouiller ce prix (ignorer IA)
                      </label>
                      <Bouton type="submit" variant="principal" className="mt-2">Mettre à jour</Bouton>
                  </form>
              )}
              
              <button onClick={clearSelection} className="mt-4 text-sm text-global-inactive hover:text-white w-full text-center transition-colors">Annuler</button>
          </div>
      )}
    </div>
  );
}

export default PricingPage;