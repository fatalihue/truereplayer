using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using TrueReplayer.Models;

namespace TrueReplayer.Services
{
    /// <summary>
    /// Computes the minimum TrueReplayer version a given profile needs in order to run.
    /// Used at export time so a shared .trprofile carries an AppMinVersion the receiver
    /// can check against their installed version before importing.
    ///
    /// The lookup table is intentionally small — only features that are NEW since the
    /// project's "1.0.0 baseline" need entries. Anything missing from the table is
    /// assumed to be available in 1.0.0. When you add a new action type or a profile-
    /// level switch that wouldn't work on older builds, add a row here and the export
    /// flow picks it up automatically.
    ///
    /// Format choice: plain "MAJOR.MINOR.PATCH" string parsed lazily by IsCompatible —
    /// no NuGet dep on Semver. Pre-release suffixes are not supported (we don't ship
    /// pre-release builds publicly).
    /// </summary>
    public static class ProfileCompatibility
    {
        /// <summary>The version below which we don't bother emitting AppMinVersion at all.</summary>
        private static readonly Version BaselineVersion = new(1, 0, 0);

        /// <summary>
        /// Feature → minimum version that supports it. Add new entries here whenever
        /// you ship a feature that can be persisted into a profile and wouldn't load
        /// on older builds.
        /// </summary>
        private static readonly List<(Func<UserProfile, bool> Detect, Version MinVersion, string FeatureName)> FeatureMatrix = new()
        {
            // WaitImage was added in 2.0 — actions of this type fail on older releases.
            (p => p.Actions.Any(a => string.Equals(a.ActionType, "WaitImage", StringComparison.OrdinalIgnoreCase)),
                new Version(2, 0, 0), "WaitImage"),

            // Relative coordinates require the window-tracking pipeline shipped in 2.0.5.
            (p => p.UseRelativeCoordinates,
                new Version(2, 0, 5), "UseRelativeCoordinates"),

            // WhilePressed / Toggle trigger modes landed in 2.1.0; older builds only handle OnPress/OnRelease.
            (p => p.TriggerMode == TriggerMode.WhilePressed || p.TriggerMode == TriggerMode.Toggle,
                new Version(2, 1, 0), "TriggerMode WhilePressed/Toggle"),

            // DoubleTap / Hold trigger modes — an older build's JsonStringEnumConverter THROWS
            // on the unknown enum string: the local profile.json fails to load entirely (a
            // _loadFailures toast, worse than divergence), and inside a .trprofile envelope the
            // parse failure bricks the WHOLE batch with a generic "corrupt file" error before
            // the per-entry compat gate ever runs. The pin can't soften either failure (it is
            // metadata inside the same JSON) — it exists so the export carries an honest
            // AppMinVersion. Introduced after 2.8.1 — bump at release.
            (p => p.TriggerMode == TriggerMode.DoubleTap || p.TriggerMode == TriggerMode.Hold,
                new Version(2, 9, 0), "TriggerMode double-tap/hold"),

            // Mouse X-button hotkey ("XButton1"/"XButton2" in CustomHotkey) — an older build's
            // mouse hook never decodes WM_XBUTTON*, so the hotkey is silently dead (profile
            // loads fine, trigger never fires). Same divergence class as the mode pins.
            // Introduced after 2.8.1 — bump at release.
            (p => p.CustomHotkey?.Contains("XButton", StringComparison.OrdinalIgnoreCase) == true,
                new Version(2, 9, 0), "Mouse-button hotkey"),

            // WaitPixelColor + the pixel:* bridge messages were introduced in 2.1.4.
            (p => p.Actions.Any(a => string.Equals(a.ActionType, "WaitPixelColor", StringComparison.OrdinalIgnoreCase)),
                new Version(2, 1, 4), "WaitPixelColor"),

            // Conditional logic (IF / ELSE / ENDIF blocks) — older builds don't understand
            // the new action types and would treat them as no-op rows (worse: the body of
            // a "false" branch would execute unconditionally). Pin the whole feature to
            // 2.3.0 the moment ANY of the three structural rows appears.
            (p => p.Actions.Any(a => !string.IsNullOrEmpty(a.ActionType) && (
                string.Equals(a.ActionType, "If", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(a.ActionType, "Else", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(a.ActionType, "EndIf", StringComparison.OrdinalIgnoreCase))),
                new Version(2, 3, 0), "Conditional logic (If/Else/EndIf)"),

            // IF poll-timeout (ConditionTimeout > 0) shipped 2.6.9. A 2.3.0-2.6.8 build
            // understands IF but ignores this field → does an instant single probe instead of
            // polling up to N ms → can read the condition false before it becomes true and take
            // the Else branch (silent divergence). The field is JsonIgnore-when-default so it is
            // only present when > 0; predicate is exact.
            (p => p.Actions.Any(a => a.ConditionTimeout > 0),
                new Version(2, 6, 9), "IF condition poll timeout"),

            // New If-condition families — an older build hits the unknown-ConditionType
            // else-branch in InstantProbe → treats the probe as false → always takes the
            // Else branch, a silent semantic divergence. Pin to the build that introduces
            // them (2.8.0, the introducing build), same as the
            // ActivateWindow / cycle pins. One row per family so import diagnostics name it.
            (p => p.Actions.Any(a => string.Equals(a.ConditionType, "Random", StringComparison.OrdinalIgnoreCase)),
                new Version(2, 8, 0), "If Random condition"),
            (p => p.Actions.Any(a => string.Equals(a.ConditionType, "Variable", StringComparison.OrdinalIgnoreCase)),
                new Version(2, 8, 0), "If Variable condition"),
            (p => p.Actions.Any(a => string.Equals(a.ConditionType, "ProcessRunning", StringComparison.OrdinalIgnoreCase)),
                new Version(2, 8, 0), "If Process Running condition"),
            (p => p.Actions.Any(a => string.Equals(a.ConditionType, "FileExists", StringComparison.OrdinalIgnoreCase)),
                new Version(2, 8, 0), "If File Exists condition"),
            (p => p.Actions.Any(a => string.Equals(a.ConditionType, "TimeWindow", StringComparison.OrdinalIgnoreCase)),
                new Version(2, 8, 0), "If Time condition"),

            // The 2.6.12 If-condition families have the SAME unknown-ConditionType failure
            // mode as the 2.8.0 block above, but were never pinned. A 2.3.0-2.6.11 build
            // understands If/Else/EndIf yet hits InstantProbe's unknown-condition else-branch
            // → treats the probe as false → always takes the Else branch (silent divergence).
            (p => p.Actions.Any(a => string.Equals(a.ConditionType, "WindowOpen", StringComparison.OrdinalIgnoreCase)),
                new Version(2, 6, 12), "If Window condition"),
            (p => p.Actions.Any(a => string.Equals(a.ConditionType, "ClipboardMatch", StringComparison.OrdinalIgnoreCase)),
                new Version(2, 6, 12), "If Clipboard condition"),
            (p => p.Actions.Any(a => string.Equals(a.ConditionType, "BrowserElementState", StringComparison.OrdinalIgnoreCase)),
                new Version(2, 6, 12), "If Browser element condition"),

            // Data-loop table (Model A) — older builds leave {row:column} tokens literal and
            // don't loop over the rows, a silent divergence. Pin to the introducing build
            // (2.8.0).
            (p => p.Data != null,
                new Version(2, 8, 0), "Data-loop table"),

            // Per-row skip-on-error (OnRowError == "skip") — an older build ignores the unknown
            // JSON property and HALTS the whole run on the first failed row instead of skipping,
            // a silent behavioural divergence. Property-level pin so plain tables keep the
            // 2.8.0 floor; gated on LoopOverData because skip is runtime-inert without the
            // batch loop (matches SkipRowOnErrorActive). Introduced after 2.8.1 — bump at release.
            (p => p.Data is { LoopOverData: true } d && string.Equals(d.OnRowError, "skip", StringComparison.OrdinalIgnoreCase),
                new Version(2, 9, 0), "Data-loop skip-on-error"),

            // Data-loop cell modifiers ({row:column:mods}) — an older build's row-token regex
            // requires '}' right after the column name, so the WHOLE token stays literal and
            // gets typed into the target verbatim (worse than the clipboard-mods degradation,
            // where at least the content substitutes). Text-scan over every token-resolved
            // string field. Introduced after 2.8.1 — bump at release.
            (p => p.Actions.Any(UsesModifiedRowToken),
                new Version(2, 9, 0), "Data-loop cell modifiers"),

            // Copy to Slot ({clip:name} capture) — an older build has no dispatch case for the
            // unknown ActionType → silently skips the capture and every {clip:} token resolves
            // empty. Introduced after 2.8.1 — bump at release.
            (p => p.Actions.Any(a => string.Equals(a.ActionType, "CopyToSlot", StringComparison.OrdinalIgnoreCase)),
                new Version(2, 9, 0), "Copy to Slot"),

            // BrowserAssert — a DEDICATED row (the Browser* predicate below auto-pins 2.1.0,
            // but that is INSUFFICIENT: an older build has no dispatch case for the unknown
            // type, silently SKIPS the assertion → a broken page passes unnoticed. Pin to
            // 2.8.0 (the introducing build).
            (p => p.Actions.Any(a => string.Equals(a.ActionType, "BrowserAssert", StringComparison.OrdinalIgnoreCase)),
                new Version(2, 8, 0), "Browser assert"),

            // Browser actions (BrowserClick/Type/Navigate/WaitElement/SelectOption) all rely on the
            // Chrome extension + native host bridge added in 2.1.0.
            (p => p.Actions.Any(a => !string.IsNullOrEmpty(a.ActionType) &&
                a.ActionType.StartsWith("Browser", StringComparison.OrdinalIgnoreCase)),
                new Version(2, 1, 0), "Browser actions"),

            // HoldKey / Keystroke combos were factored out of the regular Key actions in 2.0.0.
            (p => p.Actions.Any(a => string.Equals(a.ActionType, "HoldKey", StringComparison.OrdinalIgnoreCase) ||
                                      string.Equals(a.ActionType, "Keystroke", StringComparison.OrdinalIgnoreCase)),
                new Version(2, 0, 0), "HoldKey/Keystroke"),

            // RunProfile (profile chaining) shipped in the 2.0.0 line, same era as WaitImage /
            // HoldKey / Keystroke which ARE pinned here — but it was missed. A pre-2.0.0 build
            // has no "RunProfile" switch case (no default) → silently skips the sub-profile
            // call. Pinned to 2.0.0 for consistency.
            (p => p.Actions.Any(a => string.Equals(a.ActionType, "RunProfile", StringComparison.OrdinalIgnoreCase)),
                new Version(2, 0, 0), "RunProfile (profile chaining)"),

            // RunProfile-over-data (data-loop Phase C) — an older build drops the unknown
            // RunOverData property and runs the sub-profile ONCE instead of once per data row
            // (silent divergence; a 40-row batch quietly becomes 1). Property-level Detect so
            // plain RunProfile rows keep the 2.0.0 floor. Introduced after 2.8.1 — bump at release.
            (p => p.Actions.Any(a => string.Equals(a.ActionType, "RunProfile", StringComparison.OrdinalIgnoreCase)
                && a.RunOverData == true),
                new Version(2, 9, 0), "RunProfile over data"),

            // Combined-mode single clicks (LeftClick/RightClick/MiddleClick — press+release in one
            // row) shipped in 2.4.0. Builds without the replay switch cases silently skip the click,
            // so pin the profile the moment one appears. Kept in lockstep with the app version so an
            // own-build export → import round-trips cleanly (IsCompatible rejects a pin above the
            // running version).
            (p => p.Actions.Any(a => string.Equals(a.ActionType, "LeftClick", StringComparison.OrdinalIgnoreCase) ||
                                      string.Equals(a.ActionType, "RightClick", StringComparison.OrdinalIgnoreCase) ||
                                      string.Equals(a.ActionType, "MiddleClick", StringComparison.OrdinalIgnoreCase)),
                new Version(2, 4, 0), "Combined clicks (LeftClick/RightClick/MiddleClick)"),

            // DoubleClick (two press/release pairs replayed as one row) shipped in 2.5.4 —
            // older builds have no replay switch case and would silently skip it.
            (p => p.Actions.Any(a => string.Equals(a.ActionType, "DoubleClick", StringComparison.OrdinalIgnoreCase)),
                new Version(2, 5, 4), "Double click"),

            // ActivateWindow (launch/wait/focus a window mid-run) — older builds have no
            // replay switch case and would silently skip the row, leaving the following
            // actions to fire against whatever window happens to be focused. Pinned to
            // the build that introduces it (2.8.0) so an own-build export → import
            // round-trips cleanly — IsCompatible would reject a pin above the running
            // version.
            (p => p.Actions.Any(a => string.Equals(a.ActionType, "ActivateWindow", StringComparison.OrdinalIgnoreCase)),
                new Version(2, 8, 0), "Activate Window"),

            // ActivateWindow window PLACEMENT (RestorePosition / RestoreSize + WindowX/Y/Width/
            // Height on the action) shipped AFTER 2.8.0. A 2.8.0 build has the ActivateWindow
            // replay case, so the row itself runs — but it drops the unknown placement properties
            // and activates the window WITHOUT moving/resizing it, leaving any following absolute
            // clicks to land against a wrong-placed window (silent divergence). Introduced in
            // 2.8.1; bumped from the 2.8.0 dev placeholder at release, in lockstep with the
            // version files (see [[workflow-release-procedure]]).
            (p => p.Actions.Any(a => string.Equals(a.ActionType, "ActivateWindow", StringComparison.OrdinalIgnoreCase)
                && (a.RestorePosition || a.RestoreSize)),
                new Version(2, 8, 1), "Activate Window placement"),

            // ActivateWindow Phase 3 — VERB (maximize/minimize/close) + NTH-MATCH shipped after 2.8.1.
            // An older build has the ActivateWindow replay case, so the row runs — but it drops the
            // unknown WindowVerb/WindowMatchIndex and does the DEFAULT (activate the FIRST match),
            // e.g. focuses a window the user meant to CLOSE (silent divergence). Property-level Detect
            // so a plain ActivateWindow keeps the 2.8.0 floor. Pinned at 2.8.1 (≤ the running dev
            // version) so own-export→import round-trips; bump at release with the other pins.
            (p => p.Actions.Any(a => string.Equals(a.ActionType, "ActivateWindow", StringComparison.OrdinalIgnoreCase)
                && (!string.IsNullOrEmpty(a.WindowVerb) || (a.WindowMatchIndex is int mi && mi > 1))),
                new Version(2, 9, 0), "Activate Window verb/nth-match"),

            // SetVariable Cycle mode — older builds drop the unknown VariableMode property
            // and run the row in SET mode, storing the ENTIRE multi-line list instead of
            // one item per execution (silent semantic change, exactly what this matrix
            // gates). Pinned to the build that introduces it (2.8.0), same as Activate
            // Window.
            (p => p.Actions.Any(a => string.Equals(a.VariableMode, "cycle", StringComparison.OrdinalIgnoreCase)),
                new Version(2, 8, 0), "Set Variable cycle mode"),

            // SendText rich text (KeyHtml) shipped AFTER 2.8.0. An older build drops the unknown
            // KeyHtml property and pastes the plain Key — content preserved, formatting silently
            // lost. That is a mild divergence (never literal markup), but formatting can be
            // load-bearing (a bolded warning, a numbered procedure), so gate it like the other
            // property-level pins. Predicate is on the FIELD, not the ActionType, so existing
            // plain SendText profiles keep their old floor. Introduced in 2.8.1; bumped from the
            // 2.8.0 dev placeholder at release, in lockstep with the ActivateWindow placement pin
            // and the version files.
            (p => p.Actions.Any(a => !string.IsNullOrEmpty(a.KeyHtml) || !string.IsNullOrEmpty(a.KeyMarkdown)),
                new Version(2, 8, 1), "Rich text (SendText)"),

            // SetVariable base action ('set' mode, VariableMode null) shipped in 2.6.12.
            // Builds < 2.6.12 have no "SetVariable" case in the replay switch (which has NO
            // default) → silently skip the row → the variable is never written → downstream
            // {var} tokens resolve empty. Only the CYCLE sub-mode above is otherwise pinned,
            // leaving the base action unpinned.
            (p => p.Actions.Any(a => string.Equals(a.ActionType, "SetVariable", StringComparison.OrdinalIgnoreCase)),
                new Version(2, 6, 12), "Set Variable"),

            // Automation trigger (interval / schedule / condition self-firing) — an older build
            // has no Triggers property, so the config is DROPPED at load and any save from that
            // build rewrites the profile without it (no JsonExtensionData anywhere): the entire
            // automation silently evaporates. That is the destroy-on-round-trip class of
            // divergence this matrix exists for (the NotifyOnLapComplete no-pin precedent does
            // NOT apply — that field is a cosmetic notice, this is a whole feature's config).
            // Introduced after 2.8.1 — bump at release.
            (p => p.Triggers != null,
                new Version(2, 9, 0), "Automation trigger"),

            // Restore Size split from Restore Position in 2.0.5; older builds only honour Position.
            (p => p.RestoreSize,
                new Version(2, 0, 5), "RestoreSize"),

            // Sharing-metadata round-trip itself is a 2.2 feature — anything carrying tags/description
            // came from a 2.2+ build. Older builds will ignore the metadata but load the actions fine,
            // so this is the floor for "no compatibility issues" rather than a hard requirement.
            (p => (p.Tags != null && p.Tags.Count > 0) || !string.IsNullOrEmpty(p.Description) || !string.IsNullOrEmpty(p.IconEmoji),
                new Version(2, 2, 0), "Profile sharing metadata"),
        };

        // {row:column:mods} — a row token carrying at least one modifier segment after the
        // column name. Mirrors ActionExecution.RowDataTokenRegex's modified form; the plain
        // {row:column} shape is NOT matched (already covered by the Data-loop table pin).
        private static readonly Regex ModifiedRowTokenRegex = new(
            @"\{row:[A-Za-z0-9_]+:[^}]+\}",
            RegexOptions.IgnoreCase | RegexOptions.Compiled);

        // Key is resolved only on the key-simulation family + SendText; BrowserText only on
        // BrowserType/BrowserSelectOption (BrowserWaitElement text-match patterns go RAW to
        // the extension). Gate those two SHARED fields by ActionType so e.g. a browser
        // selector that merely looks like a modified row token can't over-pin a profile
        // that behaves identically on the older build.
        private static readonly HashSet<string> KeyResolvingActionTypes = new(StringComparer.OrdinalIgnoreCase)
            { "SendText", "Keystroke", "KeyDown", "KeyUp", "HoldKey" };
        private static readonly HashSet<string> BrowserTextResolvingActionTypes = new(StringComparer.OrdinalIgnoreCase)
            { "BrowserType", "BrowserSelectOption" };

        // Every string field the runtime token resolver touches — the fields where a
        // {row:column:mods} token can actually take effect (SendText/Keystroke Key + rich
        // flavors, browser text, Set Variable value, If-Variable operand, If-File path,
        // ActivateWindow launch path/args).
        private static bool UsesModifiedRowToken(ActionItem a) =>
            (KeyResolvingActionTypes.Contains(a.ActionType) && ContainsModifiedRowToken(a.Key)) ||
            ContainsModifiedRowToken(a.KeyHtml) ||
            ContainsModifiedRowToken(a.KeyMarkdown) ||
            (BrowserTextResolvingActionTypes.Contains(a.ActionType) && ContainsModifiedRowToken(a.BrowserText)) ||
            ContainsModifiedRowToken(a.VariableValue) ||
            ContainsModifiedRowToken(a.ConditionOperand) ||
            ContainsModifiedRowToken(a.FilePath) ||
            ContainsModifiedRowToken(a.LaunchPath) ||
            ContainsModifiedRowToken(a.LaunchArgs);

        private static bool ContainsModifiedRowToken(string? text) =>
            !string.IsNullOrEmpty(text) && text.Contains("{row", StringComparison.OrdinalIgnoreCase)
                && ModifiedRowTokenRegex.IsMatch(text);

        /// <summary>
        /// Walks the feature matrix and returns the highest minimum version among all
        /// features the profile actually uses. Returns null when nothing beyond the
        /// 1.0 baseline is required (no AppMinVersion needs to be written).
        /// </summary>
        public static string? ComputeMinVersion(UserProfile profile)
        {
            Version highest = BaselineVersion;
            foreach (var (detect, version, _) in FeatureMatrix)
            {
                try
                {
                    if (detect(profile) && version > highest)
                        highest = version;
                }
                catch
                {
                    // A predicate throwing means the profile shape is unusual — skip that
                    // feature rather than failing the whole export. Worst case: AppMinVersion
                    // is slightly low, and the receiver sees a runtime error instead of a
                    // pre-import block. Acceptable degradation.
                }
            }
            return highest > BaselineVersion ? FormatVersion(highest) : null;
        }

        /// <summary>
        /// Compares an exported AppMinVersion against the currently running app version.
        /// Returns true when the profile can run (running ≥ required). A null required
        /// version means "no requirement" → always compatible.
        /// </summary>
        public static bool IsCompatible(string? requiredVersion, string runningVersion)
        {
            if (string.IsNullOrWhiteSpace(requiredVersion)) return true;
            // Present-but-unparseable required version (e.g. a hand-crafted "99.banana"): fail
            // CLOSED. The pin was clearly intended to gate, so a value we can't compare must be
            // treated as incompatible rather than waved through.
            if (!TryParseVersion(requiredVersion, out var required)) return false;
            if (!TryParseVersion(runningVersion, out var running)) return true;
            return running >= required;
        }

        /// <summary>
        /// Lists the feature names that pushed the AppMinVersion above the baseline.
        /// Used by the Info tab to render "Min version: 2.1.0 (because: TriggerMode WhilePressed)"
        /// so users can understand what's pinning their profile to a newer build.
        /// </summary>
        public static List<string> ListContributingFeatures(UserProfile profile)
        {
            // Single pass: evaluate each detect predicate exactly once, recording the
            // (version, name) of every feature the profile actually uses.
            var matches = new List<(Version Version, string Name)>();
            Version highest = BaselineVersion;
            foreach (var (detect, version, name) in FeatureMatrix)
            {
                try
                {
                    if (detect(profile))
                    {
                        matches.Add((version, name));
                        if (version > highest) highest = version;
                    }
                }
                catch { }
            }
            // Collect (in matrix order) every matched feature pinned at the highest version.
            var contributors = new List<string>();
            foreach (var (version, name) in matches)
            {
                if (version == highest) contributors.Add(name);
            }
            return contributors;
        }

        private static bool TryParseVersion(string s, out Version version)
        {
            // Strip any leading 'v' and only consume MAJOR[.MINOR[.PATCH]] — drop anything
            // after a '-' or '+' so we tolerate semver pre-release / build suffixes even
            // though we don't emit them.
            var trimmed = s.TrimStart('v', 'V');
            int cut = trimmed.IndexOfAny(new[] { '-', '+' });
            if (cut >= 0) trimmed = trimmed[..cut];
            return Version.TryParse(trimmed, out version!);
        }

        private static string FormatVersion(Version v)
        {
            // Always emit 3-part (MAJOR.MINOR.PATCH) for stability — .NET's Version.ToString()
            // omits trailing zero components ("2.0" instead of "2.0.0") which confuses semver
            // consumers on the frontend.
            int build = v.Build < 0 ? 0 : v.Build;
            return $"{v.Major}.{v.Minor}.{build}";
        }
    }
}
