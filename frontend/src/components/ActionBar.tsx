import { Circle, Play, Square, Save, FolderOpen, MousePointerClick, ListOrdered } from 'lucide-react';
import { useAppState } from '../state/AppStateContext';
import { useBridge } from '../bridge/BridgeContext';
import { useSelectionRef } from '../state/SelectionContext';
import { useTt } from '../state/LanguageContext';

// Shared min-width for the primary action buttons so the layout doesn't shift when
// labels swap (Recording↔Pause, Replay↔Stop, Click↔Stop). Comfortably fits the longest
// label ("Recording") with its icon and padding at text-[13px] font-semibold.
const PRIMARY_BTN = 'min-w-[120px] justify-center';

export function ActionBar() {
  const { buttonStates, settings, actions } = useAppState();
  const { send } = useBridge();
  const selectionRef = useSelectionRef();
  const tt = useTt();
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
  // Ink comes from the per-fill --color-*-ink tokens (contrast-picked in
  // applyThemeConfig) — the fills are user-configurable, so a hardcoded
  // text-white can land at ≈ 2:1 (it did, on the default replay green).
  const recordBtnClass = isRecording
    ? 'bg-accent-solid hover:bg-accent-solid/80 text-[color:var(--color-accent-ink)]'
    : 'bg-recording hover:bg-recording/80 text-[color:var(--color-recording-ink)]';

  const replayBtnClass = isReplaying
    ? 'bg-accent-solid hover:bg-accent-solid/80 text-[color:var(--color-accent-ink)]'
    : (isClicker
        ? 'bg-[var(--color-clicker)] hover:opacity-85 text-[color:var(--color-clicker-ink)]'
        : 'bg-replay hover:bg-replay/80 text-[color:var(--color-replay-ink)]');

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
            data-tip={tt('Run the recorded actions in order', 'Executa as ações gravadas em ordem')}
          >
            {/* ListOrdered (not Play) so the mode pill doesn't visually duplicate the Replay
                action button. Both pills now use a "type" icon (Macro = ordered list, Clicker
                = cursor click), keeping the segmented control conceptually uniform. */}
            <ListOrdered size={11} />
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
            data-tip={tt('Click repeatedly at cursor position. Ignores recorded actions and profile hotkeys.', 'Clica repetidamente na posição do cursor. Ignora ações gravadas e hotkeys de perfil.')}
          >
            <MousePointerClick size={11} />
            Clicker
          </button>
        </div>

        {/* Button picker used to live here — moved to the ClickerSection in the side
            panel so the panel is the single source of truth for every Clicker setting. */}

        {/* Divider */}
        <div className="w-px h-6 bg-border-subtle mx-1" />

        {/* Record button — hidden entirely in Clicker mode (the mode swap is the affordance) */}
        {!isClicker && (
          <button
            onClick={() => {
              const sel = selectionRef.current;
              // Match the toolbar's add-action behaviour: insert BEFORE the first selected
              // row (so the selected row flows downward past the new actions), or append
              // to the end when nothing is selected.
              const insertIndex = sel.size > 0 ? Math.min(...sel) : actions.length;
              send({ type: 'recording:toggle', payload: { insertIndex } });
            }}
            disabled={!buttonStates.recordEnabled}
            className={`flex items-center gap-2 px-5 py-2 rounded text-[13px] font-semibold transition-colors ${recordBtnClass} ${PRIMARY_BTN} ${isRecording ? 'record-btn-glow' : ''} disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            {isRecording
              ? <Square size={11} fill="currentColor" className="shrink-0" />
              : <Circle size={8} fill="currentColor" className="shrink-0" />}
            {buttonStates.recordButtonText}
          </button>
        )}

        {/* Replay/Click button */}
        <button
          onClick={handleReplay}
          disabled={!buttonStates.replayEnabled}
          className={`flex items-center gap-2 px-5 py-2 rounded text-[13px] font-semibold transition-colors ${replayBtnClass} ${PRIMARY_BTN} ${isReplaying ? 'replay-btn-glow' : ''} disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          {isReplaying
            ? <Square size={11} fill="currentColor" className="shrink-0" />
            : isClicker
              ? <MousePointerClick size={12} className="shrink-0" />
              : <Play size={12} fill="currentColor" className="shrink-0" />}
          {buttonStates.replayButtonText}
        </button>
      </div>

      {/* Right: Save + Load — disabled in Clicker mode (profiles wrap recorded actions,
          which Clicker doesn't use). Tooltip explains the disabled state.
          Subtle bg + border so they read as real buttons next to Recording/Replay
          instead of dissolving into ghost-text. Still much quieter than the
          coloured Record/Replay so the visual hierarchy is preserved. */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => send({ type: 'profile:save', payload: {} })}
          disabled={isClicker}
          data-tip={isClicker ? tt('Profiles are unavailable in Clicker mode', 'Perfis não estão disponíveis no modo Clicker') : undefined}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[13px] bg-bg-elevated/40 border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-bg-elevated/40 disabled:hover:text-text-secondary"
        >
          <Save size={14} />
          Save
        </button>
        <button
          onClick={() => send({ type: 'profile:load', payload: {} })}
          disabled={isClicker}
          data-tip={isClicker ? tt('Profiles are unavailable in Clicker mode', 'Perfis não estão disponíveis no modo Clicker') : undefined}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[13px] bg-bg-elevated/40 border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-bg-elevated/40 disabled:hover:text-text-secondary"
        >
          <FolderOpen size={14} />
          Load
        </button>
      </div>
    </div>
  );
}
