import React from 'react';

export const IconsStateLogoPriceye = ({ className = '', state, ...props }) => {
  return (
    <svg
      className={`w-6 h-6 ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path d="M12 3L1 9L12 15L21 10.74V17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M5 10.74V15.26C5 15.54 5.11 15.81 5.3 16L11.3 22C11.69 22.39 12.31 22.39 12.7 22L18.7 16C18.89 15.81 19 15.54 19 15.26V10.74" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M9 21H15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
};

export default IconsStateLogoPriceye;


