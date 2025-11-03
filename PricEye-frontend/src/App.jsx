import React, { useState, useEffect } from 'react';
import LoginPage from './pages/LoginPage.jsx';
import RegisterPage from './pages/RegisterPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import PricingPage from './pages/PricingPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import ReportPage from './pages/ReportPage.jsx'; 
import BookingsPage from './pages/BookingsPage.jsx'; // NOUVELLE PAGE
import { getUserProfile } from './services/api.js'; 

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

  // Gérer le changement de thème
  const handleThemeChange = (newTheme) => {
    setUserProfile(prev => ({ ...prev, theme: newTheme }));
    applyTheme(newTheme);
  };

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
    }
  }, [token]); // Relancé si le token change (ex: connexion)

  const handleLoginSuccess = (newToken) => {
    setToken(newToken); // Déclenchera le useEffect ci-dessus pour charger le profil
    localStorage.setItem('authToken', newToken);
    setCurrentView('dashboard'); 
  };

  const handleLogout = () => {
    setToken(null);
    setUserProfile(null);
    localStorage.removeItem('authToken');
    setCurrentView('login'); 
  };

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
      <div className="flex flex-col md:flex-row min-h-screen bg-bg-primary text-text-primary transition-colors duration-200">
        <nav className="bg-bg-sidebar md:w-64 p-4 md:p-6 flex-shrink-0 flex flex-col">
          <div>
              <h1 className="text-2xl font-bold text-white mb-8">Pricing IA</h1>
              <ul className="space-y-2">
                <li><button onClick={() => navigateTo('dashboard')} className={`w-full text-left block py-2.5 px-4 rounded transition duration-200 hover:bg-gray-700 ${currentView === 'dashboard' ? 'bg-blue-800 text-text-sidebar-active' : 'text-text-sidebar'}`}>Dashboard</button></li>
                <li><button onClick={() => navigateTo('bookings')} className={`w-full text-left block py-2.5 px-4 rounded transition duration-200 hover:bg-gray-700 ${currentView === 'bookings' ? 'bg-blue-800 text-text-sidebar-active' : 'text-text-sidebar'}`}>Réservations</button></li> 
                <li><button onClick={() => navigateTo('report')} className={`w-full text-left block py-2.5 px-4 rounded transition duration-200 hover:bg-gray-700 ${currentView === 'report' ? 'bg-blue-800 text-text-sidebar-active' : 'text-text-sidebar'}`}>Rapports</button></li> 
                <li><button onClick={() => navigateTo('pricing')} className={`w-full text-left block py-2.5 px-4 rounded transition duration-200 hover:bg-gray-700 ${currentView === 'pricing' ? 'bg-blue-800 text-text-sidebar-active' : 'text-text-sidebar'}`}>Calendrier Pricing</button></li>
                 <li><button disabled className={`w-full text-left block py-2.5 px-4 rounded text-gray-600 cursor-not-allowed`}>Concurrents (Bientôt)</button></li>
                 <li><button onClick={() => navigateTo('settings')} className={`w-full text-left block py-2.5 px-4 rounded transition duration-200 hover:bg-gray-700 ${currentView === 'settings' ? 'bg-blue-800 text-text-sidebar-active' : 'text-text-sidebar'}`}>Paramètres</button></li> 
              </ul>
          </div>
          <div className="mt-auto pt-6 border-t border-gray-700">
             <button
                onClick={handleLogout}
                className="w-full px-4 py-2 font-semibold text-white bg-red-600 rounded-md hover:bg-red-700"
              >
                Déconnexion
              </button>
          </div>
        </nav>

        <main className="flex-1 p-4 md:p-8 overflow-auto">
          {renderMainContent()}
        </main>
      </div>
    );
  };

  return renderApp();
}

export default App;

