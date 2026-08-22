import type { ActionItem } from '../bridge/messageTypes';

// Structural OPENER/CLOSER markers of the two block families. Kept local to this pure
// module so it has no React/component dependency. BreakLoop/ContinueLoop are deliberately
// NOT here: they are ordinary single rows INSIDE a block — selecting one must not drag the
// whole loop along, and deleting one is a granular edit.
const STRUCTURAL = new Set(['If', 'Else', 'EndIf', 'While', 'ForEachRow', 'EndLoop']);

// Stack-built map of each opener row → its matching closer row, across BOTH families with a
// TYPED stack: EndIf only closes an If, EndLoop only closes a While/ForEachRow — the kind
// check is what keeps a crossed hand-edited pair ("If, While, EndIf, EndLoop") from pairing
// an If with a loop closer. Mirrors the engine's BuildBlockMap (ActionExecution.cs) and the
// grid's blockInfo; an orphan/crossed closer simply gets no entry.
function buildCloserOf(actions: ActionItem[]): Map<number, number> {
  const closerOf = new Map<number, number>();
  const stack: { kind: 'If' | 'Loop'; idx: number }[] = [];
  for (let i = 0; i < actions.length; i++) {
    const t = actions[i]?.actionType;
    if (t === 'If') stack.push({ kind: 'If', idx: i });
    else if (t === 'While' || t === 'ForEachRow') stack.push({ kind: 'Loop', idx: i });
    else if (t === 'EndIf') {
      if (stack.length > 0 && stack[stack.length - 1].kind === 'If') closerOf.set(stack.pop()!.idx, i);
    } else if (t === 'EndLoop') {
      if (stack.length > 0 && stack[stack.length - 1].kind === 'Loop') closerOf.set(stack.pop()!.idx, i);
    }
  }
  return closerOf;
}

// Block-snap a selection: if it TOUCHES a structural marker, expand every selected index
// to its whole enclosing block span — for nested blocks, every enclosing span — so a marker
// can never be operated on as a half-block and orphaned. A PURE body-row selection is returned
// untouched (referentially identical), so deleting/moving plain actions stays granular.
//
// This is the single source of truth for the "only snap when a marker is involved" rule shared
// by the grid (ActionTable: delete / drag / bulk Move / duplicate) and the global Alt+↑/↓ reorder
// handler (Toolbar), which has no access to the grid's memoised blockInfo. Pure + cheap (one O(n)
// stack walk per call, only on user-initiated mutations). Returns a sorted-ascending array when it
// expands, otherwise the original array.
export function snapIndicesToBlocks(indices: number[], actions: ActionItem[]): number[] {
  if (!indices.some((i) => STRUCTURAL.has(actions[i]?.actionType ?? ''))) return indices;
  const set = new Set(indices);
  const closerOf = buildCloserOf(actions);
  for (const sel of indices) {
    for (const [openIdx, closeIdx] of closerOf) {
      if (openIdx <= sel && sel <= closeIdx) for (let i = openIdx; i <= closeIdx; i++) set.add(i);
    }
  }
  return Array.from(set).sort((a, b) => a - b);
}

// Loop nesting depth at an INSERT position (the row would land before actions[insertIndex]).
// While/ForEachRow push, EndLoop pops, floor 0 (orphan closers in a hand-edited list must
// not drive the count negative). The Toolbar's Break/Next items gate on this — grey with a
// tooltip when 0, never hidden.
export function loopDepthAt(actions: ActionItem[], insertIndex: number): number {
  let depth = 0;
  const upTo = Math.min(Math.max(0, insertIndex), actions.length);
  for (let i = 0; i < upTo; i++) {
    const t = actions[i]?.actionType;
    if (t === 'While' || t === 'ForEachRow') depth++;
    else if (t === 'EndLoop') depth = Math.max(0, depth - 1);
  }
  return depth;
}
