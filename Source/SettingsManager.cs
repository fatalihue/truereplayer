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

            var options = new JsonSerializerOptions
            {
                WriteIndented = true,
                TypeInfoResolver = new DefaultJsonTypeInfoResolver()
            };

            var originalActions = profile.Actions;
            try
            {
                profile.Actions = snapshot;
                var json = JsonSerializer.Serialize(profile, options);
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
                    changed |= RenameLockPositionKey(root);
                    // Envelope .trprofile: profiles[] em camelCase OU PascalCase
                    if (root["Profiles"] is JsonArray pascal)
                        foreach (var p in pascal) if (p is JsonObject po) changed |= RenameLockPositionKey(po);
                    if (root["profiles"] is JsonArray camel)
                        foreach (var p in camel) if (p is JsonObject po) changed |= RenameLockPositionKey(po);
                    if (changed) return root.ToJsonString();
                }
            }
            catch { /* malformed JSON falls through to deserializer for normal error path */ }
            return json;
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
        /// Pré-RestoreSize, "Lock Position" gateava ambos. Se geometria foi capturada e Restore
        /// Position estava ligado, preserva intenção original ligando RestoreSize também.
        /// </summary>
        public static void MigrateRestoreSize(UserProfile profile)
        {
            if (profile.RestorePosition && !profile.RestoreSize
                && profile.WindowWidth > 0 && profile.WindowHeight > 0)
            {
                profile.RestoreSize = true;
            }
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

            var options = new JsonSerializerOptions
            {
                // The main store writes PascalCase; case-insensitive load lets the camelCase
                // migration shims (e.g. ActionItem.sendPlainOnly → SendMode) bind, matches the
                // import path, and tolerates a hand-edited profile with off-case keys.
                PropertyNameCaseInsensitive = true,
                TypeInfoResolver = new DefaultJsonTypeInfoResolver()
            };

            var json = await File.ReadAllTextAsync(filePath);  // Lê o arquivo de perfil
            json = MigrateProfileJson(json);                    // Renomeia LockPosition→RestorePosition se necessário
            var profile = JsonSerializer.Deserialize<UserProfile>(json, options);
            if (profile != null)
            {
                MigrateRestoreSize(profile);   // Infere RestoreSize de perfis pré-split
                MigrateActionIds(profile);     // Backfill stable Id for pre-2.2.6 actions
            }
            return profile;
        }
    }
}
