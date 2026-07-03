import type { ReactNode } from 'react';

/**
 * THE segmented control — canonicalizes the ActionBar's treatment (inset input-
 * colored track, tinted active segment), which the 2026-07 audit judged the best
 * of the five drifted variants. Options may override the active tint with a
 * semantic class (e.g. Macro = replay green, Clicker = clicker purple); the
 * default active state is the neutral elevated fill used by tab-style consumers.
 */

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  /** data-tip tooltip body (goes through the global TooltipLayer). */
  tip?: string;
  /** Class set applied to the ACTIVE segment instead of the neutral default. */
  activeClass?: string;
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  /** Stretch segments to share the track evenly (tab-bar style). */
  grow?: boolean;
  /** Drop the inset input-colored track (bg + border + padding) so the control
   *  blends into its surface — used by the SettingsPanel tabs, whose dark track
   *  read as "another input field". The active segment's own fill still shows. */
  plain?: boolean;
  className?: string;
}

const DEFAULT_ACTIVE = 'bg-bg-elevated text-text-primary shadow-[inset_0_0_0_1px_var(--color-border-default)]';

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  grow = false,
  plain = false,
  className = '',
}: SegmentedControlProps<T>) {
  return (
    <div
      className={`flex items-center gap-0.5 ${plain ? '' : 'bg-bg-input border border-border-default rounded p-0.5'} ${className}`}
      role="tablist"
      aria-label={ariaLabel}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            data-tip={opt.tip}
            className={`flex items-center justify-center gap-1.5 px-2.5 py-1 rounded text-[12px] font-semibold transition-colors ${grow ? 'flex-1' : ''} ${
              active
                ? (opt.activeClass ?? DEFAULT_ACTIVE)
                : 'text-text-tertiary hover:text-text-secondary'
            }`}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
