import { type ReactNode } from 'react';

interface RemovableChipProps {
  children: ReactNode;                  // chip content (KbdTag, app icon, hotstring text, etc.)
  onRemove: (e: React.MouseEvent) => void;
  removeTitle?: string;                 // aria-label on the ✕ button (screen readers only)
  // Optional instant tooltip on the whole chip (data-tip). Targets pass the
  // .exe name; hotkey/hotstring chips pass nothing — their content is already
  // self-explanatory and the red ✕ speaks for itself.
  tip?: string;
  // Right-edge ✕ overlay shape. "edge" = full-height right strip with rounded-r (kbd-like chips).
  // "circle" = small circular overlay (matches the existing window-target/crosshair icons).
  variant?: 'edge' | 'circle';
  className?: string;                   // outer wrapper class
}

// Hover-reveal ✕ button overlay used across ProfilePanel for assignable bits (hotkey,
// hotstring, window target, folder target). One source of truth so styling stays
// consistent and a single tweak propagates everywhere. The ✕ is positioned absolute
// so it overlays the chip without consuming layout width when hidden.
//
// Each wrapper is its own `group` — chips aren't nested in other groups in ProfilePanel,
// so the unnamed variant is enough and survives Tailwind's static class extraction.
export function RemovableChip({
  children,
  onRemove,
  removeTitle = 'Remove',
  tip,
  variant = 'edge',
  className = '',
}: RemovableChipProps) {
  const btnClass = variant === 'edge'
    ? 'absolute top-0 right-0 bottom-0 w-4 rounded-r flex items-center justify-center text-[7px] font-bold text-white bg-recording/80 hover:bg-recording transition-colors'
    : 'absolute inset-0 rounded-full flex items-center justify-center text-[9px] font-bold text-white bg-recording hover:bg-red-500 transition-colors';

  return (
    // The optional tooltip lives on the OUTER span, never on the ✕ button: the
    // [data-tip] CSS rule is unlayered and forces position: relative, which
    // overrides the button's Tailwind `absolute` (unlayered beats @layer
    // utilities) and threw the ✕ out of the chip onto its own line. The outer
    // span is already position: relative, so attaching the tip here is
    // layout-safe. below-start keeps long names from clipping at the panel edge.
    <span
      className={`group shrink-0 relative ${className}`}
      {...(tip ? { 'data-tip': tip, 'data-tip-pos': 'below-start' } : {})}
    >
      {children}
      <button
        type="button"
        onClick={onRemove}
        aria-label={removeTitle}
        className={`hidden group-hover:inline-flex ${btnClass}`}
      >
        ✕
      </button>
    </span>
  );
}
