import React, { useState, useEffect, useCallback } from 'react';
import LoginPage from './pages/LoginPage.jsx';
import RegisterPage from './pages/RegisterPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import PricingPage from './pages/PricingPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import ReportPage from './pages/ReportPage.jsx'; 
import BookingsPage from './pages/BookingsPage.jsx'; // NOUVELLE PAGE
import CheckoutSuccessPage from './pages/CheckoutSuccessPage.jsx';
import CheckoutCancelPage from './pages/CheckoutCancelPage.jsx';
import AccessBlockedPage from './pages/AccessBlockedPage.jsx';
import { getUserProfile, getGroupRecommendations, getProperties } from './services/api.js'; 
import NavBar from './components/NavBar.jsx';
import PageTopBar from './components/PageTopBar.jsx';
import { LanguageProvider, useLanguage } from './contexts/LanguageContext.jsx';

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

function AppContent() {
  const [token, setToken] = useState(null);
  const [currentView, setCurrentView] = useState(localStorage.getItem('authToken') ? 'dashboard' : 'login'); 
  const [userProfile, setUserProfile] = useState(null); 
  const [isLoadingProfile, setIsLoadingProfile] = useState(true);
  const [isNavCollapsed, setIsNavCollapsed] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [isLoadingNotifications, setIsLoadingNotifications] = useState(false);
  const [propertyCount, setPropertyCount] = useState(null);
  const [isInitialLoad, setIsInitialLoad] = useState(true);

  // Gérer le changement de thème
  const handleThemeChange = (newTheme) => {
    setUserProfile(prev => ({ ...prev, theme: newTheme }));
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
      setPropertyCount(Array.isArray(properties) ? properties.length : 0);
    } catch (err) {
      console.error("Erreur lors du chargement des propriétés:", err);
      setPropertyCount(null);
    }
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      // Déconnecter de Supabase
      const { supabase } = await import('./config/supabase.js');
      await supabase.auth.signOut();
    } catch (error) {
      console.error('Erreur lors de la déconnexion Supabase:', error);
      // Continuer même si la déconnexion Supabase échoue
    }
    
    // Nettoyer tous les éléments du localStorage liés à l'auth AVANT de nettoyer l'état
    localStorage.removeItem('authToken');
    
    // Nettoyer toutes les clés Supabase du localStorage
    Object.keys(localStorage).forEach(key => {
      if (key.startsWith('sb-')) {
        localStorage.removeItem(key);
      }
    });
    
    // Nettoyer l'état local
    setToken(null);
    setUserProfile(null);
    setNotifications([]);
    setPropertyCount(null);
    
    // Forcer la redirection vers login
    setCurrentView('login');
    
    // Forcer un rechargement complet pour s'assurer que tout est nettoyé
    // Utiliser replaceState pour éviter de garder l'historique
    window.history.replaceState({}, '', '/');
    
    // Attendre un peu pour que le nettoyage soit effectué avant le rechargement
    setTimeout(() => {
      window.location.href = '/';
    }, 100);
  }, []);

  // Effet pour écouter les événements d'expiration de token
  useEffect(() => {
    const handleTokenExpired = () => {
      handleLogout();
    };

    window.addEventListener('tokenExpired', handleTokenExpired);

    return () => {
      window.removeEventListener('tokenExpired', handleTokenExpired);
    };
  }, [handleLogout]);

  // Effet pour vérifier le retour depuis Stripe Checkout
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const sessionId = urlParams.get('session_id');
    const canceled = urlParams.get('canceled');
    
    if (sessionId) {
      // Succès - rediriger vers la page de succès
      setCurrentView('checkout-success');
      // Nettoyer l'URL
      window.history.replaceState({}, '', window.location.pathname);
    } else if (canceled) {
      // Annulation - rediriger vers la page d'annulation
      setCurrentView('checkout-cancel');
      // Nettoyer l'URL
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  // Effet pour le chargement initial (une seule fois)
  useEffect(() => {
    if (!isInitialLoad) return;
    
    const storedToken = localStorage.getItem('authToken');
    if (storedToken) {
      // Vérifier que le token est valide avant de l'utiliser
      try {
        const { jwtDecode } = require('jwt-decode');
        jwtDecode(storedToken); // Vérifier que le token est valide
        setToken(storedToken);
        // Définir dashboard seulement au premier chargement
        if (currentView === 'login' || currentView === 'register') {
          setCurrentView('dashboard');
        }
      } catch (e) {
        // Token invalide, nettoyer et rediriger vers login
        console.error('Token invalide au chargement:', e);
        localStorage.removeItem('authToken');
        setCurrentView('login');
      }
    } else {
      setCurrentView('login');
    }
    setIsInitialLoad(false);
  }, [isInitialLoad, currentView]);

  // Effet pour charger le profil quand le token change
  useEffect(() => {
    if (!token) {
      setIsLoadingProfile(false);
      applyTheme('auto');
      setNotifications([]);
      return;
    }

    setIsLoadingProfile(true);
    
    // Charger le profil utilisateur pour récupérer le thème
    getUserProfile(token)
      .then(profile => {
        setUserProfile(profile);
        
        // Vérifier si l'accès est désactivé (kill-switch)
        if (profile.accessDisabled) {
          setCurrentView('access-blocked');
          setIsLoadingProfile(false);
          return;
        }
        
        applyTheme(profile.theme || 'auto'); // Appliquer le thème sauvegardé
        // Mettre à jour la langue dans localStorage et déclencher l'événement
        if (profile.language) {
          localStorage.setItem('userLanguage', profile.language);
          if (typeof window !== 'undefined') {
            try {
              window.dispatchEvent(new CustomEvent('languageChanged', { detail: { language: profile.language } }));
            } catch (error) {
              console.error('Erreur lors de l\'envoi de l\'événement languageChanged:', error);
            }
          }
        }
        // Charger les notifications et le nombre de propriétés après le profil
        fetchNotifications(token);
        fetchPropertyCount(token);
      })
      .catch(err => {
        console.error("Erreur de chargement du profil:", err);
        // Si le token est invalide (ex: 403), déconnecter l'utilisateur
        if (err.message.includes('403') || err.message.includes('401') || err.message.includes('Jeton invalide') || err.message.includes('Jeton manquant')) {
           handleLogout();
        }
      })
      .finally(() => setIsLoadingProfile(false));
  }, [token, fetchNotifications, fetchPropertyCount, handleLogout]);

  const handleLoginSuccess = (newToken) => {
    setToken(newToken); // Déclenchera le useEffect ci-dessus pour charger le profil
    localStorage.setItem('authToken', newToken);
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
    
    // Passer le profil et le gestionnaire de thème aux pages qui en ont besoin
    switch (currentView) {
      case 'dashboard':
        return <DashboardPage token={token} userProfile={userProfile} />;
      case 'pricing':
        return <PricingPage token={token} userProfile={userProfile} />;
      case 'bookings': // NOUVELLE VUE
        return <BookingsPage token={token} userProfile={userProfile} />;
      case 'settings':
        return <SettingsPage token={token} userProfile={userProfile} onThemeChange={handleThemeChange} onLogout={handleLogout} />;
      case 'report': 
        return <ReportPage token={token} userProfile={userProfile} />;
      case 'checkout-success':
        return <CheckoutSuccessPage 
          token={token}
          onProfileUpdate={async () => {
            const profile = await getUserProfile(token);
            setUserProfile(profile);
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

  const renderApp = () => {
    if (!token && !isLoadingProfile) {
      if (currentView === 'register') {
        return <RegisterPage onNavigate={navigateTo} />;
      }
      return <LoginPage onLoginSuccess={handleLoginSuccess} onNavigate={navigateTo} />;
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
          <div className="hidden md:block">
            <PageTopBar
              userName={userProfile?.name || userProfile?.email || 'Utilisateur'}
              propertyCount={propertyCount}
              notifications={notifications}
              token={token}
              onNotificationsUpdate={handleNotificationsUpdate}
              onLogout={handleLogout}
            />
          </div>
          <nav className="bg-bg-sidebar md:hidden p-4 flex-shrink-0 flex flex-col rounded-b-3xl border border-border-primary">
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
      </div>
    );
  };

  return renderApp();
}

function App() {
  return (
    <LanguageProvider userLanguage={localStorage.getItem('userLanguage') || 'fr'}>
      <AppContent />
    </LanguageProvider>
  );
}

export default App;

