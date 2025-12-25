/**
 * Module de gestion de l'intégration Stripe pour la facturation
 * 
 * NOTE IMPORTANTE SUR LE SYSTÈME DE TARIFICATION PAR PALIERS:
 * 
 * Le système de tarification par paliers pour les Parent Units est géré dans server.js
 * via la fonction calculateTieredPricing(). Le montant total calculé selon les paliers
 * est appliqué via des Invoice Items dans recalculateAndUpdateBilling().
 * 
 * Pour une meilleure traçabilité dans Stripe, vous pouvez créer plusieurs Price IDs
 * (un pour chaque palier) et modifier updateSubscriptionQuantities() pour utiliser
 * ces Price IDs au lieu d'un seul Price ID avec des Invoice Items.
 * 
 * Paliers actuels:
 * - 1ère unité : €13.99/mo
 * - Unités 2-5 : €11.99/mo
 * - Unités 6-15 : €8.99/mo
 * - Unités 16-30 : €5.49/mo
 * - 30+ unités : €3.99/mo
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

/**
 * Calcule le prix mensuel total pour les Parent Units selon le système de tarification par paliers.
 * Cette fonction est dupliquée depuis server.js pour éviter les dépendances circulaires.
 * 
 * @param {number} quantityPrincipal - Nombre total de Parent Units
 * @returns {Object} - { totalAmount, breakdown } où totalAmount est en centimes
 */
function calculateTieredPricing(quantityPrincipal) {
    if (quantityPrincipal === 0) {
        return { totalAmount: 0, breakdown: [] };
    }
    
    // Prix en centimes par palier
    const TIERS = [
        { start: 1, end: 1, pricePerUnit: 1399 },      // 1ère unité : €13.99
        { start: 2, end: 5, pricePerUnit: 1199 },     // Unités 2-5 : €11.99
        { start: 6, end: 15, pricePerUnit: 899 },      // Unités 6-15 : €8.99
        { start: 16, end: 30, pricePerUnit: 549 },    // Unités 16-30 : €5.49
        { start: 31, end: Infinity, pricePerUnit: 399 } // 30+ unités : €3.99
    ];
    
    let totalAmount = 0;
    const breakdown = [];
    
    for (const tier of TIERS) {
        if (quantityPrincipal < tier.start) break;
        
        // Calculer combien d'unités dans ce palier
        const unitsInTier = Math.min(quantityPrincipal, tier.end) - tier.start + 1;
        const tierAmount = unitsInTier * tier.pricePerUnit;
        
        if (unitsInTier > 0) {
            totalAmount += tierAmount;
            breakdown.push({
                range: tier.end === Infinity 
                    ? `${tier.start}+` 
                    : tier.start === tier.end 
                        ? `${tier.start}` 
                        : `${tier.start}-${tier.end}`,
                units: unitsInTier,
                pricePerUnit: tier.pricePerUnit,
                amount: tierAmount
            });
        }
    }
    
    return { totalAmount, breakdown };
}

/**
 * Met à jour la quantité d'un abonnement Stripe avec système de paliers pour les Parent Units
 * @param {string} subscriptionId - ID de l'abonnement Stripe
 * @param {Object} quantities - { quantityPrincipal, quantityChild }
 * @returns {Promise<Object>} - L'abonnement mis à jour
 */
async function updateSubscriptionQuantities(subscriptionId, quantities) {
    try {
        if (!process.env.STRIPE_SECRET_KEY) {
            console.warn('[Stripe] STRIPE_SECRET_KEY non configuré. Mise à jour ignorée.');
            return null;
        }
        
        // Récupérer l'abonnement actuel
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const customerId = subscription.customer;
        
        // Trouver les items d'abonnement
        const childProductId = process.env.STRIPE_PRODUCT_CHILD_ID;
        const childPriceId = process.env.STRIPE_PRICE_CHILD_ID;
        
        if (!childPriceId) {
            console.warn('[Stripe] Les Price IDs ne sont pas configurés dans les variables d\'environnement.');
            return null;
        }
        
        const subscriptionItems = subscription.items.data;
        
        // Trouver l'item enfant (Child Units - prix fixe)
        let childItem = subscriptionItems.find(item => {
            const productId = typeof item.price.product === 'string' ? item.price.product : item.price.product.id;
            return productId === childProductId;
        });
        
        // Trouver l'Invoice Item récurrent pour les Parent Units (s'il existe)
        // On cherche dans les invoice items récurrents du customer
        const allInvoiceItems = await stripe.invoiceItems.list({
            customer: customerId,
            limit: 100
        });
        
        // Trouver l'invoice item récurrent pour les Parent Units (celui avec metadata.propertyType = 'principal')
        // Les invoice items récurrents ont un 'subscription' défini
        let principalInvoiceItem = allInvoiceItems.data.find(item => 
            item.subscription === subscriptionId && 
            item.metadata?.propertyType === 'principal'
        );
        
        const itemsToUpdate = [];
        
        // Gérer les Parent Units avec système de paliers via Invoice Item récurrent
        const tieredPricing = calculateTieredPricing(quantities.quantityPrincipal);
        
        if (quantities.quantityPrincipal > 0) {
            // Calculer le montant selon les paliers
            const principalAmount = tieredPricing.totalAmount;
            
            if (principalInvoiceItem) {
                // Mettre à jour l'invoice item récurrent existant
                await stripe.invoiceItems.update(principalInvoiceItem.id, {
                    amount: principalAmount,
                    description: `Parent Units (${quantities.quantityPrincipal} unités) - Tarification par paliers`,
                    metadata: {
                        propertyType: 'principal',
                        quantity: quantities.quantityPrincipal,
                        pricingBreakdown: JSON.stringify(tieredPricing.breakdown)
                    }
                });
                console.log(`[Stripe] Invoice item récurrent mis à jour pour ${quantities.quantityPrincipal} Parent Units: ${principalAmount / 100}€`);
            } else {
                // Créer un nouvel invoice item récurrent
                // Les invoice items avec 'subscription' sont automatiquement récurrents
                await stripe.invoiceItems.create({
                    customer: customerId,
                    subscription: subscriptionId,
                    amount: principalAmount,
                    currency: 'eur',
                    description: `Parent Units (${quantities.quantityPrincipal} unités) - Tarification par paliers`,
                    metadata: {
                        propertyType: 'principal',
                        quantity: quantities.quantityPrincipal,
                        pricingBreakdown: JSON.stringify(tieredPricing.breakdown)
                    }
                });
                console.log(`[Stripe] Invoice item récurrent créé pour ${quantities.quantityPrincipal} Parent Units: ${principalAmount / 100}€`);
            }
        } else if (principalInvoiceItem) {
            // Supprimer l'invoice item si la quantité est 0
            await stripe.invoiceItems.del(principalInvoiceItem.id);
            console.log(`[Stripe] Invoice item récurrent supprimé (0 Parent Units)`);
        }
        
        // Gérer l'item enfant (Child Units - prix fixe 3.99€ par unité)
        if (childItem) {
            if (quantities.quantityChild > 0) {
                // Mettre à jour la quantité existante
                itemsToUpdate.push({
                    id: childItem.id,
                    quantity: quantities.quantityChild
                });
            } else {
                // Supprimer l'item si la quantité est 0
                itemsToUpdate.push({
                    id: childItem.id,
                    deleted: true
                });
            }
        } else if (quantities.quantityChild > 0) {
            // Ajouter un nouvel item si nécessaire
            itemsToUpdate.push({
                price: childPriceId,
                quantity: quantities.quantityChild
            });
        }
        
        // Mettre à jour l'abonnement pour les Child Units seulement s'il y a des changements
        if (itemsToUpdate.length > 0) {
            const updatedSubscription = await stripe.subscriptions.update(subscriptionId, {
                items: itemsToUpdate,
                proration_behavior: 'none' // Pas de proration : les changements prennent effet au prochain cycle
            });
            
            console.log(`[Stripe] Abonnement ${subscriptionId} mis à jour avec succès (changements appliqués au prochain cycle)`);
            return updatedSubscription;
        } else {
            console.log(`[Stripe] Aucune mise à jour nécessaire pour l'abonnement ${subscriptionId}`);
            return subscription;
        }
    } catch (error) {
        console.error('[Stripe] Erreur lors de la mise à jour de l\'abonnement Stripe:', error);
        throw error;
    }
}

/**
 * Crée ou récupère un customer Stripe pour un utilisateur
 * @param {string} userId - ID de l'utilisateur
 * @param {string} email - Email de l'utilisateur
 * @param {string} name - Nom de l'utilisateur
 * @param {string} customerId - ID du customer Stripe existant (optionnel)
 * @returns {Promise<string>} - ID du customer Stripe
 */
async function getOrCreateStripeCustomer(userId, email, name, customerId = null) {
    try {
        if (!process.env.STRIPE_SECRET_KEY) {
            throw new Error('STRIPE_SECRET_KEY non configuré');
        }
        
        // Si un customerId existe déjà, vérifier qu'il est valide
        if (customerId) {
            try {
                const existingCustomer = await stripe.customers.retrieve(customerId);
                if (!existingCustomer.deleted) {
                    return customerId;
                }
            } catch (error) {
                console.warn(`[Stripe] Customer ${customerId} n'existe pas ou a été supprimé. Création d'un nouveau.`);
            }
        }
        
        // Créer un nouveau customer Stripe
        const customer = await stripe.customers.create({
            email: email,
            name: name || 'Utilisateur',
            metadata: {
                userId: userId
            }
        });
        
        return customer.id;
    } catch (error) {
        console.error('[Stripe] Erreur lors de la création/récupération du customer Stripe:', error);
        throw error;
    }
}

/**
 * Crée un abonnement Stripe avec période d'essai
 * @param {string} customerId - ID du customer Stripe
 * @param {string} paymentMethodId - ID de la méthode de paiement
 * @param {Object} quantities - { quantityPrincipal, quantityChild }
 * @param {number} trialPeriodDays - Nombre de jours d'essai gratuit (défaut: 30)
 * @returns {Promise<Object>} - L'abonnement créé
 */
async function createSubscription(customerId, paymentMethodId, quantities, trialPeriodDays = 30) {
    try {
        if (!process.env.STRIPE_SECRET_KEY) {
            throw new Error('STRIPE_SECRET_KEY non configuré');
        }
        
        // Support des deux noms de variables pour compatibilité
        const principalPriceId = process.env.STRIPE_PRICE_PARENT_ID || process.env.STRIPE_PRICE_PRINCIPAL_ID;
        const childPriceId = process.env.STRIPE_PRICE_CHILD_ID;
        
        if (!principalPriceId || !childPriceId) {
            throw new Error('Les Price IDs ne sont pas configurés dans les variables d\'environnement');
        }
        
        // Construire les items d'abonnement
        // NOTE: Les Parent Units utilisent le système de paliers via Invoice Items récurrents
        // On n'ajoute que les Child Units dans les items d'abonnement
        // Si on n'a que des Parent Units, on doit quand même créer un item (on utilisera le Price ID principal à 0€ ou on créera un item temporaire)
        const items = [];
        
        // Ajouter l'item enfant si la quantité > 0
        if (quantities.quantityChild > 0) {
            items.push({
                price: childPriceId,
                quantity: quantities.quantityChild
            });
        }
        
        // Si aucune quantité (ni principal ni enfant), retourner une erreur
        if (items.length === 0 && quantities.quantityPrincipal === 0) {
            throw new Error('Au moins une quantité doit être supérieure à 0 pour créer un abonnement');
        }
        
        // Si on n'a que des Parent Units (pas de Child Units), on doit créer un item temporaire
        // On utilisera le Price ID principal avec quantité 0 (ou on peut créer un Price ID à 0€)
        // Pour l'instant, on crée l'abonnement avec le Price ID principal à quantité 1 (sera remplacé par l'Invoice Item)
        if (items.length === 0 && quantities.quantityPrincipal > 0) {
            // Utiliser le Price ID principal avec quantité 1 comme placeholder
            // L'Invoice Item récurrent remplacera le montant
            items.push({
                price: principalPriceId,
                quantity: 1
            });
        }
        
        // Attacher la méthode de paiement au customer
        await stripe.paymentMethods.attach(paymentMethodId, {
            customer: customerId
        });
        
        // Définir la méthode de paiement comme défaut pour le customer
        await stripe.customers.update(customerId, {
            invoice_settings: {
                default_payment_method: paymentMethodId
            }
        });
        
        // Créer l'abonnement avec période d'essai
        const subscription = await stripe.subscriptions.create({
            customer: customerId,
            items: items,
            trial_period_days: trialPeriodDays,
            metadata: {
                createdAt: new Date().toISOString()
            }
        });
        
        // Si on a utilisé un placeholder pour les Parent Units, supprimer l'item et le remplacer par l'Invoice Item
        if (quantities.quantityPrincipal > 0 && quantities.quantityChild === 0) {
            // Supprimer l'item placeholder
            const principalItem = subscription.items.data.find(item => {
                const priceId = typeof item.price === 'string' ? item.price : item.price.id;
                return priceId === principalPriceId;
            });
            
            if (principalItem) {
                await stripe.subscriptions.update(subscription.id, {
                    items: [{
                        id: principalItem.id,
                        deleted: true
                    }]
                });
            }
        }
        
        // Créer un Invoice Item récurrent pour les Parent Units avec système de paliers
        if (quantities.quantityPrincipal > 0) {
            const tieredPricing = calculateTieredPricing(quantities.quantityPrincipal);
            const principalAmount = tieredPricing.totalAmount;
            
            await stripe.invoiceItems.create({
                customer: customerId,
                subscription: subscription.id,
                amount: principalAmount,
                currency: 'eur',
                description: `Parent Units (${quantities.quantityPrincipal} unités) - Tarification par paliers`,
                metadata: {
                    propertyType: 'principal',
                    quantity: quantities.quantityPrincipal,
                    pricingBreakdown: JSON.stringify(tieredPricing.breakdown)
                }
            });
            
            console.log(`[Stripe] Invoice item récurrent créé pour ${quantities.quantityPrincipal} Parent Units: ${principalAmount / 100}€`);
        }
        
        console.log(`[Stripe] Abonnement créé avec succès: ${subscription.id}`);
        return subscription;
    } catch (error) {
        console.error('[Stripe] Erreur lors de la création de l\'abonnement:', error);
        throw error;
    }
}

module.exports = {
    updateSubscriptionQuantities,
    getOrCreateStripeCustomer,
    createSubscription
};

