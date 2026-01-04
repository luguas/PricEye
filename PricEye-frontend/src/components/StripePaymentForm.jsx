import React, { useState } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import {
  Elements,
  CardElement,
  useStripe,
  useElements
} from '@stripe/react-stripe-js';

// Initialiser Stripe avec la clé publique
const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLIC_KEY);

/**
 * Composant interne pour le formulaire de paiement
 */
function PaymentForm({ onSuccess, onError, isLoading: externalLoading }) {
  const stripe = useStripe();
  const elements = useElements();
  const [cardholderName, setCardholderName] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState(null);

  const isLoading = isProcessing || externalLoading;

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!stripe || !elements) {
      setError('Stripe n\'est pas encore chargé. Veuillez patienter...');
      return;
    }

    if (!cardholderName.trim()) {
      setError('Veuillez saisir le nom du titulaire de la carte.');
      return;
    }

    setIsProcessing(true);
    setError(null);

    try {
      const cardElement = elements.getElement(CardElement);

      // Créer un PaymentMethod avec les informations de la carte
      const { error: createError, paymentMethod } = await stripe.createPaymentMethod({
        type: 'card',
        card: cardElement,
        billing_details: {
          name: cardholderName,
        },
      });

      if (createError) {
        // Gérer les erreurs spécifiques de Stripe
        let errorMessage = 'Une erreur est survenue lors de la saisie de votre carte.';
        
        if (createError.type === 'card_error' || createError.type === 'validation_error') {
          errorMessage = createError.message || errorMessage;
        } else if (createError.type === 'invalid_request_error') {
          errorMessage = 'Les informations de la carte sont invalides.';
        }

        setError(errorMessage);
        if (onError) {
          onError(createError);
        }
        setIsProcessing(false);
        return;
      }

      if (paymentMethod) {
        // Succès : appeler le callback avec le paymentMethodId
        if (onSuccess) {
          onSuccess(paymentMethod.id);
        }
      }
    } catch (err) {
      console.error('Erreur lors de la création du PaymentMethod:', err);
      setError('Une erreur inattendue est survenue. Veuillez réessayer.');
      if (onError) {
        onError(err);
      }
    } finally {
      setIsProcessing(false);
    }
  };

  // Options de style pour le CardElement (cohérent avec le design de l'app)
  const cardElementOptions = {
    style: {
      base: {
        fontSize: '16px',
        color: '#ffffff',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        '::placeholder': {
          color: '#9ca3af',
        },
      },
      invalid: {
        color: '#ef4444',
        iconColor: '#ef4444',
      },
    },
    hidePostalCode: false,
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <label htmlFor="cardholder-name" className="block text-sm font-medium text-gray-300 mb-2">
          Nom du titulaire de la carte
        </label>
        <input
          id="cardholder-name"
          type="text"
          required
          value={cardholderName}
          onChange={(e) => setCardholderName(e.target.value)}
          placeholder="Jean Dupont"
          className="w-full px-3 py-2 text-white bg-gray-700 border border-gray-600 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          disabled={isLoading}
        />
      </div>

      <div>
        <label htmlFor="card-element" className="block text-sm font-medium text-gray-300 mb-2">
          Informations de la carte
        </label>
        <div className="px-3 py-3 bg-gray-700 border border-gray-600 rounded-md">
          <CardElement
            id="card-element"
            options={cardElementOptions}
            className="text-white"
          />
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-900/50 border border-red-700 rounded-md">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      <button
        type="submit"
        disabled={isLoading || !stripe}
        className="w-full px-4 py-2 font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-800 focus:ring-blue-500 disabled:bg-gray-500 disabled:cursor-not-allowed transition-colors"
      >
        {isLoading ? 'Traitement en cours...' : 'Valider la carte'}
      </button>

      <p className="text-xs text-center text-gray-400">
        Vos informations de paiement sont sécurisées et cryptées par Stripe.
      </p>
    </form>
  );
}

/**
 * Composant principal StripePaymentForm
 * @param {Function} onSuccess - Callback appelé avec le paymentMethodId en cas de succès
 * @param {Function} onError - Callback appelé en cas d'erreur
 * @param {boolean} isLoading - État de chargement externe
 */
function StripePaymentForm({ onSuccess, onError, isLoading = false }) {
  return (
    <div className="w-full">
      <Elements stripe={stripePromise}>
        <PaymentForm 
          onSuccess={onSuccess} 
          onError={onError} 
          isLoading={isLoading}
        />
      </Elements>
    </div>
  );
}

export default StripePaymentForm;

















