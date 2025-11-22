import React, { useRef, useEffect, useState } from 'react';

function CustomScrollbar({ children, className = '' }) {
  const scrollContainerRef = useRef(null);
  const scrollbarTrackRef = useRef(null);
  const [scrollPosition, setScrollPosition] = useState(0);
  const [scrollHeight, setScrollHeight] = useState(0);
  const [clientHeight, setClientHeight] = useState(0);
  const [trackHeight, setTrackHeight] = useState(0);

  useEffect(() => {
    const container = scrollContainerRef.current;
    const track = scrollbarTrackRef.current;
    if (!container) return;

    const updateScrollbar = () => {
      requestAnimationFrame(() => {
        if (!container) return;
        const scrollTop = container.scrollTop;
        const scrollHeight = container.scrollHeight;
        const clientHeight = container.clientHeight;
        const trackHeight = track?.offsetHeight || 0;
        
        setScrollPosition(scrollTop);
        setScrollHeight(scrollHeight);
        setClientHeight(clientHeight);
        if (trackHeight > 0) {
          setTrackHeight(trackHeight);
        }
      });
    };

    // Mise à jour initiale
    updateScrollbar();

    // Écouter les événements de scroll avec passive pour de meilleures performances
    container.addEventListener('scroll', updateScrollbar, { passive: true });
    
    // Observer les changements de taille du contenu et de la track
    const resizeObserver = new ResizeObserver(() => {
      updateScrollbar();
    });
    resizeObserver.observe(container);
    if (track) {
      resizeObserver.observe(track);
    }

    return () => {
      container.removeEventListener('scroll', updateScrollbar);
      resizeObserver.disconnect();
    };
  }, [children]);

  // Calculer la position et la taille de l'indicateur de scroll
  const getScrollbarStyle = () => {
    if (scrollHeight <= clientHeight || clientHeight === 0) {
      return { display: 'none' };
    }

    // Utiliser la hauteur de la track si disponible, sinon utiliser clientHeight comme fallback
    const scrollbarTrackHeight = trackHeight > 0 ? trackHeight : clientHeight;
    const scrollbarThumbHeight = Math.max(20, (clientHeight / scrollHeight) * scrollbarTrackHeight);
    const maxScroll = scrollHeight - clientHeight;
    const scrollPercentage = maxScroll > 0 ? scrollPosition / maxScroll : 0;
    const scrollbarThumbTop = Math.max(0, scrollPercentage * (scrollbarTrackHeight - scrollbarThumbHeight));

    return {
      height: `${scrollbarThumbHeight}px`,
      top: `${scrollbarThumbTop}px`,
      display: 'block',
    };
  };

  return (
    <div className={`flex flex-row gap-2 items-stretch justify-start relative ${className}`} style={{ height: '100%', minHeight: 0 }}>
      <div 
        ref={scrollContainerRef}
        className="flex-1 overflow-x-hidden hide-scrollbar"
        style={{ overflowY: 'auto', height: '100%' }}
      >
        {children}
      </div>
      {/* Barre de défilement personnalisée */}
      <div 
        ref={scrollbarTrackRef}
        className="bg-global-bg-small-box rounded-[10px] shrink-0 w-2 relative overflow-hidden flex-shrink-0 self-stretch"
        style={{ height: '100%', minHeight: '100px' }}
      >
        {scrollHeight > clientHeight && clientHeight > 0 && (
          <div 
            className="bg-global-blanc rounded-[10px] w-1.5 absolute left-px overflow-hidden"
            style={getScrollbarStyle()}
          ></div>
        )}
      </div>
    </div>
  );
}

export default CustomScrollbar;

