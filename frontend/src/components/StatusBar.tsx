import { useEffect, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import { useAppState } from '../state/AppStateContext';

export function StatusBar() {
  const { statusBar, status, highlightedActionIndex } = useAppState();
  const isReplaying = status === 'replaying';

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
          <div className="flex items-center gap-2 flex-1">
            <Play size={10} className="text-accent" fill="currentColor" />
            <span className="text-[11px] font-medium font-mono text-accent">
              {current} / {total}
            </span>
            <div className="h-[2px] bg-bg-elevated rounded-full overflow-hidden" style={{ flex: 1, maxWidth: 160 }}>
              <div
                className="h-full bg-accent-solid rounded-full transition-[width] duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-[11px] text-text-disabled font-mono">
              {minutes}:{seconds}
            </span>
          </div>
        </>
      )}

      <div className="flex-1" />
      <span className="text-[11px] text-text-disabled">v1.9.41</span>
    </div>
  );
}
