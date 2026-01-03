import React from 'react';
import IconsStateFiltre from './IconsStateFiltre.jsx';
import IconsStateFlCheBas from './IconsStateFlCheBas.jsx';
import BoutonStateSecondaire from './BoutonStateSecondaire.jsx';
import { useLanguage } from '../contexts/LanguageContext.jsx';

const SearchIcon = ({ className = '' }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className={className}>
    <path d="M7 13C10.3137 13 13 10.3137 13 7C13 3.68629 10.3137 1 7 1C3.68629 1 1 3.68629 1 7C1 10.3137 3.68629 13 7 13Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M15 15L11.65 11.65" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

function RechercheRSa({ className = '', value = '', onChange, onFilterClick, ...props }) {
  const { t } = useLanguage();
  
  return (
    <div
      className={`bg-global-bg-box rounded-[14px] border border-solid border-global-stroke-box p-6 flex flex-col gap-6 items-start justify-start flex-1 relative ${className}`}
      {...props}
    >
      <div className="flex flex-row items-center justify-between self-stretch shrink-0 h-[38px] relative">
        <div className="bg-global-bg-box rounded-lg border border-solid border-global-stroke-box pt-[7px] pr-3 pb-[7px] pl-3 flex flex-row gap-3 items-center justify-start self-stretch shrink-0 w-[400px] relative">
          <SearchIcon className="w-4 h-4 shrink-0 text-global-inactive" />
          <input
            type="text"
            value={value}
            onChange={(e) => onChange && onChange(e.target.value)}
            placeholder={t('bookings.searchPlaceholder')}
            className="flex-1 bg-transparent border-none outline-none text-global-inactive font-h4-font-family text-h4-font-size leading-h4-line-height font-h4-font-weight placeholder:text-global-inactive"
          />
        </div>
        <BoutonStateSecondaire
          state="secondaire"
          component={<IconsStateFiltre className="!w-5 !h-5" state="filtre" />}
          component2={<IconsStateFlCheBas className="!w-5 !h-5" state="fl-che-bas" />}
          onClick={onFilterClick}
          className="!shrink-0"
        />
      </div>
    </div>
  );
}

export default RechercheRSa;

