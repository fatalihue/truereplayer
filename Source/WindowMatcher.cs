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
        /// </summary>
        /// <param name="titleBuffer">Optional reusable buffer to avoid allocations on hot paths.</param>
        /// <param name="procBuffer">Optional reusable buffer to avoid allocations on hot paths.</param>
        public static bool Matches(
            IntPtr hwnd,
            WindowTarget target,
            Regex? compiledTitleRegex,
            StringBuilder? titleBuffer = null,
            StringBuilder? procBuffer = null)
        {
            if (hwnd == IntPtr.Zero) return false;
            if (target == null) return false;

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
                if (hProcess == IntPtr.Zero) return false;

                try
                {
                    var buf = procBuffer ?? new StringBuilder(512);
                    buf.Clear();
                    uint len = NativeMethods.GetProcessImageFileName(hProcess, buf, (uint)buf.Capacity);
                    if (len == 0) return false;

                    string fullPath = buf.ToString();
                    string fileName = fullPath.Substring(fullPath.LastIndexOf('\\') + 1);

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
