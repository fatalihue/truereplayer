using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Threading;
using TrueReplayer.Helpers;

namespace TrueReplayer.Services
{
    /// <summary>
    /// Always-on 1:1 key remap layer (the AutoHotkey classic: CapsLock→Esc, mouse
    /// side-button→key, disable a key). Config lives in its own sidecar
    /// Documents\TrueReplayer\remaps.json (the AppSettings POCO's full-rebuild save
    /// pattern doesn't fit lists; profile-order.json precedent) and is loaded in the
    /// MainWindow ctor BEFORE the input hooks start — the layer must work even if
    /// WebView2 never comes up (tray-daemon usage). The UI only edits + republishes.
    /// The hook-facing artifact is a volatile snapshot dictionary registered into
    /// InputHookManager (ProfileHotkeys pattern).
    /// </summary>
    public static class RemapService
    {
        public class RemapEntry
        {
            public string From { get; set; } = "";
            // Empty string = disable the key (swallow with no replacement).
            public string To { get; set; } = "";
            public bool Enabled { get; set; } = true;
        }

        public class RemapConfig
        {
            public bool Enabled { get; set; } = true;
            public List<RemapEntry> Remaps { get; set; } = new();
        }

        public const int MaxRemaps = 32;
        private const string FileName = "remaps.json";

        // Last content of remaps.json that PARSED. Written by Load (the text just proved itself)
        // and refreshed after a successful Save; never touched while the load latch is on, because
        // then it is the only surviving copy of the user's list.
        private const string BackupFileName = "remaps.bak.json";

        // Where an edit goes while the latch is on. Nothing reads it back automatically: the app
        // cannot know whether remaps.json became readable again with NEWER content than this, so
        // merging is the user's call. Both the balloon and the log name the path.
        private const string PendingFileName = "remaps.pending.json";

        private static readonly object _lock = new();

        public static RemapConfig Current { get; private set; } = new();

        /// <summary>
        /// TRUE only for "remaps.json is there and we could not turn it into a config" — a sharing
        /// violation (this sidecar lives under Documents, which is usually cloud-synced), an
        /// antivirus lock, a write cut short, hand-edited JSON. It is NOT set when the file is
        /// simply absent: that is a legitimately empty config, the state every fresh install is in.
        ///
        /// Collapsing those two into one empty <see cref="Current"/> is what made a transient read
        /// failure permanent. Up to 32 remaps rendered as an empty panel, indistinguishable from
        /// having none — and the first thing anyone tries, flipping "Enable Key Remaps" off and on
        /// to see if that wakes it up, called Save with that empty list and wrote it over the file.
        /// One locked read, and the list was gone for good. While this is set Save will not touch
        /// remaps.json at all (see Save), so the data outlives whatever was holding the file.
        /// </summary>
        public static bool LoadFailed { get; private set; }

        /// <summary>Why <see cref="LoadFailed"/> is set, in one line, for the log and the UI.</summary>
        public static string? LoadFailureDetail { get; private set; }

        /// <summary>
        /// True when <see cref="Current"/> came from <see cref="BackupFileName"/> because
        /// remaps.json was unreadable. The layer works and the panel is populated, but what is
        /// shown is the last known-good copy, which may be older than the file on disk.
        /// </summary>
        public static bool LoadedFromBackup { get; private set; }

        // Read attempts for a file that exists but will not open. The holders we lose to here —
        // OneDrive/Dropbox uploading it, Defender scanning it moments after a write — keep it for
        // tens of milliseconds, not seconds, so three quick tries clear nearly all of them.
        // Deliberately much shorter than FileHelper's write-side ladder (~3.8s): this runs in the
        // MainWindow ctor, before the hooks exist, and a frozen startup is its own bug.
        private const int ReadRetryAttempts = 3;
        private const int ReadRetryDelayMs = 40;

        private static string GetPath()
        {
            string dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "TrueReplayer");
            Directory.CreateDirectory(dir);
            return Path.Combine(dir, FileName);
        }

        private static string SiblingPath(string fileName) =>
            Path.Combine(Path.GetDirectoryName(GetPath())!, fileName);

        public static void Load()
        {
            lock (_lock)
            {
                var path = GetPath();

                // No FileHelper.CleanupOrphanTemps sweep here, deliberately. It matches on SHAPE —
                // 8 lowercase-alnum chars, '.', 3 more — which is safe in Profiles\, a directory
                // only the app writes to with long names. This one is Documents\TrueReplayer: the
                // user opens it, and an ordinary file of theirs like mymacros.txt fits that shape
                // exactly. A data-loss fix must not plant a delete-by-pattern in a user folder.
                // WriteAllTextAtomic only strands a temp when both its retried Move AND its
                // cleanup Delete fail, and every other sidecar here already lives with that.

                // A retry is a fresh verdict: a file that reads fine now is no longer quarantined.
                LoadFailed = false;
                LoadFailureDetail = null;
                LoadedFromBackup = false;

                if (!File.Exists(path))
                {
                    // ABSENT. Nothing to protect and nothing to warn about — this is what a new
                    // install looks like, and Save stays free to create the file.
                    Current = new RemapConfig();
                    Publish();
                    return;
                }

                // PRESENT. From here on, every failure path must leave the file alone.
                if (TryReadText(path, out var json, out var readError))
                {
                    var parsed = TryParse(json, out var parseError);
                    if (parsed != null)
                    {
                        Current = parsed;
                        // Snapshot the text we just proved parseable, so the next start has
                        // something to fall back on if the file is unreadable by then.
                        WriteBackupIfChanged(json);
                        Publish();
                        return;
                    }
                    readError = parseError;
                }

                LoadFailed = true;
                LoadFailureDetail = Describe(readError);
                DiagnosticLog.Error(
                    $"remaps.json could not be read — it will NOT be overwritten; edits this session go to {PendingFileName}",
                    readError ?? new IOException("unknown read failure"));

                if (TryLoadBackup(out var backup))
                {
                    Current = backup;
                    LoadedFromBackup = true;
                    Announce("Key remaps: file unreadable",
                        $"remaps.json could not be read, so the last backup was loaded ({backup.Remaps.Count} remaps). The file is not overwritten — edits go to {PendingFileName}.");
                }
                else
                {
                    Current = new RemapConfig();
                    Announce("Key remaps: file unreadable",
                        "remaps.json could not be read and there is no backup, so the list shows empty. The file was NOT overwritten — see the session log.");
                }
                Publish();
            }
        }

        /// <param name="overwriteUnreadableFile">
        /// The explicit "yes, replace whatever is in that file" the quarantine below waits for.
        /// Only a deliberate user choice may pass true — every ordinary save leaves it false.
        /// </param>
        public static void Save(RemapConfig config, bool overwriteUnreadableFile = false)
        {
            lock (_lock)
            {
                if (config.Remaps.Count > MaxRemaps)
                    config.Remaps = config.Remaps.GetRange(0, MaxRemaps);

                // The edit takes effect in this session either way. The layer is live state, and
                // refusing to apply it would stack a second, invisible failure on the first.
                Current = config;
                try
                {
                    var json = JsonSerializer.Serialize(config, new JsonSerializerOptions { WriteIndented = true });

                    if (LoadFailed && !overwriteUnreadableFile)
                    {
                        // QUARANTINE. We hold a config we could not read off disk, so writing it
                        // back is not a save, it is a delete of everything the file still holds.
                        if (config.Remaps.Count == 0)
                        {
                            // Nothing worth preserving, and a pending file containing an empty
                            // list is a trap: it invites the user to copy it over a remaps.json
                            // that may be perfectly intact by then. Write nothing.
                            DiagnosticLog.Warn(
                                "Key remaps: change NOT written — remaps.json is unreadable and the in-memory list is empty. Live for this session only.");
                            Announce("Key remaps not saved",
                                "remaps.json could not be read, so nothing was written to disk. Your change is active for this session only.");
                        }
                        else
                        {
                            FileHelper.WriteAllTextAtomic(SiblingPath(PendingFileName), json);
                            DiagnosticLog.Warn(
                                $"Key remaps: remaps.json is unreadable, so the change was written to {PendingFileName} instead. remaps.json is untouched.");
                            Announce("Key remaps not saved",
                                $"remaps.json could not be read, so your change went to {PendingFileName}. It is active for this session.");
                        }
                        // Note the backup is NOT refreshed here: while the main file is unreadable
                        // it is the last known-good copy, and this content never came off disk.
                    }
                    else
                    {
                        FileHelper.WriteAllTextAtomic(GetPath(), json);
                        WriteBackupIfChanged(json);
                        if (LoadFailed)
                        {
                            // The user chose to replace the unreadable file and we did: the file on
                            // disk is ours again, so the quarantine has nothing left to protect.
                            LoadFailed = false;
                            LoadFailureDetail = null;
                            LoadedFromBackup = false;
                            DiagnosticLog.Info("remaps.json overwritten on explicit request — load-failure quarantine cleared.");
                        }
                    }
                }
                catch (Exception ex)
                {
                    DiagnosticLog.Error("remaps.json save failed", ex);
                }
                Publish();
            }
        }

        /// <summary>
        /// Opens with FileShare.ReadWrite where File.ReadAllText asks for FileShare.Read only:
        /// a sync agent or scanner that has the file open for WRITING fails the stricter mode,
        /// and this is a file no other part of the process writes concurrently.
        /// </summary>
        private static bool TryReadText(string path, out string text, out Exception? error,
            int attempts = ReadRetryAttempts)
        {
            text = "";
            error = null;
            for (int attempt = 0; attempt < attempts; attempt++)
            {
                try
                {
                    using var stream = new FileStream(path, FileMode.Open, FileAccess.Read,
                        FileShare.ReadWrite | FileShare.Delete);
                    using var reader = new StreamReader(stream, detectEncodingFromByteOrderMarks: true);
                    text = reader.ReadToEnd();
                    return true;
                }
                catch (Exception ex)
                {
                    error = ex;
                    if (attempt < attempts - 1) Thread.Sleep(ReadRetryDelayMs);
                }
            }
            return false;
        }

        // Malformed content is not retried — it will be just as malformed 40ms later. Kept apart
        // from TryReadText so the two failures stay distinguishable in the log.
        private static RemapConfig? TryParse(string json, out Exception? error)
        {
            error = null;
            try
            {
                return JsonSerializer.Deserialize<RemapConfig>(json,
                    new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new RemapConfig();
            }
            catch (Exception ex)
            {
                error = ex;
                return null;
            }
        }

        private static bool TryLoadBackup(out RemapConfig config)
        {
            config = new RemapConfig();
            try
            {
                var backupPath = SiblingPath(BackupFileName);
                if (!File.Exists(backupPath)) return false;
                if (!TryReadText(backupPath, out var text, out _)) return false;
                var parsed = TryParse(text, out _);
                if (parsed == null) return false;
                config = parsed;
                DiagnosticLog.Info($"Key remaps recovered from {BackupFileName}: {parsed.Remaps.Count} entries.");
                return true;
            }
            catch
            {
                return false;
            }
        }

        // Compares before writing: Load calls this on every app start, and this directory is
        // typically cloud-synced — rewriting identical bytes is a sync upload for nothing.
        // A backup that cannot be written is never a reason to fail the thing it backs up.
        private static void WriteBackupIfChanged(string json)
        {
            try
            {
                var backupPath = SiblingPath(BackupFileName);
                // One attempt only: this read decides "skip a redundant write", nothing more, and
                // Save runs it on the UI thread. If the backup is momentarily locked we just
                // rewrite it — and if THAT fails, the catch below turns it into a log line.
                if (File.Exists(backupPath)
                    && TryReadText(backupPath, out var existing, out _, attempts: 1)
                    && string.Equals(existing, json, StringComparison.Ordinal))
                {
                    return;
                }
                FileHelper.WriteAllTextAtomic(backupPath, json);
            }
            catch (Exception ex)
            {
                DiagnosticLog.Warn($"remaps backup write failed: {ex.GetType().Name}: {ex.Message}");
            }
        }

        private static string Describe(Exception? ex) =>
            ex == null ? "unknown read failure" : $"{ex.GetType().Name}: {ex.Message}";

        // The tray balloon is the only user-facing surface this service can reach on its own: Load
        // runs in the window ctor, long before WebView2 (and in tray-daemon usage the panel may
        // never open at all). Never let a notification failure break a load or a save.
        private static void Announce(string title, string text)
        {
            try { TrayIconService.ShowBalloon(title, text); }
            catch (Exception ex) { DiagnosticLog.Warn($"remap notification failed: {ex.GetType().Name}: {ex.Message}"); }
        }

        public static void SetEnabled(bool enabled)
        {
            RemapConfig updated;
            lock (_lock)
            {
                updated = new RemapConfig { Enabled = enabled, Remaps = Current.Remaps };
            }
            Save(updated);
        }

        /// <summary>
        /// Compiles the config into the hook's vk→vk snapshot: enabled entries only,
        /// self-remaps rejected, duplicate FROMs first-wins, unresolvable names skipped.
        /// TO of "" maps to 0 = swallow-only (disable the key).
        /// </summary>
        // Generic modifier names (what hotkey capture emits for either physical side) fan out
        // to BOTH side vks on the FROM side — capturing RIGHT Alt shows "Alt" in the chip, and
        // remapping only the left one would silently target the wrong physical key.
        private static readonly Dictionary<string, ushort[]> ModifierSidePairs = new(StringComparer.OrdinalIgnoreCase)
        {
            ["Ctrl"] = new ushort[] { 0xA2, 0xA3 },
            ["Alt"] = new ushort[] { 0xA4, 0xA5 },
            ["Shift"] = new ushort[] { 0xA0, 0xA1 },
            ["Win"] = new ushort[] { 0x5B, 0x5C },
        };

        private static void Publish()
        {
            var map = new Dictionary<int, ushort>();
            int active = 0;
            if (Current.Enabled)
            {
                foreach (var entry in Current.Remaps)
                {
                    if (!entry.Enabled) continue;
                    if (string.IsNullOrWhiteSpace(entry.From)) continue;
                    if (string.Equals(entry.From, entry.To, StringComparison.OrdinalIgnoreCase)) continue;
                    ushort toVk = 0;
                    if (!string.IsNullOrWhiteSpace(entry.To)
                        && !KeyUtils.TryResolveVirtualKeyCode(entry.To, out toVk)) continue;
                    // X-button vks resolve (they're in the map for release polling) but a
                    // KEYBOARD injection of a mouse-button vk is a no-op — accepting one
                    // would silently DISABLE the FROM key instead of clicking. Sources only.
                    if (toVk == 0x05 || toVk == 0x06) continue;

                    ushort[] fromVks;
                    if (ModifierSidePairs.TryGetValue(entry.From.Trim(), out var pair))
                        fromVks = pair;
                    else if (KeyUtils.TryResolveVirtualKeyCode(entry.From, out var fromVk))
                        fromVks = new[] { fromVk };
                    else
                        continue;

                    bool added = false;
                    foreach (var fv in fromVks)
                    {
                        if (map.ContainsKey(fv)) continue;   // duplicate FROM — first wins
                        map[fv] = toVk;
                        added = true;
                    }
                    if (added) active++;
                }
            }
            InputHookManager.RegisterRemaps(map);
            // The suffix is what makes "0 active" readable after the fact: an empty layer because
            // the user has no remaps and an empty layer because the file would not open used to
            // write the identical log line.
            string state = !LoadFailed ? ""
                : LoadedFromBackup ? " — from BACKUP, remaps.json unreadable"
                : " — remaps.json UNREADABLE, list not recovered";
            DiagnosticLog.Info($"Key remaps published: {active} active (config {Current.Remaps.Count}, enabled={Current.Enabled}){state}");
        }
    }
}
