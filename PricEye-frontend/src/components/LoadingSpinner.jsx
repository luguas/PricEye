import React from 'react';

/**
 * Spinner bleu au style PricEye (même apparence que le chargement initial).
 * @param {boolean} overlay - Si true, affiche en overlay plein écran
 * @param {number} contentAreaLeft - Largeur de la navbar (px) ; l'overlay commence à droite pour que le centre soit au milieu de la zone visible (desktop uniquement)
 * @param {string} className - Classes CSS additionnelles pour le conteneur
 */
function LoadingSpinner({ overlay = false, contentAreaLeft = 0, className = '' }) {
  const overlayStyle = overlay && contentAreaLeft > 0
    ? { left: `${contentAreaLeft}px` }
    : undefined;

  return (
    <div
      className={`priceye-loader ${overlay ? 'priceye-loader--overlay' : ''} ${className}`}
      style={overlayStyle}
      role="status"
      aria-label="Chargement"
    >
      <div className="priceye-loader__spinner" />
    </div>
  );
}

export default LoadingSpinner;
