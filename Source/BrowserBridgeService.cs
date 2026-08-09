using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Linq;
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
        // Must move in lockstep with ChromeExtension/manifest.json's "version". Bumping one without
        // the other either fires the outdated banner against a current extension or hides a real
        // mismatch. 1.4.10 = G1, recording ships the ranked selector alternatives (previously only
        // the crosshair picker did, so every recorded action was a single candidate).
        // 1.4.11 = findExisting's existence probe stopped filtering hidden elements for text=
        // selectors, so the anti-premature-fallback guard now treats a present-but-hidden primary
        // the same way for both selector kinds instead of letting a fallback act on a lookalike.
        // 1.4.12 = the popup's "Reload extension" button is disabled in markup and re-enabled only
        // by a getStatus response that confirms nothing is recording, so an unanswered status
        // query can no longer leave a click able to tear down an in-progress session.
        // 1.4.13 = mutating browser commands (click/rightClick/type/selectOption) no longer fan out
        // to every frame. A read-only locateFrame probe elects ONE frame and the command is sent
        // there alone, so an element that exists in both the page and an iframe is acted on once.
        // 1.4.14 = dropped the "activeTab" permission, which nothing used. There is no
        // chrome.scripting / executeScript / insertCSS anywhere in the extension and no
        // action.onClicked (the action declares a default_popup, so onClicked could not fire even
        // if one were added); the only chrome.action calls are setBadgeText and
        // setBadgeBackgroundColor, neither of which needs a permission. The content script is
        // already declared for <all_urls>, and chrome.tabs.sendMessage to your own content script
        // needs no host permission — so activeTab granted host access that no code path consumed,
        // on an extension that can already read and type into every page. No behaviour change.
        // 1.4.15 = the recording relay caps every page-controlled string it forwards (a megabyte
        // -long id used to blow Chrome's 1 MB native-messaging frame and drop the bridge
        // mid-recording), the overlay marker moved from a page-writable data attribute to a
        // closure-scoped WeakSet, the dead commandResult relay is gone, and reconnect backs off
        // instead of spawning a host process every 30 s forever with the app closed.
        // 1.4.16 = finishes what 1.4.15's backoff started. getStatus still answers anyone, but only
        // the POPUP may force a reconnect through it. A content script asks getStatus on every page
        // load in every frame to recover recording across navigations, and the reconnect side effect
        // there called connectNative — spawning TrueReplayer.NativeHost.exe once per navigation with
        // the app closed — and reset the backoff counter each time, so the 0.5→2 min ramp never
        // actually climbed. The gate is sender.tab, the same discriminator the recording-message
        // check above it already uses.
        public const string ExpectedExtensionVersion = "1.4.16";
        private static readonly Encoding Utf8NoBom = new UTF8Encoding(false);
        private NamedPipeServerStream? _pipeServer;
        private StreamReader? _reader;
        private StreamWriter? _writer;
        private CancellationTokenSource _cts = new();
        private bool _disposed;
        private readonly object _writeLock = new();

        // Run-length state for pipe-listen failures. The listen loop retries every second forever,
        // so a PERMANENT failure — the pipe name already held by a second instance, an ACL the OS
        // refuses — would otherwise write one warning per second and bury every other event in the
        // session log. The log is the only sensor a shipped build has, so flooding it is its own
        // bug. Both fields are touched only from ListenLoopAsync, which is a single task, so they
        // need no lock.
        private string? _lastPipeError;
        private int _suppressedPipeErrors;

        private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonElement>> _pendingCommands = new();

        public bool IsConnected { get; private set; }
        public bool IsRecordingMode { get; private set; }
        public event Action<bool>? ConnectionChanged;
        public event Action<string, string>? ExtensionVersionMismatch; // currentVersion, expectedVersion
        // G1 — the trailing alternatives list is the SAME ranked shape the crosshair pick returns.
        // Empty (never null) when the extension sent none: a pre-1.4.10 content script, or an
        // element the generator found no unique fallback for. Empty means "record it exactly as
        // before", so the recording path degrades to its pre-G1 behaviour rather than failing.
        public event Action<string, string, string?, string?, string?, bool, IReadOnlyList<SelectorAlternative>>? ElementClicked; // selector, description, url, tagName, button, isInput, alternatives
        // #10 — typingCaptured(selector, text, isAppend, alternatives)
        public event Action<string, string, bool, IReadOnlyList<SelectorAlternative>>? TypingCaptured;
        // Fired when a native <select>'s value changed during recording. Carries the
        // selector for the <select> and the picked option's text/value so the bridge
        // can create a BrowserSelectOption action.
        public event Action<string, string, string, string, IReadOnlyList<SelectorAlternative>>? SelectChanged; // selector, description, selectedText, selectedValue, alternatives
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
                        // Pin the OWNER to the user SID as well, not just the DACL. The NativeHost
                        // connects with PipeOptions.CurrentUserOnly, and that check compares the
                        // pipe's owner against WindowsIdentity.Owner — which is NOT the user SID for
                        // an elevated process, it is BUILTIN\Administrators. Left at the default,
                        // running TrueReplayer with RunAsAdmin would create an Administrators-owned
                        // pipe that the (non-elevated, Chrome-launched) host then refuses, breaking
                        // the browser bridge for exactly the users who opted into elevation.
                        // Setting it explicitly makes the owner the same value in both elevations,
                        // so the host's check answers identically either way.
                        pipeSecurity.SetOwner(currentUserSid);
                    }
                    _pipeServer = NamedPipeServerStreamAcl.Create(PipeName, PipeDirection.InOut, 1,
                        PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 0, 0, pipeSecurity);

                    await _pipeServer.WaitForConnectionAsync(token).ConfigureAwait(false);

                    _reader = new StreamReader(_pipeServer, Utf8NoBom);
                    _writer = new StreamWriter(_pipeServer, Utf8NoBom) { AutoFlush = true };

                    IsConnected = true;
                    ConnectionChanged?.Invoke(true);
                    // A connection ends any run of identical failures, so the same error recurring
                    // after a good session is reported again instead of being folded into the old
                    // run and never mentioned.
                    EndPipeFailureRun();

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
                    // Was Debug.WriteLine, which compiles out of Release: creating the server
                    // stream or waiting for a connection could fail forever and the ONLY symptom
                    // the user ever got was "extension disconnected", with nothing written
                    // anywhere to say why. DiagnosticLog.Warn is the idiom the parse-error catch
                    // below already uses.
                    LogPipeFailure(ex);
                }
                finally
                {
                    IsConnected = false;
                    ConnectionChanged?.Invoke(false);

                    // NAME the disconnect instead of cancelling anonymously. TrySetCanceled() with no
                    // token produced a BARE OperationCanceledException — indistinguishable from a user
                    // Stop, so it slipped past ActionExecution's `when (token.IsCancellationRequested)`
                    // filter and died in its catch-all OCE swallow: the run ENDED with no error, no
                    // toast, the step logged as "skipped". A dropped bridge is a failure, not a stop.
                    // BrowserActionException does not derive from OperationCanceledException, so every
                    // consumer now routes it the same way it routes any other browser failure (the If
                    // probe's generic catch → false, the Assert's catch → HandleAssertFailure, the
                    // replay → OnReplayError). The two sites that already worked around the bare-OCE
                    // shape become harmless redundancy.
                    foreach (var pending in _pendingCommands)
                    {
                        pending.Value.TrySetException(new BrowserActionException(
                            "EXTENSION_DISCONNECTED",
                            "The browser bridge disconnected while the action was running.",
                            "Chrome or the TrueReplayer extension was closed, reloaded, or recycled. Reconnect and run again."));
                    }
                    _pendingCommands.Clear();
                }

                if (!token.IsCancellationRequested)
                    await Task.Delay(1000, token).ConfigureAwait(false);
            }
        }

        /// <summary>
        /// Logs a pipe-listen failure, collapsing consecutive identical ones into a single entry
        /// plus a count. See the <see cref="_lastPipeError"/> fields for why the raw 1 Hz stream
        /// cannot go straight to the log.
        /// </summary>
        private void LogPipeFailure(Exception ex)
        {
            // Type included: "Access to the path is denied" reads very differently as an
            // UnauthorizedAccessException (ACL) than as an IOException (name already in use), and
            // that distinction is the whole diagnosis.
            string message = $"{ex.GetType().Name}: {ex.Message}";
            if (message == _lastPipeError)
            {
                _suppressedPipeErrors++;
                return;
            }
            EndPipeFailureRun();
            _lastPipeError = message;
            DiagnosticLog.Warn($"[BrowserBridge] Pipe listen failed, retrying in 1s: {message}");
        }

        /// <summary>
        /// Closes an open run of identical pipe failures, reporting how many were folded away.
        /// Called both when the message changes and when a connection finally succeeds — without
        /// the second call, a failure that repeated 3600 times and then cleared would leave the
        /// log claiming it happened once.
        /// </summary>
        private void EndPipeFailureRun()
        {
            if (_suppressedPipeErrors > 0)
                DiagnosticLog.Warn($"[BrowserBridge] ...that same pipe failure repeated {_suppressedPipeErrors} more time(s).");
            _suppressedPipeErrors = 0;
            _lastPipeError = null;
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
                    // Release-visible for the same reason as the listen catch above. Bounded to
                    // one line per session — this breaks the read loop, which ends the session —
                    // so it needs none of the run-collapsing the retry loop does.
                    DiagnosticLog.Warn($"[BrowserBridge] Read failed, dropping the connection: {ex.GetType().Name}: {ex.Message}");
                    break;
                }
                if (line == null) break; // EOF = pipe closed

                try
                {
                    // JsonDocument rents its backing buffer from ArrayPool and only returns it on
                    // Dispose. Not a leak — the GC reclaims it — but this loop parses one document
                    // per pipe line, and the high-volume path is browser:typingCaptured during
                    // RECORDING, which is one message per keystroke. Every JsonElement that escapes
                    // this scope must be Clone()d: the handlers below only pass out strings (already
                    // independent copies), but the three TrySetResult deliveries hand the element
                    // itself to an awaiter that may resume on another thread, long after this
                    // `using` has recycled the buffer underneath it.
                    using var doc = JsonDocument.Parse(line);
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
                            // Materialised here, inside the `using` that owns the JsonDocument's pooled
                            // buffer, for the same reason the commandResult path Clone()s: the handler
                            // runs through a dispatcher and reads this AFTER the buffer is recycled.
                            // ReadAlternatives copies into strings, so the result is already independent.
                            ElementClicked?.Invoke(selector, description, url, tagName, button, isInput, ReadAlternatives(root));
                            break;

                        case "browser:typingCaptured":
                            // #10 — Typing observed in a recorded input field
                            var typeSelector = root.GetProperty("selector").GetString() ?? "";
                            var typedText = root.TryGetProperty("text", out var ttEl) ? ttEl.GetString() ?? "" : "";
                            var typedAppend = root.TryGetProperty("isAppend", out var taEl) && taEl.GetBoolean();
                            TypingCaptured?.Invoke(typeSelector, typedText, typedAppend, ReadAlternatives(root));
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
                            SelectChanged?.Invoke(selSelector, selDescription, selText, selValue, ReadAlternatives(root));
                            break;

                        case "browser:commandResult":
                            var cmdId = root.GetProperty("commandId").GetString() ?? "";
                            if (_pendingCommands.TryRemove(cmdId, out var tcs))
                            {
                                if (root.TryGetProperty("error", out var errEl))
                                {
                                    // Sits OUTSIDE the error object — background.js attaches it to the
                                    // whole reply, so it is present on this path too and only needed
                                    // carrying onto the exception.
                                    var failedOn = root.TryGetProperty("tabUrl", out var tuEl)
                                        && tuEl.ValueKind == JsonValueKind.String ? tuEl.GetString() : null;
                                    // Same rule as tabUrl, one field over: the extension stamps the tab on
                                    // failures too, and only the success path was reading it — so a step
                                    // that failed under a Continue policy left the run unbound.
                                    var failedTab = ReadTabId(root);
                                    // Support legacy string format and new {code, message, tip} object format
                                    if (errEl.ValueKind == JsonValueKind.String)
                                    {
                                        tcs.TrySetException(new BrowserActionException(null, errEl.GetString() ?? "Unknown error", null) { TabUrl = failedOn, TabId = failedTab });
                                    }
                                    else if (errEl.ValueKind == JsonValueKind.Object)
                                    {
                                        var code = errEl.TryGetProperty("code", out var c) ? c.GetString() : null;
                                        var msg = errEl.TryGetProperty("message", out var m) ? m.GetString() : null;
                                        var tip = errEl.TryGetProperty("tip", out var t) ? t.GetString() : null;
                                        tcs.TrySetException(new BrowserActionException(code, msg ?? "Unknown error", tip) { TabUrl = failedOn, TabId = failedTab });
                                    }
                                    else
                                    {
                                        tcs.TrySetResult(root.Clone());
                                    }
                                }
                                else
                                {
                                    tcs.TrySetResult(root.Clone());
                                }
                            }
                            break;

                        case "browser:pickResult":
                            var pickId = root.GetProperty("requestId").GetString() ?? "";
                            if (_pendingCommands.TryRemove(pickId, out var pickTcs))
                            {
                                pickTcs.TrySetResult(root.Clone());
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
        /// Reads the ranked "alternatives" array off any bridge message that carries one — the
        /// crosshair pick result and, since G1, the three recording messages. Never null: a
        /// missing, non-array or entirely malformed field yields an empty list, which every
        /// consumer already treats as "single selector, behave exactly as before".
        /// An entry with no selector is skipped rather than defaulted; there is no sensible
        /// stand-in for the one field that IS the alternative.
        /// </summary>
        private static List<SelectorAlternative> ReadAlternatives(JsonElement root)
        {
            var alternatives = new List<SelectorAlternative>();
            if (!root.TryGetProperty("alternatives", out var altEl) || altEl.ValueKind != JsonValueKind.Array)
                return alternatives;

            foreach (var alt in altEl.EnumerateArray())
            {
                if (alt.ValueKind != JsonValueKind.Object) continue;
                var altSel = alt.TryGetProperty("selector", out var s) ? s.GetString() : null;
                var altTier = alt.TryGetProperty("tier", out var t) ? t.GetString() : null;
                var altDesc = alt.TryGetProperty("description", out var d) ? d.GetString() : null;
                if (!string.IsNullOrEmpty(altSel))
                    alternatives.Add(new SelectorAlternative(altSel!, altTier ?? "C", altDesc ?? ""));
            }
            return alternatives;
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

        /// <summary>
        /// Writes one message to the extension. Returns false when it did not go out — either the
        /// bridge was already down or the write threw.
        /// </summary>
        /// <remarks>
        /// The return value exists because "dropped on the floor" and "sent" used to be
        /// indistinguishable to the caller. ExecuteBrowserCommandAsync checks IsConnected, registers
        /// its commandId, and only then sends; if the pipe dies in that window, the disconnect
        /// cleanup has already swept past without seeing the entry and the message is discarded
        /// silently. The command then sat there until its own timeout and reported
        /// ELEMENT_NOT_FOUND — "Element not found or not visible" — for a case where Chrome had
        /// simply gone away. Actively misleading at the exact moment the user needs the diagnosis.
        /// Fire-and-forget callers can keep ignoring the result.
        /// </remarks>
        public bool SendMessage(object message)
        {
            if (!IsConnected || _writer == null) return false;

            try
            {
                lock (_writeLock)
                {
                    var json = JsonSerializer.Serialize(message);
                    _writer.WriteLine(json);
                }
                return true;
            }
            catch (Exception ex)
            {
                // A failed send is how a browser action silently does nothing: the command never
                // reaches the extension, no reply ever comes, and the caller waits out its timeout
                // with no record of the cause. Debug.WriteLine meant that record existed only in a
                // debugger-attached build.
                DiagnosticLog.Warn($"[BrowserBridge] Send failed: {ex.GetType().Name}: {ex.Message}");
                return false;
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
            // RunContinuationsAsynchronously: these are completed from ReadMessagesAsync, i.e. the
            // single task that drains the pipe. Without it the awaiting continuation — a replay
            // step, an If probe, the picker's UI work — runs INLINE on that reader, so the next
            // message sits unread for as long as the continuation takes, and an exception in it
            // would surface inside the read loop. Every other TCS in this codebase already opts in.
            var tcs = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
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
                    if (result.TryGetProperty("selector", out var selEl) && selEl.ValueKind == JsonValueKind.String)
                        primary = selEl.GetString();
                    return new PickResult(primary, ReadAlternatives(result));
                }
            }
            catch
            {
                _pendingCommands.TryRemove(requestId, out _);
                // Give up on THIS side only, and the page stays in crosshair mode forever: content.js
                // keeps picking=true with its click/contextmenu handlers installed, and every click the
                // user makes is eaten (preventDefault + stopImmediatePropagation) instead of reaching
                // the page. Closing or switching the editor does not save them either — the frontend
                // clears its requestId on the null result, which disarms the only two places that would
                // still send a cancel. So tell the extension to stand down here. A pick reply already in
                // flight is unaffected: stopPick resolves it through the normal path and the frontend's
                // requestId guard drops it, and content.js's `if (picking)` makes the late cancel a no-op.
                CancelPickElement();
                return new PickResult(null, new List<SelectorAlternative>());
            }
        }

        public record PickResult(string? Selector, IReadOnlyList<SelectorAlternative> Alternatives);
        public record SelectorAlternative(string Selector, string Tier, string Description);

        /// <summary>
        /// Instant element-state check for If-BrowserElementState conditions: sends a
        /// waitElement command with timeout=0 so content.js evaluates the state ONCE and
        /// returns immediately (no wait loop). Returns the raw outcome as a bool — a
        /// not-found/hidden/disabled element, a pipe hiccup, or an unresponsive tab all
        /// read as FALSE rather than throwing, because an If probe must branch, not halt.
        /// User cancellation still propagates. The caller polls this when the IF carries a
        /// ConditionTimeout ("wait for condition"), so each call must stay cheap.
        /// </summary>
        /// <param name="ignoreTabPin">
        /// Same escape hatch as ExecuteBrowserCommandAsync: target the active tab and do not touch
        /// the run-scoped pin. For the editor's "test this condition" button, which is not a run.
        /// </param>
        public async Task<bool> ProbeElementStateAsync(
            TrueReplayer.Models.ActionItem action, CancellationToken token, int pipeTimeoutMs = 3000,
            bool ignoreTabPin = false)
        {
            if (!IsConnected) return false;

            var commandId = Guid.NewGuid().ToString("N")[..8];
            // RunContinuationsAsynchronously: these are completed from ReadMessagesAsync, i.e. the
            // single task that drains the pipe. Without it the awaiting continuation — a replay
            // step, an If probe, the picker's UI work — runs INLINE on that reader, so the next
            // message sits unread for as long as the continuation takes, and an exception in it
            // would surface inside the read loop. Every other TCS in this codebase already opts in.
            var tcs = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
            _pendingCommands[commandId] = tcs;

            SendMessage(new
            {
                type = "browser:executeCommand",
                commandId,
                command = "waitElement",
                selector = action.Key ?? "",
                text = action.BrowserText ?? "",     // text pattern for waitMode=text-match
                timeout = 0,                          // instant single check — see content.js short-circuit
                waitMode = action.WaitMode ?? "appears",
                // Pick-time fallback selectors apply to probes too (same drift protection).
                alternatives = action.SelectorAlternatives is { Count: > 0 }
                    ? action.SelectorAlternatives
                        .Select(x => new { selector = x.Selector, tier = x.Tier })
                        .ToArray()
                    : null,
                // An If-Browser probe must ask the SAME page the run's actions act on, or a
                // condition could pass on one tab while the click lands on another.
                tabId = ignoreTabPin ? (int?)null : _pinnedTabId
            });

            using var timeoutCts = new CancellationTokenSource(pipeTimeoutMs);
            try
            {
                using (token.Register(() => tcs.TrySetCanceled()))
                using (timeoutCts.Token.Register(() => tcs.TrySetException(new TimeoutException("probe pipe timeout"))))
                {
                    var result = await tcs.Task;
                    // The probe RESOLVES a page, so it also BINDS to it. Reading the pin without
                    // ever setting it was the whole bug: an If that runs before any browser action
                    // left the pin null, so it and the action after it each asked "which tab is
                    // active?" independently. Note this must happen on the not-found reply too —
                    // "the element is not there" is an answer ABOUT a specific page, and the run
                    // belongs on that page either way.
                    if (!ignoreTabPin) AdoptTabPin(ReadTabId(result));
                    return result.ValueKind == JsonValueKind.Object
                        && result.TryGetProperty("success", out var s)
                        && s.ValueKind == JsonValueKind.True;
                }
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                throw; // genuine user stop — propagate, never swallow into "false"
            }
            catch (BrowserActionException bex) when (!ignoreTabPin && bex.TabId.HasValue)
            {
                // Same rule on the error reply. A probe that came back ELEMENT_NOT_FOUND from tab X
                // has still told us the run lives on tab X; the caller polls this up to
                // ConditionTimeout, and every one of those polls used to re-resolve the active tab.
                AdoptTabPin(bex.TabId);
                return false;
            }
            catch
            {
                // Also catches a pipe DISCONNECT, which the reader's cleanup now reports as a
                // BrowserActionException("EXTENSION_DISCONNECTED") rather than a bare cancellation.
                // Either way it lands here and reads as FALSE, which is the contract an If probe
                // needs: a dropped bridge must make the condition BRANCH, not halt the replay
                // (same rule as ProbeBrowserElementStateAsync's disconnected-extension check).
                // The `when (token.IsCancellationRequested)` filter above still guards the one case
                // that must never be swallowed — a genuine user Stop.
                return false; // pipe timeout / disconnect / extension error → state not satisfied
            }
            finally
            {
                _pendingCommands.TryRemove(commandId, out _);
            }
        }

        // ── Run-scoped tab pin ──────────────────────────────────────────────────────────────
        //
        // The extension resolves the target with chrome.tabs.query({active:true}) — "the tab you
        // are looking at". For most macros that IS the intent: 4 of the owner's 6 browser profiles
        // act on a page already open rather than navigating to one. The bug was never the choice,
        // it was RE-MAKING the choice on every step: move focus mid-run and the macro follows,
        // silently acting on a different page.
        //
        // So resolve ONCE per run and reuse. The pin lives HERE, not in the extension: an MV3
        // service worker is evicted when idle, so state kept there evaporates. Passing the tabId
        // down with every command keeps the extension stateless and removes the need for any
        // "run started / run ended" protocol.
        private int? _pinnedTabId;

        /// <summary>Drop the pinned tab. Called at the start of every replay — a new run must
        /// resolve the page afresh rather than inherit whatever the last one was aimed at.</summary>
        public void ResetTabPin() => _pinnedTabId = null;

        /// <summary>
        /// Bind the run to the tab the extension actually used. Whoever resolves the page FIRST
        /// establishes it, and that had to include the If probe: a profile shaped
        /// [If BrowserElementState '#logout' → BrowserClick '#logout'] — the natural shape, and the
        /// reason If-Browser exists — ran the probe with no pin, so the probe fell through to
        /// chrome.tabs.query({active:true}) and the click then resolved the active tab AGAIN. Move
        /// focus between the two (a daemon trigger while the user works is exactly that) and the
        /// condition answers about tab A while the click lands on tab B, with nothing to detect it.
        /// </summary>
        private void AdoptTabPin(int? tabId)
        {
            if (tabId.HasValue) _pinnedTabId = tabId.Value;
        }

        /// <summary>The tab id the extension stamps on every relayed reply, success or failure.
        /// Absent on TAB_GONE / NO_CONTENT_SCRIPT, which background.js answers itself without ever
        /// reaching a tab — correctly, since there is no page there to bind to.</summary>
        private static int? ReadTabId(JsonElement result)
            => result.ValueKind == JsonValueKind.Object
               && result.TryGetProperty("tabId", out var t)
               && t.TryGetInt32(out var id)
                ? id
                : null;

        /// <param name="ignoreTabPin">
        /// Run the command outside the run-scoped pin entirely: send tabId=null (the extension falls
        /// back to the active tab) and do NOT adopt the tab it used. For the editor's "Test action",
        /// which is not a run and must not write to run state — see TestActionAsync.
        /// </param>
        public async Task<JsonElement> ExecuteBrowserCommandAsync(
            TrueReplayer.Models.ActionItem action, CancellationToken token, int timeoutMs = 5000,
            string? resolvedText = null, bool ignoreTabPin = false)
        {
            if (!IsConnected)
                throw new InvalidOperationException("Browser extension is not connected.");

            var commandId = Guid.NewGuid().ToString("N")[..8];
            // RunContinuationsAsynchronously: these are completed from ReadMessagesAsync, i.e. the
            // single task that drains the pipe. Without it the awaiting continuation — a replay
            // step, an If probe, the picker's UI work — runs INLINE on that reader, so the next
            // message sits unread for as long as the continuation takes, and an exception in it
            // would surface inside the read loop. Every other TCS in this codebase already opts in.
            var tcs = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
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
                case "BrowserAssert":
                    // BrowserAssert reuses the extension's waitElement evaluator (appears/
                    // disappears/enabled/text-match). A timeout throws BrowserActionException,
                    // which ExecuteBrowserAssert converts into the friendly Halt/Continue policy.
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

            // The action's timeout budget arrives ALREADY DECIDED in timeoutMs — all three callers
            // (the replay's Browser arm, ExecuteBrowserAssert, TestActionAsync) pass the same
            // `action.Timeout > 0 ? action.Timeout : 5000`. There used to be a ternary here that
            // re-derived it for five of the seven action types, announcing a policy ("these five
            // honour action.Timeout, Type/Navigate don't") that it did not implement: on every
            // reachable path both branches produced the identical value, so editing it to change
            // the policy would have changed nothing at all. The decision has one home; this isn't it.

            // Navigation can take longer than action timeout; give it generous headroom (timeout * 6 or 30s).
            //
            // Everything else gets the action's timeout PLUS a grace margin, because the two clocks are
            // not the same clock. This CTS starts below, before the message has crossed the pipe, the
            // NativeHost, the service worker and tabs.sendMessage; content.js only arms its own timer once
            // it has the message. Same nominal value ⇒ this side always fires first, and that cost two
            // real things: (1) content.js's timeout classifier (ELEMENT_HIDDEN / ELEMENT_DISABLED /
            // "tried N selectors") could never win the race, so every timeout collapsed into the generic
            // GetFriendlyTimeoutMessage below and the user lost the actual diagnosis; (2) content.js has
            // no abort — an element found in the last moments still runs its ~310 ms of click sequence, so
            // the click LANDED while this side had already reported ELEMENT_NOT_FOUND and halted the run.
            // The margin makes the content script's timer the authority on "not found" (where the message
            // has context) and leaves this one as the backstop for a pipe that never answers at all.
            // Costs nothing on success, and the fast failures still answer fast: a closed tab replies
            // TAB_GONE in ~0 ms and a page with no content script NO_CONTENT_SCRIPT in ~300 ms.
            const int PipeGraceMs = 2000;
            var pipeTimeout = command == "navigate" ? Math.Max(timeoutMs * 6, 30000) : timeoutMs + PipeGraceMs;

            bool sent = SendMessage(new
            {
                type = "browser:executeCommand",
                commandId,
                command,
                selector = action.Key ?? "",
                text = resolvedText ?? action.BrowserText ?? "",
                url = action.Key ?? "",
                newTab = action.NewTab,
                timeout = timeoutMs,
                // New fields (extension 1.3.0) — older extensions ignore unknown keys
                waitMode = action.WaitMode,
                urlWaitPattern = action.UrlWaitPattern,
                postNavigateSelector = action.PostNavigateSelector,
                typeAppend = action.TypeAppend,
                typePaste = action.TypePaste,
                typeDelay = action.TypeDelay,
                // BrowserSelectOption (extension bump) — defaults to "text" when null.
                selectMatchMode = action.SelectMatchMode ?? "text",
                // Ranked fallback selectors captured at pick time — the extension retries
                // these in tier order when the primary selector times out. null when the
                // action has none (older profiles / hand-typed selectors); older extensions
                // ignore the key entirely.
                alternatives = action.SelectorAlternatives is { Count: > 0 }
                    ? action.SelectorAlternatives
                        .Select(x => new { selector = x.Selector, tier = x.Tier })
                        .ToArray()
                    : null,
                // The tab this run is bound to; null on the first command, after which the
                // extension's reply tells us which one it used. An older extension ignores the key
                // and keeps its per-command behaviour, which is exactly the pre-fix status quo.
                // ignoreTabPin sends null on purpose — the extension's documented fallback is
                // chrome.tabs.query({active:true}), i.e. exactly what the picker already targets.
                tabId = ignoreTabPin ? (int?)null : _pinnedTabId
            });

            // The IsConnected check at the top of this method and the send are not one atomic step:
            // the pipe can die in between, and by then the disconnect sweep has already walked
            // _pendingCommands without seeing this entry. Waiting out pipeTimeout would report
            // ELEMENT_NOT_FOUND for a browser that is no longer there. Fail now, with the code that
            // says what actually happened — the same one the disconnect sweep uses.
            if (!sent)
            {
                _pendingCommands.TryRemove(commandId, out _);
                throw new BrowserActionException(
                    "EXTENSION_DISCONNECTED",
                    "The browser bridge disconnected before the action could be sent.",
                    "Chrome or the TrueReplayer extension was closed, reloaded, or recycled. Reconnect and run again.");
            }

            using var timeoutCts = new CancellationTokenSource(pipeTimeout);

            try
            {
                // If user stops replay, propagate cancellation normally
                using (token.Register(() => tcs.TrySetCanceled()))
                // If command times out, set a timeout exception instead of cancellation
                using (timeoutCts.Token.Register(() => tcs.TrySetException(
                    new BrowserActionException(
                        code: command == "navigate" ? "NAVIGATION_TIMEOUT" : "ELEMENT_NOT_FOUND",
                        message: GetFriendlyTimeoutMessage(command, timeoutMs),
                        tip: GetFriendlyTimeoutTip(command)))))
                {
                    var result = await tcs.Task;
                    // Bind the run to whatever tab the extension actually used. Every later
                    // command carries it, so a focus change mid-run can no longer redirect the
                    // macro. A navigate re-pins by nature: it reports the tab it navigated, which
                    // is a NEW one when the action opened one.
                    // Skipped under ignoreTabPin: the pin is run state, and the only thing that
                    // clears it is the start of the next replay. A Test action writing to it left a
                    // stale tab id behind that outlived the editor — test once, close that tab, test
                    // again and the second test failed with "the tab this RUN was acting on has been
                    // closed" with no run anywhere in sight, or worse, silently ran in the old tab.
                    if (!ignoreTabPin) AdoptTabPin(ReadTabId(result));
                    // Surface fallback usage in the session log — the primary selector is
                    // drifting and the user should re-pick before the fallbacks drift too.
                    if (result.ValueKind == JsonValueKind.Object
                        && result.TryGetProperty("matchedVia", out var mv)
                        && mv.ValueKind == JsonValueKind.Object)
                    {
                        var mvSel = mv.TryGetProperty("selector", out var s) ? s.GetString() : null;
                        var mvTier = mv.TryGetProperty("tier", out var t) ? t.GetString() : null;
                        TrueReplayer.Services.DiagnosticLog.Info(
                            $"[BrowserBridge] {command}: primary selector '{action.Key}' failed — matched via tier-{mvTier} fallback '{mvSel}'. Consider re-picking the element.");
                    }
                    return result;
                }
            }
            catch (BrowserActionException bex) when (!ignoreTabPin && bex.TabId.HasValue)
            {
                // A step that FAILED still resolved a page. Under AssertOnFail=Continue the run
                // carries on, and it must carry on WHERE IT WAS — dropping the binding here sent
                // the next step back to "whatever tab is active now", which is the exact drift the
                // pin exists to prevent, on the one path where the user is already distracted by
                // an error. Adopt, then rethrow untouched: the failure policy above this frame is
                // what decides whether the run halts, not this.
                AdoptTabPin(bex.TabId);
                throw;
            }
            finally
            {
                _pendingCommands.TryRemove(commandId, out _);
            }
        }

        /// <summary>
        /// One-shot browser action execution for the "Test action" button in the editor.
        /// Same as ExecuteBrowserCommandAsync but does not require an existing replay context —
        /// and, because there is no run, it neither reads nor writes the run-scoped tab pin. It
        /// targets the active tab, which is what the user is looking at and what the crosshair
        /// picker already aims at, so Test and Pick finally agree on "which page".
        /// </summary>
        public async Task<JsonElement> TestActionAsync(
            TrueReplayer.Models.ActionItem action, CancellationToken token, string? resolvedText = null)
        {
            return await ExecuteBrowserCommandAsync(action, token,
                action.Timeout > 0 ? action.Timeout : 5000, resolvedText, ignoreTabPin: true);
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
        /// <summary>
        /// The page the step was acting on when it failed. The extension puts it on EVERY reply,
        /// success or error, and the failure path used to drop it — so the run report could tell
        /// you which page a step that WORKED was on, and not the one that broke. Backwards, since
        /// "which page was this?" is the first question a failure raises: an ELEMENT_NOT_FOUND
        /// reads the same whether the session had expired, a banner was covering the page, or the
        /// run was simply somewhere else entirely.
        /// </summary>
        public string? TabUrl { get; init; }

        /// <summary>
        /// The tab the step was acting on, carried for the SAME reason as TabUrl but consumed by
        /// the run rather than by the reader: a first step that fails under a Continue policy still
        /// resolved a page, and the steps after it must stay on it. Without this the failure path
        /// dropped the binding and the next step re-resolved "whatever is active now".
        /// Null when the extension never reached a tab (TAB_GONE, NO_CONTENT_SCRIPT, pipe timeout).
        /// </summary>
        public int? TabId { get; init; }

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
