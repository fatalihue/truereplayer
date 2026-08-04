using System;
using System.Collections.Generic;
using System.Threading;

namespace TrueReplayer.Services
{
    /// <summary>
    /// "The user is in the middle of an interaction the app must not yank out from under them."
    ///
    /// The signal that existed before this was <see cref="TrueReplayer.InputHookManager.SuppressAllHotkeys"/>,
    /// a plain bool with several owners and no refcount. Two overlapping owners were enough to
    /// break it in both directions: the inner one's release cleared the outer one's suppression
    /// (fails OPEN — an automation fires while a region overlay is up), and any owner that leaked
    /// on an early return left it stuck true (fails CLOSED — every hotkey, hotstring and
    /// automation in the app dies until restart, while the tray still says "N automations armed").
    /// Both were real: see the early-return comment that used to sit in
    /// HandleAutomationCaptureImageAsync, written after the second one happened.
    ///
    /// A refcount fixes the first. The second is why the periodic sweep exists rather than a
    /// deadline checked only on read: a scope nobody disposes is exactly the case where nobody is
    /// reading, so an on-read deadline would never fire and the leak would be permanent.
    ///
    /// THE LOAD-BEARING PROPERTY: this lock is not the mechanism that keeps data correct.
    /// The epoch + reference-anchor pair (EditScope) does that, unconditionally, without consulting
    /// any scope. That is what lets this fail OPEN safely — a swept-away scope costs an announced
    /// abort ("the profile changed while you were selecting"), not a PNG written into the wrong
    /// profile. Any future change that makes correctness DEPEND on this being held turns every
    /// leak into a choice between killing the owner's 33 hotkeys and corrupting their data.
    ///
    /// <see cref="IsAnyOpen"/> is read from the low-level mouse hook — including on every
    /// WM_MOUSEMOVE — so it must stay a bare field read. The lock guards only the registry the
    /// sweep walks, never the hot path.
    /// </summary>
    internal static class InteractionScope
    {
        /// Hot-path counter. Kept in lockstep with <see cref="_live"/> under <see cref="_lock"/>,
        /// but READ without any lock — see the class remarks.
        private static int _count;

        /// Exclusive holder, if any. Separate from the count because an exclusive scope still
        /// participates in suppression; it only additionally refuses a second exclusive claim.
        private static int _exclusive;
        private static string _exclusiveOwner = "";

        private static readonly Dictionary<long, Entry> _live = new();
        private static readonly object _lock = new();
        private static long _nextId;

        /// Held in a static so the GC cannot collect a timer that nothing else references —
        /// a collected sweep timer is indistinguishable from a sweep that never finds anything.
        private static Timer? _sweeper;

        private const int SweepIntervalMs = 30_000;

        /// A scope that outlives this is a bug, not a slow user. Overlays are TopMost and
        /// full-screen, dialogs are answered or abandoned; nothing legitimate sits here for five
        /// minutes. Call sites that genuinely can (a file picker while the user browses a NAS)
        /// pass their own.
        private static readonly TimeSpan DefaultTtl = TimeSpan.FromMinutes(5);

        private sealed class Entry
        {
            public string Owner = "";
            public DateTime Deadline;
        }

        /// <summary>True while at least one interaction scope is open. Bare field read.</summary>
        public static bool IsAnyOpen => Volatile.Read(ref _count) > 0;

        /// <summary>
        /// Name of an open scope, for diagnostics only ("skipped — region overlay open" beats
        /// "skipped"). Takes the lock, so never call it from a hook callback.
        /// Returns the EARLIEST-opened scope: with several open it is the outermost one, which is
        /// the one that describes what the user is actually doing.
        /// </summary>
        public static string? CurrentOwner
        {
            get
            {
                lock (_lock)
                {
                    string? best = null;
                    long bestId = long.MaxValue;
                    foreach (var kv in _live)
                    {
                        if (kv.Key < bestId) { bestId = kv.Key; best = kv.Value.Owner; }
                    }
                    return best;
                }
            }
        }

        /// <summary>
        /// Opens a scope. Never refuses and never returns null — the caller is telling us what is
        /// happening, not asking permission. Dispose (or a <c>using</c>) closes it.
        /// </summary>
        /// <param name="owner">Short name of the interaction, used by diagnostics and the sweep.</param>
        /// <param name="ttl">Override the default leak deadline. See <see cref="DefaultTtl"/>.</param>
        public static IDisposable Enter(string owner, TimeSpan? ttl = null) => Open(owner, ttl, exclusive: false)!;

        /// <summary>
        /// Opens a scope that also claims exclusivity: returns null when another EXCLUSIVE scope is
        /// already open, and the caller must then take its own cancel path without showing
        /// anything. For surfaces where a second instance is not merely redundant but harmful —
        /// two file pickers owned by nobody, stacked over each other.
        ///
        /// Non-exclusive scopes never block this and are never blocked by it: an overlay being up
        /// does not make a picker illegal, it just makes both count.
        /// </summary>
        public static IDisposable? EnterExclusive(string owner, TimeSpan? ttl = null) => Open(owner, ttl, exclusive: true);

        private static IDisposable? Open(string owner, TimeSpan? ttl, bool exclusive)
        {
            var token = new Token(exclusive);
            lock (_lock)
            {
                if (exclusive && _exclusive != 0)
                {
                    DiagnosticLog.Info($"Interaction refused ('{owner}'): '{_exclusiveOwner}' is already open.");
                    return null;
                }

                token.Id = ++_nextId;
                _live[token.Id] = new Entry
                {
                    Owner = string.IsNullOrEmpty(owner) ? "interaction" : owner,
                    Deadline = DateTime.UtcNow + (ttl ?? DefaultTtl),
                };
                Volatile.Write(ref _count, _live.Count);
                if (exclusive) { _exclusive = 1; _exclusiveOwner = _live[token.Id].Owner; }

                // Armed on first use rather than at type-init: an app that never opens a scope
                // should not carry a timer waking the process every 30 s forever.
                _sweeper ??= new Timer(_ => Sweep(), null, SweepIntervalMs, SweepIntervalMs);
            }
            return token;
        }

        private static void Close(long id, bool exclusive)
        {
            lock (_lock)
            {
                // Remove returning false means the sweep already force-closed this id. Returning
                // here is what keeps a late Dispose from clearing the exclusive flag of whatever
                // legitimately claimed it after the sweep let go.
                if (!_live.Remove(id)) return;
                Volatile.Write(ref _count, _live.Count);
                if (exclusive) { _exclusive = 0; _exclusiveOwner = ""; }
            }
        }

        /// <summary>
        /// Force-closes scopes past their deadline. Every hit is a leak — a scope whose owner
        /// returned without disposing — so it is logged as a warning naming the owner, which is the
        /// only breadcrumb that will exist when someone reports "my hotkeys stopped working".
        /// </summary>
        private static void Sweep()
        {
            List<string>? expired = null;
            lock (_lock)
            {
                var now = DateTime.UtcNow;
                List<long>? ids = null;
                foreach (var kv in _live)
                {
                    if (kv.Value.Deadline > now) continue;
                    (ids ??= new()).Add(kv.Key);
                    (expired ??= new()).Add(kv.Value.Owner);
                }
                if (ids == null) return;
                foreach (var id in ids) _live.Remove(id);
                Volatile.Write(ref _count, _live.Count);
                // An exclusive scope that leaked would otherwise refuse every future exclusive
                // claim for the life of the process — the same permanent-death failure the sweep
                // exists to end, one level up.
                if (_live.Count == 0) { _exclusive = 0; _exclusiveOwner = ""; }
            }
            foreach (var owner in expired!)
                DiagnosticLog.Warn($"Interaction scope '{owner}' expired and was force-closed — it was never disposed. Hotkeys are live again.");
        }

        private sealed class Token : IDisposable
        {
            private readonly bool _exclusive;
            private int _disposed;
            public long Id;

            public Token(bool exclusive) => _exclusive = exclusive;

            public void Dispose()
            {
                // Idempotent, and for the same reason ModalGate's is: a double dispose must not
                // decrement someone else's scope. It also makes Dispose safe to call after the
                // sweep already removed this id — Close simply finds nothing.
                if (Interlocked.Exchange(ref _disposed, 1) == 0) Close(Id, _exclusive);
            }
        }
    }
}
