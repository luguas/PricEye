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
    // On garde les timers pour être sûr que le rendu est fini
    const timers = [
      setTimeout(updateScrollbar, 50),
      setTimeout(updateScrollbar, 200)
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

  const isScrollable = dimensions.scrollHeight > dimensions.clientHeight + 1;

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
    // CORRECTION : On revient à Flexbox standard. "relative" sert juste d'ancrage pour la barre.
    <div className={`relative flex flex-col overflow-hidden ${className}`}>
      
      {/* 1. Zone de scroll native : flex-1 pour qu'elle prenne toute la place dispo, mais reste DANS le flux */}
      <div 
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto overflow-x-hidden hide-scrollbar w-full"
        style={{ scrollBehavior: 'smooth' }}
      >
        {children}
      </div>

      {/* 2. Barre de défilement (superposée à droite) */}
      {isScrollable && (
        <div 
          ref={scrollbarTrackRef}
          className="absolute right-1 top-1 bottom-1 w-1.5 z-20"
        >
          {/* Fond de la barre */}
          <div className="absolute inset-0 bg-gray-700/30 rounded-full"></div>
          
          {/* Curseur */}
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
