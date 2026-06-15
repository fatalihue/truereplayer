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

    private static void Log(string msg)
    {
        try { _log?.WriteLine($"{DateTime.Now:HH:mm:ss.fff} {msg}"); _log?.Flush(); } catch { }
    }

    static async Task<int> Main(string[] args)
    {
        try
        {
            var logPath = Path.Combine(Path.GetTempPath(), "TrueReplayerNativeHost.log");
            _log = new StreamWriter(logPath, append: true, Utf8NoBom) { AutoFlush = true };
            Log($"=== NativeHost started (PID {Environment.ProcessId}) ===");
        }
        catch { }

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
                    Log($"stdin→pipe: {msg[..Math.Min(msg.Length, 120)]}");
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
            // Try to connect to pipe — if TrueReplayer isn't running, retry a few times
            using var pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut, PipeOptions.Asynchronous);

            for (int attempt = 0; attempt < 3; attempt++) // Try for ~3 seconds
            {
                if (cts.Token.IsCancellationRequested) return 0;
                try
                {
                    await pipe.ConnectAsync(1000, cts.Token).ConfigureAwait(false);
                    break;
                }
                catch (TimeoutException) { }
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
                    Log($"pipe→stdout: {line[..Math.Min(line.Length, 120)]}");
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

    private static void SendToStdout(string json)
    {
        lock (StdoutLock)
        {
            // Open the standard output stream once and reuse it — re-opening per message is
            // wasteful and risks interleaving on a shared handle.
            _stdoutStream ??= Console.OpenStandardOutput();
            var msgBytes = Encoding.UTF8.GetBytes(json);
            var lengthBytes = BitConverter.GetBytes(msgBytes.Length);
            _stdoutStream.Write(lengthBytes, 0, 4);
            _stdoutStream.Write(msgBytes, 0, msgBytes.Length);
            _stdoutStream.Flush();
        }
    }
}
