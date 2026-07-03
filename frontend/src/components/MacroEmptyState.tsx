import { List } from 'lucide-react';
import { useAppState } from '../state/AppStateContext';

// Shown inside the ActionTable when the grid has zero actions (Macro mode only —
// Clicker mode swaps the whole table for ClickerDashboard / ClickerEmptyState).
// Mirrors ClickerEmptyState's composition — mode icon, mode name in the mode
// colour, hint line with the relevant hotkey — but in the Macro/replay green and
// with the List icon the ActionBar mode pill uses. No background wash:
// the user asked for the plain theme surface here (the green gradient that
// mirrored ClickerEmptyState read as a stain on the grid).
export function MacroEmptyState() {
  const { settings, status } = useAppState();
  const isRecording = status === 'recording';

  return (
    <div className="flex flex-col items-center justify-center gap-2 h-full min-h-[200px] select-none">
      <List size={32} style={{ color: 'var(--color-replay)', opacity: 0.7 }} />
      <div className="text-[14px] font-semibold" style={{ color: 'var(--color-replay)' }}>
        Macro mode
      </div>
      <div className="text-[12px] text-text-tertiary text-center max-w-[420px] px-4">
        {isRecording ? (
          <span className="font-medium text-recording">Recording — waiting for input…</span>
        ) : (
          <>
            No actions recorded.
            {' '}Press{' '}
            <kbd className="kbd kbd-accent">{settings.recordingHotkey}</kbd>
            {' '}to start recording.
          </>
        )}
      </div>
    </div>
  );
}
