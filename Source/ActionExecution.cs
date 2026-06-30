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
            replayer.OnReplayResumed += () =>
            {
                OnReplayResumed?.Invoke();
            };
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
            IsReplaying = true;
            onButtonStateChanged?.Invoke("Stop", true);

            int loopCount = loopEnabled && int.TryParse(loopCountText, out int count) && count >= 0 ? count : 1;
            int loopInterval = intervalEnabled && int.TryParse(intervalText, out int interval) && interval >= 0 ? interval : 0;
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
                    ResetReplayState();
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
                });
            });
        }

        private void StopReplay()
        {
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

            if (IsReplaying)
            {
                // Stop whatever's running — could be either a regular replay (started by a profile
                // hotkey before the user switched to Clicker mode) or our own click loop. StopReplay
                // cancels both, so the Replay hotkey reliably acts as "stop" regardless of source.
                StopReplay();
                return;
            }

            IsReplaying = true;
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
            onStatusChanged?.Invoke("ready");
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

        public ActionReplayer(ObservableCollection<ActionItem> actions, DispatcherQueue dispatcherQueue, BrowserBridgeService? browserBridge = null)
        {
            _actions = actions;
            this.dispatcherQueue = dispatcherQueue;
            _browserBridge = browserBridge;
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

                // Bring target window to focus if enabled
                if (_bringToFocus && _windowTarget != null)
                {
                    var targetHwnd = FindTargetWindow();
                    if (targetHwnd != IntPtr.Zero)
                    {
                        // Only restore if minimized — preserves maximized/fullscreen state
                        if (NativeMethods.IsIconic(targetHwnd))
                            NativeMethods.ShowWindow(targetHwnd, 9); // SW_RESTORE
                        // AttachThreadInput trick to bypass foreground restriction
                        var fgHwnd = NativeMethods.GetForegroundWindow();
                        uint fgThread = NativeMethods.GetWindowThreadProcessId(fgHwnd, out _);
                        uint curThread = NativeMethods.GetCurrentThreadId();
                        if (fgThread != curThread)
                            NativeMethods.AttachThreadInput(fgThread, curThread, true);
                        NativeMethods.SetForegroundWindow(targetHwnd);
                        if (fgThread != curThread)
                            NativeMethods.AttachThreadInput(fgThread, curThread, false);
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

                // Run replay on a dedicated thread to avoid blocking the thread pool
                await Task.Factory.StartNew(async () =>
                {
                    while (!token.IsCancellationRequested && (isInfinite || iteration < _loopCount))
                    {
                        iteration++;

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

                        await ExecuteActionsAsync(snapshot, token);

                        if (!token.IsCancellationRequested && (isInfinite || iteration < _loopCount) && _loopInterval > 0)
                            await Task.Delay(_loopInterval, token);
                    }
                }, token, TaskCreationOptions.LongRunning, TaskScheduler.Default).Unwrap();
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
                if (token.IsCancellationRequested) break;
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
                dispatcherQueue.TryEnqueue(() => OnActionExecuting?.Invoke(action));
                InputHookManager.IsReplayingAction = true;

                try
                {
                    switch (action.ActionType)
                    {
                        case "KeyDown": SimulateKey(action.Key, true); break;
                        case "KeyUp": SimulateKey(action.Key, false); break;
                        case "HoldKey": {
                            // Send KEYDOWN, hold the configured duration, then KEYUP. The
                            // SimulateKey tracker (Add on isDown / Remove on !isDown) keeps
                            // the key in _simulatedKeysDown for the entire hold, so a Stop
                            // mid-hold has ResetKeyState() release it cleanly instead of
                            // leaving it stuck in the OS keyboard state.
                            int duration = action.HoldDurationMs > 0
                                ? Math.Max(10, Math.Min(60000, action.HoldDurationMs))
                                : ActionItem.DefaultHoldDurationMs;
                            SimulateKey(action.Key, true);
                            try { await Task.Delay(duration, token); }
                            catch (OperationCanceledException) { /* ResetKeyState releases */ }
                            SimulateKey(action.Key, false);
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
                            for (int r = 0; r < repeats; r++) {
                                if (token.IsCancellationRequested) break;
                                SimulateKeystroke(action.Key, token);
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
                        case "SendText": await SimulateClipboardPaste(action.Key, token); break;
                        case "WaitImage": await ExecuteWaitImage(action, token); break;
                        case "WaitPixelColor": await ExecuteWaitPixelColor(action, token); break;
                        case "RunProfile": await HandleRunProfile(action, token); break;
                        case "Pause": await ExecutePause(action, token); break;
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
                    if (NativeMethods.IsIconic(targetHwnd))
                        NativeMethods.ShowWindow(targetHwnd, 9); // SW_RESTORE
                    var fgHwnd = NativeMethods.GetForegroundWindow();
                    uint fgThread = NativeMethods.GetWindowThreadProcessId(fgHwnd, out _);
                    uint curThread = NativeMethods.GetCurrentThreadId();
                    if (fgThread != curThread)
                        NativeMethods.AttachThreadInput(fgThread, curThread, true);
                    NativeMethods.SetForegroundWindow(targetHwnd);
                    if (fgThread != curThread)
                        NativeMethods.AttachThreadInput(fgThread, curThread, false);
                    await Task.Delay(200, token);
                }
            }

            bool hasSize = _lockWidth > 0 && _lockHeight > 0;
            bool applySize = _restoreSize && hasSize;
            bool applyPos = _restorePosition;
            if (_windowTarget != null && (applySize || applyPos))
            {
                var sizeHwnd = FindTargetWindow();
                if (sizeHwnd != IntPtr.Zero && !NativeMethods.IsIconic(sizeHwnd))
                {
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
                    await Task.Delay(80, token);
                }
            }
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
                for (int r = 0; r < repeats && !token.IsCancellationRequested; r++)
                {
                    await ExecuteActionsAsync(subActions, token);
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
                            NativeMethods.SetForegroundWindow(hwnd);
                            await Task.Delay(80, token);
                        }
                    }
                    catch { /* best-effort restore */ }
                }

                if (_callStack.Count > 0) _callStack.RemoveAt(_callStack.Count - 1);
                NotifyChainChanged();
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
            DiagnosticLog.Warn($"Replay aborted: relative-coords target window not found [{name} {_windowTarget?.WindowTitle}]".TrimEnd());
            OnReplayError?.Invoke($"Target window '{name}' not found — open it and retry");
            try { _cts?.Cancel(); } catch (ObjectDisposedException) { }
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
                    default:
                        // Unknown modifier — skip it (forward-compat)
                        i++;
                        break;
                }
            }
            return result;
        }

        /// <summary>
        /// Replaces every {clipboard[:mods]} token in <paramref name="text"/> with the
        /// clipboard content transformed by the given modifiers. Reads the clipboard only once.
        /// If <paramref name="clipboardOverride"/> is non-null it is used instead of reading the OS clipboard.
        /// When <paramref name="escapeBracesInSubstitution"/> is true, '{' / '}' in substituted
        /// values are replaced with sentinels so ParseSendTextSegments does not re-interpret them
        /// as another placeholder — used for the Win32 SendText path.
        /// </summary>
        private Task<string> ResolveClipboardTokens(string text, string? clipboardOverride = null, bool escapeBracesInSubstitution = false)
        {
            return ResolveClipboardTokensAsync(text, dispatcherQueue, clipboardOverride, escapeBracesInSubstitution);
        }

        internal static async Task<string> ResolveClipboardTokensAsync(string text, DispatcherQueue dispatcherQueue, string? clipboardOverride = null, bool escapeBracesInSubstitution = false)
        {
            if (string.IsNullOrEmpty(text)) return text;
            if (!ClipboardTokenRegex.IsMatch(text)) return text;

            string? clipContent;
            if (clipboardOverride != null)
            {
                clipContent = clipboardOverride;
            }
            else
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
                clipContent = await tcsClip.Task;
            }

            var raw = clipContent ?? string.Empty;
            return ClipboardTokenRegex.Replace(text, m =>
            {
                var mods = m.Groups[1].Success ? m.Groups[1].Value : null;
                var resolved = ApplyClipboardModifiers(raw, mods);
                return escapeBracesInSubstitution ? EscapeBracesForParser(resolved) : resolved;
            });
        }

        private Task<string> ResolveBrowserTextPlaceholders(string text)
            => ResolveBrowserTextPlaceholdersAsync(text, dispatcherQueue);

        /// <summary>
        /// Resolves data placeholders ({clipboard[:mods]}, {datetime}, {date}, {time}) for
        /// BrowserType actions. Special-key placeholders ({enter}, {tab}, …) are left untouched —
        /// they are interpreted by the Chrome extension's own parser. Static so the Test Action
        /// path can call it without an ActionReplayer instance.
        /// </summary>
        internal static async Task<string> ResolveBrowserTextPlaceholdersAsync(string text, DispatcherQueue dispatcherQueue)
        {
            if (string.IsNullOrEmpty(text)) return text;

            text = await ResolveClipboardTokensAsync(text, dispatcherQueue);

            var now = DateTime.Now;
            if (text.Contains("{datetime}", StringComparison.OrdinalIgnoreCase))
                text = text.Replace("{datetime}", now.ToString("dd/MM/yyyy - HH:mm:ss"), StringComparison.OrdinalIgnoreCase);
            if (text.Contains("{date}", StringComparison.OrdinalIgnoreCase))
                text = text.Replace("{date}", now.ToString("dd/MM/yyyy"), StringComparison.OrdinalIgnoreCase);
            if (text.Contains("{time}", StringComparison.OrdinalIgnoreCase))
                text = text.Replace("{time}", now.ToString("HH:mm:ss"), StringComparison.OrdinalIgnoreCase);

            return text;
        }

        private async Task SimulateClipboardPaste(string text, CancellationToken token)
        {
            if (string.IsNullOrEmpty(text)) return;

            // Save original clipboard content so we can restore it after pasting
            var tcsBackup = new TaskCompletionSource<string?>();
            if (!dispatcherQueue.TryEnqueue(async () =>
            {
                try
                {
                    var content = Windows.ApplicationModel.DataTransfer.Clipboard.GetContent();
                    if (content.Contains(Windows.ApplicationModel.DataTransfer.StandardDataFormats.Text))
                    {
                        var clipText = await content.GetTextAsync();
                        tcsBackup.SetResult(clipText);
                    }
                    else
                    {
                        tcsBackup.SetResult(null);
                    }
                }
                catch
                {
                    tcsBackup.SetResult(null);
                }
            }))
            {
                // Queue shut down (app closing) — unblock the awaiter with "no backup".
                tcsBackup.TrySetResult(null);
            }
            var originalClipboard = await tcsBackup.Task;

            // Resolve {clipboard[:mods]} placeholders using the saved clipboard content
            // so that subsequent writes to the clipboard (for pasting) don't affect token resolution.
            // Escape '{' / '}' in the substituted value so clipboard content like "{enter}" is
            // pasted as text instead of being re-interpreted as a key press.
            text = await ResolveClipboardTokens(text, originalClipboard ?? string.Empty, escapeBracesInSubstitution: true);

            // Resolve {datetime} before {date}/{time} to avoid partial matches
            var now = DateTime.Now;
            if (text.Contains("{datetime}", StringComparison.OrdinalIgnoreCase))
                text = text.Replace("{datetime}", now.ToString("dd/MM/yyyy - HH:mm:ss"), StringComparison.OrdinalIgnoreCase);
            if (text.Contains("{date}", StringComparison.OrdinalIgnoreCase))
                text = text.Replace("{date}", now.ToString("dd/MM/yyyy"), StringComparison.OrdinalIgnoreCase);
            if (text.Contains("{time}", StringComparison.OrdinalIgnoreCase))
                text = text.Replace("{time}", now.ToString("HH:mm:ss"), StringComparison.OrdinalIgnoreCase);

            if (string.IsNullOrEmpty(text) || token.IsCancellationRequested)
            {
                RestoreOriginalClipboard(originalClipboard);
                return;
            }

            // Parse text into segments: plain text + special key placeholders
            var segments = ParseSendTextSegments(text);

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
                        await PasteTextViaClipboard(literal, token);
                    }
                }
            }
            finally
            {
                // Always restore the user's original clipboard, even if cancelled mid-paste.
                RestoreOriginalClipboard(originalClipboard);
            }
        }

        private void RestoreOriginalClipboard(string? originalClipboard)
        {
            dispatcherQueue.TryEnqueue(() =>
            {
                try
                {
                    if (originalClipboard != null)
                    {
                        var dataPackage = new Windows.ApplicationModel.DataTransfer.DataPackage();
                        dataPackage.SetText(originalClipboard);
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
                return InstantProbe(action, token); // instant single check — unchanged legacy behaviour

            int pollMs = string.Equals(action.ConditionType, "PixelColorMatch", StringComparison.OrdinalIgnoreCase) ? 50 : 200;
            var sw = System.Diagnostics.Stopwatch.StartNew();
            while (true)
            {
                token.ThrowIfCancellationRequested();
                if (InstantProbe(action, token)) return true;         // condition satisfied within the window
                if (sw.ElapsedMilliseconds >= timeoutMs) return false; // window elapsed → take the Else/false branch
                await Task.Delay(pollMs, token);
            }
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

        private async Task PasteTextViaClipboard(string text, CancellationToken token)
        {
            var tcs = new TaskCompletionSource<bool>();
            if (!dispatcherQueue.TryEnqueue(() =>
            {
                try
                {
                    var dataPackage = new Windows.ApplicationModel.DataTransfer.DataPackage();
                    dataPackage.SetText(text);
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
            if (!Helpers.KeyUtils.TryResolveVirtualKeyCode(key, out ushort vk)) return;
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
