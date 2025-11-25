import React, { useState, useEffect, useCallback } from 'react';
import LoginPage from './pages/LoginPage.jsx';
import RegisterPage from './pages/RegisterPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import PricingPage from './pages/PricingPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import ReportPage from './pages/ReportPage.jsx'; 
import BookingsPage from './pages/BookingsPage.jsx'; // NOUVELLE PAGE
import { getUserProfile, getGroupRecommendations } from './services/api.js'; 
import NavBar from './components/NavBar.jsx';
import PageTopBar from './components/PageTopBar.jsx';

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

function App() {
  const [token, setToken] = useState(null);
  const [currentView, setCurrentView] = useState(localStorage.getItem('authToken') ? 'dashboard' : 'login'); 
  const [userProfile, setUserProfile] = useState(null); 
  const [isLoadingProfile, setIsLoadingProfile] = useState(true);
  const [isNavCollapsed, setIsNavCollapsed] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [isLoadingNotifications, setIsLoadingNotifications] = useState(false);

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

  const handleLogout = useCallback(() => {
    setToken(null);
    setUserProfile(null);
    setNotifications([]);
    localStorage.removeItem('authToken');
    setCurrentView('login'); 
  }, []);

  // Effet pour charger le token et le profil au démarrage
  useEffect(() => {
    const storedToken = localStorage.getItem('authToken');
    if (storedToken) {
      setToken(storedToken);
      setCurrentView('dashboard');
      
      // Charger le profil utilisateur pour récupérer le thème
      getUserProfile(storedToken)
        .then(profile => {
          setUserProfile(profile);
          applyTheme(profile.theme || 'auto'); // Appliquer le thème sauvegardé
          // Charger les notifications après le profil
          fetchNotifications(storedToken);
        })
        .catch(err => {
          console.error("Erreur de chargement du profil:", err);
          // Si le token est invalide (ex: 403), déconnecter l'utilisateur
          if (err.message.includes('403') || err.message.includes('401')) {
             handleLogout();
          }
        })
        .finally(() => setIsLoadingProfile(false));
        
    } else {
      setCurrentView('login');
      setIsLoadingProfile(false);
      applyTheme('auto'); // Appliquer le thème système par défaut si déconnecté
      setNotifications([]);
    }
  }, [token, fetchNotifications, handleLogout]); // Relancé si le token change (ex: connexion)

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
        return <SettingsPage token={token} userProfile={userProfile} onThemeChange={handleThemeChange} />;
      case 'report': 
        return <ReportPage token={token} userProfile={userProfile} />;
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
          onLogout={handleLogout}
          isCollapsed={isNavCollapsed}
          onToggleCollapse={() => setIsNavCollapsed((prev) => !prev)}
        />

        <div className="flex flex-col min-h-screen">
          <div className="hidden md:block">
            <PageTopBar
              userName={userProfile?.name || userProfile?.email || 'Utilisateur'}
              propertyCount={userProfile?.stats?.propertyCount}
              notifications={notifications}
              token={token}
              onNotificationsUpdate={handleNotificationsUpdate}
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
            <div className="mt-6 pt-6 border-t border-border-primary">
               <button
                  onClick={handleLogout}
                  className="w-full px-4 py-2.5 font-semibold text-white bg-red-600 rounded-xl hover:bg-red-700"
                >
                  Déconnexion
                </button>
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

export default App;

