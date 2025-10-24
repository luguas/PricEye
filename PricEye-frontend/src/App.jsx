import React, { useState, useEffect } from 'react';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import DashboardPage from './pages/DashboardPage';
import PricingPage from './pages/PricingPage';
import SettingsPage from './pages/SettingsPage';
import ReportPage from './pages/ReportPage'; // Importer la nouvelle page Rapport

function App() {
  const [token, setToken] = useState(null);
  // Initialiser sur 'dashboard' si un token existe déjà
  const [currentView, setCurrentView] = useState(localStorage.getItem('authToken') ? 'dashboard' : 'login'); 

  // Essayer de récupérer le token depuis le localStorage au démarrage
  useEffect(() => {
    const storedToken = localStorage.getItem('authToken');
    if (storedToken) {
      setToken(storedToken);
      //setCurrentView('dashboard'); // Déjà fait dans l'initialisation du state
    } else {
        setCurrentView('login'); // S'assurer qu'on est sur login si pas de token
    }
  }, []);

  const handleLoginSuccess = (newToken) => {
    setToken(newToken);
    localStorage.setItem('authToken', newToken);
    setCurrentView('dashboard'); // Rediriger vers le dashboard après connexion
  };

  const handleLogout = () => {
    setToken(null);
    localStorage.removeItem('authToken');
    setCurrentView('login'); // Ramener à la page de connexion après déconnexion
  };

  const navigateTo = (view) => {
    setCurrentView(view);
  };

  // Fonction pour afficher le contenu principal en fonction de l'état
  const renderMainContent = () => {
    switch (currentView) {
      case 'dashboard':
        return <DashboardPage token={token} onLogout={handleLogout} />;
      case 'pricing':
        return <PricingPage token={token} />;
      case 'settings': 
        return <SettingsPage token={token} />;
      case 'report': // Ajouter le cas pour la page Rapport
        return <ReportPage token={token} />;
      // Ajouter d'autres cas pour les futures pages (concurrents...)
      default:
        // Si aucune vue ne correspond, on retourne au dashboard si connecté
        return <DashboardPage token={token} onLogout={handleLogout} />; 
    }
  };

  // Fonction pour afficher l'interface de connexion/inscription ou l'application principale
  const renderApp = () => {
    if (!token) {
      if (currentView === 'register') {
        return <RegisterPage onNavigate={navigateTo} />;
      }
      return <LoginPage onLoginSuccess={handleLoginSuccess} onNavigate={navigateTo} />;
    }

    // Si l'utilisateur est connecté, afficher la sidebar et le contenu principal
    return (
      <div className="flex flex-col md:flex-row min-h-screen bg-gray-900 text-white">
        {/* Sidebar Navigation */}
        <nav className="bg-gray-800 md:w-64 p-4 md:p-6 flex-shrink-0 flex flex-col">
          <div>
              <h1 className="text-2xl font-bold text-white mb-8">Pricing IA</h1>
              <ul className="space-y-2">
                {/* Utilisation de classes conditionnelles pour l'état actif */}
                <li><button onClick={() => navigateTo('dashboard')} className={`w-full text-left block py-2.5 px-4 rounded transition duration-200 hover:bg-gray-700 ${currentView === 'dashboard' ? 'bg-blue-800 text-white' : 'text-gray-400'}`}>Dashboard</button></li>
                <li><button onClick={() => navigateTo('report')} className={`w-full text-left block py-2.5 px-4 rounded transition duration-200 hover:bg-gray-700 ${currentView === 'report' ? 'bg-blue-800 text-white' : 'text-gray-400'}`}>Rapports</button></li> {/* Lien vers Rapports */}
                <li><button onClick={() => navigateTo('pricing')} className={`w-full text-left block py-2.5 px-4 rounded transition duration-200 hover:bg-gray-700 ${currentView === 'pricing' ? 'bg-blue-800 text-white' : 'text-gray-400'}`}>Calendrier Pricing</button></li>
                 <li><button disabled className={`w-full text-left block py-2.5 px-4 rounded text-gray-600 cursor-not-allowed`}>Concurrents (Bientôt)</button></li>
                 <li><button onClick={() => navigateTo('settings')} className={`w-full text-left block py-2.5 px-4 rounded transition duration-200 hover:bg-gray-700 ${currentView === 'settings' ? 'bg-blue-800 text-white' : 'text-gray-400'}`}>Paramètres</button></li> 
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

        {/* Main Content Area */}
        <main className="flex-1 p-4 md:p-8 overflow-auto">
          {renderMainContent()}
        </main>
      </div>
    );
  };

  return renderApp();
}

export default App;

