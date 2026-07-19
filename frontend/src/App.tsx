import { useState, useEffect, useCallback, useRef } from 'react';
import { BridgeProvider, useBridge } from './bridge/BridgeContext';
import { AppStateProvider, useAppState } from './state/AppStateContext';
import { SelectionProvider } from './state/SelectionContext';
import { ThemeProvider, useTheme } from './state/ThemeContext';
import { ToastProvider } from './state/ToastContext';
import { LanguageProvider } from './state/LanguageContext';
import { TitleBar } from './components/TitleBar';
import { ProfilePanel } from './components/ProfilePanel';
import { Toolbar, defaultColumnVisibility } from './components/Toolbar';
import type { ColumnVisibility } from './components/Toolbar';
import { ActionTable } from './components/ActionTable';
import { ActionBar } from './components/ActionBar';
import { ReplayProgressLine } from './components/ReplayProgressLine';
import { SettingsPanel } from './components/SettingsPanel';
import { StatusBar } from './components/StatusBar';
import { Toast } from './components/Toast';
import { TooltipLayer } from './components/common/TooltipLayer';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { UpdateOverlay } from './components/UpdateOverlay';
import { AskInputHost } from './components/AskInputDialog';
import { LiveVariablesHost } from './components/LiveVariablesPanel';
import { ExtensionUpdateBanner } from './components/ExtensionUpdateBanner';
import { ClickerDashboard } from './components/ClickerDashboard';
import { CommandPalette } from './components/CommandPalette';
import { SheetPanel } from './components/SheetPanel';
import { ThemeEditor } from './components/ThemeEditor';
import { DataPanel } from './components/DataPanel';
import { AutomationPanel } from './components/AutomationPanel';

// AppShell is rendered inside AppStateProvider so it can read settings to drive
// mode-dependent visuals (Clicker mode glow, ActionTable replacement).
function AppShell() {
  const { settings, buttonStates } = useAppState();
  const { subscribe } = useBridge();
  const isClicker = settings.useCursorClick;

  // Read by the global keydown handler through a ref so the handler can stay
  // bound once (empty deps) instead of re-attaching on every run-state push.
  const runActiveRef = useRef(false);
  runActiveRef.current = buttonStates.recordingActive || buttonStates.replayActive;

  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [sheetActionIndex, setSheetActionIndex] = useState<number | null>(null);
  // Sheet exit choreography — closing keeps the old index mounted while the
  // panel slides out (SheetPanel animates on `leaving`, then calls onExited).
  // With animations off we skip straight to unmount.
  const [sheetLeaving, setSheetLeaving] = useState(false);
  const closeSheet = useCallback(() => {
    if (document.documentElement.getAttribute('data-animations') !== 'true') {
      setSheetActionIndex(null);
      return;
    }
    setSheetLeaving(true);
  }, []);
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
  // Interface section, Command Palette, future shortcuts). Listens to the
  // shared cmd:themeeditor event so every caller stays decoupled.
  const [showThemeEditor, setShowThemeEditor] = useState(false);
  useEffect(() => {
    const handler = () => setShowThemeEditor(prev => !prev);
    window.addEventListener('cmd:themeeditor', handler);
    return () => window.removeEventListener('cmd:themeeditor', handler);
  }, []);

  // Data Loop panel — App-level like the Theme Editor, opened via the shared
  // cmd:dataeditor event (Toolbar button + Command Palette).
  const [showDataEditor, setShowDataEditor] = useState(false);
  useEffect(() => {
    const handler = () => setShowDataEditor(prev => !prev);
    window.addEventListener('cmd:dataeditor', handler);
    return () => window.removeEventListener('cmd:dataeditor', handler);
  }, []);

  // Automation panel — openers: Settings → App → Automation row (cmd:automation)
  // and the tray "Automations…" item (backend automation:open push).
  const [showAutomation, setShowAutomation] = useState(false);
  useEffect(() => {
    const handler = () => setShowAutomation(prev => !prev);
    window.addEventListener('cmd:automation', handler);
    return () => window.removeEventListener('cmd:automation', handler);
  }, []);
  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === 'automation:open') setShowAutomation(true);
    });
  }, [subscribe]);

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

      // Run-active lockout comes BEFORE the interactive early-return — if a
      // control is already focused when a recording/replay starts, a stray
      // Space/Enter/Tab aimed at the game must not actuate it or move focus.
      if (runActiveRef.current
        && ['Tab', ' ', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        return;
      }

      // Don't swallow keys aimed at a focused interactive control — Space/Enter
      // are how the browser activates buttons/checkboxes/links (it synthesizes a
      // click), and arrows drive selects. closest() catches nested targets too
      // (e.g. an icon inside a <button>).
      const interactive = (e.target as HTMLElement)?.closest?.(
        'button, a[href], select, summary, [role="button"], [role="checkbox"], [tabindex]'
      );
      if (interactive) return;

      // Tab from <body> is pure focus NAVIGATION — it never actuates anything —
      // and only idle flows reach this point (the run-active gate above), so it
      // passes through. This is what makes keyboard entry into the UI possible.
      if (e.key === 'Tab') return;

      // Block Space, Enter, arrows from interacting with UI elements
      if ([' ', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
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
    setSheetLeaving(false);
    setSheetActionIndex(index);
  }, []);

  // Responsive auto-collapse — pairs with the C# window minimum dropping to
  // 960px (half a 1080p display, the side-by-side-with-the-game arrangement):
  // when the window crosses below the threshold, both side panels fold to
  // their icon rails so the action grid keeps a usable width. Crossing-only
  // logic (not continuous) so a panel the user expands while narrow STAYS
  // expanded; panels WE collapsed re-expand when the window widens again.
  // Deliberately bypasses handleToggleSettings so the auto state never
  // touches the persisted ui:settingsCollapsed preference.
  //
  // The threshold is expressed in LAYOUT px and scaled by the UI zoom setting
  // (root.style.zoom, default 95%): zoom scales the layout, not innerWidth, so
  // the same window width fits more/less UI depending on zoom. 1074 layout px
  // ≈ both expanded panels + a usable grid (≡ 1020 device px at the 95% default).
  const NARROW_THRESHOLD_LAYOUT = 1074;
  const { config: themeConfig } = useTheme();
  const zoomScale = (themeConfig.uiSettings.zoom ?? 95) / 100;
  const wasNarrowRef = useRef(false);
  const autoCollapsedRef = useRef({ sidebar: false, settings: false });
  useEffect(() => {
    const isNarrow = () => window.innerWidth < NARROW_THRESHOLD_LAYOUT * zoomScale;
    const applyNarrowState = (narrow: boolean) => {
      if (narrow) {
        setSidebarCollapsed(prev => {
          if (!prev) autoCollapsedRef.current.sidebar = true;
          return true;
        });
        setSettingsCollapsed(prev => {
          if (!prev) autoCollapsedRef.current.settings = true;
          return true;
        });
      } else {
        if (autoCollapsedRef.current.sidebar) {
          autoCollapsedRef.current.sidebar = false;
          setSidebarCollapsed(false);
        }
        if (autoCollapsedRef.current.settings) {
          autoCollapsedRef.current.settings = false;
          setSettingsCollapsed(false);
        }
      }
    };
    // Re-evaluate on mount AND whenever the zoom setting changes (a zoom bump
    // can push the layout across the threshold without any window resize).
    const evaluate = () => {
      const narrow = isNarrow();
      if (narrow === wasNarrowRef.current) return;
      wasNarrowRef.current = narrow;
      applyNarrowState(narrow);
    };
    evaluate();
    window.addEventListener('resize', evaluate);
    return () => window.removeEventListener('resize', evaluate);
  }, [zoomScale]);

  const handleToggleSidebar = useCallback(() => {
    // A manual toggle takes ownership — the auto logic must not fight it.
    autoCollapsedRef.current.sidebar = false;
    setSidebarCollapsed(prev => !prev);
  }, []);

  const handleToggleSettings = useCallback(() => {
    autoCollapsedRef.current.settings = false;
    setSettingsCollapsed(prev => {
      localStorage.setItem('ui:settingsCollapsed', prev ? '0' : '1');
      return !prev;
    });
  }, []);

  // Command palette triggers — sidebar toggle is in App state, so listen here.
  // Clears the auto-collapse flag like the header button does: a palette toggle
  // is just as manual, and the responsive logic must not fight it.
  useEffect(() => {
    const handler = () => {
      autoCollapsedRef.current.sidebar = false;
      setSidebarCollapsed(prev => !prev);
    };
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
        setSheetLeaving(false);
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
          {/* Indeterminate green sweep between toolbar and grid while a run is
              live — see ReplayProgressLine. Self-hides when idle. */}
          <ReplayProgressLine />
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
        onClose={closeSheet}
        leaving={sheetLeaving}
        onExited={() => {
          setSheetActionIndex(null);
          setSheetLeaving(false);
        }}
      />
      {showThemeEditor && <ThemeEditor onClose={() => setShowThemeEditor(false)} />}
      {showDataEditor && <DataPanel onClose={() => setShowDataEditor(false)} />}
      {showAutomation && <AutomationPanel onClose={() => setShowAutomation(false)} />}
      <UpdateOverlay />
      <AskInputHost />
      <LiveVariablesHost />

      {/* One global tooltip renderer driving every [data-tip] in the app */}
      <TooltipLayer />
    </div>
  );
}

export default function App() {
  return (
    // Two boundaries: the OUTER one catches provider-level crashes (its
    // fallback carries hardcoded color fallbacks for exactly that case); the
    // INNER one catches shell crashes while keeping the providers alive, so
    // theme variables still style the fallback card.
    <ErrorBoundary>
      <ThemeProvider>
        <BridgeProvider>
          <AppStateProvider>
            <SelectionProvider>
              <ToastProvider>
                <LanguageProvider>
                  <ErrorBoundary>
                    <AppShell />
                  </ErrorBoundary>
                </LanguageProvider>
              </ToastProvider>
            </SelectionProvider>
          </AppStateProvider>
        </BridgeProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
