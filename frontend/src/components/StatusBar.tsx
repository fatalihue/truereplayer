import { useEffect, useRef, useState } from 'react';
import { Play, Pause as PauseIcon, MousePointerClick, Folder, ListOrdered, Gauge, Clock, Repeat } from 'lucide-react';
import { useAppState } from '../state/AppStateContext';
import { useBridge } from '../bridge/BridgeContext';
import { usePauseTick } from '../hooks/usePauseTick';
import { formatClickerStats } from '../utils/clickerFormat';
import { APP_VERSION } from '../appVersion';

// Thin vertical divider between status segments.
const Sep = () => <div className="w-px h-3 bg-border-subtle mx-3 shrink-0" />;

export function StatusBar() {
  const { statusBar, status, highlightedActionIndex, replayChain, pauseState, settings, clickerStats, loopProgress } = useAppState();
  const { send } = useBridge();
  const isReplaying = status === 'replaying';
  const isClicker = settings.useCursorClick;
  // The engine's stack already includes the root profile at index 0, so we only
  // render "Running ..." when the chain has at least 2 entries (root + a sub-call).
  // While running A alone, replayChain is ['A'] and we leave the chain hidden.
  const chainLabel = replayChain.length >= 2 ? replayChain.join(' → ') : null;

  // Elapsed timer. Anchored to Date.now() rather than an accumulating per-tick
  // counter (setInterval is throttled in background tabs / under load, which made
  // the old `prev + 1` drift below wall-clock). Paused intervals are subtracted so a
  // pause no longer inflates the count. Limitation: no backend macro elapsed exists,
  // so this measures from when the UI observes the start/pause edges; a sub-second
  // offset vs the engine's true start is possible, but it no longer drifts.
  const [elapsed, setElapsed] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRef = useRef(0);          // Date.now() at the replay-start edge.
  const pausedAccumRef = useRef(0);    // total resolved paused ms.
  const pauseStartRef = useRef(0);     // Date.now() captured when the current pause began.
  const wasPausedRef = useRef(false);  // previous isPaused, to detect edges.

  useEffect(() => {
    if (!isReplaying) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      startRef.current = 0;
      pausedAccumRef.current = 0;
      pauseStartRef.current = 0;
      wasPausedRef.current = false;
      setElapsed(0);
      return;
    }

    if (startRef.current === 0) {
      startRef.current = Date.now();
      pausedAccumRef.current = 0;
      pauseStartRef.current = 0;
      wasPausedRef.current = false;
    }

    // Pause-begin edge: capture the pause start while pauseState.startedAt is still set.
    if (!wasPausedRef.current && pauseState.isPaused) {
      pauseStartRef.current = pauseState.startedAt > 0 ? pauseState.startedAt : Date.now();
    }
    // Resume edge: fold the just-ended pause in using the CAPTURED start (pauseState.startedAt
    // is already 0 here because replay:resumed zeroes it in the same dispatch).
    if (wasPausedRef.current && !pauseState.isPaused && pauseStartRef.current > 0) {
      pausedAccumRef.current += Math.max(0, Date.now() - pauseStartRef.current);
      pauseStartRef.current = 0;
    }
    wasPausedRef.current = pauseState.isPaused;

    const compute = () => {
      // While paused, freeze: subtract the in-progress pause using the captured start.
      const livePause = pauseState.isPaused && pauseStartRef.current > 0
        ? Math.max(0, Date.now() - pauseStartRef.current)
        : 0;
      const ms = Date.now() - startRef.current - pausedAccumRef.current - livePause;
      setElapsed(Math.max(0, Math.floor(ms / 1000)));
    };
    compute();

    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(compute, 1000);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isReplaying, pauseState.isPaused, pauseState.startedAt]);

  const total = statusBar.actionCount;
  const current = highlightedActionIndex != null ? highlightedActionIndex + 1 : 0;
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  const minutes = Math.floor(elapsed / 60);
  const seconds = String(elapsed % 60).padStart(2, '0');

  usePauseTick(pauseState);

  const pauseRemainingSec = pauseState.timeoutMs > 0
    ? Math.max(0, Math.ceil((pauseState.timeoutMs - (Date.now() - pauseState.startedAt)) / 1000))
    : 0;

  // Clicker mode shows whether it's mid-run (live stats) or idle (config summary).
  const clickerRunning = isReplaying || clickerStats.count > 0;
  // Target rate from the per-click delay (the configured cadence, not the measured
  // one which the live stats below already report). Falls back to 0 on a bad value.
  const targetCps = (() => {
    const d = parseInt(settings.cursorClickDelay, 10);
    return d > 0 ? Math.round(1000 / d) : 0;
  })();

  return (
    <div className="flex items-center h-[26px] px-4 bg-bg-base border-t border-border-subtle shrink-0 text-[11px]">
      {isClicker ? (
        /* ── CLICKER MODE ── profile/action-count are meaningless here, so the bar
            shows the clicker's own context instead: button + target rate when idle,
            live Clicked/rate/elapsed once it's running. */
        clickerRunning ? (() => {
          const { elapsed: clickerElapsed, rateLabel } = formatClickerStats(clickerStats.count, clickerStats.elapsedMs);
          return (
            <span className="flex items-center gap-2 font-mono" style={{ color: 'var(--color-clicker)' }}>
              <MousePointerClick size={11} className="shrink-0" />
              <span className="text-text-secondary">Clicked</span>
              <strong className="text-text-primary">{clickerStats.count.toLocaleString()}</strong>
              <span className="text-text-disabled">·</span>
              <strong className="text-text-primary">{rateLabel}/s</strong>
              <span className="text-text-disabled">·</span>
              <span className="flex items-center gap-1 text-text-secondary"><Clock size={10} />{clickerElapsed}</span>
            </span>
          );
        })() : (
          <>
            <span className="flex items-center gap-1.5 font-medium" style={{ color: 'var(--color-clicker)' }}>
              <MousePointerClick size={11} />
              Clicker
            </span>
            <Sep />
            <span className="text-text-secondary">{settings.cursorClickButton} button</span>
            {targetCps > 0 && (
              <>
                <Sep />
                <span className="flex items-center gap-1.5 text-text-tertiary">
                  <Gauge size={11} />
                  <span className="text-text-secondary font-mono">~{targetCps}/s</span>
                </span>
              </>
            )}
          </>
        )
      ) : (
        /* ── MACRO MODE ── idle shows the active profile + action count; a live replay
            replaces them with the progress read-out (which already carries the count
            via current/total). The loop counter persists across the run→ready edge. */
        <>
          {!isReplaying && (
            <>
              <span className="flex items-center gap-1.5 text-text-tertiary">
                <Folder size={11} />
                <span className="text-text-primary font-medium">{statusBar.profileName ?? 'No profile'}</span>
              </span>
              <Sep />
              <span className="flex items-center gap-1.5 text-text-tertiary">
                <ListOrdered size={11} />
                <span className="text-text-secondary">{statusBar.actionCount} actions</span>
              </span>
            </>
          )}

          {isReplaying && (
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <Play size={10} className="text-accent shrink-0" fill="currentColor" />
              <span className="text-[11px] font-medium font-mono text-accent shrink-0">
                {current} / {total}
              </span>
              <div className="h-[2px] bg-bg-elevated rounded-full overflow-hidden shrink-0" style={{ flex: '0 1 160px' }}>
                <div
                  className="h-full bg-accent-solid rounded-full transition-[width] duration-300"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="flex items-center gap-1 text-[11px] text-text-tertiary font-mono shrink-0">
                <Clock size={10} />{minutes}:{seconds}
              </span>
              {chainLabel && (
                <>
                  <div className="w-px h-3 bg-border-subtle shrink-0" />
                  <span
                    className="flex items-center gap-1.5 text-[11px] font-mono whitespace-nowrap"
                    style={{ color: 'var(--color-action-runprofile-fg)' }}
                    data-tip={chainLabel}
                  >
                    <Repeat size={10} />
                    {chainLabel}
                  </span>
                </>
              )}
              {pauseState.isPaused && (
                <>
                  <div className="w-px h-3 bg-border-subtle shrink-0" />
                  <PauseIcon size={10} className="shrink-0" style={{ color: 'var(--color-action-pause-fg)' }} fill="currentColor" />
                  <span className="text-[11px] font-medium whitespace-nowrap" style={{ color: 'var(--color-action-pause-fg)' }}>
                    PAUSED
                    {pauseState.hotkey && ` — Press ${pauseState.hotkey}`}
                    {pauseState.hotkey && pauseState.timeoutMs > 0 ? ' or ' : pauseState.timeoutMs > 0 ? ' — ' : ''}
                    {pauseState.timeoutMs > 0 && `wait ${pauseRemainingSec}s`}
                  </span>
                  <button
                    onClick={() => send({ type: 'replay:resume', payload: {} })}
                    className="px-2 py-0.5 text-[10px] font-medium rounded border border-border-default text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors shrink-0"
                  >
                    Resume
                  </button>
                </>
              )}
            </div>
          )}

          {/* Loop counter — survives the replaying→ready transition (the backend keeps
              loopProgress.active true briefly after the final iteration) so the user can
              read the final "Loop 100/100". total === 0 → infinite (∞). */}
          {loopProgress.active && (
            <>
              <Sep />
              <span className="flex items-center gap-1.5 text-[11px] font-mono text-text-secondary shrink-0">
                <Repeat size={10} className="text-text-tertiary" />
                Loop <strong className="text-text-primary">{loopProgress.current}</strong>
                <span className="text-text-disabled">/</span>
                <strong className="text-text-primary">{loopProgress.total === 0 ? '∞' : loopProgress.total}</strong>
              </span>
            </>
          )}
        </>
      )}

      {/* Spacer only when the replay progress row isn't already using flex-1 — otherwise
          two flex-1 elements would split the space and squeeze the chain label. */}
      {!(isReplaying && !isClicker) && <div className="flex-1" />}
      <span className="text-[11px] text-text-secondary shrink-0 ml-3">{APP_VERSION}</span>
    </div>
  );
}
