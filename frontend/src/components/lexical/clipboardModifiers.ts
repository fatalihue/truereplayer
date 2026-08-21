// Pure logic for the {clipboard[:mods]} and {row:column[:mods]} token formats. Shared
// between the side-panel "Advanced Clipboard" insert popover and the chip click-to-edit
// popovers (clipboard + data-row cell — both run the SAME backend modifier pipeline).
//
// Modifier order in the emitted chain MUST match the backend pipeline:
// next → trim → before/after → range/lines → sort → dedupe → reverse → join → words →
// line/word → first/last → upper/lower/sentence/title. ('next' picks WHICH text the rest sees
// and is handled in ResolveClipboardTokensAsync, ahead of ApplyClipboardModifiers; the split
// cuts the RAW text at a delimiter, list ops then narrow/reshape the multiline content, words
// takes a span and line/word a single piece, limit and case finish.)

export type CaseTransform = 'none' | 'upper' | 'lower' | 'sentence' | 'title';
export type Extract = 'none' | 'line' | 'word' | 'words';
export type Limit = 'none' | 'first' | 'last';
export type ListPick = 'none' | 'range' | 'lines';
/** Which side of the delimiter to keep. `splitLast` picks the last occurrence instead of the first. */
export type Split = 'none' | 'before' | 'after';

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

/**
 * ARITY mirror of the backend TryParseSpan — splits on the FIRST '-', each PRESENT side
 * int.TryParse. Either side may be omitted for an open end ("6-", "-5"); a bare "-" carries no
 * bound and is not a span, so it must stay rejected here too or the two sides would disagree
 * about whether the following segment is an argument.
 *
 * This answers "does the backend CONSUME this segment?", which is a different question from
 * "can these controls SHOW it?" — see parseSpanState.
 */
function isSpan(s: string | undefined): boolean {
  if (s === undefined || s.length === 0) return false;
  const dash = s.indexOf('-');
  if (dash < 0) return false;
  const left = s.slice(0, dash);
  const right = s.slice(dash + 1);
  if (left.length === 0 && right.length === 0) return false;
  if (left.length > 0 && tryParseInt(left) === null) return false;
  if (right.length > 0 && tryParseInt(right) === null) return false;
  return true;
}

/**
 * REPRESENTABILITY of a span: only bare non-negative digits round-trip through two number
 * fields. " 3 ", "+3" and "--5" are all consumed by the backend but would come back rewritten,
 * so they are refused here and the chain goes read-only — the same posture line/word take.
 * null on either side = open end.
 */
function parseSpanState(s: string | undefined): { from: number | null; to: number | null } | null {
  if (s === undefined) return null;
  const m = /^(\d*)-(\d*)$/.exec(s);
  if (!m || (m[1].length === 0 && m[2].length === 0)) return null;
  let from = m[1].length > 0 ? Number(m[1]) : null;
  let to = m[2].length > 0 ? Number(m[2]) : null;
  // The backend swaps reversed bounds, so a closed span round-trips in MEANING either way;
  // swapping here keeps the rebuilt token byte-identical to what the controls will emit.
  if (from !== null && to !== null && from > to) [from, to] = [to, from];
  return { from, to };
}

/**
 * The bounds as the RUN will actually see them, or null when the step is not emitted at all.
 *
 * One function so the token, the preview and the step badge can never disagree about a span —
 * they used to. `words:4-1` was emitted verbatim, the backend swapped it (TryParseSpan does) and
 * pasted words 1..4, while the preview ran sliceWords(4, 1) and showed EMPTY. A preview that says
 * "nothing" about a token that pastes a sentence is the worst kind of wrong, and it was reachable
 * by clicking: type 4 in the first field, 1 in the second.
 */
function effectiveSpan(from: number | null, to: number | null): { from: number; to: number } | null {
  if (from === null && to === null) return null;
  let a = from ?? 1;
  let b = to ?? Number.POSITIVE_INFINITY;
  if (a > b) [a, b] = [b, a];
  return { from: a, to: b };
}

/**
 * Serializes a span back to "a-b", with an omitted side for an open end. null = emit nothing,
 * which is what BOTH ends open means: a bare "-" carries no bound, the backend would not consume
 * it, and the step would sit inert — so there is nothing honest to write.
 *
 * Reversed bounds are emitted ALREADY SWAPPED. They mean the same thing to the engine either way,
 * but "4-1" did not round-trip: the parser swapped it, the rebuild came out "1-4", and
 * assertRebuildable froze the chip read-only the next time it was opened.
 */
function spanText(from: number | null, to: number | null): string | null {
  if (from === null && to === null) return null;
  if (from !== null && to !== null && from > to) [from, to] = [to, from];
  return `${from ?? ''}-${to ?? ''}`;
}

type ArgKind = 'none' | 'raw' | 'rawsplit' | 'count1' | 'count0' | 'span' | 'indices';

const argOf = (modifier: string): ArgKind => {
  switch (modifier) {
    // Freeform-text arguments — a separator (join) or a cut point (the split family).
    //
    // They are NOT the same kind, and the split is not cosmetic: `join` may legitimately take an
    // EMPTY separator, which buildModifierParts emits as an explicit empty part, so
    // "{clipboard:join::upper}" already means "glue with nothing, then upper" and its "::" is
    // spoken for. The split family never emits an empty delimiter (one leaves the modifier
    // inert), so ITS "::" was free to mean an escaped colon. Mirror of the backend's ArgOf.
    case 'join': return 'raw';
    case 'before': case 'after': case 'beforelast': case 'afterlast': return 'rawsplit';
    case 'line': case 'word': return 'count1';
    case 'first': case 'last': return 'count0';
    case 'range': case 'words': return 'span';
    case 'lines': return 'indices';
    default: return 'none';
  }
};

/**
 * Mirror of the backend's ActionReplayer.ReadSplitDelimiter: reads the delimiter of the
 * split-family modifier at `i` and reports where the next modifier starts. "::" is ONE literal
 * colon — the chain was split on ':' before anyone got here, so an escaped colon arrives as an
 * EMPTY segment between the two halves and this stitches them back together.
 *
 * Arity comes from SHAPE alone, as everywhere else in this walk: how many segments are consumed
 * depends on WHERE the empty segments are, never on what any of them hold.
 */
function readSplitDelimiter(parts: string[], i: number): { delim: string; next: number } {
  let j = i + 1;
  // No argument at all (a hand-typed "...:after" at the tail): empty delimiter, and the step
  // below lands safely past the end — the same fall-through raw has always had.
  let delim = j < parts.length ? parts[j] : '';
  // An empty follower is a "::" seam ONLY when something follows it — bound j+2, not j+1.
  // "after:Total:" is a chain that merely ENDS in a colon (delimiter "Total", plus an inert
  // empty modifier, exactly as 2.22.0 read it); "after:Total::" is the real seam (delimiter
  // "Total:"). buildModifierParts always DOUBLES a trailing colon, so the one-empty shape is
  // never something this editor wrote, and absorbing it would redefine chains already on disk.
  while (j + 2 < parts.length && parts[j + 1].length === 0) {
    delim += ':' + parts[j + 2];
    j += 2;
  }
  return { delim, next: j + 1 };
}

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
  // The split family owns a VARIABLE number of segments once "::" is in play, and
  // readSplitDelimiter is the single place that decides how many — so every walk routing
  // through here inherits the escape instead of re-deriving it.
  if (kind === 'rawsplit') return { next: readSplitDelimiter(parts, i).next, argIsRef: false };
  if (i + 1 >= parts.length) return { next: kind === 'raw' ? i + 2 : i + 1, argIsRef: false };

  const arg = parts[i + 1];
  if (kind === 'raw') return { next: i + 2, argIsRef: false };
  if (isArgRef(arg)) return { next: i + 2, argIsRef: true };

  let literalFits: boolean;
  switch (kind) {
    case 'count1': { const n = tryParseInt(arg); literalFits = n !== null && n >= 1; break; }
    case 'count0': { const n = tryParseInt(arg); literalFits = n !== null && n >= 0; break; }
    case 'span': literalFits = isSpan(arg); break;
    case 'indices': literalFits = /[0-9]/.test(arg); break;
    default: literalFits = false;
  }
  return { next: literalFits ? i + 2 : i + 1, argIsRef: false };
}

/**
 * Indices into `parts` that hold the ARGUMENT of a freeform-text modifier — a join separator or
 * a split delimiter. Whoever normalises a chain must leave these alone: case-folding them
 * rewrites text the user typed ({clipboard:after:AB} is not {clipboard:after:ab} on screen, even
 * though the engine matches either).
 *
 * Derived from the arity walk, not from "the previous segment spells join". That guess breaks
 * where a raw modifier's own argument spells its name: in `{clipboard:join:join:X}` the walk
 * consumes the second `join` AS the separator and then lands on `X` as a MODIFIER, while the
 * positional test sees "join immediately before it" and shields a segment that is not an
 * argument at all. Cosmetic there, but the rule has to come from the walk to stay right as
 * modifiers are added.
 *
 * A split delimiter can span SEVERAL segments once it carries an escaped colon, so every segment
 * the walk consumed is shielded, not just the first. Shielding only the head would case-fold the
 * far side of the escape — `{clipboard:after:A::B}` would come back as `A::b` — which is the very
 * rewriting-what-the-user-typed this set exists to prevent.
 */
export function verbatimArgIndices(parts: string[], from: number): Set<number> {
  const out = new Set<number>();
  for (let i = from; i < parts.length;) {
    const { next } = stepModifier(parts, i);
    const kind = argOf(parts[i].toLowerCase());
    if (kind === 'rawsplit') for (let k = i + 1; k < next; k++) out.add(k);
    else if (next === i + 2 && kind === 'raw') out.add(i + 1);
    i = next;
  }
  return out;
}

export interface TransformState {
  // {clipboard:next} — take ONE line per use and advance a cursor, instead of the whole
  // clipboard. Clipboard-only: {row:col}/{rownext:col} share this state object but their
  // heads have no such modifier, so it is emitted by buildClipboardToken alone (never by
  // the shared buildModifierParts) and only parseClipboardToken ever sets it.
  next: boolean;
  trim: boolean;
  case: CaseTransform;
  // Split at a delimiter — cuts the RAW text before the list ops reshape it. `splitDelim` is
  // freeform text consumed verbatim (the join rule); an EMPTY delimiter is never emitted, since
  // the backend leaves the content untouched for one and the controls would be lying.
  split: Split;
  splitDelim: string;
  splitLast: boolean;      // cut at the LAST occurrence (beforelast/afterlast)
  extract: Extract;
  extractN: number;
  // extract === 'words' — the span of words a..b. null on either side = open end
  // ({clipboard:words:6-} is "word 6 onwards"). Kept separate from extractN because a span is
  // two bounds, and separate from rangeFrom/rangeTo because those count LINES.
  wordsFrom: number | null;
  wordsTo: number | null;
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
  rangeFrom: number | null;   // null = open end, same as the word span above
  rangeTo: number | null;
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
  split: 'none',
  splitDelim: '',
  splitLast: false,
  extract: 'none',
  extractN: 1,
  wordsFrom: 1,
  wordsTo: null,
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
  // An empty delimiter is not a cut point — the backend leaves the content untouched for one,
  // so emitting the modifier would put a step in the token that does nothing. Same care the
  // `lines` spec takes about needing a digit.
  if (s.split !== 'none' && s.splitDelim.length > 0) {
    // A colon in the delimiter is doubled: the array below is flattened with .join(':'), so an
    // "::" survives the flattening and readSplitDelimiter stitches it back on the way in. This
    // is the ONLY place that escapes — state.splitDelim always holds the literal delimiter, so
    // the preview and the input field never see the escaped form.
    parts.push(s.split + (s.splitLast ? 'last' : ''), s.splitDelim.replace(/:/g, '::'));
  }
  if (s.listPick === 'range') {
    const arg = spanText(s.rangeFrom, s.rangeTo);
    // Both ends open carries no bound; the backend would read the bare "-" as a non-argument
    // and leave `range` inert, so there is nothing honest to write.
    if (arg !== null) parts.push('range', arg);
  } else if (s.listPick === 'lines' && /\d/.test(s.linesSpec)) parts.push('lines', s.linesSpec);
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
  if (s.extract === 'words') {
    const arg = spanText(s.wordsFrom, s.wordsTo);
    if (arg !== null) parts.push('words', arg);
  }
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

// Mirror of the backend SliceWords, offset-for-offset. It returns a SUBSTRING rather than
// splitting and re-joining, so the whitespace between the kept words survives exactly — a
// preview built on `split(/\s+/).join(' ')` would quietly show normalised spacing that runtime
// never produces. Same separator set as word:N (space, tab, CR, LF), not /\s/, which would also
// match Unicode spaces the backend leaves inside a word.
const isWordSeparator = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

function sliceWords(content: string, from: number, to: number): string {
  if (!content || to < 1) return '';
  const f = from < 1 ? 1 : from;
  let start = -1;
  let end = -1;
  let index = 0;
  let i = 0;
  while (i < content.length) {
    while (i < content.length && isWordSeparator(content[i])) i++;
    if (i >= content.length) break;
    const wordStart = i;
    while (i < content.length && !isWordSeparator(content[i])) i++;
    index++;
    if (index === f) start = wordStart;
    if (index <= to) end = i;
    if (index >= to) break;
  }
  return start < 0 || end <= start ? '' : content.slice(start, end);
}

// Mirror of backend ApplyClipboardModifiers — used for the live preview only.
// Every backend modifier needs a mirrored branch here or the preview lies.
/**
 * True when the chain depends on a value that only exists at run time, so no honest preview can
 * be computed. Surfaces MUST branch on this and say so rather than render a number — showing the
 * result for index 1 when the real index comes from a variable is the same class of lie as the
 * WaitImage 100%-confidence footgun: authoritative-looking and wrong.
 */
/** Only line/word read `extractRef`; a word SPAN carries its bounds in wordsFrom/wordsTo, so
 *  asking about the reference field there would answer about a leftover from another mode. */
const extractUsesRef = (s: TransformState): boolean => s.extract === 'line' || s.extract === 'word';

export const previewIsRuntimeDependent = (s: TransformState): boolean =>
  (extractUsesRef(s) && isArgRef(s.extractRef)) || (s.limit !== 'none' && isArgRef(s.limitRef));

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
  (extractUsesRef(s) && !!s.extractRef && !isArgRef(s.extractRef)) ||
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
  if (s.split !== 'none' && s.splitDelim.length > 0) {
    // OrdinalIgnoreCase on the backend — fold both sides to find the index, then cut the
    // ORIGINAL so the surviving text keeps its own casing.
    const hay = r.toLowerCase();
    const needle = s.splitDelim.toLowerCase();
    const at = s.splitLast ? hay.lastIndexOf(needle) : hay.indexOf(needle);
    // Delimiter absent → empty, never the whole content (the backend's fail-closed rule).
    if (at < 0) r = '';
    else r = s.split === 'before' ? r.slice(0, at) : r.slice(at + s.splitDelim.length);
  }
  // null = the builder emits no `range` at all (both ends open), so the preview must skip the
  // step too — it used to run it, and silently reported CRLF-normalised text for a token that
  // does not touch the content.
  const rangeSpan = s.listPick === 'range' ? effectiveSpan(s.rangeFrom, s.rangeTo) : null;
  if (rangeSpan) {
    const lines = splitLines(r);
    const from = Math.max(1, rangeSpan.from);
    const to = Math.min(lines.length, rangeSpan.to);
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
  // Same rule as the range span above: bounds exactly as the emitted token carries them, and no
  // step at all when the token carries none.
  const wordSpan = s.extract === 'words' ? effectiveSpan(s.wordsFrom, s.wordsTo) : null;
  if (wordSpan) {
    r = sliceWords(r, wordSpan.from, wordSpan.to);
  } else if (s.extract === 'line') {
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

// {var:name[:mods]} and {clip:name[:mods]} — the same modifier tail as the row tokens, on a head
// whose first argument is a user-chosen NAME. No mods → plain {var:name}, byte-identical to what
// NamePromptPopover inserts.
export function buildNameToken(head: 'var' | 'clip', name: string, s: TransformState): string {
  return '{' + [head, name, ...buildModifierParts(s)].join(':') + '}';
}

export function parseNameToken(token: string, head: 'var' | 'clip'): { name: string; state: TransformState } {
  const re = head === 'var' ? /^\{var:/i : /^\{clip:/i;
  if (!re.test(token)) return { name: '', state: { ...DEFAULT_TRANSFORM } };
  const parts = token.slice(1, -1).split(':');
  const name = parts[1] ?? '';
  const state = parseModifierParts(parts, 2);
  return { name, state: assertRebuildable(state, token, buildNameToken(head, name, state)) };
}

// {winclip[:N][:mods]} — item N of the Windows clipboard history. The index is optional and
// DIGITS ONLY, which is exactly what keeps {winclip:trim} unambiguous on both sides. The builder
// always writes the index, so the two never have to be told apart by position.
export function buildWinClipToken(index: number, s: TransformState): string {
  return '{' + ['winclip', String(index), ...buildModifierParts(s)].join(':') + '}';
}

export function parseWinClipToken(token: string): { index: number; state: TransformState } {
  if (!/^\{winclip(?::|\})/i.test(token)) return { index: 1, state: { ...DEFAULT_TRANSFORM } };
  const parts = token.slice(1, -1).split(':');
  const hasIndex = parts[1] !== undefined && /^\d+$/.test(parts[1]);
  const index = hasIndex ? Math.max(1, Number(parts[1])) : 1;
  const state = parseModifierParts(parts, hasIndex ? 2 : 1);
  // Compare against the token with the index made EXPLICIT. A bare {winclip} means index 1, so
  // rebuilding it as {winclip:1} loses nothing — comparing against the bare form instead would
  // flag every plain history chip as unrebuildable and freeze its editor.
  //
  // The index goes in RAW, not clamped. Folding the clamp in here made assertRebuildable compare
  // {winclip:1} against {winclip:1} and wave through a rewrite of {winclip:0} — which the engine
  // resolves to NOTHING (its gate is n >= 1) — into {winclip:1}, which pastes the last thing
  // copied. Silently swapping "paste nothing" for "paste the clipboard" is exactly what this
  // guard exists to stop, so an out-of-range index goes read-only instead.
  const rawIndex = hasIndex ? parts[1] : '1';
  const normalised = '{' + ['winclip', rawIndex, ...parts.slice(hasIndex ? 2 : 1)].join(':') + '}';
  return { index, state: assertRebuildable(state, normalised, buildWinClipToken(index, state)) };
}

// ── The chain-bearing heads, as one dispatch ─────────────────────────────────────────────────
//
// Six token shapes now carry the SAME modifier tail. Every surface that edits one needs the same
// three answers — is this a chain token, what is its identity, how do I write it back — and each
// of them getting its own copy of the head list is how the routing and the editor drift apart.
// `head` holds the part that is NOT the chain: a column, a name, a history index.
export type ChainHead =
  | { kind: 'clipboard' }
  | { kind: 'row'; column: string }
  | { kind: 'rownext'; column: string }
  | { kind: 'var'; name: string }
  | { kind: 'clip'; name: string }
  | { kind: 'winclip'; index: number };

export type ChainHeadKind = ChainHead['kind'];

/** The head kind of a chain-bearing token, or null for anything else ({enter}, {date}, …). */
export function chainHeadKind(token: string): ChainHeadKind | null {
  if (token.length < 3 || token[0] !== '{' || token[token.length - 1] !== '}') return null;
  const inner = token.slice(1, -1);
  const name = inner.split(':')[0].toLowerCase();
  switch (name) {
    case 'clipboard': return 'clipboard';
    // These four need their argument to be a token at all: the engine's regexes all require
    // ':name' / ':column', so a bare {var} or {clip} resolves to nothing and there is no identity
    // for the builder to edit. Routing them to it opened a surface whose Token box read "{var:}"
    // and whose Apply button did nothing — a dead end. They fall through to the popover, which
    // has a name field to fill in. (A bare {row} is the action-row counter, a different token.)
    case 'row':
    case 'rownext':
    case 'var':
    case 'clip':
      return inner.includes(':') ? name as ChainHeadKind : null;
    case 'winclip': return 'winclip';
    default: return null;
  }
}

export function parseChainToken(token: string): { head: ChainHead; state: TransformState } | null {
  const kind = chainHeadKind(token);
  if (kind === null) return null;
  switch (kind) {
    case 'clipboard':
      return { head: { kind }, state: parseClipboardToken(token) };
    case 'row': {
      const r = parseRowToken(token);
      return { head: { kind, column: r.column }, state: r.state };
    }
    case 'rownext': {
      const r = parseRowNextToken(token);
      return { head: { kind, column: r.column }, state: r.state };
    }
    case 'var':
    case 'clip': {
      const r = parseNameToken(token, kind);
      return { head: { kind, name: r.name }, state: r.state };
    }
    case 'winclip': {
      const r = parseWinClipToken(token);
      return { head: { kind, index: r.index }, state: r.state };
    }
  }
}

export function buildChainToken(head: ChainHead, s: TransformState): string {
  switch (head.kind) {
    case 'clipboard': return buildClipboardToken(s);
    case 'row': return buildRowToken(head.column, s);
    case 'rownext': return buildRowNextToken(head.column, s);
    case 'var': return buildNameToken('var', head.name, s);
    case 'clip': return buildNameToken('clip', head.name, s);
    case 'winclip': return buildWinClipToken(head.index, s);
  }
}

/** Whether the head's identity is filled in — an empty column or name would build a broken token. */
export function chainHeadIsUsable(head: ChainHead): boolean {
  switch (head.kind) {
    case 'row': case 'rownext': return head.column.length > 0;
    case 'var': case 'clip': return head.name.length > 0;
    default: return true;
  }
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
          const span = parseSpanState(arg);
          if (span) {
            state.listPick = 'range';
            state.rangeFrom = span.from;
            state.rangeTo = span.to;
          } else lose();
        }
        break;
      case 'words':
        // Same treatment as range — the bounds are a literal span, a reference cannot be shown.
        if (argIsRef) { state.unmodeled = true; sawRefArg = true; }
        else {
          const span = parseSpanState(arg);
          if (span) {
            state.extract = 'words';
            state.wordsFrom = span.from;
            state.wordsTo = span.to;
          } else lose();
        }
        break;
      case 'before':
      case 'after':
      case 'beforelast':
      case 'afterlast':
        // Raw arity, like join: the delimiter is whatever follows, read from the ORIGINAL parts
        // (the switch matched on a lowercased copy) and re-emitted verbatim, so anything the
        // backend consumes here round-trips byte-for-byte. Unlike join it may span several
        // segments — "::" is one literal colon — and readSplitDelimiter is the same helper
        // stepModifier used to decide `next`, so the state and the arity can never disagree.
        state.split = p.startsWith('before') ? 'before' : 'after';
        state.splitLast = p.endsWith('last');
        state.splitDelim = readSplitDelimiter(parts, i).delim;
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
