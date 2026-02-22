import { useState } from 'react';
import { Copy, Trash2, Palette } from 'lucide-react';
import { useAppState } from '../state/AppStateContext';
import { useBridge } from '../bridge/BridgeContext';
import { ThemeEditor } from './ThemeEditor';

export function Toolbar() {
  const { toolbar } = useAppState();
  const { send } = useBridge();
  const [showThemeEditor, setShowThemeEditor] = useState(false);

  return (
    <>
      <div className="flex items-center justify-between px-4 py-2.5 bg-bg-surface border border-border-subtle rounded-ui">
        {/* Left: profile name + action count */}
        <div className="flex items-center gap-3">
          <span className="text-base font-semibold text-text-primary">{toolbar.profileName}</span>
          <span className="px-2.5 py-0.5 text-xs text-text-tertiary border border-border-subtle rounded-full">
            {toolbar.actionCount} actions
          </span>
        </div>

        {/* Right: copy + clear + theme */}
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
          <button
            onClick={() => setShowThemeEditor(prev => !prev)}
            className={`p-1.5 rounded transition-colors ${
              showThemeEditor
                ? 'bg-bg-elevated text-accent'
                : 'hover:bg-bg-elevated text-text-tertiary hover:text-text-primary'
            }`}
            title="Theme Editor"
          >
            <Palette size={14} />
          </button>
        </div>
      </div>

      {showThemeEditor && <ThemeEditor onClose={() => setShowThemeEditor(false)} />}
    </>
  );
}
