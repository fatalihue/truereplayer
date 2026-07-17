import React, { useState, useRef, useEffect, useCallback, useMemo, useLayoutEffect } from 'react';
import ReactDOM from 'react-dom';
import {
  Smile, Braces, BookmarkPlus, Trash2, ChevronRight, Wand2, Pencil, Search, Check, X, Type,
} from 'lucide-react';
import EmojiPicker, { Theme } from 'emoji-picker-react';
import type { EmojiClickData } from 'emoji-picker-react';
import { DialogShell } from './common/DialogShell';
import { Button } from './common/Button';
import { SegmentedControl } from './common/SegmentedControl';
import { useTt } from '../state/LanguageContext';
import {
  LexicalTokenEditor,
  countKnownTokens,
  type LexicalEditorHandle,
} from './lexical/LexicalTokenEditor';
import type { ClipboardChipEditRequest } from './lexical/TokenChip';
import { ClipboardSurface } from './lexical/ClipboardSurface';
import {
  buildClipboardToken,
  parseClipboardToken,
  DEFAULT_TRANSFORM,
  type TransformState,
} from './lexical/clipboardModifiers';

interface SendTextDialogProps {
  mode: 'add' | 'edit';
  initialText?: string;
  /** Saved rich flavor (KeyHtml) — rebuilds the formatted doc on reopen. */
  initialHtml?: string | null;
  /** Saved delivery mode (SendMode); 'rich' default. */
  initialMode?: SendMode;
  /** html/markdown are null when the doc carries no formatting → the action stays plain. */
  onConfirm: (text: string, html: string | null, markdown: string | null, mode: SendMode) => void;
  onClose: () => void;
}

type SendMode = 'rich' | 'markdown' | 'plain' | 'discord';

interface Snippet {
  id: string;
  name: string;
  text: string;
  /** Rich flavor — pre-rich snippets simply lack the field and insert as plain. */
  html?: string;
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
      <div className="label-micro text-text-tertiary">
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

// ── Insert palette data ─────────────────────────────────────────────────────
//
// Four real sections (no breakAfter hacks): CLIPBOARD (chip + Advanced…),
// VALUES, KEYS & TIMING (+ collapsed More keys), RUN STATE (the 2.8.0 tokens).
// Direct chips insert their seed string; prompt chips ({Variable…}/{Row
// column…}) open a name prompt first — never insert a literal placeholder.

interface PaletteChip {
  label: string;
  insert?: string;             // direct-insert seed (byte-identical to 2.7.x)
  prompt?: 'var' | 'row';      // opens the name prompt instead
  tip: [string, string];       // tt(en, ptBr)
}

const VALUE_CHIPS: PaletteChip[] = [
  { label: 'Date', insert: '{date}', tip: ['Current date (dd/MM/yyyy)', 'Data atual (dd/MM/aaaa)'] },
  { label: 'Time', insert: '{time}', tip: ['Current time (HH:mm:ss)', 'Hora atual (HH:mm:ss)'] },
  { label: 'DateTime', insert: '{datetime}', tip: ['Current date and time', 'Data e hora atuais'] },
  { label: 'Random', insert: '{random:1-10}', tip: ['Fresh random number each run', 'Número aleatório novo a cada execução'] },
];

const KEY_CHIPS: PaletteChip[] = [
  { label: 'Enter', insert: '{enter}', tip: ['Press Enter', 'Pressiona Enter'] },
  { label: 'Tab', insert: '{tab}', tip: ['Press Tab', 'Pressiona Tab'] },
  { label: 'Delay', insert: '{delay:500}', tip: ['Pause typing for N ms', 'Pausa a digitação por N ms'] },
];

const MORE_KEY_CHIPS: PaletteChip[] = [
  { label: 'Space', insert: '{space}', tip: ['Press Space', 'Pressiona Espaço'] },
  { label: 'Backspace', insert: '{backspace}', tip: ['Press Backspace', 'Pressiona Backspace'] },
  { label: 'Delete', insert: '{delete}', tip: ['Press Delete', 'Pressiona Delete'] },
  { label: 'Escape', insert: '{escape}', tip: ['Press Escape', 'Pressiona Esc'] },
  { label: 'Home', insert: '{home}', tip: ['Press Home', 'Pressiona Home'] },
  { label: 'End', insert: '{end}', tip: ['Press End', 'Pressiona End'] },
  { label: 'PageUp', insert: '{pageup}', tip: ['Press Page Up', 'Pressiona Page Up'] },
  { label: 'PageDown', insert: '{pagedown}', tip: ['Press Page Down', 'Pressiona Page Down'] },
  { label: 'Up', insert: '{up}', tip: ['Press Up arrow', 'Pressiona seta ↑'] },
  { label: 'Down', insert: '{down}', tip: ['Press Down arrow', 'Pressiona seta ↓'] },
  { label: 'Left', insert: '{left}', tip: ['Press Left arrow', 'Pressiona seta ←'] },
  { label: 'Right', insert: '{right}', tip: ['Press Right arrow', 'Pressiona seta →'] },
];

const RUN_STATE_CHIPS: PaletteChip[] = [
  { label: 'Variable…', prompt: 'var', tip: ['Value stored by a Set Variable action', 'Valor gravado por uma action Set Variable'] },
  { label: 'Counter', insert: '{counter}', tip: ['Current loop iteration (1, 2, 3…)', 'Iteração atual do loop (1, 2, 3…)'] },
  { label: 'Row #', insert: '{row}', tip: ["Current action's grid row number", 'Número da linha atual da action na grade'] },
  { label: 'Row column…', prompt: 'row', tip: ["Data table column of the current row (loop over data)", 'Coluna da tabela de dados na linha atual (loop over data)'] },
];

// One chip recipe everywhere (SheetPanel parity): neutral surface, gold hover.
const CHIP_CLASS =
  'h-6 px-2 inline-flex items-center text-[11px] font-mono bg-bg-surface border border-border-subtle rounded text-text-secondary hover:text-warning hover:border-warning/40 transition-colors';

// ── Name prompt popover ({Variable…} / {Row column…}) ──────────────────────
//
// Anchored 260px prompt reusing the TokenChipPopover shell conventions. Enter
// or Insert commits `{var:NAME}` / `{row:NAME}` through insertToken (chips
// regardless of the typing grammar); Esc is owned by the dialog's Esc router.
function NamePromptPopover({
  kind,
  anchor,
  onInsert,
  onClose,
}: {
  kind: 'var' | 'row';
  anchor: HTMLElement;
  onInsert: (token: string) => void;
  onClose: () => void;
}) {
  const tt = useTt();
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Focus AFTER positioning — the popover mounts visibility:hidden until the
  // layout pass places it, and hidden elements silently refuse focus (a bare
  // autoFocus would leave the keyboard in the editor behind the prompt).
  useEffect(() => {
    if (pos) inputRef.current?.focus();
  }, [pos]);

  useLayoutEffect(() => {
    if (!anchor || !popRef.current) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const popH = popRef.current!.offsetHeight;
      const popW = popRef.current!.offsetWidth;
      let left = r.left;
      let top = r.bottom + 6;
      if (top + popH > window.innerHeight - 8) top = Math.max(8, r.top - popH - 6);
      if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8;
      if (left < 8) left = 8;
      setPos({ left, top });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor]);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t)) return;
      if (anchor.contains(t)) return;
      onClose();
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [anchor, onClose]);

  const commit = () => {
    if (!name) return;
    onInsert(`{${kind}:${name}}`);
    onClose();
  };

  const visibilityStyle: React.CSSProperties = pos
    ? { visibility: 'visible', left: pos.left, top: pos.top }
    : { visibility: 'hidden', left: 0, top: 0 };

  return ReactDOM.createPortal(
    <div
      ref={popRef}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        ...visibilityStyle,
        zIndex: 100,
        width: 260,
        background: 'var(--color-bg-elevated, #2d2d2d)',
        border: '1px solid color-mix(in srgb, var(--color-accent-solid) 35%, transparent)',
        boxShadow: '0 16px 40px rgba(0, 0, 0, 0.55)',
      }}
      className="rounded-lg overflow-hidden"
    >
      <div className="px-3 pt-2.5 pb-2">
        <div className="label-micro text-text-tertiary mb-1.5">
          {kind === 'var' ? 'Variable name' : 'Data column'}
        </div>
        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9_]/g, ''))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit(); }
          }}
          spellCheck={false}
          placeholder={kind === 'var' ? 'name' : 'column'}
          className="h-8 w-full px-2 text-xs font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid placeholder:text-text-disabled"
        />
        <div className="text-[10px] text-text-tertiary mt-1.5 leading-relaxed">
          {kind === 'var'
            ? tt('Set by a Set Variable action while replaying.', 'Definida por uma action Set Variable durante a execução.')
            : tt("Column header from the profile's Data table.", 'Cabeçalho de coluna da tabela Data do profile.')}
        </div>
      </div>
      <div className="flex justify-end px-3 py-2 bg-bg-card border-t border-border-subtle">
        <Button variant="primary" size="sm" onClick={commit} disabled={!name}>
          Insert
        </Button>
      </div>
    </div>,
    document.body,
  );
}

// Clipboard-surface session: insert (from the palette) or edit (from a chip).
type SurfaceSession =
  | { mode: 'insert' }
  | { mode: 'edit'; token: string; commit: (next: string) => void; remove: () => void };

export function SendTextDialog({ mode, initialText = '', initialHtml = null, initialMode = 'rich', onConfirm, onClose }: SendTextDialogProps) {
  const tt = useTt();
  const [text, setText] = useState(initialText);
  // Delivery mode: Rich (HTML where accepted) · Markdown (*bold* as plain text, for
  // WhatsApp/chat) · Plain. Formatting stays authored regardless; the mode picks the flavor.
  const [sendMode, setSendMode] = useState<SendMode>(initialMode);
  // Rail: Insert (palette + snippets) is the default tab; Emoji is the other.
  const [railTab, setRailTab] = useState<'insert' | 'emoji'>('insert');
  const [snippets, setSnippets] = useState<Snippet[]>(loadSnippets);
  const [snippetName, setSnippetName] = useState('');
  const [savingSnippet, setSavingSnippet] = useState(false);
  const [editingSnippetId, setEditingSnippetId] = useState<string | null>(null);
  const [deletingSnippetId, setDeletingSnippetId] = useState<string | null>(null);
  const [snippetFilter, setSnippetFilter] = useState('');
  // "More keys" starts collapsed — rare keys only show on demand.
  const [moreKeysOpen, setMoreKeysOpen] = useState(false);
  // Clipboard Surface (full-body overlay). TransformState is lifted HERE so the
  // DialogShell footer (swapped while the surface is open) can build the token.
  const [surface, setSurface] = useState<SurfaceSession | null>(null);
  const [clipState, setClipState] = useState<TransformState>(DEFAULT_TRANSFORM);
  // Dirty flag — Apply only commits real edits: parse→build round-trips are NOT
  // byte-identical for hand-typed edge cases, so open+Apply must not rewrite.
  const [clipDirty, setClipDirty] = useState(false);
  // {Variable…}/{Row column…} name prompt.
  const [namePrompt, setNamePrompt] = useState<{ kind: 'var' | 'row'; anchor: HTMLElement } | null>(null);
  const lexicalApiRef = useRef<LexicalEditorHandle | null>(null);

  // Pick the emoji picker's built-in LIGHT/DARK variant from the ACTIVE theme's
  // base surface — NOT Theme.AUTO (the app theme is user-picked, not OS-driven).
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

  // ── Clipboard Surface session ──
  const openInsertSurface = useCallback(() => {
    setClipState(DEFAULT_TRANSFORM); // fresh every time, as the old popover did
    setClipDirty(false);
    setSurface({ mode: 'insert' });
  }, []);

  // Chip click → edit session (routed here by ClipboardChipEditContext; the
  // SheetPanel consumer has no provider and keeps the legacy popover).
  const handleClipboardChipEdit = useCallback((req: ClipboardChipEditRequest) => {
    setClipState(parseClipboardToken(req.token));
    setClipDirty(false);
    setSurface({ mode: 'edit', token: req.token, commit: req.commit, remove: req.remove });
  }, []);

  const closeSurface = useCallback(() => {
    setSurface(null);
    lexicalApiRef.current?.focus();
  }, []);

  const handleSurfaceConfirm = useCallback(() => {
    setSurface((cur) => {
      if (!cur) return cur;
      const token = buildClipboardToken(clipState);
      if (cur.mode === 'insert') {
        // insertToken (not insertText): a surface-built token always becomes a
        // chip even when its join separator defeats the typing grammar.
        lexicalApiRef.current?.insertToken(token);
      } else if (clipDirty) {
        cur.commit(token);
      }
      return null;
    });
    lexicalApiRef.current?.focus();
  }, [clipState, clipDirty]);

  const handleSurfaceReset = useCallback(() => {
    setClipState(surface?.mode === 'edit' ? parseClipboardToken(surface.token) : DEFAULT_TRANSFORM);
    setClipDirty(false); // back to the session's starting point = nothing to apply
  }, [surface]);

  // ── Snippets (persistence + guards unchanged from 2.7.x) ──
  const handleSaveSnippet = useCallback(() => {
    const trimmedName = snippetName.trim();
    const trimmedText = text.trim();
    if (!trimmedName || !trimmedText) return;

    // Capture the rich flavor too (undefined when the doc has no formatting) so a
    // formatted snippet re-inserts formatted. Pre-rich snippets simply lack the field.
    const snippetHtml = lexicalApiRef.current?.getHtml() ?? undefined;
    const newSnippet: Snippet = {
      // crypto.randomUUID (secure-context, available in WebView2) avoids the
      // same-millisecond collision a bare timestamp had; fall back to timestamp+random.
      id: (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: trimmedName,
      text: trimmedText,
      ...(snippetHtml ? { html: snippetHtml } : {}),
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
      // Plain-text edit invalidates the rich flavor (same contract as actions:edit on
      // key) — keeping stale html would make insert ignore the text change entirely.
      s.id === id ? { id: s.id, name: trimmedName, text: trimmedText } : s,
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

  const handleInsertSnippet = useCallback((snippet: Snippet) => {
    // Rich snippets re-enter as formatted nodes; pre-rich ones as plain text+chips.
    if (snippet.html && lexicalApiRef.current) lexicalApiRef.current.insertHtml(snippet.html);
    else insertAtCursor(snippet.text);
  }, [insertAtCursor]);

  const handleConfirm = () => {
    // Don't trim — leading/trailing spaces are intentional ("oi " ≠ "oi"). Only
    // block submit when the field is entirely whitespace (trim used as emptiness check).
    if (!text.trim()) return;
    // Flavors exported on demand at confirm (not per keystroke); null = no formatting
    // in the doc → the action persists as a plain SendText, exactly as pre-rich.
    onConfirm(text, lexicalApiRef.current?.getHtml() ?? null, lexicalApiRef.current?.getMarkdown(sendMode === 'discord' ? 'discord' : 'whatsapp') ?? null, sendMode);
  };

  // Status strip counts. Lines: 0 for an empty payload, else newline count + 1.
  const tokenCount = useMemo(() => countKnownTokens(text), [text]);
  const lineCount = text.length === 0 ? 0 : text.split('\n').length;

  // ── Esc router — ONE capture-phase priority ladder for every sub-layer:
  // name prompt → clipboard surface → snippet sub-form. DialogShell's card
  // handler (dialog close) only sees Esc when no layer is open. Chip popovers
  // (TokenChipPopover) own their Esc via their own capture listener — when one
  // is open (data-token-popover marker) this router stands down entirely.
  const escLayerActive =
    namePrompt !== null || surface !== null ||
    savingSnippet || deletingSnippetId !== null || editingSnippetId !== null;
  useEffect(() => {
    if (!escLayerActive) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('[data-token-popover]')) return;
      e.preventDefault();
      e.stopPropagation();
      if (namePrompt) setNamePrompt(null);
      else if (surface) closeSurface();
      else if (savingSnippet) setSavingSnippet(false);
      else if (deletingSnippetId !== null) setDeletingSnippetId(null);
      else if (editingSnippetId !== null) setEditingSnippetId(null);
    };
    document.addEventListener('keydown', onEsc, true);
    return () => document.removeEventListener('keydown', onEsc, true);
  }, [escLayerActive, namePrompt, surface, savingSnippet, deletingSnippetId, editingSnippetId, closeSurface]);

  // ── Palette chip renderer ──
  const renderChip = (chip: PaletteChip, extraClass = '') => (
    <button
      key={chip.label}
      type="button"
      onClick={(e) => {
        if (chip.prompt) setNamePrompt({ kind: chip.prompt, anchor: e.currentTarget });
        else if (chip.insert) insertAtCursor(chip.insert);
      }}
      className={`${CHIP_CLASS} ${extraClass}`}
      data-tip={tt(chip.tip[0], chip.tip[1])}
    >
      {chip.label}
    </button>
  );

  const sectionLabel = (label: string) => (
    <div className="label-micro text-text-tertiary px-3 pt-2.5 pb-1">{label}</div>
  );

  return (
    <DialogShell
      icon={<Type size={14} style={{ color: 'var(--color-action-sendtext-fg)' }} />}
      title={mode === 'add' ? 'Insert Text' : 'Edit Text'}
      widthClass="w-[1080px] h-[90vh] max-h-[900px]"
      // Space-hungry dialog: fill the window to a 12px gutter at the minimum app
      // size (the default 90vw clamp left ~14% of the window unused).
      maxWidthClass="max-w-[calc(100vw-24px)]"
      onClose={onClose}
      // Text-entry dialog: a stray scrim click must not discard typed text —
      // dismissal is Esc or Cancel only.
      closeOnBackdrop={false}
      footerHint={
        surface ? (
          <span className="flex items-center gap-3">
            {surface.mode === 'edit' && (
              <button
                type="button"
                onClick={() => { surface.remove(); closeSurface(); }}
                className="flex items-center gap-1 h-7 px-2 text-[11px] rounded text-red-300 hover:bg-red-500/15 border border-transparent hover:border-red-500/30 transition-colors"
              >
                <Trash2 size={12} />
                Delete token
              </button>
            )}
            <span>{tt('Steps apply in the runtime pipeline order', 'As etapas seguem a ordem do pipeline de execução')}</span>
          </span>
        ) : (
          <>Ctrl+Enter to confirm · Esc to cancel</>
        )
      }
      footer={
        surface ? (
          <>
            <Button variant="secondary" onClick={closeSurface}>Cancel</Button>
            <Button
              variant="primary"
              onClick={handleSurfaceConfirm}
              disabled={surface.mode === 'edit' && !clipDirty}
            >
              {surface.mode === 'insert' ? 'Insert' : 'Apply'}
            </Button>
          </>
        ) : (
          <>
            <div
              className="mr-auto flex items-center gap-1.5"
              data-tip={tt('Delivery: Rich pastes formatting where the target accepts it (Gmail, Crisp, Word) and plain text elsewhere. Markdown pastes *bold*/_italic_ as plain text for WhatsApp; Discord uses **bold**/~~strike~~. Plain sends the raw text.', 'Entrega: Rich cola formatação onde o alvo aceita (Gmail, Crisp, Word) e texto puro no resto. Markdown cola *negrito*/_itálico_ como texto puro para WhatsApp; Discord usa **negrito**/~~tachado~~. Plain envia o texto cru.')}
            >
              <span className="text-[10px] uppercase tracking-wide text-text-tertiary">Delivery</span>
              <SegmentedControl<SendMode>
                ariaLabel="Delivery mode"
                value={sendMode}
                onChange={setSendMode}
                options={[
                  { value: 'rich', label: 'Rich' },
                  { value: 'markdown', label: 'Markdown' },
                  { value: 'discord', label: 'Discord' },
                  { value: 'plain', label: 'Plain' },
                ]}
              />
            </div>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={handleConfirm} disabled={!text.trim()}>
              {mode === 'add' ? 'Add' : 'Save'}
            </Button>
          </>
        )
      }
      onCardKeyDown={(e) => {
        // Ctrl+Enter routes by surface: clipboard surface open → Insert/Apply;
        // otherwise confirm the dialog (incl. from inside the editor, whose
        // SubmitPlugin can only fire while the editor is visible/focused).
        if (e.key === 'Enter' && e.ctrlKey) {
          e.preventDefault();
          if (namePrompt) return; // prompt owns Enter; Ctrl+Enter is a no-op there
          if (surface) handleSurfaceConfirm();
          else handleConfirm();
        }
      }}
    >
      {/* Body — `relative` is load-bearing: the Clipboard Surface mounts
          absolute inset-0 INSIDE this wrapper (an overlay, so the Lexical
          editor underneath never unmounts and undo/caret survive). */}
      <div className="relative flex flex-1 min-h-0">
        {/* ── Editor column: full-bleed writing surface + status strip ── */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="relative flex-1 min-h-0 bg-bg-input sendtext-editor">
            <LexicalTokenEditor
              initialText={initialText}
              initialHtml={initialHtml}
              richMode
              onChange={setText}
              onSubmit={handleConfirm}
              apiRef={lexicalApiRef}
              contentClassName="w-full h-full px-4 py-3 text-sm leading-[1.6] outline-none whitespace-pre-wrap break-words text-text-primary overflow-auto"
              placeholderClassName="absolute top-3 left-4 text-sm text-text-disabled pointer-events-none select-none"
              onClipboardChipEdit={handleClipboardChipEdit}
            />
          </div>
          <div className="h-7 shrink-0 px-4 flex items-center justify-between gap-3 bg-bg-card border-t border-border-subtle">
            <span className="text-[11px] text-text-tertiary tabular-nums whitespace-nowrap">
              {text.length} chars · {tokenCount} token{tokenCount === 1 ? '' : 's'} · {lineCount} line{lineCount === 1 ? '' : 's'}
            </span>
            <span className="text-[10px] text-text-tertiary truncate">
              {tt('Click any chip in the editor to edit its parameters', 'Clique em qualquer chip no editor para editar seus parâmetros')}
            </span>
          </div>
        </div>

        {/* ── Rail: Insert (palette + snippets) | Emoji ── */}
        <div className="w-[300px] shrink-0 border-l border-border-subtle flex flex-col min-h-0">
          <div className="p-2 pb-1.5 shrink-0">
            <SegmentedControl<'insert' | 'emoji'>
              grow
              ariaLabel="Insert panel"
              options={[
                { value: 'insert', label: 'Insert', icon: <Braces size={12} /> },
                { value: 'emoji', label: 'Emoji', icon: <Smile size={12} /> },
              ]}
              value={railTab}
              onChange={setRailTab}
            />
          </div>

          {railTab === 'emoji' ? (
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
          ) : (
            <div className="flex-1 min-h-0 flex flex-col">
              {/* Palette — four real sections. */}
              <div className="shrink-0 overflow-y-auto">
                {sectionLabel('Clipboard')}
                <div className="flex flex-wrap gap-1 px-3 pb-2">
                  {renderChip({
                    label: 'Clipboard',
                    insert: '{clipboard}',
                    tip: ['Paste the clipboard text', 'Cola o texto da área de transferência'],
                  })}
                  <button
                    type="button"
                    onClick={openInsertSurface}
                    className={`${CHIP_CLASS} gap-1`}
                    data-tip={tt('Build a {clipboard:...} transform', 'Crie uma transformação {clipboard:...}')}
                  >
                    <Wand2 size={11} className="shrink-0" />
                    Advanced…
                  </button>
                </div>

                {sectionLabel('Values')}
                <div className="flex flex-wrap gap-1 px-3 pb-2">
                  {VALUE_CHIPS.map((c) => renderChip(c))}
                </div>

                {sectionLabel('Keys & timing')}
                <div className="flex flex-wrap gap-1 px-3 pb-1">
                  {KEY_CHIPS.map((c) => renderChip(c))}
                </div>
                <button
                  type="button"
                  onClick={() => setMoreKeysOpen((v) => !v)}
                  className="w-full flex items-center gap-1 px-3 py-1 text-[10px] font-semibold text-text-tertiary uppercase tracking-wide hover:text-text-primary transition-colors"
                >
                  <ChevronRight size={11} className={`transition-transform ${moreKeysOpen ? 'rotate-90' : ''}`} />
                  More keys
                </button>
                {moreKeysOpen && (
                  <div className="grid grid-cols-3 gap-1 px-3 pb-2">
                    {MORE_KEY_CHIPS.map((c) => renderChip(c, 'justify-center'))}
                  </div>
                )}

                {sectionLabel('Run state')}
                <div className="flex flex-wrap gap-1 px-3 pb-2.5">
                  {RUN_STATE_CHIPS.map((c) => renderChip(c))}
                </div>
              </div>

              {/* Snippets — permanently visible below the palette. */}
              <div className="flex-1 min-h-0 flex flex-col border-t border-border-subtle">
                <div className="px-3 py-2 flex items-center justify-between shrink-0">
                  <span className="label-micro text-text-tertiary">Snippets</span>
                  <button
                    type="button"
                    onClick={() => setSavingSnippet(true)}
                    disabled={!text.trim()}
                    className="w-6 h-6 flex items-center justify-center rounded text-text-tertiary hover:text-accent-light hover:bg-bg-card transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    data-tip={tt('Save current text as a snippet', 'Salvar o texto atual como snippet')}
                  >
                    <BookmarkPlus size={13} />
                  </button>
                </div>

                {savingSnippet && (
                  <div className="px-3 pb-2 shrink-0 flex flex-col gap-2">
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
                )}

                {snippets.length > 0 && (
                  <div className="px-3 pb-2 shrink-0">
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

                <div className="flex-1 min-h-0 overflow-y-auto border-t border-border-subtle">
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
                            onClick={() => handleInsertSnippet(s)}
                            disabled={deletingSnippetId === s.id}
                            className="flex-1 text-left min-w-0 disabled:cursor-default"
                          >
                            <div className="text-xs font-medium text-text-primary truncate">{s.name}</div>
                            <div className="text-[11px] text-text-tertiary line-clamp-2 mt-0.5">{s.text}</div>
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
                                className="shrink-0 p-1 text-text-disabled hover:text-accent-light transition-colors opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                              >
                                <Pencil size={12} />
                              </button>
                              <button
                                type="button"
                                onClick={() => setDeletingSnippetId(s.id)}
                                className="shrink-0 p-1 text-text-disabled hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
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
            </div>
          )}
        </div>

        {/* ── Clipboard Surface — overlay INSIDE the relative body wrapper. ── */}
        {surface && (
          <ClipboardSurface
            state={clipState}
            onStateChange={(updater) => {
              setClipState(updater);
              setClipDirty(true);
            }}
            onBack={closeSurface}
            onReset={handleSurfaceReset}
          />
        )}
      </div>

      {/* Name prompt for {Variable…}/{Row column…} (portal — sits above everything). */}
      {namePrompt && (
        <NamePromptPopover
          kind={namePrompt.kind}
          anchor={namePrompt.anchor}
          onInsert={(token) => lexicalApiRef.current?.insertToken(token)}
          onClose={() => setNamePrompt(null)}
        />
      )}
    </DialogShell>
  );
}
