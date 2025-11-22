import React from 'react';
import IconsStateAdd from './IconsStateAdd.jsx';

function Bouton({ state = 'principal', className = '', children, text, onClick, ...props }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-[10px] border border-solid border-global-stroke-highlight-2nd pt-2 pr-3 pb-2 pl-3 flex flex-row gap-2 items-center justify-center shrink-0 relative cursor-pointer hover:opacity-90 transition-opacity ${className}`}
      style={{
        background: 'linear-gradient(90deg, rgba(21, 93, 252, 0.20) 0%, rgba(0, 146, 184, 0.20) 100%)',
      }}
      {...props}
    >
      <IconsStateAdd
        state="add"
        visibleComponent={true}
        className="!w-5 !h-5"
      />
      <div className="text-global-blanc text-left font-h4-font-family text-h4-font-size leading-h4-line-height font-h4-font-weight relative">
        {text || children || 'Ajouter Réservation'}
      </div>
    </button>
  );
}

export default Bouton;

