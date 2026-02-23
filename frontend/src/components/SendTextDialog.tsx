import { useState, useRef, useEffect, useCallback } from 'react';
import { Smile, ClipboardPaste, Clock, BookmarkPlus, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
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

const TIME_VARIABLES = [
  { label: '{date}', desc: 'Current date (23/02/2026)' },
  { label: '{time}', desc: 'Current time (14:30:05)' },
  { label: '{datetime}', desc: 'Date + time (23/02/2026 14:30:05)' },
] as const;

export function SendTextDialog({ mode, initialText = '', onConfirm, onClose }: SendTextDialogProps) {
  const [text, setText] = useState(initialText);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showTimeVars, setShowTimeVars] = useState(false);
  const [showSnippets, setShowSnippets] = useState(false);
  const [snippets, setSnippets] = useState<Snippet[]>(loadSnippets);
  const [snippetName, setSnippetName] = useState('');
  const [savingSnippet, setSavingSnippet] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cursorPosRef = useRef<number>(initialText.length);
  const timeVarsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Close time vars dropdown on outside click
  useEffect(() => {
    if (!showTimeVars) return;
    const handler = (e: MouseEvent) => {
      if (timeVarsRef.current && !timeVarsRef.current.contains(e.target as Node)) {
        setShowTimeVars(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showTimeVars]);

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

  const handleClipboardInsert = useCallback(() => {
    insertAtCursor('{clipboard}');
  }, [insertAtCursor]);

  const handleTimeVarInsert = useCallback((variable: string) => {
    insertAtCursor(variable);
    setShowTimeVars(false);
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

  const handleLoadSnippet = useCallback((snippetText: string) => {
    setText(snippetText);
    cursorPosRef.current = snippetText.length;
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.selectionStart = snippetText.length;
        textareaRef.current.selectionEnd = snippetText.length;
      }
    });
  }, []);

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
      } else if (showTimeVars) {
        setShowTimeVars(false);
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        className="bg-bg-elevated border border-border-subtle rounded-lg shadow-xl w-[460px] h-[75vh] max-h-[700px] flex flex-col"
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
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => { setText(e.target.value); saveCursorPos(); }}
            onSelect={saveCursorPos}
            onClick={saveCursorPos}
            onKeyUp={saveCursorPos}
            placeholder="Type the text to send..."
            rows={5}
            className="w-full px-3 py-2 text-sm text-text-primary bg-bg-input border border-border-subtle rounded resize-y outline-none focus:border-accent-solid placeholder:text-text-disabled"
          />

          {/* Toolbar */}
          <div className="flex items-center gap-1.5 mt-2 flex-wrap">
            {/* Emoji */}
            <button
              type="button"
              onClick={() => { setShowEmojiPicker(!showEmojiPicker); setShowTimeVars(false); }}
              className={toolbarBtnClass(showEmojiPicker)}
              title="Insert emoji"
            >
              <Smile size={14} />
              Emoji
            </button>

            {/* Clipboard */}
            <button
              type="button"
              onClick={handleClipboardInsert}
              className={toolbarBtnClass(false)}
              title="Insert {clipboard} placeholder"
            >
              <ClipboardPaste size={14} />
              Clipboard
            </button>

            {/* Time variables */}
            <div className="relative" ref={timeVarsRef}>
              <button
                type="button"
                onClick={() => { setShowTimeVars(!showTimeVars); setShowEmojiPicker(false); }}
                className={toolbarBtnClass(showTimeVars)}
                title="Insert time/date variable"
              >
                <Clock size={14} />
                Variables
              </button>

              {showTimeVars && (
                <div className="absolute left-0 top-full mt-1 z-10 w-[260px] bg-bg-elevated border border-border-subtle rounded-lg shadow-xl overflow-hidden">
                  {TIME_VARIABLES.map((v) => (
                    <button
                      key={v.label}
                      type="button"
                      onClick={() => handleTimeVarInsert(v.label)}
                      className="flex items-center justify-between w-full px-3 py-2 text-left hover:bg-bg-card transition-colors"
                    >
                      <code className="text-xs font-mono text-accent-light">{v.label}</code>
                      <span className="text-[11px] text-text-tertiary">{v.desc}</span>
                    </button>
                  ))}
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
                        onClick={() => handleLoadSnippet(s.text)}
                        className="flex-1 text-left min-w-0"
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
          <div className="mt-2 space-y-1">
            <p className="text-[11px] text-text-tertiary">
              Placeholders resolved at replay:
              <code className="ml-1 px-1 py-0.5 rounded bg-bg-input text-text-secondary">{'{clipboard}'}</code>
              <code className="ml-1 px-1 py-0.5 rounded bg-bg-input text-text-secondary">{'{date}'}</code>
              <code className="ml-1 px-1 py-0.5 rounded bg-bg-input text-text-secondary">{'{time}'}</code>
              <code className="ml-1 px-1 py-0.5 rounded bg-bg-input text-text-secondary">{'{datetime}'}</code>
            </p>
            <p className="text-[11px] text-text-disabled">
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
