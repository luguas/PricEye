import React, { useState } from 'react';
import { createGroup, addPropertiesToGroup } from '../services/api.js';

/**
 * Affiche les suggestions de regroupement de propriétés.
 * @param {object} props
 * @param {string} props.token - Le jeton d'authentification.
 * @param {Array} props.recommendations - Tableau des recommandations.
 * @param {Function} props.onGroupCreated - Callback pour rafraîchir le dashboard.
 */
function GroupRecommendations({ token, recommendations, onGroupCreated }) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  if (!recommendations || recommendations.length === 0) {
    return null; // Ne rien afficher s'il n'y a pas de suggestions
  }

  const handleCreateGroup = async (recommendation) => {
    if (!recommendation || !recommendation.properties || recommendation.properties.length < 2) {
      setError("Recommandation invalide.");
      return;
    }
    
    setIsLoading(true);
    setError('');

    try {
      // 1. Créer un nom de groupe (ex: "Groupe Similaire - Paris")
      const firstPropAddress = recommendation.properties[0].address;
      const groupName = `Groupe Similaire (${firstPropAddress.split(',')[0]})`;
      
      // 2. Créer le groupe
      const newGroup = await createGroup({ name: groupName }, token);
      
      // 3. Ajouter les propriétés au groupe
      const propertyIds = recommendation.properties.map(p => p.id);
      await addPropertiesToGroup(newGroup.id, propertyIds, token);
      
      // 4. Rafraîchir le dashboard
      onGroupCreated();
      
    } catch (err) {
      console.error("Erreur lors de la création du groupe suggéré:", err);
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="bg-bg-secondary p-4 rounded-lg shadow-lg mb-6 border border-blue-500/30">
      <h3 className="text-xl font-semibold text-text-primary mb-3">Suggestions d'Optimisation</h3>
      {error && <p className="text-sm text-red-400 mb-2">{error}</p>}
      
      <div className="space-y-3">
        {recommendations.map((rec) => (
          <div key={rec.key} className="bg-bg-muted p-3 rounded-md flex flex-col md:flex-row justify-between items-center gap-3">
            <div className="text-sm text-text-secondary">
              <strong className="text-text-primary">Suggestion :</strong> Nous avons trouvé {rec.properties.length} propriétés non groupées qui ont des caractéristiques identiques.
              <ul className="list-disc list-inside ml-4 text-xs mt-1">
                {rec.properties.map(p => <li key={p.id}>{p.address}</li>)}
              </ul>
            </div>
            <button
              onClick={() => handleCreateGroup(rec)}
              disabled={isLoading}
              className="px-4 py-2 font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:bg-gray-500 w-full md:w-auto flex-shrink-0"
            >
              {isLoading ? 'Création...' : 'Créer le groupe'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default GroupRecommendations;
