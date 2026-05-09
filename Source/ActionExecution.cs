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
        private readonly Func<bool> getMouse, getScroll, getKeyboard;
        private readonly Action<DateTime> setLastActionTime;
        private readonly Action<string>? onStatusChanged;
        private readonly Action<string, bool>? onButtonStateChanged; // (text, isRecording)

        public bool IsRecording { get; private set; }

        public RecordingService(
            ActionRecorder recorder,
            Func<bool> getMouse,
            Func<bool> getScroll,
            Func<bool> getKeyboard,
            Action<DateTime> setLastActionTime,
            Action<string>? onStatusChanged = null,
            Action<string, bool>? onButtonStateChanged = null)
        {
            this.recorder = recorder;
            this.getMouse = getMouse;
            this.getScroll = getScroll;
            this.getKeyboard = getKeyboard;
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
            recorder.UseRelativeCoordinates = Models.UserProfile.Current.UseRelativeCoordinates;
            recorder.Start();
            setLastActionTime(DateTime.Now);
            onStatusChanged?.Invoke("recording");
        }

        public void StopRecording()
        {
            if (!IsRecording) return;
            IsRecording = false;
            onButtonStateChanged?.Invoke("Recording", false);
            recorder.Stop();
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
            replayer.OnReplayResumed += () =>
            {
                OnReplayResumed?.Invoke();
            };
        }

        // Re-exposed events from the inner replayer so MainWindow/WebViewBridge can wire UI feedback.
        public event Action<string, int>? OnReplayPaused;
        public event Action? OnReplayResumed;

        // Manual resume from UI button (status bar). Forwards to InputHookManager which fires the
        // same callback the resume hotkey would.
        public void ManualResume() => InputHookManager.TriggerReplayPauseListener();

        public void SetProfileNameProvider(Func<string> getProfileName)
        {
            replayer.SetProfileNameProvider(getProfileName);
        }

        public void SetProfileLookup(Func<string, Task<Models.UserProfile?>> lookup)
        {
            replayer.SetProfileLookup(lookup);
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

            onStatusChanged?.Invoke("replaying");

            _ = replayer.StartAsync().ContinueWith(t =>
            {
                dispatcherQueue.TryEnqueue(() =>
                {
                    ResetReplayState();
                    if (t.Exception?.InnerException is TimeoutException tex)
                        onStatusChanged?.Invoke($"error:{tex.Message}");
                    else if (t.Exception?.InnerException != null)
                        onStatusChanged?.Invoke($"error:{t.Exception.InnerException.Message}");
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

        public void ToggleCursorClickReplay(int delay, bool useJitter, int jitterPercent, int loopCount, int loopInterval, string button = "Left")
        {
            if (IsReplaying)
            {
                // Stop whatever's running — could be either a regular replay (started by a profile
                // hotkey before the user switched to Clicker mode) or our own click loop. StopReplay
                // cancels both, so the Replay hotkey reliably acts as "stop" regardless of source.
                StopReplay();
                return;
            }

            IsReplaying = true;
            onButtonStateChanged?.Invoke("Stop", true);
            onStatusChanged?.Invoke("replaying");

            _cursorClickCts = new CancellationTokenSource();
            var token = _cursorClickCts.Token;

            _ = Task.Factory.StartNew(async () =>
            {
                try
                {
                    // Wait for hotkey release
                    await Task.Delay(200, token);

                    int iteration = 0;
                    bool isInfinite = loopCount == 0;

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

                    while (!token.IsCancellationRequested && (isInfinite || iteration < loopCount))
                    {
                        iteration++;

                        NativeMethods.GetCursorPos(out var pos);

                        int vx = NativeMethods.GetSystemMetrics(76);
                        int vy = NativeMethods.GetSystemMetrics(77);
                        int vw = NativeMethods.GetSystemMetrics(78);
                        int vh = NativeMethods.GetSystemMetrics(79);
                        int absX = (int)(((double)(pos.x - vx) * 65535) / (vw - 1));
                        int absY = (int)(((double)(pos.y - vy) * 65535) / (vh - 1));
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

                        await Task.Delay(10, token);

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
                    dispatcherQueue.TryEnqueue(() => ResetReplayState());
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
        public bool UseRelativeCoordinates { get; set; } = false;
        public bool IsCaptureMode => _captureType != CaptureType.None;

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
        }

        public void Stop()
        {
            _isRecording = false;
            _pressedKeys.Clear();
            insertIndex = null;
            _lastActionTime = null;
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
                CaptureType.Mouse or CaptureType.Scroll => _captureActionCount >= _captureTargetCount,
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

        public void RecordMouseAction(string button, int x, int y, bool isDown, int scrollDelta = 0)
        {
            if (!_isRecording) return;
            // In capture mode, only accept the specific mouse button
            if (_captureType == CaptureType.Mouse && _captureMouseButton != null && button != _captureMouseButton)
                return;
            string actionType = button switch
            {
                "Left" => isDown ? "LeftClickDown" : "LeftClickUp",
                "Right" => isDown ? "RightClickDown" : "RightClickUp",
                "Middle" => isDown ? "MiddleClickDown" : "MiddleClickUp",
                "Scroll" => scrollDelta > 0 ? "ScrollUp" : "ScrollDown",
                _ => ""
            };

            if (string.IsNullOrEmpty(actionType) || (button == "Scroll" && !RecordScroll) || (button != "Scroll" && !RecordMouse)) return;

            int delay = GetDelayForNewAction();

            if (button == "Scroll")
            {
                AddAction(new ActionItem { ActionType = actionType, Delay = delay });
            }
            else
            {
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
                            // Capture window geometry on first click for Restore Position / Restore Size
                            if (Models.UserProfile.Current.WindowWidth == 0)
                            {
                                Models.UserProfile.Current.WindowWidth = rect.Right - rect.Left;
                                Models.UserProfile.Current.WindowHeight = rect.Bottom - rect.Top;
                                Models.UserProfile.Current.WindowX = rect.Left;
                                Models.UserProfile.Current.WindowY = rect.Top;
                            }
                        }
                    }
                }
                AddAction(new ActionItem { ActionType = actionType, X = recX, Y = recY, Delay = delay });
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
        private readonly ObservableCollection<ActionItem> _actions;
        private readonly DispatcherQueue dispatcherQueue;
        private readonly BrowserBridgeService? _browserBridge;
        private CancellationTokenSource? _cts;
        private int _loopCount = 0;
        private int _loopInterval = 0;
        private Func<string>? _getProfileName;

        // ── Profile chaining ──
        // Async lookup that resolves a profile name into its UserProfile. Returns null when missing.
        private Func<string, Task<Models.UserProfile?>>? _profileLookup;
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

        public void SetProfileLookup(Func<string, Task<Models.UserProfile?>> lookup)
        {
            _profileLookup = lookup;
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
            // Cancel any previous run and wait for it to finish before disposing
            if (_cts != null)
            {
                _cts.Cancel();
                // Give previous task a moment to observe cancellation
                await Task.Delay(50);
                _cts.Dispose();
            }
            _cts = new CancellationTokenSource();
            var token = _cts.Token;
            int iteration = 0;
            bool isInfinite = _forceInfiniteLoop || _loopCount == 0;

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

                        await ExecuteActionsAsync(snapshot, token);

                        if (!token.IsCancellationRequested && (isInfinite || iteration < _loopCount) && _loopInterval > 0)
                            await Task.Delay(_loopInterval, token);
                    }
                }, token, TaskCreationOptions.LongRunning, TaskScheduler.Default).Unwrap();
            }
            catch (TaskCanceledException) { }
            finally
            {
                _callStack.Clear();
                NotifyChainChanged();
            }
        }

        /// <summary>
        /// Executes a flat list of actions sequentially. Reentrant: a RunProfile action invokes
        /// this method again with the sub-profile's actions. Honors the same cancellation token,
        /// delay variation and skip behavior as the top-level loop.
        /// </summary>
        private async Task ExecuteActionsAsync(List<ActionItem> actions, CancellationToken token)
        {
            for (int i = 0; i < actions.Count; i++)
            {
                if (token.IsCancellationRequested) break;
                var action = actions[i];
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
                        case "LeftClickDown": SimulateMouse(action.X, action.Y, NativeMethods.MOUSEEVENTF_LEFTDOWN); _simLeftDown = true; break;
                        case "LeftClickUp": SimulateMouse(action.X, action.Y, NativeMethods.MOUSEEVENTF_LEFTUP); _simLeftDown = false; break;
                        case "RightClickDown": SimulateMouse(action.X, action.Y, NativeMethods.MOUSEEVENTF_RIGHTDOWN); _simRightDown = true; break;
                        case "RightClickUp": SimulateMouse(action.X, action.Y, NativeMethods.MOUSEEVENTF_RIGHTUP); _simRightDown = false; break;
                        case "MiddleClickDown": SimulateMouse(action.X, action.Y, NativeMethods.MOUSEEVENTF_MIDDLEDOWN); _simMiddleDown = true; break;
                        case "MiddleClickUp": SimulateMouse(action.X, action.Y, NativeMethods.MOUSEEVENTF_MIDDLEUP); _simMiddleDown = false; break;
                        case "ScrollUp": SimulateScroll(120); break;
                        case "ScrollDown": SimulateScroll(-120); break;
                        case "SendText": await SimulateClipboardPaste(action.Key, token); break;
                        case "WaitImage": await ExecuteWaitImage(action, token); break;
                        case "RunProfile": await HandleRunProfile(action, token); break;
                        case "Pause": await ExecutePause(action, token); break;
                        case "BrowserClick":
                        case "BrowserRightClick":
                        case "BrowserType":
                        case "BrowserWaitElement":
                        case "BrowserNavigate":
                            if (_browserBridge != null)
                            {
                                // Resolve {clipboard}, {date}, {time}, {datetime} in BrowserText without mutating original
                                string? resolvedText = null;
                                if (action.ActionType == "BrowserType" && !string.IsNullOrEmpty(action.BrowserText))
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

            // Push and update chain status BEFORE applying sub context so the user sees the
            // chain even during the focus/lock setup phase.
            _callStack.Add(targetName);
            NotifyChainChanged();

            var savedContext = SaveWindowContext();
            try
            {
                // If sub has its own target, switch into its context. Otherwise inherit caller's.
                if (subProfile.TargetWindow != null)
                {
                    _windowTarget = subProfile.TargetWindow;
                    _useRelativeCoordinates = subProfile.UseRelativeCoordinates;
                    _bringToFocus = subProfile.BringToFocus;
                    _restorePosition = subProfile.RestorePosition;
                    _restoreSize = subProfile.RestoreSize;
                    _lockWidth = subProfile.WindowWidth;
                    _lockHeight = subProfile.WindowHeight;
                    _lockX = subProfile.WindowX;
                    _lockY = subProfile.WindowY;
                    await ApplyWindowContextAsync(token);
                }

                int repeats = Math.Max(1, action.RepeatCount);
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
            // Only cancel — disposal is handled by the next StartAsync() call
            _cts?.Cancel();
            ResetMouseState();
        }

        // Tracks mouse buttons pressed down by the replay that have not yet been released.
        // Used by ResetMouseState to only release buttons we actually pressed — avoids firing
        // spurious UP events (which some apps perceive as a click) when replay stops cleanly.
        private bool _simLeftDown, _simRightDown, _simMiddleDown;

        private void ResetMouseState()
        {
            if (!_simLeftDown && !_simRightDown && !_simMiddleDown) return;
            NativeMethods.GetCursorPos(out var pos);
            if (_simLeftDown)   { SimulateMouse(pos.x, pos.y, NativeMethods.MOUSEEVENTF_LEFTUP);   _simLeftDown = false; }
            if (_simRightDown)  { SimulateMouse(pos.x, pos.y, NativeMethods.MOUSEEVENTF_RIGHTUP);  _simRightDown = false; }
            if (_simMiddleDown) { SimulateMouse(pos.x, pos.y, NativeMethods.MOUSEEVENTF_MIDDLEUP); _simMiddleDown = false; }
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
        {
            if (_windowTarget == null) return IntPtr.Zero;
            // Enumerate all windows and find by process name
            IntPtr result = IntPtr.Zero;
            NativeMethods.EnumWindows((hwnd, lParam) =>
            {
                if (!NativeMethods.IsWindowVisible(hwnd)) return true;
                NativeMethods.GetWindowThreadProcessId(hwnd, out uint pid);
                IntPtr hProcess = NativeMethods.OpenProcess(NativeMethods.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
                if (hProcess == IntPtr.Zero) return true;
                try
                {
                    var sb = new System.Text.StringBuilder(1024);
                    uint len = NativeMethods.GetProcessImageFileName(hProcess, sb, (uint)sb.Capacity);
                    if (len == 0) return true;
                    string fullPath = sb.ToString();
                    string fileName = fullPath.Substring(fullPath.LastIndexOf('\\') + 1);
                    if (!string.IsNullOrEmpty(_windowTarget.ProcessName) &&
                        fileName.Equals(_windowTarget.ProcessName, StringComparison.OrdinalIgnoreCase))
                    {
                        result = hwnd;
                        return false; // stop enumeration
                    }
                }
                finally { NativeMethods.CloseHandle(hProcess); }
                return true;
            }, IntPtr.Zero);
            return result;
        }

        private void SimulateMouse(int x, int y, uint mouseEvent, int mouseData = 0)
        {
            // Convert window-relative coordinates to screen-absolute
            if (_useRelativeCoordinates && _windowTarget != null)
            {
                var hwnd = FindTargetWindow();
                if (hwnd != IntPtr.Zero && NativeMethods.GetWindowRect(hwnd, out var rect))
                {
                    x = x + rect.Left;
                    y = y + rect.Top;
                }
            }

            int vx = NativeMethods.GetSystemMetrics(76); // SM_XVIRTUALSCREEN
            int vy = NativeMethods.GetSystemMetrics(77); // SM_YVIRTUALSCREEN
            int vw = NativeMethods.GetSystemMetrics(78); // SM_CXVIRTUALSCREEN
            int vh = NativeMethods.GetSystemMetrics(79); // SM_CYVIRTUALSCREEN

            int absoluteX = (int)(((double)(x - vx) * 65535) / (vw - 1));
            int absoluteY = (int)(((double)(y - vy) * 65535) / (vh - 1));

            uint posFlags = NativeMethods.MOUSEEVENTF_MOVE
                | NativeMethods.MOUSEEVENTF_ABSOLUTE
                | NativeMethods.MOUSEEVENTF_VIRTUALDESK;

            int inputSize = Marshal.SizeOf(typeof(NativeMethods.INPUT));

            // Step 1: SetCursorPos (for apps using GetCursorPos)
            NativeMethods.SetCursorPos(x, y);

            // Step 2: SendInput MOVE (for apps using Raw Input)
            var moveInput = new NativeMethods.INPUT
            {
                type = NativeMethods.INPUT_MOUSE,
                U = new NativeMethods.InputUnion
                {
                    mi = new NativeMethods.MOUSEINPUT
                    {
                        dx = absoluteX,
                        dy = absoluteY,
                        dwFlags = posFlags,
                    }
                }
            };
            NativeMethods.SendInput(1, new[] { moveInput }, inputSize);

            // Step 3: Wait for the target app to process the move (~1 frame)
            Thread.Sleep(10);

            // Step 4: Fire button/scroll with position embedded in the event
            var clickInput = new NativeMethods.INPUT
            {
                type = NativeMethods.INPUT_MOUSE,
                U = new NativeMethods.InputUnion
                {
                    mi = new NativeMethods.MOUSEINPUT
                    {
                        dx = absoluteX,
                        dy = absoluteY,
                        mouseData = (uint)mouseData,
                        dwFlags = mouseEvent | posFlags,
                    }
                }
            };
            NativeMethods.SendInput(1, new[] { clickInput }, inputSize);
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
                dispatcherQueue.TryEnqueue(async () =>
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
                });
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
            dispatcherQueue.TryEnqueue(async () =>
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
            });
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
                catch { }
            });
        }

        private async Task ExecuteWaitImage(ActionItem action, CancellationToken token)
        {
            if (string.IsNullOrEmpty(action.ImagePath)) return;

            string profileName = _getProfileName?.Invoke() ?? "default";
            var referenceImage = ImageStorageService.LoadReferenceImage(profileName, action.ImagePath);
            if (referenceImage == null) return;

            try
            {
                var matchResult = await ImageMatchingService.WaitForImageAsync(
                    referenceImage,
                    action.Confidence > 0 ? action.Confidence : 0.8,
                    action.Timeout > 0 ? action.Timeout : 30000,
                    token);

                if (matchResult == null && !token.IsCancellationRequested)
                {
                    var seconds = (action.Timeout > 0 ? action.Timeout : 30000) / 1000;
                    throw new TimeoutException($"Wait for Image timed out after {seconds}s. Make sure the target image is visible on screen and the confidence threshold is not too high.");
                }
            }
            finally
            {
                referenceImage.Dispose();
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

        private static readonly HashSet<ushort> ExtendedVkCodes = new()
        {
            0x21, 0x22, 0x23, 0x24, // PgUp, PgDn, End, Home
            0x25, 0x26, 0x27, 0x28, // Left, Up, Right, Down
            0x2D, 0x2E              // Insert, Delete
        };

        private void SimulateKeyPress(ushort vk)
        {
            ushort scan = (ushort)NativeMethods.MapVirtualKey(vk, 0);
            bool isExtended = ExtendedVkCodes.Contains(vk);
            bool isDirectional = vk >= 0x25 && vk <= 0x28;
            uint downFlags = NativeMethods.KEYEVENTF_SCANCODE;
            if (isExtended) downFlags |= NativeMethods.KEYEVENTF_EXTENDEDKEY;
            uint upFlags = downFlags | NativeMethods.KEYEVENTF_KEYUP;
            ushort effectiveVk = isDirectional ? (ushort)0 : vk;

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
            dispatcherQueue.TryEnqueue(() =>
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
            });

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

        private void SimulateKey(string key, bool isDown)
        {
            if (!Helpers.KeyUtils.TryResolveVirtualKeyCode(key, out ushort vk)) return;
            bool isDirectionalKey = key is "Left" or "Right" or "Up" or "Down";
            ushort scan = (ushort)NativeMethods.MapVirtualKey(vk, 0);

            var input = new NativeMethods.INPUT
            {
                type = NativeMethods.INPUT_KEYBOARD,
                U = new NativeMethods.InputUnion
                {
                    ki = new NativeMethods.KEYBDINPUT
                    {
                        wVk = isDirectionalKey ? (ushort)0 : vk,
                        wScan = scan,
                        dwFlags = isDown ? 0u : NativeMethods.KEYEVENTF_KEYUP,
                        time = 0,
                        dwExtraInfo = IntPtr.Zero
                    }
                }
            };

            if (isDirectionalKey)
            {
                input.U.ki.dwFlags |= NativeMethods.KEYEVENTF_SCANCODE | NativeMethods.KEYEVENTF_EXTENDEDKEY;
            }
            else
            {
                input.U.ki.dwFlags |= NativeMethods.KEYEVENTF_SCANCODE;
            }

            NativeMethods.SendInput(1, new[] { input }, Marshal.SizeOf(typeof(NativeMethods.INPUT)));
        }
    }
}
