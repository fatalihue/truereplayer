using Microsoft.UI.Dispatching;
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using TrueReplayer.Models;
using TrueReplayer.Interop;


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
            Action<int>? onActionHighlight = null)
        {
            this.actions = actions;
            this.replayer = new ActionReplayer(actions, dispatcherQueue);
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
        }

        public void ToggleReplay(bool loopEnabled, string loopCountText, bool intervalEnabled, string intervalText)
        {
            if (!IsReplaying && actions.Count > 0)
                StartReplay(loopEnabled, loopCountText, intervalEnabled, intervalText);
            else if (IsReplaying)
                StopReplay();
        }

        private void StartReplay(bool loopEnabled, string loopCountText, bool intervalEnabled, string intervalText)
        {
            IsReplaying = true;
            onButtonStateChanged?.Invoke("Stop", true);

            int loopCount = loopEnabled && int.TryParse(loopCountText, out int count) && count >= 0 ? count : 1;
            int loopInterval = intervalEnabled && int.TryParse(intervalText, out int interval) && interval >= 0 ? interval : 0;
            replayer.SetLoopOptions(loopCount, loopInterval);

            onStatusChanged?.Invoke("replaying");

            _ = replayer.StartAsync().ContinueWith(_ =>
            {
                dispatcherQueue.TryEnqueue(() => ResetReplayState());
            });
        }

        private void StopReplay()
        {
            replayer.Stop();
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

            AddAction(new ActionItem { ActionType = actionType, X = x, Y = y, Delay = delay });
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
        private CancellationTokenSource? _cts;
        private int _loopCount = 0;
        private int _loopInterval = 0;

        public event Action<ActionItem>? OnActionExecuting;

        public ActionReplayer(ObservableCollection<ActionItem> actions, DispatcherQueue dispatcherQueue)
        {
            _actions = actions;
            this.dispatcherQueue = dispatcherQueue;
        }

        public void SetLoopOptions(int loopCount, int loopInterval)
        {
            _loopCount = loopCount >= 0 ? loopCount : 0;
            _loopInterval = loopInterval >= 0 ? loopInterval : 0;
        }

        public async Task StartAsync()
        {
            _cts?.Dispose();
            _cts = new CancellationTokenSource();
            var token = _cts.Token;
            int iteration = 0;
            bool isInfinite = _loopCount == 0;

            try
            {
                await WaitForHotkeyReleaseAsync(token);

                while (!token.IsCancellationRequested && (isInfinite || iteration < _loopCount))
                {
                    iteration++;

                    for (int i = 0; i < _actions.Count; i++)
                    {
                        if (token.IsCancellationRequested) break;
                        var action = _actions[i];
                        int safeDelay = Math.Max(0, action.Delay);

                        await Task.Delay(safeDelay, token);
                        dispatcherQueue.TryEnqueue(() => OnActionExecuting?.Invoke(action));
                        InputHookManager.IsReplayingAction = true;

                        try
                        {
                            switch (action.ActionType)
                            {
                                case "KeyDown": SimulateKey(action.Key, true); break;
                                case "KeyUp": SimulateKey(action.Key, false); break;
                                case "LeftClickDown": SimulateMouse(action.X, action.Y, NativeMethods.MOUSEEVENTF_LEFTDOWN); break;
                                case "LeftClickUp": SimulateMouse(action.X, action.Y, NativeMethods.MOUSEEVENTF_LEFTUP); break;
                                case "RightClickDown": SimulateMouse(action.X, action.Y, NativeMethods.MOUSEEVENTF_RIGHTDOWN); break;
                                case "RightClickUp": SimulateMouse(action.X, action.Y, NativeMethods.MOUSEEVENTF_RIGHTUP); break;
                                case "MiddleClickDown": SimulateMouse(action.X, action.Y, NativeMethods.MOUSEEVENTF_MIDDLEDOWN); break;
                                case "MiddleClickUp": SimulateMouse(action.X, action.Y, NativeMethods.MOUSEEVENTF_MIDDLEUP); break;
                                case "ScrollUp": SimulateMouse(action.X, action.Y, NativeMethods.MOUSEEVENTF_WHEEL, 120); break;
                                case "ScrollDown": SimulateMouse(action.X, action.Y, NativeMethods.MOUSEEVENTF_WHEEL, -120); break;
                                case "SendText": await SimulateClipboardPaste(action.Key, token); break;
                            }
                        }
                        finally
                        {
                            InputHookManager.IsReplayingAction = false;
                        }
                    }

                    if (!token.IsCancellationRequested && (isInfinite || iteration < _loopCount) && _loopInterval > 0)
                        await Task.Delay(_loopInterval, token);
                }
            }
            catch (TaskCanceledException) { }
        }

        private static readonly Dictionary<string, int> ModifierGenericVkCodes = new(StringComparer.OrdinalIgnoreCase)
        {
            ["Ctrl"] = 0x11,   // VK_CONTROL (left or right)
            ["Alt"] = 0x12,    // VK_MENU (left or right)
            ["Shift"] = 0x10,  // VK_SHIFT (left or right)
        };

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
            _cts?.Cancel();
            _cts?.Dispose();
            _cts = null;
            ResetMouseState();
        }

        private void ResetMouseState()
        {
            NativeMethods.GetCursorPos(out var pos);
            SimulateMouse(pos.x, pos.y, NativeMethods.MOUSEEVENTF_LEFTUP);
            SimulateMouse(pos.x, pos.y, NativeMethods.MOUSEEVENTF_RIGHTUP);
            SimulateMouse(pos.x, pos.y, NativeMethods.MOUSEEVENTF_MIDDLEUP);
        }

        private void SimulateMouse(int x, int y, uint mouseEvent, int mouseData = 0)
        {
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

            // Resolve {clipboard} placeholder using the saved clipboard content
            if (text.Contains("{clipboard}", StringComparison.OrdinalIgnoreCase))
            {
                text = text.Replace("{clipboard}", originalClipboard ?? "", StringComparison.OrdinalIgnoreCase);
            }

            // Resolve {datetime} before {date}/{time} to avoid partial matches
            var now = DateTime.Now;
            if (text.Contains("{datetime}", StringComparison.OrdinalIgnoreCase))
                text = text.Replace("{datetime}", now.ToString("dd/MM/yyyy HH:mm:ss"), StringComparison.OrdinalIgnoreCase);
            if (text.Contains("{date}", StringComparison.OrdinalIgnoreCase))
                text = text.Replace("{date}", now.ToString("dd/MM/yyyy"), StringComparison.OrdinalIgnoreCase);
            if (text.Contains("{time}", StringComparison.OrdinalIgnoreCase))
                text = text.Replace("{time}", now.ToString("HH:mm:ss"), StringComparison.OrdinalIgnoreCase);

            if (string.IsNullOrEmpty(text) || token.IsCancellationRequested) return;

            // Parse text into segments: plain text + special key placeholders
            var segments = ParseSendTextSegments(text);

            foreach (var segment in segments)
            {
                if (token.IsCancellationRequested) break;

                if (segment.VkCode.HasValue)
                {
                    // Special key: simulate key down + up
                    SimulateKeyPress(segment.VkCode.Value);
                    await Task.Delay(30, token);
                }
                else if (!string.IsNullOrEmpty(segment.Text))
                {
                    // Text: paste via clipboard
                    await PasteTextViaClipboard(segment.Text, token);
                }
            }

            // Restore original clipboard content on UI thread
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

        private static readonly Dictionary<string, ushort> SpecialKeyPlaceholders = new(StringComparer.OrdinalIgnoreCase)
        {
            ["{enter}"] = 0x0D,      // VK_RETURN
            ["{tab}"] = 0x09,        // VK_TAB
            ["{backspace}"] = 0x08,  // VK_BACK
        };

        private struct SendTextSegment
        {
            public string? Text;
            public ushort? VkCode;
        }

        private static List<SendTextSegment> ParseSendTextSegments(string text)
        {
            var segments = new List<SendTextSegment>();
            int i = 0;

            while (i < text.Length)
            {
                if (text[i] == '{')
                {
                    // Try to match a special key placeholder
                    bool matched = false;
                    foreach (var kv in SpecialKeyPlaceholders)
                    {
                        if (i + kv.Key.Length <= text.Length &&
                            text.Substring(i, kv.Key.Length).Equals(kv.Key, StringComparison.OrdinalIgnoreCase))
                        {
                            segments.Add(new SendTextSegment { VkCode = kv.Value });
                            i += kv.Key.Length;
                            matched = true;
                            break;
                        }
                    }
                    if (!matched)
                    {
                        // Not a placeholder, treat '{' as regular text
                        AppendTextChar(segments, text[i]);
                        i++;
                    }
                }
                else
                {
                    AppendTextChar(segments, text[i]);
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

        private void SimulateKeyPress(ushort vk)
        {
            ushort scan = (ushort)NativeMethods.MapVirtualKey(vk, 0);
            var inputs = new NativeMethods.INPUT[]
            {
                new() { type = NativeMethods.INPUT_KEYBOARD, U = new NativeMethods.InputUnion { ki = new NativeMethods.KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = NativeMethods.KEYEVENTF_SCANCODE } } },
                new() { type = NativeMethods.INPUT_KEYBOARD, U = new NativeMethods.InputUnion { ki = new NativeMethods.KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = NativeMethods.KEYEVENTF_KEYUP | NativeMethods.KEYEVENTF_SCANCODE } } },
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
