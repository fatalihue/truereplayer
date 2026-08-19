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
  // SetVariable was sharing SendText's gold — the two "text/data" actions looked
  // identical. Its own hue (default a vivid magenta) sits in the one perceptually-
  // open pill slot left on the wheel, clear of every other action.
  actionSetVariableColor: string;
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
  // 90, lowered from 95 in 2026-08. Existing installs are moved by the v4 → v5 migration
  // in loadThemeConfig, but ONLY when their stored value is still exactly 95 — a saved
  // config always carries a zoom, so without that migration this constant would only ever
  // reach fresh installs.
  zoom: 90,
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
  // Magenta (~315°) — the last open pill slot: ~23° from WaitImage's fuchsia and
  // far from the SendText gold it used to share. Only near the block-1 rose RAIL
  // (a different visual role), never another pill. Its own icon (Braces) reinforces
  // the split.
  actionSetVariableColor: '#e05cbf',
  actionWaitImageColor: '#e879f9',
  // Lime — replaced the old cyan (#22d3ee) which collided with Key (#60cdff) at
  // only 13° of hue separation. Lime occupies the open slot between SendText
  // gold (43°) and Scroll green (127°), giving 43°+ to every neighbour. No
  // hardcoded semantic — PixelColor is "watch any colour", so the action is the
  // free agent of the palette.
  //
  // Darkened #84cc16 → #65a30d (v3→v4): under deuteranopia every 60–180° hue
  // compresses toward yellow and discrimination falls back to LIGHTNESS — and
  // the old lime sat within ~2 L* of Replay green (#6bcb77), making the two a
  // colorblind twin pair in the grid. The darker lime opens a ~13 L* gap while
  // keeping the hue slot. (Scroll mint vs Replay green share a hue by DESIGN —
  // same "movement" family, separated by lightness — and If moved to teal in
  // v2→v3, so this was the last confusable pair.)
  actionPixelColorColor: '#65a30d',
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

export const CURRENT_THEME_CONFIG_VERSION = 6;

export interface ThemeConfig {
  // Schema version. v1 = original; v2 = palette pass (PixelColor / Scroll / Pause
  // defaults swapped); v3 = If color moved from amber to teal to resolve hue
  // collision with SendText gold; v4 = PixelColor lime darkened (#84cc16 →
  // #65a30d) for deuteranopia lightness separation from Replay green; v5 = default
  // zoom 95 → 90; v6 = preset ids retired by the 2026-08 curation remapped to
  // their surviving relatives (REMOVED_THEME_FALLBACKS).
  // loadThemeConfig migrates v1 → … → v6 in place. Writers must use
  // CURRENT_THEME_CONFIG_VERSION (below) — a stale literal at any write site
  // silently re-runs migrations on the next load. Listed as `number` rather
  // than a literal union so future bumps don't require a type edit everywhere.
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

// Themes ordered by accent hue: orange/yellow → green → cyan/blue → red → purple → light.
// Curated 2026-08: 48 → 29 presets. Each surviving dark theme owns a distinct hue/vibe
// slot; near-duplicates were retired and their ids remapped in REMOVED_THEME_FALLBACKS.
// 2026-08-13: +8 in-house duotone presets built from owner-picked colour pairs (37
// total) — each palette carries its pair's reference hexes literally (see per-theme
// comments).
export const themes: ThemePreset[] = [
  // ── Orange / Yellow ──
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
  {
    // Butter Pine — in-house duotone (2026-08 owner pair): butter yellow #ffefb3
    // over deep pine green #013e37. The green is the canvas (reference hex at
    // bg-card); the text ramp warms toward the butter side so the theme reads
    // cream-on-green rather than white-on-teal.
    id: 'butter-pine',
    name: 'Butter Pine',
    preview: ['#012620', '#013129', '#013e37', '#ffefb3'],
    colors: {
      'bg-base': '#012620',
      'bg-surface': '#013129',
      'bg-card': '#013e37',
      'bg-elevated': '#024c43',
      'bg-input': '#011d19',
      'border-subtle': 'rgba(255,239,179,0.06)',
      'border-default': 'rgba(255,239,179,0.10)',
      'border-strong': 'rgba(255,239,179,0.15)',
      'text-primary': '#f4efd8',
      'text-secondary': '#c9cfae',
      'text-tertiary': '#7d9a84',
      'text-disabled': '#3f5c50',
      accent: '#ffefb3',
      'accent-solid': '#dcc571',
      'accent-hover': '#fff7d1',
    },
  },
  {
    // Bumblebee — in-house duotone (2026-08 owner pair): aureolin yellow #fbe311
    // on bistre brown #261606 (reference hex at bg-surface). High-voltage hazard
    // look; the text ramp stays warm cream so only the accent buzzes.
    id: 'bumblebee',
    name: 'Bumblebee',
    preview: ['#1c0f04', '#261606', '#33200b', '#fbe311'],
    colors: {
      'bg-base': '#1c0f04',
      'bg-surface': '#261606',
      'bg-card': '#33200b',
      'bg-elevated': '#402a10',
      'bg-input': '#150b03',
      'border-subtle': 'rgba(251,227,17,0.06)',
      'border-default': 'rgba(251,227,17,0.10)',
      'border-strong': 'rgba(251,227,17,0.15)',
      'text-primary': '#f5ecd9',
      'text-secondary': '#d1c2a4',
      'text-tertiary': '#96835f',
      'text-disabled': '#57452a',
      accent: '#fbe311',
      'accent-solid': '#d3bd09',
      'accent-hover': '#fdef5e',
    },
  },
  // ── Green ──
  {
    // Lime Spark — in-house duotone (2026-08 owner pair): electric chartreuse
    // #b6ff2e on cool graphite blue-grey #23262f (reference hex at bg-surface).
    // Instrument-cluster look: neutral cold canvas, one loud needle.
    id: 'lime-spark',
    name: 'Lime Spark',
    preview: ['#1a1d24', '#23262f', '#2c303b', '#b6ff2e'],
    colors: {
      'bg-base': '#1a1d24',
      'bg-surface': '#23262f',
      'bg-card': '#2c303b',
      'bg-elevated': '#363b48',
      'bg-input': '#15171d',
      'border-subtle': 'rgba(182,255,46,0.06)',
      'border-default': 'rgba(182,255,46,0.10)',
      'border-strong': 'rgba(182,255,46,0.15)',
      'text-primary': '#e9ebee',
      'text-secondary': '#b5b9c3',
      'text-tertiary': '#7a8090',
      'text-disabled': '#494e5b',
      accent: '#b6ff2e',
      'accent-solid': '#8fd214',
      'accent-hover': '#c9ff60',
    },
  },
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
      // Canonical comment #75715e sits at 3.03:1 on bg-surface — nudged +1 L to
      // clear the 3.15 tertiary floor, hue/saturation locked (2026-08).
      'text-tertiary': '#787460',
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
      'text-tertiary': '#6a7281',
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
      'text-tertiary': '#5e6896',
      'text-disabled': '#414868',
      accent: '#7aa2f7',
      'accent-solid': '#3d59a1',
      'accent-hover': '#9eb8fa',
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
    // bg-elevated #0c4351 is invented (the spec stops at base02) and was light enough
    // to drop base1 body text to 4.05:1; darkened to #0b3b48 for 4.53:1. bg-surface
    // (base03), bg-card (base02) and text-primary (base1) are canonical — leave them.
    // Cost: the bg-card -> bg-elevated step is now 2.2 L*, near the shipped floor
    // (lavender-coal 2.0, one-dark-pro 2.4). There is no more headroom on this side.
    id: 'solarized-dark',
    name: 'Better Solarized',
    preview: ['#001a22', '#002b36', '#073642', '#268bd2'],
    colors: {
      'bg-base': '#001a22',
      'bg-surface': '#002b36',
      'bg-card': '#073642',
      'bg-elevated': '#0b3b48',
      'bg-input': '#00161c',
      'border-subtle': 'rgba(147,161,161,0.06)',
      'border-default': 'rgba(147,161,161,0.1)',
      'border-strong': 'rgba(147,161,161,0.15)',
      'text-primary': '#93a1a1',
      'text-secondary': '#839496',
      'text-tertiary': '#60787f',
      'text-disabled': '#3e555c',
      accent: '#268bd2',
      'accent-solid': '#1a6ea3',
      'accent-hover': '#3aa6ed',
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
  {
    // Imperial Violet — in-house duotone (2026-08 owner pair): imperial red
    // #f15153 on deep royal violet #321847 (reference hex at bg-card). Warm
    // coral-red signal over a cool regal canvas.
    id: 'imperial-violet',
    name: 'Imperial Violet',
    preview: ['#1f0e2e', '#29123b', '#321847', '#f15153'],
    colors: {
      'bg-base': '#1f0e2e',
      'bg-surface': '#29123b',
      'bg-card': '#321847',
      'bg-elevated': '#3e2156',
      'bg-input': '#180a24',
      'border-subtle': 'rgba(241,81,83,0.06)',
      'border-default': 'rgba(241,81,83,0.10)',
      'border-strong': 'rgba(241,81,83,0.15)',
      'text-primary': '#f1e9f8',
      'text-secondary': '#c9b6dd',
      'text-tertiary': '#9280a8',
      'text-disabled': '#574768',
      accent: '#f15153',
      'accent-solid': '#d63033',
      'accent-hover': '#f57e7f',
    },
  },
  // ── Purple / Violet / Mauve ──
  {
    id: 'dracula',
    name: 'Dracula',
    preview: ['#21222c', '#282a36', '#343746', '#bd93f9'],
    colors: {
      'bg-base': '#21222c',
      'bg-surface': '#282a36',
      'bg-card': '#343746',
      'bg-elevated': '#3a3f55',
      'bg-input': '#1c1d26',
      'border-subtle': 'rgba(189,147,249,0.06)',
      'border-default': 'rgba(189,147,249,0.1)',
      'border-strong': 'rgba(189,147,249,0.15)',
      'text-primary': '#f8f8f2',
      'text-secondary': '#c8c0d8',
      // Canonical comment #6272a4 sits at 3.03:1 on bg-surface — nudged +2 L to
      // clear the 3.15 tertiary floor, hue/saturation locked (2026-08).
      'text-tertiary': '#6776a7',
      'text-disabled': '#44475a',
      accent: '#bd93f9',
      'accent-solid': '#9570d4',
      'accent-hover': '#d4b8ff',
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
      'accent-solid': '#a173d9',
      'accent-hover': '#d4baf2',
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
      'text-tertiary': '#7e8196',
      'text-disabled': '#acb0be',
      accent: '#8839ef',
      'accent-solid': '#7113ec',
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
      'text-tertiary': '#848d98',
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
    // bg-card / bg-elevated are NOT Solarized: the spec defines only base3 and base2
    // for light backgrounds, so both extra steps were invented here — and they were
    // invented too dark. The old ramp fell 19.4 L* from bg-base to bg-elevated, the
    // steepest of all 14 light presets (the other 13 span 10.4–14.4), which put body
    // text at 4.40:1 on bg-card and 3.65:1 on bg-elevated. Raised to #e4dfd2 / #d9d7cc
    // (5.00:1 / 4.61:1); the steps are now -5.0/-3.1/-3.0 L*, inside the shipped range.
    // Do NOT fix this by darkening text-primary further — it is already off-spec, and
    // the surfaces that fail are the invented ones, not the canonical base3/base2.
    id: 'solarized-light',
    name: 'Solarized Light',
    preview: ['#fdf6e3', '#eee8d5', '#e4dfd2', '#268bd2'],
    colors: {
      'bg-base': '#fdf6e3',
      'bg-surface': '#eee8d5',
      'bg-card': '#e4dfd2',
      'bg-elevated': '#d9d7cc',
      'bg-input': '#ffffff',
      'border-subtle': 'rgba(88,110,117,0.08)',
      'border-default': 'rgba(88,110,117,0.15)',
      'border-strong': 'rgba(88,110,117,0.25)',
      'text-primary': '#4a6066',
      'text-secondary': '#657b83',
      'text-tertiary': '#748585',
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
      'text-tertiary': '#6872a6',
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
      'text-tertiary': '#82868f',
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
    preview: ['#fafafa', '#eeeeee', '#e1e1e2', '#2f8f96'],
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
      'text-tertiary': '#708996',
      'text-disabled': '#b0bec5',
      accent: '#2f8f96',
      'accent-solid': '#1d686f',
      'accent-hover': '#3fb4bd',
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
    // Emerald Ink — in-house duotone (2026-08 owner pair): emerald green ink
    // #064e3b on champagne paper #f8e7c9 (reference hex at bg-base). Luxury-
    // stationery light theme; the whole text ramp is green-tinted so the accent
    // feels native.
    id: 'emerald-ink',
    name: 'Emerald Ink',
    preview: ['#f8e7c9', '#f0dcb7', '#e6cd9d', '#064e3b'],
    colors: {
      'bg-base': '#f8e7c9',
      'bg-surface': '#f0dcb7',
      'bg-card': '#e6cd9d',
      'bg-elevated': '#d8bb82',
      'bg-input': '#fdf3e0',
      'border-subtle': 'rgba(30,58,48,0.09)',
      'border-default': 'rgba(30,58,48,0.17)',
      'border-strong': 'rgba(30,58,48,0.27)',
      'text-primary': '#1e3a30',
      'text-secondary': '#3e5c4e',
      'text-tertiary': '#64806f',
      'text-disabled': '#a9a488',
      accent: '#064e3b',
      'accent-solid': '#053c2d',
      'accent-hover': '#0e6b52',
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
  {
    // Porcelain — in-house duotone (2026-08 owner pair): signal blue #0057ff on
    // warm porcelain white #f8f7f4 (reference hex at bg-base). Swiss-poster
    // light theme: near-black ink, one electric primary.
    id: 'porcelain',
    name: 'Porcelain',
    preview: ['#f8f7f4', '#efede8', '#e3e1da', '#0057ff'],
    colors: {
      'bg-base': '#f8f7f4',
      'bg-surface': '#efede8',
      'bg-card': '#e3e1da',
      'bg-elevated': '#d5d2c8',
      'bg-input': '#ffffff',
      'border-subtle': 'rgba(28,28,30,0.08)',
      'border-default': 'rgba(28,28,30,0.15)',
      'border-strong': 'rgba(28,28,30,0.25)',
      'text-primary': '#1c1c1e',
      'text-secondary': '#4c4c52',
      'text-tertiary': '#71717a',
      'text-disabled': '#ababb2',
      accent: '#0057ff',
      'accent-solid': '#0043c4',
      'accent-hover': '#3377ff',
    },
  },
  {
    // Ultra Apricot — in-house duotone (2026-08 owner pair): ultra violet
    // #6a00f4 on soft apricot #ffd6a5 (reference hex at bg-base). The boldest
    // light canvas in the set; the ink ramp leans deep violet so text and
    // accent share one family.
    id: 'ultra-apricot',
    name: 'Ultra Apricot',
    preview: ['#ffd6a5', '#f9c98e', '#f2ba79', '#6a00f4'],
    colors: {
      'bg-base': '#ffd6a5',
      'bg-surface': '#f9c98e',
      'bg-card': '#f2ba79',
      'bg-elevated': '#e8a962',
      'bg-input': '#ffe7cd',
      'border-subtle': 'rgba(60,29,94,0.10)',
      'border-default': 'rgba(60,29,94,0.18)',
      'border-strong': 'rgba(60,29,94,0.28)',
      'text-primary': '#3c1d5e',
      'text-secondary': '#5f3a85',
      'text-tertiary': '#82589f',
      'text-disabled': '#bb9a79',
      accent: '#6a00f4',
      'accent-solid': '#5500c4',
      'accent-hover': '#8433f6',
    },
  },
  // ── Vivid (high-saturation dark palettes) ──
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
    // Dragonfruit Night — in-house duotone (2026-08 owner pair): dragon-fruit
    // pink #ff4696 on night violet #1e1033 (reference hex at bg-surface).
    // Deeper and bluer than Synthwave '84 with a hotter, redder pink — the
    // flesh-and-rind colours of the actual fruit; text ramp is pink-tinted.
    id: 'dragonfruit-night',
    name: 'Dragonfruit Night',
    preview: ['#150b26', '#1e1033', '#2a1745', '#ff4696'],
    colors: {
      'bg-base': '#150b26',
      'bg-surface': '#1e1033',
      'bg-card': '#2a1745',
      'bg-elevated': '#351e55',
      'bg-input': '#100820',
      'border-subtle': 'rgba(255,70,150,0.07)',
      'border-default': 'rgba(255,70,150,0.12)',
      'border-strong': 'rgba(255,70,150,0.18)',
      'text-primary': '#f6ebf1',
      'text-secondary': '#d4b3c7',
      'text-tertiary': '#9d7595',
      'text-disabled': '#5c3d57',
      accent: '#ff4696',
      'accent-solid': '#d92a7c',
      'accent-hover': '#ff73b1',
    },
  },
  // ── Pastel (soft / low-saturation light palettes) ──
  {
    // Cotton Candy — pink + cyan pastel on cream. Playful, low-contrast soft.
    id: 'cotton-candy',
    name: 'Cotton Candy',
    preview: ['#fdf6f8', '#fae8ed', '#f2d4dd', '#2c8ba9'],
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
      accent: '#2c8ba9',
      'accent-solid': '#255c6c',
      'accent-hover': '#37b2d3',
    },
  },
  {
    // Mint Sorbet — soft mint canvas with lavender accent.
    id: 'mint-sorbet',
    name: 'Mint Sorbet',
    preview: ['#f1faf5', '#e3f3eb', '#d2ebde', '#9470d4'],
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
      'text-tertiary': '#6e8c7c',
      'text-disabled': '#aabbb1',
      accent: '#9470d4',
      'accent-solid': '#7150b3',
      'accent-hover': '#b094df',
    },
  },
  {
    // Peach Fuzz — warm peach + soft coral. Cosy, low-contrast.
    id: 'peach-fuzz',
    name: 'Peach Fuzz',
    preview: ['#fff3ec', '#ffe5d4', '#ffd2b6', '#df502e'],
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
      accent: '#df502e',
      'accent-solid': '#95452f',
      'accent-hover': '#e86c4e',
    },
  },
];

export const DEFAULT_THEME_ID = 'lavender-coal';

// Where each preset retired by the 2026-08 curation lands: its closest surviving
// relative (same hue family / same vibe). Consumed by the v6 migration in
// loadThemeConfig so a stored id keeps resolving to something familiar instead of
// snapping to the default. Custom presets can't collide — their ids are
// 'custom-'-prefixed by makeCustomPresetId.
const REMOVED_THEME_FALLBACKS: Record<string, string> = {
  'carbon': 'lavender-coal',
  'sakura': 'rose-pine',
  'copper': 'gruvbox-dark',
  'amber': 'gruvbox-dark',
  'green-beautiful-2': 'hatsune-miku',
  'green-dark': 'minimal-kiwi',
  'ocean': 'hatsune-miku',
  'ocean-deep': 'tokyo-night',
  'midnight': 'tokyo-night',
  'cursor-dark': 'lavender-coal',
  'github-dark': 'github-dark-default',
  'kanagawa': 'tokyo-night',
  'kanagawa-dragon': 'lavender-coal',
  'catppuccin-frappe': 'catppuccin-mocha',
  'catppuccin-macchiato': 'catppuccin-mocha',
  'violet-dusk': 'dracula',
  'genshin-vibes': 'wuthering-waves',
  'cyberpunk-neon': 'synthwave-84',
  'hotline-miami': 'synthwave-84',
};

// Filterable tags for the Themes tab — every preset is "dark" or "light", plus
// optional style tags (vivid / pastel / monochrome) when those traits dominate.
// Kept as a separate map (not inline on each preset) so adding a new tag dimension
// later is a one-place change.
export type ThemeTag = 'dark' | 'light' | 'vivid' | 'pastel' | 'monochrome';

export const THEME_TAGS: Record<string, ThemeTag[]> = {
  'gruvbox-dark': ['dark', 'vivid'],
  'butter-pine': ['dark'],
  'bumblebee': ['dark', 'vivid'],
  'lime-spark': ['dark', 'vivid'],
  'minimal-kiwi': ['dark', 'monochrome'],
  'monokai': ['dark', 'vivid'],
  'dark-ever': ['dark', 'pastel'],
  'hatsune-miku': ['dark', 'vivid'],
  'nord': ['dark', 'pastel'],
  'one-dark-pro': ['dark'],
  'lavender-coal': ['dark', 'monochrome'],
  'material-theme-darker': ['dark', 'monochrome'],
  'tokyo-night': ['dark'],
  'github-dark-default': ['dark'],
  'solarized-dark': ['dark'],
  'wuthering-waves': ['dark', 'vivid'],
  'crimson-night': ['dark', 'vivid'],
  'imperial-violet': ['dark', 'vivid'],
  'dracula': ['dark', 'vivid'],
  'catppuccin-mocha': ['dark', 'pastel'],
  'rose-pine': ['dark', 'pastel'],
  'catppuccin-latte': ['light', 'pastel'],
  'github-light': ['light'],
  'solarized-light': ['light'],
  'tokyo-night-light': ['light'],
  'atom-one-light': ['light'],
  'material-lighter': ['light'],
  'cream-paper': ['light'],
  'emerald-ink': ['light'],
  'notebook': ['light', 'monochrome'],
  'porcelain': ['light', 'monochrome'],
  'ultra-apricot': ['light', 'vivid'],
  'synthwave-84': ['dark', 'vivid'],
  'dragonfruit-night': ['dark', 'vivid'],
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
  if (color.startsWith('#')) {
    // Normalize to #RRGGBB for <input type="color">: pass #RRGGBB through, expand #RGB
    // shorthand, and drop the alpha from #RRGGBBAA. Malformed lengths fall through below.
    if (color.length === 7) return color;
    if (color.length === 4) return `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`;
    if (color.length === 9) return color.slice(0, 7);
  }
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

/**
 * Text/icon ink for a solid button fill: white or near-black, whichever contrasts
 * more against the fill. Semantic fills (recording red, replay green, clicker
 * purple, accent blue) are user-configurable, so the ink can't be hardcoded —
 * white 13px text on the default replay green computes ≈ 2:1 and is exactly the
 * kind of pairing this exists to prevent.
 */
export function pickInk(fillHex: string): string {
  return contrastRatio('#ffffff', fillHex) >= contrastRatio('#1c1c1c', fillHex)
    ? '#ffffff'
    : '#1c1c1c';
}

/** True for the colour strings toHex can actually parse. Anything else toHex silently maps to
 *  #000000, which would make a contrast derivation solve against black on a white surface. */
function isParsableColor(c: unknown): c is string {
  if (typeof c !== 'string') return false;
  if (c.startsWith('#')) return c.length === 4 || c.length === 7 || c.length === 9;
  return /rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/.test(c);
}

/**
 * Ink for warning TEXT, icons and hairlines, derived per theme.
 *
 * Three things make this different from adaptHueForInk, and each one was a measured bug first:
 *
 * 1. It solves against EVERY surface the token is painted on, not one. Contrast against the raw
 *    hue is V-shaped in luminance (minimum near L≈0.59), not monotone, so "the darkest surface"
 *    and "the surface with least contrast against the text" both pick the wrong one on some
 *    presets — solarized-light's hardest surface is bg-card, not bg-elevated.
 * 2. It includes the TINTED composites. Every consumer sits on a surface plus a translucent amber
 *    wash (8% for .warning-band, 6% for the incompatible card), and that wash drags the backdrop
 *    toward the hue's own luminance, which always costs contrast. Solving against the bare surface
 *    landed three light presets and nord below the target they were solved for. 0% and 8% bracket
 *    the 6% case, so checking those two per surface covers all of them.
 * 3. When nothing clears it returns the BEST candidate rather than text-primary. adaptHueForInk's
 *    last-resort assumption ("clears by construction") is false for solarized-light, whose own
 *    text is 3.65:1 on its own bg-elevated — a pre-existing palette defect this cannot repair.
 *    On the shipped presets this is a no-op worth having rather than an improvement: measured,
 *    solarized-light is the only preset that reaches the branch, and there the argmax candidate
 *    IS text-primary, so the returned value is identical either way. It earns its keep only for
 *    an authored theme whose text happens not to be the best available ink.
 *
 * Target is 4.5 because every consumer is 10–12px body text. That is deliberately NOT
 * adaptHueForInk's default of 3, and must not be pushed back into it: 4.5 guts the hue, which is
 * the documented reason 3 was chosen for recording/replay/clicker.
 */
export function deriveHueInk(
  hueHex: string,
  textPrimary: string,
  surfaces: unknown[],
  target = 4.5,
  maxTint = 0.08,
  staticFallbackMix = 40,
): string {
  const usable = surfaces.filter(isParsableColor).map(toHex);
  // No surface we can reason about: keep the static index.css recipe rather than inventing one.
  if (usable.length === 0 || !isParsableColor(textPrimary)) {
    // The hue passes through as authored rather than being swapped for amber when it is not a
    // hex we can parse: color-mix() accepts named colours and hsl() perfectly well, and painting
    // a recording indicator amber because its colour was spelled "red" would be a worse answer
    // than either the real hue or a dropped declaration. A genuinely malformed value makes the
    // whole declaration invalid, which is the loud failure and the one we want here.
    const fallbackHue = typeof hueHex === 'string' && hueHex.trim() ? hueHex : '#FFC107';
    return `color-mix(in srgb, ${fallbackHue} ${staticFallbackMix}%, ${isParsableColor(textPrimary) ? textPrimary : 'currentColor'})`;
  }
  const hue = hexToRGB(toHex(hueHex));
  const text = hexToRGB(toHex(textPrimary));
  const backdrops: string[] = [];
  for (const s of usable) {
    backdrops.push(s);
    const b = hexToRGB(s);
    backdrops.push(rgbToHex(       // the heaviest shipped wash of this hue, composited
      hue.r * maxTint + b.r * (1 - maxTint),
      hue.g * maxTint + b.g * (1 - maxTint),
      hue.b * maxTint + b.b * (1 - maxTint),
    ));
  }
  let best = toHex(textPrimary);
  let bestWorst = -1;
  for (let keep = 100; keep >= 0; keep -= 5) {
    const p = keep / 100;
    const candidate = rgbToHex(
      hue.r * p + text.r * (1 - p),
      hue.g * p + text.g * (1 - p),
      hue.b * p + text.b * (1 - p),
    );
    let worst = Infinity;
    for (const bg of backdrops) worst = Math.min(worst, contrastRatio(candidate, bg));
    if (worst >= target) return candidate;          // first step that clears everywhere
    if (worst > bestWorst) { bestWorst = worst; best = candidate; }
  }
  return best;
}

/** Warning amber at the constants it was solved and measured against: 8% is the heaviest wash
 *  `.warning-band` paints, and 40% is the static recipe index.css falls back to before hydration. */
export function deriveWarningInk(textPrimary: string, surfaces: unknown[], target = 4.5): string {
  return deriveHueInk('#FFC107', textPrimary, surfaces, target, 0.08, 40);
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
        version: CURRENT_THEME_CONFIG_VERSION,
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

      // v3 → v4 migration: PixelColor lime darkened (#84cc16 → #65a30d) for
      // deuteranopia lightness separation from Replay green — see the
      // DEFAULT_UI_SETTINGS comment. Same only-if-still-default pattern.
      if (parsed.version < 4) {
        const ui = merged.uiSettings;
        if (ui.actionPixelColorColor === '#84cc16') ui.actionPixelColorColor = DEFAULT_UI_SETTINGS.actionPixelColorColor;
      }

      // v4 → v5 migration: default zoom 95 % → 90 %. Unlike the colour migrations above this
      // one is NOT optional cosmetics — a saved config always carries a zoom, so the spread
      // over DEFAULT_UI_SETTINGS keeps the old 95 forever and the new default would only ever
      // reach fresh installs. Same only-if-still-the-old-default rule, for the same reason:
      // anyone who deliberately picked 120 % or 80 % keeps it.
      if (parsed.version < 5) {
        const ui = merged.uiSettings;
        if (ui.zoom === 95) ui.zoom = DEFAULT_UI_SETTINGS.zoom;
      }

      // v5 → v6 migration: the 2026-08 curation retired 19 dark presets. A stored
      // id pointing at one of them is remapped to its closest surviving relative
      // (REMOVED_THEME_FALLBACKS) so the user's aesthetic carries over instead of
      // falling through to themes[0]. Unlike the colour migrations above this one
      // is unconditional — a removed id has nothing to stay faithful to. Covers
      // the active theme and both matchSystemTheme slots.
      if (parsed.version < 6) {
        const ui = merged.uiSettings;
        merged.baseThemeId = REMOVED_THEME_FALLBACKS[merged.baseThemeId] ?? merged.baseThemeId;
        ui.darkPresetId = REMOVED_THEME_FALLBACKS[ui.darkPresetId] ?? ui.darkPresetId;
        ui.lightPresetId = REMOVED_THEME_FALLBACKS[ui.lightPresetId] ?? ui.lightPresetId;
      }

      return merged;
    }
  } catch {
    // Not JSON — old format (plain theme ID string). Run it through the removed-id
    // map too so an ancient install lands on a surviving relative.
    const legacyId = REMOVED_THEME_FALLBACKS[raw] ?? raw;
    if (getThemeById(legacyId)) {
      return { version: CURRENT_THEME_CONFIG_VERSION, baseThemeId: legacyId, colorOverrides: {}, uiSettings: { ...DEFAULT_UI_SETTINGS } };
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
  return {
    version: CURRENT_THEME_CONFIG_VERSION,
    baseThemeId: DEFAULT_THEME_ID,
    colorOverrides: {},
    uiSettings: {
      ...DEFAULT_UI_SETTINGS,
      // First run only (no stored config): seed the Animations toggle from the
      // OS reduced-motion preference. A stored config always wins — the user
      // can flip it back on in the Theme Editor at any time.
      enableAnimations: typeof window !== 'undefined'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? false
        : DEFAULT_UI_SETTINGS.enableAnimations,
    },
  };
}

// ── Theme Resolution ──

export function resolveThemeColors(config: ThemeConfig, customPresets: ThemePreset[] = []): ThemeColors {
  // Custom presets take precedence over built-in ids — the user might intentionally
  // override a built-in name. In practice ids should never collide thanks to the
  // 'custom-' prefix from makeCustomPresetId, but the lookup order keeps user wins.
  // An id that resolves to nothing (corrupt storage, deleted custom preset) lands on
  // the DEFAULT theme, not themes[0] — array order is hue-sorted, so slot 0 is an
  // arbitrary palette, not a neutral one.
  const base = customPresets.find(t => t.id === config.baseThemeId)
    ?? getThemeById(config.baseThemeId)
    ?? getThemeById(DEFAULT_THEME_ID)
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
  // INK variants of the three semantic hues, adapted per theme. The raw tokens above stay the
  // user's literal choice and go on FILLS; anything painting the hue as text, an icon or a
  // hairline uses these instead, or it disappears on the 14 light presets.
  //
  // Target stays 3 — these are glyphs and boundaries, and 4.5 was measured to gut the hue
  // (light retention 42% average, 10% minimum) for no gain on shapes.
  //
  // But the SURFACE set is no longer just bg-surface, and that was a real bug: these tokens are
  // painted on bg-base (StatusBar), bg-surface (ActionBar), bg-card (grid rows) and bg-elevated
  // (dialogs, toasts), plus the 10–12% hue washes under them. Solved against bg-surface alone,
  // the token was BELOW ITS OWN 3:1 floor on 16/37 presets for recording (worst 1.90,
  // solarized-light), 14/37 for replay and 16/37 for clicker — including two dark presets
  // (nord 2.41, catppuccin-mocha 2.90). A user-picked hue close to their background made it
  // worse: 16 of 30 hostile cases failed. Solving across all four surfaces and their 12%
  // composites clears 37/37 and 30/30. maxTint 0.12 is the heaviest wash shipped
  // (--color-clicker-bg above) — if a rule ever paints these over a heavier one, raise it here
  // or the solve goes silently stale.
  //
  // Cost, and it is visible: light-preset hue retention drops ~26pp (recording 76.8→51.1,
  // replay 58.9→40.4, clicker 72.1→48.6). Dark is essentially untouched (100→98.3/100/98.7).
  const SURFACES = [colors['bg-surface'], colors['bg-card'], colors['bg-elevated'], colors['bg-base']];
  const ink = colors['text-primary'];
  parts.push(`--color-recording-fg: ${deriveHueInk(uiSettings.recordingColor, ink, SURFACES, 3, 0.12, 72)};`);
  parts.push(`--color-replay-fg: ${deriveHueInk(uiSettings.replayColor, ink, SURFACES, 3, 0.12, 72)};`);
  const clickerFg = deriveHueInk(uiSettings.clickerColor, ink, SURFACES, 3, 0.12, 72);
  parts.push(`--color-clicker-fg: ${clickerFg};`);
  // The Clicker pill's border is a hairline on the bar, so it rides the adapted
  // hue too — at 30% of the raw purple it was 1.2:1 against a light bar.
  parts.push(`--color-clicker-border: color-mix(in srgb, ${clickerFg} 30%, transparent);`);
  // Warning ink — same idea as the three hues above, but solved across ALL the surfaces it can
  // land on and against their tinted composites; see deriveWarningInk for why one surface is not
  // enough. Missing or unparsable palette keys are filtered there, so a custom preset without a
  // bg-card can no longer take the whole theme apply down with it.
  //
  // The static color-mix in index.css is now only the pre-hydration fallback. Measured on the
  // real elements: that fixed 40% recipe gave 13 of the 14 light presets under 4.5:1
  // (solarized-light 1.98) and solarized-dark 4.43.
  //
  // Dark presets are NOT untouched, and it would be wrong to say so: the old 40% mix was a pale
  // amber with lots of headroom, and returning the raw hue trades some of that away (worst
  // measured after this change: nord). All stay above the floor, but the direction is a real
  // cost, not a null result.
  parts.push(`--color-warning-ink: ${deriveWarningInk(ink, [
    colors['bg-surface'], colors['bg-card'], colors['bg-elevated'],
  ])};`);
  // Ink for solid semantic fills (Recording/Replay/Clicker buttons + accent "Stop"
  // state) — contrast-picked per fill so no user color choice can produce the old
  // white-on-mid-green ≈ 2:1 pairing.
  parts.push(`--color-recording-ink: ${pickInk(uiSettings.recordingColor)};`);
  parts.push(`--color-replay-ink: ${pickInk(uiSettings.replayColor)};`);
  parts.push(`--color-clicker-ink: ${pickInk(uiSettings.clickerColor)};`);
  const accentInk = pickInk(colors['accent-solid']);
  parts.push(`--color-accent-ink: ${accentInk};`);
  // Hover fill for solid accent buttons — shifts AWAY from the ink (dark ink →
  // lighter fill, white ink → darker fill) so hovering never erodes the
  // contrast pickInk just guaranteed. Replaces alpha-hover (/80), whose blend
  // with the backdrop could swing either way.
  parts.push(`--color-accent-solid-hover: color-mix(in srgb, ${colors['accent-solid']} 85%, ${accentInk === '#ffffff' ? '#000000' : '#ffffff'});`);
  // Action type pill colors — the stored hue is treated as the action's identity,
  // not its literal ink: fg mixes the hue toward text-primary (dark themes ≈ the
  // original pastel; light themes automatically darken toward the near-black
  // text-primary instead of washing out), bg tints the hue over bg-surface so the
  // chip stays visible on any preset. Same recipe as the index.css fallbacks.
  const actionHues: [string, string][] = [
    ['mouse', uiSettings.actionMouseColor],
    ['key', uiSettings.actionKeyColor],
    ['scroll', uiSettings.actionScrollColor],
    ['sendtext', uiSettings.actionSendTextColor],
    ['setvariable', uiSettings.actionSetVariableColor ?? DEFAULT_UI_SETTINGS.actionSetVariableColor],
    ['waitimage', uiSettings.actionWaitImageColor],
    ['pixelcolor', uiSettings.actionPixelColorColor],
    ['browser', uiSettings.actionBrowserColor],
    ['runprofile', uiSettings.actionRunProfileColor],
    ['pause', uiSettings.actionPauseColor],
    ['if', uiSettings.actionIfColor],
  ];
  for (const [key, hue] of actionHues) {
    parts.push(`--color-action-${key}-fg: color-mix(in srgb, ${hue} 72%, ${colors['text-primary']});`);
    // bg stays TRANSLUCENT (mixed over transparent, not bg-surface): pills must
    // composite over row hover/selection/highlight/block washes and the drag
    // ghost — an opaque fill punches a hole through all of them. The light-theme
    // legibility win lives in the fg recipe above.
    parts.push(`--color-action-${key}-bg: color-mix(in srgb, ${hue} 12%, transparent);`);
  }
  // Tinted border for the conditional block scope rail — keeps the RAW hue (35%
  // alpha): rails are structural, not text, and want the pure identity color.
  parts.push(`--color-action-if-border: color-mix(in srgb, ${uiSettings.actionIfColor} 35%, transparent);`);
  // Font
  parts.push(`--font-mono: '${uiSettings.fontMono}', 'Courier New', monospace;`);
  // The zoom as a NUMBER, mirroring root.style.zoom below. `zoom` on <html> scales
  // everything it paints, but viewport units still resolve against the UNZOOMED viewport —
  // so `height: 100vh` paints at only `100vh * zoom` and can never fill the window (at the
  // default 90 % it tops out at 90 % of it, and at zoom 200 % it would paint at DOUBLE the
  // window height and clip). Anything that wants a real fraction of the visible window has
  // to divide the viewport unit by this: `calc(90vh / var(--ui-zoom))`. Kept in sync here
  // rather than read back off the element so it can't drift.
  parts.push(`--ui-zoom: ${uiSettings.zoom / 100};`);

  root.style.cssText = parts.join(' ');

  // `zoom` doesn't sit cleanly in the cssText batch because it's a real CSS
  // property (not a custom var). Set it separately — a single property assign
  // still benefits from coming after the variable batch so the browser only
  // composes one final layout. Same reasoning for the data-attribute.
  root.style.zoom = `${uiSettings.zoom / 100}`;

  // Native controls (the <input type="time"> picker glyph, date pickers, scrollbars)
  // render their built-in icons per `color-scheme`. Without this the time-picker clock
  // icon stays a dark UA glyph — invisible on a dark theme (Automation → Schedule, the
  // If-Time condition). Derive it from the background luminance so the glyphs track
  // whatever preset is active: dark bg → light glyphs, light bg → dark glyphs. Set after
  // the cssText batch (which replaces the whole inline style), same as zoom above.
  let bgLum = 0;
  try { bgLum = relativeLuminance(colors['bg-base']); } catch { bgLum = 0; }
  root.style.colorScheme = bgLum < 0.5 ? 'dark' : 'light';

  // Animations toggle — exposes a single data-attribute the CSS can hook into
  // (e.g. `html[data-animations="true"] .some-thing { transition: ... }`).
  root.setAttribute('data-animations', uiSettings.enableAnimations ? 'true' : 'false');
}

// ── Import/Export ──

// Accepts only strings safe to interpolate into a CSS value: hex / rgb()/rgba() / hsl()/hsla()
// / named colors. Rejects characters that could break out of the declaration (`;` `{` `}` `:`),
// which is the CSS-injection vector when an imported theme's color flows into root.style.cssText.
function isSafeCssColor(v: unknown): boolean {
  return typeof v === 'string' && v.length > 0 && v.length <= 64 && /^[#0-9a-zA-Z.,%()/\s-]+$/.test(v);
}

// Font-family token interpolated as `'${fontMono}', ...` — letters/digits/space/_/- only, so a
// quote / `;` / `{}` can't escape the rule.
function isSafeFontFamily(v: unknown): boolean {
  return typeof v === 'string' && v.length > 0 && v.length <= 64 && /^[a-zA-Z0-9 _-]+$/.test(v);
}

export function validateExportedTheme(data: unknown): data is ExportedTheme {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  if (d.version !== 1 || typeof d.name !== 'string') return false;
  if (!d.colors || typeof d.colors !== 'object') return false;
  const colors = d.colors as Record<string, unknown>;
  for (const key of THEME_COLOR_KEYS) {
    // Must be a safe CSS color, not merely a string — these flow verbatim into
    // root.style.cssText in applyThemeConfig, so an unvalidated value is a CSS-injection vector.
    if (!isSafeCssColor(colors[key])) return false;
  }
  if (!d.uiSettings || typeof d.uiSettings !== 'object') return false;
  const ui = d.uiSettings as Record<string, unknown>;
  // Bounds-check (not just type-check) — these feed CSS sizing, so reject NaN/Infinity/negative/
  // absurd values. Ranges are intentionally wide so any reasonable hand-made theme still imports.
  if (typeof ui.fontSize !== 'number' || !(ui.fontSize >= 6 && ui.fontSize <= 48)) return false;
  if (typeof ui.borderRadius !== 'number' || !(ui.borderRadius >= 0 && ui.borderRadius <= 64)) return false;
  if (typeof ui.rowHeight !== 'number' || !(ui.rowHeight >= 12 && ui.rowHeight <= 120)) return false;
  if (ui.zoom !== undefined && !(typeof ui.zoom === 'number' && ui.zoom >= 25 && ui.zoom <= 500)) return false;
  // uiSettings color fields are interpolated into cssText (incl. color-mix) — when present they
  // must be safe colors. Missing fields are tolerated (merged over DEFAULT_UI_SETTINGS on import).
  const UI_COLOR_FIELDS = [
    'recordingColor', 'replayColor', 'clickerColor', 'actionMouseColor', 'actionKeyColor',
    'actionScrollColor', 'actionSendTextColor', 'actionWaitImageColor', 'actionPixelColorColor',
    'actionBrowserColor', 'actionRunProfileColor', 'actionPauseColor', 'actionIfColor',
    'actionSetVariableColor',
  ];
  for (const f of UI_COLOR_FIELDS) {
    if (ui[f] !== undefined && !isSafeCssColor(ui[f])) return false;
  }
  if (ui.fontMono !== undefined && !isSafeFontFamily(ui.fontMono)) return false;
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
