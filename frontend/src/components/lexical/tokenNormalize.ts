// Canonical form for `{Variable[:mods]}` tokens. Used both as the chip display
// string and as the stored __token value so the editor never shows `{enter}`
// next to `{Enter}` next to `{ENTER}` — every chip looks the same regardless
// of how the user typed/pasted it.
//
// Rules:
//   - Variable name: title-cased (first letter upper, rest lower) UNLESS it's
//     a known compound — DateTime, PageUp, PageDown follow the camelCase form
//     used by MDN's KeyboardEvent.code and most language stdlibs.
//   - Alphabetic modifiers: lower (the backend already lower-cases them, and
//     visually they read as parameters next to numeric modifiers like `:10`).
//   - Numeric modifiers: kept as-is.
//
// Backend processing is case-insensitive so this is purely cosmetic; existing
// saved actions that contain `{enter}` continue to work and get normalised on
// next edit.
import { verbatimArgIndices } from './clipboardModifiers';

const COMPOUND_NAMES: Record<string, string> = {
  datetime: 'DateTime',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  winclip: 'WinClip',
  rownext: 'RowNext',
};

// {input:...} is the one token whose WHOLE argument is free text — the Ask-Input label plus its
// menu options, which may themselves contain ':'. It survives via the split+rejoin on ':' below,
// so {input:Label|menu:a,b,c} and {input:Enter time (HH:MM)} both round-trip unchanged.
//
// {var:Name} and {clip:Name} used to live here too, back when their whole argument was a name.
// They now carry a modifier tail like {row:Column[:mods]}, so they moved to NAME_FIRST_ARG_NAMES:
// the FIRST arg stays verbatim (case-folding {var:MyVar} would rewrite the user's text on every
// open/close, and backend lookups are case-insensitive anyway) while the segments after it are
// clipboard-style modifiers and follow the modifier rules.
// {pick:a|b|c} joins {input} here for the same reason: its whole argument is free text (the
// '|'-separated options, which may carry spaces, ':' and accents). Without this, the pure-alpha
// segment fold below would rewrite the OPTIONS on every chip creation ({Pick:Sim} → {Pick:sim}).
const VERBATIM_ARG_NAMES = new Set(['input', 'pick']);

// Heads whose first argument is a user-chosen name/column, followed by an optional modifier chain.
const NAME_FIRST_ARG_NAMES = new Set(['row', 'rownext', 'var', 'clip']);

export function normalizeToken(token: string): string {
  if (token.length < 2 || token[0] !== '{' || token[token.length - 1] !== '}') {
    return token;
  }
  const inner = token.slice(1, -1);
  if (!inner) return token;
  const parts = inner.split(':');
  const name = parts[0];
  if (!name) return token;
  const lowerName = name.toLowerCase();
  const normalizedName =
    COMPOUND_NAMES[lowerName] ?? name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
  const mods = parts.slice(1);
  const keepArgsVerbatim = VERBATIM_ARG_NAMES.has(lowerName);
  // {row:Column}, {rownext:Column}, {var:Name} and {clip:Name} all carry a verbatim name as
  // their first arg, with the modifier chain starting after it.
  const isRow = NAME_FIRST_ARG_NAMES.has(lowerName);
  // The modifier tail starts after the column name for row/rownext, at the top otherwise.
  const verbatimArgs = keepArgsVerbatim ? new Set<number>() : verbatimArgIndices(mods, isRow ? 1 : 0);
  const normalizedMods = mods.map((p, idx) => {
    // Name-bearing tokens ({var:Name}/{clip:Name}/{input:...}) keep args untouched.
    if (keepArgsVerbatim) return p;
    // {row:Column:mods} — the first arg is the user's column name (verbatim);
    // later args are clipboard-style modifiers and follow the rules below. (A
    // column literally named "join" would shield the next segment from folding —
    // cosmetic only, the backend lower-cases modifiers itself.)
    if (isRow && idx === 0) return p;
    // The freeform-text arguments — a join separator or a split delimiter — are TEXT, and
    // case-folding them rewrites what the user typed (join:AND ≠ join:and on screen). Which
    // segments those are comes from the arity walk itself, so this can never disagree with the
    // engine about who owns a segment.
    if (verbatimArgs.has(idx)) return p;
    return /^[a-zA-Z]+$/.test(p) ? p.toLowerCase() : p;
  });
  return `{${[normalizedName, ...normalizedMods].join(':')}}`;
}

// ── What the ENGINE calls a token ────────────────────────────────────────────
// ONE source of truth for "will the replay engine substitute this `{...}`, or is
// it literal text the user typed?". Three surfaces ask that question — the Lexical
// chipping pipeline, the "N tokens" figure in the Insert Text status strip, and the
// read-only SendTextPreview in the grid — and they used to answer it three different
// ways. The preview answered "yes" to EVERY `{...}`, so a literal `{xpto}` was drawn
// as a live chip promising a substitution that replay would never make, and the user
// could not tell it apart from a real one until the macro ran.
//
// Ported name-by-name from the matchers in Source/ActionExecution.cs:
// SpecialKeyPlaceholders (keyed WITH the braces — "{enter}" … "{esc}") plus the
// {delay:N} branch of ParseSendTextSegments; ClipboardTokenRegex; WinClipTokenRegex;
// RandomTokenRegex; InputTokenRegex; VarTokenRegex; RowDataTokenRegex;
// RowNextTokenRegex; ClipSlotTokenRegex; and the literal {date}/{time}/{datetime}/
// {counter}/{row} replaces in ResolveDateTimeTokens / ResolveRunStateTokens.
//
// SCOPE — this is a NAME test, exactly as wide as the chip pipeline's whitelist. It
// deliberately does NOT re-check each name's argument shape, which the engine also
// enforces: a bare {var} (VarTokenRegex requires ':name') or {winclip:abc} (requires
// digits) is counted and drawn here but pastes literally at replay. Narrowing it per
// name would split the preview from the chip pipeline again — the very divergence
// this set exists to close — so that is a separate finding, not a silent difference.
export const KNOWN_TOKEN_NAMES: ReadonlySet<string> = new Set([
  'clipboard',
  'date',
  'time',
  'datetime',
  'enter',
  'tab',
  'space',
  'backspace',
  'delete',
  'escape',
  // {esc} is a REAL alias, not an escape hatch: SpecialKeyPlaceholders maps both
  // "{escape}" and "{esc}" to VK 0x1B and ParseSendTextSegments runs them down the
  // identical path, repeat count included ({esc:3} = three presses) — and the Chrome
  // extension's BrowserType parser accepts both too. It sat outside this set on the
  // theory that it was "SendText's literal-brace escape" and chipping it would hide
  // the escape mechanism; there is no such mechanism. Literal braces are escaped by
  // EscapeBracesForParser, which uses private-use sentinel CHARACTERS, and nothing in
  // either parser gives `esc` a meaning other than the Escape key. The cost of the
  // theory was that {esc} alone among the key tokens got no chip and no editor.
  'esc',
  'home',
  'end',
  'pageup',
  'pagedown',
  'up',
  'down',
  'left',
  'right',
  'delay',
  'random',
  // Run-state tokens (2.8.0): first-class chips like everything else the
  // backend resolves — {var:name}, {counter}, {row}, {row:column} (which also
  // takes the clipboard-style modifier chain: {row:column:trim:upper}).
  'var',
  'counter',
  'row',
  // {rownext:column} — like {row:column} but auto-advancing: each use pulls the NEXT
  // data row for that column (1st use → row 1, 2nd → row 2…), resetting each run.
  'rownext',
  // Clipboard slots: {clip:name} reads a selection captured by Copy to Slot /
  // the capture hotkey. Disjoint from {clipboard} (different name).
  'clip',
  // Windows clipboard history: {winclip:N} reads item N of the Win+V history
  // (1 = most recent). Distinct from {clip:name} (in-app slots) and {clipboard}.
  'winclip',
  // Ask-Input (Text Blaze style): {input:Label} / {input:Label|menu:a,b,c} prompts the user at
  // replay time. A spaced label or the |menu: variant falls outside the editor's TYPING grammar,
  // so those chip only via insertToken (the palette prompt); a bare {input:Name} chips when typed.
  // Both shapes are tokens to the walker below, because both resolve.
  'input',
  // Random text choice: {pick:a|b|c} draws one '|'-separated option per use. Options are
  // free text (VERBATIM_ARG_NAMES), so like {input} it chips via insertToken / on load.
  'pick',
]);

export interface TokenSegment {
  kind: 'text' | 'token';
  value: string;
}

/**
 * Splits `text` into alternating literal runs and engine-resolved token runs.
 *
 * This is a port of how the ENGINE finds a token, which is deliberately WIDER than the
 * editor's typing grammar (LexicalTokenEditor's TOKEN_REGEX, which only auto-chips tokens
 * whose arguments are `[a-zA-Z0-9,_-]`). Three rules, each taken from the C# side:
 *
 *   1. A token spans '{' to the FIRST '}'. Every engine matcher bounds its argument with
 *      `[^}]` — ClipboardTokenRegex is `\{clipboard(?::([^}]+))?\}` — and ParseSendTextSegments
 *      scans forward to the first '}'. So an argument may hold ANY character except '}',
 *      including spaces and '@'. That is where the count was wrong: `{clipboard:join: - }`
 *      is a join whose separator is " - ", which the engine keeps RAW and substitutes
 *      happily, but the typing grammar rejects the spaces, so the status strip said "0 tokens"
 *      about a payload holding one.
 *   2. The NAME is everything before the first ':' (engine: `inner.Split(':')[0]`), compared
 *      case-insensitively — every engine matcher is IgnoreCase / OrdinalIgnoreCase.
 *   3. A run whose name is unknown re-anchors the scan at start+1 instead of skipping past its
 *      '}'. The engine's regexes are leftmost-first over the whole string, so the `{clipboard}`
 *      inside `{x{clipboard}` IS found there and must be found here; skipping would hide it.
 */
export function splitTokenSegments(text: string): TokenSegment[] {
  const segments: TokenSegment[] = [];
  let lastIndex = 0;   // start of the literal run still waiting to be emitted
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    const close = text.indexOf('}', open + 1);
    // No closing brace left in the string — every later '{' is past this point, so
    // none of them can close either. Nothing after here is a token.
    if (close < 0) break;
    const inner = text.slice(open + 1, close);
    const colon = inner.indexOf(':');
    const name = (colon < 0 ? inner : inner.slice(0, colon)).toLowerCase();
    if (!KNOWN_TOKEN_NAMES.has(name)) {
      i = open + 1;   // rule 3 — re-anchor, don't skip the run
      continue;
    }
    if (open > lastIndex) segments.push({ kind: 'text', value: text.slice(lastIndex, open) });
    segments.push({ kind: 'token', value: text.slice(open, close + 1) });
    lastIndex = close + 1;
    i = close + 1;
  }
  if (lastIndex < text.length) segments.push({ kind: 'text', value: text.slice(lastIndex) });
  return segments;
}
