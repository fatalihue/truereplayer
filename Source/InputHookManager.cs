using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
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

        public static Dictionary<string, string> ProfileHotkeys = new();

        public static bool IsReplayingAction { get; set; } = false;

        public static string? LastTriggerHotkey { get; set; }

        public static bool IgnoreProfileHotkeys { get; set; } = false;

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

        private static IntPtr MouseHookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
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

                if (button != null)
                {
                    OnMouseEvent?.Invoke(button, hookStruct.pt.x, hookStruct.pt.y, isDown, scrollDelta);
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

                if (isDown)
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

                    if (!IsReplayingAction && UserProfile.Current.ProfileKeyEnabled && isProfileKey && MainController.Instance != null && !MainController.Instance.IsRecording())
                    {
                        var profileName = ProfileHotkeys.FirstOrDefault(p => p.Value == key).Key;
                        LastTriggerHotkey = key;
                        OnHotkeyPressed?.Invoke($"PROFILE::{profileName}");
                        return (IntPtr)1;
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