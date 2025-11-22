import React from 'react';

export const BoutonStatePrincipal = ({ state = "principal", component, text, className, onClick, ...props }) => {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-[10px] border border-solid border-global-stroke-highlight-2nd pt-2 pr-3 pb-2 pl-3 flex flex-row gap-2 items-center justify-center relative cursor-pointer transition-opacity hover:opacity-90 bg-[linear-gradient(90deg,rgba(21,93,252,1)_0%,rgba(18,161,213,1)_100%)] ${className}`}
      {...props}
    >
      {component}
      {text && (
        <div className="text-global-blanc text-left font-h3-font-family text-h3-font-size font-h3-font-weight relative">
          {text}
        </div>
      )}
    </button>
  );
};

export default BoutonStatePrincipal;

