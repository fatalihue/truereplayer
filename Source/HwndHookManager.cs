using System;
using System.Runtime.InteropServices;

namespace TrueReplayer.Interop
{
    public static class HwndHookManager
    {
        private static WndProcDelegate? _callback;
        private delegate IntPtr WndProcDelegate(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, WndProcDelegate newProc);

        [DllImport("user32.dll")]
        private static extern IntPtr CallWindowProc(IntPtr lpPrevWndFunc, IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        private const int GWLP_WNDPROC = -4;
        private static IntPtr _oldWndProc = IntPtr.Zero;

        public static void SetupHook(IntPtr hwnd, Func<IntPtr, int, IntPtr, IntPtr, IntPtr> handler)
        {
            // _callback is a static field on purpose: it must outlive this method so the GC can't
            // collect the delegate while USER32 still holds its native thunk (a collected thunk
            // would crash on the next window message). Bound via the ANSI entry point to stay
            // consistent with CallWindowProc below — both pass params through unchanged and this
            // WndProc handles no text messages, so A/W translation is moot.
            _callback = new WndProcDelegate((hWnd, msg, wParam, lParam) => handler(hWnd, msg, wParam, lParam));
            _oldWndProc = SetWindowLongPtr(hwnd, GWLP_WNDPROC, _callback);
            if (_oldWndProc == IntPtr.Zero)
            {
                int err = Marshal.GetLastWin32Error();
                if (err != 0)
                    TrueReplayer.Services.DiagnosticLog.Error(
                        $"HwndHookManager.SetupHook: SetWindowLongPtr failed (Win32 error {err}); window subclass not installed.");
            }
        }

        public static IntPtr CallOriginalWndProc(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam)
        {
            return CallWindowProc(_oldWndProc, hWnd, msg, wParam, lParam);
        }
    }
}