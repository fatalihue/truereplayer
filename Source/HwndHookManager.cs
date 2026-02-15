using System;
using System.Runtime.InteropServices;

namespace TrueReplayer.Interop
{
    public static class HwndHookManager
    {
        private static WndProcDelegate? _callback;
        private delegate IntPtr WndProcDelegate(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, WndProcDelegate newProc);

        [DllImport("user32.dll")]
        private static extern IntPtr CallWindowProc(IntPtr lpPrevWndFunc, IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        private const int GWLP_WNDPROC = -4;
        private static IntPtr _oldWndProc = IntPtr.Zero;

        public static void SetupHook(IntPtr hwnd, Func<IntPtr, int, IntPtr, IntPtr, IntPtr> handler)
        {
            _callback = new WndProcDelegate((hWnd, msg, wParam, lParam) => handler(hWnd, msg, wParam, lParam));
            _oldWndProc = SetWindowLongPtr(hwnd, GWLP_WNDPROC, _callback);
        }

        public static IntPtr CallOriginalWndProc(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam)
        {
            return CallWindowProc(_oldWndProc, hWnd, msg, wParam, lParam);
        }
    }
}