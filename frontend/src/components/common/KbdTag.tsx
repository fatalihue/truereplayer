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
        {/* Tightened: px-1 instead of px-1.5, and the two separator spaces pulled in by
            1.5 px each. A Unicode thin/hair space buys NOTHING here — .kbd is monospace,
            so every space glyph gets the same cell as any other; wordSpacing is the only
            lever that actually narrows it. Win + Ctrl + R goes 91 → 81 px, Ctrl + Num4
            75 → 68, and the gap stays ~4.5 px so the keys still read as separate.
            Only this `unified` branch changes — the multi-chip branch below is what
            KeyCaps and the dialogs render, and those are not cramped. */}
        <span className={`${cls} px-1`} style={{ wordSpacing: '-1.5px' }}>{parts.join(' + ')}</span>
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
