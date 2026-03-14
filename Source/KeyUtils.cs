using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using TrueReplayer.Interop;

namespace TrueReplayer.Helpers
{
    public static class KeyUtils
    {
        public static string? NormalizeKeyName(int vkCode)
        {
            // 1. Check well-known non-printable / named keys first
            var named = GetNamedKey(vkCode);
            if (named != null)
                return named;

            // 2. Letters A-Z — always stored uppercase, layout-independent
            if (vkCode >= 0x41 && vkCode <= 0x5A)
                return ((char)vkCode).ToString();

            // 3. Numbers 0-9
            if (vkCode >= 0x30 && vkCode <= 0x39)
                return (vkCode - 0x30).ToString();

            // 4. NumPad 0-9
            if (vkCode >= 0x60 && vkCode <= 0x69)
                return "Num" + (vkCode - 0x60);

            // 5. NumPad operators
            if (vkCode == 0x6A) return "NumMultiply";
            if (vkCode == 0x6B) return "NumAdd";
            if (vkCode == 0x6D) return "NumSubtract";
            if (vkCode == 0x6F) return "NumDivide";

            // 6. OEM keys — use ToUnicodeEx to get the actual character
            //    for the CURRENT keyboard layout. This handles ABNT2, AZERTY, etc.
            var ch = VkToCharCurrentLayout((uint)vkCode);
            if (ch != null)
                return ch;

            // 7. Fallback
            return SafeConsoleKeyName(vkCode);
        }

        private static string? GetNamedKey(int vkCode)
        {
            return vkCode switch
            {
                0x10 or 0xA0 or 0xA1 => "Shift",
                0x11 or 0xA2 or 0xA3 => "Ctrl",
                0x12 or 0xA4 or 0xA5 => "Alt",
                0x5B or 0x5C => "Win",

                0x70 => "F1",  0x71 => "F2",  0x72 => "F3",  0x73 => "F4",
                0x74 => "F5",  0x75 => "F6",  0x76 => "F7",  0x77 => "F8",
                0x78 => "F9",  0x79 => "F10", 0x7A => "F11", 0x7B => "F12",

                0x08 => "Backspace",
                0x09 => "Tab",
                0x0D => "Enter",
                0x1B => "Escape",
                0x20 => "Spacebar",
                0x14 => "CapsLock",
                0x90 => "NumLock",
                0x91 => "ScrollLock",
                0x13 => "Pause",
                0x2C => "PrintScreen",
                0x2D => "Insert",
                0x2E => "Delete",
                0x21 => "PageUp",
                0x22 => "PageDown",
                0x24 => "Home",
                0x23 => "End",
                0x25 => "Left",
                0x26 => "Up",
                0x27 => "Right",
                0x28 => "Down",

                _ => null
            };
        }

        /// <summary>
        /// Uses MapVirtualKeyEx (MAPVK_VK_TO_CHAR = 2) to resolve an OEM VK code
        /// to the character it produces on the current keyboard layout.
        /// IMPORTANT: This is safe to call from inside a keyboard hook because
        /// unlike ToUnicodeEx, it does NOT consume/destroy the OS dead key state.
        /// </summary>
        private static string? VkToCharCurrentLayout(uint vkCode)
        {
            try
            {
                uint threadId = NativeMethods.GetWindowThreadProcessId(
                    NativeMethods.GetForegroundWindow(), out _);
                IntPtr hkl = NativeMethods.GetKeyboardLayout(threadId);

                // MAPVK_VK_TO_CHAR = 2: translates VK to unshifted character
                // Bit 31 set = dead key, we still want the base character
                uint mapped = NativeMethods.MapVirtualKeyEx(vkCode, 2, hkl);
                if (mapped == 0)
                    return null;

                // Clear dead key flag (bit 31) to get the actual character
                char ch = (char)(mapped & 0x7FFFFFFF);
                if (!char.IsControl(ch))
                    return ch.ToString();

                return null;
            }
            catch
            {
                return null;
            }
        }

        private static string SafeConsoleKeyName(int vkCode)
        {
            // Always use VK_ prefix for unmapped codes so TryResolveVirtualKeyCode
            // can reliably parse them back during replay
            try
            {
                var name = ((ConsoleKey)vkCode).ToString();
                // If the enum has no named member, ToString() returns the raw number
                if (char.IsDigit(name[0]))
                    return $"VK_{vkCode}";
                return name.ToUpper();
            }
            catch
            {
                return $"VK_{vkCode}";
            }
        }

        // ──────────────────────────────────────────────────────────
        // Replay: string → VK code
        // ──────────────────────────────────────────────────────────

        private static readonly Dictionary<string, ushort> VirtualKeyMap = new(StringComparer.OrdinalIgnoreCase)
        {
            // Function keys
            ["F1"] = 0x70, ["F2"] = 0x71, ["F3"] = 0x72, ["F4"] = 0x73,
            ["F5"] = 0x74, ["F6"] = 0x75, ["F7"] = 0x76, ["F8"] = 0x77,
            ["F9"] = 0x78, ["F10"] = 0x79, ["F11"] = 0x7A, ["F12"] = 0x7B,

            // Numbers 0-9
            ["0"] = 0x30, ["1"] = 0x31, ["2"] = 0x32, ["3"] = 0x33, ["4"] = 0x34,
            ["5"] = 0x35, ["6"] = 0x36, ["7"] = 0x37, ["8"] = 0x38, ["9"] = 0x39,

            // NumPad 0-9
            ["Num0"] = 0x60, ["Num1"] = 0x61, ["Num2"] = 0x62, ["Num3"] = 0x63,
            ["Num4"] = 0x64, ["Num5"] = 0x65, ["Num6"] = 0x66, ["Num7"] = 0x67,
            ["Num8"] = 0x68, ["Num9"] = 0x69,

            // NumPad operators
            ["NumMultiply"] = 0x6A, ["NumDivide"] = 0x6F,
            ["NumAdd"] = 0x6B, ["NumSubtract"] = 0x6D,

            // Named keys
            ["CapsLock"] = 0x14, ["NumLock"] = 0x90, ["ScrollLock"] = 0x91,
            ["PageUp"] = 0x21, ["PageDown"] = 0x22,
            ["Home"] = 0x24, ["End"] = 0x23,
            ["Insert"] = 0x2D, ["Delete"] = 0x2E,
            ["Tab"] = 0x09, ["Pause"] = 0x13, ["PrintScreen"] = 0x2C,
            ["Left"] = 0x25, ["Up"] = 0x26, ["Right"] = 0x27, ["Down"] = 0x28,
            ["Win"] = 0x5B,

            // Modifiers
            ["Alt"] = 0xA4, ["LeftAlt"] = 0xA4, ["RightAlt"] = 0xA5,
            ["Ctrl"] = 0xA2, ["LeftCtrl"] = 0xA2, ["RightCtrl"] = 0xA3,
            ["Shift"] = 0xA0, ["LeftShift"] = 0xA0, ["RightShift"] = 0xA1,

            // Common
            ["Escape"] = 0x1B, ["Esc"] = 0x1B,
            ["Backspace"] = 0x08, ["Enter"] = 0x0D, ["Space"] = 0x20, ["Spacebar"] = 0x20,

            // Legacy OEM names (from ConsoleKey.ToString() in old profiles)
            // These are layout-independent VK codes, safe to keep in the static map
            ["OEM1"] = 0xBA, ["OEM2"] = 0xBF, ["OEM3"] = 0xC0, ["OEM4"] = 0xDB,
            ["OEM5"] = 0xDC, ["OEM6"] = 0xDD, ["OEM7"] = 0xDE, ["OEM8"] = 0xDF,
            ["OEMPLUS"] = 0xBB, ["OEMMINUS"] = 0xBD, ["OEMCOMMA"] = 0xBC,
            ["OEMPERIOD"] = 0xBE, ["OEM102"] = 0xE2,

            // NOTE: Single-character symbols (like `, -, [, ;, ', etc.) are NOT
            // in this map. They are resolved dynamically by VkKeyScanEx in step 4
            // of TryResolveVirtualKeyCode, which returns the correct VK code for
            // the CURRENT keyboard layout (US, ABNT2, AZERTY, etc.).
        };

        public static bool TryResolveVirtualKeyCode(string key, out ushort vkCode)
        {
            vkCode = 0;

            // 1. Check the static map (named keys, numbers, function keys)
            if (VirtualKeyMap.TryGetValue(key, out vkCode))
                return true;

            // 2. Single uppercase letter A-Z
            if (key.Length == 1 && key[0] >= 'A' && key[0] <= 'Z')
            {
                vkCode = (ushort)key[0];
                return true;
            }

            // 3. ConsoleKey enum fallback (handles legacy profiles)
            if (Enum.TryParse<ConsoleKey>(key, true, out var consoleKey))
            {
                vkCode = (ushort)consoleKey;
                return true;
            }

            // 4. Single printable character — use VkKeyScanEx to find the VK
            //    on the current keyboard layout. This is the key fix for ABNT2:
            //    a profile recorded on ABNT2 stores "ç", and when replayed on
            //    ABNT2, VkKeyScanEx("ç") returns the correct VK code.
            if (key.Length == 1)
            {
                vkCode = CharToVkCurrentLayout(key[0]);
                return vkCode != 0;
            }

            // 5. VK_xxx format (e.g. "VK_193" for ABNT2 special keys)
            if (key.StartsWith("VK_", StringComparison.OrdinalIgnoreCase) &&
                int.TryParse(key.AsSpan(3), out int legacyVk))
            {
                vkCode = (ushort)legacyVk;
                return true;
            }

            // 6. Plain numeric string (e.g. "193" from older profiles)
            if (int.TryParse(key, out int numericVk) && numericVk > 0 && numericVk <= 0xFF)
            {
                vkCode = (ushort)numericVk;
                return true;
            }

            return false;
        }

        /// <summary>
        /// Resolves a character to its VK code on the current keyboard layout.
        /// Uses VkKeyScanEx first, then verifies the result with MapVirtualKeyEx.
        /// If VkKeyScanEx returns a wrong VK (known issue with ABNT_C1/C2 keys),
        /// falls back to scanning the OEM VK range.
        /// </summary>
        private static ushort CharToVkCurrentLayout(char ch)
        {
            try
            {
                uint threadId = NativeMethods.GetWindowThreadProcessId(
                    NativeMethods.GetForegroundWindow(), out _);
                IntPtr hkl = NativeMethods.GetKeyboardLayout(threadId);

                short result = NativeMethods.VkKeyScanEx(ch, hkl);
                if (result != -1)
                {
                    ushort vk = (ushort)(result & 0xFF);
                    // Verify: does this VK actually produce the expected character?
                    uint mapped = NativeMethods.MapVirtualKeyEx(vk, 2, hkl);
                    if (mapped != 0 && char.ToLower((char)(mapped & 0x7FFFFFFF)) == char.ToLower(ch))
                        return vk;
                }

                // VkKeyScanEx failed or returned wrong VK — scan OEM range
                // This handles ABNT_C1 (0xC1), ABNT_C2 (0xC2) and other layout-specific keys
                ushort[] oemRange = {
                    0xBA, 0xBB, 0xBC, 0xBD, 0xBE, 0xBF, 0xC0, 0xC1, 0xC2,
                    0xDB, 0xDC, 0xDD, 0xDE, 0xDF, 0xE2
                };
                foreach (ushort vk in oemRange)
                {
                    uint mapped = NativeMethods.MapVirtualKeyEx(vk, 2, hkl);
                    if (mapped != 0 && char.ToLower((char)(mapped & 0x7FFFFFFF)) == char.ToLower(ch))
                        return vk;
                }

                return 0;
            }
            catch
            {
                return 0;
            }
        }
    }
}
