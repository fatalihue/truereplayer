using System;
using System.Collections.Generic;

namespace TrueReplayer.Helpers
{
    public static class KeyUtils
    {
        public static string? NormalizeKeyName(int vkCode)
        {
            // Mapear modificadores explicitamente
            return vkCode switch
            {
                0x10 or 0xA0 or 0xA1 => "Shift",  // Shift, LeftShift, RightShift
                0x11 or 0xA2 or 0xA3 => "Ctrl",   // Ctrl, LeftCtrl, RightCtrl
                0x12 or 0xA4 or 0xA5 => "Alt",    // Alt, LeftAlt, RightAlt

                // Teclas de função (F1-F12)
                0x70 => "F1",
                0x71 => "F2",
                0x72 => "F3",
                0x73 => "F4",
                0x74 => "F5",
                0x75 => "F6",
                0x76 => "F7",
                0x77 => "F8",
                0x78 => "F9",
                0x79 => "F10",
                0x7A => "F11",
                0x7B => "F12",

                // Números superiores (0–9)
                >= 48 and <= 57 => (vkCode - 48).ToString(),

                // NumPad 0–9
                >= 96 and <= 105 => "Num" + (vkCode - 96),

                // Operações NumPad
                106 => "NumMultiply",
                107 => "NumAdd",
                109 => "NumSubtract",
                111 => "NumDivide",

                // Símbolos principais
                192 => "`",
                189 => "-",
                187 => "=",
                219 => "[",
                221 => "]",
                220 => "\\",
                186 => ";",
                222 => "'",
                188 => ",",
                190 => ".",
                191 => "/",

                // Teclas especiais
                20 => "CapsLock",
                144 => "NumLock",
                145 => "ScrollLock",
                33 => "PageUp",
                34 => "PageDown",
                36 => "Home",
                35 => "End",
                9 => "Tab",
                19 => "Pause",
                44 => "PrintScreen",
                45 => "Insert",

                // Setas
                37 => "Left",
                38 => "Up",
                39 => "Right",
                40 => "Down",

                // Teclas padrão
                _ => SafeConsoleKeyName(vkCode)
            };
        }

        private static string SafeConsoleKeyName(int vkCode)
        {
            try
            {
                return ((ConsoleKey)vkCode).ToString().ToUpper();
            }
            catch
            {
                return $"VK_{vkCode}";
            }
        }

        private static readonly Dictionary<string, ushort> VirtualKeyMap = new(StringComparer.OrdinalIgnoreCase)
        {
            // Teclas de função (F1-F12)
            ["F1"] = 0x70, ["F2"] = 0x71, ["F3"] = 0x72, ["F4"] = 0x73,
            ["F5"] = 0x74, ["F6"] = 0x75, ["F7"] = 0x76, ["F8"] = 0x77,
            ["F9"] = 0x78, ["F10"] = 0x79, ["F11"] = 0x7A, ["F12"] = 0x7B,

            // Números 0-9
            ["0"] = 0x30, ["1"] = 0x31, ["2"] = 0x32, ["3"] = 0x33, ["4"] = 0x34,
            ["5"] = 0x35, ["6"] = 0x36, ["7"] = 0x37, ["8"] = 0x38, ["9"] = 0x39,

            // NumPad 0-9
            ["Num0"] = 0x60, ["Num1"] = 0x61, ["Num2"] = 0x62, ["Num3"] = 0x63,
            ["Num4"] = 0x64, ["Num5"] = 0x65, ["Num6"] = 0x66, ["Num7"] = 0x67,
            ["Num8"] = 0x68, ["Num9"] = 0x69,

            // Operadores NumPad
            ["NumMultiply"] = 0x6A, ["NumDivide"] = 0x6F,
            ["NumAdd"] = 0x6B, ["NumSubtract"] = 0x6D,

            // Símbolos
            ["`"] = 0xC0, ["-"] = 0xBD, ["="] = 0xBB,
            ["["] = 0xDB, ["]"] = 0xDD, ["\\"] = 0xDC,
            [";"] = 0xBA, ["'"] = 0xDE, [","] = 0xBC,
            ["."] = 0xBE, ["/"] = 0xBF,

            // Teclas especiais
            ["CapsLock"] = 0x14, ["NumLock"] = 0x90, ["ScrollLock"] = 0x91,
            ["PageUp"] = 0x21, ["PageDown"] = 0x22,
            ["Home"] = 0x24, ["End"] = 0x23,
            ["Insert"] = 0x2D, ["Delete"] = 0x2E,
            ["Tab"] = 0x09, ["Pause"] = 0x13, ["PrintScreen"] = 0x2C,

            // Setas
            ["Left"] = 0x25, ["Up"] = 0x26, ["Right"] = 0x27, ["Down"] = 0x28,

            // Modificadores
            ["Alt"] = 0xA4, ["LeftAlt"] = 0xA4, ["RightAlt"] = 0xA5,
            ["Ctrl"] = 0xA2, ["LeftCtrl"] = 0xA2, ["RightCtrl"] = 0xA3,
            ["Shift"] = 0xA0, ["LeftShift"] = 0xA0, ["RightShift"] = 0xA1,

            // Extras
            ["Escape"] = 0x1B, ["Esc"] = 0x1B,
            ["Backspace"] = 0x08, ["Enter"] = 0x0D, ["Space"] = 0x20,
        };

        public static bool TryResolveVirtualKeyCode(string key, out ushort vkCode)
        {
            vkCode = 0;

            if (VirtualKeyMap.TryGetValue(key, out vkCode))
                return true;

            if (Enum.TryParse<ConsoleKey>(key, true, out var consoleKey))
            {
                vkCode = (ushort)consoleKey;
                return true;
            }

            return false;
        }
    }
}