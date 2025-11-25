import React, { useState } from 'react';
import { createGroup, addPropertiesToGroup } from '../services/api.js';

/**
 * Menu contextuel pour afficher les notifications de suggestions de groupe.
 * @param {object} props
 * @param {boolean} props.isOpen - Si le menu est ouvert
 * @param {Function} props.onClose - Callback pour fermer le menu
 * @param {Array} props.recommendations - Tableau des recommandations de groupe
 * @param {string} props.token - Le jeton d'authentification
 * @param {Function} props.onGroupCreated - Callback après création d'un groupe
 * @param {object} props.position - Position du menu { top, right }
 */
function NotificationsMenu({ isOpen, onClose, recommendations, token, onGroupCreated, position }) {
  const [loadingIds, setLoadingIds] = useState(new Set());
  const [error, setError] = useState('');

  const handleCreateGroup = async (recommendation) => {
    if (!recommendation || !recommendation.properties || recommendation.properties.length < 2) {
      setError("Recommandation invalide.");
      return;
    }
    
    setLoadingIds(prev => new Set([...prev, recommendation.key]));
    setError('');

    try {
      // 1. Créer un nom de groupe
      const firstPropAddress = recommendation.properties[0].address;
      const groupName = `Groupe Similaire (${firstPropAddress.split(',')[0]})`;
      
      // 2. Créer le groupe
      const newGroup = await createGroup({ name: groupName }, token);
      
      // 3. Ajouter les propriétés au groupe
      const propertyIds = recommendation.properties.map(p => p.id);
      await addPropertiesToGroup(newGroup.id, propertyIds, token);
      
      // 4. Rafraîchir et fermer le menu
      if (onGroupCreated) {
        onGroupCreated();
      }
      onClose();
      
    } catch (err) {
      console.error("Erreur lors de la création du groupe suggéré:", err);
      setError(err.message);
    } finally {
      setLoadingIds(prev => {
        const newSet = new Set(prev);
        newSet.delete(recommendation.key);
        return newSet;
      });
    }
  };

  if (!isOpen) return null;

  const hasNotifications = recommendations && recommendations.length > 0;

  return (
    <div
      ref={menuRef}
      className="notifications-menu fixed bg-global-bg-box border border-global-stroke-box rounded-[14px] shadow-xl z-50 w-[400px] max-h-[600px] overflow-hidden flex flex-col"
      style={{
        top: position?.top || '60px',
        right: position?.right || '20px',
      }}
    >
      {/* En-tête du menu */}
      <div className="flex items-center justify-between p-4 border-b border-global-stroke-box">
        <h3 className="text-global-blanc font-h3-font-family font-h3-font-weight text-h3-font-size">
          Notifications
        </h3>
        <button
          onClick={onClose}
          className="text-global-inactive hover:text-global-blanc transition-colors"
          aria-label="Fermer"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>

      {/* Contenu du menu */}
      <div className="overflow-y-auto flex-1">
        {error && (
          <div className="m-4 p-3 bg-red-900/20 border border-red-500/50 rounded-[10px] text-red-300 text-sm">
            {error}
          </div>
        )}

        {!hasNotifications ? (
          <div className="p-8 text-center">
            <svg
              className="w-16 h-16 mx-auto mb-4 text-global-inactive"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
              />
            </svg>
            <p className="text-global-inactive font-p1-font-family text-p1-font-size">
              Aucune notification
            </p>
          </div>
        ) : (
          <div className="p-4 space-y-3">
            <div className="mb-3">
              <p className="text-xs font-bold uppercase tracking-[0.2em] text-global-inactive mb-2">
                Suggestions de regroupement
              </p>
            </div>
            {recommendations.map((rec) => {
              const isLoading = loadingIds.has(rec.key);
              return (
                <div
                  key={rec.key}
                  className="bg-global-bg-small-box border border-global-stroke-box rounded-[12px] p-4 flex flex-col gap-3"
                >
                  <div className="text-sm text-global-inactive">
                    <p className="text-global-blanc font-semibold mb-2">
                      {rec.properties.length} propriétés similaires détectées
                    </p>
                    <ul className="list-disc list-inside text-xs space-y-1 max-h-32 overflow-y-auto">
                      {rec.properties.map((p) => (
                        <li key={p.id} className="text-global-inactive">
                          {p.address}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <button
                    onClick={() => handleCreateGroup(rec)}
                    disabled={isLoading}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-[10px] font-semibold text-white bg-gradient-to-r from-[#155dfc] to-[#12a1d5] shadow-lg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
                  >
                    {isLoading ? (
                      <>
                        <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                        <span>Création...</span>
                      </>
                    ) : (
                      'Créer le groupe'
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default NotificationsMenu;

