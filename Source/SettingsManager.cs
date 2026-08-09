using System;
using System.Collections.ObjectModel;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization.Metadata;
using System.Threading.Tasks;
using TrueReplayer.Models;

namespace TrueReplayer.Services
{
    public static class SettingsManager
    {
        // JsonSerializerOptions IS the type-metadata cache in System.Text.Json, so a fresh
        // instance per call rebuilds the whole UserProfile -> ObservableCollection<ActionItem>
        // -> ActionItem reflection graph from scratch. LoadProfileAsync runs once PER FILE in
        // ProfileController.LoadProfileListAsync (~80 profiles for a real user) and every
        // RefreshProfileListAsync goes through it, so that was one metadata rebuild per profile
        // per refresh. Options are frozen on first use, so sharing one instance is safe —
        // ProfileController.OrderJsonOptions already does exactly this for profile-order.json.
        private static readonly JsonSerializerOptions LoadOptions = new()
        {
            // The main store writes PascalCase; case-insensitive load lets the camelCase
            // migration shims (e.g. ActionItem.sendPlainOnly → SendMode) bind, matches the
            // import path, and tolerates a hand-edited profile with off-case keys.
            PropertyNameCaseInsensitive = true,
            TypeInfoResolver = new DefaultJsonTypeInfoResolver()
        };

        private static readonly JsonSerializerOptions SaveOptions = new()
        {
            WriteIndented = true,
            TypeInfoResolver = new DefaultJsonTypeInfoResolver()
        };

        private static string GetDefaultProfilePath()
        {
            string profileDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                "TrueReplayer", "Profiles"
            );

            Directory.CreateDirectory(profileDir);
            return Path.Combine(profileDir, "profile.json");
        }

        public static async Task SaveProfileAsync(string? filePath, UserProfile profile)
        {
            if (string.IsNullOrWhiteSpace(filePath))
                filePath = GetDefaultProfilePath();  // Usa o caminho padrão, se não for especificado

            // Belt-and-suspenders: repair any block imbalance still in memory before the
            // JSON hits disk. The load-time validator catches everything from the file
            // side, but an in-memory mutation (bridge bug, undo/redo race, drag that
            // straddled a block boundary) could in principle leave the profile unbalanced
            // until save. Idempotent for already-clean profiles.
            //
            // CRITICAL: do NOT mutate profile.Actions in place. Some callers pass an
            // ObservableCollection that's bound to the UI grid — silently removing
            // orphan rows during save would make rows vanish from the user's screen
            // mid-save. Build a fresh snapshot, repair it, and swap it onto the profile
            // just long enough to serialize, then restore the original reference.
            var snapshot = new System.Collections.ObjectModel.ObservableCollection<ActionItem>(profile.Actions);
            var saveFix = ConditionalBlockValidator.ValidateAndRepairBlocks(snapshot);
            if (saveFix.HadFixups)
                DiagnosticLog.Info($"[ConditionalBlocks] Save-time repair on '{Path.GetFileNameWithoutExtension(filePath)}': removed {saveFix.OrphansRemoved} orphan(s), appended {saveFix.EndIfsAppended} synthetic ENDIF(s)");

            var originalActions = profile.Actions;
            try
            {
                profile.Actions = snapshot;
                var json = JsonSerializer.Serialize(profile, SaveOptions);
                await FileHelper.WriteAllTextAtomicAsync(filePath, json);
            }
            finally
            {
                // Restore the caller's original collection reference so the UI grid binding
                // survives the save unchanged.
                profile.Actions = originalActions;
            }
        }

        /// <summary>
        /// Migra a chave JSON "LockPosition"/"lockPosition" (nome antigo) para
        /// "RestorePosition"/"restorePosition" (nome novo). Aplicado antes da deserialização para
        /// que perfis pré-rename continuem funcionando — tanto profile.json (PascalCase) quanto
        /// envelopes .trprofile (camelCase, com array Profiles/profiles).
        /// </summary>
        public static string MigrateProfileJson(string json)
        {
            try
            {
                var node = JsonNode.Parse(json);
                if (node is JsonObject root)
                {
                    bool changed = false;
                    // UserProfile direto (PascalCase no profile.json)
                    changed |= MigrateProfileObject(root);
                    // Envelope .trprofile: profiles[] em camelCase OU PascalCase
                    if (root["Profiles"] is JsonArray pascal)
                        foreach (var p in pascal) if (p is JsonObject po) changed |= MigrateProfileObject(po);
                    if (root["profiles"] is JsonArray camel)
                        foreach (var p in camel) if (p is JsonObject po) changed |= MigrateProfileObject(po);
                    if (changed) return root.ToJsonString();
                }
            }
            catch { /* malformed JSON falls through to deserializer for normal error path */ }
            return json;
        }

        /// <summary>
        /// Every raw-JSON migration that applies to one profile object, in dependency order: the
        /// LockPosition rename can CREATE RestorePosition, and the RestoreSize inference reads it.
        /// </summary>
        private static bool MigrateProfileObject(JsonObject obj)
        {
            bool changed = RenameLockPositionKey(obj);
            changed |= InferRestoreSizeFromLegacy(obj);
            return changed;
        }

        /// <summary>
        /// Pre-RestoreSize, a single "Lock Position" flag gated position AND size together. Splitting
        /// it left old profiles with no RestoreSize key at all, so a profile that used to restore its
        /// whole rect came back restoring only the position. When the key is ABSENT and the old flag
        /// was on over a captured rect, restore the original intent.
        ///
        /// The ABSENCE of the key is the entire signal, and it has to be read here, from the raw
        /// JSON. This inference used to run on the DESERIALIZED profile, where a missing key and an
        /// explicit false are both just `false` — so it re-fired on EVERY load, and a user who turned
        /// Restore Size off on a profile with a captured rect got it silently turned back on the next
        /// time that profile was loaded. The setting could not be switched off at all. UserProfile
        /// .RestoreSize carries no JsonIgnore, so every profile written since the split has the key;
        /// only a genuinely pre-split file is missing it, and a file can only be missing it once.
        /// Same shape as <see cref="RenameLockPositionKey"/>, which has always gated on ContainsKey.
        /// </summary>
        private static bool InferRestoreSizeFromLegacy(JsonObject obj)
        {
            if (obj.ContainsKey("RestoreSize") || obj.ContainsKey("restoreSize")) return false;
            if (!ReadBoolLoose(GetEitherCase(obj, "RestorePosition", "restorePosition"))) return false;
            if (ReadIntLoose(GetEitherCase(obj, "WindowWidth", "windowWidth")) <= 0) return false;
            if (ReadIntLoose(GetEitherCase(obj, "WindowHeight", "windowHeight")) <= 0) return false;
            // Mirror the casing the object already uses, so a camelCase .trprofile entry stays
            // camelCase. Both readers bind case-insensitively, but don't make the file mixed.
            obj[obj.ContainsKey("restorePosition") ? "restoreSize" : "RestoreSize"] = true;
            return true;
        }

        private static JsonNode? GetEitherCase(JsonObject obj, string pascal, string camel)
            => obj.TryGetPropertyValue(pascal, out var p) && p != null ? p
             : obj.TryGetPropertyValue(camel, out var c) ? c : null;

        // Geometry is written as a JSON number; tolerate a string for the same reason
        // ReadBoolLoose exists — a hand-edited profile shouldn't abort the whole migration.
        private static int ReadIntLoose(JsonNode? node)
        {
            if (node == null) return 0;
            try { return node.GetValue<int>(); } catch { }
            return int.TryParse(node.ToString().Trim(), out var v) ? v : 0;
        }

        private static bool RenameLockPositionKey(JsonObject obj)
        {
            bool changed = false;
            if (obj.ContainsKey("LockPosition") && !obj.ContainsKey("RestorePosition"))
            {
                obj["RestorePosition"] = ReadBoolLoose(obj["LockPosition"]);
                obj.Remove("LockPosition");
                changed = true;
            }
            if (obj.ContainsKey("lockPosition") && !obj.ContainsKey("restorePosition"))
            {
                obj["restorePosition"] = ReadBoolLoose(obj["lockPosition"]);
                obj.Remove("lockPosition");
                changed = true;
            }
            return changed;
        }

        // Legacy LockPosition was a JSON bool, but tolerate a stray string/number so a malformed
        // value doesn't throw out of GetValue<bool>() and abort the whole settings migration.
        private static bool ReadBoolLoose(JsonNode? node)
        {
            if (node == null) return false;
            try { return node.GetValue<bool>(); } catch { }
            var s = node.ToString().Trim();
            return s.Equals("true", StringComparison.OrdinalIgnoreCase) || s == "1";
        }

        /// <summary>
        /// Backfill ActionItem.Id for profiles created before the stable-id schema landed.
        /// Old actions deserialize with Id = empty string (no field in JSON); we assign a
        /// fresh GUID per action. Idempotent — actions already carrying an Id are left alone,
        /// so re-saving doesn't churn IDs and break frontend React keys across sessions.
        /// </summary>
        public static void MigrateActionIds(UserProfile profile)
        {
            foreach (var action in profile.Actions)
            {
                if (string.IsNullOrEmpty(action.Id))
                    action.Id = Guid.NewGuid().ToString("N");
            }
        }

        public static async Task<UserProfile?> LoadProfileAsync(string? filePath = null)
        {
            if (string.IsNullOrWhiteSpace(filePath))
                filePath = GetDefaultProfilePath();  // Usa o caminho padrão, se não for especificado

            if (!File.Exists(filePath)) return null;  // Verifica se o arquivo existe

            var json = await File.ReadAllTextAsync(filePath);  // Lê o arquivo de perfil
            // Raw-JSON migrations (LockPosition rename + pre-split RestoreSize inference). Both
            // gate on a key being absent, which only the undeserialized text can tell us.
            //
            // MigrateProfileJson parses a whole JsonNode DOM to look for two legacy keys, so every
            // profile was being parsed TWICE — a full DOM of the action array built and thrown away,
            // once per file, ~80 times per profile-list refresh. Neither migration can apply to a
            // file that already has RestoreSize and no LockPosition, which is every profile written
            // since the split, so a substring test skips the DOM for the common case.
            //
            // Applied HERE and not inside MigrateProfileJson: profile.json is a single UserProfile
            // object, so one test speaks for the whole file. The .trprofile import path shares that
            // method with a multi-profile envelope where one entry can have the key and another not,
            // and a whole-document substring test would be wrong there.
            //
            // Suffix matching ("ockPosition" / "estoreSize") so one test covers both the PascalCase
            // profile.json spelling and a camelCase hand edit.
            bool mayNeedMigration =
                json.Contains("ockPosition", StringComparison.Ordinal) ||
                !json.Contains("estoreSize", StringComparison.Ordinal);
            if (mayNeedMigration)
                json = MigrateProfileJson(json);
            var profile = JsonSerializer.Deserialize<UserProfile>(json, LoadOptions);
            if (profile != null)
            {
                MigrateActionIds(profile);     // Backfill stable Id for pre-2.2.6 actions
            }
            return profile;
        }
    }
}
