import React, { useEffect, useState } from 'react';
import { getUserProfile, verifyCheckoutSession } from '../services/api.js';

function CheckoutSuccessPage({ token, sessionId, onProfileUpdate }) {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    // Utiliser le sessionId passé en prop, ou essayer de le récupérer depuis l'URL en fallback
    const finalSessionId = sessionId || new URLSearchParams(window.location.search).get('session_id');
    
    if (!finalSessionId) {
      setError('Session ID manquant');
      setIsLoading(false);
      return;
    }

    if (!token) {
      setError('Token d\'authentification manquant');
      setIsLoading(false);
      return;
    }

    // Vérifier directement la session Stripe et mettre à jour le profil
    const checkSubscription = async () => {
      try {
        // D'abord, vérifier directement la session Stripe (plus rapide que d'attendre le webhook)
        let subscriptionActivated = false;
        const maxRetries = 3; // Réduire à 3 tentatives
        const retryDelay = 1000; // Réduire à 1 seconde entre chaque tentative
        
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            // Vérifier la session Stripe directement
            const verificationResult = await verifyCheckoutSession(finalSessionId, token);
            
            if (verificationResult.success && verificationResult.subscriptionStatus) {
              // La session est complétée et le profil a été mis à jour
              subscriptionActivated = true;
              console.log('Abonnement activé avec succès via vérification directe:', verificationResult.subscriptionStatus);
              
              // Rafraîchir le profil local
              if (onProfileUpdate) {
                await onProfileUpdate();
              }
              
              break;
            }
          } catch (verifyError) {
            console.warn(`Tentative ${attempt + 1} de vérification échouée:`, verifyError);
          }
          
          // Attendre avant la prochaine tentative (sauf si c'est la dernière)
          if (attempt < maxRetries - 1) {
            await new Promise(resolve => setTimeout(resolve, retryDelay));
          }
        }
        
        // Si la vérification directe n'a pas fonctionné, essayer de récupérer le profil
        if (!subscriptionActivated && onProfileUpdate) {
          const updatedProfile = await onProfileUpdate();
          if (updatedProfile && (updatedProfile.subscriptionStatus === 'active' || updatedProfile.subscriptionStatus === 'trialing')) {
            subscriptionActivated = true;
            console.log('Abonnement trouvé dans le profil:', updatedProfile.subscriptionStatus);
          }
        }
        
        if (!subscriptionActivated) {
          console.warn('Le statut de l\'abonnement n\'a pas été confirmé. Le webhook peut être en cours de traitement.');
          // Ne pas afficher d'erreur, juste un avertissement dans la console
        }
        
        // Rediriger vers les paramètres après un court délai
        setTimeout(() => {
          window.location.href = '/#settings';
        }, 1500); // Réduire le délai à 1.5 secondes
      } catch (err) {
        console.error('Erreur lors de la vérification de l\'abonnement:', err);
        setError('Une erreur est survenue. Votre abonnement devrait être activé sous peu. Vous pouvez vérifier dans les paramètres.');
      } finally {
        setIsLoading(false);
      }
    };

    checkSubscription();
  }, [onProfileUpdate, sessionId, token]);

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

