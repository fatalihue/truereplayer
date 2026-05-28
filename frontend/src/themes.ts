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
  zoom: number;
  recordingColor: string;
  replayColor: string;
  // Clicker mode has its own identity (used by the Clicker tab UI + repeating clicks);
  // exposed as a customizable semantic color so it stays cohesive when the accent changes.
  clickerColor: string;
  actionMouseColor: string;
  actionKeyColor: string;
  actionScrollColor: string;
  actionSendTextColor: string;
  actionWaitImageColor: string;
  actionPixelColorColor: string;
  actionBrowserColor: string;
  actionRunProfileColor: string;
  actionPauseColor: string;
  // Conditional / control-flow rows (If / Else / EndIf). Distinct hue from the two
  // other purples in the palette (Mouse #a78bfa, Clicker mode #c084fc) — amber sits
  // in the gold band but at a saturation/brightness that reads as "decision/branch"
  // rather than "sendtext gold" (#d4a020). The token is consumed by the conditional
  // row pill + rail + ghost "+ Add Else" button.
  actionIfColor: string;
  fontMono: string;
  // When true, auto-switch between darkPresetId / lightPresetId based on the OS
  // prefers-color-scheme media query. ThemeContext listens to changes and updates
  // the active preset live. Defaults: false so behaviour is unchanged for users
  // who didn't opt in.
  matchSystemTheme: boolean;
  darkPresetId: string;
  lightPresetId: string;
  // Master toggle for UI transitions / micro-interactions. Stored here so users on
  // low-end hardware or with reduced-motion preferences can switch them off
  // independently of the theme palette.
  enableAnimations: boolean;
}

export const DEFAULT_UI_SETTINGS: ThemeUISettings = {
  fontSize: 13,
  borderRadius: 3,
  rowHeight: 34,
  zoom: 95,
  recordingColor: '#ff6b6b',
  replayColor: '#6bcb77',
  clickerColor: '#c084fc',
  actionMouseColor: '#a78bfa',
  actionKeyColor: '#60cdff',
  // Mint green — lighter / softer than the previous #6bcb77 so it reads as
  // distinct from PixelColor's lime (#84cc16) at a glance. Same green "movement"
  // semantic carried by Scroll actions.
  actionScrollColor: '#8be597',
  actionSendTextColor: '#d4a020',
  actionWaitImageColor: '#e879f9',
  // Lime — replaced the old cyan (#22d3ee) which collided with Key (#60cdff) at
  // only 13° of hue separation. Lime occupies the open slot between SendText
  // gold (43°) and Scroll green (127°), giving 43°+ to every neighbour. No
  // hardcoded semantic — PixelColor is "watch any colour", so the action is the
  // free agent of the palette.
  actionPixelColorColor: '#84cc16',
  actionBrowserColor: '#fb923c',
  // True blue, picked to be distinct from Key cyan (#60cdff) and Mouse purple
  // (#a78bfa). Carries the "control flow / chain call" semantic.
  actionRunProfileColor: '#3b82f6',
  // Slate — neutral grey-blue, semantically "inactive / waiting". Replaces the
  // previous amber (#fbbf24), which shared its exact hue (43°) with SendText
  // gold and only differed in brightness — visually too close. Slate sits in a
  // hue range no other action uses (~215°) and stays distinguishable from
  // RunProfile's vivid blue by saturation (slate is desaturated grey-blue,
  // RunProfile is fully saturated).
  actionPauseColor: '#94a3b8',
  // Teal — replaces the original amber (#fbbf24), which shared its hue (43°) with
  // SendText gold (#d4a020) and was only distinguishable by brightness/saturation.
  // At the action-pill size in the grid (~30 px wide) the two amber tones looked
  // confusingly alike. Teal sits at 170° — 38° from Scroll mint, 28° from Key
  // cyan, comfortably distinct from every other action. Preserves the
  // "structural / decision" semantic without the warm-amber collision. The
  // v2→v3 migration swaps the old #fbbf24 default for anyone who never
  // customised the colour.
  actionIfColor: '#2dd4bf',
  fontMono: 'Consolas',
  matchSystemTheme: false,
  darkPresetId: 'lavender-coal',
  lightPresetId: 'github-light',
  enableAnimations: true,
};

export interface ThemeConfig {
  // Schema version. v1 = original; v2 = palette pass (PixelColor / Scroll / Pause
  // defaults swapped); v3 = If color moved from amber to teal to resolve hue
  // collision with SendText gold. loadThemeConfig migrates v1 → v2 → v3 in place.
  // Listed as `number` rather than a literal union so future bumps don't require
  // a type edit at every call site.
  version: number;
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

// Themes ordered by accent hue: neutral → pink → orange/yellow → green → cyan/blue → red → purple → light.
export const themes: ThemePreset[] = [
  // ── Neutral ──
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
  // ── Pink / Rose ──
  {
    id: 'sakura',
    name: 'Sakura',
    preview: ['#1a1218', '#241c22', '#2e242c', '#f9a8d4'],
    colors: {
      'bg-base': '#1a1218',
      'bg-surface': '#241c22',
      'bg-card': '#2e242c',
      'bg-elevated': '#383036',
      'bg-input': '#150f14',
      'border-subtle': 'rgba(255,183,197,0.06)',
      'border-default': 'rgba(255,183,197,0.1)',
      'border-strong': 'rgba(255,183,197,0.15)',
      'text-primary': '#f8eef2',
      'text-secondary': '#d0b8c0',
      'text-tertiary': '#967888',
      'text-disabled': '#604858',
      accent: '#f9a8d4',
      'accent-solid': '#db6fa0',
      'accent-hover': '#fbcfe8',
    },
  },
  // ── Orange / Yellow ──
  {
    id: 'copper',
    name: 'Copper',
    preview: ['#1a1210', '#251c18', '#302420', '#e8956a'],
    colors: {
      'bg-base': '#1a1210',
      'bg-surface': '#251c18',
      'bg-card': '#302420',
      'bg-elevated': '#3c2e28',
      'bg-input': '#15100d',
      'border-subtle': 'rgba(220,160,120,0.06)',
      'border-default': 'rgba(220,160,120,0.1)',
      'border-strong': 'rgba(220,160,120,0.15)',
      'text-primary': '#f5ece5',
      'text-secondary': '#c8b0a0',
      'text-tertiary': '#8a7060',
      'text-disabled': '#5a4a40',
      accent: '#e8956a',
      'accent-solid': '#c06030',
      'accent-hover': '#f0b890',
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
    // Gruvbox Dark — morhetz/gruvbox. Hard-contrast bg #1d2021, default
    // bg #282828, fg #ebdbb2, yellow #fabd2f (the iconic accent).
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    preview: ['#1d2021', '#282828', '#3c3836', '#fabd2f'],
    colors: {
      'bg-base': '#1d2021',
      'bg-surface': '#282828',
      'bg-card': '#3c3836',
      'bg-elevated': '#45403d',
      'bg-input': '#161819',
      'border-subtle': 'rgba(235,219,178,0.06)',
      'border-default': 'rgba(235,219,178,0.1)',
      'border-strong': 'rgba(235,219,178,0.15)',
      'text-primary': '#ebdbb2',
      'text-secondary': '#d5c4a1',
      'text-tertiary': '#928374',
      'text-disabled': '#665c54',
      accent: '#fabd2f',
      'accent-solid': '#d79921',
      'accent-hover': '#ffd866',
    },
  },
  // ── Green ──
  {
    // Minimal Kiwi — minimalist near-black backgrounds with a single kiwi-green pop accent.
    id: 'minimal-kiwi',
    name: 'Minimal Kiwi',
    preview: ['#0d100e', '#131713', '#1a1f1a', '#a4d96c'],
    colors: {
      'bg-base': '#0d100e',
      'bg-surface': '#131713',
      'bg-card': '#1a1f1a',
      'bg-elevated': '#212620',
      'bg-input': '#0a0c0a',
      'border-subtle': 'rgba(164,217,108,0.06)',
      'border-default': 'rgba(164,217,108,0.1)',
      'border-strong': 'rgba(164,217,108,0.15)',
      'text-primary': '#e8f0e0',
      'text-secondary': '#b0bfa0',
      'text-tertiary': '#6a8060',
      'text-disabled': '#404a3a',
      accent: '#a4d96c',
      'accent-solid': '#7eb84a',
      'accent-hover': '#beea88',
    },
  },
  {
    id: 'monokai',
    name: 'Monokai',
    preview: ['#1e1f1c', '#272822', '#30312b', '#a6e22e'],
    colors: {
      'bg-base': '#1e1f1c',
      'bg-surface': '#272822',
      'bg-card': '#30312b',
      'bg-elevated': '#3a3b35',
      'bg-input': '#191a17',
      'border-subtle': 'rgba(200,200,180,0.06)',
      'border-default': 'rgba(200,200,180,0.1)',
      'border-strong': 'rgba(200,200,180,0.15)',
      'text-primary': '#f8f8f2',
      'text-secondary': '#c8c8b8',
      'text-tertiary': '#75715e',
      'text-disabled': '#49483e',
      accent: '#a6e22e',
      'accent-solid': '#82b01e',
      'accent-hover': '#c4f04e',
    },
  },
  {
    // Everforest Dark Hard — sainnhe/everforest. Warm earthy greens, low-saturation
    // body fg #d3c6aa, signature green accent #a7c080.
    id: 'dark-ever',
    name: 'Dark Ever',
    preview: ['#1e2326', '#272e33', '#2e353b', '#a7c080'],
    colors: {
      'bg-base': '#1e2326',
      'bg-surface': '#272e33',
      'bg-card': '#2e353b',
      'bg-elevated': '#374146',
      'bg-input': '#181b1e',
      'border-subtle': 'rgba(211,198,170,0.06)',
      'border-default': 'rgba(211,198,170,0.1)',
      'border-strong': 'rgba(211,198,170,0.15)',
      'text-primary': '#d3c6aa',
      'text-secondary': '#a7c080',
      'text-tertiary': '#859289',
      'text-disabled': '#5a6b5b',
      accent: '#a7c080',
      'accent-solid': '#83b16f',
      'accent-hover': '#c0d6a0',
    },
  },
  {
    // Green Beautiful Color Themes — "Green Beautiful 2" from the VS Code extension family.
    // Saturated mint-teal accent over a deep emerald canvas.
    id: 'green-beautiful-2',
    name: 'Green Beautiful 2',
    preview: ['#0a1f14', '#103024', '#163d2e', '#5eead4'],
    colors: {
      'bg-base': '#0a1f14',
      'bg-surface': '#103024',
      'bg-card': '#163d2e',
      'bg-elevated': '#1d4a38',
      'bg-input': '#061a10',
      'border-subtle': 'rgba(94,234,212,0.06)',
      'border-default': 'rgba(94,234,212,0.1)',
      'border-strong': 'rgba(94,234,212,0.15)',
      'text-primary': '#d4f4e0',
      'text-secondary': '#98d1b0',
      'text-tertiary': '#5a8a70',
      'text-disabled': '#355044',
      accent: '#5eead4',
      'accent-solid': '#2dd4bf',
      'accent-hover': '#8af3da',
    },
  },
  {
    // Green Beautiful Color Themes — "Green Dark" variant. Classic forest green
    // accent over near-black greens.
    id: 'green-dark',
    name: 'Green Dark',
    preview: ['#0a1410', '#102018', '#182e22', '#22c55e'],
    colors: {
      'bg-base': '#0a1410',
      'bg-surface': '#102018',
      'bg-card': '#182e22',
      'bg-elevated': '#1f3b2d',
      'bg-input': '#050d09',
      'border-subtle': 'rgba(34,197,94,0.06)',
      'border-default': 'rgba(34,197,94,0.1)',
      'border-strong': 'rgba(34,197,94,0.15)',
      'text-primary': '#e0f5e8',
      'text-secondary': '#a4d4b4',
      'text-tertiary': '#5e8a70',
      'text-disabled': '#355040',
      accent: '#22c55e',
      'accent-solid': '#16a34a',
      'accent-hover': '#4ade80',
    },
  },
  // ── Cyan / Blue ──
  {
    // Hatsune Miku — Crypton's mascot signature teal (#39c5bb) over deep teal-tinted
    // dark backgrounds. Subtle pop without going neon.
    id: 'hatsune-miku',
    name: 'Hatsune Miku',
    preview: ['#0f1a1c', '#152528', '#1d3236', '#39c5bb'],
    colors: {
      'bg-base': '#0f1a1c',
      'bg-surface': '#152528',
      'bg-card': '#1d3236',
      'bg-elevated': '#244047',
      'bg-input': '#0a1517',
      'border-subtle': 'rgba(57,197,187,0.06)',
      'border-default': 'rgba(57,197,187,0.10)',
      'border-strong': 'rgba(57,197,187,0.15)',
      'text-primary': '#e0fafc',
      'text-secondary': '#a8d5d5',
      'text-tertiary': '#5a8a8a',
      'text-disabled': '#345555',
      accent: '#39c5bb',
      'accent-solid': '#00a89e',
      'accent-hover': '#5cd9d0',
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
    // Ocean Deep — saturated blue accent over very dark navy. Companion of Ocean
    // shifted toward true blue.
    id: 'ocean-deep',
    name: 'Ocean Deep',
    preview: ['#051323', '#0a1f38', '#102b4c', '#38bdf8'],
    colors: {
      'bg-base': '#051323',
      'bg-surface': '#0a1f38',
      'bg-card': '#102b4c',
      'bg-elevated': '#173763',
      'bg-input': '#030d1b',
      'border-subtle': 'rgba(56,189,248,0.06)',
      'border-default': 'rgba(56,189,248,0.10)',
      'border-strong': 'rgba(56,189,248,0.15)',
      'text-primary': '#e0eef8',
      'text-secondary': '#9cc4dc',
      'text-tertiary': '#5a7d98',
      'text-disabled': '#344a5c',
      accent: '#38bdf8',
      'accent-solid': '#0284c7',
      'accent-hover': '#7dd3fc',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    preview: ['#2e3440', '#3b4252', '#434c5e', '#88c0d0'],
    colors: {
      'bg-base': '#2e3440',
      'bg-surface': '#3b4252',
      'bg-card': '#434c5e',
      'bg-elevated': '#4c566a',
      'bg-input': '#272d38',
      'border-subtle': 'rgba(216,222,233,0.06)',
      'border-default': 'rgba(216,222,233,0.1)',
      'border-strong': 'rgba(216,222,233,0.15)',
      'text-primary': '#eceff4',
      'text-secondary': '#d8dee9',
      'text-tertiary': '#81a1c1',
      'text-disabled': '#5c6678',
      accent: '#88c0d0',
      'accent-solid': '#5e81ac',
      'accent-hover': '#8fbcbb',
    },
  },
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
    // One Dark Pro Default — Atom's One Dark via VSCode One Dark Pro.
    // bg #282c34, sidebar #21252b, fg #abb2bf, blue #61afef.
    id: 'one-dark-pro',
    name: 'One Dark Pro',
    preview: ['#1e2127', '#21252b', '#282c34', '#61afef'],
    colors: {
      'bg-base': '#1e2127',
      'bg-surface': '#21252b',
      'bg-card': '#282c34',
      'bg-elevated': '#2c313c',
      'bg-input': '#181a1f',
      'border-subtle': 'rgba(171,178,191,0.06)',
      'border-default': 'rgba(171,178,191,0.1)',
      'border-strong': 'rgba(171,178,191,0.15)',
      'text-primary': '#abb2bf',
      'text-secondary': '#9da5b4',
      'text-tertiary': '#5c6370',
      'text-disabled': '#4b5263',
      accent: '#61afef',
      'accent-solid': '#4392d3',
      'accent-hover': '#80c0f5',
    },
  },
  {
    // One Dark Pro Night Flat — Binaryify/OneDark-Pro's official "night-flat"
    // variant (OneDark-Pro-night-flat.json). editor/sidebar/activityBar/statusBar
    // all collapse to #16191d (deeper than the regular Flat #282c34). Dropdown
    // sits at #1e2227, input at #1d1f23. Foreground stays at #abb2bf with
    // titleBar fg #9da5b4 as the secondary text role. Comment #5c6370 and
    // disabled #4b5263 keep One Dark's classic muted greys. Accent #61afef is
    // the trademark One Dark blue.
    id: 'one-dark-pro-night-flat',
    name: 'Night Flat',
    preview: ['#1d1f23', '#16191d', '#1e2227', '#61afef'],
    colors: {
      'bg-base': '#16191d',
      'bg-surface': '#16191d',
      'bg-card': '#16191d',
      'bg-elevated': '#1e2227',
      'bg-input': '#1d1f23',
      'border-subtle': 'rgba(171,178,191,0.06)',
      'border-default': 'rgba(171,178,191,0.1)',
      'border-strong': 'rgba(171,178,191,0.15)',
      'text-primary': '#abb2bf',
      'text-secondary': '#9da5b4',
      'text-tertiary': '#5c6370',
      'text-disabled': '#4b5263',
      accent: '#61afef',
      'accent-solid': '#4392d3',
      'accent-hover': '#80c0f5',
    },
  },
  {
    // Lavender Coal — custom near-black flat palette (originally mis-labeled
    // "Night Flat" before alignment to the official Binaryify variant). Pairs
    // a One Dark-style blue accent (#61afef) and comment grey (#4b5263) with
    // a custom lavender-tinted foreground (#c8c8d4) over flat near-black
    // backgrounds. Not derived from any single official theme — kept as an
    // intentional in-house design.
    id: 'lavender-coal',
    name: 'Lavender Coal',
    preview: ['#161616', '#1a1a1a', '#232323', '#61afef'],
    colors: {
      'bg-base': '#1a1a1a',
      'bg-surface': '#1c1c1c',
      'bg-card': '#1f1f1f',
      'bg-elevated': '#232323',
      'bg-input': '#161616',
      'border-subtle': 'rgba(200,200,212,0.06)',
      'border-default': 'rgba(200,200,212,0.1)',
      'border-strong': 'rgba(200,200,212,0.15)',
      'text-primary': '#c8c8d4',
      'text-secondary': '#a0a8b4',
      'text-tertiary': '#6b7280',
      'text-disabled': '#4b5263',
      accent: '#61afef',
      'accent-solid': '#4392d3',
      'accent-hover': '#80c0f5',
    },
  },
  {
    // Cursor Dark — official theme from cursor.sh, mirrored by
    // CedricVerlinden/cursor-dark and BioHazard786/cursor-theme-vscode.
    // editor.background #1a1a1a; sidebar/activityBar/statusBar/panel all
    // collapse to #141414 for a deeper chrome. Foreground #D8DEE9 (Nord-like
    // snow storm). Accent / button / textLink #4c9df3 (saturated blue);
    // badge #88C0D0 hints at the Nord aurora cyan.
    id: 'cursor-dark',
    name: 'Cursor Dark',
    preview: ['#141414', '#1a1a1a', '#2a2a2a', '#4c9df3'],
    colors: {
      'bg-base': '#1a1a1a',
      'bg-surface': '#141414',
      'bg-card': '#1a1a1a',
      'bg-elevated': '#2a2a2a',
      'bg-input': '#222222',
      'border-subtle': 'rgba(216,222,233,0.06)',
      'border-default': 'rgba(216,222,233,0.1)',
      'border-strong': 'rgba(216,222,233,0.15)',
      'text-primary': '#D8DEE9',
      'text-secondary': '#cccccc',
      'text-tertiary': '#8a8e94',
      'text-disabled': '#5c6066',
      accent: '#4c9df3',
      'accent-solid': '#2f7fd4',
      'accent-hover': '#6cb0f7',
    },
  },
  {
    // Cursor Less Dark — official lighter variant of Cursor Dark from
    // cursor.sh (CedricVerlinden/cursor-dark themes/cursor-less-dark.json).
    // editor.background lifts to #242424; sidebar/activityBar/statusBar/panel
    // sit at #1E1E1E. Same #D8DEE9 foreground and #4c9df3 accent as Cursor
    // Dark — only the surface tones shift up.
    id: 'cursor-less-dark',
    name: 'Cursor Less Dark',
    preview: ['#1E1E1E', '#242424', '#2e2e2e', '#4c9df3'],
    colors: {
      'bg-base': '#242424',
      'bg-surface': '#1E1E1E',
      'bg-card': '#242424',
      'bg-elevated': '#2e2e2e',
      'bg-input': '#2a2a2a',
      'border-subtle': 'rgba(216,222,233,0.06)',
      'border-default': 'rgba(216,222,233,0.1)',
      'border-strong': 'rgba(216,222,233,0.15)',
      'text-primary': '#D8DEE9',
      'text-secondary': '#bcc1c8',
      'text-tertiary': '#8a8e94',
      'text-disabled': '#5c6066',
      accent: '#4c9df3',
      'accent-solid': '#2f7fd4',
      'accent-hover': '#6cb0f7',
    },
  },
  {
    // Material Theme Darker — Equinusocio/Mattia Astorino's classic "Darker"
    // variant (now community-maintained as vsc-community-material-theme).
    // editor/sidebar/activityBar/statusBar/panel all collapse to #212121.
    // Trademark cyan-tinted white foreground #EEFFFF; input #2b2b2b lifts
    // slightly. Accent #80CBC4 is the Material teal (textLink). Secondary
    // text-grey #b0bec5 is Material Blue-Grey 200, comment #545454.
    id: 'material-theme-darker',
    name: 'Material Theme Darker',
    preview: ['#212121', '#2b2b2b', '#3a3a3a', '#80CBC4'],
    colors: {
      'bg-base': '#212121',
      'bg-surface': '#212121',
      'bg-card': '#212121',
      'bg-elevated': '#2b2b2b',
      'bg-input': '#2b2b2b',
      'border-subtle': 'rgba(238,255,255,0.06)',
      'border-default': 'rgba(238,255,255,0.1)',
      'border-strong': 'rgba(238,255,255,0.15)',
      'text-primary': '#EEFFFF',
      'text-secondary': '#b0bec5',
      'text-tertiary': '#808080',
      'text-disabled': '#545454',
      accent: '#80CBC4',
      'accent-solid': '#5d9c95',
      'accent-hover': '#a0e0d9',
    },
  },
  {
    // Tokyo Night — folke/tokyonight.nvim official palette.
    // bg #1a1b26, bg_dark #16161e, fg #c0caf5, comment #565f89, blue #7aa2f7.
    id: 'tokyo-night',
    name: 'Tokyo Night',
    preview: ['#16161e', '#1a1b26', '#24283b', '#7aa2f7'],
    colors: {
      'bg-base': '#16161e',
      'bg-surface': '#1a1b26',
      'bg-card': '#24283b',
      'bg-elevated': '#292e42',
      'bg-input': '#13141a',
      'border-subtle': 'rgba(122,162,247,0.06)',
      'border-default': 'rgba(122,162,247,0.1)',
      'border-strong': 'rgba(122,162,247,0.15)',
      'text-primary': '#c0caf5',
      'text-secondary': '#a9b1d6',
      'text-tertiary': '#565f89',
      'text-disabled': '#414868',
      accent: '#7aa2f7',
      'accent-solid': '#3d59a1',
      'accent-hover': '#9eb8fa',
    },
  },
  {
    // GitHub Dark — primer/github-vscode-theme. Higher-contrast variant.
    // canvas #0d1117, canvas-inset #010409, accent #58a6ff (blue).
    id: 'github-dark',
    name: 'GitHub Dark',
    preview: ['#010409', '#0d1117', '#161b22', '#58a6ff'],
    colors: {
      'bg-base': '#010409',
      'bg-surface': '#0d1117',
      'bg-card': '#161b22',
      'bg-elevated': '#21262d',
      'bg-input': '#010409',
      'border-subtle': 'rgba(240,246,252,0.06)',
      'border-default': 'rgba(240,246,252,0.1)',
      'border-strong': 'rgba(240,246,252,0.15)',
      'text-primary': '#e6edf3',
      'text-secondary': '#c9d1d9',
      'text-tertiary': '#8b949e',
      'text-disabled': '#484f58',
      accent: '#58a6ff',
      'accent-solid': '#1f6feb',
      'accent-hover': '#79c0ff',
    },
  },
  {
    // GitHub Dark Default — github.com's primary dark theme via Primer tokens.
    // canvas #0d1117, fg-default #e6edf3, accent-fg #2f81f7. Slightly airier
    // than GitHub Dark with lighter mid-tones and a less saturated accent.
    id: 'github-dark-default',
    name: 'GitHub Default',
    preview: ['#0d1117', '#161b22', '#21262d', '#2f81f7'],
    colors: {
      'bg-base': '#0d1117',
      'bg-surface': '#161b22',
      'bg-card': '#21262d',
      'bg-elevated': '#2a2f37',
      'bg-input': '#0d1117',
      'border-subtle': 'rgba(240,246,252,0.06)',
      'border-default': 'rgba(240,246,252,0.1)',
      'border-strong': 'rgba(240,246,252,0.15)',
      'text-primary': '#e6edf3',
      'text-secondary': '#b1bac4',
      'text-tertiary': '#7d8590',
      'text-disabled': '#484f58',
      accent: '#2f81f7',
      'accent-solid': '#1f6feb',
      'accent-hover': '#58a6ff',
    },
  },
  {
    // Better Solarized — Ethan Schoonover's Solarized Dark.
    // base03 #002b36, base02 #073642, base01 #586e75, base0 #839496,
    // base1 #93a1a1, blue #268bd2. Designed for low eye-strain contrast.
    id: 'solarized-dark',
    name: 'Better Solarized',
    preview: ['#001a22', '#002b36', '#073642', '#268bd2'],
    colors: {
      'bg-base': '#001a22',
      'bg-surface': '#002b36',
      'bg-card': '#073642',
      'bg-elevated': '#0c4351',
      'bg-input': '#00161c',
      'border-subtle': 'rgba(147,161,161,0.06)',
      'border-default': 'rgba(147,161,161,0.1)',
      'border-strong': 'rgba(147,161,161,0.15)',
      'text-primary': '#93a1a1',
      'text-secondary': '#839496',
      'text-tertiary': '#586e75',
      'text-disabled': '#3e555c',
      accent: '#268bd2',
      'accent-solid': '#1a6ea3',
      'accent-hover': '#3aa6ed',
    },
  },
  {
    // Kanagawa Wave — rebelot/kanagawa.nvim. Inspired by Hokusai's "The Great Wave".
    // bg sumiInk3 #1f1f28, fg fujiWhite #dcd7ba, signature crystalBlue #7e9cd8.
    id: 'kanagawa',
    name: 'Kanagawa',
    preview: ['#16161d', '#1f1f28', '#2a2a37', '#7e9cd8'],
    colors: {
      'bg-base': '#16161d',
      'bg-surface': '#1f1f28',
      'bg-card': '#2a2a37',
      'bg-elevated': '#363646',
      'bg-input': '#181820',
      'border-subtle': 'rgba(220,215,186,0.06)',
      'border-default': 'rgba(220,215,186,0.1)',
      'border-strong': 'rgba(220,215,186,0.15)',
      'text-primary': '#dcd7ba',
      'text-secondary': '#c8c093',
      'text-tertiary': '#727169',
      'text-disabled': '#54546d',
      accent: '#7e9cd8',
      'accent-solid': '#5878b8',
      'accent-hover': '#a3bfee',
    },
  },
  {
    // Kanagawa Dragon — monochromatic warm variant of Kanagawa. Charcoal blacks
    // with a single dragonBlue #658594 accent.
    id: 'kanagawa-dragon',
    name: 'Kanagawa Dragon',
    preview: ['#0d0c0c', '#181616', '#282727', '#658594'],
    colors: {
      'bg-base': '#0d0c0c',
      'bg-surface': '#181616',
      'bg-card': '#282727',
      'bg-elevated': '#393836',
      'bg-input': '#12120f',
      'border-subtle': 'rgba(197,201,197,0.06)',
      'border-default': 'rgba(197,201,197,0.10)',
      'border-strong': 'rgba(197,201,197,0.15)',
      'text-primary': '#c5c9c5',
      'text-secondary': '#a6a69c',
      'text-tertiary': '#625e5a',
      'text-disabled': '#393836',
      accent: '#658594',
      'accent-solid': '#4a6b7a',
      'accent-hover': '#8aabbe',
    },
  },
  {
    // Wuthering Waves — Kuro Games' sci-fi action RPG. Dark teal-black canvases with
    // antique gold accent (signature Resonator amber tone).
    id: 'wuthering-waves',
    name: 'Wuthering Waves',
    preview: ['#0a0f12', '#11181d', '#1a2329', '#d4af37'],
    colors: {
      'bg-base': '#0a0f12',
      'bg-surface': '#11181d',
      'bg-card': '#1a2329',
      'bg-elevated': '#232f37',
      'bg-input': '#070b0e',
      'border-subtle': 'rgba(212,175,55,0.06)',
      'border-default': 'rgba(212,175,55,0.10)',
      'border-strong': 'rgba(212,175,55,0.15)',
      'text-primary': '#e6e9eb',
      'text-secondary': '#b0b8be',
      'text-tertiary': '#6a747c',
      'text-disabled': '#404850',
      accent: '#d4af37',
      'accent-solid': '#a08020',
      'accent-hover': '#e9c75a',
    },
  },
  // ── Red ──
  {
    // Crimson Night — saturated red-500 over deep wine backgrounds. Dramatic but
    // not garish; bg leans nearly-black to keep contrast.
    id: 'crimson-night',
    name: 'Crimson Night',
    preview: ['#14080a', '#1f0e10', '#2a1418', '#ef4444'],
    colors: {
      'bg-base': '#14080a',
      'bg-surface': '#1f0e10',
      'bg-card': '#2a1418',
      'bg-elevated': '#361a1f',
      'bg-input': '#0d0506',
      'border-subtle': 'rgba(248,113,113,0.06)',
      'border-default': 'rgba(248,113,113,0.10)',
      'border-strong': 'rgba(248,113,113,0.15)',
      'text-primary': '#f5e8eb',
      'text-secondary': '#d4a8b0',
      'text-tertiary': '#8c5b66',
      'text-disabled': '#553538',
      accent: '#ef4444',
      'accent-solid': '#dc2626',
      'accent-hover': '#f87171',
    },
  },
  // ── Purple / Violet / Mauve ──
  {
    id: 'dracula',
    name: 'Dracula',
    preview: ['#21222c', '#282a36', '#313545', '#bd93f9'],
    colors: {
      'bg-base': '#21222c',
      'bg-surface': '#282a36',
      'bg-card': '#313545',
      'bg-elevated': '#3a3f55',
      'bg-input': '#1c1d26',
      'border-subtle': 'rgba(189,147,249,0.06)',
      'border-default': 'rgba(189,147,249,0.1)',
      'border-strong': 'rgba(189,147,249,0.15)',
      'text-primary': '#f8f8f2',
      'text-secondary': '#c8c0d8',
      'text-tertiary': '#6272a4',
      'text-disabled': '#44475a',
      accent: '#bd93f9',
      'accent-solid': '#9570d4',
      'accent-hover': '#d4b8ff',
    },
  },
  {
    // Catppuccin Frappé — official catppuccin palette, mid-range dark.
    // base #303446, mantle #292c3c, crust #232634, surface0 #414559,
    // text #c6d0f5, mauve #ca9ee6.
    id: 'catppuccin-frappe',
    name: 'Catppuccin Frappé',
    preview: ['#232634', '#303446', '#414559', '#ca9ee6'],
    colors: {
      'bg-base': '#232634',
      'bg-surface': '#303446',
      'bg-card': '#414559',
      'bg-elevated': '#51576d',
      'bg-input': '#292c3c',
      'border-subtle': 'rgba(198,208,245,0.06)',
      'border-default': 'rgba(198,208,245,0.10)',
      'border-strong': 'rgba(198,208,245,0.15)',
      'text-primary': '#c6d0f5',
      'text-secondary': '#b5bfe2',
      'text-tertiary': '#838ba7',
      'text-disabled': '#626880',
      accent: '#ca9ee6',
      'accent-solid': '#a571c4',
      'accent-hover': '#dab5ed',
    },
  },
  {
    // Catppuccin Macchiato — official catppuccin palette, deep dark.
    // base #24273a, mantle #1e2030, crust #181926, surface0 #363a4f,
    // text #cad3f5, mauve #c6a0f6.
    id: 'catppuccin-macchiato',
    name: 'Catppuccin Macchiato',
    preview: ['#181926', '#24273a', '#363a4f', '#c6a0f6'],
    colors: {
      'bg-base': '#181926',
      'bg-surface': '#24273a',
      'bg-card': '#363a4f',
      'bg-elevated': '#494d64',
      'bg-input': '#1e2030',
      'border-subtle': 'rgba(202,211,245,0.06)',
      'border-default': 'rgba(202,211,245,0.10)',
      'border-strong': 'rgba(202,211,245,0.15)',
      'text-primary': '#cad3f5',
      'text-secondary': '#b8c0e0',
      'text-tertiary': '#8087a2',
      'text-disabled': '#5b6078',
      accent: '#c6a0f6',
      'accent-solid': '#a070d4',
      'accent-hover': '#d4baf9',
    },
  },
  {
    // Catppuccin Mocha — official catppuccin palette, darkest variant.
    // base #1e1e2e, mantle #181825, crust #11111b, surface0 #313244,
    // text #cdd6f4, mauve #cba6f7 (signature accent).
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    preview: ['#11111b', '#1e1e2e', '#313244', '#cba6f7'],
    colors: {
      'bg-base': '#11111b',
      'bg-surface': '#1e1e2e',
      'bg-card': '#313244',
      'bg-elevated': '#45475a',
      'bg-input': '#181825',
      'border-subtle': 'rgba(205,214,244,0.06)',
      'border-default': 'rgba(205,214,244,0.10)',
      'border-strong': 'rgba(205,214,244,0.15)',
      'text-primary': '#cdd6f4',
      'text-secondary': '#bac2de',
      'text-tertiary': '#7f849c',
      'text-disabled': '#585b70',
      accent: '#cba6f7',
      'accent-solid': '#8839ef',
      'accent-hover': '#dbb6fa',
    },
  },
  {
    // Rosé Pine (Main) — rosepinetheme.com. base #191724, surface #1f1d2e,
    // overlay #26233a, text #e0def4, iris #c4a7e7 (signature accent).
    id: 'rose-pine',
    name: 'Rosé Pine',
    preview: ['#191724', '#1f1d2e', '#26233a', '#c4a7e7'],
    colors: {
      'bg-base': '#191724',
      'bg-surface': '#1f1d2e',
      'bg-card': '#26233a',
      'bg-elevated': '#2c2940',
      'bg-input': '#14121f',
      'border-subtle': 'rgba(224,222,244,0.06)',
      'border-default': 'rgba(224,222,244,0.1)',
      'border-strong': 'rgba(224,222,244,0.15)',
      'text-primary': '#e0def4',
      'text-secondary': '#908caa',
      'text-tertiary': '#6e6a86',
      'text-disabled': '#403d52',
      accent: '#c4a7e7',
      'accent-solid': '#9d7cd8',
      'accent-hover': '#d4baf2',
    },
  },
  {
    // Violet Dusk — saturated violet over near-black indigo. Crepuscular vibe,
    // pairs well with the Genshin / mystical themes nearby.
    id: 'violet-dusk',
    name: 'Violet Dusk',
    preview: ['#100c1d', '#18132e', '#221c40', '#a78bfa'],
    colors: {
      'bg-base': '#100c1d',
      'bg-surface': '#18132e',
      'bg-card': '#221c40',
      'bg-elevated': '#2c2552',
      'bg-input': '#0c0918',
      'border-subtle': 'rgba(167,139,250,0.06)',
      'border-default': 'rgba(167,139,250,0.10)',
      'border-strong': 'rgba(167,139,250,0.15)',
      'text-primary': '#efeaff',
      'text-secondary': '#bba8dc',
      'text-tertiary': '#7c6da5',
      'text-disabled': '#4b3f6a',
      accent: '#a78bfa',
      'accent-solid': '#8b5cf6',
      'accent-hover': '#c4b5fd',
    },
  },
  {
    // Genshin Vibes — inspired by HoYoverse's open-world RPG. Twilight violet
    // canvases with Mora-gold accent (#bd9560).
    id: 'genshin-vibes',
    name: 'Genshin Vibes',
    preview: ['#14101d', '#1e1a2e', '#29243f', '#bd9560'],
    colors: {
      'bg-base': '#14101d',
      'bg-surface': '#1e1a2e',
      'bg-card': '#29243f',
      'bg-elevated': '#342e4d',
      'bg-input': '#100d18',
      'border-subtle': 'rgba(189,149,96,0.06)',
      'border-default': 'rgba(189,149,96,0.10)',
      'border-strong': 'rgba(189,149,96,0.15)',
      'text-primary': '#f0eaff',
      'text-secondary': '#d0c8d8',
      'text-tertiary': '#8e8398',
      'text-disabled': '#58506a',
      accent: '#bd9560',
      'accent-solid': '#9c7a48',
      'accent-hover': '#d4b079',
    },
  },
  // ── Light ──
  {
    // Catppuccin Latte — official catppuccin light variant.
    // base #eff1f5, mantle #e6e9ef, crust #dce0e8, surface0 #ccd0da,
    // text #4c4f69, mauve #8839ef.
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    preview: ['#eff1f5', '#e6e9ef', '#ccd0da', '#8839ef'],
    colors: {
      'bg-base': '#eff1f5',
      'bg-surface': '#e6e9ef',
      'bg-card': '#dce0e8',
      'bg-elevated': '#ccd0da',
      'bg-input': '#ffffff',
      'border-subtle': 'rgba(76,79,105,0.08)',
      'border-default': 'rgba(76,79,105,0.15)',
      'border-strong': 'rgba(76,79,105,0.25)',
      'text-primary': '#4c4f69',
      'text-secondary': '#5c5f77',
      'text-tertiary': '#8c8fa1',
      'text-disabled': '#acb0be',
      accent: '#8839ef',
      'accent-solid': '#7c3aed',
      'accent-hover': '#a570f5',
    },
  },
  {
    // GitHub Light — primer.style canonical light. canvas-default #ffffff,
    // canvas-subtle #f6f8fa, fg-default #1f2328, accent-fg #0969da.
    id: 'github-light',
    name: 'GitHub Light',
    preview: ['#ffffff', '#f6f8fa', '#eaeef2', '#0969da'],
    colors: {
      'bg-base': '#ffffff',
      'bg-surface': '#f6f8fa',
      'bg-card': '#eaeef2',
      'bg-elevated': '#d0d7de',
      'bg-input': '#ffffff',
      'border-subtle': 'rgba(31,35,40,0.08)',
      'border-default': 'rgba(31,35,40,0.15)',
      'border-strong': 'rgba(31,35,40,0.25)',
      'text-primary': '#1f2328',
      'text-secondary': '#656d76',
      'text-tertiary': '#8c959f',
      'text-disabled': '#b5bac1',
      accent: '#0969da',
      'accent-solid': '#0550ae',
      'accent-hover': '#218bff',
    },
  },
  {
    // Solarized Light — Ethan Schoonover's light variant. base3 #fdf6e3 (canvas),
    // base2 #eee8d5, base01 #586e75 (body), blue #268bd2.
    // text-primary nudged from base01 #586e75 to #4a6066 — same blue-gray tone but
    // dark enough to clear WCAG AA (4.5:1) against bg-surface (#eee8d5). base01
    // against base2 was 4.4:1, just below the threshold.
    id: 'solarized-light',
    name: 'Solarized Light',
    preview: ['#fdf6e3', '#eee8d5', '#d8d2bf', '#268bd2'],
    colors: {
      'bg-base': '#fdf6e3',
      'bg-surface': '#eee8d5',
      'bg-card': '#d8d2bf',
      'bg-elevated': '#c4c0b0',
      'bg-input': '#ffffff',
      'border-subtle': 'rgba(88,110,117,0.08)',
      'border-default': 'rgba(88,110,117,0.15)',
      'border-strong': 'rgba(88,110,117,0.25)',
      'text-primary': '#4a6066',
      'text-secondary': '#657b83',
      'text-tertiary': '#93a1a1',
      'text-disabled': '#b5b09f',
      accent: '#268bd2',
      'accent-solid': '#1a6ea3',
      'accent-hover': '#3aa6ed',
    },
  },
  {
    // Tokyo Night Light — folke/tokyonight.nvim's day variant. Cool gray-blue
    // canvas with deep blue accent. Pairs well with the dark Tokyo Night above.
    id: 'tokyo-night-light',
    name: 'Tokyo Night Light',
    preview: ['#e1e2e7', '#d5d6db', '#cbccd1', '#2959aa'],
    colors: {
      'bg-base': '#e1e2e7',
      'bg-surface': '#d5d6db',
      'bg-card': '#cbccd1',
      'bg-elevated': '#b8b9be',
      'bg-input': '#f1f2f7',
      'border-subtle': 'rgba(52,59,88,0.08)',
      'border-default': 'rgba(52,59,88,0.15)',
      'border-strong': 'rgba(52,59,88,0.25)',
      'text-primary': '#343b58',
      'text-secondary': '#485178',
      'text-tertiary': '#828ab5',
      'text-disabled': '#a8b1d6',
      accent: '#2959aa',
      'accent-solid': '#1d4380',
      'accent-hover': '#4071c8',
    },
  },
  {
    // Atom One Light — port of atom/one-light. Soft greys with teal accent.
    id: 'atom-one-light',
    name: 'Atom One Light',
    preview: ['#fafafa', '#f0f0f0', '#e5e5e5', '#0184bc'],
    colors: {
      'bg-base': '#fafafa',
      'bg-surface': '#f0f0f0',
      'bg-card': '#e5e5e5',
      'bg-elevated': '#d6d6d6',
      'bg-input': '#ffffff',
      'border-subtle': 'rgba(56,58,66,0.06)',
      'border-default': 'rgba(56,58,66,0.12)',
      'border-strong': 'rgba(56,58,66,0.22)',
      'text-primary': '#383a42',
      'text-secondary': '#525965',
      'text-tertiary': '#8a8e96',
      'text-disabled': '#b9bcc1',
      accent: '#0184bc',
      'accent-solid': '#016793',
      'accent-hover': '#39a3ce',
    },
  },
  {
    // Material Lighter — JetBrains material-theme palette, lighter variant.
    // Cool whites + cyan accent. Industry classic.
    id: 'material-lighter',
    name: 'Material Lighter',
    preview: ['#fafafa', '#eeeeee', '#e1e1e2', '#39adb5'],
    colors: {
      'bg-base': '#fafafa',
      'bg-surface': '#eeeeee',
      'bg-card': '#e1e1e2',
      'bg-elevated': '#d4d4d5',
      'bg-input': '#ffffff',
      'border-subtle': 'rgba(74,89,99,0.06)',
      'border-default': 'rgba(74,89,99,0.12)',
      'border-strong': 'rgba(74,89,99,0.22)',
      'text-primary': '#4a5963',
      'text-secondary': '#6f7e8a',
      'text-tertiary': '#90a4ae',
      'text-disabled': '#b0bec5',
      accent: '#39adb5',
      'accent-solid': '#26878f',
      'accent-hover': '#5cc1c9',
    },
  },
  {
    // Cream Paper — warm cream canvas with terracotta accent. For users who
    // find pure-white light themes harsh; reads like a paper notebook.
    id: 'cream-paper',
    name: 'Cream Paper',
    preview: ['#f5efe3', '#ede5d3', '#e3d9c2', '#b85c38'],
    colors: {
      'bg-base': '#f5efe3',
      'bg-surface': '#ede5d3',
      'bg-card': '#e3d9c2',
      'bg-elevated': '#d6caaf',
      'bg-input': '#fbf6ec',
      'border-subtle': 'rgba(94,69,42,0.08)',
      'border-default': 'rgba(94,69,42,0.16)',
      'border-strong': 'rgba(94,69,42,0.26)',
      'text-primary': '#4a3a28',
      'text-secondary': '#6b5640',
      'text-tertiary': '#8a7660',
      'text-disabled': '#b3a48f',
      accent: '#b85c38',
      'accent-solid': '#964627',
      'accent-hover': '#d17a55',
    },
  },
  {
    // Notebook — near-white with navy accent. Minimal, high-legibility light.
    id: 'notebook',
    name: 'Notebook',
    preview: ['#ffffff', '#f7f7f8', '#eeeef0', '#1f3a93'],
    colors: {
      'bg-base': '#ffffff',
      'bg-surface': '#f7f7f8',
      'bg-card': '#eeeef0',
      'bg-elevated': '#e2e2e6',
      'bg-input': '#ffffff',
      'border-subtle': 'rgba(31,58,147,0.05)',
      'border-default': 'rgba(31,58,147,0.12)',
      'border-strong': 'rgba(31,58,147,0.22)',
      'text-primary': '#1a1a2e',
      'text-secondary': '#3a3a52',
      'text-tertiary': '#6c6c84',
      'text-disabled': '#a2a2b4',
      accent: '#1f3a93',
      'accent-solid': '#162a6d',
      'accent-hover': '#3a5cc7',
    },
  },
  // ── Vivid (high-saturation dark palettes) ──
  {
    // Cyberpunk Neon — hot pink + cyan on near-black. Heavy contrast.
    id: 'cyberpunk-neon',
    name: 'Cyberpunk Neon',
    preview: ['#0a0a14', '#12121e', '#1c1c2e', '#ff2bd1'],
    colors: {
      'bg-base': '#0a0a14',
      'bg-surface': '#12121e',
      'bg-card': '#1c1c2e',
      'bg-elevated': '#262640',
      'bg-input': '#06060c',
      'border-subtle': 'rgba(255,43,209,0.08)',
      'border-default': 'rgba(255,43,209,0.18)',
      'border-strong': 'rgba(255,43,209,0.32)',
      'text-primary': '#f0eaff',
      'text-secondary': '#b8a8d4',
      'text-tertiary': '#7e6e98',
      'text-disabled': '#4a4060',
      accent: '#ff2bd1',
      'accent-solid': '#d61eb0',
      'accent-hover': '#ff66dc',
    },
  },
  {
    // Synthwave '84 — robb0wen/synthwave-84 inspired. Magenta + deep purple.
    id: 'synthwave-84',
    name: 'Synthwave \'84',
    preview: ['#241b2f', '#2b213d', '#34294a', '#ff7edb'],
    colors: {
      'bg-base': '#241b2f',
      'bg-surface': '#2b213d',
      'bg-card': '#34294a',
      'bg-elevated': '#3f3258',
      'bg-input': '#1e1727',
      'border-subtle': 'rgba(255,126,219,0.08)',
      'border-default': 'rgba(255,126,219,0.18)',
      'border-strong': 'rgba(255,126,219,0.30)',
      'text-primary': '#f8f8f2',
      'text-secondary': '#cdb8e0',
      'text-tertiary': '#8a7ba0',
      'text-disabled': '#5a4d6c',
      accent: '#ff7edb',
      'accent-solid': '#e455c0',
      'accent-hover': '#ffa1e5',
    },
  },
  {
    // Hotline Miami — electric yellow on near-black. Differentiates from Cyberpunk Neon
    // (magenta-on-black) by hue: yellow accent with pink borders for that 1980s arcade
    // / Miami-at-night vibe.
    id: 'hotline-miami',
    name: 'Hotline Miami',
    preview: ['#100c14', '#1a1620', '#26202e', '#f4d03f'],
    colors: {
      'bg-base': '#100c14',
      'bg-surface': '#1a1620',
      'bg-card': '#26202e',
      'bg-elevated': '#322a3a',
      'bg-input': '#0a070c',
      'border-subtle': 'rgba(255,0,170,0.08)',
      'border-default': 'rgba(255,0,170,0.22)',
      'border-strong': 'rgba(255,0,170,0.38)',
      'text-primary': '#fff8e0',
      'text-secondary': '#d4c8a0',
      'text-tertiary': '#988868',
      'text-disabled': '#5a4e3a',
      accent: '#f4d03f',
      'accent-solid': '#d4af0a',
      'accent-hover': '#ffe066',
    },
  },
  // ── Pastel (soft / low-saturation light palettes) ──
  {
    // Cotton Candy — pink + cyan pastel on cream. Playful, low-contrast soft.
    id: 'cotton-candy',
    name: 'Cotton Candy',
    preview: ['#fdf6f8', '#fae8ed', '#f2d4dd', '#7dc6dd'],
    colors: {
      'bg-base': '#fdf6f8',
      'bg-surface': '#fae8ed',
      'bg-card': '#f2d4dd',
      'bg-elevated': '#e8bfcc',
      'bg-input': '#fffafc',
      'border-subtle': 'rgba(170,90,120,0.08)',
      'border-default': 'rgba(170,90,120,0.16)',
      'border-strong': 'rgba(170,90,120,0.26)',
      'text-primary': '#4a2a3c',
      'text-secondary': '#6e4c5e',
      'text-tertiary': '#9a7888',
      'text-disabled': '#c4adb8',
      accent: '#7dc6dd',
      'accent-solid': '#52aac4',
      'accent-hover': '#a4dceb',
    },
  },
  {
    // Mint Sorbet — soft mint canvas with lavender accent.
    id: 'mint-sorbet',
    name: 'Mint Sorbet',
    preview: ['#f1faf5', '#e3f3eb', '#d2ebde', '#9d7cd8'],
    colors: {
      'bg-base': '#f1faf5',
      'bg-surface': '#e3f3eb',
      'bg-card': '#d2ebde',
      'bg-elevated': '#bce0cd',
      'bg-input': '#f8fdfa',
      'border-subtle': 'rgba(70,120,90,0.08)',
      'border-default': 'rgba(70,120,90,0.16)',
      'border-strong': 'rgba(70,120,90,0.26)',
      'text-primary': '#2c4838',
      'text-secondary': '#4a6a58',
      'text-tertiary': '#7a9788',
      'text-disabled': '#aabbb1',
      accent: '#9d7cd8',
      'accent-solid': '#7a5bb8',
      'accent-hover': '#b9a0e3',
    },
  },
  {
    // Peach Fuzz — warm peach + soft coral. Cosy, low-contrast.
    id: 'peach-fuzz',
    name: 'Peach Fuzz',
    preview: ['#fff3ec', '#ffe5d4', '#ffd2b6', '#e8826a'],
    colors: {
      'bg-base': '#fff3ec',
      'bg-surface': '#ffe5d4',
      'bg-card': '#ffd2b6',
      'bg-elevated': '#f6c19f',
      'bg-input': '#fff9f4',
      'border-subtle': 'rgba(184,92,56,0.08)',
      'border-default': 'rgba(184,92,56,0.16)',
      'border-strong': 'rgba(184,92,56,0.26)',
      'text-primary': '#4a2618',
      'text-secondary': '#6e3f2a',
      'text-tertiary': '#9a6648',
      'text-disabled': '#c4967a',
      accent: '#e8826a',
      'accent-solid': '#c46045',
      'accent-hover': '#f09f8b',
    },
  },
];

export const DEFAULT_THEME_ID = 'lavender-coal';

// Filterable tags for the Themes tab — every preset is "dark" or "light", plus
// optional style tags (vivid / pastel / monochrome) when those traits dominate.
// Kept as a separate map (not inline on each preset) so adding a new tag dimension
// later is a one-place change.
export type ThemeTag = 'dark' | 'light' | 'vivid' | 'pastel' | 'monochrome';

export const THEME_TAGS: Record<string, ThemeTag[]> = {
  'carbon': ['dark', 'monochrome'],
  'sakura': ['dark', 'pastel'],
  'copper': ['dark', 'vivid'],
  'amber': ['dark', 'vivid'],
  'gruvbox-dark': ['dark', 'vivid'],
  'minimal-kiwi': ['dark', 'monochrome'],
  'monokai': ['dark', 'vivid'],
  'dark-ever': ['dark', 'pastel'],
  'green-beautiful-2': ['dark', 'vivid'],
  'green-dark': ['dark', 'vivid'],
  'hatsune-miku': ['dark', 'vivid'],
  'ocean': ['dark', 'vivid'],
  'ocean-deep': ['dark', 'vivid'],
  'nord': ['dark', 'pastel'],
  'midnight': ['dark'],
  'one-dark-pro': ['dark'],
  'one-dark-pro-night-flat': ['dark', 'monochrome'],
  'lavender-coal': ['dark', 'monochrome'],
  'cursor-dark': ['dark', 'monochrome'],
  'cursor-less-dark': ['dark', 'monochrome'],
  'material-theme-darker': ['dark', 'monochrome'],
  'tokyo-night': ['dark'],
  'github-dark': ['dark'],
  'github-dark-default': ['dark'],
  'solarized-dark': ['dark'],
  'kanagawa': ['dark', 'pastel'],
  'kanagawa-dragon': ['dark', 'monochrome'],
  'wuthering-waves': ['dark', 'vivid'],
  'crimson-night': ['dark', 'vivid'],
  'dracula': ['dark', 'vivid'],
  'catppuccin-frappe': ['dark', 'pastel'],
  'catppuccin-macchiato': ['dark', 'pastel'],
  'catppuccin-mocha': ['dark', 'pastel'],
  'rose-pine': ['dark', 'pastel'],
  'violet-dusk': ['dark', 'vivid'],
  'genshin-vibes': ['dark'],
  'catppuccin-latte': ['light', 'pastel'],
  'github-light': ['light'],
  'solarized-light': ['light'],
  'tokyo-night-light': ['light'],
  'atom-one-light': ['light'],
  'material-lighter': ['light'],
  'cream-paper': ['light'],
  'notebook': ['light', 'monochrome'],
  'cyberpunk-neon': ['dark', 'vivid'],
  'synthwave-84': ['dark', 'vivid'],
  'hotline-miami': ['dark', 'vivid'],
  'cotton-candy': ['light', 'pastel'],
  'mint-sorbet': ['light', 'pastel'],
  'peach-fuzz': ['light', 'pastel'],
};

export function getThemeTags(id: string): ThemeTag[] {
  return THEME_TAGS[id] ?? ['dark'];
}

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

// ── WCAG contrast ──

// Relative luminance per WCAG 2.1 — gamma-correct then weighted sum.
function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRGB(hex);
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * WCAG 2.1 contrast ratio between two colors (hex). Returns 1.0–21.0.
 * AA body-text wants ≥ 4.5; AA large/graphics wants ≥ 3; AAA wants ≥ 7.
 */
export function contrastRatio(fgHex: string, bgHex: string): number {
  const l1 = relativeLuminance(toHex(fgHex));
  const l2 = relativeLuminance(toHex(bgHex));
  const [lighter, darker] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
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
const CUSTOM_PRESETS_KEY = 'truereplay-custom-presets';

/**
 * User-saved presets — separate from the built-in presets array so they can be
 * added/removed without affecting the curated list. Stored as JSON in localStorage
 * under CUSTOM_PRESETS_KEY. Each entry uses the same shape as ThemePreset but with
 * a `__custom: true` marker for UI distinction.
 */
export interface CustomThemePreset extends ThemePreset {
  __custom: true;
}

export function loadCustomPresets(): CustomThemePreset[] {
  try {
    const raw = localStorage.getItem(CUSTOM_PRESETS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(p => p && typeof p.id === 'string' && p.colors);
  } catch {
    return [];
  }
}

export function saveCustomPresets(presets: CustomThemePreset[]): void {
  // localStorage.setItem can throw QuotaExceededError when the storage quota is full
  // (rare in WebView2 with no other origins competing, but technically possible if
  // the user accumulates hundreds of custom presets with embedded preview data).
  // Swallow + log instead of crashing the theme provider — the user just won't see
  // the preset persist; current session still works in memory.
  try {
    localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(presets));
  } catch (err) {
    console.warn('[themes] Failed to save custom presets:', err);
  }
}

/** Generate a stable id from a user-supplied preset name. */
export function makeCustomPresetId(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `custom-${slug || Date.now()}`;
}

export function loadThemeConfig(): ThemeConfig {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return makeDefaultConfig();

  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version >= 1 && parsed.baseThemeId) {
      // Merge UI settings with defaults for backwards compatibility (new fields)
      const merged: ThemeConfig = {
        ...parsed,
        version: 3,
        uiSettings: { ...DEFAULT_UI_SETTINGS, ...parsed.uiSettings },
      };

      // v1 → v2 migration: the palette pass swapped three action colours
      // (PixelColor cyan → lime, Scroll deep mint → light mint, Pause amber →
      // slate) to resolve hue clashes with Key and SendText. Only swap the
      // user's stored value when it still matches the OLD default — that way
      // anyone who deliberately picked one of those hex values keeps their
      // choice intact. Fresh installs already get the new defaults via
      // DEFAULT_UI_SETTINGS; this branch covers existing localStorage data.
      if (parsed.version < 2) {
        const ui = merged.uiSettings;
        if (ui.actionPixelColorColor === '#22d3ee') ui.actionPixelColorColor = DEFAULT_UI_SETTINGS.actionPixelColorColor;
        if (ui.actionScrollColor === '#6bcb77') ui.actionScrollColor = DEFAULT_UI_SETTINGS.actionScrollColor;
        if (ui.actionPauseColor === '#fbbf24') ui.actionPauseColor = DEFAULT_UI_SETTINGS.actionPauseColor;
      }

      // v2 → v3 migration: If/Else/EndIf moved from amber (#fbbf24) to teal
      // (#2dd4bf) so it no longer shares the 43° hue with SendText gold. Same
      // "only swap if it still matches the old default" pattern as above.
      if (parsed.version < 3) {
        const ui = merged.uiSettings;
        if (ui.actionIfColor === '#fbbf24') ui.actionIfColor = DEFAULT_UI_SETTINGS.actionIfColor;
      }

      return merged;
    }
  } catch {
    // Not JSON — old format (plain theme ID string)
    if (getThemeById(raw)) {
      return { version: 3, baseThemeId: raw, colorOverrides: {}, uiSettings: { ...DEFAULT_UI_SETTINGS } };
    }
  }

  return makeDefaultConfig();
}

export function saveThemeConfig(config: ThemeConfig): void {
  // Same QuotaExceededError guard as saveCustomPresets. Theme config is tiny (~1KB)
  // so realistically the quota only fills up when something ELSE is misbehaving;
  // logging + swallowing keeps the rest of the app responsive.
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch (err) {
    console.warn('[themes] Failed to save theme config:', err);
  }
}

export function makeDefaultConfig(): ThemeConfig {
  return { version: 3, baseThemeId: DEFAULT_THEME_ID, colorOverrides: {}, uiSettings: { ...DEFAULT_UI_SETTINGS } };
}

// ── Theme Resolution ──

export function resolveThemeColors(config: ThemeConfig, customPresets: ThemePreset[] = []): ThemeColors {
  // Custom presets take precedence over built-in ids — the user might intentionally
  // override a built-in name. In practice ids should never collide thanks to the
  // 'custom-' prefix from makeCustomPresetId, but the lookup order keeps user wins.
  const base = customPresets.find(t => t.id === config.baseThemeId)
    ?? getThemeById(config.baseThemeId)
    ?? themes[0];
  return { ...base.colors, ...config.colorOverrides };
}

export function applyThemeConfig(colors: ThemeColors, uiSettings: ThemeUISettings) {
  const root = document.documentElement;

  // Build the entire variable set as one cssText string, then assign once.
  // Each `setProperty` call invalidates the style cache and can schedule a
  // separate style recalc — with ~40 vars per theme apply, the cumulative
  // cost is visible on theme-editor sliders (one keystroke = full recompute
  // through 40 sets). One cssText assign is a single mutation that the
  // browser batches into a single recalc. Trade-off: we lose the inline-vs-
  // stylesheet distinction, but every var here was already an inline anyway,
  // so net behaviour is identical — just faster.
  const parts: string[] = [];
  for (const [key, value] of Object.entries(colors)) {
    parts.push(`--color-${key}: ${value};`);
  }
  // Layout
  parts.push(`--ui-font-size: ${uiSettings.fontSize}px;`);
  parts.push(`--ui-border-radius: ${uiSettings.borderRadius}px;`);
  parts.push(`--ui-row-height: ${uiSettings.rowHeight}px;`);
  // Semantic colors + auto-derived backgrounds
  parts.push(`--color-recording: ${uiSettings.recordingColor};`);
  parts.push(`--color-recording-bg: color-mix(in srgb, ${uiSettings.recordingColor} 10%, transparent);`);
  parts.push(`--color-replay: ${uiSettings.replayColor};`);
  parts.push(`--color-replay-bg: color-mix(in srgb, ${uiSettings.replayColor} 10%, transparent);`);
  parts.push(`--color-clicker: ${uiSettings.clickerColor};`);
  parts.push(`--color-clicker-bg: color-mix(in srgb, ${uiSettings.clickerColor} 12%, transparent);`);
  parts.push(`--color-clicker-border: color-mix(in srgb, ${uiSettings.clickerColor} 30%, transparent);`);
  // Action type pill colors + auto-derived backgrounds
  parts.push(`--color-action-mouse-fg: ${uiSettings.actionMouseColor};`);
  parts.push(`--color-action-mouse-bg: color-mix(in srgb, ${uiSettings.actionMouseColor} 10%, transparent);`);
  parts.push(`--color-action-key-fg: ${uiSettings.actionKeyColor};`);
  parts.push(`--color-action-key-bg: color-mix(in srgb, ${uiSettings.actionKeyColor} 10%, transparent);`);
  parts.push(`--color-action-scroll-fg: ${uiSettings.actionScrollColor};`);
  parts.push(`--color-action-scroll-bg: color-mix(in srgb, ${uiSettings.actionScrollColor} 10%, transparent);`);
  parts.push(`--color-action-sendtext-fg: ${uiSettings.actionSendTextColor};`);
  parts.push(`--color-action-sendtext-bg: color-mix(in srgb, ${uiSettings.actionSendTextColor} 10%, transparent);`);
  parts.push(`--color-action-waitimage-fg: ${uiSettings.actionWaitImageColor};`);
  parts.push(`--color-action-waitimage-bg: color-mix(in srgb, ${uiSettings.actionWaitImageColor} 10%, transparent);`);
  parts.push(`--color-action-pixelcolor-fg: ${uiSettings.actionPixelColorColor};`);
  parts.push(`--color-action-pixelcolor-bg: color-mix(in srgb, ${uiSettings.actionPixelColorColor} 10%, transparent);`);
  parts.push(`--color-action-browser-fg: ${uiSettings.actionBrowserColor};`);
  parts.push(`--color-action-browser-bg: color-mix(in srgb, ${uiSettings.actionBrowserColor} 10%, transparent);`);
  parts.push(`--color-action-runprofile-fg: ${uiSettings.actionRunProfileColor};`);
  parts.push(`--color-action-runprofile-bg: color-mix(in srgb, ${uiSettings.actionRunProfileColor} 10%, transparent);`);
  parts.push(`--color-action-pause-fg: ${uiSettings.actionPauseColor};`);
  parts.push(`--color-action-pause-bg: color-mix(in srgb, ${uiSettings.actionPauseColor} 10%, transparent);`);
  parts.push(`--color-action-if-fg: ${uiSettings.actionIfColor};`);
  parts.push(`--color-action-if-bg: color-mix(in srgb, ${uiSettings.actionIfColor} 10%, transparent);`);
  // Tinted border for the conditional block scope rail. 35% alpha so it stays
  // visible at depth-1 while still reading as a secondary structural cue.
  parts.push(`--color-action-if-border: color-mix(in srgb, ${uiSettings.actionIfColor} 35%, transparent);`);
  // Font
  parts.push(`--font-mono: '${uiSettings.fontMono}', 'Courier New', monospace;`);

  root.style.cssText = parts.join(' ');

  // `zoom` doesn't sit cleanly in the cssText batch because it's a real CSS
  // property (not a custom var). Set it separately — a single property assign
  // still benefits from coming after the variable batch so the browser only
  // composes one final layout. Same reasoning for the data-attribute.
  root.style.zoom = `${uiSettings.zoom / 100}`;

  // Animations toggle — exposes a single data-attribute the CSS can hook into
  // (e.g. `html[data-animations="true"] .some-thing { transition: ... }`).
  root.setAttribute('data-animations', uiSettings.enableAnimations ? 'true' : 'false');
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
  if (ui.zoom !== undefined && typeof ui.zoom !== 'number') return false;
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
