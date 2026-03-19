import { useState, useRef, useEffect } from 'react';
import { Copy, Trash2, Palette, Undo2, Redo2, LayoutGrid, Check, Type, ChevronUp, ChevronDown, ScanSearch, Plus, Mouse, Keyboard, ArrowUp, ArrowDown, Globe } from 'lucide-react';
import { useAppState } from '../state/AppStateContext';
import { useBridge } from '../bridge/BridgeContext';
import { useSelectionRef } from '../state/SelectionContext';
import { ThemeEditor } from './ThemeEditor';
import { SendTextDialog } from './SendTextDialog';

export interface ColumnVisibility {
  action: boolean;
  key: boolean;
  x: boolean;
  y: boolean;
  delay: boolean;
  notes: boolean;
}

export const defaultColumnVisibility: ColumnVisibility = {
  action: true,
  key: true,
  x: true,
  y: true,
  delay: true,
  notes: true,
};

interface ToolbarProps {
  columnVisibility: ColumnVisibility;
  onColumnVisibilityChange: (vis: ColumnVisibility) => void;
}

export function Toolbar({ columnVisibility, onColumnVisibilityChange }: ToolbarProps) {
  const { toolbar, buttonStates, actions } = useAppState();
  const { send } = useBridge();
  const selectionRef = useSelectionRef();
  const [showThemeEditor, setShowThemeEditor] = useState(false);
  const [showColDropdown, setShowColDropdown] = useState(false);
  const [showSendTextDialog, setShowSendTextDialog] = useState(false);
  const [showAddActions, setShowAddActions] = useState(false);
  const [showBrowserMenu, setShowBrowserMenu] = useState(false);
  const colDropdownRef = useRef<HTMLDivElement>(null);
  const addActionsRef = useRef<HTMLDivElement>(null);
  const browserMenuRef = useRef<HTMLDivElement>(null);

  // Suppress hotkeys while SendText dialog is open
  useEffect(() => {
    if (showSendTextDialog) {
      send({ type: 'ui:modalOpen', payload: {} });
      return () => { send({ type: 'ui:modalClose', payload: {} }); };
    }
  }, [showSendTextDialog, send]);

  // Listen for command palette trigger
  useEffect(() => {
    const handler = () => setShowSendTextDialog(true);
    window.addEventListener('cmd:sendtext', handler);
    return () => window.removeEventListener('cmd:sendtext', handler);
  }, []);

  // Close dropdowns on outside click
  useEffect(() => {
    if (!showColDropdown && !showAddActions && !showBrowserMenu) return;
    const handler = (e: MouseEvent) => {
      if (showColDropdown && colDropdownRef.current && !colDropdownRef.current.contains(e.target as Node)) {
        setShowColDropdown(false);
      }
      if (showAddActions && addActionsRef.current && !addActionsRef.current.contains(e.target as Node)) {
        setShowAddActions(false);
      }
      if (showBrowserMenu && browserMenuRef.current && !browserMenuRef.current.contains(e.target as Node)) {
        setShowBrowserMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showColDropdown, showAddActions, showBrowserMenu]);

  const toggleColumn = (key: keyof ColumnVisibility) => {
    onColumnVisibilityChange({ ...columnVisibility, [key]: !columnVisibility[key] });
  };

  const columns: { key: keyof ColumnVisibility; label: string }[] = [
    { key: 'action', label: 'Action' },
    { key: 'key', label: 'Key' },
    { key: 'x', label: 'X' },
    { key: 'y', label: 'Y' },
    { key: 'delay', label: 'Delay' },
    { key: 'notes', label: 'Notes' },
  ];

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

        {/* Right: tools — prevent focus on click so Space/Enter can't re-trigger */}
        <div className="flex items-center gap-1" onMouseDown={(e) => e.preventDefault()}>
          {/* Undo / Redo (placeholders) */}
          <button
            tabIndex={-1}
            disabled
            className="p-1.5 rounded text-text-disabled cursor-not-allowed opacity-50"
            title="Undo (coming soon)"
          >
            <Undo2 size={14} />
          </button>
          <button
            tabIndex={-1}
            disabled
            className="p-1.5 rounded text-text-disabled cursor-not-allowed opacity-50"
            title="Redo (coming soon)"
          >
            <Redo2 size={14} />
          </button>

          {/* Divider */}
          <div className="w-px h-4 bg-border-subtle mx-1" />

          {/* Move Up / Move Down */}
          <button
            tabIndex={-1}
            onClick={() => {
              const sel = selectionRef.current;
              if (sel.size === 0) return;
              const indices = Array.from(sel).sort((a, b) => a - b);
              const minIdx = indices[0];
              if (minIdx <= 0) return;
              send({ type: 'actions:reorder', payload: { indices, targetIndex: minIdx - 1 } });
              // Tell ActionTable to update selection to new positions
              window.dispatchEvent(new CustomEvent('selection:set', { detail: indices.map(i => i - 1) }));
            }}
            disabled={buttonStates.recordingActive || buttonStates.replayActive}
            className="p-1.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Move Up"
          >
            <ChevronUp size={14} />
          </button>
          <button
            tabIndex={-1}
            onClick={() => {
              const sel = selectionRef.current;
              if (sel.size === 0) return;
              const indices = Array.from(sel).sort((a, b) => a - b);
              const maxIdx = indices[indices.length - 1];
              if (maxIdx >= toolbar.actionCount - 1) return;
              send({ type: 'actions:reorder', payload: { indices, targetIndex: maxIdx + 2 } });
              // Tell ActionTable to update selection to new positions
              window.dispatchEvent(new CustomEvent('selection:set', { detail: indices.map(i => i + 1) }));
            }}
            disabled={buttonStates.recordingActive || buttonStates.replayActive}
            className="p-1.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Move Down"
          >
            <ChevronDown size={14} />
          </button>

          {/* Divider */}
          <div className="w-px h-4 bg-border-subtle mx-1" />

          {/* Add Actions */}
          <div className="relative" ref={addActionsRef}>
            <button
              tabIndex={-1}
              onClick={() => setShowAddActions(prev => !prev)}
              disabled={buttonStates.recordingActive || buttonStates.replayActive}
              className={`p-1.5 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                showAddActions
                  ? 'bg-bg-elevated text-accent'
                  : 'hover:bg-bg-elevated text-text-tertiary hover:text-text-primary'
              }`}
              title="Add Actions"
            >
              <Plus size={14} />
            </button>

            {showAddActions && (
              <div
                className="absolute right-0 top-[calc(100%+4px)] min-w-[160px] p-1 bg-bg-card border border-border-default rounded-lg z-50"
                style={{ animation: 'fade-in 0.12s ease-out', boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}
              >
                <div className="px-2.5 py-1.5 text-[11px] font-semibold text-text-tertiary">
                  Add action
                </div>
                {([
                  { type: 'LeftClick', label: 'Left Click', icon: Mouse },
                  { type: 'RightClick', label: 'Right Click', icon: Mouse },
                  { type: 'MiddleClick', label: 'Middle Click', icon: Mouse },
                  { type: 'KeyPress', label: 'Key Press', icon: Keyboard },
                  { type: 'ScrollUp', label: 'Scroll Up', icon: ArrowUp },
                  { type: 'ScrollDown', label: 'Scroll Down', icon: ArrowDown },
                  { type: 'SendText', label: 'Send Text', icon: Type },
                  { type: 'WaitImage', label: 'Wait for Image', icon: ScanSearch },
                ] as const).map(item => (
                  <button
                    key={item.type}
                    onClick={() => {
                      const sel = selectionRef.current;
                      const insertIndex = sel.size > 0 ? Math.max(...sel) + 1 : actions.length;
                      if (item.type === 'SendText') {
                        setShowAddActions(false);
                        setShowSendTextDialog(true);
                      } else {
                        send({ type: 'actions:insertAction', payload: { actionType: item.type, insertIndex } });
                        setShowAddActions(false);
                      }
                    }}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-xs text-text-secondary hover:bg-bg-elevated hover:text-text-primary transition-colors"
                  >
                    <item.icon size={12} className="shrink-0" />
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Send Text */}
          <button
            tabIndex={-1}
            onClick={() => setShowSendTextDialog(true)}
            disabled={buttonStates.recordingActive || buttonStates.replayActive}
            className="p-1.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Send Text"
          >
            <Type size={14} />
          </button>

          {/* Wait for Image */}
          <button
            tabIndex={-1}
            onClick={() => {
              const sel = selectionRef.current;
              const insertIndex = sel.size > 0 ? Math.max(...sel) + 1 : actions.length;
              send({ type: 'actions:insertAction', payload: { actionType: 'WaitImage', insertIndex } });
            }}
            disabled={buttonStates.recordingActive || buttonStates.replayActive}
            className="p-1.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Wait for Image"
          >
            <ScanSearch size={14} />
          </button>

          {/* Browser Actions */}
          <div className="relative" ref={browserMenuRef}>
            <button
              tabIndex={-1}
              onClick={() => setShowBrowserMenu(!showBrowserMenu)}
              disabled={buttonStates.recordingActive || buttonStates.replayActive}
              className="p-1.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title="Browser Actions"
            >
              <Globe size={14} />
            </button>
            {showBrowserMenu && (
              <div className="absolute top-full left-0 mt-1 w-44 bg-bg-surface border border-border-default rounded-lg shadow-xl z-50 py-1">
                {([
                  { type: 'BrowserClick', label: 'Browser Click' },
                  { type: 'BrowserType', label: 'Browser Type' },
                  { type: 'BrowserWaitElement', label: 'Browser Wait' },
                  { type: 'BrowserNavigate', label: 'Navigate' },
                ] as const).map((item) => (
                  <button
                    key={item.type}
                    className="w-full text-left px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-elevated hover:text-text-primary transition-colors flex items-center gap-2"
                    onClick={() => {
                      const sel = selectionRef.current;
                      const insertIndex = sel.size > 0 ? Math.max(...sel) + 1 : actions.length;
                      send({ type: 'actions:addBrowserAction', payload: { actionType: item.type, selector: '', insertIndex } });
                      setShowBrowserMenu(false);
                    }}
                  >
                    <Globe size={12} className="text-[#60cdff]" />
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="w-px h-4 bg-border-subtle mx-1" />

          {/* Copy / Clear */}
          <button
            tabIndex={-1}
            onClick={() => send({ type: 'actions:copy', payload: {} })}
            className="p-1.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors"
            title="Copy Actions"
          >
            <Copy size={14} />
          </button>
          <button
            tabIndex={-1}
            onClick={() => send({ type: 'actions:clear', payload: {} })}
            className="p-1.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors"
            title="Clear All"
          >
            <Trash2 size={14} />
          </button>

          {/* Divider */}
          <div className="w-px h-4 bg-border-subtle mx-1" />

          {/* Toggle Columns */}
          <div className="relative" ref={colDropdownRef}>
            <button
              tabIndex={-1}
              onClick={() => setShowColDropdown(prev => !prev)}
              className={`p-1.5 rounded transition-colors ${
                showColDropdown
                  ? 'bg-bg-elevated text-accent'
                  : 'hover:bg-bg-elevated text-text-tertiary hover:text-text-primary'
              }`}
              title="Toggle Columns"
            >
              <LayoutGrid size={14} />
            </button>

            {showColDropdown && (
              <div
                className="absolute right-0 top-[calc(100%+4px)] min-w-[150px] p-1 bg-bg-card border border-border-default rounded-lg z-50"
                style={{ animation: 'fade-in 0.12s ease-out', boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}
              >
                <div className="px-2.5 py-1.5 text-[11px] font-semibold text-text-tertiary">
                  Toggle columns
                </div>
                {columns.map(col => (
                  <button
                    key={col.key}
                    onClick={() => toggleColumn(col.key)}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-xs text-text-secondary hover:bg-bg-elevated hover:text-text-primary transition-colors"
                  >
                    <div className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center shrink-0 ${
                      columnVisibility[col.key]
                        ? 'bg-accent-solid border-accent-solid'
                        : 'border-border-default'
                    }`}>
                      {columnVisibility[col.key] && <Check size={10} className="text-white" />}
                    </div>
                    {col.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Theme Editor */}
          <button
            tabIndex={-1}
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

      {showSendTextDialog && (
        <SendTextDialog
          mode="add"
          onConfirm={(text) => {
            const sel = selectionRef.current;
            const insertIndex = sel.size > 0 ? Math.max(...sel) + 1 : undefined;
            send({ type: 'actions:addSendText', payload: { text, insertIndex } });
            setShowSendTextDialog(false);
          }}
          onClose={() => setShowSendTextDialog(false)}
        />
      )}
    </>
  );
}
