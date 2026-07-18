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
const COMPOUND_NAMES: Record<string, string> = {
  datetime: 'DateTime',
  pageup: 'PageUp',
  pagedown: 'PageDown',
};

// Tokens whose args are user-chosen NAMES (variable / data-table column) or free
// text (the Ask-Input label + menu options), not modifiers — case-folding
// {var:MyVar} to {var:myvar} would still run (backend lookups are case-insensitive)
// but would rewrite the user's text on every open/close. Keep every arg verbatim,
// same rationale as join's separator. A label with ':' survives via the split+rejoin
// on ':' below (the parts are re-joined with ':'), so {input:Label|menu:a,b,c} and
// {input:Enter time (HH:MM)} both round-trip unchanged.
const VERBATIM_ARG_NAMES = new Set(['var', 'row', 'clip', 'input']);

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
  const normalizedMods = mods.map((p, idx) => {
    // Name-bearing tokens ({var:Name}/{row:Column}) keep args untouched.
    if (keepArgsVerbatim) return p;
    // join's argument is freeform separator TEXT — case-folding it would change
    // what actually gets typed (join:AND ≠ join:and). Keep it verbatim.
    if (idx > 0 && mods[idx - 1].toLowerCase() === 'join') return p;
    return /^[a-zA-Z]+$/.test(p) ? p.toLowerCase() : p;
  });
  return `{${[normalizedName, ...normalizedMods].join(':')}}`;
}
