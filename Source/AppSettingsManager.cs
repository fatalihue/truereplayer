using System;
using System.IO;
using System.Text.Json;

namespace TrueReplayer.Services
{
    public static class AppSettingsManager
    {
        private const string FileName = "appsettings.json";

        public class AppSettings
        {
            public bool AlwaysOnTop { get; set; } = false;
            public bool MinimizeToTray { get; set; } = false;
        }

        public static void Save(AppSettings settings)
        {
            try
            {
                var json = JsonSerializer.Serialize(settings, AppSettingsJsonContext.Default.AppSettings);
                File.WriteAllText(GetPath(), json);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Erro ao salvar appsettings: {ex.Message}");
            }
        }

        public static AppSettings Load()
        {
            string path = GetPath();

            if (!File.Exists(path))
                return new AppSettings();

            try
            {
                var json = File.ReadAllText(path);
                return JsonSerializer.Deserialize(json, AppSettingsJsonContext.Default.AppSettings) ?? new AppSettings();
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Erro ao carregar appsettings: {ex.Message}");
                return new AppSettings();
            }
        }

        private static string GetPath()
        {
            string dir = AppContext.BaseDirectory;
            return Path.Combine(dir, FileName);
        }
    }
}
