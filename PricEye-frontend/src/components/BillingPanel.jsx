import React, { useState, useEffect } from 'react';
import { createCheckoutSession, endTrialAndBill, createPortalSession, getUserProfile } from '../services/api.js';
import { useLanguage } from '../contexts/LanguageContext.jsx';
import ConfirmModal from './ConfirmModal.jsx';

/**
 * Composant pour gérer l'abonnement Stripe
 * @param {string} token - Jeton d'authentification
 * @param {object} userProfile - Profil utilisateur (doit contenir subscriptionStatus, stripeCustomerId, etc.)
 * @param {Function} onProfileUpdate - Callback pour rafraîchir le profil après mise à jour
 */
function BillingPanel({ token, userProfile, onProfileUpdate }) {
  const { t } = useLanguage();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  
  // États pour les modales
  const [showLimitModal, setShowLimitModal] = useState(false);
  const [limitModalData, setLimitModalData] = useState(null);
  const [showEndTrialModal, setShowEndTrialModal] = useState(false);

  // Fonction pour créer une session Checkout
  const handleActivateSubscription = async () => {
    setIsLoading(true);
    setError('');
    setSuccess('');

    try {
      const { url } = await createCheckoutSession(token);
      
      // Rediriger vers Stripe Checkout
      window.location.href = url;
    } catch (err) {
      console.error('Erreur lors de la création de la session Checkout:', err);
      setError(err.message || 'Une erreur est survenue lors de la création de la session de paiement.');
      setIsLoading(false);
    }
  };

  // Fonction pour terminer l'essai et facturer
  const handleEndTrial = async () => {
    setIsLoading(true);
    setError('');
    setSuccess('');

    try {
      const result = await endTrialAndBill(token);
      setSuccess('Essai terminé et facturation effectuée avec succès !');
      setShowEndTrialModal(false);
      
      // Rafraîchir le profil
      if (onProfileUpdate) {
        await onProfileUpdate();
      }
    } catch (err) {
      console.error('Erreur lors de la fin de l\'essai:', err);
      setError(err.message || 'Une erreur est survenue lors de la fin de l\'essai.');
    } finally {
      setIsLoading(false);
    }
  };

  // Fonction pour ouvrir le Customer Portal
  const handleManageSubscription = async () => {
    setIsLoading(true);
    setError('');

    try {
      const { url } = await createPortalSession(token);
      
      // Ouvrir le portal dans une nouvelle fenêtre ou rediriger
      window.location.href = url;
    } catch (err) {
      console.error('Erreur lors de la création de la session Portal:', err);
      setError(err.message || 'Une erreur est survenue lors de l\'ouverture du portail de gestion.');
      setIsLoading(false);
    }
  };

  // Fonction pour afficher la modale de limite
  const showLimitExceededModal = (data) => {
    setLimitModalData(data);
    setShowLimitModal(true);
  };

  // Exposer la fonction pour les autres composants (ex: PropertyModal)
  useEffect(() => {
    // Utiliser une référence stable pour éviter les problèmes de closure
    const stableShowLimitModal = (data) => {
      try {
        setLimitModalData(data);
        setShowLimitModal(true);
      } catch (error) {
        console.error('Erreur lors de l\'affichage de la modale de limite:', error);
      }
    };
    
    // Vérifier que window existe avant d'assigner
    if (typeof window !== 'undefined') {
      window.showLimitExceededModal = stableShowLimitModal;
    }
    
    return () => {
      // Nettoyer proprement lors du démontage
      if (typeof window !== 'undefined' && window.showLimitExceededModal === stableShowLimitModal) {
        try {
          delete window.showLimitExceededModal;
        } catch (error) {
          // Ignorer les erreurs de nettoyage
        }
      }
    };
  }, []);

  // Déterminer le statut de l'abonnement
  const subscriptionStatus = userProfile?.subscriptionStatus || 'none';
  const hasActiveSubscription = subscriptionStatus === 'active' || subscriptionStatus === 'trialing';
  const isTrialing = subscriptionStatus === 'trialing';
  const hasStripeCustomer = !!userProfile?.stripeCustomerId;

  // Calculer les jours restants de l'essai
  const getTrialDaysRemaining = () => {
    if (!isTrialing || !userProfile?.subscriptionCreatedAt) return null;
    
    const createdAt = new Date(userProfile.subscriptionCreatedAt);
    const now = new Date();
    const daysElapsed = Math.floor((now - createdAt) / (1000 * 60 * 60 * 24));
    const daysRemaining = Math.max(0, 30 - daysElapsed);
    
    return daysRemaining;
  };

  const trialDaysRemaining = getTrialDaysRemaining();

  return (
    <div className="bg-global-bg-box rounded-[14px] border border-solid border-global-stroke-box p-6 flex flex-col gap-4">
      <h2 className="text-global-blanc text-left font-h2-font-family text-h2-font-size font-h2-font-weight relative border-b border-global-stroke-box pb-2 mb-4">
        {t('billing.title') || 'Gestion de l\'abonnement'}
      </h2>

      {/* Messages d'erreur et de succès */}
      {error && (
        <div className="bg-red-900/50 text-red-300 p-3 rounded-[10px] text-sm">
          {error}
        </div>
      )}
      {success && (
        <div className="bg-green-900/50 text-green-300 p-3 rounded-[10px] text-sm">
          {success}
        </div>
      )}

      {/* Statut de l'abonnement */}
      <div className="space-y-4">
        {!hasActiveSubscription && (
          <div className="bg-global-bg-small-box border border-global-stroke-box p-4 rounded-[10px]">
            <p className="text-global-inactive text-sm mb-4">
              {t('billing.noSubscription') || 'Vous n\'avez pas encore d\'abonnement actif.'}
            </p>
            <button
              onClick={handleActivateSubscription}
              disabled={isLoading}
              className="px-6 py-2 font-semibold text-white rounded-[10px] bg-gradient-to-r from-[#155dfc] to-[#12a1d5] hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
            >
              {isLoading ? 'Chargement...' : (t('billing.activateSubscription') || 'Activer l\'abonnement')}
            </button>
          </div>
        )}

        {isTrialing && (
          <div className="bg-blue-900/20 border border-blue-700/50 p-4 rounded-[10px]">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-global-blanc font-semibold">
                {t('billing.trialActive') || 'Essai gratuit actif'}
              </h3>
              {trialDaysRemaining !== null && (
                <span className="text-blue-400 text-sm font-medium">
                  {trialDaysRemaining} {trialDaysRemaining === 1 ? 'jour restant' : 'jours restants'}
                </span>
              )}
            </div>
            <p className="text-global-inactive text-sm mb-4">
              {t('billing.trialDescription') || 'Vous bénéficiez d\'un essai gratuit de 30 jours. Vous pouvez ajouter jusqu\'à 10 propriétés pendant cette période.'}
            </p>
            <button
              onClick={() => setShowEndTrialModal(true)}
              disabled={isLoading}
              className="px-4 py-2 text-sm font-semibold text-white rounded-[10px] bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {t('billing.endTrialNow') || 'Terminer l\'essai et payer maintenant'}
            </button>
          </div>
        )}

        {subscriptionStatus === 'active' && (
          <div className="bg-green-900/20 border border-green-700/50 p-4 rounded-[10px]">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-global-blanc font-semibold">
                {t('billing.subscriptionActive') || 'Abonnement actif'}
              </h3>
              <span className="text-green-400 text-sm font-medium">✓ Actif</span>
            </div>
            <p className="text-global-inactive text-sm mb-4">
              {t('billing.subscriptionDescription') || 'Votre abonnement est actif. Vous pouvez gérer votre abonnement, télécharger vos factures et mettre à jour votre carte bancaire.'}
            </p>
            {hasStripeCustomer && (
              <button
                onClick={handleManageSubscription}
                disabled={isLoading}
                className="px-4 py-2 text-sm font-semibold text-white rounded-[10px] bg-gradient-to-r from-[#155dfc] to-[#12a1d5] hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
              >
                {isLoading ? 'Chargement...' : (t('billing.manageSubscription') || 'Gérer mon abonnement')}
              </button>
            )}
          </div>
        )}

        {(subscriptionStatus === 'past_due' || subscriptionStatus === 'unpaid') && (
          <div className="bg-red-900/50 border border-red-700 p-4 rounded-[10px]">
            <h3 className="text-red-400 font-semibold mb-2">
              {t('billing.paymentFailed') || 'Échec de paiement'}
            </h3>
            <p className="text-global-inactive text-sm mb-4">
              {t('billing.paymentFailedDescription') || 'Votre dernier paiement a échoué. Veuillez mettre à jour votre méthode de paiement pour continuer à utiliser Priceye.'}
            </p>
            {hasStripeCustomer && (
              <button
                onClick={handleManageSubscription}
                disabled={isLoading}
                className="px-4 py-2 text-sm font-semibold text-white rounded-[10px] bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isLoading ? 'Chargement...' : (t('billing.updatePaymentMethod') || 'Mettre à jour la méthode de paiement')}
              </button>
            )}
          </div>
        )}

        {subscriptionStatus === 'canceled' && (
          <div className="bg-gray-900/50 border border-gray-700 p-4 rounded-[10px]">
            <h3 className="text-global-inactive font-semibold mb-2">
              {t('billing.subscriptionCanceled') || 'Abonnement annulé'}
            </h3>
            <p className="text-global-inactive text-sm mb-4">
              {t('billing.subscriptionCanceledDescription') || 'Votre abonnement a été annulé. Réactivez votre abonnement pour continuer à utiliser Priceye.'}
            </p>
            <button
              onClick={handleActivateSubscription}
              disabled={isLoading}
              className="px-4 py-2 text-sm font-semibold text-white rounded-[10px] bg-gradient-to-r from-[#155dfc] to-[#12a1d5] hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
            >
              {isLoading ? 'Chargement...' : (t('billing.reactivateSubscription') || 'Réactiver l\'abonnement')}
            </button>
          </div>
        )}
      </div>

      {/* Modale de limite dépassée */}
      <ConfirmModal
        isOpen={showLimitModal}
        onClose={() => setShowLimitModal(false)}
        onConfirm={() => {
          setShowLimitModal(false);
          setShowEndTrialModal(true);
        }}
        title={t('billing.limitExceeded') || 'Limite de propriétés dépassée'}
        message={
          limitModalData
            ? `${t('billing.limitExceededMessage') || 'Vous avez atteint la limite de 10 propriétés pendant votre essai gratuit.'} ${t('billing.limitExceededAction') || 'Pour continuer, vous devez terminer votre essai et activer la facturation maintenant.'}`
            : ''
        }
        confirmText={t('billing.endTrialAndPay') || 'Terminer l\'essai et payer'}
        cancelText={t('common.cancel') || 'Annuler'}
      />

      {/* Modale de confirmation pour terminer l'essai */}
      <ConfirmModal
        isOpen={showEndTrialModal}
        onClose={() => setShowEndTrialModal(false)}
        onConfirm={handleEndTrial}
        title={t('billing.endTrialConfirm') || 'Terminer l\'essai gratuit'}
        message={t('billing.endTrialConfirmMessage') || 'Êtes-vous sûr de vouloir terminer votre essai gratuit maintenant ? Vous serez facturé immédiatement pour le mois en cours.'}
        confirmText={t('billing.confirmEndTrial') || 'Oui, terminer l\'essai'}
        cancelText={t('common.cancel') || 'Annuler'}
      />
    </div>
  );
}

export default BillingPanel;

