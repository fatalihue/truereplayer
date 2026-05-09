import { MousePointerClick } from 'lucide-react';
import { useAppState } from '../state/AppStateContext';

export function ClickerEmptyState() {
  const { settings } = useAppState();

  return (
    <div
      className="flex-1 flex flex-col items-center justify-center gap-2 rounded-ui border min-h-0"
      style={{
        background: 'linear-gradient(135deg, rgba(192,132,252,0.05), rgba(192,132,252,0.01))',
        borderColor: 'var(--color-clicker-border)',
      }}
    >
      <MousePointerClick size={32} style={{ color: 'var(--color-clicker)', opacity: 0.7 }} />
      <div className="text-[14px] font-semibold" style={{ color: 'var(--color-clicker)' }}>
        Clicker mode
      </div>
      <div className="text-[12px] text-text-tertiary text-center max-w-[420px] px-4">
        Recorded actions and profile hotkeys are ignored.
        {' '}Press{' '}
        <kbd className="kbd kbd-accent">{settings.replayHotkey}</kbd>
        {' '}to start clicking at cursor.
      </div>
    </div>
  );
}
