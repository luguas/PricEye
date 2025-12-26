/**
 * Script de feature engineering : Construire la table features_pricing_daily
 * 
 * Ce script :
 * 1. Lit depuis calendar et properties pour calculer les features
 * 2. Calcule les métriques d'occupation (occupancy_rate_7d, occupancy_rate_30d, occupancy_rate_90d)
 * 3. Calcule les features temporelles (day_of_week, season, is_weekend, etc.)
 * 4. Calcule les features de prix, disponibilité, et demande
 * 5. Stocke dans features_pricing_daily
 */

const { supabase } = require('../config/supabase.js');
const db = require('../helpers/supabaseDb.js');

/**
 * Formate une date au format YYYY-MM-DD
 */
function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Calcule les features temporelles pour une date
 */
function calculateTemporalFeatures(date) {
    const d = new Date(date);
    
    // day_of_week: 0 = Dimanche, 1 = Lundi, ..., 6 = Samedi
    // On veut: 0 = Lundi, 6 = Dimanche
    let dayOfWeek = d.getDay();
    dayOfWeek = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    
    const isWeekend = dayOfWeek >= 5; // Samedi (5) ou Dimanche (6)
    const month = d.getMonth() + 1; // 1-12
    const dayOfMonth = d.getDate();
    const quarter = Math.floor((month - 1) / 3) + 1; // 1-4
    
    // Déterminer la saison (hémisphère nord)
    let season;
    if (month >= 3 && month <= 5) {
        season = 'spring';
    } else if (month >= 6 && month <= 8) {
        season = 'summer';
    } else if (month >= 9 && month <= 11) {
        season = 'autumn';
    } else {
        season = 'winter';
    }
    
    // TODO: is_holiday - nécessite une table de jours fériés
    const isHoliday = false;
    
    return {
        day_of_week: dayOfWeek,
        is_weekend: isWeekend,
        month: month,
        day_of_month: dayOfMonth,
        quarter: quarter,
        season: season,
        is_holiday: isHoliday
    };
}

/**
 * Calcule les métriques d'occupation pour une propriété à une date donnée
 * 
 * @param {string} propertyId - ID de la propriété (non utilisé mais gardé pour cohérence)
 * @param {string} targetDate - Date cible (format YYYY-MM-DD)
 * @param {Array} calendarData - Données calendar historiques jusqu'à la date cible (exclue)
 */
async function calculateOccupancyMetrics(propertyId, targetDate, calendarData) {
    const target = new Date(targetDate);
    
    // Calculer les plages de dates pour 7d, 30d, 90d (fenêtres glissantes avant la date cible)
    const range7dStart = new Date(target);
    range7dStart.setDate(range7dStart.getDate() - 7);
    
    const range30dStart = new Date(target);
    range30dStart.setDate(range30dStart.getDate() - 30);
    
    const range90dStart = new Date(target);
    range90dStart.setDate(range90dStart.getDate() - 90);
    
    const startDate7d = formatDate(range7dStart);
    const startDate30d = formatDate(range30dStart);
    const startDate90d = formatDate(range90dStart);
    const endDate = formatDate(target);
    
    // Filtrer les données calendar pour les plages (avant la date cible uniquement)
    const data7d = calendarData.filter(c => {
        const cDate = new Date(c.date);
        return cDate >= new Date(startDate7d) && cDate < new Date(endDate);
    });
    
    const data30d = calendarData.filter(c => {
        const cDate = new Date(c.date);
        return cDate >= new Date(startDate30d) && cDate < new Date(endDate);
    });
    
    const data90d = calendarData.filter(c => {
        const cDate = new Date(c.date);
        return cDate >= new Date(startDate90d) && cDate < new Date(endDate);
    });
    
    // Calculer les taux d'occupation
    const occupancyRate7d = data7d.length > 0 
        ? (data7d.filter(c => c.is_booked).length / data7d.length) * 100 
        : 0;
    
    const occupancyRate30d = data30d.length > 0 
        ? (data30d.filter(c => c.is_booked).length / data30d.length) * 100 
        : 0;
    
    const occupancyRate90d = data90d.length > 0 
        ? (data90d.filter(c => c.is_booked).length / data90d.length) * 100 
        : 0;
    
    // Compter le nombre de réservations uniques (par booking_id)
    const uniqueBookings7d = new Set(
        data7d
            .filter(c => c.is_booked && c.booking_id)
            .map(c => c.booking_id)
    );
    
    const uniqueBookings30d = new Set(
        data30d
            .filter(c => c.is_booked && c.booking_id)
            .map(c => c.booking_id)
    );
    
    return {
        occupancy_rate_7d: Math.round(occupancyRate7d * 100) / 100, // Arrondir à 2 décimales
        occupancy_rate_30d: Math.round(occupancyRate30d * 100) / 100,
        occupancy_rate_90d: Math.round(occupancyRate90d * 100) / 100,
        booking_count_7d: uniqueBookings7d.size,
        booking_count_30d: uniqueBookings30d.size
    };
}

/**
 * Calcule les jours depuis/until la dernière/prochaine réservation
 */
function calculateBookingGaps(calendarData, targetDate) {
    const target = new Date(targetDate);
    const targetDateStr = formatDate(target);
    
    // Trier les dates réservées
    const bookedDates = calendarData
        .filter(c => c.is_booked && c.date !== targetDateStr)
        .map(c => ({ date: new Date(c.date), booking_id: c.booking_id }))
        .sort((a, b) => a.date - b.date);
    
    // Trouver la dernière réservation avant la date cible
    const lastBooking = bookedDates
        .filter(b => b.date < target)
        .pop();
    
    // Trouver la prochaine réservation après la date cible
    const nextBooking = bookedDates
        .filter(b => b.date > target)
        .shift();
    
    let daysSinceLastBooking = null;
    let daysUntilNextBooking = null;
    
    if (lastBooking) {
        const diff = target - lastBooking.date;
        daysSinceLastBooking = Math.floor(diff / (1000 * 60 * 60 * 24));
    }
    
    if (nextBooking) {
        const diff = nextBooking.date - target;
        daysUntilNextBooking = Math.floor(diff / (1000 * 60 * 60 * 24));
    }
    
    return {
        days_since_last_booking: daysSinceLastBooking,
        days_until_next_booking: daysUntilNextBooking
    };
}

/**
 * Calcule un score de demande basé sur l'occupation et les tendances
 */
function calculateDemandScore(occupancyMetrics, bookingGaps) {
    // Score basé sur l'occupation récente (poids: 70%)
    const occupancyScore = occupancyMetrics.occupancy_rate_7d;
    
    // Score basé sur la proximité des réservations (poids: 30%)
    let proximityScore = 50; // Score par défaut
    
    if (bookingGaps.days_since_last_booking !== null) {
        // Plus récent = plus élevé
        if (bookingGaps.days_since_last_booking <= 3) proximityScore = 90;
        else if (bookingGaps.days_since_last_booking <= 7) proximityScore = 70;
        else if (bookingGaps.days_since_last_booking <= 14) proximityScore = 50;
        else proximityScore = 30;
    }
    
    if (bookingGaps.days_until_next_booking !== null) {
        // Plus proche = plus élevé
        if (bookingGaps.days_until_next_booking <= 7) proximityScore = Math.max(proximityScore, 80);
        else if (bookingGaps.days_until_next_booking <= 14) proximityScore = Math.max(proximityScore, 60);
    }
    
    // Score combiné
    const demandScore7d = (occupancyScore * 0.7) + (proximityScore * 0.3);
    
    // Score 30d basé uniquement sur l'occupation
    const demandScore30d = occupancyMetrics.occupancy_rate_30d;
    
    return {
        demand_score_7d: Math.min(100, Math.round(demandScore7d * 100) / 100),
        demand_score_30d: Math.min(100, Math.round(demandScore30d * 100) / 100)
    };
}

/**
 * Construit les features pour une propriété sur une plage de dates
 */
async function buildFeaturesForProperty(property, startDate, endDate) {
    const propertyId = property.id;
    
    console.log(`[Features] Traitement de la propriété ${propertyId} (${property.name || property.address})`);
    
    // 1. Récupérer les données calendar pour cette propriété
    const { data: calendarData, error: calendarError } = await supabase
        .from('calendar')
        .select('*')
        .eq('property_id', propertyId)
        .gte('date', startDate)
        .lte('date', endDate)
        .order('date', { ascending: true });
    
    if (calendarError) {
        throw new Error(`Erreur lors de la récupération des données calendar: ${calendarError.message}`);
    }
    
    if (!calendarData || calendarData.length === 0) {
        console.log(`  → Aucune donnée calendar trouvée pour cette propriété`);
        return { processed: 0 };
    }
    
    console.log(`  → ${calendarData.length} entrée(s) calendar trouvée(s)`);
    
    // 2. Pour chaque date, calculer les features
    const features = [];
    
    // Récupérer toutes les données calendar historiques pour calculer les métriques d'occupation
    // (on a besoin de plus de données que la plage cible pour calculer les métriques)
    const historicalEndDate = endDate;
    const historicalStartDate = new Date(historicalEndDate);
    historicalStartDate.setDate(historicalStartDate.getDate() - 90); // 90 jours en arrière pour avoir les métriques
    
    const { data: historicalCalendarData, error: historicalError } = await supabase
        .from('calendar')
        .select('*')
        .eq('property_id', propertyId)
        .gte('date', formatDate(historicalStartDate))
        .lt('date', historicalEndDate)
        .order('date', { ascending: true });
    
    if (historicalError) {
        console.warn(`  ⚠ Erreur lors de la récupération des données historiques: ${historicalError.message}`);
    }
    
    const allCalendarData = historicalCalendarData || [];
    
    for (const calendarEntry of calendarData) {
        const date = calendarEntry.date;
        
        // Features temporelles
        const temporalFeatures = calculateTemporalFeatures(date);
        
        // Features de prix
        const pricePublished = calendarEntry.price_published || property.base_price || 0;
        const priceBase = calendarEntry.price_base || property.base_price || 0;
        const priceDifference = pricePublished - priceBase;
        const pricePerBedroom = (property.bedrooms && property.bedrooms > 0) 
            ? pricePublished / property.bedrooms 
            : null;
        
        // Features de disponibilité
        const isBooked = calendarEntry.is_booked || false;
        const leadTime = calendarEntry.lead_time;
        
        // Métriques d'occupation (utiliser les données jusqu'à la date cible exclusivement)
        const historicalDataUpToDate = allCalendarData.filter(c => {
            const cDate = new Date(c.date);
            const targetDate = new Date(date);
            return cDate < targetDate;
        });
        
        const occupancyMetrics = await calculateOccupancyMetrics(
            propertyId, 
            date, 
            historicalDataUpToDate
        );
        
        // Jours depuis/until réservations (utiliser toutes les données historiques)
        const bookingGaps = calculateBookingGaps(
            historicalDataUpToDate,
            date
        );
        
        // Score de demande
        const demandScores = calculateDemandScore(occupancyMetrics, bookingGaps);
        
        // Construire l'entrée feature
        const feature = {
            property_id: propertyId,
            date: date,
            
            // Temporel
            ...temporalFeatures,
            
            // Prix
            price_published: pricePublished,
            price_base: priceBase,
            price_difference_from_base: priceDifference,
            price_per_bedroom: pricePerBedroom,
            
            // Disponibilité
            is_booked: isBooked,
            lead_time: leadTime,
            days_since_last_booking: bookingGaps.days_since_last_booking,
            days_until_next_booking: bookingGaps.days_until_next_booking,
            
            // Occupation
            ...occupancyMetrics,
            
            // Demande
            ...demandScores,
            
            // Propriété (features statiques)
            property_type: property.property_type,
            bedrooms: property.bedrooms,
            bathrooms: property.bathrooms,
            city: property.city,
            country: property.country
        };
        
        features.push(feature);
    }
    
    // 3. Insérer ou mettre à jour en batch
    const chunkSize = 1000;
    let insertedCount = 0;
    
    for (let i = 0; i < features.length; i += chunkSize) {
        const chunk = features.slice(i, i + chunkSize);
        
        try {
            const { error } = await supabase
                .from('features_pricing_daily')
                .upsert(chunk, {
                    onConflict: 'property_id,date',
                    ignoreDuplicates: false
                });
            
            if (error) throw error;
            insertedCount += chunk.length;
        } catch (error) {
            console.error(`  ✗ Erreur lors de l'insertion du chunk ${i}-${i + chunk.length}:`, error);
            throw error;
        }
    }
    
    console.log(`  ✓ ${insertedCount} feature(s) créée(s)/mise(s) à jour`);
    
    return {
        propertyId,
        processed: insertedCount
    };
}

/**
 * Fonction principale : Construit les features pour toutes les propriétés ou pour une propriété spécifique
 * 
 * @param {Object} options - Options
 * @param {string} options.propertyId - (Optionnel) ID d'une propriété spécifique
 * @param {string} options.teamId - (Optionnel) ID d'une équipe
 * @param {string} options.ownerId - (Optionnel) ID d'un propriétaire
 * @param {string} options.startDate - Date de début (format YYYY-MM-DD). Par défaut: aujourd'hui
 * @param {string} options.endDate - Date de fin (format YYYY-MM-DD). Par défaut: dans 90 jours
 * @returns {Promise<Object>} Statistiques
 */
async function buildFeaturesPricingDaily(options = {}) {
    const {
        propertyId = null,
        teamId = null,
        ownerId = null,
        startDate = null,
        endDate = null
    } = options;
    
    // Calculer les dates par défaut (aujourd'hui → 90 jours)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const defaultStartDate = today;
    const defaultEndDate = new Date(today);
    defaultEndDate.setDate(defaultEndDate.getDate() + 90);
    
    const finalStartDate = startDate || formatDate(defaultStartDate);
    const finalEndDate = endDate || formatDate(defaultEndDate);
    
    console.log(`\n[Build Features] Démarrage`);
    console.log(`  Plage de dates: ${finalStartDate} → ${finalEndDate}`);
    
    // Récupérer les propriétés à traiter
    let properties = [];
    
    try {
        if (propertyId) {
            const property = await db.getProperty(propertyId);
            if (property) {
                properties = [property];
            } else {
                throw new Error(`Propriété ${propertyId} non trouvée`);
            }
        } else if (teamId) {
            properties = await db.getPropertiesByTeam(teamId);
        } else if (ownerId) {
            properties = await db.getPropertiesByOwner(ownerId);
        } else {
            // Toutes les propriétés
            const { data, error } = await supabase
                .from('properties')
                .select('*');
            
            if (error) throw error;
            properties = data || [];
        }
        
        console.log(`  ${properties.length} propriété(s) à traiter\n`);
        
        if (properties.length === 0) {
            console.log('Aucune propriété à traiter.');
            return { processed: 0, errors: [] };
        }
        
        // Traiter chaque propriété
        const results = [];
        const errors = [];
        
        for (const property of properties) {
            try {
                const result = await buildFeaturesForProperty(
                    property,
                    finalStartDate,
                    finalEndDate
                );
                results.push(result);
            } catch (error) {
                console.error(`  ✗ Erreur pour la propriété ${property.id}:`, error.message);
                errors.push({
                    propertyId: property.id,
                    error: error.message
                });
            }
        }
        
        // Résumé
        const totalProcessed = results.reduce((sum, r) => sum + (r.processed || 0), 0);
        
        console.log(`\n[Build Features] Terminé`);
        console.log(`  ✓ ${results.length} propriété(s) traitée(s) avec succès`);
        console.log(`  ✓ ${totalProcessed} feature(s) créée(s)/mise(s) à jour`);
        
        if (errors.length > 0) {
            console.log(`  ✗ ${errors.length} erreur(s)`);
        }
        
        return {
            processed: results.length,
            totalFeaturesProcessed: totalProcessed,
            errors
        };
        
    } catch (error) {
        console.error('[Build Features] Erreur fatale:', error);
        throw error;
    }
}

// Si le script est exécuté directement
if (require.main === module) {
    const args = process.argv.slice(2);
    
    const options = {};
    
    args.forEach(arg => {
        if (arg.startsWith('--property-id=')) {
            options.propertyId = arg.split('=')[1];
        } else if (arg.startsWith('--team-id=')) {
            options.teamId = arg.split('=')[1];
        } else if (arg.startsWith('--owner-id=')) {
            options.ownerId = arg.split('=')[1];
        } else if (arg.startsWith('--start-date=')) {
            options.startDate = arg.split('=')[1];
        } else if (arg.startsWith('--end-date=')) {
            options.endDate = arg.split('=')[1];
        }
    });
    
    buildFeaturesPricingDaily(options)
        .then(result => {
            console.log('\n✓ Feature engineering terminé avec succès');
            process.exit(0);
        })
        .catch(error => {
            console.error('\n✗ Erreur lors du feature engineering:', error);
            process.exit(1);
        });
}

module.exports = {
    buildFeaturesPricingDaily,
    buildFeaturesForProperty
};

