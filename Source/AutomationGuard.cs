using System.Threading;

namespace TrueReplayer.Services
{
    /// <summary>
    /// The one place that answers "may an autonomous fire proceed right now, and if not, why".
    ///
    /// The reason half is not decoration. Steps 4-5 deliberately RAISE the skip rate: overlays and
    /// file pickers that previously did not register as "user mid-interaction" now do, which is the
    /// correct behaviour and also new behaviour, in an app with armed automations and 84 profiles.
    /// A skipped fire is LOST, not queued. Reported as a bare "skipped (dialog open)" while the
    /// screen looks perfectly idle — because the thing holding it is a full-screen overlay the user
    /// already dismissed, or a picker behind the main window — that is indistinguishable from a
    /// bug, and it would be reported as a regression of the automation engine.
    ///
    /// Composed here rather than at each call site because the two readers (the hotkey/hotstring
    /// path and the trigger path) drifting apart is how one of them ends up firing into a state the
    /// other refuses.
    /// </summary>
    internal static class AutomationGuard
    {
        /// <summary>
        /// Null when nothing blocks an autonomous fire. Otherwise a short phrase naming what does,
        /// suitable for the Automation panel's result line.
        ///
        /// IsCaptureDialogOpen rather than CaptureHotkeyMode: the latter is additionally gated on
        /// TrueReplayer being the foreground app, which an autonomous fire by definition almost
        /// never is — using it here would read false exactly when it matters.
        /// </summary>
        public static string? BlockedReason()
        {
            // Most specific first: the scope knows WHICH interaction, and it is also the most
            // common blocker now that overlays and pickers register.
            var owner = InteractionScope.CurrentOwner;
            if (owner != null)
            {
                var reason = $"skipped ({owner})";
                LastReason = reason;
                return reason;
            }
            if (TrueReplayer.InputHookManager.SuppressAllHotkeys)
            {
                // No scope open, so this is the frontend channel: a React modal is up.
                const string reason = "skipped (a dialog is open)";
                LastReason = reason;
                return reason;
            }
            if (TrueReplayer.InputHookManager.IsCaptureDialogOpen)
            {
                const string reason = "skipped (capturing a hotkey)";
                LastReason = reason;
                return reason;
            }
            return null;
        }

        /// <summary>
        /// The phrase from the most recent blocked check.
        ///
        /// It exists because the decision and the bookkeeping happen in different places: the fire
        /// path decides (and returns a bare enum), TriggerService records. Re-asking BlockedReason
        /// at record time would be worse than this — by then the overlay is usually closed, so it
        /// would answer "nothing is blocking" for a fire that was demonstrably blocked.
        ///
        /// Two skips racing can therefore label one with the other's reason. That is a cosmetic
        /// mislabel in a diagnostics line, and both were genuinely blocked; nothing branches on it.
        /// </summary>
        public static string? LastReason
        {
            get => Volatile.Read(ref _lastReason);
            private set => Volatile.Write(ref _lastReason, value);
        }

        private static string? _lastReason;
    }
}
