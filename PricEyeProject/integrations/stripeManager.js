/**
 * Module de gestion de l'intégration Stripe pour la facturation
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

/**
 * Met à jour la quantité d'un abonnement Stripe
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
        
        // Trouver les items d'abonnement (on suppose qu'il y a deux produits)
        // Vous devrez ajuster les product IDs selon votre configuration Stripe
        const principalProductId = process.env.STRIPE_PRODUCT_PRINCIPAL_ID;
        const childProductId = process.env.STRIPE_PRODUCT_CHILD_ID;
        const principalPriceId = process.env.STRIPE_PRICE_PRINCIPAL_ID;
        const childPriceId = process.env.STRIPE_PRICE_CHILD_ID;
        
        if (!principalPriceId || !childPriceId) {
            console.warn('[Stripe] Les Price IDs ne sont pas configurés dans les variables d\'environnement.');
            return null;
        }
        
        const subscriptionItems = subscription.items.data;
        let principalItem = subscriptionItems.find(item => {
            const productId = typeof item.price.product === 'string' ? item.price.product : item.price.product.id;
            return productId === principalProductId;
        });
        let childItem = subscriptionItems.find(item => {
            const productId = typeof item.price.product === 'string' ? item.price.product : item.price.product.id;
            return productId === childProductId;
        });
        
        const itemsToUpdate = [];
        
        // Gérer l'item principal
        if (principalItem) {
            if (quantities.quantityPrincipal > 0) {
                // Mettre à jour la quantité existante
                itemsToUpdate.push({
                    id: principalItem.id,
                    quantity: quantities.quantityPrincipal
                });
            } else {
                // Supprimer l'item si la quantité est 0
                itemsToUpdate.push({
                    id: principalItem.id,
                    deleted: true
                });
            }
        } else if (quantities.quantityPrincipal > 0) {
            // Ajouter un nouvel item si nécessaire
            itemsToUpdate.push({
                price: principalPriceId,
                quantity: quantities.quantityPrincipal
            });
        }
        
        // Gérer l'item enfant
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
        
        // Mettre à jour l'abonnement seulement s'il y a des changements
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
        // Ne pas relancer l'erreur pour ne pas bloquer la requête principale
        // L'erreur sera loggée et pourra être traitée séparément
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
        
        const principalPriceId = process.env.STRIPE_PRICE_PRINCIPAL_ID;
        const childPriceId = process.env.STRIPE_PRICE_CHILD_ID;
        
        if (!principalPriceId || !childPriceId) {
            throw new Error('Les Price IDs ne sont pas configurés dans les variables d\'environnement');
        }
        
        // Construire les items d'abonnement
        const items = [];
        
        // Ajouter l'item principal si la quantité > 0
        if (quantities.quantityPrincipal > 0) {
            items.push({
                price: principalPriceId,
                quantity: quantities.quantityPrincipal
            });
        }
        
        // Ajouter l'item enfant si la quantité > 0
        if (quantities.quantityChild > 0) {
            items.push({
                price: childPriceId,
                quantity: quantities.quantityChild
            });
        }
        
        // Si aucun item, retourner une erreur
        if (items.length === 0) {
            throw new Error('Au moins une quantité doit être supérieure à 0 pour créer un abonnement');
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

