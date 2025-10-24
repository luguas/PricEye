import React, { useState, useEffect, useCallback } from 'react';
import { getGroups, createGroup, updateGroup, deleteGroup, addPropertiesToGroup, removePropertiesFromGroup } from '../services/api';

function GroupsManager({ token, properties }) {
  const [groups, setGroups] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [newGroupName, setNewGroupName] = useState('');

  // State for inline editing
  const [editingGroupId, setEditingGroupId] = useState(null);
  const [editingGroupName, setEditingGroupName] = useState('');
  
  // State for expanded group details
  const [expandedGroupId, setExpandedGroupId] = useState(null);
  const [selectedPropertiesToAdd, setSelectedPropertiesToAdd] = useState([]);

  const fetchGroups = useCallback(async () => {
    try {
      setIsLoading(true);
      const data = await getGroups(token);
      setGroups(data);
      setError(''); // Clear previous error on success
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchGroups();
  }, [fetchGroups]);

  const handleCreateGroup = async (e) => {
    e.preventDefault();
    if (!newGroupName.trim()) return; // Check if name is not just whitespace
    try {
      await createGroup({ name: newGroupName.trim() }, token);
      setNewGroupName(''); // Clear input after creation
      fetchGroups(); // Refresh the list
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDeleteGroup = async (groupId) => {
    if (window.confirm("Êtes-vous sûr de vouloir supprimer ce groupe ? Cette action est irréversible.")) {
      try {
        await deleteGroup(groupId, token);
        fetchGroups(); // Refresh the list
      } catch (err) {
        setError(err.message);
      }
    }
  };

  const handleStartEdit = (group) => {
    setEditingGroupId(group.id);
    setEditingGroupName(group.name);
  };

  const handleCancelEdit = () => {
    setEditingGroupId(null);
    setEditingGroupName('');
  };

  const handleSaveEdit = async (groupId) => {
    if (!editingGroupName.trim()) return; // Check if name is not just whitespace
    try {
      await updateGroup(groupId, { name: editingGroupName.trim() }, token);
      handleCancelEdit(); // Reset editing state
      fetchGroups(); // Refresh the list
    } catch (err) {
      setError(err.message);
    }
  };
  
  const handleToggleExpand = (groupId) => {
    setExpandedGroupId(expandedGroupId === groupId ? null : groupId);
    setSelectedPropertiesToAdd([]); // Reset selection on toggle
  };

  const handleAddProperties = async (groupId) => {
    if (selectedPropertiesToAdd.length === 0) return;
    try {
      await addPropertiesToGroup(groupId, selectedPropertiesToAdd, token);
      fetchGroups(); // Refresh the list to update group properties array
      setSelectedPropertiesToAdd([]); // Clear selection
    } catch (err) {
      setError(err.message);
    }
  };

  const handleRemoveProperty = async (groupId, propertyId) => {
    try {
      await removePropertiesFromGroup(groupId, [propertyId], token);
      fetchGroups(); // Refresh the list
    } catch (err) {
      setError(err.message);
    }
  };


  const renderGroupList = () => {
    if (isLoading) {
      return <p className="text-sm text-gray-400">Chargement des groupes...</p>;
    }
    if (groups.length === 0) {
      return <p className="text-sm text-gray-400">Aucun groupe créé pour le moment.</p>;
    }
    return (
      <ul className="space-y-4">
        {groups.map((group) => {
          // Check if properties array exists before mapping
          const propertiesInGroupIds = group.properties || [];
          const propertiesInGroup = propertiesInGroupIds
            .map(propId => properties.find(p => p.id === propId))
            .filter(Boolean); // Filter out undefined if a property was deleted

          const availableProperties = properties.filter(p => !propertiesInGroupIds.includes(p.id));

          return (
            <li key={group.id} className="bg-gray-700 p-4 rounded-md transition-all">
              <div className="flex justify-between items-center">
                {editingGroupId === group.id ? (
                  // Edit mode
                  <>
                    <input
                      type="text"
                      value={editingGroupName}
                      onChange={(e) => setEditingGroupName(e.target.value)}
                      className="flex-grow bg-gray-600 p-1 rounded-md text-white mr-2" // Added margin
                    />
                    <div className="flex gap-2 flex-shrink-0"> {/* Added flex-shrink-0 */}
                      <button onClick={() => handleSaveEdit(group.id)} className="text-xs px-3 py-1 bg-green-600 hover:bg-green-500 rounded-md">OK</button>
                      <button onClick={handleCancelEdit} className="text-xs px-3 py-1 bg-gray-500 hover:bg-gray-400 rounded-md">X</button>
                    </div>
                  </>
                ) : (
                  // Display mode
                  <>
                    <span className="font-semibold">{group.name}</span>
                    <div className="flex gap-2 flex-shrink-0"> {/* Added flex-shrink-0 */}
                      <button onClick={() => handleStartEdit(group)} className="text-xs px-3 py-1 bg-gray-600 hover:bg-gray-500 rounded-md">Modifier</button>
                      <button onClick={() => handleDeleteGroup(group.id)} className="text-xs px-3 py-1 bg-red-800 hover:bg-red-700 rounded-md">Supprimer</button>
                      <button onClick={() => handleToggleExpand(group.id)} className="p-1">{expandedGroupId === group.id ? '▲' : '▼'}</button>
                    </div>
                  </>
                )}
              </div>

              {/* Expanded content */}
              {expandedGroupId === group.id && (
                <div className="mt-4 pt-4 border-t border-gray-600 space-y-4">
                  <div>
                    <h4 className="font-semibold text-sm mb-2">Propriétés dans ce groupe ({propertiesInGroup.length})</h4>
                    {propertiesInGroup.length > 0 ? (
                      <ul className="space-y-2">
                        {propertiesInGroup.map(prop => (
                          <li key={prop.id} className="flex justify-between items-center bg-gray-600 p-2 rounded text-xs">
                            <span>{prop.address}</span>
                            <button onClick={() => handleRemoveProperty(group.id, prop.id)} className="px-2 py-1 bg-red-800 rounded">Retirer</button>
                          </li>
                        ))}
                      </ul>
                    ) : <p className="text-xs text-gray-400">Aucune propriété assignée.</p>}
                  </div>
                  {availableProperties.length > 0 && (
                    <div>
                      <h4 className="font-semibold text-sm mb-2">Ajouter des propriétés disponibles</h4>
                      <div className="flex gap-2">
                        <select
                          multiple
                          value={selectedPropertiesToAdd}
                          onChange={(e) => setSelectedPropertiesToAdd(Array.from(e.target.selectedOptions, option => option.value))}
                          className="flex-grow bg-gray-600 p-2 rounded-md text-xs h-24"
                        >
                          {availableProperties.map(prop => <option key={prop.id} value={prop.id}>{prop.address}</option>)}
                        </select>
                        <button onClick={() => handleAddProperties(group.id)} className="px-4 py-2 font-semibold text-white bg-blue-600 rounded-md self-start">Ajouter</button>
                      </div>
                    </div>
                  )}
                   {availableProperties.length === 0 && (
                     <p className="text-xs text-gray-400 mt-2">Aucune autre propriété disponible à ajouter.</p>
                   )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <div className="bg-gray-800 p-6 rounded-lg">
      <h2 className="text-2xl font-bold mb-4">Gestion des Groupes</h2>
      {error && <p className="text-sm text-red-400 mb-4 bg-red-900/50 p-3 rounded-md">{error}</p>}
      <div className="grid md:grid-cols-2 gap-6">
        {/* Section Mes Groupes */}
        <div>
          <h3 className="font-semibold mb-2">Mes Groupes</h3>
          {renderGroupList()}
        </div>
        {/* Section Créer un groupe */}
        <div>
          <h3 className="font-semibold mb-2">Créer un nouveau groupe</h3>
          <form onSubmit={handleCreateGroup} className="flex gap-2">
            <input
              type="text"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder="Nom du groupe (ex: Villas de luxe)"
              className="flex-grow bg-gray-700 p-2 rounded-md"
            />
            <button type="submit" className="px-4 py-2 font-semibold text-white bg-blue-600 rounded-md hover:bg-blue-700">
              Créer
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

export default GroupsManager;

