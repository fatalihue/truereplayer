using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace TrueReplayer.Services
{
    /// <summary>
    /// Resolves a process-name (e.g. "chrome.exe") to a base64-encoded PNG of its icon.
    /// Used to render the app icon next to each profile/folder in the side panel.
    ///
    /// Lookup strategy (first hit wins):
    ///   1. <b>In-memory cache</b> — populated on first use from the on-disk cache, plus any
    ///      resolutions performed during the current session. Entries are revalidated using
    ///      the .exe's <c>LastWriteTimeUtc</c>: a stale timestamp triggers re-extraction from
    ///      the same path, and a missing file falls through to a full re-resolve.
    ///   2. <b>Running process</b> — <see cref="Process.GetProcessesByName"/> +
    ///      <see cref="ProcessModule.FileName"/>. Confirms the exact build the user actually
    ///      launches; matters for portable installs and side-by-side versions.
    ///   3. <b>App Paths registry</b> (HKLM → HKCU) — covers most installed apps even when
    ///      they aren't running. Same lookup the Windows Run dialog uses.
    ///
    /// On disk: <c>Documents/TrueReplayer/icon-cache.json</c>. Survives restarts so portable
    /// apps that aren't running at startup still show their icon, and so the registry walk
    /// is skipped for known processes. Self-invalidates via file <c>LastWriteTimeUtc</c>, so
    /// app updates that change the icon get picked up on next lookup without manual TTL.
    ///
    /// Null results (resolution failed) are kept in memory for the session to avoid retry
    /// loops, but <b>never persisted</b> — next launch tries fresh, since the user may have
    /// installed the missing app in between.
    /// </summary>
    public static class AppIconService
    {
        // Cache value semantics:
        //   - non-null CacheEntry  → resolved successfully; revalidate via LastWriteTime
        //   - null                 → resolution failed this session; don't retry, don't persist
        //   - key absent           → never tried in this session; full lookup needed
        private sealed record CacheEntry(string Path, long LastWriteTimeUtcTicks, string PngBase64);

        private static readonly Dictionary<string, CacheEntry?> _cache =
            new(StringComparer.OrdinalIgnoreCase);
        private static readonly object _lock = new();
        private static bool _diskLoaded;
        private static Timer? _saveTimer;
        // 1 s debounce: PushProfilesUpdate can fire several times in a burst (profile list
        // rebuild, folder edits) and each one resolves icons for every profile. Coalescing
        // all writes within a second collapses that to a single disk hit. Loses at most 1 s
        // of cache work on kill — acceptable, next launch re-resolves whatever was missed.
        private const int SaveDebounceMs = 1000;

        private static string CachePath => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
            "TrueReplayer", "icon-cache.json");

        public static string? GetIconBase64(string? processName)
        {
            if (string.IsNullOrWhiteSpace(processName)) return null;

            EnsureDiskLoaded();

            // ── Step 1: in-memory cache lookup ────────────────────────────────────
            CacheEntry? entry;
            bool hadEntry;
            lock (_lock)
            {
                hadEntry = _cache.TryGetValue(processName, out entry);
                if (hadEntry && entry == null)
                {
                    // Known-failed this session — don't retry until next launch.
                    return null;
                }
            }

            // ── Step 2: revalidate existing entry (path still there + LastWrite matches) ──
            // Outside the lock because File I/O isn't cheap and we don't want to block
            // other lookups while we hit the disk.
            if (entry != null)
            {
                try
                {
                    if (File.Exists(entry.Path))
                    {
                        long currentTicks = File.GetLastWriteTimeUtc(entry.Path).Ticks;
                        if (currentTicks == entry.LastWriteTimeUtcTicks)
                        {
                            return entry.PngBase64;
                        }

                        // Timestamp changed — app was updated. Re-extract from the same path
                        // rather than redoing the whole process+registry walk, since the path
                        // is still valid.
                        string? refreshed = ExtractIconFromPath(entry.Path);
                        if (refreshed != null)
                        {
                            lock (_lock)
                            {
                                _cache[processName] = new CacheEntry(entry.Path, currentTicks, refreshed);
                            }
                            ScheduleSave();
                            return refreshed;
                        }
                        // Re-extract failed — fall through to a full resolve.
                    }
                    // Path vanished (uninstalled, moved) — fall through.
                }
                catch (Exception ex)
                {
                    Debug.WriteLine($"[AppIconService] Revalidation failed for {processName}: {ex.Message}");
                    // Fall through to full resolve.
                }
            }

            // ── Step 3: full resolve (running processes → registry → extract) ─────
            string? resolvedPath = ResolveExecutablePath(processName);
            string? png = null;
            long lastWriteTicks = 0;

            if (!string.IsNullOrEmpty(resolvedPath) && File.Exists(resolvedPath))
            {
                png = ExtractIconFromPath(resolvedPath);
                if (png != null)
                {
                    try { lastWriteTicks = File.GetLastWriteTimeUtc(resolvedPath).Ticks; }
                    catch { /* race with file delete — leave at 0, next revalidation will refresh */ }
                }
            }

            // ── Step 4: write back to cache ───────────────────────────────────────
            bool needSave;
            lock (_lock)
            {
                if (png != null && !string.IsNullOrEmpty(resolvedPath))
                {
                    _cache[processName] = new CacheEntry(resolvedPath!, lastWriteTicks, png);
                    needSave = true;
                }
                else
                {
                    _cache[processName] = null;
                    // Schedule save only if disk used to have this entry — otherwise we'd
                    // touch the file for no reason. `hadEntry` covers the "loaded from disk
                    // and now invalid" case; if it was never on disk, no-op.
                    needSave = hadEntry && entry != null;
                }
            }
            if (needSave) ScheduleSave();
            return png;
        }

        private static string? ExtractIconFromPath(string path)
        {
            try
            {
                using var icon = Icon.ExtractAssociatedIcon(path);
                if (icon == null) return null;
                using var bmp = icon.ToBitmap();
                using var ms = new MemoryStream();
                bmp.Save(ms, ImageFormat.Png);
                return Convert.ToBase64String(ms.ToArray());
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[AppIconService] Failed to extract icon from {path}: {ex.Message}");
                return null;
            }
        }

        private static string? ResolveExecutablePath(string processName)
        {
            string nameNoExt = processName.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
                ? processName.Substring(0, processName.Length - 4)
                : processName;
            string exeName = nameNoExt + ".exe";

            // 1. Running processes. MainModule throws on elevation mismatch — swallow per-proc.
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
                        // Access denied — try next instance.
                    }
                    finally
                    {
                        p.Dispose();
                    }
                }
            }
            catch
            {
                // Process enumeration itself failed — fall through.
            }

            // 2. App Paths registry — per-machine, then per-user.
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
                // Registry access denied / key malformed — give up silently.
            }
            return null;
        }

        // ─────────────────────────────────────────────────────────────────────────
        //  Persistence
        // ─────────────────────────────────────────────────────────────────────────

        private sealed class PersistedEntry
        {
            public string Path { get; set; } = "";
            public long LastWriteTimeUtcTicks { get; set; }
            public string PngBase64 { get; set; } = "";
        }

        private static void EnsureDiskLoaded()
        {
            lock (_lock)
            {
                if (_diskLoaded) return;
                _diskLoaded = true;

                try
                {
                    if (!File.Exists(CachePath)) return;
                    string json = File.ReadAllText(CachePath);
                    var data = JsonSerializer.Deserialize<Dictionary<string, PersistedEntry>>(json);
                    if (data == null) return;

                    foreach (var (key, value) in data)
                    {
                        if (value != null
                            && !string.IsNullOrEmpty(value.Path)
                            && !string.IsNullOrEmpty(value.PngBase64))
                        {
                            _cache[key] = new CacheEntry(value.Path, value.LastWriteTimeUtcTicks, value.PngBase64);
                        }
                    }
                }
                catch (Exception ex)
                {
                    Debug.WriteLine($"[AppIconService] Failed to load icon cache from {CachePath}: {ex.Message}");
                    // Continue with empty in-memory cache — file may be corrupt, will be
                    // overwritten on next successful save.
                }
            }
        }

        private static void ScheduleSave()
        {
            // Debounce: each call cancels the previous timer and starts a fresh one. The
            // dispose/recreate dance happens under the lock so two threads racing to schedule
            // can't leak timers.
            lock (_lock)
            {
                _saveTimer?.Dispose();
                _saveTimer = new Timer(_ => _ = SaveToDiskAsync(), null, SaveDebounceMs, Timeout.Infinite);
            }
        }

        private static async Task SaveToDiskAsync()
        {
            Dictionary<string, PersistedEntry> snapshot;
            lock (_lock)
            {
                // Only persist successful resolutions. Null entries (failed-this-session) are
                // ephemeral — next launch should try again.
                snapshot = new Dictionary<string, PersistedEntry>(StringComparer.OrdinalIgnoreCase);
                foreach (var (key, value) in _cache)
                {
                    if (value != null)
                    {
                        snapshot[key] = new PersistedEntry
                        {
                            Path = value.Path,
                            LastWriteTimeUtcTicks = value.LastWriteTimeUtcTicks,
                            PngBase64 = value.PngBase64,
                        };
                    }
                }
            }

            try
            {
                string dir = Path.GetDirectoryName(CachePath)!;
                Directory.CreateDirectory(dir);
                string json = JsonSerializer.Serialize(snapshot, new JsonSerializerOptions
                {
                    WriteIndented = true,
                });
                await FileHelper.WriteAllTextAtomicAsync(CachePath, json);
            }
            catch (Exception ex)
            {
                Debug.WriteLine($"[AppIconService] Failed to save icon cache: {ex.Message}");
                // Cache continues to work in memory; next change retries the save.
            }
        }
    }
}
