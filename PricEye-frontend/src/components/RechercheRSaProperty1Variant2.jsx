import React from 'react';

const SearchIcon = ({ className = '' }) => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className={className}>
    <path d="M9 17C13.4183 17 17 13.4183 17 9C17 4.58172 13.4183 1 9 1C4.58172 1 1 4.58172 1 9C1 13.4183 4.58172 17 9 17Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M19 19L14.65 14.65" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

function RechercheRSaProperty1Variant2({ className = '', value = '', onChange, placeholder = 'Rechercher une propriété...', ...props }) {
  return (
    <div className={`relative flex-1 ${className}`} {...props}>
      <div className="relative">
        <div className="absolute left-3 top-1/2 transform -translate-y-1/2 text-global-inactive pointer-events-none">
          <SearchIcon className="w-5 h-5" />
        </div>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange && onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full bg-global-bg-small-box border border-solid border-global-stroke-box rounded-[10px] pl-10 pr-4 py-2.5 text-global-blanc placeholder:text-global-inactive font-h4-font-family text-h4-font-size font-h4-font-weight leading-h4-line-height focus:outline-none focus:ring-2 focus:ring-global-content-highlight-2nd focus:border-transparent"
        />
      </div>
    </div>
  );
}

export default RechercheRSaProperty1Variant2;

