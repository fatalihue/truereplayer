using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.UI.Dispatching;
using TrueReplayer.Interop;
using TrueReplayer.Models;

namespace TrueReplayer.Services
{
    /// <summary>
    /// Outcome of one trigger fire attempt, decided ON THE UI THREAD so the busy checks
    /// can't race hotkey dispatch (both are serialized by the dispatcher queue).
    /// </summary>
    public enum TriggerFireResult
    {
        Fired,
        SkippedBusy,     // replay / recording / clicker mode active — retriable
        SkippedDirty,    // unsaved edits in the grid — an autonomous fire must never discard them
        SkippedModal,    // user mid-interaction: dialog, overlay, file picker, or hotkey capture
        NotReady,        // WebView2/bridge not up yet (app boot) — retriable, NOT a failure
        Failed,          // profile missing or the start path threw — permanent for this edge
    }

    /// <summary>
    /// The automation daemon: one lightweight watcher loop per ARMED profile trigger
    /// (interval / schedule / condition), each with its own CancellationTokenSource —
    /// deliberately decoupled from the replay engine's single _cts. Loops only OBSERVE;
    /// every fire is marshalled to the UI thread where MainWindow re-checks the busy
    /// gates and starts the replay through the same path a profile hotkey uses.
    /// Reload() is DIFF-BASED: loops whose serialized config is unchanged keep running
    /// (interval anchors, schedule dedup and condition edge state survive the constant
    /// profile-list refreshes the app does on every save/import/toggle).
    /// </summary>
    public class TriggerService
    {
        public static TriggerService? Instance { get; private set; }

        private readonly DispatcherQueue dispatcherQueue;
        private readonly object _lock = new();
        private readonly Dictionary<string, TriggerRuntime> _runtimes = new(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, TriggerStats> _stats = new(StringComparer.OrdinalIgnoreCase);
        // Profiles whose watcher loop has started at least once IN THIS PROCESS. Distinguishes a
        // cold start (the app was closed, an overdue interval tick deserves a catch-up) from a
        // Reload-driven restart (an edit or an arm toggle, where catching up would be an ambush).
        private readonly HashSet<string> _coldStarted = new(StringComparer.OrdinalIgnoreCase);
        // Last fire outcome actually written to the diagnostic log, per profile — so a blocked
        // watcher retrying every few seconds logs once, not forever. See RequestFireAsync.
        private readonly Dictionary<string, string?> _lastLoggedOutcome = new(StringComparer.OrdinalIgnoreCase);
        // Last full config list seen (armed or not) — used by SetGlobalEnabled(true) to
        // re-arm without waiting for the next profile-list refresh, and by GetStatus().
        private List<(string Name, ProfileTriggerConfig Config)> _lastConfigs = new();
        private volatile bool _globalEnabled = true;
        // App-originated clipboard traffic window: while a replay runs (and shortly after),
        // and after a capture-slot use, clipboard watchers rebaseline instead of firing —
        // SendText paste/restore bumps the sequence number twice per action.
        private long _clipboardSuppressUntilTicks;

        /// <summary>UI-thread fire entry — set by MainWindow (gates + shared dispatch body).</summary>
        public Func<string, Task<TriggerFireResult>>? FireProfile { get; set; }
        /// <summary>True while the single engine is replaying (clipboard rebaseline uses it).</summary>
        public Func<bool>? IsReplayActive { get; set; }
        /// <summary>Raised (on the calling thread) whenever status meaningfully changed — arm,
        /// fire, skip, condition flip. The bridge coalesces + pushes automation:state.</summary>
        public Action? OnStateChanged { get; set; }

        public bool GlobalEnabled => _globalEnabled;

        public TriggerService(DispatcherQueue dispatcherQueue)
        {
            this.dispatcherQueue = dispatcherQueue;
            Instance = this;
            // One pump for the whole app — see the fire-queue region. Started here rather than
            // lazily so there is exactly one, created before any watcher loop can exist.
            _ = Task.Run(() => RunFirePumpAsync(_pumpCts.Token));
        }

        private sealed class TriggerRuntime
        {
            public string ConfigKey = "";                 // serialized config — diff identity
            public ProfileTriggerConfig Config = null!;
            public CancellationTokenSource Cts = null!;
            public volatile bool ConditionTrue;           // last probe result (status display)
            public long NextDueTicks;                     // interval/schedule: next planned fire (DateTime ticks, local)
        }

        private sealed class TriggerStats
        {
            public DateTime? LastFiredAt;
            public int FireCount;
            public int SkippedBusy;
            public int SkippedDirty;
            public int SkippedModal;
            // Clipboard changes swallowed by the app-traffic window. Deliberately NOT SkippedBusy:
            // these were never fire ATTEMPTS, so folding them in would corrupt the number that
            // means "the engine was busy".
            public int SkippedSuppressed;
            public string? LastResult;                    // short human-readable outcome line
            public long LastScheduleOccurrenceTicks;      // double-fire guard across loop restarts
            // Cooldown survives loop restarts (config edits) — a loop-local copy would let an
            // edit right after a fire re-fire immediately, voiding the cooldown the user set.
            public long CooldownUntilTicks;
        }

        public sealed class AutomationStatusEntry
        {
            public string Profile = "";
            public ProfileTriggerConfig Config = null!;
            public bool Running;                          // loop currently armed + alive
            public bool ConditionTrue;
            public DateTime? NextDueAt;
            public DateTime? LastFiredAt;
            public int FireCount;
            public int SkippedBusy;
            public int SkippedDirty;
            public int SkippedModal;
            public int SkippedSuppressed;
            public string? LastResult;
        }

        public int ArmedCount
        {
            get { lock (_lock) return _runtimes.Count; }
        }

        /// <summary>Armed triggers in CONFIG (independent of the global master switch) —
        /// lets the tray show "automations paused" instead of silently dropping the count.</summary>
        public int ConfiguredArmedCount
        {
            get { lock (_lock) return _lastConfigs.Count(c => c.Config is { Armed: true }); }
        }

        /// <summary>
        /// Sync the watcher pool to the current profile list. Called from the profile-list
        /// registration choke point (every reload) and from SetGlobalEnabled — must stay
        /// cheap and diff-based (see class doc). UI thread.
        /// </summary>
        /// <param name="allProfileNames">
        /// EVERY profile that exists, armed or not, enabled or not. Used ONLY to prune stats for
        /// profiles that are genuinely gone. It cannot be derived from <paramref name="configs"/>:
        /// that list is GetProfileTriggers(), which drops disabled profiles and profiles whose
        /// JSON failed to load — so pruning against it would read "merely disabled" as "deleted"
        /// and, now that the prune is written through to the sidecar, permanently destroy that
        /// automation's fire history and its interval anchor. Null = do not prune.
        /// </param>
        public void Reload(List<(string Name, ProfileTriggerConfig Config)> configs,
                           IReadOnlyCollection<string>? allProfileNames = null)
        {
            List<string> started = new(), stopped = new();
            bool prunedStats = false;
            lock (_lock)
            {
                _lastConfigs = configs;
                var desired = new Dictionary<string, (string Key, ProfileTriggerConfig Config)>(StringComparer.OrdinalIgnoreCase);
                if (_globalEnabled)
                {
                    foreach (var (name, config) in configs)
                    {
                        if (config is { Armed: true })
                            desired[name] = (SerializeConfig(config), config);
                    }
                }

                // Stop loops that vanished or whose config changed.
                foreach (var name in _runtimes.Keys.ToList())
                {
                    if (!desired.TryGetValue(name, out var d) || d.Key != _runtimes[name].ConfigKey)
                    {
                        _runtimes[name].Cts.Cancel();
                        _runtimes.Remove(name);
                        stopped.Add(name);
                    }
                }

                // Start loops that are new or changed. Unchanged loops keep their state.
                foreach (var (name, d) in desired)
                {
                    if (_runtimes.ContainsKey(name)) continue;
                    var rt = new TriggerRuntime
                    {
                        ConfigKey = d.Key,
                        Config = d.Config.Clone(),        // loop owns a snapshot — later edits can't mutate mid-poll
                        Cts = new CancellationTokenSource(),
                    };
                    _runtimes[name] = rt;
                    var stats = GetStatsLocked(name);
                    _ = Task.Run(() => RunLoopSafeAsync(name, rt, stats, rt.Cts.Token));
                    started.Add(name);
                }

                // Drop stats for profiles that no longer carry a trigger at all (renames are
                // migrated explicitly via RenameStats before the refresh lands here).
                // Only when the caller could tell us what actually exists, and never on an empty
                // set (a failed/partial profile-list load must not read as "everything is gone").
                if (allProfileNames is { Count: > 0 })
                {
                    var known = new HashSet<string>(allProfileNames, StringComparer.OrdinalIgnoreCase);
                    foreach (var name in _stats.Keys.ToList())
                        if (!known.Contains(name))
                        {
                            _stats.Remove(name);
                            _lastLoggedOutcome.Remove(name);
                            _coldStarted.Remove(name);
                            prunedStats = true;
                        }
                }
            }
            // The prune has to reach the SIDECAR as well, or a deleted profile's stats live in the
            // file forever and are read back on the next launch — an entry for a profile that no
            // longer exists, growing without bound as profiles come and go.
            if (prunedStats) MarkStatsDirty();
            if (started.Count > 0 || stopped.Count > 0)
            {
                DiagnosticLog.Info($"Automation: armed [{string.Join(", ", started)}], disarmed [{string.Join(", ", stopped)}]");
                NotifyStateChanged();
            }
        }

        public void SetGlobalEnabled(bool enabled)
        {
            if (_globalEnabled == enabled) return;
            _globalEnabled = enabled;
            List<(string, ProfileTriggerConfig)> configs;
            lock (_lock) configs = _lastConfigs;
            DiagnosticLog.Info($"Automation: global master {(enabled ? "ENABLED" : "DISABLED")}");
            Reload(configs);
            NotifyStateChanged();
        }

        /// <summary>Migrate per-profile fire stats across a profile rename.</summary>
        public void RenameStats(string oldName, string newName)
        {
            lock (_lock)
            {
                if (_stats.TryGetValue(oldName, out var s))
                {
                    _stats.Remove(oldName);
                    _stats[newName] = s;
                }
            }
            MarkStatsDirty();
        }

        /// <summary>Suppress clipboard-change fires for the next 2 s (capture-slot etc.).</summary>
        public void NotifyAppClipboardActivity()
            => Interlocked.Exchange(ref _clipboardSuppressUntilTicks, DateTime.UtcNow.AddSeconds(2).Ticks);

        public void StopAll()
        {
            lock (_lock)
            {
                foreach (var rt in _runtimes.Values) rt.Cts.Cancel();
                _runtimes.Clear();
            }
        }

        public List<AutomationStatusEntry> GetStatus()
        {
            lock (_lock)
            {
                var result = new List<AutomationStatusEntry>();
                foreach (var (name, config) in _lastConfigs)
                {
                    if (config == null) continue;
                    _runtimes.TryGetValue(name, out var rt);
                    _stats.TryGetValue(name, out var st);
                    result.Add(new AutomationStatusEntry
                    {
                        Profile = name,
                        Config = config,
                        Running = rt != null,
                        ConditionTrue = rt?.ConditionTrue ?? false,
                        NextDueAt = rt != null && rt.NextDueTicks > 0 ? new DateTime(rt.NextDueTicks) : null,
                        LastFiredAt = st?.LastFiredAt,
                        FireCount = st?.FireCount ?? 0,
                        SkippedBusy = st?.SkippedBusy ?? 0,
                        SkippedDirty = st?.SkippedDirty ?? 0,
                        SkippedModal = st?.SkippedModal ?? 0,
                        SkippedSuppressed = st?.SkippedSuppressed ?? 0,
                        LastResult = st?.LastResult,
                    });
                }
                return result;
            }
        }

        // ── Loop bodies ──

        private async Task RunLoopSafeAsync(string name, TriggerRuntime rt, TriggerStats stats, CancellationToken ct)
        {
            try
            {
                switch (rt.Config.Kind?.ToLowerInvariant())
                {
                    case "interval": await RunIntervalLoopAsync(name, rt, stats, ct); break;
                    case "schedule": await RunScheduleLoopAsync(name, rt, stats, ct); break;
                    case "condition":
                        if (string.Equals(rt.Config.ConditionType, "ClipboardChanged", StringComparison.OrdinalIgnoreCase))
                            await RunClipboardLoopAsync(name, rt, stats, ct);
                        else
                            await RunConditionLoopAsync(name, rt, stats, ct);
                        break;
                    default:
                        SetLastResult(stats, $"unknown trigger kind '{rt.Config.Kind}'");
                        break;
                }
            }
            catch (OperationCanceledException) { /* disarm */ }
            catch (Exception ex)
            {
                // A watcher loop dying must never take the app down — log + surface in status.
                DiagnosticLog.Error($"Automation watcher '{name}' crashed", ex);
                SetLastResult(stats, $"watcher crashed: {ex.Message}");
            }
            finally
            {
                // A loop that exits for any reason OTHER than disarm (bad config, missing
                // reference image, crash) must leave the registry — else the panel shows
                // Running forever and the diff-based Reload ("unchanged → keep") never
                // restarts it. With the entry gone, the next Reload starts a fresh loop.
                if (!ct.IsCancellationRequested)
                {
                    lock (_lock)
                    {
                        if (_runtimes.TryGetValue(name, out var current) && ReferenceEquals(current, rt))
                            _runtimes.Remove(name);
                    }
                    NotifyStateChanged();
                }
            }
        }

        private async Task RunIntervalLoopAsync(string name, TriggerRuntime rt, TriggerStats stats, CancellationToken ct)
        {
            int seconds = Math.Max(5, rt.Config.IntervalSeconds);
            var period = TimeSpan.FromSeconds(seconds);

            // Anchor the FIRST tick to the last real fire, not to loop start. Anchoring to loop
            // start meant the countdown restarted on every app launch AND on every config edit or
            // arm toggle (Reload restarts a loop whenever the serialized config differs, and Armed
            // is part of that key) — so "every 12 hours" on a machine rebooted nightly never fired
            // once, and the row's "next" silently jumped forward each time with no explanation.
            // Stats are persisted now, so LastFiredAt survives the restart that used to erase it.
            // The catch-up is ONLY for a cold start. A loop restart is not rare: Reload restarts
            // one whenever the serialized config differs, and that key includes Armed — so an arm
            // toggle, a field edit or a master-switch cycle all rebuild the loop. Without this
            // gate, re-arming an automation whose period had elapsed would seize the mouse and
            // keyboard 15 s after the click, with the user still standing in the panel. Anchoring
            // to LastFiredAt is right; treating every restart as "the app was closed" is not.
            bool coldStart;
            lock (_lock) coldStart = _coldStarted.Add(name);

            DateTime? lastFired;
            lock (_lock) lastFired = stats.LastFiredAt;
            var next = lastFired is DateTime lf ? lf + period : DateTime.Now + period;
            if (next <= DateTime.Now)
            {
                if (coldStart)
                {
                    // Overdue while the app was closed. Fire — but after a short settle rather than
                    // the instant the loop starts: at launch the bridge may still be coming up
                    // (NotReady), and an autonomous replay landing on a user who just opened the
                    // app is the same ambush the schedule loop's staleness bound exists to prevent.
                    next = DateTime.Now.AddSeconds(15);
                    DiagnosticLog.Info($"Automation '{name}': interval tick was overdue at startup — firing in 15 s");
                }
                else
                {
                    // Re-armed or edited: start a fresh period, which is also what the editor's own
                    // hint promises ("the first fire happens one interval after arming").
                    next = DateTime.Now + period;
                }
            }

            while (!ct.IsCancellationRequested)
            {
                rt.NextDueTicks = next.Ticks;
                // Sleep in <= 60 s chunks so a clock change or a long suspend can't strand the loop
                // on a single huge Task.Delay (the schedule loop already does this).
                while (!ct.IsCancellationRequested)
                {
                    var remaining = next - DateTime.Now;
                    if (remaining <= TimeSpan.Zero) break;
                    await Task.Delay(remaining > TimeSpan.FromSeconds(60) ? TimeSpan.FromSeconds(60) : remaining, ct);
                }
                if (ct.IsCancellationRequested) break;

                // A busy tick used to be DROPPED outright ("the next tick catches up"), which is
                // only true when the interval is short. On a 30-minute interval that reasoning
                // costs the user half an hour because a replay happened to be running for two
                // seconds. Retry within a window bounded by the interval itself, so a retry can
                // never collide with the following tick.
                var graceEnd = next + TimeSpan.FromSeconds(Math.Min(seconds / 2.0, 180));
                var result = await RequestFireAsync(name, stats, ct, dueAt: next, expiresAt: graceEnd);
                // Anything but Fired/Failed/dirty means the queue held it to the deadline.
                // SkippedDirty is excluded because it comes back immediately and already set a
                // truthful result line — calling that "missed the grace window" would be a lie.
                if (result is not (TriggerFireResult.Fired or TriggerFireResult.Failed or TriggerFireResult.SkippedDirty))
                {
                    SetLastResult(stats, "missed (busy past the grace window)");
                    NotifyStateChanged();
                }

                // Anchor the NEXT tick to the tick we just serviced, not to "now" — otherwise a
                // fire that spent 40 s retrying would push every subsequent tick 40 s later, and
                // an "every 5 minutes" automation would drift off the clock over a day.
                next += period;
                if (next <= DateTime.Now) next = DateTime.Now + period;   // skipped ticks: don't burst-fire the backlog
            }
        }

        // How late a schedule occurrence may be before it is abandoned rather than fired. Sized to
        // comfortably cover the busy-retry grace window (3 min) plus a slow machine, while still
        // being unmistakably "we are past the moment you asked for".
        private static readonly TimeSpan ScheduleStaleAfter = TimeSpan.FromMinutes(10);

        private async Task RunScheduleLoopAsync(string name, TriggerRuntime rt, TriggerStats stats, CancellationToken ct)
        {
            if (!TimeSpan.TryParse(rt.Config.TimeOfDay, System.Globalization.CultureInfo.InvariantCulture, out var timeOfDay))
            {
                SetLastResult(stats, $"invalid schedule time '{rt.Config.TimeOfDay}'");
                NotifyStateChanged();
                return;
            }
            while (!ct.IsCancellationRequested)
            {
                var next = ComputeNextOccurrence(DateTime.Now, timeOfDay, rt.Config.DaysOfWeek);
                // Double-fire guard across loop restarts (global toggle off/on within the
                // fire minute): never re-fire the exact occurrence we already fired.
                long lastOcc;
                lock (_lock) lastOcc = stats.LastScheduleOccurrenceTicks;
                if (next.Ticks == lastOcc)
                    next = ComputeNextOccurrence(next.AddMinutes(1), timeOfDay, rt.Config.DaysOfWeek);
                rt.NextDueTicks = next.Ticks;

                // Sleep in <= 60 s chunks so a system clock change can't strand the loop.
                while (!ct.IsCancellationRequested)
                {
                    var remaining = next - DateTime.Now;
                    if (remaining <= TimeSpan.Zero) break;
                    await Task.Delay(remaining > TimeSpan.FromSeconds(60) ? TimeSpan.FromSeconds(60) : remaining, ct);
                }
                if (ct.IsCancellationRequested) break;

                lock (_lock) stats.LastScheduleOccurrenceTicks = next.Ticks;

                // Staleness bound. The sleep above breaks out as soon as `remaining <= 0`, which
                // across a suspend/hibernate is deeply negative: a 09:00 automation on a laptop
                // closed at 08:30 and opened at 18:00 fired the instant the machine woke — nine
                // hours late, injecting mouse and keyboard at a user who was looking at the
                // screen. A schedule names a MOMENT; once that moment is well past, running it is
                // no longer what the user asked for. (Distinct from the busy-retry grace below,
                // which bounds contention, not lateness.)
                var lateness = DateTime.Now - next;
                if (lateness > ScheduleStaleAfter)
                {
                    SetLastResult(stats, $"skipped — {(int)lateness.TotalMinutes} min late (machine asleep or clock changed)");
                    DiagnosticLog.Warn($"Automation '{name}': schedule occurrence {next:t} skipped, {(int)lateness.TotalMinutes} min stale");
                    NotifyStateChanged();
                    continue;
                }

                // A schedule that lands on a busy moment must NOT lose the whole day (the
                // interval loop's "next tick catches up" reasoning doesn't transfer — the
                // next tick is tomorrow). Retry retriable skips within a bounded grace
                // window; two same-time schedules then run back-to-back instead of one of
                // them deterministically never executing.
                // Queued on the OCCURRENCE time, so a schedule that landed on a busy minute keeps
                // its place ahead of interval ticks that became due while it waited — the
                // "deterministically never executes" case this grace window was written for.
                var graceEnd = next.AddMinutes(3);
                var result = await RequestFireAsync(name, stats, ct, dueAt: next, expiresAt: graceEnd);
                if (result is not (TriggerFireResult.Fired or TriggerFireResult.Failed or TriggerFireResult.SkippedDirty))
                {
                    SetLastResult(stats, "missed (busy past the grace window)");
                    NotifyStateChanged();
                }
            }
        }

        // Next local DateTime >= `after` matching HH:mm + the DaysOfWeek bitmask
        // (Sun = 1<<0, the If-Time convention; 0 = every day).
        internal static DateTime ComputeNextOccurrence(DateTime after, TimeSpan timeOfDay, int daysOfWeek)
        {
            for (int offset = 0; offset <= 7; offset++)
            {
                var candidate = after.Date.AddDays(offset) + timeOfDay;
                if (candidate <= after) continue;
                bool dayOk = daysOfWeek == 0 || (daysOfWeek & (1 << (int)candidate.DayOfWeek)) != 0;
                if (dayOk) return candidate;
            }
            // Unreachable (a 7-day scan always finds a slot), but never loop forever.
            return after.Date.AddDays(8) + timeOfDay;
        }

        private async Task RunConditionLoopAsync(string name, TriggerRuntime rt, TriggerStats stats, CancellationToken ct)
        {
            var cfg = rt.Config;
            bool levelMode = string.Equals(cfg.Retrigger, "level", StringComparison.OrdinalIgnoreCase);
            int cooldownSec = cfg.CooldownSeconds > 0 ? cfg.CooldownSeconds : 30;
            var pendingTtl = TimeSpan.FromSeconds(Math.Max(cooldownSec, 30));
            int pollMs = PollCadenceMs(cfg);

            // Stop BEFORE spending a poll loop on something that provably cannot fire, and say so
            // in the same place a missing reference image is reported. Returning (rather than
            // spinning) also drops the runtime in the finally, so the panel stops claiming Running.
            var unfireable = DescribeUnfireable(cfg);
            if (unfireable != null)
            {
                SetLastResult(stats, $"{unfireable} — watcher stopped");
                DiagnosticLog.Warn($"Automation watcher '{name}': {unfireable}");
                NotifyStateChanged();
                return;
            }

            // Everything below is resolved ONCE for the lifetime of the loop, because the loop owns
            // an immutable snapshot of the config (rt.Config = d.Config.Clone() — a later edit
            // restarts the loop instead of mutating it), so none of these can change between polls.
            // ProbeCondition used to redo all of it on every tick — at a cadence the user can push
            // down to 100 ms, and 250 ms by default on the pixel path.
            //
            // The loop owns the reference bitmap and its Mat: loaded after start, disposed in OUR
            // finally — Reload() only cancels the CTS and never touches them (a Dispose from
            // the UI thread would race MatchOnce's LockBits on this thread).
            System.Drawing.Bitmap? refImage = null;
            OpenCvSharp.Mat? templateMat = null;
            // Lowercased once instead of per tick, and it is what the switch in ProbeCondition reads.
            string? kind = cfg.ConditionType?.ToLowerInvariant();
            // WindowOpen: CompileTitleRegex emits IL (RegexOptions.Compiled) — its own doc asks
            // callers to cache the result when the target is reused across many calls.
            Models.WindowTarget? windowTarget = null;
            System.Text.RegularExpressions.Regex? titleRegex = null;
            // PixelColorMatch: a Trim + 3 Substring + 3 Convert.ToInt32 per tick otherwise.
            System.Drawing.Color? pixelColor = null;
            try
            {
                if (kind == "windowopen")
                {
                    (windowTarget, titleRegex) = ActionReplayer.BuildWindowTarget(
                        cfg.WindowProcessName, cfg.WindowTitle, cfg.WindowTitleMatchMode);
                }
                else if (kind == "pixelcolormatch")
                {
                    pixelColor = PixelColorService.ParseHex(cfg.PixelColor);
                }
                else if (kind == "imagefound")
                {
                    refImage = string.IsNullOrEmpty(cfg.ImagePath)
                        ? null
                        : ImageStorageService.LoadReferenceImage(name, cfg.ImagePath);
                    if (refImage == null)
                    {
                        SetLastResult(stats, "reference image missing — watcher stopped");
                        DiagnosticLog.Warn($"Automation watcher '{name}': reference image '{cfg.ImagePath}' missing");
                        NotifyStateChanged();
                        return;
                    }
                    templateMat = ScreenCaptureService.BitmapToMat(refImage);
                }

                // Seed the edge state with an INITIAL probe: a condition that is already true
                // when the loop starts is NOT an edge. Without this, every config edit (which
                // restarts the loop) — or arming while the condition holds — auto-fired within
                // one poll. Cooldown lives in TriggerStats so it also survives loop restarts.
                bool wasTrue = ProbeCondition(cfg, kind, windowTarget, titleRegex, pixelColor, templateMat);
                rt.ConditionTrue = wasTrue;
                if (wasTrue) NotifyStateChanged();
                bool pending = false;
                var pendingSince = DateTime.MinValue;
                DateTime CooldownUntil() { lock (_lock) return new DateTime(stats.CooldownUntilTicks); }
                void StampCooldown() { lock (_lock) stats.CooldownUntilTicks = DateTime.Now.AddSeconds(cooldownSec).Ticks; }

                while (!ct.IsCancellationRequested)
                {
                    await Task.Delay(pollMs, ct);

                    bool isTrue = ProbeCondition(cfg, kind, windowTarget, titleRegex, pixelColor, templateMat);
                    if (isTrue != rt.ConditionTrue)
                    {
                        rt.ConditionTrue = isTrue;
                        NotifyStateChanged();
                    }

                    if (levelMode)
                    {
                        wasTrue = isTrue;
                        if (isTrue && DateTime.Now >= CooldownUntil())
                        {
                            // Bounded so the loop gets back to PROBING: in level mode the condition
                            // going false is meaningful, and a request parked at the head of the
                            // queue for minutes would hide that.
                            var r = await RequestFireAsync(name, stats, ct,
                                dueAt: DateTime.Now, expiresAt: DateTime.Now.AddSeconds(30));
                            if (r == TriggerFireResult.Fired)
                                StampCooldown();
                            else if (r == TriggerFireResult.Failed)
                                await Task.Delay(30000, ct);   // permanent failure — don't spam the disk logger
                        }
                        continue;
                    }

                    // Edge mode: fire once per false→true transition.
                    if (isTrue && !wasTrue)
                    {
                        pending = true;
                        pendingSince = DateTime.Now;
                    }
                    wasTrue = isTrue;

                    if (!pending) continue;
                    if (!isTrue) { pending = false; continue; }                 // cause vanished — drop the edge
                    if (DateTime.Now - pendingSince > pendingTtl)               // stale edge — don't ambush later
                    {
                        pending = false;
                        SetLastResult(stats, "fire skipped (busy too long — edge expired)");
                        NotifyStateChanged();
                        continue;
                    }
                    if (DateTime.Now < CooldownUntil()) continue;

                    // The queue holds the edge for exactly the TTL the loop already enforced, so
                    // the "stale edge" branch above keeps its meaning; dueAt is when the edge was
                    // observed, not now, so an old edge outranks a fresh one.
                    var result = await RequestFireAsync(name, stats, ct,
                        dueAt: pendingSince, expiresAt: pendingSince + pendingTtl);
                    if (result == TriggerFireResult.Fired)
                    {
                        pending = false;
                        StampCooldown();
                    }
                    else if (result == TriggerFireResult.Failed)
                    {
                        pending = false;
                    }
                    // Otherwise the edge stays pending and the loop re-probes: the cause may have
                    // vanished, which the branches above must still be allowed to notice.
                }
            }
            finally
            {
                // Mat before Bitmap: BitmapToMat copies the pixels, so the two are independent, but
                // releasing the native buffer first keeps the ownership order obvious.
                templateMat?.Dispose();
                refImage?.Dispose();
            }
        }

        private async Task RunClipboardLoopAsync(string name, TriggerRuntime rt, TriggerStats stats, CancellationToken ct)
        {
            var cfg = rt.Config;
            int cooldownSec = cfg.CooldownSeconds > 0 ? cfg.CooldownSeconds : 5;
            int pollMs = PollCadenceMs(cfg);
            uint lastSeq = NativeMethods.GetClipboardSequenceNumber();
            var cooldownUntil = DateTime.MinValue;
            var lastReplayActiveAt = DateTime.MinValue;

            while (!ct.IsCancellationRequested)
            {
                await Task.Delay(pollMs, ct);

                uint seq = NativeMethods.GetClipboardSequenceNumber();
                if (seq == 0) continue;   // locked desktop — unknown, hold previous state

                bool replayActive = IsReplayActive?.Invoke() ?? false;
                if (replayActive) lastReplayActiveAt = DateTime.Now;
                bool appTraffic = replayActive
                    || DateTime.Now - lastReplayActiveAt < TimeSpan.FromSeconds(2)
                    || DateTime.UtcNow.Ticks < Interlocked.Read(ref _clipboardSuppressUntilTicks);
                if (appTraffic)
                {
                    // Rebaseline: our own paste/restore traffic must stay invisible. But the filter
                    // is TEMPORAL, not attributional — a copy the USER makes in another app during
                    // a long macro is swallowed identically, and that IS a lost event worth
                    // reporting.
                    //
                    // Only the TAIL is worth counting. While a replay is actually running (or a
                    // capture-slot write is in its window) the app is the provable author of the
                    // traffic — SendText bumps the sequence twice per action, so counting there
                    // would report dozens of "skipped fires" per successful fire and bury the real
                    // ones. The residual window is the part where the app is already finished and
                    // a bump is most likely the user's own copy.
                    //
                    // It gets its OWN counter rather than SkippedBusy: these were never fire
                    // attempts, and folding them in would corrupt the number that means "the
                    // engine was busy".
                    bool attributable = replayActive
                        || DateTime.UtcNow.Ticks < Interlocked.Read(ref _clipboardSuppressUntilTicks);
                    if (seq != lastSeq && !attributable)
                    {
                        lock (_lock)
                        {
                            stats.SkippedSuppressed++;
                            stats.LastResult = "clipboard change ignored (just after a replay)";
                        }
                        MarkStatsDirty();
                        NotifyStateChanged();
                    }
                    lastSeq = seq;
                    continue;
                }

                if (seq == lastSeq) continue;
                lastSeq = seq;

                if (DateTime.Now < cooldownUntil) continue;

                if (!string.IsNullOrEmpty(cfg.ClipboardPattern))
                {
                    string? text = await ActionReplayer.ReadClipboardTextAsync(dispatcherQueue);
                    if (text == null || !text.Contains(cfg.ClipboardPattern, StringComparison.OrdinalIgnoreCase))
                        continue;
                }

                // A clipboard change is an EVENT, so it can't PEND indefinitely — but dropping it
                // on the first busy tick was too harsh: the engine is often busy for a second or
                // two, and the copy the user just made is exactly what they wanted acted on.
                // Retry briefly, bounded so a stale copy can never ambush them later.
                var copiedAt = DateTime.Now;
                var r = await RequestFireAsync(name, stats, ct,
                    dueAt: copiedAt, expiresAt: copiedAt + TimeSpan.FromSeconds(10));
                if (r == TriggerFireResult.Fired)
                    cooldownUntil = DateTime.Now.AddSeconds(cooldownSec);
            }
        }

        // Effective poll cadence: the user's PollIntervalMs when set, else the per-condition
        // default. Clamped to [100 ms, 10 min] — below 100 ms the probe cost dominates the
        // interval and the watcher just burns a core; above 10 minutes a "watcher" stops being
        // one and the user wants a schedule trigger instead.
        internal static int PollCadenceMs(ProfileTriggerConfig cfg)
        {
            if (cfg.PollIntervalMs > 0) return Math.Clamp(cfg.PollIntervalMs, 100, 600_000);
            return DefaultPollCadenceMs(cfg.ConditionType);
        }

        internal static int DefaultPollCadenceMs(string? conditionType) => conditionType?.ToLowerInvariant() switch
        {
            "pixelcolormatch" => 250,
            "clipboardchanged" => 500,
            _ => 1000,   // WindowOpen / ProcessRunning / FileExists / ImageFound
        };

        /// <summary>
        /// Why this condition can NEVER become true as configured, or null when it can.
        ///
        /// A blank required field is not an error anywhere downstream — WindowMatcher returns
        /// zero for a criteria-less target BY DESIGN, an empty process name returns false, an
        /// empty path returns false. So the watcher armed, reported Running, polled forever and
        /// never fired, with nothing on screen saying why. ImageFound was the only family that
        /// self-reported, which taught users that silence means healthy. The editor now blocks
        /// saving these, but configs written before that still exist on disk — this is what
        /// surfaces THOSE, and it is the backend's own answer rather than a mirror of the UI's.
        /// </summary>
        internal static string? DescribeUnfireable(ProfileTriggerConfig cfg)
        {
            switch (cfg.ConditionType?.ToLowerInvariant())
            {
                case "windowopen":
                    return string.IsNullOrWhiteSpace(cfg.WindowProcessName) && string.IsNullOrWhiteSpace(cfg.WindowTitle)
                        ? "no process name or window title set — this can never match"
                        : null;
                case "processrunning":
                    return string.IsNullOrWhiteSpace(cfg.WindowProcessName)
                        ? "no process name set — this can never match"
                        : null;
                case "fileexists":
                    return string.IsNullOrWhiteSpace(cfg.FilePath)
                        ? "no file path set — this can never match"
                        : null;
                default:
                    return null;   // ImageFound reports its own missing reference below
            }
        }

        // Raw probes — reuse the app's static primitives; a probe error reads FALSE
        // (transition-only logging keeps DiagnosticLog off the per-poll path).
        /// <remarks>
        /// Everything after <paramref name="cfg"/> is precomputed ONCE by the caller's loop (see
        /// RunConditionLoopAsync) because none of it can change between polls, and rebuilding a
        /// compiled Regex / re-parsing a hex colour / re-converting the template bitmap on every
        /// tick was pure waste on a path that runs 4-10x a second for as long as the watcher is
        /// armed. Nulls are fine: a probe only ever reads the ones its own condition type needs.
        /// </remarks>
        private bool ProbeCondition(
            ProfileTriggerConfig cfg,
            string? kind,
            Models.WindowTarget? windowTarget,
            System.Text.RegularExpressions.Regex? titleRegex,
            System.Drawing.Color? pixelColor,
            OpenCvSharp.Mat? templateMat)
        {
            try
            {
                switch (kind)
                {
                    case "windowopen":
                    {
                        if (windowTarget == null) return false;
                        if (cfg.WindowMatchForegroundOnly)
                            return Helpers.WindowMatcher.Matches(NativeMethods.GetForegroundWindow(), windowTarget, titleRegex);
                        return Helpers.WindowMatcher.FindWindow(windowTarget, titleRegex) != IntPtr.Zero;
                    }
                    case "processrunning":
                    {
                        var procName = cfg.WindowProcessName?.Trim();
                        if (string.IsNullOrEmpty(procName)) return false;
                        if (procName.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                            procName = procName[..^4];
                        System.Diagnostics.Process[] procs;
                        try { procs = System.Diagnostics.Process.GetProcessesByName(procName); }
                        catch { return false; }
                        try { return procs.Length > 0; }
                        finally { foreach (var p in procs) p.Dispose(); }
                    }
                    case "fileexists":
                        return !string.IsNullOrEmpty(cfg.FilePath)
                            && (System.IO.File.Exists(cfg.FilePath) || System.IO.Directory.Exists(cfg.FilePath));
                    case "pixelcolormatch":
                    {
                        if (pixelColor == null) return false;
                        var sampled = PixelColorService.GetPixelAt(cfg.PixelX, cfg.PixelY);
                        return sampled != null
                            && PixelColorService.MatchesWithinTolerance(sampled.Value, pixelColor.Value, cfg.PixelTolerance);
                    }
                    case "imagefound":
                    {
                        if (templateMat == null) return false;
                        double confidence = Math.Min(0.99, cfg.ImageConfidence <= 0 ? 0.8 : cfg.ImageConfidence);
                        // Optional ROI — constrain the scan to a sub-rect (cheaper + fewer false
                        // positives for a background poll). Absolute coords; no offset translation.
                        System.Drawing.Rectangle? searchRegion = null;
                        if (cfg.SearchRegionW is int sw && cfg.SearchRegionH is int sh && sw > 0 && sh > 0)
                            searchRegion = new System.Drawing.Rectangle(cfg.SearchRegionX ?? 0, cfg.SearchRegionY ?? 0, sw, sh);
                        // Pre-converted template (see the loop): the Bitmap overload would redo the
                        // LockBits + BGRA→BGR conversion into a fresh native Mat on every poll.
                        return ImageMatchingService.MatchOnce(templateMat, searchRegion, reportUnusableRegion: true)
                            .Score >= confidence;
                    }
                    default:
                        return false;
                }
            }
            catch
            {
                return false;
            }
        }

        // ── Fire queue ──
        //
        // Every watcher loop used to retry on its own: call, get SkippedBusy, sleep 5 s, call
        // again, until its grace window expired. Two problems that only show up with more than one
        // armed automation, which is the normal case here.
        //
        // ORDER. Two triggers due while a replay runs each poll independently, so when the engine
        // frees, whichever loop happens to wake first wins. Not first-due-first-served — arbitrary,
        // and it changes run to run. A schedule that lands on a busy minute could lose to an
        // interval tick that became due afterwards.
        //
        // LATENCY. The retry cadence was the wait: up to 5 s of dead time after the engine was
        // already free, on every fire that had to wait at all.
        //
        // One ordered waiting room fixes both. It deliberately introduces NO new policy: each
        // request carries the deadline its own loop already computed (the interval's half-period
        // grace, the schedule's 3 minutes, the edge's TTL, the clipboard's 10 s), so lifetimes are
        // exactly what they were. What changes is who goes first and how fast.
        //
        // A side effect worth knowing: the skip counters now count SKIPS, not retry attempts. One
        // missed interval tick used to bump SkippedBusy up to 36 times (3 min of grace at a 5 s
        // cadence, because the bookkeeping sat inside the polled call). It bumps once now.

        private sealed class FireRequest
        {
            public string Name = "";
            /// Ordering key: the moment this fire BECAME due, not when it was queued. A schedule
            /// that has been waiting keeps its place ahead of an interval tick due later.
            public DateTime DueAt;
            /// The caller's own grace deadline. Past it the request is abandoned, unchanged from
            /// the per-loop behaviour it replaces.
            public DateTime ExpiresAt;
            public long Seq;
            /// Why the last attempt was refused — reported back if the deadline wins.
            public TriggerFireResult LastRefusal = TriggerFireResult.SkippedBusy;
            public readonly TaskCompletionSource<TriggerFireResult> Tcs =
                new(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        private readonly List<FireRequest> _fireQueue = new();
        private readonly object _queueLock = new();
        /// Wake signal, not a counter: capacity 1, released only when empty. The pump waits on it
        /// solely while the queue is empty, so a spurious wake costs one re-check.
        private readonly SemaphoreSlim _queueWake = new(0, 1);
        private long _fireSeq;
        private readonly CancellationTokenSource _pumpCts = new();

        /// How fast a refused request is re-attempted. The old per-loop cadence was 5 s and was
        /// pure latency; this is the queue's whole latency budget. An attempt is a dispatcher hop
        /// plus a handful of bool reads, so 400 ms is affordable even during a long replay.
        private const int FireRetryCadenceMs = 400;

        private void WakePump()
        {
            try { if (_queueWake.CurrentCount == 0) _queueWake.Release(); }
            catch (SemaphoreFullException) { /* another thread won the race — already awake */ }
        }

        /// <summary>
        /// The single fire pump. Only this task calls <see cref="FireProfile"/> from a watcher, so
        /// ordering is a property of the code rather than of who polls first.
        ///
        /// It attempts ONLY the head. Every refusal it can get is global — the engine is busy, a
        /// modal is up, the grid is dirty — so walking the rest of the queue would just multiply
        /// dispatcher hops to collect the same answer.
        /// </summary>
        private async Task RunFirePumpAsync(CancellationToken ct)
        {
            while (!ct.IsCancellationRequested)
            {
                FireRequest? head;
                List<FireRequest>? expired = null;
                lock (_queueLock)
                {
                    var now = DateTime.Now;
                    for (int i = _fireQueue.Count - 1; i >= 0; i--)
                    {
                        if (_fireQueue[i].ExpiresAt > now) continue;
                        (expired ??= new()).Add(_fireQueue[i]);
                        _fireQueue.RemoveAt(i);
                    }
                    head = null;
                    foreach (var r in _fireQueue)
                    {
                        if (head == null || r.DueAt < head.DueAt || (r.DueAt == head.DueAt && r.Seq < head.Seq))
                            head = r;
                    }
                }
                // Completed OUTSIDE the lock: the continuation is the waiting loop, which takes
                // _lock for its stats bookkeeping, and holding both is how a deadlock gets written.
                if (expired != null)
                    foreach (var r in expired) r.Tcs.TrySetResult(r.LastRefusal);

                if (head == null)
                {
                    try { await _queueWake.WaitAsync(ct); }
                    catch (OperationCanceledException) { break; }
                    continue;
                }

                var fire = FireProfile;
                TriggerFireResult result;
                if (fire == null)
                {
                    // Bridge not wired yet. Retriable, same as NotReady — never a failure, or an
                    // automation armed at boot would drop its first fire.
                    result = TriggerFireResult.NotReady;
                }
                else
                {
                    try { result = await fire(head.Name); }
                    catch (Exception ex)
                    {
                        DiagnosticLog.Error($"Automation fire '{head.Name}' failed", ex);
                        result = TriggerFireResult.Failed;
                    }
                }

                // SkippedDirty is terminal on purpose. Unsaved edits are not a moment of
                // contention like a running replay — they can sit for hours, and a request holding
                // the head of the queue that whole time would starve every other automation. The
                // watcher's next tick asks again.
                bool terminal = result is TriggerFireResult.Fired
                                       or TriggerFireResult.Failed
                                       or TriggerFireResult.SkippedDirty;
                if (terminal)
                {
                    lock (_queueLock) _fireQueue.Remove(head);
                    head.Tcs.TrySetResult(result);
                    // No delay: on Fired the engine is now busy and the next attempt discovers
                    // that in one cheap hop; on the other two the answer was immediate anyway.
                    continue;
                }

                head.LastRefusal = result;
                try { await Task.Delay(FireRetryCadenceMs, ct); }
                catch (OperationCanceledException) { break; }
            }
        }

        // ── Fire plumbing ──

        /// <param name="dueAt">When this fire became due — the queue's ordering key.</param>
        /// <param name="expiresAt">
        /// The caller's grace deadline. Reaching it returns the last refusal reason, which is the
        /// caller's signal that it waited the window out rather than being refused once.
        /// </param>
        private async Task<TriggerFireResult> RequestFireAsync(
            string name, TriggerStats stats, CancellationToken ct, DateTime dueAt, DateTime expiresAt)
        {
            var req = new FireRequest { Name = name, DueAt = dueAt, ExpiresAt = expiresAt };
            lock (_queueLock)
            {
                req.Seq = ++_fireSeq;
                _fireQueue.Add(req);
            }
            WakePump();

            TriggerFireResult result;
            // Disarming (Reload cancels the loop's CTS) must pull the request out, or the pump
            // would keep attempting a fire for a watcher that no longer exists.
            using (ct.Register(() =>
            {
                lock (_queueLock) _fireQueue.Remove(req);
                req.Tcs.TrySetCanceled();
            }))
            {
                // OperationCanceledException on disarm — RunLoopSafeAsync catches it as a clean stop.
                result = await req.Tcs.Task.ConfigureAwait(false);
            }

            if (ct.IsCancellationRequested) return result;

            lock (_lock)
            {
                switch (result)
                {
                    case TriggerFireResult.Fired:
                        stats.LastFiredAt = DateTime.Now;
                        stats.FireCount++;
                        stats.LastResult = "fired";
                        break;
                    case TriggerFireResult.SkippedBusy:
                        stats.SkippedBusy++;
                        stats.LastResult = "skipped (busy)";
                        break;
                    case TriggerFireResult.SkippedDirty:
                        stats.SkippedDirty++;
                        stats.LastResult = "skipped (unsaved changes)";
                        break;
                    case TriggerFireResult.SkippedModal:
                        stats.SkippedModal++;
                        // Name WHAT blocked it. "skipped (dialog open)" on a screen that looks
                        // idle — because the blocker was a full-screen overlay or a picker behind
                        // the main window — reads as a bug in the automation engine, and steps 4-5
                        // deliberately made this case more common. Falls back to the old literal
                        // if the guard has no reason on record.
                        stats.LastResult = AutomationGuard.LastReason ?? "skipped (dialog open)";
                        break;
                    case TriggerFireResult.NotReady:
                        stats.LastResult = "waiting (app starting)";
                        break;
                    default:
                        stats.LastResult = "failed to start";
                        break;
                }
            }
            // Only "fired" used to be logged, so a skip left NO durable trace anywhere: the
            // counters live in the panel and (before persistence) died with the process, meaning
            // "did my automation run last night?" was unanswerable after a restart.
            //
            // Log the TRANSITION, not the state. Every retry loop calls this repeatedly for
            // exactly the outcomes worth logging — interval every 5 s, schedule every 15 s,
            // clipboard every 2 s, and level-mode conditions every 5 s with no upper bound — and
            // DiagnosticLog.Info is a synchronous append under a global lock. Logging per call
            // would grow the file forever while a watcher sits blocked. One line when the outcome
            // changes keeps the durable trace and costs nothing while it persists.
            string? logLine = null;
            lock (_lock)
            {
                var current = result == TriggerFireResult.Fired ? "fired" : stats.LastResult;
                if (!string.Equals(_lastLoggedOutcome.GetValueOrDefault(name), current, StringComparison.Ordinal))
                {
                    _lastLoggedOutcome[name] = current;
                    // NotReady is excluded even as a transition: it fires once per tick during boot
                    // and resolves itself the moment the bridge is up.
                    if (result != TriggerFireResult.NotReady)
                        logLine = result == TriggerFireResult.Fired
                            ? $"Automation: fired '{name}'"
                            : $"Automation: '{name}' {current}";
                }
            }
            if (logLine != null) DiagnosticLog.Info(logLine);
            MarkStatsDirty();
            NotifyStateChanged();
            return result;
        }

        private TriggerStats GetStatsLocked(string name)
        {
            if (!_stats.TryGetValue(name, out var s))
            {
                s = new TriggerStats();
                _stats[name] = s;
            }
            return s;
        }

        // ── Stats persistence ────────────────────────────────────────────────────────────────
        //
        // Fire counts, last-fired times and skip counters were in-memory only, so every launch
        // reset them to zero and "-". That made the ONE question a background daemon exists to
        // answer — "did this run while I was away?" — unanswerable, and it also erased the
        // interval loop's anchor, which is why a long interval could never come due (the loop
        // re-anchored to launch time on every start).
        //
        // Sidecar + debounced atomic write, following the run-cursors.json convention:
        // FileHelper.WriteAllTextAtomic yields UTF-8 with no BOM, matching the app's other JSON
        // writers. Debounced because a level-mode watcher can fire every few seconds.
        private const string StatsFileName = "automation-stats.json";
        private const int StatsSaveDebounceMs = 2000;
        private System.Threading.Timer? _statsTimer;

        private sealed class PersistedStats
        {
            public DateTime? LastFiredAt { get; set; }
            public int FireCount { get; set; }
            public int SkippedBusy { get; set; }
            public int SkippedDirty { get; set; }
            public int SkippedModal { get; set; }
            public int SkippedSuppressed { get; set; }
            public string? LastResult { get; set; }
            public long LastScheduleOccurrenceTicks { get; set; }
        }

        private static string StatsPath()
        {
            string dir = System.IO.Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "TrueReplayer");
            System.IO.Directory.CreateDirectory(dir);
            return System.IO.Path.Combine(dir, StatsFileName);
        }

        /// <summary>Restore persisted fire stats. Call once, before the first Reload.</summary>
        public void LoadStats()
        {
            try
            {
                var path = StatsPath();
                if (!System.IO.File.Exists(path)) return;
                var map = JsonSerializer.Deserialize<Dictionary<string, PersistedStats>>(System.IO.File.ReadAllText(path));
                if (map == null) return;
                lock (_lock)
                {
                    foreach (var (name, p) in map)
                    {
                        _stats[name] = new TriggerStats
                        {
                            LastFiredAt = p.LastFiredAt,
                            FireCount = p.FireCount,
                            SkippedBusy = p.SkippedBusy,
                            SkippedDirty = p.SkippedDirty,
                            SkippedModal = p.SkippedModal,
                            SkippedSuppressed = p.SkippedSuppressed,
                            LastResult = p.LastResult,
                            LastScheduleOccurrenceTicks = p.LastScheduleOccurrenceTicks,
                            // CooldownUntilTicks is deliberately NOT restored: a cooldown is a
                            // rate limit on a running watcher, not history. Restoring one would
                            // silently mute a watcher for minutes after a restart.
                        };
                    }
                }
            }
            catch (Exception ex)
            {
                // Corrupt/unreadable stats must never stop the daemon — worst case we start at zero,
                // which is exactly the old behaviour.
                DiagnosticLog.Warn($"Automation stats load failed — starting from zero ({ex.Message})");
            }
        }

        private void MarkStatsDirty()
        {
            lock (_lock)
            {
                if (_statsTimer != null) return;
                _statsTimer = new System.Threading.Timer(_ =>
                {
                    lock (_lock)
                    {
                        _statsTimer?.Dispose();
                        _statsTimer = null;
                    }
                    SaveStats();
                }, null, StatsSaveDebounceMs, System.Threading.Timeout.Infinite);
            }
        }

        /// <summary>Write pending stats immediately — call from the app's exit paths.</summary>
        public void Flush()
        {
            lock (_lock)
            {
                _statsTimer?.Dispose();
                _statsTimer = null;
            }
            SaveStats();
        }

        // Serializing AND writing inside _lock is deliberate — the same discipline
        // RunCursorService.SaveLocked documents. Flush() (exit paths) and the debounce timer
        // callback can both reach here, and Timer.Dispose does not wait for a callback already in
        // flight; with the write outside the lock, two WriteAllTextAtomic calls race on the same
        // target and the older snapshot can land last, losing the very fire the exit flush existed
        // to save. The payload is a handful of counters per automation, so holding the lock across
        // the write costs nothing measurable.
        private void SaveStats()
        {
            try
            {
                lock (_lock)
                {
                    var snapshot = _stats.ToDictionary(
                        kv => kv.Key,
                        kv => new PersistedStats
                        {
                            LastFiredAt = kv.Value.LastFiredAt,
                            FireCount = kv.Value.FireCount,
                            SkippedBusy = kv.Value.SkippedBusy,
                            SkippedDirty = kv.Value.SkippedDirty,
                            SkippedModal = kv.Value.SkippedModal,
                            SkippedSuppressed = kv.Value.SkippedSuppressed,
                            LastResult = kv.Value.LastResult,
                            LastScheduleOccurrenceTicks = kv.Value.LastScheduleOccurrenceTicks,
                        },
                        StringComparer.OrdinalIgnoreCase);

                    var path = StatsPath();
                    // Empty snapshot is only a no-op when there is nothing on disk either. Once a
                    // file exists, "everything was pruned" is a real state that has to be written —
                    // bailing out would leave the deleted profiles' stats to be read back on the
                    // next launch, which is the exact staleness the prune exists to remove.
                    if (snapshot.Count == 0 && !System.IO.File.Exists(path)) return;
                    FileHelper.WriteAllTextAtomic(path, JsonSerializer.Serialize(snapshot));
                }
            }
            catch (Exception ex)
            {
                DiagnosticLog.Warn($"Automation stats save failed ({ex.Message})");
            }
        }

        private void SetLastResult(TriggerStats stats, string message)
        {
            lock (_lock) stats.LastResult = message;
            // Persist these too, not just fire outcomes. The reasons that arrive through here are
            // the STOP reasons ("reference image missing", "can never match", "missed") — exactly
            // what a user needs to still be on screen after the restart that used to erase it.
            MarkStatsDirty();
        }

        // Trailing debounce (300 ms): a flapping condition probe (a pixel watcher on an
        // animated region flips up to 4×/s) must not drive a full automation:state push +
        // tray refresh per flip. Bursts collapse to one notification.
        private System.Threading.Timer? _notifyTimer;

        private void NotifyStateChanged()
        {
            lock (_lock)
            {
                if (_notifyTimer != null) return;
                _notifyTimer = new System.Threading.Timer(_ =>
                {
                    lock (_lock)
                    {
                        _notifyTimer?.Dispose();
                        _notifyTimer = null;
                    }
                    try { OnStateChanged?.Invoke(); }
                    catch { /* status push is best-effort */ }
                }, null, 300, System.Threading.Timeout.Infinite);
            }
        }

        private static string SerializeConfig(ProfileTriggerConfig config)
            => JsonSerializer.Serialize(config);
    }
}
