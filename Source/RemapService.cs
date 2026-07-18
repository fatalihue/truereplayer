using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
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
        private static readonly object _lock = new();

        public static RemapConfig Current { get; private set; } = new();

        private static string GetPath()
        {
            string dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "TrueReplayer");
            Directory.CreateDirectory(dir);
            return Path.Combine(dir, FileName);
        }

        public static void Load()
        {
            lock (_lock)
            {
                try
                {
                    var path = GetPath();
                    if (File.Exists(path))
                    {
                        var json = File.ReadAllText(path);
                        Current = JsonSerializer.Deserialize<RemapConfig>(json,
                            new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new RemapConfig();
                    }
                }
                catch (Exception ex)
                {
                    DiagnosticLog.Error("remaps.json load failed — remap layer disabled until re-saved", ex);
                    Current = new RemapConfig();
                }
                Publish();
            }
        }

        public static void Save(RemapConfig config)
        {
            lock (_lock)
            {
                if (config.Remaps.Count > MaxRemaps)
                    config.Remaps = config.Remaps.GetRange(0, MaxRemaps);
                Current = config;
                try
                {
                    var json = JsonSerializer.Serialize(config, new JsonSerializerOptions { WriteIndented = true });
                    FileHelper.WriteAllTextAtomic(GetPath(), json);
                }
                catch (Exception ex)
                {
                    DiagnosticLog.Error("remaps.json save failed", ex);
                }
                Publish();
            }
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
            DiagnosticLog.Info($"Key remaps published: {active} active (config {Current.Remaps.Count}, enabled={Current.Enabled})");
        }
    }
}
