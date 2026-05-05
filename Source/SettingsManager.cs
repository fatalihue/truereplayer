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

            var options = new JsonSerializerOptions
            {
                WriteIndented = true,
                TypeInfoResolver = new DefaultJsonTypeInfoResolver()
            };

            var json = JsonSerializer.Serialize(profile, options);
            await FileHelper.WriteAllTextAtomicAsync(filePath, json);
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
                obj["RestorePosition"] = obj["LockPosition"]?.GetValue<bool>() ?? false;
                obj.Remove("LockPosition");
                changed = true;
            }
            if (obj.ContainsKey("lockPosition") && !obj.ContainsKey("restorePosition"))
            {
                obj["restorePosition"] = obj["lockPosition"]?.GetValue<bool>() ?? false;
                obj.Remove("lockPosition");
                changed = true;
            }
            return changed;
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

        public static async Task<UserProfile?> LoadProfileAsync(string? filePath = null)
        {
            if (string.IsNullOrWhiteSpace(filePath))
                filePath = GetDefaultProfilePath();  // Usa o caminho padrão, se não for especificado

            if (!File.Exists(filePath)) return null;  // Verifica se o arquivo existe

            var options = new JsonSerializerOptions
            {
                TypeInfoResolver = new DefaultJsonTypeInfoResolver()
            };

            var json = await File.ReadAllTextAsync(filePath);  // Lê o arquivo de perfil
            json = MigrateProfileJson(json);                    // Renomeia LockPosition→RestorePosition se necessário
            var profile = JsonSerializer.Deserialize<UserProfile>(json, options);
            if (profile != null) MigrateRestoreSize(profile);   // Infere RestoreSize de perfis pré-split
            return profile;
        }
    }
}
