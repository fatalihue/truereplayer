using System;
using System.Collections.Generic;
using System.Linq;
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

            // Browser actions (BrowserClick/Type/Navigate/WaitElement/SelectOption) all rely on the
            // Chrome extension + native host bridge added in 2.1.0.
            (p => p.Actions.Any(a => !string.IsNullOrEmpty(a.ActionType) &&
                a.ActionType.StartsWith("Browser", StringComparison.OrdinalIgnoreCase)),
                new Version(2, 1, 0), "Browser actions"),

            // HoldKey / Keystroke combos were factored out of the regular Key actions in 2.0.0.
            (p => p.Actions.Any(a => string.Equals(a.ActionType, "HoldKey", StringComparison.OrdinalIgnoreCase) ||
                                      string.Equals(a.ActionType, "Keystroke", StringComparison.OrdinalIgnoreCase)),
                new Version(2, 0, 0), "HoldKey/Keystroke"),

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

            // Restore Size split from Restore Position in 2.0.5; older builds only honour Position.
            (p => p.RestoreSize,
                new Version(2, 0, 5), "RestoreSize"),

            // Sharing-metadata round-trip itself is a 2.2 feature — anything carrying tags/description
            // came from a 2.2+ build. Older builds will ignore the metadata but load the actions fine,
            // so this is the floor for "no compatibility issues" rather than a hard requirement.
            (p => (p.Tags != null && p.Tags.Count > 0) || !string.IsNullOrEmpty(p.Description) || !string.IsNullOrEmpty(p.IconEmoji),
                new Version(2, 2, 0), "Profile sharing metadata"),
        };

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
