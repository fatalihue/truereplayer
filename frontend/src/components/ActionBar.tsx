import { Circle, Play, Square, Save, FolderOpen, MousePointerClick, List } from 'lucide-react';
import { SegmentedControl } from './common/SegmentedControl';
import { useAppState } from '../state/AppStateContext';
import { useBridge } from '../bridge/BridgeContext';
import { useSelectionRef } from '../state/SelectionContext';
import { useTt } from '../state/LanguageContext';
import { chipOn } from './common/chipStyles';

// Shared min-width for the primary action buttons so the layout doesn't shift when
// labels swap (Recording↔Pause, Replay↔Stop, Click↔Stop). Comfortably fits the longest
// label ("Recording") with its icon and padding at text-[13px] font-semibold.
const PRIMARY_BTN = 'min-w-[120px] justify-center';

export function ActionBar() {
  const { buttonStates, settings, actions, profileLoop, profiles, activeProfile, dataTable } = useAppState();
  const { send } = useBridge();
  const selectionRef = useSelectionRef();
  const tt = useTt();
  const isClicker = settings.useCursorClick;
  const isReplaying = buttonStates.replayActive;
  const isRecording = buttonStates.recordingActive;

  const handleReplay = () => {
    // Empty payload on purpose — the backend resolves the loop settings itself. Sending
    // React's `settings` slice back is what made this button run the previous profile's
    // count: no profile-activation path refreshes that slice.
    send({ type: 'replay:toggle', payload: {} });
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
  // White text on all three primary fills (owner preference — the contrast-
  // picked dark ink read as unattractive on the saturated Record/Replay/Click
  // colours). The --color-*-ink tokens still drive the quieter confirm buttons.
  const recordBtnClass = isRecording
    ? 'bg-accent-solid hover:bg-accent-solid/80 text-white'
    : 'bg-recording hover:bg-recording/80 text-white';

  // ── Loop chip ──
  // Loops moved out of Settings-as-a-global into the profile, and a value you can only see by
  // opening a side panel is a value that surprises you mid-run. The chip answers "how many
  // passes will this Replay do?" at the point of pressing it.
  //
  // The order below IS the engine's precedence chain (StartReplay + SetForceInfiniteLoop):
  // loop-over-data > forced infinite > the profile's own count. Reporting the raw count while
  // one of the first two is in effect would be a lie — a 40-row data profile showing "3x" is
  // worse than no chip.
  const activeEntry = activeProfile ? profiles.find(p => p.name === activeProfile) : undefined;
  const forcedInfinite = activeEntry?.triggerMode === 'whilePressed' || activeEntry?.triggerMode === 'toggle';
  const perRow = dataTable.loopOverData && dataTable.rows.length > 0;
  // True only when the chip is actually reporting the Loops number. The other two branches
  // report something that OVERRIDES it, and both the accent tint and the unsaved marker below
  // are gated on this — an amber "unsaved Loops" outline around a chip reading "per row" would
  // decorate a value that this run is not going to use.
  const showsCount = !perRow && !forcedInfinite;
  const loopLabel = perRow
    ? tt('per row', 'por linha')
    : forcedInfinite
      ? '∞'
      : profileLoop.enabled
        ? `${profileLoop.count}×`
        : '1×';
  // Quiet by default: only an actual repeat earns the accent tint. A dashed amber outline
  // marks an edit that Ctrl+S has not written yet — the value is live for this session but
  // will not survive a profile switch.
  const loopEmphasised = showsCount && profileLoop.enabled && profileLoop.count !== '1';
  const loopDirty = showsCount && profileLoop.dirty;
  const loopTip = perRow
    ? tt('One run per data row.', 'Uma execução por linha de dados.')
    : forcedInfinite
      ? tt('Runs until you stop it.', 'Roda até você parar.')
      : loopDirty
        ? tt('Repeats per run. Not saved — press Ctrl+S.', 'Repetições por execução. Não salvo — aperte Ctrl+S.')
        : tt('Repeats per run. Change in Settings → Execution.', 'Repetições por execução. Ajuste em Settings → Execution.');

  const replayBtnClass = isReplaying
    ? 'bg-accent-solid hover:bg-accent-solid/80 text-white'
    : (isClicker
        ? 'bg-[var(--color-clicker)] hover:opacity-85 text-white'
        : 'bg-replay hover:bg-replay/80 text-white');

  return (
    <div className="flex items-center justify-between px-4 py-2.5 bg-bg-surface border border-border-subtle rounded-ui">
      {/* Left: Mode toggle + Primary actions */}
      <div className="flex items-center gap-2">
        {/* Mode segmented control — shared primitive; the semantic active tints
            (Macro = replay green, Clicker = clicker purple) ride in via
            activeClass. The macro ring's old hardcoded rgba is now a token mix.
            List (not Play) so the mode pill doesn't visually duplicate the
            Replay action button. Glyphs match the redesign mockup. */}
        <SegmentedControl
          ariaLabel="Execution mode"
          value={isClicker ? 'clicker' : 'macro'}
          onChange={(v) => setMode(v === 'clicker')}
          options={[
            {
              value: 'macro',
              label: 'Macro',
              icon: <List size={11} />,
              // Accent at 12% fill / 40% border — the exact recipe the Settings switches and
              // the field chips use for "on", so the app has ONE intensity for an active
              // control instead of this pill shouting in replay-green next to a quiet switch.
              // Clicker deliberately keeps its own purple: that one is a MODE identity, not an
              // on/off state, and the two pills must stay tellable apart at a glance.
              activeClass: 'bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] text-accent shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent)_40%,transparent)]',
            },
            {
              value: 'clicker',
              label: 'Clicker',
              icon: <MousePointerClick size={11} />,
              activeClass: 'bg-[var(--color-clicker-bg)] text-[var(--color-clicker)] shadow-[inset_0_0_0_1px_var(--color-clicker-border)]',
            },
          ]}
        />

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
              ? <Square size={11} fill="white" className="shrink-0" />
              : <Circle size={8} fill="white" className="shrink-0" />}
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
            ? <Square size={11} fill="white" className="shrink-0" />
            : isClicker
              ? <MousePointerClick size={12} className="shrink-0" />
              : <Play size={12} fill="white" className="shrink-0" />}
          {buttonStates.replayButtonText}
        </button>

        {/* Loop chip — macro only. Clicker has its own loop control in the side panel
            (ClickerSection), HandleReplayToggle returns before reading any of this in Clicker
            mode, and Save/Load next to it are already disabled there — so showing a macro loop
            count in Clicker mode would describe a number nothing is going to use. */}
        {!isClicker && (
          <span
            data-tip={loopTip}
            className={`h-7 px-2 flex items-center justify-center rounded border text-[11px] font-mono tabular-nums select-none ${
              loopEmphasised ? 'text-accent-solid' : 'text-text-tertiary'
            } ${loopDirty ? 'border-dashed' : ''}`}
            style={
              loopDirty
                ? {
                    // Amber, not the accent: "pending" must not read as "on". Dashed border
                    // carries the state a second way, for the low-contrast themes where a hue
                    // shift alone drops below readable (see the toggle-two-channel note).
                    borderColor: 'color-mix(in srgb, var(--color-warning) 55%, transparent)',
                    background: 'color-mix(in srgb, var(--color-warning) 12%, transparent)',
                  }
                : loopEmphasised
                  ? chipOn
                  : { borderColor: 'var(--color-border-default)', background: 'var(--color-bg-input)' }
            }
          >
            {loopLabel}
          </span>
        )}
      </div>

      {/* Right: Save + Load — disabled in Clicker mode (profiles wrap recorded actions,
          which Clicker doesn't use). Tooltip explains the disabled state.
          Subtle bg + border so they read as real buttons next to Recording/Replay
          instead of dissolving into ghost-text. Still much quieter than the
          coloured Record/Replay so the visual hierarchy is preserved. */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => send({ type: 'profile:save', payload: {} })}
          disabled={isClicker}          className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[13px] bg-bg-elevated/40 border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-bg-elevated/40 disabled:hover:text-text-secondary"
        >
          <Save size={14} />
          Save
        </button>
        <button
          onClick={() => send({ type: 'profile:load', payload: {} })}
          disabled={isClicker}          className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[13px] bg-bg-elevated/40 border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-bg-elevated/40 disabled:hover:text-text-secondary"
        >
          <FolderOpen size={14} />
          Load
        </button>
      </div>
    </div>
  );
}
