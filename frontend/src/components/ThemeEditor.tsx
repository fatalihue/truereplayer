import { useEffect, useRef, useState, useCallback } from 'react';
import { X, Check, RotateCcw, Download, Upload, Clipboard, ClipboardPaste, Pipette, ChevronDown, ChevronRight, Dices, LayoutGrid, Droplets, SlidersHorizontal, FileJson2 } from 'lucide-react';
import { NumberInput } from './common/NumberInput';
import { Toggle } from './common/Toggle';
import {
  themes,
  DEFAULT_UI_SETTINGS,
  toHex,
  withOriginalAlpha,
  validateExportedTheme,
  getThemeTags,
  hexToHSL,
  hslToHex,
  contrastRatio,
} from '../themes';
import type { ThemeColors, ExportedTheme, ThemeTag, CustomThemePreset } from '../themes';
import { useTheme } from '../state/ThemeContext';

interface ThemeEditorProps {
  onClose: () => void;
}

type TabId = 'presets' | 'colors' | 'appearance' | 'import-export';

const TABS: { id: TabId; label: string; icon: React.ElementType }[] = [
  { id: 'presets', label: 'Presets', icon: LayoutGrid },
  { id: 'colors', label: 'Colors', icon: Droplets },
  { id: 'appearance', label: 'Appearance', icon: SlidersHorizontal },
  { id: 'import-export', label: 'Import / Export', icon: FileJson2 },
];

// Single source for the small uppercase group label every tab uses — the tabs
// had drifted across three slightly different font-size/tracking combos.
function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-semibold text-text-disabled tracking-wider mb-1.5">
      {children}
    </div>
  );
}

// ── Color Section Groupings ──

const COLOR_SECTIONS: { title: string; keys: (keyof ThemeColors)[] }[] = [
  { title: 'Backgrounds', keys: ['bg-base', 'bg-surface', 'bg-card', 'bg-elevated', 'bg-input'] },
  { title: 'Borders', keys: ['border-subtle', 'border-default', 'border-strong'] },
  { title: 'Text', keys: ['text-primary', 'text-secondary', 'text-tertiary', 'text-disabled'] },
  { title: 'Accent', keys: ['accent', 'accent-solid', 'accent-hover'] },
];

const COLOR_LABELS: Record<keyof ThemeColors, string> = {
  'bg-base': 'Base',
  'bg-surface': 'Surface',
  'bg-card': 'Card',
  'bg-elevated': 'Elevated',
  'bg-input': 'Input',
  'border-subtle': 'Subtle',
  'border-default': 'Default',
  'border-strong': 'Strong',
  'text-primary': 'Primary',
  'text-secondary': 'Secondary',
  'text-tertiary': 'Tertiary',
  'text-disabled': 'Disabled',
  accent: 'Accent',
  'accent-solid': 'Solid',
  'accent-hover': 'Hover',
};

// ── Eyedropper helper ──

// Picks a color anywhere on screen using the EyeDropper API (Chromium 95+).
// Returns the sRGBHex string or null if unsupported or cancelled. Available in
// WebView2 since it ships with Chromium; pre-2021 builds fall through to null.
async function pickFromScreen(): Promise<string | null> {
  const Ctor = (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
  if (!Ctor) return null;
  try {
    const result = await new Ctor().open();
    return result.sRGBHex;
  } catch {
    return null;
  }
}

// ── Reusable Color Row ──

function ColorRow({ label, colorKey, value, baseValue, mode, contrastBg, onChange, onReset }: {
  label: string;
  colorKey: keyof ThemeColors;
  value: string;
  baseValue: string;
  mode: 'hex' | 'hsl';
  /** When set, show a small WCAG contrast chip comparing this color against the bg. */
  contrastBg?: string;
  onChange: (key: keyof ThemeColors, value: string) => void;
  onReset: (key: keyof ThemeColors) => void;
}) {
  const isOverridden = value !== baseValue;
  const hexValue = toHex(value);
  const hasEyedropper = typeof (window as unknown as { EyeDropper?: unknown }).EyeDropper !== 'undefined';

  // WCAG contrast chip — only displayed for keys with a meaningful bg reference
  // (text-* keys against bg-surface). Threshold mirrors WCAG 2.1 AA body text.
  const ratio = contrastBg ? contrastRatio(hexValue, contrastBg) : null;

  return (
    <div className="py-0.5 group">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 w-[90px]">
          {isOverridden && <div className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
          <span className={`text-xs ${isOverridden ? 'text-text-primary' : 'text-text-secondary'}`}>{label}</span>
        </div>

        <label className="relative w-6 h-6 rounded border border-border-default cursor-pointer shrink-0 overflow-hidden">
          <div className="absolute inset-0" style={{ backgroundColor: value }} />
          <input
            type="color"
            value={hexValue}
            onChange={(e) => {
              const newHex = e.target.value;
              onChange(colorKey, withOriginalAlpha(newHex, value));
            }}
            className="absolute inset-0 opacity-0 cursor-pointer"
          />
        </label>

        <input
          type="text"
          value={hexValue}
          onChange={(e) => {
            const v = e.target.value;
            if (/^#[0-9a-fA-F]{6}$/.test(v)) {
              onChange(colorKey, withOriginalAlpha(v, value));
            }
          }}
          className="w-[80px] h-6 px-2 text-xs font-mono text-text-primary bg-bg-input border border-border-default rounded text-center outline-none focus:border-accent-solid"
        />

        {hasEyedropper && (
          <button
            onClick={async () => {
              const picked = await pickFromScreen();
              if (picked) onChange(colorKey, withOriginalAlpha(picked, value));
            }}
            className="p-0.5 rounded text-text-disabled hover:text-accent hover:bg-bg-elevated transition-colors"
            title="Pick color from screen"
          >
            <Pipette size={12} />
          </button>
        )}

        {ratio !== null && (() => {
          // WCAG 2.1 AA: 4.5 for body text, 3.0 for large text / graphics. Below 3
          // is hard to read at any size. Three buckets keep the chip glanceable.
          const tone =
            ratio < 3 ? { bg: 'bg-recording/15', fg: 'text-recording', border: 'border-recording/40', icon: '⚠' }
            : ratio < 4.5 ? { bg: 'bg-yellow-500/10', fg: 'text-yellow-400', border: 'border-yellow-500/30', icon: '⚠' }
            : { bg: 'bg-replay/15', fg: 'text-replay', border: 'border-replay/40', icon: '✓' };
          return (
            <span
              className={`px-1.5 py-px text-[9px] font-mono rounded border ${tone.bg} ${tone.fg} ${tone.border}`}
              title={`Contrast ratio ${ratio.toFixed(1)}:1 — WCAG AA wants 4.5+ for body text`}
            >
              {tone.icon} {ratio.toFixed(1)}
            </span>
          );
        })()}

        <button
          onClick={() => onReset(colorKey)}
          className={`p-0.5 rounded text-text-disabled hover:text-text-primary hover:bg-bg-elevated transition-colors ${isOverridden ? 'visible' : 'invisible'}`}
          title="Reset to base"
        >
          <RotateCcw size={12} />
        </button>
      </div>

      {mode === 'hsl' && (() => {
        const hsl = hexToHSL(hexValue);
        const updateHSL = (h: number, s: number, l: number) => {
          const newHex = hslToHex(h, s, l);
          onChange(colorKey, withOriginalAlpha(newHex, value));
        };
        return (
          <div className="ml-[98px] mt-1 mb-1 pl-2 border-l border-border-subtle space-y-1">
            <HSLSlider label="H" max={360} value={Math.round(hsl.h)} unit="°" gradient="linear-gradient(to right, hsl(0,80%,50%), hsl(60,80%,50%), hsl(120,80%,50%), hsl(180,80%,50%), hsl(240,80%,50%), hsl(300,80%,50%), hsl(360,80%,50%))" onChange={(v) => updateHSL(v, hsl.s, hsl.l)} />
            <HSLSlider label="S" max={100} value={Math.round(hsl.s)} unit="%" gradient={`linear-gradient(to right, hsl(${hsl.h},0%,${hsl.l}%), hsl(${hsl.h},100%,${hsl.l}%))`} onChange={(v) => updateHSL(hsl.h, v, hsl.l)} />
            <HSLSlider label="L" max={100} value={Math.round(hsl.l)} unit="%" gradient={`linear-gradient(to right, hsl(${hsl.h},${hsl.s}%,0%), hsl(${hsl.h},${hsl.s}%,50%), hsl(${hsl.h},${hsl.s}%,100%))`} onChange={(v) => updateHSL(hsl.h, hsl.s, v)} />
          </div>
        );
      })()}
    </div>
  );
}

function HSLSlider({ label, value, max, unit, gradient, onChange }: {
  label: string;
  value: number;
  max: number;
  unit: string;
  gradient: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-[10px] text-text-tertiary w-3">{label}</span>
      <div className="flex-1 relative h-3 rounded" style={{ background: gradient }}>
        <input
          type="range"
          min={0}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        />
        <div
          className="absolute top-1/2 w-2.5 h-2.5 rounded-full bg-white border border-black/40 pointer-events-none"
          style={{ left: `${(value / max) * 100}%`, transform: 'translate(-50%, -50%)' }}
        />
      </div>
      <span className="font-mono text-[10px] text-text-tertiary w-7 text-right">{value}{unit}</span>
    </div>
  );
}

// ── Slider + Input ──

function SliderSetting({ label, value, min, max, unit, defaultValue, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  defaultValue?: number;
  onChange: (v: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const hovering = useRef(false);
  const latestValue = useRef(value);
  latestValue.current = value;
  // Keep the latest onChange in a ref so the wheel effect doesn't re-subscribe on
  // every render (onChange is an inline arrow recreated by the parent each render).
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!hovering.current) return;
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY < 0 ? 1 : -1;
      const next = Math.min(max, Math.max(min, latestValue.current + delta));
      if (next !== latestValue.current) onChangeRef.current(next);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [min, max]);

  // Position of the default-value tick along the range (0..100%). Only rendered when
  // defaultValue is supplied and strictly inside the [min, max] interval (so edge
  // values don't put the tick under the thumb at min/max position).
  const defaultPct = defaultValue !== undefined && defaultValue > min && defaultValue < max
    ? ((defaultValue - min) / (max - min)) * 100
    : null;

  return (
    <div ref={containerRef} className="flex items-center gap-3 py-1" onMouseEnter={() => { hovering.current = true; }} onMouseLeave={() => { hovering.current = false; }}>
      <span className="text-xs text-text-secondary w-[100px]">{label}</span>
      <div className="flex-1 relative">
        <input
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full h-1.5 accent-accent-solid"
        />
        {defaultPct !== null && (
          <div
            className="absolute pointer-events-none"
            style={{ left: `${defaultPct}%`, top: '50%', transform: 'translate(-50%, -50%)' }}
            title={`Default: ${defaultValue}${unit}`}
          >
            <div className="w-0.5 h-2.5 bg-text-tertiary/60" />
          </div>
        )}
      </div>
      <NumberInput
        value={value}
        onChange={onChange}
        min={min}
        max={max}
        suffix={unit}
        inputHeight="h-7"
        ariaLabel="Value"
      />
    </div>
  );
}

// ── Compact Color Picker for Appearance tab ──

const MONO_FONTS = [
  'Consolas',
  'Cascadia Mono',
  'Cascadia Code',
  'Courier New',
  'Lucida Console',
];

function AppearanceColorRow({ label, value, defaultValue, onChange }: {
  label: string;
  value: string;
  defaultValue: string;
  onChange: (v: string) => void;
}) {
  const isCustom = value !== defaultValue;
  return (
    <div className="flex items-center gap-2 py-0.5 group">
      <div className="flex items-center gap-1.5 w-[100px]">
        {isCustom && <div className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
        <span className={`text-xs ${isCustom ? 'text-text-primary' : 'text-text-secondary'}`}>{label}</span>
      </div>
      <label className="relative w-6 h-6 rounded border border-border-default cursor-pointer shrink-0 overflow-hidden">
        <div className="absolute inset-0" style={{ backgroundColor: value }} />
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 opacity-0 cursor-pointer"
        />
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => {
          if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) onChange(e.target.value);
        }}
        className="w-[80px] h-6 px-2 text-xs font-mono text-text-primary bg-bg-input border border-border-default rounded text-center outline-none focus:border-accent-solid"
      />
      <button
        onClick={() => onChange(defaultValue)}
        className={`p-0.5 rounded text-text-disabled hover:text-text-primary hover:bg-bg-elevated transition-colors ${isCustom ? 'visible' : 'invisible'}`}
        title="Reset to default"
      >
        <RotateCcw size={12} />
      </button>
    </div>
  );
}

// ── Main ThemeEditor ──

export function ThemeEditor({ onClose }: ThemeEditorProps) {
  const {
    config, resolvedColors, customPresets, selectPreset,
    setColorOverride, clearColorOverride, clearAllOverrides,
    setAccentColor, setUISetting, resetUISettings,
    exportTheme, importTheme,
    saveAsPreset, deleteCustomPreset,
  } = useTheme();

  const panelRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<TabId>('presets');
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState('');
  const [copySuccess, setCopySuccess] = useState(false);
  const [copyError, setCopyError] = useState(false);
  // Transient index of the recent-color swatch just copied, for a per-swatch tick.
  const [copiedRecent, setCopiedRecent] = useState<number | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  // Preset tab — search + filter chip state. Persists across tab switches as long
  // as the editor stays open.
  const [presetSearch, setPresetSearch] = useState('');
  const [presetFilter, setPresetFilter] = useState<'all' | ThemeTag>('all');
  const [savePresetName, setSavePresetName] = useState('');
  // Import/Export tab — name embedded in the exported JSON (was hardcoded 'My Theme').
  const [exportName, setExportName] = useState('My Theme');
  // Colors tab — Hex vs HSL picker mode and a transient palette of recently-used colors.
  // Recent colors do not persist across editor opens; they're a within-session
  // affordance for reusing the same color across multiple slots.
  const [colorMode, setColorMode] = useState<'hex' | 'hsl'>('hex');
  const [recentColors, setRecentColors] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Wraps setColorOverride to also push the chosen color onto the recent strip.
  // Dedups (case-insensitive) and caps at 8 entries.
  const trackedSetColorOverride = useCallback((key: keyof ThemeColors, val: string) => {
    setColorOverride(key, val);
    const hex = toHex(val).toLowerCase();
    setRecentColors(prev => {
      const filtered = prev.filter(c => c.toLowerCase() !== hex);
      return [hex, ...filtered].slice(0, 8);
    });
  }, [setColorOverride]);

  const hasOverrides = Object.keys(config.colorOverrides).length > 0;

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Close on click outside (but not on title bar controls like maximize/restore)
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        // Ignore clicks on window title bar area (top 32px)
        if (e.clientY < 40) return;
        onClose();
      }
    };
    const timer = setTimeout(() => {
      window.addEventListener('mousedown', handleClick);
    }, 50);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('mousedown', handleClick);
    };
  }, [onClose]);

  // Get base preset colors for comparison
  const basePreset = themes.find(t => t.id === config.baseThemeId) ?? themes[0];

  // Toggle collapsible section
  const toggleSection = useCallback((title: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      return next;
    });
  }, []);

  // ── Export handlers ──

  const handleExportFile = useCallback(() => {
    const name = exportName.trim() || 'My Theme';
    const theme = exportTheme(name);
    const blob = new Blob([JSON.stringify(theme, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    // Filename derived from the theme name so multiple exports don't collide.
    a.download = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'theme'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [exportTheme, exportName]);

  const handleCopyClipboard = useCallback(async () => {
    const theme = exportTheme(exportName.trim() || 'My Theme');
    try {
      await navigator.clipboard.writeText(JSON.stringify(theme, null, 2));
      setCopyError(false);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch {
      setCopySuccess(false);
      setCopyError(true);
      setTimeout(() => setCopyError(false), 2000);
    }
  }, [exportTheme, exportName]);

  // ── Import handlers ──

  const doImport = useCallback((json: string) => {
    setImportError('');
    try {
      const parsed = JSON.parse(json);
      if (!validateExportedTheme(parsed)) {
        setImportError('Invalid theme format. Check all required color keys and UI settings.');
        return;
      }
      if (!importTheme(parsed as ExportedTheme)) {
        setImportError('Invalid theme format. Check all required color keys and UI settings.');
        return;
      }
      setImportText('');
      setActiveTab('presets');
    } catch {
      setImportError('Invalid JSON. Please check the format.');
    }
  }, [importTheme]);

  const handleImportFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => doImport(reader.result as string);
    reader.onerror = () => setImportError('Could not read the selected file.');
    reader.readAsText(file);
    e.target.value = '';
  }, [doImport]);

  const handlePasteClipboard = useCallback(async () => {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      setImportError('Could not read from clipboard. Check clipboard permissions or paste the JSON manually.');
      return;
    }
    setImportText(text);
    doImport(text);
  }, [doImport]);

  // Accent color derived from resolved
  const currentAccentHex = toHex(resolvedColors.accent);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      {/* 2-column grid: editor body on the left, persistent Live Preview on the right.
          Header and Tabs span both columns; body+footer share the left column;
          the preview pane spans the body+footer rows on the right. */}
      {/* Fixed 1000×660 — matches TrueReplayer's 1180×780 launch size with ~90 px
          horizontal and ~60 px vertical backdrop showing through. No 95vh that
          ballooned on tall displays. Preview pane stays at 340 px (was 360). */}
      <div
        ref={panelRef}
        className="w-[1000px] h-[660px] bg-bg-surface border border-border-default rounded-lg shadow-2xl overflow-hidden grid grid-cols-[1fr_340px] grid-rows-[auto_auto_1fr_auto]"
      >
        {/* Header — spans both columns */}
        <div className="col-span-2 flex items-center justify-between px-5 py-3.5 border-b border-border-subtle">
          <span className="text-sm font-semibold text-text-primary">Theme Editor</span>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Tabs — spans both columns */}
        <div className="col-span-2 flex border-b border-border-subtle">
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors ${
                activeTab === tab.id
                  ? 'text-accent border-b-2 border-accent'
                  : 'text-text-tertiary hover:text-text-primary border-b-2 border-transparent'
              }`}
            >
              <tab.icon size={13} />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content — left column. Border-r separates it from the Live Preview pane. */}
        <div className="overflow-y-auto border-r border-border-subtle min-w-0">

          {/* ═══ Tab 1: Presets ═══ */}
          {activeTab === 'presets' && (() => {
            const filterChips: { id: 'all' | ThemeTag; label: string }[] = [
              { id: 'all', label: 'All' },
              { id: 'dark', label: 'Dark' },
              { id: 'light', label: 'Light' },
              { id: 'vivid', label: 'Vivid' },
              { id: 'pastel', label: 'Pastel' },
              { id: 'monochrome', label: 'Monochrome' },
            ];
            const q = presetSearch.trim().toLowerCase();
            const matchesFilter = (id: string) => {
              if (presetFilter === 'all') return true;
              return getThemeTags(id).includes(presetFilter);
            };
            const matchesSearch = (name: string) => q.length === 0 || name.toLowerCase().includes(q);
            const builtinList = themes.filter(t => matchesFilter(t.id) && matchesSearch(t.name));
            const customList = customPresets.filter(t => matchesSearch(t.name));
            // Custom presets aren't tagged by THEME_TAGS — show them only when filter is 'all'
            // or 'dark'/'light' inferred from their bg-base luminance.
            const filteredCustom = customList.filter(p => {
              if (presetFilter === 'all') return true;
              if (presetFilter === 'dark' || presetFilter === 'light') {
                // Quick luminance check on bg-base
                const hex = p.colors['bg-base'].replace('#', '');
                if (hex.length < 6) return presetFilter === 'dark';
                const r = parseInt(hex.substring(0, 2), 16);
                const g = parseInt(hex.substring(2, 4), 16);
                const b = parseInt(hex.substring(4, 6), 16);
                const lum = (r * 299 + g * 587 + b * 114) / 1000;
                return (lum > 128) === (presetFilter === 'light');
              }
              return false;
            });

            const renderCard = (theme: typeof themes[0] | CustomThemePreset) => {
              const isActive = theme.id === config.baseThemeId && !hasOverrides;
              const isCustom = '__custom' in theme;
              return (
                <div key={theme.id} className="group/card relative">
                  <button
                    onClick={() => selectPreset(theme.id)}
                    className={`w-full flex flex-col rounded-lg overflow-hidden border transition-all cursor-pointer ${
                      isActive
                        ? 'border-accent ring-1 ring-accent/30'
                        : 'border-border-subtle hover:border-border-strong'
                    }`}
                  >
                    <div className="flex h-12">
                      {theme.preview.map((color, i) => (
                        <div key={i} className="flex-1" style={{ backgroundColor: color }} />
                      ))}
                    </div>
                    <div
                      className="flex items-center justify-between px-2.5 py-2"
                      style={{ backgroundColor: theme.colors['bg-card'] }}
                    >
                      <span
                        className="text-xs font-medium truncate"
                        style={{ color: theme.colors['text-secondary'] }}
                      >
                        {theme.name}
                      </span>
                      {isActive && <Check size={12} style={{ color: theme.colors.accent }} />}
                    </div>
                  </button>
                  {isCustom && (
                    <button
                      onClick={(e) => { e.stopPropagation(); deleteCustomPreset(theme.id); }}
                      className="absolute top-1 right-1 w-5 h-5 rounded bg-bg-base/80 text-text-tertiary hover:text-recording opacity-0 group-hover/card:opacity-100 transition-opacity flex items-center justify-center"
                      title="Delete this custom preset"
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
              );
            };

            return (
              <div className="p-4 space-y-3">
                {/* Search + filter chips */}
                <div className="relative">
                  <input
                    type="text"
                    value={presetSearch}
                    onChange={(e) => setPresetSearch(e.target.value)}
                    placeholder="Search themes…"
                    className="w-full h-7 pl-2.5 pr-7 text-xs text-text-primary bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid"
                  />
                  {presetSearch && (
                    <button
                      onClick={() => setPresetSearch('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary"
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
                <div className="flex gap-1 flex-wrap items-center">
                  {filterChips.map(chip => (
                    <button
                      key={chip.id}
                      onClick={() => setPresetFilter(chip.id)}
                      className={`px-2.5 py-0.5 text-[10px] rounded-full border transition-colors ${
                        presetFilter === chip.id
                          ? 'bg-accent-solid/15 border-accent-solid/40 text-accent'
                          : 'bg-transparent border-border-default text-text-tertiary hover:text-text-secondary'
                      }`}
                    >
                      {chip.label}
                    </button>
                  ))}
                  {/* Random preset within the current filter — discovery shortcut for users
                      browsing palettes. Excludes the currently active one so a click is
                      always a visible change. Falls back to any preset when the filter is
                      empty (shouldn't happen since builtinList is non-empty when shown). */}
                  {(() => {
                    // Disable when the filter has nothing to pick from OR the only item
                    // in it is already active (a click would be a no-op + confuse).
                    const pool = builtinList.filter(t => t.id !== config.baseThemeId);
                    const noPick = pool.length === 0;
                    return (
                      <button
                        onClick={() => {
                          if (pool.length === 0) return;
                          selectPreset(pool[Math.floor(Math.random() * pool.length)].id);
                        }}
                        disabled={noPick}
                        className="ml-auto flex items-center gap-1 px-2.5 py-0.5 text-[10px] rounded-full border border-border-default text-text-tertiary hover:text-text-primary hover:border-accent-solid/40 hover:bg-bg-elevated disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        title={noPick ? 'No other presets in this filter' : 'Pick a random preset from the current filter'}
                      >
                        <Dices size={11} />
                        Surprise me
                      </button>
                    );
                  })()}
                </div>

                {/* Built-in presets */}
                {builtinList.length === 0 && filteredCustom.length === 0 ? (
                  <div className="text-xs text-text-tertiary text-center py-6">No themes match your search.</div>
                ) : (
                  <div className="grid grid-cols-4 gap-3">
                    {builtinList.map(renderCard)}
                  </div>
                )}

                {/* Custom presets section */}
                {filteredCustom.length > 0 && (
                  <>
                    <div className="text-[10px] font-semibold text-text-disabled tracking-wider pt-1">My Themes</div>
                    <div className="grid grid-cols-4 gap-3">
                      {filteredCustom.map(renderCard)}
                    </div>
                  </>
                )}

                {/* Save as preset — only when the user has overrides on top of a preset
                    (otherwise "saving" a built-in unchanged is just a duplicate). */}
                {hasOverrides && (
                  <div className="flex items-center gap-2 px-3 py-2 bg-bg-card border border-dashed border-border-default rounded">
                    <input
                      type="text"
                      value={savePresetName}
                      onChange={(e) => setSavePresetName(e.target.value)}
                      placeholder="Name your customization…"
                      className="flex-1 h-6 px-2 text-xs text-text-primary bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && savePresetName.trim()) {
                          saveAsPreset(savePresetName.trim());
                          setSavePresetName('');
                        }
                      }}
                    />
                    <button
                      onClick={() => {
                        if (!savePresetName.trim()) return;
                        saveAsPreset(savePresetName.trim());
                        setSavePresetName('');
                      }}
                      disabled={!savePresetName.trim()}
                      className="px-2.5 py-1 text-[11px] text-white bg-accent-solid rounded disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      + Save as preset
                    </button>
                  </div>
                )}

                {/* Quick Accent Picker */}
                <div className="flex items-center gap-3 pt-1">
                  <span className="text-xs text-text-secondary">Accent Color</span>
                  <label className="relative w-8 h-8 rounded-md border border-border-default cursor-pointer overflow-hidden">
                    <div className="absolute inset-0" style={{ backgroundColor: currentAccentHex }} />
                    <input
                      type="color"
                      value={currentAccentHex}
                      onChange={(e) => setAccentColor(e.target.value)}
                      className="absolute inset-0 opacity-0 cursor-pointer"
                    />
                  </label>
                  <span className="text-xs font-mono text-text-tertiary">{currentAccentHex}</span>

                  {hasOverrides && (
                    <button
                      onClick={clearAllOverrides}
                      className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded text-xs text-text-secondary hover:text-text-primary bg-bg-elevated hover:bg-bg-card border border-border-subtle transition-colors"
                    >
                      <RotateCcw size={12} />
                      Reset customizations
                    </button>
                  )}
                </div>
              </div>
            );
          })()}

          {/* ═══ Tab 2: Colors ═══ */}
          {activeTab === 'colors' && (
            <div className="p-4 space-y-2">
              {/* Hex/HSL toggle — global across all color sections. HSL is much better for
                  fine-tuning lightness or saturation while locking hue. */}
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] font-semibold text-text-disabled tracking-wider">Picker Mode</span>
                <div className="flex gap-1">
                  <button
                    onClick={() => setColorMode('hex')}
                    className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
                      colorMode === 'hex'
                        ? 'bg-accent-solid/15 text-accent border border-accent-solid/40'
                        : 'text-text-tertiary border border-border-default hover:text-text-secondary'
                    }`}
                  >Hex</button>
                  <button
                    onClick={() => setColorMode('hsl')}
                    className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
                      colorMode === 'hsl'
                        ? 'bg-accent-solid/15 text-accent border border-accent-solid/40'
                        : 'text-text-tertiary border border-border-default hover:text-text-secondary'
                    }`}
                  >HSL</button>
                </div>
              </div>

              {COLOR_SECTIONS.map(section => {
                const isCollapsed = collapsedSections.has(section.title);
                const overriddenCount = section.keys.filter(k => k in config.colorOverrides).length;
                return (
                  <div key={section.title} className="border border-border-subtle rounded-md overflow-hidden">
                    <button
                      onClick={() => toggleSection(section.title)}
                      className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-bg-card transition-colors"
                    >
                      {isCollapsed
                        ? <ChevronRight size={12} className="text-text-tertiary shrink-0" />
                        : <ChevronDown size={12} className="text-text-tertiary shrink-0" />}
                      <span className="text-xs font-semibold text-text-primary">{section.title}</span>
                      {overriddenCount > 0 && (
                        <span className="px-1.5 py-px rounded-full text-[9px] font-medium bg-accent-solid/15 text-accent border border-accent-solid/30">
                          {overriddenCount} modified
                        </span>
                      )}
                      {/* Swatch strip — the section's current colors at a glance, most
                          useful while the section is collapsed. */}
                      <span className="ml-auto flex gap-0.5">
                        {section.keys.map(k => (
                          <span
                            key={k}
                            className="w-3 h-3 rounded-sm border border-border-default"
                            style={{ backgroundColor: resolvedColors[k] }}
                          />
                        ))}
                      </span>
                    </button>
                    {!isCollapsed && (
                      <div className="px-3 pb-1.5">
                        {section.keys.map(key => (
                          <ColorRow
                            key={key}
                            label={COLOR_LABELS[key]}
                            colorKey={key}
                            value={resolvedColors[key]}
                            baseValue={basePreset.colors[key]}
                            mode={colorMode}
                            // Contrast chip only for Text section — that's where WCAG body-text
                            // thresholds apply. Background/border colors don't have a single
                            // canonical "what is the foreground?" answer.
                            contrastBg={section.title === 'Text' ? resolvedColors['bg-surface'] : undefined}
                            onChange={trackedSetColorOverride}
                            onReset={clearColorOverride}
                          />
                        ))}
                        {section.title === 'Accent' && (
                          <button
                            onClick={() => setAccentColor(currentAccentHex)}
                            className="mt-1 text-[11px] text-accent hover:text-accent-hover transition-colors"
                          >
                            Auto-derive solid & hover from accent
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Recent colors — transient strip showing the last few chosen hex values
                  so the user can paint several slots with the same color quickly. */}
              {recentColors.length > 0 && (
                <div className="flex items-center gap-1.5 px-1 pt-1">
                  <span className="text-[10px] font-semibold text-text-disabled tracking-wider">RECENT</span>
                  <div className="flex gap-1">
                    {recentColors.map((c, i) => (
                      <button
                        key={i}
                        onClick={async () => {
                          // Copy the hex to clipboard so the user can paste into any field.
                          // Better than auto-applying because we don't know which slot to set.
                          try {
                            await navigator.clipboard?.writeText(c);
                            setCopiedRecent(i);
                            setTimeout(() => setCopiedRecent(prev => (prev === i ? null : prev)), 1200);
                          } catch {
                            /* clipboard unavailable — swatch stays unchanged */
                          }
                        }}
                        className="w-4 h-4 rounded border border-border-default hover:scale-110 transition-transform flex items-center justify-center"
                        style={{ backgroundColor: c }}
                        title={copiedRecent === i ? `${c} — copied!` : `${c} — click to copy`}
                      >
                        {copiedRecent === i && <Check size={9} className="text-white drop-shadow-[0_0_1px_rgba(0,0,0,0.8)]" />}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Reset moved to the fixed footer below — single source for "undo everything"
                  so the user doesn't have to remember which Reset belongs to which tab. */}
            </div>
          )}

          {/* ═══ Tab 3: Appearance ═══ */}
          {activeTab === 'appearance' && (
            <div className="p-4 space-y-4">
              {/* Density presets — apply a coordinated bundle (fontSize + rowHeight + borderRadius)
                  rather than asking the user to dial each slider individually. The fine-tune
                  sliders below remain for users who want to drift away from a preset. */}
              <div>
                <GroupLabel>Density</GroupLabel>
                {(() => {
                  const DENSITY_PRESETS = [
                    { id: 'compact', name: 'Compact', fontSize: 12, rowHeight: 28, borderRadius: 2 },
                    { id: 'normal', name: 'Normal', fontSize: 13, rowHeight: 34, borderRadius: 3 },
                    { id: 'spacious', name: 'Spacious', fontSize: 14, rowHeight: 42, borderRadius: 4 },
                  ];
                  // Match a preset only when ALL three sliders match — drifting any of them
                  // de-selects to avoid a misleading "active" highlight.
                  const activePreset = DENSITY_PRESETS.find(p =>
                    p.fontSize === config.uiSettings.fontSize &&
                    p.rowHeight === config.uiSettings.rowHeight &&
                    p.borderRadius === config.uiSettings.borderRadius
                  );
                  return (
                    <div className="grid grid-cols-3 gap-2">
                      {DENSITY_PRESETS.map(p => {
                        const isActive = activePreset?.id === p.id;
                        const lineCount = p.id === 'compact' ? 4 : p.id === 'normal' ? 3 : 2;
                        const lineHeight = p.id === 'compact' ? 2 : p.id === 'normal' ? 3 : 5;
                        return (
                          <button
                            key={p.id}
                            onClick={() => {
                              setUISetting('fontSize', p.fontSize);
                              setUISetting('rowHeight', p.rowHeight);
                              setUISetting('borderRadius', p.borderRadius);
                            }}
                            className={`flex flex-col items-stretch gap-1.5 px-2 py-2 rounded border transition-colors ${
                              isActive
                                ? 'border-accent bg-accent-solid/8'
                                : 'border-border-default bg-bg-card hover:bg-bg-elevated'
                            }`}
                          >
                            <span className={`text-[11px] font-medium ${isActive ? 'text-accent' : 'text-text-primary'}`}>
                              {p.name}
                            </span>
                            <div className="flex flex-col gap-px">
                              {Array.from({ length: lineCount }).map((_, i) => (
                                <div key={i} style={{ height: lineHeight }} className="bg-text-disabled/50 rounded-sm" />
                              ))}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>

              {/* Layout fine-tuners */}
              <div>
                <GroupLabel>Fine-tune</GroupLabel>
                <SliderSetting
                  label="Font Size"
                  value={config.uiSettings.fontSize}
                  min={10}
                  max={18}
                  unit="px"
                  defaultValue={DEFAULT_UI_SETTINGS.fontSize}
                  onChange={(v) => setUISetting('fontSize', v)}
                />
                <SliderSetting
                  label="Border Radius"
                  value={config.uiSettings.borderRadius}
                  min={0}
                  max={16}
                  unit="px"
                  defaultValue={DEFAULT_UI_SETTINGS.borderRadius}
                  onChange={(v) => setUISetting('borderRadius', v)}
                />
                <SliderSetting
                  label="Row Height"
                  value={config.uiSettings.rowHeight}
                  min={28}
                  max={48}
                  unit="px"
                  defaultValue={DEFAULT_UI_SETTINGS.rowHeight}
                  onChange={(v) => setUISetting('rowHeight', v)}
                />
                <SliderSetting
                  label="Zoom"
                  value={config.uiSettings.zoom}
                  min={50}
                  max={200}
                  unit="%"
                  defaultValue={DEFAULT_UI_SETTINGS.zoom}
                  onChange={(v) => setUISetting('zoom', v)}
                />
              </div>

              {/* Semantic Colors — 2-col grid halves the vertical footprint of what
                  used to be a long single-column list. */}
              <div>
                <GroupLabel>Semantic Colors</GroupLabel>
                <div className="grid grid-cols-2 gap-x-4">
                <AppearanceColorRow
                  label="Recording"
                  value={config.uiSettings.recordingColor}
                  defaultValue={DEFAULT_UI_SETTINGS.recordingColor}
                  onChange={(v) => setUISetting('recordingColor', v)}
                />
                <AppearanceColorRow
                  label="Replay"
                  value={config.uiSettings.replayColor}
                  defaultValue={DEFAULT_UI_SETTINGS.replayColor}
                  onChange={(v) => setUISetting('replayColor', v)}
                />
                <AppearanceColorRow
                  label="Clicker"
                  value={config.uiSettings.clickerColor}
                  defaultValue={DEFAULT_UI_SETTINGS.clickerColor}
                  onChange={(v) => setUISetting('clickerColor', v)}
                />
                </div>
              </div>

              {/* Action Type Colors */}
              <div>
                <GroupLabel>Action Types</GroupLabel>
                <div className="grid grid-cols-2 gap-x-4">
                <AppearanceColorRow
                  label="Mouse"
                  value={config.uiSettings.actionMouseColor}
                  defaultValue={DEFAULT_UI_SETTINGS.actionMouseColor}
                  onChange={(v) => setUISetting('actionMouseColor', v)}
                />
                <AppearanceColorRow
                  label="Key"
                  value={config.uiSettings.actionKeyColor}
                  defaultValue={DEFAULT_UI_SETTINGS.actionKeyColor}
                  onChange={(v) => setUISetting('actionKeyColor', v)}
                />
                <AppearanceColorRow
                  label="Scroll"
                  value={config.uiSettings.actionScrollColor}
                  defaultValue={DEFAULT_UI_SETTINGS.actionScrollColor}
                  onChange={(v) => setUISetting('actionScrollColor', v)}
                />
                <AppearanceColorRow
                  label="Send Text"
                  value={config.uiSettings.actionSendTextColor}
                  defaultValue={DEFAULT_UI_SETTINGS.actionSendTextColor}
                  onChange={(v) => setUISetting('actionSendTextColor', v)}
                />
                <AppearanceColorRow
                  label="Wait Image"
                  value={config.uiSettings.actionWaitImageColor}
                  defaultValue={DEFAULT_UI_SETTINGS.actionWaitImageColor}
                  onChange={(v) => setUISetting('actionWaitImageColor', v)}
                />
                <AppearanceColorRow
                  label="Pixel Color"
                  value={config.uiSettings.actionPixelColorColor}
                  defaultValue={DEFAULT_UI_SETTINGS.actionPixelColorColor}
                  onChange={(v) => setUISetting('actionPixelColorColor', v)}
                />
                <AppearanceColorRow
                  label="Browser"
                  value={config.uiSettings.actionBrowserColor}
                  defaultValue={DEFAULT_UI_SETTINGS.actionBrowserColor}
                  onChange={(v) => setUISetting('actionBrowserColor', v)}
                />
                <AppearanceColorRow
                  label="Run Profile"
                  value={config.uiSettings.actionRunProfileColor}
                  defaultValue={DEFAULT_UI_SETTINGS.actionRunProfileColor}
                  onChange={(v) => setUISetting('actionRunProfileColor', v)}
                />
                <AppearanceColorRow
                  label="Pause"
                  value={config.uiSettings.actionPauseColor}
                  defaultValue={DEFAULT_UI_SETTINGS.actionPauseColor}
                  onChange={(v) => setUISetting('actionPauseColor', v)}
                />
                <AppearanceColorRow
                  label="Conditional"
                  value={config.uiSettings.actionIfColor}
                  defaultValue={DEFAULT_UI_SETTINGS.actionIfColor}
                  onChange={(v) => setUISetting('actionIfColor', v)}
                />
                </div>
              </div>

              {/* Font */}
              <div>
                <GroupLabel>Font</GroupLabel>
                <div className="flex items-center gap-2 py-0.5">
                  <span className="text-xs text-text-secondary w-[100px]">Monospace</span>
                  <select
                    value={MONO_FONTS.includes(config.uiSettings.fontMono) ? config.uiSettings.fontMono : '__custom'}
                    onChange={(e) => {
                      if (e.target.value !== '__custom') setUISetting('fontMono', e.target.value);
                    }}
                    className="flex-1 h-7 px-2 text-xs text-text-primary bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid cursor-pointer"
                  >
                    {MONO_FONTS.map(f => (
                      <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>
                    ))}
                    {!MONO_FONTS.includes(config.uiSettings.fontMono) && (
                      <option value="__custom">{config.uiSettings.fontMono}</option>
                    )}
                  </select>
                  <span
                    className="text-xs font-mono text-text-tertiary truncate w-[80px] text-center"
                    style={{ fontFamily: `'${config.uiSettings.fontMono}', monospace` }}
                  >
                    Abc 123
                  </span>
                </div>
              </div>

              {/* System */}
              <div>
                <GroupLabel>System</GroupLabel>
                <div className="flex items-center justify-between py-1.5">
                  <div className="flex flex-col">
                    <span className="text-xs text-text-secondary">Match Windows theme</span>
                    <span className="text-[10px] text-text-tertiary">Auto-switch dark / light when the OS does</span>
                  </div>
                  <Toggle
                    isOn={config.uiSettings.matchSystemTheme}
                    onChange={(v) => setUISetting('matchSystemTheme', v)}
                  />
                </div>

                {config.uiSettings.matchSystemTheme && (
                  <div className="ml-3 pl-3 border-l border-border-subtle space-y-1.5 py-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-text-tertiary w-[100px]">Dark preset</span>
                      <select
                        value={config.uiSettings.darkPresetId}
                        onChange={(e) => setUISetting('darkPresetId', e.target.value)}
                        className="flex-1 h-6 px-2 text-[11px] text-text-primary bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid cursor-pointer"
                      >
                        {themes.filter(t => !getThemeTags(t.id).includes('light')).map(t => (
                          <option key={t.id} value={t.id}>{t.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-text-tertiary w-[100px]">Light preset</span>
                      <select
                        value={config.uiSettings.lightPresetId}
                        onChange={(e) => setUISetting('lightPresetId', e.target.value)}
                        className="flex-1 h-6 px-2 text-[11px] text-text-primary bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid cursor-pointer"
                      >
                        {themes.filter(t => getThemeTags(t.id).includes('light')).map(t => (
                          <option key={t.id} value={t.id}>{t.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between py-1.5">
                  <div className="flex flex-col">
                    <span className="text-xs text-text-secondary">Enable animations</span>
                    <span className="text-[10px] text-text-tertiary">Theme switch transitions and hover effects</span>
                  </div>
                  <Toggle
                    isOn={config.uiSettings.enableAnimations}
                    onChange={(v) => setUISetting('enableAnimations', v)}
                  />
                </div>
              </div>

              {/* Reset moved to the fixed footer — same rationale as the Colors tab. */}
            </div>
          )}

          {/* ═══ Tab 4: Import / Export ═══ */}
          {activeTab === 'import-export' && (
            <div className="p-4 space-y-5">
              {/* Export */}
              <div>
                <GroupLabel>Export current theme</GroupLabel>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs text-text-secondary w-[60px]">Name</span>
                  <input
                    type="text"
                    value={exportName}
                    onChange={(e) => setExportName(e.target.value)}
                    placeholder="My Theme"
                    className="flex-1 max-w-[260px] h-7 px-2 text-xs text-text-primary bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleExportFile}
                    className="flex items-center gap-1.5 px-3 py-2 rounded text-xs text-text-primary bg-bg-elevated hover:bg-bg-card border border-border-subtle transition-colors"
                  >
                    <Download size={13} />
                    Export to File
                  </button>
                  <button
                    onClick={handleCopyClipboard}
                    className="flex items-center gap-1.5 px-3 py-2 rounded text-xs text-text-primary bg-bg-elevated hover:bg-bg-card border border-border-subtle transition-colors"
                  >
                    <Clipboard size={13} />
                    {copyError ? 'Copy failed' : copySuccess ? 'Copied!' : 'Copy to Clipboard'}
                  </button>
                </div>
                <p className="mt-2 text-[10px] text-text-tertiary">
                  Bundles the base preset, your color overrides and every appearance setting into a single JSON.
                </p>
              </div>

              {/* Import */}
              <div>
                <GroupLabel>Import a theme</GroupLabel>
                <div className="flex gap-2 mb-3">
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="flex items-center gap-1.5 px-3 py-2 rounded text-xs text-text-primary bg-bg-elevated hover:bg-bg-card border border-border-subtle transition-colors"
                  >
                    <Upload size={13} />
                    Import from File
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json"
                    onChange={handleImportFile}
                    className="hidden"
                  />
                  <button
                    onClick={handlePasteClipboard}
                    className="flex items-center gap-1.5 px-3 py-2 rounded text-xs text-text-primary bg-bg-elevated hover:bg-bg-card border border-border-subtle transition-colors"
                  >
                    <ClipboardPaste size={13} />
                    Paste from Clipboard
                  </button>
                </div>
                <textarea
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  placeholder="Paste theme JSON here..."
                  className="w-full h-24 px-3 py-2 text-xs font-mono text-text-primary bg-bg-input border border-border-default rounded resize-none outline-none focus:border-accent-solid"
                />
                {importText && (
                  <button
                    onClick={() => doImport(importText)}
                    className="mt-2 px-3 py-1.5 rounded text-xs text-white bg-accent-solid hover:bg-accent-solid/80 transition-colors"
                  >
                    Apply Theme
                  </button>
                )}
                {importError && (
                  <p className="mt-2 text-xs text-recording">{importError}</p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Fixed footer — single home for the "undo everything" / "export current" /
            "close" actions. Sits in the left column (under the body), so the right-side
            Live Preview pane spans the full body+footer height. */}
        <div className="border-t border-r border-border-subtle bg-bg-card px-4 py-2 flex items-center gap-2">
          <button
            onClick={() => { clearAllOverrides(); resetUISettings(); }}
            disabled={!hasOverrides && JSON.stringify(config.uiSettings) === JSON.stringify(DEFAULT_UI_SETTINGS)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] text-text-secondary hover:text-text-primary bg-bg-elevated hover:bg-bg-surface border border-border-subtle transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title="Clear color overrides and reset all UI settings to defaults"
          >
            <RotateCcw size={11} />
            Reset all
          </button>
          <button
            onClick={handleExportFile}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] text-text-secondary hover:text-text-primary bg-bg-elevated hover:bg-bg-surface border border-border-subtle transition-colors"
            title="Save the current theme as a JSON file"
          >
            <Download size={11} />
            Export
          </button>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="px-3 py-1 rounded text-[11px] text-white bg-accent-solid hover:bg-accent-solid/85 transition-colors"
          >
            Done
          </button>
        </div>

        {/* Live Preview — a MINIATURE OF THE APP rather than a flat list of chips.
            Title bar, toolbar, action grid, action bar and status bar are framed as
            a tiny window so every color shows in the context it actually appears in:
            zebra striping, the selected row, a conditional block (structural tint +
            body wash + rails), all 10 action pill tones, the hotkey chip, the
            semantic buttons and the text hierarchy. Reads the same CSS vars the real
            app does, so it updates live from any tab — including --ui-row-height
            (mini rows scale at 60%) and --ui-border-radius.

            Content is non-interactive (pointer-events: none on buttons/inputs):
            everything inside is mock. */}
        <div className="col-start-2 row-start-3 row-span-2 bg-bg-base p-3 flex flex-col gap-2 select-none overflow-hidden [&_button]:pointer-events-none [&_input]:pointer-events-none">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold text-text-tertiary tracking-wider">Live Preview</span>
            <span className="text-[9px] text-text-disabled">updates as you edit</span>
          </div>

          {/* ── Mini app window ── */}
          <div
            className="flex flex-col border border-border-default overflow-hidden shadow-lg"
            style={{ borderRadius: 'calc(var(--ui-border-radius) + 4px)' }}
          >
            {/* Title bar */}
            <div className="flex items-center gap-1.5 px-2.5 h-8 bg-bg-base border-b border-border-subtle shrink-0">
              <span className="w-3.5 h-3.5 rounded bg-accent-solid flex items-center justify-center text-[8px] font-bold text-white">T</span>
              <span className="text-[10px] text-text-secondary">TrueReplayer</span>
              <span className="flex-1" />
              <span
                className="inline-flex items-center gap-1 px-1.5 py-px rounded-full text-[9px] border"
                style={{
                  background: 'var(--color-replay-bg)',
                  color: 'var(--color-replay)',
                  borderColor: 'color-mix(in srgb, var(--color-replay) 25%, transparent)',
                }}
              >
                <span className="w-1 h-1 rounded-full" style={{ background: 'var(--color-replay)' }} />
                Ready
              </span>
            </div>

            {/* Toolbar */}
            <div className="flex items-center gap-1.5 px-2.5 h-8 bg-bg-surface border-b border-border-subtle shrink-0">
              <span className="text-[10px] font-medium text-text-primary truncate">My Macro</span>
              <span
                className="px-1.5 py-px rounded font-mono text-[8px] border"
                style={{
                  background: 'var(--color-hotkey-bg)',
                  color: 'var(--color-hotkey-fg)',
                  borderColor: 'var(--color-hotkey-border)',
                }}
              >F8</span>
              <span className="flex-1" />
              <button className="px-2 py-0.5 text-[9px] text-white bg-accent-solid" style={{ borderRadius: 'var(--ui-border-radius)' }}>Save</button>
              <button className="px-2 py-0.5 text-[9px] text-text-secondary bg-bg-elevated border border-border-default" style={{ borderRadius: 'var(--ui-border-radius)' }}>Load</button>
            </div>

            {/* Grid header */}
            <div className="grid grid-cols-[16px_68px_1fr_34px] gap-1.5 items-center px-2 h-5 bg-bg-surface border-b border-border-subtle shrink-0">
              <span />
              <span className="text-[8px] font-semibold text-text-tertiary">Action</span>
              <span className="text-[8px] font-semibold text-text-tertiary">Details</span>
              <span className="text-[8px] font-semibold text-text-tertiary">Delay</span>
            </div>

            {/* Rows — real grid semantics: zebra / selected / structural / in-block */}
            {(() => {
              const evenBg = 'var(--color-bg-surface)';
              const oddBg = 'color-mix(in srgb, var(--color-text-primary) 1.5%, transparent)';
              const selectedBg = 'color-mix(in srgb, var(--color-accent) 8%, transparent)';
              const structuralBg = 'color-mix(in srgb, var(--color-action-if-fg) 6%, transparent)';
              const inBlockBg = 'color-mix(in srgb, var(--color-action-if-fg) 3%, transparent)';
              const rows: { n: number; pill: string; label: string; delay: string; tone: [string, string]; bg: string; rail?: 'strong' | 'thin'; selected?: boolean }[] = [
                { n: 1, pill: 'KeyDown', label: 'Ctrl+S', delay: '50', tone: ['--color-action-key-bg', '--color-action-key-fg'], bg: evenBg },
                { n: 2, pill: 'LeftClick', label: '1742, 388', delay: '120', tone: ['--color-action-mouse-bg', '--color-action-mouse-fg'], bg: selectedBg, selected: true },
                { n: 3, pill: 'ScrollUp', label: '×3', delay: '80', tone: ['--color-action-scroll-bg', '--color-action-scroll-fg'], bg: oddBg },
                { n: 4, pill: 'SendText', label: '"Hello {date}"', delay: '200', tone: ['--color-action-sendtext-bg', '--color-action-sendtext-fg'], bg: evenBg },
                { n: 5, pill: 'if image', label: 'btn-ok.png', delay: '—', tone: ['--color-action-if-bg', '--color-action-if-fg'], bg: structuralBg, rail: 'strong' },
                { n: 6, pill: 'WaitImage', label: 'btn-ok.png', delay: '—', tone: ['--color-action-waitimage-bg', '--color-action-waitimage-fg'], bg: inBlockBg, rail: 'thin' },
                { n: 7, pill: 'BrowserClick', label: 'button.submit', delay: '100', tone: ['--color-action-browser-bg', '--color-action-browser-fg'], bg: inBlockBg, rail: 'thin' },
                { n: 8, pill: 'endif', label: '', delay: '—', tone: ['--color-action-if-bg', '--color-action-if-fg'], bg: structuralBg, rail: 'strong' },
                { n: 9, pill: 'PixelColor', label: '#ff8800', delay: '—', tone: ['--color-action-pixelcolor-bg', '--color-action-pixelcolor-fg'], bg: oddBg },
                { n: 10, pill: 'Pause', label: 'until F9', delay: '—', tone: ['--color-action-pause-bg', '--color-action-pause-fg'], bg: evenBg },
                { n: 11, pill: 'RunProfile', label: 'Sub-flow ×2', delay: '—', tone: ['--color-action-runprofile-bg', '--color-action-runprofile-fg'], bg: oddBg },
              ];
              return (
                <div className="flex flex-col bg-bg-surface">
                  {rows.map(row => (
                    <div
                      key={row.n}
                      className="relative grid grid-cols-[16px_68px_1fr_34px] gap-1.5 items-center px-2 border-b border-border-subtle"
                      style={{
                        // Mini rows track the Row Height slider at 60% scale, so the
                        // Appearance tab's density changes are visible right here.
                        height: 'calc(var(--ui-row-height) * 0.6)',
                        background: row.bg,
                        boxShadow: row.selected
                          ? 'inset 2px 0 0 var(--color-accent)'
                          : row.rail
                            ? `inset 2px 0 0 ${row.rail === 'strong' ? 'var(--color-action-if-fg)' : 'var(--color-action-if-border)'}`
                            : undefined,
                      }}
                    >
                      <span className="font-mono text-[8px] text-text-disabled text-right">{row.n}</span>
                      <span
                        className="px-1 py-px rounded font-mono text-[8px] text-center truncate border"
                        style={{
                          background: `var(${row.tone[0]})`,
                          color: `var(${row.tone[1]})`,
                          borderColor: `color-mix(in srgb, var(${row.tone[1]}) 30%, transparent)`,
                        }}
                      >{row.pill}</span>
                      <span className="text-[9px] text-text-secondary truncate">{row.label}</span>
                      <span className={`font-mono text-[8px] ${row.delay === '—' ? 'text-text-disabled' : 'text-text-secondary'}`}>{row.delay}</span>
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* Action bar */}
            <div className="flex items-center gap-1.5 px-2.5 h-9 bg-bg-surface border-t border-border-subtle shrink-0">
              <button
                className="px-2 py-0.5 text-[9px] border"
                style={{
                  borderRadius: 'var(--ui-border-radius)',
                  background: 'var(--color-recording-bg)',
                  color: 'var(--color-recording)',
                  borderColor: 'color-mix(in srgb, var(--color-recording) 30%, transparent)',
                }}
              >● Recording</button>
              <button
                className="px-2 py-0.5 text-[9px] border"
                style={{
                  borderRadius: 'var(--ui-border-radius)',
                  background: 'var(--color-replay-bg)',
                  color: 'var(--color-replay)',
                  borderColor: 'color-mix(in srgb, var(--color-replay) 30%, transparent)',
                }}
              >▶ Replay</button>
              <span className="flex-1" />
              <button
                className="px-2 py-0.5 text-[9px] border"
                style={{
                  borderRadius: 'var(--ui-border-radius)',
                  background: 'var(--color-clicker-bg)',
                  color: 'var(--color-clicker)',
                  borderColor: 'var(--color-clicker-border)',
                }}
              >Clicker</button>
            </div>

            {/* Status bar */}
            <div className="flex items-center gap-1 px-2.5 h-6 bg-bg-base border-t border-border-subtle text-[9px] text-text-tertiary shrink-0">
              <span>~/Macros</span>
              <span className="text-text-disabled">·</span>
              <span>11 actions</span>
              <span className="flex-1" />
              <span style={{ color: 'var(--color-replay)' }}>Ready</span>
            </div>
          </div>

          {/* Below the window: text hierarchy + controls sample */}
          <div className="grid grid-cols-2 gap-2 mt-auto">
            <div
              className="px-2.5 py-2 bg-bg-card border border-border-subtle space-y-0.5"
              style={{ borderRadius: 'var(--ui-border-radius)' }}
            >
              <div className="text-[10px] text-text-primary">Primary text</div>
              <div className="text-[10px] text-text-secondary">Secondary text</div>
              <div className="text-[10px] text-text-tertiary">Tertiary text</div>
              <div className="text-[10px] text-text-disabled">Disabled text</div>
            </div>
            <div
              className="px-2.5 py-2 bg-bg-card border border-border-subtle flex flex-col gap-1.5"
              style={{ borderRadius: 'var(--ui-border-radius)' }}
            >
              {/* Mock input — focused state (accent border) since that's the variant
                  users most want to check against the background. */}
              <div
                className="h-6 px-2 flex items-center text-[9px] font-mono text-text-primary bg-bg-input border border-accent-solid"
                style={{ borderRadius: 'var(--ui-border-radius)' }}
              >
                1742, 388
              </div>
              <div className="flex gap-1.5">
                <button className="px-2 py-0.5 text-[9px] text-white bg-accent-solid" style={{ borderRadius: 'var(--ui-border-radius)' }}>OK</button>
                <button className="px-2 py-0.5 text-[9px] text-text-secondary bg-bg-elevated border border-border-default" style={{ borderRadius: 'var(--ui-border-radius)' }}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
