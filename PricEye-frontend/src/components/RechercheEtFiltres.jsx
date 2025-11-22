import React from 'react';
import RechercheRSaProperty1Variant2 from './RechercheRSaProperty1Variant2.jsx';

function RechercheEtFiltres({ className = '', searchValue = '', onSearchChange, ...props }) {
  return (
    <div
      className={`flex flex-row gap-3 items-start justify-start self-stretch shrink-0 relative ${className}`}
      {...props}
    >
      <RechercheRSaProperty1Variant2 
        value={searchValue}
        onChange={onSearchChange}
        className="flex-1"
      />
    </div>
  );
}

export default RechercheEtFiltres;


