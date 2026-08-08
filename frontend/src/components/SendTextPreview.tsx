// Static (non-Lexical) renderer for SendText payloads in the grid Key column.
// Parses `{token}` patterns and renders each as a compact pink chip — same visual
// identity as the interactive chips in the Lexical-based Insert Text editor
// (`lexical/TokenChip.tsx`), minus the popover / cursor / hover affordances since
// the grid cell is read-only. Used inside the existing truncating wrapper, so
// long sequences still clip at the cell's max-width with the title attribute
// showing the full raw text on hover.

// A chip here is a PROMISE that replay will substitute the thing. This file used to chip
// every `{...}` it found, with no whitelist at all, so a literal `{xpto}` — text the engine
// leaves exactly as typed — was drawn identically to a live {clipboard}, and nothing on
// screen told the two apart until the macro ran and pasted the braces. The preview and the
// Insert Text editor now ask the SAME walker (grammar ported from the engine's own matchers)
// instead of each keeping a private copy of the rule.
import { splitTokenSegments } from './lexical/tokenNormalize';

interface SendTextPreviewProps {
  text: string;
  /** Tiny delivery badge ("rich" / "md") shown before the text so the grid signals
   *  which SendText rows paste formatted content. Omit for plain rows. */
  badge?: string | null;
}

export function SendTextPreview({ text, badge = null }: SendTextPreviewProps) {
  if (!text) return null;
  // "Hello{Enter}World" → [text "Hello", token "{Enter}", text "World"]. Unclosed `{`
  // and unknown names both fall through as literal text, matching what replay does
  // with them.
  const segments = splitTokenSegments(text);
  return (
    <>
      {badge && (
        <span className="inline-flex items-center px-1 py-[1px] mr-1 text-[9px] font-semibold uppercase tracking-wide rounded text-accent bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] border border-[color-mix(in_srgb,var(--color-accent)_40%,transparent)] select-none align-middle">
          {badge}
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
