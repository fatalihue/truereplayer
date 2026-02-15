using CommunityToolkit.WinUI.UI.Controls;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using TrueReplayer.Controllers;
using TrueReplayer.Helpers;
using TrueReplayer.Interop;
using TrueReplayer.Models;
using TrueReplayer.Services;
using Windows.System;

namespace TrueReplayer.Managers
{
    public class UIInteractionHandler
    {
        private readonly ObservableCollection<ActionItem> actions;
        private readonly MainController mainController;
        private readonly DataGrid actionsDataGrid;

        public UIInteractionHandler(ObservableCollection<ActionItem> actions, MainController mainController, DataGrid actionsDataGrid)
        {
            this.actions = actions;
            this.mainController = mainController;
            this.actionsDataGrid = actionsDataGrid;
        }

        public void HandleKeyEditTextBoxPreviewKeyDown(object sender, KeyRoutedEventArgs e)
        {
            if (sender is not TextBox textBox) return;
            if (actionsDataGrid.SelectedItem is not ActionItem item) return;

            e.Handled = true;

            bool ctrl = (NativeMethods.GetAsyncKeyState(0x11) & 0x8000) != 0; // VK_CONTROL
            bool alt = (NativeMethods.GetAsyncKeyState(0x12) & 0x8000) != 0;  // VK_MENU (Alt)
            bool shift = (NativeMethods.GetAsyncKeyState(0x10) & 0x8000) != 0; // VK_SHIFT

            string? mainKey = KeyUtils.NormalizeKeyName((int)e.Key) ?? e.Key.ToString();

            var parts = new List<string>();
            if (ctrl) parts.Add("Ctrl");
            if (alt) parts.Add("Alt");
            if (shift) parts.Add("Shift");
            if (!string.IsNullOrEmpty(mainKey) && !parts.Contains(mainKey))
                parts.Add(mainKey);

            string newKey = string.Join("+", parts);

            item.Key = newKey;
            var selectedIndex = actionsDataGrid.SelectedIndex;
            actionsDataGrid.SelectedItem = null;
            actionsDataGrid.SelectedIndex = selectedIndex;
        }

        public void HandleRecordingButtonClick()
        {
            mainController.ToggleRecording();
            actionsDataGrid.Focus(FocusState.Programmatic);
        }

        public void HandleReplayButtonClick(bool loopEnabled, string loopCountText, bool intervalEnabled, string intervalText)
        {
            mainController.ToggleReplay(loopEnabled, loopCountText, intervalEnabled, intervalText);
        }

        public void HandleClearButtonClick()
        {
            actions.Clear();
            mainController.UpdateButtonStates();
        }

        public void HandleCopyButtonClick()
        {
            ClipboardService.CopyActions(actions);
        }

        public void HandleTextBoxSelectAll(object sender)
        {
            if (sender is TextBox textBox)
                textBox.SelectAll();
        }
    }

    public class UISettingsManager
    {
        public static UserProfile CreateFromUI(MainWindow window)
        {
            var profile = new UserProfile
            {
                Actions = window.Actions,
                RecordingHotkey = window.ToggleRecordingTextBox.Text,
                ReplayHotkey = window.ToggleReplayTextBox.Text,
                ProfileKeyToggleHotkey = window.ToggleProfileKeyTextBox.Text,
                RecordMouse = window.RecordMouseSwitch.IsOn,
                RecordScroll = window.RecordScrollSwitch.IsOn,
                RecordKeyboard = window.RecordKeyboardSwitch.IsOn,
                UseCustomDelay = window.UseCustomDelaySwitch.IsOn,
                CustomDelay = int.TryParse(window.CustomDelayTextBox.Text, out var d) ? d : 100,
                EnableLoop = window.EnableLoopSwitch.IsOn,
                LoopCount = int.TryParse(window.LoopCountTextBox.Text, out var c) ? c : 0,
                LoopIntervalEnabled = window.LoopIntervalSwitch.IsOn,
                LoopInterval = int.TryParse(window.LoopIntervalTextBox.Text, out var i) ? i : 1000,
                ProfileKeyEnabled = window.ProfileKeySwitch.IsOn,
                CustomHotkey = UserProfile.Current.CustomHotkey,

                AlwaysOnTop = window.AlwaysOnTopSwitch.IsOn,
                MinimizeToTray = window.MinimizeToTraySwitch.IsOn
            };

            return profile;
        }


        public static void ApplyToUI(MainWindow window, UserProfile profile)
        {
            window.Actions.Clear();
            foreach (var action in profile.Actions)
                window.Actions.Add(action);

            window.ToggleRecordingTextBox.Text = profile.RecordingHotkey;
            window.ToggleReplayTextBox.Text = profile.ReplayHotkey;
            window.ToggleProfileKeyTextBox.Text = profile.ProfileKeyToggleHotkey;
            window.RecordMouseSwitch.IsOn = profile.RecordMouse;
            window.RecordScrollSwitch.IsOn = profile.RecordScroll;
            window.RecordKeyboardSwitch.IsOn = profile.RecordKeyboard;
            window.UseCustomDelaySwitch.IsOn = profile.UseCustomDelay;
            window.CustomDelayTextBox.Text = profile.CustomDelay.ToString();
            window.EnableLoopSwitch.IsOn = profile.EnableLoop;
            window.LoopCountTextBox.Text = profile.LoopCount.ToString();
            window.LoopIntervalSwitch.IsOn = profile.LoopIntervalEnabled;
            window.LoopIntervalTextBox.Text = profile.LoopInterval.ToString();
            window.ProfileKeySwitch.IsOn = profile.ProfileKeyEnabled;

            window.AlwaysOnTopSwitch_Toggled(null, null);

            window.UpdateButtonStates();
        }

    }

    public class HotkeyManager
    {
        private readonly TextBox recordingTextBox;
        private readonly TextBox replayTextBox;
        private readonly TextBox profileKeyToggleTextBox;
        private readonly Control focusTarget;

        public string RecordingHotkey => UserProfile.Current.RecordingHotkey;
        public string ReplayHotkey => UserProfile.Current.ReplayHotkey;
        public string ProfileKeyToggleHotkey => UserProfile.Current.ProfileKeyToggleHotkey;

        public event Action<string>? OnHotkeyChanged;

        public HotkeyManager(TextBox recordingTextBox, TextBox replayTextBox, TextBox profileKeyToggleTextBox, Control focusTarget)
        {
            this.recordingTextBox = recordingTextBox;
            this.replayTextBox = replayTextBox;
            this.profileKeyToggleTextBox = profileKeyToggleTextBox;
            this.focusTarget = focusTarget;

            recordingTextBox.Text = RecordingHotkey;
            replayTextBox.Text = ReplayHotkey;
            profileKeyToggleTextBox.Text = ProfileKeyToggleHotkey;
        }

        public void HandlePreviewKeyDown(object sender, KeyRoutedEventArgs e)
        {
            if (sender is not TextBox textBox) return;
            textBox.Focus(FocusState.Keyboard);
            e.Handled = true;

            // Verifica modificadores
            bool ctrl = (NativeMethods.GetAsyncKeyState(0x11) & 0x8000) != 0; // VK_CONTROL
            bool alt = (NativeMethods.GetAsyncKeyState(0x12) & 0x8000) != 0;  // VK_MENU (Alt)
            bool shift = (NativeMethods.GetAsyncKeyState(0x10) & 0x8000) != 0; // VK_SHIFT

            int vkCode = (int)e.Key;

            // Ignora teclas modificadoras sozinhas
            if (vkCode == 0x10 || vkCode == 0x11 || vkCode == 0x12 || // Shift, Ctrl, Alt
                vkCode == 0xA0 || vkCode == 0xA1 || // LeftShift, RightShift
                vkCode == 0xA2 || vkCode == 0xA3 || // LeftCtrl, RightCtrl
                vkCode == 0xA4 || vkCode == 0xA5)   // LeftAlt, RightAlt
            {
                var parts = new List<string>();
                if (ctrl) parts.Add("Ctrl");
                if (alt) parts.Add("Alt");
                if (shift) parts.Add("Shift");
                textBox.Text = string.Join("+", parts);
                return;
            }

            string? mainKey = KeyUtils.NormalizeKeyName(vkCode) ?? e.Key.ToString();
            if (string.IsNullOrEmpty(mainKey)) return;

            var keyParts = new List<string>();
            if (ctrl) keyParts.Add("Ctrl");
            if (alt) keyParts.Add("Alt");
            if (shift) keyParts.Add("Shift");
            if (!keyParts.Contains(mainKey, StringComparer.OrdinalIgnoreCase))
                keyParts.Add(mainKey);

            string newKey = string.Join("+", keyParts);

            // Verifica se a hotkey é válida (não apenas modificadores)
            if (keyParts.Count == 0 || (keyParts.Count == 1 && (keyParts[0] == "Ctrl" || keyParts[0] == "Alt" || keyParts[0] == "Shift")))
            {
                System.Diagnostics.Debug.WriteLine("Hotkey inválida: apenas modificadores não são permitidos.");
                return;
            }

            string newHotkey = string.Join("+", keyParts);

            // Verifica se a hotkey já está em uso
            var profileHotkeys = InputHookManager.ProfileHotkeys.Values;
            var existingHotkeys = new List<string> { RecordingHotkey, ReplayHotkey, ProfileKeyToggleHotkey };
            if (textBox == recordingTextBox)
                existingHotkeys.Remove(RecordingHotkey);
            else if (textBox == replayTextBox)
                existingHotkeys.Remove(ReplayHotkey);
            else if (textBox == profileKeyToggleTextBox)
                existingHotkeys.Remove(ProfileKeyToggleHotkey);

            if (profileHotkeys.Contains(newHotkey, StringComparer.OrdinalIgnoreCase) ||
                existingHotkeys.Contains(newHotkey))
            {
                System.Diagnostics.Debug.WriteLine($"Hotkey '{newHotkey}' já está em uso.");
                return;
            }

            if (textBox == recordingTextBox)
                UserProfile.Current.RecordingHotkey = newHotkey;
            else if (textBox == replayTextBox)
                UserProfile.Current.ReplayHotkey = newHotkey;
            else if (textBox == profileKeyToggleTextBox)
                UserProfile.Current.ProfileKeyToggleHotkey = newHotkey;
            else return;

            textBox.Text = newHotkey;
            textBox.SelectionStart = newHotkey.Length;

            OnHotkeyChanged?.Invoke(newHotkey);
            focusTarget.Focus(FocusState.Programmatic);
        }
    }

    public class DelayManager
    {
        private readonly TextBox delayTextBox;
        private readonly ObservableCollection<ActionItem> actions;
        private readonly DataGrid dataGrid;

        public DelayManager(TextBox delayTextBox, ObservableCollection<ActionItem> actions, DataGrid dataGrid)
        {
            this.delayTextBox = delayTextBox;
            this.actions = actions;
            this.dataGrid = dataGrid;
        }

        public void HandleKeyDown(object sender, KeyRoutedEventArgs e)
        {
            bool isDigit = (e.Key >= Windows.System.VirtualKey.Number0 && e.Key <= Windows.System.VirtualKey.Number9) ||
                           (e.Key >= Windows.System.VirtualKey.NumberPad0 && e.Key <= Windows.System.VirtualKey.NumberPad9);

            bool isControlKey = e.Key == Windows.System.VirtualKey.Back ||
                                e.Key == Windows.System.VirtualKey.Delete ||
                                e.Key == Windows.System.VirtualKey.Left ||
                                e.Key == Windows.System.VirtualKey.Right ||
                                e.Key == Windows.System.VirtualKey.Enter;

            if (!isDigit && !isControlKey)
            {
                e.Handled = true;
                return;
            }

            if (e.Key == Windows.System.VirtualKey.Enter)
            {
                if (!int.TryParse(delayTextBox.Text, out int newDelay) || newDelay < 0)
                {
                    delayTextBox.Text = "100";
                    delayTextBox.SelectionStart = delayTextBox.Text.Length;
                }
                else
                {
                    var selectedItems = dataGrid.SelectedItems.Cast<ActionItem>().ToList();
                    if (selectedItems.Any())
                    {
                        foreach (var item in selectedItems)
                            item.Delay = newDelay;

                        dataGrid.ItemsSource = null;
                        dataGrid.ItemsSource = actions;
                    }
                }

                dataGrid.Focus(FocusState.Programmatic);
            }
        }

        public void HandleTextChanging(object sender, TextBoxTextChangingEventArgs args)
        {
            if (sender is not TextBox textBox) return;
            string newText = textBox.Text;

            if (string.IsNullOrWhiteSpace(newText) || !newText.All(char.IsDigit) ||
                !int.TryParse(newText, out int delay) || delay < 0)
            {
                textBox.Text = "100";
                textBox.SelectionStart = textBox.Text.Length;
            }
        }
    }

    public class LoopControlManager
    {
        private readonly TextBox loopCountTextBox;
        private readonly ToggleSwitch enableLoopSwitch;
        private readonly TextBox loopIntervalTextBox;
        private readonly ToggleSwitch loopIntervalSwitch;
        private readonly Control focusTarget;

        public LoopControlManager(TextBox loopCountTextBox, ToggleSwitch enableLoopSwitch, TextBox loopIntervalTextBox, ToggleSwitch loopIntervalSwitch, Control focusTarget)
        {
            this.loopCountTextBox = loopCountTextBox;
            this.enableLoopSwitch = enableLoopSwitch;
            this.loopIntervalTextBox = loopIntervalTextBox;
            this.loopIntervalSwitch = loopIntervalSwitch;
            this.focusTarget = focusTarget;
        }

        public void HandleLoopCountKeyDown(object sender, KeyRoutedEventArgs e)
        {
            if (e.Key == Windows.System.VirtualKey.Enter)
            {
                if (int.TryParse(loopCountTextBox.Text, out int loopCount) && loopCount >= 0)
                    enableLoopSwitch.IsOn = true;
                else
                {
                    loopCountTextBox.Text = "0";
                    enableLoopSwitch.IsOn = false;
                }

                focusTarget.Focus(FocusState.Programmatic);
            }
        }

        public void HandleLoopCountTextChanging(object sender, TextBoxTextChangingEventArgs args)
        {
            if (sender is not TextBox textBox) return;
            string newText = textBox.Text;
            if (string.IsNullOrEmpty(newText) || !newText.All(char.IsDigit))
            {
                string validText = new string(newText.Where(char.IsDigit).ToArray());
                textBox.Text = string.IsNullOrEmpty(validText) ? "0" : validText;
                textBox.SelectionStart = textBox.Text.Length;
            }
        }

        public void HandleLoopIntervalKeyDown(object sender, KeyRoutedEventArgs e)
        {
            if (e.Key == Windows.System.VirtualKey.Enter)
            {
                if (int.TryParse(loopIntervalTextBox.Text, out int loopInterval) && loopInterval >= 0)
                    loopIntervalSwitch.IsOn = true;
                else
                {
                    loopIntervalTextBox.Text = "1000";
                    loopIntervalSwitch.IsOn = false;
                }

                focusTarget.Focus(FocusState.Programmatic);
            }
        }

        public void HandleLoopIntervalTextChanging(object sender, TextBoxTextChangingEventArgs args)
        {
            if (sender is not TextBox textBox) return;
            string newText = textBox.Text;
            if (string.IsNullOrEmpty(newText) || !newText.All(char.IsDigit))
            {
                string validText = new string(newText.Where(char.IsDigit).ToArray());
                textBox.Text = string.IsNullOrEmpty(validText) ? "1000" : validText;
                textBox.SelectionStart = textBox.Text.Length;
            }
        }
    }
}