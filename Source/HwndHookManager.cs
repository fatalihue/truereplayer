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

        // Restore overload: takes the raw pointer SetWindowLongPtr handed back, so the original
        // WndProc can be put back without manufacturing a managed delegate around it.
        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtr", SetLastError = true)]
        private static extern IntPtr SetWindowLongPtrRaw(IntPtr hWnd, int nIndex, IntPtr newProc);

        [DllImport("user32.dll")]
        private static extern IntPtr CallWindowProc(IntPtr lpPrevWndFunc, IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        private const int GWLP_WNDPROC = -4;
        private static IntPtr _oldWndProc = IntPtr.Zero;
        // The window the subclass is installed on, so RemoveHook can address it without the
        // caller having to hold on to the handle.
        private static IntPtr _hookedHwnd = IntPtr.Zero;

        public static void SetupHook(IntPtr hwnd, Func<IntPtr, int, IntPtr, IntPtr, IntPtr> handler)
        {
            // Idempotent by refusal, not by re-installing. _callback and _oldWndProc are singletons,
            // so a second install would (a) drop the first delegate for the GC while USER32 still
            // holds its native thunk — a crash on that window's next message — and (b) overwrite
            // _oldWndProc, making CallOriginalWndProc forward window 1 into window 2's original
            // WndProc. InputHookManager keeps its low-level hook delegates in static readonly
            // fields for exactly this reason; this class has to enforce the same thing at runtime
            // because its delegate is built per call.
            if (_callback != null)
            {
                TrueReplayer.Services.DiagnosticLog.Warn(
                    $"HwndHookManager.SetupHook: subclass already installed on 0x{_hookedHwnd.ToInt64():X}; " +
                    $"ignoring the request for 0x{hwnd.ToInt64():X}.");
                return;
            }

            // _callback is a static field on purpose: it must outlive this method so the GC can't
            // collect the delegate while USER32 still holds its native thunk (a collected thunk
            // would crash on the next window message). Bound via the ANSI entry point to stay
            // consistent with CallWindowProc below — both pass params through unchanged and this
            // WndProc handles no text messages, so A/W translation is moot.
            var callback = new WndProcDelegate((hWnd, msg, wParam, lParam) => handler(hWnd, msg, wParam, lParam));
            IntPtr previous = SetWindowLongPtr(hwnd, GWLP_WNDPROC, callback);
            if (previous == IntPtr.Zero)
            {
                int err = Marshal.GetLastWin32Error();
                if (err != 0)
                {
                    TrueReplayer.Services.DiagnosticLog.Error(
                        $"HwndHookManager.SetupHook: SetWindowLongPtr failed (Win32 error {err}); window subclass not installed.");
                    // Publish nothing on failure: leaving _callback null keeps this call
                    // retryable and keeps CallOriginalWndProc from forwarding into a null proc.
                    return;
                }
            }
            _callback = callback;
            _oldWndProc = previous;
            _hookedHwnd = hwnd;
        }

        /// <summary>
        /// Puts the original WndProc back and forgets the subclass.
        /// </summary>
        /// <remarks>
        /// Called on the way out of the process. Without it the managed thunk stays installed
        /// until the process dies, so the WM_DESTROY / WM_NCDESTROY that Windows dispatches while
        /// <c>Environment.Exit(0)</c> is already tearing the CLR down re-enter managed code — the
        /// one window where that re-entry has no guarantee of finding a live runtime. Safe to call
        /// when nothing is installed, and safe to call twice.
        /// </remarks>
        public static void RemoveHook()
        {
            if (_callback == null || _hookedHwnd == IntPtr.Zero || _oldWndProc == IntPtr.Zero)
            {
                _callback = null;
                _hookedHwnd = IntPtr.Zero;
                _oldWndProc = IntPtr.Zero;
                return;
            }
            SetWindowLongPtrRaw(_hookedHwnd, GWLP_WNDPROC, _oldWndProc);
            // Cleared AFTER the restore, so a message arriving mid-restore still finds a valid
            // _oldWndProc to forward to rather than a zeroed one.
            _callback = null;
            _hookedHwnd = IntPtr.Zero;
            _oldWndProc = IntPtr.Zero;
        }

        [DllImport("user32.dll")]
        private static extern IntPtr DefWindowProc(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        public static IntPtr CallOriginalWndProc(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam)
        {
            // Zero means either the subclass never installed or RemoveHook already ran. Passing a
            // null lpPrevWndFunc to CallWindowProc is undefined; DefWindowProc is the documented
            // stand-in and keeps a message that races the teardown from faulting.
            if (_oldWndProc == IntPtr.Zero)
                return DefWindowProc(hWnd, msg, wParam, lParam);
            return CallWindowProc(_oldWndProc, hWnd, msg, wParam, lParam);
        }
    }
}