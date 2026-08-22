using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using TrueReplayer.Models;

namespace TrueReplayer.Services
{
    /// <summary>
    /// Walks an action list at profile-load time, ensuring the structural blocks are
    /// balanced. Two families share one TYPED stack:
    ///   • If / Else / EndIf — the conditional block (Else only pairs with an If on TOP
    ///     of the stack, so an Else inside a While can never leak into the outer If);
    ///   • While / ForEachRow / EndLoop — the loop blocks (one closer for both openers).
    ///
    /// ONE deterministic rule: a closer only closes its OWN kind. A mismatched or
    /// unmatched marker is an ORPHAN and is REMOVED — never "fixed" by inserting rows in
    /// the middle, which would shift every index the toRemove math depends on, and the
    /// engine treats the same orphans as no-ops, so validator and engine agree on
    /// malformed input by construction. BreakLoop / ContinueLoop are orphans when NO loop
    /// is open anywhere on the stack (If frames between them and the loop don't count).
    ///
    /// Backward-compat by construction: profiles with zero structural rows trigger zero
    /// mutations, so the round-trip JSON is byte-identical to pre-v2.3 saves. Validator
    /// is idempotent — running it twice on the same list is a no-op (the repaired list
    /// contains no orphans and no unmatched openers).
    /// </summary>
    public static class ConditionalBlockValidator
    {
        public readonly record struct BlockValidationResult(int OrphansRemoved, int EndIfsAppended)
        {
            public bool HadFixups => OrphansRemoved > 0 || EndIfsAppended > 0;
        }

        private enum Kind { If, While, ForEachRow }

        private static bool Is(ActionItem a, string type) =>
            string.Equals(a.ActionType, type, StringComparison.OrdinalIgnoreCase);

        /// <summary>
        /// Repairs the action list IN PLACE. Returns a tally of how many fixups were
        /// applied so the caller (bridge / load path) can surface a toast like
        /// "Auto-fixed N conditional blocks". EndIfsAppended counts synthetic closers of
        /// BOTH families (the field name predates the loop blocks; the four call sites
        /// only ever read it as "closers appended"). A profile that was already balanced
        /// returns (0, 0) and isn't mutated.
        /// </summary>
        public static BlockValidationResult ValidateAndRepairBlocks(IList<ActionItem> actions)
        {
            // IList covers both ObservableCollection (profile load path) and List
            // (clipboard auto-complete on paste). The mutation API (RemoveAt / Add) is
            // identical on both, and we don't depend on collection-changed notifications.
            if (actions == null || actions.Count == 0)
                return new BlockValidationResult(0, 0);

            // Pure jump markers carry no replay delay — normalise any stray value to 0 so a
            // hand-edited profile can't leave a meaningless delay on them. The opening If and
            // While are deliberately exempt: they run a probe, so their delay is a real "wait
            // for the condition to settle" knob (per ITERATION on a While). ForEachRow has no
            // probe and no delay either — it joins the zeroed set. Silent (not counted as a
            // fixup → no toast) and idempotent.
            foreach (var a in actions)
            {
                if (a.Delay != 0
                    && (Is(a, "Else") || Is(a, "EndIf")
                        || Is(a, "EndLoop") || Is(a, "BreakLoop") || Is(a, "ContinueLoop")
                        || Is(a, "ForEachRow")))
                {
                    a.Delay = 0;
                }
            }

            // First pass — collect orphans + open blocks. No mutation while scanning so the
            // stack's indices stay valid; mutations happen in a second pass.
            // hasElseFor tracks If indices that already own an Else — a SECOND Else under
            // the same If is structurally invalid and treated as orphan.
            var stack = new Stack<(Kind Kind, int Idx)>();
            var hasElseFor = new HashSet<int>();
            var toRemove = new List<int>(); // sorted ascending by construction
            for (int i = 0; i < actions.Count; i++)
            {
                var a = actions[i];
                if (Is(a, "If")) stack.Push((Kind.If, i));
                else if (Is(a, "While")) stack.Push((Kind.While, i));
                else if (Is(a, "ForEachRow")) stack.Push((Kind.ForEachRow, i));
                else if (Is(a, "Else"))
                {
                    // Else pairs ONLY with an If sitting on TOP — "the innermost open block
                    // is an If". An Else whose innermost block is a loop belongs to nobody.
                    if (stack.Count == 0 || stack.Peek().Kind != Kind.If)
                        toRemove.Add(i);
                    else if (!hasElseFor.Add(stack.Peek().Idx))
                        toRemove.Add(i); // duplicate Else under one If
                }
                else if (Is(a, "EndIf"))
                {
                    // Closes ONLY an If. A crossed closer ("If, While, EndIf, EndLoop")
                    // is an orphan here — removing it lets the synthetic pass below close
                    // both blocks in LIFO order, which is the only deterministic repair.
                    if (stack.Count > 0 && stack.Peek().Kind == Kind.If)
                        stack.Pop();
                    else
                        toRemove.Add(i);
                }
                else if (Is(a, "EndLoop"))
                {
                    // Closes ONLY a loop opener (While or ForEachRow — the shared closer).
                    if (stack.Count > 0 && stack.Peek().Kind != Kind.If)
                        stack.Pop();
                    else
                        toRemove.Add(i);
                }
                else if (Is(a, "BreakLoop") || Is(a, "ContinueLoop"))
                {
                    // Valid only somewhere inside a loop — scan the WHOLE stack (If frames
                    // between the row and its loop don't count against it).
                    bool insideLoop = false;
                    foreach (var frame in stack)
                        if (frame.Kind != Kind.If) { insideLoop = true; break; }
                    if (!insideLoop) toRemove.Add(i);
                }
            }

            // Second pass — remove orphans from the END so earlier indices stay valid.
            for (int k = toRemove.Count - 1; k >= 0; k--)
                actions.RemoveAt(toRemove[k]);

            // Third pass — synthesize the missing closer PER KIND, in LIFO order (pop
            // order IS innermost-first, so the appended closers nest correctly).
            int appended = 0;
            while (stack.Count > 0)
            {
                var (kind, _) = stack.Pop();
                actions.Add(kind == Kind.If
                    ? new ActionItem
                    {
                        ActionType = "EndIf",
                        Delay = 0,
                        // Mark synthetic origin so the user can spot auto-repaired rows in
                        // the Notes column. Cheap and human-readable; no extra schema needed.
                        Comment = "auto-repaired: unmatched IF",
                    }
                    : new ActionItem
                    {
                        ActionType = "EndLoop",
                        Delay = 0,
                        Comment = kind == Kind.While
                            ? "auto-repaired: unmatched WHILE"
                            : "auto-repaired: unmatched FOR EACH ROW",
                    });
                appended++;
            }

            return new BlockValidationResult(toRemove.Count, appended);
        }
    }
}
