import { Check, Minus } from 'lucide-react';
import type { MouseEvent } from 'react';

interface CheckboxProps {
  checked: boolean;
  /** Tri-state support: shows a dash glyph when true, regardless of `checked`. */
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  /** Optional text shown next to the box. Omit for box-only (e.g. table row selection). */
  label?: string;
  title?: string;
  /** Stop click from bubbling to parent (useful inside row/list items with their own onClick). */
  stopPropagation?: boolean;
  /** Non-interactive: dimmed box + subtle border (two channels), clicks ignored.
   *  Pair with `title` — [data-tip][disabled] keeps pointer-events alive so a
   *  disabled box can still explain WHY it is off (the Button doctrine). */
  disabled?: boolean;
  /** Extra classes on the outer button (typically for layout/spacing tweaks). */
  className?: string;
}

/**
 * Themed checkbox replacing the native <input type="checkbox">. Native checkboxes
 * render with a white background when unchecked, which clashes with dark themes.
 *
 * Behavior (matches the original .checkbox-subtle style):
 *   - Unchecked: transparent fill + 1.5px border (subtle outline, blends with row bg)
 *   - Checked:   accent-solid fill, glyph in --color-accent-ink (contrast-picked per theme)
 *   - Indeterminate: accent fill, dash glyph (for partial-selection cases)
 */
export function Checkbox({
  checked,
  indeterminate,
  onChange,
  label,
  title,
  stopPropagation,
  disabled = false,
  className = '',
}: CheckboxProps) {
  const filled = checked || !!indeterminate;

  const handleClick = (e: MouseEvent) => {
    if (stopPropagation) e.stopPropagation();
    onChange(!checked);
  };

  return (
    // Native `disabled` alone carries the whole disabled contract (no click dispatch
    // in Chromium even with the [data-tip][disabled] pointer-events restore, and the
    // state is exposed to AT) — same single mechanism Button.tsx relies on.
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      disabled={disabled}
      onClick={handleClick}
      data-tip={title}
      className={`flex items-center gap-2 select-none group ${
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
      } ${className}`}
    >
      <span
        className={`w-3.5 h-3.5 rounded border-[1.5px] flex items-center justify-center transition-colors shrink-0 ${
          filled
            ? 'bg-accent-solid border-accent-solid'
            : disabled
              ? 'bg-transparent border-border-subtle'
              : 'bg-transparent border-border-default group-hover:border-text-tertiary'
        }`}
      >
        {/* Glyph ink is contrast-picked per theme (accent-ink), never white: on a
            light preset with a light accent-solid a white check disappears. */}
        {indeterminate ? (
          <Minus size={10} strokeWidth={3} className="text-[color:var(--color-accent-ink)]" />
        ) : checked ? (
          <Check size={10} strokeWidth={3} className="text-[color:var(--color-accent-ink)]" />
        ) : null}
      </span>
      {label && (
        <span className="text-xs text-text-secondary group-hover:text-text-primary transition-colors">
          {label}
        </span>
      )}
    </button>
  );
}

/**
 * Visual-only checkbox indicator. Use inside parent buttons/clickable rows
 * where you want the whole row to be the click target — Checkbox itself is a
 * <button>, and button-in-button is invalid HTML.
 */
export function CheckboxBox({
  checked, indeterminate,
}: {
  checked: boolean;
  indeterminate?: boolean;
}) {
  const filled = checked || !!indeterminate;
  return (
    <span
      aria-hidden="true"
      className={`w-3.5 h-3.5 rounded border-[1.5px] flex items-center justify-center transition-colors shrink-0 ${
        filled
          ? 'bg-accent-solid border-accent-solid'
          : 'bg-transparent border-border-default'
      }`}
    >
      {indeterminate ? (
        <Minus size={10} strokeWidth={3} className="text-[color:var(--color-accent-ink)]" />
      ) : checked ? (
        <Check size={10} strokeWidth={3} className="text-[color:var(--color-accent-ink)]" />
      ) : null}
    </span>
  );
}
