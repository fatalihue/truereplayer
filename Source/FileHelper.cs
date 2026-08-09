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

        /// <summary>
        /// True for the File.Move failures no amount of waiting can fix, so the backoff loop below
        /// must let them through on the FIRST attempt.
        ///
        /// PathTooLongException and DirectoryNotFoundException both derive from IOException, which
        /// means the plain "ex is IOException" filter used to swallow them into the retry loop and
        /// burn the whole 30/60/120/…/1920 ms ladder — ~3.8 s — before rethrowing, and then blame
        /// antivirus in the log. That is merely slow for one save; it is fatal for an import, which
        /// runs this once per entry: a 50 MB envelope of over-long names turned into an hours-long
        /// hang with a misleading diagnostic. Neither exception describes a lock — the path is
        /// impossible (past MAX_PATH) or its directory does not exist — so there is nothing to
        /// outlast. FileNotFoundException is deliberately NOT listed: a vanished temp file is a
        /// different failure with a different owner, and folding it in here would change behaviour
        /// this guard has no business changing.
        /// </summary>
        private static bool IsPermanentPathFailure(Exception ex)
            => ex is PathTooLongException || ex is DirectoryNotFoundException;

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
                // MUST stay above the transient filter — both of its exception types are
                // IOException subclasses, so whichever catch is written first wins.
                catch (Exception ex) when (IsPermanentPathFailure(ex))
                {
                    DiagnosticLog.Info($"[FileHelper] Move to '{filePath}' failed permanently ({ex.GetType().Name}: {ex.Message}). Not retried — the path itself is unusable (past MAX_PATH, or its directory is gone), so backing off would only postpone the same failure.");
                    throw;
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
                // MUST stay above the transient filter — both of its exception types are
                // IOException subclasses, so whichever catch is written first wins.
                catch (Exception ex) when (IsPermanentPathFailure(ex))
                {
                    DiagnosticLog.Info($"[FileHelper] Move to '{filePath}' failed permanently ({ex.GetType().Name}: {ex.Message}). Not retried — the path itself is unusable (past MAX_PATH, or its directory is gone), so backing off would only postpone the same failure.");
                    throw;
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
        /// Renames a caller-produced temp file over its final path, with the same transient-lock
        /// backoff the atomic text writers use. Exposed because not every atomic write goes through
        /// WriteAllTextAtomic: ImageStorageService hands its temp path to GDI+ Bitmap.Save and only
        /// needs the rename half. A bare File.Move there would reintroduce exactly the antivirus /
        /// indexer / cloud-sync lock this class exists to absorb — on a file the scanner has *just*
        /// seen appear, which is the worst case for it.
        /// </summary>
        public static void MoveAtomic(string tempPath, string filePath) => MoveWithRetry(tempPath, filePath);

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
