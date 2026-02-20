import { BridgeProvider } from './bridge/BridgeContext';
import { AppStateProvider } from './state/AppStateContext';
import { TitleBar } from './components/TitleBar';
import { ProfilePanel } from './components/ProfilePanel';
import { Toolbar } from './components/Toolbar';
import { ActionTable } from './components/ActionTable';
import { ActionBar } from './components/ActionBar';
import { SettingsPanel } from './components/SettingsPanel';
import { StatusBar } from './components/StatusBar';

export default function App() {
  return (
    <BridgeProvider>
      <AppStateProvider>
        <div className="h-full flex flex-col bg-bg-base">
          {/* Title Bar */}
          <TitleBar />

          {/* Main Content: 3-column layout */}
          <div className="flex-1 flex gap-2 p-2 min-h-0">
            {/* Left: Profiles */}
            <ProfilePanel />

            {/* Center: Toolbar + Table + Action Bar */}
            <div className="flex-1 flex flex-col gap-1.5 min-w-0">
              <Toolbar />
              <ActionTable />
              <ActionBar />
            </div>

            {/* Right: Settings */}
            <SettingsPanel />
          </div>

          {/* Status Bar */}
          <StatusBar />
        </div>
      </AppStateProvider>
    </BridgeProvider>
  );
}
