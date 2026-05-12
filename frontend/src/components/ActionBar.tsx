import { Circle, Play, Square, Save, FolderOpen, MousePointerClick } from 'lucide-react';
import { useAppState } from '../state/AppStateContext';
import { useBridge } from '../bridge/BridgeContext';
import { useSelectionRef } from '../state/SelectionContext';

// Shared min-width for the primary action buttons so the layout doesn't shift when
// labels swap (Recording↔Pause, Replay↔Stop, Click↔Stop). Comfortably fits the longest
// label ("Recording") with its icon and padding at text-[13px] font-semibold.
const PRIMARY_BTN = 'min-w-[120px] justify-center';

export function ActionBar() {
  const { buttonStates, settings, actions } = useAppState();
  const { send } = useBridge();
  const selectionRef = useSelectionRef();
  const isClicker = settings.useCursorClick;
  const isReplaying = buttonStates.replayActive;
  const isRecording = buttonStates.recordingActive;

  const handleReplay = () => {
    send({
      type: 'replay:toggle',
      payload: {
        loopEnabled: settings.enableLoop,
        loopCount: settings.loopCount,
        intervalEnabled: settings.loopIntervalEnabled,
        intervalText: settings.loopInterval,
      },
    });
  };

  const setMode = (clicker: boolean) => {
    if (clicker === isClicker) return;
    send({ type: 'settings:change', payload: { key: 'useCursorClick', value: clicker } });
  };

  // Color rules — "busy/stop" states all converge on the blue accent so the user has a
  // single, unambiguous visual cue for "click here to stop":
  //   Macro mode   Recording idle  → red       (start recording)
  //                Pause (busy)    → blue      (stop recording)
  //                Replay idle     → green     (start replay)
  //                Stop (busy)     → blue      (stop replay)
  //   Clicker mode Click idle      → purple    (start clicking)
  //                Stop (busy)     → blue      (stop clicking)
  const recordBtnClass = isRecording
    ? 'bg-accent-solid hover:bg-accent-solid/80'
    : 'bg-recording hover:bg-recording/80';

  const replayBtnClass = isReplaying
    ? 'bg-accent-solid hover:bg-accent-solid/80'
    : (isClicker
        ? 'bg-[var(--color-clicker)] hover:opacity-85'
        : 'bg-replay hover:bg-replay/80');

  return (
    <div className="flex items-center justify-between px-4 py-2.5 bg-bg-surface border border-border-subtle rounded-ui">
      {/* Left: Mode toggle + Primary actions */}
      <div className="flex items-center gap-2">
        {/* Mode segmented control */}
        <div
          className="flex items-center bg-bg-input border border-border-default rounded p-0.5 gap-0.5"
          role="tablist"
          aria-label="Execution mode"
        >
          <button
            role="tab"
            aria-selected={!isClicker}
            onClick={() => setMode(false)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[12px] font-semibold transition-colors ${
              !isClicker
                ? 'bg-replay/15 text-replay shadow-[inset_0_0_0_1px_rgba(107,203,119,0.35)]'
                : 'text-text-tertiary hover:text-text-secondary'
            }`}
            data-tip="Run the recorded actions in order"
          >
            <Play size={11} fill={!isClicker ? 'currentColor' : 'none'} />
            Macro
          </button>
          <button
            role="tab"
            aria-selected={isClicker}
            onClick={() => setMode(true)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[12px] font-semibold transition-colors ${
              isClicker
                ? 'bg-[var(--color-clicker-bg)] text-[var(--color-clicker)] shadow-[inset_0_0_0_1px_var(--color-clicker-border)]'
                : 'text-text-tertiary hover:text-text-secondary'
            }`}
            data-tip="Click repeatedly at cursor position. Ignores recorded actions and profile hotkeys."
          >
            <MousePointerClick size={11} />
            Clicker
          </button>
        </div>

        {/* Cursor button picker (Clicker mode only) */}
        {isClicker && (
          <select
            value={settings.cursorClickButton}
            onChange={(e) => send({ type: 'settings:change', payload: { key: 'cursorClickButton', value: e.target.value } })}
            className="h-8 px-2 text-[12px] font-mono bg-bg-input border border-[var(--color-clicker-border)] rounded text-[var(--color-clicker)] outline-none focus:border-[var(--color-clicker)] cursor-pointer"
            data-tip="Mouse button to click"
          >
            <option value="Left">Left</option>
            <option value="Right">Right</option>
            <option value="Middle">Middle</option>
          </select>
        )}

        {/* Divider */}
        <div className="w-px h-6 bg-border-subtle mx-1" />

        {/* Record button — hidden entirely in Clicker mode (the mode swap is the affordance) */}
        {!isClicker && (
          <button
            onClick={() => {
              const sel = selectionRef.current;
              // Match the toolbar's add-action behaviour: insert AFTER the last selected
              // row (so new recordings flow downward, not above the selection), or append
              // to the end when nothing is selected.
              const insertIndex = sel.size > 0 ? Math.max(...sel) + 1 : actions.length;
              send({ type: 'recording:toggle', payload: { insertIndex } });
            }}
            disabled={!buttonStates.recordEnabled}
            className={`flex items-center gap-2 px-5 py-2 rounded text-[13px] font-semibold text-white transition-colors ${recordBtnClass} ${PRIMARY_BTN} disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            {isRecording
              ? <Square size={11} fill="white" className="shrink-0" />
              : <Circle size={8} fill="white" className="shrink-0" />}
            {buttonStates.recordButtonText}
          </button>
        )}

        {/* Replay/Click button */}
        <button
          onClick={handleReplay}
          disabled={!buttonStates.replayEnabled}
          className={`flex items-center gap-2 px-5 py-2 rounded text-[13px] font-semibold text-white transition-colors ${replayBtnClass} ${PRIMARY_BTN} disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          {isReplaying
            ? <Square size={11} fill="white" className="shrink-0" />
            : isClicker
              ? <MousePointerClick size={12} className="shrink-0" />
              : <Play size={12} fill="white" className="shrink-0" />}
          {buttonStates.replayButtonText}
        </button>
      </div>

      {/* Right: Ghost actions (Save + Load) — disabled in Clicker mode (profiles wrap recorded
          actions, which Clicker doesn't use). Tooltip explains the disabled state to the user. */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => send({ type: 'profile:save', payload: {} })}
          disabled={isClicker}
          data-tip={isClicker ? 'Profiles are unavailable in Clicker mode' : undefined}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[13px] text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-text-tertiary"
        >
          <Save size={14} />
          Save
        </button>
        <button
          onClick={() => send({ type: 'profile:load', payload: {} })}
          disabled={isClicker}
          data-tip={isClicker ? 'Profiles are unavailable in Clicker mode' : undefined}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[13px] text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-text-tertiary"
        >
          <FolderOpen size={14} />
          Load
        </button>
      </div>
    </div>
  );
}
