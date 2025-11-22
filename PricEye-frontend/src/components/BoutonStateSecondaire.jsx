import React from 'react';

function BoutonStateSecondaire({ state = 'secondaire', component, component2, text, className = '', onClick, ...props }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center justify-center gap-2 px-3 py-2 rounded-[10px] border border-solid border-global-stroke-box bg-transparent cursor-pointer hover:opacity-90 transition-opacity ${className}`}
      {...props}
    >
      {component}
      {component2}
      {text && <span className="text-global-blanc font-h3-font-family text-h3-font-size font-h3-font-weight">{text}</span>}
    </button>
  );
}

export default BoutonStateSecondaire;


