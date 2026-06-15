import { Search } from 'lucide-react';
import { useAppState } from '../state/AppStateContext';

// Right margin reserved for the Windows native caption-button strip
// (minimize / maximize / close), which is overlaid on the right edge of the
// custom title bar. Without this gap the status badge would sit underneath the
// caption buttons. Matches the previous `mr-[140px]` (140px = margin-right: 140px).
const CAPTION_BUTTONS_WIDTH_PX = 140;

const statusConfig = {
  ready:     { dot: 'bg-replay',    text: 'Ready',     bg: 'bg-replay-bg',    border: 'border-replay/20' },
  recording: { dot: 'bg-recording', text: 'Recording', bg: 'bg-recording-bg', border: 'border-recording/20' },
  replaying: { dot: 'bg-accent',    text: 'Replaying', bg: 'bg-[rgba(96,205,255,0.1)]', border: 'border-accent/20' },
};

interface TitleBarProps {
  onOpenCommandPalette?: () => void;
}

export function TitleBar({ onOpenCommandPalette }: TitleBarProps) {
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

      {/* Command Palette Trigger */}
      {onOpenCommandPalette && (
        <button
          onClick={onOpenCommandPalette}
          className="no-drag flex items-center gap-2 px-3 py-1 bg-bg-surface border border-border-subtle rounded-ui hover:border-border-default hover:bg-bg-elevated transition-colors cursor-pointer min-w-[260px]"
        >
          <Search size={13} className="text-text-disabled" />
          <span className="text-xs text-text-disabled flex-1 text-left">Search profiles, actions, commands...</span>
          <div className="flex gap-0.5">
            <span className="kbd">Ctrl</span>
            <span className="kbd">K</span>
          </div>
        </button>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Status badge — while recording it emits an expanding red ring (see
          .rec-badge-pulse in index.css) so the REC state is unmistakable without
          a full-viewport frame. */}
      <div
        className={`no-drag flex items-center gap-1.5 px-2.5 py-1 rounded-full ${cfg.bg} border ${cfg.border} ${status === 'recording' ? 'rec-badge-pulse' : ''}`}
        style={{ marginRight: CAPTION_BUTTONS_WIDTH_PX }}
      >
        <div className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} style={{ animation: 'pulse-dot 2s ease-in-out infinite' }} />
        <span className="text-[11px] font-medium text-text-primary">{cfg.text}</span>
      </div>
    </div>
  );
}
