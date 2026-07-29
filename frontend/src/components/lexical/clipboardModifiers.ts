// Pure logic for the {clipboard[:mods]} and {row:column[:mods]} token formats. Shared
// between the side-panel "Advanced Clipboard" insert popover and the chip click-to-edit
// popovers (clipboard + data-row cell — both run the SAME backend modifier pipeline).
//
// Modifier order in the emitted chain MUST match the backend pipeline:
// next → trim → range/lines → sort → dedupe → reverse → join → line/word →
// first/last → upper/lower/sentence/title. ('next' picks WHICH text the rest sees and is
// handled in ResolveClipboardTokensAsync, ahead of ApplyClipboardModifiers; list ops then
// narrow/reshape the multiline content, line/word extracts a single piece, limit and case finish.)

export type CaseTransform = 'none' | 'upper' | 'lower' | 'sentence' | 'title';
export type Extract = 'none' | 'line' | 'word';
export type Limit = 'none' | 'first' | 'last';
export type ListPick = 'none' | 'range' | 'lines';

/**
 * Mirror of the backend's ActionReplayer.IsArgRef. A chain segment shaped "@name" is a REFERENCE
 * to run state (a variable, or the reserved @counter / @row), not a literal argument.
 *
 * Shape only — it must never ask whether the reference resolves, because arity is decided
 * syntactically on both sides: the backend applier, its next-walk and findNextModifier below all
 * step through the chain with this predicate, and a value-dependent answer would make "is this
 * segment `next`?" depend on what a variable happens to hold at run time.
 */
export const isArgRef = (seg: string | undefined): boolean =>
  seg !== undefined && /^@[A-Za-z0-9_]+$/.test(seg);

export interface TransformState {
  // {clipboard:next} — take ONE line per use and advance a cursor, instead of the whole
  // clipboard. Clipboard-only: {row:col}/{rownext:col} share this state object but their
  // heads have no such modifier, so it is emitted by buildClipboardToken alone (never by
  // the shared buildModifierParts) and only parseClipboardToken ever sets it.
  next: boolean;
  trim: boolean;
  case: CaseTransform;
  extract: Extract;
  extractN: number;
  limit: Limit;
  limitN: number;
  // Reference arguments — "@name" instead of a literal index (e.g. {clipboard:line:@i}, where
  // the line number comes from the variable i, or from @counter / @row). Empty string = use the
  // numeric field above. Kept as a SEPARATE field rather than widening extractN to string so
  // every existing numeric consumer stays typed, and so a chain that carries a reference always
  // round-trips: parse sets it, build re-emits it, and nothing in between can quietly drop it.
  extractRef: string;
  limitRef: string;
  /** The chain carried something this editor cannot represent, so REBUILDING it would silently
   *  throw that part away. Set by the parser, never emitted into a token. Consumers must go
   *  read-only rather than re-serialize. See parseModifierParts. */
  unmodeled: boolean;
  // List ops — operate on the content as CRLF-normalized lines (backend list modifiers).
  listPick: ListPick;   // 'range' → range:a-b · 'lines' → lines:i,j,k (1-based)
  rangeFrom: number;
  rangeTo: number;
  linesSpec: string;    // raw comma list, e.g. "3,1,2" (duplicates = repeat the line)
  sort: boolean;        // case-insensitive A→Z
  dedupe: boolean;      // keep first occurrence, case-insensitive
  reverse: boolean;
  join: boolean;
  joinSep: string;      // '' is a legal separator (emitted as an explicit empty part)
}

export const DEFAULT_TRANSFORM: TransformState = {
  next: false,
  trim: false,
  case: 'none',
  extract: 'none',
  extractN: 1,
  limit: 'none',
  limitN: 10,
  extractRef: '',
  limitRef: '',
  unmodeled: false,
  listPick: 'none',
  rangeFrom: 1,
  rangeTo: 3,
  linesSpec: '',
  sort: false,
  dedupe: false,
  reverse: false,
  join: false,
  joinSep: ',',
};

export function buildClipboardToken(s: TransformState): string {
  // 'next' leads the chain because the backend applies it first (pick the line, THEN transform
  // it) and this module's contract is that the emitted order matches the backend pipeline.
  // Deliberately NOT part of buildModifierParts: that tail is shared with {row:col} and
  // {rownext:col}, whose heads ignore 'next' — emitting it there would persist a silent no-op.
  const lead = s.next ? ['next'] : [];
  return '{' + ['clipboard', ...lead, ...buildModifierParts(s)].join(':') + '}';
}

// {row:column[:mods]} — the data-loop cell token with the same modifier chain.
// No mods → plain {row:column}, byte-identical to what NamePromptPopover inserts.
export function buildRowToken(column: string, s: TransformState): string {
  return '{' + ['row', column, ...buildModifierParts(s)].join(':') + '}';
}

// {rownext:column[:mods]} — the auto-advancing data-row token. Same shape/modifier chain as
// {row:column}, different head; at replay each use pulls the NEXT row (backend cursor), resetting
// per run. No mods → plain {rownext:column}, byte-identical to what NamePromptPopover inserts.
export function buildRowNextToken(column: string, s: TransformState): string {
  return '{' + ['rownext', column, ...buildModifierParts(s)].join(':') + '}';
}

// The modifier tail shared by every token head that supports transforms.
function buildModifierParts(s: TransformState): string[] {
  const parts: string[] = [];
  if (s.trim) parts.push('trim');
  if (s.listPick === 'range') parts.push('range', `${s.rangeFrom}-${s.rangeTo}`);
  else if (s.listPick === 'lines' && /\d/.test(s.linesSpec)) parts.push('lines', s.linesSpec);
  if (s.sort) parts.push('sort');
  if (s.dedupe) parts.push('dedupe');
  if (s.reverse) parts.push('reverse');
  // join ALWAYS emits its separator as the very next part — an explicit empty part
  // ("...:join:") means empty separator. Matches the backend's consume-one-arg rule.
  if (s.join) parts.push('join', s.joinSep);
  const extractArg = s.extractRef ? s.extractRef : String(s.extractN);
  if (s.extract === 'line') parts.push('line', extractArg);
  else if (s.extract === 'word') parts.push('word', extractArg);
  const limitArg = s.limitRef ? s.limitRef : String(s.limitN);
  if (s.limit === 'first') parts.push('first', limitArg);
  else if (s.limit === 'last') parts.push('last', limitArg);
  if (s.case === 'upper') parts.push('upper');
  else if (s.case === 'lower') parts.push('lower');
  else if (s.case === 'sentence') parts.push('sentence');
  else if (s.case === 'title') parts.push('title');
  return parts;
}

// Same CRLF normalization the backend's SplitContentLines / line:N use.
function splitLines(t: string): string[] {
  return t.replace(/\r\n/g, '\n').split('\n');
}

// Mirror of backend ApplyClipboardModifiers — used for the live preview only.
// Every backend modifier needs a mirrored branch here or the preview lies.
/**
 * True when the chain depends on a value that only exists at run time, so no honest preview can
 * be computed. Surfaces MUST branch on this and say so rather than render a number — showing the
 * result for index 1 when the real index comes from a variable is the same class of lie as the
 * WaitImage 100%-confidence footgun: authoritative-looking and wrong.
 */
export const previewIsRuntimeDependent = (s: TransformState): boolean =>
  (s.extract !== 'none' && !!s.extractRef) || (s.limit !== 'none' && !!s.limitRef);

export function applyTransformPreview(raw: string, s: TransformState): string {
  let r = raw;
  // 'next' first, mirroring the backend. The preview can only ever show the FIRST line: the
  // real cursor lives in the replay engine and a preview must never consume it. Surfaces that
  // show this must say so in copy — an authoritative-looking preview that silently disagrees
  // with runtime is the WaitImage-confidence class of footgun.
  if (s.next) {
    const items = splitLines(r).filter(l => l.trim() !== '');   // backend drops blank lines
    r = items.length > 0 ? items[0] : '';
  }
  if (s.trim) r = r.trim();
  if (s.listPick === 'range') {
    const lines = splitLines(r);
    let a = s.rangeFrom, b = s.rangeTo;
    if (a > b) [a, b] = [b, a];
    const from = Math.max(1, a);
    const to = Math.min(lines.length, b);
    r = from <= to ? lines.slice(from - 1, to).join('\n') : '';
  } else if (s.listPick === 'lines' && /\d/.test(s.linesSpec)) {
    const lines = splitLines(r);
    const picked: string[] = [];
    for (const tok of s.linesSpec.split(',')) {
      // Strict digit parse — the backend's int.TryParse rejects "3x" where a bare
      // parseInt would read 3, so mirror the strictness (whitespace is tolerated).
      const trimmed = tok.trim();
      if (!/^\d+$/.test(trimmed)) continue;
      const n = parseInt(trimmed, 10);
      if (n >= 1 && n <= lines.length) picked.push(lines[n - 1]);
    }
    r = picked.join('\n');
  }
  if (s.sort) {
    // StringComparer.OrdinalIgnoreCase folds to UPPERCASE — fold up, not down, or
    // the six ASCII chars between 'Z' and 'a' ([ \ ] ^ _ `) order differently than
    // runtime ("_x" vs "ax"). Code-unit compare, NOT localeCompare (culture-aware).
    r = splitLines(r)
      .sort((x, y) => { const ux = x.toUpperCase(), uy = y.toUpperCase(); return ux < uy ? -1 : ux > uy ? 1 : 0; })
      .join('\n');
  }
  if (s.dedupe) {
    const seen = new Set<string>();
    const kept: string[] = [];
    for (const line of splitLines(r)) {
      const key = line.toUpperCase(); // same upper-fold as the backend comparer
      if (!seen.has(key)) { seen.add(key); kept.push(line); }
    }
    r = kept.join('\n');
  }
  if (s.reverse) r = splitLines(r).reverse().join('\n');
  if (s.join) r = splitLines(r).join(s.joinSep);
  if (s.extract === 'line') {
    const lines = splitLines(r);
    r = lines[s.extractN - 1] ?? '';
  } else if (s.extract === 'word') {
    // Split on the SAME whitespace set the backend uses (space, tab, CR, LF) so the preview can't
    // diverge from runtime — /\s+/ would also match Unicode spaces the backend doesn't.
    const words = r.split(/[ \t\n\r]+/).filter(Boolean);
    r = words[s.extractN - 1] ?? '';
  }
  if (s.limit === 'first') r = r.slice(0, Math.max(0, s.limitN));
  else if (s.limit === 'last') r = s.limitN <= 0 ? '' : r.slice(-s.limitN);
  if (s.case === 'upper') r = r.toUpperCase();
  else if (s.case === 'lower') r = r.toLowerCase();
  else if (s.case === 'sentence') r = r.length > 0 ? r[0].toUpperCase() + r.slice(1) : r;
  else if (s.case === 'title') r = r.replace(/(^|\s)(\S)/g, (_, ws, ch) => ws + ch.toUpperCase());
  return r;
}

// Reverse of buildClipboardToken — hydrates state from an existing chip's token
// so the edit popover starts with the user's prior choices.
export function parseClipboardToken(token: string): TransformState {
  if (!/^\{clipboard(?::|\})/i.test(token)) return { ...DEFAULT_TRANSFORM };
  // parts[0] === 'clipboard'; the modifier tail starts at 1.
  const parts = token.slice(1, -1).split(':');
  // Pull 'next' out BEFORE the shared tail parser, which has no case for it and would drop it
  // silently — and a dropped flag here is not cosmetic: the chip editors rebuild the token from
  // this state, so a lost 'next' is written back to the profile as a plain {clipboard}.
  const at = findNextModifier(parts, 1);
  if (at >= 0) parts.splice(at, 1);
  const state = parseModifierParts(parts, 1);
  state.next = at >= 0;
  return state;
}

// Mirror of the backend's TrySplitNextModifier walk (ActionExecution.cs): returns the index of
// the standalone 'next' segment, or -1. Steps over ARGUMENTS exactly as the applier does, so a
// join separator that happens to be the word "next" ({clipboard:join:next}) is left alone — the
// backend treats it as a separator, and the two sides must agree or the chip rewrites the token
// into something that behaves differently.
function findNextModifier(parts: string[], from: number): number {
  for (let i = from; i < parts.length; ) {
    const p = parts[i].toLowerCase();
    const arg = parts[i + 1];
    const hasArg = arg !== undefined;
    switch (p) {
      case 'join':                                   // always consumes its separator, verbatim
        i += 2; continue;
      case 'line': case 'word': case 'first': case 'last':
        i += hasArg && (isArgRef(arg) || /^\d+$/.test(arg.trim())) ? 2 : 1; continue;
      case 'range':
        i += hasArg && (isArgRef(arg) || /^\d+-\d+$/.test(arg.trim())) ? 2 : 1; continue;
      case 'lines':
        i += hasArg && (isArgRef(arg) || /\d/.test(arg)) ? 2 : 1; continue;
      default:
        if (p === 'next') return i;
        i++; continue;
    }
  }
  return -1;
}

// Reverse of buildRowToken — column name (verbatim) + hydrated modifier state.
// parts[0] === 'row', parts[1] === column, mods from 2 on.
export function parseRowToken(token: string): { column: string; state: TransformState } {
  if (!/^\{row:/i.test(token)) return { column: '', state: { ...DEFAULT_TRANSFORM } };
  const parts = token.slice(1, -1).split(':');
  return { column: parts[1] ?? '', state: parseModifierParts(parts, 2) };
}

// Reverse of buildRowNextToken — {rownext:column[:mods]} → column name (verbatim) + modifier state.
export function parseRowNextToken(token: string): { column: string; state: TransformState } {
  if (!/^\{rownext:/i.test(token)) return { column: '', state: { ...DEFAULT_TRANSFORM } };
  const parts = token.slice(1, -1).split(':');
  return { column: parts[1] ?? '', state: parseModifierParts(parts, 2) };
}

// The shared modifier-tail parser — same forgiving grammar as the backend
// ApplyClipboardModifiers (unknown segments skipped, arg-taking modifiers
// validate their arg before consuming it).
//
// It also reports whether anything was LOST. That matters because this editor round-trips:
// every popover edit REBUILDS the whole token from state, so a segment the parser could not
// represent disappears the moment the user ticks any checkbox — and the loss is written back
// to the profile. Two ways a segment goes unrepresented:
//
//   1. It is unknown entirely — a future modifier, or a typo ({clipboard:uppercase}).
//   2. It is a KNOWN arg-taking modifier whose argument fails its gate, so the modifier is
//      recognised but no state is set: {clipboard:lines:sort} parses `lines` (no digit in
//      `sort`, so it is not its argument), sets nothing, and rebuilds as just `{clipboard:sort}`.
//
// Either way the answer is the same — refuse to rebuild. `unmodeled` is what the consumers
// branch on to go read-only.
function parseModifierParts(parts: string[], from: number): TransformState {
  const state: TransformState = { ...DEFAULT_TRANSFORM };
  for (let i = from; i < parts.length; i++) {
    const p = parts[i].toLowerCase();
    switch (p) {
      case 'trim':
        state.trim = true;
        break;
      case 'upper':
      case 'lower':
      case 'sentence':
      case 'title':
        state.case = p;
        break;
      case 'line':
      case 'word': {
        // A reference is consumed unconditionally (shape-decided arity, mirroring the backend);
        // a literal only when it parses, so a typo like "line:upper" still leaves the following
        // segment to be read as its own modifier.
        if (isArgRef(parts[i + 1])) {
          state.extract = p;
          state.extractRef = parts[i + 1];
          i++;
          break;
        }
        const n = parseInt(parts[i + 1] ?? '', 10);
        if (Number.isFinite(n) && n >= 1) {
          state.extract = p;
          state.extractN = n;
          i++;
        } else state.unmodeled = true;   // recognised, but nothing set -> would vanish on rebuild
        break;
      }
      case 'first':
      case 'last': {
        if (isArgRef(parts[i + 1])) {
          state.limit = p;
          state.limitRef = parts[i + 1];
          i++;
          break;
        }
        const n = parseInt(parts[i + 1] ?? '', 10);
        if (Number.isFinite(n) && n >= 0) {
          state.limit = p;
          state.limitN = n;
          i++;
        } else state.unmodeled = true;
        break;
      }
      case 'range': {
        const m = (parts[i + 1] ?? '').match(/^(\d+)-(\d+)$/);
        if (m) {
          let a = parseInt(m[1], 10);
          let b = parseInt(m[2], 10);
          if (a > b) [a, b] = [b, a];
          state.listPick = 'range';
          state.rangeFrom = a;
          state.rangeTo = b;
          i++;
        } else state.unmodeled = true;
        break;
      }
      case 'lines': {
        // Digit gate mirrors the backend: a digitless arg (hand-typed
        // "{clipboard:lines:sort}") is NOT lines' argument — it falls through as
        // its own modifier. Without this, opening the chip would swallow it into
        // linesSpec and the rebuild-on-close would silently erase it.
        if (parts[i + 1] !== undefined && /\d/.test(parts[i + 1])) {
          state.listPick = 'lines';
          state.linesSpec = parts[i + 1];
          i++;
        } else state.unmodeled = true;
        break;
      }
      case 'sort':
        state.sort = true;
        break;
      case 'dedupe':
        state.dedupe = true;
        break;
      case 'reverse':
        state.reverse = true;
        break;
      case 'join': {
        // join ALWAYS owns the next part as its separator (raw, never lowercased —
        // note the switch matches on the lowercased copy, so read the original).
        state.join = true;
        if (parts[i + 1] !== undefined) {
          state.joinSep = parts[i + 1];
          i++;
        } else {
          state.joinSep = ' '; // hand-typed trailing "join" — backend falls back to space
        }
        break;
      }
      default:
        // Anything this editor does not know: a modifier added to the backend but not here yet,
        // or a typo. Either way rebuilding would drop it, so refuse to rebuild.
        state.unmodeled = true;
        break;
    }
  }
  return state;
}
