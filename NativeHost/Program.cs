using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace TrueReplayer.NativeHost;

/// <summary>
/// Relay between Chrome Native Messaging (stdin/stdout) and TrueReplayer (named pipe).
/// Keeps retrying pipe connection so Chrome only needs to launch us once.
/// </summary>
class Program
{
    private const string PipeName = "TrueReplayerBridge";
    private static readonly object StdoutLock = new();

    static async Task Main(string[] args)
    {
        try
        {
            while (true)
            {
                try
                {
                    await RunSessionAsync().ConfigureAwait(false);
                }
                catch (OperationCanceledException) { }
                catch { }

                await Task.Delay(500).ConfigureAwait(false);
            }
        }
        catch { }
    }

    private static async Task RunSessionAsync()
    {
        using var pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        await pipe.ConnectAsync(1500).ConfigureAwait(false);

        // Connected! Notify Chrome
        SendToStdout("{\"type\":\"bridge:connected\"}");

        using var sessionCts = new CancellationTokenSource();

        // Pipe→stdout relay: reads lines from pipe, forwards to Chrome.
        // When TrueReplayer sends heartbeats, ReadLineAsync stays responsive
        // and returns null promptly when pipe server closes.
        var pipeToStdout = Task.Run(async () =>
        {
            var reader = new StreamReader(pipe, Encoding.UTF8);
            while (!sessionCts.Token.IsCancellationRequested)
            {
                var line = await reader.ReadLineAsync().ConfigureAwait(false);
                if (line == null) break; // EOF = pipe closed

                // Skip heartbeat messages, forward everything else to Chrome
                if (line.Contains("\"heartbeat\"")) continue;
                SendToStdout(line);
            }
            sessionCts.Cancel();
        });

        // Stdin→pipe relay: reads Chrome native messaging from stdin, forwards to pipe.
        var stdinToPipe = Task.Run(async () =>
        {
            var stdin = Console.OpenStandardInput();
            var writer = new StreamWriter(pipe, Encoding.UTF8) { AutoFlush = true };
            var lengthBuf = new byte[4];

            while (!sessionCts.Token.IsCancellationRequested)
            {
                int bytesRead = await ReadExactAsync(stdin, lengthBuf, 4, sessionCts.Token).ConfigureAwait(false);
                if (bytesRead < 4) break;

                int msgLength = BitConverter.ToInt32(lengthBuf, 0);
                if (msgLength <= 0 || msgLength > 1024 * 1024) break;

                var msgBuf = new byte[msgLength];
                bytesRead = await ReadExactAsync(stdin, msgBuf, msgLength, sessionCts.Token).ConfigureAwait(false);
                if (bytesRead < msgLength) break;

                try
                {
                    await writer.WriteLineAsync(Encoding.UTF8.GetString(msgBuf)).ConfigureAwait(false);
                }
                catch { break; } // Pipe broken
            }
            sessionCts.Cancel();
        });

        // Wait for pipe relay to finish (stdin relay might hang — that's OK)
        await pipeToStdout.ConfigureAwait(false);

        // Notify Chrome of disconnection
        try { SendToStdout("{\"type\":\"bridge:disconnected\"}"); } catch { }

        // Give stdin relay a moment to notice cancellation, then move on
        try { await stdinToPipe.WaitAsync(TimeSpan.FromSeconds(1)).ConfigureAwait(false); }
        catch { }
    }

    private static async Task<int> ReadExactAsync(Stream stream, byte[] buffer, int count, CancellationToken token)
    {
        int totalRead = 0;
        while (totalRead < count)
        {
            int read = await stream.ReadAsync(buffer, totalRead, count - totalRead, token).ConfigureAwait(false);
            if (read == 0) return totalRead;
            totalRead += read;
        }
        return totalRead;
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
