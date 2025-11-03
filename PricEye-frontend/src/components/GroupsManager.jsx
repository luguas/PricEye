import React, { useState, useEffect, useCallback } from 'react';
import { getGroups, createGroup, updateGroup, deleteGroup, addPropertiesToGroup, removePropertiesFromGroup } from '../services/api.js';

// Accepter onGroupChange, onEditStrategy, onEditRules
function GroupsManager({ token, properties, onGroupChange, onEditStrategy, onEditRules }) {
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
      setError(''); 
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
    if (!newGroupName.trim()) return; 
    try {
      await createGroup({ name: newGroupName.trim() }, token);
      setNewGroupName(''); 
      fetchGroups(); 
      onGroupChange(); // Notifier le parent (Dashboard)
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDeleteGroup = async (groupId) => {
    if (window.confirm("Êtes-vous sûr de vouloir supprimer ce groupe ? Cette action est irréversible.")) {
      try {
        await deleteGroup(groupId, token);
        fetchGroups(); 
        onGroupChange();
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
    if (!editingGroupName.trim()) return; 
    try {
      await updateGroup(groupId, { name: editingGroupName.trim() }, token);
      handleCancelEdit(); 
      fetchGroups(); 
    } catch (err) {
      setError(err.message);
    }
  };
  
  const handleToggleExpand = (groupId) => {
    setExpandedGroupId(expandedGroupId === groupId ? null : groupId);
    setSelectedPropertiesToAdd([]); 
  };

  const handleAddProperties = async (groupId) => {
    if (selectedPropertiesToAdd.length === 0) return;
    try {
      await addPropertiesToGroup(groupId, selectedPropertiesToAdd, token);
      fetchGroups(); 
      setSelectedPropertiesToAdd([]); 
      onGroupChange(); // Re-vérifier les recommandations
    } catch (err) {
      setError(err.message);
    }
  };

  const handleRemoveProperty = async (groupId, propertyId) => {
    try {
      await removePropertiesFromGroup(groupId, [propertyId], token);
      fetchGroups(); 
      onGroupChange();
    } catch (err) {
      setError(err.message);
    }
  };
  
  const handleSetMainProperty = async (groupId, propertyId) => {
    try {
      await updateGroup(groupId, { mainPropertyId: propertyId }, token);
      fetchGroups(); 
    } catch (err) {
      setError(err.message);
    }
  };

  const handleToggleSync = async (group) => {
    try {
      await updateGroup(group.id, { syncPrices: !group.syncPrices }, token);
      fetchGroups(); 
    } catch (err) {
      setError(err.message);
    }
  };


  const renderGroupList = () => {
    if (isLoading) {
      return <p className="text-sm text-text-muted">Chargement des groupes...</p>;
    }
    if (groups.length === 0) {
      return <p className="text-sm text-text-muted">Aucun groupe créé pour le moment.</p>;
    }
    return (
      <ul className="space-y-4">
        {groups.map((group) => {
          const propertiesInGroupIds = group.properties || [];
          const propertiesInGroup = propertiesInGroupIds
            .map(propId => properties.find(p => p.id === propId))
            .filter(Boolean); 

          const availableProperties = properties.filter(p => !propertiesInGroupIds.includes(p.id));

          return (
            <li key={group.id} className="bg-bg-tertiary p-4 rounded-md transition-all shadow">
              <div className="flex justify-between items-center">
                {editingGroupId === group.id ? (
                  <>
                    <input
                      type="text"
                      value={editingGroupName}
                      onChange={(e) => setEditingGroupName(e.target.value)}
                      className="form-input flex-grow bg-bg-muted p-1 rounded-md text-text-primary mr-2"
                    />
                    <div className="flex gap-2 flex-shrink-0">
                      <button onClick={() => handleSaveEdit(group.id)} className="text-xs px-3 py-1 bg-green-600 hover:bg-green-500 text-white rounded-md">OK</button>
                      <button onClick={handleCancelEdit} className="text-xs px-3 py-1 bg-bg-muted hover:bg-border-primary text-text-secondary rounded-md">X</button>
                    </div>
                  </>
                ) : (
                  <>
                    <span className="font-semibold text-text-primary">{group.name}</span>
                    <div className="flex gap-2 flex-shrink-0">
                      <button onClick={() => onEditStrategy(group)} className="text-xs px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded-md">Stratégie</button>
                      <button onClick={() => onEditRules(group)} className="text-xs px-3 py-1 bg-purple-600 hover:bg-purple-500 text-white rounded-md">Règles</button>
                      <button onClick={() => handleStartEdit(group)} className="text-xs px-3 py-1 bg-bg-muted hover:bg-border-primary text-text-secondary rounded-md">Renommer</button>
                      <button onClick={() => handleDeleteGroup(group.id)} className="text-xs px-3 py-1 bg-red-800 hover:bg-red-700 text-white rounded-md">Supprimer</button>
                      <button onClick={() => handleToggleExpand(group.id)} className="p-1 text-xl text-text-muted">{expandedGroupId === group.id ? '−' : '＋'}</button>
                    </div>
                  </>
                )}
              </div>

              {/* Expanded content */}
              {expandedGroupId === group.id && (
                <div className="mt-4 pt-4 border-t border-border-primary space-y-4">
                  
                  <label className="flex items-center gap-2 text-sm text-text-primary">
                      <input
                          type="checkbox"
                          checked={!!group.syncPrices}
                          onChange={() => handleToggleSync(group)}
                          className="rounded bg-bg-muted border-border-primary text-blue-500 focus:ring-blue-500"
                      />
                      Synchroniser les prix de l'IA pour ce groupe
                  </label>
                  
                  <div>
                    <h4 className="font-semibold text-sm mb-2 text-text-primary">Propriétés dans ce groupe ({propertiesInGroup.length})</h4>
                    {propertiesInGroup.length > 0 ? (
                      <ul className="space-y-2">
                        {propertiesInGroup.map(prop => (
                          <li key={prop.id} className="flex justify-between items-center bg-bg-muted p-2 rounded text-xs">
                            <span className="text-text-secondary">{prop.address}</span>
                            <div className="flex items-center gap-2">
                              {group.mainPropertyId === prop.id ? (
                                <span className="px-2 py-0.5 bg-blue-600 text-white rounded-full text-[10px] font-bold">Principal</span>
                              ) : (
                                <button onClick={() => handleSetMainProperty(group.id, prop.id)} className="px-2 py-1 bg-gray-500 hover:bg-blue-600 rounded text-[10px] text-white">Définir principal</button>
                              )}
                              <button onClick={() => handleRemoveProperty(group.id, prop.id)} className="px-2 py-1 bg-red-800 text-white rounded">Retirer</button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : <p className="text-xs text-text-muted">Aucune propriété assignée.</p>}
                  </div>

                  {availableProperties.length > 0 && (
                    <div>
                      <h4 className="font-semibold text-sm mb-2 text-text-primary">Ajouter des propriétés disponibles</h4>
                      <div className="flex gap-2">
                        <select
                          multiple
                          value={selectedPropertiesToAdd}
                          onChange={(e) => setSelectedPropertiesToAdd(Array.from(e.target.selectedOptions, option => option.value))}
                          className="form-input flex-grow bg-bg-muted p-2 rounded-md text-xs h-24 border-border-primary text-text-primary"
                        >
                          {availableProperties.map(prop => <option key={prop.id} value={prop.id}>{prop.address}</option>)}
                        </select>
                        <button onClick={() => handleAddProperties(group.id)} className="px-4 py-2 font-semibold text-white bg-blue-600 rounded-md self-start">Ajouter</button>
                      </div>
                    </div>
                  )}
                   {availableProperties.length === 0 && propertiesInGroup.length > 0 && (
                     <p className="text-xs text-text-muted mt-2">Toutes vos propriétés sont dans ce groupe.</p>
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
    <div className="bg-bg-secondary p-6 rounded-lg shadow-lg">
      <h2 className="text-2xl font-bold mb-4 text-text-primary">Gestion des Groupes</h2>
      {error && <p className="text-sm text-red-400 mb-4 bg-red-900/50 p-3 rounded-md">{error}</p>}
      <div className="grid md:grid-cols-2 gap-6">
        {/* Section Mes Groupes */}
        <div>
          <h3 className="font-semibold mb-2 text-text-primary">Mes Groupes</h3>
          {renderGroupList()}
        </div>
        {/* Section Créer un groupe */}
        <div>
          <h3 className="font-semibold mb-2 text-text-primary">Créer un nouveau groupe</h3>
          <form onSubmit={handleCreateGroup} className="flex gap-2">
            <input
              type="text"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder="Nom du groupe (ex: Villas de luxe)"
              className="form-input flex-grow bg-bg-muted p-2 rounded-md border-border-primary text-text-primary"
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

