using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using TrueReplayer.Controllers;
using TrueReplayer.Helpers;
using TrueReplayer.Interop;
using TrueReplayer.Models;

namespace TrueReplayer
{
    public static class InputHookManager
    {
        public static event Action<string, int, int, bool, int>? OnMouseEvent;
        public static event Action<string, bool>? OnKeyEvent;
        public static event Action<string>? OnHotkeyPressed;

        private static IntPtr _mouseHookId = IntPtr.Zero;
        private static IntPtr _keyboardHookId = IntPtr.Zero;

        private static NativeMethods.LowLevelMouseProc _mouseProc = MouseHookCallback;
        private static NativeMethods.LowLevelKeyboardProc _keyboardProc = KeyboardHookCallback;

        private static DateTime? lastAltRightPressTime = null;

        public static volatile Dictionary<string, string> ProfileHotkeys = new();
        public static volatile Dictionary<string, HotstringConfig> ProfileHotstrings = new();
        public static volatile Dictionary<string, TriggerMode> ProfileTriggerModes = new();

        // Tracks VK codes currently held down to suppress Windows auto-repeat. Keyed by vkCode
        // (physical key) rather than the composed hotkey string, because the composed string can
        // change between key-down and key-up if the user releases modifiers in a different order
        // than they pressed them (which would leak entries and make the next press look like a repeat).
        private static readonly HashSet<int> _vkCodesCurrentlyDown = new();

        // When WhilePressed mode is active, records which profile is currently running tied to
        // which PHYSICAL key (vkCode), so releasing that key stops the replay. Tracked by
        // vkCode (not composed key) so modifier-state flicker between down and up doesn't
        // break the release match. volatile for cross-thread visibility.
        private static volatile string? _activeHoldProfile = null;
        private static volatile int _activeHoldVkCode = 0;

        // Debounce: WhilePressed only starts the replay if the key is held for at least this
        // many milliseconds. Prevents an accidental brush against the key from triggering.
        private const int WhilePressedDebounceMs = 120;
        private static System.Threading.Timer? _holdDebounceTimer;
        private static volatile bool _holdConfirmed = false;

        /// <summary>
        /// Exposes whether a WhilePressed hold is still active for a given profile. Used by
        /// the MainWindow dispatcher to detect when the user released the key BEFORE the async
        /// replay-start handler had a chance to run — in that case we skip starting the replay
        /// instead of leaving it looping forever.
        /// </summary>
        public static bool IsHoldActiveForProfile(string profileName) => _activeHoldProfile == profileName;

        // Window targets and compiled regexes are bundled together for atomic access
        private sealed class WindowTargetSnapshot
        {
            public Dictionary<string, WindowTarget> Targets { get; init; } = new();
            public Dictionary<string, Regex?> CompiledRegexes { get; init; } = new();
            public HashSet<string> BringToFocusProfiles { get; init; } = new();
        }
        private static volatile WindowTargetSnapshot _windowTargets = new();

        // Hotstring character buffer (accessed only from hook thread)
        private static readonly char[] _hotstringBuffer = new char[64];
        private static int _hotstringBufferLen = 0;
        private static readonly HashSet<int> _terminatorVkCodes = new() { 0x0D, 0x20, 0x09 }; // Enter, Space, Tab

        public static bool IsReplayingAction { get; set; } = false;

        public static string? LastTriggerHotkey { get; set; }

        public static bool IgnoreProfileHotkeys { get; set; } = false;

        /// When true, suppresses ALL hotkey matching and key/mouse event recording.
        /// Used when a UI dialog/modal is active (SendText, Rename, Hotkey Capture, ContentDialogs).
        public static bool SuppressAllHotkeys { get; set; } = false;

        /// When true, mouse click events (Down/Up) are swallowed (not passed to the target app).
        /// Used during capture mode to capture coordinates without performing the actual click.
        public static bool SuppressMouseClick { get; set; } = false;

        public static void Start()
        {
            if (_mouseHookId == IntPtr.Zero)
                _mouseHookId = NativeMethods.SetMouseHook(_mouseProc);
            if (_keyboardHookId == IntPtr.Zero)
                _keyboardHookId = NativeMethods.SetKeyboardHook(_keyboardProc);
        }

        public static void Stop()
        {
            if (_mouseHookId != IntPtr.Zero)
            {
                NativeMethods.UnhookWindowsHookEx(_mouseHookId);
                _mouseHookId = IntPtr.Zero;
            }
            if (_keyboardHookId != IntPtr.Zero)
            {
                NativeMethods.UnhookWindowsHookEx(_keyboardHookId);
                _keyboardHookId = IntPtr.Zero;
            }
        }


        public static void RegisterProfileHotkeys(Dictionary<string, string> profileHotkeys)
        {
            ProfileHotkeys = profileHotkeys;
        }

        public static void RegisterProfileHotstrings(Dictionary<string, HotstringConfig> hotstrings)
        {
            ProfileHotstrings = hotstrings;
            _hotstringBufferLen = 0;
        }

        public static void RegisterProfileTriggerModes(Dictionary<string, TriggerMode> modes)
        {
            ProfileTriggerModes = modes;
        }

        /// <summary>
        /// Called from MainWindow when replay ends, so Toggle mode's "pressing again stops it"
        /// logic doesn't get stuck thinking a stopped replay is still running.
        /// </summary>
        public static void ClearActiveHold()
        {
            _activeHoldProfile = null;
            _activeHoldVkCode = 0;
            _holdConfirmed = false;
            _holdDebounceTimer?.Dispose();
            _holdDebounceTimer = null;
        }

        public static void RegisterProfileWindowTargets(Dictionary<string, WindowTarget> targets, HashSet<string>? bringToFocusProfiles = null)
        {
            var regexes = new Dictionary<string, Regex?>();
            foreach (var (name, target) in targets)
            {
                if (target.TitleMatchMode == "regex" && !string.IsNullOrEmpty(target.WindowTitle))
                {
                    try
                    {
                        regexes[name] = new Regex(target.WindowTitle,
                            RegexOptions.IgnoreCase | RegexOptions.Compiled,
                            TimeSpan.FromMilliseconds(5));
                    }
                    catch
                    {
                        regexes[name] = null;
                    }
                }
            }
            // Assign both atomically as a single snapshot
            _windowTargets = new WindowTargetSnapshot
            {
                Targets = targets,
                CompiledRegexes = regexes,
                BringToFocusProfiles = bringToFocusProfiles ?? new HashSet<string>()
            };
        }

        private static readonly StringBuilder _windowTextBuffer = new(512);
        private static readonly StringBuilder _processNameBuffer = new(512);

        private static bool IsForegroundWindowMatch(string profileName)
        {
            // Read snapshot once for consistent access
            var wt = _windowTargets;

            // Bring to Focus profiles skip foreground check — they fire from any window
            if (wt.BringToFocusProfiles.Contains(profileName))
                return true;

            if (!wt.Targets.TryGetValue(profileName, out var target))
                return true;

            IntPtr hwnd = NativeMethods.GetForegroundWindow();
            if (hwnd == IntPtr.Zero)
                return false;

            if (!string.IsNullOrEmpty(target.WindowTitle))
            {
                _windowTextBuffer.Clear();
                NativeMethods.GetWindowText(hwnd, _windowTextBuffer, _windowTextBuffer.Capacity);
                string title = _windowTextBuffer.ToString();

                if (target.TitleMatchMode == "regex")
                {
                    if (wt.CompiledRegexes.TryGetValue(profileName, out var regex) && regex != null)
                    {
                        try
                        {
                            if (!regex.IsMatch(title))
                                return false;
                        }
                        catch (RegexMatchTimeoutException)
                        {
                            return false;
                        }
                    }
                    else
                    {
                        return false;
                    }
                }
                else
                {
                    if (title.IndexOf(target.WindowTitle, StringComparison.OrdinalIgnoreCase) < 0)
                        return false;
                }
            }

            if (!string.IsNullOrEmpty(target.ProcessName))
            {
                NativeMethods.GetWindowThreadProcessId(hwnd, out uint pid);
                IntPtr hProcess = NativeMethods.OpenProcess(
                    NativeMethods.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);

                if (hProcess == IntPtr.Zero)
                    return false;

                try
                {
                    _processNameBuffer.Clear();
                    uint len = NativeMethods.GetProcessImageFileName(
                        hProcess, _processNameBuffer, (uint)_processNameBuffer.Capacity);

                    if (len == 0)
                        return false;

                    string fullPath = _processNameBuffer.ToString();
                    string fileName = fullPath.Substring(fullPath.LastIndexOf('\\') + 1);

                    if (!fileName.Equals(target.ProcessName, StringComparison.OrdinalIgnoreCase))
                        return false;
                }
                finally
                {
                    NativeMethods.CloseHandle(hProcess);
                }
            }

            return true;
        }

        #region Hotstring Helpers

        private static char? VkCodeToChar(int vkCode)
        {
            if (vkCode >= 0x41 && vkCode <= 0x5A) return (char)('a' + (vkCode - 0x41)); // A-Z → a-z
            if (vkCode >= 0x30 && vkCode <= 0x39) return (char)('0' + (vkCode - 0x30)); // 0-9

            // Use MapVirtualKeyEx for OEM keys — safe inside keyboard hook
            // (unlike ToUnicodeEx, does NOT destroy the OS dead key state)
            try
            {
                uint threadId = NativeMethods.GetWindowThreadProcessId(
                    NativeMethods.GetForegroundWindow(), out _);
                IntPtr hkl = NativeMethods.GetKeyboardLayout(threadId);

                // MAPVK_VK_TO_CHAR = 2
                uint mapped = NativeMethods.MapVirtualKeyEx((uint)vkCode, 2, hkl);
                if (mapped == 0) return null;

                char ch = char.ToLower((char)(mapped & 0x7FFFFFFF));
                if (!char.IsControl(ch))
                    return ch;
            }
            catch { }

            return null;
        }

        private static void HotstringBufferAppend(char c)
        {
            if (_hotstringBufferLen >= _hotstringBuffer.Length)
            {
                int half = _hotstringBuffer.Length / 2;
                Array.Copy(_hotstringBuffer, half, _hotstringBuffer, 0, _hotstringBufferLen - half);
                _hotstringBufferLen -= half;
            }
            _hotstringBuffer[_hotstringBufferLen++] = c;
        }

        private static void HotstringBufferClear()
        {
            _hotstringBufferLen = 0;
        }

        private static string? CheckHotstringMatch(bool isTerminator)
        {
            if (_hotstringBufferLen == 0 || ProfileHotstrings.Count == 0)
                return null;

            var bufferSpan = new ReadOnlySpan<char>(_hotstringBuffer, 0, _hotstringBufferLen);
            string? bestMatch = null;
            int bestLen = 0;

            foreach (var (profileName, config) in ProfileHotstrings)
            {
                var seq = config.Sequence;
                if (seq.Length == 0 || seq.Length > _hotstringBufferLen)
                    continue;

                if (!config.Instant && !isTerminator)
                    continue;

                var tail = bufferSpan.Slice(_hotstringBufferLen - seq.Length);
                if (tail.SequenceEqual(seq.AsSpan()))
                {
                    // Prefer the longest match that also matches the foreground window
                    if (seq.Length >= bestLen && IsForegroundWindowMatch(profileName))
                    {
                        bestLen = seq.Length;
                        bestMatch = profileName;
                    }
                }
            }

            return bestMatch;
        }

        private static void EraseCharacters(int count)
        {
            if (count <= 0) return;

            bool wasReplaying = IsReplayingAction;
            IsReplayingAction = true;

            try
            {
                int inputSize = Marshal.SizeOf(typeof(NativeMethods.INPUT));
                ushort vkBack = 0x08;
                ushort scanBack = (ushort)NativeMethods.MapVirtualKey(vkBack, 0);

                for (int i = 0; i < count; i++)
                {
                    var inputs = new NativeMethods.INPUT[]
                    {
                        new() { type = NativeMethods.INPUT_KEYBOARD, U = new NativeMethods.InputUnion {
                            ki = new NativeMethods.KEYBDINPUT { wVk = vkBack, wScan = scanBack, dwFlags = NativeMethods.KEYEVENTF_SCANCODE } } },
                        new() { type = NativeMethods.INPUT_KEYBOARD, U = new NativeMethods.InputUnion {
                            ki = new NativeMethods.KEYBDINPUT { wVk = vkBack, wScan = scanBack, dwFlags = NativeMethods.KEYEVENTF_KEYUP | NativeMethods.KEYEVENTF_SCANCODE } } },
                    };
                    NativeMethods.SendInput((uint)inputs.Length, inputs, inputSize);
                }
            }
            finally
            {
                IsReplayingAction = wasReplaying;
            }
        }

        #endregion

        private static IntPtr MouseHookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0 && !SuppressAllHotkeys)
            {
                var hookStruct = Marshal.PtrToStructure<NativeMethods.MSLLHOOKSTRUCT>(lParam);
                string? button = null;
                bool isDown = false;
                int scrollDelta = 0;

                switch ((int)wParam)
                {
                    case NativeMethods.WM_LBUTTONDOWN:
                        button = "Left"; isDown = true; break;
                    case NativeMethods.WM_LBUTTONUP:
                        button = "Left"; isDown = false; break;
                    case NativeMethods.WM_RBUTTONDOWN:
                        button = "Right"; isDown = true; break;
                    case NativeMethods.WM_RBUTTONUP:
                        button = "Right"; isDown = false; break;
                    case NativeMethods.WM_MBUTTONDOWN:
                        button = "Middle"; isDown = true; break;
                    case NativeMethods.WM_MBUTTONUP:
                        button = "Middle"; isDown = false; break;
                    case NativeMethods.WM_MOUSEWHEEL:
                        button = "Scroll";
                        scrollDelta = (short)((hookStruct.mouseData >> 16) & 0xffff);
                        break;
                }

                // Check scroll events against profile hotkeys
                if ((int)wParam == NativeMethods.WM_MOUSEWHEEL && !IgnoreProfileHotkeys && !IsReplayingAction &&
                    UserProfile.Current.ProfileKeyEnabled && ProfileHotkeys.Count > 0 &&
                    MainController.Instance != null && !MainController.Instance.IsRecording())
                {
                    string scrollKey = scrollDelta > 0 ? "ScrollUp" : "ScrollDown";

                    bool ctrlHeld = (NativeMethods.GetAsyncKeyState(0x11) & 0x8000) != 0;
                    bool altHeld = (NativeMethods.GetAsyncKeyState(0x12) & 0x8000) != 0;
                    bool shiftHeld = (NativeMethods.GetAsyncKeyState(0x10) & 0x8000) != 0;

                    var parts = new List<string>();
                    if (ctrlHeld) parts.Add("Ctrl");
                    if (altHeld) parts.Add("Alt");
                    if (shiftHeld) parts.Add("Shift");
                    parts.Add(scrollKey);
                    string combo = string.Join("+", parts);

                    string? matchedProfile = null;
                    foreach (var p in ProfileHotkeys)
                    {
                        if (p.Value == combo && IsForegroundWindowMatch(p.Key))
                        {
                            matchedProfile = p.Key;
                            break;
                        }
                    }
                    if (matchedProfile != null)
                    {
                        LastTriggerHotkey = combo;
                        OnHotkeyPressed?.Invoke($"PROFILE::{matchedProfile}");
                        return (IntPtr)1;
                    }
                }

                if (button != null)
                {
                    if ((int)wParam != NativeMethods.WM_MOUSEWHEEL)
                        _hotstringBufferLen = 0;

                    // Snapshot suppress state before invoking event (callback may clear the flag)
                    bool shouldSuppress = SuppressMouseClick && button != "Scroll";

                    OnMouseEvent?.Invoke(button, hookStruct.pt.x, hookStruct.pt.y, isDown, scrollDelta);

                    // In capture mode, swallow mouse clicks so they don't reach the target app
                    if (shouldSuppress)
                        return (IntPtr)1;
                }
            }

            return NativeMethods.CallNextHookEx(_mouseHookId, nCode, wParam, lParam);
        }

        private static string GetKeyName(int vkCode)
        {
            return KeyUtils.NormalizeKeyName(vkCode) ?? SafeKeyFallback(vkCode);
        }

        private static string BuildComposedKey(int vkCode)
        {
            bool ctrlPressed = (NativeMethods.GetAsyncKeyState(0x11) & 0x8000) != 0; // VK_CONTROL
            bool altPressed = (NativeMethods.GetAsyncKeyState(0x12) & 0x8000) != 0;  // VK_MENU (Alt)
            bool shiftPressed = (NativeMethods.GetAsyncKeyState(0x10) & 0x8000) != 0; // VK_SHIFT

            string? mainKey = KeyUtils.NormalizeKeyName(vkCode) ?? SafeKeyFallback(vkCode);

            var parts = new List<string>();
            if (ctrlPressed) parts.Add("Ctrl");
            if (altPressed) parts.Add("Alt");
            if (shiftPressed) parts.Add("Shift");

            if (!string.IsNullOrEmpty(mainKey) && !parts.Contains(mainKey, StringComparer.OrdinalIgnoreCase))
                parts.Add(mainKey);

            return string.Join("+", parts);
        }

        private static string SafeKeyFallback(int vkCode)
        {
            try
            {
                return ((Windows.System.VirtualKey)vkCode).ToString();
            }
            catch
            {
                return $"VK_{vkCode}";
            }
        }

        private static IntPtr KeyboardHookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                if (SuppressAllHotkeys)
                {
                    return NativeMethods.CallNextHookEx(_keyboardHookId, nCode, wParam, lParam);
                }

                if (IgnoreProfileHotkeys)
                {
                    return NativeMethods.CallNextHookEx(_keyboardHookId, nCode, wParam, lParam);
                }

                int vkCode = Marshal.ReadInt32(lParam);
                bool isDown = wParam == (IntPtr)NativeMethods.WM_KEYDOWN || wParam == (IntPtr)0x0104;

                if (vkCode == 165 && isDown)
                {
                    lastAltRightPressTime = DateTime.Now;
                }

                if (vkCode == 162 && isDown && lastAltRightPressTime != null)
                {
                    var elapsed = DateTime.Now - lastAltRightPressTime.Value;
                    if (elapsed.TotalMilliseconds < 100)
                    {
                        return NativeMethods.CallNextHookEx(_keyboardHookId, nCode, wParam, lParam);
                    }
                }

                string key = BuildComposedKey(vkCode);
                string keyName = GetKeyName(vkCode);

                if (string.IsNullOrEmpty(keyName))
                {
                    return NativeMethods.CallNextHookEx(_keyboardHookId, nCode, wParam, lParam);
                }

                bool isProfileKey = ProfileHotkeys.ContainsValue(key);

                // Auto-repeat detection: Windows fires WM_KEYDOWN repeatedly while a key is held.
                // Only the first down counts for hotkey triggers; repeats are ignored. Keyed by
                // vkCode (physical key) so modifier release order doesn't desync the set.
                bool isRepeat = isDown && _vkCodesCurrentlyDown.Contains(vkCode);
                if (isDown) _vkCodesCurrentlyDown.Add(vkCode);
                else _vkCodesCurrentlyDown.Remove(vkCode);

                if (isDown)
                {
                    // Global hotkeys — always OnPress, ignore auto-repeat
                    if (!isRepeat)
                    {
                        if (key == UserProfile.Current.RecordingHotkey)
                        {
                            OnHotkeyPressed?.Invoke(key);
                            return (IntPtr)1;
                        }

                        if (key == UserProfile.Current.ReplayHotkey)
                        {
                            LastTriggerHotkey = key;
                            OnHotkeyPressed?.Invoke(key);
                            return (IntPtr)1;
                        }

                        if (key == UserProfile.Current.ProfileKeyToggleHotkey)
                        {
                            OnHotkeyPressed?.Invoke(key);
                            return (IntPtr)1;
                        }

                        if (key == UserProfile.Current.ForegroundHotkey)
                        {
                            OnHotkeyPressed?.Invoke(key);
                            return (IntPtr)1;
                        }
                    }
                    else
                    {
                        // Repeat press of a global hotkey — swallow, don't re-fire
                        if (key == UserProfile.Current.RecordingHotkey
                            || key == UserProfile.Current.ReplayHotkey
                            || key == UserProfile.Current.ProfileKeyToggleHotkey
                            || key == UserProfile.Current.ForegroundHotkey)
                        {
                            return (IntPtr)1;
                        }
                    }

                    if (UserProfile.Current.ProfileKeyEnabled && isProfileKey && MainController.Instance != null && !MainController.Instance.IsRecording())
                    {
                        // Find the first profile with this hotkey that matches the foreground window
                        string? matchedProfile = null;
                        foreach (var p in ProfileHotkeys)
                        {
                            if (p.Value == key && IsForegroundWindowMatch(p.Key))
                            {
                                matchedProfile = p.Key;
                                break;
                            }
                        }

                        if (matchedProfile == null)
                        {
                            return NativeMethods.CallNextHookEx(_keyboardHookId, nCode, wParam, lParam);
                        }

                        var triggerMode = ProfileTriggerModes.TryGetValue(matchedProfile, out var tm) ? tm : TriggerMode.OnPress;

                        // Toggle is the only mode that needs to dispatch even when a replay is active
                        // (second press = stop). For other modes, ignore presses during replay.
                        if (IsReplayingAction && triggerMode != TriggerMode.Toggle && triggerMode != TriggerMode.WhilePressed)
                        {
                            return (IntPtr)1; // still swallow to prevent leak
                        }

                        switch (triggerMode)
                        {
                            case TriggerMode.OnPress:
                                if (!isRepeat)
                                {
                                    LastTriggerHotkey = key;
                                    OnHotkeyPressed?.Invoke($"PROFILE::{matchedProfile}");
                                }
                                return (IntPtr)1;

                            case TriggerMode.OnRelease:
                                // Swallow down, fire on up
                                return (IntPtr)1;

                            case TriggerMode.WhilePressed:
                                if (!isRepeat)
                                {
                                    LastTriggerHotkey = key;
                                    _activeHoldProfile = matchedProfile;
                                    _activeHoldVkCode = vkCode;
                                    _holdConfirmed = false;
                                    // Debounce: only fire PROFILE_HOLD after the key has been held
                                    // long enough to be "intentional" — stops accidental brushes
                                    // from kicking off the infinite-loop replay.
                                    var profileCapture = matchedProfile;
                                    var vkCapture = vkCode;
                                    _holdDebounceTimer?.Dispose();
                                    _holdDebounceTimer = new System.Threading.Timer(_ =>
                                    {
                                        // Confirm the hold is still on the same physical key
                                        // (user hasn't released or pressed a different hotkey).
                                        if (_activeHoldVkCode == vkCapture && _activeHoldProfile == profileCapture)
                                        {
                                            _holdConfirmed = true;
                                            OnHotkeyPressed?.Invoke($"PROFILE_HOLD::{profileCapture}");
                                        }
                                    }, null, WhilePressedDebounceMs, System.Threading.Timeout.Infinite);
                                }
                                return (IntPtr)1;

                            case TriggerMode.Toggle:
                                if (!isRepeat)
                                {
                                    LastTriggerHotkey = key;
                                    OnHotkeyPressed?.Invoke($"PROFILE_TOGGLE::{matchedProfile}");
                                }
                                return (IntPtr)1;
                        }
                    }

                    // ── Hotstring buffer management ──
                    if (!IsReplayingAction && UserProfile.Current.ProfileKeyEnabled &&
                        ProfileHotstrings.Count > 0 &&
                        MainController.Instance != null && !MainController.Instance.IsRecording())
                    {
                        if (vkCode == 0x08) // Backspace: pop last char
                        {
                            if (_hotstringBufferLen > 0)
                                _hotstringBufferLen--;
                        }
                        else if (vkCode == 0x1B  // Escape
                              || vkCode == 0x11 || vkCode == 0xA2 || vkCode == 0xA3  // Ctrl
                              || vkCode == 0x12 || vkCode == 0xA4 || vkCode == 0xA5) // Alt
                        {
                            HotstringBufferClear();
                        }
                        else if (_terminatorVkCodes.Contains(vkCode)) // Enter, Space, Tab
                        {
                            var matchedProfile = CheckHotstringMatch(isTerminator: true);
                            if (matchedProfile != null && IsForegroundWindowMatch(matchedProfile))
                            {
                                var config = ProfileHotstrings[matchedProfile];
                                int backspaceCount = config.Sequence.Length; // erase typed chars
                                HotstringBufferClear();
                                EraseCharacters(backspaceCount);

                                LastTriggerHotkey = $"HOTSTRING::{matchedProfile}";
                                OnHotkeyPressed?.Invoke($"PROFILE::{matchedProfile}");
                                return (IntPtr)1; // swallow the terminator key
                            }
                            else
                            {
                                HotstringBufferClear(); // terminator without match resets buffer
                            }
                        }
                        else
                        {
                            char? ch = VkCodeToChar(vkCode);
                            if (ch.HasValue)
                            {
                                HotstringBufferAppend(ch.Value);

                                var matchedProfile = CheckHotstringMatch(isTerminator: false);
                                if (matchedProfile != null && IsForegroundWindowMatch(matchedProfile))
                                {
                                    var config = ProfileHotstrings[matchedProfile];
                                    int backspaceCount = config.Sequence.Length - 1; // previous chars (current key swallowed)
                                    HotstringBufferClear();
                                    if (backspaceCount > 0)
                                        EraseCharacters(backspaceCount);

                                    LastTriggerHotkey = $"HOTSTRING::{matchedProfile}";
                                    OnHotkeyPressed?.Invoke($"PROFILE::{matchedProfile}");
                                    return (IntPtr)1; // swallow current key
                                }
                            }
                            else if (vkCode != 0x10 && vkCode != 0xA0 && vkCode != 0xA1) // not Shift
                            {
                                HotstringBufferClear(); // non-character key clears buffer
                            }
                        }
                    }
                }

                // KEY UP handling for WhilePressed release (matched by physical vkCode so
                // modifier-state flicker between down and up doesn't break the match). Runs
                // outside the isProfileKey gate so it still fires even if the hotkey config
                // changed mid-hold.
                if (!isDown && _activeHoldVkCode == vkCode && _activeHoldProfile != null
                    && MainController.Instance != null && !MainController.Instance.IsRecording())
                {
                    var heldProfile = _activeHoldProfile;
                    bool wasConfirmed = _holdConfirmed;
                    _holdDebounceTimer?.Dispose();
                    _holdDebounceTimer = null;
                    ClearActiveHold();
                    _holdConfirmed = false;

                    // Only fire PROFILE_STOP if the hold was actually confirmed (replay had
                    // started or is about to start). If released before the debounce window
                    // expired, the press was an accidental brush — silently drop it.
                    if (wasConfirmed)
                    {
                        OnHotkeyPressed?.Invoke($"PROFILE_STOP::{heldProfile}");
                    }
                    return (IntPtr)1;
                }

                // KEY UP handling for OnRelease trigger mode (still keyed by composed key)
                if (!isDown && isProfileKey && UserProfile.Current.ProfileKeyEnabled
                    && MainController.Instance != null && !MainController.Instance.IsRecording())
                {

                    // 2) OnRelease mode: fire on key up
                    string? releaseProfile = null;
                    foreach (var p in ProfileHotkeys)
                    {
                        if (p.Value == key && IsForegroundWindowMatch(p.Key))
                        {
                            releaseProfile = p.Key;
                            break;
                        }
                    }
                    if (releaseProfile != null)
                    {
                        var mode = ProfileTriggerModes.TryGetValue(releaseProfile, out var rm) ? rm : TriggerMode.OnPress;
                        if (mode == TriggerMode.OnRelease && !IsReplayingAction)
                        {
                            LastTriggerHotkey = key;
                            OnHotkeyPressed?.Invoke($"PROFILE::{releaseProfile}");
                            return (IntPtr)1;
                        }
                        // OnPress and Toggle modes: let the key-up pass through to the target app
                        // (matches pre-feature behavior; the orphan key-up is harmless since the
                        // matching key-down was swallowed).
                    }
                }

                if (!(isDown == false && MainController.Instance?.IsHotkeyKeyUpSuppressed(key) == true))
                {
                    if (!(isProfileKey && !UserProfile.Current.ProfileKeyEnabled && MainController.Instance != null && !MainController.Instance.IsRecording()))
                    {
                        OnKeyEvent?.Invoke(keyName, isDown);
                    }
                }
            }

            return NativeMethods.CallNextHookEx(_keyboardHookId, nCode, wParam, lParam);
        }
    }
}