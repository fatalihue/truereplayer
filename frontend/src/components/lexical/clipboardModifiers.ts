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
const LETTER_OR_DIGIT = /[\p{L}\p{Nd}]/u;   // char.IsLetterOrDigit: any Unicode letter or decimal digit

export const isArgRef = (seg: string | undefined): boolean => {
  if (seg === undefined || seg.length < 2) return false;
  if (seg[0] !== '@') return false;
  // Per UTF-16 code unit, exactly like the C# char loop — a lone surrogate is not a letter there
  // and must not be one here. `/^@[A-Za-z0-9_]+$/` was ASCII-only, so "@código" was a valid
  // reference to the backend and an unknown modifier to this editor.
  for (let k = 1; k < seg.length; k++) {
    const c = seg[k];
    if (c !== '_' && !LETTER_OR_DIGIT.test(c)) return false;
  }
  return true;
};

/**
 * int.TryParse with the default NumberStyles.Integer: optional surrounding whitespace, optional
 * sign, decimal digits, and it must fit in Int32. Returns null when the backend would reject it.
 *
 * The parser used to gate on `parseInt`, which is a different function wearing the same name:
 * parseInt('3x') is 3. So {clipboard:line:3x} parsed as "line 3" and any edit REBUILT it as
 * {clipboard:line:3} — while the backend read the original as a typo, left `line` inert and
 * returned the whole content. A silent rewrite that changed what the macro does.
 */
function tryParseInt(s: string | undefined): number | null {
  if (s === undefined) return null;
  if (!/^\s*[+-]?\d+\s*$/.test(s)) return null;
  const n = Number(s.trim());
  return Number.isSafeInteger(n) && n >= -2147483648 && n <= 2147483647 ? n : null;
}

/** Mirror of the backend TryParseLineRange — splits on the FIRST '-', both sides int.TryParse. */
function isLineRange(s: string | undefined): boolean {
  if (s === undefined) return false;
  const dash = s.indexOf('-');
  if (dash <= 0 || dash >= s.length - 1) return false;
  return tryParseInt(s.slice(0, dash)) !== null && tryParseInt(s.slice(dash + 1)) !== null;
}

type ArgKind = 'none' | 'raw' | 'count1' | 'count0' | 'range' | 'indices';

const argOf = (modifier: string): ArgKind => {
  switch (modifier) {
    case 'join': return 'raw';
    case 'line': case 'word': return 'count1';
    case 'first': case 'last': return 'count0';
    case 'range': return 'range';
    case 'lines': return 'indices';
    default: return 'none';
  }
};

/**
 * Mirror of the backend's ActionReplayer.StepModifier: advances past ONE modifier and reports
 * where the next one starts and whether the argument consumed was a reference.
 *
 * Every walk on this side goes through it, as the three C# walks go through StepModifier. The
 * gates were transcribed by hand in two places before, and a transcribed rule is a rule that
 * eventually drifts — which is exactly how the backend's own reference detector came to disagree
 * with its applier about {clipboard:line:first:@n}.
 */
function stepModifier(parts: string[], i: number): { next: number; argIsRef: boolean } {
  const kind = argOf(parts[i].toLowerCase());
  if (kind === 'none') return { next: i + 1, argIsRef: false };
  if (i + 1 >= parts.length) return { next: kind === 'raw' ? i + 2 : i + 1, argIsRef: false };

  const arg = parts[i + 1];
  if (kind === 'raw') return { next: i + 2, argIsRef: false };
  if (isArgRef(arg)) return { next: i + 2, argIsRef: true };

  let literalFits: boolean;
  switch (kind) {
    case 'count1': { const n = tryParseInt(arg); literalFits = n !== null && n >= 1; break; }
    case 'count0': { const n = tryParseInt(arg); literalFits = n !== null && n >= 0; break; }
    case 'range': literalFits = isLineRange(arg); break;
    case 'indices': literalFits = /[0-9]/.test(arg); break;
    default: literalFits = false;
  }
  return { next: literalFits ? i + 2 : i + 1, argIsRef: false };
}

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
  /** Why: the unrepresentable part is an "@name" argument on `range`/`lines`, which the backend
   *  supports and pins but whose controls here are literal-only (a range is "a-b", not a number,
   *  so it has no ArgInput). Going read-only is still the right answer — the point of this flag is
   *  that the copy must not blame "a modifier this editor does not know" when the editor knows the
   *  modifier perfectly well and only cannot SHOW the argument. */
  unmodeledRefArg: boolean;
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
  unmodeledRefArg: false,
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
  // isArgRef, not merely non-empty. The `@` toggle writes a bare "@" the instant it is clicked,
  // and emitting THAT wrote a token the parser cannot read back: reopening the chip hit
  // parseInt('@') = NaN, set `unmodeled`, and the popover was read-only forever — a trap the
  // editor laid for itself with one click. Until the name is finished the chain keeps the fixed
  // number, which is a valid token and exactly what the field beside it still shows.
  const extractArg = isArgRef(s.extractRef) ? s.extractRef : String(s.extractN);
  if (s.extract === 'line') parts.push('line', extractArg);
  else if (s.extract === 'word') parts.push('word', extractArg);
  const limitArg = isArgRef(s.limitRef) ? s.limitRef : String(s.limitN);
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
  (s.extract !== 'none' && isArgRef(s.extractRef)) || (s.limit !== 'none' && isArgRef(s.limitRef));

/**
 * The reference field holds something the backend would NOT read as a reference — in practice just
 * "@", which the toggle writes the instant it is clicked, before a name is typed.
 *
 * The token keeps the fixed number until the name is finished (see buildModifierParts), so nothing
 * is broken — but the field on screen says "@" while the chain says "1", and `previewIsRuntimeDependent`
 * used to call that state runtime-dependent and print "resolved when the macro runs" for a value
 * that would never be resolved. Surfaces say the reference is unfinished instead.
 */
export const argRefIsUnfinished = (s: TransformState): boolean =>
  (s.extract !== 'none' && !!s.extractRef && !isArgRef(s.extractRef)) ||
  (s.limit !== 'none' && !!s.limitRef && !isArgRef(s.limitRef));

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
  // An unfinished reference emits the NUMBER (see buildModifierParts), so previewing the number
  // is the honest thing — it is literally what the token beside this preview says.
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

/**
 * The last gate, and the only one that cannot be out-argued: if rebuilding the parsed state does
 * not reproduce the token, this editor CANNOT edit it without changing it, whatever the reason.
 *
 * Per-modifier gates only catch the reasons somebody thought of. They missed two whole families:
 *   - a modifier used TWICE where the state has one slot. `{clipboard:join:trim:join}` joins with
 *     "trim" and then again with a space; the state holds one separator, so it rebuilt as
 *     `{clipboard:join: }` — a different result. `reverse:reverse` is identity and rebuilt as one
 *     `reverse`, which is not.
 *   - a chain in a different ORDER. The builder emits the fixed backend pipeline order, so
 *     `{clipboard:upper:join:x}` came back as `{clipboard:join:x:upper}` — upper before the join
 *     versus after it, which is a different string whenever the separator has letters.
 * Neither is exotic; both are what you get by hand-typing a token that reads naturally.
 *
 * Case is folded because the backend lowercases modifier names too, so `{clipboard:TRIM}` really
 * is the same token — and a `join` separator round-trips verbatim, so folding can never wave
 * through a chain whose separator actually differs.
 */
function assertRebuildable(state: TransformState, original: string, rebuilt: string): TransformState {
  if (rebuilt.toLowerCase() !== original.toLowerCase()) state.unmodeled = true;
  return state;
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
  // `next` is compared at the head, which is free: the backend strips it out before applying the
  // chain, so where the user wrote it never meant anything.
  const normalised = '{' + ['clipboard', ...(at >= 0 ? ['next'] : []), ...parts.slice(1)].join(':') + '}';
  return assertRebuildable(state, normalised, buildClipboardToken(state));
}

// Mirror of the backend's TrySplitNextModifier walk (ActionExecution.cs): returns the index of
// the standalone 'next' segment, or -1. Steps over ARGUMENTS exactly as the applier does, so a
// join separator that happens to be the word "next" ({clipboard:join:next}) is left alone — the
// backend treats it as a separator, and the two sides must agree or the chip rewrites the token
// into something that behaves differently.
function findNextModifier(parts: string[], from: number): number {
  for (let i = from; i < parts.length; ) {
    // Only a segment the walk LANDS on is a modifier — one it steps over is somebody's argument.
    if (parts[i].toLowerCase() === 'next') return i;
    i = stepModifier(parts, i).next;
  }
  return -1;
}

// Reverse of buildRowToken — column name (verbatim) + hydrated modifier state.
// parts[0] === 'row', parts[1] === column, mods from 2 on.
export function parseRowToken(token: string): { column: string; state: TransformState } {
  if (!/^\{row:/i.test(token)) return { column: '', state: { ...DEFAULT_TRANSFORM } };
  const parts = token.slice(1, -1).split(':');
  const column = parts[1] ?? '';
  const state = parseModifierParts(parts, 2);
  return { column, state: assertRebuildable(state, token, buildRowToken(column, state)) };
}

// Reverse of buildRowNextToken — {rownext:column[:mods]} → column name (verbatim) + modifier state.
export function parseRowNextToken(token: string): { column: string; state: TransformState } {
  if (!/^\{rownext:/i.test(token)) return { column: '', state: { ...DEFAULT_TRANSFORM } };
  const parts = token.slice(1, -1).split(':');
  const column = parts[1] ?? '';
  const state = parseModifierParts(parts, 2);
  return { column, state: assertRebuildable(state, token, buildRowNextToken(column, state)) };
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
  // Two distinct reasons the chain can be unrepresentable, tracked separately and resolved at the
  // end. A single sticky flag got this wrong: `{clipboard:range:@r:frobnicate}` set the reference
  // reason and then the unknown-modifier reason, and the surfaces — which branch on the reference
  // reason first — told the user the token was fine and never mentioned `frobnicate`.
  let sawRefArg = false;
  let sawOtherLoss = false;
  // ARITY comes from stepModifier — the same rule the backend applies — and is asked BEFORE any
  // representability question. The two are genuinely different: `{clipboard:line:+3}` has its
  // argument consumed by the backend but cannot be re-emitted from a number field without
  // rewriting it, so it is consumed AND unrepresentable. Deciding both with one regex is what
  // let parseInt('3x') === 3 rewrite a token into different behaviour.
  let i = from;
  while (i < parts.length) {
    const p = parts[i].toLowerCase();
    const { next, argIsRef } = stepModifier(parts, i);
    // The argument, but only when the backend would actually take it.
    const arg = next === i + 2 ? parts[i + 1] : undefined;
    const lose = () => { state.unmodeled = true; sawOtherLoss = true; };
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
      case 'word':
        // Only a bare digit string is representable: the numeric field re-emits String(n), so
        // " 3 " and "+3" would come back as "3" — a rewrite, even though the backend reads them
        // the same. Refuse rather than normalise somebody's token behind their back.
        if (argIsRef) { state.extract = p; state.extractRef = arg!; }
        else if (arg !== undefined && /^\d+$/.test(arg)) { state.extract = p; state.extractN = Number(arg); }
        else lose();
        break;
      case 'first':
      case 'last':
        if (argIsRef) { state.limit = p; state.limitRef = arg!; }
        else if (arg !== undefined && /^\d+$/.test(arg)) { state.limit = p; state.limitN = Number(arg); }
        else lose();
        break;
      case 'range':
        // A reference is consumed for the same shape-decided reason as line/word, but still
        // cannot be DISPLAYED (the control is a literal "a-b" pair), so the chain goes read-only;
        // the flag only makes the explanation name the real cause.
        if (argIsRef) { state.unmodeled = true; sawRefArg = true; }
        else {
          const m = arg !== undefined ? /^(\d+)-(\d+)$/.exec(arg) : null;
          if (m) {
            let a = Number(m[1]);
            let b = Number(m[2]);
            if (a > b) [a, b] = [b, a];   // the backend swaps too, so this round-trips in meaning
            state.listPick = 'range';
            state.rangeFrom = a;
            state.rangeTo = b;
          } else lose();
        }
        break;
      case 'lines':
        // Same reference treatment as range. The spec is re-emitted VERBATIM, so anything the
        // backend consumes here round-trips byte-for-byte and needs no second gate.
        if (argIsRef) { state.unmodeled = true; sawRefArg = true; }
        else if (arg !== undefined) { state.listPick = 'lines'; state.linesSpec = arg; }
        else lose();
        break;
      case 'sort':
        state.sort = true;
        break;
      case 'dedupe':
        state.dedupe = true;
        break;
      case 'reverse':
        state.reverse = true;
        break;
      case 'join':
        // join ALWAYS owns the next part as its separator (raw, never lowercased — the switch
        // matches on the lowercased copy, so read the original). A hand-typed trailing "join"
        // with no argument falls back to a space, as the backend does.
        state.join = true;
        state.joinSep = parts[i + 1] !== undefined ? parts[i + 1] : ' ';
        break;
      default:
        // Anything this editor does not know: a modifier added to the backend but not here yet,
        // or a typo. Either way rebuilding would drop it, so refuse to rebuild.
        lose();
        break;
    }
    i = next;
  }
  // Only claim "it's just a reference argument" when that is the WHOLE story — anything unknown
  // in the chain outranks it, because that is the reason the user cannot act on.
  state.unmodeledRefArg = sawRefArg && !sawOtherLoss;
  return state;
}
