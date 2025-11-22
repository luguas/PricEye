import React from 'react';

export const PremiReStatsStateSmall = ({ 
  state = "small", 
  component, 
  text, 
  text2, 
  text3, 
  text4, 
  className = '',
  ...props 
}) => {
  return (
    <div
      className={`bg-global-bg-box rounded-[14px] border border-solid border-global-stroke-box p-4 flex flex-col gap-2 items-start justify-center flex-1 relative overflow-hidden ${className}`}
      {...props}
    >
      <div className="flex flex-row items-center justify-between self-stretch shrink-0 relative w-full">
        <div className="flex flex-col gap-0 items-start justify-start flex-1 relative min-w-0">
          <div className="text-global-inactive text-left font-p1-font-family text-p1-font-size font-p1-font-weight relative">
            {text}
          </div>
          <div className="text-global-blanc text-left font-h1-font-family text-h1-font-size font-h1-font-weight font-bold relative">
            {text2 || '—'}
          </div>
          {text3 && (
            <div className="text-global-positive-impact text-left font-p1-font-family text-p1-font-size font-p1-font-weight relative">
              {text3}
            </div>
          )}
          {text4 && (
            <div className="text-global-inactive text-left font-p1-font-family text-p1-font-size font-p1-font-weight relative">
              {text4}
            </div>
          )}
        </div>
        {component && (
          <div
            className="rounded-[10px] border border-solid border-global-stroke-highlight-2nd flex flex-col gap-2.5 items-center justify-center shrink-0 w-[50px] h-[50px] relative"
            style={{
              background: 'linear-gradient(90deg, rgba(21, 93, 252, 0.20) 0%, rgba(0, 146, 184, 0.20) 100%)',
              aspectRatio: '1',
            }}
          >
            {component}
          </div>
        )}
      </div>
    </div>
  );
};

export default PremiReStatsStateSmall;

