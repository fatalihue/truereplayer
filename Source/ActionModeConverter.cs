using System;
using System.Collections.Generic;
using System.Linq;
using TrueReplayer.Models;

namespace TrueReplayer.Services
{
    /// <summary>
    /// Converts a profile's action list between the two input representations:
    ///   • Paired   — KeyDown+KeyUp / *ClickDown+*ClickUp (two rows per press)
    ///   • Combined — Keystroke / HoldKey / *Click       (one row per press)
    ///
    /// This is the on-demand counterpart to the record-time "Combined Actions" toggle: a
    /// profile recorded (or hand-built) in one form can be switched to the other without
    /// re-recording or editing JSON. Both methods are PURE functions over a snapshot — the
    /// caller swaps the result into the live collection (with undo) — so the transforms stay
    /// trivially testable and side-effect free.
    ///
    /// Faithfulness rules (so a converted macro keeps doing the same thing):
    ///   • A click whose Down/Up land on DIFFERENT points is a drag — left paired (a combined
    ///     *Click has a single point and can't represent a moved release).
    ///   • A held KEY (adjacent KeyDown+KeyUp whose Up delay ≥ <see cref="HoldThresholdMs"/>)
    ///     becomes a HoldKey carrying that exact duration — no timing is lost.
    ///   • A held mouse button collapses to an instant *Click (there is no mouse-hold action),
    ///     matching how the record-time combined mode treats clicks.
    ///   • Overlapping / interleaved presses (KeyDown … other event … KeyUp) can't be folded,
    ///     so they are left paired exactly as-is.
    /// </summary>
    public static class ActionModeConverter
    {
        // Down/Up click coords this far apart (px, either axis) are treated as a DRAG and kept
        // paired. Real clicks record identical Down/Up coords; a couple px of slack absorbs the
        // rare 1px wobble without misreading a genuine drag as a click.
        private const int ClickCoordTolerance = 2;

        // A KeyDown+KeyUp pair whose Up delay (= how long the key stayed down) reaches this is
        // treated as a deliberate hold and mapped to HoldKey (preserving the duration) instead
        // of an instant Keystroke. Below it, the press is a tap → Keystroke.
        private const int HoldThresholdMs = 200;

        private static readonly HashSet<string> Modifiers =
            new(StringComparer.OrdinalIgnoreCase) { "Ctrl", "Shift", "Alt", "Win" };

        // ── Paired → Combined ─────────────────────────────────────────────
        public static List<ActionItem> ToCombined(IReadOnlyList<ActionItem> input)
        {
            var result = new List<ActionItem>(input.Count);
            int i = 0;
            while (i < input.Count)
            {
                var a = input[i];

                // Click pair: *ClickDown + *ClickUp (same button, same point) → *Click.
                if (TryClickButton(a.ActionType, down: true, out string btn)
                    && i + 1 < input.Count
                    && TryClickButton(input[i + 1].ActionType, down: false, out string upBtn)
                    && upBtn == btn
                    && Math.Abs(input[i + 1].X - a.X) <= ClickCoordTolerance
                    && Math.Abs(input[i + 1].Y - a.Y) <= ClickCoordTolerance)
                {
                    var click = a.Clone();
                    click.ActionType = btn + "Click";
                    result.Add(click);
                    i += 2;
                    continue;
                }

                // Held key: adjacent non-modifier KeyDown+KeyUp whose Up carries a real hold
                // → HoldKey, preserving the exact press duration. Checked before the keystroke
                // matcher (which would otherwise flatten it into an instant tap).
                if (a.ActionType == "KeyDown" && !Modifiers.Contains(a.Key)
                    && i + 1 < input.Count
                    && input[i + 1].ActionType == "KeyUp" && KeyEq(input[i + 1].Key, a.Key)
                    && input[i + 1].Delay >= HoldThresholdMs)
                {
                    var hold = a.Clone();
                    hold.ActionType = "HoldKey";
                    hold.HoldDurationMs = Math.Clamp(input[i + 1].Delay, 10, 60000);
                    result.Add(hold);
                    i += 2;
                    continue;
                }

                // Keystroke: a clean [mods] key [mods-reversed] run (or a lone modifier tap)
                // → one Keystroke. Returns 0 when the structure isn't clean (overlap, drag
                // half, unmatched), in which case the row is emitted untouched below.
                int consumed = TryMatchKeystroke(input, i, out var ks);
                if (consumed > 0)
                {
                    result.Add(ks!);
                    i += consumed;
                    continue;
                }

                result.Add(a);
                i++;
            }
            return result;
        }

        // ── Combined → Paired ─────────────────────────────────────────────
        public static List<ActionItem> ToPaired(IReadOnlyList<ActionItem> input)
        {
            var result = new List<ActionItem>(input.Count * 2);
            foreach (var a in input)
            {
                switch (a.ActionType)
                {
                    case "LeftClick":
                    case "RightClick":
                    case "MiddleClick":
                    {
                        string btn = a.ActionType[..^"Click".Length]; // "LeftClick" → "Left"
                        var down = a.Clone(); down.ActionType = btn + "ClickDown";
                        var up = a.Clone(); up.ActionType = btn + "ClickUp"; up.Delay = 0; up.Comment = "";
                        result.Add(down);
                        result.Add(up);
                        break;
                    }
                    case "Keystroke":
                        ExpandKeystroke(a, result);
                        break;
                    case "HoldKey":
                    {
                        // KeyDown(key) then KeyUp(key) after the hold — the hold rides on the
                        // Up's delay (how long the key stays down), the inverse of the
                        // ToCombined hold mapping, so a round-trip preserves the duration.
                        var down = a.Clone(); down.ActionType = "KeyDown"; down.HoldDurationMs = 0;
                        int hold = a.HoldDurationMs > 0
                            ? Math.Clamp(a.HoldDurationMs, 10, 60000)
                            : ActionItem.DefaultHoldDurationMs;
                        result.Add(down);
                        result.Add(new ActionItem { ActionType = "KeyUp", Key = a.Key, Delay = hold });
                        break;
                    }
                    default:
                        result.Add(a);
                        break;
                }
            }
            return result;
        }

        // Expands a Keystroke ("Ctrl+Shift+T", "A", "Shift") into its KeyDown/KeyUp sequence:
        // modifiers down (canonical Win→Ctrl→Shift→Alt), key down, key up, modifiers up reversed.
        // Honours RepeatCount (emit the whole combo N times, the repeat gap leading each cycle).
        private static void ExpandKeystroke(ActionItem ks, List<ActionItem> result)
        {
            if (string.IsNullOrWhiteSpace(ks.Key)) { result.Add(ks.Clone()); return; }

            var parts = ks.Key.Split('+');
            string target = parts[^1].Trim();
            var prefix = parts.Take(parts.Length - 1).Select(p => p.Trim()).ToList();
            var mods = new[] { "Win", "Ctrl", "Shift", "Alt" }
                .Where(m => prefix.Any(p => KeyEq(p, m)))
                .ToList();

            int repeats = Math.Max(1, Math.Min(999, ks.RepeatCount));
            int gap = Math.Max(0, Math.Min(5000, ks.RepeatDelayMs ?? ActionItem.DefaultRepeatDelayMs));

            for (int r = 0; r < repeats; r++)
            {
                // First action of the whole expansion carries the Keystroke's own delay; each
                // later cycle leads with the repeat gap; the rest of a cycle fires back-to-back.
                int leadDelay = r == 0 ? ks.Delay : gap;
                bool first = true;
                foreach (var m in mods)
                {
                    result.Add(new ActionItem { ActionType = "KeyDown", Key = m, Delay = first ? leadDelay : 0 });
                    first = false;
                }
                result.Add(new ActionItem { ActionType = "KeyDown", Key = target, Delay = first ? leadDelay : 0 });
                result.Add(new ActionItem { ActionType = "KeyUp", Key = target, Delay = 0 });
                for (int m = mods.Count - 1; m >= 0; m--)
                    result.Add(new ActionItem { ActionType = "KeyUp", Key = mods[m], Delay = 0 });
            }
        }

        // Matches a clean keystroke run at <paramref name="start"/>:
        //   [KeyDown(mod)]*  KeyDown(key, non-mod)  KeyUp(key)  [KeyUp(mod) reversed]*
        // or a lone modifier tap:  KeyDown(mod)+  KeyUp(mod reversed)+
        // Returns the number of rows consumed (0 = no clean match → caller leaves the row as-is).
        private static int TryMatchKeystroke(IReadOnlyList<ActionItem> input, int start, out ActionItem? combined)
        {
            combined = null;
            if (input[start].ActionType != "KeyDown") return 0;

            int j = start;
            var mods = new List<string>();
            while (j < input.Count && input[j].ActionType == "KeyDown" && Modifiers.Contains(input[j].Key))
            {
                mods.Add(input[j].Key);
                j++;
            }

            bool haveKey = j < input.Count && input[j].ActionType == "KeyDown" && !Modifiers.Contains(input[j].Key);
            if (!haveKey)
            {
                // Lone modifier(s): expect a KeyUp for each held modifier, in reverse order.
                if (mods.Count == 0) return 0;
                int k = j;
                for (int m = mods.Count - 1; m >= 0; m--)
                {
                    if (k >= input.Count || input[k].ActionType != "KeyUp" || !KeyEq(input[k].Key, mods[m])) return 0;
                    k++;
                }
                // Clone the leading row so Comment (and any other persisted field) carries through,
                // matching the click + held-key folds above. Delay rides along via Clone().
                combined = input[start].Clone();
                combined.ActionType = "Keystroke";
                combined.Key = BuildCombo(mods, null);
                return k - start;
            }

            string key = input[j].Key;
            j++;
            if (j >= input.Count || input[j].ActionType != "KeyUp" || !KeyEq(input[j].Key, key)) return 0;
            j++;
            for (int m = mods.Count - 1; m >= 0; m--)
            {
                if (j >= input.Count || input[j].ActionType != "KeyUp" || !KeyEq(input[j].Key, mods[m])) return 0;
                j++;
            }
            // Clone the leading row so Comment (and any other persisted field) carries through,
            // matching the click + held-key folds above. Delay rides along via Clone().
            combined = input[start].Clone();
            combined.ActionType = "Keystroke";
            combined.Key = mods.Count > 0 ? BuildCombo(mods, key) : key;
            return j - start;
        }

        private static bool KeyEq(string? a, string? b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

        private static bool TryClickButton(string actionType, bool down, out string button)
        {
            button = "";
            string suffix = down ? "ClickDown" : "ClickUp";
            foreach (var b in new[] { "Left", "Right", "Middle" })
                if (actionType == b + suffix) { button = b; return true; }
            return false;
        }

        // Joins modifiers (+ optional target) into the canonical "Win+Ctrl+Shift+Alt+Key" form
        // SimulateKeystroke parses — identical to what manual "Send Keystroke" / hotkey capture
        // produce, so a converted combo replays the same as a recorded one.
        private static string BuildCombo(IReadOnlyCollection<string> mods, string? target)
        {
            var parts = new List<string>();
            foreach (var m in new[] { "Win", "Ctrl", "Shift", "Alt" })
                if (mods.Any(x => KeyEq(x, m))) parts.Add(m);
            if (!string.IsNullOrEmpty(target)) parts.Add(target);
            return string.Join("+", parts);
        }
    }
}
