import { useState, useEffect, useCallback } from 'react';
import { BridgeProvider, useBridge } from './bridge/BridgeContext';
import { AppStateProvider, useAppState } from './state/AppStateContext';
import { SelectionProvider } from './state/SelectionContext';
import { ThemeProvider } from './state/ThemeContext';
import { ToastProvider } from './state/ToastContext';
import { TitleBar } from './components/TitleBar';
import { ProfilePanel } from './components/ProfilePanel';
import { Toolbar, defaultColumnVisibility } from './components/Toolbar';
import type { ColumnVisibility } from './components/Toolbar';
import { ActionTable } from './components/ActionTable';
import { ActionBar } from './components/ActionBar';
import { SettingsPanel } from './components/SettingsPanel';
import { StatusBar } from './components/StatusBar';
import { Toast } from './components/Toast';
import { UpdateOverlay } from './components/UpdateOverlay';
import { ExtensionUpdateBanner } from './components/ExtensionUpdateBanner';
import { ClickerEmptyState } from './components/ClickerEmptyState';
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
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibility>(defaultColumnVisibility);
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
      const ctrlOrMeta = e.ctrlKey || e.metaKey;
      if (ctrlOrMeta && e.key === 'k') {
        e.preventDefault();
        setCmdPaletteOpen(prev => !prev);
        return;
      }

      // Allow keys inside inputs/textareas (user is actively typing)
      const tag = (e.target as HTMLElement)?.tagName;
      const inEditable = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable;

      if (ctrlOrMeta && !inEditable) {
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

      {/* Main Content: 3-column layout */}
      <div className="flex-1 flex gap-1 px-2 py-1 min-h-0">
        {/* Left: Profiles */}
        <ProfilePanel
          collapsed={sidebarCollapsed}
          onToggleCollapse={handleToggleSidebar}
        />

        {/* Center: Toolbar + Table + Action Bar */}
        <div className="flex-1 flex flex-col gap-1 min-w-0">
          <ExtensionUpdateBanner />
          <Toolbar />
          {isClicker ? (
            <ClickerEmptyState />
          ) : (
            <ActionTable
              columnVisibility={columnVisibility}
              onColumnVisibilityChange={setColumnVisibility}
              onOpenSheet={handleOpenSheet}
            />
          )}
          <ActionBar />
        </div>

        {/* Right: Settings */}
        <SettingsPanel />
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
              <AppShell />
            </ToastProvider>
          </SelectionProvider>
        </AppStateProvider>
      </BridgeProvider>
    </ThemeProvider>
  );
}
