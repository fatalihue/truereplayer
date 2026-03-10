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
import { UpdateBanner } from './components/UpdateBanner';
import { CommandPalette } from './components/CommandPalette';
import { SheetPanel } from './components/SheetPanel';

export default function App() {
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [sheetActionIndex, setSheetActionIndex] = useState<number | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibility>(defaultColumnVisibility);

  // Global Ctrl+K listener for command palette
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setCmdPaletteOpen(prev => !prev);
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
            <UpdateBanner />

            {/* Main Content: 3-column layout */}
            <div className="flex-1 flex gap-2 p-2 min-h-0">
              {/* Left: Profiles */}
              <ProfilePanel
                collapsed={sidebarCollapsed}
                onToggleCollapse={handleToggleSidebar}
              />

              {/* Center: Toolbar + Table + Action Bar */}
              <div className="flex-1 flex flex-col gap-1.5 min-w-0">
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
          </div>
          </ToastProvider>
          </SelectionProvider>
        </AppStateProvider>
      </BridgeProvider>
    </ThemeProvider>
  );
}
