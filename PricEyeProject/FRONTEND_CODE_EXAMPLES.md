# 💻 Exemples de Code Frontend - Stripe

## 📝 Fichiers à Modifier/Créer

---

## 1. Ajouter les fonctions API dans `src/services/api.js`

Ajoutez ces fonctions à la fin du fichier `api.js` :

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

## 2. Gérer l'erreur LIMIT_EXCEEDED dans les composants

### Exemple pour `PropertyModal.jsx` ou composant d'ajout de propriété

```javascript
import { addProperty } from '../services/api.js';

// Dans votre fonction handleAddProperty ou handleSubmit
const handleAddProperty = async (propertyData) => {
  try {
    setIsLoading(true);
    setError('');
    
    await addProperty(propertyData, token);
    
    // Succès
    onSuccess?.();
    onClose?.();
  } catch (err) {
    console.error('Erreur lors de l\'ajout de la propriété:', err);
    
    // Vérifier si c'est une erreur de limite
    const errorMessage = err.message || '';
    const errorData = err.response?.data || {};
    
    if (errorMessage.includes('LIMIT_EXCEEDED') || errorData.error === 'LIMIT_EXCEEDED') {
      // Afficher la modale de limite via la fonction globale
      if (window.showLimitExceededModal) {
        window.showLimitExceededModal({
          currentCount: errorData.currentCount || 10,
          maxAllowed: errorData.maxAllowed || 10,
        });
      } else {
        // Fallback si la fonction n'est pas disponible
        alert(`Vous avez atteint la limite de ${errorData.maxAllowed || 10} propriétés pendant votre essai gratuit. Veuillez terminer votre essai pour continuer.`);
      }
    } else {
      // Autre erreur
      setError(errorMessage || 'Une erreur est survenue lors de l\'ajout de la propriété.');
    }
  } finally {
    setIsLoading(false);
  }
};
```

### Exemple pour `PropertySyncModal.jsx` (import de propriétés)

```javascript
import { importPmsProperties } from '../services/api.js';

// Dans votre fonction handleImport
const handleImportProperties = async (propertiesToImport, pmsType) => {
  try {
    setIsLoading(true);
    setError('');
    
    await importPmsProperties(propertiesToImport, pmsType, token);
    
    // Succès
    onSuccess?.();
    onClose?.();
  } catch (err) {
    console.error('Erreur lors de l\'import des propriétés:', err);
    
    // Vérifier si c'est une erreur de limite
    const errorMessage = err.message || '';
    const errorData = err.response?.data || {};
    
    if (errorMessage.includes('LIMIT_EXCEEDED') || errorData.error === 'LIMIT_EXCEEDED') {
      // Afficher la modale de limite
      if (window.showLimitExceededModal) {
        window.showLimitExceededModal({
          currentCount: errorData.currentCount || 10,
          maxAllowed: errorData.maxAllowed || 10,
        });
      } else {
        alert(`Vous avez atteint la limite de ${errorData.maxAllowed || 10} propriétés pendant votre essai gratuit. Veuillez terminer votre essai pour continuer.`);
      }
    } else {
      // Autre erreur
      setError(errorMessage || 'Une erreur est survenue lors de l\'import des propriétés.');
    }
  } finally {
    setIsLoading(false);
  }
};
```

---

## 3. Exemple de gestion du retour depuis Stripe (App.jsx)

Si vous utilisez un système de routing simple (sans React Router), ajoutez ceci dans `App.jsx` :

```javascript
// Dans App.jsx
import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom'; // Si vous utilisez React Router
// OU
// Pour un routing simple, vérifiez window.location.search

// Dans votre composant App ou AppContent
useEffect(() => {
  // Vérifier si on revient de Stripe Checkout
  const urlParams = new URLSearchParams(window.location.search);
  const sessionId = urlParams.get('session_id');
  const canceled = urlParams.get('canceled');
  
  if (sessionId) {
    // Succès - rediriger vers la page de succès
    setCurrentView('checkout-success');
    // Nettoyer l'URL
    window.history.replaceState({}, '', window.location.pathname);
  } else if (canceled) {
    // Annulation - rediriger vers la page d'annulation
    setCurrentView('checkout-cancel');
    // Nettoyer l'URL
    window.history.replaceState({}, '', window.location.pathname);
  }
}, []);
```

---

## 4. Exemple de vérification d'accès bloqué (App.jsx)

```javascript
// Dans App.jsx, après le chargement du profil
useEffect(() => {
  const storedToken = localStorage.getItem('authToken');
  if (storedToken) {
    setToken(storedToken);
    
    getUserProfile(storedToken)
      .then(profile => {
        setUserProfile(profile);
        
        // Vérifier si l'accès est désactivé (kill-switch)
        if (profile.accessDisabled) {
          setCurrentView('access-blocked');
          return;
        }
        
        // Vérifier si la sync PMS est désactivée
        if (!profile.pmsSyncEnabled && profile.pmsSyncStoppedReason) {
          console.warn('Synchronisation PMS désactivée:', profile.pmsSyncStoppedReason);
          // Optionnel : afficher une notification
        }
        
        // Continuer le chargement normal
        setCurrentView('dashboard');
        applyTheme(profile.theme || 'auto');
        // ... reste du code ...
      })
      .catch(err => {
        console.error("Erreur de chargement du profil:", err);
        if (err.message.includes('403') || err.message.includes('401')) {
          handleLogout();
        }
      });
  } else {
    setCurrentView('login');
  }
}, [token]);
```

---

## 5. Exemple de gestion d'erreur dans apiRequest

Si votre fonction `apiRequest` ne gère pas bien les erreurs avec `response.data`, modifiez-la ainsi :

```javascript
// Dans api.js, fonction apiRequest
async function apiRequest(endpoint, options = {}) {
  const token = options.token;
  const headers = {
    'Content-Type': options.headers?.['Content-Type'] ?? 'application/json', 
    ...options.headers, 
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      method: options.method || 'GET',
      headers,
      body: options.body,
    });

    if (!response.ok) {
      // Essayer de parser le JSON de l'erreur
      let errorData;
      try {
        errorData = await response.json();
      } catch {
        errorData = { message: `Erreur ${response.status}: ${response.statusText}` };
      }
      
      // Créer une erreur avec les données complètes
      const error = new Error(errorData.message || errorData.error || `Erreur ${response.status}`);
      error.response = { data: errorData, status: response.status };
      throw error;
    }

    // ... reste du code pour le succès ...
  } catch (error) {
    // Si c'est déjà une erreur avec response, la relancer
    if (error.response) {
      throw error;
    }
    // Sinon, créer une erreur générique
    throw new Error(error.message || 'Une erreur est survenue lors de la requête.');
  }
}
```

---

## 6. Exemple de rafraîchissement du profil après action Stripe

```javascript
// Dans SettingsPage.jsx ou BillingPanel.jsx
const handleProfileRefresh = async () => {
  try {
    const updatedProfile = await getUserProfile(token);
    setProfile(updatedProfile);
    
    // Si le parent (App.jsx) a besoin de mettre à jour le profil global
    if (onProfileUpdate) {
      onProfileUpdate(updatedProfile);
    }
  } catch (err) {
    console.error('Erreur lors du rafraîchissement du profil:', err);
  }
};

// Appeler après chaque action Stripe (fin d'essai, etc.)
const handleEndTrial = async () => {
  try {
    await endTrialAndBill(token);
    await handleProfileRefresh(); // Rafraîchir le profil
    setSuccess('Essai terminé avec succès !');
  } catch (err) {
    setError(err.message);
  }
};
```

---

## 7. Exemple de notification pour sync PMS désactivée

Si vous voulez afficher une notification quand la sync PMS est désactivée :

```javascript
// Dans DashboardPage.jsx ou PricingPage.jsx
useEffect(() => {
  if (userProfile && !userProfile.pmsSyncEnabled && userProfile.pmsSyncStoppedReason) {
    // Afficher une notification
    const notification = {
      type: 'warning',
      message: `Synchronisation PMS désactivée : ${userProfile.pmsSyncStoppedReason === 'payment_failed' ? 'Problème de paiement' : 'Raison inconnue'}. Veuillez mettre à jour votre méthode de paiement.`,
      action: {
        label: 'Mettre à jour',
        onClick: () => {
          // Rediriger vers les paramètres ou ouvrir le portal
          setCurrentView('settings');
        }
      }
    };
    
    // Ajouter à votre système de notifications
    addNotification(notification);
  }
}, [userProfile]);
```

---

## 📝 Notes Importantes

1. **Gestion des erreurs** : Toujours vérifier `error.response?.data` pour les erreurs structurées du backend
2. **Rafraîchissement** : Rafraîchir le profil après chaque action Stripe importante
3. **UX** : Afficher des messages de chargement pendant les actions asynchrones
4. **Sécurité** : Ne jamais stocker les clés Stripe côté frontend (utiliser les variables d'environnement)

---

**Date de création :** 2025-01-XX  
**Statut :** ✅ Exemples de code pour faciliter l'implémentation

