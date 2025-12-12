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
          {token && (
            <button
              onClick={handleUpdatePayment}
              className="px-6 py-2 font-semibold text-white rounded-[10px] bg-red-600 hover:bg-red-700 transition-colors"
            >
              Mettre à jour la méthode de paiement
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default AccessBlockedPage;

