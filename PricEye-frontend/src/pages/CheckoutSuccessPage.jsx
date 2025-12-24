import React, { useEffect, useState } from 'react';
import { getUserProfile } from '../services/api.js';

function CheckoutSuccessPage({ token, onProfileUpdate }) {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const sessionId = new URLSearchParams(window.location.search).get('session_id');
    
    if (!sessionId) {
      setError('Session ID manquant');
      setIsLoading(false);
      return;
    }

    // Attendre quelques secondes pour que le webhook soit traité
    const checkSubscription = async () => {
      try {
        // Essayer plusieurs fois de récupérer le profil mis à jour (le webhook peut prendre du temps)
        let profileUpdated = false;
        const maxRetries = 5;
        const retryDelay = 2000; // 2 secondes entre chaque tentative
        
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          // Attendre avant chaque tentative (sauf la première)
          if (attempt > 0) {
            await new Promise(resolve => setTimeout(resolve, retryDelay));
          }
          
          // Rafraîchir le profil
          if (onProfileUpdate) {
            const updatedProfile = await onProfileUpdate();
            
            // Vérifier si l'abonnement a été activé
            if (updatedProfile && (updatedProfile.subscriptionStatus === 'active' || updatedProfile.subscriptionStatus === 'trialing')) {
              profileUpdated = true;
              console.log('Abonnement activé avec succès:', updatedProfile.subscriptionStatus);
              break;
            }
          }
        }
        
        if (!profileUpdated) {
          console.warn('Le statut de l\'abonnement n\'a pas été mis à jour après plusieurs tentatives. Le webhook peut être en cours de traitement.');
        }
        
        // Rediriger vers les paramètres après un court délai
        setTimeout(() => {
          window.location.href = '/#settings';
        }, 2000);
      } catch (err) {
        console.error('Erreur lors de la vérification de l\'abonnement:', err);
        setError('Une erreur est survenue. Votre abonnement devrait être activé sous peu. Vous pouvez vérifier dans les paramètres.');
      } finally {
        setIsLoading(false);
      }
    };

    checkSubscription();
  }, [onProfileUpdate]);

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
              onClick={() => {
                window.location.href = '/#settings';
              }}
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

