using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;
using Velopack;
using Velopack.Sources;

namespace TrueReplayer.Services
{
    public static class UpdateService
    {
        private const string RepoOwner = "fatalihue";
        private const string RepoName = "TrueReplayer-releases";
        private const string RepoUrl = "https://github.com/" + RepoOwner + "/" + RepoName;

        private static readonly UpdateManager _manager = new(
            new GithubSource(RepoUrl, null, false));

        private static readonly HttpClient _http = CreateHttpClient();

        private static UpdateInfo? _pendingUpdate;
        private static string? _cachedReleaseNotes;
        private static string? _cachedReleaseNotesVersion;

        public static bool IsInstalled => _manager.IsInstalled;

        public static string? CurrentVersion => _manager.IsInstalled
            ? _manager.CurrentVersion?.ToString()
            : null;

        private static HttpClient CreateHttpClient()
        {
            var client = new HttpClient();
            client.DefaultRequestHeaders.UserAgent.ParseAdd("TrueReplayer-Updater/1.0");
            client.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
            client.Timeout = TimeSpan.FromSeconds(10);
            return client;
        }

        /// <summary>
        /// Checks GitHub Releases for a newer version.
        /// Returns the new version string, or null if up-to-date.
        /// </summary>
        public static async Task<string?> CheckForUpdateAsync()
        {
            if (!_manager.IsInstalled)
                return null;

            try
            {
                _pendingUpdate = await _manager.CheckForUpdatesAsync();
                return _pendingUpdate?.TargetFullRelease?.Version?.ToString();
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[UpdateService] Check failed: {ex.Message}");
                return null;
            }
        }

        /// <summary>
        /// Fetches the markdown release notes from the GitHub Releases API for the
        /// pending update. Parsed into a list of bullet points suitable for the
        /// changelog panel. Returns an empty list on failure.
        /// </summary>
        public static async Task<List<string>> GetPendingReleaseNotesAsync()
        {
            var version = _pendingUpdate?.TargetFullRelease?.Version?.ToString();
            if (string.IsNullOrEmpty(version))
                return new List<string>();

            // Return cached if same version
            if (_cachedReleaseNotesVersion == version && _cachedReleaseNotes != null)
                return ParseMarkdownBullets(_cachedReleaseNotes);

            try
            {
                // Try v-prefixed tag first (project convention), then fall back to bare.
                var tags = new[] { $"v{version}", version };
                foreach (var tag in tags)
                {
                    var url = $"https://api.github.com/repos/{RepoOwner}/{RepoName}/releases/tags/{tag}";
                    using var req = new HttpRequestMessage(HttpMethod.Get, url);
                    using var resp = await _http.SendAsync(req).ConfigureAwait(false);
                    if (!resp.IsSuccessStatusCode)
                        continue;

                    var json = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
                    using var doc = JsonDocument.Parse(json);
                    if (doc.RootElement.TryGetProperty("body", out var bodyEl))
                    {
                        var body = bodyEl.GetString() ?? string.Empty;
                        _cachedReleaseNotes = body;
                        _cachedReleaseNotesVersion = version;
                        return ParseMarkdownBullets(body);
                    }
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[UpdateService] Release notes fetch failed: {ex.Message}");
            }
            return new List<string>();
        }

        /// <summary>
        /// Parses markdown body into plain bullet items. Strips common markdown
        /// bullet prefixes (-, *, +, numbered) and trims. Empty lines, headings
        /// and horizontal rules are skipped.
        /// </summary>
        private static List<string> ParseMarkdownBullets(string markdown)
        {
            var result = new List<string>();
            if (string.IsNullOrWhiteSpace(markdown)) return result;

            foreach (var rawLine in markdown.Replace("\r\n", "\n").Split('\n'))
            {
                var line = rawLine.Trim();
                if (line.Length == 0) continue;
                if (line.StartsWith('#')) continue;          // heading
                if (line.StartsWith("---") || line.StartsWith("===")) continue; // hr

                // Strip bullet prefix
                if (line.StartsWith("- ") || line.StartsWith("* ") || line.StartsWith("+ "))
                    line = line.Substring(2).Trim();
                else if (line.Length > 2 && char.IsDigit(line[0]))
                {
                    // Numbered list like "1. foo"
                    var dot = line.IndexOf('.');
                    if (dot > 0 && dot < 4)
                        line = line.Substring(dot + 1).Trim();
                }

                // Strip simple markdown emphasis
                line = line.Replace("**", "").Replace("__", "");

                if (line.Length > 0)
                    result.Add(line);
            }
            return result;
        }

        /// <summary>
        /// Downloads the pending update, reporting progress (0–100).
        /// </summary>
        public static async Task<bool> DownloadUpdateAsync(Action<int>? onProgress = null)
        {
            if (_pendingUpdate == null)
                return false;

            try
            {
                await _manager.DownloadUpdatesAsync(_pendingUpdate, progress =>
                {
                    onProgress?.Invoke(progress);
                });
                return true;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[UpdateService] Download failed: {ex.Message}");
                return false;
            }
        }

        /// <summary>
        /// Applies the downloaded update and restarts the app.
        ///
        /// Uses <c>WaitExitThenApplyUpdates(silent: true, restart: true)</c> + an
        /// <c>Environment.Exit(0)</c> instead of <c>ApplyUpdatesAndRestart</c> because the
        /// latter spawns Velopack's native "Installing update X.Y.Z…" progress window with
        /// a Hide button — a jarring duplicate next to our own React splash overlay. The
        /// `silent: true` flag suppresses that native UI; Update.exe still applies the
        /// patch + restarts, but invisibly. Replicates ApplyUpdatesAndRestart's internal
        /// structure (queue → Environment.Exit) minus the dialog.
        /// </summary>
        public static void ApplyAndRestart()
        {
            if (_pendingUpdate?.TargetFullRelease == null) return;
            _manager.WaitExitThenApplyUpdates(_pendingUpdate.TargetFullRelease, silent: true, restart: true);
            Environment.Exit(0);
        }

        /// <summary>
        /// Applies the downloaded update on next app exit (non-disruptive).
        /// </summary>
        public static void ApplyOnExit()
        {
            if (_pendingUpdate?.TargetFullRelease != null)
                _manager.WaitExitThenApplyUpdates(_pendingUpdate.TargetFullRelease);
        }
    }
}
