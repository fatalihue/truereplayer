import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

// Optional PT-BR tooltip mode. Names/labels across the app stay in English (universal); only the
// TOOLTIP text is localized. The language lives in localStorage (frontend-only — tooltips never
// touch the backend), survives updates via the pinned WebView2 UserDataFolder, and switches live.
export type Language = 'en' | 'pt-BR';
const STORAGE_KEY = 'tr-language';

function loadLanguage(): Language {
  try { return localStorage.getItem(STORAGE_KEY) === 'pt-BR' ? 'pt-BR' : 'en'; } catch { return 'en'; }
}

type LanguageContextValue = { language: Language; setLanguage: (l: Language) => void };
const LanguageContext = createContext<LanguageContextValue>({ language: 'en', setLanguage: () => {} });

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLang] = useState<Language>(loadLanguage);
  const setLanguage = useCallback((l: Language) => {
    setLang(l);
    try { localStorage.setItem(STORAGE_KEY, l); } catch { /* quota — ignore */ }
  }, []);
  return <LanguageContext.Provider value={{ language, setLanguage }}>{children}</LanguageContext.Provider>;
}

export function useLanguage() { return useContext(LanguageContext); }

// tt('English text', 'Texto PT-BR') → the right string for the current language. Use it for tooltip
// text only. Keep tokens ({clipboard}), hotkeys (Ctrl, PageDown) and units (ms, px, %) in English
// inside the PT-BR string too. Returns a memoised fn so consumers re-render on language change.
export function useTt() {
  const { language } = useContext(LanguageContext);
  return useCallback((en: string, ptBr: string) => (language === 'pt-BR' ? ptBr : en), [language]);
}
