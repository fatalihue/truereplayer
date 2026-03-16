import { useState, useRef, useEffect, useCallback } from 'react';
import { Smile, Clock, BookmarkPlus, Trash2, ChevronRight, ChevronLeft } from 'lucide-react';
import EmojiPicker, { Theme } from 'emoji-picker-react';
import type { EmojiClickData } from 'emoji-picker-react';

interface SendTextDialogProps {
  mode: 'add' | 'edit';
  initialText?: string;
  onConfirm: (text: string) => void;
  onClose: () => void;
}

interface Snippet {
  id: string;
  name: string;
  text: string;
}

const SNIPPETS_KEY = 'trueplayer_snippets';

function loadSnippets(): Snippet[] {
  try {
    const raw = localStorage.getItem(SNIPPETS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveSnippets(snippets: Snippet[]) {
  localStorage.setItem(SNIPPETS_KEY, JSON.stringify(snippets));
}

// ── Variable definitions (organized by group, all chip/grid style) ──

interface VarChipItem { var: string; label: string }
interface VarGroup { label: string; items: VarChipItem[] }

const VARIABLE_GROUPS: VarGroup[] = [
  {
    label: 'Utility',
    items: [
      { var: '{clipboard}', label: 'Clipboard' },
      { var: '{date}', label: 'Date' },
      { var: '{time}', label: 'Time' },
      { var: '{datetime}', label: 'DateTime' },
      { var: '{delay:500}', label: 'Delay' },
    ],
  },
  {
    label: 'Action Keys',
    items: [
      { var: '{enter}', label: 'Enter' },
      { var: '{tab}', label: 'Tab' },
      { var: '{space}', label: 'Space' },
      { var: '{backspace}', label: 'Bksp' },
      { var: '{delete}', label: 'Del' },
      { var: '{escape}', label: 'Esc' },
    ],
  },
  {
    label: 'Navigation',
    items: [
      { var: '{up}', label: '↑' },
      { var: '{down}', label: '↓' },
      { var: '{left}', label: '←' },
      { var: '{right}', label: '→' },
      { var: '{home}', label: 'Home' },
      { var: '{end}', label: 'End' },
      { var: '{pageup}', label: 'PgUp' },
      { var: '{pagedown}', label: 'PgDn' },
    ],
  },
];

// All known variable names for syntax highlighting
const KNOWN_VARIABLES = new Set([
  'clipboard', 'date', 'time', 'datetime',
  'enter', 'tab', 'space', 'backspace', 'delete', 'escape',
  'home', 'end', 'pageup', 'pagedown',
  'up', 'down', 'left', 'right',
  'delay',
]);

// Render text with highlighted variables
function renderHighlightedText(text: string): React.ReactNode[] {
  if (!text) return [<span key="empty">{'\n'}</span>];

  const regex = /\{([a-zA-Z]+(?::\d+)?)\}/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(
        <span key={`t${lastIndex}`} className="text-text-primary">
          {text.slice(lastIndex, match.index)}
        </span>
      );
    }
    const inner = match[1];
    const varName = inner.split(':')[0].toLowerCase();
    const isValid = KNOWN_VARIABLES.has(varName);

    parts.push(
      <span
        key={`v${match.index}`}
        className={
          isValid
            ? 'text-accent-light bg-accent-solid/15 rounded-sm'
            : 'text-text-primary'
        }
      >
        {match[0]}
      </span>
    );
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(
      <span key={`t${lastIndex}`} className="text-text-primary">
        {text.slice(lastIndex)}
      </span>
    );
  }

  // Trailing newline to match textarea line rendering
  parts.push(<span key="trail">{'\n'}</span>);
  return parts;
}

type PanelType = 'emoji' | 'variables' | 'snippets';

export function SendTextDialog({ mode, initialText = '', onConfirm, onClose }: SendTextDialogProps) {
  const [text, setText] = useState(initialText);
  const [activePanel, setActivePanel] = useState<PanelType | null>('emoji');
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [snippets, setSnippets] = useState<Snippet[]>(loadSnippets);
  const [snippetName, setSnippetName] = useState('');
  const [savingSnippet, setSavingSnippet] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const cursorPosRef = useRef<number>(initialText.length);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Sync highlight scroll with textarea
  const syncScroll = useCallback(() => {
    if (highlightRef.current && textareaRef.current) {
      highlightRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }, []);

  const saveCursorPos = useCallback(() => {
    if (textareaRef.current) {
      cursorPosRef.current = textareaRef.current.selectionStart;
    }
  }, []);

  const insertAtCursor = useCallback((insertText: string) => {
    const ta = textareaRef.current;
    if (!ta) return;

    ta.focus();
    ta.selectionStart = cursorPosRef.current;
    ta.selectionEnd = cursorPosRef.current;

    // execCommand integrates with the browser's native undo/redo stack
    document.execCommand('insertText', false, insertText);

    cursorPosRef.current = ta.selectionStart;
  }, []);

  const handleEmojiClick = useCallback((emojiData: EmojiClickData) => {
    insertAtCursor(emojiData.emoji);
  }, [insertAtCursor]);

  const handleVarInsert = useCallback((variable: string) => {
    insertAtCursor(variable);
  }, [insertAtCursor]);

  const handleSaveSnippet = useCallback(() => {
    const trimmedName = snippetName.trim();
    const trimmedText = text.trim();
    if (!trimmedName || !trimmedText) return;

    const newSnippet: Snippet = {
      id: Date.now().toString(),
      name: trimmedName,
      text: trimmedText,
    };
    const updated = [...snippets, newSnippet];
    setSnippets(updated);
    saveSnippets(updated);
    setSnippetName('');
    setSavingSnippet(false);
  }, [snippetName, text, snippets]);

  const handleDeleteSnippet = useCallback((id: string) => {
    const updated = snippets.filter(s => s.id !== id);
    setSnippets(updated);
    saveSnippets(updated);
  }, [snippets]);

  const handleInsertSnippet = useCallback((snippetText: string) => {
    insertAtCursor(snippetText);
  }, [insertAtCursor]);

  const handleConfirm = () => {
    const trimmed = text.trim();
    if (trimmed) onConfirm(trimmed);
  };

  const selectPanel = (panel: PanelType) => {
    setActivePanel(panel);
    setPanelCollapsed(false);
  };

  const toggleCollapse = () => {
    setPanelCollapsed(prev => !prev);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (savingSnippet) {
        setSavingSnippet(false);
      } else if (!panelCollapsed) {
        setPanelCollapsed(true);
      } else {
        onClose();
      }
    }
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      handleConfirm();
    }
  };

  const tabBtnClass = (active: boolean) =>
    `flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium rounded transition-colors ${
      active
        ? 'text-accent-solid bg-accent-solid/10'
        : 'text-text-tertiary hover:text-text-primary hover:bg-bg-card'
    }`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div
        className="bg-bg-elevated border border-border-subtle rounded-lg shadow-xl w-[950px] max-w-[95vw] h-[90vh] max-h-[750px] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header with tool tabs */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle shrink-0">
          <h3 className="text-sm font-semibold text-text-primary">
            {mode === 'add' ? 'Insert Send Text' : 'Edit Send Text'}
          </h3>
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => selectPanel('emoji')} className={tabBtnClass(activePanel === 'emoji')} title="Emoji">
              <Smile size={14} /> Emoji
            </button>
            <button type="button" onClick={() => selectPanel('variables')} className={tabBtnClass(activePanel === 'variables')} title="Variables">
              <Clock size={14} /> Variables
            </button>
            <button type="button" onClick={() => selectPanel('snippets')} className={tabBtnClass(activePanel === 'snippets')} title="Snippets">
              <BookmarkPlus size={14} /> Snippets
            </button>
            <button
              type="button"
              onClick={toggleCollapse}
              className="ml-1 p-1.5 text-text-tertiary hover:text-text-primary hover:bg-bg-card rounded transition-colors"
              title={panelCollapsed ? 'Show panel' : 'Hide panel'}
            >
              {panelCollapsed ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
            </button>
          </div>
        </div>

        {/* Body: textarea + optional side panel */}
        <div className="flex flex-1 min-h-0">
          {/* Left: textarea with syntax highlighting */}
          <div className="flex-1 min-w-0 p-4 flex flex-col">
            <div className="relative flex-1 min-h-0 rounded border border-border-subtle focus-within:border-accent-solid bg-bg-input">
              {/* Highlight layer */}
              <div
                ref={highlightRef}
                className="absolute inset-0 px-3 py-2 text-sm leading-[1.5] whitespace-pre-wrap break-words overflow-hidden pointer-events-none select-none"
                aria-hidden="true"
              >
                {renderHighlightedText(text)}
              </div>
              {/* Textarea */}
              <textarea
                ref={textareaRef}
                value={text}
                onChange={(e) => { setText(e.target.value); saveCursorPos(); }}
                onSelect={saveCursorPos}
                onClick={saveCursorPos}
                onKeyUp={saveCursorPos}
                onScroll={syncScroll}
                placeholder="Type the text to send..."
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                className="relative w-full h-full px-3 py-2 text-sm leading-[1.5] bg-transparent text-transparent selection:text-transparent selection:bg-accent-solid/30 resize-none outline-none placeholder:text-text-disabled"
                style={{ caretColor: 'var(--color-text-primary, #e0e0e0)' }}
              />
            </div>
          </div>

          {/* Right: collapsible side panel */}
          {activePanel && !panelCollapsed && (
            <div className="w-[300px] shrink-0 border-l border-border-subtle flex flex-col">
              {/* ── Emoji Panel ── */}
              {activePanel === 'emoji' && (
                <div className="flex-1 min-h-0 overflow-hidden">
                  <EmojiPicker
                    onEmojiClick={handleEmojiClick}
                    theme={Theme.DARK}
                    width="100%"
                    height="100%"
                    searchPlaceholder="Search emoji..."
                    previewConfig={{ showPreview: false }}
                    skinTonesDisabled
                    style={{
                      '--epr-bg-color': '#2a2a2a',
                      '--epr-category-label-bg-color': '#2a2a2a',
                      '--epr-hover-bg-color': '#353535',
                      '--epr-search-input-bg-color': '#0e0e0e',
                      '--epr-search-border-color': 'rgba(255, 255, 255, 0.06)',
                      '--epr-text-color': '#e0e0e0',
                      '--epr-category-icon-active-color': '#42a5f5',
                      '--epr-highlight-color': '#42a5f5',
                    } as React.CSSProperties}
                  />
                </div>
              )}

              {/* ── Variables Panel ── */}
              {activePanel === 'variables' && (
                <div className="flex-1 min-h-0 overflow-y-auto">
                  {VARIABLE_GROUPS.map((group) => (
                    <div key={group.label}>
                      <div className="px-3 py-1.5 text-[10px] font-semibold text-text-tertiary uppercase tracking-wide border-b border-border-subtle">
                        {group.label}
                      </div>
                      <div className="flex flex-wrap gap-1 px-3 py-2">
                        {group.items.map((item) => (
                          <button
                            key={item.var}
                            type="button"
                            onClick={() => handleVarInsert(item.var)}
                            className="px-2 py-0.5 text-[11px] font-mono bg-bg-surface border border-border-subtle rounded text-text-secondary hover:text-accent-light hover:border-accent-solid/30 transition-colors"
                            title={item.var}
                          >
                            {item.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                  {/* Repeat syntax tip */}
                  <div className="px-3 py-2 text-[10px] text-text-tertiary border-t border-border-subtle">
                    Tip: add <code className="text-accent-light">:N</code> to repeat — e.g. <code className="text-accent-light">{'{enter:5}'}</code> presses Enter 5×
                  </div>
                </div>
              )}

              {/* ── Snippets Panel ── */}
              {activePanel === 'snippets' && (
                <div className="flex-1 min-h-0 flex flex-col">
                  {/* Save current as snippet */}
                  <div className="px-3 py-2 bg-bg-card border-b border-border-subtle shrink-0">
                    {savingSnippet ? (
                      <div className="flex flex-col gap-2">
                        <input
                          type="text"
                          value={snippetName}
                          onChange={(e) => setSnippetName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); handleSaveSnippet(); }
                            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setSavingSnippet(false); }
                          }}
                          placeholder="Snippet name..."
                          autoFocus
                          className="h-7 px-2 text-xs text-text-primary bg-bg-input border border-border-subtle rounded outline-none focus:border-accent-solid placeholder:text-text-disabled"
                        />
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={handleSaveSnippet}
                            disabled={!snippetName.trim() || !text.trim()}
                            className="px-3 py-1 text-[11px] font-medium text-white bg-accent-solid hover:bg-accent-solid/80 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setSavingSnippet(false)}
                            className="px-2 py-1 text-[11px] text-text-tertiary hover:text-text-primary transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setSavingSnippet(true)}
                        disabled={!text.trim()}
                        className="text-[11px] font-medium text-accent-light hover:text-accent-solid transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        + Save current text as snippet
                      </button>
                    )}
                  </div>

                  {/* Snippet list */}
                  <div className="flex-1 overflow-y-auto">
                    {snippets.length === 0 ? (
                      <div className="px-3 py-4 text-center text-[11px] text-text-disabled">
                        No saved snippets yet
                      </div>
                    ) : (
                      snippets.map((s) => (
                        <div
                          key={s.id}
                          className="flex items-center gap-2 px-3 py-2 hover:bg-bg-card transition-colors group border-b border-border-subtle last:border-b-0"
                        >
                          <button
                            type="button"
                            onClick={() => handleInsertSnippet(s.text)}
                            className="flex-1 text-left min-w-0"
                            title="Insert at cursor"
                          >
                            <div className="text-xs font-medium text-text-primary truncate">{s.name}</div>
                            <div className="text-[11px] text-text-tertiary truncate mt-0.5">{s.text}</div>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteSnippet(s.id)}
                            className="shrink-0 p-1 text-text-disabled hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
                            title="Delete snippet"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border-subtle shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-text-tertiary">{text.length} chars</span>
            <span className="text-[11px] text-text-tertiary">Ctrl+Enter to confirm</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-1.5 text-xs font-medium text-text-secondary bg-bg-card hover:bg-bg-surface border border-border-subtle rounded transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={!text.trim()}
              className="px-4 py-1.5 text-xs font-medium text-white bg-accent-solid hover:bg-accent-solid/80 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Confirm
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
