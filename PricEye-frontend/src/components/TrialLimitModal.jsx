import React, { useState } from 'react';
import { createCheckoutSession } from '../services/api.js';
import { useLanguage } from '../contexts/LanguageContext.jsx';

function TrialLimitModal({ isOpen, onClose, currentCount, maxAllowed, token }) {
  const { t } = useLanguage();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const handleUpgrade = async () => {
    if (!token) {
      setError('Vous devez être connecté pour passer à l\'abonnement payant.');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      // Créer une session Stripe Checkout
      const { url } = await createCheckoutSession(token);
      
      // Rediriger vers Stripe Checkout
      if (url) {
        window.location.href = url;
      } else {
        setError('Impossible de créer la session de paiement. Veuillez réessayer.');
      }
    } catch (err) {
      console.error('Erreur lors de la création de la session checkout:', err);
      setError(err.message || 'Une erreur est survenue. Veuillez réessayer.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-90 flex items-center justify-center p-4 z-50">
      <div className="bg-global-bg-box border border-global-stroke-box rounded-[14px] shadow-xl w-full max-w-md p-6">
        <div className="text-center mb-6">
          <div className="text-6xl mb-4">🔒</div>
          <h2 className="text-2xl font-bold text-global-blanc mb-2">
            Limite d'essai atteinte
          </h2>
          <p className="text-global-inactive">
            Vous avez atteint la limite de {maxAllowed} propriétés pendant votre essai gratuit.
          </p>
          <p className="text-global-inactive mt-2">
            Vous avez actuellement <span className="font-bold text-global-blanc">{currentCount}</span> propriété{currentCount > 1 ? 's' : ''}.
          </p>
        </div>

        <div className="bg-global-bg-small-box border border-global-stroke-box rounded-[8px] p-4 mb-6">
          <h3 className="text-lg font-semibold text-global-blanc mb-2">
            Passez à l'abonnement payant pour continuer
          </h3>
          <ul className="text-sm text-global-inactive space-y-2">
            <li className="flex items-start gap-2">
              <span className="text-green-400">✓</span>
              <span>Ajoutez un nombre illimité de propriétés</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-green-400">✓</span>
              <span>Accédez à toutes les fonctionnalités premium</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-green-400">✓</span>
              <span>Support prioritaire</span>
            </li>
          </ul>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-900/50 border border-red-500/20 rounded-[8px]">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        <div className="flex gap-4">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 px-4 py-2 font-semibold text-global-inactive bg-global-bg-small-box border border-global-stroke-box rounded-[8px] hover:border-global-content-highlight-2nd hover:text-global-blanc transition-colors"
          >
            Plus tard
          </button>
          <button
            type="button"
            onClick={handleUpgrade}
            disabled={isLoading}
            className="flex-1 px-4 py-2 font-semibold text-white bg-gradient-to-r from-[#155dfc] to-[#12a1d5] rounded-[8px] hover:opacity-90 disabled:bg-gray-500 disabled:opacity-50 transition-opacity"
          >
            {isLoading ? 'Chargement...' : 'Passer à l\'abonnement'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default TrialLimitModal;

