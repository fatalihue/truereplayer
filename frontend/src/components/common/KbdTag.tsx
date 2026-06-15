interface KbdTagProps {
  combo: string;
  accent?: boolean;
}

/**
 * Renders a keyboard shortcut combo as individual styled kbd tags.
 * e.g. "Ctrl+PageDown" → [Ctrl] [PageDown]
 */
export function KbdTag({ combo, accent = false }: KbdTagProps) {
  if (!combo) return null;

  // Split on '+' as the separator, but keep a literal '+' KEY intact: it shows up as a trailing
  // empty segment (e.g. "Ctrl++" → ['Ctrl','','']) which we map back to '+'. "+" alone is the
  // lone plus key.
  const parts = combo === '+'
    ? ['+']
    : combo.split('+').map((p, i, arr) => (p === '' && i === arr.length - 1 ? '+' : p)).filter(p => p !== '');
  const cls = accent ? 'kbd kbd-accent' : 'kbd';

  return (
    <div className="flex items-center gap-0.5">
      {parts.map((part, i) => (
        <span key={i} className={cls}>{part}</span>
      ))}
    </div>
  );
}
