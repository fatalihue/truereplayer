import { useState, useRef, useEffect, useCallback } from 'react';
import { Smile, Clock, BookmarkPlus, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
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

export function SendTextDialog({ mode, initialText = '', onConfirm, onClose }: SendTextDialogProps) {
  const [text, setText] = useState(initialText);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showVarsDropdown, setShowVarsDropdown] = useState(false);
  const [showSnippets, setShowSnippets] = useState(false);
  const [snippets, setSnippets] = useState<Snippet[]>(loadSnippets);
  const [snippetName, setSnippetName] = useState('');
  const [savingSnippet, setSavingSnippet] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const cursorPosRef = useRef<number>(initialText.length);
  const varsDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Close vars dropdown on outside click
  useEffect(() => {
    if (!showVarsDropdown) return;
    const handler = (e: MouseEvent) => {
      if (varsDropdownRef.current && !varsDropdownRef.current.contains(e.target as Node)) {
        setShowVarsDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showVarsDropdown]);

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
    const pos = cursorPosRef.current;
    const before = text.slice(0, pos);
    const after = text.slice(pos);
    const newText = before + insertText + after;
    setText(newText);

    const newPos = pos + insertText.length;
    cursorPosRef.current = newPos;

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.selectionStart = newPos;
        textareaRef.current.selectionEnd = newPos;
      }
    });
  }, [text]);

  const handleEmojiClick = useCallback((emojiData: EmojiClickData) => {
    insertAtCursor(emojiData.emoji);
    setShowEmojiPicker(false);
  }, [insertAtCursor]);

  const handleVarInsert = useCallback((variable: string) => {
    insertAtCursor(variable);
    setShowVarsDropdown(false);
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

  // Insert snippet at cursor position (instead of replacing all text)
  const handleInsertSnippet = useCallback((snippetText: string) => {
    insertAtCursor(snippetText);
  }, [insertAtCursor]);

  const handleConfirm = () => {
    const trimmed = text.trim();
    if (trimmed) {
      onConfirm(trimmed);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (showEmojiPicker) {
        setShowEmojiPicker(false);
      } else if (showVarsDropdown) {
        setShowVarsDropdown(false);
      } else if (savingSnippet) {
        setSavingSnippet(false);
      } else {
        onClose();
      }
    }
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      handleConfirm();
    }
  };

  const toolbarBtnClass = (active: boolean) =>
    `flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium rounded border transition-colors ${
      active
        ? 'text-accent-solid bg-accent-solid/10 border-accent-solid/30'
        : 'text-text-secondary bg-bg-card hover:bg-bg-surface border-border-subtle hover:text-text-primary'
    }`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div
        className="bg-bg-elevated border border-border-subtle rounded-lg shadow-xl w-[700px] h-[90vh] max-h-[700px] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-border-subtle shrink-0">
          <h3 className="text-sm font-semibold text-text-primary">
            {mode === 'add' ? 'Insert Send Text' : 'Edit Send Text'}
          </h3>
        </div>

        {/* Scrollable body */}
        <div className="px-4 py-3 overflow-y-auto flex-1 min-h-0">
          {/* Textarea with syntax highlighting overlay */}
          <div className="relative w-full rounded border border-border-subtle focus-within:border-accent-solid bg-bg-input">
            {/* Highlight layer (behind textarea) */}
            <div
              ref={highlightRef}
              className="absolute inset-0 px-3 py-2 text-sm leading-[1.5] whitespace-pre-wrap break-words overflow-hidden pointer-events-none select-none"
              aria-hidden="true"
            >
              {renderHighlightedText(text)}
            </div>
            {/* Textarea (on top, transparent text, visible caret) */}
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => { setText(e.target.value); saveCursorPos(); }}
              onSelect={saveCursorPos}
              onClick={saveCursorPos}
              onKeyUp={saveCursorPos}
              onScroll={syncScroll}
              placeholder="Type the text to send..."
              rows={8}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              className="relative w-full px-3 py-2 text-sm leading-[1.5] bg-transparent text-transparent selection:text-transparent selection:bg-accent-solid/30 resize-y outline-none placeholder:text-text-disabled"
              style={{ caretColor: 'var(--color-text-primary, #e0e0e0)' }}
            />
          </div>

          {/* Character count */}
          <div className="flex justify-end mt-1">
            <span className="text-[10px] text-text-disabled">{text.length} chars</span>
          </div>

          {/* Toolbar */}
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            {/* Emoji */}
            <button
              type="button"
              onClick={() => { setShowEmojiPicker(!showEmojiPicker); setShowVarsDropdown(false); }}
              className={toolbarBtnClass(showEmojiPicker)}
              title="Insert emoji"
            >
              <Smile size={14} />
              Emoji
            </button>

            {/* Variables dropdown */}
            <div className="relative" ref={varsDropdownRef}>
              <button
                type="button"
                onClick={() => { setShowVarsDropdown(!showVarsDropdown); setShowEmojiPicker(false); }}
                className={toolbarBtnClass(showVarsDropdown)}
                title="Insert variable"
              >
                <Clock size={14} />
                Variables
              </button>

              {showVarsDropdown && (
                <div className="absolute left-0 top-full mt-1 z-10 w-[320px] bg-bg-elevated border border-border-subtle rounded-lg shadow-xl overflow-hidden">
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
            </div>

            {/* Snippets toggle */}
            <button
              type="button"
              onClick={() => setShowSnippets(!showSnippets)}
              className={toolbarBtnClass(showSnippets)}
              title="Saved text snippets"
            >
              <BookmarkPlus size={14} />
              Snippets
              {showSnippets ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
          </div>

          {/* Emoji Picker */}
          {showEmojiPicker && (
            <div className="mt-2 rounded-lg overflow-hidden border border-border-subtle">
              <EmojiPicker
                onEmojiClick={handleEmojiClick}
                theme={Theme.DARK}
                width="100%"
                height={300}
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

          {/* Snippets Panel */}
          {showSnippets && (
            <div className="mt-2 border border-border-subtle rounded-lg overflow-hidden">
              {/* Save current as snippet */}
              <div className="px-3 py-2 bg-bg-card border-b border-border-subtle">
                {savingSnippet ? (
                  <div className="flex items-center gap-2">
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
                      className="flex-1 h-7 px-2 text-xs text-text-primary bg-bg-input border border-border-subtle rounded outline-none focus:border-accent-solid placeholder:text-text-disabled"
                    />
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
              <div className="max-h-[150px] overflow-y-auto">
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

          {/* Hints */}
          <div className="mt-2">
            <p className="text-[11px] text-text-tertiary">
              Ctrl+Enter to confirm
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border-subtle shrink-0">
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
  );
}
