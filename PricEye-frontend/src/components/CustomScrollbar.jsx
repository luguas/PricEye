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

    updateScrollbar();
    // Plusieurs vérifications pour capturer le rendu initial et les animations
    const timers = [
      setTimeout(updateScrollbar, 50),
      setTimeout(updateScrollbar, 150), 
      setTimeout(updateScrollbar, 500)
    ];

    container.addEventListener('scroll', updateScrollbar, { passive: true });
    window.addEventListener('resize', updateScrollbar);
    
    const resizeObserver = new ResizeObserver(() => updateScrollbar());
    resizeObserver.observe(container);
    if (container.firstElementChild) {
      resizeObserver.observe(container.firstElementChild);
    }

    return () => {
      timers.forEach(clearTimeout);
      container.removeEventListener('scroll', updateScrollbar);
      window.removeEventListener('resize', updateScrollbar);
      resizeObserver.disconnect();
    };
  }, [children, updateScrollbar]);

  // Seuil de tolérance très bas (0.5px) pour garantir l'affichage
  const isScrollable = dimensions.scrollHeight > dimensions.clientHeight + 0.5;

  const getThumbStyle = () => {
    if (!isScrollable) return { display: 'none' };

    const { scrollHeight, clientHeight, trackHeight, scrollTop } = dimensions;
    const availableHeight = trackHeight || clientHeight;
    
    if (scrollHeight === 0) return { display: 'none' };

    const thumbHeight = Math.max(20, (clientHeight / scrollHeight) * availableHeight);
    const maxScrollTop = scrollHeight - clientHeight;
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
    // Le conteneur parent est RELATIVE pour permettre le positionnement ABSOLU des enfants
    <div className={`relative overflow-hidden ${className}`}>
      
      {/* 1. Zone de scroll native (cachée visuellement mais active) */}
      {/* absolute inset-0 force ce div à prendre exactement la taille du parent */}
      <div 
        ref={scrollContainerRef}
        className="absolute inset-0 overflow-y-auto overflow-x-hidden hide-scrollbar"
        style={{ scrollBehavior: 'smooth' }}
      >
        {children}
      </div>

      {/* 2. Barre de défilement personnalisée (superposée à droite) */}
      {isScrollable && (
        <div 
          ref={scrollbarTrackRef}
          className="absolute right-1 top-1 bottom-1 w-1.5 z-20 transition-opacity duration-200"
        >
          {/* Fond de la barre (Track) - Rendu plus visible */}
          <div className="absolute inset-0 bg-gray-700/30 rounded-full"></div>
          
          {/* Curseur (Thumb) */}
          <div 
            className="bg-gray-400/80 hover:bg-white/80 w-full rounded-full absolute left-0 transition-colors duration-200 cursor-pointer"
            style={getThumbStyle()}
          />
        </div>
      )}
    </div>
  );
}

export default CustomScrollbar;
