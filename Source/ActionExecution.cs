using CommunityToolkit.WinUI.UI.Controls;
using Microsoft.UI;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
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
        private readonly Button recordingButton;
        private readonly Func<bool> getMouse, getScroll, getKeyboard;
        private readonly Action<DateTime> setLastActionTime;

        public bool IsRecording { get; private set; }

        public RecordingService(ActionRecorder recorder, Button recordingButton, Func<bool> getMouse, Func<bool> getScroll, Func<bool> getKeyboard, Action<DateTime> setLastActionTime)
        {
            this.recorder = recorder;
            this.recordingButton = recordingButton;
            this.getMouse = getMouse;
            this.getScroll = getScroll;
            this.getKeyboard = getKeyboard;
            this.setLastActionTime = setLastActionTime;
        }

        public void ToggleRecording()
        {
            if (IsRecording) StopRecording();
            else StartRecording();
        }

        private void StartRecording()
        {
            IsRecording = true;
            recordingButton.Content = "Pause";
            recordingButton.Background = new SolidColorBrush(Colors.Orange);
            recorder.RecordMouse = getMouse();
            recorder.RecordScroll = getScroll();
            recorder.RecordKeyboard = getKeyboard();
            recorder.Start();
            setLastActionTime(DateTime.Now);
        }

        private void StopRecording()
        {
            IsRecording = false;
            recordingButton.Content = "Recording";
            recordingButton.ClearValue(Button.BackgroundProperty);
            recorder.Stop();
        }
    }

    public class ReplayService
    {
        private readonly DataGrid actionsGrid;
        private readonly ObservableCollection<ActionItem> actions;
        private readonly ActionReplayer replayer;
        private readonly Button replayButton;
        private readonly DispatcherQueue dispatcherQueue;
        private readonly Action updateButtonStates;

        public bool IsReplaying { get; private set; }

        public ReplayService(ObservableCollection<ActionItem> actions, Button replayButton, DispatcherQueue dispatcherQueue, Action updateButtonStates, DataGrid actionsGrid)
        {
            this.actions = actions;
            this.replayer = new ActionReplayer(actions, dispatcherQueue);
            this.replayButton = replayButton;
            this.dispatcherQueue = dispatcherQueue;
            this.updateButtonStates = updateButtonStates;
            this.actionsGrid = actionsGrid;

            replayer.OnActionExecuting += (action) =>
            {
                dispatcherQueue.TryEnqueue(() =>
                {
                    actionsGrid.SelectedItem = action;
                    actionsGrid.ScrollIntoView(action, null);
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
            replayButton.Content = "Stop";
            replayButton.Background = new SolidColorBrush(Colors.Orange);

            int loopCount = loopEnabled && int.TryParse(loopCountText, out int count) && count >= 0 ? count : 1;
            int loopInterval = intervalEnabled && int.TryParse(intervalText, out int interval) && interval >= 0 ? interval : 0;
            replayer.SetLoopOptions(loopCount, loopInterval);

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
            replayButton.Content = "Replay";
            replayButton.ClearValue(Button.BackgroundProperty);
            updateButtonStates();
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

        public bool RecordMouse { get; set; } = true;
        public bool RecordScroll { get; set; } = true;
        public bool RecordKeyboard { get; set; } = true;

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
        }

        public bool IsRecording => _isRecording;

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
            }
            else if (!isDown)
            {
                AddAction(new ActionItem { ActionType = actionType, Key = key, Delay = delay });
                _pressedKeys.Remove(key);
            }
        }

        public void RecordMouseAction(string button, int x, int y, bool isDown, int scrollDelta = 0)
        {
            if (!_isRecording) return;
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
            NativeMethods.SetCursorPos(x, y);

            var input = new NativeMethods.INPUT
            {
                type = NativeMethods.INPUT_MOUSE,
                U = new NativeMethods.InputUnion
                {
                    mi = new NativeMethods.MOUSEINPUT
                    {
                        dx = 0,
                        dy = 0,
                        mouseData = (uint)mouseData,
                        dwFlags = mouseEvent,
                        time = 0,
                        dwExtraInfo = IntPtr.Zero
                    }
                }
            };

            NativeMethods.SendInput(1, new[] { input }, Marshal.SizeOf(typeof(NativeMethods.INPUT)));
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