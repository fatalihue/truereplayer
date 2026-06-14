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

            // If in capture mode, cancel it (discard partial actions)
            if (recordingService.IsRecording && recorder.IsCaptureMode)
            {
                CancelCaptureMode();
                return;
            }

            recordingService.ToggleRecording();
        }

        public void ToggleReplay(bool loopEnabled, string loopCountText, bool intervalEnabled, string intervalText, bool useDelayVariation = false, int delayVariationPercent = 20, bool useRelativeCoords = false, Models.WindowTarget? windowTarget = null, bool bringToFocus = false, int lockWidth = 0, int lockHeight = 0, int lockX = 0, int lockY = 0, bool restorePosition = false, bool restoreSize = false, bool forceInfiniteLoop = false)
        {
            if (recordingService.IsRecording)
                recordingService.ToggleRecording();

            replayService.ToggleReplay(loopEnabled, loopCountText, intervalEnabled, intervalText, useDelayVariation, delayVariationPercent, useRelativeCoords, windowTarget, bringToFocus, lockWidth, lockHeight, lockX, lockY, restorePosition, restoreSize, forceInfiniteLoop);
        }

        public void ToggleCursorClickReplay(ClickerRunConfig config)
        {
            if (recordingService.IsRecording)
                recordingService.ToggleRecording();

            replayService.ToggleCursorClickReplay(config);
        }

        // Clicker pause hotkey — toggles pause/resume on a running click loop.
        public void TogglePauseClicker() => replayService.TogglePauseClicker();

        public void CancelInsertMode()
        {
            recorder.SetInsertIndex(null);
        }

        public void EnableInsertMode(int? index)
        {
            recorder.SetInsertIndex(index);
        }

        public bool IsCaptureMode() => recorder.IsCaptureMode;
        public bool IsInsertMode() => recorder.IsInsertMode;

        public void StartCaptureMode(int insertIndex, CaptureType captureType, string? mouseButton, Action? onComplete)
        {
            if (replayService.IsReplaying)
                replayService.ToggleReplay(false, "1", false, "0");
            if (recordingService.IsRecording)
                recordingService.StopRecording();

            // Swallow mouse clicks during capture so they don't reach the target app
            if (captureType == CaptureType.Mouse)
                InputHookManager.SuppressMouseClick = true;

            recorder.SetInsertIndex(insertIndex);
            recorder.StartCapture(captureType, () =>
            {
                InputHookManager.SuppressMouseClick = false;
                recordingService.StopRecording();
                onComplete?.Invoke();
            }, mouseButton);
            recordingService.StartCaptureRecording(captureType);
        }

        public void CancelCaptureMode()
        {
            if (!recorder.IsCaptureMode) return;
            InputHookManager.SuppressMouseClick = false;
            recorder.DiscardCapturedActions();
            recordingService.StopRecording();
        }

        public bool IsRecording() => recordingService.IsRecording;

        public bool IsReplayInProgress() => replayService.IsReplaying;

        public void StopReplayIfRunning() => replayService.StopIfRunning();

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
