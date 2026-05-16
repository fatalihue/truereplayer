// Helpers for the "Collapse to × N" / "Expand × N" context-menu flow.
//
// Collapse: takes a contiguous selection of KeyDown+KeyUp pairs of the SAME key
// and folds them into a single Keystroke row with RepeatCount = pairs. The
// inter-cycle gap (RepeatDelayMs) is derived from the average pre-action delay
// of the 2nd/3rd/... KeyDown rows — those delays ARE the gaps the user originally
// recorded between presses, so reusing them keeps replay timing faithful.
//
// Expand: the inverse — splits one Keystroke × N row back into N pairs. v1
// blocks combos with modifiers (e.g. "Ctrl+A") because they'd expand to 4 rows
// per cycle (mod-down / key-down / key-up / mod-up); single-key expansion is
// always 2 rows per cycle and easy to reason about.
//
// Both validators run on the React side — pure functions, no side effects, no
// bridge calls — so the menu's enabled/disabled state recomputes cheaply on
// every render. The actual mutation goes through the `actions:replaceRange`
// bridge message which is atomic (single undo step).

import type { ActionItem } from '../bridge/messageTypes';

export interface CollapseResult {
  key: string;
  count: number;          // number of press cycles (= rows.length / 2)
  delay: number;          // pre-action wait carried over from the first KeyDown
  repeatDelayMs: number;  // averaged gap between cycles, clamped 0..5000
}

/**
 * Returns the collapsed form if `rows` is a clean sequence of KeyDown+KeyUp
 * pairs of the same key; null otherwise. Rejects any selection containing a
 * skipped row to preserve "skip" semantics (a folded row can't be partially
 * skipped).
 *
 * Contiguity is the caller's responsibility — `rows` should already be the
 * actions at consecutive indices. We only validate the pair pattern.
 */
export function canCollapse(rows: ActionItem[]): CollapseResult | null {
  if (rows.length < 2 || rows.length % 2 !== 0) return null;
  if (rows.some(r => r.isSkipped)) return null;
  const key = rows[0].key;
  if (!key) return null;

  for (let i = 0; i < rows.length; i += 2) {
    if (rows[i].actionType !== 'KeyDown' || rows[i].key !== key) return null;
    if (rows[i + 1].actionType !== 'KeyUp' || rows[i + 1].key !== key) return null;
  }

  // Average the pre-action delays on KeyDown rows from the 2nd cycle onwards —
  // those delays represent the time between Up(prev) and Down(this), i.e. the
  // gap between cycles. The first KeyDown's delay is the row's overall wait
  // (carries over as the new Keystroke's `delay`, not its `repeatDelayMs`).
  const gaps: number[] = [];
  for (let i = 2; i < rows.length; i += 2) gaps.push(rows[i].delay);
  const avgGap = gaps.length > 0
    ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)
    : 30;

  return {
    key,
    count: rows.length / 2,
    delay: rows[0].delay,
    repeatDelayMs: Math.max(0, Math.min(5000, avgGap)),
  };
}

/**
 * True when `row` is a single-key Keystroke with RepeatCount > 1.
 * Modifier combos (e.g. "Ctrl+A") are excluded in v1 — see top-of-file comment.
 */
export function canExpand(row: ActionItem): boolean {
  return row.actionType === 'Keystroke'
      && (row.repeatCount ?? 1) > 1
      && !row.key.includes('+');
}

/**
 * Returns the N pairs of KeyDown/KeyUp that reproduce `row` row-for-row when
 * replayed. The first KeyDown keeps the original `delay` (so the Keystroke's
 * pre-action wait is preserved); subsequent KeyDowns get the recorded
 * `repeatDelayMs` (or its 30 ms default) as their delay; every KeyUp gets 0
 * (Keystroke replays Down→Up tightly, no programmatic hold).
 *
 * The returned rows are Partial<ActionItem> so the C# side can fill in
 * RowNumber/etc on deserialise — the caller passes them straight into the
 * `actions:replaceRange` payload.
 */
export function expandKeystroke(row: ActionItem): Partial<ActionItem>[] {
  const count = row.repeatCount ?? 1;
  const gap = row.repeatDelayMs ?? 30;
  const out: Partial<ActionItem>[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      actionType: 'KeyDown',
      key: row.key,
      delay: i === 0 ? row.delay : gap,
      comment: '',
    });
    out.push({
      actionType: 'KeyUp',
      key: row.key,
      delay: 0,
      comment: '',
    });
  }
  return out;
}
