using System;
using System.Collections.Concurrent;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace TrueReplayer.NativeHost;

/// <summary>
/// Relay between Chrome Native Messaging (stdin/stdout) and TrueReplayer (named pipe).
/// Keeps retrying pipe connection so Chrome only needs to launch us once.
/// Exits immediately when Chrome closes stdin (port disconnected or browser closed).
/// </summary>
class Program
{
    private const string PipeName = "TrueReplayerBridge";
    private static readonly object StdoutLock = new();
    private static readonly CancellationTokenSource GlobalCts = new();
    private static readonly ConcurrentQueue<string> IncomingMessages = new();
    private static readonly SemaphoreSlim MessageSignal = new(0);

    static async Task Main(string[] args)
    {
        // Single stdin reader for the entire lifetime.
        // Reads Chrome native messaging format and queues messages.
        // When stdin closes (Chrome disconnected), cancels GlobalCts → process exits.
        _ = Task.Run(() => ReadStdinLoop());

        try
        {
            while (!GlobalCts.Token.IsCancellationRequested)
            {
                try
                {
                    await RunSessionAsync().ConfigureAwait(false);
                }
                catch (OperationCanceledException) { }
                catch { }

                if (GlobalCts.Token.IsCancellationRequested) break;
                await Task.Delay(500, GlobalCts.Token).ConfigureAwait(false);
            }
        }
        catch { }
    }

    /// <summary>
    /// Reads Chrome native messaging from stdin forever.
    /// Queues messages for the active pipe session.
    /// Cancels GlobalCts on EOF (Chrome closed).
    /// </summary>
    private static void ReadStdinLoop()
    {
        try
        {
            var stdin = Console.OpenStandardInput();
            var lengthBuf = new byte[4];

            while (!GlobalCts.Token.IsCancellationRequested)
            {
                int bytesRead = ReadExact(stdin, lengthBuf, 4);
                if (bytesRead < 4) break; // EOF

                int msgLength = BitConverter.ToInt32(lengthBuf, 0);
                if (msgLength <= 0 || msgLength > 1024 * 1024) break;

                var msgBuf = new byte[msgLength];
                bytesRead = ReadExact(stdin, msgBuf, msgLength);
                if (bytesRead < msgLength) break;

                IncomingMessages.Enqueue(Encoding.UTF8.GetString(msgBuf));
                MessageSignal.Release();
            }
        }
        catch { }

        GlobalCts.Cancel();
    }

    private static int ReadExact(Stream stream, byte[] buffer, int count)
    {
        int totalRead = 0;
        while (totalRead < count)
        {
            int read = stream.Read(buffer, totalRead, count - totalRead);
            if (read == 0) return totalRead;
            totalRead += read;
        }
        return totalRead;
    }

    private static async Task RunSessionAsync()
    {
        using var pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        await pipe.ConnectAsync(1500, GlobalCts.Token).ConfigureAwait(false);

        // Connected! Notify Chrome
        SendToStdout("{\"type\":\"bridge:connected\"}");

        using var sessionCts = CancellationTokenSource.CreateLinkedTokenSource(GlobalCts.Token);

        // Queue→pipe relay: forwards queued Chrome messages to TrueReplayer pipe
        var queueToPipe = Task.Run(async () =>
        {
            var writer = new StreamWriter(pipe, Encoding.UTF8) { AutoFlush = true };
            while (!sessionCts.Token.IsCancellationRequested)
            {
                try
                {
                    await MessageSignal.WaitAsync(sessionCts.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) { break; }

                while (IncomingMessages.TryDequeue(out var msg))
                {
                    try
                    {
                        await writer.WriteLineAsync(msg).ConfigureAwait(false);
                    }
                    catch { sessionCts.Cancel(); return; } // Pipe broken
                }
            }
        });

        // Pipe→stdout relay: reads lines from pipe, forwards to Chrome
        var pipeToStdout = Task.Run(async () =>
        {
            var reader = new StreamReader(pipe, Encoding.UTF8);
            while (!sessionCts.Token.IsCancellationRequested)
            {
                var line = await reader.ReadLineAsync().ConfigureAwait(false);
                if (line == null) break; // EOF = pipe closed

                if (line.Contains("\"heartbeat\"")) continue;
                SendToStdout(line);
            }
            sessionCts.Cancel();
        });

        // Wait for either relay to finish
        await Task.WhenAny(pipeToStdout, queueToPipe).ConfigureAwait(false);
        sessionCts.Cancel();

        // Notify Chrome of disconnection
        try { SendToStdout("{\"type\":\"bridge:disconnected\"}"); } catch { }

        // Wait for tasks to wind down
        try { await Task.WhenAll(pipeToStdout, queueToPipe).WaitAsync(TimeSpan.FromSeconds(1)).ConfigureAwait(false); }
        catch { }
    }

    private static void SendToStdout(string json)
    {
        lock (StdoutLock)
        {
            var stdout = Console.OpenStandardOutput();
            var msgBytes = Encoding.UTF8.GetBytes(json);
            var lengthBytes = BitConverter.GetBytes(msgBytes.Length);
            stdout.Write(lengthBytes, 0, 4);
            stdout.Write(msgBytes, 0, msgBytes.Length);
            stdout.Flush();
        }
    }
}
