import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Check, RotateCcw, Download, Upload, Clipboard, ClipboardPaste, Pipette,
  ChevronDown, ChevronRight, ChevronLeft, Dices, SlidersHorizontal, FileJson2,
  Palette, Wand2, TriangleAlert,
} from 'lucide-react';
import { NumberInput } from './common/NumberInput';
import { Toggle } from './common/Toggle';
import { DialogShell } from './common/DialogShell';
import { Button } from './common/Button';
import { SegmentedControl } from './common/SegmentedControl';
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
import type { ThemeColors, ExportedTheme, ThemeTag, CustomThemePreset, ThemeUISettings } from '../themes';
import { useTheme } from '../state/ThemeContext';
import { useTt, useLanguage, DEFAULT_LANGUAGE } from '../state/LanguageContext';

interface ThemeEditorProps {
  onClose: () => void;
}

// Which left-column surface is showing. Gallery is the 90% path (pick a preset);
// customize (colors + interface) and share (import/export) live behind footer doors.
type Surface = 'gallery' | 'customize' | 'share';

// ── Color field model ──
// One flat list of every editable colour, grouped into accordion sections. Theme
// keys route through the preset override system (alpha-preserving); ui keys are the
// semantic + action-type colours stored plainly in uiSettings.
type ColorKind = 'theme' | 'ui';
interface ColorField { key: string; label: string; kind: ColorKind }
interface ColorSection {
  title: string;
  fields: ColorField[];
  grid2?: boolean;     // render the rows in a 2-col grid (Action types)
  wcag?: boolean;      // show a WCAG contrast chip per row (Text)
  accent?: boolean;    // append the "Derive solid & hover" button (Accent)
  defaultOpen?: boolean;
}

const COLOR_SECTIONS: ColorSection[] = [
  { title: 'Accent', accent: true, defaultOpen: true, fields: [
    { key: 'accent', label: 'Accent', kind: 'theme' },
    { key: 'accent-solid', label: 'Solid', kind: 'theme' },
    { key: 'accent-hover', label: 'Hover', kind: 'theme' },
  ] },
  { title: 'Backgrounds', fields: [
    { key: 'bg-base', label: 'Base', kind: 'theme' },
    { key: 'bg-surface', label: 'Surface', kind: 'theme' },
    { key: 'bg-card', label: 'Card', kind: 'theme' },
    { key: 'bg-elevated', label: 'Elevated', kind: 'theme' },
    { key: 'bg-input', label: 'Input', kind: 'theme' },
  ] },
  { title: 'Text', wcag: true, fields: [
    { key: 'text-primary', label: 'Primary', kind: 'theme' },
    { key: 'text-secondary', label: 'Secondary', kind: 'theme' },
    { key: 'text-tertiary', label: 'Tertiary', kind: 'theme' },
    { key: 'text-disabled', label: 'Disabled', kind: 'theme' },
  ] },
  { title: 'Borders', fields: [
    { key: 'border-subtle', label: 'Subtle', kind: 'theme' },
    { key: 'border-default', label: 'Default', kind: 'theme' },
    { key: 'border-strong', label: 'Strong', kind: 'theme' },
  ] },
  { title: 'Semantic', fields: [
    { key: 'recordingColor', label: 'Recording', kind: 'ui' },
    { key: 'replayColor', label: 'Replay', kind: 'ui' },
    { key: 'clickerColor', label: 'Clicker', kind: 'ui' },
  ] },
  { title: 'Action types', grid2: true, fields: [
    { key: 'actionMouseColor', label: 'Mouse', kind: 'ui' },
    { key: 'actionKeyColor', label: 'Key', kind: 'ui' },
    { key: 'actionScrollColor', label: 'Scroll', kind: 'ui' },
    { key: 'actionSendTextColor', label: 'Send Text', kind: 'ui' },
    { key: 'actionSetVariableColor', label: 'Set Variable', kind: 'ui' },
    { key: 'actionWaitImageColor', label: 'Wait Image', kind: 'ui' },
    { key: 'actionPixelColorColor', label: 'Pixel Color', kind: 'ui' },
    { key: 'actionBrowserColor', label: 'Browser', kind: 'ui' },
    { key: 'actionRunProfileColor', label: 'Run Profile', kind: 'ui' },
    { key: 'actionPauseColor', label: 'Pause', kind: 'ui' },
    { key: 'actionIfColor', label: 'Conditional', kind: 'ui' },
  ] },
];

const ALL_FIELDS: ColorField[] = COLOR_SECTIONS.flatMap(s => s.fields);
// All sections start EXPANDED — scrolling one column beats expanding six accordions
// one at a time. The header chevrons still collapse a section on demand.
const INITIAL_COLLAPSED = new Set<string>();

const MONO_FONTS = ['Consolas', 'Cascadia Mono', 'Cascadia Code', 'Courier New', 'Lucida Console'];

// Picks a color anywhere on screen using the EyeDropper API (Chromium 95+).
// Returns the sRGBHex string or null if unsupported or cancelled.
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
const HAS_EYEDROPPER = typeof (window as unknown as { EyeDropper?: unknown }).EyeDropper !== 'undefined';

// ── Unified color row ──
// One row for all 29 colours. The parent supplies the resolved value, whether it's
// overridden, and change/reset callbacks — the row stays agnostic about theme vs ui.
function ColorRow({ label, value, overridden, wcagBg, hslOpen, onChange, onReset, onToggleHsl, onHover }: {
  label: string;
  value: string;
  overridden: boolean;
  /** When set, show a WCAG contrast chip comparing this colour against the bg. */
  wcagBg?: string;
  hslOpen: boolean;
  onChange: (hex: string) => void;   // raw #rrggbb; parent applies alpha/plain + tracks recent
  onReset: () => void;
  onToggleHsl: () => void;
  onHover: (hovering: boolean) => void;
}) {
  const tt = useTt();
  const hexValue = toHex(value);
  const ratio = wcagBg ? contrastRatio(hexValue, wcagBg) : null;

  return (
    <div
      className="py-0.5 group"
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    >
      <div className="flex items-center gap-1.5">
        <span className="w-[96px] text-xs text-text-secondary shrink-0">{label}</span>

        <label className="relative w-6 h-6 rounded border border-border-default cursor-pointer shrink-0 overflow-hidden">
          <div className="absolute inset-0" style={{ backgroundColor: value }} />
          <input
            type="color"
            value={hexValue}
            onChange={(e) => onChange(e.target.value)}
            className="absolute inset-0 opacity-0 cursor-pointer"
          />
        </label>

        <input
          type="text"
          value={hexValue}
          onChange={(e) => { if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) onChange(e.target.value); }}
          className="w-[76px] h-6 px-1 text-xs font-mono text-text-primary bg-bg-input border border-border-default rounded text-center outline-none focus:border-accent-solid"
        />

        {/* Icon cluster (fixed width so 2-col rows line up). Pipette + tune reveal on
            hover; reset holds a reserved slot, visible only when overridden. */}
        <span className="flex items-center gap-0.5 w-[62px] shrink-0">
          {HAS_EYEDROPPER && (
            <button
              onClick={async () => { const p = await pickFromScreen(); if (p) onChange(p); }}
              className="w-5 h-5 flex items-center justify-center rounded text-text-tertiary hover:text-accent hover:bg-bg-card opacity-0 group-hover:opacity-100 transition-opacity"
              data-tip={tt('Pick color from screen', 'Capturar cor da tela')}
            >
              <Pipette size={12} />
            </button>
          )}
          <button
            onClick={onToggleHsl}
            className={`w-5 h-5 flex items-center justify-center rounded hover:bg-bg-card transition-opacity ${hslOpen ? 'text-accent opacity-100' : 'text-text-tertiary hover:text-text-primary opacity-0 group-hover:opacity-100'}`}
            data-tip={tt('Fine-tune with HSL sliders', 'Ajustar com controles HSL')}
          >
            <SlidersHorizontal size={11} />
          </button>
          {overridden && (
            <button
              onClick={onReset}
              className="w-5 h-5 flex items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-bg-card"
              data-tip={tt('Reset to preset', 'Voltar ao preset')}
            >
              <RotateCcw size={12} />
            </button>
          )}
        </span>

        {ratio !== null && (() => {
          // Quiet-when-passing: ≥4.5 renders a bare ratio; below AA shows a tinted
          // warning chip so failures are the only thing that draws the eye.
          const passing = ratio >= 4.5;
          const bad = ratio < 3;
          const tip = tt(`Contrast ${ratio.toFixed(1)}:1 — WCAG AA wants 4.5+ for body text`, `Contraste ${ratio.toFixed(1)}:1 — WCAG AA exige 4.5+ para texto de corpo`);
          if (passing) {
            return <span className="ml-auto font-mono text-[10px] text-text-tertiary" data-tip={tip}>{ratio.toFixed(1)}</span>;
          }
          return (
            <span
              className="ml-auto inline-flex items-center gap-1 px-1.5 rounded font-mono text-[10px]"
              style={{
                color: bad ? 'var(--color-recording)' : 'var(--color-warning)',
                background: `color-mix(in srgb, ${bad ? 'var(--color-recording)' : 'var(--color-warning)'} 12%, transparent)`,
              }}
              data-tip={tip}
            >
              <TriangleAlert size={10} />{ratio.toFixed(1)}
            </span>
          );
        })()}
      </div>

      {hslOpen && (() => {
        const hsl = hexToHSL(hexValue);
        const set = (h: number, s: number, l: number) => onChange(hslToHex(h, s, l));
        return (
          <div className="ml-[102px] mt-1 mb-1 pl-2 border-l border-border-subtle space-y-1">
            <HSLSlider label="H" max={360} value={Math.round(hsl.h)} unit="°" gradient="linear-gradient(to right, hsl(0,80%,50%), hsl(60,80%,50%), hsl(120,80%,50%), hsl(180,80%,50%), hsl(240,80%,50%), hsl(300,80%,50%), hsl(360,80%,50%))" onChange={(v) => set(v, hsl.s, hsl.l)} />
            <HSLSlider label="S" max={100} value={Math.round(hsl.s)} unit="%" gradient={`linear-gradient(to right, hsl(${hsl.h},0%,${hsl.l}%), hsl(${hsl.h},100%,${hsl.l}%))`} onChange={(v) => set(hsl.h, v, hsl.l)} />
            <HSLSlider label="L" max={100} value={Math.round(hsl.l)} unit="%" gradient={`linear-gradient(to right, hsl(${hsl.h},${hsl.s}%,0%), hsl(${hsl.h},${hsl.s}%,50%), hsl(${hsl.h},${hsl.s}%,100%))`} onChange={(v) => set(hsl.h, hsl.s, v)} />
          </div>
        );
      })()}
    </div>
  );
}

function HSLSlider({ label, value, max, unit, gradient, onChange }: {
  label: string; value: number; max: number; unit: string; gradient: string; onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-[10px] text-text-tertiary w-3">{label}</span>
      <div className="flex-1 relative h-3 rounded" style={{ background: gradient }}>
        <input type="range" min={0} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
        <div className="absolute top-1/2 w-2.5 h-2.5 rounded-full bg-white border border-black/40 pointer-events-none" style={{ left: `${(value / max) * 100}%`, transform: 'translate(-50%, -50%)' }} />
      </div>
      <span className="font-mono text-[10px] text-text-tertiary w-7 text-right">{value}{unit}</span>
    </div>
  );
}

function SliderSetting({ label, value, min, max, unit, defaultValue, onChange }: {
  label: string; value: number; min: number; max: number; unit: string; defaultValue?: number; onChange: (v: number) => void;
}) {
  const tt = useTt();
  const containerRef = useRef<HTMLDivElement>(null);
  const hovering = useRef(false);
  const latestValue = useRef(value);
  latestValue.current = value;
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

  const defaultPct = defaultValue !== undefined && defaultValue > min && defaultValue < max
    ? ((defaultValue - min) / (max - min)) * 100
    : null;

  return (
    <div ref={containerRef} className="flex items-center gap-3 py-1" onMouseEnter={() => { hovering.current = true; }} onMouseLeave={() => { hovering.current = false; }}>
      <span className="text-xs text-text-secondary w-[100px]">{label}</span>
      <div className="flex-1 relative">
        <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full h-1.5 accent-accent-solid" />
        {defaultPct !== null && (
          <div className="absolute pointer-events-none" style={{ left: `${defaultPct}%`, top: '50%', transform: 'translate(-50%, -50%)' }} data-tip={tt(`Default: ${defaultValue}${unit}`, `Padrão: ${defaultValue}${unit}`)}>
            <div className="w-0.5 h-2.5 bg-text-tertiary/60" />
          </div>
        )}
      </div>
      <NumberInput value={value} onChange={onChange} min={min} max={max} suffix={unit} inputHeight="h-7" ariaLabel="Value" />
    </div>
  );
}

const DENSITY_PRESETS = [
  { id: 'compact', name: 'Compact', fontSize: 12, rowHeight: 28, borderRadius: 2, lines: 4, lineH: 2 },
  { id: 'normal', name: 'Normal', fontSize: 13, rowHeight: 34, borderRadius: 3, lines: 3, lineH: 3 },
  { id: 'spacious', name: 'Spacious', fontSize: 14, rowHeight: 42, borderRadius: 4, lines: 2, lineH: 5 },
];

// ── Main ThemeEditor ──

export function ThemeEditor({ onClose }: ThemeEditorProps) {
  const tt = useTt();
  const {
    config, resolvedColors, customPresets, selectPreset,
    setColorOverride, clearColorOverride, clearAllOverrides,
    setAccentColor, setUISetting, resetUISettings,
    exportTheme, importTheme,
    saveAsPreset, deleteCustomPreset,
  } = useTheme();
  const { language, setLanguage } = useLanguage();

  const [surface, setSurface] = useState<Surface>('gallery');
  const [custSeg, setCustSeg] = useState<'colors' | 'interface'>('colors');
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set(INITIAL_COLLAPSED));
  const [openHslKey, setOpenHslKey] = useState<string | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);

  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState('');
  const [copySuccess, setCopySuccess] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [copiedRecent, setCopiedRecent] = useState<number | null>(null);
  const [presetSearch, setPresetSearch] = useState('');
  const [presetFilter, setPresetFilter] = useState<'all' | ThemeTag>('all');
  const [savePresetName, setSavePresetName] = useState('');
  const [saveMode, setSaveMode] = useState(false);        // Modified-bar inline save input open
  const [exportName, setExportName] = useState('My Theme');
  const [recentColors, setRecentColors] = useState<string[]>([]);
  const [resetMenuOpen, setResetMenuOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const saveInputRef = useRef<HTMLInputElement>(null);
  const resetMenuRef = useRef<HTMLDivElement>(null);

  const hasOverrides = Object.keys(config.colorOverrides).length > 0;
  const basePreset = themes.find(t => t.id === config.baseThemeId) ?? themes[0];
  const currentAccentHex = toHex(resolvedColors.accent);

  // Field-wise compare (cheaper than JSON.stringify per render) for the reset-everything gate.
  const uiAtDefault = (Object.keys(DEFAULT_UI_SETTINGS) as (keyof ThemeUISettings)[])
    .every(k => config.uiSettings[k] === DEFAULT_UI_SETTINGS[k]);
  const everythingAtDefault = !hasOverrides && uiAtDefault && language === DEFAULT_LANGUAGE;

  // Push a chosen colour onto the transient recent strip (dedup ci, cap 8).
  const pushRecent = useCallback((val: string) => {
    const hex = toHex(val).toLowerCase();
    setRecentColors(prev => [hex, ...prev.filter(c => c.toLowerCase() !== hex)].slice(0, 8));
  }, []);

  // Field value / base / overridden — bridges the two storage backends.
  const fieldValue = useCallback((f: ColorField): string =>
    f.kind === 'theme' ? resolvedColors[f.key as keyof ThemeColors] : String(config.uiSettings[f.key as keyof ThemeUISettings]),
    [resolvedColors, config.uiSettings]);
  const fieldBase = useCallback((f: ColorField): string =>
    f.kind === 'theme' ? basePreset.colors[f.key as keyof ThemeColors] : String(DEFAULT_UI_SETTINGS[f.key as keyof ThemeUISettings]),
    [basePreset]);
  const fieldOverridden = useCallback((f: ColorField): boolean =>
    f.kind === 'theme' ? (f.key in config.colorOverrides) : fieldValue(f) !== fieldBase(f),
    [config.colorOverrides, fieldValue, fieldBase]);

  // Apply a raw #rrggbb to a field: theme keys preserve original alpha + go through the
  // override store; ui keys store plain hex. Both feed the recent strip.
  const applyColor = useCallback((f: ColorField, rawHex: string) => {
    if (f.kind === 'theme') {
      const k = f.key as keyof ThemeColors;
      setColorOverride(k, withOriginalAlpha(rawHex, resolvedColors[k]));
    } else {
      setUISetting(f.key as keyof ThemeUISettings, rawHex as ThemeUISettings[keyof ThemeUISettings]);
    }
    pushRecent(rawHex);
  }, [setColorOverride, setUISetting, resolvedColors, pushRecent]);

  const resetColor = useCallback((f: ColorField) => {
    if (f.kind === 'theme') clearColorOverride(f.key as keyof ThemeColors);
    else setUISetting(f.key as keyof ThemeUISettings, DEFAULT_UI_SETTINGS[f.key as keyof ThemeUISettings]);
  }, [clearColorOverride, setUISetting]);

  const toggleSection = useCallback((title: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title); else next.add(title);
      return next;
    });
  }, []);

  // Reset menu — close on outside mousedown / Esc. Focus the menu when it opens so its
  // own onKeyDown catches Esc (stopPropagation) instead of the keystroke bubbling to
  // DialogShell and closing the whole editor — mouse-open otherwise leaves focus on the
  // toggle button, outside the menu, so the Esc-swallow never fired.
  useEffect(() => {
    if (!resetMenuOpen) return;
    resetMenuRef.current?.focus();
    const onDown = () => setResetMenuOpen(false);
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [resetMenuOpen]);

  useEffect(() => { if (saveMode) saveInputRef.current?.focus(); }, [saveMode]);

  // ── Export handlers ──
  const handleExportFile = useCallback(() => {
    const name = exportName.trim() || 'My Theme';
    const theme = exportTheme(name);
    const blob = new Blob([JSON.stringify(theme, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
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
      if (!validateExportedTheme(parsed) || !importTheme(parsed as ExportedTheme)) {
        setImportError('Invalid theme format. Check all required color keys and UI settings.');
        return;
      }
      setImportText('');
      setSurface('gallery');
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

  const doSaveAsPreset = useCallback(() => {
    if (!savePresetName.trim()) return;
    saveAsPreset(savePresetName.trim());
    setSavePresetName('');
    setSaveMode(false);
  }, [savePresetName, saveAsPreset]);

  // Recent-swatch click: apply to the currently open HSL row if any, else copy to clipboard.
  const openField = openHslKey ? ALL_FIELDS.find(f => f.key === openHslKey) : undefined;
  const handleRecentClick = useCallback(async (c: string, i: number) => {
    if (openField) { applyColor(openField, c); return; }
    try {
      await navigator.clipboard?.writeText(c);
      setCopiedRecent(i);
      setTimeout(() => setCopiedRecent(prev => (prev === i ? null : prev)), 1200);
    } catch { /* clipboard unavailable */ }
  }, [openField, applyColor]);

  const ckHover = (key: string): React.CSSProperties | undefined =>
    hoverKey === key ? { outline: '1px solid var(--color-accent-solid)', outlineOffset: '-1px' } : undefined;

  // ═══ Footer ═══
  const footerHint = (
    <div className="relative" onMouseDown={(e) => e.stopPropagation()}>
      <button
        onClick={() => setResetMenuOpen(o => !o)}
        className="inline-flex items-center gap-1.5 h-7 px-2 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-bg-card transition-colors"
      >
        <RotateCcw size={12} /> Reset <ChevronDown size={11} />
      </button>
      {resetMenuOpen && (
        <div
          ref={resetMenuRef}
          tabIndex={-1}
          className="absolute bottom-full left-0 mb-1 w-[220px] bg-bg-card border border-border-default rounded shadow-xl p-1 z-10 outline-none"
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setResetMenuOpen(false); } }}
        >
          <button
            onClick={() => { clearAllOverrides(); setResetMenuOpen(false); }}
            disabled={!hasOverrides}
            className="w-full text-left px-2 py-1.5 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-bg-surface disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Color overrides
          </button>
          <button
            onClick={() => { clearAllOverrides(); resetUISettings(); setLanguage(DEFAULT_LANGUAGE); setResetMenuOpen(false); }}
            disabled={everythingAtDefault}
            className="w-full text-left px-2 pt-1.5 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-bg-surface disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Reset everything
          </button>
          <div className="px-2 pb-1 text-[10px] text-text-tertiary">Includes app language</div>
        </div>
      )}
    </div>
  );

  const footer = (
    <>
      <Button variant="ghost" onClick={() => setSurface('share')}>
        <FileJson2 size={13} /> Import / Export
      </Button>
      {surface !== 'customize' && (
        <Button variant="secondary" onClick={() => setSurface('customize')}>
          <SlidersHorizontal size={13} /> Customize
        </Button>
      )}
      <Button variant="primary" onClick={onClose}>Done</Button>
    </>
  );

  return (
    <DialogShell
      icon={<Palette size={14} style={{ color: 'var(--color-accent)' }} />}
      title="Theme Editor"
      widthClass="w-[920px]"
      onClose={onClose}
      closeOnBackdrop
      showClose
      // Ignore backdrop clicks in the OS title-bar guard zone so hitting the
      // maximize/restore/close caption buttons doesn't dismiss the editor.
      scrimMouseDownGuard={(e) => e.clientY < 40}
      footerHint={footerHint}
      footer={footer}
    >
      <div className="grid grid-cols-[1fr_300px] h-[560px] min-h-0">
        {/* ── Left column ── */}
        <div className="min-w-0 overflow-y-auto">
          {surface === 'gallery' && renderGallery()}
          {surface === 'customize' && renderCustomize()}
          {surface === 'share' && renderShare()}
        </div>

        {/* ── Persistent preview rail ── */}
        {renderRail()}
      </div>
    </DialogShell>
  );

  // ══════════════ GALLERY ══════════════
  function renderGallery() {
    const filterChips: { id: 'all' | ThemeTag; label: string }[] = [
      { id: 'all', label: 'All' }, { id: 'dark', label: 'Dark' }, { id: 'light', label: 'Light' },
      { id: 'vivid', label: 'Vivid' }, { id: 'pastel', label: 'Pastel' }, { id: 'monochrome', label: 'Monochrome' },
    ];
    const q = presetSearch.trim().toLowerCase();
    const matchesFilter = (id: string) => presetFilter === 'all' || getThemeTags(id).includes(presetFilter);
    const matchesSearch = (name: string) => q.length === 0 || name.toLowerCase().includes(q);
    const builtinList = themes.filter(t => matchesFilter(t.id) && matchesSearch(t.name));
    const customList = customPresets.filter(t => matchesSearch(t.name));
    const filteredCustom = customList.filter(p => {
      if (presetFilter === 'all') return true;
      if (presetFilter === 'dark' || presetFilter === 'light') {
        const hex = p.colors['bg-base'].replace('#', '');
        if (hex.length < 6) return presetFilter === 'dark';
        const r = parseInt(hex.substring(0, 2), 16), g = parseInt(hex.substring(2, 4), 16), b = parseInt(hex.substring(4, 6), 16);
        const lum = (r * 299 + g * 587 + b * 114) / 1000;
        return (lum > 128) === (presetFilter === 'light');
      }
      return false;
    });
    const pool = builtinList.filter(t => t.id !== config.baseThemeId);

    const renderCard = (theme: typeof themes[0] | CustomThemePreset) => {
      const isActive = theme.id === config.baseThemeId && !hasOverrides;
      const isCustom = '__custom' in theme;
      return (
        <div key={theme.id} className="group/card relative">
          <button
            onClick={() => selectPreset(theme.id)}
            className={`w-full flex flex-col rounded-md overflow-hidden border transition-colors cursor-pointer ${
              isActive ? 'border-accent ring-1 ring-accent/30' : 'border-border-subtle hover:border-border-default'
            }`}
          >
            <div className="flex h-10">
              {theme.preview.map((color, i) => <div key={i} className="flex-1" style={{ backgroundColor: color }} />)}
            </div>
            <div className="flex items-center justify-between px-2 py-1.5" style={{ backgroundColor: theme.colors['bg-card'] }}>
              <span className="text-[11px] font-medium truncate" style={{ color: theme.colors['text-secondary'] }}>{theme.name}</span>
              {isActive && <Check size={12} style={{ color: theme.colors.accent }} />}
            </div>
          </button>
          {/* Hover-revealed Customize shortcut on the active card. */}
          {isActive && (
            <button
              onClick={() => setSurface('customize')}
              className="absolute bottom-9 right-1 w-4 h-4 rounded bg-black/45 text-white opacity-0 group-hover/card:opacity-100 transition-opacity flex items-center justify-center"
              data-tip={tt('Customize this theme', 'Personalizar este tema')}
            >
              <SlidersHorizontal size={10} />
            </button>
          )}
          {isCustom && (
            <button
              onClick={(e) => { e.stopPropagation(); deleteCustomPreset(theme.id); }}
              className="absolute top-1 right-1 w-5 h-5 rounded bg-bg-base/80 text-text-tertiary hover:text-recording opacity-0 group-hover/card:opacity-100 transition-opacity flex items-center justify-center"
            >
              <span className="text-sm leading-none">×</span>
            </button>
          )}
        </div>
      );
    };

    return (
      <div className="p-4">
        {/* Toolbar */}
        <div className="flex gap-2 h-8">
          <div className="flex-1 relative">
            <input
              type="text"
              value={presetSearch}
              onChange={(e) => setPresetSearch(e.target.value)}
              placeholder="Search themes…"
              className="w-full h-8 pl-2.5 pr-7 text-xs text-text-primary bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid"
            />
            {presetSearch && (
              <button onClick={() => setPresetSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary text-sm leading-none">×</button>
            )}
          </div>
          <button
            onClick={() => { if (pool.length) selectPreset(pool[Math.floor(Math.random() * pool.length)].id); }}
            disabled={pool.length === 0}
            className="w-8 h-8 flex items-center justify-center rounded text-text-secondary hover:text-text-primary hover:bg-bg-card disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            data-tip={pool.length === 0 ? tt('No other presets in this filter', 'Nenhum outro preset neste filtro') : tt('Pick a random preset from the current filter', 'Escolher um preset aleatório do filtro atual')}
          >
            <Dices size={14} />
          </button>
          <label className="relative w-8 h-8 rounded border border-border-default cursor-pointer overflow-hidden shrink-0" data-tip={tt(`Accent · ${currentAccentHex} — click to change`, `Destaque · ${currentAccentHex} — clique para mudar`)}>
            <div className="absolute inset-0" style={{ backgroundColor: currentAccentHex }} />
            <input type="color" value={currentAccentHex} onChange={(e) => setAccentColor(e.target.value)} className="absolute inset-0 opacity-0 cursor-pointer" />
          </label>
        </div>

        {/* Filter chips */}
        <div className="flex gap-1 mt-2">
          {filterChips.map(chip => {
            const on = presetFilter === chip.id;
            return (
              <button
                key={chip.id}
                onClick={() => setPresetFilter(chip.id)}
                className={`h-6 px-2 rounded text-[11px] transition-colors ${on ? 'text-accent' : 'text-text-tertiary hover:text-text-primary'}`}
                style={on ? { background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)' } : undefined}
              >
                {chip.label}
              </button>
            );
          })}
        </div>

        {/* Modified bar */}
        {hasOverrides && (
          <div className="flex items-center gap-2 mt-2 h-8 px-3 rounded text-xs" style={{ background: 'color-mix(in srgb, var(--color-accent) 6%, transparent)' }}>
            <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
            {saveMode ? (
              <input
                ref={saveInputRef}
                type="text"
                value={savePresetName}
                onChange={(e) => setSavePresetName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') doSaveAsPreset(); else if (e.key === 'Escape') { setSaveMode(false); setSavePresetName(''); } }}
                onBlur={() => { if (!savePresetName.trim()) setSaveMode(false); }}
                placeholder="Name your customization…"
                className="flex-1 h-6 px-2 text-xs text-text-primary bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid"
              />
            ) : (
              <span className="text-text-secondary truncate">
                {Object.keys(config.colorOverrides).length} color{Object.keys(config.colorOverrides).length === 1 ? '' : 's'} customized on <span className="text-text-primary font-medium">{basePreset.name}</span>
              </span>
            )}
            <span className="flex-1" />
            {saveMode ? (
              <button onClick={doSaveAsPreset} disabled={!savePresetName.trim()} className="text-accent hover:text-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors">Save</button>
            ) : (
              <button onClick={() => setSaveMode(true)} className="text-text-secondary hover:text-text-primary transition-colors">Save as preset…</button>
            )}
            <button onClick={clearAllOverrides} className="text-text-secondary hover:text-text-primary transition-colors">Reset</button>
            <button onClick={() => setSurface('customize')} className="text-accent hover:text-accent-hover transition-colors">Edit →</button>
          </div>
        )}

        {/* Card grids */}
        {builtinList.length === 0 && filteredCustom.length === 0 ? (
          <div className="text-xs text-text-tertiary text-center py-8">No themes match your search.</div>
        ) : (
          <div className="grid grid-cols-4 gap-2.5 mt-3">{builtinList.map(renderCard)}</div>
        )}
        {filteredCustom.length > 0 && (
          <>
            <div className="label-micro text-text-tertiary mt-4 mb-1.5">My Themes</div>
            <div className="grid grid-cols-4 gap-2.5">{filteredCustom.map(renderCard)}</div>
          </>
        )}
      </div>
    );
  }

  // ══════════════ CUSTOMIZE ══════════════
  function renderCustomize() {
    return (
      <div>
        {/* Local header */}
        <div className="h-9 px-4 flex items-center gap-2.5 border-b border-border-subtle sticky top-0 bg-bg-elevated z-10">
          <button onClick={() => setSurface('gallery')} className="inline-flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors">
            <ChevronLeft size={14} /> Themes
          </button>
          <span className="text-xs text-text-secondary truncate">
            {basePreset.name}{hasOverrides ? ` · ${Object.keys(config.colorOverrides).length} edits` : ''}
          </span>
          <div className="ml-auto">
            <SegmentedControl
              options={[{ value: 'colors', label: 'Colors' }, { value: 'interface', label: 'Interface' }]}
              value={custSeg}
              onChange={setCustSeg}
              ariaLabel="Customize section"
            />
          </div>
        </div>
        {custSeg === 'colors' ? renderColorsPanel() : renderInterfacePanel()}
      </div>
    );
  }

  function renderColorsPanel() {
    return (
      <div className="relative">
        {COLOR_SECTIONS.map((section, si) => {
          const collapsed = collapsedSections.has(section.title);
          const modified = section.fields.filter(fieldOverridden).length;
          return (
            <div key={section.title} className={si < COLOR_SECTIONS.length - 1 ? 'border-b border-border-subtle' : ''}>
              <button onClick={() => toggleSection(section.title)} className="w-full h-8 px-4 flex items-center gap-2 hover:bg-bg-card/50 transition-colors">
                {collapsed ? <ChevronRight size={12} className="text-text-tertiary shrink-0" /> : <ChevronDown size={12} className="text-text-tertiary shrink-0" />}
                <span className="text-xs font-medium text-text-primary">{section.title}</span>
                {modified > 0 && <span className="text-[11px] text-accent">· {modified}</span>}
                {collapsed && (
                  <span className="ml-auto flex gap-0.5">
                    {section.fields.map(f => <span key={f.key} className="w-2.5 h-2.5 rounded-sm border border-border-default" style={{ backgroundColor: fieldValue(f) }} />)}
                  </span>
                )}
              </button>
              {!collapsed && (
                <div className={`px-4 pb-2.5 ${section.grid2 ? 'grid grid-cols-2 gap-x-4' : ''}`}>
                  {section.fields.map(f => (
                    <ColorRow
                      key={f.key}
                      label={f.label}
                      value={fieldValue(f)}
                      overridden={fieldOverridden(f)}
                      wcagBg={section.wcag ? resolvedColors['bg-surface'] : undefined}
                      hslOpen={openHslKey === f.key}
                      onChange={(hex) => applyColor(f, hex)}
                      onReset={() => resetColor(f)}
                      onToggleHsl={() => setOpenHslKey(prev => (prev === f.key ? null : f.key))}
                      onHover={(h) => setHoverKey(h ? f.key : null)}
                    />
                  ))}
                  {section.accent && (
                    <button onClick={() => setAccentColor(currentAccentHex)} className="mt-1 inline-flex items-center gap-1.5 h-6 px-2 rounded text-[11px] text-text-secondary hover:text-text-primary hover:bg-bg-card transition-colors">
                      <Wand2 size={12} /> Derive solid &amp; hover
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* Recent colours — sticky bottom, session-only */}
        {recentColors.length > 0 && (
          <div className="sticky bottom-0 bg-bg-elevated pt-2 mt-1 border-t border-border-subtle px-4 pb-3 flex items-center gap-2">
            <span className="label-micro text-text-tertiary">Recent</span>
            <div className="flex gap-1">
              {recentColors.map((c, i) => (
                <button
                  key={i}
                  onClick={() => handleRecentClick(c, i)}
                  className="w-4 h-4 rounded border border-border-default flex items-center justify-center"
                  style={{ backgroundColor: c }}
                  data-tip={openField ? tt(`Apply ${c} to ${openField.label}`, `Aplicar ${c} em ${openField.label}`) : copiedRecent === i ? tt(`${c} — copied!`, `${c} — copiado!`) : tt(`${c} — click to copy`, `${c} — clique para copiar`)}
                >
                  {copiedRecent === i && <Check size={9} className="text-white drop-shadow-[0_0_1px_rgba(0,0,0,0.8)]" />}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  function renderInterfacePanel() {
    const activeDensity = DENSITY_PRESETS.find(p =>
      p.fontSize === config.uiSettings.fontSize && p.rowHeight === config.uiSettings.rowHeight && p.borderRadius === config.uiSettings.borderRadius);
    return (
      <div className="p-4">
        <div className="label-micro text-text-tertiary mb-1.5">Density</div>
        <div className="grid grid-cols-3 gap-2">
          {DENSITY_PRESETS.map(p => {
            const isActive = activeDensity?.id === p.id;
            return (
              <button
                key={p.id}
                onClick={() => { setUISetting('fontSize', p.fontSize); setUISetting('rowHeight', p.rowHeight); setUISetting('borderRadius', p.borderRadius); }}
                className="flex flex-col items-stretch gap-1.5 px-2 py-2 rounded transition-colors"
                style={isActive ? { background: 'color-mix(in srgb, var(--color-accent) 10%, transparent)' } : undefined}
              >
                <span className={`text-[11px] font-medium ${isActive ? 'text-accent' : 'text-text-primary'}`}>{p.name}</span>
                <div className="flex flex-col gap-px">
                  {Array.from({ length: p.lines }).map((_, i) => <div key={i} style={{ height: p.lineH }} className="bg-text-disabled/50 rounded-sm" />)}
                </div>
              </button>
            );
          })}
        </div>

        <div className="label-micro text-text-tertiary mt-4 mb-1">Fine-tune</div>
        <SliderSetting label="Font Size" value={config.uiSettings.fontSize} min={10} max={18} unit="px" defaultValue={DEFAULT_UI_SETTINGS.fontSize} onChange={(v) => setUISetting('fontSize', v)} />
        <SliderSetting label="Border Radius" value={config.uiSettings.borderRadius} min={0} max={16} unit="px" defaultValue={DEFAULT_UI_SETTINGS.borderRadius} onChange={(v) => setUISetting('borderRadius', v)} />
        <SliderSetting label="Row Height" value={config.uiSettings.rowHeight} min={28} max={48} unit="px" defaultValue={DEFAULT_UI_SETTINGS.rowHeight} onChange={(v) => setUISetting('rowHeight', v)} />
        <SliderSetting label="Zoom" value={config.uiSettings.zoom} min={50} max={200} unit="%" defaultValue={DEFAULT_UI_SETTINGS.zoom} onChange={(v) => setUISetting('zoom', v)} />

        <div className="label-micro text-text-tertiary mt-4 mb-1">Font</div>
        <div className="flex items-center gap-2 py-0.5">
          <span className="text-xs text-text-secondary w-[100px]">Monospace</span>
          <select
            value={MONO_FONTS.includes(config.uiSettings.fontMono) ? config.uiSettings.fontMono : '__custom'}
            onChange={(e) => { if (e.target.value !== '__custom') setUISetting('fontMono', e.target.value); }}
            className="flex-1 h-7 px-2 text-xs text-text-primary bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid cursor-pointer"
          >
            {MONO_FONTS.map(f => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
            {!MONO_FONTS.includes(config.uiSettings.fontMono) && <option value="__custom">{config.uiSettings.fontMono}</option>}
          </select>
          <span className="text-xs font-mono text-text-tertiary truncate w-[80px] text-center" style={{ fontFamily: `'${config.uiSettings.fontMono}', monospace` }}>Abc 123</span>
        </div>

        <div className="label-micro text-text-tertiary mt-4 mb-1">System</div>
        <div className="flex items-center justify-between py-1.5">
          <div className="flex flex-col">
            <span className="text-xs text-text-secondary">Match Windows theme</span>
            <span className="text-[10px] text-text-tertiary">Auto-switch dark / light when the OS does</span>
          </div>
          <Toggle isOn={config.uiSettings.matchSystemTheme} onChange={(v) => setUISetting('matchSystemTheme', v)} />
        </div>
        {config.uiSettings.matchSystemTheme && (
          <div className="ml-3 pl-3 border-l border-border-subtle space-y-1.5 py-1">
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-text-tertiary w-[100px]">Dark preset</span>
              <select value={config.uiSettings.darkPresetId} onChange={(e) => setUISetting('darkPresetId', e.target.value)} className="flex-1 h-6 px-2 text-[11px] text-text-primary bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid cursor-pointer">
                {themes.filter(t => !getThemeTags(t.id).includes('light')).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-text-tertiary w-[100px]">Light preset</span>
              <select value={config.uiSettings.lightPresetId} onChange={(e) => setUISetting('lightPresetId', e.target.value)} className="flex-1 h-6 px-2 text-[11px] text-text-primary bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid cursor-pointer">
                {themes.filter(t => getThemeTags(t.id).includes('light')).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          </div>
        )}
        <div className="flex items-center justify-between py-1.5">
          <div className="flex flex-col">
            <span className="text-xs text-text-secondary">Enable animations</span>
            <span className="text-[10px] text-text-tertiary">Theme switch transitions and hover effects</span>
          </div>
          <Toggle isOn={config.uiSettings.enableAnimations} onChange={(v) => setUISetting('enableAnimations', v)} />
        </div>
      </div>
    );
  }

  // ══════════════ SHARE ══════════════
  function renderShare() {
    return (
      <div>
        <div className="h-9 px-4 flex items-center gap-2.5 border-b border-border-subtle">
          <button onClick={() => setSurface('gallery')} className="inline-flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors">
            <ChevronLeft size={14} /> Themes
          </button>
          <span className="text-xs text-text-secondary">Import / Export</span>
        </div>
        <div className="p-4 space-y-5">
          <div>
            <div className="label-micro text-text-tertiary mb-2">Export current theme</div>
            <div className="flex gap-2 items-center">
              <input type="text" value={exportName} onChange={(e) => setExportName(e.target.value)} placeholder="My Theme" className="w-[240px] h-8 px-2.5 text-xs text-text-primary bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid" />
              <Button variant="secondary" onClick={handleExportFile}><Download size={13} /> Export to file</Button>
              <Button variant="secondary" onClick={handleCopyClipboard}><Clipboard size={13} /> {copyError ? 'Copy failed' : copySuccess ? 'Copied!' : 'Copy to clipboard'}</Button>
            </div>
            <p className="mt-2 text-[10px] text-text-tertiary">Bundles the base preset, your color overrides and every appearance setting into a single JSON.</p>
          </div>
          <div>
            <div className="label-micro text-text-tertiary mb-2">Import a theme</div>
            <div className="flex gap-2 mb-2">
              <Button variant="secondary" onClick={() => fileInputRef.current?.click()}><Upload size={13} /> Import from file</Button>
              <input ref={fileInputRef} type="file" accept=".json" onChange={handleImportFile} className="hidden" />
              <Button variant="secondary" onClick={handlePasteClipboard}><ClipboardPaste size={13} /> Paste from clipboard</Button>
            </div>
            <textarea value={importText} onChange={(e) => setImportText(e.target.value)} placeholder="Paste theme JSON here…" className="w-full h-28 px-3 py-2 text-xs font-mono text-text-primary bg-bg-input border border-border-default rounded resize-none outline-none focus:border-accent-solid" />
            {importText && <Button variant="primary" className="mt-2" onClick={() => doImport(importText)}>Apply theme</Button>}
            {importError && <p className="mt-2 text-xs text-recording">{importError}</p>}
          </div>
        </div>
      </div>
    );
  }

  // ══════════════ PREVIEW RAIL ══════════════
  function renderRail() {
    const evenBg = 'var(--color-bg-surface)';
    const oddBg = 'color-mix(in srgb, var(--color-text-primary) 1.5%, transparent)';
    const selectedBg = 'color-mix(in srgb, var(--color-accent) 8%, transparent)';
    const structuralBg = 'color-mix(in srgb, var(--color-action-if-fg) 6%, transparent)';
    const inBlockBg = 'color-mix(in srgb, var(--color-action-if-fg) 3%, transparent)';
    const rows: { n: number; pill: string; label: string; delay: string; tone: [string, string]; bg: string; rail?: 'strong' | 'thin'; selected?: boolean }[] = [
      { n: 1, pill: 'LeftClick', label: 'left · 1742,388', delay: '50', tone: ['--color-action-mouse-bg', '--color-action-mouse-fg'], bg: evenBg },
      { n: 2, pill: 'KeyDown', label: 'Ctrl+V', delay: '80', tone: ['--color-action-key-bg', '--color-action-key-fg'], bg: oddBg },
      { n: 3, pill: 'if image', label: 'btn-ok.png', delay: '—', tone: ['--color-action-if-bg', '--color-action-if-fg'], bg: structuralBg, rail: 'strong' },
      { n: 4, pill: 'WaitImage', label: 'btn-ok.png', delay: '120', tone: ['--color-action-waitimage-bg', '--color-action-waitimage-fg'], bg: inBlockBg, rail: 'thin' },
      { n: 5, pill: 'PixelColor', label: '#ff8800', delay: '60', tone: ['--color-action-pixelcolor-bg', '--color-action-pixelcolor-fg'], bg: inBlockBg, rail: 'thin' },
      { n: 6, pill: 'endif', label: '', delay: '—', tone: ['--color-action-if-bg', '--color-action-if-fg'], bg: structuralBg, rail: 'strong' },
      { n: 7, pill: 'SendText', label: '"Hello {date}"', delay: '200', tone: ['--color-action-sendtext-bg', '--color-action-sendtext-fg'], bg: evenBg },
      { n: 8, pill: 'SetVar', label: 'count = {counter}', delay: '—', tone: ['--color-action-setvariable-bg', '--color-action-setvariable-fg'], bg: oddBg },
      { n: 9, pill: 'ScrollDn', label: '×3', delay: '80', tone: ['--color-action-scroll-bg', '--color-action-scroll-fg'], bg: evenBg },
      { n: 10, pill: 'Browser', label: 'button.submit', delay: '100', tone: ['--color-action-browser-bg', '--color-action-browser-fg'], bg: oddBg },
      { n: 11, pill: 'RunProfile', label: 'Sub-flow ×2', delay: '30', tone: ['--color-action-runprofile-bg', '--color-action-runprofile-fg'], bg: selectedBg, selected: true },
      { n: 12, pill: 'Pause', label: 'until F9', delay: '—', tone: ['--color-action-pause-bg', '--color-action-pause-fg'], bg: evenBg },
    ];

    return (
      <div className="bg-bg-base border-l border-border-subtle p-3 select-none overflow-hidden [&_button]:pointer-events-none [&_input]:pointer-events-none">
        <div className="label-micro text-text-tertiary mb-2">Live Preview</div>
        <div className="flex flex-col border border-border-default overflow-hidden shadow-lg" style={{ borderRadius: 'calc(var(--ui-border-radius) + 4px)' }}>
          {/* Title bar */}
          <div className="flex items-center gap-1.5 px-2 h-8 bg-bg-surface border-b border-border-subtle shrink-0" style={ckHover('bg-surface')}>
            <span className="w-4 h-4 rounded bg-accent-solid shrink-0" style={ckHover('accent-solid')} />
            <span className="text-[10px] text-text-secondary">TrueReplayer</span>
            <span className="flex-1" />
            <span className="inline-flex items-center gap-1 px-1.5 py-px rounded-full text-[9px]" style={{ background: 'var(--color-replay-bg)', color: 'var(--color-replay)' }}>
              <span className="w-1 h-1 rounded-full" style={{ background: 'var(--color-replay)' }} /> Ready
            </span>
            <span className="px-1 py-px rounded font-mono text-[8px] border" style={{ background: 'var(--color-hotkey-bg)', color: 'var(--color-hotkey-fg)', borderColor: 'var(--color-hotkey-border)' }}>F8</span>
          </div>
          {/* Toolbar */}
          <div className="flex items-center gap-1.5 px-2 h-8 bg-bg-surface border-b border-border-subtle shrink-0" style={ckHover('bg-surface')}>
            <button className="px-2 py-0.5 text-[9px] text-white bg-accent-solid" style={{ borderRadius: 'var(--ui-border-radius)', ...ckHover('accent-solid') }}>Save</button>
            <button className="px-2 py-0.5 text-[9px] text-text-secondary bg-bg-elevated border border-border-default" style={{ borderRadius: 'var(--ui-border-radius)' }}>Load</button>
          </div>
          {/* Grid header */}
          <div className="grid grid-cols-[14px_54px_1fr_30px] gap-1.5 items-center px-2 h-5 bg-bg-surface border-b border-border-subtle shrink-0">
            <span className="text-[8px] font-semibold text-text-tertiary">#</span>
            <span className="text-[8px] font-semibold text-text-tertiary">Type</span>
            <span className="text-[8px] font-semibold text-text-tertiary">Details</span>
            <span className="text-[8px] font-semibold text-text-tertiary text-right">Delay</span>
          </div>
          {/* Body: rows + sheet pane */}
          <div className="grid grid-cols-[1fr_104px]">
            <div className="flex flex-col bg-bg-surface">
              {rows.map(row => (
                <div
                  key={row.n}
                  className="grid grid-cols-[14px_54px_1fr_30px] gap-1.5 items-center px-2 border-b border-border-subtle"
                  style={{
                    height: 'calc(var(--ui-row-height) * 0.6)',
                    background: row.bg,
                    boxShadow: row.selected ? 'inset 2px 0 0 var(--color-accent)'
                      : row.rail ? `inset 2px 0 0 ${row.rail === 'strong' ? 'var(--color-action-if-fg)' : 'color-mix(in srgb, var(--color-action-if-fg) 35%, transparent)'}`
                      : undefined,
                  }}
                >
                  <span className="font-mono text-[8px] text-text-disabled text-right">{row.n}</span>
                  <span className="px-1 py-px rounded font-mono text-[8px] text-center truncate border" style={{ background: `var(${row.tone[0]})`, color: `var(${row.tone[1]})`, borderColor: `color-mix(in srgb, var(${row.tone[1]}) 30%, transparent)` }}>{row.pill}</span>
                  <span className="text-[9px] text-text-secondary truncate">{row.label}</span>
                  <span className={`font-mono tabular-nums text-[8px] text-right ${row.delay === '—' ? 'text-text-disabled' : 'text-text-secondary'}`}>
                    {row.delay}{row.delay !== '—' && <span className="text-[7px] text-text-tertiary ml-0.5">ms</span>}
                  </span>
                </div>
              ))}
            </div>
            {/* Mock SheetPanel pane — folds the old text/input sample cards inside the window */}
            <div className="bg-bg-card border-l border-border-subtle p-2 flex flex-col gap-1" style={ckHover('bg-card')}>
              <div className="text-[10px] text-text-primary">Primary</div>
              <div className="text-[10px] text-text-secondary">Secondary</div>
              <div className="text-[10px] text-text-tertiary">Tertiary</div>
              <div className="text-[10px] text-text-disabled">Disabled</div>
              <div className="h-6 mt-1 px-1.5 flex items-center text-[9px] font-mono text-text-primary bg-bg-input border border-accent-solid" style={{ borderRadius: 'var(--ui-border-radius)' }}>1742, 388</div>
              <div className="flex gap-1 mt-0.5">
                <button className="px-2 py-0.5 text-[9px] text-white bg-accent-solid" style={{ borderRadius: 'var(--ui-border-radius)' }}>OK</button>
                <button className="px-2 py-0.5 text-[9px] text-text-secondary bg-bg-elevated border border-border-default" style={{ borderRadius: 'var(--ui-border-radius)' }}>Cancel</button>
              </div>
            </div>
          </div>
          {/* Action bar */}
          <div className="flex items-center gap-1.5 px-2 h-9 bg-bg-surface border-t border-border-subtle shrink-0">
            <button className="px-2 py-0.5 text-[9px] border" style={{ borderRadius: 'var(--ui-border-radius)', background: 'var(--color-recording-bg)', color: 'var(--color-recording)', borderColor: 'color-mix(in srgb, var(--color-recording) 30%, transparent)', ...ckHover('recordingColor') }}>● Recording</button>
            <button className="px-2 py-0.5 text-[9px] border" style={{ borderRadius: 'var(--ui-border-radius)', background: 'var(--color-replay-bg)', color: 'var(--color-replay)', borderColor: 'color-mix(in srgb, var(--color-replay) 30%, transparent)', ...ckHover('replayColor') }}>▶ Replay</button>
            <span className="flex-1" />
            <button className="px-2 py-0.5 text-[9px] border" style={{ borderRadius: 'var(--ui-border-radius)', background: 'var(--color-clicker-bg)', color: 'var(--color-clicker)', borderColor: 'var(--color-clicker-border)', ...ckHover('clickerColor') }}>Clicker</button>
          </div>
          {/* Status bar */}
          <div className="flex items-center gap-1 px-2 h-6 bg-bg-base border-t border-border-subtle text-[9px] text-text-tertiary shrink-0">
            <span style={{ color: 'var(--color-replay)' }}>Ready</span>
            <span className="flex-1" />
            <span>127 actions</span>
          </div>
        </div>
      </div>
    );
  }
}
