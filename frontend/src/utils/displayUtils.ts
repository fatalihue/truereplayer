import type { ActionItem } from '../bridge/messageTypes';

const DISPLAY_KEY_MAP: Record<string, string> = {
  '162': 'Ctrl', '163': 'Ctrl',
  '160': 'Shift', '161': 'Shift',
  '20': 'Caps Lock', '144': 'Num Lock', '145': 'Scroll Lock',
  '91': 'Win', '92': 'Win',
  '164': 'Alt', '165': 'Alt', 'Menu': 'Alt',
  'Oem1': ';', 'Oem2': '/', 'Oem3': '`',
  'Oem4': '[', 'Oem5': '\\', 'Oem6': ']', 'Oem7': "'",
  'OemComma': ',', 'OemPeriod': '.',
  'OemMinus': '-', 'OemPlus': '=',
  'NumMultiply': 'Num*', 'NumDivide': 'Num/',
  'NumAdd': 'Num+', 'NumSubtract': 'Num-',
  'Return': 'Enter', 'Back': 'Backspace',
  'Capital': 'Caps Lock',
  'Next': 'Page Down', 'Prior': 'Page Up',
};

const NO_COORD_TYPES = new Set(['KeyDown', 'KeyUp', 'Keystroke', 'HoldKey', 'ScrollUp', 'ScrollDown', 'SendText', 'SetVariable', 'WaitImage', 'WaitPixelColor', 'BrowserClick', 'BrowserRightClick', 'BrowserType', 'BrowserWaitElement', 'BrowserNavigate', 'BrowserSelectOption', 'RunProfile', 'Pause', 'If', 'Else', 'EndIf']);

export function getDisplayKey(key: string): string {
  if (!key) return '';
  if (key.startsWith('D') && key.length === 2 && /\d/.test(key[1])) return key[1];
  return DISPLAY_KEY_MAP[key] ?? key;
}

// Space the '+' separators in a keystroke combo for readability in the grid:
// "Ctrl+Alt+F" → "Ctrl + Alt + F" (matches the ProfilePanel hotkey chips). Each
// part is run through getDisplayKey so raw enum names get the DISPLAY_KEY_MAP
// cleanup — a single "NumAdd" renders "Num+", "D1" renders "1" — matching how the
// HoldKey row (which uses getDisplayKey directly) shows the same key. A lone '+'
// key and a trailing literal '+' (e.g. "Ctrl++") are kept intact, same split rule
// as KbdTag.
export function formatKeyCombo(combo: string): string {
  if (!combo) return '';
  if (combo === '+') return '+';
  const parts = combo
    .split('+')
    .map((p, i, arr) => (p === '' && i === arr.length - 1 ? '+' : p))
    .filter(p => p !== '')
    .map(getDisplayKey);
  return parts.join(' + ');
}

// Format a millisecond value for display with locale thousands separators, so a
// large delay reads at a glance: 30000 → "30.000" (pt-BR) / "30,000" (en). Values
// under 1000 render as bare integers. The separator follows the UI language toggle
// on purpose — a hardcoded "." would read as a decimal to an English user, and a
// "," would to a Brazilian one. The unit ("ms") is added by the caller so it can be
// styled as a separate quiet suffix. Floats are truncated; NaN/±∞ fall back to 0.
export function formatMs(ms: number, language: 'en' | 'pt-BR'): string {
  const n = Number.isFinite(ms) ? Math.trunc(ms) : 0;
  return n.toLocaleString(language === 'pt-BR' ? 'pt-BR' : 'en-US');
}

// Pixel-coordinate display applies to the standalone WaitPixelColor action AND
// to IF rows whose condition is PixelColorMatch — both store the watched point
// in pixelX/pixelY and show it in the Details column.
function showsPixelCoords(item: ActionItem): boolean {
  return item.actionType === 'WaitPixelColor'
    || (item.actionType === 'If' && item.conditionType === 'PixelColorMatch');
}

export function getDisplayX(item: ActionItem): string {
  // Pixel probes (WaitPixelColor / IF PixelColorMatch) borrow the pixel coords
  // for display — mirrors the C# ActionItem.DisplayX override. Image conditions
  // stay blank (the matched-rect is dynamic per probe, no single XY).
  if (showsPixelCoords(item)) {
    return item.pixelX != null ? String(item.pixelX) : '';
  }
  return NO_COORD_TYPES.has(item.actionType) ? '' : String(item.x);
}

export function getDisplayY(item: ActionItem): string {
  if (showsPixelCoords(item)) {
    return item.pixelY != null ? String(item.pixelY) : '';
  }
  return NO_COORD_TYPES.has(item.actionType) ? '' : String(item.y);
}

// Resolved-color tuple cached per action type. The values themselves are CSS
// var() references — they're token strings, not actual colors — so caching is
// safe across theme changes (the variable resolves at paint time, not at
// JS-string-construction time). Keyed by raw `actionType` string so all of
// "BrowserClick", "BrowserType", etc. share the Browser entry via the
// startsWith check below. Allocates ~12 objects total instead of one per row
// per render — meaningful when rendering a 500+ row grid where the function
// was being called for every iteration of actions.map.
const ACTION_COLOR_CACHE: Map<string, { bg: string; fg: string }> = new Map();

function computeActionTypeColors(actionType: string): { bg: string; fg: string } {
  // Check conditional types first — they share a single token regardless of which
  // marker (If / Else / EndIf) so the whole block reads as one cohesive surface.
  if (actionType === 'If' || actionType === 'Else' || actionType === 'EndIf')
    return { bg: 'var(--color-action-if-bg)', fg: 'var(--color-action-if-fg)' };
  if (actionType.startsWith('Browser'))
    return { bg: 'var(--color-action-browser-bg)', fg: 'var(--color-action-browser-fg)' };
  if (actionType.includes('Click'))
    return { bg: 'var(--color-action-mouse-bg)', fg: 'var(--color-action-mouse-fg)' };
  if (actionType.includes('Scroll'))
    return { bg: 'var(--color-action-scroll-bg)', fg: 'var(--color-action-scroll-fg)' };
  if (actionType.startsWith('Key') || actionType === 'HoldKey')
    return { bg: 'var(--color-action-key-bg)', fg: 'var(--color-action-key-fg)' };
  if (actionType === 'SendText')
    return { bg: 'var(--color-action-sendtext-bg)', fg: 'var(--color-action-sendtext-fg)' };
  // SetVariable has its own magenta token now (it used to share SendText's gold, which
  // made the two "text/data" actions look identical in the grid).
  if (actionType === 'SetVariable')
    return { bg: 'var(--color-action-setvariable-bg)', fg: 'var(--color-action-setvariable-fg)' };
  if (actionType === 'WaitImage')
    return { bg: 'var(--color-action-waitimage-bg)', fg: 'var(--color-action-waitimage-fg)' };
  if (actionType === 'WaitPixelColor')
    return { bg: 'var(--color-action-pixelcolor-bg)', fg: 'var(--color-action-pixelcolor-fg)' };
  if (actionType === 'RunProfile')
    return { bg: 'var(--color-action-runprofile-bg)', fg: 'var(--color-action-runprofile-fg)' };
  if (actionType === 'Pause')
    return { bg: 'var(--color-action-pause-bg)', fg: 'var(--color-action-pause-fg)' };
  return { bg: 'transparent', fg: 'var(--color-text-tertiary)' };
}

export function getActionTypeColors(actionType: string): { bg: string; fg: string } {
  const cached = ACTION_COLOR_CACHE.get(actionType);
  if (cached) return cached;
  const result = computeActionTypeColors(actionType);
  ACTION_COLOR_CACHE.set(actionType, result);
  return result;
}

export function getActionTypeIcon(actionType: string): string {
  if (actionType.startsWith('Browser')) return 'Globe';
  if (actionType.includes('Click')) return 'Mouse';
  if (actionType === 'ScrollUp') return 'ArrowUp';
  if (actionType === 'ScrollDown') return 'ArrowDown';
  if (actionType.startsWith('Key')) return 'Keyboard';
  if (actionType === 'HoldKey') return 'Timer';
  if (actionType === 'SendText') return 'Type';
  if (actionType === 'SetVariable') return 'Braces';
  if (actionType === 'WaitImage') return 'ScanSearch';
  if (actionType === 'WaitPixelColor') return 'Pipette';
  if (actionType === 'RunProfile') return 'Repeat2';
  if (actionType === 'Pause') return 'Hourglass';
  // Conditional logic — Lucide's GitBranch is the universal "branch / decision"
  // glyph and matches the mockup. Else uses the two-way swap arrows, EndIf uses
  // a closing chevron (visually "block closes here").
  if (actionType === 'If') return 'GitBranch';
  if (actionType === 'Else') return 'ArrowRightLeft';
  if (actionType === 'EndIf') return 'ChevronDown';
  return 'Zap';
}
