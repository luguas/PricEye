import React, { useState, useRef, useEffect } from 'react';
import NotificationsMenu from './NotificationsMenu.jsx';

const BellIcon = ({ className = '' }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={`w-5 h-5 ${className}`}
  >
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
);

const UserIcon = ({ className = '' }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={`w-5 h-5 ${className}`}
  >
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);

function PageTopBar({
  className = '',
  userName = 'Utilisateur',
  propertyCount = null,
  notifications = [],
  token = null,
  onNotificationsUpdate,
  ...props
}) {
  const [isNotificationsMenuOpen, setIsNotificationsMenuOpen] = useState(false);
  const buttonRef = useRef(null);

  const formattedPropertyCount =
    typeof propertyCount === 'number'
      ? `${propertyCount} ${propertyCount > 1 ? 'propriétés' : 'propriété'}`
      : '—';

  // Vérifier s'il y a des notifications
  const hasNotifications = notifications && notifications.length > 0;

  const handleNotificationsClick = () => {
    setIsNotificationsMenuOpen(!isNotificationsMenuOpen);
  };

  const handleCloseMenu = () => {
    setIsNotificationsMenuOpen(false);
  };

  const handleGroupCreated = () => {
    if (onNotificationsUpdate) {
      onNotificationsUpdate();
    }
    // Le menu se fermera automatiquement après la création
  };

  // Calculer la position du menu
  const getMenuPosition = () => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      return {
        top: `${rect.bottom + 8}px`,
        right: `${window.innerWidth - rect.right}px`,
      };
    }
    return { top: '60px', right: '20px' };
  };

  // Fermer le menu si on clique en dehors
  useEffect(() => {
    if (!isNotificationsMenuOpen) return;

    const handleClickOutside = (event) => {
      // Ne pas fermer si on clique sur le bouton de notification ou dans le menu
      if (
        buttonRef.current?.contains(event.target) ||
        document.querySelector('.notifications-menu')?.contains(event.target)
      ) {
        return;
      }
      setIsNotificationsMenuOpen(false);
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isNotificationsMenuOpen]);

  return (
    <div
      className={`bg-global-bg-box border-b border-global-stroke-box px-4 py-3 flex items-center justify-end h-[70px] relative z-10 ${className}`}
      {...props}
    >
      <div className="flex items-center gap-4">
        <button
          ref={buttonRef}
          type="button"
          onClick={handleNotificationsClick}
          className="relative w-10 h-10 flex items-center justify-center rounded-full border border-transparent text-global-inactive hover:text-global-blanc hover:border-global-stroke-box transition"
          aria-label="Notifications"
        >
          {hasNotifications && (
            <span className="absolute top-2 right-2 w-2 h-2 bg-global-content-highlight-2nd rounded-full" />
          )}
          <BellIcon />
        </button>

        {/* Menu de notifications */}
        {isNotificationsMenuOpen && (
          <NotificationsMenu
            isOpen={isNotificationsMenuOpen}
            onClose={handleCloseMenu}
            recommendations={notifications}
            token={token}
            onGroupCreated={handleGroupCreated}
            position={getMenuPosition()}
          />
        )}

        <div className="hidden sm:block w-px h-8 bg-white/10" aria-hidden="true" />

        <div className="flex flex-col items-end">
          <span className="text-global-blanc font-h3-font-family text-h3-font-size font-h3-font-weight leading-h3-line-height">
            {userName}
          </span>
          <span className="text-global-inactive font-p1-font-family text-p1-font-size font-p1-font-weight leading-p1-line-height">
            {formattedPropertyCount}
          </span>
        </div>

        <div
          className="rounded-full w-11 h-11 flex items-center justify-center"
          style={{
            background:
              'linear-gradient(90deg, rgba(21, 93, 252, 1) 0%, rgba(18, 161, 213, 1) 100%)',
          }}
        >
          <UserIcon className="text-white" />
        </div>
      </div>
    </div>
  );
}

export default PageTopBar;

