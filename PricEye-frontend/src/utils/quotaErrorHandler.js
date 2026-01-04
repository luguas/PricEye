/**
 * Gère les erreurs de quota IA (429) et affiche les messages appropriés
 * @param {Error} error - L'erreur capturée
 * @param {Function} setError - Fonction pour définir le message d'erreur
 * @param {Function} setAlertModal - Fonction pour afficher une modale d'alerte (optionnel)
 * @param {object} userProfile - Profil utilisateur pour vérifier le statut d'abonnement
 * @param {Function} navigateTo - Fonction pour naviguer vers une page (optionnel)
 * @returns {boolean} - true si c'était une erreur de quota, false sinon
 */
export function handleQuotaError(error, setError, setAlertModal = null, userProfile = null, navigateTo = null) {
  // Vérifier si c'est une erreur 429 (quota atteint)
  const isQuotaError = 
    error?.errorData?.error === 'Quota IA atteint' ||
    error?.message?.includes('429') ||
    error?.message?.includes('Quota IA atteint') ||
    error?.message?.includes('limite quotidienne') ||
    error?.isQuotaExceeded === true;

  if (!isQuotaError) {
    return false;
  }

  // Message d'erreur selon le statut d'abonnement
  const subscriptionStatus = userProfile?.subscriptionStatus || userProfile?.subscription_status || 'none';
  let errorMessage = '';
  let shouldRedirectToSubscription = false;

  if (subscriptionStatus === 'trialing' || subscriptionStatus === 'none') {
    errorMessage = "Vous avez atteint votre limite quotidienne d'appels IA. Réessayez demain ou passez à un abonnement pour plus de quota.";
    shouldRedirectToSubscription = true;
  } else {
    errorMessage = "Vous avez atteint votre limite quotidienne d'appels IA. Réessayez demain.";
  }

  // Afficher le message d'erreur
  if (setError) {
    setError(errorMessage);
  }

  // Afficher une modale si disponible
  if (setAlertModal) {
    setAlertModal({
      isOpen: true,
      title: 'Quota IA atteint',
      message: errorMessage,
      onClose: () => {
        setAlertModal({ isOpen: false, message: '', title: '' });
        if (shouldRedirectToSubscription && navigateTo) {
          navigateTo('settings');
        }
      },
      buttonText: shouldRedirectToSubscription ? 'Voir les abonnements' : 'Fermer',
      onButtonClick: shouldRedirectToSubscription && navigateTo 
        ? () => {
            setAlertModal({ isOpen: false, message: '', title: '' });
            navigateTo('settings');
          }
        : null
    });
  }

  // Déclencher un événement pour mettre à jour l'indicateur de quota
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('aiQuotaExceeded', { 
      detail: { 
        errorMessage,
        shouldRedirectToSubscription,
        subscriptionStatus 
      } 
    }));
  }

  return true;
}

/**
 * Vérifie si le quota est atteint en appelant l'API
 * @param {string} token - Token d'authentification
 * @returns {Promise<{isQuotaReached: boolean, quota: object|null}>}
 */
export async function checkQuotaStatus(token) {
  if (!token) {
    return { isQuotaReached: false, quota: null };
  }

  try {
    const { getAIQuota } = await import('../services/api.js');
    const quota = await getAIQuota(token);
    const isQuotaReached = quota.remaining <= 0;
    return { isQuotaReached, quota };
  } catch (error) {
    // Si erreur 429, le quota est atteint
    if (error?.isQuotaExceeded || error?.errorData?.error === 'Quota IA atteint') {
      return { isQuotaReached: true, quota: null };
    }
    // En cas d'autre erreur, on considère que le quota n'est pas atteint (pour ne pas bloquer)
    console.error('Erreur lors de la vérification du quota:', error);
    return { isQuotaReached: false, quota: null };
  }
}




