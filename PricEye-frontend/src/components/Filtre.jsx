import React from 'react';
import IconsStateFlCheBas from './IconsStateFlCheBas.jsx';

export const Filtre = ({ text, text2, className = '', value, onChange, options = [], ...props }) => {
  return (
    <div className={`flex flex-col gap-2 items-start justify-start shrink-0 relative ${className}`} {...props}>
      {text && (
        <div className="text-global-blanc text-left font-p1-font-family text-p1-font-size font-p1-font-weight relative self-stretch">
          {text}
        </div>
      )}
      <div className="bg-global-bg-small-box rounded-lg border-solid border-global-stroke-box border pt-[7px] pr-3 pb-[7px] pl-3 flex flex-row gap-3 items-center justify-start self-stretch shrink-0 h-[38px] relative">
        {options.length > 0 ? (
          <select
            value={value || ''}
            onChange={onChange}
            className="flex-1 bg-transparent border-none outline-none text-global-inactive font-h4-font-family text-h4-font-size leading-h4-line-height font-h4-font-weight appearance-none cursor-pointer"
          >
            <option value="">{text2 || 'Sélectionner...'}</option>
            {options.map((option) => (
              <option key={typeof option === 'string' ? option : option.value} value={typeof option === 'string' ? option : option.value}>
                {typeof option === 'string' ? option : option.label}
              </option>
            ))}
          </select>
        ) : (
          <div className="text-global-inactive text-left font-h4-font-family text-h4-font-size leading-h4-line-height font-h4-font-weight relative">
            {text2 || 'Sélectionner...'}
          </div>
        )}
        <IconsStateFlCheBas className="!w-5 !h-5 shrink-0" state="fl-che-bas" />
      </div>
    </div>
  );
};

export default Filtre;

