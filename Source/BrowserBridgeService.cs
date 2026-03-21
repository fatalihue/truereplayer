using System;
using System.Collections.Concurrent;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace TrueReplayer.Services
{
    public class BrowserBridgeService : IDisposable
    {
        private const string PipeName = "TrueReplayerBridge";
        private static readonly Encoding Utf8NoBom = new UTF8Encoding(false);
        private NamedPipeServerStream? _pipeServer;
        private StreamReader? _reader;
        private StreamWriter? _writer;
        private CancellationTokenSource _cts = new();
        private bool _disposed;
        private readonly object _writeLock = new();

        private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonElement>> _pendingCommands = new();

        public bool IsConnected { get; private set; }
        public bool IsRecordingMode { get; private set; }
        public event Action<bool>? ConnectionChanged;
        public event Action<string, string, string?, string?>? ElementClicked; // selector, description, url, tagName

        public void Start()
        {
            _ = Task.Run(() => ListenLoopAsync(_cts.Token));
        }

        private async Task ListenLoopAsync(CancellationToken token)
        {
            while (!token.IsCancellationRequested)
            {
                try
                {
                    _pipeServer?.Dispose();
                    _pipeServer = new NamedPipeServerStream(PipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);

                    await _pipeServer.WaitForConnectionAsync(token).ConfigureAwait(false);

                    _reader = new StreamReader(_pipeServer, Utf8NoBom);
                    _writer = new StreamWriter(_pipeServer, Utf8NoBom) { AutoFlush = true };

                    IsConnected = true;
                    ConnectionChanged?.Invoke(true);

                    // Send immediate heartbeat so NativeHost's watchdog doesn't timeout
                    try { _writer.WriteLine("{\"type\":\"heartbeat\"}"); } catch { }

                    // Re-sync recording mode if it was active before reconnection
                    if (IsRecordingMode)
                    {
                        try { SendMessage(new { type = "browser:setRecording", enabled = true }); } catch { }
                    }

                    // Run message reader and heartbeat sender concurrently
                    using var sessionCts = CancellationTokenSource.CreateLinkedTokenSource(token);
                    var reading = ReadMessagesAsync(sessionCts.Token);
                    var heartbeat = SendHeartbeatAsync(sessionCts.Token);

                    await Task.WhenAny(reading, heartbeat).ConfigureAwait(false);
                    sessionCts.Cancel();
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine($"[BrowserBridge] Pipe error: {ex.Message}");
                }
                finally
                {
                    IsConnected = false;
                    ConnectionChanged?.Invoke(false);

                    foreach (var pending in _pendingCommands)
                    {
                        pending.Value.TrySetCanceled();
                    }
                    _pendingCommands.Clear();
                }

                if (!token.IsCancellationRequested)
                    await Task.Delay(1000, token).ConfigureAwait(false);
            }
        }

        private async Task ReadMessagesAsync(CancellationToken token)
        {
            while (!token.IsCancellationRequested)
            {
                string? line;
                try
                {
                    line = await _reader!.ReadLineAsync().ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine($"[BrowserBridge] ReadLineAsync error: {ex.Message}");
                    break;
                }
                if (line == null) break; // EOF = pipe closed

                try
                {
                    var doc = JsonDocument.Parse(line);
                    var root = doc.RootElement;
                    var type = root.GetProperty("type").GetString() ?? "";

                    switch (type)
                    {
                        case "browser:elementClicked":
                            var selector = root.GetProperty("selector").GetString() ?? "";
                            var description = root.TryGetProperty("description", out var descEl) ? descEl.GetString() ?? "" : "";
                            var url = root.TryGetProperty("url", out var urlEl) ? urlEl.GetString() : null;
                            var tagName = root.TryGetProperty("tagName", out var tagEl) ? tagEl.GetString() : null;
                            ElementClicked?.Invoke(selector, description, url, tagName);
                            break;

                        case "browser:commandResult":
                            var cmdId = root.GetProperty("commandId").GetString() ?? "";
                            if (_pendingCommands.TryRemove(cmdId, out var tcs))
                            {
                                if (root.TryGetProperty("error", out var errEl) && errEl.ValueKind == JsonValueKind.String)
                                    tcs.TrySetException(new Exception(errEl.GetString()));
                                else
                                    tcs.TrySetResult(root);
                            }
                            break;
                    }
                }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine($"[BrowserBridge] Parse error: {ex.Message}");
                }
            }
        }

        /// <summary>
        /// Sends periodic heartbeats through the pipe so NativeHost's ReadLineAsync
        /// stays active and detects pipe closure promptly via EOF.
        /// </summary>
        private async Task SendHeartbeatAsync(CancellationToken token)
        {
            while (!token.IsCancellationRequested)
            {
                await Task.Delay(2000, token).ConfigureAwait(false);
                try
                {
                    lock (_writeLock)
                    {
                        _writer?.WriteLine("{\"type\":\"heartbeat\"}");
                    }
                }
                catch
                {
                    break; // Pipe broken
                }
            }
        }

        public void SendMessage(object message)
        {
            if (!IsConnected || _writer == null) return;

            try
            {
                lock (_writeLock)
                {
                    var json = JsonSerializer.Serialize(message);
                    _writer.WriteLine(json);
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[BrowserBridge] Send error: {ex.Message}");
            }
        }

        public async Task<JsonElement> ExecuteBrowserCommandAsync(
            TrueReplayer.Models.ActionItem action, CancellationToken token, int timeoutMs = 5000)
        {
            if (!IsConnected)
                throw new InvalidOperationException("Browser extension is not connected.");

            var commandId = Guid.NewGuid().ToString("N")[..8];
            var tcs = new TaskCompletionSource<JsonElement>();
            _pendingCommands[commandId] = tcs;

            string command;
            switch (action.ActionType)
            {
                case "BrowserClick":
                    command = "click";
                    break;
                case "BrowserRightClick":
                    command = "rightClick";
                    break;
                case "BrowserType":
                    command = "type";
                    break;
                case "BrowserWaitElement":
                    command = "waitElement";
                    break;
                case "BrowserNavigate":
                    command = "navigate";
                    break;
                default:
                    _pendingCommands.TryRemove(commandId, out _);
                    throw new ArgumentException($"Unknown browser action type: {action.ActionType}");
            }

            var timeout = (action.ActionType == "BrowserWaitElement" || action.ActionType == "BrowserClick" || action.ActionType == "BrowserRightClick") && action.Timeout > 0
                ? action.Timeout
                : timeoutMs;

            SendMessage(new
            {
                type = "browser:executeCommand",
                commandId,
                command,
                selector = action.Key ?? "",
                text = action.BrowserText ?? "",
                url = action.Key ?? "",
                newTab = action.NewTab,
                timeout
            });

            using var timeoutCts = new CancellationTokenSource(timeout);

            try
            {
                // If user stops replay, propagate cancellation normally
                using (token.Register(() => tcs.TrySetCanceled()))
                // If command times out, set a timeout exception instead of cancellation
                using (timeoutCts.Token.Register(() => tcs.TrySetException(
                    new TimeoutException(GetFriendlyTimeoutMessage(command, timeout)))))
                {
                    return await tcs.Task;
                }
            }
            finally
            {
                _pendingCommands.TryRemove(commandId, out _);
            }
        }

        public void SetRecordingMode(bool enabled)
        {
            IsRecordingMode = enabled;
            SendMessage(new { type = "browser:setRecording", enabled });
        }

        private static string GetFriendlyTimeoutMessage(string command, int timeoutMs)
        {
            var seconds = timeoutMs / 1000;
            return command switch
            {
                "click" => $"Browser Click timed out after {seconds}s. Make sure the element is visible on the page. Tip: try using a text= selector (e.g. text=Submit).",
                "rightClick" => $"Browser Right Click timed out after {seconds}s. Make sure the element is visible on the page. Tip: try using a text= selector (e.g. text=Submit).",
                "type" => $"Browser Type timed out after {seconds}s. Make sure the target input field is visible on the page. Tip: try using a text= selector.",
                "waitElement" => $"Browser Wait timed out after {seconds}s. The element was not found on the page. Tip: try using a text= selector or increase the timeout.",
                "navigate" => $"Browser Navigate timed out after {seconds}s. Check the URL and your internet connection.",
                _ => $"Browser command timed out after {seconds}s. Make sure the page is fully loaded."
            };
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            _cts.Cancel();
            _pipeServer?.Dispose();
            _cts.Dispose();
        }
    }
}
