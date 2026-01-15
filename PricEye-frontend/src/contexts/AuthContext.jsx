import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { jwtDecode } from 'jwt-decode';
import { supabase } from '../config/supabase';
import { getUserProfile } from '../services/api';
import { setApiToken } from '../services/api'; // Nous créerons cette fonction à l'étape 3

const AuthContext = createContext(null);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth doit être utilisé à l'intérieur d'un AuthProvider");
  }
  return context;
};

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

export const AuthProvider = ({ children }) => {
  const [token, setToken] = useState(() => localStorage.getItem('authToken'));
  const [userProfile, setUserProfile] = useState(null);
  const [isLoading, setIsLoading] = useState(true); // Chargement global (token check)
  const [isLoadingProfile, setIsLoadingProfile] = useState(false); // Chargement spécifique profil

  // Centralisation de la déconnexion
  const logout = useCallback(async () => {
    try {
      await supabase.auth.signOut();
    } catch (error) {
      console.error('Erreur déconnexion Supabase:', error);
    }
    
    setToken(null);
    setUserProfile(null);
    localStorage.removeItem('authToken');
    setApiToken(null); // Nettoyer le token dans le service API
    
    // Nettoyage complet du storage (sauf préférences peut-être)
    Object.keys(localStorage).forEach(key => {
      if (key.startsWith('sb-') || key === 'authToken') {
        localStorage.removeItem(key);
      }
    });

    // Redirection forcée si nécessaire
    if (window.location.pathname !== '/' && window.location.pathname !== '/login') {
      // Attendre un peu pour que le nettoyage soit effectué avant le rechargement
      setTimeout(() => {
        window.location.href = 'https://priceye-ai.com/';
      }, 100);
    }
  }, []);

  const login = useCallback((newToken) => {
    localStorage.setItem('authToken', newToken);
    setToken(newToken);
    setApiToken(newToken); // Mise à jour immédiate du service API
  }, []);

  // Synchronisation initiale et écoute Supabase
  useEffect(() => {
    // Initialiser le token API au démarrage
    if (token) setApiToken(token);

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_OUT') {
        logout();
      } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        if (session?.access_token) {
          login(session.access_token);
        }
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [login, logout, token]);

  // Effet pour gérer le token depuis un site externe (URL)
  useEffect(() => {
    // Vérifier si un token vient d'un site externe dans l'URL
    const urlParams = new URLSearchParams(window.location.search);
    const externalToken = urlParams.get('token');
    
    // Vérifier aussi le hash (ex: #access_token=... ou #token=...)
    const hashParams = new URLSearchParams(window.location.hash.substring(1));
    const hashToken = hashParams.get('token') || hashParams.get('access_token');
    
    const tokenFromUrl = externalToken || hashToken;
    
    if (tokenFromUrl && !token) {
      try {
        // Valider le token JWT
        const decoded = jwtDecode(tokenFromUrl);
        
        // Vérifier que le token n'est pas expiré
        if (decoded.exp && decoded.exp * 1000 < Date.now()) {
          console.error('Token expiré depuis site externe');
          // Nettoyer l'URL
          const cleanUrl = window.location.pathname || '/';
          window.history.replaceState({}, '', cleanUrl);
          return;
        }
        
        // Token valide : le stocker et connecter l'utilisateur
        login(tokenFromUrl);
        
        // Nettoyer l'URL
        const cleanUrl = window.location.pathname || '/';
        window.history.replaceState({}, '', cleanUrl);
      } catch (e) {
        console.error('Token invalide depuis site externe:', e);
        // Nettoyer l'URL
        const cleanUrl = window.location.pathname || '/';
        window.history.replaceState({}, '', cleanUrl);
      }
    }
  }, [token, login]);

  // Effet pour écouter les événements d'expiration de token
  useEffect(() => {
    const handleTokenExpired = () => {
      logout();
    };

    window.addEventListener('tokenExpired', handleTokenExpired);

    return () => {
      window.removeEventListener('tokenExpired', handleTokenExpired);
    };
  }, [logout]);

  // Chargement du profil utilisateur quand le token change
  useEffect(() => {
    if (!token) {
      setUserProfile(null);
      setIsLoading(false);
      applyTheme('auto');
      return;
    }

    const fetchProfile = async () => {
      setIsLoadingProfile(true);
      try {
        // Note: getUserProfile utilise maintenant le token global via setApiToken
        // Mais pour la rétrocompatibilité, on peut toujours passer le token
        const profile = await getUserProfile(token);
        
        if (profile.accessDisabled) {
          throw new Error("ACCESS_BLOCKED");
        }
        
        setUserProfile(profile);
        
        // Gestion du thème via le profil
        if (profile.theme) {
          applyTheme(profile.theme);
        }
        
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
        
      } catch (err) {
        console.error("Erreur chargement profil:", err);
        if (err.message === "ACCESS_BLOCKED" || err.message.includes('401') || err.message.includes('403')) {
          logout();
        }
      } finally {
        setIsLoadingProfile(false);
        setIsLoading(false);
      }
    };

    fetchProfile();
  }, [token, logout]);

  const value = {
    token,
    userProfile,
    isAuthenticated: !!token,
    isLoading, // Chargement initial
    isLoadingProfile, // Rechargement de données
    login,
    logout,
    updateUserProfile: setUserProfile // Pour mises à jour optimistes
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
