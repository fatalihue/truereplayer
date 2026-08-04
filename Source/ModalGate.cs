using System;
using System.Threading;

namespace TrueReplayer.Services
{
    /// <summary>
    /// One ContentDialog at a time, process-wide.
    ///
    /// WinUI throws "Only a single ContentDialog can be open at any time" from ShowAsync, and
    /// because that happens inside a XAML callback it surfaces as a STOWED exception
    /// (0xc000027b) — which terminates the process WITHOUT reaching App's UnhandledException
    /// handler. That is why the crash this guard exists to prevent left an EMPTY session log: the
    /// last line was a clean "Replay finished" and then nothing, with the real cause visible only
    /// in the Windows Event Log (faulting module CoreMessagingXP.dll).
    ///
    /// Reproduced by an automation trigger firing every few seconds while profile switches with
    /// unsaved changes were queued: each switch asks CheckUnsavedChangesAsync, which shows a
    /// dialog, and the second request landed while the first dialog was still up. Nothing about
    /// that requires a test harness — a user with an armed automation who clicks two profiles in
    /// a row gets the same race.
    ///
    /// The gate REFUSES rather than queues. Queueing would pop a dialog later, detached from the
    /// action that asked for it, about a decision the user has usually already made in the first
    /// one. Every caller maps the refusal onto its existing cancel path, which is the correct
    /// reading anyway: "a question is already on screen, this second request does not proceed".
    ///
    /// All callers are on the UI thread, so a plain bool would do; Interlocked costs nothing and
    /// removes the assumption.
    /// </summary>
    internal static class ModalGate
    {
        private static int _open;

        /// <summary>True while a guarded dialog is on screen.</summary>
        public static bool IsOpen => Volatile.Read(ref _open) != 0;

        /// <summary>
        /// Claims the gate. Returns null when a dialog is ALREADY open — the caller must then
        /// return its own "user cancelled" value without showing anything. Dispose (or a
        /// <c>using</c>) releases it.
        /// </summary>
        /// <param name="what">
        /// Short name of the dialog asking, used only for the refusal log line. A refusal is
        /// otherwise completely silent — every caller maps it onto its own cancel path, which
        /// means "Exit from the tray did nothing" and "the close button did nothing" look
        /// identical to a user cancelling, in the UI AND in the session log. One line here makes
        /// the difference visible without inventing UI for a case nobody should hit often.
        /// </param>
        public static IDisposable? TryEnter(string what = "dialog")
        {
            if (Interlocked.CompareExchange(ref _open, 1, 0) == 0) return new Token();
            DiagnosticLog.Info($"Modal refused ('{what}'): another dialog is already open.");
            return null;
        }

        private sealed class Token : IDisposable
        {
            private int _disposed;
            public void Dispose()
            {
                // Idempotent: a double dispose must not free the gate for someone else's dialog.
                if (Interlocked.Exchange(ref _disposed, 1) == 0) Volatile.Write(ref _open, 0);
            }
        }
    }
}
