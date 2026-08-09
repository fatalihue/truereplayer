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

        /// A scope that outlives this is a bug, not a slow user — for surfaces the user cannot
        /// walk away from. Dialogs are answered or abandoned; nothing legitimate sits here for
        /// five minutes. Call sites that genuinely can pass their own: a file picker while the
        /// user browses a NAS passes 20 minutes, and the screen-capture overlays pass a liveness
        /// probe instead of a longer number — see <see cref="Enter(string, Func{bool}, TimeSpan?)"/>.
        private static readonly TimeSpan DefaultTtl = TimeSpan.FromMinutes(5);

        private sealed class Entry
        {
            public string Owner = "";
            public DateTime Deadline;

            /// Renewal probe, or null for a plain deadline. See the keepAlive overload of Enter.
            public Func<bool>? KeepAlive;

            /// How far a successful probe pushes the deadline out. The scope's ORIGINAL ttl, not a
            /// fixed number, so a renewed scope is still force-closed within one ttl of the probe
            /// going false — renewal delays the backstop, it never disables it.
            public TimeSpan Ttl;
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
        public static IDisposable Enter(string owner, TimeSpan? ttl = null) => Open(owner, ttl, null, exclusive: false)!;

        /// <summary>
        /// Opens a scope whose deadline RENEWS for as long as <paramref name="keepAlive"/> answers
        /// true. For the screen-capture overlays, and the reason is a specific way the plain
        /// deadline fails them.
        ///
        /// A region picker is exactly the surface that invites walking away — comparing two
        /// screens, waiting for a game to load. The overlay is a plain WinForms window, so nothing
        /// about it is protected: once the sweep force-closes the scope, <see cref="IsAnyOpen"/>
        /// goes false and hotkey suppression clears WHILE THE OVERLAY IS STILL ON SCREEN. An armed
        /// interval trigger then fires, switches profile and injects clicks through SendInput —
        /// and those clicks land in the overlay. In point-pick mode that COMMITS a pixel the user
        /// never chose; in region mode it drags a rectangle. The three pickers that only return a
        /// coordinate (position pick, pixel pick, RunRegionPickerAsync) have no EditScope net
        /// underneath them to catch the result, so the bad value is simply what the user gets.
        ///
        /// A longer flat ttl was the other candidate and is strictly worse: it weakens leak
        /// detection for every overlay AND still eventually fires under a live one, so it trades a
        /// certain harm for a rarer one. The probe keeps the safety net at full strength — an
        /// overlay whose owner returned without disposing has a dead probe and is swept on exactly
        /// the old schedule — while a live overlay is renewed for as long as it is genuinely up.
        /// </summary>
        /// <param name="keepAlive">
        /// Called by the sweep, on a timer thread, only after the deadline has already passed —
        /// never on the hot path. Must be cheap and must not block. True means "the thing this
        /// scope describes is still on screen"; the overlay sites pass the STA thread's IsAlive,
        /// which is true for precisely the window between Start() and the form closing. A probe
        /// that throws counts as false: an un-closeable scope is the failure this whole class
        /// exists to prevent.
        /// </param>
        public static IDisposable Enter(string owner, Func<bool> keepAlive, TimeSpan? ttl = null)
            => Open(owner, ttl, keepAlive, exclusive: false)!;

        /// <summary>
        /// Both at once: claims exclusivity AND renews against a liveness probe. Returns null when
        /// another exclusive scope is already open, exactly like <see cref="EnterExclusive(string, TimeSpan?)"/>.
        /// </summary>
        /// <remarks>
        /// This is what the screen-capture overlays need. The exclusivity argument is the same one
        /// written out for the file picker: two full-screen TopMost windows showing the same
        /// screenshot, stacked, with no way for the user to tell which one their click answered —
        /// and each holding a bitmap of the entire virtual desktop. The keep-alive argument is the
        /// one above. Neither substitutes for the other, and until this overload existed the sites
        /// had to pick one.
        ///
        /// The protection they had instead lived in the frontend, which disables the pick buttons
        /// while a request is in flight. That works, and it is why this was never reachable — but
        /// it is a backend invariant defended in the UI layer, which is the wrong place for it: a
        /// second entry point (a command, a hotkey, a future caller) would not inherit it.
        /// </remarks>
        public static IDisposable? EnterExclusive(string owner, Func<bool> keepAlive, TimeSpan? ttl = null)
            => Open(owner, ttl, keepAlive, exclusive: true);

        /// <summary>
        /// Opens a scope that also claims exclusivity: returns null when another EXCLUSIVE scope is
        /// already open, and the caller must then take its own cancel path without showing
        /// anything. For surfaces where a second instance is not merely redundant but harmful —
        /// two file pickers owned by nobody, stacked over each other.
        ///
        /// Non-exclusive scopes never block this and are never blocked by it: an overlay being up
        /// does not make a picker illegal, it just makes both count.
        /// </summary>
        public static IDisposable? EnterExclusive(string owner, TimeSpan? ttl = null) => Open(owner, ttl, null, exclusive: true);

        private static IDisposable? Open(string owner, TimeSpan? ttl, Func<bool>? keepAlive, bool exclusive)
        {
            var token = new Token(exclusive);
            lock (_lock)
            {
                if (exclusive && _exclusive != 0)
                {
                    DiagnosticLog.Info($"Interaction refused ('{owner}'): '{_exclusiveOwner}' is already open.");
                    return null;
                }

                var effectiveTtl = ttl ?? DefaultTtl;
                token.Id = ++_nextId;
                _live[token.Id] = new Entry
                {
                    Owner = string.IsNullOrEmpty(owner) ? "interaction" : owner,
                    Deadline = DateTime.UtcNow + effectiveTtl,
                    KeepAlive = keepAlive,
                    Ttl = effectiveTtl,
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
        /// Force-closes scopes past their deadline, unless their keep-alive probe says the thing
        /// they describe is still on screen. A hit with no probe, or a probe that answers false, is
        /// a leak — a scope whose owner returned without disposing — so it is logged as a warning
        /// naming the owner, the only breadcrumb that will exist when someone reports "my hotkeys
        /// stopped working".
        ///
        /// Three phases, and the split is not stylistic. KeepAlive is a delegate handed in by a
        /// caller: running it inside <see cref="_lock"/> would let any future probe that takes a
        /// lock of its own deadlock the sweep, and a deadlocked sweep is a permanently stuck
        /// suppression flag — the exact failure this class was written to end. Collect under the
        /// lock, probe with nothing held, commit under the lock again.
        /// </summary>
        private static void Sweep()
        {
            List<(long Id, string Owner, Func<bool>? KeepAlive)>? due = null;
            lock (_lock)
            {
                var now = DateTime.UtcNow;
                foreach (var kv in _live)
                {
                    if (kv.Value.Deadline > now) continue;
                    (due ??= new()).Add((kv.Key, kv.Value.Owner, kv.Value.KeepAlive));
                }
            }
            if (due == null) return;

            var verdicts = new List<(long Id, string Owner, bool Alive)>(due.Count);
            foreach (var (id, owner, keepAlive) in due)
            {
                bool alive = false;
                if (keepAlive != null)
                {
                    // A probe that throws is not evidence of life. Counting it as alive would give
                    // the scope an unbounded lease off the back of a bug, which is the one outcome
                    // worse than closing it early.
                    try { alive = keepAlive(); }
                    catch (Exception ex)
                    {
                        DiagnosticLog.Warn($"Interaction keep-alive probe for '{owner}' threw ({ex.Message}) — treating the scope as expired.");
                    }
                }
                verdicts.Add((id, owner, alive));
            }

            List<string>? renewed = null;
            List<string>? expired = null;
            lock (_lock)
            {
                foreach (var (id, owner, alive) in verdicts)
                {
                    // Absent means Dispose won the race while we were probing. Skip it: writing a
                    // fresh deadline for a missing id would resurrect a closed scope as a
                    // permanent one, since nothing is left to dispose it a second time.
                    if (!_live.TryGetValue(id, out var entry)) continue;
                    if (alive)
                    {
                        entry.Deadline = DateTime.UtcNow + entry.Ttl;
                        (renewed ??= new()).Add(owner);
                        continue;
                    }
                    _live.Remove(id);
                    (expired ??= new()).Add(owner);
                }
                Volatile.Write(ref _count, _live.Count);
                // An exclusive scope that leaked would otherwise refuse every future exclusive
                // claim for the life of the process — the same permanent-death failure the sweep
                // exists to end, one level up.
                if (_live.Count == 0) { _exclusive = 0; _exclusiveOwner = ""; }
            }

            if (renewed != null)
            {
                // Logged, not silent: "the user sat in the capture overlay for twenty minutes" is
                // the explanation for a whole class of "my automation never fired" reports, and
                // this line is the only place that fact is ever written down. At most one per
                // scope per ttl, so it cannot flood the session log.
                foreach (var owner in renewed)
                    DiagnosticLog.Info($"Interaction scope '{owner}' passed its deadline but is still on screen — renewed. Hotkeys stay suppressed.");
            }
            if (expired != null)
            {
                foreach (var owner in expired)
                    DiagnosticLog.Warn($"Interaction scope '{owner}' expired and was force-closed — it was never disposed. Hotkeys are live again.");
            }
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
