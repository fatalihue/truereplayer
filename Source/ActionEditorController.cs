using System;
using System.Collections.ObjectModel;
using System.Linq;
using CommunityToolkit.WinUI.UI.Controls;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using TrueReplayer.Models;
using Windows.Foundation;

namespace TrueReplayer.Controllers
{
    public class ActionEditorController
    {
        private readonly ObservableCollection<ActionItem> actions;
        private readonly DataGrid actionsGrid;
        private readonly Action updateUI;

        public ActionEditorController(ObservableCollection<ActionItem> actions, DataGrid actionsGrid, Action updateUI)
        {
            this.actions = actions;
            this.actionsGrid = actionsGrid;
            this.updateUI = updateUI;
        }

        public void HandleKeyDown(object sender, KeyRoutedEventArgs e)
        {
            if (e.Key == Windows.System.VirtualKey.Delete)
            {
                var selectedItems = actionsGrid.SelectedItems.Cast<ActionItem>().ToList();
                foreach (var item in selectedItems)
                {
                    actions.Remove(item);
                }
                e.Handled = true;
                updateUI();
            }
        }

        public void HandlePreparingCellForEdit(object sender, DataGridPreparingCellForEditEventArgs e)
        {
            InputHookManager.IgnoreProfileHotkeys = true; // Suppress profile hotkeys when editing starts
            if (e.Column.Header?.ToString() == "Delay")
            {
                if (e.EditingElement is TextBox textBox)
                {
                    textBox.DispatcherQueue.TryEnqueue(() => textBox.SelectAll());
                }
            }
        }

        public void HandleCellEditEnding(object sender, DataGridCellEditEndingEventArgs e)
        {
            InputHookManager.IgnoreProfileHotkeys = false; // Re-enable profile hotkeys when editing ends
        }

        public void HandleTapped(object sender, TappedRoutedEventArgs e)
        {
            if (sender is not DataGrid grid) return;

            if (e.OriginalSource is DependencyObject source)
            {
                DependencyObject current = source;
                while (current != null && current is not FrameworkElement)
                    current = VisualTreeHelper.GetParent(current);

                if (current is FrameworkElement element && element.DataContext is ActionItem item)
                {
                    Point clickPosition = e.GetPosition(grid);

                    var column = GetClickedColumn(grid, clickPosition);
                    if (column?.Header?.ToString() != "Delay" && column?.Header?.ToString() != "Comment")
                        return;

                    grid.SelectedItem = item;
                    grid.ScrollIntoView(item, null);

                    grid.DispatcherQueue.TryEnqueue(() => grid.BeginEdit());
                }
            }
        }

        private DataGridColumn? GetClickedColumn(DataGrid grid, Point clickPosition)
        {
            double totalWidth = 0;
            foreach (var column in grid.Columns)
            {
                totalWidth += column.ActualWidth;
                if (clickPosition.X < totalWidth)
                    return column;
            }
            return null;
        }
    }
}