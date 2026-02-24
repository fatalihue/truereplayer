using System;
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

            var headers = new[] { "Action", "Key", "X", "Y", "Delay", "Notes" };
            var rows = actions.Select(a => new[]
            {
                a.ActionType ?? "",
                a.DisplayKey ?? "",
                a.DisplayX ?? "",
                a.DisplayY ?? "",
                a.Delay.ToString(),
                a.Comment ?? ""
            }).ToList();

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
    }
}
