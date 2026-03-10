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

  const parts = combo.includes('+') ? combo.split('+') : [combo];
  const cls = accent ? 'kbd kbd-accent' : 'kbd';

  return (
    <div className="flex items-center gap-0.5">
      {parts.map((part, i) => (
        <span key={i} className={cls}>{part}</span>
      ))}
    </div>
  );
}
