import React from 'react';

function Pastille({ text, className = '' }) {
  return (
    <div
      className={`inline-flex items-center justify-center px-2 py-1 rounded-[10px] border border-solid text-global-blanc font-p1-font-family text-p1-font-size font-p1-font-weight relative ${className}`}
    >
      {text}
    </div>
  );
}

export default Pastille;


