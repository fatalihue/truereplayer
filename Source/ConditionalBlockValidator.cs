using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using TrueReplayer.Models;

namespace TrueReplayer.Services
{
    /// <summary>
    /// Walks an action list at profile-load time, ensuring IF / ELSE / ENDIF blocks
    /// are balanced. Single O(n) pass with a small stack of open IFs:
    ///   • Every IF pushes its index.
    ///   • Every ELSE that has an open IF is allowed; orphan ELSE (no open IF) is removed.
    ///   • Every ENDIF that has an open IF pops it; orphan ENDIF is removed.
    ///   • Any IF still on the stack at end-of-list gets a synthetic ENDIF appended so
    ///     the engine's block matcher always finds a closer.
    ///
    /// Backward-compat by construction: profiles with zero conditional rows trigger zero
    /// mutations, so the round-trip JSON is byte-identical to pre-v2.3 saves. Validator
    /// is idempotent — running it twice on the same list is a no-op.
    /// </summary>
    public static class ConditionalBlockValidator
    {
        public readonly record struct BlockValidationResult(int OrphansRemoved, int EndIfsAppended)
        {
            public bool HadFixups => OrphansRemoved > 0 || EndIfsAppended > 0;
        }

        /// <summary>
        /// Repairs the action list IN PLACE. Returns a tally of how many fixups were
        /// applied so the caller (bridge / load path) can surface a toast like
        /// "Auto-fixed N conditional blocks". A profile that was already balanced
        /// returns (0, 0) and isn't mutated.
        /// </summary>
        public static BlockValidationResult ValidateAndRepairBlocks(IList<ActionItem> actions)
        {
            // IList covers both ObservableCollection (profile load path) and List
            // (clipboard auto-complete on paste). The mutation API (RemoveAt / Add) is
            // identical on both, and we don't depend on collection-changed notifications.
            if (actions == null || actions.Count == 0)
                return new BlockValidationResult(0, 0);

            // Structural markers (IF/ELSE/ENDIF) carry no replay delay — normalise any stray value to
            // 0 so a bulk "set delay for all" (or a hand-edited profile) can't leave a meaningless
            // delay on a block marker. Silent (not counted as a fixup → no toast) and idempotent.
            foreach (var a in actions)
            {
                if (a.Delay != 0
                    && (string.Equals(a.ActionType, "If", StringComparison.OrdinalIgnoreCase)
                        || string.Equals(a.ActionType, "Else", StringComparison.OrdinalIgnoreCase)
                        || string.Equals(a.ActionType, "EndIf", StringComparison.OrdinalIgnoreCase)))
                {
                    a.Delay = 0;
                }
            }

            // First pass — collect indices of orphan ELSE/ENDIF rows + open IFs.
            // We don't mutate the list while scanning so the indices in the stack stay
            // valid; mutations happen in a second pass after we know what to drop.
            // hasElseFor tracks IF indices that already have an ELSE attached — a SECOND
            // ELSE under the same IF is structurally invalid (no defined semantics for
            // "two false branches"), so it's treated as orphan.
            var stack = new Stack<int>();
            var hasElseFor = new HashSet<int>();
            var toRemove = new List<int>(); // sorted ascending by construction
            for (int i = 0; i < actions.Count; i++)
            {
                var t = actions[i].ActionType;
                if (string.Equals(t, "If", StringComparison.OrdinalIgnoreCase))
                {
                    stack.Push(i);
                }
                else if (string.Equals(t, "Else", StringComparison.OrdinalIgnoreCase))
                {
                    if (stack.Count == 0)
                    {
                        toRemove.Add(i); // orphan ELSE — no open IF to pair with
                    }
                    else if (!hasElseFor.Add(stack.Peek()))
                    {
                        // hasElseFor.Add returned false → this IF already had an ELSE earlier.
                        // The duplicate is invalid; drop it so the engine's block map only
                        // sees one ELSE per IF (the FIRST one, which is what the user
                        // visually authored first).
                        toRemove.Add(i);
                    }
                }
                else if (string.Equals(t, "EndIf", StringComparison.OrdinalIgnoreCase))
                {
                    if (stack.Count > 0)
                        stack.Pop(); // matches an open IF
                    else
                        toRemove.Add(i); // orphan ENDIF
                }
            }

            // Second pass — remove orphans from the END so earlier indices stay valid.
            for (int k = toRemove.Count - 1; k >= 0; k--)
                actions.RemoveAt(toRemove[k]);

            // Third pass — for every IF still on the stack, append a synthetic ENDIF.
            // We don't care about insertion ORDER among the synthetics relative to each
            // other (they all sit at the very end and the block matcher handles them
            // in LIFO order naturally). Using a per-IF append keeps each synthetic ENDIF
            // attributable in the diagnostic log if we need it later.
            int appended = 0;
            while (stack.Count > 0)
            {
                stack.Pop();
                actions.Add(new ActionItem
                {
                    ActionType = "EndIf",
                    Delay = 0,
                    // Mark synthetic origin so the user can spot auto-repaired rows in
                    // the Notes column. Cheap and human-readable; no extra schema needed.
                    Comment = "auto-repaired: unmatched IF",
                });
                appended++;
            }

            return new BlockValidationResult(toRemove.Count, appended);
        }
    }
}
