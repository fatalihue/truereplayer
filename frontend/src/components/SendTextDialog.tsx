import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Smile, Clock, BookmarkPlus, Trash2, ChevronRight, ChevronLeft, Wand2, Pencil, Search, Check, X } from 'lucide-react';
import EmojiPicker, { Theme } from 'emoji-picker-react';
import type { EmojiClickData } from 'emoji-picker-react';
import { LexicalTokenEditor, type LexicalEditorHandle } from './lexical/LexicalTokenEditor';
import { ClipboardModifierBody } from './lexical/ClipboardModifierBody';
import { useClipboardContent } from './lexical/useClipboardContent';
import {
  buildClipboardToken,
  DEFAULT_TRANSFORM,
  type TransformState,
} from './lexical/clipboardModifiers';

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

// Inline edit form for an existing snippet — rendered in place of the row so
// the user can adjust name and text without leaving the panel.
function SnippetEditForm({
  snippet,
  onSave,
  onCancel,
}: {
  snippet: Snippet;
  onSave: (name: string, text: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(snippet.name);
  const [text, setText] = useState(snippet.text);
  const canSave = name.trim().length > 0 && text.trim().length > 0;

  return (
    <div className="px-3 py-3 bg-bg-card border-b border-border-subtle space-y-2">
      <div className="text-[10px] uppercase tracking-wide font-semibold text-text-tertiary">
        Edit snippet
      </div>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
        }}
        placeholder="Snippet name..."
        autoFocus
        className="w-full h-7 px-2 text-xs text-text-primary bg-bg-input border border-border-subtle rounded outline-none focus:border-accent-solid placeholder:text-text-disabled"
      />
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Let Ctrl+Enter still confirm the parent dialog; Escape cancels the edit.
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
        }}
        placeholder="Snippet text..."
        rows={5}
        className="w-full px-2 py-1.5 text-[11px] font-mono text-text-primary bg-bg-input border border-border-subtle rounded outline-none focus:border-accent-solid resize-none placeholder:text-text-disabled"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => canSave && onSave(name, text)}
          disabled={!canSave}
          className="px-3 py-1 text-[11px] font-medium text-white bg-accent-solid hover:bg-accent-solid/80 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-2 py-1 text-[11px] text-text-tertiary hover:text-text-primary transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Variable definitions (organized by group, all chip/grid style) ──

interface VarChipItem { var: string; label: string; action?: 'transform'; breakAfter?: boolean }
interface VarGroup { label: string; items: VarChipItem[] }

const VARIABLE_GROUPS: VarGroup[] = [
  {
    label: 'Clipboard',
    items: [
      { var: '{clipboard}', label: 'Clipboard' },
      { var: '__transform__', label: 'Advanced', action: 'transform' },
    ],
  },
  {
    label: 'Action Keys',
    items: [
      { var: '{enter}', label: 'Enter' },
      { var: '{tab}', label: 'Tab' },
      { var: '{space}', label: 'Space', breakAfter: true },
      { var: '{backspace}', label: 'Backspace' },
      { var: '{delete}', label: 'Delete' },
      { var: '{escape}', label: 'Escape' },
    ],
  },
  {
    label: 'Utility',
    items: [
      { var: '{date}', label: 'Date' },
      { var: '{time}', label: 'Time' },
      { var: '{datetime}', label: 'DateTime' },
      { var: '{delay:500}', label: 'Delay' },
    ],
  },
  {
    label: 'Navigation',
    items: [
      { var: '{home}', label: 'Home' },
      { var: '{end}', label: 'End' },
      { var: '{pageup}', label: 'PageUp' },
      { var: '{pagedown}', label: 'PageDown', breakAfter: true },
      { var: '{up}', label: 'Up' },
      { var: '{down}', label: 'Down' },
      { var: '{left}', label: 'Left' },
      { var: '{right}', label: 'Right' },
    ],
  },
];

interface ClipboardTransformPopoverProps {
  onInsert: (token: string) => void;
  onClose: () => void;
}

// Side-panel "Advanced Clipboard" insert popover. The body (Transform / Extract /
// Limit + token / preview) is shared with the chip click-to-edit popover via
// ClipboardModifierBody — only the shell (header / footer / positioning) differs.
function ClipboardTransformPopover({ onInsert, onClose }: ClipboardTransformPopoverProps) {
  const [state, setState] = useState<TransformState>(DEFAULT_TRANSFORM);
  const { clipRaw, clipReady } = useClipboardContent();
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const handleInsert = () => {
    onInsert(buildClipboardToken(state));
    onClose();
  };

  return (
    <div
      ref={popRef}
      className="absolute inset-1 z-30 rounded-lg overflow-hidden shadow-2xl flex flex-col"
      style={{
        background: 'var(--color-bg-elevated, #2d2d2d)',
        border: '1px solid rgba(96, 205, 255, 0.35)',
        boxShadow: '0 16px 40px rgba(0, 0, 0, 0.55)',
        animation: 'transform-pop-in 0.16s ease',
      }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
      }}
    >
      <style>{`@keyframes transform-pop-in {
        from { opacity: 0; transform: translateY(-4px) scale(0.98); }
        to   { opacity: 1; transform: translateY(0)    scale(1); }
      }`}</style>

      <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-border-subtle bg-bg-card shrink-0">
        <Wand2 size={14} className="text-accent-light shrink-0" />
        <div className="text-xs font-semibold text-text-primary flex-1">Advanced Clipboard</div>
        <button
          type="button"
          onClick={onClose}
          className="text-text-tertiary hover:text-text-primary text-sm leading-none px-1"
          title="Close"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
        <ClipboardModifierBody
          state={state}
          setState={setState}
          clipRaw={clipRaw}
          clipReady={clipReady}
        />
      </div>

      <div className="flex justify-end gap-2 px-3.5 py-2.5 bg-bg-card border-t border-border-subtle shrink-0">
        <button
          type="button"
          onClick={onClose}
          className="h-7 px-3 text-[11px] rounded border border-border-subtle text-text-secondary hover:bg-bg-surface transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleInsert}
          className="h-7 px-3 text-[11px] font-semibold rounded text-white shadow-sm transition-colors"
          style={{
            background: 'linear-gradient(180deg, #0078D4, #0065B3)',
            boxShadow: '0 2px 6px rgba(0, 120, 212, 0.3)',
          }}
        >
          Insert
        </button>
      </div>
    </div>
  );
}

type PanelType = 'emoji' | 'variables' | 'snippets';

export function SendTextDialog({ mode, initialText = '', onConfirm, onClose }: SendTextDialogProps) {
  const [text, setText] = useState(initialText);
  const [activePanel, setActivePanel] = useState<PanelType | null>('variables');
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [snippets, setSnippets] = useState<Snippet[]>(loadSnippets);
  const [snippetName, setSnippetName] = useState('');
  const [savingSnippet, setSavingSnippet] = useState(false);
  const [editingSnippetId, setEditingSnippetId] = useState<string | null>(null);
  const [deletingSnippetId, setDeletingSnippetId] = useState<string | null>(null);
  const [snippetFilter, setSnippetFilter] = useState('');
  const [transformOpen, setTransformOpen] = useState(false);
  const lexicalApiRef = useRef<LexicalEditorHandle | null>(null);

  useEffect(() => {
    lexicalApiRef.current?.focus();
  }, []);

  const insertAtCursor = useCallback((insertText: string) => {
    lexicalApiRef.current?.insertText(insertText);
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
    if (editingSnippetId === id) setEditingSnippetId(null);
    setDeletingSnippetId(null);
  }, [snippets, editingSnippetId]);

  const handleUpdateSnippet = useCallback((id: string, newName: string, newText: string) => {
    const trimmedName = newName.trim();
    const trimmedText = newText.trim();
    if (!trimmedName || !trimmedText) return;
    const updated = snippets.map(s =>
      s.id === id ? { ...s, name: trimmedName, text: trimmedText } : s,
    );
    setSnippets(updated);
    saveSnippets(updated);
    setEditingSnippetId(null);
  }, [snippets]);

  const filteredSnippets = useMemo(() => {
    const q = snippetFilter.trim().toLowerCase();
    if (!q) return snippets;
    return snippets.filter(s =>
      s.name.toLowerCase().includes(q) || s.text.toLowerCase().includes(q),
    );
  }, [snippets, snippetFilter]);

  const handleInsertSnippet = useCallback((snippetText: string) => {
    insertAtCursor(snippetText);
  }, [insertAtCursor]);

  const handleConfirm = () => {
    // Don't trim — leading/trailing spaces are intentional ("oi " ≠ "oi"). Only
    // block submit when the field is entirely whitespace (trim used as emptiness check).
    if (!text.trim()) return;
    onConfirm(text);
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
      } else if (deletingSnippetId !== null) {
        setDeletingSnippetId(null);
      } else if (editingSnippetId !== null) {
        setEditingSnippetId(null);
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
        className="bg-bg-elevated border border-border-subtle rounded-lg shadow-xl w-[950px] max-w-[95vw] h-[90vh] max-h-[920px] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header with tool tabs */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle shrink-0">
          <h3 className="text-sm font-semibold text-text-primary">
            {mode === 'add' ? 'Insert Text' : 'Edit Text'}
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
          {/* Left: Lexical chip editor */}
          <div className="flex-1 min-w-0 p-4 flex flex-col">
            <div className="relative flex-1 min-h-0 rounded border border-border-subtle focus-within:border-accent-solid bg-bg-input">
              <LexicalTokenEditor
                initialText={initialText}
                onChange={setText}
                onSubmit={handleConfirm}
                apiRef={lexicalApiRef}
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
                      '--epr-bg-color': 'var(--color-bg-card)',
                      '--epr-category-label-bg-color': 'var(--color-bg-card)',
                      '--epr-hover-bg-color': 'var(--color-bg-elevated)',
                      '--epr-search-input-bg-color': 'var(--color-bg-input)',
                      '--epr-search-border-color': 'var(--color-border-default)',
                      '--epr-text-color': 'var(--color-text-primary)',
                      '--epr-category-icon-active-color': 'var(--color-accent-solid)',
                      '--epr-highlight-color': 'var(--color-accent-solid)',
                    } as React.CSSProperties}
                  />
                </div>
              )}

              {/* ── Variables Panel ── */}
              {activePanel === 'variables' && (
                <div className="relative flex-1 min-h-0 overflow-y-auto">
                  {VARIABLE_GROUPS.map((group) => (
                    <div key={group.label}>
                      <div className="px-3 py-1.5 text-[10px] font-semibold text-text-tertiary uppercase tracking-wide border-b border-border-subtle">
                        {group.label}
                      </div>
                      <div className="flex flex-wrap gap-1 px-3 py-2">
                        {group.items.map((item) => (
                          <React.Fragment key={item.var}>
                            {item.action === 'transform' ? (
                              <button
                                type="button"
                                onClick={() => setTransformOpen((v) => !v)}
                                className={`flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono border rounded transition-colors ${
                                  transformOpen
                                    ? 'text-accent-light bg-accent-solid/15 border-accent-solid/50'
                                    : 'text-accent-light bg-accent-solid/8 border-accent-solid/30 hover:bg-accent-solid/15'
                                }`}
                                title="Build a {clipboard:...} transform"
                              >
                                <Wand2 size={11} className="shrink-0" />
                                {item.label}
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handleVarInsert(item.var)}
                                className="px-2 py-0.5 text-[11px] font-mono bg-bg-surface border border-border-subtle rounded text-text-secondary hover:text-accent-light hover:border-accent-solid/30 transition-colors"
                                title={item.var}
                              >
                                {item.label}
                              </button>
                            )}
                            {item.breakAfter && <div className="basis-full h-0" />}
                          </React.Fragment>
                        ))}
                      </div>
                    </div>
                  ))}
                  {/* Tip */}
                  <div className="px-3 py-2 text-[10px] text-text-tertiary border-t border-border-subtle leading-relaxed">
                    Tip: click any chip in the editor to edit its parameters — repeat count, delay ms, clipboard modifiers.
                  </div>

                  {/* Transform popover (overlays the panel) */}
                  {transformOpen && (
                    <ClipboardTransformPopover
                      onInsert={(token) => handleVarInsert(token)}
                      onClose={() => setTransformOpen(false)}
                    />
                  )}
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

                  {/* Search (only when there are snippets) */}
                  {snippets.length > 0 && (
                    <div className="px-3 py-2 border-b border-border-subtle shrink-0">
                      <div className="relative">
                        <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
                        <input
                          type="text"
                          value={snippetFilter}
                          onChange={(e) => setSnippetFilter(e.target.value)}
                          placeholder="Search snippets..."
                          className="w-full h-7 pl-6 pr-2 text-[11px] text-text-primary bg-bg-input border border-border-subtle rounded outline-none focus:border-accent-solid placeholder:text-text-disabled"
                        />
                      </div>
                    </div>
                  )}

                  {/* Snippet list */}
                  <div className="flex-1 overflow-y-auto">
                    {snippets.length === 0 ? (
                      <div className="px-3 py-4 text-center text-[11px] text-text-disabled">
                        No saved snippets yet
                      </div>
                    ) : filteredSnippets.length === 0 ? (
                      <div className="px-3 py-4 text-center text-[11px] text-text-disabled">
                        No snippets match “{snippetFilter}”
                      </div>
                    ) : (
                      filteredSnippets.map((s) =>
                        editingSnippetId === s.id ? (
                          <SnippetEditForm
                            key={s.id}
                            snippet={s}
                            onSave={(name, snippetText) => handleUpdateSnippet(s.id, name, snippetText)}
                            onCancel={() => setEditingSnippetId(null)}
                          />
                        ) : (
                          <div
                            key={s.id}
                            className={`flex items-center gap-1 px-3 py-2 transition-colors group border-b border-border-subtle last:border-b-0 ${
                              deletingSnippetId === s.id ? 'bg-red-500/10' : 'hover:bg-bg-card'
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => handleInsertSnippet(s.text)}
                              disabled={deletingSnippetId === s.id}
                              className="flex-1 text-left min-w-0 disabled:cursor-default"
                              title={deletingSnippetId === s.id ? '' : 'Insert at cursor'}
                            >
                              <div className="text-xs font-medium text-text-primary truncate">{s.name}</div>
                              <div className="text-[11px] text-text-tertiary truncate mt-0.5">{s.text}</div>
                            </button>
                            {deletingSnippetId === s.id ? (
                              <>
                                <span className="text-[10px] text-red-300 mr-1 shrink-0">Delete?</span>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteSnippet(s.id)}
                                  className="shrink-0 p-1 rounded text-red-300 bg-red-500/20 hover:bg-red-500/35 border border-red-500/40 transition-colors"
                                  title="Confirm delete"
                                  autoFocus
                                >
                                  <Check size={12} />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setDeletingSnippetId(null)}
                                  className="shrink-0 p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors"
                                  title="Cancel"
                                >
                                  <X size={12} />
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  onClick={() => setEditingSnippetId(s.id)}
                                  className="shrink-0 p-1 text-text-disabled hover:text-accent-light transition-colors opacity-0 group-hover:opacity-100"
                                  title="Edit snippet"
                                >
                                  <Pencil size={12} />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setDeletingSnippetId(s.id)}
                                  className="shrink-0 p-1 text-text-disabled hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
                                  title="Delete snippet"
                                >
                                  <Trash2 size={12} />
                                </button>
                              </>
                            )}
                          </div>
                        ),
                      )
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
