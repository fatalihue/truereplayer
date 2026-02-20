import { useAppState } from '../state/AppStateContext';

export function StatusBar() {
  const { statusBar } = useAppState();

  return (
    <div className="flex items-center h-[26px] px-4 bg-bg-base border-t border-border-subtle shrink-0">
      <span className="text-[11px] text-text-disabled">{statusBar.directory}</span>
      <div className="w-px h-3 bg-border-subtle mx-3" />
      <span className="text-[11px] text-text-disabled">{statusBar.profileName ?? 'No profile'}</span>
      <div className="flex-1" />
      <span className="text-[11px] text-text-disabled">{statusBar.actionCount} actions</span>
      <div className="w-px h-3 bg-border-subtle mx-3" />
      <span className="text-[11px] text-text-disabled">v2.0.0</span>
    </div>
  );
}
