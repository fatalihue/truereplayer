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
  /** Extra classes on the outer button (typically for layout/spacing tweaks). */
  className?: string;
}

/**
 * Themed checkbox replacing the native <input type="checkbox">. Native checkboxes
 * render with a white background when unchecked, which clashes with dark themes.
 *
 * Behavior (matches the original .checkbox-subtle style):
 *   - Unchecked: transparent fill + 1.5px border (subtle outline, blends with row bg)
 *   - Checked:   accent-solid fill with white check glyph
 *   - Indeterminate: accent fill, dash glyph (for partial-selection cases)
 */
export function Checkbox({
  checked,
  indeterminate,
  onChange,
  label,
  title,
  stopPropagation,
  className = '',
}: CheckboxProps) {
  const filled = checked || !!indeterminate;

  const handleClick = (e: MouseEvent) => {
    if (stopPropagation) e.stopPropagation();
    onChange(!checked);
  };

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      onClick={handleClick}
      data-tip={title}
      className={`flex items-center gap-2 cursor-pointer select-none group ${className}`}
    >
      <span
        className={`w-3.5 h-3.5 rounded border-[1.5px] flex items-center justify-center transition-colors shrink-0 ${
          filled
            ? 'bg-accent-solid border-accent-solid'
            : 'bg-transparent border-border-default group-hover:border-text-tertiary'
        }`}
      >
        {indeterminate ? (
          <Minus size={10} strokeWidth={3} className="text-white" />
        ) : checked ? (
          <Check size={10} strokeWidth={3} className="text-white" />
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
        <Minus size={10} strokeWidth={3} className="text-white" />
      ) : checked ? (
        <Check size={10} strokeWidth={3} className="text-white" />
      ) : null}
    </span>
  );
}
