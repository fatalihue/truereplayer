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

        /// <summary>
        /// Fires when a profile hotkey is pressed AND its target window can't be found
        /// anywhere on the system (not just not-foreground — actually not running). Lets
        /// the UI surface a "target X not open" toast so the user doesn't see the hotkey
        /// silently swallowed. The legit gate case (target running but not foreground)
        /// stays silent because that's the feature working as designed — user is in the
        /// wrong window, shouldn't trigger the profile.
        ///
        /// Throttled per-profile via <see cref="_lastTargetMissingFireUtc"/> so a user
        /// who mashes the hotkey doesn't get spammed.
        /// </summary>
        public static event Action<string>? OnProfileTargetMissing;

        private static readonly Dictionary<string, DateTime> _lastTargetMissingFireUtc = new();
        private static readonly TimeSpan _targetMissingCooldown = TimeSpan.FromSeconds(3);

        /// <summary>
        /// Fires when CaptureHotkeyMode is active and the user presses a key/combo. The string
        /// is the composed hotkey (e.g. "Win+Q", "Ctrl+Shift+F5", "ScrollUp"). The hook
        /// swallows the underlying OS event so the Windows Shell doesn't react to it (no
        /// Start menu on Win+letter, no Run dialog on Win+R, etc.).
        /// </summary>
        public static event Action<string>? OnHotkeyCaptured;

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

        // OnRelease: when the profile hotkey key-down is swallowed, we remember which profile
        // is pending a release-fire and which physical vkCode will trigger it. Tracking by
        // vkCode (not composed key) so users who release the modifier before the main key
        // still get the profile to fire — otherwise the composed key on key-up would be just
        // "Q" instead of "Alt+Q", missing the profile lookup entirely.
        private static volatile string? _pendingReleaseProfile = null;
        private static volatile int _pendingReleaseVkCode = 0;

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

        // Single-use hotkey listener for Pause action: when ExecutePause is awaiting, the registered
        // hotkey resumes replay. Volatile so the hook thread sees writes from the replay thread
        // immediately. Cleared in finally block of ExecutePause.
        private static volatile string? _pauseResumeHotkey;
        private static volatile Action? _pauseResumeCallback;

        public static void SetReplayPauseListener(string hotkey, Action onPress)
        {
            _pauseResumeHotkey = hotkey;
            _pauseResumeCallback = onPress;
        }

        public static void ClearReplayPauseListener()
        {
            _pauseResumeHotkey = null;
            _pauseResumeCallback = null;
        }

        // Manual resume from UI button — fires the same callback the hotkey would.
        public static void TriggerReplayPauseListener() => _pauseResumeCallback?.Invoke();

        public static string? LastTriggerHotkey { get; set; }

        public static bool IgnoreProfileHotkeys { get; set; } = false;

        /// When true, suppresses ALL hotkey matching and key/mouse event recording.
        /// Used when a UI dialog/modal is active (SendText, Rename, Hotkey Capture, ContentDialogs).
        public static bool SuppressAllHotkeys { get; set; } = false;

        /// When true, the low-level keyboard hook captures every keydown, composes it with
        /// modifier state via BuildComposedKey, fires OnHotkeyCaptured, and swallows the event.
        /// This is what allows the UI to capture combos that the Windows Shell would otherwise
        /// intercept (Win+letter, Alt+Tab on some setups, etc.) — WH_KEYBOARD_LL runs before
        /// the shell processes its own shortcuts, and returning 1 cancels the event entirely.
        /// Auto-cancels Start/menu activation by injecting F15 when the combo includes Win/Alt
        /// plus another key (same trick used for swallowed profile hotkeys).
        public static bool CaptureHotkeyMode { get; set; } = false;

        /// When true, mouse click events (Down/Up) are swallowed (not passed to the target app).
        /// Used during capture mode to capture coordinates without performing the actual click.
        public static bool SuppressMouseClick { get; set; } = false;

        /// When true, mouse click events are NOT recorded (but still pass through to the target
        /// app). Bridge flips this on while a native <select> dropdown is being interacted with,
        /// so the OS-level click pairs (open popup + pick option) don't end up in the macro grid
        /// alongside the BrowserSelectOption action that already captures the semantic event.
        /// Cleared on change / blur / 15 s safety timeout — see WebViewBridge SelectInteraction*.
        public static bool SuppressMouseRecording { get; set; } = false;

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

        /// <summary>
        /// Injects a benign F15 key-down / key-up pair via SendInput. Used right after we
        /// swallow a profile hotkey that includes Alt (or Win) so that when the user releases
        /// the modifier, Windows does NOT interpret it as "modifier pressed alone" and open
        /// the Alt menu / Start menu. F15 is unbound on virtually all apps.
        /// </summary>
        private static void InjectMenuCancelKey()
        {
            const ushort VK_F15 = 0x7E;
            var inputs = new NativeMethods.INPUT[]
            {
                new NativeMethods.INPUT
                {
                    type = NativeMethods.INPUT_KEYBOARD,
                    U = new NativeMethods.InputUnion
                    {
                        ki = new NativeMethods.KEYBDINPUT { wVk = VK_F15, dwFlags = 0 }
                    }
                },
                new NativeMethods.INPUT
                {
                    type = NativeMethods.INPUT_KEYBOARD,
                    U = new NativeMethods.InputUnion
                    {
                        ki = new NativeMethods.KEYBDINPUT { wVk = VK_F15, dwFlags = NativeMethods.KEYEVENTF_KEYUP }
                    }
                }
            };
            NativeMethods.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(NativeMethods.INPUT)));
        }

        private static bool ShouldCancelMenuFor(string key)
        {
            // Alt alone triggers browser/app menu bar on release; Win alone triggers Start menu.
            // If our hotkey uses these as modifiers, inject a phantom key so the target app
            // sees "something happened" while the modifier was held — which cancels the
            // menu-activation heuristic.
            return key.StartsWith("Alt+", StringComparison.OrdinalIgnoreCase)
                || key.Contains("+Alt+", StringComparison.OrdinalIgnoreCase)
                || key.StartsWith("Win+", StringComparison.OrdinalIgnoreCase)
                || key.Contains("+Win+", StringComparison.OrdinalIgnoreCase);
        }

        public static void RegisterProfileWindowTargets(Dictionary<string, WindowTarget> targets, HashSet<string>? bringToFocusProfiles = null)
        {
            var regexes = new Dictionary<string, Regex?>();
            foreach (var (name, target) in targets)
            {
                var compiled = TrueReplayer.Helpers.WindowMatcher.CompileTitleRegex(target);
                if (compiled != null) regexes[name] = compiled;
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
            wt.CompiledRegexes.TryGetValue(profileName, out var regex);

            if (hwnd != IntPtr.Zero && TrueReplayer.Helpers.WindowMatcher.Matches(
                    hwnd, target, regex, _windowTextBuffer, _processNameBuffer))
                return true;

            // Foreground doesn't match. Two sub-cases worth distinguishing for UX:
            //   - target is running somewhere else (different desktop / behind other windows):
            //     stay silent. The gate is doing its job — user pressed in the wrong context.
            //   - target isn't running at all: surface a toast so the user knows why the
            //     hotkey did nothing. Cooldown'd so a mashed key doesn't flood notifications.
            // FindWindow walks the full window list which is cheap enough at hotkey-press rate.
            try
            {
                if (TrueReplayer.Helpers.WindowMatcher.FindWindow(target, regex) == IntPtr.Zero)
                {
                    var now = DateTime.UtcNow;
                    if (!_lastTargetMissingFireUtc.TryGetValue(profileName, out var last)
                        || now - last >= _targetMissingCooldown)
                    {
                        _lastTargetMissingFireUtc[profileName] = now;
                        OnProfileTargetMissing?.Invoke(profileName);
                    }
                }
            }
            catch { /* hook must never throw — swallow any FindWindow / event-handler failure */ }
            return false;
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
            if (nCode < 0)
                return NativeMethods.CallNextHookEx(_mouseHookId, nCode, wParam, lParam);

            // Capture mode: scroll is a valid hotkey trigger, so wheel events get composed
            // with modifier state and emitted through OnHotkeyCaptured, then swallowed.
            // Mouse buttons are not capturable as hotkeys (would conflict with normal UI
            // interaction inside the dialog), so they pass through.
            if (CaptureHotkeyMode && (int)wParam == NativeMethods.WM_MOUSEWHEEL)
            {
                var wheelHookStruct = Marshal.PtrToStructure<NativeMethods.MSLLHOOKSTRUCT>(lParam);
                int wheelDelta = (short)((wheelHookStruct.mouseData >> 16) & 0xffff);
                string scrollKey = wheelDelta > 0 ? "ScrollUp" : "ScrollDown";

                // Tracked state, not GetAsyncKeyState — modifiers swallowed by the keyboard
                // hook (Win in particular) won't show up in the async OS state.
                bool winHeld = _vkCodesCurrentlyDown.Contains(0x5B) || _vkCodesCurrentlyDown.Contains(0x5C);
                bool ctrlHeld = _vkCodesCurrentlyDown.Contains(0xA2) || _vkCodesCurrentlyDown.Contains(0xA3) || _vkCodesCurrentlyDown.Contains(0x11);
                bool altHeld = _vkCodesCurrentlyDown.Contains(0xA4) || _vkCodesCurrentlyDown.Contains(0xA5) || _vkCodesCurrentlyDown.Contains(0x12);
                bool shiftHeld = _vkCodesCurrentlyDown.Contains(0xA0) || _vkCodesCurrentlyDown.Contains(0xA1) || _vkCodesCurrentlyDown.Contains(0x10);

                var parts = new List<string>();
                if (winHeld) parts.Add("Win");
                if (ctrlHeld) parts.Add("Ctrl");
                if (altHeld) parts.Add("Alt");
                if (shiftHeld) parts.Add("Shift");
                parts.Add(scrollKey);
                string combo = string.Join("+", parts);

                OnHotkeyCaptured?.Invoke(combo);
                return (IntPtr)1;
            }

            if (!SuppressAllHotkeys)
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

                    // Same rationale as BuildComposedKey: read modifier state from the tracked
                    // set (populated only from non-injected events), not GetAsyncKeyState. A
                    // macro that holds Shift via SendInput would otherwise make every user
                    // scroll look like Shift+ScrollUp/Down, breaking scroll-bound profile
                    // hotkeys mid-replay even though the user only meant to scroll.
                    bool ctrlHeld = _vkCodesCurrentlyDown.Contains(0x11)
                                 || _vkCodesCurrentlyDown.Contains(0xA2)
                                 || _vkCodesCurrentlyDown.Contains(0xA3);
                    bool altHeld = _vkCodesCurrentlyDown.Contains(0x12)
                                || _vkCodesCurrentlyDown.Contains(0xA4)
                                || _vkCodesCurrentlyDown.Contains(0xA5);
                    bool shiftHeld = _vkCodesCurrentlyDown.Contains(0x10)
                                  || _vkCodesCurrentlyDown.Contains(0xA0)
                                  || _vkCodesCurrentlyDown.Contains(0xA1);
                    bool winHeld = _vkCodesCurrentlyDown.Contains(0x5B)
                                || _vkCodesCurrentlyDown.Contains(0x5C);

                    var parts = new List<string>();
                    if (winHeld) parts.Add("Win");
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
                    // Suppress recording during a native <select> interaction so the open
                    // popup + pick option clicks don't bleed into the macro alongside the
                    // BrowserSelectOption action that semantically captures the change.
                    bool skipRecording = SuppressMouseRecording && button != "Scroll";

                    if (!skipRecording)
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

        /// <summary>
        /// Composes a modifier+key string (e.g. "Ctrl+Shift+F5") from the current event's main
        /// vkCode plus whichever modifiers the user is physically holding.
        ///
        /// Reads modifier state from <see cref="_vkCodesCurrentlyDown"/> (populated only from
        /// NON-injected hook events) instead of <see cref="NativeMethods.GetAsyncKeyState"/>.
        /// GetAsyncKeyState reports the OS keyboard state, which is wrong in two opposite ways:
        ///
        ///  1. CAPTURE MODE — when the hook swallows a modifier keydown by returning 1, the OS
        ///     never marks it as down. By the time the main key (Q) arrives, GetAsyncKeyState
        ///     reports "up" even though the user is still physically holding the modifier, so a
        ///     "Win+Q" capture would compose as just "Q".
        ///
        ///  2. REPLAY — when the replay engine injects a modifier KEYDOWN via SendInput (e.g. a
        ///     "KeyDown Shift" action), the OS DOES mark the modifier as down. The hook event
        ///     for the injection is dropped at the LLKHF_INJECTED gate so _vkCodesCurrentlyDown
        ///     stays correct, but GetAsyncKeyState now returns "Shift held" for everything that
        ///     follows. Result: the user's attempt to press the Replay-stop hotkey, or the
        ///     profile's own hotkey, composes as "Shift+&lt;key&gt;" and misses the configured
        ///     hotkey lookup — the press is silently swallowed and the replay can't be aborted
        ///     until the macro releases Shift itself.
        ///
        /// Trusting the tracked set fixes both. Trade-off: if the user is already holding a
        /// modifier when the hook installs (rare — only at app startup), we'll miss it until
        /// they release and re-press. Acceptable; recovers on next keystroke.
        /// </summary>
        private static string BuildComposedKey(int vkCode)
        {
            bool winPressed = _vkCodesCurrentlyDown.Contains(0x5B) || _vkCodesCurrentlyDown.Contains(0x5C);
            bool ctrlPressed = _vkCodesCurrentlyDown.Contains(0xA2) || _vkCodesCurrentlyDown.Contains(0xA3) || _vkCodesCurrentlyDown.Contains(0x11);
            bool altPressed = _vkCodesCurrentlyDown.Contains(0xA4) || _vkCodesCurrentlyDown.Contains(0xA5) || _vkCodesCurrentlyDown.Contains(0x12);
            bool shiftPressed = _vkCodesCurrentlyDown.Contains(0xA0) || _vkCodesCurrentlyDown.Contains(0xA1) || _vkCodesCurrentlyDown.Contains(0x10);

            string? mainKey = KeyUtils.NormalizeKeyName(vkCode) ?? SafeKeyFallback(vkCode);

            var parts = new List<string>();
            if (winPressed) parts.Add("Win");
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
                // Capture mode handled first: composes the combo via BuildComposedKey, emits
                // it through OnHotkeyCaptured, then swallows the event so the Shell never sees
                // it. This is the only way to bind Win+letter combos — WebView2's JS keydown
                // never fires for them because the OS shortcut layer intercepts first.
                if (CaptureHotkeyMode)
                {
                    int captureVk = Marshal.ReadInt32(lParam);
                    bool captureDown = wParam == (IntPtr)NativeMethods.WM_KEYDOWN || wParam == (IntPtr)0x0104;
                    uint captureFlags = (uint)Marshal.ReadInt32(lParam, 8);
                    bool captureInjected = (captureFlags & 0x10) != 0;

                    // Always let our own SendInput events through unchanged — they're our F15
                    // menu-cancel pulses and we'd otherwise echo them back to the UI.
                    if (captureInjected)
                    {
                        return NativeMethods.CallNextHookEx(_keyboardHookId, nCode, wParam, lParam);
                    }

                    // Track physical key state so a held key doesn't spam OnHotkeyCaptured.
                    bool captureRepeat = captureDown && _vkCodesCurrentlyDown.Contains(captureVk);
                    if (captureDown) _vkCodesCurrentlyDown.Add(captureVk);
                    else _vkCodesCurrentlyDown.Remove(captureVk);

                    if (captureDown && !captureRepeat)
                    {
                        string combo = BuildComposedKey(captureVk);
                        if (!string.IsNullOrEmpty(combo))
                        {
                            OnHotkeyCaptured?.Invoke(combo);
                            // Win/Alt held + another key → tell the shell "something happened"
                            // so releasing the modifier doesn't trigger Start/menu activation.
                            if (ShouldCancelMenuFor(combo)) InjectMenuCancelKey();
                        }
                    }

                    return (IntPtr)1; // swallow every keydown AND keyup while capturing
                }

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

                // Skip any trigger-mode / hotkey / hotstring logic for events we injected
                // via SendInput — replay-simulated keystrokes and the F15 menu-cancel phantom.
                // Processing them would cause feedback loops (simulated keys treated as repeats,
                // triggering PROFILE_STOP, feeding the hotstring buffer, etc.).
                // LLKHF_INJECTED is flag bit 4 (0x10) in KBDLLHOOKSTRUCT.flags (offset 8).
                uint hookFlags = (uint)Marshal.ReadInt32(lParam, 8);
                bool isInjected = (hookFlags & 0x10) != 0;
                if (isInjected)
                {
                    return NativeMethods.CallNextHookEx(_keyboardHookId, nCode, wParam, lParam);
                }

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

                // Pause action resume: when a Pause action is awaiting, swallow the configured
                // resume hotkey and fire the callback. ExecutePause clears the listener via finally.
                if (isDown && !isRepeat && _pauseResumeHotkey != null && key == _pauseResumeHotkey)
                {
                    var cb = _pauseResumeCallback;
                    cb?.Invoke();
                    return (IntPtr)1;
                }

                // Unconditional swallow for the physical main key of an active WhilePressed hold
                // or a pending OnRelease. If we don't do this here, any code path that decides
                // the event "doesn't match a profile hotkey" (because the user released the
                // modifier, or the foreground window changed, or any other reason the composed
                // key no longer matches) would let the physical key pass through to the target.
                // That would leak the held Q (or whatever) into the target as text, on top of
                // whatever the replay is outputting.
                if (isDown && _activeHoldProfile != null && _activeHoldVkCode == vkCode)
                {
                    return (IntPtr)1;
                }
                if (isDown && _pendingReleaseProfile != null && _pendingReleaseVkCode == vkCode)
                {
                    return (IntPtr)1;
                }

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

                        if (key == UserProfile.Current.ModeToggleHotkey)
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
                            || key == UserProfile.Current.ForegroundHotkey
                            || key == UserProfile.Current.ModeToggleHotkey)
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

                        // If the swallowed hotkey uses Alt or Win as a modifier, inject a
                        // phantom F15 so the target app doesn't later interpret the modifier
                        // release as "pressed alone" → no browser Alt menu / Start menu.
                        bool needsMenuCancel = !isRepeat && ShouldCancelMenuFor(key);

                        switch (triggerMode)
                        {
                            case TriggerMode.OnPress:
                                if (!isRepeat)
                                {
                                    LastTriggerHotkey = key;
                                    if (needsMenuCancel) InjectMenuCancelKey();
                                    OnHotkeyPressed?.Invoke($"PROFILE::{matchedProfile}");
                                }
                                return (IntPtr)1;

                            case TriggerMode.OnRelease:
                                // Remember this key-down so the release-fire can match by
                                // physical vkCode. Without this, if the user releases the
                                // modifier before the main key, the composed key on key-up
                                // reduces to just "Q" and our lookup against ProfileHotkeys
                                // (which holds "Alt+Q") would miss.
                                if (!isRepeat)
                                {
                                    _pendingReleaseProfile = matchedProfile;
                                    _pendingReleaseVkCode = vkCode;
                                    // Inject F15 during the down phase (while the modifier is
                                    // guaranteed physically held). Injecting only on key-up
                                    // would race the user's modifier release — if the target
                                    // sees Alt↑ before F15 arrives, the menu opens.
                                    if (needsMenuCancel) InjectMenuCancelKey();
                                }
                                return (IntPtr)1;

                            case TriggerMode.WhilePressed:
                                if (!isRepeat)
                                {
                                    LastTriggerHotkey = key;
                                    if (needsMenuCancel) InjectMenuCancelKey();
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
                                    if (needsMenuCancel) InjectMenuCancelKey();
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

                // KEY UP handling for OnRelease mode (matched by physical vkCode so releasing
                // the modifier before the main key still fires the profile). The composed
                // key at this point may be just "Q" instead of "Alt+Q" — we ignore that and
                // match against the vkCode we recorded on key-down.
                if (!isDown && _pendingReleaseVkCode == vkCode && _pendingReleaseProfile != null
                    && MainController.Instance != null && !MainController.Instance.IsRecording()
                    && !IsReplayingAction)
                {
                    var pendingProfile = _pendingReleaseProfile;
                    _pendingReleaseProfile = null;
                    _pendingReleaseVkCode = 0;
                    LastTriggerHotkey = key;
                    OnHotkeyPressed?.Invoke($"PROFILE::{pendingProfile}");
                    return (IntPtr)1;
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
                            // Inject phantom key BEFORE firing so if the hotkey uses Alt/Win, the
                            // modifier keyup (about to arrive) doesn't trigger the target's menu.
                            if (ShouldCancelMenuFor(key)) InjectMenuCancelKey();
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