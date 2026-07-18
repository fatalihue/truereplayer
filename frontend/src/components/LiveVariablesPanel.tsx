import { useEffect, useState } from 'react';
import { Activity, X } from 'lucide-react';
import { useBridge } from '../bridge/BridgeContext';
import { useAppState } from '../state/AppStateContext';
import { useTt } from '../state/LanguageContext';

// ── Live Variables pane ──────────────────────────────────────────────────────
//
// Debug aid: a small opt-in floating card (bottom-right, above the StatusBar)
// mirroring the replay engine's run state — {var:} variables, {clip:} slots and
// the data-loop row currently executing. Fed by replay:variables pushes; also
// useful OUTSIDE a replay, since clip slots survive between runs (capture with
// the hotkey, verify here, then run). Toggled from the Command Palette
// ('cmd:livevars' CustomEvent — same decoupled pattern as the Theme/Data
// editors) and persisted in localStorage so it survives restarts.

const STORAGE_KEY = 'tr-livevars';

type Snapshot = {
  variables: Record<string, string>;
  slots: Record<string, string>;
  rowData: Record<string, string> | null;
};

const EMPTY: Snapshot = { variables: {}, slots: {}, rowData: null };

// One value row: mono token name, single-line ellipsized value, full value on
// hover (capped — a captured selection can be huge and the tip layer isn't a
// document viewer).
function ValueRow({ name, value }: { name: string; value: string }) {
  const oneLine = value.replace(/\r?\n/g, ' ⏎ ');
  const tip = oneLine.length > 220 ? `${oneLine.slice(0, 220)}…` : oneLine;
  return (
    <div className="flex items-baseline gap-1.5 px-2.5 py-0.5 min-w-0" data-tip={tip}>
      <span className="font-mono text-[11px] text-text-secondary shrink-0">{name}</span>
      <span className="font-mono text-[11px] text-text-primary truncate min-w-0">{oneLine || '·'}</span>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="label-micro text-text-tertiary px-2.5 pt-1.5 pb-0.5">{children}</div>;
}

export function LiveVariablesHost() {
  const { send, subscribe } = useBridge();
  const { status } = useAppState();
  const tt = useTt();
  const [enabled, setEnabled] = useState(() => localStorage.getItem(STORAGE_KEY) === '1');
  const [snap, setSnap] = useState<Snapshot>(EMPTY);

  // Toggle via CustomEvent so any surface (Command Palette today) can flip it
  // without prop-drilling — the Theme/Data editor pattern.
  useEffect(() => {
    const handler = () => {
      setEnabled((prev) => {
        const next = !prev;
        localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
        return next;
      });
    };
    window.addEventListener('cmd:livevars', handler);
    return () => window.removeEventListener('cmd:livevars', handler);
  }, []);

  useEffect(() => subscribe((m) => {
    if (m.type === 'replay:variables') setSnap(m.payload);
  }), [subscribe]);

  // On open, ask for the current snapshot — pushes only happen on writes, and
  // the pane may open long after the last one.
  useEffect(() => {
    if (enabled) send({ type: 'replay:variablesRequest', payload: {} });
  }, [enabled, send]);

  if (!enabled) return null;

  const vars = Object.entries(snap.variables);
  const slots = Object.entries(snap.slots);
  const row = snap.rowData ? Object.entries(snap.rowData) : [];
  const empty = vars.length === 0 && slots.length === 0 && row.length === 0;

  // z-[40]: below every DialogShell modal (z-50) and the SheetPanel stack (60/70) —
  // a debug pane must never paint over, or steal clicks from, an open dialog.
  return (
    <div className="fixed bottom-10 right-3 z-[40] w-[264px] max-h-[45vh] flex flex-col rounded-lg border border-border-subtle bg-bg-elevated shadow-[0_12px_32px_rgba(0,0,0,0.45)] overflow-hidden">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-border-subtle shrink-0">
        <Activity size={12} className={status === 'replaying' ? '' : 'text-text-tertiary'} style={status === 'replaying' ? { color: 'var(--color-replay)' } : undefined} />
        <span className="label-micro text-text-secondary flex-1">Live Variables</span>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent('cmd:livevars'))}
          className="p-0.5 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface transition-colors"
          data-tip={tt('Close (reopen from the Command Palette)', 'Fechar (reabra pela Command Palette)')}
        >
          <X size={12} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto pb-1.5">
        {empty && (
          <div className="px-2.5 py-2 text-[11px] text-text-tertiary leading-relaxed">
            {tt(
              'Nothing yet — Set Variable actions, {input:} answers and {clip:} captures show here as they happen.',
              'Nada ainda — actions Set Variable, respostas de {input:} e capturas {clip:} aparecem aqui em tempo real.',
            )}
          </div>
        )}
        {vars.length > 0 && (
          <>
            <SectionLabel>{tt('Variables', 'Variáveis')}</SectionLabel>
            {vars.map(([k, v]) => <ValueRow key={`v${k}`} name={k} value={v} />)}
          </>
        )}
        {slots.length > 0 && (
          <>
            <SectionLabel>Slots</SectionLabel>
            {slots.map(([k, v]) => <ValueRow key={`s${k}`} name={`clip:${k}`} value={v} />)}
          </>
        )}
        {row.length > 0 && (
          <>
            <SectionLabel>{tt('Current row', 'Linha atual')}</SectionLabel>
            {row.map(([k, v]) => <ValueRow key={`r${k}`} name={`row:${k}`} value={v} />)}
          </>
        )}
      </div>
    </div>
  );
}
