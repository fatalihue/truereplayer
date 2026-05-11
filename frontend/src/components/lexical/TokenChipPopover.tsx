import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { Trash2, Wand2 } from 'lucide-react';
import { ClipboardModifierBody } from './ClipboardModifierBody';
import { useClipboardContent } from './useClipboardContent';
import {
  buildClipboardToken,
  parseClipboardToken,
  type TransformState,
} from './clipboardModifiers';
import { NumInput, Section } from './popoverAtoms';
import { normalizeToken } from './tokenNormalize';

// Tokens that accept a `:N` repeat count (e.g. {enter:5}).
const REPEATABLE_TOKEN_NAMES = new Set([
  'enter',
  'tab',
  'space',
  'backspace',
  'delete',
  'escape',
  'home',
  'end',
  'pageup',
  'pagedown',
  'up',
  'down',
  'left',
  'right',
]);

type TokenKind = 'clipboard' | 'delay' | 'repeatable' | 'static';

function getTokenKind(token: string): TokenKind {
  const inner = token.slice(1, -1);
  const name = inner.split(':')[0].toLowerCase();
  if (name === 'clipboard') return 'clipboard';
  if (name === 'delay') return 'delay';
  if (REPEATABLE_TOKEN_NAMES.has(name)) return 'repeatable';
  return 'static';
}

function parseRepeatable(token: string): { name: string; n: number } {
  const inner = token.slice(1, -1);
  const [name, modN] = inner.split(':');
  const parsed = modN !== undefined ? parseInt(modN, 10) : 1;
  return { name, n: !Number.isFinite(parsed) || parsed < 1 ? 1 : parsed };
}

function parseDelay(token: string): { ms: number } {
  const inner = token.slice(1, -1);
  const parts = inner.split(':');
  const parsed = parts[1] !== undefined ? parseInt(parts[1], 10) : 500;
  return { ms: !Number.isFinite(parsed) || parsed < 0 ? 500 : parsed };
}

interface TokenChipPopoverProps {
  anchor: HTMLElement;
  token: string;
  onLiveChange: (newToken: string) => void;
  onDelete: () => void;
  onClose: () => void;
}

// Visual shell for chip editing. The owning TokenChip holds the live token in
// a ref and decides whether to commit on close — this component is purely
// presentational + emits onLiveChange/onClose. That layout means every close
// path (Esc, outside click, ✕, clicking the chip again) funnels through the
// same TokenChip.handleClose, so no path can lose unsaved edits.
export function TokenChipPopover({
  anchor,
  token,
  onLiveChange,
  onDelete,
  onClose,
}: TokenChipPopoverProps) {
  const kind = getTokenKind(token);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // Local state so the header can show the live token; mirror to onLiveChange
  // so the parent's commit-on-close has the latest value to apply. We normalise
  // here so the header preview matches the eventual chip display character-by-
  // character (the chip itself re-normalises on setToken — belt and suspenders).
  const [liveToken, setLiveToken] = useState(() => normalizeToken(token));
  const updateLive = useCallback(
    (next: string) => {
      const normalized = normalizeToken(next);
      setLiveToken(normalized);
      onLiveChange(normalized);
    },
    [onLiveChange],
  );

  // Position below the chip (above if it would overflow the viewport).
  useLayoutEffect(() => {
    if (!anchor || !popRef.current) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const popH = popRef.current!.offsetHeight;
      const popW = popRef.current!.offsetWidth;
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      let left = r.left;
      let top = r.bottom + 6;
      if (top + popH > vh - 8) top = Math.max(8, r.top - popH - 6);
      if (left + popW > vw - 8) left = vw - popW - 8;
      if (left < 8) left = 8;
      setPos({ left, top });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor, kind, token]);

  // Dismiss on outside click or Escape — both delegate to onClose, which the
  // parent maps to its commit-and-close handler.
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t)) return;
      if (anchor.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [anchor, onClose]);

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
        width: kind === 'clipboard' ? 300 : 260,
        background: 'var(--color-bg-elevated, #2d2d2d)',
        border: '1px solid rgba(96, 205, 255, 0.35)',
        boxShadow: '0 16px 40px rgba(0, 0, 0, 0.55)',
        animation: 'token-chip-pop-in 0.14s ease',
        maxHeight: 'calc(100vh - 24px)',
      }}
      className="rounded-lg overflow-hidden flex flex-col"
    >
      <style>{`@keyframes token-chip-pop-in {
        from { opacity: 0; transform: translateY(-3px) scale(0.98); }
        to   { opacity: 1; transform: translateY(0)    scale(1); }
      }`}</style>

      <Header token={liveToken} onClose={onClose} />

      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
        {kind === 'clipboard' && <ClipboardEditor token={token} onChange={updateLive} />}
        {kind === 'delay' && <DelayEditor token={token} onChange={updateLive} />}
        {kind === 'repeatable' && <RepeatableEditor token={token} onChange={updateLive} />}
        {kind === 'static' && <StaticInfo />}
      </div>

      <Footer kind={kind} onDelete={onDelete} />
    </div>,
    document.body,
  );
}

function Header({ token, onClose }: { token: string; onClose: () => void }) {
  return (
    <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-border-subtle bg-bg-card shrink-0">
      <Wand2 size={14} className="text-accent-light shrink-0" />
      <div className="text-xs font-mono text-[#f0abfc] flex-1 truncate" title={token}>
        {token}
      </div>
      <button
        type="button"
        onClick={onClose}
        className="text-text-tertiary hover:text-text-primary text-sm leading-none px-1"
        title="Close"
      >
        ✕
      </button>
    </div>
  );
}

function Footer({
  kind,
  onDelete,
}: {
  kind: TokenKind;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-3.5 py-2 bg-bg-card border-t border-border-subtle shrink-0">
      <button
        type="button"
        onClick={onDelete}
        className="flex items-center gap-1 h-7 px-2 text-[11px] rounded text-red-300 hover:bg-red-500/15 border border-transparent hover:border-red-500/30 transition-colors"
        title="Remove this token"
      >
        <Trash2 size={12} />
        Delete
      </button>
      {kind === 'static' && (
        <span className="text-[10px] text-text-tertiary italic">No parameters</span>
      )}
    </div>
  );
}

// ── Editors per token kind ──────────────────────────────────────────────────
//
// Each editor manages its own local state and reports the latest token via
// onChange (synchronous). The popover lifts that into liveToken and the parent
// chip into liveTokenRef — neither triggers a chip update, so the controlled
// inputs are never re-rendered by an editor.update() round-trip mid-typing.

function ClipboardEditor({
  token,
  onChange,
}: {
  token: string;
  onChange: (t: string) => void;
}) {
  const [state, setState] = useState<TransformState>(() => parseClipboardToken(token));
  const { clipRaw, clipReady } = useClipboardContent();
  const newToken = useMemo(() => buildClipboardToken(state), [state]);

  useEffect(() => {
    onChange(newToken);
  }, [newToken, onChange]);

  return (
    <ClipboardModifierBody
      state={state}
      setState={setState}
      clipRaw={clipRaw}
      clipReady={clipReady}
    />
  );
}

function DelayEditor({ token, onChange }: { token: string; onChange: (t: string) => void }) {
  const initial = parseDelay(token);
  const [ms, setMs] = useState(initial.ms);

  useEffect(() => {
    onChange(`{delay:${ms}}`);
  }, [ms, onChange]);

  return (
    <Section label="Delay">
      <div className="flex items-center gap-2 py-1">
        <NumInput value={ms} onChange={setMs} min={0} width={80} />
        <span className="text-[11px] text-text-tertiary">milliseconds</span>
      </div>
      <div className="text-[10px] text-text-tertiary mt-1">
        Pause for this many ms before continuing.
      </div>
    </Section>
  );
}

function RepeatableEditor({
  token,
  onChange,
}: {
  token: string;
  onChange: (t: string) => void;
}) {
  const initial = parseRepeatable(token);
  const [n, setN] = useState(initial.n);
  const next = n > 1 ? `{${initial.name}:${n}}` : `{${initial.name}}`;

  useEffect(() => {
    onChange(next);
  }, [next, onChange]);

  return (
    <Section label="Repeat">
      <div className="flex items-center gap-2 py-1">
        <NumInput value={n} onChange={setN} min={1} width={70} />
        <span className="text-[11px] text-text-tertiary">
          time{n === 1 ? '' : 's'}
        </span>
      </div>
      <div className="text-[10px] text-text-tertiary mt-1">
        Press <code className="text-accent-light">{`{${initial.name}}`}</code> {n}× when this action runs.
      </div>
    </Section>
  );
}

function StaticInfo() {
  return (
    <div className="px-3.5 py-3 text-[11px] text-text-tertiary">
      This token has no editable parameters. Use Delete to remove it.
    </div>
  );
}
