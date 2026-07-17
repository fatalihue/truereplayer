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

type TokenKind = 'clipboard' | 'delay' | 'repeatable' | 'random' | 'var' | 'rowcol' | 'input' | 'static';

function getTokenKind(token: string): TokenKind {
  const inner = token.slice(1, -1);
  const name = inner.split(':')[0].toLowerCase();
  if (name === 'clipboard') return 'clipboard';
  if (name === 'delay') return 'delay';
  if (name === 'random') return 'random';
  // {var:name} edits its variable name; bare {row} is a static counter while
  // {row:column} edits its data-table column name.
  if (name === 'var') return 'var';
  if (name === 'row' && inner.includes(':')) return 'rowcol';
  if (name === 'input') return 'input';
  if (REPEATABLE_TOKEN_NAMES.has(name)) return 'repeatable';
  return 'static';
}

// The name arg of {var:...}/{row:...} — verbatim (normalizeToken never touches it).
function parseNameArg(token: string): string {
  const inner = token.slice(1, -1);
  const idx = inner.indexOf(':');
  return idx >= 0 ? inner.slice(idx + 1) : '';
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

function parseRandom(token: string): { min: number; max: number } {
  const inner = token.slice(1, -1);
  const m = inner.match(/^random:(\d+)-(\d+)$/i);
  if (!m) return { min: 1, max: 10 };
  const a = parseInt(m[1], 10);
  const b = parseInt(m[2], 10);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { min: 1, max: 10 };
  return a <= b ? { min: a, max: b } : { min: b, max: a };
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
    // Also reposition on scroll (capture phase so a scroll in ANY ancestor container counts) —
    // otherwise scrolling the editor leaves the popover detached from its chip.
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
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
      // Marker for host-level Esc routers (SendTextDialog): when a chip popover
      // is open, its own capture-phase Esc owns the key — routers must stand down.
      data-token-popover=""
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        ...visibilityStyle,
        zIndex: 100,
        width: kind === 'clipboard' ? 300 : 260,
        background: 'var(--color-bg-elevated, #2d2d2d)',
        border: '1px solid color-mix(in srgb, var(--color-accent-solid) 35%, transparent)',
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
        {kind === 'random' && <RandomEditor token={token} onChange={updateLive} />}
        {kind === 'var' && <NameEditor token={token} tokenName="var" onChange={updateLive} />}
        {kind === 'rowcol' && <NameEditor token={token} tokenName="row" onChange={updateLive} />}
        {kind === 'input' && <InputEditor token={token} onChange={updateLive} />}
        {kind === 'static' && <StaticInfo token={token} />}
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
      <div
        className="text-xs font-mono flex-1 truncate"
        style={{ color: 'var(--color-action-sendtext-fg)' }}
      >
        {token}
      </div>
      <button
        type="button"
        onClick={onClose}
        className="text-text-tertiary hover:text-text-primary text-sm leading-none px-1"
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

  // Report changes only on real user input — NOT from a mount-time effect, which would emit a
  // canonicalized token (e.g. {delay} → {delay:500}) and make merely opening then closing the
  // chip silently rewrite it.
  // Clamp to the backend's 60000ms cap here since the local NumInput has no max prop.
  const update = (v: number) => { const c = Math.min(60000, v); setMs(c); onChange(`{delay:${c}}`); };

  return (
    <Section label="Delay">
      <div className="flex items-center gap-2 py-1">
        {/* width here is the TOTAL span (input + the two 24px steppers), unlike the dialogs'
            inputWidth which sizes the input alone — so it needs extra room to fit "60.000 ms". */}
        <NumInput value={ms} onChange={update} min={0} width={140} thousands suffix="ms" suffixInside />
      </div>
      <div className="text-[10px] text-text-tertiary mt-1">
        Pause for this long before continuing.
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

  // Report changes only on real user input — NOT from a mount-time effect, which would emit a
  // canonicalized token (e.g. {enter:1} → {enter}) and make opening then closing the chip rewrite it.
  const update = (v: number) => { setN(v); onChange(v > 1 ? `{${initial.name}:${v}}` : `{${initial.name}}`); };

  return (
    <Section label="Repeat">
      <div className="flex items-center gap-2 py-1">
        <NumInput value={n} onChange={update} min={1} width={70} />
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

function RandomEditor({ token, onChange }: { token: string; onChange: (t: string) => void }) {
  const initial = parseRandom(token);
  const [min, setMin] = useState(initial.min);
  const [max, setMax] = useState(initial.max);

  // Report changes only on real user input (see DelayEditor note) — merely opening
  // the chip must not rewrite it. Reversed bounds are legal; the backend swaps.
  const update = (nextMin: number, nextMax: number) => {
    setMin(nextMin);
    setMax(nextMax);
    onChange(`{random:${nextMin}-${nextMax}}`);
  };

  return (
    <Section label="Random number">
      <div className="flex items-center gap-2 py-1">
        <NumInput value={min} onChange={(v) => update(v, max)} min={0} width={86} thousands />
        <span className="text-[11px] text-text-tertiary">to</span>
        <NumInput value={max} onChange={(v) => update(min, v)} min={0} width={86} thousands />
      </div>
      <div className="text-[10px] text-text-tertiary mt-1">
        A fresh integer between the two bounds (inclusive) each time this text runs.
      </div>
    </Section>
  );
}

// Shared editor for the name-bearing tokens: {var:name} (runtime variable) and
// {row:column} (data-table column). Emits only on real input with a non-empty
// name — clearing the field never emits a broken `{var:}`, and merely opening
// then closing the chip never rewrites it (same guard family as DelayEditor).
function NameEditor({
  token,
  tokenName,
  onChange,
}: {
  token: string;
  tokenName: 'var' | 'row';
  onChange: (t: string) => void;
}) {
  const [name, setName] = useState(() => parseNameArg(token));
  const label = tokenName === 'var' ? 'Variable name' : 'Data column';

  const update = (raw: string) => {
    // Same charset the typing grammar chips ([A-Za-z0-9_]) — anything else
    // would produce a token the editor immediately un-chips on round-trip.
    const clean = raw.replace(/[^A-Za-z0-9_]/g, '');
    setName(clean);
    if (clean.length > 0) onChange(`{${tokenName}:${clean}}`);
  };

  return (
    <Section label={label}>
      <div className="py-1">
        <input
          type="text"
          value={name}
          onChange={(e) => update(e.target.value)}
          autoFocus
          spellCheck={false}
          placeholder={tokenName === 'var' ? 'name' : 'column'}
          className="h-7 w-full px-2 text-xs font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid placeholder:text-text-disabled"
        />
      </div>
      <div className="text-[10px] text-text-tertiary mt-1">
        {tokenName === 'var'
          ? 'Replaced with the value a Set Variable action stored under this name.'
          : "Replaced with this column's cell of the current data row (loop over data)."}
      </div>
    </Section>
  );
}

// Splits an {input:Label|menu:a,b,c} token into its label and (raw) menu CSV. The label may
// itself contain ':' — everything up to the FIRST "|menu:" is the label (the backend's regex
// and normalizeToken agree: label = [^}|]+, menu after |menu:).
function parseInputArg(token: string): { label: string; menu: string } {
  const arg = parseNameArg(token); // everything after the first ':'
  const mi = arg.indexOf('|menu:');
  return mi >= 0 ? { label: arg.slice(0, mi), menu: arg.slice(mi + 6) } : { label: arg, menu: '' };
}

// Editor for {input:Label} / {input:Label|menu:a,b,c} — the Ask-Input token. The label allows
// spaces (unlike variable/column names); a non-empty menu CSV turns the runtime prompt into a
// dropdown. '{', '}' and '|' are stripped from both fields since they'd break the token grammar.
// An empty label never emits (would produce a broken {input:}).
function InputEditor({ token, onChange }: { token: string; onChange: (t: string) => void }) {
  const parsed = parseInputArg(token);
  const [label, setLabel] = useState(parsed.label);
  const [menu, setMenu] = useState(parsed.menu);

  const emit = (l: string, m: string) => {
    const lc = l.trim();
    if (lc.length === 0) return;
    const mc = m.trim();
    onChange(mc.length > 0 ? `{input:${lc}|menu:${mc}}` : `{input:${lc}}`);
  };
  const onLabel = (raw: string) => {
    const clean = raw.replace(/[{}|]/g, '');
    setLabel(clean);
    emit(clean, menu);
  };
  const onMenu = (raw: string) => {
    const clean = raw.replace(/[{}|]/g, '');
    setMenu(clean);
    emit(label, clean);
  };

  return (
    <>
      <Section label="Prompt label">
        <div className="py-1">
          <input
            type="text"
            value={label}
            onChange={(e) => onLabel(e.target.value)}
            autoFocus
            spellCheck={false}
            placeholder="What to ask"
            className="h-7 w-full px-2 text-xs bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid placeholder:text-text-disabled"
          />
        </div>
        <div className="text-[10px] text-text-tertiary mt-1">
          Replay pauses and shows this prompt; your answer is substituted (and reusable as {'{var:label}'}).
        </div>
      </Section>
      <Section label="Menu options (optional)">
        <div className="py-1">
          <input
            type="text"
            value={menu}
            onChange={(e) => onMenu(e.target.value)}
            spellCheck={false}
            placeholder="Yes,No,Maybe"
            className="h-7 w-full px-2 text-xs bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid placeholder:text-text-disabled"
          />
        </div>
        <div className="text-[10px] text-text-tertiary mt-1">
          Comma-separated → the prompt becomes a dropdown instead of a text field.
        </div>
      </Section>
    </>
  );
}

// Zero-pads to two digits — matches the backend's dd/MM/yyyy HH:mm:ss formats.
function p2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

// Live resolved value / description for tokens without editable parameters.
// Date/time formats mirror the backend's ResolveDateTimeTokens exactly.
function staticTokenInfo(token: string): { value?: string; note?: string } {
  const name = token.slice(1, -1).split(':')[0].toLowerCase();
  const now = new Date();
  const date = `${p2(now.getDate())}/${p2(now.getMonth() + 1)}/${now.getFullYear()}`;
  const time = `${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
  switch (name) {
    case 'date': return { value: date };
    case 'time': return { value: time };
    case 'datetime': return { value: `${date} - ${time}` };
    case 'counter': return { note: 'Replaced with the current loop iteration (1, 2, 3…) while replaying.' };
    case 'row': return { note: "Replaced with the current action's grid row number while replaying." };
    default: return {};
  }
}

function StaticInfo({ token }: { token: string }) {
  const { value, note } = staticTokenInfo(token);
  if (value) {
    return (
      <div className="px-3.5 py-3">
        <div className="text-[10px] uppercase tracking-wide font-semibold text-text-tertiary mb-1">
          Resolves now to
        </div>
        <div className="text-xs font-mono text-text-primary bg-bg-input border border-border-subtle rounded px-2 py-1">
          {value}
        </div>
      </div>
    );
  }
  return (
    <div className="px-3.5 py-3 text-[11px] text-text-tertiary">
      {note ?? 'This token has no editable parameters. Use Delete to remove it.'}
    </div>
  );
}
