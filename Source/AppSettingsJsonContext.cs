using System.Text.Json.Serialization;

namespace TrueReplayer.Services
{
    [JsonSourceGenerationOptions(WriteIndented = true)]
    [JsonSerializable(typeof(AppSettingsManager.AppSettings))]
    internal partial class AppSettingsJsonContext : JsonSerializerContext
    {
    }
}
