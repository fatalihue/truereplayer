// Shared formatters for Clicker live stats — consumed by StatusBar (compact one-line
// readout) and ClickerDashboard (large hero + grid). Keeping one source of truth so the
// "rate >= 10 → integer, else 1 decimal" rule + MM:SS convention stay consistent.

export interface ClickerStatsView {
  elapsed: string;     // "M:SS"
  rate: number;        // clicks per second (raw)
  rateLabel: string;   // "9.8" or "120"
}

// Integer-only above 10 CPS — at high rates a trailing ".0" reads as noise; at low
// rates the decimal carries useful precision (1.2/s vs 1.8/s).
// Shared by the MEASURED rate (dashboard) and the TARGET rate (settings, status bar) so
// the two can never format differently for the same number.
export function formatRate(rate: number): string {
  return rate >= 10 ? rate.toFixed(0) : rate.toFixed(1);
}

export function formatClickerStats(count: number, elapsedMs: number): ClickerStatsView {
  const sec = Math.max(0, Math.floor(elapsedMs / 1000));
  const mm = Math.floor(sec / 60);
  const ss = String(sec % 60).padStart(2, '0');
  const rate = elapsedMs > 0 ? (count * 1000) / elapsedMs : 0;
  return { elapsed: `${mm}:${ss}`, rate, rateLabel: formatRate(rate) };
}

// ── Engine truth ────────────────────────────────────────────────────────────────────
//
// These mirror ReplayService.ToggleCursorClickReplay (Source/ActionExecution.cs). The UI
// used to compute its rate as 1000/delay, which ignored the hold and the interval — so the
// shipped default reported 10/s while the engine ran ~9.1/s, and the "200/s" preset was
// simply unreachable. Anything here that drifts from the C# is a bug on this side; keep
// the two in step.
//
// Jitter is deliberately absent: it is a symmetric scatter (Random.Next(-v, v+1)), so it
// perturbs individual periods without moving the mean. Adding it here would be wrong.

/** Math.Clamp(config.DelayMs, MinClickPeriodMs, ...) — ActionExecution.cs MinClickPeriodMs. */
export const CLICK_PERIOD_FLOOR_MS = 5;
/** Math.Clamp(holdMs, 0, 2000) — ActionExecution.cs safeHold. */
export const CLICK_HOLD_MAX_MS = 2000;

/** One full cycle: the engine schedules against this, with hold absorbed INSIDE it. */
export function clickPeriodMs(delayMs: number, intervalMs: number): number {
  const base = Math.max(CLICK_PERIOD_FLOOR_MS, Number.isFinite(delayMs) ? delayMs : 0);
  return base + Math.max(0, Number.isFinite(intervalMs) ? intervalMs : 0);
}

/** Clicks per second the engine will actually produce for this configuration. */
export function targetCps(delayMs: number, intervalMs: number): number {
  return 1000 / clickPeriodMs(delayMs, intervalMs);
}

/**
 * Ceiling for the current hold/interval. The hold lives inside the period, so a period
 * shorter than the hold cannot be honoured — that is the real cap, and it is why the
 * old "/s" preset list could offer rates the engine would never reach.
 */
export function maxCps(holdMs: number, intervalMs: number): number {
  const hold = Math.min(CLICK_HOLD_MAX_MS, Math.max(0, Number.isFinite(holdMs) ? holdMs : 0));
  const floor = Math.max(CLICK_PERIOD_FLOOR_MS, hold + 1);
  return 1000 / clickPeriodMs(floor, intervalMs);
}

/**
 * Inverse of targetCps: the delay to store for a requested clicks/second.
 * `clamped` reports that the request was out of reach, so the caller can say so instead
 * of silently storing a number that means something else.
 */
export function delayForCps(
  cps: number,
  holdMs: number,
  intervalMs: number,
): { ms: number; clamped: boolean } {
  if (!Number.isFinite(cps) || cps <= 0) return { ms: 100, clamped: true };
  const hold = Math.min(CLICK_HOLD_MAX_MS, Math.max(0, Number.isFinite(holdMs) ? holdMs : 0));
  const interval = Math.max(0, Number.isFinite(intervalMs) ? intervalMs : 0);
  const raw = Math.round(1000 / cps) - interval;
  const floor = Math.max(CLICK_PERIOD_FLOOR_MS, hold + 1);
  const ms = Math.min(60000, Math.max(floor, raw));
  return { ms, clamped: ms !== raw };
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
