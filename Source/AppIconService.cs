using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using Microsoft.Win32;

namespace TrueReplayer.Services
{
    /// <summary>
    /// Resolves a process-name (e.g. "chrome.exe") to a base64-encoded PNG of its icon.
    /// Used to render the app icon next to each profile/folder in the side panel — the
    /// profile's effective WindowTarget tells us which exe, and this service handles
    /// "where is that exe on disk, and what does its icon look like".
    ///
    /// Lookup order (first hit wins):
    ///   1. Running process — if any instance of <c>{name}.exe</c> is alive,
    ///      <see cref="Process.MainModule"/> gives us the path directly.
    ///   2. Per-machine App Paths registry key — covers most installed apps
    ///      (Chrome, Firefox, Notepad++, Discord, OBS, etc.).
    ///   3. Per-user App Paths — single-user installs (Chrome's user install,
    ///      portable launchers).
    ///
    /// On failure (UWP host where the .exe is <c>ApplicationFrameHost.exe</c>,
    /// portable apps not in PATH, name typo) the cache stores <c>null</c> so we
    /// don't retry every push. The UI degrades to the existing crosshair badge —
    /// no error, just no icon. Cache lives for the session; clear by restarting
    /// the app (rare enough that an explicit invalidation API isn't worth the
    /// surface area).
    /// </summary>
    public static class AppIconService
    {
        // ProcessName → base64 PNG (or null when resolution failed). Case-insensitive
        // because Windows treats "chrome.exe" and "Chrome.EXE" as the same file but
        // ProfileEntries are populated from user-typed input that can disagree on case.
        private static readonly Dictionary<string, string?> _cache =
            new(StringComparer.OrdinalIgnoreCase);
        private static readonly object _lock = new();

        public static string? GetIconBase64(string? processName)
        {
            if (string.IsNullOrWhiteSpace(processName)) return null;

            lock (_lock)
            {
                if (_cache.TryGetValue(processName, out var cached)) return cached;
            }

            string? path = ResolveExecutablePath(processName);
            string? result = null;

            if (!string.IsNullOrEmpty(path) && File.Exists(path))
            {
                try
                {
                    using var icon = Icon.ExtractAssociatedIcon(path);
                    if (icon != null)
                    {
                        using var bmp = icon.ToBitmap();
                        using var ms = new MemoryStream();
                        bmp.Save(ms, ImageFormat.Png);
                        result = Convert.ToBase64String(ms.ToArray());
                    }
                }
                catch (Exception ex)
                {
                    Debug.WriteLine($"[AppIconService] Failed to extract icon for {path}: {ex.Message}");
                }
            }

            lock (_lock)
            {
                _cache[processName] = result;
            }
            return result;
        }

        private static string? ResolveExecutablePath(string processName)
        {
            // Normalise: accept "chrome", "chrome.exe", or "Chrome.EXE" the same way.
            string nameNoExt = processName.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
                ? processName.Substring(0, processName.Length - 4)
                : processName;
            string exeName = nameNoExt + ".exe";

            // 1. Running processes — preferred because it confirms the exact build the user
            //    is actually launching (matters for portable installs and side-by-side
            //    versions). GetProcessesByName is cheap; MainModule access can throw if the
            //    process is elevated and we are not, so we swallow per-process.
            try
            {
                var procs = Process.GetProcessesByName(nameNoExt);
                foreach (var p in procs)
                {
                    try
                    {
                        string? path = p.MainModule?.FileName;
                        if (!string.IsNullOrEmpty(path) && File.Exists(path))
                        {
                            return path;
                        }
                    }
                    catch
                    {
                        // Access denied for elevated process — try next instance / fallback.
                    }
                    finally
                    {
                        p.Dispose();
                    }
                }
            }
            catch
            {
                // Process enumeration itself failed (rare, machine-level issue). Fall through.
            }

            // 2. App Paths — HKLM. Default value of the key is the absolute path to the exe.
            //    This is the same lookup the Windows Run dialog and ShellExecute use, so it
            //    covers the long tail of properly-installed apps that aren't running right now.
            string? registryPath = TryReadAppPath(Registry.LocalMachine, exeName)
                                   ?? TryReadAppPath(Registry.CurrentUser, exeName);

            if (!string.IsNullOrEmpty(registryPath) && File.Exists(registryPath))
            {
                return registryPath;
            }

            return null;
        }

        private static string? TryReadAppPath(RegistryKey root, string exeName)
        {
            try
            {
                using var key = root.OpenSubKey(
                    $@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exeName}");
                if (key?.GetValue(null) is string raw)
                {
                    return raw.Trim().Trim('"');
                }
            }
            catch
            {
                // Registry access denied or key malformed — give up silently.
            }
            return null;
        }
    }
}
