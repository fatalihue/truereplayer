// Pure logic for the {clipboard[:mods]} token format. Shared between the side-panel
// "Advanced Clipboard" insert popover and the chip click-to-edit popover.
//
// Modifier order in the emitted chain MUST match the backend ApplyClipboardModifiers
// pipeline: trim → range/lines → sort → dedupe → reverse → join → line/word →
// first/last → upper/lower/sentence/title. (List ops narrow/reshape the multiline
// content first; line/word then extracts a single piece; limit and case finish.)

export type CaseTransform = 'none' | 'upper' | 'lower' | 'sentence' | 'title';
export type Extract = 'none' | 'line' | 'word';
export type Limit = 'none' | 'first' | 'last';
export type ListPick = 'none' | 'range' | 'lines';

export interface TransformState {
  trim: boolean;
  case: CaseTransform;
  extract: Extract;
  extractN: number;
  limit: Limit;
  limitN: number;
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
  trim: false,
  case: 'none',
  extract: 'none',
  extractN: 1,
  limit: 'none',
  limitN: 10,
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
  const parts = ['clipboard'];
  if (s.trim) parts.push('trim');
  if (s.listPick === 'range') parts.push('range', `${s.rangeFrom}-${s.rangeTo}`);
  else if (s.listPick === 'lines' && /\d/.test(s.linesSpec)) parts.push('lines', s.linesSpec);
  if (s.sort) parts.push('sort');
  if (s.dedupe) parts.push('dedupe');
  if (s.reverse) parts.push('reverse');
  // join ALWAYS emits its separator as the very next part — an explicit empty part
  // ("...:join:") means empty separator. Matches the backend's consume-one-arg rule.
  if (s.join) parts.push('join', s.joinSep);
  if (s.extract === 'line') parts.push('line', String(s.extractN));
  else if (s.extract === 'word') parts.push('word', String(s.extractN));
  if (s.limit === 'first') parts.push('first', String(s.limitN));
  else if (s.limit === 'last') parts.push('last', String(s.limitN));
  if (s.case === 'upper') parts.push('upper');
  else if (s.case === 'lower') parts.push('lower');
  else if (s.case === 'sentence') parts.push('sentence');
  else if (s.case === 'title') parts.push('title');
  return '{' + parts.join(':') + '}';
}

// Same CRLF normalization the backend's SplitContentLines / line:N use.
function splitLines(t: string): string[] {
  return t.replace(/\r\n/g, '\n').split('\n');
}

// Mirror of backend ApplyClipboardModifiers — used for the live preview only.
// Every backend modifier needs a mirrored branch here or the preview lies.
export function applyTransformPreview(raw: string, s: TransformState): string {
  let r = raw;
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
  const state: TransformState = { ...DEFAULT_TRANSFORM };
  if (!/^\{clipboard(?::|\})/i.test(token)) return state;
  const inner = token.slice(1, -1);
  const parts = inner.split(':');
  // parts[0] === 'clipboard'; iterate the modifier tail.
  for (let i = 1; i < parts.length; i++) {
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
        const n = parseInt(parts[i + 1] ?? '', 10);
        if (Number.isFinite(n) && n >= 1) {
          state.extract = p;
          state.extractN = n;
          i++;
        }
        break;
      }
      case 'first':
      case 'last': {
        const n = parseInt(parts[i + 1] ?? '', 10);
        if (Number.isFinite(n) && n >= 0) {
          state.limit = p;
          state.limitN = n;
          i++;
        }
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
        }
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
        }
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
    }
  }
  return state;
}
