import React, { createContext, useContext, useState, useEffect } from 'react';

const LanguageContext = createContext();

export const useLanguage = () => {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
};

export const LanguageProvider = ({ children, userLanguage = 'fr' }) => {
  const [language, setLanguage] = useState(userLanguage);
  const [translations, setTranslations] = useState({});

  useEffect(() => {
    setLanguage(userLanguage);
  }, [userLanguage]);

  // Écouter les changements de langue depuis SettingsPage
  useEffect(() => {
    const handleLanguageChange = (event) => {
      setLanguage(event.detail.language);
    };

    window.addEventListener('languageChanged', handleLanguageChange);
    return () => {
      window.removeEventListener('languageChanged', handleLanguageChange);
    };
  }, []);

  useEffect(() => {
    // Charger les traductions depuis les fichiers JSON
    const loadTranslations = async () => {
      try {
        const response = await fetch(`/locales/${language}/translation.json`);
        const data = await response.json();
        setTranslations(data);
      } catch (error) {
        console.error(`Erreur lors du chargement des traductions pour ${language}:`, error);
        // Fallback sur le français en cas d'erreur
        if (language !== 'fr') {
          try {
            const fallbackResponse = await fetch('/locales/fr/translation.json');
            const fallbackData = await fallbackResponse.json();
            setTranslations(fallbackData);
          } catch (fallbackError) {
            console.error('Erreur lors du chargement des traductions de secours:', fallbackError);
          }
        }
      }
    };

    loadTranslations();
  }, [language]);

  const t = (key, params = {}) => {
    const keys = key.split('.');
    let value = translations;
    
    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k];
      } else {
        // Si la clé n'existe pas, retourner la clé elle-même
        return key;
      }
    }

    // Remplacer les paramètres dans la chaîne
    if (typeof value === 'string' && Object.keys(params).length > 0) {
      return value.replace(/\{\{(\w+)\}\}/g, (match, paramKey) => {
        return params[paramKey] !== undefined ? params[paramKey] : match;
      });
    }

    return typeof value === 'string' ? value : key;
  };

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
};

