using Microsoft.UI.Dispatching;
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using TrueReplayer.Models;
using TrueReplayer.Interop;
using TrueReplayer.Services;


namespace TrueReplayer.Services
{
    public class RecordingService
    {
        private readonly ActionRecorder recorder;
        private readonly Func<bool> getMouse, getScroll, getKeyboard, getCombined;
        private readonly Action<DateTime> setLastActionTime;
        private readonly Action<string>? onStatusChanged;
        private readonly Action<string, bool>? onButtonStateChanged; // (text, isRecording)

        public bool IsRecording { get; private set; }

        public RecordingService(
            ActionRecorder recorder,
            Func<bool> getMouse,
            Func<bool> getScroll,
            Func<bool> getKeyboard,
            Func<bool> getCombined,
            Action<DateTime> setLastActionTime,
            Action<string>? onStatusChanged = null,
            Action<string, bool>? onButtonStateChanged = null)
        {
            this.recorder = recorder;
            this.getMouse = getMouse;
            this.getScroll = getScroll;
            this.getKeyboard = getKeyboard;
            this.getCombined = getCombined;
            this.setLastActionTime = setLastActionTime;
            this.onStatusChanged = onStatusChanged;
            this.onButtonStateChanged = onButtonStateChanged;
        }

        public void ToggleRecording()
        {
            if (IsRecording) StopRecording();
            else StartRecording();
        }

        private void StartRecording()
        {
            IsRecording = true;
            onButtonStateChanged?.Invoke("Pause", true);
            recorder.RecordMouse = getMouse();
            recorder.RecordScroll = getScroll();
            recorder.RecordKeyboard = getKeyboard();
            recorder.RecordCombined = getCombined();
            recorder.UseRelativeCoordinates = Models.UserProfile.Current.UseRelativeCoordinates;
            recorder.Start();
            setLastActionTime(DateTime.Now);
            onStatusChanged?.Invoke("recording");
            DiagnosticLog.Info(
                $"Recording start: mouse={recorder.RecordMouse}, scroll={recorder.RecordScroll}, " +
                $"keyboard={recorder.RecordKeyboard}, combined={recorder.RecordCombined}, " +
                $"relativeCoords={recorder.UseRelativeCoordinates}");
        }

        public void StopRecording()
        {
            if (!IsRecording) return;
            IsRecording = false;
            onButtonStateChanged?.Invoke("Recording", false);
            recorder.Stop();
            DiagnosticLog.Info("Recording stopped");
            // Clear the <select>-interaction suppression flag in case the user hit Stop
            // mid-interaction. Without this the flag would persist up to 15 s before the
            // safety timer cleared it — and any clicks recorded in the next session
            // (or via a different code path) would be silently dropped.
            InputHookManager.SuppressMouseRecording = false;
            onStatusChanged?.Invoke("ready");
        }

        public void StartCaptureRecording(CaptureType captureType)
        {
            if (IsRecording) StopRecording();
            IsRecording = true;
            onButtonStateChanged?.Invoke("Pause", true);
            recorder.RecordMouse = captureType == CaptureType.Mouse;
            recorder.RecordScroll = captureType == CaptureType.Scroll;
            recorder.RecordKeyboard = captureType == CaptureType.Keyboard;
            recorder.RecordCombined = getCombined();
            recorder.Start();
            setLastActionTime(DateTime.Now);
            onStatusChanged?.Invoke("recording");
        }
    }

    public enum CaptureType { None, Mouse, Keyboard, Scroll }

    public class ReplayService
    {
        private readonly ObservableCollection<ActionItem> actions;
        private readonly ActionReplayer replayer;
        private readonly DispatcherQueue dispatcherQueue;
        private readonly Action updateButtonStates;
        private readonly Action<string>? onStatusChanged;
        private readonly Action<string, bool>? onButtonStateChanged; // (text, isReplaying)
        private readonly Action<int>? onActionHighlight; // highlight action at index

        public bool IsReplaying { get; private set; }

        public ReplayService(
            ObservableCollection<ActionItem> actions,
            DispatcherQueue dispatcherQueue,
            Action updateButtonStates,
            Action<string>? onStatusChanged = null,
            Action<string, bool>? onButtonStateChanged = null,
            Action<int>? onActionHighlight = null,
            BrowserBridgeService? browserBridge = null)
        {
            this.actions = actions;
            this.replayer = new ActionReplayer(actions, dispatcherQueue, browserBridge);
            this.dispatcherQueue = dispatcherQueue;
            this.updateButtonStates = updateButtonStates;
            this.onStatusChanged = onStatusChanged;
            this.onButtonStateChanged = onButtonStateChanged;
            this.onActionHighlight = onActionHighlight;

            replayer.OnActionExecuting += (action) =>
            {
                dispatcherQueue.TryEnqueue(() =>
                {
                    int index = actions.IndexOf(action);
                    if (index >= 0)
                        onActionHighlight?.Invoke(index);
                });
            };

            replayer.OnReplayPaused += (hotkey, timeoutMs) =>
            {
                OnReplayPaused?.Invoke(hotkey, timeoutMs);
            };
            // Forward structural-error messages (e.g. missing target window) to the host's
            // status pipeline. The "error:" prefix gets stripped by PushStatusChange and
            // displayed as an alert toast. Marshalled to the UI thread because the
            // callback fires from background task contexts (ExecuteWaitImage,
            // ExecuteWaitPixelColor) — onStatusChanged downstream updates UI state, so
            // invoking it from the task pool would race the dispatcher. Mirrors the
            // continuation pattern at the bottom of StartReplay (lines 203-213).
            replayer.OnReplayError = msg => dispatcherQueue.TryEnqueue(
                () => onStatusChanged?.Invoke($"error:{msg}"));
            // Data-list lap notice — same dispatcher marshalling as OnReplayError (it fires
            // from the replay task), but its own channel so the host can present it as
            // information rather than an error.
            replayer.OnDataLapCompleted = rows => dispatcherQueue.TryEnqueue(
                () => OnDataLapCompleted?.Invoke(rows));
            replayer.OnReplayResumed += () =>
            {
                OnReplayResumed?.Invoke();
            };
            replayer.OnInputRequested += (id, label, menu) => OnInputRequested?.Invoke(id, label, menu);
            replayer.OnInputDismissed += id => OnInputDismissed?.Invoke(id);
            replayer.OnVariablesChanged += (vars, slots, row) => OnVariablesChanged?.Invoke(vars, slots, row);
            // Loop counter — defined on the inner replayer (it's the one running the loop),
            // re-exposed here so MainWindow can wire the bridge callback alongside the other
            // ReplayService events. Same pass-through pattern as OnReplayPaused/Resumed above.
            replayer.OnLoopProgress = (current, total) =>
            {
                OnLoopProgress?.Invoke(current, total);
            };
        }

        // Re-exposed events from the inner replayer so MainWindow/WebViewBridge can wire UI feedback.
        public event Action<string, int>? OnReplayPaused;
        public event Action? OnReplayResumed;
        // {input:Label} Ask-Input modal: request a value from the host, and dismiss a stale prompt.
        public event Action<string, string, string[]?>? OnInputRequested;   // (requestId, label, menu?)
        public event Action<string>? OnInputDismissed;                       // (requestId)
        // Live-variables pane feed: (variables, clip slots, current data row or null).
        public event Action<Dictionary<string, string>, Dictionary<string, string>, Dictionary<string, string>?>? OnVariablesChanged;

        // Live pane opened / re-subscribed — push the current snapshot on demand.
        public void RequestVariablesSnapshot() => replayer.PushVariablesSnapshot(force: true);

        // Global capture hotkey: capture the current selection into the next sequential slot.
        public Task<(string Slot, string? Value)> CaptureSelectionToNextSlotAsync()
            => replayer.CaptureSelectionToNextSlotAsync();

        // Host → replay: the Ask-Input modal was submitted (cancelled=false) or cancelled.
        public void CompleteInput(string requestId, string? value, bool cancelled)
            => replayer.CompleteInput(requestId, value, cancelled);

        // Manual resume from a UI button (status-bar Resume, or the Clicker dashboard).
        // Resumes whichever is paused: a Clicker run (no-op if not paused) and/or a macro
        // Pause action (TriggerReplayPauseListener is a no-op when no listener is registered).
        public void ManualResume()
        {
            ResumeClicker();
            InputHookManager.TriggerReplayPauseListener();
        }

        // ── Clicker pause/resume ──────────────────────────────────────────────
        // The click loop (ToggleCursorClickReplay) awaits _clickerResumeTcs while paused and
        // reuses the existing OnReplayPaused/OnReplayResumed events (already bridged) so the
        // dashboard's pause overlay works. Pause is triggered from the dashboard Pause button
        // (clicker:pause); resume from the overlay's Resume button (replay:resume → ManualResume).
        private volatile bool _clickerLoopActive;
        private volatile bool _clickerPaused;
        private TaskCompletionSource<bool>? _clickerResumeTcs;

        public void PauseClicker()
        {
            if (!_clickerLoopActive || _clickerPaused) return;
            _clickerResumeTcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            _clickerPaused = true;
            dispatcherQueue.TryEnqueue(() => OnReplayPaused?.Invoke("", 0));
        }

        public void ResumeClicker()
        {
            if (!_clickerPaused) return;
            _clickerPaused = false;
            _clickerResumeTcs?.TrySetResult(true);
            dispatcherQueue.TryEnqueue(() => OnReplayResumed?.Invoke());
        }

        // Pause hotkey — toggles pause/resume on a running clicker (no-op if not running).
        public void TogglePauseClicker()
        {
            if (!_clickerLoopActive) return;
            if (_clickerPaused) ResumeClicker();
            else PauseClicker();
        }

        public void SetProfileNameProvider(Func<string> getProfileName)
        {
            replayer.SetProfileNameProvider(getProfileName);
        }

        // Reset a SetVariable cycle row to its first item (see ActionReplayer.ResetCycleCursor).
        public void ResetCycleCursor(string actionId)
        {
            replayer.ResetCycleCursor(actionId);
        }

        // Reset the data-loop row cursor to the first row (see ActionReplayer.ResetRowCursor).
        public void ResetRowCursor()
        {
            replayer.ResetRowCursor();
        }

        public void SetProfileLookup(Func<string, Task<Models.UserProfile?>> lookup)
        {
            replayer.SetProfileLookup(lookup);
        }

        public void SetFolderInheritedContextLookup(Func<string, Controllers.ProfileController.FolderInheritedContext?> lookup)
        {
            replayer.SetFolderInheritedContextLookup(lookup);
        }

        public void SetChainChangedCallback(Action<List<string>> callback)
        {
            replayer.SetChainChangedCallback(callback);
        }

        public void ToggleReplay(bool loopEnabled, string loopCountText, bool intervalEnabled, string intervalText, bool useDelayVariation = false, int delayVariationPercent = 20, bool useRelativeCoords = false, Models.WindowTarget? windowTarget = null, bool bringToFocus = false, int lockWidth = 0, int lockHeight = 0, int lockX = 0, int lockY = 0, bool restorePosition = false, bool restoreSize = false, bool forceInfiniteLoop = false)
        {
            if (!IsReplaying && actions.Count > 0)
                StartReplay(loopEnabled, loopCountText, intervalEnabled, intervalText, useDelayVariation, delayVariationPercent, useRelativeCoords, windowTarget, bringToFocus, lockWidth, lockHeight, lockX, lockY, restorePosition, restoreSize, forceInfiniteLoop);
            else if (IsReplaying)
                StopReplay();
        }

        private void StartReplay(bool loopEnabled, string loopCountText, bool intervalEnabled, string intervalText, bool useDelayVariation, int delayVariationPercent, bool useRelativeCoords, Models.WindowTarget? windowTarget, bool bringToFocus, int lockWidth, int lockHeight, int lockX, int lockY, bool restorePosition, bool restoreSize, bool forceInfiniteLoop)
        {
            // Data-loop (Model A): the active profile's table. Read BEFORE flipping IsReplaying
            // so the empty-table guard can bail cleanly without a state to unwind. Data is
            // per-profile only (no folder inheritance), so UserProfile.Current is the source.
            var dataTable = Models.UserProfile.Current?.Data;
            bool loopOverData = dataTable != null && dataTable.LoopOverData;
            if (loopOverData && (dataTable!.Rows?.Count ?? 0) == 0)
            {
                // Empty table + loop-over-data would set loopCount=0 → the loop reads that as
                // INFINITE. Refuse with a friendly message instead of spinning forever.
                // Null-safe: a hand-edited/corrupt profile can carry {"rows":null}, and this guard
                // runs BEFORE SetDataTable normalizes Rows — treat null as empty, not a crash.
                DiagnosticLog.Warn("Replay refused: 'loop over data' is on but the data table has no rows.");
                onStatusChanged?.Invoke("error:The data table has no rows — add data or turn off \"loop over data\".");
                return;
            }

            IsReplaying = true;
            _userStopped = false;
            onButtonStateChanged?.Invoke("Stop", true);

            int loopCount = loopEnabled && int.TryParse(loopCountText, out int count) && count >= 0 ? count : 1;
            int loopInterval = intervalEnabled && int.TryParse(intervalText, out int interval) && interval >= 0 ? interval : 0;
            // Loop-over-data OVERRIDES the normal loop count: one iteration per data row.
            // It also wins over forceInfiniteLoop (WhilePressed/Toggle hotkeys) — the feature's
            // contract is "run once per row", so a bounded run must not become infinite (which
            // would also stamp empty {row:col} for every iteration past the last row).
            if (loopOverData)
            {
                loopCount = dataTable!.Rows?.Count ?? 0;
                forceInfiniteLoop = false;
            }
            replayer.SetDataTable(dataTable, loopOverData);
            replayer.SetLoopOptions(loopCount, loopInterval);
            replayer.SetDelayVariation(useDelayVariation, delayVariationPercent);
            replayer.SetRelativeCoordinates(useRelativeCoords, windowTarget, lockWidth, lockHeight, lockX, lockY, restorePosition, restoreSize);
            replayer.SetBringToFocus(bringToFocus);
            replayer.SetForceInfiniteLoop(forceInfiniteLoop);

            // Start banner — the single highest-value diagnostic line: records action count,
            // loop config, the resolved window target, relative-coords, and the movement strategy
            // (smooth/path vs jump — the Roblox-class issue). Without this no replay leaves any
            // trace of having run or with what settings.
            DiagnosticLog.Info(
                $"Replay start: actions={actions.Count}, " +
                $"loop={(loopCount == 0 ? "infinite" : loopCount.ToString())}, interval={loopInterval}ms, " +
                $"relativeCoords={useRelativeCoords}, " +
                $"target=[{(windowTarget == null ? "none" : $"{windowTarget.ProcessName} {windowTarget.WindowTitle}".Trim())}], " +
                $"bringToFocus={bringToFocus}, forceInfinite={forceInfiniteLoop}, " +
                $"smoothMovement={ActionReplayer.SmoothMovement} (step {ActionReplayer.MoveStepPx}px/{ActionReplayer.MoveStepDelayMs}ms, clickGap {ActionReplayer.MoveClickDelayMs}ms), " +
                $"fastApproach={ActionReplayer.FastApproach} (settle {ActionReplayer.SettleDistancePx}px)");

            onStatusChanged?.Invoke("replaying");

            _ = replayer.StartAsync().ContinueWith(t =>
            {
                dispatcherQueue.TryEnqueue(() =>
                {
                    // Error status is pushed BEFORE ResetReplayState — the bridge's
                    // run-end notifier keys on status transitions, and the old order
                    // (reset first) made a faulted run fire the SUCCESS cue off the
                    // replaying→ready edge and then the error cue right behind it.
                    // Error-first notifies exactly once, with the error sound.
                    if (t.Exception?.InnerException is TimeoutException tex)
                        onStatusChanged?.Invoke($"error:{tex.Message}");
                    else if (t.Exception?.InnerException != null)
                    {
                        // Capture the type + stack — the user only sees the message in the status bar.
                        DiagnosticLog.Error("Replay run faulted", t.Exception.InnerException);
                        onStatusChanged?.Invoke($"error:{t.Exception.InnerException.Message}");
                    }
                    else
                    {
                        DiagnosticLog.Info("Replay finished");
                    }
                    ResetReplayState();
                });
            });
        }

        // True while the CURRENT run is ending because the user asked it to (Stop
        // hotkey, WhilePressed release, clicker toggle-off). ResetReplayState turns
        // it into the "ready:stopped" status so the bridge's run-end notifier stays
        // silent — a deliberate stop is not "something finished in the background",
        // and WhilePressed would otherwise flash the taskbar on EVERY key release.
        private volatile bool _userStopped;

        private void StopReplay()
        {
            _userStopped = true;
            replayer.Stop();
            _cursorClickCts?.Cancel();
        }

        /// <summary>
        /// Stop replay if currently running. No-op if idle. Used by the WhilePressed trigger mode
        /// release handler, where calling ToggleReplay could otherwise start a new replay if the
        /// previous one had already completed naturally before the key was released.
        /// </summary>
        public void StopIfRunning()
        {
            if (IsReplaying) StopReplay();
        }

        private CancellationTokenSource? _cursorClickCts;

        // Bridge callback for click counter / CPS / elapsed updates. Set by MainWindow on init.
        // Throttled to ~4 Hz inside the loop so the WebView2 message channel isn't flooded
        // (a 100 Hz clicker would otherwise spam 100 messages/s).
        public Action<long, long>? OnClickerStats; // (count, elapsedMs)

        // Macro loop counter — re-exposed from the inner ActionReplayer. Fired only for
        // genuine loops (LoopCount > 1 or infinite); single-shot replays never trigger it.
        // total == 0 signals infinite loop. Frontend renders "Loop X/Y" or "Loop X/∞".
        public Action<int, int>? OnLoopProgress;

        // Data-list lap notice — re-exposed from the inner ActionReplayer. Fires only in
        // cursor mode (data table present, "loop over data" OFF) when a run consumes the
        // last row. Arg = the table's row count.
        public Action<int>? OnDataLapCompleted;

        public void ToggleCursorClickReplay(ClickerRunConfig config)
        {
            // Locals mirror the old method parameters so the loop body below stays unchanged.
            int delay = config.DelayMs;
            bool useJitter = config.UseJitter;
            int jitterPercent = config.JitterPercent;
            int loopCount = config.LoopCount;
            int loopInterval = config.LoopIntervalMs;
            string button = config.Button;
            int holdMs = config.HoldMs;
            int positionJitter = config.PositionJitter;
            // Decompose the optional Area record into the booleans + 4 ints the engine expects.
            bool useArea = config.Area is not null;
            int areaX = config.Area?.X ?? 0;
            int areaY = config.Area?.Y ?? 0;
            int areaW = config.Area?.W ?? 0;
            int areaH = config.Area?.H ?? 0;
            // Fixed-point mode. A picked point clicks exactly there every tick; a null point
            // with UseFixed on = "lock on start" — capture the cursor on the first click and
            // reuse it. fixedCaptured is pre-set when a point was picked so the loop skips the
            // one-time GetCursorPos. No position jitter is applied in fixed mode (exact point).
            bool useFixed = config.UseFixed;
            int fixedX = config.FixedPoint?.X ?? 0;
            int fixedY = config.FixedPoint?.Y ?? 0;
            bool fixedCaptured = config.FixedPoint is not null;

            if (IsReplaying)
            {
                // Stop whatever's running — could be either a regular replay (started by a profile
                // hotkey before the user switched to Clicker mode) or our own click loop. StopReplay
                // cancels both, so the Replay hotkey reliably acts as "stop" regardless of source.
                StopReplay();
                return;
            }

            IsReplaying = true;
            _userStopped = false;
            _clickerLoopActive = true;
            _clickerPaused = false;
            _clickerResumeTcs = null;
            onButtonStateChanged?.Invoke("Stop", true);
            onStatusChanged?.Invoke("replaying");

            // Start banner for the clicker loop — records the resolved run config so "clicker does
            // nothing / wrong rate / wrong place" is diagnosable. (Smooth-movement does NOT apply
            // here — the loop clicks at the live cursor via SendInput, not the macro mouse path.)
            DiagnosticLog.Info(
                $"Clicker start: button={button}, rate={delay}ms, " +
                $"loops={(loopCount == 0 ? "infinite" : loopCount.ToString())}, interval={loopInterval}ms, " +
                $"hold={holdMs}ms, jitter={(useJitter ? jitterPercent + "%" : "off")}, posJitter={positionJitter}px, " +
                $"area={(useArea ? $"{areaW}x{areaH}@{areaX},{areaY}" : "off")}");

            _cursorClickCts = new CancellationTokenSource();
            var token = _cursorClickCts.Token;

            _ = Task.Factory.StartNew(async () =>
            {
                long clickCount = 0;
                var startedAt = DateTime.UtcNow;
                long lastStatsPushMs = 0;
                // Read by the finally block for the final loop-progress flush.
                int iteration = 0;
                bool isInfinite = loopCount == 0;
                try
                {
                    // Wait for hotkey release
                    await Task.Delay(200, token);
                    startedAt = DateTime.UtcNow;  // reset after the grace delay so CPS isn't skewed

                    // Resolve button flags
                    uint downFlag = button switch
                    {
                        "Right" => NativeMethods.MOUSEEVENTF_RIGHTDOWN,
                        "Middle" => NativeMethods.MOUSEEVENTF_MIDDLEDOWN,
                        _ => NativeMethods.MOUSEEVENTF_LEFTDOWN,
                    };
                    uint upFlag = button switch
                    {
                        "Right" => NativeMethods.MOUSEEVENTF_RIGHTUP,
                        "Middle" => NativeMethods.MOUSEEVENTF_MIDDLEUP,
                        _ => NativeMethods.MOUSEEVENTF_LEFTUP,
                    };

                    // Clamp hold to a reasonable range so a typo can't lock things up.
                    int safeHold = Math.Clamp(holdMs, 0, 2000);
                    // Position jitter is treated as a radius in px on each axis. Stored value
                    // is already validated >= 0 by the UI, but defensive-clamp anyway.
                    int jitterRadius = Math.Max(0, positionJitter);
                    // Area mode: each click picks a uniformly-random pixel inside (x,y,w,h).
                    // Requires positive dimensions — defensive against stale/empty state.
                    bool areaActive = useArea && areaW > 0 && areaH > 0;

                    while (!token.IsCancellationRequested && (isInfinite || iteration < loopCount))
                    {
                        // Pause: stop clicking and wait for resume (or cancellation). Shift
                        // startedAt forward by the paused span so CPS/elapsed exclude the pause.
                        if (_clickerPaused)
                        {
                            var pauseBegan = DateTime.UtcNow;
                            var resumeTask = _clickerResumeTcs;
                            if (resumeTask != null)
                            {
                                await Task.WhenAny(resumeTask.Task, Task.Delay(Timeout.Infinite, token));
                                token.ThrowIfCancellationRequested();
                            }
                            startedAt = startedAt.Add(DateTime.UtcNow - pauseBegan);
                        }
                        iteration++;

                        int jitteredX, jitteredY;
                        if (areaActive)
                        {
                            // Sample inclusive on both axes (Next's upper bound is exclusive, so
                            // we pass areaW directly to get [0, areaW-1], which when added to
                            // areaX covers [areaX, areaX+areaW-1] — the full rect interior.
                            jitteredX = areaX + Random.Shared.Next(0, areaW);
                            jitteredY = areaY + Random.Shared.Next(0, areaH);
                        }
                        else if (useFixed)
                        {
                            // Lock on start: capture the cursor at the FIRST click, reuse it for
                            // the whole run. A picked point pre-sets fixedCaptured so this is a
                            // no-op and (fixedX, fixedY) is used verbatim. No jitter — exact point.
                            if (!fixedCaptured)
                            {
                                NativeMethods.GetCursorPos(out var fp);
                                fixedX = fp.x;
                                fixedY = fp.y;
                                fixedCaptured = true;
                            }
                            jitteredX = fixedX;
                            jitteredY = fixedY;
                        }
                        else
                        {
                            NativeMethods.GetCursorPos(out var pos);
                            // Apply position jitter to the raw cursor coords, BEFORE normalising
                            // to the virtual-desktop 0-65535 range. Keeps the jitter measured in
                            // pixels (what the user dialled in) rather than abstract 0-65535 units.
                            jitteredX = pos.x;
                            jitteredY = pos.y;
                            if (jitterRadius > 0)
                            {
                                jitteredX += Random.Shared.Next(-jitterRadius, jitterRadius + 1);
                                jitteredY += Random.Shared.Next(-jitterRadius, jitterRadius + 1);
                            }
                        }

                        // Cached virtual-screen bounds — same call signature minus 4
                        // P/Invokes per clicker tick. See NativeMethods.VirtualScreen.
                        var (vx, vy, vw, vh) = NativeMethods.VirtualScreen.Bounds;
                        int absX = (int)(((double)(jitteredX - vx) * 65535) / Math.Max(1, vw - 1));
                        int absY = (int)(((double)(jitteredY - vy) * 65535) / Math.Max(1, vh - 1));
                        uint posFlags = NativeMethods.MOUSEEVENTF_MOVE | NativeMethods.MOUSEEVENTF_ABSOLUTE | NativeMethods.MOUSEEVENTF_VIRTUALDESK;
                        int inputSize = System.Runtime.InteropServices.Marshal.SizeOf(typeof(NativeMethods.INPUT));

                        var downInput = new NativeMethods.INPUT
                        {
                            type = NativeMethods.INPUT_MOUSE,
                            U = new NativeMethods.InputUnion
                            {
                                mi = new NativeMethods.MOUSEINPUT
                                {
                                    dx = absX, dy = absY,
                                    dwFlags = downFlag | posFlags,
                                }
                            }
                        };
                        NativeMethods.SendInput(1, new[] { downInput }, inputSize);

                        // Hold duration — was hardcoded 10ms; now user-configurable. Skipped
                        // when 0 (some apps need it to register a click cleanly though, hence
                        // the default of 10).
                        if (safeHold > 0) await Task.Delay(safeHold, token);

                        var upInput = new NativeMethods.INPUT
                        {
                            type = NativeMethods.INPUT_MOUSE,
                            U = new NativeMethods.InputUnion
                            {
                                mi = new NativeMethods.MOUSEINPUT
                                {
                                    dx = absX, dy = absY,
                                    dwFlags = upFlag | posFlags,
                                }
                            }
                        };
                        NativeMethods.SendInput(1, new[] { upInput }, inputSize);

                        clickCount++;

                        // Push click stats to the UI every ~250ms. Comparing against elapsed
                        // (not iteration count) makes the cadence stable across slow/fast
                        // configurations.
                        var elapsedMs = (long)(DateTime.UtcNow - startedAt).TotalMilliseconds;
                        if (elapsedMs - lastStatsPushMs >= 250)
                        {
                            lastStatsPushMs = elapsedMs;
                            var snapshotCount = clickCount;
                            var snapshotElapsed = elapsedMs;
                            dispatcherQueue.TryEnqueue(() => OnClickerStats?.Invoke(snapshotCount, snapshotElapsed));

                            // Loop progress for genuine loops only (single-shot keeps "—").
                            // total=0 signals infinite — matches Macro engine convention.
                            if (isInfinite || loopCount > 1)
                            {
                                var snapshotIteration = iteration;
                                var snapshotTotal = isInfinite ? 0 : loopCount;
                                dispatcherQueue.TryEnqueue(() => OnLoopProgress?.Invoke(snapshotIteration, snapshotTotal));
                            }
                        }

                        // Apply delay + jitter
                        int safeDelay = Math.Max(10, delay);
                        if (useJitter && jitterPercent > 0)
                        {
                            int variation = safeDelay * jitterPercent / 100;
                            safeDelay += Random.Shared.Next(-variation, variation + 1);
                            safeDelay = Math.Max(10, safeDelay);
                        }
                        await Task.Delay(safeDelay, token);

                        // Loop interval (between iterations when looping)
                        if (loopInterval > 0 && (isInfinite || iteration < loopCount))
                            await Task.Delay(loopInterval, token);
                    }
                }
                catch (OperationCanceledException) { }
                finally
                {
                    // Clear pause state so a stop-while-paused doesn't leave the loop "armed"
                    // and the dashboard stuck on the PAUSED overlay.
                    _clickerLoopActive = false;
                    bool wasPaused = _clickerPaused;
                    _clickerPaused = false;
                    _clickerResumeTcs?.TrySetResult(true);

                    // Final flush so the UI lands on the exact end-state (e.g. "100/100" not
                    // "97/100") even if the loop ended between throttled pushes.
                    var finalCount = clickCount;
                    var finalElapsed = (long)(DateTime.UtcNow - startedAt).TotalMilliseconds;
                    var finalIteration = iteration;
                    var finalLoopTotal = isInfinite ? 0 : loopCount;
                    var emitFinalLoop = isInfinite || loopCount > 1;
                    dispatcherQueue.TryEnqueue(() =>
                    {
                        OnClickerStats?.Invoke(finalCount, finalElapsed);
                        if (emitFinalLoop)
                            OnLoopProgress?.Invoke(finalIteration, finalLoopTotal);
                        if (wasPaused) OnReplayResumed?.Invoke();
                        ResetReplayState();
                    });
                }
            }, token, TaskCreationOptions.LongRunning, TaskScheduler.Default).Unwrap();
        }

        private void ResetReplayState()
        {
            IsReplaying = false;
            onButtonStateChanged?.Invoke("Replay", false);
            updateButtonStates();
            // "ready:stopped" = same READY state, but tagged so the bridge knows the
            // run ended by user request and skips the out-of-window notification.
            var stopped = _userStopped;
            _userStopped = false;
            onStatusChanged?.Invoke(stopped ? "ready:stopped" : "ready");
        }
    }

    public class ActionRecorder
    {
        private readonly ObservableCollection<ActionItem> _actions;
        private readonly Func<int> _getCustomDelay;
        private readonly Func<bool> _useCustomDelayFunc;
        private readonly Action? _onActionAdded;
        private readonly HashSet<string> _pressedKeys = new();
        private int? insertIndex;
        private bool _isRecording;
        private DateTime? _lastActionTime;

        // Capture mode state
        private CaptureType _captureType = CaptureType.None;
        private int _captureActionCount;
        private int _captureTargetCount;
        private bool _captureKeyWasPressed;
        private int _captureStartIndex;
        private string? _captureMouseButton;
        private Action? _onCaptureComplete;

        public bool RecordMouse { get; set; } = true;
        public bool RecordScroll { get; set; } = true;
        public bool RecordKeyboard { get; set; } = true;
        // When true, a key press / mouse click is recorded as ONE action (Keystroke / *Click)
        // instead of the paired Down+Up. Set per-session from the global toggle in Start().
        public bool RecordCombined { get; set; } = false;
        public bool UseRelativeCoordinates { get; set; } = false;
        public bool IsCaptureMode => _captureType != CaptureType.None;

        // ── Double-click merge state ──
        // The merge is always active in combined mode (two LeftClicks within the SYSTEM
        // double-click time and SM_CX/CYDOUBLECLK rectangle collapse into one DoubleClick
        // row); paired mode records raw Down/Up rows and never merges.
        // _lastAdded tracks the most recent row from ANY AddAction (a keystroke between
        // two clicks must break the pair); the click fields remember where/when the last
        // combined LeftClick physically landed, in SCREEN coords — the recorded X/Y may
        // be window-relative, which would break the distance check.
        private ActionItem? _lastAdded;
        private ActionItem? _lastCombinedLeftClick;
        private int _lastClickScreenX, _lastClickScreenY;
        private long _lastClickTickMs;
        // GetSystemMetrics indices for the system double-click tolerance rectangle — Win32 SM_* constants.
        // SM_CXDOUBLECLK / SM_CYDOUBLECLK give the FULL width/height of the rectangle (centred on the
        // first click) within which Windows itself pairs two clicks into a double-click.
        private const int SM_CXDOUBLECLK = 36, SM_CYDOUBLECLK = 37;

        // ── Combined-mode keyboard grouping state ──
        // Modifiers are folded into the following key so "Ctrl+C", "Shift+A" (capitals) and
        // "Shift+1" (symbols) reproduce correctly. _heldMods = modifiers physically down now;
        // _sessionMods = union seen since the first modifier of the current chord went down
        // (used to emit a lone-modifier tap on release); _sessionUsed = a key/click already
        // consumed the held modifiers, so releasing them must NOT emit a stray Keystroke.
        private readonly HashSet<string> _heldMods = new(StringComparer.OrdinalIgnoreCase);
        private readonly HashSet<string> _sessionMods = new(StringComparer.OrdinalIgnoreCase);
        private bool _sessionUsed;
        private static readonly HashSet<string> ModifierKeyNames =
            new(StringComparer.OrdinalIgnoreCase) { "Ctrl", "Shift", "Alt", "Win" };

        public ActionRecorder(
            ObservableCollection<ActionItem> actions,
            Func<int>? getCustomDelay = null,
            Func<bool>? useCustomDelayFunc = null,
            Action? onActionAdded = null)
        {
            _actions = actions;
            _getCustomDelay = getCustomDelay ?? (() => 100);
            _useCustomDelayFunc = useCustomDelayFunc ?? (() => true);
            _onActionAdded = onActionAdded;
        }

        public void SetInsertIndex(int? index) => insertIndex = (index >= 0 && index <= _actions.Count) ? index : null;
        public bool IsInsertMode => insertIndex.HasValue;

        public void Start()
        {
            _isRecording = true;
            _lastActionTime = null;
            // A click from a previous session must never pair with the first click of
            // this one — the wall-clock gap check would usually reject it anyway, but a
            // quick stop/start inside the double-click window shouldn't merge across.
            _lastCombinedLeftClick = null;
            _lastAdded = null;
        }

        public void Stop()
        {
            _isRecording = false;
            _pressedKeys.Clear();
            _heldMods.Clear();
            _sessionMods.Clear();
            _sessionUsed = false;
            insertIndex = null;
            _lastActionTime = null;
            _lastCombinedLeftClick = null;
            _lastAdded = null;
            foreach (var action in _actions) action.IsInsertionPoint = false;
            ClearCapture();
        }

        public bool IsRecording => _isRecording;

        public void StartCapture(CaptureType type, Action onComplete, string? mouseButton = null)
        {
            _captureType = type;
            _captureActionCount = 0;
            _captureKeyWasPressed = false;
            _captureStartIndex = insertIndex ?? _actions.Count;
            _captureMouseButton = mouseButton;
            _onCaptureComplete = onComplete;
            _captureTargetCount = type switch
            {
                CaptureType.Mouse => 2,
                CaptureType.Scroll => 1,
                _ => 0
            };
        }

        public void ClearCapture()
        {
            _captureType = CaptureType.None;
            _captureActionCount = 0;
            _captureTargetCount = 0;
            _captureKeyWasPressed = false;
            _captureStartIndex = 0;
            _captureMouseButton = null;
            _onCaptureComplete = null;
        }

        public void DiscardCapturedActions()
        {
            if (_captureActionCount > 0 && _captureStartIndex >= 0)
            {
                int removeCount = Math.Min(_captureActionCount, _actions.Count - _captureStartIndex);
                for (int i = 0; i < removeCount; i++)
                {
                    if (_captureStartIndex < _actions.Count)
                        _actions.RemoveAt(_captureStartIndex);
                }
            }
        }

        private void CheckCaptureCompletion()
        {
            if (_captureType == CaptureType.None) return;

            bool complete = _captureType switch
            {
                // Combined mode records a click as ONE event (press only), so Mouse capture
                // completes after 1 action instead of the paired Down+Up's 2. Evaluated live
                // here (not baked into _captureTargetCount in StartCapture) because RecordCombined
                // is assigned by StartCaptureRecording, which runs just AFTER StartCapture.
                CaptureType.Mouse => _captureActionCount >= (RecordCombined ? 1 : 2),
                CaptureType.Scroll => _captureActionCount >= _captureTargetCount,
                CaptureType.Keyboard => _captureKeyWasPressed && _pressedKeys.Count == 0,
                _ => false
            };

            if (complete)
                _onCaptureComplete?.Invoke();
        }

        private int GetDelayForNewAction()
        {
            if (_useCustomDelayFunc())
            {
                return _getCustomDelay();
            }
            else
            {
                DateTime now = DateTime.Now;
                int delay;
                if (_lastActionTime.HasValue)
                {
                    delay = (int)(now - _lastActionTime.Value).TotalMilliseconds;
                    if (delay < 0) delay = 0;
                }
                else
                {
                    delay = 0;
                }
                _lastActionTime = now;
                return delay;
            }
        }

        public void RecordKeyboardAction(string key, bool isDown)
        {
            if (!_isRecording || !RecordKeyboard) return;
            if (RecordCombined) { RecordKeyboardCombined(key, isDown); return; }

            // ── Paired mode (legacy, unchanged) ──
            var actionType = isDown ? "KeyDown" : "KeyUp";
            int delay = GetDelayForNewAction();

            if (isDown && !_pressedKeys.Contains(key))
            {
                AddAction(new ActionItem { ActionType = actionType, Key = key, Delay = delay });
                _pressedKeys.Add(key);
                if (_captureType == CaptureType.Keyboard)
                    _captureKeyWasPressed = true;
            }
            else if (!isDown)
            {
                // Remove before AddAction so CheckCaptureCompletion sees _pressedKeys.Count == 0
                _pressedKeys.Remove(key);
                AddAction(new ActionItem { ActionType = actionType, Key = key, Delay = delay });
            }
        }

        // Combined mode: one event per press, emitted on key-DOWN; the key-up is ignored
        // (no hold capture — the user adds a HoldKey action manually if they want a hold).
        // A held modifier folds into the next key so combos / capitals / symbols replay right.
        private void RecordKeyboardCombined(string key, bool isDown)
        {
            if (ModifierKeyNames.Contains(key))
            {
                if (isDown)
                {
                    if (_heldMods.Count == 0) { _sessionUsed = false; _sessionMods.Clear(); }
                    _heldMods.Add(key);
                    _sessionMods.Add(key);
                }
                else
                {
                    _heldMods.Remove(key);
                    // Modifier(s) pressed and released with no key/click in between → record the
                    // lone tap as a single Keystroke ("Shift", "Ctrl+Shift", …). Emitted only
                    // once the whole chord is released so multi-modifier taps fold together.
                    if (_heldMods.Count == 0 && !_sessionUsed && _sessionMods.Count > 0)
                    {
                        // Set the capture flag BEFORE AddAction — AddAction runs CheckCaptureCompletion
                        // synchronously, and the Keyboard arm needs _captureKeyWasPressed already true.
                        // This modifier-up is BOTH the emitter and the terminal event (no follow-up
                        // event to complete the capture), so setting it after would hang capture mode.
                        if (_captureType == CaptureType.Keyboard) _captureKeyWasPressed = true;
                        AddAction(new ActionItem { ActionType = "Keystroke", Key = BuildCombo(_sessionMods, null), Delay = GetDelayForNewAction() });
                        _sessionMods.Clear();
                    }
                }
                return;
            }

            // Non-modifier key.
            if (isDown && !_pressedKeys.Contains(key))
            {
                string combo = _heldMods.Count > 0 ? BuildCombo(_heldMods, key) : key;
                AddAction(new ActionItem { ActionType = "Keystroke", Key = combo, Delay = GetDelayForNewAction() });
                _pressedKeys.Add(key);
                if (_heldMods.Count > 0) _sessionUsed = true;
                if (_captureType == CaptureType.Keyboard) _captureKeyWasPressed = true;
            }
            else if (!isDown)
            {
                _pressedKeys.Remove(key);
                // Combined mode emits nothing on key-up, but keyboard capture completes on
                // release (_captureKeyWasPressed && no keys held). Paired mode triggers this
                // via the KeyUp's AddAction; here we call it directly. Self-guards when idle.
                CheckCaptureCompletion();
            }
        }

        // Joins modifiers (+ optional target key) into the canonical "Win+Ctrl+Shift+Alt+Key"
        // form SimulateKeystroke parses — identical to what the manual "Send Keystroke" insert
        // and the hotkey capture produce, so replay of a recorded combo matches exactly.
        private static string BuildCombo(HashSet<string> mods, string? target)
        {
            var parts = new List<string>();
            if (mods.Contains("Win")) parts.Add("Win");
            if (mods.Contains("Ctrl")) parts.Add("Ctrl");
            if (mods.Contains("Shift")) parts.Add("Shift");
            if (mods.Contains("Alt")) parts.Add("Alt");
            if (!string.IsNullOrEmpty(target)) parts.Add(target);
            return string.Join("+", parts);
        }

        public void RecordMouseAction(string button, int x, int y, bool isDown, int scrollDelta = 0)
        {
            if (!_isRecording) return;
            // In capture mode, only accept the specific mouse button
            if (_captureType == CaptureType.Mouse && _captureMouseButton != null && button != _captureMouseButton)
                return;

            bool isScroll = button == "Scroll";
            if ((isScroll && !RecordScroll) || (!isScroll && !RecordMouse)) return;

            // Combined mode records a click as ONE event captured on the press; the release is
            // ignored (no drag/hold capture — use paired mode for those). Scroll is unaffected.
            if (RecordCombined && !isScroll && !isDown) return;

            string actionType = isScroll
                ? (scrollDelta > 0 ? "ScrollUp" : "ScrollDown")
                : RecordCombined
                    ? button switch
                    {
                        "Left" => "LeftClick",
                        "Right" => "RightClick",
                        "Middle" => "MiddleClick",
                        _ => ""
                    }
                    : button switch
                    {
                        "Left" => isDown ? "LeftClickDown" : "LeftClickUp",
                        "Right" => isDown ? "RightClickDown" : "RightClickUp",
                        "Middle" => isDown ? "MiddleClickDown" : "MiddleClickUp",
                        _ => ""
                    };

            if (string.IsNullOrEmpty(actionType)) return;

            int delay = GetDelayForNewAction();

            if (isScroll)
            {
                AddAction(new ActionItem { ActionType = actionType, Delay = delay });
            }
            else
            {
                // A click consumes any held-modifier session so its (ignored) release doesn't
                // later emit a stray lone-modifier Keystroke. Modifier+click isn't encoded as a
                // unit in combined mode — the click is recorded without the modifier.
                if (RecordCombined && _heldMods.Count > 0) _sessionUsed = true;

                // Double-click merge: this LeftClick is the second half of a system
                // double-click → upgrade the previous row in place instead of adding a
                // new one. Always on in combined mode (paired mode keeps raw Down/Up
                // rows untouched). Conditions: Left button + the previous row is still
                // the most recently added action (consecutive) + within
                // GetDoubleClickTime and the SM_CX/CYDOUBLECLK rectangle, both measured
                // the way Windows itself pairs clicks. Skipped in capture mode (capture
                // flows count actions and complete after exactly one click). The merged
                // row keeps the FIRST click's coords/delay; tracking resets after a
                // merge so a triple-click records DoubleClick + LeftClick.
                if (RecordCombined && button == "Left"
                    && _captureType == CaptureType.None
                    && _lastCombinedLeftClick != null
                    && ReferenceEquals(_lastCombinedLeftClick, _lastAdded)
                    && _lastCombinedLeftClick.ActionType == "LeftClick")
                {
                    long nowMs = Environment.TickCount64;
                    // SM_CX/CYDOUBLECLK are the FULL rectangle dimensions, but the distance check
                    // measures the offset of each click from the rectangle's centre (the first
                    // click), so the tolerance is HALF the metric per axis. Max(2, …) guards against
                    // a degenerate 0/1-px metric collapsing the rectangle and never merging.
                    int maxW = Math.Max(2, NativeMethods.GetSystemMetrics(SM_CXDOUBLECLK) / 2);
                    int maxH = Math.Max(2, NativeMethods.GetSystemMetrics(SM_CYDOUBLECLK) / 2);
                    if (nowMs - _lastClickTickMs <= NativeMethods.GetDoubleClickTime()
                        && Math.Abs(x - _lastClickScreenX) <= maxW
                        && Math.Abs(y - _lastClickScreenY) <= maxH)
                    {
                        var merged = _lastCombinedLeftClick;
                        merged.ActionType = "DoubleClick";
                        _lastCombinedLeftClick = null;
                        // An in-place property mutation only raises PropertyChanged — the
                        // bridge pushes the grid on COLLECTION changes. Re-assigning the
                        // same instance at its index raises a Replace event, so the
                        // upgraded row shows immediately (not only after the next action
                        // happens to be recorded or the profile reloads).
                        int mi = _actions.IndexOf(merged);
                        if (mi >= 0) _actions[mi] = merged;
                        _onActionAdded?.Invoke();
                        return;
                    }
                }

                int recX = x, recY = y;
                if (UseRelativeCoordinates)
                {
                    // Convert screen coords to window-relative
                    var pt = new NativeMethods.POINT { x = x, y = y };
                    var hwnd = NativeMethods.WindowFromPoint(pt);
                    if (hwnd != IntPtr.Zero)
                    {
                        // Get the top-level window (not child controls)
                        var root = NativeMethods.GetAncestor(hwnd, NativeMethods.GA_ROOT);
                        if (root != IntPtr.Zero) hwnd = root;
                        if (NativeMethods.GetWindowRect(hwnd, out var rect))
                        {
                            recX = x - rect.Left;
                            recY = y - rect.Top;
                            // Capture window geometry on first click for Restore Position / Restore Size.
                            // WindowFromPoint can resolve to the wrong window (a tooltip, the desktop, or
                            // TrueReplayer itself if the click lands on our own UI) — capturing that would
                            // permanently poison the profile's restore geometry. Skip our own process and
                            // implausibly small rects to rule out the common poison cases. This is a
                            // heuristic, not a strict Window Target match (the recorder has no target
                            // reference), so an unrelated large window could still seed geometry.
                            if (Models.UserProfile.Current.WindowWidth == 0)
                            {
                                int w = rect.Right - rect.Left;
                                int h = rect.Bottom - rect.Top;
                                NativeMethods.GetWindowThreadProcessId(hwnd, out uint pid);
                                bool isOwnWindow = pid == (uint)Environment.ProcessId;
                                if (!isOwnWindow && w >= 100 && h >= 100)
                                {
                                    Models.UserProfile.Current.WindowWidth = w;
                                    Models.UserProfile.Current.WindowHeight = h;
                                    Models.UserProfile.Current.WindowX = rect.Left;
                                    Models.UserProfile.Current.WindowY = rect.Top;
                                }
                            }
                        }
                    }
                }
                var clickAction = new ActionItem { ActionType = actionType, X = recX, Y = recY, Delay = delay };
                AddAction(clickAction);
                // Arm (or reset) the double-click tracker. Screen coords, not recX/recY —
                // relative recording rewrites those and would corrupt the distance check.
                if (RecordCombined && actionType == "LeftClick")
                {
                    _lastCombinedLeftClick = clickAction;
                    _lastClickScreenX = x;
                    _lastClickScreenY = y;
                    _lastClickTickMs = Environment.TickCount64;
                }
                else
                {
                    _lastCombinedLeftClick = null;
                }
            }
        }

        private void AddAction(ActionItem action)
        {
            if (insertIndex.HasValue && insertIndex.Value >= 0 && insertIndex.Value <= _actions.Count)
            {
                _actions.Insert(insertIndex.Value, action);
                insertIndex++;
            }
            else
            {
                _actions.Add(action);
            }

            _lastAdded = action;
            _onActionAdded?.Invoke();

            if (_captureType != CaptureType.None)
            {
                _captureActionCount++;
                CheckCaptureCompletion();
            }
        }
    }

    public class ActionReplayer
    {
        // ── Smooth mouse movement ─────────────────────────────────────────────────────
        // Some apps/games (notably Roblox) reject a single large "teleport" of the cursor —
        // they only follow movement that progresses through intermediate positions, like a
        // physical mouse. When SmoothMovement is on, SimulateMouse walks a straight path from
        // the current cursor to the target in steps of at most MoveStepPx pixels, pausing
        // MoveStepDelayMs between steps. MoveClickDelayMs is the gap before the click fires.
        // When off, it jumps straight to the target (legacy behaviour). These are persisted in
        // appsettings.json and loaded into these statics by AppSettingsManager.ApplyGlobalSettings;
        // the UI edits them through the settings:change keys smoothMovement / moveStepPx /
        // moveStepDelay / moveClickDelay.
        public static bool SmoothMovement = true;
        public static int MoveStepPx = 20;
        public static int MoveStepDelayMs = 2;
        public static int MoveClickDelayMs = 10;

        // ── Fast approach (jump-and-settle) ─────────────────────────────────────────────
        // Walking the WHOLE smooth path is slow when the cursor starts far from the target
        // (e.g. the first click is on the opposite monitor — hundreds of MoveStepPx steps).
        // When FastApproach is on and the move is longer than SettleDistancePx, we teleport
        // most of the way with a bare SetCursorPos (no SendInput, so no large Raw-Input delta
        // for anti-cheat to flag) to a point SettleDistancePx short of the target, then walk
        // only that final stretch smoothly — the small "settle" moves are what games look for
        // to accept the cursor as having arrived. Far moves become ~constant-time instead of
        // scaling with distance. On by default (validated on real games): the bare SetCursorPos
        // teleport works for the user's games — turn off only if a particular game misclicks.
        // UI keys: fastApproach / settleDistance.
        public static bool FastApproach = true;
        public static int SettleDistancePx = 80;

        // ── Focus click ───────────────────────────────────────────────────────────────
        // Opt-in per-action flag (ActionItem.IsFocusClick) honoured by combined clicks. A
        // single click on a very small target — e.g. a Roblox text field while the window is at
        // its minimum size — lands but doesn't give the field keyboard focus. Replaying the click
        // TWICE a few pixels apart (what users do by hand) makes the second click settle inside
        // the field and focus it. FocusClickOffsetPx is the second click's down-right offset from
        // the recorded point (in recorded/profile space, so the window-relative translation in
        // SimulateMouse applies to it too); FocusClickGapMs is the pause between the two clicks.
        // Static so a future settings knob can tune them; defaults match the manual workaround.
        public static int FocusClickOffsetPx = 5;
        public static int FocusClickGapMs = 60;

        // Gap between the two press/release pairs of a DoubleClick replay. 50 ms sits
        // comfortably below any system double-click time (default 500 ms, minimum 200)
        // while still letting slower apps process the first click. Static so a future
        // settings knob can tune it.
        public static int DoubleClickGapMs = 50;

        // Fires the second "focus" click for an IsFocusClick combined click: a short pause, then
        // a full press/release FocusClickOffsetPx down-right of the recorded point. Skips if the
        // replay was cancelled mid-sequence (mirrors how the primary click's release is gated).
        private void FocusTap(int x, int y, uint down, uint up, CancellationToken token)
        {
            if (FocusClickGapMs > 0) Thread.Sleep(FocusClickGapMs);
            if (token.IsCancellationRequested) return;
            int fx = x + FocusClickOffsetPx, fy = y + FocusClickOffsetPx;
            // The focus tap is a deliberate few-px settle off the primary click, never a jump — opt it
            // out of fast approach so a tiny SettleDistancePx can't turn this nudge into a teleport.
            SimulateMouse(fx, fy, down, allowFastApproach: false);
            if (!token.IsCancellationRequested)
                SimulateMouse(fx, fy, up, allowFastApproach: false);
        }

        private readonly ObservableCollection<ActionItem> _actions;
        private readonly DispatcherQueue dispatcherQueue;
        private readonly BrowserBridgeService? _browserBridge;
        private CancellationTokenSource? _cts;
        private int _loopCount = 0;
        private int _loopInterval = 0;
        private Func<string>? _getProfileName;

        // Bridge callback for the status bar's "Loop X/Y" indicator. Mirrors OnClickerStats:
        // throttled to ~4 Hz inside the loop so we don't flood the WebView2 message channel
        // for tight macros, plus a final push in the finally block so the last count lands
        // even when the throttle skipped the last tick or the user cancelled mid-iteration.
        // total == 0 means infinite (WhilePressed or LoopCount=0).
        public Action<int, int>? OnLoopProgress;
        private long _lastLoopProgressMs;

        // ── Profile chaining ──
        // Async lookup that resolves a profile name into its UserProfile. Returns null when missing.
        private Func<string, Task<Models.UserProfile?>>? _profileLookup;
        // Sync lookup for folder-inherited execution context (target + flags + geometry) when the
        // sub-profile has no target of its own. Returns null when the profile already has its own
        // target (caller uses subProfile.* directly) or no folder applies. Without this, a sub
        // inheriting from its folder would silently run against the caller's window.
        private Func<string, Controllers.ProfileController.FolderInheritedContext?>? _folderInheritedContextLookup;
        // Active call stack of profile names (excluding the root). Used for cycle detection
        // and for the status-bar "A → B → C" display.
        private readonly List<string> _callStack = new();
        // Run-global variable store behind SetVariable / {var:name}. Cleared at the start of
        // every replay run; deliberately NOT snapshot/restored around RunProfile sub-calls —
        // variables share one scope across the whole chain (AHK model), unlike the window
        // context. Keys are normalized to lowercase so {var:UserName} and {var:username} agree.
        private readonly Dictionary<string, string> _runtimeVariables = new();
        // {counter} source: the root replay loop's 1-based iteration. Written only by
        // StartAsync's loop (RunProfile RepeatCount is a different knob and never touches it),
        // so a sub-profile reads the same counter as its caller.
        private int _currentIteration;
        // {row} source: 1-based grid row of the action currently executing, set per action in
        // ExecuteActionsAsync. Inside a RunProfile sub-call it tracks the SUB-profile's rows —
        // the caller's next iteration re-stamps it before any of its own tokens resolve, so no
        // save/restore is needed around the recursion.
        private int _currentActionRow;
        // Data-loop state. _dataTable is the profile's table (set once per run in StartReplay);
        // _dataLoopOver drives the "one iteration per row" loop override; _currentRowData is the
        // current iteration's column→cell dict that {row:column} resolves from. Like _currentIteration,
        // this is instance state so a RunProfile sub-call sees the CALLER's current row (the sub has
        // no data loop of its own to re-stamp it) — same AHK-shared-scope model as {counter}/{var}.
        private Models.ProfileDataTable? _dataTable;
        private bool _dataLoopOver;
        private IReadOnlyDictionary<string, string>? _currentRowData;
        // Data-loop CURSOR (Model B). When a table exists but "loop over data" is OFF,
        // each RUN uses ONE row — this per-profile cursor's current row — and advances
        // (wrapping) for the next run, exactly like a SetVariable cycle but for a whole
        // row. Session-lifetime, keyed by the executing (root) profile name; the table is
        // per-profile. DELIBERATELY not in the fresh-run reset block (same as _cycleCursors)
        // so the position survives across runs — that IS the feature.
        private readonly Dictionary<string, int> _rowCursors = new(StringComparer.Ordinal);
        // Clipboard SLOTS behind Copy to Slot / {clip:name}. "Multiple clipboards": each slot
        // holds one captured selection, read back via {clip:1}…{clip:name}. DELIBERATELY not in
        // the fresh-run reset block — slots are captured ad hoc (capture hotkey, earlier runs)
        // and must survive into later runs, exactly like _cycleCursors. Session-lifetime; keys
        // are lowercased like _runtimeVariables so {clip:Name} and {clip:name} agree.
        private readonly Dictionary<string, string> _clipSlots = new();
        // Guards _clipSlots and _runtimeVariables where they cross threads: the capture
        // hotkey writes _clipSlots on the UI dispatcher while the replay thread reads it
        // (token resolution) and both threads copy both dicts for the live-variables pane
        // (a Dictionary enumerated concurrently with a resizing write throws). Writes and
        // copies are rare and tiny, so one coarse lock is plenty.
        private readonly object _runStateLock = new();
        // Sequential slot the capture hotkey writes to next: 1..9, wrapping. Session-lifetime.
        private int _nextHotkeySlot = 1;
        // Per-row skip-on-error (data loop). When the table opts in (OnRowError == "skip"),
        // an action-level failure marks the CURRENT ROW faulted instead of cancelling the
        // run: the action loop (and any RunProfile recursion) unwinds at its next boundary
        // check, StartAsync logs the row and continues with the next one. Replay-thread-only
        // state, reset per iteration.
        private bool _rowFaulted;
        private string? _rowFaultReason;
        // Skip mode gates on the BATCH data loop only — cursor mode and plain runs keep the
        // exact halt semantics they had (skip-on-error is a data-loop robustness knob).
        // _softFaultOverride: RunProfile-over-data (Phase C) sets it while a HALT-mode sub
        // table runs UNDER a skip-active parent batch — the fault sites must then FaultRow
        // (soft) instead of cancelling _cts, or one bad sub row would kill the whole parent
        // batch that skip-on-error exists to protect. Replay-thread-only, save/restored by
        // RunSubProfileOverDataAsync.
        private bool _softFaultOverride;
        private bool SkipRowOnErrorActive =>
            (_dataLoopOver && string.Equals(_dataTable?.OnRowError, "skip", StringComparison.OrdinalIgnoreCase))
            || _softFaultOverride;

        // Route an action-level failure while skip mode is active: mark the row faulted and
        // let the loops unwind. Keeps the FIRST reason (later failures are knock-on noise).
        private void FaultRow(string reason)
        {
            _rowFaulted = true;
            _rowFaultReason ??= reason;
        }
        // Hard cap on how deep RunProfile chains can recurse. Prevents accidental infinite loops
        // even if cycle detection were somehow bypassed.
        private const int MaxCallDepth = 5;
        // Fires whenever the call stack changes so the host can update the status bar.
        // The argument is the current stack snapshot (empty when no sub-profile is running).
        private Action<List<string>>? _onChainChanged;

        public event Action<ActionItem>? OnActionExecuting;
        public event Action<string, int>? OnReplayPaused;
        public event Action? OnReplayResumed;
        // Surfaced when an action can't proceed for a structural reason (e.g. profile uses
        // relative coords but the target window isn't running). ReplayService wires this to
        // its onStatusChanged with the "error:" prefix so the bridge alerts the user.
        public Action<string>? OnReplayError;
        // Cursor mode: the run just consumed the last row of the data table (arg = row count).
        // Benign/informational — deliberately NOT routed through OnReplayError, which the host
        // renders as a red error toast.
        public Action<int>? OnDataLapCompleted;

        // {input:Label} Ask-Input modal round-trip, raised from the token resolver. OnInputRequested
        // asks the host to show the prompt; the host later calls CompleteInput with the answer.
        // OnInputDismissed tells the host to close a still-open prompt (on cancel / Stop).
        public event Action<string, string, string[]?>? OnInputRequested;   // (requestId, label, menu?)
        public event Action<string>? OnInputDismissed;                       // (requestId)
        private readonly System.Collections.Concurrent.ConcurrentDictionary<string, TaskCompletionSource<string?>> _pendingInputs = new();
        // An {input:} prompt with no answer aborts the run after this, instead of pausing the single
        // replay engine forever (an unattended automation would otherwise block it and starve every
        // other trigger). A present, hotkey-driven user beats 60 s easily; timeout = clean cancel.
        private const int InputTimeoutMs = 60_000;

        // Live-variables snapshot for the frontend debug pane: (variables, clip slots, current
        // data row or null). Raised on the dispatcher with COPIES of the dictionaries (the live
        // ones mutate on the replay thread). Forced on user-meaningful writes (SetVariable, input
        // answer, slot capture) and run start; per-iteration bumps ride a small throttle.
        public event Action<Dictionary<string, string>, Dictionary<string, string>, Dictionary<string, string>?>? OnVariablesChanged;
        private long _lastVariablesPushTick;

        public ActionReplayer(ObservableCollection<ActionItem> actions, DispatcherQueue dispatcherQueue, BrowserBridgeService? browserBridge = null)
        {
            _actions = actions;
            this.dispatcherQueue = dispatcherQueue;
            _browserBridge = browserBridge;
        }

        // Reset a cycle row's position back to item 1. Removes the cursor entry for
        // this action under the ACTIVE UI profile (the profile the user is looking at
        // when they right-click the row), so the next execution starts at the first
        // item again. No-op when the row never cycled (no entry yet). Keyed the same
        // way ExecuteSetVariable creates the entry — profile name + '|' + action Id.
        public void ResetCycleCursor(string actionId)
        {
            if (string.IsNullOrEmpty(actionId)) return;
            var profile = _getProfileName?.Invoke() ?? "default";
            _cycleCursors.Remove(profile + "|" + actionId);
        }

        // Reset the data-loop row cursor (Model B) to the first row for the active UI
        // profile — the "start over" the table can't trigger itself. Session-only, keyed
        // the same way StartAsync reads it. No-op when the profile never cursored.
        public void ResetRowCursor()
        {
            var profile = _getProfileName?.Invoke() ?? "default";
            _rowCursors.Remove(profile);
        }

        public void SetProfileNameProvider(Func<string> getProfileName)
        {
            _getProfileName = getProfileName;
        }

        // The profile whose action list is CURRENTLY executing. During a RunProfile sub-call this
        // is the sub-profile (top of the call stack), NOT the root profile shown in the UI.
        // _getProfileName always returns the UI's active profile, so image-based actions that
        // resolve their reference image per-profile (WaitImage, If/ImageFound) must use THIS
        // instead — otherwise a sub-profile's image is looked up under the parent's folder, fails
        // to load, and the action silently no-ops (WaitImage: skips the wait + OnTimeout policy;
        // If/ImageFound: always reads "not found"). The call stack always holds at least the root
        // (pushed in StartAsync) by the time any action runs; the _getProfileName fallback only
        // guards the degenerate empty-stack case.
        private string CurrentExecutingProfileName =>
            _callStack.Count > 0 ? _callStack[^1] : (_getProfileName?.Invoke() ?? "default");

        public void SetProfileLookup(Func<string, Task<Models.UserProfile?>> lookup)
        {
            _profileLookup = lookup;
        }

        public void SetFolderInheritedContextLookup(Func<string, Controllers.ProfileController.FolderInheritedContext?> lookup)
        {
            _folderInheritedContextLookup = lookup;
        }

        public void SetChainChangedCallback(Action<List<string>> callback)
        {
            _onChainChanged = callback;
        }

        public void SetLoopOptions(int loopCount, int loopInterval)
        {
            _loopCount = loopCount >= 0 ? loopCount : 0;
            _loopInterval = loopInterval >= 0 ? loopInterval : 0;
        }

        // Data-loop: hand the replayer the active profile's table + whether to loop over it.
        // Both null/false when the feature is off (byte-identical behaviour). Called once per
        // run in ReplayService.StartReplay, before StartAsync.
        public void SetDataTable(Models.ProfileDataTable? dataTable, bool loopOverData)
        {
            // Normalize null Headers/Rows — a hand-edited / corrupt imported .trprofile can
            // deserialize {"rows":null} to a null list, and the loop/BuildRowDict paths
            // dereference these without further guards. Import is a trust boundary.
            if (dataTable != null)
            {
                dataTable.Headers ??= new System.Collections.Generic.List<string>();
                dataTable.Rows ??= new System.Collections.Generic.List<System.Collections.Generic.List<string>>();
            }
            _dataTable = dataTable;
            _dataLoopOver = loopOverData && dataTable != null;
        }

        // Builds the column→cell dict for one data row: lowercased header → cell value.
        // Short rows are tolerated (missing trailing cells resolve empty); duplicate headers
        // keep the LAST occurrence (last-writer-wins, same as a plain dictionary assign).
        private static IReadOnlyDictionary<string, string> BuildRowDict(Models.ProfileDataTable table, int rowIndex)
        {
            var dict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var row = table.Rows[rowIndex];
            for (int c = 0; c < table.Headers.Count; c++)
            {
                var header = table.Headers[c]?.Trim();
                if (string.IsNullOrEmpty(header)) continue;
                dict[header] = c < row.Count ? (row[c] ?? string.Empty) : string.Empty;
            }
            return dict;
        }

        private bool _useRelativeCoordinates = false;
        private Models.WindowTarget? _windowTarget;
        // Cached compiled regex for _windowTarget.WindowTitle. Recomputed whenever
        // _windowTarget is reassigned (SetRelativeCoordinates or sub-profile context swap).
        // Avoids recompiling every SimulateMouse call inside a long replay loop.
        private System.Text.RegularExpressions.Regex? _windowTargetTitleRegex;
        private int _lockWidth = 0;
        private int _lockHeight = 0;
        private int _lockX = 0;
        private int _lockY = 0;
        private bool _restorePosition = false;
        private bool _restoreSize = false;

        private bool _bringToFocus = false;

        public void SetRelativeCoordinates(bool enabled, Models.WindowTarget? target, int lockWidth = 0, int lockHeight = 0, int lockX = 0, int lockY = 0, bool restorePosition = false, bool restoreSize = false)
        {
            _useRelativeCoordinates = enabled;
            _windowTarget = target;
            _windowTargetTitleRegex = TrueReplayer.Helpers.WindowMatcher.CompileTitleRegex(target);
            _lockWidth = lockWidth;
            _lockHeight = lockHeight;
            _lockX = lockX;
            _lockY = lockY;
            _restorePosition = restorePosition;
            _restoreSize = restoreSize;
        }

        public void SetBringToFocus(bool enabled)
        {
            _bringToFocus = enabled;
        }

        private bool _useDelayVariation = false;
        private int _delayVariationPercent = 20;

        public void SetDelayVariation(bool enabled, int percent)
        {
            _useDelayVariation = enabled;
            _delayVariationPercent = Math.Clamp(percent, 0, 50);
        }

        // Forced infinite loop (set by WhilePressed trigger mode, overrides profile's LoopCount)
        private bool _forceInfiniteLoop = false;
        public void SetForceInfiniteLoop(bool enabled) => _forceInfiniteLoop = enabled;

        public async Task StartAsync()
        {
            // Atomically swap _cts so any in-flight callers that read the field after this
            // line see the NEW cts immediately. Without Interlocked.Exchange there's a window
            // where an internal cancel path (e.g. ReportMissingTargetWindow → _cts?.Cancel())
            // could fire AFTER we reassign _cts and end up cancelling the new replay's CTS.
            // Disposing the old cts is fire-and-forget on a background task — gives any sync
            // loop sections of the old replay time to finish without us blocking StartAsync,
            // AND ObjectDisposedException on any straggler Cancel is swallowed inside the
            // continuation so the new replay doesn't crash.
            var oldCts = System.Threading.Interlocked.Exchange(ref _cts, new CancellationTokenSource());
            var token = _cts!.Token;
            if (oldCts != null)
            {
                try { oldCts.Cancel(); } catch (ObjectDisposedException) { /* already gone */ }
                _ = Task.Delay(500).ContinueWith(_ => { try { oldCts.Dispose(); } catch { } }, TaskScheduler.Default);
            }
            await Task.Yield(); // preserve the original "yield before kickoff" behaviour
            int iteration = 0;
            bool isInfinite = _forceInfiniteLoop || _loopCount == 0;
            // Status-bar loop counter only makes sense for actual loops. Single-run replays
            // (loopCount=1, not infinite) execute the macro once and end — no counter to
            // overlay. Computed once here so the lambda captures stay simple.
            bool emitLoopProgress = isInfinite || _loopCount > 1;
            int loopProgressTotal = isInfinite ? 0 : _loopCount;
            _lastLoopProgressMs = 0;

            // Snapshot the actions list to avoid crashes from concurrent modifications
            var snapshot = _actions.ToList();

            try
            {
                // WhilePressed (forceInfiniteLoop) is semantically "run while the key is held"
                // — waiting for the user to release the hotkey before starting would defeat
                // the entire purpose. Skip the release wait in that mode.
                if (!_forceInfiniteLoop)
                    await WaitForHotkeyReleaseAsync(token);

                // Release any physically-held modifier keys from the target app's perspective.
                // Without this, a combined hotkey like Alt+Q leaves Alt "pressed" in the target
                // while the replay runs, turning every simulated keystroke into Alt+<key> (so a
                // plain KeyDown A becomes Alt+A in the target). The user's real Alt release later
                // will send a duplicate keyup which is harmless.
                ReleasePhysicallyHeldModifiers();

                // Bring target window to focus if enabled. Full activation stack
                // (restore-if-minimized, NULL-foreground-guarded AttachThreadInput,
                // foreground-lock bypass, verified) — see WindowActivation. Best-effort:
                // a refused switch doesn't block the run, matching the old behavior.
                if (_bringToFocus && _windowTarget != null)
                {
                    var targetHwnd = FindTargetWindow();
                    if (targetHwnd != IntPtr.Zero)
                    {
                        await TrueReplayer.Helpers.WindowActivation.ActivateAsync(
                            targetHwnd, _windowTarget, _windowTargetTitleRegex, token);
                        await Task.Delay(300, token); // Wait for window to restore and gain focus
                    }
                }

                // Restore Position / Restore Size: reposition/resize target window before replay.
                // Independent from Relative Coordinates — the user can restore geometry even with
                // absolute coordinates (e.g., they just want the window consistently placed).
                bool hasSize = _lockWidth > 0 && _lockHeight > 0;
                bool applySize = _restoreSize && hasSize;   // gating explícito + sanity-check
                bool applyPos = _restorePosition;
                if (_windowTarget != null && (applySize || applyPos))
                {
                    var sizeHwnd = FindTargetWindow();
                    if (sizeHwnd != IntPtr.Zero && !NativeMethods.IsIconic(sizeHwnd))
                    {
                        // Chrome fix: SetWindowPos resize é silenciosamente ignorado em janelas
                        // maximizadas (chrome customizado/DWM). Un-maximize antes de aplicar tamanho.
                        if (applySize && NativeMethods.IsZoomed(sizeHwnd))
                        {
                            NativeMethods.ShowWindow(sizeHwnd, NativeMethods.SW_RESTORE);
                            await Task.Delay(80, token);
                        }
                        uint flags = NativeMethods.SWP_NOZORDER;
                        if (!applyPos) flags |= NativeMethods.SWP_NOMOVE;
                        if (!applySize) flags |= NativeMethods.SWP_NOSIZE;
                        int posX = applyPos ? _lockX : 0;
                        int posY = applyPos ? _lockY : 0;
                        int sizeW = applySize ? _lockWidth : 0;
                        int sizeH = applySize ? _lockHeight : 0;
                        NativeMethods.SetWindowPos(sizeHwnd, IntPtr.Zero, posX, posY, sizeW, sizeH, flags);
                        await Task.Delay(100, token); // Wait for reposition/resize
                    }
                }

                // Reset the call stack at the start of every replay run (in case a previous
                // run was canceled mid-sub-profile, leaving stack residue). Push the ROOT
                // profile name so cycle detection treats "A directly invoked → B → A" as a
                // cycle. Without this, the root would be invisible to RunProfile and a
                // sub-profile could re-call its own grandparent recursively.
                _callStack.Clear();
                var rootName = _getProfileName?.Invoke();
                if (!string.IsNullOrEmpty(rootName))
                    _callStack.Add(rootName);
                NotifyChainChanged();

                // Fresh run = fresh run state: variables from a previous run must not leak in,
                // and the counter/row read as "not started" until the loop below stamps them.
                lock (_runStateLock) _runtimeVariables.Clear();
                _pendingTokenKeyDowns.Clear();
                _currentIteration = 0;
                _currentActionRow = 0;
                _currentRowData = null;
                _rowFaulted = false;
                _rowFaultReason = null;
                _softFaultOverride = false;
                PushVariablesSnapshot(force: true); // live pane: run started, variables cleared

                // Data-loop CURSOR (Model B): table present but "loop over data" OFF → this
                // whole run uses ONE row (the per-profile cursor's current row); the cursor
                // then advances (wrapping) for the next run. Resolved ONCE here (not per
                // iteration) so an inner loop repeats the SAME row — "each run = one row".
                // Batch mode (_dataLoopOver) leaves this null and stamps per-iteration below.
                IReadOnlyDictionary<string, string>? cursorRowData = null;
                int lapCompletedRows = 0;
                if (!_dataLoopOver && _dataTable != null && (_dataTable.Rows?.Count ?? 0) > 0)
                {
                    string rowKey = _getProfileName?.Invoke() ?? "default";
                    int rowN = _dataTable.Rows!.Count;
                    int cur = _rowCursors.TryGetValue(rowKey, out var cv) ? ((cv % rowN) + rowN) % rowN : 0;
                    cursorRowData = BuildRowDict(_dataTable, cur);
                    _rowCursors[rowKey] = (cur + 1) % rowN; // advance for the next run
                    // Lap complete = this run consumed the LAST row, so the next one wraps to
                    // the top. Detected HERE (not at the wrap) so the notice fires while it is
                    // still true — "that was the last one" — instead of after row 1 was already
                    // re-sent. Suppressed for a single-row table, where every run would qualify.
                    if (rowN > 1 && cur == rowN - 1 && _dataTable.NotifyOnLapComplete != false)
                        lapCompletedRows = rowN;
                }

                // Run replay on a dedicated thread to avoid blocking the thread pool
                int skippedRows = 0;
                string? firstSkipNote = null;
                await Task.Factory.StartNew(async () =>
                {
                    while (!token.IsCancellationRequested && (isInfinite || iteration < _loopCount))
                    {
                        iteration++;
                        _currentIteration = iteration; // {counter} token source (1-based)
                        // Data-loop: stamp the current row so {row:column} resolves to it.
                        // Batch (loop-over-data): 1-based iteration → 0-based row index, guarded
                        // against a corrupt count. Cursor mode (Model B): the fixed cursor row
                        // for every iteration. Neither: null → {row:column} resolves empty.
                        _currentRowData = (_dataLoopOver && _dataTable != null && iteration - 1 < (_dataTable.Rows?.Count ?? 0))
                            ? BuildRowDict(_dataTable, iteration - 1)
                            : cursorRowData;
                        _rowFaulted = false;
                        _rowFaultReason = null;

                        // Throttled status-bar update. First iteration is always pushed so the
                        // counter appears immediately; subsequent iterations are coalesced to
                        // ~4 Hz to avoid flooding the message channel on tight loops (e.g. a
                        // macro that's basically "press key + 10 ms delay" running infinite).
                        if (emitLoopProgress)
                        {
                            long nowMs = Environment.TickCount64;
                            if (iteration == 1 || nowMs - _lastLoopProgressMs >= 250)
                            {
                                _lastLoopProgressMs = nowMs;
                                int capturedIteration = iteration;
                                dispatcherQueue.TryEnqueue(() => OnLoopProgress?.Invoke(capturedIteration, loopProgressTotal));
                            }
                        }
                        PushVariablesSnapshot(); // live pane: counter/{row:col} moved (throttled)

                        try
                        {
                            await ExecuteActionsAsync(snapshot, token);
                        }
                        // Skip mode also absorbs the FAULTING error paths (browser action
                        // exceptions, If-probe Halt rethrows). A genuine Stop/cancel (token
                        // cancelled) must keep unwinding the whole run — but a SPURIOUS OCE
                        // (e.g. a pipe drop resolving an in-flight TCS with no token behind
                        // it) is just another row error, so only the token-backed one rethrows.
                        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
                        catch (Exception ex) when (SkipRowOnErrorActive)
                        {
                            FaultRow(ex.Message);
                        }

                        if (_rowFaulted)
                        {
                            // Release anything the faulted row left pressed BEFORE moving on —
                            // the engine's stuck-input recovery (StartAsync's finally) is gated
                            // on cancellation, which skip mode deliberately avoids. A KeyDown
                            // whose matching KeyUp was skipped would otherwise stay stuck for
                            // every remaining row and past the end of the run. Both resets are
                            // lock-guarded no-ops when nothing is down.
                            ResetMouseState();
                            ResetKeyState();
                            skippedRows++;
                            var reason = _rowFaultReason ?? "error";
                            firstSkipNote ??= $"row {iteration}: {reason}";
                            Services.DiagnosticLog.Warn($"Data loop: row {iteration} skipped — {reason}");
                            _rowFaulted = false;
                            _rowFaultReason = null;
                        }

                        if (!token.IsCancellationRequested && (isInfinite || iteration < _loopCount) && _loopInterval > 0)
                            await Task.Delay(_loopInterval, token);
                    }
                }, token, TaskCreationOptions.LongRunning, TaskScheduler.Default).Unwrap();

                // One honest end-of-run summary instead of a toast per skipped row. Rides the
                // error channel on purpose: rows DID fail; the log has the per-row reasons.
                if (skippedRows > 0 && !token.IsCancellationRequested)
                    OnReplayError?.Invoke($"Data loop finished — {skippedRows} of {_loopCount} row(s) skipped after errors (first: {firstSkipNote})");

                // Cursor-mode lap notice. Armed at the top of the run (the cursor advances
                // there, so it is already known), announced here so it lands with the run's
                // own end-of-run cue rather than before the row was actually used. Not raised
                // on a user Stop: the host's run-end notifier suppresses those too, and being
                // told "list complete" right after aborting is noise.
                if (lapCompletedRows > 0 && !token.IsCancellationRequested)
                    OnDataLapCompleted?.Invoke(lapCompletedRows);
            }
            // OperationCanceledException is the BASE type (TaskCanceledException derives from it),
            // so this catches both. A plain Stop during a Pause or an instant probe surfaces a bare
            // OperationCanceledException (ExecutePause's ThrowIfCancellationRequested, InstantProbe's
            // rethrow) — catching only TaskCanceledException let it escape and fault the run, making
            // StartReplay's continuation show a spurious "error:" toast on a normal cancel.
            catch (OperationCanceledException) { }
            finally
            {
                // Final push so the StatusBar lands on the actual completion count regardless
                // of where the throttle happened to be. Skipped when no iterations ran (early
                // cancel before the loop body) — pushing "Loop 0/N" would look broken.
                if (emitLoopProgress && iteration > 0)
                {
                    int capturedFinal = iteration;
                    dispatcherQueue.TryEnqueue(() => OnLoopProgress?.Invoke(capturedFinal, loopProgressTotal));
                }

                // Release any button/key the replay left pressed when it was cancelled. This
                // runs after the replay task has fully completed, so an in-flight SimulateMouse/
                // SimulateKey (whose Thread.Sleep window Stop's own ResetMouseState may have
                // raced) has finished and recorded its state — closing the stuck-button/key
                // race. Idempotent with Stop()'s reset (lock-guarded, no-op when nothing down).
                if (token.IsCancellationRequested)
                {
                    ResetMouseState();
                    ResetKeyState();
                }

                _callStack.Clear();
                NotifyChainChanged();
                PushVariablesSnapshot(force: true); // live pane: land on the final state
            }
        }

        /// <summary>
        /// Executes a flat list of actions sequentially. Reentrant: a RunProfile action invokes
        /// this method again with the sub-profile's actions. Honors the same cancellation token,
        /// delay variation and skip behavior as the top-level loop.
        /// </summary>
        // ── Conditional logic: block map ─────────────────────────────────────
        // Single O(n) pass over the action list pre-computing:
        //   elseOf[ifIndex]  = index of matching ELSE row (only when one exists)
        //   endIfOf[ifIndex] = index of matching ENDIF row
        //   endIfOf[elseIdx] = same ENDIF, so the engine can jump from inside a
        //                       TRUE-branch body — when it hits the ELSE boundary —
        //                       all the way to the closing ENDIF (skipping the FALSE body).
        // Orphan ELSE / ENDIF (no open IF on the stack) are silently ignored at runtime;
        // the load-time validator should have stripped them, but the engine stays
        // graceful if a hand-edited profile slipped through.
        private static (Dictionary<int, int> elseOf, Dictionary<int, int> endIfOf) BuildBlockMap(List<ActionItem> actions)
        {
            var elseOf = new Dictionary<int, int>();
            var endIfOf = new Dictionary<int, int>();
            var stack = new Stack<int>();
            for (int i = 0; i < actions.Count; i++)
            {
                var t = actions[i].ActionType;
                if (string.Equals(t, "If", StringComparison.OrdinalIgnoreCase))
                {
                    stack.Push(i);
                }
                else if (string.Equals(t, "Else", StringComparison.OrdinalIgnoreCase))
                {
                    if (stack.Count > 0) elseOf[stack.Peek()] = i;
                }
                else if (string.Equals(t, "EndIf", StringComparison.OrdinalIgnoreCase))
                {
                    if (stack.Count > 0)
                    {
                        int ifIdx = stack.Pop();
                        endIfOf[ifIdx] = i;
                        if (elseOf.TryGetValue(ifIdx, out int elseIdx))
                            endIfOf[elseIdx] = i;
                    }
                }
            }
            return (elseOf, endIfOf);
        }

        private async Task ExecuteActionsAsync(List<ActionItem> actions, CancellationToken token)
        {
            // Pre-pass per call so nested RunProfile invocations each get a fresh map
            // scoped to the sub-profile's action list. Cost is negligible (~32 B / IF row).
            var (elseOf, endIfOf) = BuildBlockMap(actions);

            for (int i = 0; i < actions.Count; i++)
            {
                // _rowFaulted: a skip-mode action failure unwinds the rest of the row's
                // actions (and any RunProfile recursion level) without cancelling the run.
                if (token.IsCancellationRequested || _rowFaulted) break;
                var action = actions[i];

                // ── Conditional logic — handled before the regular Delay / Highlight /
                // input-replay gate so block skips happen immediately (no spurious 0 ms
                // Task.Delay) and ELSE/ENDIF don't trip the input-replay marker (they
                // don't simulate input). Structural rows never enter the action switch.
                if (string.Equals(action.ActionType, "If", StringComparison.OrdinalIgnoreCase))
                {
                    if (action.IsSkipped)
                    {
                        // Block-level skip: jump past the whole IF/ELSE/ENDIF range so the
                        // body rows of BOTH branches are elided. Mirrors the visual
                        // "whole block is greyed out" the frontend renders for an IF row
                        // whose IsSkipped is true. Orphan IF (no matching EndIf in the map
                        // because the load-time validator failed somehow) → bail out to
                        // end-of-list so the body doesn't run unconditionally. Safer than
                        // continuing past the IF, which would execute the body as if no
                        // IF existed and contradict the user's explicit skip.
                        if (endIfOf.TryGetValue(i, out int endIdx))
                            i = endIdx;
                        else
                            i = actions.Count;
                        continue;
                    }
                    // The IF carries an optional delay applied BEFORE the probe — a "wait for the
                    // condition to settle" knob. Some conditions (an image/pixel that only appears
                    // after a page or animation loads) aren't ready the instant the loop reaches the
                    // IF, so an immediate probe reads FALSE and the block is wrongly skipped. The
                    // delay lets the screen catch up first. (ELSE/ENDIF are pure jumps — no delay.)
                    // Honours the same jitter setting as a regular action's delay.
                    int ifDelay = Math.Max(0, action.Delay);
                    if (_useDelayVariation && _delayVariationPercent > 0 && ifDelay > 0)
                    {
                        int variation = ifDelay * _delayVariationPercent / 100;
                        ifDelay += Random.Shared.Next(-variation, variation + 1);
                        ifDelay = Math.Max(0, ifDelay);
                    }
                    if (ifDelay > 0)
                    {
                        try { await Task.Delay(ifDelay, token); }
                        catch (OperationCanceledException) { break; }
                    }
                    // Highlight while the probe runs — user feedback "we're checking the condition".
                    dispatcherQueue.TryEnqueue(() => OnActionExecuting?.Invoke(action));
                    bool branchTrue;
                    try { branchTrue = await EvaluateConditionWithTimeout(action, token); }
                    catch (OperationCanceledException) { break; }
                    if (!branchTrue)
                    {
                        // FALSE — jump to ELSE if one exists, otherwise to ENDIF. The loop's
                        // i++ lands us on the row AFTER the structural marker (start of the
                        // ELSE body, or the row right after the block if there's no ELSE).
                        if (elseOf.TryGetValue(i, out int elseIdx))
                            i = elseIdx;
                        else
                            i = endIfOf.GetValueOrDefault(i, i);
                    }
                    // TRUE → fall through; loop advances to i+1 which is the first body row.
                    continue;
                }
                if (string.Equals(action.ActionType, "Else", StringComparison.OrdinalIgnoreCase))
                {
                    // Encountered only when walking through the TRUE-branch body and the
                    // loop reached the ELSE boundary. Skip the FALSE-branch body entirely
                    // by jumping to the matching ENDIF. Orphan ELSE (no entry in the map
                    // because the load-time validator failed to strip it) → treat as a
                    // no-op so the rows after it run with whatever scope they were already
                    // in. Falling through to the FALSE branch instead would execute the
                    // wrong code path, which is worse than ignoring the orphan marker.
                    if (endIfOf.TryGetValue(i, out int endIdx))
                        i = endIdx;
                    continue;
                }
                if (string.Equals(action.ActionType, "EndIf", StringComparison.OrdinalIgnoreCase))
                {
                    continue; // structural marker — no work, no delay, no highlight
                }

                if (action.IsSkipped) continue;
                int safeDelay = Math.Max(0, action.Delay);
                if (_useDelayVariation && _delayVariationPercent > 0 && safeDelay > 0)
                {
                    int variation = safeDelay * _delayVariationPercent / 100;
                    safeDelay += Random.Shared.Next(-variation, variation + 1);
                    safeDelay = Math.Max(0, safeDelay);
                }

                await Task.Delay(safeDelay, token);
                _currentActionRow = i + 1; // {row} token source (1-based grid row)
                dispatcherQueue.TryEnqueue(() => OnActionExecuting?.Invoke(action));
                InputHookManager.IsReplayingAction = true;

                try
                {
                    switch (action.ActionType)
                    {
                        case "KeyDown": {
                            // Token keys record their resolution under the RAW key text so the
                            // matching KeyUp releases exactly what was pressed — {var} can change
                            // (SetVariable in between), {random} re-rolls, {clipboard} is live.
                            // Without the pairing, the up would target a different key and the
                            // pressed one would stay stuck past a normally-completed run.
                            var downKey = await ResolveKeyTokens(action.Key);
                            if (action.Key.IndexOf('{') >= 0)
                                _pendingTokenKeyDowns[action.Key] = downKey;
                            SimulateKey(downKey, true);
                            break;
                        }
                        case "KeyUp": {
                            string upKey;
                            if (action.Key.IndexOf('{') >= 0 && _pendingTokenKeyDowns.Remove(action.Key, out var pairedDown))
                                upKey = pairedDown;
                            else
                                upKey = await ResolveKeyTokens(action.Key);
                            SimulateKey(upKey, false);
                            break;
                        }
                        case "HoldKey": {
                            // Send KEYDOWN, hold the configured duration, then KEYUP. The
                            // SimulateKey tracker (Add on isDown / Remove on !isDown) keeps
                            // the key in _simulatedKeysDown for the entire hold, so a Stop
                            // mid-hold has ResetKeyState() release it cleanly instead of
                            // leaving it stuck in the OS keyboard state.
                            int duration = action.HoldDurationMs > 0
                                ? Math.Max(10, Math.Min(60000, action.HoldDurationMs))
                                : ActionItem.DefaultHoldDurationMs;
                            // Resolve ONCE and reuse for both halves — the down and up must
                            // agree on the key string or the stuck-key tracker desyncs.
                            var holdKey = await ResolveKeyTokens(action.Key);
                            SimulateKey(holdKey, true);
                            try { await Task.Delay(duration, token); }
                            catch (OperationCanceledException) { /* ResetKeyState releases */ }
                            SimulateKey(holdKey, false);
                            break;
                        }
                        case "Keystroke": {
                            // RepeatCount > 1 → emit N consecutive press cycles with
                            // RepeatDelayMs gap between them. Clamped 1..999 (same range
                            // as RunProfile). Cancellation checked between iterations so
                            // the user's Stop hotkey aborts a long "× 999" cleanly instead
                            // of waiting for the whole burst to finish.
                            int repeats = Math.Max(1, Math.Min(999, action.RepeatCount));
                            int gap = Math.Max(0, Math.Min(5000, action.RepeatDelayMs ?? ActionItem.DefaultRepeatDelayMs));
                            // Resolve once, outside the burst — no other action runs between
                            // repeats, so the value can't legitimately change mid-burst.
                            var combo = await ResolveKeyTokens(action.Key);
                            for (int r = 0; r < repeats; r++) {
                                if (token.IsCancellationRequested) break;
                                SimulateKeystroke(combo, token);
                                if (r < repeats - 1 && gap > 0) {
                                    try { await Task.Delay(gap, token); }
                                    catch (OperationCanceledException) { break; }
                                }
                            }
                            break;
                        }
                        case "LeftClickDown": SimulateMouse(action.X, action.Y, NativeMethods.MOUSEEVENTF_LEFTDOWN); break;
                        case "LeftClickUp": SimulateMouse(action.X, action.Y, NativeMethods.MOUSEEVENTF_LEFTUP); break;
                        case "RightClickDown": SimulateMouse(action.X, action.Y, NativeMethods.MOUSEEVENTF_RIGHTDOWN); break;
                        case "RightClickUp": SimulateMouse(action.X, action.Y, NativeMethods.MOUSEEVENTF_RIGHTUP); break;
                        case "MiddleClickDown": SimulateMouse(action.X, action.Y, NativeMethods.MOUSEEVENTF_MIDDLEDOWN); break;
                        case "MiddleClickUp": SimulateMouse(action.X, action.Y, NativeMethods.MOUSEEVENTF_MIDDLEUP); break;
                        // Combined-mode clicks: one row = press + release at the same point.
                        // SimulateMouse moves the cursor and embeds the position in each event,
                        // so the two calls land the down/up together (the second move is a no-op).
                        // The release is skipped if the press cancelled the replay (e.g. a missing
                        // target window with relative coords calls _cts.Cancel via
                        // ReportMissingTargetWindow) — this matches paired mode, where the loop
                        // breaks after the *Down action and the *Up never fires, so only ONE error
                        // surfaces. A button left pressed mid-cancel is released by StartAsync's
                        // finally (ResetMouseState), so skipping the up can't leave it stuck.
                        case "LeftClick":
                            SimulateMouse(action.X, action.Y, NativeMethods.MOUSEEVENTF_LEFTDOWN);
                            if (!token.IsCancellationRequested)
                                SimulateMouse(action.X, action.Y, NativeMethods.MOUSEEVENTF_LEFTUP);
                            if (action.IsFocusClick && !token.IsCancellationRequested)
                                FocusTap(action.X, action.Y, NativeMethods.MOUSEEVENTF_LEFTDOWN, NativeMethods.MOUSEEVENTF_LEFTUP, token);
                            break;
                        case "RightClick":
                            SimulateMouse(action.X, action.Y, NativeMethods.MOUSEEVENTF_RIGHTDOWN);
                            if (!token.IsCancellationRequested)
                                SimulateMouse(action.X, action.Y, NativeMethods.MOUSEEVENTF_RIGHTUP);
                            if (action.IsFocusClick && !token.IsCancellationRequested)
                                FocusTap(action.X, action.Y, NativeMethods.MOUSEEVENTF_RIGHTDOWN, NativeMethods.MOUSEEVENTF_RIGHTUP, token);
                            break;
                        case "MiddleClick":
                            SimulateMouse(action.X, action.Y, NativeMethods.MOUSEEVENTF_MIDDLEDOWN);
                            if (!token.IsCancellationRequested)
                                SimulateMouse(action.X, action.Y, NativeMethods.MOUSEEVENTF_MIDDLEUP);
                            if (action.IsFocusClick && !token.IsCancellationRequested)
                                FocusTap(action.X, action.Y, NativeMethods.MOUSEEVENTF_MIDDLEDOWN, NativeMethods.MOUSEEVENTF_MIDDLEUP, token);
                            break;
                        // Two full left press/release pairs at the SAME point with a gap well
                        // below GetDoubleClickTime, so the target app pairs them into a real
                        // double-click. The cursor only travels once — the second pair's move
                        // is a no-op because SimulateMouse sees it's already on target, which
                        // also keeps the clicks inside the SM_CX/CYDOUBLECLK rectangle.
                        // IsFocusClick is intentionally ignored here (a focus tap after a
                        // double-click would read as a triple-click to the target).
                        case "DoubleClick":
                            SimulateMouse(action.X, action.Y, NativeMethods.MOUSEEVENTF_LEFTDOWN);
                            if (!token.IsCancellationRequested)
                                SimulateMouse(action.X, action.Y, NativeMethods.MOUSEEVENTF_LEFTUP);
                            if (!token.IsCancellationRequested)
                            {
                                if (DoubleClickGapMs > 0) Thread.Sleep(DoubleClickGapMs);
                                if (!token.IsCancellationRequested)
                                {
                                    SimulateMouse(action.X, action.Y, NativeMethods.MOUSEEVENTF_LEFTDOWN);
                                    if (!token.IsCancellationRequested)
                                        SimulateMouse(action.X, action.Y, NativeMethods.MOUSEEVENTF_LEFTUP);
                                }
                            }
                            break;
                        case "ScrollUp": SimulateScroll(120); break;
                        case "ScrollDown": SimulateScroll(-120); break;
                        case "SendText":
                        {
                            // Delivery mode picks the flavor: "plain" → clean Key only; "markdown"
                            // (WhatsApp) / "discord" → the pre-serialized KeyMarkdown pasted as plain
                            // text (no HTML) — the flavor's marks are already baked in frontend-side;
                            // default/"rich" → Key + KeyHtml dual-format (target negotiates).
                            var mode = action.SendMode;
                            bool markdownMode = string.Equals(mode, "markdown", StringComparison.OrdinalIgnoreCase)
                                || string.Equals(mode, "discord", StringComparison.OrdinalIgnoreCase);
                            string sendText = markdownMode && !string.IsNullOrEmpty(action.KeyMarkdown)
                                ? action.KeyMarkdown : action.Key;
                            string? sendHtml = string.IsNullOrEmpty(mode) || string.Equals(mode, "rich", StringComparison.OrdinalIgnoreCase)
                                ? action.KeyHtml : null;
                            await SimulateClipboardPaste(sendText, sendHtml, token);
                            break;
                        }
                        case "SetVariable": await ExecuteSetVariable(action); break;
                        case "CopyToSlot": await ExecuteCopyToSlot(action, token); break;
                        case "ActivateWindow": await ExecuteActivateWindow(action, token); break;
                        case "WaitImage": await ExecuteWaitImage(action, token); break;
                        case "WaitPixelColor": await ExecuteWaitPixelColor(action, token); break;
                        case "RunProfile": await HandleRunProfile(action, token); break;
                        case "Pause": await ExecutePause(action, token); break;
                        case "BrowserAssert": await ExecuteBrowserAssert(action, token); break;
                        case "BrowserClick":
                        case "BrowserRightClick":
                        case "BrowserType":
                        case "BrowserWaitElement":
                        case "BrowserNavigate":
                        case "BrowserSelectOption":
                            if (_browserBridge != null)
                            {
                                // Resolve {clipboard}, {date}, {time}, {datetime} in BrowserText without
                                // mutating original. Applies to BrowserType AND BrowserSelectOption
                                // (where a user might want to pick an option dynamically by clipboard
                                // content, e.g. clipboard holds "Option 1" → select matches that).
                                string? resolvedText = null;
                                if ((action.ActionType == "BrowserType" || action.ActionType == "BrowserSelectOption")
                                    && !string.IsNullOrEmpty(action.BrowserText))
                                    resolvedText = await ResolveBrowserTextPlaceholders(action.BrowserText);
                                await _browserBridge.ExecuteBrowserCommandAsync(action, token, action.Timeout > 0 ? action.Timeout : 5000, resolvedText);
                            }
                            break;
                    }
                }
                finally
                {
                    InputHookManager.IsReplayingAction = false;
                }
            }
        }

        /// <summary>
        /// Saved snapshot of the window-context state so a sub-profile can apply its own without
        /// destroying the caller's context.
        /// </summary>
        private struct WindowContextSnapshot
        {
            public bool UseRelativeCoordinates;
            public Models.WindowTarget? WindowTarget;
            public int LockWidth, LockHeight, LockX, LockY;
            public bool RestorePosition;
            public bool RestoreSize;
            public bool BringToFocus;
        }

        private WindowContextSnapshot SaveWindowContext() => new()
        {
            UseRelativeCoordinates = _useRelativeCoordinates,
            WindowTarget = _windowTarget,
            LockWidth = _lockWidth,
            LockHeight = _lockHeight,
            LockX = _lockX,
            LockY = _lockY,
            RestorePosition = _restorePosition,
            RestoreSize = _restoreSize,
            BringToFocus = _bringToFocus,
        };

        private void RestoreWindowContext(WindowContextSnapshot snap)
        {
            _useRelativeCoordinates = snap.UseRelativeCoordinates;
            _windowTarget = snap.WindowTarget;
            _windowTargetTitleRegex = TrueReplayer.Helpers.WindowMatcher.CompileTitleRegex(snap.WindowTarget);
            _lockWidth = snap.LockWidth;
            _lockHeight = snap.LockHeight;
            _lockX = snap.LockX;
            _lockY = snap.LockY;
            _restorePosition = snap.RestorePosition;
            _restoreSize = snap.RestoreSize;
            _bringToFocus = snap.BringToFocus;
        }

        /// <summary>
        /// Runs the focus + lock-position + lock-size setup that StartAsync does at the top,
        /// but extracted so a sub-profile entry can apply its own target window the same way.
        /// </summary>
        private async Task ApplyWindowContextAsync(CancellationToken token)
        {
            if (_bringToFocus && _windowTarget != null)
            {
                var targetHwnd = FindTargetWindow();
                if (targetHwnd != IntPtr.Zero)
                {
                    // Full activation stack, best-effort (see WindowActivation).
                    await TrueReplayer.Helpers.WindowActivation.ActivateAsync(
                        targetHwnd, _windowTarget, _windowTargetTitleRegex, token);
                    await Task.Delay(200, token);
                }
            }

            bool hasSize = _lockWidth > 0 && _lockHeight > 0;
            bool applySize = _restoreSize && hasSize;
            bool applyPos = _restorePosition;
            if (_windowTarget != null && (applySize || applyPos))
                await ApplyWindowGeometryAsync(FindTargetWindow(), _lockX, _lockY, _lockWidth, _lockHeight, applyPos, applySize, token);
        }

        /// <summary>
        /// Moves and/or resizes a window to a saved rect. Shared by the profile/folder
        /// "restore position/size" pass and the per-action ActivateWindow placement, so the
        /// un-maximize workaround (a zoomed window ignores SetWindowPos sizing — the Chrome
        /// case) and the minimized guard live in ONE place instead of being copied per call site.
        /// </summary>
        private static async Task ApplyWindowGeometryAsync(
            IntPtr hwnd, int x, int y, int width, int height,
            bool applyPos, bool applySize, CancellationToken token)
        {
            if (hwnd == IntPtr.Zero || (!applyPos && !applySize)) return;
            if (NativeMethods.IsIconic(hwnd)) return;
            if (applySize && NativeMethods.IsZoomed(hwnd))
            {
                NativeMethods.ShowWindow(hwnd, NativeMethods.SW_RESTORE);
                await Task.Delay(80, token);
            }
            uint flags = NativeMethods.SWP_NOZORDER;
            if (!applyPos) flags |= NativeMethods.SWP_NOMOVE;
            if (!applySize) flags |= NativeMethods.SWP_NOSIZE;
            NativeMethods.SetWindowPos(hwnd, IntPtr.Zero,
                applyPos ? x : 0, applyPos ? y : 0,
                applySize ? width : 0, applySize ? height : 0, flags);
            await Task.Delay(80, token);
        }

        /// <summary>
        /// Resolves a RunProfile action: validates target, guards cycles and depth, applies the
        /// sub-profile's window context (if it has one), executes its actions N times, then
        /// restores the caller's context.
        /// </summary>
        private async Task HandleRunProfile(ActionItem action, CancellationToken token)
        {
            var targetName = action.Key?.Trim();
            if (string.IsNullOrEmpty(targetName))
            {
                DiagnosticLog.Info("[Chain] RunProfile with empty profile name — skipped.");
                return;
            }

            // Cycle detection: refuse if the target is already on the active call stack.
            if (_callStack.Contains(targetName, StringComparer.OrdinalIgnoreCase))
            {
                var path = string.Join(" → ", _callStack) + " → " + targetName;
                DiagnosticLog.Info($"[Chain] Cycle detected, aborting sub-call: {path}");
                return;
            }

            // Hard depth cap as a defensive belt-and-suspenders even when cycle detection passes.
            if (_callStack.Count >= MaxCallDepth)
            {
                DiagnosticLog.Info($"[Chain] Max depth {MaxCallDepth} exceeded at '{targetName}', aborting.");
                return;
            }

            if (_profileLookup == null)
            {
                DiagnosticLog.Info("[Chain] Profile lookup not configured — RunProfile is a no-op.");
                return;
            }

            Models.UserProfile? subProfile;
            try
            {
                subProfile = await _profileLookup(targetName);
            }
            catch (Exception ex)
            {
                DiagnosticLog.Info($"[Chain] Profile lookup threw for '{targetName}': {ex.Message}");
                return;
            }

            if (subProfile == null)
            {
                DiagnosticLog.Info($"[Chain] Profile '{targetName}' not found, skipping.");
                return;
            }

            // Disabled sub-profiles are skipped at replay time — same rule as direct hotkey
            // triggering (ProfileController.GetProfileHotkeys filters disabled). Running a
            // profile the user has explicitly turned off would surprise more than help.
            if (subProfile.IsDisabled)
            {
                DiagnosticLog.Info($"[Chain] Profile '{targetName}' is disabled, skipping.");
                return;
            }

            // Push and update chain status BEFORE applying sub context so the user sees the
            // chain even during the focus/lock setup phase.
            _callStack.Add(targetName);
            NotifyChainChanged();

            var savedContext = SaveWindowContext();
            try
            {
                // Resolve sub's effective context: own target wins, otherwise fall back to the
                // folder it lives in. Without the folder fallback, a sub-profile that inherits
                // its target from a folder would silently run against the caller's window.
                Models.WindowTarget? subTarget = null;
                bool subUseRel = false, subBringFocus = false, subRestorePos = false, subRestoreSz = false;
                int subW = 0, subH = 0, subX = 0, subY = 0;
                if (subProfile.TargetWindow != null)
                {
                    subTarget = subProfile.TargetWindow;
                    subUseRel = subProfile.UseRelativeCoordinates;
                    subBringFocus = subProfile.BringToFocus;
                    subRestorePos = subProfile.RestorePosition;
                    subRestoreSz = subProfile.RestoreSize;
                    subW = subProfile.WindowWidth;
                    subH = subProfile.WindowHeight;
                    subX = subProfile.WindowX;
                    subY = subProfile.WindowY;
                }
                else
                {
                    var inherited = _folderInheritedContextLookup?.Invoke(targetName);
                    if (inherited.HasValue)
                    {
                        subTarget = inherited.Value.Target;
                        subUseRel = inherited.Value.UseRelativeCoordinates;
                        subBringFocus = inherited.Value.BringToFocus;
                        subRestorePos = inherited.Value.RestorePosition;
                        subRestoreSz = inherited.Value.RestoreSize;
                        subW = inherited.Value.Width;
                        subH = inherited.Value.Height;
                        subX = inherited.Value.X;
                        subY = inherited.Value.Y;
                    }
                    // else: no own target and no folder — keep the caller's context unchanged
                    //       (sub runs against whatever the parent set up).
                }
                if (subTarget != null)
                {
                    _windowTarget = subTarget;
                    _windowTargetTitleRegex = TrueReplayer.Helpers.WindowMatcher.CompileTitleRegex(subTarget);
                    _useRelativeCoordinates = subUseRel;
                    _bringToFocus = subBringFocus;
                    _restorePosition = subRestorePos;
                    _restoreSize = subRestoreSz;
                    _lockWidth = subW;
                    _lockHeight = subH;
                    _lockX = subX;
                    _lockY = subY;
                    await ApplyWindowContextAsync(token);
                }

                // Clamp 1..999 to match Keystroke (the canonical RepeatCount range) — without
                // an upper bound a hand-edited/corrupt RepeatCount could spin a sub-profile an
                // unbounded number of times before the Stop hotkey gets a turn between iterations.
                int repeats = Math.Max(1, Math.Min(999, action.RepeatCount));
                var subActions = subProfile.Actions.ToList();

                // Data-loop Phase C: "run once per data row" iterates the SUB-profile's own
                // table, one sub-run per row, {row:col} resolving from that row. RepeatCount
                // is ignored while over-data (UI disables it). Missing/empty table degrades
                // to a single normal run with a log line (graceful, never a hard error).
                if (action.RunOverData == true && (subProfile.Data?.Rows?.Count ?? 0) > 0)
                {
                    await RunSubProfileOverDataAsync(targetName, subActions, subProfile.Data!, token);
                }
                else
                {
                    // Over-data with no rows degrades to exactly ONE run — the stored
                    // RepeatCount belongs to the mode the user turned off.
                    if (action.RunOverData == true)
                    {
                        DiagnosticLog.Warn($"[Chain] '{targetName}' has no data rows — 'run once per data row' fell back to a single run.");
                        repeats = 1;
                    }
                    for (int r = 0; r < repeats && !token.IsCancellationRequested && !_rowFaulted; r++)
                    {
                        await ExecuteActionsAsync(subActions, token);
                    }
                }
            }
            finally
            {
                RestoreWindowContext(savedContext);

                // After returning to the caller's context, re-bring its window to focus so the
                // remaining actions of the parent run against the intended window. We don't
                // re-apply lock-position because the window is still where we put it.
                if (_bringToFocus && _windowTarget != null && !token.IsCancellationRequested)
                {
                    try
                    {
                        var hwnd = FindTargetWindow();
                        if (hwnd != IntPtr.Zero)
                        {
                            // Full activation stack, best-effort (see WindowActivation) —
                            // the bare SetForegroundWindow this used to call is routinely
                            // rejected by the foreground lock when TR isn't active.
                            await TrueReplayer.Helpers.WindowActivation.ActivateAsync(
                                hwnd, _windowTarget, _windowTargetTitleRegex, token);
                            await Task.Delay(80, token);
                        }
                    }
                    catch { /* best-effort restore */ }
                }

                if (_callStack.Count > 0) _callStack.RemoveAt(_callStack.Count - 1);
                NotifyChainChanged();
            }
        }

        /// <summary>
        /// Data-loop Phase C body: run the sub-profile once per row of ITS OWN Data table,
        /// stamping the shared row context so {row:col} resolves per row inside the sub. The
        /// caller's data context (table / loop flag / current row / soft-fault override) is
        /// saved and restored — a parent batch loop keeps its own row across the call. The
        /// Model-B cursor is untouched (batch iteration is not a "run") and the lap notice
        /// never fires (cursor-mode feature). Fault policy per row:
        ///   sub table "skip"        → faulted row absorbed HERE: stuck input released,
        ///                             logged + counted, next row runs (mirrors StartAsync's
        ///                             per-iteration skip block);
        ///   sub halt + parent skip  → _softFaultOverride keeps the fault SOFT (FaultRow, not
        ///                             _cts.Cancel), remaining sub rows abort, and the fault
        ///                             propagates to the PARENT row (today's granularity: a
        ///                             failed sub call = one skipped parent row);
        ///   sub halt, no parent skip→ the fault site cancels _cts exactly like today.
        /// </summary>
        private async Task RunSubProfileOverDataAsync(
            string subName, List<ActionItem> subActions, Models.ProfileDataTable subTable, CancellationToken token)
        {
            bool parentSkipActive = SkipRowOnErrorActive;
            var savedTable = _dataTable;
            bool savedLoopOver = _dataLoopOver;
            var savedRowData = _currentRowData;
            bool savedSoftOverride = _softFaultOverride;
            bool subSkip = string.Equals(subTable.OnRowError, "skip", StringComparison.OrdinalIgnoreCase);
            int rowCount = subTable.Rows?.Count ?? 0;
            int skipped = 0;
            string? firstReason = null;
            try
            {
                // The sub table comes straight from the profile lookup, which does NOT pass
                // through SetDataTable's null-normalization trust boundary — a hand-edited
                // {"Headers":null} sub .trprofile would NRE in BuildRowDict otherwise.
                subTable.Headers ??= new List<string>();
                subTable.Rows ??= new List<List<string>>();

                _dataTable = subTable;
                _dataLoopOver = true;               // fault sites now read the SUB's skip policy…
                _softFaultOverride = parentSkipActive && !subSkip;   // …or stay soft for the parent's sake

                for (int i = 0; i < rowCount && !token.IsCancellationRequested; i++)
                {
                    _currentRowData = BuildRowDict(subTable, i);
                    PushVariablesSnapshot();   // live pane: show which row {row:col} resolves from (throttled)
                    _rowFaulted = false;
                    _rowFaultReason = null;
                    try
                    {
                        await ExecuteActionsAsync(subActions, token);
                    }
                    // Same two-catch shape as StartAsync's batch loop: a genuine Stop (token
                    // cancelled) keeps unwinding; a SPURIOUS OCE (pipe drop resolving an
                    // in-flight TCS) and any thrown action error (browser exceptions, If-probe
                    // Halt rethrows) are just row errors while a skip policy is active.
                    catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
                    catch (Exception ex) when (SkipRowOnErrorActive)
                    {
                        FaultRow(ex.Message);
                    }

                    if (!_rowFaulted) continue;

                    if (subSkip)
                    {
                        skipped++;
                        firstReason ??= _rowFaultReason;
                        // A skipped row may die mid-hold — release anything the faulted row
                        // left pressed before the next row starts.
                        ResetMouseState();
                        ResetKeyState();
                        DiagnosticLog.Warn($"[Chain] '{subName}' data row {i + 1}/{rowCount} skipped: {_rowFaultReason}");
                        _rowFaulted = false;
                        _rowFaultReason = null;
                        continue;
                    }

                    // Halt-mode sub under a skip-active parent: abort the remaining sub rows and
                    // leave _rowFaulted SET — after the finally restores the parent context, the
                    // parent's boundary checks unwind this as a normal parent-row fault.
                    break;
                }

                // Suppressed after a deliberate Stop — a notice right after the user's own
                // abort is noise (StartAsync's summary applies the same gate).
                if (skipped > 0 && !token.IsCancellationRequested)
                {
                    string msg = $"Sub-profile '{subName}': {skipped} of {rowCount} row(s) skipped" +
                        (firstReason != null ? $" — first: {firstReason}" : "");
                    OnReplayError?.Invoke(msg);
                }
            }
            finally
            {
                _dataTable = savedTable;
                _dataLoopOver = savedLoopOver;
                _currentRowData = savedRowData;
                _softFaultOverride = savedSoftOverride;
                PushVariablesSnapshot();   // live pane: back on the parent's row
            }
        }

        private void NotifyChainChanged()
        {
            if (_onChainChanged == null) return;
            // Send a defensive copy so callers can't mutate our internal state.
            var snapshot = new List<string>(_callStack);
            dispatcherQueue.TryEnqueue(() => _onChainChanged?.Invoke(snapshot));
        }

        private static readonly Dictionary<string, int> ModifierGenericVkCodes = new(StringComparer.OrdinalIgnoreCase)
        {
            ["Ctrl"] = 0x11,   // VK_CONTROL (left or right)
            ["Alt"] = 0x12,    // VK_MENU (left or right)
            ["Shift"] = 0x10,  // VK_SHIFT (left or right)
        };

        /// <summary>
        /// Sends key-up events for any modifier keys (Alt, Ctrl, Shift, Win) the user is
        /// currently physically holding, so the target app's input state is clean when the
        /// replay's simulated keystrokes arrive. Without this, a replay triggered by a
        /// combined hotkey like Alt+Q would have every simulated key stroke seen as Alt+key
        /// by the target because the OS still reports Alt as pressed.
        /// The user's real key-up event that follows is a benign duplicate for the target.
        /// </summary>
        private void ReleasePhysicallyHeldModifiers()
        {
            // Check specific L/R vk codes so we send keyup for the exact key the user is holding,
            // not the generic virtual key (which some drivers ignore).
            ReadOnlySpan<ushort> modifierVks = new ushort[]
            {
                0xA0, 0xA1,   // LShift, RShift
                0xA2, 0xA3,   // LControl, RControl
                0xA4, 0xA5,   // LMenu, RMenu (Alt)
                0x5B, 0x5C,   // LWin, RWin
            };

            var inputs = new System.Collections.Generic.List<NativeMethods.INPUT>(modifierVks.Length);
            foreach (var vk in modifierVks)
            {
                if ((NativeMethods.GetAsyncKeyState(vk) & 0x8000) == 0) continue;
                inputs.Add(new NativeMethods.INPUT
                {
                    type = NativeMethods.INPUT_KEYBOARD,
                    U = new NativeMethods.InputUnion
                    {
                        ki = new NativeMethods.KEYBDINPUT { wVk = vk, dwFlags = NativeMethods.KEYEVENTF_KEYUP }
                    }
                });
            }

            if (inputs.Count > 0)
            {
                NativeMethods.SendInput((uint)inputs.Count, inputs.ToArray(),
                    Marshal.SizeOf(typeof(NativeMethods.INPUT)));
            }
        }

        private async Task WaitForHotkeyReleaseAsync(CancellationToken token)
        {
            var hotkey = InputHookManager.LastTriggerHotkey;
            InputHookManager.LastTriggerHotkey = null;

            if (string.IsNullOrEmpty(hotkey))
                return;

            var vkCodes = new List<int>();

            foreach (var part in hotkey.Split('+'))
            {
                var trimmed = part.Trim();
                if (ModifierGenericVkCodes.TryGetValue(trimmed, out int genericVk))
                    vkCodes.Add(genericVk);
                else if (Helpers.KeyUtils.TryResolveVirtualKeyCode(trimmed, out ushort vk))
                    vkCodes.Add(vk);
            }

            if (vkCodes.Count == 0)
                return;

            var deadline = DateTime.Now.AddMilliseconds(2000);

            while (!token.IsCancellationRequested && DateTime.Now < deadline)
            {
                bool anyPressed = false;
                foreach (var vk in vkCodes)
                {
                    if ((NativeMethods.GetAsyncKeyState(vk) & 0x8000) != 0)
                    {
                        anyPressed = true;
                        break;
                    }
                }

                if (!anyPressed)
                    break;

                await Task.Delay(10, token);
            }
        }

        public void Stop()
        {
            // Only cancel — disposal is handled by the next StartAsync() call (via async path).
            // ObjectDisposedException is possible if Stop fires concurrently with a fresh
            // StartAsync that already disposed the old cts; swallow because the intent
            // (stop whatever's running) is satisfied regardless.
            try { _cts?.Cancel(); } catch (ObjectDisposedException) { /* already gone */ }
            ResetMouseState();
            ResetKeyState();
        }

        // Tracks mouse buttons pressed down by the replay that have not yet been released.
        // Used by ResetMouseState to only release buttons we actually pressed — avoids firing
        // spurious UP events (which some apps perceive as a click) when replay stops cleanly.
        private bool _simLeftDown, _simRightDown, _simMiddleDown;

        // Same idea for keyboard: tracks key names sent KEYDOWN by the replay that haven't
        // received their matching KEYUP yet. Used by ResetKeyState on Stop so a macro that
        // does `KeyDown(W), delay 10s, KeyUp(W)` doesn't leave W stuck in the OS keyboard
        // state when the user hits Stop mid-hold (a real bug pre-fix — without an explicit
        // KEYUP the OS treats the key as physically pressed until the user releases it
        // themselves, which manifests as a "stuck character" or a game-character that
        // keeps walking forever). StringComparer.OrdinalIgnoreCase matches the resolution
        // logic in SimulateKey which is case-insensitive at the VK lookup.
        private readonly HashSet<string> _simulatedKeysDown = new(StringComparer.OrdinalIgnoreCase);

        // Serializes mutation/inspection of the simulated-input "currently down" state
        // (_simLeftDown/_simRightDown/_simMiddleDown and _simulatedKeysDown) so Stop()'s
        // ResetMouseState/ResetKeyState (UI/hotkey thread) can't race the replay thread
        // mid-dispatch and leave a button/key stuck or corrupt the HashSet.
        private readonly object _simInputLock = new();

        private void ResetMouseState()
        {
            lock (_simInputLock)
            {
                if (!_simLeftDown && !_simRightDown && !_simMiddleDown) return;
                NativeMethods.GetCursorPos(out var pos);
                // pos is already absolute screen space — coordsAreProfileSpace:false skips the
                // relative-offset resolution (which would mis-place, or even suppress, the UP).
                if (_simLeftDown)   SimulateMouse(pos.x, pos.y, NativeMethods.MOUSEEVENTF_LEFTUP,   coordsAreProfileSpace: false);
                if (_simRightDown)  SimulateMouse(pos.x, pos.y, NativeMethods.MOUSEEVENTF_RIGHTUP,  coordsAreProfileSpace: false);
                if (_simMiddleDown) SimulateMouse(pos.x, pos.y, NativeMethods.MOUSEEVENTF_MIDDLEUP, coordsAreProfileSpace: false);
            }
        }

        private void ResetKeyState()
        {
            lock (_simInputLock)
            {
                if (_simulatedKeysDown.Count == 0) return;
                // Snapshot first — SimulateKey(_, false) calls Remove() on the set, mutating it
                // mid-iteration. Copy-then-iterate avoids InvalidOperationException.
                var pending = _simulatedKeysDown.ToArray();
                foreach (var key in pending) SimulateKey(key, false);
            }
        }

        private void SimulateScroll(int delta)
        {
            int inputSize = Marshal.SizeOf(typeof(NativeMethods.INPUT));
            var scrollInput = new NativeMethods.INPUT
            {
                type = NativeMethods.INPUT_MOUSE,
                U = new NativeMethods.InputUnion
                {
                    mi = new NativeMethods.MOUSEINPUT
                    {
                        mouseData = (uint)delta,
                        dwFlags = NativeMethods.MOUSEEVENTF_WHEEL,
                    }
                }
            };
            NativeMethods.SendInput(1, new[] { scrollInput }, inputSize);
        }

        private IntPtr FindTargetWindow()
            => TrueReplayer.Helpers.WindowMatcher.FindWindow(_windowTarget, _windowTargetTitleRegex);

        /// <summary>
        /// Resolve the offset (window origin) that converts profile-space coordinates to
        /// absolute virtual-desktop coordinates. Used by every replay path that consumes
        /// stored relative coords — mouse clicks, WaitImage search region, WaitPixelColor.
        ///
        /// Returns true when no translation is needed (rel coords off OR no target window
        /// configured — degenerate state preserved for backward compat) OR the target was
        /// found and dx/dy are populated. Returns false ONLY when rel coords are on AND a
        /// target is configured AND we couldn't resolve the running window — caller should
        /// treat this as an error (call <see cref="ReportMissingTargetWindow"/>).
        /// </summary>
        private bool TryResolveRelativeOffset(out int dx, out int dy)
        {
            dx = 0;
            dy = 0;
            if (!_useRelativeCoordinates) return true;
            if (_windowTarget == null) return true;
            var hwnd = FindTargetWindow();
            if (hwnd == IntPtr.Zero) return false;
            if (!NativeMethods.GetWindowRect(hwnd, out var rect)) return false;
            dx = rect.Left;
            dy = rect.Top;
            return true;
        }

        /// <summary>
        /// Surfaces a visible error and stops the replay when a profile-relative action
        /// can't resolve its target window. Used to be silent for mouse clicks — actions
        /// would land at the relative coord interpreted as absolute, almost certainly
        /// somewhere wrong. Now the user sees "target window X not found" instead.
        /// </summary>
        private void ReportMissingTargetWindow()
        {
            var name = _windowTarget?.ProcessName ?? "target";
            if (SkipRowOnErrorActive)
            {
                FaultRow($"target window '{name}' not found");
                return;
            }
            DiagnosticLog.Warn($"Replay aborted: relative-coords target window not found [{name} {_windowTarget?.WindowTitle}]".TrimEnd());
            OnReplayError?.Invoke($"Target window '{name}' not found — open it and retry");
            try { _cts?.Cancel(); } catch (ObjectDisposedException) { }
        }

        // ── ActivateWindow ──
        // Combined find → launch-if-missing → wait → focus. The matcher reuses the
        // If-Window fields (WindowProcessName/WindowTitle/WindowTitleMatchMode); Timeout
        // is the wait-for-window budget; window EXISTENCE is the only success criterion —
        // the launched process is never tracked, so single-instance apps that forward to
        // an already-running instance behave identically to a plain focus.
        private async Task ExecuteActivateWindow(ActionItem action, CancellationToken token)
        {
            var (target, regex) = BuildWindowTargetFromAction(action);
            bool hasMatcher = target.ProcessName != null || target.WindowTitle != null;

            // Phase-3 verb + nth-match. Verb null/unknown = "activate" (bring to foreground). matchN
            // is 1-based in Z-order (front→back); null/≤1 = first match.
            string verb = (action.WindowVerb ?? "activate").ToLowerInvariant();
            if (verb != "maximize" && verb != "minimize" && verb != "close") verb = "activate";
            int matchN = action.WindowMatchIndex is int mi && mi > 1 ? mi : 1;

            // LaunchPath/LaunchArgs accept the same tokens as SendText ({var:}, {clipboard}, …).
            // Only activate/maximize can launch — resolving for minimize/close would fire a token's
            // side effects (e.g. an {input:} prompt / clipboard-cursor advance) whose result is then
            // discarded, since those verbs never launch.
            string? path = null;
            string? args = null;
            if (verb == "activate" || verb == "maximize")
            {
                path = string.IsNullOrWhiteSpace(action.LaunchPath)
                    ? null
                    : (await ResolveTokens(action.LaunchPath)).Trim();
                if (string.IsNullOrEmpty(path)) path = null;
                args = path != null && !string.IsNullOrWhiteSpace(action.LaunchArgs)
                    ? await ResolveTokens(action.LaunchArgs)
                    : null;
            }

            if (!hasMatcher)
            {
                // Pure-run row: no matcher → fire-and-forget shell run (URL, document, .lnk, exe).
                // Only the "activate" intent launches; minimize/close have no window to act on → no-op.
                // A row with neither matcher nor launch no-ops (SetVariable-without-a-name forgiveness).
                if (path == null || verb == "minimize" || verb == "close") return;
                if (!TryLaunch(path, args, out var runError))
                    HandleActivateWindowFailure(action, $"launch failed: {runError}");
                return;
            }

            // Minimize / Close act on the EXISTING window only — no launch, no focus, no wait. If it's
            // not there, nothing to do and the goal (window minimized / gone) is already met — benign
            // no-op success (owner decision).
            if (verb == "minimize" || verb == "close")
            {
                IntPtr existing = FindWindowExcludingSelf(target, regex, matchN);
                if (existing == IntPtr.Zero)
                {
                    DiagnosticLog.Info($"ActivateWindow {verb}: no matching window — nothing to do");
                    return;
                }
                if (verb == "minimize")
                    NativeMethods.ShowWindow(existing, NativeMethods.SW_MINIMIZE);
                else
                    NativeMethods.PostMessage(existing, NativeMethods.WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
                return;
            }

            IntPtr hwnd = FindWindowExcludingSelf(target, regex, matchN);

            // Launch AT MOST once, and only when no window matched first — re-running
            // the program on every poll would spawn N copies of a slow-starting app.
            if (hwnd == IntPtr.Zero && path != null)
            {
                if (!TryLaunch(path, args, out var launchError))
                {
                    HandleActivateWindowFailure(action, $"launch failed: {launchError}");
                    return;
                }
            }

            int timeoutMs = action.Timeout > 0 ? action.Timeout : 10000;
            var sw = System.Diagnostics.Stopwatch.StartNew();
            while (hwnd == IntPtr.Zero)
            {
                if (sw.ElapsedMilliseconds >= timeoutMs)
                {
                    HandleActivateWindowFailure(action, "window not found");
                    return;
                }
                await Task.Delay(200, token); // token-aware — the Stop hotkey aborts instantly
                hwnd = FindWindowExcludingSelf(target, regex, matchN);
            }

            if (!await TrueReplayer.Helpers.WindowActivation.ActivateAsync(hwnd, target, regex, token))
            {
                HandleActivateWindowFailure(action, "could not bring window to foreground");
                return;
            }

            // Readiness: don't fire the following keystrokes into a FROZEN target. Poll
            // IsHungAppWindow within the SAME Timeout budget the window-not-found loop above used
            // (sw is still running). A responsive window returns false on the first check, so this
            // costs nothing on the normal path — it only waits for a genuinely hung app, then applies
            // the On-Timeout policy if it never recovers. IsHungAppWindow is heuristic (true only
            // after ~5s of an unpumped queue), so it's a frozen-app guard, not a "slow loader ready"
            // signal — the 300ms settle below still covers the ordinary focus-animation wait.
            while (NativeMethods.IsHungAppWindow(hwnd))
            {
                if (sw.ElapsedMilliseconds >= timeoutMs)
                {
                    HandleActivateWindowFailure(action, "target window not responding");
                    return;
                }
                await Task.Delay(150, token); // token-aware — the Stop hotkey aborts instantly
            }

            await Task.Delay(300, token); // settle — same wait the replay-start focus uses

            if (verb == "maximize")
            {
                // Maximize is its own placement — SetWindowPos is ignored on a zoomed window, so the
                // Placement fields are mutually exclusive with this verb (the editor hides them).
                NativeMethods.ShowWindow(hwnd, NativeMethods.SW_MAXIMIZE);
                return;
            }

            // Optional placement (activate verb): move/resize the window we just activated. Deliberately
            // uses the hwnd we actually focused rather than a fresh matcher lookup, so with two windows of
            // the same process the placement can never land on a different one. Purely positional
            // — the replay's coordinate context is untouched (clicks still resolve against the
            // profile/folder target; use a sub-profile + RunProfile for per-window relative coords).
            bool placeSize = action.RestoreSize && action.WindowWidth > 0 && action.WindowHeight > 0;
            bool placePos = action.RestorePosition;
            if (placePos || placeSize)
                await ApplyWindowGeometryAsync(hwnd, action.WindowX, action.WindowY,
                    action.WindowWidth, action.WindowHeight, placePos, placeSize, token);
        }

        // ── BrowserAssert ──
        // Verify a page element is in the expected state (reusing the BrowserWaitElement
        // probe + selector fallback) and FAIL the replay LOUDLY when it isn't — the
        // difference from an If, which branches. The extension polls up to Timeout and
        // walks the ranked alternatives; success returns with no side effect. A timeout /
        // failure surfaces as a BrowserActionException which we convert into the friendly
        // Halt/Continue policy. Bridge not connected = we can't verify ⇒ that's a FAILURE
        // (contrast If-Browser, which reads "not found" and branches).
        private async Task ExecuteBrowserAssert(ActionItem action, CancellationToken token)
        {
            if (_browserBridge == null || !_browserBridge.IsConnected)
            {
                HandleAssertFailure(action, "browser bridge not connected");
                return;
            }
            int timeout = action.Timeout > 0 ? action.Timeout : 5000;
            try
            {
                // A text-match assert needs its text pattern resolved for tokens, same as
                // BrowserType/SelectOption. Other modes ignore the text.
                string? resolvedText = string.IsNullOrEmpty(action.BrowserText)
                    ? null
                    : await ResolveBrowserTextPlaceholders(action.BrowserText);
                await _browserBridge.ExecuteBrowserCommandAsync(action, token, timeout, resolvedText);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                throw; // genuine user stop always propagates
            }
            catch (OperationCanceledException)
            {
                // A SPURIOUS OCE (token.None) — the extension pipe dropped mid-probe, whose
                // cleanup cancels every in-flight TCS with no token. We couldn't verify, so
                // it's a FAILURE routed through the policy (same rule as the pre-probe
                // disconnect above) — NOT a silent stop. The If-Browser probe documents the
                // same pipe-disconnect mechanism.
                HandleAssertFailure(action, "browser bridge disconnected");
            }
            catch (BrowserActionException ex)
            {
                HandleAssertFailure(action, ex.Message);
            }
        }

        // BrowserAssert failure policy — mirrors HandleActivateWindowFailure. Default (null)
        // = Halt: report LOUDLY (OnReplayError — the whole point of an assertion) and stop.
        // "Continue" logs and lets the run proceed.
        private void HandleAssertFailure(ActionItem action, string reason)
        {
            string label = !string.IsNullOrWhiteSpace(action.Comment) ? action.Comment
                : !string.IsNullOrWhiteSpace(action.Key) ? action.Key
                : "element";

            if (string.Equals(action.AssertOnFail, "Continue", StringComparison.OrdinalIgnoreCase))
            {
                DiagnosticLog.Warn($"Assert '{label}': {reason} — Continue policy, moving on");
                return;
            }
            if (SkipRowOnErrorActive)
            {
                FaultRow($"Assert failed: '{label}' — {reason}");
                return;
            }
            DiagnosticLog.Warn($"Replay aborted: Assert '{label}' — {reason}");
            OnReplayError?.Invoke($"Assert failed: '{label}' — {reason}");
            try { _cts?.Cancel(); } catch (ObjectDisposedException) { }
        }

        // One failure policy for all three modes (launch threw / window never appeared /
        // activation unverified). Default = halt: keyboard actions follow the OS foreground,
        // so continuing after a silent focus failure would type into the wrong app.
        private void HandleActivateWindowFailure(ActionItem action, string reason)
        {
            bool hasProc = !string.IsNullOrWhiteSpace(action.WindowProcessName);
            bool hasTitle = !string.IsNullOrWhiteSpace(action.WindowTitle);
            string label =
                hasProc && hasTitle ? $"{action.WindowProcessName} · {action.WindowTitle}" :
                hasProc ? action.WindowProcessName! :
                hasTitle ? action.WindowTitle! :
                action.LaunchPath ?? "?";

            if (string.Equals(action.ActivateOnTimeout, "Continue", StringComparison.OrdinalIgnoreCase))
            {
                DiagnosticLog.Warn($"Activate Window '{label}': {reason} — Continue policy, moving on");
                return;
            }
            if (SkipRowOnErrorActive)
            {
                FaultRow($"Activate Window: '{label}' — {reason}");
                return;
            }
            DiagnosticLog.Warn($"Replay aborted: Activate Window '{label}' — {reason}");
            OnReplayError?.Invoke($"Activate Window: '{label}' — {reason}");
            try { _cts?.Cancel(); } catch (ObjectDisposedException) { }
        }

        private static bool TryLaunch(string path, string? args, out string error)
        {
            try
            {
                // UseShellExecute so bare names resolve via PATH/App Paths and URLs,
                // documents and .lnk files open with their registered handler — same
                // semantics as Win+R. The Process object is irrelevant (window existence
                // is the success criterion), dispose it immediately.
                var psi = new System.Diagnostics.ProcessStartInfo
                {
                    FileName = path,
                    Arguments = args ?? string.Empty,
                    UseShellExecute = true,
                };
                System.Diagnostics.Process.Start(psi)?.Dispose();
                error = string.Empty;
                return true;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }

        // WindowMatcher.FindWindow with TrueReplayer's own windows excluded — a target
        // like title-contains "True" must never match (and then activate) ourselves.
        // Same self-skip rule the window picker applies.
        // <paramref name="matchN"/> = nth-match (1-based, EnumWindows Z-order front→back), counted
        // AFTER the visible + self-PID filters so it stays consistent with the first-match default.
        // matchN≤1 keeps the original first-match fast path; if fewer than N windows match, returns
        // Zero (the caller's poll loop then keeps waiting / times out).
        internal static IntPtr FindWindowExcludingSelf(Models.WindowTarget target, Regex? regex, int matchN = 1)
        {
            uint ownPid = (uint)Environment.ProcessId;
            var titleBuffer = new System.Text.StringBuilder(512);
            var procBuffer = new System.Text.StringBuilder(512);
            IntPtr result = IntPtr.Zero;
            int seen = 0;
            NativeMethods.EnumWindows((hwnd, lParam) =>
            {
                if (!NativeMethods.IsWindowVisible(hwnd)) return true;
                NativeMethods.GetWindowThreadProcessId(hwnd, out uint pid);
                if (pid == ownPid) return true;
                if (TrueReplayer.Helpers.WindowMatcher.Matches(hwnd, target, regex, titleBuffer, procBuffer)
                    && ++seen >= matchN)
                {
                    result = hwnd;
                    return false; // stop enumeration at the Nth match
                }
                return true;
            }, IntPtr.Zero);
            return result;
        }

        /// <summary>
        /// Send a synthesized mouse event. By default the (x, y) is interpreted as
        /// "profile coord space" — i.e. relative to the target window when
        /// <see cref="_useRelativeCoordinates"/> is on, absolute otherwise. Pass
        /// <paramref name="coordsAreProfileSpace"/> = false for callers that already
        /// have absolute virtual-desktop coordinates (e.g. WaitImage match-centre
        /// click — the screenshot pipeline returns absolute hits regardless of
        /// profile rel-coord state) so we don't double-translate.
        /// </summary>
        private void SimulateMouse(int x, int y, uint mouseEvent, int mouseData = 0, bool coordsAreProfileSpace = true, bool allowFastApproach = true)
        {
            // Translate profile-space coords (window-relative when UseRelativeCoordinates is on)
            // to absolute virtual-desktop pixels. Callers that already hold absolute coords
            // (e.g. WaitImage match-centre click) pass coordsAreProfileSpace: false to skip.
            // Missing target window with rel-coords on used to silently fall through here —
            // clicks would land at the relative coord interpreted as absolute. Now we surface
            // a visible error and bail instead. Same fix applies to WaitImage / WaitPixelColor.
            if (coordsAreProfileSpace)
            {
                if (!TryResolveRelativeOffset(out int dx, out int dy))
                {
                    ReportMissingTargetWindow();
                    return;
                }
                x += dx;
                y += dy;
            }

            // Cached virtual-screen bounds — saves 4 P/Invokes per mouse action.
            // See NativeMethods.VirtualScreen.
            var (vx, vy, vw, vh) = NativeMethods.VirtualScreen.Bounds;

            int absoluteX = (int)(((double)(x - vx) * 65535) / Math.Max(1, vw - 1));
            int absoluteY = (int)(((double)(y - vy) * 65535) / Math.Max(1, vh - 1));

            uint posFlags = NativeMethods.MOUSEEVENTF_MOVE
                | NativeMethods.MOUSEEVENTF_ABSOLUTE
                | NativeMethods.MOUSEEVENTF_VIRTUALDESK;

            int inputSize = Marshal.SizeOf(typeof(NativeMethods.INPUT));

            // ── Move the cursor to (x,y), then build the click event. ──────────────────────
            // Roblox (and similar) reject a single large "teleport" move — they only follow
            // movement that progresses through intermediate positions, like a physical mouse.
            // So when SmoothMovement is on we INTERPOLATE: walk a straight path from the current
            // cursor to the target in steps of at most MoveStepPx pixels, pausing MoveStepDelayMs
            // between steps. SmoothMovement off (or MoveStepPx == 0) jumps straight (legacy).
            void MoveAbs(int tx, int ty)
            {
                int nx = (int)(((double)(tx - vx) * 65535) / Math.Max(1, vw - 1));
                int ny = (int)(((double)(ty - vy) * 65535) / Math.Max(1, vh - 1));
                NativeMethods.SetCursorPos(tx, ty); // for apps reading GetCursorPos
                var mv = new NativeMethods.INPUT
                {
                    type = NativeMethods.INPUT_MOUSE,
                    U = new NativeMethods.InputUnion { mi = new NativeMethods.MOUSEINPUT { dx = nx, dy = ny, dwFlags = posFlags } }
                };
                NativeMethods.SendInput(1, new[] { mv }, inputSize); // for apps reading Raw Input
            }

            // A click is split across separate SimulateMouse calls (DOWN then UP at the same
            // point); on the UP half the cursor is already on target, so re-issuing the move is a
            // redundant SetCursorPos/SendInput. Skip that no-op move — but the gap sleep below is
            // KEPT on both halves so press→release retains a small, realistic dwell (some games /
            // anti-cheat reject a zero-dwell synthetic click).
            int stepPx = MoveStepPx;
            if (SmoothMovement && stepPx > 0 && NativeMethods.GetCursorPos(out var start) && (start.x != x || start.y != y))
            {
                int originX = start.x, originY = start.y;

                // Fast approach: teleport the long part of the move (SetCursorPos only — no
                // SendInput, so the game never sees a giant Raw-Input delta) to SettleDistancePx
                // short of the target, then smooth-walk just that final stretch below. Skipped
                // for moves already shorter than the settle distance (they're walked in full) and
                // for callers that opt out (the focus tap — see FocusTap). The settle point lands on
                // the nearest integer pixel, so it can sit ~1px off the exact SettleDistancePx ring;
                // that's harmless — the walk below still ends exactly on the target.
                if (allowFastApproach && FastApproach && SettleDistancePx > 0)
                {
                    double fullDx = x - originX;
                    double fullDy = y - originY;
                    double fullDist = Math.Sqrt(fullDx * fullDx + fullDy * fullDy);
                    if (fullDist > SettleDistancePx)
                    {
                        originX = x - (int)Math.Round(fullDx / fullDist * SettleDistancePx);
                        originY = y - (int)Math.Round(fullDy / fullDist * SettleDistancePx);
                        NativeMethods.SetCursorPos(originX, originY); // raw-input-silent teleport
                    }
                }

                int pathDx = x - originX;
                int pathDy = y - originY;
                double dist = Math.Sqrt((double)pathDx * pathDx + (double)pathDy * pathDy);
                int steps = Math.Max(1, (int)Math.Ceiling(dist / stepPx));
                for (int i = 1; i <= steps; i++)
                {
                    double t = (double)i / steps;
                    MoveAbs(originX + (int)Math.Round(pathDx * t), originY + (int)Math.Round(pathDy * t));
                    if (i < steps && MoveStepDelayMs > 0) Thread.Sleep(MoveStepDelayMs);
                }
            }
            else if (SmoothMovement && stepPx > 0 && NativeMethods.GetCursorPos(out var atTarget) && atTarget.x == x && atTarget.y == y)
            {
                // Already exactly on target (typical UP half of a click) — skip the redundant move.
            }
            else
            {
                MoveAbs(x, y); // single jump (SmoothMovement off, MoveStepPx == 0, or GetCursorPos failed)
            }

            var clickInput = new NativeMethods.INPUT
            {
                type = NativeMethods.INPUT_MOUSE,
                U = new NativeMethods.InputUnion
                {
                    mi = new NativeMethods.MOUSEINPUT { dx = absoluteX, dy = absoluteY, mouseData = (uint)mouseData, dwFlags = mouseEvent | posFlags }
                }
            };

            // Small gap before the button fires: after a move it lets the app register the final
            // position; on the same-spot UP half it provides the press→release dwell. Kept on both
            // halves so synthetic clicks keep a realistic, non-zero dwell.
            Thread.Sleep(Math.Max(0, MoveClickDelayMs));
            lock (_simInputLock)
            {
                NativeMethods.SendInput(1, new[] { clickInput }, inputSize);

                // Track currently-pressed buttons here (atomic with the SendInput) so
                // ResetMouseState releases exactly what's down. Living inside SimulateMouse
                // means the missing-target early-return above never leaves a flag set — which
                // previously caused a spurious UP on Stop — and Stop can't observe a torn state.
                if ((mouseEvent & NativeMethods.MOUSEEVENTF_LEFTDOWN) != 0) _simLeftDown = true;
                else if ((mouseEvent & NativeMethods.MOUSEEVENTF_LEFTUP) != 0) _simLeftDown = false;
                if ((mouseEvent & NativeMethods.MOUSEEVENTF_RIGHTDOWN) != 0) _simRightDown = true;
                else if ((mouseEvent & NativeMethods.MOUSEEVENTF_RIGHTUP) != 0) _simRightDown = false;
                if ((mouseEvent & NativeMethods.MOUSEEVENTF_MIDDLEDOWN) != 0) _simMiddleDown = true;
                else if ((mouseEvent & NativeMethods.MOUSEEVENTF_MIDDLEUP) != 0) _simMiddleDown = false;
            }
        }

        // Matches {clipboard} or {clipboard:modifier[:arg]...}
        // Group 1 captures the modifier chain (without the leading colon); empty when no modifiers.
        private static readonly Regex ClipboardTokenRegex = new(
            @"\{clipboard(?::([^}]+))?\}",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);

        /// <summary>
        /// Applies modifier chain (e.g. "trim:line:1:first:8:upper") to clipboard content.
        /// Unknown modifiers are silently ignored so that future modifiers stay forward-compatible.
        /// </summary>
        internal static string ApplyClipboardModifiers(string content, string? modifierChain)
        {
            if (string.IsNullOrEmpty(modifierChain)) return content;
            if (content == null) return string.Empty;

            var parts = modifierChain.Split(':');
            var result = content;
            int i = 0;
            while (i < parts.Length)
            {
                var mod = parts[i].ToLowerInvariant();
                switch (mod)
                {
                    case "upper":
                        result = result.ToUpperInvariant();
                        i++;
                        break;
                    case "lower":
                        result = result.ToLowerInvariant();
                        i++;
                        break;
                    case "sentence":
                        if (result.Length > 0)
                            result = char.ToUpperInvariant(result[0]) + result.Substring(1);
                        i++;
                        break;
                    case "title":
                        {
                            var sb = new System.Text.StringBuilder(result.Length);
                            bool atWordStart = true;
                            foreach (var ch in result)
                            {
                                if (char.IsWhiteSpace(ch)) { sb.Append(ch); atWordStart = true; }
                                else { sb.Append(atWordStart ? char.ToUpperInvariant(ch) : ch); atWordStart = false; }
                            }
                            result = sb.ToString();
                        }
                        i++;
                        break;
                    case "trim":
                        result = result.Trim();
                        i++;
                        break;
                    case "line":
                        if (i + 1 < parts.Length && int.TryParse(parts[i + 1], out var lineN) && lineN >= 1)
                        {
                            var lines = result.Replace("\r\n", "\n").Split('\n');
                            result = lineN <= lines.Length ? lines[lineN - 1] : string.Empty;
                            i += 2;
                        }
                        else i++;
                        break;
                    case "word":
                        if (i + 1 < parts.Length && int.TryParse(parts[i + 1], out var wordN) && wordN >= 1)
                        {
                            var words = result.Split(new[] { ' ', '\t', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries);
                            result = wordN <= words.Length ? words[wordN - 1] : string.Empty;
                            i += 2;
                        }
                        else i++;
                        break;
                    case "first":
                        if (i + 1 < parts.Length && int.TryParse(parts[i + 1], out var firstN) && firstN >= 0)
                        {
                            result = firstN >= result.Length ? result : result.Substring(0, firstN);
                            i += 2;
                        }
                        else i++;
                        break;
                    case "last":
                        if (i + 1 < parts.Length && int.TryParse(parts[i + 1], out var lastN) && lastN >= 0)
                        {
                            result = lastN >= result.Length ? result : result.Substring(result.Length - lastN);
                            i += 2;
                        }
                        else i++;
                        break;

                    // ── List modifiers — operate on CRLF-normalized lines (same split rule
                    // as line:N above) and re-join with "\n". Old app versions skip these
                    // via the default case below, degrading to the unmodified content.
                    case "range":
                        // range:a-b → keep lines a..b (1-based, inclusive; bounds swap when
                        // reversed; clamped to the available lines; no overlap → empty).
                        if (i + 1 < parts.Length && TryParseLineRange(parts[i + 1], out var rangeFrom, out var rangeTo))
                        {
                            var lines = SplitContentLines(result);
                            int from = Math.Max(1, rangeFrom);
                            int to = Math.Min(lines.Length, rangeTo);
                            result = from <= to ? string.Join("\n", lines[(from - 1)..to]) : string.Empty;
                            i += 2;
                        }
                        else i++;
                        break;
                    case "lines":
                        // lines:3,1,2 → pick lines by 1-based index in the given order
                        // (duplicates allowed — it's a reorder/pick, not a filter);
                        // invalid or out-of-range indices are skipped. The arg is only
                        // consumed when it actually contains a digit — same validating
                        // posture as line/word, so a typo'd "lines:upper" doesn't eat
                        // the next modifier.
                        if (i + 1 < parts.Length && parts[i + 1].AsSpan().IndexOfAnyInRange('0', '9') >= 0)
                        {
                            var lines = SplitContentLines(result);
                            var picked = new List<string>();
                            foreach (var tok in parts[i + 1].Split(','))
                            {
                                if (int.TryParse(tok, out var n) && n >= 1 && n <= lines.Length)
                                    picked.Add(lines[n - 1]);
                            }
                            result = string.Join("\n", picked);
                            i += 2;
                        }
                        else i++;
                        break;
                    case "reverse":
                        {
                            var lines = SplitContentLines(result);
                            Array.Reverse(lines);
                            result = string.Join("\n", lines);
                        }
                        i++;
                        break;
                    case "sort":
                        {
                            // Case-insensitive alphabetical — matches the app-wide
                            // case-insensitive matching convention.
                            var lines = SplitContentLines(result);
                            Array.Sort(lines, StringComparer.OrdinalIgnoreCase);
                            result = string.Join("\n", lines);
                        }
                        i++;
                        break;
                    case "dedupe":
                        {
                            // Keeps the FIRST occurrence of each line; case-insensitive.
                            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                            var kept = new List<string>();
                            foreach (var line in SplitContentLines(result))
                                if (seen.Add(line)) kept.Add(line);
                            result = string.Join("\n", kept);
                        }
                        i++;
                        break;
                    case "join":
                        // join:sep → collapse the lines into one with the separator.
                        // ALWAYS consumes exactly the next part ("join:" = empty separator)
                        // — the one modifier whose arg is freeform text, so unconditional
                        // consumption keeps the grammar unambiguous (a separator that
                        // happens to spell a modifier name is still a separator). A
                        // hand-typed trailing {clipboard:...:join} with no arg at all
                        // falls back to a single space.
                        {
                            string sep = i + 1 < parts.Length ? parts[i + 1] : " ";
                            result = string.Join(sep, SplitContentLines(result));
                        }
                        i += 2; // safely past-the-end when no arg — the while condition exits
                        break;

                    default:
                        // Unknown modifier — skip it (forward-compat)
                        i++;
                        break;
                }
            }
            return result;
        }

        // Shared line split for the list modifiers — same CRLF normalization the
        // line:N modifier uses, kept as one helper so all list ops agree on it.
        private static string[] SplitContentLines(string content)
            => content.Replace("\r\n", "\n").Split('\n');

        // Parses the "a-b" argument of range:a-b (both 1-based ints; reversed bounds
        // swap, mirroring {random:a-b}'s forgiveness).
        private static bool TryParseLineRange(string s, out int from, out int to)
        {
            from = 0; to = 0;
            int dash = s.IndexOf('-');
            if (dash <= 0 || dash >= s.Length - 1) return false;
            if (!int.TryParse(s[..dash], out from) || !int.TryParse(s[(dash + 1)..], out to)) return false;
            if (from > to) (from, to) = (to, from);
            return true;
        }

        // Run-state carrier threaded into token resolution: the variable store plus the current
        // loop iteration and data-row index. RunCtx.Empty (the default) is what the static Test
        // Action path uses — there, stateful tokens resolve to empty/0. A later phase populates it
        // from _runtimeVariables + the live loop counter; today it is the seam only, so the unified
        // resolver stays behavior-identical to the pre-refactor scattered resolvers.
        public readonly struct RunCtx
        {
            public IReadOnlyDictionary<string, string>? Variables { get; init; }
            public int Iteration { get; init; }
            public int Row { get; init; }
            // Data-loop current row: column name (lowercased) → cell value. Non-null only
            // while a "loop over data" run is stamping rows. {row:column} resolves from here.
            public IReadOnlyDictionary<string, string>? RowData { get; init; }
            // Clipboard slots (Copy to Slot / capture hotkey): slot name (lowercased) → captured
            // text. {clip:name} resolves from here. Null on the static Test-Action path → empty.
            public IReadOnlyDictionary<string, string>? ClipSlots { get; init; }
            // {input:Label} provider: (label, menu-options-or-null) → the value to substitute.
            // Null on the static Test-Action path (RunCtx.Empty) — there {input} resolves empty.
            // On the live path it pauses replay and prompts the user (ProvideInputAsync).
            public Func<string, string[]?, Task<string>>? InputProvider { get; init; }
            public static RunCtx Empty => default;
        }

        // Live run context handed to token resolution on the replay-instance path. The static
        // Test-Action path never sees this — it resolves against RunCtx.Empty instead.
        private RunCtx CurrentRunCtx => new()
        {
            Variables = _runtimeVariables,
            Iteration = _currentIteration,
            Row = _currentActionRow,
            RowData = _currentRowData,
            // Snapshot, not the live dict — the capture hotkey mutates _clipSlots on the UI
            // thread and a TryGetValue racing a resize is undefined. Slots are tiny (≤ a few
            // entries), so a copy per resolution is noise. _runtimeVariables needs no copy:
            // it is only ever written on the replay thread that is also doing the resolving.
            ClipSlots = SnapshotClipSlots(),
            InputProvider = ProvideInputAsync,
        };

        private IReadOnlyDictionary<string, string> SnapshotClipSlots()
        {
            lock (_runStateLock) return new Dictionary<string, string>(_clipSlots);
        }

        // Variable names: letters/digits/underscore, matched case-insensitively (stored keys are
        // lowercased). Same shape as the {var:name} token regex below — keep the two in sync.
        private static readonly Regex VariableNameRegex = new(@"^[A-Za-z0-9_]+$", RegexOptions.Compiled);

        // Cycle-mode cursors, keyed by executing-profile-name + ActionItem.Id.
        // Deliberately NOT cleared in StartAsync — surviving across runs is the
        // feature: each hotkey press walks the list one item further. Session-lifetime
        // only (the replayer instance is created once per app session); an app restart
        // starts lists over at item 1. The profile-name half of the key matters:
        // Profile Duplicate is a raw File.Copy and import keeps envelope Actions
        // verbatim, so the SAME action Id can exist in several profiles — Id alone
        // would make copies share (and fight over) one cursor. Row-level copies are
        // covered the other way: Clone() gives duplicated rows a fresh Id. Renaming a
        // profile resets its cursors (acceptable for session-only state); deleted rows
        // strand a dead int (negligible).
        private readonly Dictionary<string, int> _cycleCursors = new(StringComparer.Ordinal);

        // SetVariable action: resolve the value's tokens against the live run state, then write
        // (or, for an empty resolved value, delete) the entry. Pure state mutation — no input
        // simulation, no extra delay beyond the row's own Delay.
        //
        // Cycle mode (VariableMode == "cycle"): the RESOLVED value is treated as a list
        // (one item per line, blank lines dropped) and each execution stores the NEXT
        // line, wrapping around. Resolution happens before the split on purpose — a
        // value of just {clipboard} cycles through the clipboard's lines. The modulo
        // keeps an old cursor valid when the list shrinks between presses.
        private async Task ExecuteSetVariable(ActionItem action)
        {
            var name = action.Key?.Trim();
            if (string.IsNullOrEmpty(name) || !VariableNameRegex.IsMatch(name))
                return; // unusable name — no-op, same forgiveness as an unknown clipboard modifier
            var key = name.ToLowerInvariant();
            // escapeBracesInSubstitution:false — the dict stores raw text; brace-escaping (for the
            // SendText segment parser) happens later, at {var} substitution time on that path.
            var value = await ResolveTokens(action.VariableValue ?? string.Empty);

            if (string.Equals(action.VariableMode, "cycle", StringComparison.OrdinalIgnoreCase))
            {
                var items = value.Replace("\r\n", "\n").Split('\n')
                    .Where(l => !string.IsNullOrWhiteSpace(l))
                    .ToArray();
                if (items.Length == 0)
                {
                    lock (_runStateLock) _runtimeVariables.Remove(key); // empty list = delete (same contract as set mode)
                    PushVariablesSnapshot(force: true);
                    return;
                }
                var idPart = string.IsNullOrEmpty(action.Id) ? key : action.Id; // Id always set in practice
                var cursorKey = CurrentExecutingProfileName + "|" + idPart;
                _cycleCursors.TryGetValue(cursorKey, out int cursor);
                lock (_runStateLock) _runtimeVariables[key] = items[((cursor % items.Length) + items.Length) % items.Length];
                _cycleCursors[cursorKey] = (cursor + 1) % items.Length;
                PushVariablesSnapshot(force: true);
                return;
            }

            if (string.IsNullOrEmpty(value))
                lock (_runStateLock) _runtimeVariables.Remove(key);   // empty value = delete (documented contract)
            else
                lock (_runStateLock) _runtimeVariables[key] = value;
            PushVariablesSnapshot(force: true);
        }

        // {input:Label} provider handed to the resolver via RunCtx. Ask-once-per-Label-per-run:
        // the answer is stored in _runtimeVariables (so a later {var:Label} reuses it, and the rich
        // SendText's double resolve — plain pass then html pass — prompts only once). Cancelling the
        // prompt (or a Stop mid-prompt) aborts the run, mirroring the Stop hotkey.
        private async Task<string> ProvideInputAsync(string label, string[]? menu)
        {
            var trimmed = (label ?? string.Empty).Trim();
            var key = trimmed.ToLowerInvariant();
            if (key.Length > 0 && _runtimeVariables.TryGetValue(key, out var cached))
                return cached; // already answered (or pre-set by a same-named SetVariable) — reuse
            var token = _cts?.Token ?? CancellationToken.None;
            var answer = await RequestInputAsync(trimmed, menu, token);
            if (answer == null)
            {
                // User cancelled the prompt → abort the run, same clean stop as the Stop hotkey.
                try { _cts?.Cancel(); } catch (ObjectDisposedException) { }
                token.ThrowIfCancellationRequested();
                throw new OperationCanceledException();
            }
            if (key.Length > 0)
            {
                lock (_runStateLock) _runtimeVariables[key] = answer;
                PushVariablesSnapshot(force: true);
            }
            return answer;
        }

        // Pauses replay, raises the Ask-Input modal on the host, and awaits the answer. Returns the
        // entered/selected string, or null if the user cancelled (or replay was stopped mid-prompt).
        // Mirrors ExecutePause's TCS-park-on-dispatcher shape but returns a value.
        private async Task<string?> RequestInputAsync(string label, string[]? menu, CancellationToken token)
        {
            var requestId = Guid.NewGuid().ToString("N")[..8];
            var tcs = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
            _pendingInputs[requestId] = tcs;
            // Remember who had focus BEFORE the prompt surfaces the TrueReplayer window
            // (OnInputRequested brings the app forward so the modal is visible). After a real answer
            // we hand focus back, so the replay's resolved text lands where the user was pointing
            // (Notepad/Chrome) instead of typing into TrueReplayer itself.
            IntPtr prevForeground = NativeMethods.GetForegroundWindow();
            dispatcherQueue.TryEnqueue(() => OnInputRequested?.Invoke(requestId, label, menu));
            using var timeoutCts = new CancellationTokenSource(InputTimeoutMs);
            try
            {
                // Resolve as cancel (null) — the caller then aborts the run — on either a Stop mid-prompt
                // (token) or the no-response timeout (timeoutCts), so the engine is never held forever.
                using (token.Register(() => tcs.TrySetResult(null)))
                using (timeoutCts.Token.Register(() =>
                {
                    if (tcs.TrySetResult(null))
                        DiagnosticLog.Info($"Ask-Input '{label}': no response after {InputTimeoutMs / 1000}s — run aborted");
                }))
                {
                    var answer = await tcs.Task;
                    // Hand focus back before returning — on a real submit so the resolved text lands on
                    // the target, and on a modal Cancel so the user's window isn't left buried behind TR.
                    // A hard Stop cancels the token, so ActivateAsync short-circuits and skips the poll.
                    await RestoreForegroundAfterInputAsync(prevForeground, token);
                    return answer;
                }
            }
            finally
            {
                _pendingInputs.TryRemove(requestId, out _);
                dispatcherQueue.TryEnqueue(() => OnInputDismissed?.Invoke(requestId));
            }
        }

        // Hand foreground back after an Ask-Input prompt (which surfaced the TrueReplayer window):
        // prefer the profile's explicit target (customer-service flows type into Chrome/Crisp), else
        // the window that was focused when the prompt appeared (the simple no-target flow → Notepad).
        // Best-effort — a refused switch never breaks the run. ActivateAsync no-ops when the chosen
        // window is already foreground, so this is cheap when nothing needs restoring.
        private async Task RestoreForegroundAfterInputAsync(IntPtr prevForeground, CancellationToken token)
        {
            try
            {
                if (_bringToFocus && _windowTarget != null)
                {
                    var targetHwnd = FindTargetWindow();
                    if (targetHwnd != IntPtr.Zero)
                    {
                        await Helpers.WindowActivation.ActivateAsync(targetHwnd, _windowTarget, _windowTargetTitleRegex, token);
                        return;
                    }
                }
                if (prevForeground != IntPtr.Zero)
                    await Helpers.WindowActivation.ActivateAsync(prevForeground, token: token);
            }
            catch { /* focus restore is best-effort (also swallows the token's OCE on a hard Stop) */ }
        }

        // Called by the host when the Ask-Input modal is submitted or cancelled. Completes the
        // pending await: a cancel resolves to null (→ the run aborts); a submit resolves the value.
        public void CompleteInput(string requestId, string? value, bool cancelled)
        {
            if (_pendingInputs.TryRemove(requestId, out var tcs))
                tcs.TrySetResult(cancelled ? null : (value ?? string.Empty));
        }

        // Copy to Slot action: capture the CURRENT SELECTION of the focused app (synthetic
        // Ctrl+C) into the named clipboard slot, then restore the user's real clipboard.
        // Slot name lives in Key (SetVariable's Key-reuse convention); read back via
        // {clip:name}. A failed capture (no selection / slow target) leaves the slot
        // UNCHANGED — a transient focus hiccup must not wipe a good capture.
        private async Task ExecuteCopyToSlot(ActionItem action, CancellationToken token)
        {
            var name = action.Key?.Trim();

            // Clear mode: empty a slot instead of capturing. A blank name wipes ALL slots
            // (1..9) and resets the capture hotkey's cursor to slot 1 — the "start over" the
            // sequential hotkey otherwise can't do. Nothing is typed/pasted. No capture, so
            // no selection is needed and it never touches the clipboard.
            if (string.Equals(action.SlotMode, "clear", StringComparison.OrdinalIgnoreCase))
            {
                if (string.IsNullOrEmpty(name))
                {
                    lock (_runStateLock) _clipSlots.Clear();
                    _nextHotkeySlot = 1;
                }
                else if (VariableNameRegex.IsMatch(name))
                {
                    lock (_runStateLock) _clipSlots.Remove(name.ToLowerInvariant());
                }
                else
                {
                    return; // unusable slot name — no-op
                }
                PushVariablesSnapshot(force: true);
                return;
            }

            if (string.IsNullOrEmpty(name) || !VariableNameRegex.IsMatch(name))
                return; // unusable slot name — no-op, same forgiveness as SetVariable
            var key = name.ToLowerInvariant();
            var captured = await CaptureSelectionTextAsync(token);
            if (captured == null)
            {
                Services.DiagnosticLog.Info($"Copy to Slot '{name}': nothing copied (empty selection?) — slot left unchanged");
                return;
            }
            lock (_runStateLock) _clipSlots[key] = captured;
            PushVariablesSnapshot(force: true);
        }

        // 1 while a selection capture is in flight — a second capture (double-tapped hotkey,
        // or hotkey overlapping a CopyToSlot action) interleaving its snapshot/clear/restore
        // with the first would store the OLD clipboard as the "selection" and then wipe the
        // clipboard. Overlappers bail out with null instead.
        private int _captureBusy;

        // The selection-capture primitive shared by the Copy to Slot action and the global
        // capture hotkey: snapshot the real clipboard → clear it (the "did a copy happen"
        // detector) → synthetic Ctrl+C → poll for the copied text → restore the snapshot.
        // Injected keys carry LLKHF_INJECTED so the hook can't re-trigger anything. Returns
        // null when nothing arrived (empty selection, or a target that doesn't copy text).
        private async Task<string?> CaptureSelectionTextAsync(CancellationToken token)
        {
            if (System.Threading.Interlocked.CompareExchange(ref _captureBusy, 1, 0) != 0)
            {
                Services.DiagnosticLog.Info("Capture to Slot: a capture is already in flight — ignored");
                return null;
            }
            var original = await ReadClipboardSnapshotAsync(dispatcherQueue, includeHtml: true);
            // Text-bearing clipboards get the clear-then-poll change detector (and a faithful
            // restore at the end). A NON-text clipboard (files, image — the snapshot can't
            // carry those) is left untouched instead: any text APPEARING is the copy, and
            // skipping the pre-clear means a no-op copy (empty selection) can't destroy the
            // files/image the user had copied. A successful capture still replaces the
            // clipboard system-wide — that's Ctrl+C itself, not something we can restore.
            bool hadTextual = original.Text != null || original.Html != null;
            try
            {
                if (hadTextual)
                {
                    RestoreOriginalClipboard((null, null)); // (null, null) = Clipboard.Clear()
                    await Task.Delay(30, token);
                }
                // A physically held hotkey modifier (e.g. the Shift of Ctrl+Shift+9) would turn
                // the injected Ctrl+C into Ctrl+Shift+C for the target — release first, same as
                // replay start does before its first synthetic input.
                ReleasePhysicallyHeldModifiers();
                SimulateKeystroke("Ctrl+C", token);
                for (int i = 0; i < 15; i++) // up to ~750 ms — slow targets render the copy late
                {
                    await Task.Delay(50, token);
                    var text = await ReadClipboardTextAsync(dispatcherQueue);
                    if (!string.IsNullOrEmpty(text)) return text;
                }
                return null;
            }
            finally
            {
                if (hadTextual) RestoreOriginalClipboard(original);
                System.Threading.Interlocked.Exchange(ref _captureBusy, 0);
            }
        }

        // Capture the current selection into the NEXT sequential slot (1..9, wrapping) — the
        // global capture hotkey's entry, called by the host on its dispatcher. Returns the slot
        // name and the captured text (null = nothing copied; the cursor does not advance then).
        public async Task<(string Slot, string? Value)> CaptureSelectionToNextSlotAsync()
        {
            var slot = _nextHotkeySlot.ToString();
            var captured = await CaptureSelectionTextAsync(CancellationToken.None);
            if (captured != null)
            {
                lock (_runStateLock) _clipSlots[slot] = captured;
                _nextHotkeySlot = _nextHotkeySlot >= 9 ? 1 : _nextHotkeySlot + 1;
                PushVariablesSnapshot(force: true);
            }
            return (slot, captured);
        }

        // Live-variables pane feed: copy the mutable dictionaries (they change on the replay
        // thread) and raise OnVariablesChanged on the dispatcher. Forced pushes are for rare,
        // user-meaningful writes; unforced (per-iteration) pushes ride a ~4 Hz throttle so a
        // tight infinite loop doesn't flood the bridge.
        public void PushVariablesSnapshot(bool force = false)
        {
            if (OnVariablesChanged == null) return;
            var now = Environment.TickCount64;
            if (!force && now - _lastVariablesPushTick < 250) return;
            _lastVariablesPushTick = now;
            Dictionary<string, string> vars, slots;
            lock (_runStateLock)
            {
                vars = new Dictionary<string, string>(_runtimeVariables);
                slots = new Dictionary<string, string>(_clipSlots);
            }
            var row = _currentRowData != null ? new Dictionary<string, string>(_currentRowData) : null;
            dispatcherQueue.TryEnqueue(() => OnVariablesChanged?.Invoke(vars, slots, row));
        }

        // Instance entry to the unified resolver for the SendText/paste path: passes the saved
        // clipboard backup + brace-escaping so ParseSendTextSegments doesn't re-interpret substituted braces.
        private Task<string> ResolveTokens(string text, string? clipboardOverride = null, bool escapeBracesInSubstitution = false, TokenFlavorSync? flavorSync = null)
            => ResolveTokensAsync(text, dispatcherQueue, CurrentRunCtx, clipboardOverride, escapeBracesInSubstitution, htmlEncodeSubstitution: false, flavorSync);

        /// <summary>
        /// Replaces every {clipboard[:mods]} token in <paramref name="text"/> with the
        /// clipboard content transformed by the given modifiers. Reads the clipboard only once.
        /// If <paramref name="clipboardOverride"/> is non-null it is used instead of reading the OS clipboard.
        /// When <paramref name="escapeBracesInSubstitution"/> is true, '{' / '}' in substituted
        /// values are replaced with sentinels so ParseSendTextSegments does not re-interpret them
        /// as another placeholder — used for the Win32 SendText path.
        /// </summary>
        /// <summary>
        /// Reads the clipboard's TEXT content on the UI dispatcher (clipboard access requires
        /// it). Returns null when the clipboard holds no text, the read fails, or the queue is
        /// shutting down. Shared by token resolution, the SendText backup snapshot, and the
        /// If-Clipboard probe so the TCS/TryEnqueue dance lives in exactly one place.
        /// </summary>
        /// <summary>
        /// Snapshots the clipboard's text AND HTML flavors for the SendText backup/restore
        /// round-trip. The HTML string is the raw CF_HTML format payload (header included),
        /// so restoring it via SetHtmlFormat is byte-symmetric. Either flavor is null when
        /// absent or unreadable; both null = clipboard held something else entirely (image,
        /// files) — restore then clears, same as the old text-only behavior.
        /// </summary>
        internal static async Task<(string? Text, string? Html)> ReadClipboardSnapshotAsync(DispatcherQueue dispatcherQueue, bool includeHtml = true)
        {
            var tcsSnap = new TaskCompletionSource<(string?, string?)>();
            if (!dispatcherQueue.TryEnqueue(async () =>
            {
                string? text = null, htmlFormat = null;
                try
                {
                    var content = Windows.ApplicationModel.DataTransfer.Clipboard.GetContent();
                    if (content.Contains(Windows.ApplicationModel.DataTransfer.StandardDataFormats.Text))
                    {
                        try { text = await content.GetTextAsync(); } catch { }
                    }
                    // Materializing CF_HTML forces delayed-render owners (Excel) to produce it —
                    // skip unless the caller will actually overwrite the HTML flavor.
                    if (includeHtml && content.Contains(Windows.ApplicationModel.DataTransfer.StandardDataFormats.Html))
                    {
                        try { htmlFormat = await content.GetHtmlFormatAsync(); } catch { }
                    }
                }
                catch { }
                tcsSnap.TrySetResult((text, htmlFormat));
            }))
            {
                tcsSnap.TrySetResult((null, null));
            }
            return await tcsSnap.Task;
        }

        internal static async Task<string?> ReadClipboardTextAsync(DispatcherQueue dispatcherQueue)
        {
            var tcsClip = new TaskCompletionSource<string?>();
            if (!dispatcherQueue.TryEnqueue(async () =>
            {
                try
                {
                    var content = Windows.ApplicationModel.DataTransfer.Clipboard.GetContent();
                    if (content.Contains(Windows.ApplicationModel.DataTransfer.StandardDataFormats.Text))
                    {
                        var clipText = await content.GetTextAsync();
                        tcsClip.SetResult(clipText);
                    }
                    else tcsClip.SetResult(null);
                }
                catch { tcsClip.SetResult(null); }
            }))
            {
                // Queue shut down (app closing) — unblock the awaiter with "no clipboard".
                tcsClip.TrySetResult(null);
            }
            return await tcsClip.Task;
        }

        // Reads the Windows clipboard HISTORY (Win+V) as a recency-ordered list of text values —
        // element 0 = most recent. The WinRT Items order is NOT documented, so we sort by Timestamp
        // DESCENDING (a stable OrderBy) rather than trust the raw order. Each element is the item's
        // text, or null when that item carries no text (image / other format). Returns null when
        // history is disabled/denied or the call throws — the resolver treats a null list and a null
        // element alike as empty, and never throws. Marshaled to the UI thread like
        // ReadClipboardTextAsync (the WinRT clipboard APIs want the UI thread; a background-daemon
        // call may legitimately fail here, which surfaces as "history unavailable" = empty).
        internal static async Task<IReadOnlyList<string?>?> ReadClipboardHistoryTextsAsync(DispatcherQueue dispatcherQueue)
        {
            var tcs = new TaskCompletionSource<IReadOnlyList<string?>?>();
            if (!dispatcherQueue.TryEnqueue(async () =>
            {
                try
                {
                    var result = await Windows.ApplicationModel.DataTransfer.Clipboard.GetHistoryItemsAsync();
                    if (result.Status != Windows.ApplicationModel.DataTransfer.ClipboardHistoryItemsResultStatus.Success)
                    {
                        tcs.SetResult(null); // disabled / access denied — treat as empty
                        return;
                    }
                    var texts = new List<string?>(result.Items.Count);
                    foreach (var item in result.Items.OrderByDescending(i => i.Timestamp))
                    {
                        try
                        {
                            texts.Add(item.Content.Contains(Windows.ApplicationModel.DataTransfer.StandardDataFormats.Text)
                                ? await item.Content.GetTextAsync()
                                : null); // non-text item (image/other) — placeholder so indices still align
                        }
                        catch { texts.Add(null); } // one unreadable item must not sink the whole read
                    }
                    tcs.SetResult(texts);
                }
                catch { tcs.SetResult(null); }
            }))
            {
                tcs.TrySetResult(null); // queue shut down (app closing)
            }
            return await tcs.Task;
        }

        // HTML-flavor substitution guard: a resolved clipboard/var/row value containing '<' or
        // '&' must paste as visible TEXT inside the rich payload, never inject markup; newlines
        // in the value become <br> so multi-line values still render (the CRLF normalization is
        // plain-flavor-only). Dates/counters resolve to digits/punctuation and skip this.
        internal static string HtmlEncodeValue(string value)
            => System.Net.WebUtility.HtmlEncode(value).Replace("\r\n", "\n").Replace("\n", "<br>");

        internal static async Task<string> ResolveClipboardTokensAsync(string text, DispatcherQueue dispatcherQueue, string? clipboardOverride = null, bool escapeBracesInSubstitution = false, bool htmlEncodeSubstitution = false)
        {
            if (string.IsNullOrEmpty(text)) return text;
            if (!ClipboardTokenRegex.IsMatch(text)) return text;

            string? clipContent = clipboardOverride != null
                ? clipboardOverride
                : await ReadClipboardTextAsync(dispatcherQueue);

            var raw = clipContent ?? string.Empty;
            return ClipboardTokenRegex.Replace(text, m =>
            {
                var mods = m.Groups[1].Success ? m.Groups[1].Value : null;
                var resolved = ApplyClipboardModifiers(raw, mods);
                if (htmlEncodeSubstitution) resolved = HtmlEncodeValue(resolved);
                return escapeBracesInSubstitution ? EscapeBracesForParser(resolved) : resolved;
            });
        }

        // Matches {winclip:N} — a 1-based index into the WINDOWS clipboard history (Win+V),
        // most-recent first ({winclip:1} = the last thing copied). The index is OPTIONAL: a bare
        // {winclip} means index 1, matching the editor chip (which defaults to 1) so a hand-typed
        // {winclip} resolves instead of pasting literally. Deliberately DISJOINT from {clip:name}
        // (in-app capture slots) and {clipboard} (the live OS clipboard). IgnoreCase like the others.
        private static readonly Regex WinClipTokenRegex = new(
            @"\{winclip(?::(\d+))?\}",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);

        // Resolves {winclip:N} against the Windows clipboard history. Fetches the history ONCE per
        // pass (so several {winclip:N} in one field see a consistent snapshot; different actions in a
        // run each read fresh, which is MORE correct than a run-start snapshot) and indexes it
        // 1-based, most-recent-first. Consume-always forgiveness — history disabled, index out of
        // range, or a non-text item at that slot all resolve to empty; it never throws or stalls the
        // run. On the rich SendText double-resolve the plain pass RECORDS each resolved value and the
        // html pass REPLAYS it, so both flavors agree and the html pass skips the second history read.
        internal static async Task<string> ResolveWinClipTokensAsync(
            string text, DispatcherQueue dispatcherQueue,
            bool escapeBracesInSubstitution, bool htmlEncodeSubstitution, TokenFlavorSync? sync = null)
        {
            if (string.IsNullOrEmpty(text) || !WinClipTokenRegex.IsMatch(text)) return text;
            bool replaying = sync?.WinClipReplay is { Count: > 0 };
            IReadOnlyList<string?>? history = replaying
                ? null
                : await ReadClipboardHistoryTextsAsync(dispatcherQueue);
            return WinClipTokenRegex.Replace(text, m =>
            {
                string raw;
                if (sync?.WinClipReplay is { Count: > 0 } replay)
                {
                    raw = replay.Dequeue();
                }
                else
                {
                    raw = string.Empty;
                    // Bare {winclip} (no group) = index 1; {winclip:N} parses N (overflow → skip).
                    int n = 1;
                    bool haveIndex = !m.Groups[1].Success || int.TryParse(m.Groups[1].Value, out n);
                    if (history != null && haveIndex
                        && n >= 1 && n <= history.Count && history[n - 1] != null)
                        raw = history[n - 1]!;
                    sync?.WinClipRecord?.Add(raw);
                }
                var resolved = htmlEncodeSubstitution ? HtmlEncodeValue(raw) : raw;
                return escapeBracesInSubstitution ? EscapeBracesForParser(resolved) : resolved;
            });
        }

        private Task<string> ResolveBrowserTextPlaceholders(string text)
            => ResolveBrowserTextPlaceholdersAsync(text, dispatcherQueue, CurrentRunCtx);

        /// <summary>
        /// Resolves data placeholders ({clipboard[:mods]}, {datetime}, {date}, {time}) for
        /// BrowserType actions via the unified resolver. Special-key placeholders ({enter}, {tab}, …)
        /// are left untouched — they are interpreted by the Chrome extension's own parser, so the
        /// Browser path must NOT brace-escape. Static so the Test Action path can call it without an
        /// ActionReplayer instance (runCtx defaults to RunCtx.Empty there).
        /// </summary>
        internal static Task<string> ResolveBrowserTextPlaceholdersAsync(string text, DispatcherQueue dispatcherQueue, RunCtx runCtx = default)
            => ResolveTokensAsync(text, dispatcherQueue, runCtx, clipboardOverride: null, escapeBracesInSubstitution: false);

        /// <summary>
        /// The single token-resolution pipeline for user text (SendText + BrowserType). Order:
        /// {clipboard[:mods]} first, then {datetime}/{date}/{time}. Stateful tokens
        /// ({var:name}/{counter}/{row}) will resolve here from <paramref name="runCtx"/> in a later
        /// phase — today runCtx is reserved (default = RunCtx.Empty), so output is byte-identical to
        /// the previous scattered resolvers. <paramref name="escapeBracesInSubstitution"/> escapes
        /// '{' / '}' in substituted clipboard values for the Win32 SendText path so
        /// ParseSendTextSegments does not re-interpret them; the Browser path passes false. Static so
        /// the Test Action path resolves without a live ActionReplayer.
        /// </summary>
        internal static async Task<string> ResolveTokensAsync(
            string text, DispatcherQueue dispatcherQueue, RunCtx runCtx = default,
            string? clipboardOverride = null, bool escapeBracesInSubstitution = false,
            bool htmlEncodeSubstitution = false, TokenFlavorSync? flavorSync = null)
        {
            if (string.IsNullOrEmpty(text)) return text;
            text = await ResolveClipboardTokensAsync(text, dispatcherQueue, clipboardOverride, escapeBracesInSubstitution, htmlEncodeSubstitution);
            text = await ResolveWinClipTokensAsync(text, dispatcherQueue, escapeBracesInSubstitution, htmlEncodeSubstitution, flavorSync);
            text = ResolveDateTimeTokens(text, flavorSync);
            text = ResolveRandomTokens(text, flavorSync);
            // {input:Label} runs BEFORE run-state so a {var:Label} in the same text sees the answer
            // the prompt just stored. On the static Test-Action path runCtx.InputProvider is null →
            // resolves empty (consume-always), keeping that path byte-identical.
            text = await ResolveInputTokensAsync(text, runCtx, escapeBracesInSubstitution, htmlEncodeSubstitution);
            text = ResolveRunStateTokens(text, runCtx, escapeBracesInSubstitution, htmlEncodeSubstitution);
            return text;
        }

        // Matches {input:Label} and {input:Label|menu:a,b,c}. The label allows any char except '}'
        // and '|' (so it can contain spaces); the optional menu carries a comma-separated option
        // list. IgnoreCase like the other token regexes (the FE chip normalizer title-cases names).
        // menu group is [^}]* (not +) so a present-but-empty "|menu:" still matches and falls
        // through to the plain-field branch below, instead of failing the whole match and leaking
        // the literal token. A stray '|' that isn't "|menu:" (a typo) still stays literal, like any
        // other malformed token.
        private static readonly Regex InputTokenRegex = new(
            @"\{input:([^}|]+)(?:\|menu:([^}]*))?\}",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);

        // Resolves {input:Label} / {input:Label|menu:a,b,c} by asking the user at replay time and
        // substituting the answer. Awaits a UI round-trip, so it can't live in the sync run-state
        // step. On the static Test-Action path (RunCtx.Empty) InputProvider is null → each token
        // resolves to empty. The provider caches by Label (ask-once-per-run), so multiple
        // occurrences and the rich SendText double-resolve prompt only once. The substituted value
        // gets the same html-encode / brace-escape treatment as {var} for its target context.
        private static async Task<string> ResolveInputTokensAsync(
            string text, RunCtx runCtx, bool escapeBracesInSubstitution, bool htmlEncodeSubstitution)
        {
            if (string.IsNullOrEmpty(text) || !InputTokenRegex.IsMatch(text)) return text;
            var sb = new System.Text.StringBuilder();
            int last = 0;
            foreach (Match m in InputTokenRegex.Matches(text))
            {
                sb.Append(text, last, m.Index - last);
                last = m.Index + m.Length;
                string value = string.Empty;
                if (runCtx.InputProvider != null)
                {
                    var label = m.Groups[1].Value.Trim();
                    string[]? menu = null;
                    if (m.Groups[2].Success)
                    {
                        menu = m.Groups[2].Value.Split(',')
                            .Select(o => o.Trim()).Where(o => o.Length > 0).ToArray();
                        if (menu.Length == 0) menu = null; // "|menu:" with no real options → plain field
                    }
                    value = await runCtx.InputProvider(label, menu);
                }
                if (htmlEncodeSubstitution) value = HtmlEncodeValue(value);
                if (escapeBracesInSubstitution) value = EscapeBracesForParser(value);
                sb.Append(value);
            }
            sb.Append(text, last, text.Length - last);
            return sb.ToString();
        }

        // Matches {random:a-b} — two non-negative integers separated by a hyphen.
        // IgnoreCase because the frontend chip normalizer title-cases token names
        // ({Random:1-10}), same rationale as the clipboard/var regexes.
        private static readonly Regex RandomTokenRegex = new(
            @"\{random:(\d+)-(\d+)\}",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);

        // Stateless {random:a-b} → uniform integer in [a, b] (inclusive; bounds swap when
        // reversed). Each occurrence rolls independently — "{random:1-6} {random:1-6}" is
        // two dice. Unparseable/overflowing numbers resolve to empty, the same consume-
        // always forgiveness as an empty clipboard. Output is digits-only, so no brace
        // escaping is needed on the SendText path (same note as {counter}/{row}).
        /// <summary>
        /// Cross-flavor value sync for one SendText paste: the plain (CF_UNICODETEXT) and rich
        /// (CF_HTML) flavors of the SAME DataPackage must carry IDENTICAL values for
        /// non-deterministic tokens, or the pasted content would depend on the target's paste
        /// mode. The plain pass RECORDS each {random} draw and one DateTime.Now snapshot; the
        /// html pass REPLAYS them in occurrence order (the two strings are parallel
        /// serializations of one document, so occurrences align).
        /// </summary>
        internal sealed class TokenFlavorSync
        {
            public DateTime Now = DateTime.Now;
            public List<string>? RandomRecord;   // set on the recording (plain) pass
            public Queue<string>? RandomReplay;  // set on the replay (html) pass
            public List<string>? WinClipRecord;  // {winclip:N} resolved values — recording (plain) pass
            public Queue<string>? WinClipReplay; // replayed on the html pass so both flavors agree
        }

        private static string ResolveRandomTokens(string text, TokenFlavorSync? sync = null)
        {
            if (text.IndexOf("{random:", StringComparison.OrdinalIgnoreCase) < 0) return text;
            return RandomTokenRegex.Replace(text, m =>
            {
                // Replay pass: consume the plain pass's draw for this occurrence. Falls
                // through to a fresh roll only if the occurrence counts diverge (defensive).
                if (sync?.RandomReplay is { Count: > 0 } replay) return replay.Dequeue();
                if (!long.TryParse(m.Groups[1].Value, out var a) ||
                    !long.TryParse(m.Groups[2].Value, out var b))
                    return string.Empty; // digits beyond long range — treat as invalid
                if (a > b) (a, b) = (b, a);
                if (b == long.MaxValue) b--; // keep the inclusive upper bound addable
                var value = Random.Shared.NextInt64(a, b + 1).ToString();
                sync?.RandomRecord?.Add(value);
                return value;
            });
        }

        // Matches {var:name} — letters/digits/underscore, case-insensitive (mirrors
        // VariableNameRegex; lookup lowercases the captured name).
        private static readonly Regex VarTokenRegex = new(
            @"\{var:([A-Za-z0-9_]+)\}",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);

        // Data-loop column token {row:column} / {row:column:mods}. Disjoint from the bare
        // {row} replace below — "{row}" is not a substring of "{row:column}" (the ':' breaks
        // the literal match), and this regex requires the ':name' tail so it never matches
        // bare {row}. Group 2 is the optional clipboard-style modifier chain (same grammar
        // as {clipboard:mods} — the FIRST segment is always the column, the rest modifiers).
        private static readonly Regex RowDataTokenRegex = new(
            @"\{row:([A-Za-z0-9_]+)(?::([^}]+))?\}",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);

        // Clipboard-slot token {clip:name}. Disjoint from {clipboard...}: this regex requires
        // ':' immediately after "clip", which "{clipboard}" / "{clipboard:mods}" never has
        // (their 5th char is 'b'). Lookup lowercases the captured name, same as {var}.
        private static readonly Regex ClipSlotTokenRegex = new(
            @"\{clip:([A-Za-z0-9_]+)\}",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);

        /// <summary>
        /// Resolves the run-state tokens {var:name} / {counter} / {row} from
        /// <paramref name="runCtx"/>. With RunCtx.Empty (the Test Action path) every {var}
        /// resolves to empty and counter/row read as not-started → empty, mirroring how an
        /// empty clipboard resolves — the token is always consumed, never left as literal
        /// text. Variable VALUES get the same brace-escaping treatment as clipboard content
        /// so a value like "{enter}" pastes as text on the SendText path instead of being
        /// re-parsed as a key press.
        /// </summary>
        private static string ResolveRunStateTokens(string text, RunCtx runCtx, bool escapeBracesInSubstitution, bool htmlEncodeSubstitution = false)
        {
            if (text.IndexOf('{') < 0) return text;

            if (VarTokenRegex.IsMatch(text))
            {
                text = VarTokenRegex.Replace(text, m =>
                {
                    var name = m.Groups[1].Value.ToLowerInvariant();
                    string value = string.Empty;
                    runCtx.Variables?.TryGetValue(name, out value!);
                    value ??= string.Empty;
                    if (htmlEncodeSubstitution) value = HtmlEncodeValue(value);
                    return escapeBracesInSubstitution ? EscapeBracesForParser(value) : value;
                });
            }

            // Data-loop {row:column} — resolves to the current loop row's cell. Runs BEFORE
            // the bare {row} replace below (defensive isolation). Missing column / no data
            // loop → empty (consume-always), and the cell is brace-escaped like {var} since
            // data cells can contain arbitrary text. An optional modifier chain
            // ({row:name:trim:upper}) reuses the clipboard pipeline VERBATIM — modifiers run
            // on the raw cell, before the html-encode/brace-escape for the target context.
            if (RowDataTokenRegex.IsMatch(text))
            {
                text = RowDataTokenRegex.Replace(text, m =>
                {
                    var col = m.Groups[1].Value.ToLowerInvariant();
                    string value = string.Empty;
                    runCtx.RowData?.TryGetValue(col, out value!);
                    value ??= string.Empty;
                    if (m.Groups[2].Success)
                        value = ApplyClipboardModifiers(value, m.Groups[2].Value);
                    if (htmlEncodeSubstitution) value = HtmlEncodeValue(value);
                    return escapeBracesInSubstitution ? EscapeBracesForParser(value) : value;
                });
            }

            // Clipboard slots {clip:name} — captured selections (Copy to Slot / capture
            // hotkey). Missing slot → empty (consume-always); slot text is brace-escaped
            // like {var} since captured selections can contain arbitrary text.
            if (ClipSlotTokenRegex.IsMatch(text))
            {
                text = ClipSlotTokenRegex.Replace(text, m =>
                {
                    var name = m.Groups[1].Value.ToLowerInvariant();
                    string value = string.Empty;
                    runCtx.ClipSlots?.TryGetValue(name, out value!);
                    value ??= string.Empty;
                    if (htmlEncodeSubstitution) value = HtmlEncodeValue(value);
                    return escapeBracesInSubstitution ? EscapeBracesForParser(value) : value;
                });
            }

            // Numeric run-state tokens — no braces in the substituted value, so no escaping.
            // <= 0 means "no live run" (Test Action) → empty, consistent with {var} above.
            if (text.Contains("{counter}", StringComparison.OrdinalIgnoreCase))
                text = text.Replace("{counter}", runCtx.Iteration > 0 ? runCtx.Iteration.ToString() : string.Empty, StringComparison.OrdinalIgnoreCase);
            if (text.Contains("{row}", StringComparison.OrdinalIgnoreCase))
                text = text.Replace("{row}", runCtx.Row > 0 ? runCtx.Row.ToString() : string.Empty, StringComparison.OrdinalIgnoreCase);

            return text;
        }

        // Resolves {datetime}/{date}/{time} ({datetime} first to avoid partial matches). The
        // substituted values contain no braces, so no brace-escaping is needed here.
        private static string ResolveDateTimeTokens(string text, TokenFlavorSync? sync = null)
        {
            if (string.IsNullOrEmpty(text)) return text;
            var now = sync?.Now ?? DateTime.Now;
            if (text.Contains("{datetime}", StringComparison.OrdinalIgnoreCase))
                text = text.Replace("{datetime}", now.ToString("dd/MM/yyyy - HH:mm:ss"), StringComparison.OrdinalIgnoreCase);
            if (text.Contains("{date}", StringComparison.OrdinalIgnoreCase))
                text = text.Replace("{date}", now.ToString("dd/MM/yyyy"), StringComparison.OrdinalIgnoreCase);
            if (text.Contains("{time}", StringComparison.OrdinalIgnoreCase))
                text = text.Replace("{time}", now.ToString("HH:mm:ss"), StringComparison.OrdinalIgnoreCase);
            return text;
        }

        // The editor exports every token chip as <span data-token="{token}">{token}</span> so a
        // saved KeyHtml round-trips back into chips. At SEND time those markers must go: the
        // wrapper span carries no paste value, key/delay placeholders ({enter}/{tab}/{delay:N})
        // act at the SEGMENT level (pressed around the paste) and must not surface as literal
        // text in the rich flavor, and the DOM serializer entity-escapes freeform modifier args
        // ({clipboard:join:&} → &amp;, likewise {row:col:join:&}) which would desync the two
        // flavors' mods. Replacing each marker with its HtmlDecode'd raw token hands the
        // resolvers the exact same token string the plain pass sees; the substituted VALUE is
        // then HTML-encoded by the html pass. KNOWN LIMIT: a HAND-TYPED token whose separator
        // falls outside the chip grammar (join:&) never becomes a marker span, so its escaped
        // form reaches the html-pass resolvers and the flavors desync — pre-existing for
        // {clipboard}, inherited by {row:col:mods}; popover-built chips are immune.
        private static readonly Regex TokenMarkerSpanRegex = new(
            "<span[^>]*\\bdata-token=\"([^\"]*)\"[^>]*>.*?</span>",
            RegexOptions.Singleline | RegexOptions.IgnoreCase | RegexOptions.Compiled);

        private static string PrepareRichHtmlForSend(string html)
        {
            return TokenMarkerSpanRegex.Replace(html, m =>
            {
                var tokenText = System.Net.WebUtility.HtmlDecode(m.Groups[1].Value);
                var inner = tokenText.Trim('{', '}');
                var name = inner.Split(':')[0];
                // SpecialKeyPlaceholders is keyed WITH the braces ("{enter}"), so the lookup
                // has to re-wrap the bare name exactly like ParseSendTextSegments does. Passing
                // the bare "enter" never matched, so no key placeholder was ever stripped from
                // the rich flavor and every {enter}/{tab}/… pasted as literal text next to the
                // key press it was supposed to BE.
                if (string.Equals(name, "delay", StringComparison.OrdinalIgnoreCase)
                    || SpecialKeyPlaceholders.ContainsKey("{" + name + "}"))
                    return string.Empty;
                return tokenText;
            });
        }

        private async Task SimulateClipboardPaste(string text, string? html, CancellationToken token)
        {
            if (string.IsNullOrEmpty(text)) return;

            // Save the original clipboard so we can restore it after pasting. The HTML flavor
            // is snapshotted only when this paste will WRITE an HTML flavor (materializing
            // CF_HTML can stall on delayed-render owners like Excel — don't pay that cost for
            // plain pastes, which never clobber the HTML flavor's source text anyway... they do
            // replace the package, so when we're about to paste rich we save/restore both).
            var originalClipboard = await ReadClipboardSnapshotAsync(dispatcherQueue, includeHtml: !string.IsNullOrEmpty(html));

            // Resolve {clipboard[:mods]} + {datetime}/{date}/{time} in one pass via the unified
            // resolver, using the saved clipboard content so subsequent clipboard writes (for
            // pasting) don't affect token resolution. Escape '{' / '}' in the substituted clipboard
            // value so content like "{enter}" is pasted as text, not re-interpreted as a key press.
            // The flavor sync RECORDS this pass's {random} draws + DateTime.Now snapshot so the
            // html pass below replays the exact same values (one paste = one set of values).
            var flavorSync = new TokenFlavorSync { RandomRecord = new List<string>(), WinClipRecord = new List<string>() };
            text = await ResolveTokens(text, originalClipboard.Text ?? string.Empty, escapeBracesInSubstitution: true, flavorSync);

            if (string.IsNullOrEmpty(text) || token.IsCancellationRequested)
            {
                RestoreOriginalClipboard(originalClipboard);
                return;
            }

            // Parse text into segments: plain text + special key placeholders
            var segments = ParseSendTextSegments(text);

            // Rich flavor (KeyHtml): resolve the SAME token chain over the HTML with the
            // substituted values HTML-encoded (a clipboard/var/row value containing '<' must
            // paste as text, never inject markup) AND brace-sentinel-escaped (a clipboard/var
            // value containing a literal "{date}" must not be re-expanded by the downstream
            // resolvers — same guard the plain pass has), un-escaped again before the CF_HTML
            // is built. V1 rule: the HTML is attached only when the plain resolution produced
            // EXACTLY ONE text segment ({enter}/{tab}/{delay} before/after still work as their
            // own segments — their marker spans are stripped from the html by the pre-process);
            // a key press in the MIDDLE of the text downgrades the whole action to plain —
            // splitting markup at placeholder boundaries is Phase 2.
            string? resolvedHtml = null;
            if (!string.IsNullOrEmpty(html) && segments.Count(s => !string.IsNullOrEmpty(s.Text)) == 1)
            {
                var replaySync = new TokenFlavorSync
                {
                    Now = flavorSync.Now,
                    RandomReplay = new Queue<string>(flavorSync.RandomRecord!),
                    WinClipReplay = new Queue<string>(flavorSync.WinClipRecord!),
                };
                resolvedHtml = await ResolveTokensAsync(PrepareRichHtmlForSend(html), dispatcherQueue, CurrentRunCtx,
                    originalClipboard.Text ?? string.Empty, escapeBracesInSubstitution: true,
                    htmlEncodeSubstitution: true, flavorSync: replaySync);
                resolvedHtml = UnescapeBraceSentinels(resolvedHtml);
            }

            try
            {
                foreach (var segment in segments)
                {
                    if (token.IsCancellationRequested) break;

                    if (segment.DelayMs.HasValue)
                    {
                        // Explicit delay: pause during replay
                        await Task.Delay(segment.DelayMs.Value, token);
                    }
                    else if (segment.VkCode.HasValue)
                    {
                        // Special key: simulate key down + up
                        SimulateKeyPress(segment.VkCode.Value);
                        await Task.Delay(30, token);
                    }
                    else if (!string.IsNullOrEmpty(segment.Text))
                    {
                        // Text: paste via clipboard. Restore '{' / '}' that the resolver escaped.
                        var literal = UnescapeBraceSentinels(segment.Text);
                        await PasteTextViaClipboard(literal, resolvedHtml, token);
                    }
                }
            }
            finally
            {
                // Always restore the user's original clipboard, even if cancelled mid-paste.
                RestoreOriginalClipboard(originalClipboard);
            }
        }

        private void RestoreOriginalClipboard((string? Text, string? Html) originalClipboard)
        {
            dispatcherQueue.TryEnqueue(() =>
            {
                try
                {
                    if (originalClipboard.Text != null || originalClipboard.Html != null)
                    {
                        var dataPackage = new Windows.ApplicationModel.DataTransfer.DataPackage();
                        if (originalClipboard.Text != null) dataPackage.SetText(originalClipboard.Text);
                        // The snapshot holds the raw CF_HTML payload (header included) exactly as
                        // GetHtmlFormatAsync returned it — restore it verbatim, no re-wrapping.
                        if (originalClipboard.Html != null) dataPackage.SetHtmlFormat(originalClipboard.Html);
                        Windows.ApplicationModel.DataTransfer.Clipboard.SetContent(dataPackage);
                    }
                    else
                    {
                        Windows.ApplicationModel.DataTransfer.Clipboard.Clear();
                    }
                }
                catch (Exception ex)
                {
                    // Clipboard.SetContent/Clear can throw transiently (another app holding the
                    // clipboard, COM 0x800401D0 CLIPBRD_E_CANT_OPEN). Non-fatal — the replay is
                    // already over — but log so a user who notices their clipboard wasn't restored
                    // has a breadcrumb instead of silence.
                    DiagnosticLog.Error("Failed to restore original clipboard", ex);
                }
            });
        }

        private async Task ExecuteWaitImage(ActionItem action, CancellationToken token)
        {
            if (string.IsNullOrEmpty(action.ImagePath)) return;

            // Resolve from the executing profile, not the UI's active one — see
            // CurrentExecutingProfileName. Using _getProfileName here made WaitImage a silent
            // no-op when run via RunProfile (image lives in the sub-profile's folder).
            string profileName = CurrentExecutingProfileName;
            var referenceImage = ImageStorageService.LoadReferenceImage(profileName, action.ImagePath);
            if (referenceImage == null)
            {
                // Reference PNG missing/unreadable (e.g. deleted by orphan cleanup, or a wrong
                // profile-name context). Don't silently skip the wait — that lets the macro fall
                // through as if the screen were ready and silently desync. Log it and honour the
                // OnTimeout policy (StopReplay by default), the same as a real match timeout.
                DiagnosticLog.Info($"[WaitImage] Reference image not found (profile '{profileName}', {action.ImagePath}) — applying OnTimeout policy.");
                HandleWaitImageTimeout(action);
                return;
            }

            // Compose the optional ROI from the four nullable ints stored on the action.
            // When the profile uses relative coordinates, the stored X/Y are window-relative
            // and must be translated to absolute via the current target-window origin —
            // mirrors the SimulateMouse translation path. Skipping translation here was the
            // original bug: a WaitImage region anchored visually to a window would stop
            // matching the moment the user moved the window.
            System.Drawing.Rectangle? searchRegion = null;
            if (action.WaitImageSearchW is int sw && action.WaitImageSearchH is int sh && sw > 0 && sh > 0)
            {
                int sx = action.WaitImageSearchX ?? 0;
                int sy = action.WaitImageSearchY ?? 0;
                if (!TryResolveRelativeOffset(out int dx, out int dy))
                {
                    ReportMissingTargetWindow();
                    return;
                }
                sx += dx;
                sy += dy;
                searchRegion = new System.Drawing.Rectangle(sx, sy, sw, sh);
            }

            try
            {
                int timeoutMs = action.Timeout > 0 ? action.Timeout : 30000;
                // Clamp below 1.0: a normalized template correlation (CCoeffNormed) essentially never
                // reaches an exact 1.0 on a live screen (anti-aliasing, sub-pixel text, animation,
                // capture noise), so a user-set 100% confidence makes the match unreachable and the
                // WaitImage just times out forever (→ StopReplay). Cap at 0.99 so "max confidence"
                // stays strict but achievable.
                double confidence = action.Confidence > 0 ? Math.Min(action.Confidence, 0.99) : 0.8;

                var matchResult = await ImageMatchingService.WaitForImageAsync(
                    referenceImage,
                    confidence,
                    timeoutMs,
                    token,
                    waitForDisappear: action.WaitImageInvert,
                    searchRegion: searchRegion);

                if (matchResult == null)
                {
                    if (token.IsCancellationRequested) return;
                    HandleWaitImageTimeout(action);
                    return;
                }

                // Click center of the matched region when the user opted in. The match coords are
                // absolute virtual-screen positions (from the screenshot pipeline) regardless of
                // whether the profile uses relative coordinates. Pass coordsAreProfileSpace: false
                // so SimulateMouse skips the relative→absolute translation it would normally apply —
                // without this gate, a profile with rel-coords on would add the window origin twice
                // and click in the wrong place.
                if (action.WaitImageClickOnMatch && !action.WaitImageInvert)
                {
                    int cx = matchResult.X + matchResult.W / 2;
                    int cy = matchResult.Y + matchResult.H / 2;
                    SimulateMouse(cx, cy, NativeMethods.MOUSEEVENTF_LEFTDOWN, coordsAreProfileSpace: false);
                    SimulateMouse(cx, cy, NativeMethods.MOUSEEVENTF_LEFTUP, coordsAreProfileSpace: false);
                }
            }
            finally
            {
                referenceImage.Dispose();
            }
        }

        // Two branches: explicit "Continue" silently moves on to the next action; everything
        // else (null default / "StopReplay" / anything legacy) cancels the shared CTS so the
        // replay halts cleanly mid-iteration, equivalent to pressing the Stop button. A debug
        // screenshot is dumped to %APPDATA%\TrueReplayer\Debug\ regardless, so the user can
        // diagnose why the match failed.
        private void HandleWaitImageTimeout(ActionItem action)
        {
            SaveTimeoutScreenshot(action);

            if (action.WaitImageOnTimeout == "Continue")
            {
                return;
            }
            if (SkipRowOnErrorActive)
            {
                FaultRow($"Wait Image timed out ({action.DisplayKey})");
                return;
            }
            // ObjectDisposedException possible if a new StartAsync swapped _cts out
            // from under us; swallow because this run was already over anyway.
            try { _cts?.Cancel(); } catch (ObjectDisposedException) { }
        }

        /// <summary>
        /// Poll a single screen pixel until it matches (or stops matching, with Invert) a
        /// target colour within a per-channel tolerance, or the timeout elapses. Mirrors the
        /// shape of <see cref="ExecuteWaitImage"/> so they share the same OnTimeout vocabulary
        /// and cancellation semantics, but the implementation is intentionally tiny —
        /// <c>GetPixelAt</c> is ~0.1 ms so the loop spends ~all its time in Task.Delay,
        /// keeping CPU near zero and cancellation responsive.
        /// </summary>
        private async Task ExecuteWaitPixelColor(ActionItem action, CancellationToken token)
        {
            // Missing coords or unparseable colour → immediate timeout. Better to surface the
            // configuration error via OnTimeout (Stop/Continue/Halt) than to silently no-op
            // and have the user wonder why the action did nothing.
            if (action.PixelX is not int relPx || action.PixelY is not int relPy)
            {
                HandleWaitPixelColorTimeout(action);
                return;
            }
            var target = PixelColorService.ParseHex(action.PixelColor);
            if (target == null)
            {
                HandleWaitPixelColorTimeout(action);
                return;
            }

            // Translate profile-space coords to absolute virtual-desktop pixels via the
            // current target-window origin. With rel-coords on but no target running this
            // is a hard error: GetPixelAt at the wrong location would silently sample the
            // desktop and never match. ReportMissingTargetWindow surfaces it + cancels.
            if (!TryResolveRelativeOffset(out int dx, out int dy))
            {
                ReportMissingTargetWindow();
                return;
            }
            int px = relPx + dx;
            int py = relPy + dy;

            int timeoutMs = action.Timeout > 0 ? action.Timeout : 5000;
            int tolerance = action.PixelTolerance;
            bool invert = action.PixelInvert;

            // 50 ms poll = ~20 Hz. Fast enough that humans never perceive lag, slow enough
            // that even an infinite loop costs <1 % CPU on a recent machine. Stopwatch
            // beats DateTime here because we're inside a hot loop with cancellation.
            var sw = System.Diagnostics.Stopwatch.StartNew();
            System.Drawing.Color? lastSampled = null;

            while (!token.IsCancellationRequested && sw.ElapsedMilliseconds < timeoutMs)
            {
                var sampled = PixelColorService.GetPixelAt(px, py);
                lastSampled = sampled;

                if (sampled is System.Drawing.Color s)
                {
                    bool match = PixelColorService.MatchesWithinTolerance(s, target.Value, tolerance);
                    // Invert flips the success condition: "wait for X to disappear" succeeds
                    // when the current colour DOESN'T match. Out-of-bounds reads (sampled
                    // null) treat as no-match this iteration — they never satisfy either
                    // branch, so the action falls through to its timeout.
                    if (invert ? !match : match)
                    {
                        // Click the watched pixel when the user opted in. Suppressed in invert
                        // mode because "the colour we expected isn't here anymore" doesn't make
                        // a clear target for a follow-up click — same gate WaitImage uses.
                        // SimulateMouse handles virtual-desktop normalisation + Raw Input.
                        if (action.PixelClickOnMatch && !invert)
                        {
                            // px/py are already absolute after the TryResolveRelativeOffset
                            // translation at the top of this method; pass coordsAreProfileSpace:
                            // false so SimulateMouse doesn't translate a second time.
                            SimulateMouse(px, py, NativeMethods.MOUSEEVENTF_LEFTDOWN, coordsAreProfileSpace: false);
                            SimulateMouse(px, py, NativeMethods.MOUSEEVENTF_LEFTUP, coordsAreProfileSpace: false);
                        }
                        return;
                    }
                }

                try { await Task.Delay(50, token); }
                catch (TaskCanceledException) { return; }
            }

            if (token.IsCancellationRequested) return;

            // Surface the last sampled colour into the diagnostic log so the user can
            // compare "wanted #FF5733 ± 10 / got #2B2B2B" without instrumenting anything.
            // Cheap and non-blocking; falls off the end of the buffer like any other log.
            // Log both stored coords (profile space) and effective abs coords so users on
            // rel-coords profiles can tell whether the translation landed where they wanted.
            System.Diagnostics.Debug.WriteLine(
                $"[WaitPixelColor] Timeout @ rel ({relPx},{relPy}) → abs ({px},{py}). " +
                $"Target={action.PixelColor} tol={tolerance} invert={invert} " +
                $"lastSampled={(lastSampled is System.Drawing.Color ls ? PixelColorService.ToHex(ls) : "null")}");
            HandleWaitPixelColorTimeout(action);
        }

        // Same Continue/StopReplay shape as HandleWaitImageTimeout, just driven by the
        // separate PixelOnTimeout field so each action type can carry its own policy.
        // No diagnostic screenshot here — the cheaper, more relevant artefact (last sampled
        // colour) already went into the Debug log above.
        private void HandleWaitPixelColorTimeout(ActionItem action)
        {
            if (action.PixelOnTimeout == "Continue") return;
            if (SkipRowOnErrorActive)
            {
                FaultRow($"Wait Pixel timed out ({action.PixelColor ?? "?"})");
                return;
            }
            // Same swallow as HandleWaitImageTimeout — race with a fresh StartAsync.
            try { _cts?.Cancel(); } catch (ObjectDisposedException) { }
        }

        // ── Conditional logic: instant probe ─────────────────────────────────
        // Evaluates an IF condition, optionally POLLING for up to action.ConditionTimeout ms for the
        // (negate-applied) outcome to become true before deciding. ConditionTimeout 0 = the classic
        // instant single check (unchanged). > 0 turns the IF into "wait up to N ms for the condition,
        // then branch": returns TRUE the instant the probe is satisfied, otherwise FALSE once the window
        // elapses (→ Else / false branch). Like a Wait Image/Pixel poll, but it BRANCHES on the result
        // instead of stopping the run. Poll cadence matches the probe's cost (pixel ~0.1 ms → 50 ms; an
        // image match captures + correlates the screen → a gentler 200 ms).
        private async Task<bool> EvaluateConditionWithTimeout(ActionItem action, CancellationToken token)
        {
            int timeoutMs = action.ConditionTimeout;
            if (timeoutMs <= 0)
                return await InstantProbeAsync(action, token); // instant single check — unchanged legacy behaviour

            int pollMs = string.Equals(action.ConditionType, "PixelColorMatch", StringComparison.OrdinalIgnoreCase) ? 50 : 200;
            var sw = System.Diagnostics.Stopwatch.StartNew();
            while (true)
            {
                token.ThrowIfCancellationRequested();
                if (await InstantProbeAsync(action, token)) return true; // condition satisfied within the window
                // Skip mode: a probe that faulted the row (e.g. missing rel-coords target
                // window) must unwind NOW, not keep re-polling a dead probe for the full window.
                if (_rowFaulted) return false;
                if (sw.ElapsedMilliseconds >= timeoutMs) return false;   // window elapsed → take the Else/false branch
                await Task.Delay(pollMs, token);
            }
        }

        // Async-probing conditions fetch their data here before evaluating — the clipboard
        // read must run on the UI dispatcher and the browser probe awaits the extension
        // pipe; neither can block the sync InstantProbe (the replay thread awaiting a
        // dispatcher/pipe hop synchronously would risk a deadlock). Everything else falls
        // straight through to the sync InstantProbe unchanged. Keeps the same Negate /
        // IfOnProbeError / cancellation contract as InstantProbe.
        private async Task<bool> InstantProbeAsync(ActionItem action, CancellationToken token)
        {
            bool isClipboard = string.Equals(action.ConditionType, "ClipboardMatch", StringComparison.OrdinalIgnoreCase);
            bool isBrowserElement = string.Equals(action.ConditionType, "BrowserElementState", StringComparison.OrdinalIgnoreCase);
            bool isVariable = string.Equals(action.ConditionType, "Variable", StringComparison.OrdinalIgnoreCase);
            bool isFileExists = string.Equals(action.ConditionType, "FileExists", StringComparison.OrdinalIgnoreCase);
            if (!isClipboard && !isBrowserElement && !isVariable && !isFileExists)
                return InstantProbe(action, token);

            token.ThrowIfCancellationRequested();
            try
            {
                bool rawResult;
                if (isClipboard)
                {
                    var clip = await ReadClipboardTextAsync(dispatcherQueue) ?? string.Empty;
                    rawResult = EvaluateClipboardPattern(clip, action);
                }
                else if (isVariable)
                {
                    rawResult = await ProbeVariableAsync(action);
                }
                else if (isFileExists)
                {
                    rawResult = await ProbeFileExistsAsync(action);
                }
                else
                {
                    rawResult = await ProbeBrowserElementStateAsync(action, token);
                }
                return action.ConditionNegate ? !rawResult : rawResult;
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                throw; // genuine user stop always propagates — same rule as InstantProbe
            }
            catch (Exception ex)
            {
                // A spurious OCE (e.g. token.None from a pipe-disconnect TCS cancel) does NOT match
                // the guarded catch above and lands here — treated as a probe error → TreatAsFalse
                // (or Halt if the row opts in), so a dropped bridge branches instead of halting.
                DiagnosticLog.Info($"[InstantProbe] Probe error ({action.ConditionType}): {ex.Message}");
                if (string.Equals(action.IfOnProbeError, "Halt", StringComparison.OrdinalIgnoreCase))
                    throw;
                return action.ConditionNegate; // TreatAsFalse + negate — mirrors InstantProbe's catch
            }
        }

        // If-Browser-Element raw probe: one instant state check (appears/disappears/enabled/
        // text-match) against the live page, reusing the extension's waitElement evaluator
        // with timeout=0 so it never enters the wait loop. Reuses BrowserWaitElement's probe
        // fields — Key (selector), WaitMode, BrowserText (text pattern) — the same way
        // If-Image reuses WaitImage's. A missing/disconnected extension reads as "not found"
        // (raw false) rather than an error, so an If never halts a replay just because the
        // browser bridge is down; ConditionNegate still applies via the caller.
        private async Task<bool> ProbeBrowserElementStateAsync(ActionItem action, CancellationToken token)
        {
            if (string.IsNullOrEmpty(action.Key)) return false; // unconfigured probe
            if (_browserBridge == null || !_browserBridge.IsConnected) return false;
            return await _browserBridge.ProbeElementStateAsync(action, token);
        }

        // If-Clipboard raw match: case-insensitive contains (default) / equals / regex, matching
        // the case-insensitive convention of window-title matching. Empty pattern = unconfigured
        // probe = no match (same shape as an If-Image with no reference image). An invalid regex
        // throws ArgumentException, which the caller's catch routes through IfOnProbeError.
        private static bool EvaluateClipboardPattern(string clip, ActionItem action)
        {
            var pattern = action.ClipboardPattern ?? string.Empty;
            if (pattern.Length == 0) return false;
            var mode = action.ClipboardPatternType?.ToLowerInvariant();
            return mode switch
            {
                "equals" => string.Equals(clip, pattern, StringComparison.OrdinalIgnoreCase),
                "regex" => Regex.IsMatch(clip, pattern, RegexOptions.IgnoreCase, TimeSpan.FromMilliseconds(50)),
                _ => clip.IndexOf(pattern, StringComparison.OrdinalIgnoreCase) >= 0, // contains (default)
            };
        }

        // If-Window raw probe: builds a WindowTarget from the IF's fields and reuses
        // WindowMatcher — identical semantics to the profile Window Target (empty field =
        // wildcard; no criteria at all = no match). ForegroundOnly checks only the window
        // currently in front instead of enumerating all top-level windows.
        private static bool ProbeWindowOpen(ActionItem action)
        {
            var (target, regex) = BuildWindowTargetFromAction(action);
            if (action.WindowMatchForegroundOnly)
                return TrueReplayer.Helpers.WindowMatcher.Matches(NativeMethods.GetForegroundWindow(), target, regex);
            return TrueReplayer.Helpers.WindowMatcher.FindWindow(target, regex) != IntPtr.Zero;
        }

        // Shared matcher builder for the per-action window fields (If-Window probe,
        // ActivateWindow, and the bridge's window:testProbe). Forgiving process input:
        // window targets store "chrome.exe" but users type "chrome" — every Windows
        // process image has an extension, so append the missing ".exe" rather than
        // silently never matching.
        internal static (Models.WindowTarget Target, Regex? TitleRegex) BuildWindowTarget(
            string? processName, string? windowTitle, string? titleMatchMode)
        {
            var proc = processName?.Trim();
            if (!string.IsNullOrEmpty(proc) && !proc.Contains('.'))
                proc += ".exe";
            var target = new Models.WindowTarget
            {
                ProcessName = string.IsNullOrWhiteSpace(proc) ? null : proc,
                WindowTitle = string.IsNullOrWhiteSpace(windowTitle) ? null : windowTitle,
                TitleMatchMode = string.Equals(titleMatchMode, "regex", StringComparison.OrdinalIgnoreCase)
                    ? "regex" : "contains",
            };
            return (target, TrueReplayer.Helpers.WindowMatcher.CompileTitleRegex(target));
        }

        private static (Models.WindowTarget Target, Regex? TitleRegex) BuildWindowTargetFromAction(ActionItem action)
            => BuildWindowTarget(action.WindowProcessName, action.WindowTitle, action.WindowTitleMatchMode);

        // If-Random raw probe: TRUE with probability RandomPercent/100. Stateless, rolls
        // fresh each check (Random.Shared, same source as delay jitter and {random:a-b}).
        // 0 → never, 100 → always. Clamped so a hand-edited out-of-range value is sane.
        private static bool ProbeRandom(ActionItem action)
        {
            int pct = Math.Clamp(action.RandomPercent, 0, 100);
            return Random.Shared.Next(100) < pct;
        }

        // If-Process raw probe: TRUE when a process with the given image name is running,
        // window or not (broader than If-Window). Reuses the process-name field of If-Window
        // and the GetProcessesByName pattern (same as AppIconService). ".exe" stripped since
        // GetProcessesByName wants the bare name.
        private static bool ProbeProcessRunning(ActionItem action)
        {
            var name = action.WindowProcessName?.Trim();
            if (string.IsNullOrEmpty(name)) return false;
            if (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                name = name[..^4];
            System.Diagnostics.Process[] procs;
            try { procs = System.Diagnostics.Process.GetProcessesByName(name); }
            catch { return false; }
            try { return procs.Length > 0; }
            finally { foreach (var p in procs) p.Dispose(); }
        }

        // If-Time raw probe: TRUE when local time is inside [TimeStart, TimeEnd] AND today is
        // selected in DaysOfWeek. Empty times = day-only (time check passes). start > end =
        // overnight window (22:00–02:00 → in-window when now ≥ start OR now ≤ end). Local time
        // to match the token engine's {time}. DaysOfWeek 0 = every day.
        private static bool ProbeTimeWindow(ActionItem action)
        {
            var now = DateTime.Now;
            bool dayOk = action.DaysOfWeek == 0 || (action.DaysOfWeek & (1 << (int)now.DayOfWeek)) != 0;
            if (!dayOk) return false;

            bool hasStart = TimeSpan.TryParse(action.TimeStart, System.Globalization.CultureInfo.InvariantCulture, out var start);
            bool hasEnd = TimeSpan.TryParse(action.TimeEnd, System.Globalization.CultureInfo.InvariantCulture, out var end);
            if (!hasStart || !hasEnd) return true; // day-only mode (or partial config) — day already matched

            var t = now.TimeOfDay;
            return start <= end
                ? (t >= start && t <= end)      // normal same-day window
                : (t >= start || t <= end);     // overnight wrap-around
        }

        // If-Variable raw probe: compares the runtime variable named in Key against the
        // resolved operand. Async because the operand runs the full token pipeline (may hit
        // {clipboard}). Missing variable → "". gt/lt coerce to numeric when both sides parse
        // (InvariantCulture); eq/neq/contains are case-insensitive string (house style).
        private async Task<bool> ProbeVariableAsync(ActionItem action)
        {
            var name = action.Key?.Trim();
            if (string.IsNullOrEmpty(name)) return false; // unconfigured
            var lhs = _runtimeVariables.TryGetValue(name.ToLowerInvariant(), out var v) ? v : string.Empty;
            var rhs = await ResolveTokens(action.ConditionOperand ?? string.Empty);
            var op = action.ConditionOperator?.ToLowerInvariant() ?? "eq";
            switch (op)
            {
                case "neq":
                    return !string.Equals(lhs, rhs, StringComparison.OrdinalIgnoreCase);
                case "contains":
                    return lhs.IndexOf(rhs, StringComparison.OrdinalIgnoreCase) >= 0;
                case "gt":
                case "lt":
                    bool lok = double.TryParse(lhs, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var ln);
                    bool rok = double.TryParse(rhs, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var rn);
                    if (lok && rok) return op == "gt" ? ln > rn : ln < rn;
                    // Non-numeric → lexical comparison so the operator still means something.
                    int cmp = string.Compare(lhs, rhs, StringComparison.OrdinalIgnoreCase);
                    return op == "gt" ? cmp > 0 : cmp < 0;
                default: // "eq"
                    return string.Equals(lhs, rhs, StringComparison.OrdinalIgnoreCase);
            }
        }

        // If-File raw probe: TRUE when the resolved path exists as a file OR directory.
        // Async so the path can carry {clipboard}/{var}/{date} tokens. Empty → false.
        private async Task<bool> ProbeFileExistsAsync(ActionItem action)
        {
            var path = (await ResolveTokens(action.FilePath ?? string.Empty)).Trim();
            if (string.IsNullOrEmpty(path)) return false;
            try { return System.IO.File.Exists(path) || System.IO.Directory.Exists(path); }
            catch { return false; } // malformed path (illegal chars, too long) → not found
        }

        // Used by IF rows to decide which branch to take — a SINGLE-SHOT probe (the optional
        // "wait up to N ms for the condition" polling lives in EvaluateConditionWithTimeout above).
        // One screen capture + match (image) or one pixel read (pixel), completes in ~tens of
        // milliseconds. Cancellation is
        // checked up-front; the probe itself is fast enough that we don't interleave
        // checks during the work (MatchOnce is ~30-80 ms on 1080p, GetPixelAt is sub-ms).
        //
        // Returns the EFFECTIVE branch outcome — i.e. ConditionNegate is already applied.
        // The caller treats the return value as "execute TRUE branch?" without needing
        // to know about negation.
        private bool InstantProbe(ActionItem action, CancellationToken token)
        {
            token.ThrowIfCancellationRequested();

            try
            {
                bool rawResult;
                if (string.Equals(action.ConditionType, "ImageFound", StringComparison.OrdinalIgnoreCase))
                {
                    rawResult = ProbeImageFound(action);
                }
                else if (string.Equals(action.ConditionType, "PixelColorMatch", StringComparison.OrdinalIgnoreCase))
                {
                    rawResult = ProbePixelColorMatch(action);
                }
                else if (string.Equals(action.ConditionType, "WindowOpen", StringComparison.OrdinalIgnoreCase))
                {
                    rawResult = ProbeWindowOpen(action);
                }
                else if (string.Equals(action.ConditionType, "Random", StringComparison.OrdinalIgnoreCase))
                {
                    rawResult = ProbeRandom(action);
                }
                else if (string.Equals(action.ConditionType, "ProcessRunning", StringComparison.OrdinalIgnoreCase))
                {
                    rawResult = ProbeProcessRunning(action);
                }
                else if (string.Equals(action.ConditionType, "TimeWindow", StringComparison.OrdinalIgnoreCase))
                {
                    rawResult = ProbeTimeWindow(action);
                }
                else
                {
                    // Unknown / unset ConditionType — return false so the FALSE branch fires.
                    // The load-time validator should also have flagged this, but defending the
                    // engine against a hand-edited typo keeps the replay graceful instead of
                    // throwing on an unrecognized probe family.
                    System.Diagnostics.Debug.WriteLine($"[InstantProbe] Unknown ConditionType '{action.ConditionType}' — treating as false");
                    rawResult = false;
                }

                return action.ConditionNegate ? !rawResult : rawResult;
            }
            catch (OperationCanceledException)
            {
                // Cancellation always propagates regardless of error policy — the user
                // explicitly stopped the replay; surfacing it as "no match" would let the
                // FALSE branch run, which is wrong.
                throw;
            }
            catch (Exception ex)
            {
                DiagnosticLog.Info($"[InstantProbe] Probe error ({action.ConditionType}): {ex.Message}");
                if (string.Equals(action.IfOnProbeError, "Halt", StringComparison.OrdinalIgnoreCase))
                    throw;
                // TreatAsFalse (null / default): raw outcome is false, then apply Negate so
                // the IFNOT semantics still hold (a negated IF whose probe errored still
                // executes its TRUE branch — same as if the image weren't found).
                return action.ConditionNegate;
            }
        }

        private bool ProbeImageFound(ActionItem action)
        {
            if (string.IsNullOrEmpty(action.ImagePath)) return false;

            // Executing profile, not the UI's active one — see CurrentExecutingProfileName. With
            // _getProfileName an If/ImageFound inside a RunProfile'd sub-profile always read
            // "not found" (image lives in the sub-profile's folder), forcing the FALSE branch.
            string profileName = CurrentExecutingProfileName;
            var referenceImage = ImageStorageService.LoadReferenceImage(profileName, action.ImagePath);
            if (referenceImage == null) return false;

            try
            {
                // Compose optional ROI the same way ExecuteWaitImage does — translate via
                // the current relative-coord offset so a profile-bound region tracks its
                // target window even when the user has moved the window.
                System.Drawing.Rectangle? searchRegion = null;
                if (action.WaitImageSearchW is int sw && action.WaitImageSearchH is int sh && sw > 0 && sh > 0)
                {
                    int sx = action.WaitImageSearchX ?? 0;
                    int sy = action.WaitImageSearchY ?? 0;
                    if (!TryResolveRelativeOffset(out int dx, out int dy))
                    {
                        // Rel-coords on but target window missing. With IfOnProbeError=Halt this
                        // surfaces the error + cancels (same as WaitImage); otherwise we silently
                        // treat as not-matched. Caller's catch above doesn't fire for this path
                        // because it's not an exception — just a config-impossible state.
                        if (string.Equals(action.IfOnProbeError, "Halt", StringComparison.OrdinalIgnoreCase))
                            ReportMissingTargetWindow();
                        return false;
                    }
                    searchRegion = new System.Drawing.Rectangle(sx + dx, sy + dy, sw, sh);
                }

                // Same 1.0-is-unreachable clamp as ExecuteWaitImage — a 100%-confidence IF/ImageFound
                // condition would otherwise always read FALSE on a live screen.
                double confidence = action.Confidence > 0 ? Math.Min(action.Confidence, 0.99) : 0.8;
                var matchResult = ImageMatchingService.MatchOnce(referenceImage, searchRegion);
                return matchResult.Score >= confidence;
            }
            finally
            {
                referenceImage.Dispose();
            }
        }

        private bool ProbePixelColorMatch(ActionItem action)
        {
            if (action.PixelX is not int relPx || action.PixelY is not int relPy) return false;
            var target = PixelColorService.ParseHex(action.PixelColor);
            if (target == null) return false;

            if (!TryResolveRelativeOffset(out int dx, out int dy))
            {
                if (string.Equals(action.IfOnProbeError, "Halt", StringComparison.OrdinalIgnoreCase))
                    ReportMissingTargetWindow();
                return false;
            }
            int px = relPx + dx;
            int py = relPy + dy;

            var sampled = PixelColorService.GetPixelAt(px, py);
            if (sampled is not System.Drawing.Color s) return false;
            return PixelColorService.MatchesWithinTolerance(s, target.Value, action.PixelTolerance);
        }

        private void SaveTimeoutScreenshot(ActionItem action)
        {
            // Diagnostic-only — never let a screenshot failure bubble up and break the replay.
            try
            {
                var dir = System.IO.Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    "TrueReplayer", "Debug");
                System.IO.Directory.CreateDirectory(dir);

                var refName = System.IO.Path.GetFileNameWithoutExtension(action.ImagePath ?? "unknown");
                var ts = DateTime.Now.ToString("yyyyMMdd-HHmmss");
                using var screen = ScreenCaptureService.CaptureVirtualScreen();
                var outPath = System.IO.Path.Combine(dir, $"waitimage-timeout-{refName}-{ts}.png");
                screen.Save(outPath, System.Drawing.Imaging.ImageFormat.Png);
                DiagnosticLog.Info($"[WaitImage] Timeout screenshot saved: {outPath}");
            }
            catch (Exception ex)
            {
                DiagnosticLog.Info($"[WaitImage] Failed to save timeout screenshot: {ex.Message}");
            }
        }

        /// <summary>
        /// Pauses replay until either the configured resume hotkey is pressed, or the timeout
        /// expires, or the replay is cancelled. The hotkey is suppressed (not sent to the target
        /// app). If both fields are empty/zero, this is a no-op so the replay continues immediately.
        /// </summary>
        private async Task ExecutePause(ActionItem action, CancellationToken token)
        {
            string? hotkey = string.IsNullOrWhiteSpace(action.Key) ? null : action.Key.Trim();
            int timeoutMs = action.Timeout > 0 ? action.Timeout : 0;
            if (hotkey == null && timeoutMs == 0) return;

            var resumeTcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

            dispatcherQueue.TryEnqueue(() => OnReplayPaused?.Invoke(hotkey ?? "", timeoutMs));

            if (hotkey != null)
                InputHookManager.SetReplayPauseListener(hotkey, () => resumeTcs.TrySetResult(true));

            try
            {
                var resumeTask = resumeTcs.Task;
                var timeoutTask = timeoutMs > 0 ? Task.Delay(timeoutMs, token) : Task.Delay(Timeout.Infinite, token);
                await Task.WhenAny(resumeTask, timeoutTask);
                token.ThrowIfCancellationRequested();
            }
            finally
            {
                InputHookManager.ClearReplayPauseListener();
                dispatcherQueue.TryEnqueue(() => OnReplayResumed?.Invoke());
            }
        }

        private static readonly Dictionary<string, ushort> SpecialKeyPlaceholders = new(StringComparer.OrdinalIgnoreCase)
        {
            ["{enter}"] = 0x0D,      // VK_RETURN
            ["{tab}"] = 0x09,        // VK_TAB
            ["{space}"] = 0x20,      // VK_SPACE
            ["{backspace}"] = 0x08,  // VK_BACK
            ["{delete}"] = 0x2E,     // VK_DELETE
            ["{escape}"] = 0x1B,     // VK_ESCAPE
            ["{esc}"] = 0x1B,        // alias for {escape} — matches BrowserType chip naming
            ["{home}"] = 0x24,       // VK_HOME
            ["{end}"] = 0x23,        // VK_END
            ["{pageup}"] = 0x21,     // VK_PRIOR
            ["{pagedown}"] = 0x22,   // VK_NEXT
            ["{up}"] = 0x26,         // VK_UP
            ["{down}"] = 0x28,       // VK_DOWN
            ["{left}"] = 0x25,       // VK_LEFT
            ["{right}"] = 0x27,      // VK_RIGHT
        };

        // Sentinels used to mark literal '{' / '}' produced by placeholder substitution
        // (e.g. clipboard content). Stops ParseSendTextSegments from re-interpreting them
        // as another placeholder. Stripped back to '{' / '}' when text segments are emitted.
        private const char OpenBraceSentinel = '';
        private const char CloseBraceSentinel = '';

        private struct SendTextSegment
        {
            public string? Text;
            public ushort? VkCode;
            public int? DelayMs;
        }

        private static List<SendTextSegment> ParseSendTextSegments(string text)
        {
            var segments = new List<SendTextSegment>();
            int i = 0;

            while (i < text.Length)
            {
                char ch = text[i];

                // Sentinels stand in for literal '{' / '}' that came from placeholder substitution
                // (e.g. clipboard content). Emit as plain text — never re-parse as a placeholder.
                if (ch == OpenBraceSentinel)
                {
                    AppendTextChar(segments, '{');
                    i++;
                    continue;
                }
                if (ch == CloseBraceSentinel)
                {
                    AppendTextChar(segments, '}');
                    i++;
                    continue;
                }

                if (ch == '{')
                {
                    // Find closing brace (skip sentinel close-braces — they belong to substituted text)
                    int closeBrace = -1;
                    for (int j = i + 1; j < text.Length; j++)
                    {
                        if (text[j] == '}') { closeBrace = j; break; }
                        if (text[j] == OpenBraceSentinel || text[j] == CloseBraceSentinel)
                        {
                            // Sentinel inside what looked like a placeholder — bail out, treat '{' as literal
                            break;
                        }
                    }
                    if (closeBrace == -1)
                    {
                        AppendTextChar(segments, ch);
                        i++;
                        continue;
                    }

                    string inner = text.Substring(i + 1, closeBrace - i - 1); // e.g. "enter", "enter:5", "delay:500"
                    string name = inner;
                    int colonIdx = inner.IndexOf(':');
                    bool hasValidParam = false;
                    int paramValue = 0;
                    if (colonIdx >= 0)
                    {
                        name = inner.Substring(0, colonIdx);
                        if (int.TryParse(inner.Substring(colonIdx + 1), out int n) && n > 0)
                        {
                            hasValidParam = true;
                            paramValue = n;
                        }
                    }

                    // {delay:N} — pause during replay. Invalid/missing N → treat as default (500 ms),
                    // not as a 1 ms no-op. Cap at 60 s.
                    if (name.Equals("delay", StringComparison.OrdinalIgnoreCase))
                    {
                        int delayMs = hasValidParam ? Math.Min(paramValue, 60000) : 500;
                        segments.Add(new SendTextSegment { DelayMs = delayMs });
                        i = closeBrace + 1;
                        continue;
                    }

                    // {key} or {key:N} — special key with optional repeat. Invalid N → 1 press. Cap at 100.
                    string keyPlaceholder = "{" + name + "}";
                    if (SpecialKeyPlaceholders.TryGetValue(keyPlaceholder, out ushort vk))
                    {
                        int count = hasValidParam ? Math.Min(paramValue, 100) : 1;
                        for (int r = 0; r < count; r++)
                            segments.Add(new SendTextSegment { VkCode = vk });
                        i = closeBrace + 1;
                        continue;
                    }

                    // Unknown placeholder, treat '{' as regular text
                    AppendTextChar(segments, ch);
                    i++;
                }
                else
                {
                    AppendTextChar(segments, ch);
                    i++;
                }
            }

            return segments;
        }

        private static void AppendTextChar(List<SendTextSegment> segments, char c)
        {
            if (segments.Count > 0 && segments[^1].Text != null)
            {
                var last = segments[^1];
                last.Text += c;
                segments[^1] = last;
            }
            else
            {
                segments.Add(new SendTextSegment { Text = c.ToString() });
            }
        }

        // Escape '{' and '}' in substituted placeholder values so the parser does not re-interpret
        // them as another placeholder (e.g. clipboard content "{enter}" should stay as text).
        private static string EscapeBracesForParser(string value)
        {
            if (string.IsNullOrEmpty(value)) return value ?? string.Empty;
            if (value.IndexOf('{') < 0 && value.IndexOf('}') < 0) return value;
            return value.Replace('{', OpenBraceSentinel).Replace('}', CloseBraceSentinel);
        }

        // Inverse of EscapeBracesForParser — restore real '{' / '}' before any further use of the text.
        internal static string UnescapeBraceSentinels(string value)
        {
            if (string.IsNullOrEmpty(value)) return value ?? string.Empty;
            if (value.IndexOf(OpenBraceSentinel) < 0 && value.IndexOf(CloseBraceSentinel) < 0) return value;
            return value.Replace(OpenBraceSentinel, '{').Replace(CloseBraceSentinel, '}');
        }

        // VK codes that must carry KEYEVENTF_EXTENDEDKEY when replayed via SendInput. These keys
        // share their scancode with a numpad twin (Delete↔Num. , Insert↔Num0, Home↔Num7, etc.);
        // the E0 prefix — Windows' KEYEVENTF_EXTENDEDKEY flag — is what distinguishes them on
        // hardware. Without it, Delete is delivered as scancode 0x53 with no E0 → Windows treats
        // it as Numpad Decimal → produces "." instead of deleting. Same shape for the others.
        // PrintScreen (0x2C) and Pause (0x13) have non-trivial scancode sequences and are
        // intentionally omitted — replaying them via SendInput needs special handling.
        private static readonly HashSet<ushort> ExtendedVkCodes = new()
        {
            0x21, 0x22, 0x23, 0x24, // PgUp, PgDn, End, Home
            0x25, 0x26, 0x27, 0x28, // Left, Up, Right, Down
            0x2D, 0x2E,             // Insert, Delete
            0x5B, 0x5C, 0x5D,       // LWin, RWin, Apps (context menu)
            0x6F,                   // NumDivide (numpad /)
            0x90,                   // NumLock
            0xA3, 0xA5              // RControl, RAlt (RMenu)
        };

        private void SimulateKeyPress(ushort vk)
        {
            ushort scan = (ushort)NativeMethods.MapVirtualKey(vk, 0);
            bool isExtended = ExtendedVkCodes.Contains(vk);
            uint downFlags = NativeMethods.KEYEVENTF_SCANCODE;
            if (isExtended) downFlags |= NativeMethods.KEYEVENTF_EXTENDEDKEY;
            uint upFlags = downFlags | NativeMethods.KEYEVENTF_KEYUP;
            // wVk is ignored when KEYEVENTF_SCANCODE is set, but kept populated for non-extended
            // keys so any listener that ignores the flag still sees something sensible. Extended
            // keys send 0 to mirror the long-standing arrow-key behaviour.
            ushort effectiveVk = isExtended ? (ushort)0 : vk;

            var inputs = new NativeMethods.INPUT[]
            {
                new() { type = NativeMethods.INPUT_KEYBOARD, U = new NativeMethods.InputUnion { ki = new NativeMethods.KEYBDINPUT { wVk = effectiveVk, wScan = scan, dwFlags = downFlags } } },
                new() { type = NativeMethods.INPUT_KEYBOARD, U = new NativeMethods.InputUnion { ki = new NativeMethods.KEYBDINPUT { wVk = effectiveVk, wScan = scan, dwFlags = upFlags } } },
            };
            NativeMethods.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(NativeMethods.INPUT)));
        }

        private async Task PasteTextViaClipboard(string text, string? html, CancellationToken token)
        {
            // SEC: KeyHtml is untrusted markup (a foreign/hand-edited .trprofile could carry a tracking
            // beacon, hidden text, or a javascript:/file: link) that the paste TARGET interprets. Scrub
            // it to the editor-producible allowlist at this single choke point — reader-side covers ALL
            // provenance (import, hand-edited profile JSON on disk, and profiles imported before the
            // sanitizer shipped), which an import-only gate would miss. Sanitize returns null on an
            // empty/hostile result or a parse error, so we fail CLOSED to plain text and never emit raw
            // markup. Cost is negligible against the two Task.Delay(50) + SendInput already on this path.
            // NOT done in PrepareRichHtmlForSend: that runs pre-token-resolution, so it wouldn't see the
            // final bytes (resolution itself can't inject — htmlEncodeSubstitution is on — but the sink
            // is where the truly-final CF_HTML string exists).
            if (!string.IsNullOrEmpty(html))
                html = HtmlSanitizer.Sanitize(html);
            // CF_UNICODETEXT convention is CRLF, and classic Win32 EDIT / WinForms
            // multiline targets do NOT break lines on a lone LF. The list modifiers
            // (sort/range/lines/dedupe/reverse) emit LF-joined text — normalize any
            // bare LF back to CRLF before it hits the clipboard. Browser-path text
            // never routes through here, so LF-tolerant consumers are unaffected.
            // The HTML flavor is deliberately NOT normalized — markup needs no CRLF.
            text = text.Replace("\r\n", "\n").Replace("\n", "\r\n");
            var tcs = new TaskCompletionSource<bool>();
            if (!dispatcherQueue.TryEnqueue(() =>
            {
                try
                {
                    var dataPackage = new Windows.ApplicationModel.DataTransfer.DataPackage();
                    dataPackage.SetText(text);
                    // Rich flavor: both formats ride the same package and the paste TARGET
                    // negotiates — Gmail/Word/contenteditable take the HTML, Notepad takes the
                    // text. HtmlFormatHelper writes the CF_HTML header (StartHTML/EndHTML byte
                    // offsets) for us — same pattern as ClipboardService.CopyActions.
                    if (!string.IsNullOrEmpty(html))
                        dataPackage.SetHtmlFormat(Windows.ApplicationModel.DataTransfer.HtmlFormatHelper.CreateHtmlFormat(html));
                    Windows.ApplicationModel.DataTransfer.Clipboard.SetContent(dataPackage);
                    tcs.SetResult(true);
                }
                catch
                {
                    tcs.SetResult(false);
                }
            }))
            {
                // Queue shut down (app closing) — unblock the awaiter; the false result bails below.
                tcs.TrySetResult(false);
            }

            if (!await tcs.Task || token.IsCancellationRequested) return;

            await Task.Delay(50, token);

            ushort vkCtrl = 0x11;
            ushort vkV = 0x56;
            ushort scanCtrl = (ushort)NativeMethods.MapVirtualKey(vkCtrl, 0);
            ushort scanV = (ushort)NativeMethods.MapVirtualKey(vkV, 0);

            var inputs = new NativeMethods.INPUT[]
            {
                new() { type = NativeMethods.INPUT_KEYBOARD, U = new NativeMethods.InputUnion { ki = new NativeMethods.KEYBDINPUT { wVk = vkCtrl, wScan = scanCtrl, dwFlags = NativeMethods.KEYEVENTF_SCANCODE } } },
                new() { type = NativeMethods.INPUT_KEYBOARD, U = new NativeMethods.InputUnion { ki = new NativeMethods.KEYBDINPUT { wVk = vkV, wScan = scanV, dwFlags = NativeMethods.KEYEVENTF_SCANCODE } } },
                new() { type = NativeMethods.INPUT_KEYBOARD, U = new NativeMethods.InputUnion { ki = new NativeMethods.KEYBDINPUT { wVk = vkV, wScan = scanV, dwFlags = NativeMethods.KEYEVENTF_KEYUP | NativeMethods.KEYEVENTF_SCANCODE } } },
                new() { type = NativeMethods.INPUT_KEYBOARD, U = new NativeMethods.InputUnion { ki = new NativeMethods.KEYBDINPUT { wVk = vkCtrl, wScan = scanCtrl, dwFlags = NativeMethods.KEYEVENTF_KEYUP | NativeMethods.KEYEVENTF_SCANCODE } } },
            };

            NativeMethods.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(NativeMethods.INPUT)));
            await Task.Delay(50, token);
        }

        // Replay handler for the Keystroke action type. Parses a "+"-joined combo like
        // "Ctrl+Shift+T" or "Alt+Tab" and emits the proper modifier-down → key-down →
        // key-up → modifier-up sequence. The modifiers are released in REVERSE order
        // (last-pressed-first-released) which is what physical typing produces and what
        // Windows shortcut handlers expect.
        //
        // A short Thread.Sleep(10) sits between the modifier-down chain and the key tap
        // so the target app has a frame to register the modifier state before the key
        // event arrives. Without it, fast apps (some games, terminals) can drop the
        // modifier from their state machine and treat the keystroke as if only the key
        // was pressed bare. 10 ms is below human-perceptible latency.
        // Keystroke / KeyDown / KeyUp / HoldKey: the Key field accepts the same tokens
        // as the text fields ({var:name}, {clipboard}, {random:a-b}, …). Resolved here,
        // BEFORE SimulateKeystroke's '+' split, so a variable holding a whole combo
        // ("Ctrl+V") works. Plain keys (no '{') never touch the async resolver — the
        // hot path in tight repeat loops stays synchronous. escapeBraces:false — the
        // resolved value must remain a literal key name; ParseSendTextSegments never
        // runs on this path.
        private async Task<string> ResolveKeyTokens(string key)
        {
            if (string.IsNullOrEmpty(key) || key.IndexOf('{') < 0) return key;
            var resolved = (await ResolveTokens(key)).Trim();
            if (resolved.Length == 0)
                DiagnosticLog.Warn($"Key '{key}' resolved to empty — press skipped");
            return resolved;
        }

        // KeyDown resolutions awaiting their KeyUp, keyed by the RAW (token) key text.
        // Guarantees a down/up pair with identical token text presses and releases the
        // SAME key even when the token would resolve differently by the KeyUp row.
        private readonly Dictionary<string, string> _pendingTokenKeyDowns = new(StringComparer.OrdinalIgnoreCase);

        // Last key SimulateKey warned about — dedupes the unrecognizable-key warning so
        // a misspelled key inside a tight/infinite loop logs once, not once per press
        // (DiagnosticLog appends synchronously per line; it is for low-volume events).
        private string? _lastUnrecognizedKeyWarned;

        private void SimulateKeystroke(string keystroke, CancellationToken token = default)
        {
            if (string.IsNullOrWhiteSpace(keystroke)) return;
            var parts = keystroke.Split('+');
            if (parts.Length == 0) return;

            // The LAST part is the target key; everything before it is a modifier.
            // Order matters at replay time, but for the modifier set we don't need to
            // preserve incoming order (Ctrl+Shift and Shift+Ctrl are semantically the
            // same modifier set; we always emit in our canonical order: Win, Ctrl, Shift, Alt).
            var modifiers = new System.Collections.Generic.List<string>();
            string target = parts[^1].Trim();
            for (int i = 0; i < parts.Length - 1; i++)
            {
                var m = parts[i].Trim();
                if (m == "Win" || m == "Ctrl" || m == "Shift" || m == "Alt") modifiers.Add(m);
                // Silently skip unknown modifiers — keystroke replay is best-effort.
            }

            // Modifiers down. Win goes first because shell shortcuts (Win+D, Win+E, Win+R)
            // need the LWin keydown to land before the trigger key, otherwise the Shell
            // sees a bare D and ignores it. Ctrl/Shift/Alt order matches the capture
            // canonical order.
            foreach (var m in new[] { "Win", "Ctrl", "Shift", "Alt" })
                if (modifiers.Contains(m)) SimulateKey(m, true);

            try
            {
                Thread.Sleep(10); // let target app's input system register the modifier set

                // If Stop landed while the modifiers were going down, skip the target tap —
                // but still fall through to the finally so the modifiers are released.
                if (token.IsCancellationRequested) return;

                // Key tap (down → up)
                SimulateKey(target, true);
                SimulateKey(target, false);
            }
            finally
            {
                // Modifiers up in REVERSE order. Mirrors physical typing — release the last-
                // pressed first. Some apps watch for transient modifier states; doing this
                // out of order can leave them in a stuck modifier state until the user
                // physically presses + releases the same modifier themselves. In a finally so a
                // cancelled combo (or a throw in the tap) never leaves a modifier stuck down.
                foreach (var m in new[] { "Alt", "Shift", "Ctrl", "Win" })
                    if (modifiers.Contains(m)) SimulateKey(m, false);
            }
        }

        private void SimulateKey(string key, bool isDown)
        {
            if (!Helpers.KeyUtils.TryResolveVirtualKeyCode(key, out ushort vk))
            {
                // Was a silent no-op — surface it in the session log: an unresolvable
                // key here is almost always a typo'd key name or a {var} that resolved
                // to something that isn't a key. Empty strings stay quiet (the resolver
                // already logged the resolved-to-empty case), and repeats of the SAME
                // bad key are deduped — a Keystroke ×999 or an infinite loop must not
                // turn one typo into thousands of synchronous log appends.
                if (!string.IsNullOrWhiteSpace(key)
                    && !string.Equals(_lastUnrecognizedKeyWarned, key, StringComparison.Ordinal))
                {
                    _lastUnrecognizedKeyWarned = key;
                    DiagnosticLog.Warn($"Key press skipped: '{key}' is not a recognizable key");
                }
                return;
            }
            bool isExtended = ExtendedVkCodes.Contains(vk);
            ushort scan = (ushort)NativeMethods.MapVirtualKey(vk, 0);

            uint flags = isDown ? 0u : NativeMethods.KEYEVENTF_KEYUP;
            flags |= NativeMethods.KEYEVENTF_SCANCODE;
            if (isExtended) flags |= NativeMethods.KEYEVENTF_EXTENDEDKEY;

            var input = new NativeMethods.INPUT
            {
                type = NativeMethods.INPUT_KEYBOARD,
                U = new NativeMethods.InputUnion
                {
                    ki = new NativeMethods.KEYBDINPUT
                    {
                        wVk = isExtended ? (ushort)0 : vk,
                        wScan = scan,
                        dwFlags = flags,
                        time = 0,
                        dwExtraInfo = IntPtr.Zero
                    }
                }
            };

            lock (_simInputLock)
            {
                NativeMethods.SendInput(1, new[] { input }, Marshal.SizeOf(typeof(NativeMethods.INPUT)));

                // Track pressed-but-not-released keys (atomic with the SendInput) so
                // ResetKeyState (called from Stop, on another thread) sees a consistent set
                // and emits the missing KEYUP. Mirrors the mouse flag pattern above.
                if (isDown) _simulatedKeysDown.Add(key);
                else _simulatedKeysDown.Remove(key);
            }
        }
    }
}
