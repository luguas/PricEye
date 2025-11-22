import React from 'react';

export const PremiReStats = ({ 
  state = "big", 
  text,
  value,
  icon: Icon,
  iconState,
  className = '',
  ...props 
}) => {
  const variantsClassName = "state-" + state;

  return (
    <div
      className={
        "bg-global-bg-box rounded-[14px] border-solid border-global-stroke-box border p-4 flex flex-col gap-2 items-start justify-center self-stretch flex-1 relative overflow-hidden " +
        className +
        " " +
        variantsClassName
      }
      {...props}
    >
      <div className="flex flex-row items-center justify-between self-stretch shrink-0 relative">
        <div className="flex flex-col gap-0 items-start justify-start flex-1 relative">
          <div className="text-global-inactive text-left font-p1-font-family text-p1-font-size font-p1-font-weight relative">
            {text || "Taux d'occupation (Réel)"}{" "}
          </div>
          <div className="text-global-blanc text-left font-h1-font-family text-h1-font-size font-h1-font-weight relative">
            {value || "12.5%"}{" "}
          </div>
        </div>
        {Icon && (
          <div
            className="rounded-[10px] border-solid border-global-stroke-highlight-2nd border flex flex-col gap-2.5 items-center justify-center shrink-0 w-[50px] h-[50px] relative"
            style={{
              background:
                "var(--global-bg-highlight-2nd, linear-gradient(90deg, rgba(21, 93, 252, 0.20) 0%,rgba(0, 146, 184, 0.20) 100%))",
              aspectRatio: "1",
            }}
          >
            <Icon state={iconState} className="!w-6 !h-6" />
          </div>
        )}
      </div>
    </div>
  );
};

export default PremiReStats;

