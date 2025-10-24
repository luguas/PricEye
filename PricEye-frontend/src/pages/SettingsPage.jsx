import React, { useState, useEffect, useCallback } from 'react';
import { getUserProfile, updateUserProfile, getTeamMembers, inviteMember, updateMemberRole, removeMember } from '../services/api';
// Correction de l'import pour jwt-decode
import { jwtDecode } from 'jwt-decode'; // Utiliser l'import nommé { jwtDecode }

function SettingsPage({ token }) {
  const [profile, setProfile] = useState({
    name: '',
    email: '',
    currency: 'EUR',
    language: 'fr',
    timezone: 'Europe/Paris',
    notificationPreferences: {
      notifyOnBooking: true,
      notifyOnApiError: true,
    },
    reportFrequency: 'hebdomadaire',
    role: 'member', // Ajouter le rôle
  });
  
  const [teamMembers, setTeamMembers] = useState([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [teamError, setTeamError] = useState('');
  const [inviteSuccess, setInviteSuccess] = useState('');

  // Décoder le token pour obtenir l'ID de l'utilisateur actuel
  let currentUserId = null;
  try {
      if (token) {
          const decodedToken = jwtDecode(token);
          currentUserId = decodedToken?.user_id; // L'UID est dans user_id pour Firebase ID tokens
      }
  } catch (e) {
      console.error("Erreur de décodage du token:", e);
      // Gérer l'erreur, peut-être déconnecter l'utilisateur ou afficher un message
      setError("Session invalide, veuillez vous reconnecter.");
  }


  const fetchProfileAndTeam = useCallback(async () => {
    // Si le token n'est pas valide (erreur de décodage), ne rien faire
    if (!currentUserId) {
        setIsLoading(false);
        return;
    }
    try {
      setIsLoading(true);
      setError('');
      setTeamError('');
      
      // Charger le profil utilisateur
      const profileData = await getUserProfile(token);
      setProfile({
        ...profileData,
        notificationPreferences: profileData.notificationPreferences || { notifyOnBooking: true, notifyOnApiError: true },
        reportFrequency: profileData.reportFrequency || 'hebdomadaire',
        role: profileData.role || 'member' // Assurer que le rôle est chargé
      });

      // Charger les membres de l'équipe si l'utilisateur est admin
      if (profileData.role === 'admin') {
          const membersData = await getTeamMembers(token);
          setTeamMembers(membersData);
      }
      
    } catch (err) {
      setError(`Erreur lors du chargement des données: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  }, [token, currentUserId]); // Ajouter currentUserId aux dépendances

  useEffect(() => {
    fetchProfileAndTeam();
  }, [fetchProfileAndTeam]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    
    if (name.startsWith('notificationPreferences.')) {
        const key = name.split('.')[1];
        setProfile(prev => ({ ...prev, notificationPreferences: { ...prev.notificationPreferences, [key]: checked } }));
    } else {
        setProfile(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
    }
    setSuccessMessage('');
  };

  const handleProfileSubmit = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');
    setSuccessMessage('');
    try {
      const dataToUpdate = {
        name: profile.name,
        currency: profile.currency,
        language: profile.language,
        timezone: profile.timezone,
        notificationPreferences: profile.notificationPreferences,
        reportFrequency: profile.reportFrequency,
      };
      await updateUserProfile(dataToUpdate, token);
      setSuccessMessage('Profil mis à jour avec succès !');
    } catch (err) {
      setError(`Erreur lors de la sauvegarde: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  };
  
  const handleInviteSubmit = async (e) => {
      e.preventDefault();
      setTeamError('');
      setInviteSuccess('');
      try {
          await inviteMember({ email: inviteEmail, role: inviteRole }, token);
          setInviteSuccess(`Invitation envoyée à ${inviteEmail}.`);
          setInviteEmail(''); // Vider le champ
          // Rafraîchir la liste des invitations ou membres si nécessaire
          fetchProfileAndTeam(); // Pour recharger les membres
      } catch (err) {
          setTeamError(`Erreur lors de l'invitation: ${err.message}`);
      }
  };
  
  const handleRoleChange = async (memberId, newRole) => {
      setTeamError('');
      try {
          await updateMemberRole(memberId, newRole, token);
          // Rafraîchir la liste des membres
          const membersData = await getTeamMembers(token);
          setTeamMembers(membersData);
      } catch (err) {
          setTeamError(`Erreur lors du changement de rôle: ${err.message}`);
      }
  };

  const handleRemoveMember = async (memberId) => {
      if (window.confirm("Êtes-vous sûr de vouloir retirer ce membre de l'équipe ?")) {
          setTeamError('');
          try {
              await removeMember(memberId, token);
              // Rafraîchir la liste des membres
              const membersData = await getTeamMembers(token);
              setTeamMembers(membersData);
          } catch (err) {
              setTeamError(`Erreur lors de la suppression: ${err.message}`);
          }
      }
  };


  if (isLoading && !profile.email) {
    return <p className="text-center text-gray-400">Chargement des paramètres...</p>;
  }

  // Si le token était invalide au démarrage
   if (!currentUserId && !isLoading) {
       return <p className="text-center text-red-400 p-8">Erreur de session. Veuillez vous reconnecter.</p>;
   }


  return (
    <div className="space-y-8 max-w-4xl mx-auto"> {/* Augmenté la largeur max */}
      <h1 className="text-3xl font-bold text-white">Paramètres</h1>

      {error && <p className="bg-red-900/50 text-red-300 p-3 rounded-md text-sm">{error}</p>}
      {successMessage && <p className="bg-green-900/50 text-green-300 p-3 rounded-md text-sm">{successMessage}</p>}

      {/* Formulaire de Profil */}
      <form onSubmit={handleProfileSubmit} className="space-y-6 bg-gray-800 p-6 rounded-lg">
        <h2 className="text-2xl font-semibold border-b border-gray-700 pb-2 mb-4">Mon Profil</h2>
        {/* Informations Personnelles */}
         <fieldset className="border border-gray-700 p-4 rounded-md">
          <legend className="text-lg font-semibold px-2">Informations Personnelles</legend>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-gray-300">Nom</label>
              <input type="text" name="name" id="name" value={profile.name} onChange={handleChange} className="w-full bg-gray-700 p-2 rounded-md mt-1" />
            </div>
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-300">Email (non modifiable)</label>
              <input type="email" name="email" id="email" value={profile.email} className="w-full bg-gray-600 p-2 rounded-md mt-1 text-gray-400" disabled />
            </div>
          </div>
        </fieldset>
         {/* Préférences Régionales */}
         <fieldset className="border border-gray-700 p-4 rounded-md">
           <legend className="text-lg font-semibold px-2">Préférences Régionales</legend>
           <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-2">
                <div>
                  <label htmlFor="language" className="block text-sm font-medium text-gray-300">Langue</label>
                  <select name="language" id="language" value={profile.language} onChange={handleChange} className="w-full bg-gray-700 p-2 rounded-md mt-1">
                      <option value="fr">Français</option>
                      <option value="en">English</option>
                      {/* Ajouter d'autres langues si nécessaire */}
                  </select>
                </div>
                 <div>
                  <label htmlFor="currency" className="block text-sm font-medium text-gray-300">Devise</label>
                  <select name="currency" id="currency" value={profile.currency} onChange={handleChange} className="w-full bg-gray-700 p-2 rounded-md mt-1">
                      <option value="EUR">EUR (€)</option>
                      <option value="USD">USD ($)</option>
                       <option value="GBP">GBP (£)</option>
                      {/* Ajouter d'autres devises */}
                  </select>
                </div>
                 <div>
                  <label htmlFor="timezone" className="block text-sm font-medium text-gray-300">Fuseau Horaire</label>
                  <select name="timezone" id="timezone" value={profile.timezone} onChange={handleChange} className="w-full bg-gray-700 p-2 rounded-md mt-1">
                      <option value="Europe/Paris">Europe/Paris</option>
                      <option value="Europe/London">Europe/London</option>
                      <option value="America/New_York">America/New_York</option>
                      {/* Ajouter d'autres fuseaux */}
                  </select>
                </div>
           </div>
         </fieldset>
         {/* Préférences de Notification */}
         <fieldset className="border border-gray-700 p-4 rounded-md">
          <legend className="text-lg font-semibold px-2">Notifications</legend>
          <div className="space-y-2 mt-2">
            <label className="flex items-center gap-2 text-sm">
              <input 
                type="checkbox" 
                name="notificationPreferences.notifyOnBooking" 
                checked={profile.notificationPreferences?.notifyOnBooking ?? true} // Valeur par défaut si undefined
                onChange={handleChange} 
                className="rounded bg-gray-700 border-gray-600 text-blue-500 focus:ring-blue-500"
              />
              M'alerter par email pour chaque nouvelle réservation
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input 
                type="checkbox" 
                name="notificationPreferences.notifyOnApiError" 
                checked={profile.notificationPreferences?.notifyOnApiError ?? true} // Valeur par défaut si undefined
                onChange={handleChange} 
                className="rounded bg-gray-700 border-gray-600 text-blue-500 focus:ring-blue-500"
              />
              M'alerter si une connexion API est rompue
            </label>
          </div>
        </fieldset>
         {/* Rapports Automatiques */}
         <fieldset className="border border-gray-700 p-4 rounded-md">
          <legend className="text-lg font-semibold px-2">Rapports Automatiques</legend>
          <div>
            <label htmlFor="reportFrequency" className="block text-sm font-medium text-gray-300">Fréquence d'envoi du résumé des performances</label>
            <select name="reportFrequency" id="reportFrequency" value={profile.reportFrequency} onChange={handleChange} className="w-full md:w-1/2 bg-gray-700 p-2 rounded-md mt-1">
              <option value="jamais">Jamais</option>
              <option value="quotidien">Quotidien</option>
              <option value="hebdomadaire">Hebdomadaire</option>
              <option value="mensuel">Mensuel</option>
            </select>
          </div>
        </fieldset>
        {/* Bouton de sauvegarde */}
        <div className="flex justify-end pt-4">
          <button type="submit" disabled={isLoading} className="px-6 py-2 font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:bg-gray-500">
            {isLoading ? 'Sauvegarde...' : 'Sauvegarder le Profil'}
          </button>
        </div>
      </form>

      {/* Section Gestion d'Équipe (visible uniquement pour les admins) */}
      {profile.role === 'admin' && (
        <div className="space-y-6 bg-gray-800 p-6 rounded-lg">
          <h2 className="text-2xl font-semibold border-b border-gray-700 pb-2 mb-4">Gestion d'Équipe</h2>
          
          {teamError && <p className="bg-red-900/50 text-red-300 p-3 rounded-md text-sm">{teamError}</p>}
          {inviteSuccess && <p className="bg-green-900/50 text-green-300 p-3 rounded-md text-sm">{inviteSuccess}</p>}

          {/* Inviter un membre */}
          <form onSubmit={handleInviteSubmit} className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
            <div>
              <label htmlFor="inviteEmail" className="block text-sm font-medium text-gray-300">Email du nouveau membre</label>
              <input type="email" id="inviteEmail" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required className="w-full bg-gray-700 p-2 rounded-md mt-1" placeholder="membre@example.com" />
            </div>
            <div>
              <label htmlFor="inviteRole" className="block text-sm font-medium text-gray-300">Rôle</label>
              <select id="inviteRole" value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} className="w-full bg-gray-700 p-2 rounded-md mt-1">
                <option value="member">Membre (Lecture seule)</option>
                <option value="manager">Gestionnaire (Modifier propriétés)</option>
                {/* Ne pas proposer 'admin' pour l'instant pour simplifier */}
                {/* <option value="admin">Administrateur (Tout gérer)</option> */}
              </select>
            </div>
            <button type="submit" className="px-4 py-2 font-semibold text-white bg-indigo-600 rounded-md hover:bg-indigo-700 h-10">
              Inviter
            </button>
          </form>

          {/* Liste des membres */}
          <div className="mt-6">
            <h3 className="text-lg font-semibold mb-2">Membres Actuels</h3>
            {isLoading ? (
              <p className="text-gray-400">Chargement...</p>
            ) : teamMembers.length > 0 ? (
              <ul className="space-y-2">
                {teamMembers.map(member => (
                  <li key={member.id} className="bg-gray-700 p-3 rounded-md flex flex-wrap justify-between items-center gap-2">
                    <div>
                      <span className="font-medium">{member.name}</span>
                      <span className="text-sm text-gray-400 ml-2">({member.email})</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {member.id === currentUserId ? (
                          <span className="text-sm font-semibold px-2 py-1 bg-gray-600 rounded">Vous ({member.role})</span>
                      ) : (
                         <>
                          <select 
                            value={member.role} 
                            onChange={(e) => handleRoleChange(member.id, e.target.value)}
                            className="bg-gray-600 p-1 rounded-md text-xs text-white" // Ajout text-white
                          >
                            <option value="member">Membre</option>
                            <option value="manager">Gestionnaire</option>
                            <option value="admin">Admin</option>
                          </select>
                          <button 
                            onClick={() => handleRemoveMember(member.id)} 
                            className="text-xs px-2 py-1 bg-red-800 hover:bg-red-700 rounded-md"
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
              <p className="text-gray-400 text-sm">Vous êtes le seul membre de l'équipe.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default SettingsPage;

