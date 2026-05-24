import { useEffect, useRef, useState } from 'react';
import { Play, Pause as PauseIcon, MousePointerClick } from 'lucide-react';
import { useAppState } from '../state/AppStateContext';
import { useBridge } from '../bridge/BridgeContext';
import { usePauseTick } from '../hooks/usePauseTick';
import { formatClickerStats } from '../utils/clickerFormat';

export function StatusBar() {
  const { statusBar, status, highlightedActionIndex, replayChain, pauseState, settings, clickerStats, loopProgress } = useAppState();
  const { send } = useBridge();
  const isReplaying = status === 'replaying';
  const isClicker = settings.useCursorClick;
  // The engine's stack already includes the root profile at index 0, so we only
  // render "Running ..." when the chain has at least 2 entries (root + a sub-call).
  // While running A alone, replayChain is ['A'] and we leave the chain hidden.
  const chainLabel = replayChain.length >= 2 ? replayChain.join(' → ') : null;

  // Elapsed timer
  const [elapsed, setElapsed] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (isReplaying) {
      setElapsed(0);
      intervalRef.current = setInterval(() => setElapsed(prev => prev + 1), 1000);
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setElapsed(0);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isReplaying]);

  const total = statusBar.actionCount;
  const current = highlightedActionIndex != null ? highlightedActionIndex + 1 : 0;
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  const minutes = Math.floor(elapsed / 60);
  const seconds = String(elapsed % 60).padStart(2, '0');

  usePauseTick(pauseState);

  const pauseRemainingSec = pauseState.timeoutMs > 0
    ? Math.max(0, Math.ceil((pauseState.timeoutMs - (Date.now() - pauseState.startedAt)) / 1000))
    : 0;

  return (
    <div className="flex items-center h-[26px] px-4 bg-bg-base border-t border-border-subtle shrink-0">
      {isClicker ? (
        <span className="flex items-center gap-1.5 text-[11px] font-medium" style={{ color: 'var(--color-clicker)' }}>
          <MousePointerClick size={11} />
          Clicker mode
        </span>
      ) : (
        <span className="text-[11px] text-text-disabled">{statusBar.directory}</span>
      )}
      <div className="w-px h-3 bg-border-subtle mx-3" />
      <span className="text-[11px] text-text-disabled">{statusBar.profileName ?? 'No profile'}</span>
      <div className="w-px h-3 bg-border-subtle mx-3" />
      <span className="text-[11px] text-text-disabled">{statusBar.actionCount} actions</span>

      {/* Macro loop counter — sits at the panel level (not nested in the progress block)
          so it survives the replaying→ready transition. The progress block above unmounts
          on status:ready, taking its inline contents with it; the counter needs to keep
          showing the final "Loop 100/100" briefly after the run ends, mirroring how the
          Clicker stats below persists past run-end. `loopProgress.active` is the gate —
          the backend only flips it true for genuine loops (>1 iteration or infinite), so
          single-shot replays never render this. total === 0 → infinite (∞). */}
      {!isClicker && loopProgress.active && (
        <>
          <div className="w-px h-3 bg-border-subtle mx-3" />
          <span className="text-[11px] font-mono text-text-secondary shrink-0">
            Loop <strong className="text-text-primary">{loopProgress.current}</strong>
            <span className="text-text-disabled">/</span>
            <strong className="text-text-primary">{loopProgress.total === 0 ? '∞' : loopProgress.total}</strong>
          </span>
        </>
      )}

      {/* Clicker live stats — shows during a Clicker run AND after it ends (so the user
          can read the final total without it vanishing instantly). The reducer wipes
          clickerStats only when a NEW run starts via status:changed → 'replaying',
          which keeps post-run values intact. Gate: in Clicker mode + (currently running
          OR a previous run actually clicked something). */}
      {isClicker && (isReplaying || clickerStats.count > 0) && (() => {
        // Renamed to avoid shadowing the outer `elapsed` number (Replay-mode timer above).
        const { elapsed: clickerElapsed, rateLabel } = formatClickerStats(clickerStats.count, clickerStats.elapsedMs);
        return (
          <>
            <div className="w-px h-3 bg-border-subtle mx-3" />
            <span className="flex items-center gap-2 text-[11px] font-mono" style={{ color: 'var(--color-clicker)' }}>
              <span className="text-text-secondary">Clicked</span>
              <strong className="text-text-primary">{clickerStats.count.toLocaleString()}</strong>
              <span className="text-text-disabled">·</span>
              <strong className="text-text-primary">{rateLabel}/s</strong>
              <span className="text-text-disabled">·</span>
              <strong className="text-text-primary">{clickerElapsed}</strong>
            </span>
          </>
        );
      })()}

      {/* Replay progress section — Macro mode only. Clicker runs use the dedicated
          "Clicked X · Y/s · MM:SS" block above (which carries the meaningful numbers
          for that mode). Without this guard, Clicker runs would render BOTH blocks, plus
          a meaningless "0 / 0" progress bar since Clicker has no recorded actions. */}
      {!isClicker && isReplaying && (
        <>
          <div className="w-px h-3 bg-border-subtle mx-3" />
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
            <span className="text-[11px] text-text-disabled font-mono shrink-0">
              {minutes}:{seconds}
            </span>
            {chainLabel && (
              <>
                <div className="w-px h-3 bg-border-subtle shrink-0" />
                <span
                  className="text-[11px] font-mono whitespace-nowrap"
                  style={{ color: 'var(--color-action-runprofile-fg)' }}
                  title={chainLabel}
                >
                  Running {chainLabel}
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
                  title="Resume replay"
                >
                  Resume
                </button>
              </>
            )}
          </div>
        </>
      )}

      {/* Spacer only when not replaying — during replay the progress section above already
          uses flex-1, so a second flex-1 here would split available space and squeeze the
          chain label. */}
      {!isReplaying && <div className="flex-1" />}
      <span className="text-[11px] text-text-disabled shrink-0 ml-3">v2.1.4</span>
    </div>
  );
}
