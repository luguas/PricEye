import React from 'react';

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

const IconLogout = ({ className = '' }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={`w-5 h-5 ${className}`}
  >
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="16 17 21 12 16 7" />
    <line x1="21" y1="12" x2="9" y2="12" />
  </svg>
);

const navItems = [
  { id: 'dashboard', label: 'Tableau de bord', icon: IconDashboard },
  { id: 'bookings', label: 'Réservations', icon: IconCalendar },
  { id: 'report', label: 'Rapports', icon: IconReports },
  { id: 'pricing', label: 'Calendrier pricing', icon: IconCalendar },
  { id: 'settings', label: 'Paramètres', icon: IconSettings },
];

export const NavBar = ({
  currentView,
  onNavigate,
  onLogout,
  className = '',
  ...props
}) => {
  return (
    <nav
      className={`hidden md:flex flex-col gap-2.5 items-start justify-center w-[255px] min-h-screen fixed left-0 top-0 ${className}`}
      {...props}
    >
      <div className="bg-global-bg-box border-r border-global-stroke-box flex flex-col items-stretch justify-between w-full min-h-screen">
        <div className="border-b border-global-stroke-box px-8 h-[70px] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-[27px] h-10 rounded-lg bg-global-content-highlight-2nd text-global-blanc font-bold flex items-center justify-center text-base">
              P
            </div>
            <div className="text-global-blanc font-h2-font-family text-h2-font-size font-h2-font-weight">
              PricEye
            </div>
          </div>
          <button
            type="button"
            className="p-3 rounded-xl border border-transparent text-global-inactive hover:text-global-blanc hover:border-global-stroke-box transition"
            aria-label="Réduire la barre latérale"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-4 h-4"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        </div>

        <div className="p-4 flex flex-col gap-2 flex-1">
          {navItems.map(({ id, label, icon: Icon }) => {
            const isActive = currentView === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => onNavigate?.(id)}
                className={`w-full flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-medium transition duration-200 border ${
                  isActive
                    ? 'bg-global-stroke-highlight-2nd/20 border-global-stroke-highlight-2nd text-global-blanc shadow-[0_8px_30px_rgba(0,184,219,0.15)]'
                    : 'border-transparent text-global-inactive hover:border-global-stroke-box hover:text-global-blanc'
                }`}
              >
                <Icon
                  className={
                    isActive ? 'text-global-content-highlight-2nd' : ''
                  }
                />
                <span className="flex-1 text-left">{label}</span>
              </button>
            );
          })}
        </div>

        <div className="p-4 border-t border-global-stroke-box">
          <button
            type="button"
            onClick={onLogout}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-2xl border border-global-stroke-box text-global-blanc hover:border-global-content-highlight-2nd transition"
          >
            <IconLogout className="text-global-content-highlight-2nd" />
            <span>Déconnexion</span>
          </button>
        </div>
      </div>
    </nav>
  );
};

export default NavBar;

