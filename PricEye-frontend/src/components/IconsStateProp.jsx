import React from 'react';

export const IconsStateProp = ({ className = '', state, ...props }) => {
  return (
    <svg
      className={`w-6 h-6 ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path d="M3 10.5L12 3L21 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M5 10.5V21H9V15H15V21H19V10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
};

export default IconsStateProp;

