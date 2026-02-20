import { useAppState } from '../state/AppStateContext';

const statusConfig = {
  ready:     { dot: 'bg-replay',    text: 'Ready',     bg: 'bg-replay-bg',    border: 'border-replay/20' },
  recording: { dot: 'bg-recording', text: 'Recording', bg: 'bg-recording-bg', border: 'border-recording/20' },
  replaying: { dot: 'bg-accent',    text: 'Replaying', bg: 'bg-[rgba(96,205,255,0.1)]', border: 'border-accent/20' },
};

export function TitleBar() {
  const { status } = useAppState();
  const cfg = statusConfig[status];

  return (
    <div className="drag-region flex items-center h-[48px] px-4 bg-bg-base border-b border-border-subtle shrink-0">
      {/* Logo */}
      <div className="no-drag flex items-center gap-2.5">
        <div className="w-[18px] h-[18px] rounded bg-accent-solid flex items-center justify-center">
          <span className="text-[10px] font-bold text-white">T</span>
        </div>
        <span className="text-xs text-text-secondary">TrueReplayer</span>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Status badge */}
      <div className={`no-drag flex items-center gap-1.5 px-2.5 py-1 rounded-full ${cfg.bg} border ${cfg.border} mr-[140px]`}>
        <div className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
        <span className="text-[11px] font-medium text-text-primary">{cfg.text}</span>
      </div>
    </div>
  );
}
