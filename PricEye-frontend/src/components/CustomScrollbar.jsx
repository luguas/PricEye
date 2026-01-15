import React, { useRef, useEffect, useState, useCallback } from 'react';

function CustomScrollbar({ children, className = '' }) {
  const scrollContainerRef = useRef(null);
  const scrollbarTrackRef = useRef(null);
  
  // On utilise un seul objet d'état pour éviter les re-rendus en cascade
  const [dimensions, setDimensions] = useState({
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    trackHeight: 0
  });

  const updateScrollbar = useCallback(() => {
    const container = scrollContainerRef.current;
    const track = scrollbarTrackRef.current;
    
    if (!container) return;

    requestAnimationFrame(() => {
      setDimensions({
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
        trackHeight: track?.clientHeight || 0
      });
    });
  }, []);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    // 1. Calcul initial avec un petit délai pour laisser le temps au DOM de se peindre
    const timeoutId = setTimeout(updateScrollbar, 50);

    // 2. Écouter le scroll
    container.addEventListener('scroll', updateScrollbar, { passive: true });
    
    // 3. Observer le redimensionnement du conteneur LUI-MÊME
    const resizeObserver = new ResizeObserver(() => updateScrollbar());
    resizeObserver.observe(container);

    // 4. Observer le changement de taille du CONTENU (important pour les formulaires dynamiques)
    if (container.firstElementChild) {
      resizeObserver.observe(container.firstElementChild);
    }

    return () => {
      clearTimeout(timeoutId);
      container.removeEventListener('scroll', updateScrollbar);
      resizeObserver.disconnect();
    };
  }, [children, updateScrollbar]);

  // Vérifier si le scroll est nécessaire (avec une tolérance de 1px pour les arrondis)
  const isScrollable = dimensions.scrollHeight > dimensions.clientHeight + 1 && dimensions.clientHeight > 0;

  // Calculer le style du curseur (thumb)
  const getThumbStyle = () => {
    if (!isScrollable) return { display: 'none' };

    const { scrollHeight, clientHeight, trackHeight, scrollTop } = dimensions;
    
    // Hauteur de la piste disponible (fallback sur clientHeight si trackHeight est 0)
    const availableHeight = trackHeight || clientHeight;
    
    // Hauteur du curseur (minimum 20px pour rester attrapable)
    const thumbHeight = Math.max(20, (clientHeight / scrollHeight) * availableHeight);
    
    // Calcul de la position top
    const maxScrollTop = scrollHeight - clientHeight;
    const scrollRatio = scrollTop / maxScrollTop;
    const maxThumbTop = availableHeight - thumbHeight;
    const thumbTop = Math.min(maxThumbTop, Math.max(0, scrollRatio * maxThumbTop));

    return {
      height: `${thumbHeight}px`,
      transform: `translateY(${thumbTop}px)`, // Plus performant que 'top'
      display: 'block',
    };
  };

  return (
    <div className={`flex flex-row gap-2 items-stretch justify-start relative overflow-hidden ${className}`} style={{ height: '100%', minHeight: 0 }}>
      {/* Conteneur du contenu */}
      <div 
        ref={scrollContainerRef}
        className="flex-1 overflow-x-hidden hide-scrollbar"
        style={{ overflowY: 'auto', height: '100%' }}
      >
        {children}
      </div>

      {/* Barre de défilement - Ne s'affiche QUE si nécessaire */}
      {isScrollable && (
        <div 
          ref={scrollbarTrackRef}
          className="bg-global-bg-small-box rounded-[10px] shrink-0 w-1.5 relative my-1 transition-opacity duration-200"
          style={{ height: 'calc(100% - 8px)' }} // Petite marge en haut/bas
        >
          <div 
            className="bg-global-stroke-highlight-2nd/50 hover:bg-global-content-highlight-2nd w-full rounded-[10px] absolute left-0 transition-colors duration-200"
            style={getThumbStyle()}
          />
        </div>
      )}
    </div>
  );
}

export default CustomScrollbar;

