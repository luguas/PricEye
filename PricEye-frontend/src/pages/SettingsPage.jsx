import React, { useState, useEffect, useCallback } from 'react';
import { 
    getUserProfile, 
    updateUserProfile, 
    getTeamMembers, 
    inviteMember, 
    updateMemberRole, 
    removeMember,
    changeUserPassword,
    getIntegrations // NOUVEL IMPORT
} from '../services/api.js'; 
import { jwtDecode } from 'jwt-decode'; 
import PMSIntegrationPanel from '../components/PMSIntegrationPanel.jsx'; // NOUVEL IMPORT

function SettingsPage({ token, userProfile: initialProfile, onThemeChange }) {
  const [profile, setProfile] = useState({
    name: '',
    email: '',
    currency: 'EUR',
    language: 'fr',
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

  // États de chargement et de messagerie
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState(''); 
  const [profileError, setProfileError] = useState(''); 
  const [successMessage, setSuccessMessage] = useState('');
  const [teamError, setTeamError] = useState('');
  const [inviteSuccess, setInviteSuccess] = useState('');
  
  const [validationErrors, setValidationErrors] = useState({});

  let currentUserId = null;
  try {
      if (token) {
          const decodedToken = jwtDecode(token);
          currentUserId = decodedToken?.user_id; 
      }
  } catch (e) {
      console.error("Erreur de décodage du token:", e);
      setError("Session invalide, veuillez vous reconnecter.");
  }


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
         setError("Impossible de charger le statut de l'intégration PMS.");
      } finally {
         setIsIntegrationLoading(false);
      }

      // 3. Membres de l'équipe
      if (initialProfile?.role === 'admin') {
          const membersData = await getTeamMembers(token);
          setTeamMembers(membersData);
      }
      
    } catch (err) {
      setError(`Erreur lors du chargement des données: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  }, [token, currentUserId, initialProfile]); 

  useEffect(() => {
    fetchProfileAndTeam();
  }, [fetchProfileAndTeam]);

  // Fonction de validation du profil
  const validateProfile = () => {
      const newErrors = {};
      if (!profile.name || profile.name.trim() === '') {
          newErrors.name = "Le nom ne peut pas être vide.";
      }
      if (!profile.currency) {
          newErrors.currency = "Veuillez sélectionner une devise.";
      }
      if (!profile.timezone) {
          newErrors.timezone = "Veuillez sélectionner un fuseau horaire.";
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
    setSuccessMessage('');
    setProfileError('');
  };

  // Soumission du formulaire de profil
  const handleProfileSubmit = async (e) => {
    e.preventDefault();
    setProfileError('');
    setSuccessMessage('');
    
    if (!validateProfile()) {
        setProfileError("Veuillez corriger les erreurs dans le formulaire.");
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
      setSuccessMessage('Profil mis à jour avec succès !');
      setValidationErrors({}); 
    } catch (err) {
      setProfileError(`Erreur lors de la sauvegarde: ${err.message}`);
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
           setPasswordError("Le nouveau mot de passe doit contenir au moins 6 caractères.");
           return;
      }
      if (newPassword !== confirmPassword) {
          setPasswordError("Les nouveaux mots de passe ne correspondent pas.");
          return;
      }

      setIsSaving(true);
      try {
          await changeUserPassword(oldPassword, newPassword);
          setPasswordSuccess("Mot de passe modifié avec succès !");
          setOldPassword('');
          setNewPassword('');
          setConfirmPassword('');
      } catch (err) {
          setPasswordError(`Erreur: ${err.message}`);
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
          setInviteSuccess(`Invitation envoyée à ${inviteEmail}.`);
          setInviteEmail(''); 
          fetchProfileAndTeam(); // Re-fetch team
      } catch (err) {
          setTeamError(`Erreur lors de l'invitation: ${err.message}`);
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
          setTeamError(`Erreur lors du changement de rôle: ${err.message}`);
      }
  };

  // Suppression d'un membre de l'équipe
  const handleRemoveMember = async (memberId) => {
      if (window.confirm("Êtes-vous sûr de vouloir retirer ce membre de l'équipe ?")) {
          setTeamError('');
          try {
              await removeMember(memberId, token);
              const membersData = await getTeamMembers(token); // Re-fetch
              setTeamMembers(membersData);
          } catch (err) {
              setTeamError(`Erreur lors de la suppression: ${err.message}`);
          }
      }
  };


  if (isLoading && !profile.email) {
    return <p className="text-center text-text-muted">Chargement des paramètres...</p>;
  }
  
   if (!currentUserId && !isLoading) {
       return <p className="text-center text-red-400 p-8">Erreur de session. Veuillez vous reconnecter.</p>;
   }


  return (
    <div className="space-y-8 max-w-4xl mx-auto"> 
      <h1 className="text-3xl font-bold text-text-primary">Paramètres</h1>

      {error && <p className="bg-red-900/50 text-red-300 p-3 rounded-md text-sm">{error}</p>}
      {successMessage && <p className="bg-green-900/50 text-green-300 p-3 rounded-md text-sm">{successMessage}</p>}
      {profileError && <p className="bg-red-900/50 text-red-300 p-3 rounded-md text-sm">{profileError}</p>}


      {/* Panneau d'Intégration PMS */}
      <div className="bg-bg-secondary p-6 rounded-lg shadow-lg">
        {isIntegrationLoading ? (
           <p className="text-sm text-text-muted">Chargement de l'intégration...</p>
        ) : (
            <PMSIntegrationPanel 
                token={token}
                currentIntegration={currentIntegration}
                onConnectionUpdate={fetchProfileAndTeam} // Rafraîchir tout
            />
        )}
      </div>

      {/* Formulaire de Profil */}
      <form onSubmit={handleProfileSubmit} className="space-y-6 bg-bg-secondary p-6 rounded-lg shadow-lg">
        <h2 className="text-2xl font-semibold border-b border-border-primary pb-2 mb-4 text-text-primary">Mon Profil</h2>
         <fieldset className="border border-border-secondary p-4 rounded-md">
          <legend className="text-lg font-semibold px-2 text-text-primary">Informations Personnelles</legend>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-text-secondary">Nom</label>
              <input type="text" name="name" id="name" value={profile.name} onChange={handleChange} className="w-full form-input mt-1" />
              {validationErrors.name && <p className="text-xs text-red-400 mt-1">{validationErrors.name}</p>}
            </div>
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-text-secondary">Email (non modifiable)</label>
              <input type="email" name="email" id="email" value={profile.email} className="w-full form-input mt-1 text-text-muted" disabled />
            </div>
          </div>
        </fieldset>
         <fieldset className="border border-border-secondary p-4 rounded-md">
           <legend className="text-lg font-semibold px-2 text-text-primary">Préférences Régionales & Visuelles</legend>
           <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-2">
                <div>
                  <label htmlFor="language" className="block text-sm font-medium text-text-secondary">Langue</label>
                  <select name="language" id="language" value={profile.language} onChange={handleChange} className="w-full form-input mt-1">
                      <option value="fr">Français</option>
                      <option value="en">English</option>
                  </select>
                </div>
                 <div>
                  <label htmlFor="currency" className="block text-sm font-medium text-text-secondary">Devise</label>
                  <select name="currency" id="currency" value={profile.currency} onChange={handleChange} className="w-full form-input mt-1">
                      <option value="">Sélectionner...</option>
                      <option value="EUR">EUR (€)</option>
                      <option value="USD">USD ($)</option>
                       <option value="GBP">GBP (£)</option>
                  </select>
                  {validationErrors.currency && <p className="text-xs text-red-400 mt-1">{validationErrors.currency}</p>}
                </div>
                 <div>
                  <label htmlFor="timezone" className="block text-sm font-medium text-text-secondary">Fuseau Horaire</label>
                  <select name="timezone" id="timezone" value={profile.timezone} onChange={handleChange} className="w-full form-input mt-1">
                      <option value="">Sélectionner...</option>
                      <option value="Europe/Paris">Europe/Paris</option>
                      <option value="Europe/London">Europe/London</option>
                      <option value="America/New_York">America/New_York</option>
                  </select>
                  {validationErrors.timezone && <p className="text-xs text-red-400 mt-1">{validationErrors.timezone}</p>}
                </div>
                {/* SÉLECTEUR DE THÈME */}
                 <div className="md:col-span-3">
                  <label htmlFor="theme" className="block text-sm font-medium text-text-secondary">Apparence</label>
                  <select name="theme" id="theme" value={profile.theme || 'auto'} onChange={handleChange} className="w-full md:w-1/3 form-input mt-1">
                      <option value="auto">Auto (Système)</option>
                      <option value="light">Clair</option>
                      <option value="dark">Sombre</option>
                  </select>
                </div>
           </div>
         </fieldset>
         <fieldset className="border border-border-secondary p-4 rounded-md">
          <legend className="text-lg font-semibold px-2 text-text-primary">Notifications</legend>
          <div className="space-y-2 mt-2">
            <label className="flex items-center gap-2 text-sm text-text-secondary">
              <input 
                type="checkbox" 
                name="notificationPreferences.notifyOnBooking" 
                checked={profile.notificationPreferences?.notifyOnBooking ?? true} 
                onChange={handleChange} 
              />
              M'alerter par email pour chaque nouvelle réservation
            </label>
            <label className="flex items-center gap-2 text-sm text-text-secondary">
              <input 
                type="checkbox" 
                name="notificationPreferences.notifyOnApiError" 
                checked={profile.notificationPreferences?.notifyOnApiError ?? true} 
                onChange={handleChange} 
              />
              M'alerter si une connexion API est rompue
            </label>
          </div>
        </fieldset>
         <fieldset className="border border-border-secondary p-4 rounded-md">
          <legend className="text-lg font-semibold px-2 text-text-primary">Rapports Automatiques</legend>
          <div>
            <label htmlFor="reportFrequency" className="block text-sm font-medium text-text-secondary">Fréquence d'envoi du résumé des performances</label>
            <select name="reportFrequency" id="reportFrequency" value={profile.reportFrequency} onChange={handleChange} className="w-full md:w-1/2 form-input mt-1">
              <option value="jamais">Jamais</option>
              <option value="quotidien">Quotidien</option>
              <option value="hebdomadaire">Hebdomadaire</option>
              <option value="mensuel">Mensuel</option>
            </select>
          </div>
        </fieldset>
        <div className="flex justify-end pt-4">
          <button type="submit" disabled={isSaving} className="px-6 py-2 font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:bg-gray-500">
            {isSaving ? 'Sauvegarde...' : 'Sauvegarder le Profil'}
          </button>
        </div>
      </form>
      
      {/* Formulaire: Changer le mot de passe */}
      <form onSubmit={handlePasswordSubmit} className="space-y-6 bg-bg-secondary p-6 rounded-lg shadow-lg">
        <h2 className="text-2xl font-semibold border-b border-border-primary pb-2 mb-4 text-text-primary">Sécurité</h2>
        <fieldset className="border border-border-secondary p-4 rounded-md">
            <legend className="text-lg font-semibold px-2 text-text-primary">Changer le mot de passe</legend>
            
            {passwordError && <p className="text-sm text-red-400 bg-red-900/50 p-3 rounded-md">{passwordError}</p>}
            {passwordSuccess && <p className="text-sm text-green-400 bg-green-900/50 p-3 rounded-md">{passwordSuccess}</p>}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
                 <div>
                    <label htmlFor="oldPassword" className="block text-sm font-medium text-text-secondary">Ancien mot de passe</label>
                    <input type="password" name="oldPassword" id="oldPassword" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} required className="w-full form-input mt-1" />
                </div>
                <div>
                    <label htmlFor="newPassword" className="block text-sm font-medium text-text-secondary">Nouveau mot de passe</label>
                    <input type="password" name="newPassword" id="newPassword" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required className="w-full form-input mt-1" />
                </div>
                 <div>
                    <label htmlFor="confirmPassword" className="block text-sm font-medium text-text-secondary">Confirmer le nouveau</label>
                    <input type="password" name="confirmPassword" id="confirmPassword" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required className="w-full form-input mt-1" />
                </div>
            </div>
        </fieldset>
         <div className="flex justify-end pt-4">
          <button type="submit" disabled={isSaving} className="px-6 py-2 font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:bg-gray-500">
            {isSaving ? 'Sauvegarde...' : 'Changer le mot de passe'}
          </button>
        </div>
      </form>

      {/* Section Gestion d'Équipe (visible uniquement pour les admins) */}
      {profile.role === 'admin' && (
        <div className="space-y-6 bg-bg-secondary p-6 rounded-lg shadow-lg">
          <h2 className="text-2xl font-semibold border-b border-border-primary pb-2 mb-4 text-text-primary">Gestion d'Équipe</h2>
          
          {teamError && <p className="bg-red-900/50 text-red-300 p-3 rounded-md text-sm">{teamError}</p>}
          {inviteSuccess && <p className="bg-green-900/50 text-green-300 p-3 rounded-md text-sm">{inviteSuccess}</p>}

          <form onSubmit={handleInviteSubmit} className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
            <div>
              <label htmlFor="inviteEmail" className="block text-sm font-medium text-text-secondary">Email du nouveau membre</label>
              <input type="email" id="inviteEmail" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required className="w-full form-input mt-1" placeholder="membre@example.com" />
            </div>
            <div>
              <label htmlFor="inviteRole" className="block text-sm font-medium text-text-secondary">Rôle</label>
              <select id="inviteRole" value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} className="w-full form-input mt-1">
                <option value="member">Membre (Lecture seule)</option>
                <option value="manager">Gestionnaire (Modifier propriétés)</option>
              </select>
            </div>
            <button type="submit" className="px-4 py-2 font-semibold text-white bg-indigo-600 rounded-md hover:bg-indigo-700 h-10">
              Inviter
            </button>
          </form>

          <div className="mt-6">
            <h3 className="text-lg font-semibold mb-2 text-text-primary">Membres Actuels</h3>
            {isLoading ? (
              <p className="text-text-muted">Chargement...</p>
            ) : teamMembers.length > 0 ? (
              <ul className="space-y-2">
                {teamMembers.map(member => (
                  <li key={member.id} className="bg-bg-muted p-3 rounded-md flex flex-wrap justify-between items-center gap-2">
                    <div>
                      <span className="font-medium text-text-primary">{member.name}</span>
                      <span className="text-sm text-text-muted ml-2">({member.email})</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {member.id === currentUserId ? (
                          <span className="text-sm font-semibold px-2 py-1 bg-gray-600 rounded text-white">Vous ({member.role})</span>
                      ) : (
                         <>
                          <select 
                            value={member.role} 
                            onChange={(e) => handleRoleChange(member.id, e.target.value)}
                            className="bg-bg-primary p-1 rounded-md text-xs text-text-primary border border-border-primary" 
                          >
                            <option value="member">Membre</option>
                            <option value="manager">Gestionnaire</option>
                            <option value="admin">Admin</option>
                          </select>
                          <button 
                            onClick={() => handleRemoveMember(member.id)} 
                            className="text-xs px-2 py-1 bg-red-800 hover:bg-red-700 rounded-md text-white"
                          >
                            Retirer
                          </button>
                         </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-text-muted text-sm">Vous êtes le seul membre de l'équipe.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default SettingsPage;

