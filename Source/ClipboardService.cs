using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Text;
using TrueReplayer.Models;
using Windows.ApplicationModel.DataTransfer;

namespace TrueReplayer.Services
{
    public static class ClipboardService
    {
        public static void CopyActions(ObservableCollection<ActionItem> actions)
        {
            if (actions == null || actions.Count == 0) return;

            var headers = new[] { "#", "Action", "Key", "X", "Y", "Delay", "Notes" };
            var rows = new List<string[]>(actions.Count);
            for (int i = 0; i < actions.Count; i++)
            {
                var a = actions[i];
                rows.Add(new[]
                {
                    (i + 1).ToString(),
                    FriendlyActionType(a.ActionType),
                    FriendlyKey(a),
                    a.DisplayX ?? "",
                    a.DisplayY ?? "",
                    FormatDuration(a.Delay),
                    a.Comment ?? ""
                });
            }

            int totalDelay = actions.Sum(a => a.Delay);
            string summary = $"Actions: {actions.Count} | Total delay: {FormatDuration(totalDelay)}";

            // TSV format (for spreadsheets)
            var tsv = new StringBuilder();
            tsv.AppendLine($"# {summary}");
            tsv.AppendLine(string.Join("\t", headers));
            foreach (var row in rows)
                tsv.AppendLine(string.Join("\t", row));

            // HTML table (for rich-text editors)
            var html = new StringBuilder();
            html.AppendLine("<table>");
            html.AppendLine("<caption style=\"text-align:left;font-size:11px;color:#888;padding:2px 4px\">" +
                System.Net.WebUtility.HtmlEncode(summary) + "</caption>");
            html.Append("<tr>");
            foreach (var h in headers)
                html.Append($"<th style=\"text-align:left;padding:2px 8px;border-bottom:1px solid #555\">{System.Net.WebUtility.HtmlEncode(h)}</th>");
            html.AppendLine("</tr>");
            foreach (var row in rows)
            {
                html.Append("<tr>");
                foreach (var cell in row)
                    html.Append($"<td style=\"padding:2px 8px\">{System.Net.WebUtility.HtmlEncode(cell)}</td>");
                html.AppendLine("</tr>");
            }
            html.AppendLine("</table>");

            var dataPackage = new DataPackage();
            dataPackage.SetText(tsv.ToString());
            dataPackage.SetHtmlFormat(HtmlFormatHelper.CreateHtmlFormat(html.ToString()));
            Clipboard.SetContent(dataPackage);
        }

        private static string FormatDuration(int totalMs)
        {
            if (totalMs < 1000) return $"{totalMs}ms";
            double seconds = totalMs / 1000.0;
            if (seconds < 60) return $"{seconds:F1}s";
            int minutes = (int)(seconds / 60);
            double remainingSeconds = seconds - (minutes * 60);
            return $"{minutes}m {remainingSeconds:F1}s";
        }

        // Mirrors the labels shown in the action-type pill in ActionTable. For action types
        // without an explicit UI label (KeyDown, LeftClickDown, ScrollUp, etc.) we split the
        // CamelCase name into spaced words for readability in spreadsheets/emails.
        private static string FriendlyActionType(string? type)
        {
            if (string.IsNullOrEmpty(type)) return "";
            return type switch
            {
                "WaitImage" => "Wait Image",
                "BrowserClick" => "Click Element",
                "BrowserRightClick" => "Right Click Element",
                "BrowserType" => "Type Text",
                "BrowserSelectOption" => "Select Option",
                "BrowserWaitElement" => "Wait Element",
                "BrowserAssert" => "Assert Element",
                "BrowserNavigate" => "Open URL",
                "RunProfile" => "Run Profile",
                "CopyToSlot" => "Copy to Slot",
                _ => SplitCamelCase(type)
            };
        }

        private static string SplitCamelCase(string s)
        {
            if (string.IsNullOrEmpty(s)) return s;
            var sb = new StringBuilder(s.Length + 4);
            sb.Append(s[0]);
            for (int i = 1; i < s.Length; i++)
            {
                if (char.IsUpper(s[i]) && char.IsLower(s[i - 1])) sb.Append(' ');
                sb.Append(s[i]);
            }
            return sb.ToString();
        }

        // Browser actions store the full CSS selector in Key. DisplayKey truncates selectors
        // longer than 40 chars with "..." for the grid, but the clipboard should preserve the
        // full text so users can paste it elsewhere intact. Other action types use DisplayKey
        // (which formats Pause as "F4 / 5s", RunProfile as "Name ×3", WaitImage as "5s", etc).
        private static string FriendlyKey(ActionItem a)
        {
            if (a.ActionType?.StartsWith("Browser") == true)
                return a.Key ?? "";
            return a.DisplayKey ?? "";
        }
    }
}
