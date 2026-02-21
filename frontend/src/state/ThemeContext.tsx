import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import { themes, DEFAULT_THEME_ID, applyTheme, getThemeById } from '../themes';

const STORAGE_KEY = 'truereplay-theme';

interface ThemeContextValue {
  activeThemeId: string;
  setTheme: (id: string) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  activeThemeId: DEFAULT_THEME_ID,
  setTheme: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [activeThemeId, setActiveThemeId] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved && getThemeById(saved) ? saved : DEFAULT_THEME_ID;
  });

  // Apply theme on mount and whenever it changes
  useEffect(() => {
    const theme = getThemeById(activeThemeId) ?? themes[0];
    applyTheme(theme);
  }, [activeThemeId]);

  const setTheme = useCallback((id: string) => {
    if (getThemeById(id)) {
      setActiveThemeId(id);
      localStorage.setItem(STORAGE_KEY, id);
    }
  }, []);

  return (
    <ThemeContext.Provider value={{ activeThemeId, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
