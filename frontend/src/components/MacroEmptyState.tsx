import { Circle, ListOrdered } from 'lucide-react';
import { useAppState } from '../state/AppStateContext';
import { useBridge } from '../bridge/BridgeContext';

// Shown inside the ActionTable when the grid has zero actions (Macro mode only —
// Clicker mode swaps the whole table for ClickerDashboard / ClickerEmptyState).
// Mirrors ClickerEmptyState's composition — mode icon, mode name in the mode
// colour, hint line with the relevant hotkey — but in the Macro/replay green and
// with the ListOrdered icon the ActionBar mode pill uses. No background wash:
// the user asked for the plain theme surface here (the green gradient that
// mirrored ClickerEmptyState read as a stain on the grid).
export function MacroEmptyState() {
  const { settings, status, buttonStates } = useAppState();
  const { send } = useBridge();
  const isRecording = status === 'recording';

  return (
    <div className="flex flex-col items-center justify-center gap-2 h-full min-h-[200px] select-none">
      <ListOrdered size={32} style={{ color: 'var(--color-replay)', opacity: 0.7 }} />
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
      {/* Clickable next step (mockup parity) — the hotkey hint alone made the
          empty state a dead end for mouse-first users. Tinted recording style;
          empty grid ⇒ insertIndex 0, same recording:toggle the ActionBar sends. */}
      {!isRecording && (
        <button
          onClick={() => send({ type: 'recording:toggle', payload: { insertIndex: 0 } })}
          disabled={!buttonStates.recordEnabled}
          className="mt-2 flex items-center gap-2 h-8 px-4 rounded text-[12px] font-semibold transition-colors
            text-recording bg-recording/10 border border-recording/30 hover:bg-recording/20
            disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Circle size={9} fill="currentColor" />
          Start recording
        </button>
      )}
    </div>
  );
}
