import React, { useRef, useEffect, useState, useCallback } from 'react';

function CustomScrollbar({ children, className = '' }) {
  const scrollContainerRef = useRef(null);
  const scrollbarTrackRef = useRef(null);
  
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

    window.requestAnimationFrame(() => {
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

    // 1. Calcul immédiat et différé pour être sûr
    updateScrollbar();
    const timeoutId = setTimeout(updateScrollbar, 100);

    // 2. Écouteurs
    container.addEventListener('scroll', updateScrollbar, { passive: true });
    window.addEventListener('resize', updateScrollbar); // Ajout important pour le responsive
    
    // 3. Observers
    const resizeObserver = new ResizeObserver(() => updateScrollbar());
    resizeObserver.observe(container);
    if (container.firstElementChild) {
      resizeObserver.observe(container.firstElementChild);
    }

    return () => {
      clearTimeout(timeoutId);
      container.removeEventListener('scroll', updateScrollbar);
      window.removeEventListener('resize', updateScrollbar);
      resizeObserver.disconnect();
    };
  }, [children, updateScrollbar]);

  // Calcul plus souple : on utilise Math.ceil pour éviter les problèmes de sub-pixel
  // On considère scrollable si le contenu dépasse d'au moins 1px
  // La scrollbar ne s'affiche que si le contenu dépasse réellement la hauteur disponible
  const isScrollable = dimensions.scrollHeight > dimensions.clientHeight + 1;

  const getThumbStyle = () => {
    if (!isScrollable) return { display: 'none' };

    const { scrollHeight, clientHeight, trackHeight, scrollTop } = dimensions;
    const availableHeight = trackHeight || clientHeight;
    
    // Protection division par zéro
    if (scrollHeight === 0) return { display: 'none' };

    const thumbHeight = Math.max(20, (clientHeight / scrollHeight) * availableHeight);
    const maxScrollTop = scrollHeight - clientHeight;
    
    // Évite division par zéro si maxScrollTop est nul
    const scrollRatio = maxScrollTop > 0 ? scrollTop / maxScrollTop : 0;
    
    const maxThumbTop = availableHeight - thumbHeight;
    const thumbTop = Math.min(maxThumbTop, Math.max(0, scrollRatio * maxThumbTop));

    return {
      height: `${thumbHeight}px`,
      transform: `translateY(${thumbTop}px)`,
      display: 'block',
    };
  };

  return (
    <div className={`flex flex-row gap-2 items-stretch justify-start relative overflow-hidden ${className}`} style={{ height: '100%', minHeight: 0 }}>
      {/* Conteneur du contenu */}
      <div 
        ref={scrollContainerRef}
        className="flex-1 overflow-x-hidden hide-scrollbar"
        // Important: overflowY auto permet le scroll natif (caché visuellement), height 100% remplit le parent
        style={{ overflowY: 'auto', height: '100%' }}
      >
        {children}
      </div>

      {/* Barre de défilement */}
      {/* On utilise opacity-0 au lieu de ne pas rendre le composant pour garder la structure stable si besoin, 
          mais ici le rendu conditionnel est plus propre pour le layout flex */}
      {isScrollable && (
        <div 
          ref={scrollbarTrackRef}
          // z-10 assure que la barre est au-dessus
          // bg-white/5 est une couleur de fallback visible sur fond sombre si global-bg-small-box échoue
          className="bg-global-bg-small-box bg-white/5 rounded-[10px] shrink-0 w-1.5 relative my-1 z-10 transition-opacity duration-200"
          style={{ height: 'calc(100% - 8px)' }}
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

