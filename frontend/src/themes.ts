export interface ThemeColors {
  'bg-base': string;
  'bg-surface': string;
  'bg-card': string;
  'bg-elevated': string;
  'bg-input': string;
  'border-subtle': string;
  'border-default': string;
  'border-strong': string;
  'text-primary': string;
  'text-secondary': string;
  'text-tertiary': string;
  'text-disabled': string;
  accent: string;
  'accent-solid': string;
  'accent-hover': string;
}

export const THEME_COLOR_KEYS: (keyof ThemeColors)[] = [
  'bg-base', 'bg-surface', 'bg-card', 'bg-elevated', 'bg-input',
  'border-subtle', 'border-default', 'border-strong',
  'text-primary', 'text-secondary', 'text-tertiary', 'text-disabled',
  'accent', 'accent-solid', 'accent-hover',
];

export interface ThemePreset {
  id: string;
  name: string;
  colors: ThemeColors;
  /** 4 preview swatches shown in the theme card */
  preview: [string, string, string, string];
}

export interface ThemeUISettings {
  fontSize: number;
  borderRadius: number;
  rowHeight: number;
}

export const DEFAULT_UI_SETTINGS: ThemeUISettings = {
  fontSize: 13,
  borderRadius: 6,
  rowHeight: 36,
};

export interface ThemeConfig {
  version: 1;
  baseThemeId: string;
  colorOverrides: Partial<ThemeColors>;
  uiSettings: ThemeUISettings;
}

export interface ExportedTheme {
  name: string;
  version: 1;
  colors: ThemeColors;
  uiSettings: ThemeUISettings;
}

export const themes: ThemePreset[] = [
  {
    id: 'midnight',
    name: 'Midnight',
    preview: ['#0c1220', '#131b2e', '#1a2338', '#60cdff'],
    colors: {
      'bg-base': '#0c1220',
      'bg-surface': '#131b2e',
      'bg-card': '#1a2338',
      'bg-elevated': '#212b42',
      'bg-input': '#0e1628',
      'border-subtle': 'rgba(255,255,255,0.06)',
      'border-default': 'rgba(255,255,255,0.1)',
      'border-strong': 'rgba(255,255,255,0.15)',
      'text-primary': '#ffffff',
      'text-secondary': '#c5c5c5',
      'text-tertiary': '#7a8599',
      'text-disabled': '#4a5568',
      accent: '#60cdff',
      'accent-solid': '#0078d4',
      'accent-hover': '#7dd6ff',
    },
  },
  {
    id: 'carbon',
    name: 'Carbon',
    preview: ['#121212', '#1a1a1a', '#222222', '#90caf9'],
    colors: {
      'bg-base': '#121212',
      'bg-surface': '#1a1a1a',
      'bg-card': '#222222',
      'bg-elevated': '#2a2a2a',
      'bg-input': '#0e0e0e',
      'border-subtle': 'rgba(255,255,255,0.06)',
      'border-default': 'rgba(255,255,255,0.1)',
      'border-strong': 'rgba(255,255,255,0.15)',
      'text-primary': '#e0e0e0',
      'text-secondary': '#a0a0a0',
      'text-tertiary': '#707070',
      'text-disabled': '#484848',
      accent: '#90caf9',
      'accent-solid': '#42a5f5',
      'accent-hover': '#bbdefb',
    },
  },
  {
    id: 'amethyst',
    name: 'Amethyst',
    preview: ['#150e24', '#1e1533', '#271d40', '#c084fc'],
    colors: {
      'bg-base': '#150e24',
      'bg-surface': '#1e1533',
      'bg-card': '#271d40',
      'bg-elevated': '#30264d',
      'bg-input': '#120b20',
      'border-subtle': 'rgba(200,180,255,0.06)',
      'border-default': 'rgba(200,180,255,0.1)',
      'border-strong': 'rgba(200,180,255,0.15)',
      'text-primary': '#f0eaff',
      'text-secondary': '#c5b8e0',
      'text-tertiary': '#8a7aaa',
      'text-disabled': '#554a6a',
      accent: '#c084fc',
      'accent-solid': '#9333ea',
      'accent-hover': '#d8b4fe',
    },
  },
  {
    id: 'emerald',
    name: 'Emerald',
    preview: ['#0a1a14', '#112820', '#18332a', '#4ade80'],
    colors: {
      'bg-base': '#0a1a14',
      'bg-surface': '#112820',
      'bg-card': '#18332a',
      'bg-elevated': '#1f3f34',
      'bg-input': '#081510',
      'border-subtle': 'rgba(120,255,180,0.06)',
      'border-default': 'rgba(120,255,180,0.1)',
      'border-strong': 'rgba(120,255,180,0.15)',
      'text-primary': '#e8fff0',
      'text-secondary': '#a8d5b8',
      'text-tertiary': '#6a9a80',
      'text-disabled': '#405a4c',
      accent: '#4ade80',
      'accent-solid': '#16a34a',
      'accent-hover': '#86efac',
    },
  },
  {
    id: 'rose',
    name: 'Rose',
    preview: ['#1a0c14', '#28131e', '#331a28', '#fb7185'],
    colors: {
      'bg-base': '#1a0c14',
      'bg-surface': '#28131e',
      'bg-card': '#331a28',
      'bg-elevated': '#3f2132',
      'bg-input': '#150a10',
      'border-subtle': 'rgba(255,150,180,0.06)',
      'border-default': 'rgba(255,150,180,0.1)',
      'border-strong': 'rgba(255,150,180,0.15)',
      'text-primary': '#fff0f5',
      'text-secondary': '#dab0c0',
      'text-tertiary': '#a07085',
      'text-disabled': '#604558',
      accent: '#fb7185',
      'accent-solid': '#e11d48',
      'accent-hover': '#fda4af',
    },
  },
  {
    id: 'ocean',
    name: 'Ocean',
    preview: ['#0a161a', '#102228', '#162e35', '#22d3ee'],
    colors: {
      'bg-base': '#0a161a',
      'bg-surface': '#102228',
      'bg-card': '#162e35',
      'bg-elevated': '#1c3a42',
      'bg-input': '#081215',
      'border-subtle': 'rgba(100,220,240,0.06)',
      'border-default': 'rgba(100,220,240,0.1)',
      'border-strong': 'rgba(100,220,240,0.15)',
      'text-primary': '#e8fbff',
      'text-secondary': '#a8d5e0',
      'text-tertiary': '#6a98a8',
      'text-disabled': '#405868',
      accent: '#22d3ee',
      'accent-solid': '#0891b2',
      'accent-hover': '#67e8f9',
    },
  },
  {
    id: 'amber',
    name: 'Amber',
    preview: ['#1a1408', '#282010', '#332a18', '#fbbf24'],
    colors: {
      'bg-base': '#1a1408',
      'bg-surface': '#282010',
      'bg-card': '#332a18',
      'bg-elevated': '#3f3420',
      'bg-input': '#151006',
      'border-subtle': 'rgba(255,200,100,0.06)',
      'border-default': 'rgba(255,200,100,0.1)',
      'border-strong': 'rgba(255,200,100,0.15)',
      'text-primary': '#fff8e8',
      'text-secondary': '#d5c5a0',
      'text-tertiary': '#9a8a68',
      'text-disabled': '#5a5040',
      accent: '#fbbf24',
      'accent-solid': '#d97706',
      'accent-hover': '#fcd34d',
    },
  },
  {
    id: 'slate',
    name: 'Slate',
    preview: ['#0f1318', '#171c24', '#1f2630', '#94a3b8'],
    colors: {
      'bg-base': '#0f1318',
      'bg-surface': '#171c24',
      'bg-card': '#1f2630',
      'bg-elevated': '#27303c',
      'bg-input': '#0c1015',
      'border-subtle': 'rgba(180,200,220,0.06)',
      'border-default': 'rgba(180,200,220,0.1)',
      'border-strong': 'rgba(180,200,220,0.15)',
      'text-primary': '#e8edf2',
      'text-secondary': '#b0bcc8',
      'text-tertiary': '#6a7a8a',
      'text-disabled': '#445060',
      accent: '#94a3b8',
      'accent-solid': '#64748b',
      'accent-hover': '#cbd5e1',
    },
  },
];

export const DEFAULT_THEME_ID = 'carbon';

export function getThemeById(id: string): ThemePreset | undefined {
  return themes.find(t => t.id === id);
}

// ── Color Math Helpers ──

function hexToRGB(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}

export function hexToHSL(hex: string): { h: number; s: number; l: number } {
  const { r, g, b } = hexToRGB(hex);
  const rf = r / 255, gf = g / 255, bf = b / 255;
  const max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rf) h = ((gf - bf) / d + (gf < bf ? 6 : 0)) / 6;
  else if (max === gf) h = ((bf - rf) / d + 2) / 6;
  else h = ((rf - gf) / d + 4) / 6;
  return { h: h * 360, s: s * 100, l: l * 100 };
}

export function hslToHex(h: number, s: number, l: number): string {
  const sf = s / 100, lf = l / 100;
  const c = (1 - Math.abs(2 * lf - 1)) * sf;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lf - c / 2;
  let rf = 0, gf = 0, bf = 0;
  if (h < 60) { rf = c; gf = x; }
  else if (h < 120) { rf = x; gf = c; }
  else if (h < 180) { gf = c; bf = x; }
  else if (h < 240) { gf = x; bf = c; }
  else if (h < 300) { rf = x; bf = c; }
  else { rf = c; bf = x; }
  return rgbToHex((rf + m) * 255, (gf + m) * 255, (bf + m) * 255);
}

/** Convert any color string to hex (handles rgba() and hex) */
export function toHex(color: string): string {
  if (color.startsWith('#')) return color.length === 7 ? color : color;
  const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) return rgbToHex(+m[1], +m[2], +m[3]);
  return '#000000';
}

/** Rebuild rgba() string preserving alpha from original */
export function withOriginalAlpha(newHex: string, originalColor: string): string {
  if (!originalColor.startsWith('rgba')) return newHex;
  const m = originalColor.match(/rgba?\([^,]+,[^,]+,[^,]+,\s*([^)]+)\)/);
  const alpha = m ? m[1].trim() : '1';
  const { r, g, b } = hexToRGB(newHex);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── Accent Derivation ──

export function deriveAccentVariants(accentHex: string): Pick<ThemeColors, 'accent' | 'accent-solid' | 'accent-hover'> {
  const { h, s, l } = hexToHSL(accentHex);
  return {
    accent: accentHex,
    'accent-solid': hslToHex(h, Math.min(s + 10, 100), Math.max(l - 20, 10)),
    'accent-hover': hslToHex(h, Math.max(s - 5, 0), Math.min(l + 15, 90)),
  };
}

// ── Theme Config Persistence ──

const STORAGE_KEY = 'truereplay-theme';

export function loadThemeConfig(): ThemeConfig {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return makeDefaultConfig();

  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && parsed.baseThemeId) {
      return parsed as ThemeConfig;
    }
  } catch {
    // Not JSON — old format (plain theme ID string)
    if (getThemeById(raw)) {
      return { version: 1, baseThemeId: raw, colorOverrides: {}, uiSettings: { ...DEFAULT_UI_SETTINGS } };
    }
  }

  return makeDefaultConfig();
}

export function saveThemeConfig(config: ThemeConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function makeDefaultConfig(): ThemeConfig {
  return { version: 1, baseThemeId: DEFAULT_THEME_ID, colorOverrides: {}, uiSettings: { ...DEFAULT_UI_SETTINGS } };
}

// ── Theme Resolution ──

export function resolveThemeColors(config: ThemeConfig): ThemeColors {
  const base = getThemeById(config.baseThemeId) ?? themes[0];
  return { ...base.colors, ...config.colorOverrides };
}

export function applyThemeConfig(colors: ThemeColors, uiSettings: ThemeUISettings) {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(colors)) {
    root.style.setProperty(`--color-${key}`, value);
  }
  root.style.setProperty('--ui-font-size', `${uiSettings.fontSize}px`);
  root.style.setProperty('--ui-border-radius', `${uiSettings.borderRadius}px`);
  root.style.setProperty('--ui-row-height', `${uiSettings.rowHeight}px`);
}

// ── Import/Export ──

export function validateExportedTheme(data: unknown): data is ExportedTheme {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  if (d.version !== 1 || typeof d.name !== 'string') return false;
  if (!d.colors || typeof d.colors !== 'object') return false;
  const colors = d.colors as Record<string, unknown>;
  for (const key of THEME_COLOR_KEYS) {
    if (typeof colors[key] !== 'string') return false;
  }
  if (!d.uiSettings || typeof d.uiSettings !== 'object') return false;
  const ui = d.uiSettings as Record<string, unknown>;
  if (typeof ui.fontSize !== 'number' || typeof ui.borderRadius !== 'number' || typeof ui.rowHeight !== 'number') return false;
  return true;
}

export function findClosestPreset(colors: ThemeColors): string {
  let bestId = DEFAULT_THEME_ID;
  let bestMatches = 0;
  for (const preset of themes) {
    let matches = 0;
    for (const key of THEME_COLOR_KEYS) {
      if (preset.colors[key] === colors[key]) matches++;
    }
    if (matches > bestMatches) {
      bestMatches = matches;
      bestId = preset.id;
    }
  }
  return bestId;
}
