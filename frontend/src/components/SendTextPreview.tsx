// Static (non-Lexical) renderer for SendText payloads in the grid Key column.
// Parses `{token}` patterns and renders each as a compact pink chip — same visual
// identity as the interactive chips in the Lexical-based Insert Text editor
// (`lexical/TokenChip.tsx`), minus the popover / cursor / hover affordances since
// the grid cell is read-only. Used inside the existing truncating wrapper, so
// long sequences still clip at the cell's max-width with the title attribute
// showing the full raw text on hover.

interface SendTextPreviewProps {
  text: string;
  /** Action carries a rich (KeyHtml) flavor — renders a tiny "rich" badge so the
   *  grid signals which SendText rows paste formatted content. */
  rich?: boolean;
}

interface Segment {
  kind: 'text' | 'token';
  value: string;
}

// Splits "Hello{Enter}World" into [text "Hello", token "{Enter}", text "World"].
// Malformed input (unclosed `{`) falls through as literal text because the regex
// requires a matching `}`.
function parseSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  const regex = /\{[^}]+\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: 'text', value: text.slice(lastIndex, match.index) });
    }
    segments.push({ kind: 'token', value: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: 'text', value: text.slice(lastIndex) });
  }
  return segments;
}

export function SendTextPreview({ text, rich = false }: SendTextPreviewProps) {
  if (!text) return null;
  const segments = parseSegments(text);
  return (
    <>
      {rich && (
        <span className="inline-flex items-center px-1 py-[1px] mr-1 text-[9px] font-semibold uppercase tracking-wide rounded text-accent bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] border border-accent/30 select-none align-middle">
          rich
        </span>
      )}
      {segments.map((segment, idx) =>
        segment.kind === 'token' ? (
          // Chip style mirrors lexical/TokenChip.tsx but drops the interactive bits:
          // no cursor-pointer, no hover state, no ring on open — this is purely a
          // visual preview. `select-none` keeps the chip from highlighting when the
          // user selects the row.
          <span
            key={idx}
            className="inline-flex items-center px-1.5 py-[1px] mx-[1px] text-[12px] font-mono rounded text-[var(--color-action-sendtext-fg)] bg-[var(--color-action-sendtext-fg)]/15 border border-[var(--color-action-sendtext-fg)]/40 select-none align-middle"
          >
            {segment.value.slice(1, -1)}
          </span>
        ) : (
          <span key={idx}>{segment.value}</span>
        ),
      )}
    </>
  );
}
