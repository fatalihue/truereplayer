using System;
using System.Collections.Concurrent;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace TrueReplayer.Services
{
    public class BrowserBridgeService : IDisposable
    {
        private const string PipeName = "TrueReplayerBridge";
        public const string ExpectedExtensionVersion = "1.4.4";
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
        public event Action<string, string>? ExtensionVersionMismatch; // currentVersion, expectedVersion
        public event Action<string, string, string?, string?, string?, bool>? ElementClicked; // selector, description, url, tagName, button, isInput
        // #10 — typingCaptured(selector, text, isAppend)
        public event Action<string, string, bool>? TypingCaptured;
        // Fired when a native <select>'s value changed during recording. Carries the
        // selector for the <select> and the picked option's text/value so the bridge
        // can create a BrowserSelectOption action.
        public event Action<string, string, string, string>? SelectChanged; // selector, description, selectedText, selectedValue
        // Bracket events around a native <select> interaction: backend uses them to gate
        // the OS-level mouse hook so clicks during the dropdown's open/pick lifecycle
        // never reach the recorder. Started by mousedown on a <select>, ended by either
        // blur or the matching SelectChanged.
        public event Action? SelectInteractionStarted;
        public event Action? SelectInteractionEnded;

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
                    // Restrict the pipe to the current interactive user's SID. The Chrome-launched
                    // NativeHost runs as the SAME user (even when TrueReplayer is elevated — a UAC
                    // split token keeps the same User SID), so it still connects, while other local
                    // users/accounts are denied. Previously granted to Everyone (WorldSid), which
                    // let any local process drive the browser bridge.
                    var pipeSecurity = new PipeSecurity();
                    var currentUserSid = WindowsIdentity.GetCurrent().User;
                    if (currentUserSid != null)
                    {
                        pipeSecurity.AddAccessRule(new PipeAccessRule(
                            currentUserSid,
                            PipeAccessRights.ReadWrite | PipeAccessRights.CreateNewInstance,
                            AccessControlType.Allow));
                    }
                    _pipeServer = NamedPipeServerStreamAcl.Create(PipeName, PipeDirection.InOut, 1,
                        PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 0, 0, pipeSecurity);

                    await _pipeServer.WaitForConnectionAsync(token).ConfigureAwait(false);

                    _reader = new StreamReader(_pipeServer, Utf8NoBom);
                    _writer = new StreamWriter(_pipeServer, Utf8NoBom) { AutoFlush = true };

                    IsConnected = true;
                    ConnectionChanged?.Invoke(true);

                    // Send immediate heartbeat so NativeHost's watchdog doesn't timeout
                    try { _writer.WriteLine("{\"type\":\"heartbeat\"}"); } catch { }

                    // Send expected extension version for update check
                    try { SendMessage(new { type = "bridge:expectedVersion", version = ExpectedExtensionVersion }); } catch { }

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
                            var button = root.TryGetProperty("button", out var btnEl) ? btnEl.GetString() ?? "left" : "left";
                            var isInput = root.TryGetProperty("isInput", out var inputEl) && inputEl.GetBoolean();
                            ElementClicked?.Invoke(selector, description, url, tagName, button, isInput);
                            break;

                        case "browser:typingCaptured":
                            // #10 — Typing observed in a recorded input field
                            var typeSelector = root.GetProperty("selector").GetString() ?? "";
                            var typedText = root.TryGetProperty("text", out var ttEl) ? ttEl.GetString() ?? "" : "";
                            var typedAppend = root.TryGetProperty("isAppend", out var taEl) && taEl.GetBoolean();
                            TypingCaptured?.Invoke(typeSelector, typedText, typedAppend);
                            break;

                        case "browser:selectInteractionStart":
                            SelectInteractionStarted?.Invoke();
                            break;

                        case "browser:selectInteractionEnd":
                            SelectInteractionEnded?.Invoke();
                            break;

                        case "browser:selectChanged":
                            // Native <select> value changed during recording — auto-create
                            // a BrowserSelectOption action (Phase 2 of the feature).
                            var selSelector = root.GetProperty("selector").GetString() ?? "";
                            var selDescription = root.TryGetProperty("description", out var sdEl) ? sdEl.GetString() ?? "" : "";
                            var selText = root.TryGetProperty("selectedText", out var stEl) ? stEl.GetString() ?? "" : "";
                            var selValue = root.TryGetProperty("selectedValue", out var svEl) ? svEl.GetString() ?? "" : "";
                            SelectChanged?.Invoke(selSelector, selDescription, selText, selValue);
                            break;

                        case "browser:commandResult":
                            var cmdId = root.GetProperty("commandId").GetString() ?? "";
                            if (_pendingCommands.TryRemove(cmdId, out var tcs))
                            {
                                if (root.TryGetProperty("error", out var errEl))
                                {
                                    // Support legacy string format and new {code, message, tip} object format
                                    if (errEl.ValueKind == JsonValueKind.String)
                                    {
                                        tcs.TrySetException(new BrowserActionException(null, errEl.GetString() ?? "Unknown error", null));
                                    }
                                    else if (errEl.ValueKind == JsonValueKind.Object)
                                    {
                                        var code = errEl.TryGetProperty("code", out var c) ? c.GetString() : null;
                                        var msg = errEl.TryGetProperty("message", out var m) ? m.GetString() : null;
                                        var tip = errEl.TryGetProperty("tip", out var t) ? t.GetString() : null;
                                        tcs.TrySetException(new BrowserActionException(code, msg ?? "Unknown error", tip));
                                    }
                                    else
                                    {
                                        tcs.TrySetResult(root);
                                    }
                                }
                                else
                                {
                                    tcs.TrySetResult(root);
                                }
                            }
                            break;

                        case "browser:pickResult":
                            var pickId = root.GetProperty("requestId").GetString() ?? "";
                            if (_pendingCommands.TryRemove(pickId, out var pickTcs))
                            {
                                pickTcs.TrySetResult(root);
                            }
                            break;

                        case "browser:extensionVersion":
                            var extVersion = root.GetProperty("version").GetString() ?? "";
                            if (!string.IsNullOrEmpty(extVersion) && extVersion != ExpectedExtensionVersion)
                            {
                                ExtensionVersionMismatch?.Invoke(extVersion, ExpectedExtensionVersion);
                            }
                            break;
                    }
                }
                catch (Exception ex)
                {
                    // Surface malformed pipe messages to the session log instead of only Debug.
                    TrueReplayer.Services.DiagnosticLog.Warn($"[BrowserBridge] Parse error: {ex.Message}");
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

        /// <summary>
        /// Tells the extension to abort an in-progress element pick (user switched/closed the
        /// editor). The extension's stopPick resolves the pending pick with null, which flows back
        /// through the normal pickResult path; the frontend ignores it via its requestId guard.
        /// </summary>
        public void CancelPickElement()
        {
            if (!IsConnected) return;
            SendMessage(new { type = "browser:cancelPick" });
        }

        public async Task<PickResult> PickElementAsync(CancellationToken token, int timeoutMs = 30000)
        {
            if (!IsConnected)
                throw new InvalidOperationException("Browser extension is not connected.");

            var requestId = Guid.NewGuid().ToString("N")[..8];
            var tcs = new TaskCompletionSource<JsonElement>();
            _pendingCommands[requestId] = tcs;

            SendMessage(new { type = "browser:pickElement", requestId });

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(token);
            cts.CancelAfter(timeoutMs);

            try
            {
                using (cts.Token.Register(() => tcs.TrySetCanceled()))
                {
                    var result = await tcs.Task;
                    string? primary = null;
                    var alternatives = new System.Collections.Generic.List<SelectorAlternative>();
                    if (result.TryGetProperty("selector", out var selEl) && selEl.ValueKind == JsonValueKind.String)
                        primary = selEl.GetString();
                    if (result.TryGetProperty("alternatives", out var altEl) && altEl.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var alt in altEl.EnumerateArray())
                        {
                            var altSel = alt.TryGetProperty("selector", out var s) ? s.GetString() : null;
                            var altTier = alt.TryGetProperty("tier", out var t) ? t.GetString() : null;
                            var altDesc = alt.TryGetProperty("description", out var d) ? d.GetString() : null;
                            if (!string.IsNullOrEmpty(altSel))
                                alternatives.Add(new SelectorAlternative(altSel!, altTier ?? "C", altDesc ?? ""));
                        }
                    }
                    return new PickResult(primary, alternatives);
                }
            }
            catch
            {
                _pendingCommands.TryRemove(requestId, out _);
                return new PickResult(null, new System.Collections.Generic.List<SelectorAlternative>());
            }
        }

        public record PickResult(string? Selector, System.Collections.Generic.IReadOnlyList<SelectorAlternative> Alternatives);
        public record SelectorAlternative(string Selector, string Tier, string Description);

        public async Task<JsonElement> ExecuteBrowserCommandAsync(
            TrueReplayer.Models.ActionItem action, CancellationToken token, int timeoutMs = 5000, string? resolvedText = null)
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
                case "BrowserSelectOption":
                    command = "selectOption";
                    break;
                default:
                    _pendingCommands.TryRemove(commandId, out _);
                    throw new ArgumentException($"Unknown browser action type: {action.ActionType}");
            }

            var timeout = (action.ActionType == "BrowserWaitElement" || action.ActionType == "BrowserClick" || action.ActionType == "BrowserRightClick" || action.ActionType == "BrowserSelectOption") && action.Timeout > 0
                ? action.Timeout
                : timeoutMs;

            // Navigation can take longer than action timeout; give it generous headroom (timeout * 6 or 30s).
            var pipeTimeout = command == "navigate" ? Math.Max(timeout * 6, 30000) : timeout;

            SendMessage(new
            {
                type = "browser:executeCommand",
                commandId,
                command,
                selector = action.Key ?? "",
                text = resolvedText ?? action.BrowserText ?? "",
                url = action.Key ?? "",
                newTab = action.NewTab,
                timeout,
                // New fields (extension 1.3.0) — older extensions ignore unknown keys
                waitMode = action.WaitMode,
                urlWaitPattern = action.UrlWaitPattern,
                postNavigateSelector = action.PostNavigateSelector,
                typeAppend = action.TypeAppend,
                typePaste = action.TypePaste,
                typeDelay = action.TypeDelay,
                // BrowserSelectOption (extension bump) — defaults to "text" when null.
                selectMatchMode = action.SelectMatchMode ?? "text"
            });

            using var timeoutCts = new CancellationTokenSource(pipeTimeout);

            try
            {
                // If user stops replay, propagate cancellation normally
                using (token.Register(() => tcs.TrySetCanceled()))
                // If command times out, set a timeout exception instead of cancellation
                using (timeoutCts.Token.Register(() => tcs.TrySetException(
                    new BrowserActionException(
                        code: command == "navigate" ? "NAVIGATION_TIMEOUT" : "ELEMENT_NOT_FOUND",
                        message: GetFriendlyTimeoutMessage(command, timeout),
                        tip: GetFriendlyTimeoutTip(command)))))
                {
                    return await tcs.Task;
                }
            }
            finally
            {
                _pendingCommands.TryRemove(commandId, out _);
            }
        }

        /// <summary>
        /// One-shot browser action execution for the "Test action" button in the editor.
        /// Same as ExecuteBrowserCommandAsync but does not require an existing replay context.
        /// </summary>
        public async Task<JsonElement> TestActionAsync(
            TrueReplayer.Models.ActionItem action, CancellationToken token, string? resolvedText = null)
        {
            return await ExecuteBrowserCommandAsync(action, token,
                action.Timeout > 0 ? action.Timeout : 5000, resolvedText);
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
                "click" => $"Click Element timed out after {seconds}s. Element not found or not visible.",
                "rightClick" => $"Right Click Element timed out after {seconds}s. Element not found or not visible.",
                "type" => $"Type Text timed out after {seconds}s. Target field not found or not visible.",
                "waitElement" => $"Wait Element timed out after {seconds}s. Element not found on the page.",
                "navigate" => $"Page didn't finish loading after {seconds}s.",
                "selectOption" => $"Select Option timed out after {seconds}s. The <select> element wasn't found.",
                _ => $"Browser action timed out after {seconds}s."
            };
        }

        private static string GetFriendlyTimeoutTip(string command)
        {
            return command switch
            {
                "click" or "rightClick" => "Use the Text Match field to match by visible text, or pick the element with the crosshair.",
                // BrowserType has no Text Match field in the editor — only CSS selector + crosshair.
                "type" => "Refine the CSS selector or pick the element with the crosshair.",
                "waitElement" => "Use the Text Match field or increase the timeout.",
                "navigate" => "Check the URL and your internet connection.",
                "selectOption" => "Verify the CSS selector points to a native <select> and that the option's text/value matches exactly.",
                _ => "Make sure the page is fully loaded."
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

    /// <summary>
    /// Structured browser action error with code + message + actionable tip.
    /// Codes: SELECTOR_INVALID, ELEMENT_NOT_FOUND, ELEMENT_HIDDEN, ELEMENT_COVERED,
    /// ELEMENT_DISABLED, NAVIGATION_TIMEOUT, EXTENSION_DISCONNECTED, REGEX_INVALID.
    /// </summary>
    public class BrowserActionException : Exception
    {
        public string? Code { get; }
        public string? Tip { get; }

        public BrowserActionException(string? code, string message, string? tip)
            : base(BuildMessage(message, tip))
        {
            Code = code;
            Tip = tip;
        }

        private static string BuildMessage(string message, string? tip)
            => string.IsNullOrEmpty(tip) ? message : $"{message} Tip: {tip}";
    }
}
