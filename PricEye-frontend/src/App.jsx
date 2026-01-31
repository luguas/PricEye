import React, { useState, useEffect, useCallback, useRef } from 'react';
import { jwtDecode } from 'jwt-decode';
import { AuthProvider, useAuth } from './contexts/AuthContext'; // Import du Context
import { LanguageProvider } from './contexts/LanguageContext';

// Pages & Components imports...
import LoginPage from './pages/LoginPage.jsx';
import RegisterPage from './pages/RegisterPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import PricingPage from './pages/PricingPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import ReportPage from './pages/ReportPage.jsx'; 
import BookingsPage from './pages/BookingsPage.jsx';
import CheckoutSuccessPage from './pages/CheckoutSuccessPage.jsx';
import CheckoutCancelPage from './pages/CheckoutCancelPage.jsx';
import AccessBlockedPage from './pages/AccessBlockedPage.jsx';
import { getUserProfile, getGroupRecommendations, getProperties } from './services/api.js'; 
import NavBar from './components/NavBar.jsx';
import PageTopBar from './components/PageTopBar.jsx';
import LoadingSpinner from './components/LoadingSpinner.jsx';

/**
 * Applique le thème (clair/sombre/auto) à l'élément <html>.
 * @param {string} theme - 'light', 'dark', ou 'auto'
 */
function applyTheme(theme) {
  const root = window.document.documentElement;
  root.classList.remove('light', 'dark');

  if (theme === 'auto') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.classList.add(prefersDark ? 'dark' : 'light');
  } else {
    root.classList.add(theme);
  }
}

// Composant interne qui consomme le auth context
function AppRouter() {
  const { token, userProfile, isLoading, isLoadingProfile, login, logout, updateUserProfile } = useAuth();
  const [currentView, setCurrentView] = useState(() => {
    // Vérifier si on vient de Stripe Checkout
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('session_id') || urlParams.get('canceled')) {
      return urlParams.get('session_id') ? 'checkout-success' : 'checkout-cancel';
    }
    // Par défaut, retourner dashboard (la redirection sera gérée par useEffect)
    return 'dashboard';
  }); 
  const [isNavCollapsed, setIsNavCollapsed] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [isLoadingNotifications, setIsLoadingNotifications] = useState(false);
  const [propertyCount, setPropertyCount] = useState(null);
  const [checkoutSessionId, setCheckoutSessionId] = useState(null);
  const [apiRequestsInProgress, setApiRequestsInProgress] = useState(0);
  const [showApiLoader, setShowApiLoader] = useState(false);
  const [isDesktop, setIsDesktop] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches);
  const loaderShownAtRef = useRef(0);
  const countRef = useRef(0);
  const hideTimeoutRef = useRef(null);

  countRef.current = apiRequestsInProgress;

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const onChange = () => setIsDesktop(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Compter les requêtes API (pour savoir quand tout est chargé)
  useEffect(() => {
    const onStart = () => setApiRequestsInProgress((c) => c + 1);
    const onEnd = () => setApiRequestsInProgress((c) => Math.max(0, c - 1));
    window.addEventListener('api-request-start', onStart);
    window.addEventListener('api-request-end', onEnd);
    return () => {
      window.removeEventListener('api-request-start', onStart);
      window.removeEventListener('api-request-end', onEnd);
    };
  }, []);

  // Overlay uniquement au premier chargement ou au changement d'onglet (pas à chaque requête API)
  useEffect(() => {
    setShowApiLoader(true);
    loaderShownAtRef.current = Date.now();
  }, [currentView]);

  // Cacher l'overlay seulement après : plus de requêtes depuis 1.2s ET affichage visible depuis au moins 2.5s (évite double affichage)
  const MIN_DISPLAY_MS = 2500;
  const IDLE_BEFORE_HIDE_MS = 1200;

  useEffect(() => {
    if (apiRequestsInProgress > 0) return;

    const tryHide = () => {
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = setTimeout(() => {
        hideTimeoutRef.current = null;
        if (countRef.current > 0) return;
        const elapsed = Date.now() - loaderShownAtRef.current;
        if (elapsed >= MIN_DISPLAY_MS) {
          setShowApiLoader(false);
        } else {
          const remaining = MIN_DISPLAY_MS - elapsed;
          hideTimeoutRef.current = setTimeout(() => {
            hideTimeoutRef.current = null;
            if (countRef.current > 0) return;
            setShowApiLoader(false);
          }, remaining);
        }
      }, IDLE_BEFORE_HIDE_MS);
    };

    tryHide();
    return () => {
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    };
  }, [apiRequestsInProgress]);

  // Gérer le changement de thème
  const handleThemeChange = (newTheme) => {
    updateUserProfile(prev => ({ ...prev, theme: newTheme }));
    applyTheme(newTheme);
  };

  // Fonction pour charger les notifications
  const fetchNotifications = useCallback(async (authToken) => {
    if (!authToken) {
      setNotifications([]);
      return;
    }

    try {
      setIsLoadingNotifications(true);
      const recs = await getGroupRecommendations(authToken);
      setNotifications(recs || []);
    } catch (err) {
      console.error("Erreur lors du chargement des notifications:", err);
      setNotifications([]);
    } finally {
      setIsLoadingNotifications(false);
    }
  }, []);

  // Fonction pour charger le nombre de propriétés
  const fetchPropertyCount = useCallback(async (authToken) => {
    if (!authToken) {
      setPropertyCount(null);
      return;
    }

    try {
      const properties = await getProperties(authToken);
      // Filtrer uniquement les propriétés actives (pour correspondre au dashboard)
      const activeProperties = Array.isArray(properties) 
        ? properties.filter(p => (p.status || 'active') === 'active')
        : [];
      setPropertyCount(activeProperties.length);
    } catch (err) {
      console.error("Erreur lors du chargement des propriétés:", err);
      setPropertyCount(null);
    }
  }, []);

  // Effet pour écouter les événements de rafraîchissement du compteur de propriétés
  useEffect(() => {
    const handleRefreshPropertyCount = () => {
      if (token) {
        fetchPropertyCount(token);
      }
    };

    window.addEventListener('refreshPropertyCount', handleRefreshPropertyCount);

    return () => {
      window.removeEventListener('refreshPropertyCount', handleRefreshPropertyCount);
    };
  }, [token, fetchPropertyCount]);

  // Effet pour vérifier le retour depuis Stripe Checkout
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const sessionId = urlParams.get('session_id');
    const canceled = urlParams.get('canceled');
    
    if (sessionId) {
      // Succès - stocker le session_id et rediriger vers la page de succès
      setCheckoutSessionId(sessionId);
      setCurrentView('checkout-success');
      // Nettoyer l'URL en gardant le pathname mais en supprimant les query params
      const cleanUrl = window.location.pathname || '/';
      window.history.replaceState({}, '', cleanUrl);
    } else if (canceled) {
      // Annulation - rediriger vers la page d'annulation
      setCurrentView('checkout-cancel');
      // Nettoyer l'URL
      const cleanUrl = window.location.pathname || '/';
      window.history.replaceState({}, '', cleanUrl);
    }
  }, []);

  // Charger les notifications et le nombre de propriétés quand l'utilisateur est connecté
  useEffect(() => {
    if (token && userProfile && !userProfile.accessDisabled) {
      fetchNotifications(token);
      fetchPropertyCount(token);
    }
  }, [token, userProfile, fetchNotifications, fetchPropertyCount]);

  // Gestion de la navigation basée sur l'auth
  useEffect(() => {
    if (!isLoading) {
      // Vérifier si l'accès est bloqué
      if (userProfile?.accessDisabled) {
        setCurrentView('access-blocked');
        return;
      }

      if (!token) {
        // Si non connecté, rediriger vers le site externe au lieu de la page de login
        // Mais ne pas rediriger si on est en train de se déconnecter (pour éviter les conflits)
        const isLoggingOut = localStorage.getItem('_isLoggingOut');
        if (!isLoggingOut && currentView !== 'checkout-success' && currentView !== 'checkout-cancel') {
          window.location.href = 'https://priceye-ai.com/';
        }
      } else if (token && (currentView === 'login' || currentView === 'register')) {
        // Si connecté et sur page auth, on va au dashboard
        setCurrentView('dashboard');
      }
    }
  }, [token, isLoading, currentView, userProfile]);

  const handleLoginSuccess = (newToken) => {
    login(newToken);
    setCurrentView('dashboard'); 
  };

  // Fonction pour rafraîchir les notifications
  const handleNotificationsUpdate = useCallback(() => {
    if (token) {
      fetchNotifications(token);
    }
  }, [token, fetchNotifications]);

  const navigateTo = (view) => {
    setCurrentView(view);
  };

  const renderMainContent = () => {
    // Ne rien afficher tant que le profil (et le thème) n'est pas chargé
    if (isLoadingProfile) {
        return <div className="text-center p-10 text-text-muted">Chargement du profil...</div>;
    }
    
    // NOTE: Plus besoin de passer token={token} userProfile={userProfile} 
    // Les pages devront utiliser useAuth() si elles ont besoin de ces données !
    // Pour l'instant, on laisse les props pour compatibilité si vous ne refactorisez pas toutes les pages d'un coup,
    // mais l'objectif est de les retirer.
    
    switch (currentView) {
      case 'dashboard':
        return <DashboardPage token={token} userProfile={userProfile} />;
      case 'pricing':
        return <PricingPage token={token} userProfile={userProfile} />;
      case 'bookings':
        return <BookingsPage token={token} userProfile={userProfile} />;
      case 'settings':
        return <SettingsPage token={token} userProfile={userProfile} onThemeChange={handleThemeChange} onLogout={logout} />;
      case 'report': 
        return <ReportPage token={token} userProfile={userProfile} />;
      case 'checkout-success':
        return <CheckoutSuccessPage 
          token={token}
          sessionId={checkoutSessionId}
          onProfileUpdate={async () => {
            const profile = await getUserProfile(token);
            updateUserProfile(profile);
            return profile; // Retourner le profil pour permettre la vérification
          }}
        />;
      case 'checkout-cancel':
        return <CheckoutCancelPage />;
      case 'access-blocked':
        return <AccessBlockedPage token={token} />;
      default:
        return <DashboardPage token={token} userProfile={userProfile} />; 
    }
  };

  // Gestion de la vue login/register si non authentifié
  // Rediriger vers le site externe au lieu d'afficher la page de login
  if (!token && !isLoadingProfile) {
    if (currentView === 'checkout-success' || currentView === 'checkout-cancel') {
      // Si on vient de Stripe mais pas de token, permettre l'affichage de la page
      return renderMainContent();
    }
    // Rediriger vers le site externe au lieu d'afficher la page de login
    // Ne pas afficher LoginPage ou RegisterPage - redirection immédiate
    return null; // Retourner null pendant la redirection
  }

  return (
    <div className={`min-h-screen bg-transparent text-text-primary transition-colors duration-200 ${isNavCollapsed ? 'md:pl-[96px]' : 'md:pl-[255px]'}`}>
      <NavBar
        currentView={currentView}
        onNavigate={navigateTo}
        isCollapsed={isNavCollapsed}
        onToggleCollapse={() => setIsNavCollapsed((prev) => !prev)}
      />

      <div className="flex flex-col min-h-screen">
        <div className="hidden md:block relative z-[9999]">
          <PageTopBar
            userName={userProfile?.name || userProfile?.email || 'Utilisateur'}
            propertyCount={propertyCount}
            notifications={notifications}
            token={token}
            onNotificationsUpdate={handleNotificationsUpdate}
            onLogout={logout}
            userProfile={userProfile}
          />
        </div>
        <nav className="bg-bg-sidebar md:hidden p-4 flex-shrink-0 flex flex-col rounded-b-3xl border border-border-primary relative z-[9999]">
          <div>
              <h1 className="text-2xl font-bold text-white mb-6">Pricing IA</h1>
              <ul className="space-y-2">
                <li><button onClick={() => navigateTo('dashboard')} className={`w-full text-left block py-2.5 px-4 rounded-xl transition duration-200 hover:bg-global-bg-box ${currentView === 'dashboard' ? 'bg-global-stroke-highlight-2nd/30 text-text-sidebar-active' : 'text-text-sidebar'}`}>Dashboard</button></li>
                <li><button onClick={() => navigateTo('bookings')} className={`w-full text-left block py-2.5 px-4 rounded-xl transition duration-200 hover:bg-global-bg-box ${currentView === 'bookings' ? 'bg-global-stroke-highlight-2nd/30 text-text-sidebar-active' : 'text-text-sidebar'}`}>Réservations</button></li> 
                <li><button onClick={() => navigateTo('report')} className={`w-full text-left block py-2.5 px-4 rounded-xl transition duration-200 hover:bg-global-bg-box ${currentView === 'report' ? 'bg-global-stroke-highlight-2nd/30 text-text-sidebar-active' : 'text-text-sidebar'}`}>Rapports</button></li> 
                <li><button onClick={() => navigateTo('pricing')} className={`w-full text-left block py-2.5 px-4 rounded-xl transition duration-200 hover:bg-global-bg-box ${currentView === 'pricing' ? 'bg-global-stroke-highlight-2nd/30 text-text-sidebar-active' : 'text-text-sidebar'}`}>Calendrier Pricing</button></li>
                <li><button disabled className="w-full text-left block py-2.5 px-4 rounded-xl text-gray-600 cursor-not-allowed bg-gray-800/40 border border-gray-700/60">Concurrents (Bientôt)</button></li>
                <li><button onClick={() => navigateTo('settings')} className={`w-full text-left block py-2.5 px-4 rounded-xl transition duration-200 hover:bg-global-bg-box ${currentView === 'settings' ? 'bg-global-stroke-highlight-2nd/30 text-text-sidebar-active' : 'text-text-sidebar'}`}>Paramètres</button></li> 
              </ul>
          </div>
        </nav>

        <main className="flex-1 p-4 md:p-8 overflow-auto">
          {renderMainContent()}
        </main>
      </div>

      {showApiLoader && (
        <LoadingSpinner
          overlay
          contentAreaLeft={isDesktop ? (isNavCollapsed ? 96 : 255) : 0}
        />
      )}
    </div>
  );
}

function App() {
  return (
    <LanguageProvider userLanguage={localStorage.getItem('userLanguage') || 'fr'}>
      <AuthProvider>
        <AppRouter />
      </AuthProvider>
    </LanguageProvider>
  );
}

export default App;

