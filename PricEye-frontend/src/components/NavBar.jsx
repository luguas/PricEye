import React from 'react';
import logoPriceye from '../../Images/logo priceye.png';
import { useLanguage } from '../contexts/LanguageContext.jsx';

const IconDashboard = ({ className = '' }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={`w-5 h-5 ${className}`}
  >
    <path d="M3 13h8V3H3z" />
    <path d="M13 21h8V11h-8z" />
    <path d="M13 3v6h8V3z" />
    <path d="M3 21h8v-4H3z" />
  </svg>
);

const IconCalendar = ({ className = '' }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={`w-5 h-5 ${className}`}
  >
    <rect x="3" y="4" width="18" height="18" rx="3" />
    <path d="M16 2v4" />
    <path d="M8 2v4" />
    <path d="M3 10h18" />
    <path d="M8 14h.01" />
    <path d="M12 14h.01" />
    <path d="M16 14h.01" />
    <path d="M8 18h.01" />
    <path d="M12 18h.01" />
    <path d="M16 18h.01" />
  </svg>
);

const IconReports = ({ className = '' }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={`w-5 h-5 ${className}`}
  >
    <path d="M3 3h6l2 3h10a0 0 0 0 1 0 0v14a2 2 0 0 1-2 2H3a0 0 0 0 1-0-0V3a0 0 0 0 1 0-0z" />
    <path d="M13 10h4" />
    <path d="M13 14h4" />
    <path d="M8 10h.01" />
    <path d="M8 14h.01" />
  </svg>
);

const IconProperties = ({ className = '' }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={`w-5 h-5 ${className}`}
  >
    <path d="M3 21h18" />
    <path d="M5 21V8l7-5 7 5v13" />
    <path d="M9 21v-6h6v6" />
  </svg>
);

const IconSettings = ({ className = '' }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={`w-5 h-5 ${className}`}
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.37.53.58 1.16.6 1.81V11a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);


const IconArrow = ({ direction = 'left', className = '' }) => {
  const isLeft = direction === 'left';
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`${className} w-4 h-4`}
    >
      {isLeft ? <polyline points="15 18 9 12 15 6" /> : <polyline points="9 18 15 12 9 6" />}
    </svg>
  );
};

const navItemsConfig = [
  { id: 'dashboard', translationKey: 'sidebar.dashboard', icon: IconDashboard },
  { id: 'bookings', translationKey: 'sidebar.bookings', icon: IconCalendar },
  { id: 'report', translationKey: 'sidebar.reports', icon: IconReports },
  { id: 'pricing', translationKey: 'sidebar.pricing', icon: IconCalendar },
  { id: 'settings', translationKey: 'sidebar.settings', icon: IconSettings },
];

export const NavBar = ({
  currentView,
  onNavigate,
  isCollapsed = false,
  onToggleCollapse,
  className = '',
  ...props
}) => {
  const { t } = useLanguage();
  const navWidthClass = isCollapsed ? 'w-[96px]' : 'w-[255px]';
  
  const navItems = navItemsConfig.map(item => ({
    ...item,
    label: t(item.translationKey)
  }));

  return (
    <nav
      className={`hidden md:flex flex-col gap-2.5 items-start justify-center ${navWidthClass} min-h-screen fixed left-0 top-0 transition-[width] duration-300 z-20 ${className}`}
      {...props}
    >
      <div className="bg-global-bg-box border-r border-global-stroke-box flex flex-col items-stretch justify-between w-full min-h-screen relative">
        <div className={`border-b border-global-stroke-box h-[70px] flex items-center justify-between ${isCollapsed ? 'px-4' : 'px-8'}`}>
          <div className="flex items-center gap-3">
            <img 
              src={logoPriceye} 
              alt="PricEye Logo" 
              className="w-[27px] h-10 object-contain"
            />
            {!isCollapsed && (
              <div className="text-global-blanc text-left font-['Avenir-Heavy',sans-serif] text-xl leading-6 font-normal relative">
                PricEye
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => onToggleCollapse?.()}
            className={`${isCollapsed ? 'hidden' : 'p-3'} rounded-xl border border-transparent text-global-inactive hover:text-global-blanc hover:border-global-stroke-box transition`}
            aria-label={isCollapsed ? 'Déplier la barre latérale' : 'Replier la barre latérale'}
          >
            {!isCollapsed && <IconArrow direction="left" />}
          </button>
        </div>

        <div className={`p-4 flex flex-col gap-2 flex-1 ${isCollapsed ? 'items-center' : ''}`}>
          {navItems.map(({ id, label, icon: Icon }) => {
            const isActive = currentView === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => onNavigate?.(id)}
                className={`w-full flex items-center ${isCollapsed ? 'justify-center' : 'gap-3 justify-start'} rounded-2xl ${isCollapsed ? 'px-0 py-3' : 'px-4 py-3'} text-sm font-medium transition duration-200 border ${
                  isActive
                    ? 'bg-global-stroke-highlight-2nd/20 border-global-stroke-highlight-2nd text-global-blanc shadow-[0_8px_30px_rgba(0,184,219,0.15)]'
                    : 'border-transparent text-global-inactive hover:border-global-stroke-box hover:text-global-blanc'
                }`}
                aria-label={isCollapsed ? label : undefined}
              >
                <Icon
                  className={
                    isActive ? 'text-global-content-highlight-2nd' : ''
                  }
                />
                {!isCollapsed && <span className="flex-1 text-left">{label}</span>}
              </button>
            );
          })}
        </div>

        {isCollapsed && (
          <button
            type="button"
            onClick={() => onToggleCollapse?.()}
            aria-label="Déplier la barre latérale"
            className="hidden md:flex absolute top-[70px] -right-4 bg-global-bg-box border border-global-stroke-box rounded-tr-xl rounded-br-xl p-2 text-global-inactive hover:text-global-blanc hover:border-global-content-highlight-2nd transition"
          >
            <IconArrow direction="right" />
          </button>
        )}
      </div>
    </nav>
  );
};

export default NavBar;

