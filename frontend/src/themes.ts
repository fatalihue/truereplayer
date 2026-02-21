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

export interface ThemePreset {
  id: string;
  name: string;
  colors: ThemeColors;
  /** 4 preview swatches shown in the theme card */
  preview: [string, string, string, string];
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

/** Apply theme colors as CSS custom properties on :root */
export function applyTheme(theme: ThemePreset) {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.colors)) {
    root.style.setProperty(`--color-${key}`, value);
  }
}
