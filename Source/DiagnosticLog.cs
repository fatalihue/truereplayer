using System;
using System.IO;
using System.Linq;
using System.Text;

namespace TrueReplayer.Services
{
    /// <summary>
    /// Lightweight file-based logger for user-reportable diagnostics — WebView2 crashes,
    /// recovery attempts, unhandled exceptions, etc. Writes to
    /// %LOCALAPPDATA%\TrueReplayer\Logs\Session-YYYYMMDD-HHmmss.log with automatic rotation
    /// (keeps the last N sessions). Designed for low-volume events only, not high-frequency
    /// logging — each write hits disk.
    /// </summary>
    public static class DiagnosticLog
    {
        private static readonly object _writeLock = new();
        private static string? _logPath;
        private const int MaxSessionFiles = 10;

        public static string LogDirectory { get; private set; } = "";

        /// <summary>
        /// Call once on app startup. Creates the log folder, opens a new session file,
        /// deletes older session files past MaxSessionFiles, writes a startup header.
        /// </summary>
        public static void Initialize(string appVersion)
        {
            try
            {
                LogDirectory = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "TrueReplayer", "Logs");
                Directory.CreateDirectory(LogDirectory);

                // Prune old sessions
                var existing = Directory.GetFiles(LogDirectory, "Session-*.log")
                    .OrderByDescending(File.GetLastWriteTimeUtc)
                    .ToList();
                foreach (var old in existing.Skip(MaxSessionFiles - 1))
                {
                    try { File.Delete(old); } catch { /* ignore */ }
                }

                _logPath = Path.Combine(LogDirectory,
                    $"Session-{DateTime.Now:yyyyMMdd-HHmmss}.log");

                var os = Environment.OSVersion.VersionString;
                var arch = RuntimeArchString();
                WriteHeader($"TrueReplayer v{appVersion} | {os} | {arch}");
            }
            catch
            {
                // If log setup fails, we continue silently — the app shouldn't die because it
                // can't write diagnostics. System.Diagnostics.Debug still works.
            }
        }

        public static void Info(string message) => Write("INFO", message);
        public static void Warn(string message) => Write("WARN", message);
        public static void Error(string message) => Write("ERROR", message);

        public static void Error(string context, Exception ex)
        {
            Write("ERROR", $"{context}: {ex.GetType().Name}: {ex.Message}");
            if (ex.StackTrace != null)
            {
                // Stack on its own lines, indented to be visually grouped with the ERROR line
                // Normalize CRLF first so Windows stack traces don't leave a trailing '\r' on each line.
                var indented = string.Join(Environment.NewLine + "    ", ex.StackTrace.Replace("\r\n", "\n").Split('\n'));
                WriteRaw("    " + indented);
            }
            if (ex.InnerException != null)
            {
                Write("ERROR", $"  Inner: {ex.InnerException.GetType().Name}: {ex.InnerException.Message}");
            }
        }

        private static void Write(string level, string message)
        {
            var line = $"[{DateTime.Now:HH:mm:ss.fff}] [{level,-5}] {message}";
            // Always mirror to debug output for devs running in VS
            System.Diagnostics.Debug.WriteLine(line);
            WriteRaw(line);
        }

        private static void WriteRaw(string line)
        {
            if (_logPath == null) return;
            try
            {
                lock (_writeLock)
                {
                    File.AppendAllText(_logPath, line + Environment.NewLine, Encoding.UTF8);
                }
            }
            catch
            {
                // Never fail the app because of disk write issues
            }
        }

        private static void WriteHeader(string header)
        {
            var sep = new string('=', 70);
            WriteRaw(sep);
            WriteRaw(header);
            WriteRaw($"Session started: {DateTime.Now:yyyy-MM-dd HH:mm:ss}");
            WriteRaw(sep);
        }

        private static string RuntimeArchString()
        {
            return Environment.Is64BitProcess ? "x64" : "x86";
        }
    }
}
