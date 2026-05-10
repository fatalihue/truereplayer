import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Smile, Clock, BookmarkPlus, Trash2, ChevronRight, ChevronLeft, Wand2 } from 'lucide-react';
import EmojiPicker, { Theme } from 'emoji-picker-react';
import type { EmojiClickData } from 'emoji-picker-react';
import { useBridge } from '../bridge/BridgeContext';

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
      { var: '{space}', label: 'Space' },
      { var: '{backspace}', label: 'Bksp' },
      { var: '{delete}', label: 'Del' },
      { var: '{escape}', label: 'Esc' },
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
      { var: '{pageup}', label: 'PgUp' },
      { var: '{pagedown}', label: 'PgDn', breakAfter: true },
      { var: '{up}', label: '↑' },
      { var: '{down}', label: '↓' },
      { var: '{left}', label: '←' },
      { var: '{right}', label: '→' },
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

// Render text with highlighted variables — accepts multi-segment tokens like
// {clipboard:trim:line:1:first:8} so clipboard modifiers stay highlighted.
function renderHighlightedText(text: string): React.ReactNode[] {
  if (!text) return [<span key="empty">{'\n'}</span>];

  const regex = /\{([a-zA-Z]+(?::[a-zA-Z0-9]+)*)\}/g;
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
        // No padding/margin: any horizontal box affecting layout would push the
        // highlight overlay out of sync with the textarea caret beneath it. The
        // background + rounded corners already give a clear visual cue.
        className={
          isValid
            ? 'text-[#f0abfc] bg-[#d946ef]/15 rounded-sm'
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

// ── Clipboard Transform builder ──

type CaseTransform = 'none' | 'upper' | 'lower' | 'sentence' | 'title';
type Extract = 'none' | 'line' | 'word';
type Limit = 'none' | 'first' | 'last';

interface TransformState {
  trim: boolean;
  case: CaseTransform;
  extract: Extract;
  extractN: number;
  limit: Limit;
  limitN: number;
}

const DEFAULT_TRANSFORM: TransformState = {
  trim: false,
  case: 'none',
  extract: 'none',
  extractN: 1,
  limit: 'none',
  limitN: 10,
};

// Build the {clipboard[:mods]} token. Order MUST match backend ApplyClipboardModifiers:
// trim → line/word → first/last → upper/lower.
function buildClipboardToken(s: TransformState): string {
  const parts = ['clipboard'];
  if (s.trim) parts.push('trim');
  if (s.extract === 'line') parts.push('line', String(s.extractN));
  else if (s.extract === 'word') parts.push('word', String(s.extractN));
  if (s.limit === 'first') parts.push('first', String(s.limitN));
  else if (s.limit === 'last') parts.push('last', String(s.limitN));
  if (s.case === 'upper') parts.push('upper');
  else if (s.case === 'lower') parts.push('lower');
  else if (s.case === 'sentence') parts.push('sentence');
  else if (s.case === 'title') parts.push('title');
  return '{' + parts.join(':') + '}';
}

// Mirror of backend ApplyClipboardModifiers — used only for the live preview.
function applyTransformPreview(raw: string, s: TransformState): string {
  let r = raw;
  if (s.trim) r = r.trim();
  if (s.extract === 'line') {
    const lines = r.replace(/\r\n/g, '\n').split('\n');
    r = lines[s.extractN - 1] ?? '';
  } else if (s.extract === 'word') {
    const words = r.split(/\s+/).filter(Boolean);
    r = words[s.extractN - 1] ?? '';
  }
  if (s.limit === 'first') r = r.slice(0, Math.max(0, s.limitN));
  else if (s.limit === 'last') r = s.limitN <= 0 ? '' : r.slice(-s.limitN);
  if (s.case === 'upper') r = r.toUpperCase();
  else if (s.case === 'lower') r = r.toLowerCase();
  else if (s.case === 'sentence') r = r.length > 0 ? r[0].toUpperCase() + r.slice(1) : r;
  else if (s.case === 'title') r = r.replace(/(^|\s)(\S)/g, (_, ws, ch) => ws + ch.toUpperCase());
  return r;
}

interface ClipboardTransformPopoverProps {
  onInsert: (token: string) => void;
  onClose: () => void;
}

function ClipboardTransformPopover({ onInsert, onClose }: ClipboardTransformPopoverProps) {
  const { send, subscribe } = useBridge();
  const [state, setState] = useState<TransformState>(DEFAULT_TRANSFORM);
  const [clipRaw, setClipRaw] = useState<string>('');
  const [clipReady, setClipReady] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  // Read clipboard on open
  useEffect(() => {
    const off = subscribe((msg) => {
      if (msg.type === 'clipboard:content') {
        setClipRaw(msg.payload.text || '');
        setClipReady(true);
      }
    });
    send({ type: 'clipboard:read', payload: {} });
    return off;
  }, [send, subscribe]);

  // Click-outside to dismiss
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const token = useMemo(() => buildClipboardToken(state), [state]);
  const preview = useMemo(() => applyTransformPreview(clipRaw, state), [clipRaw, state]);

  const toggleCase = (v: 'upper' | 'lower' | 'sentence' | 'title') =>
    setState((s) => ({ ...s, case: s.case === v ? 'none' : v }));

  const setExtract = (v: Extract) => setState((s) => ({ ...s, extract: v }));
  const setLimit = (v: Limit) => setState((s) => ({ ...s, limit: v }));
  const setExtractN = (n: number) => setState((s) => ({ ...s, extractN: Math.max(1, n) }));
  const setLimitN = (n: number) => setState((s) => ({ ...s, limitN: Math.max(0, n) }));

  const handleInsert = () => {
    onInsert(token);
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

      {/* Header (pinned) */}
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

      {/* Scrollable middle (laid out as a flex column so the preview block
          can grow to fill any leftover height — keeps the popover seamless). */}
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">

      {/* Transform case — 2-col grid (column-flow) so 5 options fit the available
          width without growing the popover. Case options share a single radio-style
          state, so combinations like UPPERCASE + Capitalize are impossible by
          construction. Trim is orthogonal (whitespace, not case). */}
      <Section label="Transform">
        <div className="grid grid-flow-col grid-rows-3 gap-x-3">
          <CheckRow
            checked={state.trim}
            onChange={() => setState((s) => ({ ...s, trim: !s.trim }))}
            label="Trim"
          />
          <CheckRow
            checked={state.case === 'upper'}
            onChange={() => toggleCase('upper')}
            label="UPPERCASE"
          />
          <CheckRow
            checked={state.case === 'lower'}
            onChange={() => toggleCase('lower')}
            label="lowercase"
          />
          <CheckRow
            checked={state.case === 'sentence'}
            onChange={() => toggleCase('sentence')}
            label="Sentence case"
          />
          <CheckRow
            checked={state.case === 'title'}
            onChange={() => toggleCase('title')}
            label="Title Case"
          />
        </div>
      </Section>

      {/* Extract */}
      <Section label="Extract">
        <RadioRow checked={state.extract === 'none'} onChange={() => setExtract('none')} label="Everything" />
        <RadioRow
          checked={state.extract === 'line'}
          onChange={() => setExtract('line')}
          label="Line #"
          input={
            <NumInput
              value={state.extractN}
              onChange={setExtractN}
              disabled={state.extract !== 'line'}
              min={1}
            />
          }
        />
        <RadioRow
          checked={state.extract === 'word'}
          onChange={() => setExtract('word')}
          label="Word #"
          input={
            <NumInput
              value={state.extractN}
              onChange={setExtractN}
              disabled={state.extract !== 'word'}
              min={1}
            />
          }
        />
      </Section>

      {/* Limit */}
      <Section label="Limit length">
        <RadioRow checked={state.limit === 'none'} onChange={() => setLimit('none')} label="None" />
        <RadioRow
          checked={state.limit === 'first'}
          onChange={() => setLimit('first')}
          label="First N chars"
          input={
            <NumInput
              value={state.limitN}
              onChange={setLimitN}
              disabled={state.limit !== 'first'}
              min={0}
            />
          }
        />
        <RadioRow
          checked={state.limit === 'last'}
          onChange={() => setLimit('last')}
          label="Last N chars"
          input={
            <NumInput
              value={state.limitN}
              onChange={setLimitN}
              disabled={state.limit !== 'last'}
              min={0}
            />
          }
        />
      </Section>

      {/* Preview — flex-1 makes it absorb leftover height inside the middle */}
      <div className="px-3.5 py-1.5 bg-bg-surface border-b border-border-subtle flex-1">
        <div className="text-[9px] uppercase tracking-wide text-text-tertiary mb-0.5">Clipboard</div>
        <div
          className="font-mono text-[10.5px] text-text-secondary bg-white/[0.03] border-l-2 border-border-subtle px-2 py-0.5 mb-1.5 rounded-r whitespace-pre-wrap break-all max-h-[36px] overflow-auto"
          style={{ lineHeight: 1.35 }}
        >
          {clipReady
            ? clipRaw === ''
              ? <span className="italic text-text-disabled">(empty)</span>
              : clipRaw
            : <span className="italic text-text-disabled">Reading...</span>}
        </div>
        <div className="text-[9px] uppercase tracking-wide text-text-tertiary mb-0.5">Token</div>
        <div className="font-mono text-[11.5px] px-2 py-0.5 mb-1.5 rounded text-[#f0abfc] bg-[#d946ef]/10 break-all">
          {token}
        </div>
        <div className="text-[9px] uppercase tracking-wide text-text-tertiary mb-0.5">Preview</div>
        <div
          className="font-mono text-[11px] px-2 py-0.5 rounded border-l-2 break-all min-h-[20px]"
          style={{
            background: 'rgba(107, 203, 119, 0.08)',
            borderColor: 'rgba(107, 203, 119, 0.5)',
            color: '#6bcb77',
          }}
        >
          {preview === '' ? <span className="italic text-text-disabled">(empty)</span> : preview}
        </div>
      </div>

      </div>{/* /scrollable middle */}

      {/* Footer (pinned) */}
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

// ── Small UI atoms used by the popover ──

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-3.5 py-1.5 border-b border-border-subtle">
      <div className="text-[10px] uppercase tracking-wide font-semibold text-text-tertiary mb-1">{label}</div>
      {children}
    </div>
  );
}

function CheckRow({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onChange}
      className="flex items-center gap-2 w-full py-0.5 text-xs text-text-secondary hover:text-text-primary"
    >
      <span
        className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center shrink-0 ${
          checked ? 'bg-accent-solid border-accent-solid' : 'bg-bg-input border-border-default'
        }`}
      >
        {checked && (
          <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
            <path d="M2 6.5L4.5 9L10 3" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <span className="flex-1 text-left">{label}</span>
    </button>
  );
}

function RadioRow({
  checked,
  onChange,
  label,
  input,
}: { checked: boolean; onChange: () => void; label: string; input?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 py-0.5 text-xs">
      <button
        type="button"
        onClick={onChange}
        className="flex items-center gap-2 flex-1 text-left text-text-secondary hover:text-text-primary"
      >
        <span
          className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center shrink-0 transition-colors ${
            checked
              ? 'bg-accent-solid border-accent-solid'
              : 'bg-bg-input border-border-default'
          }`}
        >
          {checked && <span className="w-[5px] h-[5px] rounded-full bg-white" />}
        </span>
        <span className="flex-1">{label}</span>
      </button>
      {input}
    </div>
  );
}

function NumInput({
  value,
  onChange,
  disabled,
  min = 0,
}: { value: number; onChange: (n: number) => void; disabled?: boolean; min?: number }) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      disabled={disabled}
      onChange={(e) => {
        const n = parseInt(e.target.value, 10);
        if (!isNaN(n)) onChange(n);
      }}
      onClick={(e) => e.stopPropagation()}
      className="w-[54px] h-7 px-1 text-[12px] font-mono text-center rounded border outline-none transition-colors bg-bg-input border-border-default text-text-primary focus:border-accent-solid disabled:opacity-50 disabled:cursor-not-allowed"
    />
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
  const [transformOpen, setTransformOpen] = useState(false);
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
                  {/* Repeat syntax tip */}
                  <div className="px-3 py-2 text-[10px] text-text-tertiary border-t border-border-subtle">
                    Tip: add <code className="text-accent-light">:N</code> to repeat — e.g. <code className="text-accent-light">{'{enter:5}'}</code> presses Enter 5×
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
