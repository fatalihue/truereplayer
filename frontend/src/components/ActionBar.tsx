import type { CSSProperties } from 'react';
import { Circle, Play, Square, Save, FolderOpen, MousePointerClick, List } from 'lucide-react';
import { SegmentedControl } from './common/SegmentedControl';
import { Button, BUTTON_VARIANT_CLASSES } from './common/Button';
import { useAppState } from '../state/AppStateContext';
import { useBridge } from '../bridge/BridgeContext';
import { useSelectionRef } from '../state/SelectionContext';
import { useTt } from '../state/LanguageContext';
import { chipOn, chipOff } from './common/chipStyles';

/**
 * THE RAIL — "pilot light".
 *
 * The bar used to carry four control heights (32 / 35 / 28 / 34 px), two font
 * weights that skipped the system's 500, five icon sizes, two disabled
 * intensities and a Save/Load recipe that existed nowhere else in the app. It
 * read as unplanned because it was: every element derived its metrics privately.
 *
 * Now every control on it is 28px, one radius, one icon size, one disabled
 * intensity — and the colour doctrine is inverted to match the rest of the app:
 * a RESTING primary is a tinted outline at the app-wide on-intensity (12% fill /
 * 40% border, the .rail-tinted recipe in index.css), and a SOLID fill means one
 * thing only — this is running, click to stop. Nothing else on the bar is ever
 * solid, which is what makes the running button findable without dimming its
 * neighbours (see the note on fileTip for why dimming them was rejected).
 * See index.css .rail-tinted for the colour rationale.
 */

// Shared geometry for both primaries, so no label swap can move the bar.
// 112px is measured against "Recording" — the longest string the BACKEND can
// place in either slot (WebViewBridge.PushButtonStates owns these labels; the
// frontend renders them verbatim) — at 12px/600 with a 12px glyph and px-3.
// min-w rather than w: an unforeseen longer label grows the slot instead of
// clipping. The transparent border keeps the busy and resting states on
// identical geometry, since .rail-tinted paints a real 1px border.
const RAIL_PRIMARY =
  'inline-flex items-center justify-center gap-1.5 h-7 min-w-[112px] px-3 rounded border border-transparent ' +
  'text-[12px] font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

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

  // Hotkeys are user-configurable and may be cleared entirely, so the suffix has
  // to vanish gracefully rather than render an empty pair of brackets. The combo
  // itself stays English inside the translated sentence (LanguageContext rule).
  const withHotkey = (text: string, hotkey?: string) => (hotkey ? `${text} (${hotkey})` : text);

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
  // Quiet by default: only an actual repeat earns the accent tint. A corner dot marks an
  // edit that Ctrl+S has not written yet — the value is live for this session but will not
  // survive a profile switch. The two are INDEPENDENT and now compose: a profile that
  // repeats 12× with an unsaved count shows the accent skin and the dot together, where the
  // previous amber treatment painted over the emphasis and reported only one of the facts.
  const loopEmphasised = showsCount && profileLoop.enabled && profileLoop.count !== '1';
  const loopDirty = showsCount && profileLoop.dirty;
  const loopTip = perRow
    ? tt('One run per data row.', 'Uma execução por linha de dados.')
    : forcedInfinite
      ? tt('Runs until you stop it.', 'Roda até você parar.')
      : loopDirty
        ? tt('Repeats per run. Not saved — press Ctrl+S.', 'Repetições por execução. Não salvo — aperte Ctrl+S.')
        : tt('Repeats per run. Change in Settings → Execution.', 'Repetições por execução. Ajuste em Settings → Execution.');

  // ── Primary skins ──
  // Resting: the semantic hue at the on-intensity, carried on border + icon. Two
  // tokens go in — the raw hue for the 12% fill, and its per-theme adapted -fg
  // variant for anything that has to stay legible (see adaptHueForInk).
  // Busy: the Button `primary` variant verbatim (accent-solid + the contrast-
  // picked accent ink), which is what every other primary button in the app
  // already is — so "running" looks the same wherever it appears. The glow
  // classes are the shipped ones and keep the MODE hue (red halo for recording,
  // accent halo for replay), so the two busy states stay tellable apart even
  // though the fill converges. Both are gated on html[data-animations].
  const restingStyle = (hue: string, ink: string) =>
    ({ '--rail-hue': hue, '--rail-ink': ink } as CSSProperties);
  const busyClass = `${RAIL_PRIMARY} ${BUTTON_VARIANT_CLASSES.primary}`;
  const restingClass = `${RAIL_PRIMARY} rail-tinted`;

  // Save/Load stay disabled in Clicker mode only (profiles wrap recorded actions,
  // which Clicker doesn't use) — the same gate and the same sentence the Toolbar
  // uses, so one explanation covers the whole column.
  //
  // Deliberately NOT also disabled while a run is live, even though the design
  // sketch dimmed them: Ctrl+S is handled globally in App.tsx and is not gated on
  // the run state, so a disabled Save button would claim something the keyboard
  // would immediately disprove. Same reasoning keeps the mode switch and both
  // primaries on their shipped, backend-owned enablement — every one of those has
  // a global hotkey behind it. The "one thing is running" reading is carried by
  // the fill instead: a solid button is the only solid thing on the bar.
  const fileTip = (en: string, ptBr: string) =>
    isClicker
      ? tt('Not available in Clicker mode — switch to Macro', 'Indisponível no modo Clicker — mude para Macro')
      : tt(en, ptBr);

  return (
    <div className="flex items-center justify-between px-3 py-1.5 bg-bg-surface border border-border-subtle rounded-ui">
      {/* Left: Mode toggle + Primary actions */}
      <div className="flex items-center gap-2">
        {/* Mode segmented control — shared primitive; the semantic active tints
            (Macro = accent, Clicker = clicker purple) ride in via activeClass.
            List (not Play) so the mode pill doesn't visually duplicate the
            Replay action button. `dense` drops it from 32px to the rail's 28. */}
        <SegmentedControl
          ariaLabel="Execution mode"
          dense
          value={isClicker ? 'clicker' : 'macro'}
          onChange={(v) => setMode(v === 'clicker')}
          options={[
            {
              value: 'macro',
              label: 'Macro',
              icon: <List size={12} />,
              tip: tt('Record and replay a list of actions', 'Grave e execute uma lista de ações'),
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
              icon: <MousePointerClick size={12} />,
              tip: tt('Auto-click at a fixed rate', 'Clique automático em ritmo fixo'),
              activeClass: 'bg-[var(--color-clicker-bg)] text-[var(--color-clicker-fg)] shadow-[inset_0_0_0_1px_var(--color-clicker-border)]',
            },
          ]}
        />

        {/* Button picker used to live here — moved to the ClickerSection in the side
            panel so the panel is the single source of truth for every Clicker setting. */}

        {/* Divider — the Toolbar's dimensions, so the top and bottom strips of the
            centre column punctuate identically. */}
        <div className="w-px h-4 bg-border-subtle mx-1" />

        {/* Record button — hidden entirely in Clicker mode (the mode swap is the
            affordance), which lets Click land in exactly this slot. */}
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
            data-tip={
              isRecording
                ? withHotkey(tt('Stop recording', 'Parar a gravação'), settings.recordingHotkey)
                : withHotkey(tt('Record what you do', 'Grave o que você faz'), settings.recordingHotkey)
            }
            className={`${isRecording ? `${busyClass} record-btn-glow` : restingClass}`}
            style={isRecording ? undefined : restingStyle('var(--color-recording)', 'var(--color-recording-fg)')}
          >
            {isRecording
              ? <Square size={12} fill="currentColor" className="shrink-0" />
              : <Circle size={12} fill="currentColor" className="shrink-0" />}
            {buttonStates.recordButtonText}
          </button>
        )}

        {/* Replay/Click button — one physical button for both modes. */}
        <button
          onClick={handleReplay}
          disabled={!buttonStates.replayEnabled}
          data-tip={
            isReplaying
              ? withHotkey(tt('Stop the run', 'Parar a execução'), isClicker ? settings.cursorClickStartHotkey : settings.replayHotkey)
              : isClicker
                ? withHotkey(tt('Start clicking', 'Começar a clicar'), settings.cursorClickStartHotkey)
                : withHotkey(tt('Run the recorded actions', 'Executar as ações gravadas'), settings.replayHotkey)
          }
          className={`${isReplaying ? `${busyClass} replay-btn-glow` : restingClass}`}
          style={isReplaying
            ? undefined
            : isClicker
              ? restingStyle('var(--color-clicker)', 'var(--color-clicker-fg)')
              : restingStyle('var(--color-replay)', 'var(--color-replay-fg)')}
        >
          {isReplaying
            ? <Square size={12} fill="currentColor" className="shrink-0" />
            : isClicker
              ? <MousePointerClick size={12} className="shrink-0" />
              : <Play size={12} fill="currentColor" className="shrink-0" />}
          {buttonStates.replayButtonText}
        </button>

        {/* Loop chip — macro only. Clicker has its own loop control in the side panel
            (ClickerSection), HandleReplayToggle returns before reading any of this in Clicker
            mode, and Save/Load next to it are already disabled there — so showing a macro loop
            count in Clicker mode would describe a number nothing is going to use.
            It stays at full strength during a run, unlike every control around it: it is a
            readout, not a control, and mid-run it names the count this very run is using. */}
        {!isClicker && (
          <span
            data-tip={loopTip}
            // `relative` is explicit rather than inherited from the [data-tip] base rule,
            // because the dot below anchors to it and that rule is not this file's to rely on.
            className={`relative h-7 min-w-9 px-2 flex items-center justify-center rounded border text-[11px] font-mono tabular-nums select-none ${
              loopEmphasised ? 'text-accent-solid' : 'text-text-tertiary'
            }`}
            // The unsaved edit does NOT touch the skin — see .loop-unsaved-dot in
            // index.css. The chip answers one question ("how many passes?") and
            // answers it the same way whether or not the value is written yet.
            style={loopEmphasised ? chipOn : chipOff}
          >
            {loopLabel}
            {loopDirty && <span className="loop-unsaved-dot" aria-hidden="true" />}
          </span>
        )}
      </div>

      {/* Right: Save + Load. These used to carry a hand-rolled fill that existed
          nowhere else in the app, added so they'd "read as real buttons instead of
          dissolving into ghost-text" next to two loud solid primaries. Those solid
          primaries are gone, so the exception goes with them: they are now the same
          ghost vocabulary as the fourteen toolbar buttons at the top of this column,
          which is what makes the column read as one instrument. */}
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="xs"
          onClick={() => send({ type: 'profile:save', payload: {} })}
          disabled={isClicker}
          data-tip={fileTip('Save the current profile (Ctrl+S)', 'Salvar o perfil atual (Ctrl+S)')}
        >
          <Save size={12} />
          Save
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => send({ type: 'profile:load', payload: {} })}
          disabled={isClicker}
          data-tip={fileTip('Load a profile from a file', 'Carregar um perfil de um arquivo')}
        >
          <FolderOpen size={12} />
          Load
        </Button>
      </div>
    </div>
  );
}
