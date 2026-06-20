import { useState, useEffect, useCallback } from 'react';
import { BridgeProvider, useBridge } from './bridge/BridgeContext';
import { AppStateProvider, useAppState } from './state/AppStateContext';
import { SelectionProvider } from './state/SelectionContext';
import { ThemeProvider } from './state/ThemeContext';
import { ToastProvider } from './state/ToastContext';
import { LanguageProvider } from './state/LanguageContext';
import { TitleBar } from './components/TitleBar';
import { ProfilePanel } from './components/ProfilePanel';
import { Toolbar, defaultColumnVisibility } from './components/Toolbar';
import type { ColumnVisibility } from './components/Toolbar';
import { ActionTable } from './components/ActionTable';
import { ActionBar } from './components/ActionBar';
import { SettingsPanel } from './components/SettingsPanel';
import { StatusBar } from './components/StatusBar';
import { Toast } from './components/Toast';
import { TooltipLayer } from './components/common/TooltipLayer';
import { UpdateOverlay } from './components/UpdateOverlay';
import { ExtensionUpdateBanner } from './components/ExtensionUpdateBanner';
import { ClickerDashboard } from './components/ClickerDashboard';
import { CommandPalette } from './components/CommandPalette';
import { SheetPanel } from './components/SheetPanel';
import { ThemeEditor } from './components/ThemeEditor';

// AppShell is rendered inside AppStateProvider so it can read settings to drive
// mode-dependent visuals (Clicker mode glow, ActionTable replacement).
function AppShell() {
  const { settings } = useAppState();
  const { subscribe } = useBridge();
  const isClicker = settings.useCursorClick;

  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [sheetActionIndex, setSheetActionIndex] = useState<number | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Settings panel collapse persists across restarts (unlike the profiles
  // sidebar, which is a transient workspace toggle) — users who tuck it away
  // tend to want it to stay tucked away.
  const [settingsCollapsed, setSettingsCollapsed] = useState(() => localStorage.getItem('ui:settingsCollapsed') === '1');
  // setter prefixed with _ so the strict noUnusedLocals lint allows it through —
  // the Toggle Columns toolbar button is currently disabled so nothing mutates
  // columnVisibility right now. Keep the state pair intact so re-enabling the
  // button later is a one-line rename rather than re-introducing the state.
  const [columnVisibility, _setColumnVisibility] = useState<ColumnVisibility>(defaultColumnVisibility);
  // Theme Editor is mounted at the App level (not inside Toolbar) because its
  // open/close trigger now comes from multiple surfaces (Settings panel's
  // Appearance section, Command Palette, future shortcuts). Listens to the
  // shared cmd:themeeditor event so every caller stays decoupled.
  const [showThemeEditor, setShowThemeEditor] = useState(false);
  useEffect(() => {
    const handler = () => setShowThemeEditor(prev => !prev);
    window.addEventListener('cmd:themeeditor', handler);
    return () => window.removeEventListener('cmd:themeeditor', handler);
  }, []);

  // Global keyboard handler: Ctrl+K for command palette, Ctrl+S to save profile,
  // Ctrl+Z/Y for undo/redo + block UI interaction keys.
  // Bridge-bound actions (save/undo/redo) fire as custom events; Toolbar (which has
  // useBridge access) listens and forwards to C#.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Windows-only app: gate shortcuts on Ctrl alone. metaKey (the Windows key)
      // is intentionally excluded so Win+K/S/Z/Y don't trigger these.
      const ctrl = e.ctrlKey;
      if (ctrl && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setCmdPaletteOpen(prev => !prev);
        return;
      }

      // Allow keys inside inputs/textareas (user is actively typing)
      const tag = (e.target as HTMLElement)?.tagName;
      const inEditable = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable;

      if (ctrl && !inEditable) {
        if (e.key === 's' || e.key === 'S') {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('cmd:save'));
          return;
        }
        if ((e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('cmd:undo'));
          return;
        }
        if (e.key === 'y' || e.key === 'Y' || ((e.key === 'z' || e.key === 'Z') && e.shiftKey)) {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('cmd:redo'));
          return;
        }
      }

      if (inEditable) return;

      // Don't swallow keys aimed at a focused interactive control — Space/Enter
      // are how the browser activates buttons/checkboxes/links (it synthesizes a
      // click), and arrows drive selects. closest() catches nested targets too
      // (e.g. an icon inside a <button>).
      const interactive = (e.target as HTMLElement)?.closest?.(
        'button, a[href], select, summary, [role="button"], [role="checkbox"], [tabindex]'
      );
      if (interactive) return;

      // Block Tab, Space, Enter, arrows from interacting with UI elements
      if (['Tab', ' ', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleOpenCommandPalette = useCallback(() => {
    setCmdPaletteOpen(true);
  }, []);

  const handleOpenSheet = useCallback((index: number) => {
    setSheetActionIndex(index);
  }, []);

  const handleToggleSidebar = useCallback(() => {
    setSidebarCollapsed(prev => !prev);
  }, []);

  const handleToggleSettings = useCallback(() => {
    setSettingsCollapsed(prev => {
      localStorage.setItem('ui:settingsCollapsed', prev ? '0' : '1');
      return !prev;
    });
  }, []);

  // Command palette triggers — sidebar toggle is in App state, so listen here
  useEffect(() => {
    const handler = () => setSidebarCollapsed(prev => !prev);
    window.addEventListener('cmd:togglesidebar', handler);
    return () => window.removeEventListener('cmd:togglesidebar', handler);
  }, []);

  // Backend asks the editor to open for a specific row (currently fired after
  // a capture-first insert for Wait Image / Wait Pixel — the row exists but
  // still needs timing / tolerance / etc configured). Hosting the subscription
  // here because sheetActionIndex lives in App-level state.
  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === 'sheet:openIndex') {
        setSheetActionIndex(msg.payload.index);
      }
    });
  }, [subscribe]);

  return (
    <div className="h-full flex flex-col bg-bg-base">
      {/* Title Bar */}
      <TitleBar onOpenCommandPalette={handleOpenCommandPalette} />

      {/* Main Content: 3-column layout — 1px gutters between panels (user request) */}
      <div className="flex-1 flex gap-px px-2 py-1 min-h-0">
        {/* Left: Profiles */}
        <ProfilePanel
          collapsed={sidebarCollapsed}
          onToggleCollapse={handleToggleSidebar}
        />

        {/* Center: Toolbar + Table + Action Bar */}
        <div className="flex-1 flex flex-col gap-px min-w-0">
          <ExtensionUpdateBanner />
          {/* Toolbar takes no props right now — Toggle Columns is disabled there
              (see Toolbar.tsx) so columnVisibility / setColumnVisibility don't
              need to thread through. ActionTable still receives columnVisibility
              directly from this same state below. */}
          <Toolbar />
          {isClicker ? (
            <ClickerDashboard />
          ) : (
            <ActionTable
              columnVisibility={columnVisibility}
              onOpenSheet={handleOpenSheet}
            />
          )}
          <ActionBar />
        </div>

        {/* Right: Settings */}
        <SettingsPanel
          collapsed={settingsCollapsed}
          onToggleCollapse={handleToggleSettings}
        />
      </div>

      {/* Status Bar */}
      <StatusBar />
      <Toast />

      {/* Overlays */}
      <CommandPalette
        isOpen={cmdPaletteOpen}
        onClose={() => setCmdPaletteOpen(false)}
      />
      <SheetPanel
        actionIndex={sheetActionIndex}
        onClose={() => setSheetActionIndex(null)}
      />
      {showThemeEditor && <ThemeEditor onClose={() => setShowThemeEditor(false)} />}
      <UpdateOverlay />

      {/* One global tooltip renderer driving every [data-tip] in the app */}
      <TooltipLayer />
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <BridgeProvider>
        <AppStateProvider>
          <SelectionProvider>
            <ToastProvider>
              <LanguageProvider>
                <AppShell />
              </LanguageProvider>
            </ToastProvider>
          </SelectionProvider>
        </AppStateProvider>
      </BridgeProvider>
    </ThemeProvider>
  );
}
