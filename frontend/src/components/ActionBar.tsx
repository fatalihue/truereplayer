import { Circle, Play, Save, FolderOpen } from 'lucide-react';
import { useAppState } from '../state/AppStateContext';
import { useBridge } from '../bridge/BridgeContext';
import { useSelectionRef } from '../state/SelectionContext';

export function ActionBar() {
  const { buttonStates, settings } = useAppState();
  const { send } = useBridge();
  const selectionRef = useSelectionRef();

  const handleReplay = () => {
    send({
      type: 'replay:toggle',
      payload: {
        loopEnabled: settings.enableLoop,
        loopCount: settings.loopCount,
        intervalEnabled: settings.loopIntervalEnabled,
        intervalText: settings.loopInterval,
      },
    });
  };

  return (
    <div className="flex items-center justify-between px-4 py-2.5 bg-bg-surface border border-border-subtle rounded-ui">
      {/* Left: Primary actions (Record + Replay) */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            const sel = selectionRef.current;
            const insertIndex = sel.size > 0 ? Math.min(...sel) : undefined;
            send({ type: 'recording:toggle', payload: { insertIndex } });
          }}
          disabled={!buttonStates.recordEnabled}
          className={`flex items-center gap-2 px-5 py-2 rounded text-[13px] font-semibold text-white transition-colors ${
            buttonStates.recordingActive
              ? 'bg-recording hover:bg-recording/80'
              : 'bg-recording hover:bg-recording/80'
          } disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          <Circle size={8} fill="white" />
          {buttonStates.recordButtonText}
        </button>

        <button
          onClick={handleReplay}
          disabled={!buttonStates.replayEnabled}
          className={`flex items-center gap-2 px-5 py-2 rounded text-[13px] font-semibold text-white transition-colors ${
            buttonStates.replayActive
              ? 'bg-accent-solid hover:bg-accent-solid/80'
              : 'bg-replay hover:bg-replay/80'
          } disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          <Play size={12} fill="white" />
          {buttonStates.replayButtonText}
        </button>
      </div>

      {/* Right: Ghost actions (Save + Load) */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => send({ type: 'profile:save', payload: {} })}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[13px] text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
        >
          <Save size={14} />
          Save
        </button>
        <button
          onClick={() => send({ type: 'profile:load', payload: {} })}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[13px] text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
        >
          <FolderOpen size={14} />
          Load
        </button>
      </div>

    </div>
  );
}
