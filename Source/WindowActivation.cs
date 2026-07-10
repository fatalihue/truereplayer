using System;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using TrueReplayer.Interop;
using TrueReplayer.Models;

namespace TrueReplayer.Helpers
{
    /// <summary>
    /// Robust bring-to-foreground for arbitrary top-level windows, with verification.
    /// This is the full activation stack that <c>WindowEventManager.BringToForeground</c>
    /// uses for TrueReplayer's own window — restore-if-minimized (preserving maximized),
    /// the AttachThreadInput trick with the NULL-foreground guard, and the temporary
    /// SPI_SETFOREGROUNDLOCKTIMEOUT zeroing — extracted so the replay engine can apply
    /// it to TARGET windows instead of its historical attach-only copy.
    /// </summary>
    public static class WindowActivation
    {
        /// <summary>
        /// Bring <paramref name="hwnd"/> to the foreground and verify it actually got
        /// there. Returns false when Windows refused the switch (fullscreen-exclusive
        /// app holding focus, focus-steal prevention, etc.) — callers decide policy.
        /// <paramref name="target"/>/<paramref name="titleRegex"/> are optional: when
        /// given, verification also accepts ANY foreground window matching the target
        /// (UWP apps can swap the ApplicationFrameHost hwnd during activation).
        /// </summary>
        public static async Task<bool> ActivateAsync(
            IntPtr hwnd,
            WindowTarget? target = null,
            Regex? titleRegex = null,
            CancellationToken token = default)
        {
            if (hwnd == IntPtr.Zero) return false;

            // Only restore if minimized — preserves maximized state.
            if (NativeMethods.IsIconic(hwnd))
                NativeMethods.ShowWindow(hwnd, NativeMethods.SW_RESTORE);

            // Already the foreground window? Skip the activation dance entirely.
            if (IsForeground(hwnd, target, titleRegex))
                return true;

            uint currentThread = NativeMethods.GetCurrentThreadId();
            IntPtr foregroundHwnd = NativeMethods.GetForegroundWindow();
            // GetForegroundWindow returns NULL during focus transitions (menu just closed,
            // an app releasing fullscreen, etc.). Passing that on yields thread 0, and
            // AttachThreadInput(0, …) silently fails — so SetForegroundWindow gets rejected
            // by Windows' foreground lock. Guard the 0 case so we skip the (useless) attach
            // instead of poisoning the whole call.
            uint foregroundThread = foregroundHwnd != IntPtr.Zero
                ? NativeMethods.GetWindowThreadProcessId(foregroundHwnd, out _)
                : 0;

            bool attached = false;
            if (foregroundThread != 0 && foregroundThread != currentThread)
                attached = NativeMethods.AttachThreadInput(foregroundThread, currentThread, true);

            // Belt-and-suspenders: temporarily zero the foreground-lock timeout so Windows
            // honours SetForegroundWindow from a background process even when the attach
            // trick alone isn't enough. The user's real value is saved and restored in
            // finally so this can't leak.
            uint prevLockTimeout = 0;
            bool lockTimeoutZeroed = false;
            try
            {
                if (NativeMethods.SystemParametersInfo(NativeMethods.SPI_GETFOREGROUNDLOCKTIMEOUT, 0, ref prevLockTimeout, 0))
                    lockTimeoutZeroed = NativeMethods.SystemParametersInfo(NativeMethods.SPI_SETFOREGROUNDLOCKTIMEOUT, 0, IntPtr.Zero, NativeMethods.SPIF_SENDCHANGE);

                NativeMethods.BringWindowToTop(hwnd);
                NativeMethods.SetForegroundWindow(hwnd);
            }
            finally
            {
                if (lockTimeoutZeroed)
                    NativeMethods.SystemParametersInfo(NativeMethods.SPI_SETFOREGROUNDLOCKTIMEOUT, 0, new IntPtr(prevLockTimeout), NativeMethods.SPIF_SENDCHANGE);
                if (attached)
                    NativeMethods.AttachThreadInput(foregroundThread, currentThread, false);
            }

            // The switch is asynchronous on Windows' side — poll briefly before judging.
            for (int i = 0; i < 3; i++)
            {
                if (IsForeground(hwnd, target, titleRegex)) return true;
                await Task.Delay(100, token).ConfigureAwait(false);
            }
            return IsForeground(hwnd, target, titleRegex);
        }

        private static bool IsForeground(IntPtr hwnd, WindowTarget? target, Regex? titleRegex)
        {
            IntPtr fg = NativeMethods.GetForegroundWindow();
            if (fg == IntPtr.Zero) return false;
            if (NativeMethods.GetAncestor(fg, NativeMethods.GA_ROOT) == hwnd) return true;
            if (target == null) return false;
            // Never let the matcher fallback accept one of OUR OWN windows — TR's title
            // ("TrueReplayer") case-insensitively contains realistic matcher substrings
            // ("player", "true", "replay"), and a false "already foreground" here means
            // the caller skips activation and the following keystrokes type into
            // TrueReplayer itself. Mirrors FindWindowExcludingSelf's invariant; the
            // direct GA_ROOT check above still honours an EXPLICIT self-hwnd target.
            NativeMethods.GetWindowThreadProcessId(fg, out uint fgPid);
            if (fgPid == (uint)Environment.ProcessId) return false;
            return WindowMatcher.Matches(fg, target, titleRegex);
        }
    }
}
