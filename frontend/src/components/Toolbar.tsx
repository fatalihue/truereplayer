import { Copy, Trash2 } from 'lucide-react';
import { useAppState } from '../state/AppStateContext';
import { useBridge } from '../bridge/BridgeContext';

export function Toolbar() {
  const { toolbar } = useAppState();
  const { send } = useBridge();

  return (
    <div className="flex items-center justify-between px-4 py-2.5 bg-bg-surface border border-border-subtle rounded-md">
      {/* Left: profile name + action count */}
      <div className="flex items-center gap-3">
        <span className="text-base font-semibold text-text-primary">{toolbar.profileName}</span>
        <span className="px-2.5 py-0.5 text-xs text-text-tertiary border border-border-subtle rounded-full">
          {toolbar.actionCount} actions
        </span>
      </div>

      {/* Right: copy + clear */}
      <div className="flex items-center gap-1">
        <button
          onClick={() => send({ type: 'actions:copy', payload: {} })}
          className="p-1.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors"
          title="Copy Actions"
        >
          <Copy size={14} />
        </button>
        <button
          onClick={() => send({ type: 'actions:clear', payload: {} })}
          className="p-1.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors"
          title="Clear All"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}
