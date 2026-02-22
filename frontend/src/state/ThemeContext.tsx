import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { ThemeColors, ThemeConfig, ThemeUISettings, ExportedTheme } from '../themes';
import {
  themes,
  THEME_COLOR_KEYS,
  DEFAULT_UI_SETTINGS,
  getThemeById,
  loadThemeConfig,
  saveThemeConfig,
  resolveThemeColors,
  applyThemeConfig,
  deriveAccentVariants,
  validateExportedTheme,
  findClosestPreset,
} from '../themes';

interface ThemeContextValue {
  /** Current persisted config */
  config: ThemeConfig;
  /** Base colors merged with overrides */
  resolvedColors: ThemeColors;

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
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<ThemeConfig>(loadThemeConfig);

  const resolvedColors = useMemo(() => resolveThemeColors(config), [config]);

  // Apply theme to DOM and persist whenever config changes
  useEffect(() => {
    applyThemeConfig(resolvedColors, config.uiSettings);
    saveThemeConfig(config);
  }, [config, resolvedColors]);

  const selectPreset = useCallback((id: string) => {
    if (!getThemeById(id)) return;
    setConfig(prev => ({
      ...prev,
      baseThemeId: id,
      colorOverrides: {},
    }));
  }, []);

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
      uiSettings: { ...theme.uiSettings },
    });
  }, []);

  const value = useMemo<ThemeContextValue>(() => ({
    config,
    resolvedColors,
    selectPreset,
    setColorOverride,
    clearColorOverride,
    clearAllOverrides,
    setAccentColor,
    setUISetting,
    resetUISettings,
    exportTheme,
    importTheme,
  }), [
    config, resolvedColors, selectPreset, setColorOverride,
    clearColorOverride, clearAllOverrides, setAccentColor,
    setUISetting, resetUISettings, exportTheme, importTheme,
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
