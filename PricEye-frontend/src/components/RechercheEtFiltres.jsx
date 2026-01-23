import React from 'react';
import RechercheRSaProperty1Variant2 from './RechercheRSaProperty1Variant2.jsx';
import { Filtre } from './Filtre.jsx';

function RechercheEtFiltres({ 
  className = '', 
  searchValue = '', 
  onSearchChange,
  // Nouvelles props pour les filtres
  properties = [],
  selectedProperty,
  onPropertyChange,
  selectedChannel,
  onChannelChange,
  channels = [],
  selectedDate,
  onDateChange,
  ...props 
}) {
  return (
    <div
      className={`flex flex-row gap-3 items-start justify-start self-stretch shrink-0 relative ${className}`}
      {...props}
    >
      {/* Barre de recherche */}
      <RechercheRSaProperty1Variant2 
        value={searchValue}
        onChange={onSearchChange}
        className="flex-1"
      />

      {/* Filtres optionnels */}
      {(properties.length > 0 || channels.length > 0 || onDateChange) && (
        <div className="flex flex-row gap-3 items-start justify-start shrink-0 relative">
          {/* Filtre Propriété */}
          {properties.length > 0 && onPropertyChange && (
            <Filtre 
              text="Propriété" 
              value={selectedProperty || ''} 
              onChange={onPropertyChange}
              options={properties.map(p => ({
                id: p.id || p.value,
                name: p.name || p.address || p.label
              }))}
              text2={selectedProperty ? (properties.find(p => (p.id || p.value) === selectedProperty)?.name || properties.find(p => (p.id || p.value) === selectedProperty)?.address || 'Tous') : 'Tous'}
            />
          )}

          {/* Filtre Channel */}
          {channels.length > 0 && onChannelChange && (
            <Filtre 
              text="Canal" 
              value={selectedChannel || ''} 
              onChange={onChannelChange}
              options={channels}
              text2={selectedChannel || 'Tous'}
            />
          )}

          {/* Filtre Date (optionnel) */}
          {onDateChange && (
            <div className="flex flex-col gap-2 items-start justify-start shrink-0 relative">
              <div className="text-global-blanc text-left font-p1-font-family text-p1-font-size font-p1-font-weight relative self-stretch">
                Date
              </div>
              <div className="bg-global-bg-small-box rounded-lg border-solid border-global-stroke-box border pt-[7px] pr-3 pb-[7px] pl-3 flex flex-row gap-3 items-center justify-start self-stretch shrink-0 h-[38px] relative">
                <input 
                  type="month" 
                  value={selectedDate || new Date().toISOString().slice(0, 7)}
                  onChange={(e) => onDateChange(e.target.value)}
                  className="flex-1 bg-transparent border-none outline-none text-global-inactive font-h4-font-family text-h4-font-size leading-h4-line-height font-h4-font-weight"
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default RechercheEtFiltres;


