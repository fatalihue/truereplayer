using System.Collections.Generic;
using System.Threading;
using TrueReplayer.Models;

namespace TrueReplayer.Services
{
    /// <summary>
    /// Ticks whenever the action list is replaced WHOLESALE, or the active profile changes.
    ///
    /// This exists because the app has long-running operations that outlive the state they were
    /// started against: a screen-capture overlay the user drags a rectangle on, a WinForms file
    /// picker on a detached STA thread. None of those block the app, so the automation daemon can
    /// fire underneath them, and a fire swaps UserProfile.Current and refills the action list
    /// (MainWindow.RunProfileTriggerAsync). The operation then completes and writes its result
    /// into whatever is loaded NOW — a reference PNG into another profile's image directory, or an
    /// Insert at an index from a list that no longer exists.
    ///
    /// The counter is deliberately separate from any lock or suppression flag. That separation is
    /// the whole point of the design: a lock that fails open would bring the corruption back,
    /// while this pair (epoch + by-reference anchor) runs unconditionally and never consults a
    /// scope. The worst case degrades to an ANNOUNCED abort ("the profile changed while you were
    /// selecting"), never a silent write to the wrong place.
    /// </summary>
    internal static class ProfileEpoch
    {
        private static int _value;

        /// <summary>Current generation. Compare, never persist.</summary>
        public static int Current => Volatile.Read(ref _value);

        /// <summary>
        /// Invalidates every outstanding <see cref="EditScope"/>. Call BEFORE a bulk swap, not
        /// after — a scope captured mid-swap must be considered stale, and reading the epoch is
        /// the last thing a resuming operation does.
        /// </summary>
        /// <param name="reason">
        /// Short cause, logged. Without it "the capture aborted" is indistinguishable from a bug;
        /// with it the session log names the profile switch or undo that invalidated the scope.
        /// </param>
        public static void Bump(string reason)
        {
            int n = Interlocked.Increment(ref _value);
            DiagnosticLog.Info($"Profile epoch -> {n} ({reason})");
        }
    }

    /// <summary>
    /// "What the user was looking at when this long operation started." Capture one before opening
    /// an overlay or a picker, then require <see cref="TryResume"/> to succeed before applying the
    /// result.
    ///
    /// Three checks, and each one catches a case the other two miss:
    ///   • profile NAME  - the per-profile image directory changed, so a PNG would be written into
    ///                     another profile's folder while the row lands in this one.
    ///   • EPOCH         - the list was replaced wholesale within the SAME profile (undo/redo,
    ///                     paired-to-combined conversion, Clear All). The name check sees nothing.
    ///   • ANCHOR        - the row itself moved or was deleted. Compared BY REFERENCE, so it
    ///                     survives inserts and reorders above it, which a stored index cannot.
    ///                     `index &lt; actions.Count` is a bounds check, not an identity check: it
    ///                     happily passes while pointing at a different row.
    /// </summary>
    internal readonly struct EditScope
    {
        public int Epoch { get; }
        public string ProfileName { get; }
        public ActionItem? Anchor { get; }

        private EditScope(int epoch, string profileName, ActionItem? anchor)
        {
            Epoch = epoch;
            ProfileName = profileName;
            Anchor = anchor;
        }

        /// <param name="anchor">
        /// The row this operation will write back into, or null for operations that only care
        /// about the profile (e.g. a plain "save this image under the current profile").
        /// </param>
        public static EditScope Capture(string profileName, ActionItem? anchor = null)
            => new EditScope(ProfileEpoch.Current, profileName, anchor);

        /// <summary>
        /// True when the result may still be applied. On false, <paramref name="reason"/> is a
        /// user-facing sentence — callers are expected to surface it (alert:show + Warn), never to
        /// abort silently. Aborting without a word after the user has drawn a rectangle is worse
        /// than the exception this replaces.
        /// </summary>
        public bool TryResume(string currentProfileName, out string reason)
        {
            if (!string.Equals(currentProfileName, ProfileName, System.StringComparison.Ordinal))
            {
                reason = $"The active profile changed from \"{ProfileName}\" to \"{currentProfileName}\" — this was not applied.";
                return false;
            }
            if (ProfileEpoch.Current != Epoch)
            {
                reason = "The action list changed while this was open — this was not applied.";
                return false;
            }
            reason = string.Empty;
            return true;
        }

        /// <summary>
        /// <see cref="TryResume"/> plus the anchor's CURRENT position. Use this instead of a stored
        /// index anywhere a row is written back after an await.
        /// </summary>
        public bool TryResolveIndex(IList<ActionItem> actions, string currentProfileName, out int index, out string reason)
        {
            index = -1;
            if (!TryResume(currentProfileName, out reason)) return false;
            if (Anchor == null)
            {
                reason = "No anchor was captured for this operation.";
                return false;
            }
            // Reference identity, not Equals: two rows can be value-equal (duplicated actions are
            // ordinary) and only the instance says WHICH one the user opened.
            for (int i = 0; i < actions.Count; i++)
            {
                if (ReferenceEquals(actions[i], Anchor)) { index = i; return true; }
            }
            reason = "That action was removed while this was open — this was not applied.";
            return false;
        }
    }
}
