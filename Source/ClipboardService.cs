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

            var headers = new[] { "Action", "Key", "X", "Y", "Delay", "Comment" };
            var rows = actions.Select(a => new[]
            {
                a.ActionType ?? "",
                a.DisplayKey ?? "",
                a.X.ToString(),
                a.Y.ToString(),
                a.Delay.ToString(),
                a.Comment ?? ""
            }).ToList();

            rows.Insert(0, headers);
            int[] columnWidths = new int[headers.Length];
            for (int col = 0; col < headers.Length; col++)
            {
                columnWidths[col] = rows.Max(row => row[col].Length);
            }

            var sb = new StringBuilder();
            foreach (var row in rows)
            {
                for (int col = 0; col < row.Length; col++)
                {
                    string padded = row[col].PadRight(columnWidths[col] + 2);
                    sb.Append(padded);
                }
                sb.AppendLine();
            }

            var dataPackage = new DataPackage();
            dataPackage.SetText(sb.ToString());
            Clipboard.SetContent(dataPackage);
        }
    }
}
