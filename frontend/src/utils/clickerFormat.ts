// Shared formatters for Clicker live stats — consumed by StatusBar (compact one-line
// readout) and ClickerDashboard (large hero + grid). Keeping one source of truth so the
// "rate >= 10 → integer, else 1 decimal" rule + MM:SS convention stay consistent.

export interface ClickerStatsView {
  elapsed: string;     // "M:SS"
  rate: number;        // clicks per second (raw)
  rateLabel: string;   // "9.8" or "120"
}

export function formatClickerStats(count: number, elapsedMs: number): ClickerStatsView {
  const sec = Math.max(0, Math.floor(elapsedMs / 1000));
  const mm = Math.floor(sec / 60);
  const ss = String(sec % 60).padStart(2, '0');
  const rate = elapsedMs > 0 ? (count * 1000) / elapsedMs : 0;
  // Integer-only above 10 CPS — at high rates a trailing ".0" reads as noise; at low
  // rates the decimal carries useful precision (1.2/s vs 1.8/s).
  const rateLabel = rate >= 10 ? rate.toFixed(0) : rate.toFixed(1);
  return { elapsed: `${mm}:${ss}`, rate, rateLabel };
}

// Estimated time-to-finish, in "~Ns" or "~M:SS" form. Returns "—" when the run is
// unbounded (infinite loop) or we don't yet have enough samples to project.
export function formatEta(
  loopActive: boolean,
  total: number,
  current: number,
  rate: number,
): string {
  if (!loopActive || total <= 0 || current <= 0 || rate <= 0) return '—';
  const remaining = Math.max(0, total - current);
  const etaSec = Math.ceil(remaining / rate);
  if (etaSec >= 60) {
    const em = Math.floor(etaSec / 60);
    const es = String(etaSec % 60).padStart(2, '0');
    return `~${em}:${es}`;
  }
  return `~${etaSec}s`;
}
