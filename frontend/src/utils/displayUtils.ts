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
  'Capital': 'Caps Lock', 'Escape': 'ESC',
  'Space': 'SPACEBAR', 'Tab': 'TAB',
  'Next': 'Page Down', 'Prior': 'Page Up',
};

const NO_COORD_TYPES = new Set(['KeyDown', 'KeyUp', 'ScrollUp', 'ScrollDown']);

export function getDisplayKey(key: string): string {
  if (!key) return '';
  if (key.startsWith('D') && key.length === 2 && /\d/.test(key[1])) return key[1];
  return DISPLAY_KEY_MAP[key] ?? key;
}

export function getDisplayX(item: ActionItem): string {
  return NO_COORD_TYPES.has(item.actionType) ? '' : String(item.x);
}

export function getDisplayY(item: ActionItem): string {
  return NO_COORD_TYPES.has(item.actionType) ? '' : String(item.y);
}

export function getActionTypeColors(actionType: string) {
  if (actionType.includes('Click'))
    return { bg: 'var(--color-action-mouse-bg)', fg: 'var(--color-action-mouse-fg)' };
  if (actionType.includes('Scroll'))
    return { bg: 'var(--color-action-scroll-bg)', fg: 'var(--color-action-scroll-fg)' };
  if (actionType.startsWith('Key'))
    return { bg: 'var(--color-action-key-bg)', fg: 'var(--color-action-key-fg)' };
  return { bg: 'transparent', fg: 'var(--color-text-tertiary)' };
}

export function getActionTypeIcon(actionType: string): string {
  if (actionType.includes('Click')) return 'Mouse';
  if (actionType === 'ScrollUp') return 'ArrowUp';
  if (actionType === 'ScrollDown') return 'ArrowDown';
  if (actionType.startsWith('Key')) return 'Keyboard';
  return 'Zap';
}
