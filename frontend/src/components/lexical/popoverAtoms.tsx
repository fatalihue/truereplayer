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
        // Never hijack arrows originating in a text-entry element nested in a row's
        // input slot (Pick #s spec, NumInputs) — caret movement / steppers must win.
        // Same guard family as the app's global contentEditable keyguards.
        const target = e.target as HTMLElement;
        if (target.closest('input, textarea, [contenteditable="true"]')) return;
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
/**
 * A modifier argument that is either a literal number or a REFERENCE to run state ("@i",
 * "@counter", "@row"). The `@` button flips between the two; the reference is stored verbatim so
 * the token round-trips byte-for-byte, which matters because the popover REBUILDS the whole token
 * on every edit — anything this control cannot represent would be silently erased on the first
 * checkbox tick.
 *
 * Deliberately one control rather than two fields: the two are mutually exclusive at the grammar
 * level (a chain segment is one or the other), and a UI that let both be filled would have to
 * invent a precedence rule that the backend does not have.
 */
export function ArgInput({
  value,
  onChange,
  refValue,
  onRefChange,
  disabled,
  min = 0,
  width = 54,
  refPlaceholder = '@name',
  refTip,
  numTip,
}: {
  value: number;
  onChange: (n: number) => void;
  refValue: string;
  onRefChange: (r: string) => void;
  disabled?: boolean;
  min?: number;
  width?: number;
  refPlaceholder?: string;
  refTip?: string;
  numTip?: string;
}) {
  const isRef = !!refValue;
  return (
    <span onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1">
      {isRef ? (
        <input
          type="text"
          value={refValue}
          disabled={disabled}
          placeholder={refPlaceholder}
          onChange={(e) => {
            // Keep the sigil pinned to the front: the value IS the chain segment, and a segment
            // without it would silently become a literal that fails to parse.
            const raw = e.target.value.replace(/[^A-Za-z0-9_@]/g, '');
            onRefChange('@' + raw.replace(/@/g, ''));
          }}
          className="h-7 px-1.5 rounded bg-bg-input border border-border-subtle text-[11px] font-mono text-text-primary focus:outline-none focus:border-accent-solid disabled:opacity-50"
          style={{ width: width + 22 }}
        />
      ) : (
        <span style={{ display: 'inline-flex', width }}>
          <NumberInput
            value={value}
            onChange={onChange}
            min={min}
            disabled={disabled}
            inputWidth="w-full"
            inputHeight="h-7"
          />
        </span>
      )}
      <button
        type="button"
        disabled={disabled}
        data-tip={isRef ? numTip : refTip}
        onClick={() => onRefChange(isRef ? '' : '@')}
        className={`h-7 w-6 shrink-0 rounded border text-[11px] font-mono transition-colors disabled:opacity-40 ${
          isRef
            ? 'bg-accent-solid border-accent-solid text-[color:var(--color-accent-ink)]'
            : 'bg-bg-input border-border-subtle text-text-tertiary hover:text-text-primary hover:border-border-strong'
        }`}
      >
        @
      </button>
    </span>
  );
}

export function NumInput({
  value,
  onChange,
  onClear,
  disabled,
  min = 0,
  width = 54,
  thousands,
  suffix,
  suffixInside,
  placeholder,
  ariaLabel,
}: {
  // `null` renders the field blank with `placeholder` showing. Pass `onClear` alongside it when
  // blank carries meaning the parent must store — an open-ended span uses this for "no bound".
  value: number | null;
  onChange: (n: number) => void;
  onClear?: () => void;
  disabled?: boolean;
  min?: number;
  width?: number;
  thousands?: boolean;
  suffix?: string;
  suffixInside?: boolean;
  placeholder?: string;
  ariaLabel?: string;
}) {
  return (
    <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex', width }}>
      <NumberInput
        value={value}
        onChange={onChange}
        onClear={onClear}
        min={min}
        disabled={disabled}
        inputWidth="w-full"
        inputHeight="h-7"
        thousands={thousands}
        suffix={suffix}
        suffixInside={suffixInside}
        placeholder={placeholder}
        ariaLabel={ariaLabel}
      />
    </span>
  );
}
