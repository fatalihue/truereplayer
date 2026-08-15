import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import type { Dispatch, SetStateAction, MutableRefObject } from 'react';
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
import { useCommandToggle } from './hooks/useCommandToggle';

// Deferred: these four are already mounted conditionally, but a STATIC import still puts them in
// the startup chunk, so every launch parsed and compiled ~3700 lines (plus their dependencies) for
// panels most sessions never open — inside the window the ui:ready watchdog is timing. lazy() moves
// that to first open. Suspense fallback is null because each one is a full-surface overlay that
// only appears after a deliberate click; there is no layout to hold open.
const ThemeEditor = lazy(() => import('./components/ThemeEditor').then(m => ({ default: m.ThemeEditor })));
const DataPanel = lazy(() => import('./components/DataPanel').then(m => ({ default: m.DataPanel })));
const AutomationPanel = lazy(() => import('./components/AutomationPanel').then(m => ({ default: m.AutomationPanel })));
const RunReportPanel = lazy(() => import('./components/RunReportPanel').then(m => ({ default: m.RunReportPanel })));

// Renders null — this component exists solely to isolate the useTheme() subscription. The zoom
// setting is the only theme-derived value the shell logic needs, and subscribing AppShell
// itself to ThemeContext re-rendered the entire three-column layout on every theme edit
// (each color tweak in the Theme Editor included).
//
// Responsive auto-collapse — pairs with the C# window minimum dropping to
// 960px (half a 1080p display, the side-by-side-with-the-game arrangement):
// when the window crosses below the threshold, both side panels fold to
// their icon rails so the action grid keeps a usable width. Crossing-only
// logic (not continuous) so a panel the user expands while narrow STAYS
// expanded; panels WE collapsed re-expand when the window widens again.
// Deliberately bypasses handleToggleSettings so the auto state never
// touches the persisted ui:settingsCollapsed preference.
function AutoCollapseOnZoom({ setSidebarCollapsed, setSettingsCollapsed, autoCollapsedRef }: {
  setSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
  setSettingsCollapsed: Dispatch<SetStateAction<boolean>>;
  // Must be the SAME ref object AppShell's manual-toggle handlers write to — a manual toggle
  // clears these flags to take ownership, and the responsive logic must see that immediately.
  autoCollapsedRef: MutableRefObject<{ sidebar: boolean; settings: boolean }>;
}) {
  // The threshold is expressed in LAYOUT px and scaled by the UI zoom setting
  // (root.style.zoom, default 90%): zoom scales the layout, not innerWidth, so
  // the same window width fits more/less UI depending on zoom. 1074 layout px
  // ≈ both expanded panels + a usable grid (≡ 967 device px at the 90% default,
  // 1020 back when the default was 95% — a smaller zoom fits more UI in the same
  // window, so the panels correctly hold out to a narrower window before folding).
  const NARROW_THRESHOLD_LAYOUT = 1074;
  const { config: themeConfig } = useTheme();
  const zoomScale = (themeConfig.uiSettings.zoom ?? 90) / 100;
  const wasNarrowRef = useRef(false);
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
    // The prop-passed setters and ref ARE stable (useState setters / a useRef), but the lint
    // can't see that through the prop boundary, so they're listed; the identities never
    // change, so listing them never re-runs the effect.
  }, [zoomScale, setSidebarCollapsed, setSettingsCollapsed, autoCollapsedRef]);
  return null;
}

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
  // Four overlays, one wiring: each is mounted at the App level (not inside the
  // surface that opens it) because its trigger comes from several places at once, so
  // each listens for a shared `cmd:*` window event and every caller stays decoupled.
  // useCommandToggle is that listener; the event names are the contract with the
  // dispatch sites and must not drift.
  //
  //   themeeditor  Settings → Interface, Command Palette
  //   dataeditor   Toolbar button, Command Palette
  //   automation   Settings → App → Automation row (plus the backend push below)
  //   runreport    palette-only (Ctrl+K → "Run report"), same doctrine as Live
  //                Variables: a diagnostic you reach for after something failed,
  //                not a permanent control.
  const [showThemeEditor, setShowThemeEditor] = useCommandToggle('cmd:themeeditor');
  const [showDataEditor, setShowDataEditor] = useCommandToggle('cmd:dataeditor');
  const [showAutomation, setShowAutomation] = useCommandToggle('cmd:automation');
  const [showRunReport, setShowRunReport] = useCommandToggle('cmd:runreport');

  // The Automation panel has a second opener the others don't: the tray
  // "Automations…" item, which arrives as a backend push. It OPENS rather than
  // toggles — a tray click asking for the panel must never be the click that
  // closes it.
  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === 'automation:open') setShowAutomation(true);
    });
  }, [subscribe, setShowAutomation]);

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

  // Set by <AutoCollapseOnZoom> (which owns the responsive auto-collapse logic — it lives
  // outside AppShell to keep the ThemeContext subscription out of the shell) and cleared by
  // the manual-toggle handlers below when the user takes ownership.
  const autoCollapsedRef = useRef({ sidebar: false, settings: false });

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
      {/* Null-rendering: hosts the responsive auto-collapse so its useTheme() subscription
          stays out of AppShell. */}
      <AutoCollapseOnZoom
        setSidebarCollapsed={setSidebarCollapsed}
        setSettingsCollapsed={setSettingsCollapsed}
        autoCollapsedRef={autoCollapsedRef}
      />

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
      <Suspense fallback={null}>
        {showThemeEditor && <ThemeEditor onClose={() => setShowThemeEditor(false)} />}
        {showDataEditor && <DataPanel onClose={() => setShowDataEditor(false)} />}
        {showAutomation && <AutomationPanel onClose={() => setShowAutomation(false)} />}
        {showRunReport && <RunReportPanel onClose={() => setShowRunReport(false)} />}
      </Suspense>
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
