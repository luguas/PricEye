/**
 * Script d'ingestion : Peupler la table calendar à partir des données existantes
 * 
 * Ce script :
 * 1. Lit depuis bookings pour remplir is_booked et calculer lead_time
 * 2. Lit depuis price_overrides pour remplir price_published
 * 3. Utilise properties.base_price comme fallback
 * 4. Génère une entrée calendar pour chaque jour pour chaque propriété
 */

const { supabase } = require('../config/supabase.js');
const db = require('../helpers/supabaseDb.js');

/**
 * Génère toutes les dates entre deux dates (incluses)
 */
function generateDateRange(startDate, endDate) {
    const dates = [];
    const current = new Date(startDate);
    const end = new Date(endDate);
    
    while (current <= end) {
        dates.push(new Date(current));
        current.setDate(current.getDate() + 1);
    }
    
    return dates;
}

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
 * Calcule le lead_time en jours entre la date de réservation et la date de check-in
 */
function calculateLeadTime(bookingDate, checkinDate) {
    if (!bookingDate || !checkinDate) return null;
    
    const booking = new Date(bookingDate);
    const checkin = new Date(checkinDate);
    
    const diffTime = checkin - booking;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    return diffDays >= 0 ? diffDays : null;
}

/**
 * Récupère toutes les réservations pour une propriété dans une plage de dates
 */
async function getBookingsForDateRange(propertyId, startDate, endDate) {
    try {
        const { data, error } = await supabase
            .from('bookings')
            .select('*')
            .eq('property_id', propertyId)
            .lte('start_date', endDate) // Les réservations qui chevauchent la période
            .gte('end_date', startDate)
            .order('start_date', { ascending: true });
        
        if (error) throw error;
        return data || [];
    } catch (error) {
        console.error(`Erreur lors de la récupération des bookings pour ${propertyId}:`, error);
        return [];
    }
}

/**
 * Crée ou met à jour les entrées calendar pour une propriété
 */
async function ingestCalendarForProperty(property, startDate, endDate) {
    const propertyId = property.id;
    const basePrice = property.base_price || property.daily_revenue || 0;
    const minStay = property.min_stay || 1;
    const maxStay = property.max_stay || null;
    
    console.log(`[Ingestion] Traitement de la propriété ${propertyId} (${property.name || property.address})`);
    
    // 1. Récupérer les bookings pour la plage de dates
    const bookings = await getBookingsForDateRange(propertyId, startDate, endDate);
    console.log(`  → ${bookings.length} réservation(s) trouvée(s)`);
    
    // 2. Créer un Map de dates avec les données des bookings
    const bookingDatesMap = new Map();
    
    bookings.forEach(booking => {
        const bookingStart = new Date(booking.start_date);
        const bookingEnd = new Date(booking.end_date);
        const bookingCreated = booking.created_at ? new Date(booking.created_at) : null;
        
        // Générer toutes les dates de la réservation (check-in inclus, check-out exclus)
        // Note: end_date est généralement exclusif (jour de départ, pas réservé)
        const checkoutDate = new Date(bookingEnd);
        checkoutDate.setDate(checkoutDate.getDate() - 1); // Dernier jour réservé = end_date - 1 jour
        
        const datesInBooking = generateDateRange(bookingStart, checkoutDate);
        
        // Pour chaque date dans la réservation
        datesInBooking.forEach(date => {
            const dateStr = formatDate(date);
            const leadTime = bookingCreated ? calculateLeadTime(bookingCreated, bookingStart) : null;
            
            bookingDatesMap.set(dateStr, {
                is_booked: true,
                booking_id: booking.id,
                lead_time: leadTime,
                booking_total_price: booking.total_price || null
            });
        });
    });
    
    // 3. Récupérer les price_overrides pour la plage de dates
    const priceOverrides = await db.getPriceOverrides(propertyId, startDate, endDate);
    console.log(`  → ${priceOverrides.length} price override(s) trouvé(s)`);
    
    // 4. Créer un Map des price_overrides
    const priceOverridesMap = new Map();
    
    priceOverrides.forEach(override => {
        if (override.date) {
            priceOverridesMap.set(override.date, {
                price: override.price,
                is_locked: override.is_locked || false,
                reason: override.reason || null
            });
        }
    });
    
    // 5. Générer toutes les dates dans la plage
    const allDates = generateDateRange(new Date(startDate), new Date(endDate));
    
    // 6. Préparer les entrées calendar à insérer/mettre à jour
    const calendarEntries = [];
    
    allDates.forEach(date => {
        const dateStr = formatDate(date);
        const bookingData = bookingDatesMap.get(dateStr);
        const overrideData = priceOverridesMap.get(dateStr);
        
        // Déterminer le prix publié
        let pricePublished = basePrice;
        if (overrideData && overrideData.price !== null) {
            pricePublished = overrideData.price;
        }
        
        // Déterminer is_booked et booking_id
        const isBooked = bookingData ? bookingData.is_booked : false;
        const bookingId = bookingData ? bookingData.booking_id : null;
        const leadTime = bookingData ? bookingData.lead_time : null;
        
        // Déterminer has_manual_override
        const hasManualOverride = overrideData ? overrideData.is_locked : false;
        
        calendarEntries.push({
            property_id: propertyId,
            date: dateStr,
            price_published: pricePublished,
            price_base: basePrice,
            is_booked: isBooked,
            booking_id: bookingId,
            lead_time: leadTime,
            min_stay: minStay,
            max_stay: maxStay,
            has_manual_override: hasManualOverride
        });
    });
    
    // 7. Insérer ou mettre à jour en batch (par chunks de 1000)
    const chunkSize = 1000;
    let insertedCount = 0;
    
    for (let i = 0; i < calendarEntries.length; i += chunkSize) {
        const chunk = calendarEntries.slice(i, i + chunkSize);
        
        try {
            const { data, error } = await supabase
                .from('calendar')
                .upsert(chunk, {
                    onConflict: 'property_id,date',
                    ignoreDuplicates: false
                });
            
            if (error) throw error;
            insertedCount += chunk.length;
        } catch (error) {
            console.error(`Erreur lors de l'insertion du chunk ${i}-${i + chunk.length}:`, error);
            throw error;
        }
    }
    
    console.log(`  ✓ ${insertedCount} entrée(s) calendar créée(s)/mise(s) à jour`);
    
    return {
        propertyId,
        datesProcessed: calendarEntries.length,
        bookingsCount: bookings.length,
        overridesCount: priceOverrides.length
    };
}

/**
 * Fonction principale : Ingère les données calendar pour toutes les propriétés ou pour une propriété spécifique
 * 
 * @param {Object} options - Options d'ingestion
 * @param {string} options.propertyId - (Optionnel) ID d'une propriété spécifique
 * @param {string} options.teamId - (Optionnel) ID d'une équipe (toutes les propriétés de l'équipe)
 * @param {string} options.ownerId - (Optionnel) ID d'un propriétaire (toutes les propriétés du propriétaire)
 * @param {string} options.startDate - Date de début (format YYYY-MM-DD). Par défaut: il y a 12 mois
 * @param {string} options.endDate - Date de fin (format YYYY-MM-DD). Par défaut: dans 90 jours
 * @returns {Promise<Object>} Statistiques d'ingestion
 */
async function ingestCalendarData(options = {}) {
    const {
        propertyId = null,
        teamId = null,
        ownerId = null,
        startDate = null,
        endDate = null
    } = options;
    
    // Calculer les dates par défaut (12 mois en arrière, 90 jours en avant)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const defaultStartDate = new Date(today);
    defaultStartDate.setMonth(defaultStartDate.getMonth() - 12);
    
    const defaultEndDate = new Date(today);
    defaultEndDate.setDate(defaultEndDate.getDate() + 90);
    
    const finalStartDate = startDate || formatDate(defaultStartDate);
    const finalEndDate = endDate || formatDate(defaultEndDate);
    
    console.log(`\n[Ingestion Calendar] Démarrage`);
    console.log(`  Plage de dates: ${finalStartDate} → ${finalEndDate}`);
    
    // Récupérer les propriétés à traiter
    let properties = [];
    
    try {
        if (propertyId) {
            // Une propriété spécifique
            const property = await db.getProperty(propertyId);
            if (property) {
                properties = [property];
            } else {
                throw new Error(`Propriété ${propertyId} non trouvée`);
            }
        } else if (teamId) {
            // Toutes les propriétés d'une équipe
            properties = await db.getPropertiesByTeam(teamId);
        } else if (ownerId) {
            // Toutes les propriétés d'un propriétaire
            properties = await db.getPropertiesByOwner(ownerId);
        } else {
            // Toutes les propriétés (ATTENTION: peut être long!)
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
                const result = await ingestCalendarForProperty(
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
        const totalDatesProcessed = results.reduce((sum, r) => sum + r.datesProcessed, 0);
        const totalBookings = results.reduce((sum, r) => sum + r.bookingsCount, 0);
        const totalOverrides = results.reduce((sum, r) => sum + r.overridesCount, 0);
        
        console.log(`\n[Ingestion Calendar] Terminé`);
        console.log(`  ✓ ${results.length} propriété(s) traitée(s) avec succès`);
        console.log(`  ✓ ${totalDatesProcessed} dates traitées`);
        console.log(`  ✓ ${totalBookings} réservation(s) trouvée(s)`);
        console.log(`  ✓ ${totalOverrides} price override(s) trouvé(s)`);
        
        if (errors.length > 0) {
            console.log(`  ✗ ${errors.length} erreur(s)`);
        }
        
        return {
            processed: results.length,
            totalDatesProcessed,
            totalBookings,
            totalOverrides,
            errors
        };
        
    } catch (error) {
        console.error('[Ingestion Calendar] Erreur fatale:', error);
        throw error;
    }
}

// Si le script est exécuté directement (pas importé)
if (require.main === module) {
    // Récupérer les arguments de la ligne de commande
    const args = process.argv.slice(2);
    
    const options = {};
    
    // Parser les arguments simples
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
    
    // Exécuter l'ingestion
    ingestCalendarData(options)
        .then(result => {
            console.log('\n✓ Ingestion terminée avec succès');
            process.exit(0);
        })
        .catch(error => {
            console.error('\n✗ Erreur lors de l\'ingestion:', error);
            process.exit(1);
        });
}

module.exports = {
    ingestCalendarData,
    ingestCalendarForProperty
};

