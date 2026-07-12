import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import {
  Table2, TriangleAlert, Repeat, Plus, Trash2, Wand2, Check, Copy,
  MoreHorizontal, ClipboardPaste,
} from 'lucide-react';
import { DialogShell } from './common/DialogShell';
import { Button } from './common/Button';
import { CheckboxBox } from './Checkbox';
import { useBridge } from '../bridge/BridgeContext';
import { useAppState } from '../state/AppStateContext';
import { useTt } from '../state/LanguageContext';
import { DataPasteSurface, type PasteMode } from './DataPasteSurface';
import { parseTsv, encodeTsv, deepEqualGrid, type Grid } from '../lib/tsv';

interface DataPanelProps {
  onClose: () => void;
}

const VALID_HEADER = /^[A-Za-z0-9_]+$/;
// One chip recipe everywhere (SheetPanel / Insert Text parity).
const CHIP_CLASS =
  'h-6 px-2 inline-flex items-center text-[11px] font-mono bg-bg-surface border border-border-subtle rounded text-text-secondary hover:text-warning hover:border-warning/40 transition-colors';
// Read-only render cap: beyond this the grid stays visible but cell editing is
// disabled (the paste surface remains the bulk editor). Keeps typing O(1) without
// speculative virtualization.
const READONLY_ROW_CAP = 2000;
const LARGE_TABLE_WARN = 1000;

// Render a cell value with invisible characters made visible: tab → ⇥, newline → ↵
// (dim glyphs). Without this a quoted multi-line cell reads identically to its
// first line and users can't tell why replay types "more" than they see.
function cellFragments(value: string): React.ReactNode {
  if (!/[\t\n]/.test(value)) return value;
  const parts = value.split(/(\t|\n)/);
  return parts.map((p, i) =>
    p === '\t' ? <span key={i} className="text-text-disabled">⇥</span>
    : p === '\n' ? <span key={i} className="text-text-disabled">↵</span>
    : <React.Fragment key={i}>{p}</React.Fragment>,
  );
}

// Synthesize the next free colN name against the existing headers.
function nextColName(headers: string[]): string {
  const taken = new Set(headers.map((h) => h.trim().toLowerCase()));
  let n = headers.length + 1;
  while (taken.has(`col${n}`)) n++;
  return `col${n}`;
}

// ── Single cell/header editor ───────────────────────────────────────────────
//
// Exactly ONE editor instance exists in the whole grid (the decisive scope trim:
// no roving focus, no selection model). Commit paths: Enter (+move down), Tab
// (+move right/left), blur, Ctrl+Enter (commit, then the event bubbles to the
// card so Ctrl+Enter also saves). Esc reverts. Every commit/revert key checks
// isComposing so IME composition never commits half-typed text.
function CellEditor({
  initial,
  multiline,
  onDone,
}: {
  initial: string;
  multiline: boolean;
  /** value=null → revert (no commit). nav: where to move the editor next. */
  onDone: (value: string | null, nav?: 'down' | 'right' | 'left') => void;
}) {
  const [val, setVal] = useState(initial);
  const doneRef = useRef(false);
  const finish = (commit: boolean, nav?: 'down' | 'right' | 'left') => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone(commit ? val : null, nav);
  };

  return (
    <textarea
      autoFocus
      rows={Math.min(4, val.split('\n').length)}
      value={val}
      spellCheck={false}
      onChange={(e) => setVal(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
          return;
        }
        if (e.key === 'Enter') {
          if (e.ctrlKey) {
            // Commit synchronously (gridRef updates in the same tick), do NOT
            // stop propagation — the card's Ctrl+Enter handler saves right after.
            finish(true);
            return;
          }
          if (multiline && (e.altKey || e.shiftKey)) return; // newline in-cell
          e.preventDefault();
          e.stopPropagation();
          finish(true, 'down');
          return;
        }
        if (e.key === 'Tab') {
          // preventDefault BEFORE DialogShell's focus trap walks tabbables.
          e.preventDefault();
          e.stopPropagation();
          finish(true, e.shiftKey ? 'left' : 'right');
        }
      }}
      className="w-full bg-transparent outline-none resize-none font-mono text-xs text-text-primary leading-[1.4] max-h-[88px] overflow-auto"
    />
  );
}

// ── Header ⋯ menu (body portal, NamePromptPopover chrome) ──────────────────
type HeaderMenuAction = 'copy' | 'insert-left' | 'insert-right' | 'move-left' | 'move-right' | 'delete';

function HeaderMenu({
  anchor,
  header,
  colIndex,
  colCount,
  onAction,
  onClose,
}: {
  anchor: HTMLElement;
  header: string;
  colIndex: number;
  colCount: number;
  onAction: (a: HeaderMenuAction) => void;
  onClose: () => void;
}) {
  const tt = useTt();
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [armedDelete, setArmedDelete] = useState(false);
  const name = header.trim();
  const valid = name !== '' && VALID_HEADER.test(name);

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
    // The menu owns its own Esc (capture) — the panel's router stands down on
    // the [data-popover] marker, same contract as TokenChipPopover.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [anchor, onClose]);

  const itemCls =
    'w-full flex items-center gap-2 px-3 h-7 text-[11px] text-text-secondary hover:text-text-primary hover:bg-bg-card transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

  const visibilityStyle: React.CSSProperties = pos
    ? { visibility: 'visible', left: pos.left, top: pos.top }
    : { visibility: 'hidden', left: 0, top: 0 };

  return ReactDOM.createPortal(
    <div
      ref={popRef}
      data-popover=""
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        ...visibilityStyle,
        zIndex: 100,
        width: 200,
        background: 'var(--color-bg-elevated, #2d2d2d)',
        border: '1px solid color-mix(in srgb, var(--color-accent-solid) 35%, transparent)',
        boxShadow: '0 16px 40px rgba(0, 0, 0, 0.55)',
      }}
      className="rounded-lg overflow-hidden py-1"
    >
      <button type="button" className={itemCls} disabled={!valid} onClick={() => { onAction('copy'); onClose(); }}>
        <Copy size={12} className="shrink-0" />
        <span className="font-mono truncate">{valid ? `Copy {row:${name}}` : tt('Invalid token name', 'Nome de token inválido')}</span>
      </button>
      <div className="h-px bg-border-subtle my-1" />
      <button type="button" className={itemCls} onClick={() => { onAction('insert-left'); onClose(); }}>
        <Plus size={12} className="shrink-0" /> {tt('Insert column left', 'Inserir coluna à esquerda')}
      </button>
      <button type="button" className={itemCls} onClick={() => { onAction('insert-right'); onClose(); }}>
        <Plus size={12} className="shrink-0" /> {tt('Insert column right', 'Inserir coluna à direita')}
      </button>
      <button type="button" className={itemCls} disabled={colIndex === 0} onClick={() => { onAction('move-left'); onClose(); }}>
        ← {tt('Move left', 'Mover à esquerda')}
      </button>
      <button type="button" className={itemCls} disabled={colIndex === colCount - 1} onClick={() => { onAction('move-right'); onClose(); }}>
        → {tt('Move right', 'Mover à direita')}
      </button>
      <div className="h-px bg-border-subtle my-1" />
      <button
        type="button"
        className={`${itemCls} ${armedDelete ? 'text-red-300 hover:text-red-200' : ''}`}
        onClick={() => {
          if (!armedDelete) { setArmedDelete(true); return; }
          onAction('delete');
          onClose();
        }}
      >
        <Trash2 size={12} className="shrink-0" />
        {armedDelete ? tt('Really delete column?', 'Apagar a coluna mesmo?') : tt('Delete column', 'Apagar coluna')}
      </button>
    </div>,
    document.body,
  );
}

// ── Memoized body row ───────────────────────────────────────────────────────
//
// Re-renders only when its row-array identity changes (setCell replaces one row)
// or the editor enters/leaves one of its cells — a cell commit re-renders one row.
const GridRow = memo(function GridRow({
  row,
  r,
  colCount,
  editingCol,
  readOnly,
  zebra,
  onEdit,
  onCellDone,
  onDuplicate,
  onDelete,
}: {
  row: string[];
  r: number;
  colCount: number;
  editingCol: number | null;
  readOnly: boolean;
  zebra: boolean;
  onEdit: (r: number, c: number) => void;
  onCellDone: (r: number, c: number, value: string | null, nav?: 'down' | 'right' | 'left') => void;
  onDuplicate: (r: number) => void;
  onDelete: (r: number) => void;
}) {
  return (
    <tr
      className={`group h-row border-b border-border-subtle transition-colors hover:bg-bg-elevated ${
        zebra ? 'bg-[color-mix(in_srgb,var(--color-text-primary)_1%,transparent)]' : ''
      }`}
    >
      <td className="sticky left-0 z-[5] bg-bg-surface shadow-[inset_-1px_0_0_var(--color-border-subtle)] text-[10px] text-text-tertiary tabular-nums text-right pr-2 select-none">
        {r + 1}
      </td>
      {Array.from({ length: colCount }, (_, c) => {
        const editing = editingCol === c;
        return (
          <td
            key={c}
            onClick={() => { if (!readOnly && !editing) onEdit(r, c); }}
            className={`px-2 text-xs font-mono text-text-secondary whitespace-nowrap truncate align-middle ${
              readOnly ? '' : 'cursor-text'
            } ${editing ? 'shadow-[inset_0_0_0_1.5px_var(--color-accent-solid)] bg-bg-input' : ''}`}
          >
            {editing ? (
              <CellEditor
                initial={row[c] ?? ''}
                multiline
                onDone={(value, nav) => onCellDone(r, c, value, nav)}
              />
            ) : (
              cellFragments(row[c] ?? '')
            )}
          </td>
        );
      })}
      <td className="relative">
        {!readOnly && (
          <span className="absolute right-1 top-1/2 -translate-y-1/2 hidden group-hover:flex gap-0.5">
            <button
              type="button"
              onClick={() => onDuplicate(r)}
              className="w-6 h-6 flex items-center justify-center rounded bg-bg-elevated border border-border-subtle text-text-tertiary hover:text-text-primary transition-colors"
              data-tip="Duplicate row"
            >
              <Copy size={11} />
            </button>
            <button
              type="button"
              onClick={() => onDelete(r)}
              className="w-6 h-6 flex items-center justify-center rounded bg-bg-elevated border border-border-subtle text-text-tertiary hover:text-red-400 transition-colors"
              data-tip="Delete row"
            >
              <Trash2 size={11} />
            </button>
          </span>
        )}
      </td>
    </tr>
  );
});

type Editing = { kind: 'cell'; r: number; c: number } | { kind: 'header'; c: number } | null;

export function DataPanel({ onClose }: DataPanelProps) {
  const { send } = useBridge();
  const { dataTable, actions, activeProfile } = useAppState();
  const tt = useTt();

  // ── Canonical state: arrays, not a TSV string. Quoting exists only in
  // lib/tsv.ts at the paste/copy boundary. gridRef mirrors state synchronously
  // so commit-then-save flows (Ctrl+Enter from the cell editor) read fresh data.
  const gridRef = useRef<Grid>({ headers: [], rows: [] });
  const [grid, setGridState] = useState<Grid>(gridRef.current);
  const updateGrid = useCallback((updater: (g: Grid) => Grid) => {
    gridRef.current = updater(gridRef.current);
    setGridState(gridRef.current);
  }, []);

  const loopRef = useRef(false);
  const [loopOverData, setLoopState] = useState(false);
  const setLoop = useCallback((v: boolean) => { loopRef.current = v; setLoopState(v); }, []);

  const [editing, setEditing] = useState<Editing>(null);
  const editingRef = useRef<Editing>(null);
  useEffect(() => { editingRef.current = editing; }, [editing]);

  const [headerMenu, setHeaderMenu] = useState<{ c: number; anchor: HTMLElement } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copiedTimer = useRef<number | undefined>(undefined);
  const [armedClear, setArmedClear] = useState(false);
  const [escArmed, setEscArmed] = useState(false);
  const escArmedRef = useRef(false);
  const escTimer = useRef<number | undefined>(undefined);

  // Paste sub-surface (state lifted here — the swapped shell footer needs it).
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteMode, setPasteMode] = useState<PasteMode>('replace');
  const [pasteFirstRowHeader, setPasteFirstRowHeader] = useState(true);
  const prefillRef = useRef('');

  // ── Seed ONCE from the store at mount (send data:request as a freshness ping).
  // Deliberately NOT re-seeding on later dataTable changes: the backend rides
  // data:table on every actions:updated (recording/browser pushes AND our own
  // save confirm), which would otherwise stomp the user's unsaved edits while
  // the panel is open. Treat any later dataTable dependency as a review defect.
  const seededRef = useRef(false);
  const seedRef = useRef<{ grid: Grid; loopOverData: boolean; wasNonEmpty: boolean } | null>(null);
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    send({ type: 'data:request', payload: {} });
    const headers = [...dataTable.headers];
    const rows = dataTable.rows.map((r) => [...r]);
    // Never truncate data: if any stored row is wider than the headers, extend
    // the headers with synthesized colN names instead.
    const width = rows.reduce((m, r) => Math.max(m, r.length), headers.length);
    while (headers.length < width) headers.push(nextColName(headers));
    gridRef.current = { headers, rows };
    setGridState(gridRef.current);
    loopRef.current = dataTable.loopOverData;
    setLoopState(dataTable.loopOverData);
    seedRef.current = {
      grid: { headers: [...headers], rows: rows.map((r) => [...r]) },
      loopOverData: dataTable.loopOverData,
      wasNonEmpty: headers.length > 0 || rows.length > 0,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Profile switch while open → close immediately: stale local state must never
  // save into another profile's table (latent bug in the pre-redesign panel).
  const initialProfileRef = useRef(activeProfile);
  useEffect(() => {
    if (activeProfile !== initialProfileRef.current) onClose();
  }, [activeProfile, onClose]);

  // ── Derived ──
  const dirty = useMemo(() => {
    const seed = seedRef.current;
    if (!seed) return false;
    return !deepEqualGrid(grid, seed.grid) || loopOverData !== seed.loopOverData;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid, loopOverData]);
  const dirtyNow = () => {
    const seed = seedRef.current;
    if (!seed) return false;
    return !deepEqualGrid(gridRef.current, seed.grid) || loopRef.current !== seed.loopOverData;
  };

  const emptyGrid = grid.headers.length === 0 && grid.rows.length === 0;
  const willClear = emptyGrid && !!seedRef.current?.wasNonEmpty;
  const readOnly = grid.rows.length > READONLY_ROW_CAP;

  const headerMeta = useMemo(() => {
    const seen = new Map<string, number>();
    return grid.headers.map((h) => {
      const name = h.trim();
      const key = name.toLowerCase();
      const dup = name !== '' && (seen.get(key) ?? 0) > 0;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      return { name, valid: name !== '' && VALID_HEADER.test(name), dup };
    });
  }, [grid.headers]);
  const invalidCount = headerMeta.filter((m) => !m.valid).length;

  // One shared scan: where {row:name} tokens are used across the profile's
  // actions (case-insensitive, trimmed — matching BuildRowDict semantics).
  const usage = useMemo(() => {
    const counts = new Map<string, number>();
    const re = /\{row:([A-Za-z0-9_]+)\}/gi;
    for (const a of actions) {
      const s = JSON.stringify(a);
      let m: RegExpExecArray | null;
      while ((m = re.exec(s)) !== null) {
        const k = m[1].toLowerCase();
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    return counts;
  }, [actions]);
  const orphans = useMemo(() => {
    const have = new Set(grid.headers.map((h) => h.trim().toLowerCase()));
    return [...usage.entries()].filter(([k]) => !have.has(k));
  }, [usage, grid.headers]);

  // Paste parse — debounced for the live preview; apply re-parses the CURRENT
  // text so the last keystrokes before Apply are never lost to the debounce.
  const [debouncedPaste, setDebouncedPaste] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedPaste(pasteText), 120);
    return () => window.clearTimeout(t);
  }, [pasteText]);
  const pasteParsed = useMemo(
    () => parseTsv(debouncedPaste, pasteFirstRowHeader),
    [debouncedPaste, pasteFirstRowHeader],
  );

  // ── Grid ops ──
  const handleEdit = useCallback((r: number, c: number) => setEditing({ kind: 'cell', r, c }), []);
  const handleCellDone = useCallback((r: number, c: number, value: string | null, nav?: 'down' | 'right' | 'left') => {
    if (value !== null) {
      updateGrid((g) => {
        const rows = [...g.rows];
        const row = [...(rows[r] ?? [])];
        while (row.length <= c) row.push('');
        row[c] = value;
        rows[r] = row;
        return { ...g, rows };
      });
    }
    const g = gridRef.current;
    if (value !== null && nav === 'down' && r + 1 < g.rows.length) setEditing({ kind: 'cell', r: r + 1, c });
    else if (value !== null && nav === 'right' && c + 1 < g.headers.length) setEditing({ kind: 'cell', r, c: c + 1 });
    else if (value !== null && nav === 'left' && c > 0) setEditing({ kind: 'cell', r, c: c - 1 });
    else setEditing(null);
  }, [updateGrid]);

  const handleHeaderDone = useCallback((c: number, value: string | null) => {
    if (value !== null) {
      // Headers are trimmed on commit (BuildRowDict trims for lookup); cells never are.
      updateGrid((g) => {
        const headers = [...g.headers];
        headers[c] = value.trim();
        return { ...g, headers };
      });
    }
    setEditing(null);
  }, [updateGrid]);

  const handleDuplicateRow = useCallback((r: number) => {
    updateGrid((g) => {
      const rows = [...g.rows];
      rows.splice(r + 1, 0, [...(g.rows[r] ?? [])]);
      return { ...g, rows };
    });
  }, [updateGrid]);
  const handleDeleteRow = useCallback((r: number) => {
    setEditing(null);
    updateGrid((g) => ({ ...g, rows: g.rows.filter((_, i) => i !== r) }));
  }, [updateGrid]);
  const addRow = () => {
    updateGrid((g) => ({ ...g, rows: [...g.rows, Array(Math.max(1, g.headers.length)).fill('')] }));
    // Open the first cell of the new row immediately.
    setEditing({ kind: 'cell', r: gridRef.current.rows.length - 1, c: 0 });
  };
  const addColumn = () => {
    updateGrid((g) => ({ ...g, headers: [...g.headers, nextColName(g.headers)] }));
    setEditing({ kind: 'header', c: gridRef.current.headers.length - 1 });
  };

  const headerMenuAction = (c: number, a: HeaderMenuAction) => {
    if (a === 'copy') {
      copyToken(`{row:${grid.headers[c].trim()}}`, `h${c}`);
      return;
    }
    setEditing(null);
    if (a === 'delete') {
      updateGrid((g) => ({
        headers: g.headers.filter((_, i) => i !== c),
        rows: g.rows.map((r) => r.filter((_, i) => i !== c)),
      }));
      return;
    }
    if (a === 'insert-left' || a === 'insert-right') {
      const at = a === 'insert-left' ? c : c + 1;
      updateGrid((g) => {
        const headers = [...g.headers];
        headers.splice(at, 0, nextColName(g.headers));
        return {
          headers,
          rows: g.rows.map((r) => {
            const row = [...r];
            while (row.length < g.headers.length) row.push('');
            row.splice(at, 0, '');
            return row;
          }),
        };
      });
      setEditing({ kind: 'header', c: at });
      return;
    }
    // move-left / move-right — swap adjacent columns (rows padded first).
    const to = a === 'move-left' ? c - 1 : c + 1;
    updateGrid((g) => {
      const headers = [...g.headers];
      [headers[c], headers[to]] = [headers[to], headers[c]];
      return {
        headers,
        rows: g.rows.map((r) => {
          const row = [...r];
          while (row.length < g.headers.length) row.push('');
          [row[c], row[to]] = [row[to], row[c]];
          return row;
        }),
      };
    });
  };

  const fixHeader = (c: number) => {
    updateGrid((g) => {
      const headers = [...g.headers];
      let base = headers[c].trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
      if (base === '') base = `col${c + 1}`;
      // Dedupe against the OTHER headers (case-insensitive).
      const others = new Set(headers.filter((_, i) => i !== c).map((h) => h.trim().toLowerCase()));
      let name = base;
      let n = 2;
      while (others.has(name.toLowerCase())) name = `${base}_${n++}`;
      headers[c] = name;
      return { ...g, headers };
    });
  };

  const clearTable = () => {
    setEditing(null);
    updateGrid(() => ({ headers: [], rows: [] }));
    setArmedClear(false);
  };

  const seedSample = () => {
    updateGrid(() => ({
      headers: ['name', 'email', 'amount'],
      rows: [
        ['Maria', 'maria@example.com', '89.90'],
        ['João', 'joao@example.com', '149.00'],
        ['Ana', 'ana@example.com', '32.50'],
      ],
    }));
  };

  const copyToken = (token: string, key: string) => {
    navigator.clipboard?.writeText(token).then(() => {
      setCopiedKey(key);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopiedKey(null), 1000);
    });
  };

  // ── Paste surface ──
  const openPaste = () => {
    const g = gridRef.current;
    const prefill = g.headers.length || g.rows.length ? encodeTsv(g.headers, g.rows) : '';
    prefillRef.current = prefill;
    setPasteText(prefill);
    setPasteMode('replace');
    setPasteFirstRowHeader(true);
    setPasteOpen(true);
  };
  const handlePasteModeChange = (m: PasteMode) => {
    // Switching to Append clears the box IFF it still equals the prefill —
    // otherwise the user would append the table to itself.
    if (m === 'append' && pasteText === prefillRef.current) setPasteText('');
    setPasteMode(m);
  };
  const applyPaste = () => {
    // Re-parse the LIVE text (the 120ms debounce may lag the preview).
    const parsed = parseTsv(pasteText, pasteFirstRowHeader);
    if (parsed.headers.length === 0) return;
    if (pasteMode === 'replace') {
      updateGrid(() => parsed);
    } else {
      // Append: map pasted columns onto existing headers by trimmed,
      // case-insensitive name (BuildRowDict semantics); unmatched pasted
      // columns become new headers; missing cells resolve empty.
      updateGrid((g) => {
        const headers = [...g.headers];
        const keyOf = (h: string) => h.trim().toLowerCase();
        const idxMap = parsed.headers.map((h) => {
          const i = headers.findIndex((eh) => keyOf(eh) === keyOf(h));
          if (i >= 0) return i;
          headers.push(h.trim());
          return headers.length - 1;
        });
        const newRows = parsed.rows.map((r) => {
          const out = Array(headers.length).fill('');
          r.forEach((cell, i) => { if (i < idxMap.length) out[idxMap[i]] = cell; });
          return out;
        });
        return { headers, rows: [...g.rows, ...newRows] };
      });
    }
    setPasteOpen(false);
  };

  // ── Save — instant close (DialogShell confirm doctrine: the backend persists
  // synchronously and re-pushes data:table, so the closing dialog IS the feedback).
  const handleSave = () => {
    if (!dirtyNow()) return;
    const g = gridRef.current;
    const rows = [...g.rows];
    // Parity with the old parseTsv: trailing all-empty rows are dropped; kept
    // rows are padded to the header count so the wire shape is rectangular.
    while (rows.length && rows[rows.length - 1].every((c) => c.trim() === '')) rows.pop();
    const padded = rows.map((r) => {
      const row = [...r];
      while (row.length < g.headers.length) row.push('');
      return row.slice(0, Math.max(g.headers.length, row.length));
    });
    send({ type: 'data:save', payload: { headers: g.headers, rows: padded, loopOverData: loopRef.current } });
    onClose();
  };

  // ── Esc router — ONE capture-phase ladder. Chip/header popovers own their Esc
  // ([data-popover] stand-down); the open cell editor owns its Esc (target-level
  // revert). Below those: paste surface → armed clear → dirty double-press arm →
  // (fall through to DialogShell's card handler = close with exit animation).
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('[data-popover]')) return;
      if (editingRef.current) return; // CellEditor reverts + stops propagation itself
      if (pasteOpen) {
        e.preventDefault();
        e.stopPropagation();
        setPasteOpen(false);
        return;
      }
      if (armedClear) {
        e.preventDefault();
        e.stopPropagation();
        setArmedClear(false);
        return;
      }
      if (dirtyNow() && !escArmedRef.current) {
        e.preventDefault();
        e.stopPropagation();
        escArmedRef.current = true;
        setEscArmed(true);
        window.clearTimeout(escTimer.current);
        escTimer.current = window.setTimeout(() => {
          escArmedRef.current = false;
          setEscArmed(false);
        }, 2500);
        return;
      }
      // Clean, or second Esc while armed → let DialogShell close the dialog.
    };
    document.addEventListener('keydown', onEsc, true);
    return () => document.removeEventListener('keydown', onEsc, true);
  }, [pasteOpen, armedClear]);

  // ── Status strip ──
  const stripLeft = (
    <span className="text-[11px] text-text-tertiary tabular-nums whitespace-nowrap">
      {grid.headers.length} {tt('columns', 'colunas')} · {grid.rows.length} {tt('rows', 'linhas')}
      {loopOverData && grid.rows.length > 0 && (
        <span style={{ color: 'var(--color-replay)' }}> · {grid.rows.length} {tt('iterations/run', 'iterações/execução')}</span>
      )}
      {dirty && <span className="text-warning"> · {tt('unsaved', 'não salvo')}</span>}
      {invalidCount > 0 && <span className="text-warning"> · {invalidCount} {tt('invalid', 'inválido(s)')}</span>}
    </span>
  );
  // Hint ladder — first match wins.
  const stripRight = (() => {
    const cls = 'text-[10px] truncate';
    if (editing) return <span className={`${cls} text-text-tertiary`}>{tt('Enter commits · Alt+Enter line break · Esc reverts', 'Enter confirma · Alt+Enter quebra linha · Esc reverte')}</span>;
    if (willClear) return <span className={`${cls} text-warning`}>{tt('Saving now clears the stored table.', 'Salvar agora apaga a tabela armazenada.')}</span>;
    if (loopOverData && grid.rows.length === 0) return <span className={`${cls} text-warning`}>{tt('Replay will refuse to start: no rows.', 'O replay vai recusar iniciar: sem linhas.')}</span>;
    if (escArmed) return <span className={`${cls} text-warning`}>{tt('Unsaved changes — press Esc again to discard.', 'Alterações não salvas — pressione Esc de novo para descartar.')}</span>;
    if (readOnly) return <span className={`${cls} text-warning`}>{tt('Large table — grid is read-only; edit via Paste / bulk edit.', 'Tabela grande — grade somente leitura; edite via Paste / bulk edit.')}</span>;
    if (grid.rows.length >= LARGE_TABLE_WARN) return <span className={`${cls} text-text-tertiary`}>{tt('Large table — the profile file grows with it.', 'Tabela grande — o arquivo do perfil cresce junto.')}</span>;
    if (!loopOverData && !emptyGrid) return <span className={`${cls} text-text-tertiary`}>{tt('Loop off: each run uses the next row. Right-click → Reset row position.', 'Loop desligado: cada execução usa a próxima linha. Botão direito → Reset row position.')}</span>;
    return <span className={`${cls} text-text-tertiary`}>{tt('Click a cell to edit · Ctrl+Enter saves', 'Clique numa célula para editar · Ctrl+Enter salva')}</span>;
  })();

  // ── Footer (swaps while the paste surface is open) ──
  const footerHint = pasteOpen ? (
    <>{tt('Tabs, quotes and line breaks survive the paste', 'Tabs, aspas e quebras de linha sobrevivem à colagem')}</>
  ) : (
    <>{tt('Loop on: one run per row. Loop off: each run advances one row (the cursor).', 'Loop ligado: uma execução por linha. Loop desligado: cada execução avança uma linha (o cursor).')}</>
  );

  const applyLabel = pasteMode === 'replace'
    ? tt('Replace table', 'Substituir tabela')
    : `${tt('Append', 'Adicionar')} ${pasteParsed.rows.length} ${tt('rows', 'linhas')}`;

  return (
    <DialogShell
      icon={<Table2 size={14} className="text-accent-light" />}
      title="Data Loop"
      widthClass="w-[1080px] h-[90vh] max-h-[900px]"
      maxWidthClass="max-w-[calc(100vw-24px)]"
      onClose={onClose}
      closeOnBackdrop={false}
      showClose
      footerHint={footerHint}
      footer={(requestClose) =>
        pasteOpen ? (
          <>
            <Button variant="secondary" onClick={() => setPasteOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={applyPaste} disabled={pasteParsed.headers.length === 0}>
              {applyLabel}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={requestClose}>Cancel</Button>
            {willClear ? (
              <span data-tip={tt('Saving an empty grid deletes the data table from this profile.', 'Salvar a grade vazia apaga a tabela de dados deste profile.')}>
                <Button variant="destructive" onClick={handleSave}>Clear table</Button>
              </span>
            ) : (
              <Button variant="primary" onClick={handleSave} disabled={!dirty}>Save</Button>
            )}
          </>
        )
      }
      onCardKeyDown={(e) => {
        // Ctrl+Enter routes by layer: paste surface → apply; otherwise save when
        // dirty. A cell editor commits itself on Ctrl+Enter (gridRef is synced
        // synchronously) and lets the event bubble here, so commit+save is one press.
        if (e.key === 'Enter' && e.ctrlKey) {
          e.preventDefault();
          if (pasteOpen) applyPaste();
          else handleSave();
        }
      }}
    >
      {/* Body — `relative` is load-bearing: the paste surface overlays inside it. */}
      <div className="relative flex flex-1 min-h-0">
        {/* ── Hero column: grid + status strip ── */}
        <div className="flex-1 min-w-0 flex flex-col">
          {emptyGrid ? (
            <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 bg-bg-surface">
              <Table2 size={24} className="text-text-tertiary" />
              <div className="text-sm text-text-primary">{tt('No data table', 'Sem tabela de dados')}</div>
              <div className="text-xs text-text-tertiary max-w-[340px] text-center leading-relaxed">
                {tt(
                  'Each row runs the profile once; columns become {row:column} tokens.',
                  'Cada linha executa o perfil uma vez; colunas viram tokens {row:coluna}.',
                )}
              </div>
              <div className="flex items-center gap-2 mt-1">
                <Button variant="primary" size="sm" onClick={openPaste}>
                  {tt('Paste table…', 'Colar tabela…')}
                </Button>
                <Button variant="ghost" size="sm" onClick={seedSample}>
                  {tt('Start with sample data', 'Começar com dados de exemplo')}
                </Button>
              </div>
            </div>
          ) : (
            <div
              tabIndex={-1}
              className="flex-1 min-h-0 overflow-auto bg-bg-surface outline-none"
            >
              <table
                className="border-separate border-spacing-0"
                style={{ minWidth: 44 + grid.headers.length * 160 + 36, tableLayout: 'fixed' }}
              >
                <colgroup>
                  <col style={{ width: 44 }} />
                  {grid.headers.map((_, i) => <col key={i} style={{ width: 160 }} />)}
                  <col style={{ width: 36 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th
                      onClick={() => copyToken('{row}', '__rownum')}
                      className="sticky top-0 left-0 z-20 bg-bg-surface shadow-[inset_-1px_0_0_var(--color-border-subtle),inset_0_-1px_0_var(--color-border-subtle)] h-row text-[10px] text-text-tertiary text-right pr-2 select-none cursor-pointer"
                      data-tip={tt('{row} = the current row number (1-based) during the loop — click to copy', '{row} = o número da linha atual (base 1) durante o loop — clique para copiar')}
                    >
                      {copiedKey === '__rownum' ? <Check size={11} className="inline text-[color:var(--color-replay)]" /> : '#'}
                    </th>
                    {grid.headers.map((h, c) => {
                      const meta = headerMeta[c];
                      const editingThis = editing?.kind === 'header' && editing.c === c;
                      return (
                        <th
                          key={c}
                          className={`group sticky top-0 z-10 bg-bg-surface shadow-[inset_0_-1px_0_var(--color-border-subtle)] h-row text-left text-xs font-semibold font-mono px-2 whitespace-nowrap ${
                            meta.valid ? 'text-text-tertiary' : 'text-warning'
                          } ${editingThis ? 'shadow-[inset_0_0_0_1.5px_var(--color-accent-solid)] bg-bg-input' : ''}`}
                        >
                          {editingThis ? (
                            <CellEditor
                              initial={h}
                              multiline={false}
                              onDone={(value) => handleHeaderDone(c, value)}
                            />
                          ) : (
                            <span className="flex items-center gap-1.5">
                              {!meta.valid && <TriangleAlert size={11} className="shrink-0" />}
                              <button
                                type="button"
                                onClick={() => { if (!readOnly) setEditing({ kind: 'header', c }); }}
                                className={`truncate ${meta.dup ? 'underline decoration-dotted decoration-warning/60 underline-offset-2' : ''} ${readOnly ? '' : 'cursor-text'}`}
                                data-tip={meta.dup ? tt('Duplicate column — the last one wins at replay.', 'Coluna duplicada — a última vence no replay.') : undefined}
                              >
                                {meta.name || <span className="text-text-disabled italic">({tt('empty', 'vazio')})</span>}
                              </button>
                              <button
                                type="button"
                                onClick={(e) => setHeaderMenu({ c, anchor: e.currentTarget })}
                                className="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded hover:bg-bg-card text-text-tertiary hover:text-text-primary transition-all shrink-0 ml-auto"
                              >
                                <MoreHorizontal size={12} />
                              </button>
                            </span>
                          )}
                        </th>
                      );
                    })}
                    <th className="sticky top-0 z-10 bg-bg-surface shadow-[inset_0_-1px_0_var(--color-border-subtle)] h-row">
                      {!readOnly && (
                        <button
                          type="button"
                          onClick={addColumn}
                          className="w-6 h-6 flex items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-bg-card transition-colors"
                          data-tip={tt('Add column', 'Adicionar coluna')}
                        >
                          <Plus size={12} />
                        </button>
                      )}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {grid.rows.map((row, r) => (
                    <GridRow
                      key={r}
                      row={row}
                      r={r}
                      colCount={grid.headers.length}
                      editingCol={editing?.kind === 'cell' && editing.r === r ? editing.c : null}
                      readOnly={readOnly}
                      zebra={r % 2 === 1}
                      onEdit={handleEdit}
                      onCellDone={handleCellDone}
                      onDuplicate={handleDuplicateRow}
                      onDelete={handleDeleteRow}
                    />
                  ))}
                  {!readOnly && (
                    <tr>
                      <td colSpan={grid.headers.length + 2}>
                        <button
                          type="button"
                          onClick={addRow}
                          className="w-full h-row flex items-center gap-1.5 px-3 text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors"
                        >
                          <Plus size={12} />
                          {tt('Add row', 'Adicionar linha')}
                        </button>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          {/* Status strip */}
          <div className="h-7 shrink-0 px-4 flex items-center justify-between gap-3 bg-bg-card border-t border-border-subtle">
            {stripLeft}
            {stripRight}
          </div>
        </div>

        {/* ── Rail ── */}
        <div className="w-[300px] shrink-0 border-l border-border-subtle flex flex-col min-h-0 overflow-y-auto">
          {/* RUN */}
          <div className="label-micro text-text-tertiary px-3 pt-2.5 pb-1">Run</div>
          <button
            type="button"
            role="checkbox"
            aria-checked={loopOverData}
            onClick={() => setLoop(!loopOverData)}
            className="flex items-center gap-2 px-3 py-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
            data-tip={tt(
              'Runs the whole profile once per data row. Overrides Loop count and WhilePressed/Toggle infinite replay.',
              'Executa o perfil inteiro uma vez por linha. Sobrepõe o Loop count e o replay infinito de WhilePressed/Toggle.',
            )}
          >
            <CheckboxBox checked={loopOverData} />
            <span className="flex items-center gap-1.5"><Repeat size={13} /> Loop over data</span>
          </button>
          <div className="px-3 pt-1.5 pb-2">
            {loopOverData && grid.rows.length > 0 ? (
              <div
                className="border-l-2 rounded px-2.5 py-2 text-[11px] leading-relaxed"
                style={{
                  background: 'color-mix(in srgb, var(--color-replay) 8%, transparent)',
                  borderColor: 'var(--color-replay)',
                  color: 'var(--color-replay)',
                }}
              >
                {tt(
                  `${grid.rows.length} iterations — one full run per row. Overrides Loop count and WhilePressed/Toggle infinite.`,
                  `${grid.rows.length} iterações — uma execução completa por linha. Sobrepõe o Loop count e o infinito de WhilePressed/Toggle.`,
                )}
              </div>
            ) : loopOverData ? (
              <div
                className="border-l-2 rounded px-2.5 py-2 text-[11px] leading-relaxed"
                style={{
                  background: 'color-mix(in srgb, var(--color-recording) 8%, transparent)',
                  borderColor: 'var(--color-recording)',
                  color: 'var(--color-recording)',
                }}
              >
                {tt('Replay will refuse to start: the table has no rows.', 'O replay vai se recusar a iniciar: a tabela não tem linhas.')}
              </div>
            ) : (
              <div className="border-l-2 border-border-subtle rounded px-2.5 py-2 text-[11px] leading-relaxed text-text-tertiary">
                {tt(
                  'Cursor mode: each run uses the next row and advances (wrapping). Right-click a row → Reset row position to start over.',
                  'Modo cursor: cada execução usa a próxima linha e avança (dá a volta). Botão direito numa linha → Reset row position para recomeçar.',
                )}
              </div>
            )}
          </div>

          {/* COLUMNS · TOKENS */}
          {(grid.headers.length > 0 || orphans.length > 0) && (
            <>
              <div className="label-micro text-text-tertiary px-3 pt-2 pb-1">{tt('Columns · tokens', 'Colunas · tokens')}</div>
              <div className="flex flex-col">
                {grid.headers.map((_, c) => {
                  const meta = headerMeta[c];
                  const key = meta.name.toLowerCase();
                  const count = meta.valid ? (usage.get(key) ?? 0) : 0;
                  return (
                    <div key={c} className="flex items-center gap-1.5 px-3 py-1 min-w-0">
                      {meta.valid ? (
                        <>
                          <button
                            type="button"
                            onClick={() => copyToken(`{row:${meta.name}}`, `h${c}`)}
                            className={`${CHIP_CLASS} min-w-0`}
                            data-tip={tt(
                              'Copy token — paste into Insert Text, Keystroke Key or Browser Type',
                              'Copiar token — cole em Insert Text, Keystroke Key ou Browser Type',
                            )}
                          >
                            {copiedKey === `h${c}` ? (
                              <span className="flex items-center gap-1" style={{ color: 'var(--color-replay)' }}>
                                <Check size={11} /> {tt('Copied', 'Copiado')}
                              </span>
                            ) : (
                              <span className="truncate">{`{row:${meta.name}}`}</span>
                            )}
                          </button>
                          <span
                            className={`text-[10px] tabular-nums ml-auto shrink-0 ${count > 0 ? 'text-text-tertiary' : 'text-text-disabled'}`}
                            data-tip={count > 0 ? tt(`Used in ${count} action(s)`, `Usado em ${count} action(s)`) : undefined}
                          >
                            {count > 0 ? `×${count}` : tt('unused', 'sem uso')}
                          </span>
                        </>
                      ) : (
                        <>
                          <TriangleAlert size={11} className="text-warning shrink-0" />
                          <span className="text-[11px] font-mono text-warning truncate">
                            {meta.name || `(${tt('empty', 'vazio')})`}
                          </span>
                          <button
                            type="button"
                            onClick={() => fixHeader(c)}
                            className="w-6 h-6 flex items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-bg-card transition-colors ml-auto shrink-0"
                            data-tip={tt(
                              'Headers need A–Z, 0–9 or _ to work as tokens — click to auto-fix',
                              'Cabeçalhos precisam de A–Z, 0–9 ou _ para virar token — clique para corrigir',
                            )}
                          >
                            <Wand2 size={12} />
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
                {orphans.map(([name, count]) => (
                  <div key={name} className="flex items-center gap-1.5 px-3 py-1 min-w-0">
                    <TriangleAlert size={11} className="text-warning shrink-0" />
                    <span className="text-[11px] font-mono text-warning truncate">{`{row:${name}}`}</span>
                    <span
                      className="text-[10px] text-warning ml-auto shrink-0"
                      data-tip={tt('An action references this column, but the table has no such header — it will type empty text.', 'Uma action referencia esta coluna, mas a tabela não tem esse cabeçalho — vai digitar texto vazio.')}
                    >
                      ×{count} · {tt('no column', 'sem coluna')}
                    </span>
                  </div>
                ))}
              </div>
              <div className="text-[10px] text-text-tertiary px-3 pt-1 pb-2">
                {tt('Lookup is case-insensitive. {row} = row number.', 'A busca ignora maiúsculas. {row} = número da linha.')}
              </div>
            </>
          )}

          {/* DATA */}
          <div className="label-micro text-text-tertiary px-3 pt-2 pb-1 border-t border-border-subtle mt-auto">Data</div>
          <div className="flex flex-col pb-2">
            <button
              type="button"
              onClick={openPaste}
              className="flex items-center gap-2 px-3 h-7 text-[11px] text-text-secondary hover:text-text-primary hover:bg-bg-card transition-colors"
            >
              <ClipboardPaste size={12} className="shrink-0" />
              {tt('Paste / bulk edit…', 'Colar / edição em massa…')}
            </button>
            <button
              type="button"
              onClick={() => {
                const g = gridRef.current;
                navigator.clipboard?.writeText(encodeTsv(g.headers, g.rows)).then(() => {
                  setCopiedKey('__table');
                  window.clearTimeout(copiedTimer.current);
                  copiedTimer.current = window.setTimeout(() => setCopiedKey(null), 1000);
                });
              }}
              disabled={emptyGrid}
              className="flex items-center gap-2 px-3 h-7 text-[11px] text-text-secondary hover:text-text-primary hover:bg-bg-card transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              data-tip={tt('Copy the whole table as TSV — paste it straight into Excel/Sheets', 'Copia a tabela inteira como TSV — cole direto no Excel/Sheets')}
            >
              {copiedKey === '__table' ? <Check size={12} className="shrink-0" style={{ color: 'var(--color-replay)' }} /> : <Copy size={12} className="shrink-0" />}
              {tt('Copy table (TSV)', 'Copiar tabela (TSV)')}
            </button>
            <button
              type="button"
              onClick={() => {
                if (!armedClear) { setArmedClear(true); return; }
                clearTable();
              }}
              disabled={emptyGrid}
              className={`flex items-center gap-2 px-3 h-7 text-[11px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                armedClear ? 'text-red-300 hover:bg-red-500/15' : 'text-text-secondary hover:text-text-primary hover:bg-bg-card'
              }`}
            >
              <Trash2 size={12} className="shrink-0" />
              {armedClear ? tt('Really clear?', 'Limpar mesmo?') : tt('Clear table…', 'Limpar tabela…')}
            </button>
          </div>
        </div>

        {/* ── Paste sub-surface (overlay; the grid never unmounts) ── */}
        {pasteOpen && (
          <DataPasteSurface
            text={pasteText}
            onTextChange={setPasteText}
            mode={pasteMode}
            onModeChange={handlePasteModeChange}
            firstRowHeader={pasteFirstRowHeader}
            onFirstRowHeaderChange={setPasteFirstRowHeader}
            parsed={pasteParsed}
            hasExistingTable={!emptyGrid}
            onBack={() => setPasteOpen(false)}
          />
        )}
      </div>

      {/* Header ⋯ menu (portal) */}
      {headerMenu && (
        <HeaderMenu
          anchor={headerMenu.anchor}
          header={grid.headers[headerMenu.c] ?? ''}
          colIndex={headerMenu.c}
          colCount={grid.headers.length}
          onAction={(a) => headerMenuAction(headerMenu.c, a)}
          onClose={() => setHeaderMenu(null)}
        />
      )}
    </DialogShell>
  );
}
