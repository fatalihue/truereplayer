import { useEffect, useRef, useState, useCallback } from 'react';
import { X, Check, RotateCcw, Download, Upload, Clipboard, ClipboardPaste } from 'lucide-react';
import {
  themes,
  DEFAULT_UI_SETTINGS,
  toHex,
  withOriginalAlpha,
  validateExportedTheme,
} from '../themes';
import type { ThemeColors, ExportedTheme } from '../themes';
import { useTheme } from '../state/ThemeContext';

interface ThemeEditorProps {
  onClose: () => void;
}

type TabId = 'presets' | 'colors' | 'appearance' | 'import-export';

const TABS: { id: TabId; label: string }[] = [
  { id: 'presets', label: 'Presets' },
  { id: 'colors', label: 'Colors' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'import-export', label: 'Import / Export' },
];

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

// ── Reusable Color Row ──

function ColorRow({ label, colorKey, value, baseValue, onChange, onReset }: {
  label: string;
  colorKey: keyof ThemeColors;
  value: string;
  baseValue: string;
  onChange: (key: keyof ThemeColors, value: string) => void;
  onReset: (key: keyof ThemeColors) => void;
}) {
  const isOverridden = value !== baseValue;
  const hexValue = toHex(value);

  return (
    <div className="flex items-center gap-2 py-1 group">
      <div className="flex items-center gap-1.5 w-[90px]">
        {isOverridden && <div className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
        <span className={`text-xs ${isOverridden ? 'text-text-primary' : 'text-text-secondary'}`}>{label}</span>
      </div>

      <label className="relative w-7 h-7 rounded border border-border-default cursor-pointer shrink-0 overflow-hidden">
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
        className="w-[80px] h-7 px-2 text-xs font-mono text-text-primary bg-bg-input border border-border-default rounded text-center outline-none focus:border-accent-solid"
      />

      <button
        onClick={() => onReset(colorKey)}
        className={`p-1 rounded text-text-disabled hover:text-text-primary hover:bg-bg-elevated transition-colors ${isOverridden ? 'visible' : 'invisible'}`}
        title="Reset to base"
      >
        <RotateCcw size={12} />
      </button>
    </div>
  );
}

// ── Slider + Input ──

function SliderSetting({ label, value, min, max, unit, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="text-xs text-text-secondary w-[100px]">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 h-1.5 accent-accent-solid"
      />
      <div className="flex items-center gap-1">
        <input
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (n >= min && n <= max) onChange(n);
          }}
          className="w-14 h-7 px-2 text-xs font-mono text-text-primary bg-bg-input border border-border-default rounded text-center outline-none focus:border-accent-solid"
        />
        <span className="text-[11px] text-text-disabled w-5">{unit}</span>
      </div>
    </div>
  );
}

// ── Main ThemeEditor ──

export function ThemeEditor({ onClose }: ThemeEditorProps) {
  const {
    config, resolvedColors, selectPreset,
    setColorOverride, clearColorOverride, clearAllOverrides,
    setAccentColor, setUISetting, resetUISettings,
    exportTheme, importTheme,
  } = useTheme();

  const panelRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<TabId>('presets');
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState('');
  const [copySuccess, setCopySuccess] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const hasOverrides = Object.keys(config.colorOverrides).length > 0;

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Close on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
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
    const theme = exportTheme('My Theme');
    const blob = new Blob([JSON.stringify(theme, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'truereplay-theme.json';
    a.click();
    URL.revokeObjectURL(url);
  }, [exportTheme]);

  const handleCopyClipboard = useCallback(async () => {
    const theme = exportTheme('My Theme');
    await navigator.clipboard.writeText(JSON.stringify(theme, null, 2));
    setCopySuccess(true);
    setTimeout(() => setCopySuccess(false), 2000);
  }, [exportTheme]);

  // ── Import handlers ──

  const doImport = useCallback((json: string) => {
    setImportError('');
    try {
      const parsed = JSON.parse(json);
      if (!validateExportedTheme(parsed)) {
        setImportError('Invalid theme format. Check all required color keys and UI settings.');
        return;
      }
      importTheme(parsed as ExportedTheme);
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
    reader.readAsText(file);
    e.target.value = '';
  }, [doImport]);

  const handlePasteClipboard = useCallback(async () => {
    const text = await navigator.clipboard.readText();
    setImportText(text);
    doImport(text);
  }, [doImport]);

  // Accent color derived from resolved
  const currentAccentHex = toHex(resolvedColors.accent);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        ref={panelRef}
        className="w-[520px] max-h-[80vh] bg-bg-surface border border-border-default rounded-lg shadow-2xl overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border-subtle shrink-0">
          <span className="text-sm font-semibold text-text-primary">Theme Editor</span>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border-subtle shrink-0">
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 py-2.5 text-xs font-medium transition-colors ${
                activeTab === tab.id
                  ? 'text-accent border-b-2 border-accent'
                  : 'text-text-tertiary hover:text-text-primary'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto">

          {/* ═══ Tab 1: Presets ═══ */}
          {activeTab === 'presets' && (
            <div className="p-4 space-y-4">
              {/* Preset Grid */}
              <div className="grid grid-cols-4 gap-3">
                {themes.map((theme) => {
                  const isActive = theme.id === config.baseThemeId && !hasOverrides;
                  return (
                    <button
                      key={theme.id}
                      onClick={() => selectPreset(theme.id)}
                      className={`group flex flex-col rounded-lg overflow-hidden border transition-all cursor-pointer ${
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
                  );
                })}
              </div>

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
          )}

          {/* ═══ Tab 2: Colors ═══ */}
          {activeTab === 'colors' && (
            <div className="p-4 space-y-1">
              {COLOR_SECTIONS.map(section => {
                const isCollapsed = collapsedSections.has(section.title);
                return (
                  <div key={section.title} className="border border-border-subtle rounded-md overflow-hidden">
                    <button
                      onClick={() => toggleSection(section.title)}
                      className="w-full flex items-center justify-between px-3 py-2 hover:bg-bg-card transition-colors"
                    >
                      <span className="text-xs font-semibold text-text-primary">{section.title}</span>
                      <span className="text-xs text-text-disabled">{isCollapsed ? '+' : '-'}</span>
                    </button>
                    {!isCollapsed && (
                      <div className="px-3 pb-2">
                        {section.keys.map(key => (
                          <ColorRow
                            key={key}
                            label={COLOR_LABELS[key]}
                            colorKey={key}
                            value={resolvedColors[key]}
                            baseValue={basePreset.colors[key]}
                            onChange={setColorOverride}
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

              {hasOverrides && (
                <div className="pt-2">
                  <button
                    onClick={clearAllOverrides}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs text-text-secondary hover:text-text-primary bg-bg-elevated hover:bg-bg-card border border-border-subtle transition-colors"
                  >
                    <RotateCcw size={12} />
                    Reset all overrides
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ═══ Tab 3: Appearance ═══ */}
          {activeTab === 'appearance' && (
            <div className="p-4 space-y-1">
              <SliderSetting
                label="Font Size"
                value={config.uiSettings.fontSize}
                min={10}
                max={18}
                unit="px"
                onChange={(v) => setUISetting('fontSize', v)}
              />
              <SliderSetting
                label="Border Radius"
                value={config.uiSettings.borderRadius}
                min={0}
                max={16}
                unit="px"
                onChange={(v) => setUISetting('borderRadius', v)}
              />
              <SliderSetting
                label="Row Height"
                value={config.uiSettings.rowHeight}
                min={28}
                max={48}
                unit="px"
                onChange={(v) => setUISetting('rowHeight', v)}
              />
              <div className="pt-3">
                <button
                  onClick={resetUISettings}
                  disabled={
                    config.uiSettings.fontSize === DEFAULT_UI_SETTINGS.fontSize &&
                    config.uiSettings.borderRadius === DEFAULT_UI_SETTINGS.borderRadius &&
                    config.uiSettings.rowHeight === DEFAULT_UI_SETTINGS.rowHeight
                  }
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs text-text-secondary hover:text-text-primary bg-bg-elevated hover:bg-bg-card border border-border-subtle transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <RotateCcw size={12} />
                  Reset to Defaults
                </button>
              </div>
            </div>
          )}

          {/* ═══ Tab 4: Import / Export ═══ */}
          {activeTab === 'import-export' && (
            <div className="p-4 space-y-5">
              {/* Export */}
              <div>
                <h3 className="text-xs font-semibold text-text-primary mb-3">Export</h3>
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
                    {copySuccess ? 'Copied!' : 'Copy to Clipboard'}
                  </button>
                </div>
              </div>

              {/* Import */}
              <div>
                <h3 className="text-xs font-semibold text-text-primary mb-3">Import</h3>
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
      </div>
    </div>
  );
}
