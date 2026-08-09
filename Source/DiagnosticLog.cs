using System;
using System.Collections.Concurrent;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;

namespace TrueReplayer.Services
{
    /// <summary>
    /// Lightweight file-based logger for user-reportable diagnostics — WebView2 crashes,
    /// recovery attempts, unhandled exceptions, etc. Writes to
    /// %LOCALAPPDATA%\TrueReplayer\Logs\Session-YYYYMMDD-HHmmss.log with automatic rotation
    /// (keeps the last N sessions).
    ///
    /// CALLERS NEVER TOUCH THE DISK. Every entry is handed to a queue and written by one
    /// background thread, because two of this logger's callers run inside the low-level input
    /// hook callbacks (InputHookManager's gate-rejection diagnostic and its catch-all handlers,
    /// WindowMatcher's OpenProcess-failed warning) and one runs on the replay worker. The old
    /// shape — lock, open, append, close, per line — put those on the same mutex: with the
    /// replay thread or the trigger daemon inside File.AppendAllText and an antivirus scanning
    /// the file, the hook thread waited on the lock. Windows silently unhooks a low-level hook
    /// whose callback overruns LowLevelHooksTimeout (300 ms by default), and it says so nowhere:
    /// hotkeys, hotstrings and remaps would all be dead for the rest of the session with a clean
    /// log and a UI that still claims the hook is installed. One diagnostic line is worth less
    /// than every hook in the process, so the queue is bounded and drops rather than blocks.
    /// </summary>
    public static class DiagnosticLog
    {
        // Held by the drain thread and by Flush — never by a logging caller. See WriteRaw.
        private static readonly object _writeLock = new();
        private static string? _logPath;
        private const int MaxSessionFiles = 10;

        // ── Non-blocking write path ──
        // ConcurrentQueue's enqueue is lock-free, so a producer can never be parked behind a
        // writer that is stuck in the file system. _pendingCount is maintained separately
        // because ConcurrentQueue.Count walks the segment list.
        private static readonly ConcurrentQueue<string> _pending = new();
        private static readonly AutoResetEvent _pendingSignal = new(false);
        private static int _pendingCount;
        private static int _droppedCount;

        // Ceiling on the backlog. Reached only when the disk is genuinely wedged (a normal
        // session logs a few hundred lines in total), and at that point unbounded growth is
        // the worse failure — the process would swallow memory to hold diagnostics nobody can
        // read yet. Overflow is counted, not silent: the drain emits the tally once it catches
        // up, so a truncated log always says it was truncated.
        private const int MaxPendingLines = 4096;

        private static Thread? _drainThread;

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

                StartDrainThread();

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

        /// <summary>
        /// Hands one line to the drain thread. Every operation here is bounded and lock-free:
        /// an interlocked counter, a queue enqueue, and SetEvent. Nothing on this path can wait
        /// on the file system or on another logger — that is the whole point (see the class
        /// remarks: a blocked hook callback is an UNHOOKED hook callback).
        /// </summary>
        private static void WriteRaw(string line)
        {
            if (_logPath == null) return;

            if (Interlocked.Increment(ref _pendingCount) > MaxPendingLines)
            {
                // Backlog full — count the loss and return. Deliberately no attempt to write
                // through synchronously as a "last resort": the queue is only ever full because
                // writing is what stopped working, so the fallback would block precisely the
                // caller that must not block.
                Interlocked.Decrement(ref _pendingCount);
                Interlocked.Increment(ref _droppedCount);
                return;
            }

            _pending.Enqueue(line);
            try { _pendingSignal.Set(); }
            catch { /* disposed during shutdown — the ProcessExit drain still has the line */ }
        }

        private static void StartDrainThread()
        {
            if (_drainThread != null) return;
            _drainThread = new Thread(DrainLoop)
            {
                // Background: a logger must never be the reason the process stays alive. The
                // ProcessExit hook below is what gets the tail of the log onto disk instead.
                IsBackground = true,
                Name = "TrueReplayer.DiagnosticLog",
                Priority = ThreadPriority.BelowNormal,
            };
            _drainThread.Start();

            // Normal shutdown: drain what is still queued. ProcessExit is NOT raised for an
            // unhandled exception or Environment.FailFast, so a hard crash can still lose the
            // last few lines — call Flush() explicitly from a crash handler if that matters.
            try { AppDomain.CurrentDomain.ProcessExit += (_, _) => Flush(); }
            catch { /* ignore */ }
        }

        private static void DrainLoop()
        {
            // One buffer for the life of the thread: a batch is appended in a single open/write/
            // close, which is also why the backlog empties far faster than it filled.
            var batch = new StringBuilder(8 * 1024);
            while (true)
            {
                // Timed wait rather than an infinite one so a line enqueued in the window
                // between a failed Set and the next WaitOne can never sit there unwritten.
                // Guarded because this thread dying is indistinguishable from logging being
                // switched off — the queue would fill, then silently discard everything.
                try
                {
                    _pendingSignal.WaitOne(1000);
                    DrainOnce(batch);
                }
                catch { /* keep draining */ }
            }
        }

        private static void DrainOnce(StringBuilder batch)
        {
            if (_logPath == null) return;
            lock (_writeLock)
            {
                batch.Clear();
                int taken = 0;
                while (taken < MaxPendingLines && _pending.TryDequeue(out var line))
                {
                    Interlocked.Decrement(ref _pendingCount);
                    batch.Append(line).Append(Environment.NewLine);
                    taken++;
                }

                // Reported after the batch it interrupted rather than in place — the lines are
                // gone, so there is no in-place to report from. Reading it as "the gap is just
                // above this marker" is right.
                int dropped = Interlocked.Exchange(ref _droppedCount, 0);
                if (dropped > 0)
                {
                    batch.Append($"[{DateTime.Now:HH:mm:ss.fff}] [WARN ] DiagnosticLog dropped {dropped} line(s) — writer could not keep up.")
                         .Append(Environment.NewLine);
                }

                if (batch.Length == 0) return;
                try
                {
                    File.AppendAllText(_logPath, batch.ToString(), Encoding.UTF8);
                }
                catch
                {
                    // Never fail the app because of disk write issues. The lines are already
                    // out of the queue — dropping them here keeps the backlog moving instead of
                    // wedging every later write behind one unwritable batch.
                }
            }
        }

        /// <summary>
        /// Writes everything queued so far, on the CALLING thread. Blocks, so it belongs on
        /// shutdown and crash paths only — never on an input-hook path.
        /// </summary>
        public static void Flush()
        {
            try { DrainOnce(new StringBuilder(8 * 1024)); } catch { /* ignore */ }
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
