import React from 'react';
import IconsStateFlCheBas from './IconsStateFlCheBas.jsx';

export const Filtre = ({ text, text2, className = '', value, onChange, options = [], ...props }) => {
  // Fonction helper pour extraire la valeur d'une option
  const getOptionValue = (option) => {
    if (typeof option === 'string') return option;
    if (typeof option === 'object' && option !== null) {
      return option.value || option.id || '';
    }
    return '';
  };

  // Fonction helper pour extraire le label d'une option
  const getOptionLabel = (option) => {
    if (typeof option === 'string') return option;
    if (typeof option === 'object' && option !== null) {
      return option.label || option.name || option.address || option.value || option.id || '';
    }
    return '';
  };

  // Gérer le onChange pour supporter les deux formats : onChange(event) ou onChange(value)
  const handleChange = (e) => {
    if (onChange) {
      const newValue = e.target.value;
      // Si onChange est une fonction setState (comme setChannel, setPropertyId), elle attend directement une valeur
      // Sinon, on passe l'event pour compatibilité avec le code existant
      // On essaie d'abord avec la valeur directe (le plus courant avec setState)
      onChange(newValue);
    }
  };

  return (
    <div className={`flex flex-col gap-2 items-start justify-start shrink-0 relative ${className}`} {...props}>
      {text && (
        <div className="text-global-blanc text-left font-p1-font-family text-p1-font-size font-p1-font-weight relative self-stretch">
          {text}
        </div>
      )}
      <div className="bg-global-bg-small-box rounded-lg border-solid border-global-stroke-box border pt-[7px] pr-3 pb-[7px] pl-3 flex flex-row gap-3 items-center justify-start self-stretch shrink-0 h-[38px] relative overflow-hidden">
        {options.length > 0 ? (
          <>
            <select
              value={value || ''}
              onChange={handleChange}
              className="flex-1 bg-transparent border-none outline-none text-global-inactive font-h4-font-family text-h4-font-size leading-h4-line-height font-h4-font-weight appearance-none cursor-pointer relative z-30 pr-8"
              style={{ 
                WebkitAppearance: 'none', 
                MozAppearance: 'none',
                msAppearance: 'none',
                appearance: 'none',
                backgroundImage: 'none'
              }}
            >
              <option value="" style={{ backgroundColor: 'rgba(29, 41, 61, 1)', color: '#90a1b9' }}>{text2 || 'Sélectionner...'}</option>
              {options.map((option, index) => {
                const optValue = getOptionValue(option);
                const optLabel = getOptionLabel(option);
                // Utiliser l'index comme fallback pour la clé si on n'a pas de valeur unique
                const key = optValue || index;
                return (
                  <option 
                    key={key} 
                    value={optValue}
                    style={{ backgroundColor: 'rgba(29, 41, 61, 1)', color: '#90a1b9' }}
                  >
                    {optLabel}
                  </option>
                );
              })}
            </select>
            <IconsStateFlCheBas className="!w-5 !h-5 shrink-0 pointer-events-none absolute right-3 z-10" state="fl-che-bas" />
          </>
        ) : (
          <>
            <div className="text-global-inactive text-left font-h4-font-family text-h4-font-size leading-h4-line-height font-h4-font-weight relative flex-1">
              {text2 || 'Sélectionner...'}
            </div>
            <IconsStateFlCheBas className="!w-5 !h-5 shrink-0 pointer-events-none" state="fl-che-bas" />
          </>
        )}
      </div>
    </div>
  );
};

export default Filtre;


