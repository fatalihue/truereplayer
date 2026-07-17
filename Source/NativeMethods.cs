using System;
using System.Runtime.InteropServices;

namespace TrueReplayer.Interop
{
    internal static class NativeMethods
    {
        public const uint INPUT_MOUSE = 0;
        public const uint INPUT_KEYBOARD = 1;

        public const uint MOUSEEVENTF_MOVE = 0x0001;
        public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const uint MOUSEEVENTF_LEFTUP = 0x0004;
        public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        public const uint MOUSEEVENTF_WHEEL = 0x0800;
        public const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;

        public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        public const uint KEYEVENTF_KEYUP = 0x0002;
        public const uint KEYEVENTF_SCANCODE = 0x0008;

        public const int WH_MOUSE_LL = 14;
        public const int WH_KEYBOARD_LL = 13;

        public const int WM_LBUTTONDOWN = 0x0201;
        public const int WM_LBUTTONUP = 0x0202;
        public const int WM_RBUTTONDOWN = 0x0204;
        public const int WM_RBUTTONUP = 0x0205;
        public const int WM_MBUTTONDOWN = 0x0207;
        public const int WM_MBUTTONUP = 0x0208;
        public const int WM_MOUSEWHEEL = 0x020A;

        public const int WM_KEYDOWN = 0x0100;
        public const int WM_KEYUP = 0x0101;

        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT
        {
            public uint type;
            public InputUnion U;
        }

        [StructLayout(LayoutKind.Explicit)]
        public struct InputUnion
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int x;
            public int y;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MSLLHOOKSTRUCT
        {
            public POINT pt;
            public uint mouseData;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        public delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);
        public delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

        // SetLastError=true so a failed hook install (returns IntPtr.Zero) surfaces a meaningful
        // Marshal.GetLastWin32Error() in InputHookManager.Start()'s diagnostic logging.
        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll")]
        public static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll")]
        public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll")]
        public static extern IntPtr GetModuleHandle(string lpModuleName);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        [DllImport("user32.dll")]
        public static extern bool GetCursorPos(out POINT lpPoint);

        [DllImport("user32.dll")]
        public static extern uint MapVirtualKey(uint uCode, uint uMapType);

        [DllImport("user32.dll")]
        public static extern bool SetCursorPos(int X, int Y);

        [DllImport("user32.dll")]
        public static extern short GetAsyncKeyState(int vKey);

        [DllImport("user32.dll")]
        public static extern int GetSystemMetrics(int nIndex);

        // System double-click time (ms) — the same threshold the OS uses to pair two
        // clicks into a double-click. Used by the recorder's DoubleClick merge so
        // recording agrees with what the target app itself perceived.
        [DllImport("user32.dll")]
        public static extern uint GetDoubleClickTime();

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

        [DllImport("psapi.dll", CharSet = CharSet.Unicode)]
        public static extern uint GetProcessImageFileName(IntPtr hProcess, System.Text.StringBuilder lpImageFileName, uint nSize);

        [DllImport("kernel32.dll")]
        public static extern bool CloseHandle(IntPtr hObject);

        public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

        [DllImport("user32.dll")]
        public static extern IntPtr WindowFromPoint(POINT point);

        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left, Top, Right, Bottom;
        }

        [DllImport("user32.dll")]
        public static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);

        public const uint GA_ROOT = 2;

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);

        public const uint MB_ICONERROR = 0x00000010;

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr hWnd); // true if minimized

        // ── Out-of-window run-status notifications (UI Wave 3) ──
        // FlashWindowEx pulses the taskbar button; MessageBeep plays the system
        // sound scheme's chime (no bundled audio asset, respects user's scheme
        // incl. "No Sounds"). Both are fired only when the TrueReplayer window
        // is NOT foreground — the game usually is.
        [StructLayout(LayoutKind.Sequential)]
        public struct FLASHWINFO
        {
            public uint cbSize;
            public IntPtr hwnd;
            public uint dwFlags;
            public uint uCount;
            public uint dwTimeout;
        }

        public const uint FLASHW_TRAY = 0x00000002;      // flash the taskbar button
        public const uint FLASHW_TIMERNOFG = 0x0000000C; // flash until the window comes to the foreground

        [DllImport("user32.dll")]
        public static extern bool FlashWindowEx(ref FLASHWINFO pwfi);

        public const uint MB_OK_BEEP = 0x00000000;        // MB_OK — "done" chime
        public const uint MB_ICONERROR_BEEP = 0x00000010; // MB_ICONERROR — "failed" chime

        [DllImport("user32.dll")]
        public static extern bool MessageBeep(uint uType);

        [DllImport("user32.dll")]
        public static extern uint GetDpiForWindow(IntPtr hWnd);

        /// <summary>GetDpiForWindow with the 0-means-96 fallback every caller needs.</summary>
        public static uint GetDpiForWindowSafe(IntPtr hWnd)
        {
            uint dpi = GetDpiForWindow(hWnd);
            return dpi == 0 ? 96u : dpi;
        }

        [DllImport("user32.dll")]
        public static extern bool IsZoomed(IntPtr hWnd); // true if maximized

        [DllImport("user32.dll")]
        public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

        public const uint SWP_NOSIZE = 0x0001;
        public const uint SWP_NOMOVE = 0x0002;
        public const uint SWP_NOZORDER = 0x0004;

        [DllImport("user32.dll")]
        public static extern IntPtr GetKeyboardLayout(uint idThread);

        [DllImport("user32.dll")]
        public static extern int ToUnicodeEx(
            uint wVirtKey, uint wScanCode, byte[] lpKeyState,
            [Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pwszBuff,
            int cchBuff, uint wFlags, IntPtr dwhkl);

        [DllImport("user32.dll")]
        public static extern short VkKeyScanEx(char ch, IntPtr dwhkl);

        [DllImport("user32.dll")]
        public static extern bool GetKeyboardState(byte[] lpKeyState);

        [DllImport("user32.dll")]
        public static extern uint MapVirtualKeyEx(uint uCode, uint uMapType, IntPtr dwhkl);

        // GDI screen capture
        public const int SRCCOPY = 0x00CC0020;

        [DllImport("gdi32.dll")]
        public static extern IntPtr CreateDC(string lpszDriver, string? lpszDevice, string? lpszOutput, IntPtr lpInitData);

        [DllImport("gdi32.dll")]
        public static extern IntPtr CreateCompatibleDC(IntPtr hdc);

        [DllImport("gdi32.dll")]
        public static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int nWidth, int nHeight);

        [DllImport("gdi32.dll")]
        public static extern IntPtr SelectObject(IntPtr hdc, IntPtr hgdiobj);

        [DllImport("gdi32.dll")]
        public static extern bool BitBlt(IntPtr hdcDest, int xDest, int yDest, int wDest, int hDest,
            IntPtr hdcSrc, int xSrc, int ySrc, int dwRop);

        [DllImport("gdi32.dll")]
        public static extern bool DeleteObject(IntPtr hObject);

        [DllImport("gdi32.dll")]
        public static extern bool DeleteDC(IntPtr hdc);

        // GetDC(NULL) returns a DC for the entire virtual screen (all monitors), letting
        // GetPixel sample any visible pixel without per-monitor handling. ReleaseDC must
        // be called on the same hWnd that was passed to GetDC, even when that hWnd is NULL.
        // GetPixel returns a COLORREF (0x00BBGGRR) or CLR_INVALID (0xFFFFFFFF) when the
        // coordinates fall outside the DC. Used by PixelColorService for WaitPixelColor.
        [DllImport("user32.dll")]
        public static extern IntPtr GetDC(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

        [DllImport("gdi32.dll")]
        public static extern uint GetPixel(IntPtr hdc, int nXPos, int nYPos);

        // Window management
        public const int SW_MINIMIZE = 6;
        public const int SW_RESTORE = 9;

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool BringWindowToTop(IntPtr hWnd);

        // True when the window's thread hasn't pumped its message queue for ~5s (frozen app).
        // Heuristic — a genuine hang guard, not a general "ready" signal for a slow-but-pumping loader.
        [DllImport("user32.dll")]
        public static extern bool IsHungAppWindow(IntPtr hWnd);

        // Two overloads: GET writes the value through a ref; SET passes the new value IN the
        // pvParam slot itself (SPI_SETFOREGROUNDLOCKTIMEOUT is a "value-in-pointer" action).
        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, ref uint pvParam, uint fWinIni);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, IntPtr pvParam, uint fWinIni);

        public const uint SPI_GETFOREGROUNDLOCKTIMEOUT = 0x2000;
        public const uint SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001;
        public const uint SPIF_SENDCHANGE = 0x0002;

        [DllImport("user32.dll")]
        public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

        [DllImport("kernel32.dll")]
        public static extern uint GetCurrentThreadId();

        public static IntPtr SetMouseHook(LowLevelMouseProc proc)
        {
            using var curProcess = System.Diagnostics.Process.GetCurrentProcess();
            using var curModule = curProcess.MainModule!;
            return SetWindowsHookEx(WH_MOUSE_LL, proc, GetModuleHandle(curModule.ModuleName!), 0);
        }

        public static IntPtr SetKeyboardHook(LowLevelKeyboardProc proc)
        {
            using var curProcess = System.Diagnostics.Process.GetCurrentProcess();
            using var curModule = curProcess.MainModule!;
            return SetWindowsHookEx(WH_KEYBOARD_LL, proc, GetModuleHandle(curModule.ModuleName!), 0);
        }

        /// <summary>
        /// Virtual-screen bounds (SM_X/YVIRTUALSCREEN + SM_CX/CYVIRTUALSCREEN) cached
        /// to avoid 4 P/Invoke calls per mouse action / clicker iteration. The values
        /// only change on monitor add/remove or DPI change — both rare events; users
        /// who hit one can restart the replay to pick up the new bounds. Worth the
        /// micro-saving in the cursor-clicker hot loop where SimulateMouse fires at
        /// 10+ Hz and previously did 4 GetSystemMetrics calls per click.
        /// </summary>
        public static class VirtualScreen
        {
            // Guards the cache fields below. Bounds is read from the replay/clicker thread
            // while Invalidate() runs on the UI thread's WndProc (WM_DISPLAYCHANGE), so the
            // lock prevents a torn-tuple read (mixed old/new bounds) and double-initialization.
            // It does not change the values returned for a given display configuration.
            private static readonly object _gate = new object();
            private static int _x, _y, _w, _h;
            private static bool _cached;

            public static (int X, int Y, int W, int H) Bounds
            {
                get
                {
                    lock (_gate)
                    {
                        if (!_cached)
                        {
                            _x = GetSystemMetrics(76); // SM_XVIRTUALSCREEN
                            _y = GetSystemMetrics(77); // SM_YVIRTUALSCREEN
                            _w = GetSystemMetrics(78); // SM_CXVIRTUALSCREEN
                            _h = GetSystemMetrics(79); // SM_CYVIRTUALSCREEN
                            _cached = true;
                        }
                        return (_x, _y, _w, _h);
                    }
                }
            }

            /// <summary>
            /// Drops the cache so the next read re-queries Windows. Wired to the
            /// WM_DISPLAYCHANGE message in WindowShellServices' WndProc, so it fires
            /// automatically on a monitor reconfiguration or DPI change.
            /// </summary>
            public static void Invalidate()
            {
                lock (_gate)
                {
                    _cached = false;
                }
            }
        }
    }
}