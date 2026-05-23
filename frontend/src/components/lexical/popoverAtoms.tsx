import React from 'react';
import { NumberInput } from '../common/NumberInput';

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

// Thin wrapper kept for back-compat with token popover call sites — delegates to the
// shared NumberInput. The `width` prop (in px) is translated to an inline style on a
// wrapping span so existing layout constraints don't drift.
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
    <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex' }}>
      <NumberInput
        value={value}
        onChange={onChange}
        min={min}
        disabled={disabled}
        inputWidth={`w-[${width}px]`}
        inputHeight="h-7"
      />
    </span>
  );
}
