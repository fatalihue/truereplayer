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
        SkippedModal,    // modal dialog open (SuppressAllHotkeys) or hotkey capture in progress
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
        public void Reload(List<(string Name, ProfileTriggerConfig Config)> configs)
        {
            List<string> started = new(), stopped = new();
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
                var known = new HashSet<string>(configs.Select(c => c.Name), StringComparer.OrdinalIgnoreCase);
                foreach (var name in _stats.Keys.ToList())
                    if (!known.Contains(name))
                        _stats.Remove(name);
            }
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
            while (!ct.IsCancellationRequested)
            {
                rt.NextDueTicks = DateTime.Now.AddSeconds(seconds).Ticks;
                await Task.Delay(TimeSpan.FromSeconds(seconds), ct);
                // Skip-if-busy: no retry — the next tick catches up. Missed occurrences
                // are visible via the skip counters.
                await RequestFireAsync(name, stats, ct);
            }
        }

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

                // A schedule that lands on a busy moment must NOT lose the whole day (the
                // interval loop's "next tick catches up" reasoning doesn't transfer — the
                // next tick is tomorrow). Retry retriable skips within a bounded grace
                // window; two same-time schedules then run back-to-back instead of one of
                // them deterministically never executing.
                var graceEnd = next.AddMinutes(3);
                while (!ct.IsCancellationRequested)
                {
                    var result = await RequestFireAsync(name, stats, ct);
                    if (result == TriggerFireResult.Fired || result == TriggerFireResult.Failed)
                        break;
                    if (DateTime.Now >= graceEnd)
                    {
                        SetLastResult(stats, "missed (busy past the grace window)");
                        NotifyStateChanged();
                        break;
                    }
                    await Task.Delay(TimeSpan.FromSeconds(15), ct);
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
            int pollMs = PollCadenceMs(cfg.ConditionType);

            // The loop owns the reference bitmap: loaded after start, disposed in OUR
            // finally — Reload() only cancels the CTS and never touches it (a Dispose from
            // the UI thread would race MatchOnce's LockBits on this thread).
            System.Drawing.Bitmap? refImage = null;
            try
            {
                if (string.Equals(cfg.ConditionType, "ImageFound", StringComparison.OrdinalIgnoreCase))
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
                }

                // Seed the edge state with an INITIAL probe: a condition that is already true
                // when the loop starts is NOT an edge. Without this, every config edit (which
                // restarts the loop) — or arming while the condition holds — auto-fired within
                // one poll. Cooldown lives in TriggerStats so it also survives loop restarts.
                bool wasTrue = ProbeCondition(cfg, refImage);
                rt.ConditionTrue = wasTrue;
                if (wasTrue) NotifyStateChanged();
                bool pending = false;
                var pendingSince = DateTime.MinValue;
                DateTime CooldownUntil() { lock (_lock) return new DateTime(stats.CooldownUntilTicks); }
                void StampCooldown() { lock (_lock) stats.CooldownUntilTicks = DateTime.Now.AddSeconds(cooldownSec).Ticks; }

                while (!ct.IsCancellationRequested)
                {
                    await Task.Delay(pollMs, ct);

                    bool isTrue = ProbeCondition(cfg, refImage);
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
                            var r = await RequestFireAsync(name, stats, ct);
                            if (r == TriggerFireResult.Fired)
                                StampCooldown();
                            else if (r == TriggerFireResult.Failed)
                                await Task.Delay(30000, ct);   // permanent failure — don't spam the disk logger
                            else
                                await Task.Delay(5000, ct);    // busy backoff
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

                    var result = await RequestFireAsync(name, stats, ct);
                    if (result == TriggerFireResult.Fired)
                    {
                        pending = false;
                        StampCooldown();
                    }
                    else if (result == TriggerFireResult.Failed)
                    {
                        pending = false;
                    }
                    else
                    {
                        await Task.Delay(5000, ct);   // busy/dirty/modal/not-ready — retry while the edge is fresh
                    }
                }
            }
            finally
            {
                refImage?.Dispose();
            }
        }

        private async Task RunClipboardLoopAsync(string name, TriggerRuntime rt, TriggerStats stats, CancellationToken ct)
        {
            var cfg = rt.Config;
            int cooldownSec = cfg.CooldownSeconds > 0 ? cfg.CooldownSeconds : 5;
            uint lastSeq = NativeMethods.GetClipboardSequenceNumber();
            var cooldownUntil = DateTime.MinValue;
            var lastReplayActiveAt = DateTime.MinValue;

            while (!ct.IsCancellationRequested)
            {
                await Task.Delay(500, ct);

                uint seq = NativeMethods.GetClipboardSequenceNumber();
                if (seq == 0) continue;   // locked desktop — unknown, hold previous state

                bool replayActive = IsReplayActive?.Invoke() ?? false;
                if (replayActive) lastReplayActiveAt = DateTime.Now;
                bool appTraffic = replayActive
                    || DateTime.Now - lastReplayActiveAt < TimeSpan.FromSeconds(2)
                    || DateTime.UtcNow.Ticks < Interlocked.Read(ref _clipboardSuppressUntilTicks);
                if (appTraffic)
                {
                    lastSeq = seq;        // rebaseline: our own paste/restore traffic is invisible
                    continue;
                }

                if (seq == lastSeq) continue;
                lastSeq = seq;

                // A clipboard change is an EVENT — never pended: a busy skip just drops it.
                if (DateTime.Now < cooldownUntil) continue;

                if (!string.IsNullOrEmpty(cfg.ClipboardPattern))
                {
                    string? text = await ActionReplayer.ReadClipboardTextAsync(dispatcherQueue);
                    if (text == null || !text.Contains(cfg.ClipboardPattern, StringComparison.OrdinalIgnoreCase))
                        continue;
                }

                var r = await RequestFireAsync(name, stats, ct);
                if (r == TriggerFireResult.Fired)
                    cooldownUntil = DateTime.Now.AddSeconds(cooldownSec);
            }
        }

        private static int PollCadenceMs(string? conditionType) => conditionType?.ToLowerInvariant() switch
        {
            "pixelcolormatch" => 250,
            "imagefound" => 1000,
            _ => 1000,   // WindowOpen / ProcessRunning / FileExists
        };

        // Raw probes — reuse the app's static primitives; a probe error reads FALSE
        // (transition-only logging keeps DiagnosticLog off the per-poll path).
        private bool ProbeCondition(ProfileTriggerConfig cfg, System.Drawing.Bitmap? refImage)
        {
            try
            {
                switch (cfg.ConditionType?.ToLowerInvariant())
                {
                    case "windowopen":
                    {
                        var (target, regex) = ActionReplayer.BuildWindowTarget(
                            cfg.WindowProcessName, cfg.WindowTitle, cfg.WindowTitleMatchMode);
                        if (cfg.WindowMatchForegroundOnly)
                            return Helpers.WindowMatcher.Matches(NativeMethods.GetForegroundWindow(), target, regex);
                        return Helpers.WindowMatcher.FindWindow(target, regex) != IntPtr.Zero;
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
                        var targetColor = PixelColorService.ParseHex(cfg.PixelColor);
                        if (targetColor == null) return false;
                        var sampled = PixelColorService.GetPixelAt(cfg.PixelX, cfg.PixelY);
                        return sampled != null
                            && PixelColorService.MatchesWithinTolerance(sampled.Value, targetColor.Value, cfg.PixelTolerance);
                    }
                    case "imagefound":
                    {
                        if (refImage == null) return false;
                        double confidence = Math.Min(0.99, cfg.ImageConfidence <= 0 ? 0.8 : cfg.ImageConfidence);
                        return ImageMatchingService.MatchOnce(refImage).Score >= confidence;
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

        // ── Fire plumbing ──

        private async Task<TriggerFireResult> RequestFireAsync(string name, TriggerStats stats, CancellationToken ct)
        {
            var fire = FireProfile;
            if (fire == null) return TriggerFireResult.Failed;

            TriggerFireResult result;
            try { result = await fire(name); }
            catch (Exception ex)
            {
                DiagnosticLog.Error($"Automation fire '{name}' failed", ex);
                result = TriggerFireResult.Failed;
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
                        stats.LastResult = "skipped (dialog open)";
                        break;
                    case TriggerFireResult.NotReady:
                        stats.LastResult = "waiting (app starting)";
                        break;
                    default:
                        stats.LastResult = "failed to start";
                        break;
                }
            }
            if (result == TriggerFireResult.Fired)
                DiagnosticLog.Info($"Automation: fired '{name}'");
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

        private void SetLastResult(TriggerStats stats, string message)
        {
            lock (_lock) stats.LastResult = message;
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
