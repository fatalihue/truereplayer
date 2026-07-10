import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Smile, Clock, BookmarkPlus, Trash2, ChevronRight, Wand2, Pencil, Search, Check, X, Type } from 'lucide-react';
import EmojiPicker, { Theme } from 'emoji-picker-react';
import type { EmojiClickData } from 'emoji-picker-react';
import { DialogShell } from './common/DialogShell';
import { Button } from './common/Button';
import { useTt } from '../state/LanguageContext';
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

// Relative luminance (WCAG) of a #rgb/#rrggbb hex, 0 = black … 1 = white.
// Inlined because themes.ts doesn't export a helper; used to pick the emoji
// picker's light/dark variant from the active theme's base surface. Returns 0
// (→ dark, the previous hardcoded behavior) on anything unparseable.
function hexLuminance(hex: string): number {
  const h = hex.trim().replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (!/^[0-9a-fA-F]{6}/.test(full)) return 0;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function loadSnippets(): Snippet[] {
  try {
    const raw = localStorage.getItem(SNIPPETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // Guard against a non-array (corrupt/hand-edited localStorage) — otherwise every
    // .map/.filter over snippets downstream would throw and break the dialog.
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveSnippets(snippets: Snippet[]) {
  // QuotaExceededError guard — large snippet libraries (or storage shared with
  // other features) could fill the quota. Swallow + log so the dialog stays usable;
  // the snippet just won't persist across reloads.
  try {
    localStorage.setItem(SNIPPETS_KEY, JSON.stringify(snippets));
  } catch (err) {
    console.warn('[SendTextDialog] Failed to save snippets:', err);
  }
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
        <Button variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => canSave && onSave(name, text)}
          disabled={!canSave}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

// ── Variable definitions (organized by group, all chip/grid style) ──

interface VarChipItem { var: string; label: string; action?: 'transform'; breakAfter?: boolean }
interface VarGroup { label: string; items: VarChipItem[]; collapsible?: boolean }

// Two visible groups carry the tokens users actually reach for (mirrors the
// BrowserType chip palette in SheetPanel: Clipboard/Enter/Tab + Date/Time/DateTime).
// Everything else — rare keys and navigation — lives in a collapsed "More keys"
// group so the panel doesn't sprawl.
const VARIABLE_GROUPS: VarGroup[] = [
  {
    label: 'Clipboard',
    items: [
      { var: '{clipboard}', label: 'Clipboard' },
      { var: '__transform__', label: 'Advanced', action: 'transform' },
    ],
  },
  {
    label: 'Common',
    items: [
      { var: '{enter}', label: 'Enter' },
      { var: '{tab}', label: 'Tab' },
      { var: '{delay:500}', label: 'Delay', breakAfter: true },
      { var: '{date}', label: 'Date' },
      { var: '{time}', label: 'Time' },
      { var: '{datetime}', label: 'DateTime', breakAfter: true },
      { var: '{random:1-10}', label: 'Random' },
    ],
  },
  {
    label: 'More Keys',
    collapsible: true,
    items: [
      { var: '{space}', label: 'Space' },
      { var: '{backspace}', label: 'Backspace' },
      { var: '{delete}', label: 'Delete' },
      { var: '{escape}', label: 'Escape', breakAfter: true },
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
        border: '1px solid color-mix(in srgb, var(--color-accent) 35%, transparent)',
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
          className="h-7 px-3 text-[11px] font-semibold rounded text-[color:var(--color-accent-ink)] shadow-sm transition-colors"
          style={{
            background: 'linear-gradient(180deg, var(--color-accent-solid), color-mix(in srgb, var(--color-accent-solid) 82%, #000))',
            boxShadow: '0 2px 6px color-mix(in srgb, var(--color-accent-solid) 30%, transparent)',
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
  const tt = useTt();
  const [text, setText] = useState(initialText);
  // The side panel is always visible (user request — no collapse), with one of
  // the three tools active; Variables is the default.
  const [activePanel, setActivePanel] = useState<PanelType>('variables');
  const [snippets, setSnippets] = useState<Snippet[]>(loadSnippets);
  const [snippetName, setSnippetName] = useState('');
  const [savingSnippet, setSavingSnippet] = useState(false);
  const [editingSnippetId, setEditingSnippetId] = useState<string | null>(null);
  const [deletingSnippetId, setDeletingSnippetId] = useState<string | null>(null);
  const [snippetFilter, setSnippetFilter] = useState('');
  const [transformOpen, setTransformOpen] = useState(false);
  // "More Keys" group starts collapsed — rare keys (Space/Backspace/arrows/…) only
  // show on demand so the Variables panel stays compact.
  const [moreKeysOpen, setMoreKeysOpen] = useState(false);
  const lexicalApiRef = useRef<LexicalEditorHandle | null>(null);

  // Pick the emoji picker's built-in LIGHT/DARK variant from the ACTIVE theme's
  // base surface — NOT Theme.AUTO (the app theme is user-picked, not OS-driven).
  // Computed once per dialog mount; a theme switch mid-dialog is an edge case
  // and the picker re-reads on the next open.
  const emojiTheme = useMemo(() => {
    const base = getComputedStyle(document.documentElement).getPropertyValue('--color-bg-base');
    return hexLuminance(base) > 0.5 ? Theme.LIGHT : Theme.DARK;
  }, []);

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
      // crypto.randomUUID (secure-context, available in WebView2) avoids the
      // same-millisecond collision a bare timestamp had; fall back to timestamp+random.
      id: (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
  };

  // One Esc closes the dialog, but in-progress snippet save/delete/edit still
  // get their own Esc step so a stray press can't discard typed snippet data
  // AND the dialog. This must hold no matter WHERE focus sits — including the
  // shell's header/footer buttons, which are outside the body wrapper — so the
  // layer is a document-level CAPTURE listener (same pattern as
  // ProfileInfoDialog's emoji-picker Esc), armed only while a snippet
  // sub-state is open. Capture phase beats DialogShell's card handler.
  const snippetLayerActive = savingSnippet || deletingSnippetId !== null || editingSnippetId !== null;
  useEffect(() => {
    if (!snippetLayerActive) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (savingSnippet) setSavingSnippet(false);
      else if (deletingSnippetId !== null) setDeletingSnippetId(null);
      else if (editingSnippetId !== null) setEditingSnippetId(null);
    };
    document.addEventListener('keydown', onEsc, true);
    return () => document.removeEventListener('keydown', onEsc, true);
  }, [snippetLayerActive, savingSnippet, deletingSnippetId, editingSnippetId]);

  const tabBtnClass = (active: boolean) =>
    `flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium rounded transition-colors ${
      active
        ? 'text-accent-solid bg-accent-solid/10'
        : 'text-text-tertiary hover:text-text-primary hover:bg-bg-card'
    }`;

  return (
    <DialogShell
      icon={<Type size={14} style={{ color: 'var(--color-action-sendtext-fg)' }} />}
      title={mode === 'add' ? 'Insert Text' : 'Edit Text'}
      widthClass="w-[950px] h-[90vh] max-h-[920px]"
      onClose={onClose}
      // Text-entry dialog: a stray scrim click must not discard typed text —
      // dismissal is Esc or Cancel only.
      closeOnBackdrop={false}
      footerHint={<>{text.length} chars · Ctrl+Enter to confirm · Esc to cancel</>}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleConfirm} disabled={!text.trim()}>
            {mode === 'add' ? 'Add' : 'Save'}
          </Button>
        </>
      }
      onCardKeyDown={(e) => {
        // Ctrl+Enter confirms from anywhere in the dialog (incl. the editor).
        // Esc is owned by DialogShell; the snippet-form Esc layering runs as a
        // document-capture listener (see snippetLayerActive effect above), so
        // it wins regardless of focus position.
        if (e.key === 'Enter' && e.ctrlKey) {
          e.preventDefault();
          handleConfirm();
        }
      }}
    >
        {/* Body: textarea + side panel */}
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

          {/* Right: side panel — always visible, tool selected via the tabs below */}
          {(
            <div className="w-[300px] shrink-0 border-l border-border-subtle flex flex-col">
              {/* Tool tabs — lived in the hand-rolled dialog header; DialogShell
                  owns the header now, so they sit atop the panel they switch. */}
              <div className="flex items-center justify-center gap-1 px-2 py-2 border-b border-border-subtle shrink-0">
                <button type="button" onClick={() => selectPanel('emoji')} className={tabBtnClass(activePanel === 'emoji')}>
                  <Smile size={14} /> Emoji
                </button>
                <button type="button" onClick={() => selectPanel('variables')} className={tabBtnClass(activePanel === 'variables')}>
                  <Clock size={14} /> Variables
                </button>
                <button type="button" onClick={() => selectPanel('snippets')} className={tabBtnClass(activePanel === 'snippets')}>
                  <BookmarkPlus size={14} /> Snippets
                </button>
              </div>
              {/* ── Emoji Panel ── */}
              {activePanel === 'emoji' && (
                <div className="flex-1 min-h-0 overflow-hidden">
                  <EmojiPicker
                    onEmojiClick={handleEmojiClick}
                    theme={emojiTheme}
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
                      {group.collapsible ? (
                        // Collapsible header — whole row toggles. Chevron flips to signal
                        // state; collapsed by default so rare keys don't crowd the panel.
                        <button
                          type="button"
                          onClick={() => setMoreKeysOpen((v) => !v)}
                          className="w-full flex items-center justify-between px-3 py-1.5 text-[10px] font-semibold text-text-tertiary uppercase tracking-wide border-b border-border-subtle hover:text-text-primary transition-colors"
                        >
                          {group.label}
                          <ChevronRight size={12} className={`transition-transform ${moreKeysOpen ? 'rotate-90' : ''}`} />
                        </button>
                      ) : (
                        <div className="px-3 py-1.5 text-[10px] font-semibold text-text-tertiary uppercase tracking-wide border-b border-border-subtle">
                          {group.label}
                        </div>
                      )}
                      {(!group.collapsible || moreKeysOpen) && (
                      <div className="flex flex-wrap gap-1 px-3 py-2">
                        {group.items.map((item) => (
                          <React.Fragment key={item.var}>
                            {item.action === 'transform' ? (
                              // Advanced is a toggle — when the popover is open it keeps an
                              // accent-blue "active" state so the user can spot which chip
                              // opened the panel. When inactive it visually matches its
                              // siblings (neutral surface + gold hover) so the palette reads
                              // as a single cohesive control.
                              <button
                                type="button"
                                onClick={() => setTransformOpen((v) => !v)}
                                className={`flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono border rounded transition-colors ${
                                  transformOpen
                                    ? 'text-accent-light bg-accent-solid/15 border-accent-solid/50'
                                    : 'bg-bg-surface border-border-subtle text-text-secondary hover:text-warning hover:border-warning/40'
                                }`}
                                data-tip={tt('Build a {clipboard:...} transform', 'Crie uma transformação {clipboard:...}')}
                              >
                                <Wand2 size={11} className="shrink-0" />
                                {item.label}
                              </button>
                            ) : (
                              // Gold hover (--color-warning) mirrors the BrowserType chip palette in
                              // SheetPanel so users see the same affordance across both editors.
                              <button
                                type="button"
                                onClick={() => handleVarInsert(item.var)}
                                className="px-2 py-0.5 text-[11px] font-mono bg-bg-surface border border-border-subtle rounded text-text-secondary hover:text-warning hover:border-warning/40 transition-colors"
                              >
                                {item.label}
                              </button>
                            )}
                            {item.breakAfter && <div className="basis-full h-0" />}
                          </React.Fragment>
                        ))}
                      </div>
                      )}
                    </div>
                  ))}
                  {/* Tip */}
                  <div className="px-3 py-2 text-[10px] text-text-tertiary border-t border-border-subtle leading-relaxed">
                    Tip: click any chip in the editor to edit its parameters — repeat count, delay ms, clipboard modifiers.
                  </div>

                  {/* Transform popover (overlays the panel). insertToken (not insertText):
                      a popover-built token always becomes a chip even when its join
                      separator contains characters the typing grammar doesn't chip. */}
                  {transformOpen && (
                    <ClipboardTransformPopover
                      onInsert={(token) => lexicalApiRef.current?.insertToken(token)}
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
                          <Button variant="secondary" size="sm" onClick={() => setSavingSnippet(false)}>
                            Cancel
                          </Button>
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={handleSaveSnippet}
                            disabled={!snippetName.trim() || !text.trim()}
                          >
                            Save
                          </Button>
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
                                  autoFocus
                                >
                                  <Check size={12} />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setDeletingSnippetId(null)}
                                  className="shrink-0 p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors"
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
                                >
                                  <Pencil size={12} />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setDeletingSnippetId(s.id)}
                                  className="shrink-0 p-1 text-text-disabled hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
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
    </DialogShell>
  );
}
