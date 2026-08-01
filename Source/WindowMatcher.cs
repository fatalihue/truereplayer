using System;
using System.Text;
using System.Text.RegularExpressions;
using TrueReplayer.Interop;
using TrueReplayer.Models;

namespace TrueReplayer.Helpers
{
    /// <summary>
    /// Centralised matching for <see cref="WindowTarget"/>. The hotkey gate
    /// (<c>IsForegroundWindowMatch</c>), the replay-time hwnd lookup
    /// (<c>FindTargetWindow</c>) and the bridge utilities (Convert Coordinates,
    /// Update Window Size) all need the same logic: a target matches a window when
    /// <em>both</em> ProcessName <em>and</em> WindowTitle (contains or regex) match.
    /// Keeping three copies has drifted — the replay-side variants ignored title,
    /// so title-only targets silently no-op'd and process+title matched the first
    /// visible window of the process (wrong tab in Chrome, etc.).
    /// </summary>
    public static class WindowMatcher
    {
        /// <summary>
        /// True when <paramref name="target"/> actually names something to search for. A non-null
        /// WindowTarget with both fields blank is NOT usable: <see cref="Matches"/> refuses it and
        /// <see cref="FindWindow"/> returns Zero, so it can never resolve to a window.
        ///
        /// This is the same predicate every inheritance decision in ProfileController uses to
        /// answer "does this profile own a target?". Call sites that only null-checked answered
        /// YES for a blank target, took the "use its own context" branch, and swapped the replay
        /// onto an unfindable window instead of inheriting the folder's — so keep the test here,
        /// in one place, rather than re-spelling it.
        /// </summary>
        public static bool IsUsable(WindowTarget? target) =>
            target != null
            && (!string.IsNullOrEmpty(target.ProcessName) || !string.IsNullOrEmpty(target.WindowTitle));

        /// <summary>
        /// The one rule for "was a window rect ever captured?", shared by every resolver that hands
        /// a rect to the replay engine (ProfileController.GetEffectiveGeometry and
        /// .GetFolderInheritedContext, ActionExecution's RunProfile context swap). Returns null when
        /// all four fields are still at their defaults — every capture stamps a size, so "0,0 and
        /// no size" reads as the untouched state, not a window someone parked at the top-left.
        ///
        /// Anything else is a real capture — including the size-less rect that "Convert coords →
        /// Absolute" leaves behind, where X/Y alone still says where the coordinates were measured
        /// from. On null the caller must suppress Restore Position AND Restore Size: position is
        /// deliberately not gated on having a size, so a rect of zeroes would be executed as a real
        /// move and slam the target window into the screen corner.
        ///
        /// KNOWN BLIND SPOT, accepted: those two paragraphs collide for one window. A borderless
        /// fullscreen game really does sit at 0,0, so capturing it and then running "Convert coords
        /// → Absolute" — which clears W/H and keeps X/Y on purpose — leaves (0,0,0,0), which this
        /// rule reads as untouched, and its position-only restore is dropped. Telling a captured
        /// origin from an untouched one needs a persisted "geometry captured" flag: a schema change
        /// and a version pin, deliberately out of scope here. A framed window in the corner reports
        /// -4,0 and is unaffected, and no profile on disk is in that state; the failure is a silent
        /// no-op, never a move to the wrong place.
        /// </summary>
        public static (int X, int Y, int Width, int Height)? CapturedRect(int x, int y, int width, int height)
            => x == 0 && y == 0 && width <= 0 && height <= 0 ? null : (x, y, width, height);

        /// <summary>
        /// Compile a regex for <see cref="WindowTarget.WindowTitle"/> when match mode is "regex".
        /// Returns null for contains-mode or invalid patterns. Callers should cache the result
        /// when the target is reused across many calls (replay loop, hook snapshot).
        /// </summary>
        public static Regex? CompileTitleRegex(WindowTarget? target)
        {
            if (target == null) return null;
            if (target.TitleMatchMode != "regex") return null;
            if (string.IsNullOrEmpty(target.WindowTitle)) return null;
            try
            {
                return new Regex(target.WindowTitle,
                    RegexOptions.IgnoreCase | RegexOptions.Compiled,
                    TimeSpan.FromMilliseconds(5));
            }
            catch
            {
                return null;
            }
        }

        /// <summary>
        /// Test whether <paramref name="hwnd"/> satisfies <paramref name="target"/>. Empty
        /// fields are wildcards (target with only ProcessName matches any window of that
        /// process; target with only WindowTitle matches any window with that title).
        /// Null target returns false — caller treats "no target" as "no match".
        /// </summary>
        /// <param name="titleBuffer">Optional reusable buffer to avoid allocations on hot paths.</param>
        /// <param name="procBuffer">Optional reusable buffer to avoid allocations on hot paths.</param>
        public static bool Matches(
            IntPtr hwnd,
            WindowTarget? target,
            Regex? compiledTitleRegex,
            StringBuilder? titleBuffer = null,
            StringBuilder? procBuffer = null)
        {
            if (hwnd == IntPtr.Zero) return false;
            if (target == null) return false;
            // A target with neither criterion set would otherwise fall through both checks and
            // match EVERY window. Treat "no criteria" the same as "no target" — match nothing.
            if (string.IsNullOrEmpty(target.ProcessName) && string.IsNullOrEmpty(target.WindowTitle))
                return false;

            // Title check
            if (!string.IsNullOrEmpty(target.WindowTitle))
            {
                var buf = titleBuffer ?? new StringBuilder(512);
                buf.Clear();
                NativeMethods.GetWindowText(hwnd, buf, buf.Capacity);
                string title = buf.ToString();

                if (target.TitleMatchMode == "regex")
                {
                    if (compiledTitleRegex == null) return false;
                    try
                    {
                        if (!compiledTitleRegex.IsMatch(title)) return false;
                    }
                    catch (RegexMatchTimeoutException)
                    {
                        return false;
                    }
                }
                else
                {
                    if (title.IndexOf(target.WindowTitle, StringComparison.OrdinalIgnoreCase) < 0)
                        return false;
                }
            }

            // Process check
            if (!string.IsNullOrEmpty(target.ProcessName))
            {
                NativeMethods.GetWindowThreadProcessId(hwnd, out uint pid);
                IntPtr hProcess = NativeMethods.OpenProcess(
                    NativeMethods.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
                if (hProcess == IntPtr.Zero)
                {
                    // Most common silent cause of "hotkey/replay doesn't fire": the target is
                    // elevated and TrueReplayer isn't, so OpenProcess fails with ACCESS_DENIED (5).
                    // Log the Win32 error so it's diagnosable from the session log instead of being
                    // indistinguishable from "window not in foreground".
                    int err = System.Runtime.InteropServices.Marshal.GetLastWin32Error();
                    TrueReplayer.Services.DiagnosticLog.Warn(
                        $"WindowMatcher: OpenProcess failed for '{target.ProcessName}' (pid {pid}), Win32 error {err}");
                    return false;
                }

                try
                {
                    var buf = procBuffer ?? new StringBuilder(512);
                    buf.Clear();
                    uint len = NativeMethods.GetProcessImageFileName(hProcess, buf, (uint)buf.Capacity);
                    if (len == 0) return false;

                    string fullPath = buf.ToString();
                    string fileName = System.IO.Path.GetFileName(fullPath);

                    if (!fileName.Equals(target.ProcessName, StringComparison.OrdinalIgnoreCase))
                        return false;
                }
                finally
                {
                    NativeMethods.CloseHandle(hProcess);
                }
            }

            return true;
        }

        /// <summary>
        /// Enumerate top-level visible windows and return the first one matching the target.
        /// Returns <c>IntPtr.Zero</c> when no window matches or the target is empty.
        /// Pass <paramref name="compiledTitleRegex"/> when the caller already cached it
        /// (replay loops do).
        /// </summary>
        public static IntPtr FindWindow(WindowTarget? target, Regex? compiledTitleRegex = null)
        {
            if (target == null) return IntPtr.Zero;
            if (string.IsNullOrEmpty(target.ProcessName) && string.IsNullOrEmpty(target.WindowTitle))
                return IntPtr.Zero;

            var titleBuffer = new StringBuilder(512);
            var procBuffer = new StringBuilder(512);
            // Compile lazily if the caller didn't pre-compile.
            Regex? regex = compiledTitleRegex ?? CompileTitleRegex(target);

            IntPtr result = IntPtr.Zero;
            NativeMethods.EnumWindows((hwnd, lParam) =>
            {
                if (!NativeMethods.IsWindowVisible(hwnd)) return true;
                if (Matches(hwnd, target, regex, titleBuffer, procBuffer))
                {
                    result = hwnd;
                    return false; // stop enumeration
                }
                return true;
            }, IntPtr.Zero);
            return result;
        }
    }
}
