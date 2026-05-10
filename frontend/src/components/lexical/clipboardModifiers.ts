// Pure logic for the {clipboard[:mods]} token format. Shared between the side-panel
// "Advanced Clipboard" insert popover and the chip click-to-edit popover.
//
// Modifier order in the emitted chain MUST match the backend ApplyClipboardModifiers
// pipeline: trim → line/word → first/last → upper/lower/sentence/title.

export type CaseTransform = 'none' | 'upper' | 'lower' | 'sentence' | 'title';
export type Extract = 'none' | 'line' | 'word';
export type Limit = 'none' | 'first' | 'last';

export interface TransformState {
  trim: boolean;
  case: CaseTransform;
  extract: Extract;
  extractN: number;
  limit: Limit;
  limitN: number;
}

export const DEFAULT_TRANSFORM: TransformState = {
  trim: false,
  case: 'none',
  extract: 'none',
  extractN: 1,
  limit: 'none',
  limitN: 10,
};

export function buildClipboardToken(s: TransformState): string {
  const parts = ['clipboard'];
  if (s.trim) parts.push('trim');
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

// Mirror of backend ApplyClipboardModifiers — used for the live preview only.
export function applyTransformPreview(raw: string, s: TransformState): string {
  let r = raw;
  if (s.trim) r = r.trim();
  if (s.extract === 'line') {
    const lines = r.replace(/\r\n/g, '\n').split('\n');
    r = lines[s.extractN - 1] ?? '';
  } else if (s.extract === 'word') {
    const words = r.split(/\s+/).filter(Boolean);
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
    }
  }
  return state;
}
