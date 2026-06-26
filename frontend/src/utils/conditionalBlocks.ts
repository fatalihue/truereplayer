import type { ActionItem } from '../bridge/messageTypes';

// IF / ELSE / ENDIF are the structural markers of a conditional block. Kept local to this
// pure module so it has no React/component dependency.
const STRUCTURAL = new Set(['If', 'Else', 'EndIf']);

// Stack-built map of each IF row → its matching ENDIF row. The LIFO stack pairs an inner
// IF with the inner ENDIF and an outer IF with the outer ENDIF, so it is nesting-correct.
// Mirrors the engine's BuildBlockMap (ActionExecution.cs) and the grid's blockInfo.endIfOf;
// an orphan ENDIF (empty stack) simply gets no entry.
function buildEndIfOf(actions: ActionItem[]): Map<number, number> {
  const endIfOf = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0; i < actions.length; i++) {
    const t = actions[i]?.actionType;
    if (t === 'If') stack.push(i);
    else if (t === 'EndIf') {
      const open = stack.pop();
      if (open !== undefined) endIfOf.set(open, i);
    }
  }
  return endIfOf;
}

// Block-snap a selection: if it TOUCHES an If/Else/EndIf marker, expand every selected index
// to its whole enclosing IF…ENDIF span — for nested blocks, every enclosing span — so a marker
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
  const endIfOf = buildEndIfOf(actions);
  for (const sel of indices) {
    for (const [ifIdx, endIfIdx] of endIfOf) {
      if (ifIdx <= sel && sel <= endIfIdx) for (let i = ifIdx; i <= endIfIdx; i++) set.add(i);
    }
  }
  return Array.from(set).sort((a, b) => a - b);
}
