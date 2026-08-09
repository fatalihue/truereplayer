using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace TrueReplayer.NativeHost;

/// <summary>
/// Relay between Chrome Native Messaging (stdin/stdout) and TrueReplayer (named pipe).
/// Single-use: Chrome launches a new instance each time. Exits when either side closes.
/// </summary>
class Program
{
    private const string PipeName = "TrueReplayerBridge";
    private static readonly Encoding Utf8NoBom = new UTF8Encoding(false);
    private static readonly object StdoutLock = new();
    private static readonly object PipeLock = new();
    private static StreamWriter? _log;

    /// <summary>Env-var name that turns the relay log on. Set it to anything non-empty.</summary>
    private const string LogEnvVar = "TRUEREPLAYER_NATIVEHOST_LOG";
    private const long MaxLogBytes = 4L * 1024 * 1024;

    private static void Log(string msg)
    {
        if (_log == null) return;
        try { _log.WriteLine($"{DateTime.Now:HH:mm:ss.fff} {msg}"); _log.Flush(); } catch { }
    }

    /// <summary>
    /// Describe a relay message by its ROUTING fields only — never its payload.
    /// This log used to print the first 120 characters of the raw JSON, which on the recording
    /// path (browser:typingCaptured) is far enough in to include the text the user typed, and on
    /// the replay path can include the selector. A byte pump has no business keeping either on
    /// disk. type + command + commandId is everything a "did the message get through" question
    /// needs. Scanned rather than parsed on purpose: this binary handles JSON as opaque bytes
    /// (the only other inspection is a Contains for the heartbeat), and adding a JSON stack just
    /// to write a log line would be the tail wagging the dog.
    /// </summary>
    private static string Describe(string json)
    {
        var type = Field(json, "type") ?? "?";
        var command = Field(json, "command");
        var commandId = Field(json, "commandId");
        if (command == null && commandId == null) return type;
        return $"{type} {command} {commandId}".Replace("  ", " ").TrimEnd();
    }

    /// <summary>Pull a simple "key":"value" string out of raw JSON. Null when absent, not a
    /// string, or implausibly long — every field this is used for is a short identifier.</summary>
    private static string? Field(string json, string key)
    {
        var needle = $"\"{key}\":\"";
        int i = json.IndexOf(needle, StringComparison.Ordinal);
        if (i < 0) return null;
        i += needle.Length;
        int end = json.IndexOf('"', i);
        if (end < 0 || end - i > 64) return null;
        return json[i..end];
    }

    // The one extension allowed to drive this host. Must stay identical to the allowed_origins
    // entry Source/Program.cs writes into the native-messaging manifest — the ID is stable
    // because ChromeExtension/manifest.json pins the "key".
    private const string AllowedOrigin = "chrome-extension://akbcjaimplfchfaeoedhgkebhjaeebko/";

    static async Task<int> Main(string[] args)
    {
        // Chrome passes the calling extension's origin as the first argument. This process never
        // looked at it, leaning entirely on the manifest's allowed_origins — but that manifest
        // lives in AppContext.BaseDirectory and is registered under HKCU, both writable by the
        // user (and therefore by anything running as them). Edit it to list a second extension and
        // Chrome will happily launch this host for it; the origin argument is the only place that
        // substitution is still visible.
        //
        // Checked only when an origin is actually supplied: a bare launch (a developer running the
        // exe, a future non-Chrome caller) is left to the pipe's own defences, which is where the
        // real boundary is — the server sets CurrentUserOnly and pins the pipe owner.
        string? origin = args.Length > 0 ? args[0] : null;
        if (origin != null && origin.StartsWith("chrome-extension://", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(origin, AllowedOrigin, StringComparison.OrdinalIgnoreCase))
        {
            // Before the log is even configured, so this writes nowhere by design: refusing is the
            // whole behaviour, and a rejected caller must not be able to make us write to disk.
            return 1;
        }

        // Off unless explicitly asked for. The log was unconditional and append-only, so it grew
        // without bound and paid three flushed writes per browser command for a diagnostic nobody
        // reads on a healthy machine. Nothing in the app consumes the file — it exists purely for
        // debugging a relay that is otherwise opaque, so it belongs behind a switch.
        if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable(LogEnvVar)))
        {
            try
            {
                var logPath = Path.Combine(Path.GetTempPath(), "TrueReplayerNativeHost.log");
                // Chrome starts a fresh relay process per connection, so "truncate when too big"
                // gets its chance often. Checked here because this is the only place the file is
                // opened; a running process never grows past one session's worth on top of the cap.
                var existing = new FileInfo(logPath);
                if (existing.Exists && existing.Length > MaxLogBytes)
                {
                    try { existing.Delete(); } catch { }
                }
                _log = new StreamWriter(logPath, append: true, Utf8NoBom) { AutoFlush = true };
                Log($"=== NativeHost started (PID {Environment.ProcessId}) ===");
            }
            catch { }
        }

        using var cts = new CancellationTokenSource();

        // Monitor stdin on a thread — when Chrome closes the port, stdin returns EOF.
        // Use a dedicated thread because Console stdin doesn't support async cancellation well.
        var stdinDead = new TaskCompletionSource();
        var stdinThread = new Thread(() =>
        {
            try
            {
                var stdin = Console.OpenStandardInput();
                var buf = new byte[4096];
                // Keep reading and buffering stdin messages
                while (true)
                {
                    int read = stdin.Read(buf, 0, 4); // Read length prefix
                    if (read == 0) { Log("stdin: EOF"); break; }
                    if (read < 4)
                    {
                        int remaining = 4 - read;
                        while (remaining > 0)
                        {
                            int r = stdin.Read(buf, read, remaining);
                            if (r == 0) { stdinDead.TrySetResult(); return; }
                            read += r;
                            remaining -= r;
                        }
                    }
                    int msgLen = BitConverter.ToInt32(buf, 0);
                    if (msgLen <= 0 || msgLen > 1024 * 1024)
                    {
                        // A corrupt/malicious extension can send a negative or huge length. Don't
                        // treat it as a clean EOF — log the rejected value so the abort is diagnosable.
                        Log($"stdin: invalid msgLen {msgLen} (expected 1..1048576) — aborting read loop");
                        break;
                    }
                    var msgBuf = new byte[msgLen];
                    int totalRead = 0;
                    while (totalRead < msgLen)
                    {
                        int r = stdin.Read(msgBuf, totalRead, msgLen - totalRead);
                        if (r == 0) { stdinDead.TrySetResult(); return; }
                        totalRead += r;
                    }
                    // Forward to pipe if connected, otherwise buffer until the handler is wired up.
                    // Chrome can send messages during the up-to-3s pipe-connect window; invoking a
                    // null delegate here would silently drop the first commands of a session.
                    var msg = Encoding.UTF8.GetString(msgBuf);
                    if (_log != null) Log($"stdin→pipe: {Describe(msg)}");
                    Action<string> handler;
                    lock (StdinHandlerLock)
                    {
                        if (StdinMessageReceived == null)
                        {
                            if (_preConnectBuffer.Count < 1000) _preConnectBuffer.Enqueue(msg);
                            continue;
                        }
                        handler = StdinMessageReceived;
                    }
                    handler(msg);
                }
            }
            catch (Exception ex) { Log($"stdin: exception: {ex.Message}"); }
            Log("stdin: dead");
            stdinDead.TrySetResult();
        }) { IsBackground = true, Name = "StdinReader" };
        stdinThread.Start();

        // When stdin dies, cancel everything
        _ = stdinDead.Task.ContinueWith(_ => cts.Cancel());

        // Failsafe: kill this process after 10 seconds if the pipe never connects — prevents an
        // orphan process when Chrome dies without properly closing stdin. (Idle AFTER connect is
        // caught by the 6s pipe-relay watchdog further down, not here.)
        _ = Task.Run(async () =>
        {
            // Wait 10s for pipe to connect
            await Task.Delay(10_000).ConfigureAwait(false);
            if (!cts.Token.IsCancellationRequested && !PipeConnected)
            {
                Environment.Exit(0);
            }
        });

        try
        {
            // Try to connect to pipe — if TrueReplayer isn't running, retry a few times.
            //
            // CurrentUserOnly is the CLIENT half of the pipe's security, and it was missing while
            // the server half (the SID-restricted DACL in BrowserBridgeService) was already in
            // place. A DACL controls who may connect to OUR pipe; it says nothing about whose pipe
            // we just connected TO. Pipe names live in a machine-wide namespace and creating one
            // needs no privilege, so any local process can publish \\.\pipe\TrueReplayerBridge —
            // and it does not even have to win a boot race, because the server tears the pipe down
            // and sleeps a second between reconnects, freeing the name on every cycle. Connected to
            // an impostor, this host would hand it every recorded keystroke and URL, and accept
            // browser:executeCommand back, driving the user's logged-in browser.
            //
            // With the flag, .NET compares the pipe's owner against ours after connecting and
            // throws instead. See BrowserBridgeService for why the server pins that owner
            // explicitly — the default differs under elevation and would reject the real app.
            using var pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);

            for (int attempt = 0; attempt < 3; attempt++) // Try for ~3 seconds
            {
                if (cts.Token.IsCancellationRequested) return 0;
                try
                {
                    await pipe.ConnectAsync(1000, cts.Token).ConfigureAwait(false);
                    break;
                }
                catch (TimeoutException) { }
                catch (UnauthorizedAccessException ex)
                {
                    // Not "app not running" — something IS serving this name and it is not owned by
                    // us. Retrying is pointless (the validation runs post-connect and leaves this
                    // stream closed) and would only reconnect to the same impostor, so fail loudly
                    // and distinctly rather than degrading into the ordinary timeout path.
                    Log($"pipe: REFUSED — server is not owned by the current user ({ex.Message})");
                    return 1;
                }
            }

            if (!pipe.IsConnected) { Log("pipe: failed to connect after 3 attempts"); return 1; }

            // Connected! Notify Chrome
            PipeConnected = true;
            Log("pipe: connected");
            SendToStdout("{\"type\":\"bridge:connected\"}");

            var writer = new StreamWriter(pipe, Utf8NoBom) { AutoFlush = true };
            var reader = new StreamReader(pipe, Utf8NoBom);

            // Forward stdin messages to pipe. Assign + drain the pre-connect buffer under the same
            // lock the stdin thread uses, so no message slips through between wiring up and draining.
            lock (StdinHandlerLock)
            {
                StdinMessageReceived = (msg) =>
                {
                    try
                    {
                        lock (PipeLock)
                        {
                            writer.WriteLine(msg);
                        }
                        Log($"stdin→pipe: write OK");
                    }
                    catch (Exception ex)
                    {
                        Log($"stdin→pipe: WRITE FAILED: {ex.Message}");
                        cts.Cancel();
                    }
                };
                while (_preConnectBuffer.Count > 0)
                    StdinMessageReceived(_preConnectBuffer.Dequeue());
            }

            // Pipe→stdout relay with watchdog
            // Heartbeat arrives every 2s. If nothing for 6s, pipe is dead.
            var pipeRelay = Task.Run(async () =>
            {
                while (!cts.Token.IsCancellationRequested)
                {
                    var readTask = reader.ReadLineAsync();
                    var completed = await Task.WhenAny(readTask, Task.Delay(6000, cts.Token)).ConfigureAwait(false);
                    if (completed != readTask) { Log("pipe→stdout: watchdog timeout (6s)"); break; }

                    var line = await readTask.ConfigureAwait(false);
                    if (line == null) { Log("pipe→stdout: EOF (null)"); break; }
                    if (line.Contains("\"type\":\"heartbeat\"")) continue; // match the heartbeat TYPE, not any payload containing the word
                    if (_log != null) Log($"pipe→stdout: {Describe(line)}");
                    SendToStdout(line);
                }
                Log("pipe relay ended");
            });

            // Wait for pipe to close, stdin to close, or cancellation
            await Task.WhenAny(pipeRelay, stdinDead.Task).ConfigureAwait(false);

            // Notify Chrome
            Log("sending bridge:disconnected");
            try { SendToStdout("{\"type\":\"bridge:disconnected\"}"); } catch { }
        }
        catch (OperationCanceledException) { Log("cancelled"); }
        catch (Exception ex) { Log($"fatal: {ex.Message}"); }

        Log($"=== NativeHost exiting (PID {Environment.ProcessId}) ===");
        _log?.Dispose();
        return 0;
    }

    private static Action<string>? StdinMessageReceived;
    private static readonly object StdinHandlerLock = new();
    private static readonly System.Collections.Generic.Queue<string> _preConnectBuffer = new();
    private static volatile bool PipeConnected;
    private static Stream? _stdoutStream;

    // Chrome's documented ceiling for a message sent from a native host to the extension.
    private const int MaxOutgoingFrameBytes = 1024 * 1024;

    private static void SendToStdout(string json)
    {
        lock (StdoutLock)
        {
            // Open the standard output stream once and reuse it — re-opening per message is
            // wasteful and risks interleaving on a shared handle.
            _stdoutStream ??= Console.OpenStandardOutput();
            var msgBytes = Encoding.UTF8.GetBytes(json);

            // Chrome's native-messaging frame limit for host->extension is 1 MB, and it does not
            // fail politely: an oversized frame makes Chrome kill the port, which drops the bridge
            // mid-recording. The C# side is the trusted end here, but the CONTENT is not
            // necessarily ours — a relayed line can carry page-derived text — so the frame is
            // checked rather than assumed. Dropping one message beats losing the connection, and
            // the drop is logged so it is not a silent hole.
            if (msgBytes.Length > MaxOutgoingFrameBytes)
            {
                Log($"dropping {msgBytes.Length}-byte frame: over the {MaxOutgoingFrameBytes}-byte native messaging limit");
                return;
            }

            var lengthBytes = BitConverter.GetBytes(msgBytes.Length);
            _stdoutStream.Write(lengthBytes, 0, 4);
            _stdoutStream.Write(msgBytes, 0, msgBytes.Length);
            _stdoutStream.Flush();
        }
    }
}
