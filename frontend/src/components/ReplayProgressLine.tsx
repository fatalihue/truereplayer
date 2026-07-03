import type { CSSProperties } from 'react';
import { useAppState } from '../state/AppStateContext';

/**
 * Indeterminate "replay in progress" line — a thin bright segment sweeps
 * left→right across a faint track, sitting as a hairline between the Toolbar and
 * the grid while the replay (or clicker) engine is running. Green for macro
 * replay; adopts the clicker purple in clicker mode so it stays palette-coherent
 * with whatever is actually running. The sweep animation lives in index.css and
 * is gated by the global data-animations flag (this app's reduced-motion
 * mechanism) — with motion off it degrades to a static faint hairline.
 *
 * Rendered conditionally, so it takes zero space (and adds no gap-px gutter)
 * when idle; the grid slides down ~2px only while a run is live.
 */
export function ReplayProgressLine() {
  const { buttonStates, settings } = useAppState();
  if (!buttonStates.replayActive) return null;

  const isClicker = settings.useCursorClick;
  return (
    <div
      className="replay-progress-line shrink-0"
      role="progressbar"
      aria-label={isClicker ? 'Clicking in progress' : 'Replay in progress'}
      style={{ '--replay-line-color': isClicker ? 'var(--color-clicker)' : 'var(--color-replay)' } as CSSProperties}
    />
  );
}
