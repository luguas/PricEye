import React from 'react';

function IconsStateAdd({ className = '', state = 'add', visibleComponent = true, ...props }) {
  if (!visibleComponent) return null;
  
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className={className} {...props}>
      <path d="M10 4V16M4 10H16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

export default IconsStateAdd;

