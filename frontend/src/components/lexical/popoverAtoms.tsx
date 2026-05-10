import React from 'react';

// Small UI primitives shared by the Advanced Clipboard insert popover and the
// chip click-to-edit popover. Pure presentational — no business logic here.

export function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-3.5 py-1.5 border-b border-border-subtle">
      <div className="text-[10px] uppercase tracking-wide font-semibold text-text-tertiary mb-1">{label}</div>
      {children}
    </div>
  );
}

export function CheckRow({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      className="flex items-center gap-2 w-full py-0.5 text-xs text-text-secondary hover:text-text-primary"
    >
      <span
        className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center shrink-0 ${
          checked ? 'bg-accent-solid border-accent-solid' : 'bg-bg-input border-border-default'
        }`}
      >
        {checked && (
          <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
            <path d="M2 6.5L4.5 9L10 3" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <span className="flex-1 text-left">{label}</span>
    </button>
  );
}

export function RadioRow({
  checked,
  onChange,
  label,
  input,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  input?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 py-0.5 text-xs">
      <button
        type="button"
        onClick={onChange}
        className="flex items-center gap-2 flex-1 text-left text-text-secondary hover:text-text-primary"
      >
        <span
          className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center shrink-0 transition-colors ${
            checked ? 'bg-accent-solid border-accent-solid' : 'bg-bg-input border-border-default'
          }`}
        >
          {checked && <span className="w-[5px] h-[5px] rounded-full bg-white" />}
        </span>
        <span className="flex-1">{label}</span>
      </button>
      {input}
    </div>
  );
}

export function NumInput({
  value,
  onChange,
  disabled,
  min = 0,
  width = 54,
}: {
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
  min?: number;
  width?: number;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      disabled={disabled}
      onChange={(e) => {
        const n = parseInt(e.target.value, 10);
        if (!isNaN(n)) onChange(n);
      }}
      onClick={(e) => e.stopPropagation()}
      style={{ width }}
      className="h-7 px-1 text-[12px] font-mono text-center rounded border outline-none transition-colors bg-bg-input border-border-default text-text-primary focus:border-accent-solid disabled:opacity-50 disabled:cursor-not-allowed"
    />
  );
}
