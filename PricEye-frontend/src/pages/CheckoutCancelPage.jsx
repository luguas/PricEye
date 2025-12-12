import React from 'react';

function CheckoutCancelPage() {
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

export default CheckoutCancelPage;

