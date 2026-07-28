using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Threading;
using TrueReplayer.Helpers;

namespace TrueReplayer.Services
{
    /// <summary>
    /// Persistence for the two "where did I stop" run cursors that used to live and die with the
    /// process:
    ///   • ROW    — Data-Loop Model B (a table present with "loop over data" OFF ⇒ each RUN
    ///              consumes ONE row). Keyed by the executing profile name.
    ///   • CYCLE  — SetVariable in Cycle mode (each execution takes the next list item).
    ///              Keyed "profileName|actionId".
    ///
    /// Both are deliberately excluded from the fresh-run reset — surviving across runs IS the
    /// feature — but they were plain in-memory dictionaries, so closing the app silently restarted
    /// every list at item 1. A user working a 40-row list across a day would quietly re-do rows 1-N
    /// after any restart, with nothing on screen saying so.
    ///
    /// STATIC on purpose: the exit paths that must flush (WindowEventManager.ForceExit, the
    /// update-and-restart, the WebView2 recovery restart) have no ReplayService reference to reach
    /// an instance through. Sidecar file + atomic write follows the remaps.json / profile-order.json
    /// convention (FileHelper.WriteAllTextAtomic yields UTF-8 with no BOM, matching what the app's
    /// other JSON writers produce).
    ///
    /// Writes are DEBOUNCED because the cycle cursor is hot: it advances once per execution of the
    /// row, i.e. once per iteration of a looping replay. The row cursor advances once per run.
    /// Every mutation also happens under <see cref="_lock"/> — a serializer thread enumerating a
    /// dictionary that the replay thread is resizing is exactly the crash the codebase already
    /// documents around _runStateLock.
    /// </summary>
    public static class RunCursorService
    {
        private const string FileName = "run-cursors.json";
        // Long enough that a tight loop coalesces into one write, short enough that a hard kill
        // (Task Manager) loses at most a second of progress. Mirrors the icon-cache debounce.
        private const int SaveDebounceMs = 1000;

        private sealed class CursorFile
        {
            public Dictionary<string, int> Row { get; set; } = new();
            public Dictionary<string, int> Cycle { get; set; } = new();
        }

        private static readonly object _lock = new();
        private static readonly Dictionary<string, int> _row = new(StringComparer.Ordinal);
        private static readonly Dictionary<string, int> _cycle = new(StringComparer.Ordinal);
        private static Timer? _saveTimer;
        private static bool _dirty;
        private static bool _loaded;

        private static string GetPath()
        {
            string dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "TrueReplayer");
            Directory.CreateDirectory(dir);
            return Path.Combine(dir, FileName);
        }

        /// <summary>Load at startup, before any replay can run. Never throws.</summary>
        public static void Load()
        {
            lock (_lock)
            {
                _loaded = true;
                try
                {
                    var path = GetPath();
                    if (!File.Exists(path)) return;
                    var parsed = JsonSerializer.Deserialize<CursorFile>(File.ReadAllText(path),
                        new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                    if (parsed == null) return;
                    foreach (var kv in parsed.Row) if (kv.Value >= 0) _row[kv.Key] = kv.Value;
                    foreach (var kv in parsed.Cycle) if (kv.Value >= 0) _cycle[kv.Key] = kv.Value;
                }
                catch (Exception ex)
                {
                    // A corrupt sidecar must never block startup — worst case every list restarts
                    // at item 1, which is exactly the old behaviour.
                    DiagnosticLog.Error("run-cursors.json load failed — cursors start from the top", ex);
                    _row.Clear();
                    _cycle.Clear();
                }
            }
        }

        public static bool TryGetRow(string key, out int value)
        {
            lock (_lock) return _row.TryGetValue(key, out value);
        }

        public static void SetRow(string key, int value)
        {
            lock (_lock) { _row[key] = value; MarkDirtyLocked(); }
        }

        public static void RemoveRow(string key)
        {
            // Reset must persist IMMEDIATELY: a debounced write means "Reset row position" followed
            // by a kill resurrects the old position, which reads as the reset never happening.
            lock (_lock) { if (_row.Remove(key)) { _dirty = true; SaveLocked(); } }
        }

        public static bool TryGetCycle(string key, out int value)
        {
            lock (_lock) return _cycle.TryGetValue(key, out value);
        }

        public static void SetCycle(string key, int value)
        {
            lock (_lock) { _cycle[key] = value; MarkDirtyLocked(); }
        }

        public static void RemoveCycle(string key)
        {
            lock (_lock) { if (_cycle.Remove(key)) { _dirty = true; SaveLocked(); } }
        }

        /// <summary>
        /// Follows a profile rename so its position isn't silently lost. Row keys ARE the profile
        /// name; cycle keys carry it as the part before the first '|' (the right half is an action
        /// Id — or, when a row has no Id, a lowercased variable name — so split on the FIRST
        /// separator only and keep the remainder verbatim). Mirrors TriggerService.RenameStats,
        /// which the profile-rename handler already calls for the same reason.
        /// </summary>
        public static void RenameProfile(string oldName, string newName)
        {
            if (string.IsNullOrEmpty(oldName) || string.IsNullOrEmpty(newName) || oldName == newName) return;
            lock (_lock)
            {
                bool changed = false;
                if (_row.Remove(oldName, out var rowVal)) { _row[newName] = rowVal; changed = true; }

                var moves = new List<(string OldKey, string NewKey, int Value)>();
                foreach (var kv in _cycle)
                {
                    int sep = kv.Key.IndexOf('|');
                    if (sep <= 0) continue;
                    if (!string.Equals(kv.Key[..sep], oldName, StringComparison.Ordinal)) continue;
                    moves.Add((kv.Key, newName + kv.Key[sep..], kv.Value));
                }
                foreach (var (oldKey, newKey, value) in moves)
                {
                    _cycle.Remove(oldKey);
                    _cycle[newKey] = value;
                    changed = true;
                }
                if (changed) { _dirty = true; SaveLocked(); }
            }
        }

        /// <summary>
        /// Drops cursors for profiles that no longer exist, so a deleted profile's position doesn't
        /// rot in the file forever (and can't be resurrected by a new profile reusing the name).
        /// Call ONCE after the first successful profile-list load, with the full set of names.
        ///
        /// No-ops on an empty set: an empty list means "the load failed / nothing scanned yet", and
        /// pruning on that would wipe every cursor the user has. Same defensive posture as
        /// ImageStorageService.CleanupOrphanImages sparing folders that failed to parse.
        /// </summary>
        public static void PruneMissingProfiles(IReadOnlyCollection<string> knownProfiles)
        {
            if (knownProfiles == null || knownProfiles.Count == 0) return;
            lock (_lock)
            {
                var known = new HashSet<string>(knownProfiles, StringComparer.Ordinal)
                {
                    // The No-Profile scratch buffer keys as "default" and belongs to no file.
                    "default",
                };
                bool changed = false;
                foreach (var key in new List<string>(_row.Keys))
                    if (!known.Contains(key)) { _row.Remove(key); changed = true; }
                foreach (var key in new List<string>(_cycle.Keys))
                {
                    int sep = key.IndexOf('|');
                    var profile = sep > 0 ? key[..sep] : key;
                    if (!known.Contains(profile)) { _cycle.Remove(key); changed = true; }
                }
                if (changed) { _dirty = true; SaveLocked(); }
            }
        }

        /// <summary>Writes any pending change now. Call on every exit path.</summary>
        public static void Flush()
        {
            lock (_lock) { if (_dirty) SaveLocked(); }
        }

        // Caller holds _lock.
        private static void MarkDirtyLocked()
        {
            _dirty = true;
            _saveTimer ??= new Timer(_ => Flush(), null, Timeout.Infinite, Timeout.Infinite);
            _saveTimer.Change(SaveDebounceMs, Timeout.Infinite);
        }

        // Caller holds _lock. Serializing inside the lock is deliberate: the payload is a handful of
        // small entries, and it removes any window where the dictionaries change between snapshot
        // and write.
        private static void SaveLocked()
        {
            if (!_loaded) return; // never write before a load — that would clobber the file with {}
            try
            {
                var payload = new CursorFile
                {
                    Row = new Dictionary<string, int>(_row, StringComparer.Ordinal),
                    Cycle = new Dictionary<string, int>(_cycle, StringComparer.Ordinal),
                };
                FileHelper.WriteAllTextAtomic(GetPath(),
                    JsonSerializer.Serialize(payload, new JsonSerializerOptions { WriteIndented = true }));
                // Cleared only on SUCCESS: clearing up front would make a transient write failure
                // (antivirus holding the temp file, disk full) drop the change silently, and the
                // next Flush would think there was nothing to write.
                _dirty = false;
            }
            catch (Exception ex)
            {
                DiagnosticLog.Error("run-cursors.json save failed — positions may restart after a restart", ex);
            }
        }
    }
}
