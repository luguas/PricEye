import React, { useState } from 'react';
import { createGroup, deleteGroup } from '../services/api.js';
import ConfirmModal from './ConfirmModal.jsx';
import GroupEditModal from './GroupEditModal.jsx';
import { useLanguage } from '../contexts/LanguageContext.jsx';

// Icônes SVG
const EditIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="w-4 h-4">
    <path d="M11.333 2.00001C11.5084 1.82465 11.7163 1.68571 11.9447 1.59203C12.1731 1.49835 12.4173 1.4519 12.6637 1.45564C12.91 1.45938 13.1531 1.51324 13.3782 1.61395C13.6033 1.71466 13.8057 1.85999 13.9733 2.04001C14.1409 2.22003 14.2701 2.43145 14.3533 2.66108C14.4365 2.89071 14.4719 3.13399 14.4573 3.37668C14.4427 3.61937 14.3785 3.85648 14.2687 4.07334C14.1589 4.2902 14.0058 4.48235 13.8187 4.63868L5.81866 12.6387L1.33333 14.0001L2.69466 9.51468L10.6947 1.51468L11.333 2.00001Z" stroke="white" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const PlusIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="w-5 h-5">
    <path d="M10 4V16M4 10H16" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

// Accepter groups et groupsLoading du parent pour éviter double fetch ; onGroupChange, onEditStrategy, onEditRules
function GroupsManager({ token, properties, groups = [], groupsLoading = false, onGroupChange, onEditStrategy, onEditRules, userProfile }) {
  const { t, language } = useLanguage();
  const [error, setError] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);

  // État pour la modale d'édition
  const [editingGroup, setEditingGroup] = useState(null);

  // État pour la modale de confirmation
  const [confirmModal, setConfirmModal] = useState({ isOpen: false, message: '', onConfirm: null });

  const handleCreateGroup = async (e) => {
    e.preventDefault();
    if (!newGroupName.trim()) return; 
    try {
      await createGroup({ name: newGroupName.trim() }, token);
      setNewGroupName(''); 
      setShowCreateForm(false);
      onGroupChange();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDeleteGroup = async (groupId) => {
    setConfirmModal({
      isOpen: true,
      message: t('groupsManager.deleteConfirm'),
      onConfirm: async () => {
        try {
          await deleteGroup(groupId, token);
          onGroupChange();
        } catch (err) {
          setError(err.message);
        }
      }
    });
  };

  const handleEditGroup = (group) => {
    setEditingGroup(group);
  };

  const handleCloseEditModal = () => {
    setEditingGroup(null);
  };

  const handleSaveEditModal = () => {
    onGroupChange();
  };


  // Formater la devise
  const formatCurrency = (amount) => {
    const currency = userProfile?.currency || 'EUR';
    const locale = language === 'en' ? 'en-US' : 'fr-FR';
    return (amount || 0).toLocaleString(locale, { 
      style: 'currency', 
      currency: currency, 
      minimumFractionDigits: 0, 
      maximumFractionDigits: 0 
    });
  };

  const renderGroupList = () => {
    if (groupsLoading) {
      return <p className="text-sm text-global-inactive">{t('groupsManager.loading')}</p>;
    }
    if (!groups || groups.length === 0) {
      return <p className="text-sm text-global-inactive">{t('groupsManager.noGroups')}</p>;
    }
    return (
      <div className="space-y-4 self-stretch w-full">
        {groups.map((group) => {
          const propertiesInGroupIds = group.properties || [];
          const propertiesInGroup = propertiesInGroupIds
            .map(propId => properties.find(p => p.id === propId))
            .filter(Boolean); 

          const availableProperties = properties.filter(p => !propertiesInGroupIds.includes(p.id));

          // Données pour l'affichage
          const pricingStrategyData = [
            { label: t('groupsManager.floor'), value: formatCurrency(group.floor_price || 0) },
            { label: t('groupsManager.base'), value: formatCurrency(group.base_price || 0) },
            { label: t('groupsManager.ceiling'), value: formatCurrency(group.ceiling_price || 0) },
          ];

          const stayDurationData = [
            { label: t('groupsManager.minimum'), value: `${group.min_stay_duration || 0} ${t('groupsManager.nights')}` },
            { label: t('groupsManager.maximum'), value: `${group.max_stay_duration || 0} ${t('groupsManager.nights')}` },
          ];

          const pricingRulesData = [
            { label: t('groupsManager.longStayDiscount'), value: group.long_stay_discount ? `-${group.long_stay_discount}%` : "-" },
            { label: t('groupsManager.markups'), value: group.markup ? `+${group.markup}%` : "-" },
          ];

          const strategyLabel = group.strategy || t('strategyModal.balanced');

          return (
            <article key={group.id} className="flex flex-col items-start gap-4 p-6 relative bg-[#1d293d80] rounded-[10px] border border-solid border-[#31415780] self-stretch w-full">
              <header className="flex items-start justify-between relative self-stretch w-full flex-[0_0_auto]">
                <div className="flex-col items-start flex-1 grow flex relative">
                  <div className="h-7 items-center gap-3 self-stretch w-full flex relative">
                    <h2 className="relative w-fit mt-[-0.50px] font-h3-font-family font-h3-font-weight text-white text-h3-font-size leading-h3-line-height">
                      {group.name}
                    </h2>
                    <span className="inline-flex items-start px-2 py-1 relative flex-[0_0_auto] mt-[-1.50px] mb-[-1.50px] rounded border border-solid border-global-stroke-highlight-2nd bg-[linear-gradient(90deg,rgba(21,93,252,0.2)_0%,rgba(0,146,184,0.2)_100%)]">
                      <span className="relative w-fit font-p1-font-family font-p1-font-weight text-global-content-highlight-2nd text-p1-font-size leading-p1-line-height">
                        {strategyLabel}
                      </span>
                    </span>
                  </div>
                  <p className="relative w-fit font-p1-font-family font-p1-font-weight text-global-inactive text-p1-font-size leading-p1-line-height">
                    {propertiesInGroup.length} {propertiesInGroup.length > 1 ? t('common.properties') : t('common.property')}
                  </p>
                </div>
                <div className="h-8 items-start justify-end gap-2 flex-1 grow flex relative">
                  <button
                    className="all-[unset] box-border inline-flex h-8 items-center gap-4 px-3 py-1 relative flex-[0_0_auto] bg-global-bg-small-box rounded-lg border border-solid border-global-stroke-box cursor-pointer"
                    type="button"
                    onClick={() => handleEditGroup(group)}
                    aria-label={t('groupsManager.edit')}
                  >
                    <span className="relative w-4 h-4" aria-hidden="true">
                      <EditIcon />
                    </span>
                    <span className="relative w-fit font-h4-font-family font-normal text-white text-sm text-center tracking-[0] leading-5 whitespace-nowrap">
                      {t('groupsManager.edit')}
                    </span>
                  </button>
                </div>
              </header>

              <div className="items-start gap-4 self-stretch w-full flex-[0_0_auto] flex relative">
                {/* Stratégie de prix */}
                <section className="flex-col items-start gap-2 p-4 flex-1 self-stretch grow bg-[#0f172b80] rounded-[10px] flex relative">
                  <h3 className="relative w-fit mt-[-1.00px] font-h4-font-family font-h4-font-weight text-global-inactive text-h4-font-size leading-h4-line-height">
                    {t('groupsManager.pricingStrategy')}
                  </h3>
                  <dl className="flex-col items-start gap-1 self-stretch w-full flex-[0_0_auto] flex relative">
                    {pricingStrategyData.map((item, index) => (
                      <div
                        key={index}
                        className="flex items-start justify-between relative self-stretch w-full flex-[0_0_auto]"
                      >
                        <dt className="relative w-fit mt-[-1.00px] font-p1-font-family font-p1-font-weight text-global-inactive text-p1-font-size leading-p1-line-height">
                          {item.label}
                        </dt>
                        <dd className="relative w-fit mt-[-1.00px] font-p1-font-family font-p1-font-weight text-global-content-highlight-3rd text-p1-font-size leading-p1-line-height">
                          {item.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>

                {/* Durée du séjour */}
                <section className="flex-col items-start gap-2 pt-4 pb-0 px-4 flex-1 self-stretch grow bg-[#0f172b80] rounded-[10px] flex relative">
                  <h3 className="relative w-fit mt-[-1.00px] font-h4-font-family font-h4-font-weight text-global-inactive text-h4-font-size leading-h4-line-height">
                    {t('groupsManager.stayDuration')}
                  </h3>
                  <dl className="flex flex-col items-start gap-1 relative self-stretch w-full flex-[0_0_auto]">
                    {stayDurationData.map((item, index) => (
                      <div
                        key={index}
                        className="flex items-start justify-between relative self-stretch w-full flex-[0_0_auto]"
                      >
                        <dt className="relative w-fit mt-[-1.00px] font-p1-font-family font-p1-font-weight text-global-inactive text-p1-font-size leading-p1-line-height">
                          {item.label}
                        </dt>
                        <dd className="relative w-fit mt-[-1.00px] font-p1-font-family font-p1-font-weight text-white text-p1-font-size leading-p1-line-height">
                          {item.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>

                {/* Règles de pricing */}
                <section className="flex-col items-start gap-2 pt-4 pb-0 px-4 flex-1 self-stretch grow bg-[#0f172b80] rounded-[10px] flex relative">
                  <h3 className="relative w-fit mt-[-1.00px] font-p1-font-family font-p1-font-weight text-global-inactive text-p1-font-size leading-p1-line-height">
                    {t('groupsManager.pricingRules')}
                  </h3>
                  <dl className="flex-col items-start gap-1 self-stretch w-full flex-[0_0_auto] flex relative">
                    {pricingRulesData.map((item, index) => (
                      <div
                        key={index}
                        className="flex items-start justify-between relative self-stretch w-full flex-[0_0_auto]"
                      >
                        <dt
                          className={`relative ${index === 0 ? "flex-1" : "w-fit"} mt-[-1.00px] font-p1-font-family font-p1-font-weight text-global-inactive text-p1-font-size leading-p1-line-height`}
                        >
                          {item.label}
                        </dt>
                        <dd className="relative w-fit mt-[-1.00px] font-p1-font-family font-p1-font-weight text-global-content-highlight-3rd text-p1-font-size leading-p1-line-height">
                          {item.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              </div>
            </article>
          );
        })}
      </div>
    );
  };

  return (
    <div className="flex flex-col items-start gap-6 p-[25px] relative bg-global-bg-box rounded-[14px] border border-solid border-global-stroke-box">
      {/* Header avec titre et bouton de création */}
      <header className="flex items-center justify-between relative self-stretch w-full flex-[0_0_auto]">
        <h1 className="relative w-fit font-h2-font-family font-h2-font-weight text-global-blanc text-h2-font-size leading-h2-line-height">
          {t('groupsManager.title')}
        </h1>
        <button
          type="button"
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="inline-flex items-center justify-center gap-2 px-3 py-2 relative flex-[0_0_auto] rounded-[10px] bg-[linear-gradient(90deg,rgba(21,93,252,1)_0%,rgba(18,161,213,1)_100%)] cursor-pointer border-0 transition-opacity hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[rgba(21,93,252,1)]"
          aria-label={t('groupsManager.createGroup')}
        >
          <PlusIcon />
          <span className="relative w-fit mt-[-1.00px] font-h3-font-family font-h3-font-weight text-global-blanc text-h3-font-size leading-h3-line-height">
            {t('groupsManager.createGroup')}
          </span>
        </button>
      </header>

      {error && <p className="text-sm text-red-400 mb-4 bg-red-900/40 border border-red-500/40 p-3 rounded-md">{error}</p>}
      
      {/* Formulaire de création (affiché conditionnellement) */}
      {showCreateForm && (
        <form onSubmit={handleCreateGroup} className="self-stretch flex gap-2 p-4 bg-global-bg-small-box rounded-[10px] border border-global-stroke-box">
          <input
            type="text"
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            placeholder={t('groupsManager.groupNamePlaceholder')}
            className="flex-grow bg-transparent border border-global-stroke-box text-global-blanc placeholder:text-global-inactive rounded-[10px] px-3 py-2 focus:outline-none"
            autoFocus
          />
          <button type="submit" className="px-4 py-2 font-semibold text-white rounded-[10px] bg-gradient-to-r from-[#155dfc] to-[#12a1d5] hover:opacity-90">
            {t('groupsManager.create')}
          </button>
          <button 
            type="button"
            onClick={() => { setShowCreateForm(false); setNewGroupName(''); }}
            className="px-4 py-2 text-global-inactive hover:text-global-blanc rounded-[10px] border border-global-stroke-box"
          >
            {t('groupsManager.cancel')}
          </button>
        </form>
      )}
      
      {/* Liste des groupes */}
      {renderGroupList()}

      {/* Modale de confirmation */}
      <ConfirmModal
        isOpen={confirmModal.isOpen}
        onClose={() => setConfirmModal({ isOpen: false, message: '', onConfirm: null })}
        onConfirm={confirmModal.onConfirm || (() => {})}
        title={t('confirmModal.title')}
        message={confirmModal.message}
        confirmText={t('common.confirm')}
        cancelText={t('common.cancel')}
      />

      {/* Modale d'édition de groupe */}
      {editingGroup && (
        <GroupEditModal
          token={token}
          onClose={handleCloseEditModal}
          onSave={handleSaveEditModal}
          group={editingGroup}
          properties={properties}
          userProfile={userProfile}
        />
      )}
    </div>
  );
}

export default GroupsManager;

