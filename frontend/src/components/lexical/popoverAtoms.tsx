import React from 'react';
import { NumberInput } from '../common/NumberInput';
import { CheckboxBox } from '../Checkbox';

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
      role="checkbox"
      aria-checked={checked}
      onClick={onChange}
      className="flex items-center gap-2 w-full py-0.5 text-xs text-text-secondary hover:text-text-primary"
    >
      <CheckboxBox checked={checked} />
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
        role="radio"
        aria-checked={checked}
        // Roving tabindex — the canonical radiogroup pattern: only the checked
        // option is a tab stop; RadioGroup below moves selection with arrows.
        // (Safe here: both consuming groups always have exactly one checked.)
        tabIndex={checked ? 0 : -1}
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

/**
 * Radiogroup container implementing the WAI-ARIA keyboard pattern: one tab stop
 * (the checked RadioRow, via its roving tabIndex) and Arrow keys that move AND
 * select. Pairs with RadioRow above.
 */
export function RadioGroup({ label, children }: { label: string; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => {
        if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(e.key)) return;
        const radios = ref.current
          ? Array.from(ref.current.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
          : [];
        if (radios.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        const active = radios.findIndex(r => r === document.activeElement);
        const current = active >= 0
          ? active
          : radios.findIndex(r => r.getAttribute('aria-checked') === 'true');
        const delta = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
        const next = radios[(Math.max(current, 0) + delta + radios.length) % radios.length];
        next.focus();
        next.click(); // arrows move AND select, per the ARIA radio pattern
      }}
    >
      {children}
    </div>
  );
}

// Thin wrapper kept for back-compat with token popover call sites — delegates to the
// shared NumberInput. The `width` prop (in px) is applied as an inline width on the
// wrapper span and the inner input is told to fill it via `inputWidth="w-full"`.
// Earlier draft tried `inputWidth={\`w-[${width}px]\`}` — Tailwind's static extractor
// can't see runtime template-literal classes, so those widths were never generated and
// the chip rendered without any width. Inline style sidesteps that completely.
export function NumInput({
  value,
  onChange,
  disabled,
  min = 0,
  width = 54,
  thousands,
  suffix,
  suffixInside,
}: {
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
  min?: number;
  width?: number;
  thousands?: boolean;
  suffix?: string;
  suffixInside?: boolean;
}) {
  return (
    <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex', width }}>
      <NumberInput
        value={value}
        onChange={onChange}
        min={min}
        disabled={disabled}
        inputWidth="w-full"
        inputHeight="h-7"
        thousands={thousands}
        suffix={suffix}
        suffixInside={suffixInside}
      />
    </span>
  );
}
