import React from 'react';

function IconsStateFiltre({ className = '', state = 'filtre', ...props }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className={className} {...props}>
      <path d="M3 5H17M5 10H15M7 15H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

export default IconsStateFiltre;

