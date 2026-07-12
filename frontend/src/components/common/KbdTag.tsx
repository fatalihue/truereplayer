interface KbdTagProps {
  combo: string;
  accent?: boolean;
  // Render the WHOLE combo inside a single chip ("Ctrl+F9") instead of one chip
  // per key. Used by the ProfilePanel hotkey badge (redesign: a profile's
  // trigger reads as one token, not a keyboard-diagram row).
  unified?: boolean;
}

/**
 * Split a combo on '+' as the separator, keeping a literal '+' KEY intact: it
 * shows up as a trailing empty segment (e.g. "Ctrl++" → ['Ctrl','','']) which
 * maps back to '+'. "+" alone is the lone plus key. Shared with the capture
 * dialogs' hero key-caps (KeyCaps) so both render literal-plus combos right.
 */
export function splitCombo(combo: string): string[] {
  return combo === '+'
    ? ['+']
    : combo.split('+').map((p, i, arr) => (p === '' && i === arr.length - 1 ? '+' : p)).filter(p => p !== '');
}

/**
 * Renders a keyboard shortcut combo.
 *  default  → one chip per key:  "Ctrl+PageDown" → [Ctrl] [PageDown]
 *  unified  → one chip total:    "Ctrl+PageDown" → [Ctrl+PageDown]
 */
export function KbdTag({ combo, accent = false, unified = false }: KbdTagProps) {
  if (!combo) return null;
  const cls = accent ? 'kbd kbd-accent' : 'kbd';

  const parts = splitCombo(combo);

  if (unified) {
    // One chip, keys joined with a spaced separator ("Alt + A", not "Alt+A").
    // Built from `parts` so a literal '+' key still renders correctly. px-1.5
    // relaxes the chip's min-width so a multi-key combo isn't cramped.
    // Wrapped in the SAME block flex container as the multi-chip branch below:
    // a bare inline chip sits in its parent's 24px line box and made the
    // ProfilePanel rows ~3px taller; the flex wrapper is a 20px block instead.
    return (
      <div className="flex items-center">
        <span className={`${cls} px-1.5`}>{parts.join(' + ')}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-0.5">
      {parts.map((part, i) => (
        <span key={i} className={cls}>{part}</span>
      ))}
    </div>
  );
}
