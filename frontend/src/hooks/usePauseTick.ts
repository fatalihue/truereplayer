import { useEffect, useState } from 'react';
import type { AppState } from '../bridge/messageTypes';

// Forces a re-render once per second while replay is paused with a finite timeout, so
// downstream "wait Ns" countdowns stay current. The underlying pauseState values
// (startedAt + timeoutMs) don't change during the pause, so without this React would
// never schedule another paint and the visible countdown would freeze.
export function usePauseTick(pauseState: AppState['pauseState']): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!pauseState.isPaused || pauseState.timeoutMs <= 0) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [pauseState.isPaused, pauseState.timeoutMs]);
}
