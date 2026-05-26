using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace TrueReplayer.Services
{
    /// <summary>
    /// Provides atomic file write operations to prevent data corruption
    /// from crashes or power loss during writes.
    /// </summary>
    public static class FileHelper
    {
        /// <summary>
        /// File.Move can throw transient UnauthorizedAccessException / IOException on
        /// Windows when something briefly holds the destination file open — antivirus
        /// real-time scan (Defender, third-party AV), File Explorer preview pane,
        /// indexing services, OneDrive/Dropbox sync agents. The window is usually
        /// <100ms, so a tiny retry loop with backoff turns these into invisible
        /// transients instead of save failures the user sees as a crash dialog.
        /// </summary>
        private const int MoveRetryAttempts = 5;
        private const int MoveRetryInitialDelayMs = 30;

        private static void MoveWithRetry(string tempPath, string filePath)
        {
            int delay = MoveRetryInitialDelayMs;
            for (int attempt = 0; attempt < MoveRetryAttempts; attempt++)
            {
                try
                {
                    File.Move(tempPath, filePath, overwrite: true);
                    return;
                }
                catch (UnauthorizedAccessException) when (attempt < MoveRetryAttempts - 1)
                {
                    Thread.Sleep(delay);
                    delay *= 2;  // 30, 60, 120, 240 → ~450ms total cap
                }
                catch (IOException) when (attempt < MoveRetryAttempts - 1)
                {
                    Thread.Sleep(delay);
                    delay *= 2;
                }
            }
        }

        private static async Task MoveWithRetryAsync(string tempPath, string filePath)
        {
            int delay = MoveRetryInitialDelayMs;
            for (int attempt = 0; attempt < MoveRetryAttempts; attempt++)
            {
                try
                {
                    File.Move(tempPath, filePath, overwrite: true);
                    return;
                }
                catch (UnauthorizedAccessException) when (attempt < MoveRetryAttempts - 1)
                {
                    await Task.Delay(delay);
                    delay *= 2;
                }
                catch (IOException) when (attempt < MoveRetryAttempts - 1)
                {
                    await Task.Delay(delay);
                    delay *= 2;
                }
            }
        }

        /// <summary>
        /// Writes content to a file atomically by first writing to a temp file,
        /// then renaming it over the target. If the process crashes mid-write,
        /// the original file remains intact.
        /// </summary>
        public static void WriteAllTextAtomic(string filePath, string content)
        {
            var dir = Path.GetDirectoryName(filePath)!;
            var tempPath = Path.Combine(dir, Path.GetRandomFileName());
            File.WriteAllText(tempPath, content);
            try
            {
                MoveWithRetry(tempPath, filePath);
            }
            catch
            {
                // Best-effort cleanup so retries don't litter the directory with .tmp leftovers.
                try { File.Delete(tempPath); } catch { }
                throw;
            }
        }

        /// <summary>
        /// Async version of WriteAllTextAtomic.
        /// </summary>
        public static async Task WriteAllTextAtomicAsync(string filePath, string content)
        {
            var dir = Path.GetDirectoryName(filePath)!;
            var tempPath = Path.Combine(dir, Path.GetRandomFileName());
            await File.WriteAllTextAsync(tempPath, content);
            try
            {
                await MoveWithRetryAsync(tempPath, filePath);
            }
            catch
            {
                try { File.Delete(tempPath); } catch { }
                throw;
            }
        }
    }
}
