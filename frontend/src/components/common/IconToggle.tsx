import type { LucideIcon } from 'lucide-react';

interface IconToggleProps {
  isOn: boolean;
  onChange: (value: boolean) => void;
  /** Any lucide icon — Power for an enable master, Gamepad2 for Game Mode, etc. */
  icon: LucideIcon;
  disabled?: boolean;
  /** Accessible name. Required: the glyph alone tells a screen reader nothing. */
  ariaLabel: string;
}

/**
 * Icon-shaped switch for a PROMINENT, standalone toggle — a master enable, a toolbar
 * control — where a generic switch carries no meaning but the glyph does. NOT for
 * settings lists: a column of identical icons reads worse than a column of switches
 * (use Toggle there).
 *
 * The ON state changes THREE things: the glyph colour, plus a 12% accent pill and a 35%
 * border. The pill is not decoration — with colour as the only channel this control is
 * unreadable on the low-contrast presets. Measured across all 48 themes in themes.ts, the
 * accent↔text-tertiary contrast falls under 3:1 on 21 of them (peach-fuzz: 1.5:1), so an
 * icon that only recoloured would have no visible state at all on nearly half the palette.
 */
export function IconToggle({ isOn, onChange, icon: Icon, disabled = false, ariaLabel }: IconToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isOn}
      aria-label={ariaLabel}
      aria-disabled={disabled}
      disabled={disabled}
      onClick={() => !disabled && onChange(!isOn)}
      className={`w-[22px] h-[22px] grid place-items-center rounded-md border transition-colors ${
        disabled
          ? 'border-transparent opacity-40 cursor-not-allowed'
          : isOn
            ? 'bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)] cursor-pointer'
            : 'border-transparent hover:bg-bg-elevated cursor-pointer'
      }`}
    >
      <Icon size={13} className={`transition-colors ${isOn ? 'text-accent' : 'text-text-tertiary'}`} />
    </button>
  );
}
