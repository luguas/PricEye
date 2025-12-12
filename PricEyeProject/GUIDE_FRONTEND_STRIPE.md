# 🎨 Guide d'Intégration Frontend - Stripe Billing

## 📋 Vue d'ensemble

Ce guide vous explique comment intégrer toutes les fonctionnalités Stripe côté frontend pour Priceye.

---

## 🔧 Étape 1 : Configuration Initiale

### 1.1 Variables d'environnement

Ajoutez la clé publique Stripe dans votre fichier `.env` du frontend :

```env
VITE_STRIPE_PUBLIC_KEY=pk_test_51SXqLnG8ypIuy6LARlB49xAiphTudIodq9BFRda7lbrYCMUF5uIB7KBAgLBvrmg8gb30f2Cb5el7JsknEGSh6g5s00hEhg8wLd
```

**Note :** Pour la production, utilisez la clé publique LIVE (`pk_live_...`).

### 1.2 Installation des dépendances

Aucune dépendance supplémentaire n'est nécessaire. Stripe Checkout utilise une simple redirection, pas de SDK frontend.

---

## 📝 Étape 2 : Ajouter les fonctions API

### 2.1 Modifier `src/services/api.js`

Ajoutez ces nouvelles fonctions à la fin du fichier :

```javascript
// ===== FONCTIONS STRIPE BILLING =====

/**
 * Crée une session Stripe Checkout pour l'onboarding
 * @param {string} token - Jeton d'authentification Priceye
 * @returns {Promise<{url: string, sessionId: string}>}
 */
export async function createCheckoutSession(token) {
  return apiRequest('/api/checkout/create-session', {
    method: 'POST',
    token: token,
  });
}

/**
 * Termine l'essai gratuit et facture immédiatement
 * @param {string} token - Jeton d'authentification Priceye
 * @returns {Promise<{message: string, subscriptionId: string, invoiceId: string, status: string}>}
 */
export async function endTrialAndBill(token) {
  return apiRequest('/api/subscriptions/end-trial-and-bill', {
    method: 'POST',
    token: token,
  });
}

/**
 * Crée une session Stripe Customer Portal
 * @param {string} token - Jeton d'authentification Priceye
 * @returns {Promise<{url: string}>}
 */
export async function createPortalSession(token) {
  return apiRequest('/api/billing/portal-session', {
    method: 'POST',
    token: token,
  });
}
```

---

## 🎨 Étape 3 : Créer le composant de gestion de l'abonnement

### 3.1 Créer `src/components/BillingPanel.jsx`

Créez un nouveau composant pour gérer l'abonnement :

```javascript
import React, { useState, useEffect } from 'react';
import { createCheckoutSession, endTrialAndBill, createPortalSession, getUserProfile } from '../services/api.js';
import { useLanguage } from '../contexts/LanguageContext.jsx';
import AlertModal from './AlertModal.jsx';
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
    window.showLimitExceededModal = showLimitExceededModal;
    return () => {
      delete window.showLimitExceededModal;
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
      <AlertModal
        isOpen={showLimitModal}
        onClose={() => setShowLimitModal(false)}
        title={t('billing.limitExceeded') || 'Limite de propriétés dépassée'}
        message={
          limitModalData
            ? `${t('billing.limitExceededMessage') || 'Vous avez atteint la limite de 10 propriétés pendant votre essai gratuit.'} ${t('billing.limitExceededAction') || 'Pour continuer, vous devez terminer votre essai et activer la facturation maintenant.'}`
            : ''
        }
        onConfirm={() => {
          setShowLimitModal(false);
          setShowEndTrialModal(true);
        }}
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
```

---

## 🎨 Étape 4 : Intégrer BillingPanel dans SettingsPage

### 4.1 Modifier `src/pages/SettingsPage.jsx`

Ajoutez l'import et le composant dans `SettingsPage.jsx` :

```javascript
// ... imports existants ...
import BillingPanel from '../components/BillingPanel.jsx';

function SettingsPage({ token, userProfile: initialProfile, onThemeChange, onLogout }) {
  // ... code existant ...

  // Fonction pour rafraîchir le profil
  const handleProfileRefresh = async () => {
    try {
      const updatedProfile = await getUserProfile(token);
      setProfile(updatedProfile);
      // Si le parent a besoin de mettre à jour le profil, on peut l'appeler ici
    } catch (err) {
      console.error('Erreur lors du rafraîchissement du profil:', err);
    }
  };

  return (
    <div className="relative min-h-screen">
      {/* ... code existant ... */}
      
      {/* AJOUTER APRÈS LE PANEL PMS INTEGRATION */}
      {/* Panneau de Gestion de l'Abonnement */}
      <BillingPanel 
        token={token}
        userProfile={profile}
        onProfileUpdate={handleProfileRefresh}
      />

      {/* ... reste du code ... */}
    </div>
  );
}
```

---

## 🎨 Étape 5 : Gérer la limite de propriétés (Popup)

### 5.1 Modifier les composants qui ajoutent des propriétés

Vous devez modifier les composants qui ajoutent des propriétés pour gérer l'erreur `LIMIT_EXCEEDED`.

#### Exemple : Modifier `PropertyModal.jsx` ou le composant qui ajoute des propriétés

```javascript
// Dans votre composant qui ajoute des propriétés
import { addProperty } from '../services/api.js';

const handleAddProperty = async (propertyData) => {
  try {
    await addProperty(propertyData, token);
    // Succès
  } catch (err) {
    if (err.message.includes('LIMIT_EXCEEDED') || err.response?.data?.error === 'LIMIT_EXCEEDED') {
      // Afficher la modale de limite
      if (window.showLimitExceededModal) {
        const errorData = err.response?.data || {};
        window.showLimitExceededModal({
          currentCount: errorData.currentCount,
          maxAllowed: errorData.maxAllowed,
        });
      }
    } else {
      // Autre erreur
      setError(err.message);
    }
  }
};
```

#### Exemple : Modifier `PropertySyncModal.jsx` (pour l'import de propriétés)

```javascript
// Dans PropertySyncModal.jsx
import { importPmsProperties } from '../services/api.js';

const handleImportProperties = async (propertiesToImport, pmsType) => {
  try {
    await importPmsProperties(propertiesToImport, pmsType, token);
    // Succès
  } catch (err) {
    if (err.message.includes('LIMIT_EXCEEDED') || err.response?.data?.error === 'LIMIT_EXCEEDED') {
      // Afficher la modale de limite
      if (window.showLimitExceededModal) {
        const errorData = err.response?.data || {};
        window.showLimitExceededModal({
          currentCount: errorData.currentCount,
          maxAllowed: errorData.maxAllowed,
        });
      }
    } else {
      // Autre erreur
      setError(err.message);
    }
  }
};
```

---

## 🎨 Étape 6 : Gérer le retour depuis Stripe Checkout

### 6.1 Créer une page de succès

Créez `src/pages/CheckoutSuccessPage.jsx` :

```javascript
import React, { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { getUserProfile } from '../services/api.js';

function CheckoutSuccessPage({ token, onProfileUpdate }) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const sessionId = searchParams.get('session_id');
    
    if (!sessionId) {
      setError('Session ID manquant');
      setIsLoading(false);
      return;
    }

    // Attendre quelques secondes pour que le webhook soit traité
    const checkSubscription = async () => {
      try {
        // Attendre 2 secondes pour que le webhook soit traité
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Rafraîchir le profil
        if (onProfileUpdate) {
          await onProfileUpdate();
        }
        
        // Rediriger vers le dashboard ou les paramètres
        setTimeout(() => {
          navigate('/settings');
        }, 3000);
      } catch (err) {
        console.error('Erreur lors de la vérification de l\'abonnement:', err);
        setError('Une erreur est survenue. Votre abonnement devrait être activé sous peu.');
      } finally {
        setIsLoading(false);
      }
    };

    checkSubscription();
  }, [searchParams, navigate, onProfileUpdate]);

  if (isLoading) {
    return (
      <div className="relative min-h-screen">
        <div
          className="fixed inset-0"
          style={{
            background: 'linear-gradient(135deg, rgba(2,6,24,1) 0%, rgba(22,36,86,1) 45%, rgba(15,23,43,1) 100%)',
            zIndex: 0,
          }}
        />
        <div className="relative z-10 flex items-center justify-center min-h-screen">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto mb-4"></div>
            <p className="text-global-blanc">Activation de votre abonnement en cours...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="relative min-h-screen">
        <div
          className="fixed inset-0"
          style={{
            background: 'linear-gradient(135deg, rgba(2,6,24,1) 0%, rgba(22,36,86,1) 45%, rgba(15,23,43,1) 100%)',
            zIndex: 0,
          }}
        />
        <div className="relative z-10 flex items-center justify-center min-h-screen">
          <div className="text-center bg-global-bg-box rounded-[14px] border border-global-stroke-box p-8 max-w-md">
            <p className="text-red-400 mb-4">{error}</p>
            <button
              onClick={() => navigate('/settings')}
              className="px-6 py-2 font-semibold text-white rounded-[10px] bg-gradient-to-r from-[#155dfc] to-[#12a1d5] hover:opacity-90"
            >
              Retour aux paramètres
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen">
      <div
        className="fixed inset-0"
        style={{
          background: 'linear-gradient(135deg, rgba(2,6,24,1) 0%, rgba(22,36,86,1) 45%, rgba(15,23,43,1) 100%)',
          zIndex: 0,
        }}
      />
      <div className="relative z-10 flex items-center justify-center min-h-screen">
        <div className="text-center bg-global-bg-box rounded-[14px] border border-global-stroke-box p-8 max-w-md">
          <div className="text-6xl mb-4">🎉</div>
          <h1 className="text-global-blanc text-2xl font-bold mb-4">
            Abonnement activé avec succès !
          </h1>
          <p className="text-global-inactive mb-6">
            Votre abonnement a été activé. Vous allez être redirigé vers les paramètres...
          </p>
        </div>
      </div>
    </div>
  );
}

export default CheckoutSuccessPage;
```

### 6.2 Créer une page d'annulation

Créez `src/pages/CheckoutCancelPage.jsx` :

```javascript
import React from 'react';
import { useNavigate } from 'react-router-dom';

function CheckoutCancelPage() {
  const navigate = useNavigate();

  return (
    <div className="relative min-h-screen">
      <div
        className="fixed inset-0"
        style={{
          background: 'linear-gradient(135deg, rgba(2,6,24,1) 0%, rgba(22,36,86,1) 45%, rgba(15,23,43,1) 100%)',
          zIndex: 0,
        }}
      />
      <div className="relative z-10 flex items-center justify-center min-h-screen">
        <div className="text-center bg-global-bg-box rounded-[14px] border border-global-stroke-box p-8 max-w-md">
          <h1 className="text-global-blanc text-2xl font-bold mb-4">
            Paiement annulé
          </h1>
          <p className="text-global-inactive mb-6">
            Vous avez annulé le processus de paiement. Vous pouvez réessayer à tout moment depuis les paramètres.
          </p>
          <button
            onClick={() => navigate('/settings')}
            className="px-6 py-2 font-semibold text-white rounded-[10px] bg-gradient-to-r from-[#155dfc] to-[#12a1d5] hover:opacity-90"
          >
            Retour aux paramètres
          </button>
        </div>
      </div>
    </div>
  );
}

export default CheckoutCancelPage;
```

### 6.3 Ajouter les routes dans `App.jsx`

```javascript
// Dans App.jsx
import CheckoutSuccessPage from './pages/CheckoutSuccessPage.jsx';
import CheckoutCancelPage from './pages/CheckoutCancelPage.jsx';

// Dans le switch/case ou routing
{currentView === 'checkout-success' && (
  <CheckoutSuccessPage 
    token={token}
    onProfileUpdate={async () => {
      const profile = await getUserProfile(token);
      setUserProfile(profile);
    }}
  />
)}
{currentView === 'checkout-cancel' && (
  <CheckoutCancelPage />
)}
```

**Note :** Si vous utilisez React Router, ajoutez les routes dans votre configuration de routes.

---

## 🎨 Étape 7 : Ajouter les traductions

### 7.1 Modifier `public/locales/fr/translation.json`

Ajoutez ces clés de traduction :

```json
{
  "billing": {
    "title": "Gestion de l'abonnement",
    "noSubscription": "Vous n'avez pas encore d'abonnement actif.",
    "activateSubscription": "Activer l'abonnement",
    "trialActive": "Essai gratuit actif",
    "trialDescription": "Vous bénéficiez d'un essai gratuit de 30 jours. Vous pouvez ajouter jusqu'à 10 propriétés pendant cette période.",
    "endTrialNow": "Terminer l'essai et payer maintenant",
    "subscriptionActive": "Abonnement actif",
    "subscriptionDescription": "Votre abonnement est actif. Vous pouvez gérer votre abonnement, télécharger vos factures et mettre à jour votre carte bancaire.",
    "manageSubscription": "Gérer mon abonnement",
    "paymentFailed": "Échec de paiement",
    "paymentFailedDescription": "Votre dernier paiement a échoué. Veuillez mettre à jour votre méthode de paiement pour continuer à utiliser Priceye.",
    "updatePaymentMethod": "Mettre à jour la méthode de paiement",
    "subscriptionCanceled": "Abonnement annulé",
    "subscriptionCanceledDescription": "Votre abonnement a été annulé. Réactivez votre abonnement pour continuer à utiliser Priceye.",
    "reactivateSubscription": "Réactiver l'abonnement",
    "limitExceeded": "Limite de propriétés dépassée",
    "limitExceededMessage": "Vous avez atteint la limite de 10 propriétés pendant votre essai gratuit.",
    "limitExceededAction": "Pour continuer, vous devez terminer votre essai et activer la facturation maintenant.",
    "endTrialAndPay": "Terminer l'essai et payer",
    "endTrialConfirm": "Terminer l'essai gratuit",
    "endTrialConfirmMessage": "Êtes-vous sûr de vouloir terminer votre essai gratuit maintenant ? Vous serez facturé immédiatement pour le mois en cours.",
    "confirmEndTrial": "Oui, terminer l'essai"
  }
}
```

### 7.2 Modifier `public/locales/en/translation.json`

Ajoutez les traductions en anglais :

```json
{
  "billing": {
    "title": "Subscription Management",
    "noSubscription": "You don't have an active subscription yet.",
    "activateSubscription": "Activate Subscription",
    "trialActive": "Free Trial Active",
    "trialDescription": "You have a 30-day free trial. You can add up to 10 properties during this period.",
    "endTrialNow": "End Trial and Pay Now",
    "subscriptionActive": "Active Subscription",
    "subscriptionDescription": "Your subscription is active. You can manage your subscription, download invoices, and update your payment method.",
    "manageSubscription": "Manage Subscription",
    "paymentFailed": "Payment Failed",
    "paymentFailedDescription": "Your last payment failed. Please update your payment method to continue using Priceye.",
    "updatePaymentMethod": "Update Payment Method",
    "subscriptionCanceled": "Subscription Canceled",
    "subscriptionCanceledDescription": "Your subscription has been canceled. Reactivate your subscription to continue using Priceye.",
    "reactivateSubscription": "Reactivate Subscription",
    "limitExceeded": "Property Limit Exceeded",
    "limitExceededMessage": "You have reached the limit of 10 properties during your free trial.",
    "limitExceededAction": "To continue, you must end your trial and activate billing now.",
    "endTrialAndPay": "End Trial and Pay",
    "endTrialConfirm": "End Free Trial",
    "endTrialConfirmMessage": "Are you sure you want to end your free trial now? You will be billed immediately for the current month.",
    "confirmEndTrial": "Yes, End Trial"
  }
}
```

---

## 🎨 Étape 8 : Gérer l'accès bloqué (Kill-Switch)

### 8.1 Modifier `App.jsx` pour vérifier `accessDisabled`

Dans `App.jsx`, ajoutez une vérification pour bloquer l'accès si `accessDisabled` est `true` :

```javascript
// Dans App.jsx, après le chargement du profil
useEffect(() => {
  const storedToken = localStorage.getItem('authToken');
  if (storedToken) {
    setToken(storedToken);
    setCurrentView('dashboard');
    
    getUserProfile(storedToken)
      .then(profile => {
        setUserProfile(profile);
        
        // Vérifier si l'accès est désactivé
        if (profile.accessDisabled) {
          setCurrentView('access-blocked');
          return;
        }
        
        // ... reste du code ...
      })
      .catch(err => {
        // ... gestion d'erreur ...
      });
  }
}, [token]);
```

### 8.2 Créer `src/pages/AccessBlockedPage.jsx`

```javascript
import React from 'react';
import { createPortalSession } from '../services/api.js';

function AccessBlockedPage({ token }) {
  const handleUpdatePayment = async () => {
    try {
      const { url } = await createPortalSession(token);
      window.location.href = url;
    } catch (err) {
      console.error('Erreur lors de l\'ouverture du portal:', err);
      alert('Une erreur est survenue. Veuillez contacter le support.');
    }
  };

  return (
    <div className="relative min-h-screen">
      <div
        className="fixed inset-0"
        style={{
          background: 'linear-gradient(135deg, rgba(2,6,24,1) 0%, rgba(22,36,86,1) 45%, rgba(15,23,43,1) 100%)',
          zIndex: 0,
        }}
      />
      <div className="relative z-10 flex items-center justify-center min-h-screen">
        <div className="text-center bg-global-bg-box rounded-[14px] border border-red-700 p-8 max-w-md">
          <div className="text-6xl mb-4">🔒</div>
          <h1 className="text-red-400 text-2xl font-bold mb-4">
            Accès temporairement désactivé
          </h1>
          <p className="text-global-inactive mb-6">
            Votre accès a été désactivé en raison d'un problème de paiement. Veuillez mettre à jour votre méthode de paiement pour réactiver votre compte.
          </p>
          <button
            onClick={handleUpdatePayment}
            className="px-6 py-2 font-semibold text-white rounded-[10px] bg-red-600 hover:bg-red-700 transition-colors"
          >
            Mettre à jour la méthode de paiement
          </button>
        </div>
      </div>
    </div>
  );
}

export default AccessBlockedPage;
```

### 8.3 Ajouter la route dans `App.jsx`

```javascript
import AccessBlockedPage from './pages/AccessBlockedPage.jsx';

// Dans le routing
{currentView === 'access-blocked' && (
  <AccessBlockedPage token={token} />
)}
```

---

## ✅ Checklist de Validation

- [ ] Variables d'environnement configurées (`.env`)
- [ ] Fonctions API ajoutées dans `api.js`
- [ ] Composant `BillingPanel.jsx` créé
- [ ] `BillingPanel` intégré dans `SettingsPage.jsx`
- [ ] Gestion de l'erreur `LIMIT_EXCEEDED` dans les composants d'ajout de propriétés
- [ ] Pages `CheckoutSuccessPage.jsx` et `CheckoutCancelPage.jsx` créées
- [ ] Routes ajoutées dans `App.jsx`
- [ ] Traductions ajoutées (FR et EN)
- [ ] Page `AccessBlockedPage.jsx` créée pour le kill-switch
- [ ] Vérification de `accessDisabled` dans `App.jsx`

---

## 🧪 Tests à Effectuer

1. **Test d'onboarding** : Cliquer sur "Activer l'abonnement" → Vérifier la redirection vers Stripe → Compléter le paiement → Vérifier le retour
2. **Test de limite** : Ajouter 10 propriétés → Tenter d'ajouter la 11ème → Vérifier la popup
3. **Test de fin d'essai** : Cliquer sur "Terminer l'essai" → Vérifier la facturation
4. **Test du Customer Portal** : Cliquer sur "Gérer mon abonnement" → Vérifier l'ouverture du portal
5. **Test du kill-switch** : Simuler un échec de paiement → Vérifier l'affichage de la page de blocage

---

## 📝 Notes Importantes

1. **Stripe Checkout** : Utilise une redirection, pas de SDK frontend nécessaire
2. **Webhooks** : Le backend gère les webhooks, le frontend doit juste rafraîchir le profil après le retour
3. **Sécurité** : Ne jamais faire confiance à la redirection `success_url` pour activer l'abonnement (le webhook le fait)
4. **UX** : Afficher un message de chargement pendant le traitement du webhook (2-3 secondes)

---

**Date de création :** 2025-01-XX  
**Statut :** ✅ Guide complet pour l'intégration frontend Stripe

