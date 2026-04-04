import { useState, useEffect, useCallback } from 'react';
import { BridgeProvider } from './bridge/BridgeContext';
import { AppStateProvider } from './state/AppStateContext';
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
import { CommandPalette } from './components/CommandPalette';
import { SheetPanel } from './components/SheetPanel';

export default function App() {
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [sheetActionIndex, setSheetActionIndex] = useState<number | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibility>(defaultColumnVisibility);

  // Global keyboard handler: Ctrl+K for command palette + block UI interaction keys
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setCmdPaletteOpen(prev => !prev);
        return;
      }

      // Allow keys inside inputs/textareas (user is actively typing)
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;

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

  return (
    <ThemeProvider>
      <BridgeProvider>
        <AppStateProvider>
          <SelectionProvider>
          <ToastProvider>
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
                <Toolbar
                  columnVisibility={columnVisibility}
                  onColumnVisibilityChange={setColumnVisibility}
                />
                <ActionTable
                  columnVisibility={columnVisibility}
                  onOpenSheet={handleOpenSheet}
                />
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
            <UpdateOverlay />
          </div>
          </ToastProvider>
          </SelectionProvider>
        </AppStateProvider>
      </BridgeProvider>
    </ThemeProvider>
  );
}
