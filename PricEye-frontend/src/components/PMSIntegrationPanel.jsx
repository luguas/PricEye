import React, { useState, useEffect } from 'react';
// Importer les fonctions API nécessaires
import { testConnection, connectPMS, disconnectPMS } from '../services/api.js'; 
import PropertySyncModal from './PropertySyncModal.jsx';
import ConfirmModal from './ConfirmModal.jsx';
import { useLanguage } from '../contexts/LanguageContext.jsx'; 

// Configuration pour chaque PMS géré (les labels seront traduits dynamiquement)
const getPMSConfig = (t) => ({
  smoobu: { 
    name: 'Smoobu', 
    type: 'apikey', 
    fields: [
      { name: 'token', labelKey: 'settings.integration.fields.smoobuToken', type: 'password' }
    ] 
  },
  beds24: { 
    name: 'Beds24', 
    type: 'apikey', 
    fields: [
      { name: 'apiKey', labelKey: 'settings.integration.fields.beds24ApiKey', type: 'password' },
      { name: 'propKey', labelKey: 'settings.integration.fields.beds24PropKey', type: 'password' }
    ] 
  },
  cloudbeds: { 
    name: 'Cloudbeds', 
    type: 'oauth', 
    fields: [] 
  },
  // ... Ajoutez d'autres PMS ici
});

/**
 * @param {object} props
 * @param {string} props.token - Jeton d'authentification de l'utilisateur Priceye
 * @param {object | null} props.currentIntegration - L'intégration active (ex: { type: 'smoobu', ... }) ou null
 * @param {Function} props.onConnectionUpdate - Fonction pour rafraîchir le profil utilisateur parent
 */
function PMSIntegrationPanel({ token, currentIntegration, onConnectionUpdate }) {
  const { t } = useLanguage();
  const [selectedPms, setSelectedPms] = useState('smoobu');
  const [credentials, setCredentials] = useState({});
  
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);
  
  const [testMessage, setTestMessage] = useState({ type: '', text: '' });
  const [connectMessage, setConnectMessage] = useState({ type: '', text: '' });
  // Les états isSyncing et syncMessage sont maintenant gérés par la modale

  // État pour la modale de confirmation
  const [confirmModal, setConfirmModal] = useState({ isOpen: false, message: '', onConfirm: null });
  
  const PMS_CONFIG = getPMSConfig(t);

  // Met à jour le formulaire si une intégration existe déjà
  useEffect(() => {
    if (currentIntegration) {
      setSelectedPms(currentIntegration.type);
      setCredentials(currentIntegration.credentials || {});
    }
  }, [currentIntegration]);

  const handleCredentialChange = (field, value) => {
    setCredentials(prev => ({ ...prev, [field]: value }));
    // Réinitialiser les messages de test/connexion lors de la saisie
    setTestMessage({ type: '', text: '' });
    setConnectMessage({ type: '', text: '' });
  };
  
  const handlePmsSelect = (e) => {
      setSelectedPms(e.target.value);
      setCredentials({}); // Réinitialiser les identifiants lors du changement
      setTestMessage({ type: '', text: '' });
      setConnectMessage({ type: '', text: '' });
  };

  // 1. Tester la connexion
  const handleTest = async () => {
    setIsLoading(true);
    setTestMessage({ type: 'loading', text: t('settings.integration.testInProgress') });
    setConnectMessage({ type: '', text: '' });
    try {
      const result = await testConnection(selectedPms, credentials, token);
      setTestMessage({ type: 'success', text: result.message || t('settings.integration.connectionSuccess') });
    } catch (error) {
      setTestMessage({ type: 'error', text: `${t('settings.integration.testFailed')}: ${error.message}` });
    } finally {
      setIsLoading(false);
    }
  };

  // 2. Connecter (Sauvegarder les identifiants)
  const handleConnect = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setConnectMessage({ type: 'loading', text: t('settings.integration.saving') });
    setTestMessage({ type: '', text: '' });
    try {
      const result = await connectPMS(selectedPms, credentials, token);
      setConnectMessage({ type: 'success', text: result.message });
      onConnectionUpdate(); // Rafraîchit la page Paramètres
    } catch (error) {
      setConnectMessage({ type: 'error', text: `${t('settings.integration.connectionFailed')}: ${error.message}` });
    } finally {
      setIsLoading(false);
    }
  };

  // 3. La logique de synchronisation (handleSync) est maintenant dans la modale.
  // Le bouton 'Synchroniser' va juste ouvrir la modale.

  // Logique pour déconnecter (vide les infos dans Firestore)
  const handleDisconnect = async () => {
    setConfirmModal({
      isOpen: true,
      message: `${t('settings.integration.disconnectConfirm')} ${currentIntegration.type} ?`,
      onConfirm: async () => {
        setIsLoading(true);
        setConnectMessage({ type: 'loading', text: t('settings.integration.disconnecting') });
        try {
          // CORRECTION: Appeler la nouvelle route DELETE au lieu de connectPMS
          await disconnectPMS(currentIntegration.type, token); 
          setConnectMessage({ type: 'success', text: t('settings.integration.disconnectSuccess') });
          setCredentials({});
          onConnectionUpdate(); // Rafraîchit la page
        } catch (error) {
          setConnectMessage({ type: 'error', text: `${t('settings.integration.disconnectFailed')}: ${error.message}` });
        } finally {
          setIsLoading(false);
        }
      }
    });
  };

  const renderCurrentIntegration = () => {
    if (!currentIntegration) {
      return <p className="text-sm text-text-muted">{t('settings.integration.notConnected')}</p>;
    }
    return (
      <div className="space-y-4">
        <p className="text-sm text-green-400">
          {t('settings.integration.connected')} <span className="font-bold">{PMS_CONFIG[currentIntegration.type]?.name || currentIntegration.type}</span>
        </p>
        <button
          type="button"
          onClick={() => setIsSyncModalOpen(true)} // 3. Ouvre la modale
          disabled={isLoading} // n'est désactivé que si la connexion/déconnexion est en cours
          className="w-full px-4 py-2 font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:bg-gray-500"
        >
          {t('settings.integration.synchronizeProperties')}
        </button>
        {/* Le message de synchronisation est maintenant dans la modale */}
        <button
          type="button"
          onClick={handleDisconnect}
          disabled={isLoading}
          className="w-full text-sm text-red-400 hover:text-red-300 disabled:text-gray-500"
        >
          {t('settings.integration.disconnect')}
        </button>
      </div>
    );
  };
  
  const renderConnectionForm = () => {
    const config = PMS_CONFIG[selectedPms];
    
    return (
      <form onSubmit={handleConnect} className="space-y-4">
        <div>
          <label htmlFor="pms-select" className="block text-sm font-medium text-text-secondary">
            {t('settings.integration.choosePMS')}
          </label>
          <select 
            id="pms-select"
            value={selectedPms} 
            onChange={handlePmsSelect}
            className="w-full form-input mt-1"
          >
            <option value="smoobu">Smoobu</option>
            <option value="beds24">Beds24</option>
            <option value="cloudbeds">Cloudbeds</option>
          </select>
        </div>
        
        {config.type === 'apikey' && config.fields.map(field => (
           <div key={field.name}>
             <label htmlFor={field.name} className="block text-sm font-medium text-text-secondary">
               {t(field.labelKey)}
             </label>
             <input
               type={field.type || 'text'}
               id={field.name}
               value={credentials[field.name] || ''}
               onChange={(e) => handleCredentialChange(field.name, e.target.value)}
               className="w-full form-input mt-1"
               required
             />
           </div>
        ))}
        
        {config.type === 'oauth' && (
            <button 
                type="button" 
                className="w-full px-4 py-2 font-semibold text-white bg-gray-600 rounded-md hover:bg-gray-700"
                onClick={() => setConnectMessage({ type: 'error', text: t('settings.integration.oauthNotImplemented')})}
            >
                {t('settings.integration.connectWith')} {config.name}
            </button>
        )}
        
        {config.type === 'apikey' && (
            <div className="flex gap-4">
                 <button 
                    type="button" 
                    onClick={handleTest}
                    disabled={isLoading}
                    className="flex-1 px-4 py-2 font-semibold text-text-primary bg-bg-muted rounded-md hover:bg-border-primary disabled:opacity-50"
                 >
                    {isLoading && testMessage.text ? '...' : t('settings.integration.test')}
                  </button>
                  <button 
                    type="submit" 
                    disabled={isLoading}
                    className="flex-1 px-4 py-2 font-semibold text-white bg-green-600 rounded-md hover:bg-green-700 disabled:bg-gray-500"
                  >
                    {isLoading && connectMessage.text ? '...' : t('settings.integration.connect')}
                  </button>
            </div>
        )}
        
        {testMessage.text && (
          <p className={`text-sm ${testMessage.type === 'error' ? 'text-red-400' : 'text-green-400'}`}>
            {testMessage.text}
          </p>
        )}
        {connectMessage.text && (
          <p className={`text-sm ${connectMessage.type === 'error' ? 'text-red-400' : 'text-green-400'}`}>
            {connectMessage.text}
          </p>
        )}
      </form>
    );
  };

  return (
    <>
      <fieldset className="border border-border-secondary p-4 rounded-md">
        <legend className="text-lg font-semibold px-2 text-text-primary">{t('settings.integration.title')}</legend>
        <div className="mt-2">
          {currentIntegration ? renderCurrentIntegration() : renderConnectionForm()}
        </div>
      </fieldset>
      
      {/* 4. Afficher la modale si elle est ouverte */}
      {isSyncModalOpen && (
        <PropertySyncModal
          token={token}
          pmsType={currentIntegration?.type}
          onClose={(needsRefresh) => {
            setIsSyncModalOpen(false);
            if (needsRefresh) {
              onConnectionUpdate(); // Rafraîchit la page Paramètres/Dashboard
            }
          }}
        />
      )}

      {/* Modale de confirmation */}
      <ConfirmModal
        isOpen={confirmModal.isOpen}
        onClose={() => setConfirmModal({ isOpen: false, message: '', onConfirm: null })}
        onConfirm={confirmModal.onConfirm || (() => {})}
        title={t('common.confirm')}
        message={confirmModal.message}
        confirmText={t('common.confirm')}
        cancelText={t('common.cancel')}
      />
    </>
  );
}

export default PMSIntegrationPanel;

