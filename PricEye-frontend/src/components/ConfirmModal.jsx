import React from 'react';

const ConfirmModal = ({ isOpen, onClose, onConfirm, title = 'Confirmation', message, confirmText = 'Confirmer', cancelText = 'Annuler' }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div 
        className="bg-global-bg-box rounded-[14px] border border-solid border-global-stroke-box p-6 flex flex-col gap-4 items-start justify-start w-full max-w-md relative"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-global-blanc text-left font-h2-font-family text-h2-font-size font-h2-font-weight relative w-full">
          {title}
        </div>
        <div className="text-global-inactive text-left font-p1-font-family text-p1-font-size font-p1-font-weight relative w-full">
          {message}
        </div>
        <div className="flex flex-row gap-3 items-start justify-end self-stretch shrink-0 relative w-full">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 relative rounded-[10px] border border-solid border-global-stroke-highlight-2nd bg-transparent cursor-pointer hover:opacity-90 transition-opacity"
          >
            <span className="relative w-fit font-h3-font-family font-h3-font-weight text-global-inactive text-h3-font-size leading-h3-line-height">
              {cancelText}
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              onConfirm();
              onClose();
            }}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 relative rounded-[10px] bg-[linear-gradient(90deg,rgba(21,93,252,1)_0%,rgba(18,161,213,1)_100%)] cursor-pointer border-0 transition-opacity hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[rgba(21,93,252,1)]"
          >
            <span className="relative w-fit font-h3-font-family font-h3-font-weight text-global-blanc text-h3-font-size leading-h3-line-height">
              {confirmText}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmModal;


