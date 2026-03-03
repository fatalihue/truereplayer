using System;
using System.Threading.Tasks;
using Velopack;
using Velopack.Sources;

namespace TrueReplayer.Services
{
    public static class UpdateService
    {
        private const string RepoUrl = "https://github.com/fatalihue/truereplayer";

        private static readonly UpdateManager _manager = new(
            new GithubSource(RepoUrl, null, false));

        private static UpdateInfo? _pendingUpdate;

        public static bool IsInstalled => _manager.IsInstalled;

        public static string? CurrentVersion => _manager.IsInstalled
            ? _manager.CurrentVersion?.ToString()
            : null;

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
        /// </summary>
        public static void ApplyAndRestart()
        {
            if (_pendingUpdate?.TargetFullRelease != null)
                _manager.ApplyUpdatesAndRestart(_pendingUpdate.TargetFullRelease);
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
