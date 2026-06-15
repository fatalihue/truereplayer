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

// Hover/focus-reveal ✕ button overlay used across ProfilePanel for assignable bits
// (hotkey, hotstring, window target, folder target). One source of truth so styling
// stays consistent and a single tweak propagates everywhere. The ✕ is positioned
// absolute so it overlays the chip without consuming layout width, and is revealed
// via opacity (not display:none) so it stays Tab-reachable and AT-accessible even
// while visually hidden.
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
      // NAMED group (group/removable) so the ✕ reveals on hover of THIS chip only.
      // An unnamed `group` also matched ancestor groups — e.g. the folder header
      // row is a `group`, which made the folder-target ✕ appear when hovering
      // anywhere on the folder name instead of just over its .exe icon.
      className={`group/removable shrink-0 relative ${className}`}
      {...(tip ? { 'data-tip': tip, 'data-tip-pos': 'below-start' } : {})}
    >
      {children}
      <button
        type="button"
        // Stop the click here so removing a chip never bubbles up to the chip's
        // own (or an ancestor's) click handler — callers no longer need to.
        onClick={(e) => {
          e.stopPropagation();
          onRemove(e);
        }}
        aria-label={removeTitle}
        // Reveal on hover OR keyboard focus, and keep it reachable by Tab / AT:
        // `opacity-0` (not `hidden`/display:none) leaves the button in the tab
        // order and the accessibility tree, so keyboard and screen-reader users
        // can reach it — display:none removed it entirely. `pointer-events-none`
        // in the resting state preserves the old mouse behaviour exactly: the
        // invisible overlay never intercepts clicks on the chip content beneath
        // it until revealed. focus-visible (not focus) avoids any flash on mouse
        // interaction. Reveal is instant (no transition) to match the original.
        className={`opacity-0 pointer-events-none group-hover/removable:opacity-100 group-hover/removable:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto ${btnClass}`}
      >
        ✕
      </button>
    </span>
  );
}
