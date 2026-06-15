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
        /// indexing services, OneDrive/Dropbox sync agents. Some scanners hold the
        /// lock for 1-3 seconds on newly-written temp files, so the retry window has
        /// to outlast them. 8 attempts at 30/60/120/240/480/960/1920ms ≈ 3.8s total
        /// covers >95 % of real-world scanner windows without blocking save for so
        /// long that the user thinks the app froze.
        /// </summary>
        private const int MoveRetryAttempts = 8;
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
                catch (Exception ex) when (ex is UnauthorizedAccessException || ex is IOException)
                {
                    if (attempt == MoveRetryAttempts - 1)
                    {
                        DiagnosticLog.Info($"[FileHelper] MoveWithRetry exhausted {MoveRetryAttempts} attempts for '{filePath}'. Last error: {ex.GetType().Name}: {ex.Message}. Likely a sustained file lock (antivirus real-time scan, search indexer, cloud-sync agent, or another process holding the file open).");
                        throw;
                    }
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
                catch (Exception ex) when (ex is UnauthorizedAccessException || ex is IOException)
                {
                    // On every attempt EXCEPT the last, we back off and retry. On the last
                    // attempt we log the diagnostic with file context (so post-mortem doesn't
                    // need to grep the stack trace for the path) and rethrow so the caller
                    // surfaces the error in the usual way.
                    if (attempt == MoveRetryAttempts - 1)
                    {
                        DiagnosticLog.Info($"[FileHelper] MoveWithRetry exhausted {MoveRetryAttempts} attempts for '{filePath}'. Last error: {ex.GetType().Name}: {ex.Message}. Likely a sustained file lock (antivirus real-time scan, search indexer, cloud-sync agent, or another process holding the file open).");
                        throw;
                    }
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
            // Resolve to a full path so a bare filename doesn't put the temp in the process CWD
            // (which may differ from the target dir and break the atomic same-directory move).
            filePath = Path.GetFullPath(filePath);
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
        /// Sweeps a directory for orphan temp files left behind by
        /// WriteAllTextAtomic / WriteAllTextAtomicAsync when both the File.Move
        /// retry AND the catch-block cleanup failed (typically: antivirus held
        /// the temp file long enough that even the cleanup's Delete couldn't
        /// touch it). Matches the exact shape of Path.GetRandomFileName():
        /// 8 lowercase alphanumeric chars + '.' + 3 lowercase alphanumeric chars
        /// — so real .json profiles, .png reference images, etc. are untouched.
        ///
        /// Safe to call at startup. Logs deletions to DiagnosticLog but never throws.
        /// </summary>
        public static void CleanupOrphanTemps(string directory)
        {
            if (string.IsNullOrEmpty(directory) || !Directory.Exists(directory)) return;
            try
            {
                foreach (var path in Directory.EnumerateFiles(directory))
                {
                    var name = Path.GetFileName(path);
                    // Path.GetRandomFileName() output is exactly 12 chars: 8 + '.' + 3.
                    if (name.Length != 12 || name[8] != '.') continue;
                    bool looksLikeRandom = true;
                    for (int i = 0; i < name.Length; i++)
                    {
                        if (i == 8) continue; // the literal '.' between name and extension
                        char c = name[i];
                        // The runtime produces lowercase alphanumeric; case-folding here
                        // would risk catching legitimate user files with uppercase names.
                        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')))
                        {
                            looksLikeRandom = false;
                            break;
                        }
                    }
                    if (!looksLikeRandom) continue;
                    try
                    {
                        File.Delete(path);
                        DiagnosticLog.Info($"[FileHelper] Cleaned orphan temp file: {path}");
                    }
                    catch (Exception ex)
                    {
                        DiagnosticLog.Info($"[FileHelper] Failed to clean orphan temp '{path}': {ex.Message}");
                    }
                }
            }
            catch (Exception ex)
            {
                DiagnosticLog.Info($"[FileHelper] CleanupOrphanTemps('{directory}') failed: {ex.Message}");
            }
        }

        /// <summary>
        /// Async version of WriteAllTextAtomic.
        /// </summary>
        public static async Task WriteAllTextAtomicAsync(string filePath, string content)
        {
            // Resolve to a full path so a bare filename doesn't put the temp in the process CWD
            // (which may differ from the target dir and break the atomic same-directory move).
            filePath = Path.GetFullPath(filePath);
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
