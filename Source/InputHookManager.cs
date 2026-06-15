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

        // Throttles the diagnostic "hotkey gate rejected" log (separate from the user toast
        // above) so mashing a gated hotkey doesn't flood the session log. Keyed per profile.
        private static readonly Dictionary<string, DateTime> _lastGateRejectLogUtc = new();
        private static readonly TimeSpan _gateRejectLogCooldown = TimeSpan.FromSeconds(3);

        /// <summary>
        /// Fires when CaptureHotkeyMode is active and the user presses a key/combo. The string
        /// is the composed hotkey (e.g. "Win+Q", "Ctrl+Shift+F5", "ScrollUp"). The hook
        /// swallows the underlying OS event so the Windows Shell doesn't react to it (no
        /// Start menu on Win+letter, no Run dialog on Win+R, etc.).
        /// </summary>
        public static event Action<string>? OnHotkeyCaptured;

        private static IntPtr _mouseHookId = IntPtr.Zero;
        private static IntPtr _keyboardHookId = IntPtr.Zero;

        // readonly: these MUST stay alive for the process lifetime — SetWindowsHookEx keeps only
        // a native pointer to the delegate, so if the managed reference were ever reassigned the
        // old thunk could be GC'd and the next input event would crash. readonly enforces that.
        private static readonly NativeMethods.LowLevelMouseProc _mouseProc = MouseHookCallback;
        private static readonly NativeMethods.LowLevelKeyboardProc _keyboardProc = KeyboardHookCallback;

        // WM_SYSKEYDOWN: keyboard message Windows sends instead of WM_KEYDOWN when Alt is held
        // (or for Alt itself / F10). The low-level hook must treat it as a key-down too, else
        // Alt-combo hotkeys would never register. NativeMethods only declares WM_KEYDOWN/UP, so
        // it's named here (kept private to this hook). Value matches the Win32 WM_SYSKEYDOWN.
        private const int WM_SYSKEYDOWN = 0x0104;

        // LLKHF_INJECTED: bit 4 of KBDLLHOOKSTRUCT.flags (offset 8). Set by Windows when the
        // event came from SendInput rather than physical hardware — used to drop our own
        // replay/F15-menu-cancel injections so they don't feed back into hotkey/hotstring logic.
        private const uint LLKHF_INJECTED = 0x10;

        // Monotonic tick timestamp (Environment.TickCount64) for the AltGr (right-Alt → right-Ctrl)
        // debounce — DateTime.Now is non-monotonic (NTP/manual/DST shifts could make the delta
        // negative or huge and wrongly suppress/leak the synthetic Ctrl). 0 means "never seen a
        // right-Alt" (TickCount64 is ms-since-boot, so a real timestamp is effectively never 0,
        // and the <100ms window bounds it regardless). Matches the MainController tick fix.
        private static long lastAltRightPressTicks = 0;

        public static volatile Dictionary<string, string> ProfileHotkeys = new();
        public static volatile Dictionary<string, HotstringConfig> ProfileHotstrings = new();
        public static volatile Dictionary<string, TriggerMode> ProfileTriggerModes = new();

        /// <summary>
        /// Name of the currently-active profile (or null when "No Profile" is selected).
        /// Used by the global Replay hotkey gate to look up the active profile's target
        /// in <see cref="_windowTargets"/> and apply the same foreground-match rule that
        /// profile keys already enforce. Set by WebViewBridge.CurrentProfileName's setter.
        /// </summary>
        public static volatile string? ActiveProfileName = null;

        /// <summary>
        /// True when the app is in Cursor-Click (Clicker v2) mode. The global Replay hotkey
        /// gate skips its target check while this is on — Clicker is "mode of the app",
        /// not "mode of the active profile", so the active profile's target window is
        /// semantically irrelevant. Without this flag a user in Clicker mode with a
        /// macro-targeted profile selected would have their Clicker hotkey silently
        /// rejected whenever the macro target wasn't in front. Set by the bridge's
        /// UseCursorClick setter.
        /// </summary>
        public static volatile bool IsCursorClickMode = false;

        // Clicker-exclusive hotkeys. Mirrored here from the bridge (like IsCursorClickMode) so the
        // hook can match them with zero per-press allocation. Active ONLY while IsCursorClickMode;
        // in macro mode they're inert (the global Recording/Replay hotkeys take over instead).
        public static volatile string CursorClickStartHotkey = "PageDown";
        public static volatile string CursorClickPauseHotkey = "PageUp";

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

        // Serializes the WhilePressed hold state (_activeHoldProfile/_activeHoldVkCode/
        // _holdConfirmed/_holdDebounceTimer) across the three threads that touch it: the hook
        // thread (key down/up), the debounce Timer's ThreadPool callback, and the bridge/UI
        // thread (ClearActiveHold on replay end). Without it the timer's check-then-fire could
        // race a concurrent clear and fire PROFILE_HOLD for an already-released key.
        private static readonly object _holdLock = new();

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

        // Backed by a volatile field (matching the cross-thread fields above): written from the
        // replay worker thread (ActionExecution.cs) and read on every keystroke/scroll in the hook
        // callbacks. A plain auto-property gives no cross-thread visibility guarantee; volatile does.
        private static volatile bool _isReplayingAction = false;
        public static bool IsReplayingAction { get => _isReplayingAction; set => _isReplayingAction = value; }

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

        /// True while at least one owner has registered for capture mode (see
        /// RegisterCapture / UnregisterCapture below).
        ///
        /// In capture mode, the low-level keyboard hook captures every keydown, composes
        /// it with modifier state via BuildComposedKey, fires OnHotkeyCaptured, and swallows
        /// the event. This is what allows the UI to capture combos that the Windows Shell
        /// would otherwise intercept (Win+letter, Alt+Tab on some setups, etc.) —
        /// WH_KEYBOARD_LL runs before the shell processes its own shortcuts, and returning
        /// 1 cancels the event entirely. Auto-cancels Start/menu activation by injecting F15
        /// when the combo includes Win/Alt plus another key (same trick used for swallowed
        /// profile hotkeys).
        ///
        /// Refcounted by ownerId — multiple frontend consumers (Pause dialog, Sheet editor,
        /// Settings hotkey field, etc.) can simultaneously hold the hook open without one
        /// stomping the other on cleanup. Capture is active while any owner is registered.
        public static bool CaptureHotkeyMode
        {
            get { lock (_captureOwnersLock) return _captureOwners.Count > 0; }
        }

        private static readonly HashSet<string> _captureOwners = new();
        private static readonly object _captureOwnersLock = new();

        /// Adds an owner to the capture refcount. Hook activates on the first owner; no-op
        /// if the owner is already registered (HashSet semantics — idempotent).
        public static void RegisterCapture(string ownerId)
        {
            if (string.IsNullOrEmpty(ownerId)) return;
            lock (_captureOwnersLock) _captureOwners.Add(ownerId);
        }

        /// Removes an owner from the capture refcount. Hook deactivates when the last owner
        /// is removed. No-op if the owner wasn't registered — keeps the API safe to call
        /// blindly from cleanup paths.
        public static void UnregisterCapture(string ownerId)
        {
            if (string.IsNullOrEmpty(ownerId)) return;
            lock (_captureOwnersLock) _captureOwners.Remove(ownerId);
        }

        /// Zeroes the refcount. Called by MainWindow on WebView2 NavigationCompleted so a
        /// frontend reload doesn't leave immortal owner IDs from the previous mount alive.
        public static void ClearAllCaptures()
        {
            lock (_captureOwnersLock) _captureOwners.Clear();
        }

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
            // SetWindowsHookEx returns IntPtr.Zero on failure (e.g. another LL hook hogging the
            // chain, or a desktop-isolation restriction). Without these checks a failed install is
            // totally silent — every hotkey and all recording would be dead with no diagnostic.
            // GetLastWin32Error() is meaningful because the SetWindowsHookEx DllImports declare
            // SetLastError=true (NativeMethods.cs).
            if (_mouseHookId == IntPtr.Zero)
            {
                _mouseHookId = NativeMethods.SetMouseHook(_mouseProc);
                if (_mouseHookId == IntPtr.Zero)
                    TrueReplayer.Services.DiagnosticLog.Error(
                        $"SetMouseHook failed — mouse hook not installed (recording/clicker hotkeys disabled). Win32 error {Marshal.GetLastWin32Error()}.");
            }
            if (_keyboardHookId == IntPtr.Zero)
            {
                _keyboardHookId = NativeMethods.SetKeyboardHook(_keyboardProc);
                if (_keyboardHookId == IntPtr.Zero)
                    TrueReplayer.Services.DiagnosticLog.Error(
                        $"SetKeyboardHook failed — keyboard hook not installed (all hotkeys/hotstrings/recording disabled). Win32 error {Marshal.GetLastWin32Error()}.");
            }
        }

        public static void Stop()
        {
            if (_mouseHookId != IntPtr.Zero)
            {
                // UnhookWindowsHookEx returns false if the handle was already invalid or the
                // unhook failed. NativeMethods declares it WITHOUT SetLastError, so there's no
                // meaningful Win32 errno to report — just record the failure. We still null the
                // id either way so a later Start() re-installs rather than wedging on a stale id.
                if (!NativeMethods.UnhookWindowsHookEx(_mouseHookId))
                    TrueReplayer.Services.DiagnosticLog.Warn("UnhookWindowsHookEx failed for the mouse hook on Stop() — handle may have been already invalid.");
                _mouseHookId = IntPtr.Zero;
            }
            if (_keyboardHookId != IntPtr.Zero)
            {
                if (!NativeMethods.UnhookWindowsHookEx(_keyboardHookId))
                    TrueReplayer.Services.DiagnosticLog.Warn("UnhookWindowsHookEx failed for the keyboard hook on Stop() — handle may have been already invalid.");
                _keyboardHookId = IntPtr.Zero;
            }

            // Reset transient hook state so a subsequent Start() begins clean. Without this, a
            // key physically held across a Stop()/Start() leaves a stale _vkCodesCurrentlyDown
            // entry (next press looks like an auto-repeat and is swallowed), a half-typed
            // hotstring buffer leaks into the next session's matching, and an in-flight
            // WhilePressed/OnRelease hold could fire PROFILE_STOP/PROFILE for a key that was
            // never released. ClearActiveHold also disposes the debounce timer under _holdLock.
            ClearActiveHold();
            _vkCodesCurrentlyDown.Clear();
            _hotstringBufferLen = 0;
            _pendingReleaseProfile = null;
            _pendingReleaseVkCode = 0;
            lock (_captureOwnersLock) _captureOwners.Clear();
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
            lock (_holdLock)
            {
                _activeHoldProfile = null;
                _activeHoldVkCode = 0;
                _holdConfirmed = false;
                _holdDebounceTimer?.Dispose();
                _holdDebounceTimer = null;
            }
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

        // Reused to compose the scroll-wheel hotkey combo string on the mouse-hook hot path
        // (avoids a per-wheel-event List<string> allocation). Touched only on the hook thread,
        // like _windowTextBuffer / _processNameBuffer above — no synchronization required.
        private static readonly StringBuilder _scrollComboBuilder = new(32);

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
                bool notRunning = TrueReplayer.Helpers.WindowMatcher.FindWindow(target, regex) == IntPtr.Zero;
                var now = DateTime.UtcNow;

                // Diagnostic record (throttled, its own cooldown). This is the #1 "my hotkey does
                // nothing" cause — log WHAT the target wanted vs WHAT was actually in front, so
                // support can tell a ProcessName/title mismatch from "target not running" (and from
                // the elevation case, already logged by WindowMatcher).
                if (!_lastGateRejectLogUtc.TryGetValue(profileName, out var lastLog)
                    || now - lastLog >= _gateRejectLogCooldown)
                {
                    _lastGateRejectLogUtc[profileName] = now;
                    TrueReplayer.Services.DiagnosticLog.Info(
                        $"Hotkey gate: profile '{profileName}' target [{DescribeTarget(target)}] did not match foreground [{DescribeWindow(hwnd)}] — target {(notRunning ? "is not running" : "is running but not in front")}.");
                }

                // Toast only when the target isn't running anywhere (existing behaviour).
                if (notRunning
                    && (!_lastTargetMissingFireUtc.TryGetValue(profileName, out var last)
                        || now - last >= _targetMissingCooldown))
                {
                    _lastTargetMissingFireUtc[profileName] = now;
                    OnProfileTargetMissing?.Invoke(profileName);
                }
            }
            catch { /* hook must never throw — swallow any FindWindow / event-handler failure */ }
            return false;
        }

        // Human-readable target descriptor for the gate-rejection diagnostic log.
        private static string DescribeTarget(WindowTarget target)
        {
            var parts = new List<string>();
            if (!string.IsNullOrEmpty(target.ProcessName)) parts.Add(target.ProcessName);
            if (!string.IsNullOrEmpty(target.WindowTitle))
                parts.Add($"title{(target.TitleMatchMode == "regex" ? "~" : ":")}\"{target.WindowTitle}\"");
            return parts.Count > 0 ? string.Join(" ", parts) : "(empty target)";
        }

        // Describes a window as `proc.exe "Title"` for the gate-rejection diagnostic log. Only
        // called on a (throttled) rejection, so the per-call StringBuilder allocation is fine.
        private static string DescribeWindow(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return "no foreground window";
            try
            {
                var title = new StringBuilder(256);
                NativeMethods.GetWindowText(hwnd, title, title.Capacity);
                NativeMethods.GetWindowThreadProcessId(hwnd, out uint pid);
                string proc = "?";
                IntPtr h = NativeMethods.OpenProcess(NativeMethods.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
                if (h != IntPtr.Zero)
                {
                    try
                    {
                        var pb = new StringBuilder(512);
                        if (NativeMethods.GetProcessImageFileName(h, pb, (uint)pb.Capacity) > 0)
                            proc = System.IO.Path.GetFileName(pb.ToString());
                        else
                            // Handle opened but the image name couldn't be read — distinguish
                            // this from "couldn't open" so the gate-reject diagnostic isn't
                            // misleading (e.g. a protected/anti-cheat process).
                            proc = $"?(name-unavailable, pid {pid})";
                    }
                    finally { NativeMethods.CloseHandle(h); }
                }
                else
                {
                    // OpenProcess failed — usually the foreground app is elevated and we're not
                    // (errno 5 = ACCESS_DENIED), which is the #2 silent "hotkey does nothing"
                    // cause. Surface the errno so support can tell elevation apart from a
                    // ProcessName mismatch. OpenProcess has SetLastError=true (NativeMethods.cs).
                    proc = $"?(open-failed err {Marshal.GetLastWin32Error()}, pid {pid})";
                }
                return $"{proc} \"{title}\"";
            }
            catch { return "unknown window"; }
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

            // No need to flip IsReplayingAction here: the backspaces we inject below go out via
            // SendInput and are already dropped by the keyboard hook's LLKHF_INJECTED gate (see
            // KeyboardHookCallbackCore), so they never feed the hotstring buffer or re-trigger a
            // hotkey. The previous snapshot/restore of that shared cross-thread flag was both
            // redundant and racy — it runs on the hook thread, and if the replay worker thread set
            // the flag true between the snapshot and the finally, the restore would clobber it back
            // to false and silently disable the replay-injection guard.
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

        #endregion

        private static IntPtr MouseHookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            // A low-level hook must never let an exception escape — it can unhook itself or crash
            // the process. Run the real handler guarded; on failure log and pass the event through.
            try { return MouseHookCallbackCore(nCode, wParam, lParam); }
            catch (Exception ex) { try { TrueReplayer.Services.DiagnosticLog.Error("MouseHookCallback", ex); } catch { } }
            return NativeMethods.CallNextHookEx(_mouseHookId, nCode, wParam, lParam);
        }

        private static IntPtr MouseHookCallbackCore(int nCode, IntPtr wParam, IntPtr lParam)
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

                    // Hot path: every wheel event with profile hotkeys configured lands here, so
                    // compose the combo into a reusable StringBuilder instead of allocating a
                    // List<string> + string.Join on each scroll. _scrollComboBuilder is only ever
                    // touched on the (single) hook thread, so no synchronization is needed.
                    _scrollComboBuilder.Clear();
                    if (winHeld) _scrollComboBuilder.Append("Win+");
                    if (ctrlHeld) _scrollComboBuilder.Append("Ctrl+");
                    if (altHeld) _scrollComboBuilder.Append("Alt+");
                    if (shiftHeld) _scrollComboBuilder.Append("Shift+");
                    _scrollComboBuilder.Append(scrollKey);
                    string combo = _scrollComboBuilder.ToString();

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
            // A low-level hook must never let an exception escape — it can unhook itself or crash
            // the process. Run the real handler guarded; on failure log and pass the event through.
            try { return KeyboardHookCallbackCore(nCode, wParam, lParam); }
            catch (Exception ex) { try { TrueReplayer.Services.DiagnosticLog.Error("KeyboardHookCallback", ex); } catch { } }
            return NativeMethods.CallNextHookEx(_keyboardHookId, nCode, wParam, lParam);
        }

        private static IntPtr KeyboardHookCallbackCore(int nCode, IntPtr wParam, IntPtr lParam)
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
                    bool captureDown = wParam == (IntPtr)NativeMethods.WM_KEYDOWN || wParam == (IntPtr)WM_SYSKEYDOWN;
                    uint captureFlags = (uint)Marshal.ReadInt32(lParam, 8);
                    bool captureInjected = (captureFlags & LLKHF_INJECTED) != 0;

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
                bool isDown = wParam == (IntPtr)NativeMethods.WM_KEYDOWN || wParam == (IntPtr)WM_SYSKEYDOWN;

                // Skip any trigger-mode / hotkey / hotstring logic for events we injected
                // via SendInput — replay-simulated keystrokes and the F15 menu-cancel phantom.
                // Processing them would cause feedback loops (simulated keys treated as repeats,
                // triggering PROFILE_STOP, feeding the hotstring buffer, etc.).
                // LLKHF_INJECTED is flag bit 4 (0x10) in KBDLLHOOKSTRUCT.flags (offset 8).
                uint hookFlags = (uint)Marshal.ReadInt32(lParam, 8);
                bool isInjected = (hookFlags & LLKHF_INJECTED) != 0;
                if (isInjected)
                {
                    return NativeMethods.CallNextHookEx(_keyboardHookId, nCode, wParam, lParam);
                }

                if (vkCode == 165 && isDown)
                {
                    lastAltRightPressTicks = Environment.TickCount64;
                }

                if (vkCode == 162 && isDown && lastAltRightPressTicks != 0)
                {
                    if (Environment.TickCount64 - lastAltRightPressTicks < 100)
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
                        // Run/Stop + Pause are MODE-EXCLUSIVE. In Clicker mode the dedicated
                        // clicker hotkeys fire (and the global Recording/Replay hotkeys are inert);
                        // in Macro mode it's the reverse. The same physical key can serve both —
                        // the active mode decides which branch runs, so there's no real conflict.
                        if (IsCursorClickMode)
                        {
                            if (key == CursorClickStartHotkey)
                            {
                                OnHotkeyPressed?.Invoke("CLICKER_START");
                                return (IntPtr)1;
                            }
                            if (key == CursorClickPauseHotkey)
                            {
                                OnHotkeyPressed?.Invoke("CLICKER_PAUSE");
                                return (IntPtr)1;
                            }
                        }
                        else
                        {
                            if (key == UserProfile.Current.RecordingHotkey)
                            {
                                OnHotkeyPressed?.Invoke(key);
                                return (IntPtr)1;
                            }

                            if (key == UserProfile.Current.ReplayHotkey)
                            {
                                // Gate by the active profile's window target — same foreground rule
                                // profile keys already enforce. Pass through (CallNextHookEx) instead
                                // of swallowing when the gate rejects, so the user can still type the
                                // key in non-target apps. (Macro-only branch now, so the former
                                // Clicker-mode bypass is no longer needed here.)
                                var activeName = ActiveProfileName;
                                if (!string.IsNullOrEmpty(activeName)
                                    && !IsForegroundWindowMatch(activeName))
                                {
                                    return NativeMethods.CallNextHookEx(_keyboardHookId, nCode, wParam, lParam);
                                }
                                LastTriggerHotkey = key;
                                OnHotkeyPressed?.Invoke(key);
                                return (IntPtr)1;
                            }
                        }

                        // Utility hotkeys work in BOTH modes — Mode-toggle is how you leave
                        // Clicker mode; Profile-keys toggle and Foreground are mode-agnostic.
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
                        // Auto-repeat of a hotkey — swallow so a held key doesn't re-fire.
                        if (IsCursorClickMode)
                        {
                            if (key == CursorClickStartHotkey || key == CursorClickPauseHotkey)
                                return (IntPtr)1;
                        }
                        else
                        {
                            if (key == UserProfile.Current.RecordingHotkey)
                                return (IntPtr)1;
                            // ReplayHotkey repeat mirrors the first-press gate: pass through when
                            // the target isn't foreground, otherwise swallow.
                            if (key == UserProfile.Current.ReplayHotkey)
                            {
                                var activeName = ActiveProfileName;
                                if (!string.IsNullOrEmpty(activeName)
                                    && !IsForegroundWindowMatch(activeName))
                                {
                                    return NativeMethods.CallNextHookEx(_keyboardHookId, nCode, wParam, lParam);
                                }
                                return (IntPtr)1;
                            }
                        }
                        if (key == UserProfile.Current.ProfileKeyToggleHotkey
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
                                    // Debounce: only fire PROFILE_HOLD after the key has been held
                                    // long enough to be "intentional" — stops accidental brushes
                                    // from kicking off the infinite-loop replay.
                                    var profileCapture = matchedProfile;
                                    var vkCapture = vkCode;
                                    lock (_holdLock)
                                    {
                                        _activeHoldProfile = matchedProfile;
                                        _activeHoldVkCode = vkCode;
                                        _holdConfirmed = false;
                                        _holdDebounceTimer?.Dispose();
                                        _holdDebounceTimer = new System.Threading.Timer(_ =>
                                        {
                                            // Confirm-and-fire under the lock so a concurrent
                                            // key-up / ClearActiveHold can't clear the hold between
                                            // the check and the fire decision. The PROFILE_HOLD
                                            // invoke runs outside the lock to avoid holding it
                                            // across an event handler.
                                            bool fire = false;
                                            lock (_holdLock)
                                            {
                                                if (_activeHoldVkCode == vkCapture && _activeHoldProfile == profileCapture)
                                                {
                                                    _holdConfirmed = true;
                                                    fire = true;
                                                }
                                            }
                                            if (fire) OnHotkeyPressed?.Invoke($"PROFILE_HOLD::{profileCapture}");
                                        }, null, WhilePressedDebounceMs, System.Threading.Timeout.Infinite);
                                    }
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
                    string? heldProfile;
                    bool wasConfirmed;
                    lock (_holdLock)
                    {
                        heldProfile = _activeHoldProfile;
                        // Capture wasConfirmed in the same critical section as the clear so the
                        // timer's confirm-and-fire and this release are mutually exclusive: either
                        // the timer already fired (wasConfirmed true → we send STOP), or its
                        // post-clear check fails and it never fires. ClearActiveHold disposes the
                        // timer and nulls the hold state under the same (reentrant) lock.
                        wasConfirmed = _holdConfirmed;
                        ClearActiveHold();
                    }

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