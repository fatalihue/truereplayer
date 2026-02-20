using System;
using System.Collections.ObjectModel;
using TrueReplayer.Models;
using TrueReplayer.Services;

namespace TrueReplayer.Controllers
{
    public class MainController
    {
        public static MainController? Instance { get; private set; }

        private readonly ObservableCollection<ActionItem> actions;
        private readonly ActionRecorder recorder;
        private readonly RecordingService recordingService;
        private readonly ReplayService replayService;
        private readonly Func<int> getDelayFunc;
        private readonly Action? onButtonStatesChanged;

        private DateTime lastActionTime;

        public MainController(
            ObservableCollection<ActionItem> actions,
            ActionRecorder recorder,
            RecordingService recordingService,
            ReplayService replayService,
            Func<int> getDelay,
            Action? onButtonStatesChanged = null)
        {
            this.actions = actions;
            this.recorder = recorder;
            this.recordingService = recordingService;
            this.replayService = replayService;
            this.getDelayFunc = getDelay;
            this.onButtonStatesChanged = onButtonStatesChanged;

            Instance = this;
        }

        public void ToggleRecording()
        {
            if (replayService.IsReplaying)
                replayService.ToggleReplay(false, "1", false, "0");

            recordingService.ToggleRecording();
        }

        public void ToggleReplay(bool loopEnabled, string loopCountText, bool intervalEnabled, string intervalText)
        {
            if (recordingService.IsRecording)
                recordingService.ToggleRecording();

            replayService.ToggleReplay(loopEnabled, loopCountText, intervalEnabled, intervalText);
        }

        public void CancelInsertMode()
        {
            recorder.SetInsertIndex(null);
        }

        public void EnableInsertMode(int? index)
        {
            recorder.SetInsertIndex(index);
        }

        public bool IsRecording() => recordingService.IsRecording;

        public bool IsReplayInProgress() => replayService.IsReplaying;

        public void UpdateButtonStates()
        {
            onButtonStatesChanged?.Invoke();
        }

        public void SetLastActionTime(DateTime time)
        {
            lastActionTime = time;
        }

        public int GetDelay() => getDelayFunc();

        public void ScrollToLastAction()
        {
            // Handled by bridge — React auto-scrolls on actions:updated
        }

        private string? hotkeyJustPressed;
        private DateTime hotkeyPressTime;

        private DateTime lastRecordingToggleTime = DateTime.MinValue;
        private DateTime lastReplayToggleTime = DateTime.MinValue;

        public void SetLastHotkeyPressed(string key)
        {
            hotkeyJustPressed = key;
            hotkeyPressTime = DateTime.Now;
        }

        public bool IsHotkeyKeyUpSuppressed(string key)
        {
            return hotkeyJustPressed == key && (DateTime.Now - hotkeyPressTime).TotalMilliseconds < 300;
        }

        public bool ShouldSuppressDuplicateRecordingHotkey()
        {
            var now = DateTime.Now;
            if ((now - lastRecordingToggleTime).TotalMilliseconds < 500)
                return true;

            lastRecordingToggleTime = now;
            return false;
        }

        public bool ShouldSuppressDuplicateReplayHotkey()
        {
            var now = DateTime.Now;
            if ((now - lastReplayToggleTime).TotalMilliseconds < 500)
                return true;

            lastReplayToggleTime = now;
            return false;
        }
    }
}
