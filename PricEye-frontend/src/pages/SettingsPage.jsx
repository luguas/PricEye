import React, { useState, useEffect, useCallback } from 'react';
import { 
    getUserProfile, 
    updateUserProfile, 
    getTeamMembers, 
    inviteMember, 
    updateMemberRole, 
    removeMember,
    changeUserPassword,
    getIntegrations, // NOUVEL IMPORT
    deleteUserAccount // NOUVEL IMPORT
} from '../services/api.js'; 
import { jwtDecode } from 'jwt-decode'; 
import PMSIntegrationPanel from '../components/PMSIntegrationPanel.jsx'; // NOUVEL IMPORT
import BillingPanel from '../components/BillingPanel.jsx'; // NOUVEL IMPORT
import ConfirmModal from '../components/ConfirmModal.jsx';
import { useLanguage } from '../contexts/LanguageContext.jsx';

function SettingsPage({ token, userProfile: initialProfile, onThemeChange, onLogout }) {
  const { t, language: currentLanguage } = useLanguage();
  const [profile, setProfile] = useState({
    name: '',
    email: '',
    currency: 'EUR',
    language: currentLanguage || 'fr',
    timezone: 'Europe/Paris',
    theme: 'auto',
    notificationPreferences: {
      notifyOnBooking: true,
      notifyOnApiError: true,
    },
    reportFrequency: 'hebdomadaire',
    role: 'member', 
  });
  
  // État pour l'intégration
  const [currentIntegration, setCurrentIntegration] = useState(null);
  const [isIntegrationLoading, setIsIntegrationLoading] = useState(true);

  // États pour la gestion d'équipe
  const [teamMembers, setTeamMembers] = useState([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');

  // États pour le changement de mot de passe
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState('');

  // États pour la suppression de compte
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [deleteAccountError, setDeleteAccountError] = useState('');

  // États de chargement et de messagerie
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState(''); 
  const [profileError, setProfileError] = useState(''); 
  const [successMessage, setSuccessMessage] = useState('');
  const [teamError, setTeamError] = useState('');
  const [inviteSuccess, setInviteSuccess] = useState('');
  
  const [validationErrors, setValidationErrors] = useState({});

  // États pour les modales
  const [confirmModal, setConfirmModal] = useState({ isOpen: false, message: '', onConfirm: null });

  // Vérifier le token et rediriger si nécessaire
  useEffect(() => {
      if (!token && onLogout) {
          // Si pas de token, rediriger immédiatement
          onLogout();
          return;
      }
      
      if (token) {
          try {
              const decodedToken = jwtDecode(token);
              // Si le token est valide, on continue
          } catch (e) {
              console.error("Erreur de décodage du token:", e);
              // Si erreur de décodage, nettoyer et rediriger
              if (onLogout) {
                  onLogout();
              }
          }
      }
  }, [token, onLogout]);

  let currentUserId = null;
  try {
      if (token) {
          const decodedToken = jwtDecode(token);
          // Supabase utilise 'sub' comme identifiant utilisateur dans le JWT
          currentUserId = decodedToken?.sub || decodedToken?.user_id || decodedToken?.uid; 
      }
  } catch (e) {
      console.error("Erreur de décodage du token:", e);
      // L'erreur sera gérée par le useEffect ci-dessus
  }


  // Fonction pour rafraîchir le profil (utilisée par BillingPanel)
  const handleProfileRefresh = useCallback(async () => {
    try {
      const updatedProfile = await getUserProfile(token);
      setProfile({
        ...updatedProfile,
        language: updatedProfile.language || currentLanguage || 'fr',
        notificationPreferences: updatedProfile.notificationPreferences || { notifyOnBooking: true, notifyOnApiError: true },
        reportFrequency: updatedProfile.reportFrequency || 'hebdomadaire',
        theme: updatedProfile.theme || 'auto',
        role: updatedProfile.role || 'member'
      });
    } catch (err) {
      console.error('Erreur lors du rafraîchissement du profil:', err);
    }
  }, [token, currentLanguage]);

  const fetchProfileAndTeam = useCallback(async () => {
    if (!currentUserId) {
        setIsLoading(false);
        return;
    }
    try {
      setIsLoading(true);
      setIsIntegrationLoading(true); // Commencer le chargement
      setError('');
      setTeamError('');
      
      // 1. Profil (déjà passé en prop)
      if (initialProfile) {
           setProfile({
                ...initialProfile,
                language: initialProfile.language || currentLanguage || 'fr',
                notificationPreferences: initialProfile.notificationPreferences || { notifyOnBooking: true, notifyOnApiError: true },
                reportFrequency: initialProfile.reportFrequency || 'hebdomadaire',
                theme: initialProfile.theme || 'auto',
                role: initialProfile.role || 'member' 
            });
      }
      
      // 2. Intégration (NOUVEL APPEL)
      try {
        const integrationData = await getIntegrations(token);
        setCurrentIntegration(integrationData); // Peut être null
      } catch (integrationError) {
         console.error("Erreur de chargement de l'intégration:", integrationError);
         setError(t('settings.errors.integrationLoadError'));
      } finally {
         setIsIntegrationLoading(false);
      }

      // 3. Membres de l'équipe
      if (initialProfile?.role === 'admin') {
          const membersData = await getTeamMembers(token);
          setTeamMembers(membersData);
      }
      
    } catch (err) {
      setError(t('settings.errors.loadError', { message: err.message }));
    } finally {
      setIsLoading(false);
    }
  }, [token, currentUserId, initialProfile]); 

  useEffect(() => {
    fetchProfileAndTeam();
  }, [fetchProfileAndTeam]);

  // Synchroniser la langue du profil avec la langue actuelle du contexte
  useEffect(() => {
    if (currentLanguage) {
      setProfile(prev => {
        // Ne mettre à jour que si la langue a vraiment changé
        if (prev.language !== currentLanguage) {
          return { ...prev, language: currentLanguage };
        }
        return prev;
      });
    }
  }, [currentLanguage]);

  // Fonction de validation du profil
  const validateProfile = () => {
      const newErrors = {};
      if (!profile.name || profile.name.trim() === '') {
          newErrors.name = t('settings.validation.nameRequired');
      }
      if (!profile.currency) {
          newErrors.currency = t('settings.validation.currencyRequired');
      }
      if (!profile.timezone) {
          newErrors.timezone = t('settings.validation.timezoneRequired');
      }
      
      setValidationErrors(newErrors);
      return Object.keys(newErrors).length === 0; // Renvoie true si valide
  };

  // Handler générique pour les champs du profil
  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    
    if (validationErrors[name]) {
        setValidationErrors(prev => ({ ...prev, [name]: null }));
    }
    
    if (name === 'theme') {
        if (onThemeChange) { // Appeler la fonction du parent
            onThemeChange(value); 
        }
        setProfile(prev => ({ ...prev, theme: value }));
    } else if (name.startsWith('notificationPreferences.')) {
        const key = name.split('.')[1];
        setProfile(prev => ({ ...prev, notificationPreferences: { ...prev.notificationPreferences, [key]: checked } }));
    } else {
        setProfile(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
    }
    
    // Si la langue change, mettre à jour le localStorage et recharger la page
    if (name === 'language') {
      localStorage.setItem('userLanguage', value);
      // Déclencher un événement pour mettre à jour le LanguageProvider
      if (typeof window !== 'undefined') {
        try {
          window.dispatchEvent(new CustomEvent('languageChanged', { detail: { language: value } }));
        } catch (error) {
          console.error('Erreur lors de l\'envoi de l\'événement languageChanged:', error);
        }
      }
    }
    
    setSuccessMessage('');
    setProfileError('');
  };

  // Soumission du formulaire de profil
  const handleProfileSubmit = async (e) => {
    e.preventDefault();
    setProfileError('');
    setSuccessMessage('');
    
    if (!validateProfile()) {
        setProfileError(t('settings.validation.formErrors'));
        return; 
    }

    setIsSaving(true); 
    try {
      const dataToUpdate = {
        name: profile.name,
        currency: profile.currency,
        language: profile.language,
        timezone: profile.timezone,
        theme: profile.theme,
        notificationPreferences: profile.notificationPreferences,
        reportFrequency: profile.reportFrequency,
      };
      await updateUserProfile(dataToUpdate, token);
      setSuccessMessage(t('settings.messages.profileUpdated'));
      setValidationErrors({}); 
    } catch (err) {
      setProfileError(t('settings.errors.saveError', { message: err.message }));
    } finally {
      setIsSaving(false);
    }
  };
  
  // Soumission du formulaire de mot de passe
  const handlePasswordSubmit = async (e) => {
      e.preventDefault();
      setPasswordError('');
      setPasswordSuccess('');
      
      if (newPassword.length < 6) {
           setPasswordError(t('settings.validation.passwordMinLength'));
           return;
      }
      if (newPassword !== confirmPassword) {
          setPasswordError(t('settings.validation.passwordMismatch'));
          return;
      }

      setIsSaving(true);
      try {
          await changeUserPassword(oldPassword, newPassword);
          setPasswordSuccess(t('settings.messages.passwordChanged'));
          setOldPassword('');
          setNewPassword('');
          setConfirmPassword('');
      } catch (err) {
          setPasswordError(t('settings.errors.saveError', { message: err.message }));
      } finally {
          setIsSaving(false);
      }
  };
  
  // Soumission du formulaire d'invitation
  const handleInviteSubmit = async (e) => {
      e.preventDefault();
      setTeamError('');
      setInviteSuccess('');
      try {
          await inviteMember({ email: inviteEmail, role: inviteRole }, token);
          setInviteSuccess(t('settings.messages.inviteSent', { email: inviteEmail }));
          setInviteEmail(''); 
          fetchProfileAndTeam(); // Re-fetch team
      } catch (err) {
          setTeamError(t('settings.errors.inviteError', { message: err.message }));
      }
  };
  
  // Changement de rôle d'un membre
  const handleRoleChange = async (memberId, newRole) => {
      setTeamError('');
      try {
          await updateMemberRole(memberId, newRole, token);
          const membersData = await getTeamMembers(token); // Re-fetch
          setTeamMembers(membersData);
      } catch (err) {
          setTeamError(t('settings.errors.roleChangeError', { message: err.message }));
      }
  };

  // Suppression d'un membre de l'équipe
  const handleRemoveMember = async (memberId) => {
      setConfirmModal({
          isOpen: true,
          message: t('settings.messages.removeMemberConfirm'),
          onConfirm: async () => {
              setTeamError('');
              try {
                  await removeMember(memberId, token);
                  const membersData = await getTeamMembers(token); // Re-fetch
                  setTeamMembers(membersData);
              } catch (err) {
                  setTeamError(t('settings.errors.removeError', { message: err.message }));
              }
          }
      });
  };

  // Suppression du compte utilisateur
  const handleDeleteAccount = () => {
      setConfirmModal({
          isOpen: true,
          message: t('settings.deleteAccountConfirm'),
          onConfirm: async () => {
              setDeleteAccountError('');
              setIsDeletingAccount(true);
              try {
                  await deleteUserAccount(currentUserId, token);
                  // Si la suppression réussit, déconnecter l'utilisateur
                  if (onLogout) {
                      onLogout();
                  }
              } catch (err) {
                  console.error('Erreur lors de la suppression du compte:', err);
                  setDeleteAccountError(t('settings.errors.deleteAccountError', { message: err.message || 'Erreur inconnue' }));
                  setIsDeletingAccount(false);
              }
          }
      });
  };


  if (isLoading && !profile.email) {
    return (
      <div className="relative min-h-screen">
        <div
          className="fixed inset-0"
          style={{
            background:
              'linear-gradient(135deg, rgba(2,6,24,1) 0%, rgba(22,36,86,1) 45%, rgba(15,23,43,1) 100%)',
            zIndex: 0,
          }}
        />
        <div className="relative z-10 flex items-center justify-center min-h-screen">
          <p className="text-center text-global-inactive">{t('settings.loading')}</p>
        </div>
      </div>
    );
  }
  
   // Si pas de token ou pas de currentUserId, afficher un message
   // La redirection sera gérée par le useEffect ci-dessus
   if (!token || (!currentUserId && !isLoading)) {
       return (
         <div className="relative min-h-screen">
           <div
             className="fixed inset-0"
             style={{
               background:
                 'linear-gradient(135deg, rgba(2,6,24,1) 0%, rgba(22,36,86,1) 45%, rgba(15,23,43,1) 100%)',
               zIndex: 0,
             }}
           />
           <div className="relative z-10 flex flex-col items-center justify-center min-h-screen gap-4 p-8">
             <p className="text-center text-red-400">{t('settings.sessionError')}</p>
             <p className="text-center text-global-inactive text-sm">Redirection en cours...</p>
             {onLogout && (
               <button
                 onClick={onLogout}
                 className="px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors"
               >
                 {t('settings.disconnect')}
               </button>
             )}
           </div>
         </div>
       );
   }


  return (
    <div className="relative min-h-screen">
      {/* Fond qui couvre tout l'écran avec le même dégradé */}
      <div
        className="fixed inset-0"
        style={{
          background:
            'linear-gradient(135deg, rgba(2,6,24,1) 0%, rgba(22,36,86,1) 45%, rgba(15,23,43,1) 100%)',
          zIndex: 0,
        }}
      />
      <div className="relative z-10 space-y-6 p-4 md:p-6 lg:p-8 max-w-4xl mx-auto"> 
        <h1 className="text-global-blanc text-left font-h1-font-family text-h1-font-size font-h1-font-weight relative">
          {t('settings.title')}
        </h1>

      {error && <p className="bg-red-900/50 text-red-300 p-3 rounded-[10px] text-sm">{error}</p>}
      {successMessage && <p className="bg-green-900/50 text-green-300 p-3 rounded-[10px] text-sm">{successMessage}</p>}
      {profileError && <p className="bg-red-900/50 text-red-300 p-3 rounded-[10px] text-sm">{profileError}</p>}


      {/* Panneau d'Intégration PMS */}
      <div className="bg-global-bg-box rounded-[14px] border border-solid border-global-stroke-box p-6 flex flex-col gap-3 items-start justify-start relative">
        {isIntegrationLoading ? (
           <p className="text-sm text-global-inactive">{t('settings.integration.loading')}</p>
        ) : (
            <PMSIntegrationPanel 
                token={token}
                currentIntegration={currentIntegration}
                onConnectionUpdate={fetchProfileAndTeam} // Rafraîchir tout
            />
        )}
      </div>

      {/* Panneau de Gestion de l'Abonnement */}
      <BillingPanel 
        token={token}
        userProfile={profile}
        onProfileUpdate={handleProfileRefresh}
      />

      {/* Formulaire de Profil */}
      <form onSubmit={handleProfileSubmit} className="space-y-6 bg-global-bg-box rounded-[14px] border border-solid border-global-stroke-box p-6 flex flex-col gap-3 items-start justify-start relative">
        <h2 className="text-global-blanc text-left font-h2-font-family text-h2-font-size font-h2-font-weight relative border-b border-global-stroke-box pb-2 mb-4 w-full">
          {t('settings.myProfile')}
        </h2>
         <fieldset className="border border-global-stroke-box p-4 rounded-[10px] w-full">
          <legend className="text-global-blanc text-left font-h3-font-family text-h3-font-size font-h3-font-weight px-2">{t('settings.personalInfo')}</legend>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-global-inactive mb-1">{t('settings.name')}</label>
              <input 
                type="text" 
                name="name" 
                id="name" 
                value={profile.name} 
                onChange={handleChange} 
                className="w-full bg-global-bg-small-box border border-global-stroke-box rounded-[10px] px-3 py-2 text-global-blanc placeholder:text-global-inactive focus:outline-none focus:ring-2 focus:ring-global-content-highlight-2nd" 
              />
              {validationErrors.name && <p className="text-xs text-red-400 mt-1">{validationErrors.name}</p>}
            </div>
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-global-inactive mb-1">{t('settings.email')}</label>
              <input 
                type="email" 
                name="email" 
                id="email" 
                value={profile.email} 
                className="w-full bg-global-bg-small-box border border-global-stroke-box rounded-[10px] px-3 py-2 text-global-inactive cursor-not-allowed" 
                disabled 
              />
            </div>
          </div>
        </fieldset>
         <fieldset className="border border-global-stroke-box p-4 rounded-[10px] w-full">
           <legend className="text-global-blanc text-left font-h3-font-family text-h3-font-size font-h3-font-weight px-2">{t('settings.regionalPreferences')}</legend>
           <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-2">
                <div>
                  <label htmlFor="language" className="block text-sm font-medium text-global-inactive mb-1">{t('settings.language')}</label>
                  <select 
                    name="language" 
                    id="language" 
                    value={profile.language} 
                    onChange={handleChange} 
                    className="w-full bg-global-bg-small-box border border-global-stroke-box rounded-[10px] px-3 py-2 text-global-blanc focus:outline-none focus:ring-2 focus:ring-global-content-highlight-2nd"
                  >
                      <option value="fr">{t('settings.languages.fr')}</option>
                      <option value="en">{t('settings.languages.en')}</option>
                  </select>
                </div>
                 <div>
                  <label htmlFor="currency" className="block text-sm font-medium text-global-inactive mb-1">{t('settings.currency')}</label>
                  <select 
                    name="currency" 
                    id="currency" 
                    value={profile.currency} 
                    onChange={handleChange} 
                    className="w-full bg-global-bg-small-box border border-global-stroke-box rounded-[10px] px-3 py-2 text-global-blanc focus:outline-none focus:ring-2 focus:ring-global-content-highlight-2nd"
                  >
                      <option value="">{t('settings.selectCurrency')}</option>
                      <option value="EUR">EUR (€)</option>
                      <option value="USD">USD ($)</option>
                       <option value="GBP">GBP (£)</option>
                  </select>
                  {validationErrors.currency && <p className="text-xs text-red-400 mt-1">{validationErrors.currency}</p>}
                </div>
                 <div>
                  <label htmlFor="timezone" className="block text-sm font-medium text-global-inactive mb-1">{t('settings.timezone')}</label>
                  <select 
                    name="timezone" 
                    id="timezone" 
                    value={profile.timezone} 
                    onChange={handleChange} 
                    className="w-full bg-global-bg-small-box border border-global-stroke-box rounded-[10px] px-3 py-2 text-global-blanc focus:outline-none focus:ring-2 focus:ring-global-content-highlight-2nd"
                  >
                      <option value="">{t('settings.selectTimezone')}</option>
                      <optgroup label="Europe">
                        <option value="Europe/Paris">Europe/Paris (UTC+1/+2)</option>
                        <option value="Europe/London">Europe/London (UTC+0/+1)</option>
                        <option value="Europe/Berlin">Europe/Berlin (UTC+1/+2)</option>
                        <option value="Europe/Madrid">Europe/Madrid (UTC+1/+2)</option>
                        <option value="Europe/Rome">Europe/Rome (UTC+1/+2)</option>
                        <option value="Europe/Amsterdam">Europe/Amsterdam (UTC+1/+2)</option>
                        <option value="Europe/Brussels">Europe/Brussels (UTC+1/+2)</option>
                        <option value="Europe/Zurich">Europe/Zurich (UTC+1/+2)</option>
                        <option value="Europe/Vienna">Europe/Vienna (UTC+1/+2)</option>
                        <option value="Europe/Prague">Europe/Prague (UTC+1/+2)</option>
                        <option value="Europe/Warsaw">Europe/Warsaw (UTC+1/+2)</option>
                        <option value="Europe/Stockholm">Europe/Stockholm (UTC+1/+2)</option>
                        <option value="Europe/Oslo">Europe/Oslo (UTC+1/+2)</option>
                        <option value="Europe/Copenhagen">Europe/Copenhagen (UTC+1/+2)</option>
                        <option value="Europe/Helsinki">Europe/Helsinki (UTC+2/+3)</option>
                        <option value="Europe/Athens">Europe/Athens (UTC+2/+3)</option>
                        <option value="Europe/Lisbon">Europe/Lisbon (UTC+0/+1)</option>
                        <option value="Europe/Dublin">Europe/Dublin (UTC+0/+1)</option>
                        <option value="Europe/Moscow">Europe/Moscow (UTC+3)</option>
                      </optgroup>
                      <optgroup label="Amérique du Nord">
                        <option value="America/New_York">America/New_York (UTC-5/-4)</option>
                        <option value="America/Chicago">America/Chicago (UTC-6/-5)</option>
                        <option value="America/Denver">America/Denver (UTC-7/-6)</option>
                        <option value="America/Los_Angeles">America/Los_Angeles (UTC-8/-7)</option>
                        <option value="America/Toronto">America/Toronto (UTC-5/-4)</option>
                        <option value="America/Vancouver">America/Vancouver (UTC-8/-7)</option>
                        <option value="America/Mexico_City">America/Mexico_City (UTC-6/-5)</option>
                        <option value="America/Montreal">America/Montreal (UTC-5/-4)</option>
                      </optgroup>
                      <optgroup label="Amérique du Sud">
                        <option value="America/Sao_Paulo">America/Sao_Paulo (UTC-3)</option>
                        <option value="America/Buenos_Aires">America/Buenos_Aires (UTC-3)</option>
                        <option value="America/Lima">America/Lima (UTC-5)</option>
                        <option value="America/Santiago">America/Santiago (UTC-3/-4)</option>
                      </optgroup>
                      <optgroup label="Asie">
                        <option value="Asia/Tokyo">Asia/Tokyo (UTC+9)</option>
                        <option value="Asia/Shanghai">Asia/Shanghai (UTC+8)</option>
                        <option value="Asia/Hong_Kong">Asia/Hong_Kong (UTC+8)</option>
                        <option value="Asia/Singapore">Asia/Singapore (UTC+8)</option>
                        <option value="Asia/Seoul">Asia/Seoul (UTC+9)</option>
                        <option value="Asia/Dubai">Asia/Dubai (UTC+4)</option>
                        <option value="Asia/Kolkata">Asia/Kolkata (UTC+5:30)</option>
                        <option value="Asia/Bangkok">Asia/Bangkok (UTC+7)</option>
                      </optgroup>
                      <optgroup label="Océanie">
                        <option value="Australia/Sydney">Australia/Sydney (UTC+10/+11)</option>
                        <option value="Australia/Melbourne">Australia/Melbourne (UTC+10/+11)</option>
                        <option value="Australia/Brisbane">Australia/Brisbane (UTC+10)</option>
                        <option value="Pacific/Auckland">Pacific/Auckland (UTC+12/+13)</option>
                      </optgroup>
                      <optgroup label="Afrique">
                        <option value="Africa/Cairo">Africa/Cairo (UTC+2)</option>
                        <option value="Africa/Johannesburg">Africa/Johannesburg (UTC+2)</option>
                        <option value="Africa/Casablanca">Africa/Casablanca (UTC+0/+1)</option>
                      </optgroup>
                  </select>
                  <p className="text-xs text-global-inactive mt-1">
                    {t('settings.timezoneNote')}
                  </p>
                  {validationErrors.timezone && <p className="text-xs text-red-400 mt-1">{validationErrors.timezone}</p>}
                </div>
                {/* SÉLECTEUR DE THÈME */}
                 <div className="md:col-span-3">
                  <label htmlFor="theme" className="block text-sm font-medium text-global-inactive mb-1">{t('settings.appearance')}</label>
                  <select 
                    name="theme" 
                    id="theme" 
                    value={profile.theme || 'auto'} 
                    onChange={handleChange} 
                    className="w-full md:w-1/3 bg-global-bg-small-box border border-global-stroke-box rounded-[10px] px-3 py-2 text-global-blanc focus:outline-none focus:ring-2 focus:ring-global-content-highlight-2nd"
                  >
                      <option value="auto">{t('settings.auto')}</option>
                      <option value="light">{t('settings.light')}</option>
                      <option value="dark">{t('settings.dark')}</option>
                  </select>
                </div>
           </div>
         </fieldset>
         <fieldset className="border border-global-stroke-box p-4 rounded-[10px] w-full">
          <legend className="text-global-blanc text-left font-h3-font-family text-h3-font-size font-h3-font-weight px-2">{t('settings.notifications')}</legend>
          <div className="space-y-2 mt-2">
            <label className="flex items-center gap-2 text-sm text-global-inactive">
              <input 
                type="checkbox" 
                name="notificationPreferences.notifyOnBooking" 
                checked={profile.notificationPreferences?.notifyOnBooking ?? true} 
                onChange={handleChange}
                className="w-4 h-4 rounded border-global-stroke-box bg-global-bg-small-box text-global-content-highlight-2nd focus:ring-global-content-highlight-2nd"
              />
              {t('settings.notifyOnBooking')}
            </label>
            <label className="flex items-center gap-2 text-sm text-global-inactive">
              <input 
                type="checkbox" 
                name="notificationPreferences.notifyOnApiError" 
                checked={profile.notificationPreferences?.notifyOnApiError ?? true} 
                onChange={handleChange}
                className="w-4 h-4 rounded border-global-stroke-box bg-global-bg-small-box text-global-content-highlight-2nd focus:ring-global-content-highlight-2nd"
              />
              {t('settings.notifyOnApiError')}
            </label>
          </div>
        </fieldset>
         <fieldset className="border border-global-stroke-box p-4 rounded-[10px] w-full">
          <legend className="text-global-blanc text-left font-h3-font-family text-h3-font-size font-h3-font-weight px-2">{t('settings.automaticReports')}</legend>
          <div>
            <label htmlFor="reportFrequency" className="block text-sm font-medium text-global-inactive mb-1">{t('settings.reportFrequency')}</label>
            <select 
              name="reportFrequency" 
              id="reportFrequency" 
              value={profile.reportFrequency} 
              onChange={handleChange} 
              className="w-full md:w-1/2 bg-global-bg-small-box border border-global-stroke-box rounded-[10px] px-3 py-2 text-global-blanc focus:outline-none focus:ring-2 focus:ring-global-content-highlight-2nd"
            >
              <option value="jamais">{t('settings.never')}</option>
              <option value="quotidien">{t('settings.daily')}</option>
              <option value="hebdomadaire">{t('settings.weekly')}</option>
              <option value="mensuel">{t('settings.monthly')}</option>
            </select>
          </div>
        </fieldset>
        <div className="flex justify-end pt-4 w-full">
          <button 
            type="submit" 
            disabled={isSaving} 
            className="px-6 py-2 font-semibold text-white rounded-[10px] bg-gradient-to-r from-[#155dfc] to-[#12a1d5] hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
          >
            {isSaving ? t('common.saving') : t('settings.saveProfile')}
          </button>
        </div>
      </form>
      
      {/* Formulaire: Changer le mot de passe */}
      <form onSubmit={handlePasswordSubmit} className="space-y-6 bg-global-bg-box rounded-[14px] border border-solid border-global-stroke-box p-6 flex flex-col gap-3 items-start justify-start relative">
        <h2 className="text-global-blanc text-left font-h2-font-family text-h2-font-size font-h2-font-weight relative border-b border-global-stroke-box pb-2 mb-4 w-full">
          {t('settings.security')}
        </h2>
        <fieldset className="border border-global-stroke-box p-4 rounded-[10px] w-full">
            <legend className="text-global-blanc text-left font-h3-font-family text-h3-font-size font-h3-font-weight px-2">{t('settings.changePassword')}</legend>
            
            {passwordError && <p className="text-sm text-red-400 bg-red-900/50 p-3 rounded-[10px]">{passwordError}</p>}
            {passwordSuccess && <p className="text-sm text-green-400 bg-green-900/50 p-3 rounded-[10px]">{passwordSuccess}</p>}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
                 <div>
                    <label htmlFor="oldPassword" className="block text-sm font-medium text-global-inactive mb-1">{t('settings.oldPassword')}</label>
                    <input 
                      type="password" 
                      name="oldPassword" 
                      id="oldPassword" 
                      value={oldPassword} 
                      onChange={(e) => setOldPassword(e.target.value)} 
                      required 
                      className="w-full bg-global-bg-small-box border border-global-stroke-box rounded-[10px] px-3 py-2 text-global-blanc placeholder:text-global-inactive focus:outline-none focus:ring-2 focus:ring-global-content-highlight-2nd" 
                    />
                </div>
                <div>
                    <label htmlFor="newPassword" className="block text-sm font-medium text-global-inactive mb-1">{t('settings.newPassword')}</label>
                    <input 
                      type="password" 
                      name="newPassword" 
                      id="newPassword" 
                      value={newPassword} 
                      onChange={(e) => setNewPassword(e.target.value)} 
                      required 
                      className="w-full bg-global-bg-small-box border border-global-stroke-box rounded-[10px] px-3 py-2 text-global-blanc placeholder:text-global-inactive focus:outline-none focus:ring-2 focus:ring-global-content-highlight-2nd" 
                    />
                </div>
                 <div>
                    <label htmlFor="confirmPassword" className="block text-sm font-medium text-global-inactive mb-1">{t('settings.confirmPassword')}</label>
                    <input 
                      type="password" 
                      name="confirmPassword" 
                      id="confirmPassword" 
                      value={confirmPassword} 
                      onChange={(e) => setConfirmPassword(e.target.value)} 
                      required 
                      className="w-full bg-global-bg-small-box border border-global-stroke-box rounded-[10px] px-3 py-2 text-global-blanc placeholder:text-global-inactive focus:outline-none focus:ring-2 focus:ring-global-content-highlight-2nd" 
                    />
                </div>
            </div>
        </fieldset>
         <div className="flex justify-end pt-4 w-full">
          <button 
            type="submit" 
            disabled={isSaving} 
            className="px-6 py-2 font-semibold text-white rounded-[10px] bg-gradient-to-r from-[#155dfc] to-[#12a1d5] hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
          >
            {isSaving ? t('common.saving') : t('settings.changePasswordButton')}
          </button>
        </div>
      </form>

      {/* Section Gestion d'Équipe (visible uniquement pour les admins) */}
      {profile.role === 'admin' && (
        <div className="space-y-6 bg-global-bg-box rounded-[14px] border border-solid border-global-stroke-box p-6 flex flex-col gap-3 items-start justify-start relative">
          <h2 className="text-global-blanc text-left font-h2-font-family text-h2-font-size font-h2-font-weight relative border-b border-global-stroke-box pb-2 mb-4 w-full">
            {t('settings.teamManagement')}
          </h2>
          
          {teamError && <p className="bg-red-900/50 text-red-300 p-3 rounded-[10px] text-sm w-full">{teamError}</p>}
          {inviteSuccess && <p className="bg-green-900/50 text-green-300 p-3 rounded-[10px] text-sm w-full">{inviteSuccess}</p>}

          <form onSubmit={handleInviteSubmit} className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end w-full">
            <div>
              <label htmlFor="inviteEmail" className="block text-sm font-medium text-global-inactive mb-1">{t('settings.newMemberEmail')}</label>
              <input 
                type="email" 
                id="inviteEmail" 
                value={inviteEmail} 
                onChange={(e) => setInviteEmail(e.target.value)} 
                required 
                className="w-full bg-global-bg-small-box border border-global-stroke-box rounded-[10px] px-3 py-2 text-global-blanc placeholder:text-global-inactive focus:outline-none focus:ring-2 focus:ring-global-content-highlight-2nd" 
                placeholder="membre@example.com" 
              />
            </div>
            <div>
              <label htmlFor="inviteRole" className="block text-sm font-medium text-global-inactive mb-1">{t('settings.role')}</label>
              <select 
                id="inviteRole" 
                value={inviteRole} 
                onChange={(e) => setInviteRole(e.target.value)} 
                className="w-full bg-global-bg-small-box border border-global-stroke-box rounded-[10px] px-3 py-2 text-global-blanc focus:outline-none focus:ring-2 focus:ring-global-content-highlight-2nd"
              >
                <option value="member">{t('settings.member')}</option>
                <option value="manager">{t('settings.manager')}</option>
              </select>
            </div>
            <button 
              type="submit" 
              className="px-4 py-2 font-semibold text-white rounded-[10px] bg-gradient-to-r from-[#155dfc] to-[#12a1d5] hover:opacity-90 transition-opacity h-10"
            >
              {t('settings.invite')}
            </button>
          </form>

          <div className="mt-6 w-full">
            <h3 className="text-global-blanc text-left font-h3-font-family text-h3-font-size font-h3-font-weight mb-2">{t('settings.currentMembers')}</h3>
            {isLoading ? (
              <p className="text-global-inactive">{t('common.loading')}</p>
            ) : teamMembers.length > 0 ? (
              <ul className="space-y-2">
                {teamMembers.map(member => (
                  <li key={member.id} className="bg-global-bg-small-box border border-global-stroke-box p-3 rounded-[10px] flex flex-wrap justify-between items-center gap-2">
                    <div>
                      <span className="font-medium text-global-blanc">{member.name}</span>
                      <span className="text-sm text-global-inactive ml-2">({member.email})</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {member.id === currentUserId ? (
                          <span className="text-sm font-semibold px-2 py-1 bg-global-bg-box rounded-[10px] text-global-blanc border border-global-stroke-box">
                            {t('settings.you')} ({member.role})
                          </span>
                      ) : (
                         <>
                          <select 
                            value={member.role} 
                            onChange={(e) => handleRoleChange(member.id, e.target.value)}
                            className="bg-global-bg-box border border-global-stroke-box p-1 rounded-[10px] text-xs text-global-blanc" 
                          >
                            <option value="member">{t('settings.member')}</option>
                            <option value="manager">{t('settings.manager')}</option>
                            <option value="admin">Admin</option>
                          </select>
                          <button 
                            onClick={() => handleRemoveMember(member.id)} 
                            className="text-xs px-2 py-1 bg-red-800 hover:bg-red-700 rounded-[10px] text-white transition-colors"
                          >
                            {t('settings.remove')}
                          </button>
                         </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-global-inactive text-sm">{t('settings.onlyMember')}</p>
            )}
          </div>
        </div>
      )}

      {/* Bouton de déconnexion */}
      <div className="bg-global-bg-box rounded-[14px] border border-solid border-global-stroke-box p-6 flex flex-col gap-3 items-start justify-start relative">
        <h2 className="text-global-blanc text-left font-h2-font-family text-h2-font-size font-h2-font-weight relative border-b border-global-stroke-box pb-2 mb-4 w-full">
          {t('settings.logout')}
        </h2>
        <p className="text-global-inactive text-sm mb-4">
          {t('settings.logoutDescription')}
        </p>
        <div className="flex justify-end pt-4 w-full">
          <button 
            type="button"
            onClick={onLogout}
            className="px-6 py-2 font-semibold text-white rounded-[10px] bg-red-600 hover:bg-red-700 transition-colors"
          >
            {t('settings.disconnect')}
          </button>
        </div>
      </div>

      {/* Section Suppression de compte */}
      <div className="bg-global-bg-box rounded-[14px] border border-solid border-red-800/50 p-6 flex flex-col gap-3 items-start justify-start relative">
        <h2 className="text-global-blanc text-left font-h2-font-family text-h2-font-size font-h2-font-weight relative border-b border-global-stroke-box pb-2 mb-4 w-full">
          {t('settings.deleteAccount')}
        </h2>
        <p className="text-red-300 text-sm font-medium mb-2">
          {t('settings.deleteAccountWarning')}
        </p>
        <p className="text-global-inactive text-sm mb-4">
          {t('settings.deleteAccountDescription')}
        </p>
        {deleteAccountError && (
          <p className="bg-red-900/50 text-red-300 p-3 rounded-[10px] text-sm w-full">
            {deleteAccountError}
          </p>
        )}
        <div className="flex justify-end pt-4 w-full">
          <button 
            type="button"
            onClick={handleDeleteAccount}
            disabled={isDeletingAccount}
            className="px-6 py-2 font-semibold text-white rounded-[10px] bg-red-700 hover:bg-red-800 disabled:bg-red-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isDeletingAccount ? t('common.saving') : t('settings.deleteAccountButton')}
          </button>
        </div>
      </div>

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
      </div>
    </div>
  );
}

export default SettingsPage;

