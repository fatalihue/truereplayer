interface KbdTagProps {
  combo: string;
  accent?: boolean;
  // Render the WHOLE combo inside a single chip ("Ctrl+F9") instead of one chip
  // per key. Used by the ProfilePanel hotkey badge (redesign: a profile's
  // trigger reads as one token, not a keyboard-diagram row).
  unified?: boolean;
}

/**
 * Renders a keyboard shortcut combo.
 *  default  → one chip per key:  "Ctrl+PageDown" → [Ctrl] [PageDown]
 *  unified  → one chip total:    "Ctrl+PageDown" → [Ctrl+PageDown]
 */
export function KbdTag({ combo, accent = false, unified = false }: KbdTagProps) {
  if (!combo) return null;
  const cls = accent ? 'kbd kbd-accent' : 'kbd';

  if (unified) {
    // The raw combo is already the display string ("Ctrl+F9"); a lone "+" key
    // shows as itself. px-1.5 relaxes the chip's min-width so a multi-key combo
    // isn't cramped.
    return <span className={`${cls} px-1.5`}>{combo}</span>;
  }

  // Split on '+' as the separator, but keep a literal '+' KEY intact: it shows up as a trailing
  // empty segment (e.g. "Ctrl++" → ['Ctrl','','']) which we map back to '+'. "+" alone is the
  // lone plus key.
  const parts = combo === '+'
    ? ['+']
    : combo.split('+').map((p, i, arr) => (p === '' && i === arr.length - 1 ? '+' : p)).filter(p => p !== '');

  return (
    <div className="flex items-center gap-0.5">
      {parts.map((part, i) => (
        <span key={i} className={cls}>{part}</span>
      ))}
    </div>
  );
}
