import { useEffect, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import { useAppState } from '../state/AppStateContext';

export function StatusBar() {
  const { statusBar, status, highlightedActionIndex, replayChain } = useAppState();
  const isReplaying = status === 'replaying';
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

  return (
    <div className="flex items-center h-[26px] px-4 bg-bg-base border-t border-border-subtle shrink-0">
      <span className="text-[11px] text-text-disabled">{statusBar.directory}</span>
      <div className="w-px h-3 bg-border-subtle mx-3" />
      <span className="text-[11px] text-text-disabled">{statusBar.profileName ?? 'No profile'}</span>
      <div className="w-px h-3 bg-border-subtle mx-3" />
      <span className="text-[11px] text-text-disabled">{statusBar.actionCount} actions</span>

      {/* Replay progress section */}
      {isReplaying && (
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
          </div>
        </>
      )}

      {/* Spacer only when not replaying — during replay the progress section above already
          uses flex-1, so a second flex-1 here would split available space and squeeze the
          chain label. */}
      {!isReplaying && <div className="flex-1" />}
      <span className="text-[11px] text-text-disabled shrink-0 ml-3">v1.9.47</span>
    </div>
  );
}
