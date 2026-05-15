import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { ThemeColors, ThemeConfig, ThemeUISettings, ExportedTheme, CustomThemePreset } from '../themes';
import {
  themes,
  THEME_COLOR_KEYS,
  DEFAULT_UI_SETTINGS,
  DEFAULT_THEME_ID,
  getThemeById,
  loadThemeConfig,
  saveThemeConfig,
  resolveThemeColors,
  applyThemeConfig,
  deriveAccentVariants,
  validateExportedTheme,
  findClosestPreset,
  loadCustomPresets,
  saveCustomPresets,
  makeCustomPresetId,
} from '../themes';

interface ThemeContextValue {
  /** Current persisted config */
  config: ThemeConfig;
  /** Base colors merged with overrides */
  resolvedColors: ThemeColors;

  /** User-saved presets (separate from built-in themes) */
  customPresets: CustomThemePreset[];

  /** Pick a preset — clears color overrides, keeps UI settings */
  selectPreset: (id: string) => void;

  /** Override a single color key */
  setColorOverride: (key: keyof ThemeColors, value: string) => void;
  /** Remove a single color override (reverts to base) */
  clearColorOverride: (key: keyof ThemeColors) => void;
  /** Remove all color overrides */
  clearAllOverrides: () => void;

  /** Set accent + auto-derive solid/hover */
  setAccentColor: (hex: string) => void;

  /** Update a UI setting (fontSize, borderRadius, rowHeight) */
  setUISetting: <K extends keyof ThemeUISettings>(key: K, value: ThemeUISettings[K]) => void;
  /** Reset all UI settings to defaults */
  resetUISettings: () => void;

  /** Export current resolved theme as JSON object */
  exportTheme: (name: string) => ExportedTheme;
  /** Import a theme — sets closest preset + overrides */
  importTheme: (theme: ExportedTheme) => void;

  /** Save current resolved colors as a named custom preset and switch to it */
  saveAsPreset: (name: string) => void;
  /** Remove a custom preset by id */
  deleteCustomPreset: (id: string) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<ThemeConfig>(loadThemeConfig);
  const [customPresets, setCustomPresets] = useState<CustomThemePreset[]>(loadCustomPresets);

  const resolvedColors = useMemo(() => resolveThemeColors(config, customPresets), [config, customPresets]);

  // Match the OS prefers-color-scheme media query when matchSystemTheme is on.
  // Switches between darkPresetId / lightPresetId, preserving UI settings. Idempotent:
  // a second listener firing with the same preference is a no-op thanks to the
  // baseThemeId equality check inside the setter.
  useEffect(() => {
    if (!config.uiSettings.matchSystemTheme) return;
    const mql = window.matchMedia('(prefers-color-scheme: light)');
    const sync = () => {
      const wantId = mql.matches ? config.uiSettings.lightPresetId : config.uiSettings.darkPresetId;
      setConfig(prev => prev.baseThemeId === wantId
        ? prev
        : { ...prev, baseThemeId: wantId, colorOverrides: {} });
    };
    sync();
    mql.addEventListener('change', sync);
    return () => mql.removeEventListener('change', sync);
  }, [config.uiSettings.matchSystemTheme, config.uiSettings.darkPresetId, config.uiSettings.lightPresetId]);

  // Apply theme to DOM, persist, and notify C# bridge whenever config changes
  useEffect(() => {
    applyThemeConfig(resolvedColors, config.uiSettings);
    saveThemeConfig(config);

    // Send theme colors to C# for native dialog styling
    try {
      const webview = (window as any).chrome?.webview;
      if (webview) {
        webview.postMessage({
          type: 'theme:colors',
          payload: {
            bgSurface: resolvedColors['bg-surface'],
            bgCard: resolvedColors['bg-card'],
            textPrimary: resolvedColors['text-primary'],
            textSecondary: resolvedColors['text-secondary'],
            accentSolid: resolvedColors['accent-solid'],
            borderSubtle: resolvedColors['border-subtle'],
          },
        });
      }
    } catch { /* WebView not available (dev mode) */ }
  }, [config, resolvedColors]);

  const selectPreset = useCallback((id: string) => {
    // Built-in OR custom preset — both are valid targets.
    const isBuiltin = !!getThemeById(id);
    const isCustom = customPresets.some(p => p.id === id);
    if (!isBuiltin && !isCustom) return;
    setConfig(prev => ({
      ...prev,
      baseThemeId: id,
      colorOverrides: {},
      // A manual preset pick is an explicit override — turn off matchSystemTheme so the
      // OS listener doesn't immediately revert the user's choice on the next re-render.
      uiSettings: { ...prev.uiSettings, matchSystemTheme: false },
    }));
  }, [customPresets]);

  const setColorOverride = useCallback((key: keyof ThemeColors, value: string) => {
    setConfig(prev => ({
      ...prev,
      colorOverrides: { ...prev.colorOverrides, [key]: value },
    }));
  }, []);

  const clearColorOverride = useCallback((key: keyof ThemeColors) => {
    setConfig(prev => {
      const next = { ...prev.colorOverrides };
      delete next[key];
      return { ...prev, colorOverrides: next };
    });
  }, []);

  const clearAllOverrides = useCallback(() => {
    setConfig(prev => ({ ...prev, colorOverrides: {} }));
  }, []);

  const setAccentColor = useCallback((hex: string) => {
    const variants = deriveAccentVariants(hex);
    setConfig(prev => ({
      ...prev,
      colorOverrides: {
        ...prev.colorOverrides,
        accent: variants.accent,
        'accent-solid': variants['accent-solid'],
        'accent-hover': variants['accent-hover'],
      },
    }));
  }, []);

  const setUISetting = useCallback(<K extends keyof ThemeUISettings>(key: K, value: ThemeUISettings[K]) => {
    setConfig(prev => ({
      ...prev,
      uiSettings: { ...prev.uiSettings, [key]: value },
    }));
  }, []);

  const resetUISettings = useCallback(() => {
    setConfig(prev => ({
      ...prev,
      uiSettings: { ...DEFAULT_UI_SETTINGS },
    }));
  }, []);

  const exportTheme = useCallback((name: string): ExportedTheme => {
    return {
      name,
      version: 1,
      colors: resolvedColors,
      uiSettings: { ...config.uiSettings },
    };
  }, [resolvedColors, config.uiSettings]);

  // Persist custom presets whenever the list changes
  useEffect(() => {
    saveCustomPresets(customPresets);
  }, [customPresets]);

  const saveAsPreset = useCallback((name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const id = makeCustomPresetId(trimmed);
    // Use a 4-color preview that follows the same convention as built-in presets:
    // [base, surface, card, accent] — gives a glanceable feel of the theme.
    const preview: [string, string, string, string] = [
      resolvedColors['bg-base'],
      resolvedColors['bg-surface'],
      resolvedColors['bg-card'],
      resolvedColors.accent,
    ];
    const preset: CustomThemePreset = {
      __custom: true,
      id,
      name: trimmed,
      preview,
      colors: { ...resolvedColors },
    };
    setCustomPresets(prev => {
      // Replace if same id (saving twice with the same name updates instead of duplicating).
      const filtered = prev.filter(p => p.id !== id);
      return [...filtered, preset];
    });
    // Switch to the newly-saved preset — overrides are cleared because the saved
    // colors already capture the user's customizations.
    setConfig(prev => ({
      ...prev,
      baseThemeId: id,
      colorOverrides: {},
    }));
  }, [resolvedColors]);

  const deleteCustomPreset = useCallback((id: string) => {
    setCustomPresets(prev => prev.filter(p => p.id !== id));
    // If the deleted preset is currently selected, fall back to the default theme.
    setConfig(prev => prev.baseThemeId === id
      ? { ...prev, baseThemeId: DEFAULT_THEME_ID, colorOverrides: {} }
      : prev);
  }, []);

  const importTheme = useCallback((theme: ExportedTheme) => {
    if (!validateExportedTheme(theme)) return;

    const baseId = findClosestPreset(theme.colors);
    const base = getThemeById(baseId) ?? themes[0];

    // Only store overrides for colors that differ from the base preset
    const overrides: Partial<ThemeColors> = {};
    for (const key of THEME_COLOR_KEYS) {
      if (theme.colors[key] !== base.colors[key]) {
        overrides[key] = theme.colors[key];
      }
    }

    setConfig({
      version: 1,
      baseThemeId: baseId,
      colorOverrides: overrides,
      uiSettings: { ...DEFAULT_UI_SETTINGS, ...theme.uiSettings },
    });
  }, []);

  const value = useMemo<ThemeContextValue>(() => ({
    config,
    resolvedColors,
    customPresets,
    selectPreset,
    setColorOverride,
    clearColorOverride,
    clearAllOverrides,
    setAccentColor,
    setUISetting,
    resetUISettings,
    exportTheme,
    importTheme,
    saveAsPreset,
    deleteCustomPreset,
  }), [
    config, resolvedColors, customPresets, selectPreset, setColorOverride,
    clearColorOverride, clearAllOverrides, setAccentColor,
    setUISetting, resetUISettings, exportTheme, importTheme,
    saveAsPreset, deleteCustomPreset,
  ]);

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
