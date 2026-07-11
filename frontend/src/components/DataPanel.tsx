import { useEffect, useMemo, useRef, useState } from 'react';
import { Table2, TriangleAlert, Repeat, Check } from 'lucide-react';
import { DialogShell } from './common/DialogShell';
import { Button } from './common/Button';
import { CheckboxBox } from './Checkbox';
import { useBridge } from '../bridge/BridgeContext';
import { useAppState } from '../state/AppStateContext';
import { useTt } from '../state/LanguageContext';

interface DataPanelProps {
  onClose: () => void;
}

// Tokenize a pasted TSV block (Excel/Sheets copy = tab-separated cells, newline rows)
// into a grid, honouring CSV-style quoting: a cell wrapped in double quotes may contain
// tabs and newlines, and "" is a literal quote. Excel/Sheets quote any cell holding a
// tab, newline, or quote, so without this a multi-line message-body cell would be torn
// across rows. Unquoted cells pass through verbatim (so values keep spaces).
function tokenizeTsvGrid(text: string): string[][] {
  const src = text.replace(/\r\n/g, '\n');
  const grid: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 2; continue; } // escaped quote
        inQuotes = false; i++; continue;
      }
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell === '') { inQuotes = true; i++; continue; } // opening quote (start of cell)
    if (ch === '\t') { row.push(cell); cell = ''; i++; continue; }
    if (ch === '\n') { row.push(cell); grid.push(row); row = []; cell = ''; i++; continue; }
    cell += ch; i++;
  }
  // Flush the last cell/row (no trailing newline).
  row.push(cell);
  grid.push(row);
  return grid;
}

// Parse pasted TSV into a data table. Trailing all-empty rows are dropped. When
// firstRowHeader is off, headers are synthesized col1..colN sized to the widest row.
function parseTsv(text: string, firstRowHeader: boolean): { headers: string[]; rows: string[][] } {
  if (text.trim() === '') return { headers: [], rows: [] };
  const grid = tokenizeTsvGrid(text);
  // Drop trailing rows that are entirely empty (a paste often ends with a newline).
  while (grid.length && grid[grid.length - 1].every((c) => c.trim() === '')) grid.pop();
  if (grid.length === 0) return { headers: [], rows: [] };
  let headers: string[];
  let bodyRows: string[][];
  if (firstRowHeader) {
    headers = grid[0].map((h) => h.trim());
    bodyRows = grid.slice(1);
  } else {
    const width = grid.reduce((m, r) => Math.max(m, r.length), 0);
    headers = Array.from({ length: width }, (_, i) => `col${i + 1}`);
    bodyRows = grid;
  }
  return { headers, rows: bodyRows };
}

const VALID_HEADER = /^[A-Za-z0-9_]+$/;

export function DataPanel({ onClose }: DataPanelProps) {
  const { send } = useBridge();
  const { dataTable } = useAppState();
  const tt = useTt();

  // Seed the editor from the stored table by reconstructing a TSV (headers first).
  const [text, setText] = useState('');
  const [firstRowHeader, setFirstRowHeader] = useState(true);
  const [loopOverData, setLoopOverData] = useState(false);
  const [saved, setSaved] = useState(false);

  // Seed the editor ONCE, from the store's current table, when the panel mounts.
  // Deliberately NOT re-seeding on later dataTable changes: the backend rides data:table
  // on every actions:updated (recording/browser pushes), which would otherwise stomp the
  // user's unsaved paste while the panel is open. `send` is stable; the seed reads the
  // latest store value on mount. A cell may hold tabs/newlines (quoted), so reconstruct
  // the TSV with the same quoting the tokenizer understands.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    send({ type: 'data:request', payload: {} });
    const { headers, rows, loopOverData: loop } = dataTable;
    if (headers.length > 0 || rows.length > 0) {
      const enc = (c: string) => (/[\t\n"]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
      const tsv = [headers, ...rows].map((r) => r.map(enc).join('\t')).join('\n');
      setText(tsv);
      setLoopOverData(loop);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const parsed = useMemo(() => parseTsv(text, firstRowHeader), [text, firstRowHeader]);
  const invalidHeaders = parsed.headers.filter((h) => h && !VALID_HEADER.test(h));

  const handleSave = () => {
    send({ type: 'data:save', payload: { headers: parsed.headers, rows: parsed.rows, loopOverData } });
    setSaved(true);
    setTimeout(onClose, 350);
  };

  return (
    <DialogShell
      icon={<Table2 size={14} className="text-accent-light" />}
      title="Data Loop"
      widthClass="w-[680px]"
      onClose={onClose}
      closeOnBackdrop={false}
      showClose
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleSave}>
            {saved ? <><Check size={13} /> Saved</> : 'Save'}
          </Button>
        </>
      }
    >
      <div className="px-5 py-4 flex flex-col gap-3.5 max-h-[70vh] overflow-y-auto">
        <p className="text-[11px] text-text-tertiary leading-relaxed">
          {tt(
            'Paste a table from Excel/Sheets (tab-separated). Use {row:column} tokens in Send Text / Type Text / keys to inject a cell. Turn on “loop over data” to run the whole profile once per row.',
            'Cole uma tabela do Excel/Sheets (separada por tabs). Use tokens {row:coluna} em Enviar Texto / Digitar / teclas para injetar uma célula. Ligue “repetir por linha” para rodar o perfil inteiro uma vez por linha.'
          )}
        </p>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          placeholder={'cliente\tpedido\tvalor\nMaria\t1023\tR$ 89,90\nJoão\t1044\tR$ 149,00'}
          className="w-full h-40 px-2 py-1.5 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid resize-y whitespace-pre"
        />

        <div className="flex items-center gap-4 flex-wrap">
          <button
            type="button"
            role="checkbox"
            aria-checked={firstRowHeader}
            onClick={() => setFirstRowHeader((v) => !v)}
            className="flex items-center gap-2 text-xs text-text-secondary hover:text-text-primary"
          >
            <CheckboxBox checked={firstRowHeader} />
            {tt('First row is the header', 'Primeira linha é o cabeçalho')}
          </button>
          <button
            type="button"
            role="checkbox"
            aria-checked={loopOverData}
            onClick={() => setLoopOverData((v) => !v)}
            className="flex items-center gap-2 text-xs text-text-secondary hover:text-text-primary"
            data-tip={tt('Run the whole profile once per data row. Overrides the normal loop count.', 'Roda o perfil inteiro uma vez por linha. Sobrepõe a contagem de loop normal.')}
          >
            <CheckboxBox checked={loopOverData} />
            <span className="flex items-center gap-1"><Repeat size={12} /> {tt('Loop over data', 'Repetir por linha')}</span>
          </button>
        </div>

        {/* Parsed preview + column tokens */}
        {parsed.headers.length > 0 && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-text-tertiary">
              {tt('Preview', 'Prévia')}
              <span className="text-text-secondary normal-case tracking-normal">
                {parsed.headers.length} {tt('columns', 'colunas')} · {parsed.rows.length} {tt('rows', 'linhas')}
              </span>
            </div>
            <div className="overflow-x-auto border border-border-subtle rounded">
              <table className="text-[11px] font-mono border-collapse w-full">
                <thead>
                  <tr>
                    {parsed.headers.map((h, i) => (
                      <th key={i} className="text-left px-2 py-1 bg-bg-elevated text-text-secondary border-b border-border-subtle whitespace-nowrap">{h || <span className="text-text-disabled">·</span>}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {parsed.rows.slice(0, 5).map((r, ri) => (
                    <tr key={ri}>
                      {parsed.headers.map((_, ci) => (
                        <td key={ci} className="px-2 py-1 text-text-secondary border-b border-border-subtle/50 whitespace-nowrap max-w-[160px] truncate">{r[ci] ?? ''}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {parsed.rows.length > 5 && (
              <div className="text-[10px] text-text-tertiary">{tt(`…and ${parsed.rows.length - 5} more rows`, `…e mais ${parsed.rows.length - 5} linhas`)}</div>
            )}

            {/* Column tokens */}
            <div className="flex flex-wrap gap-1.5 items-center">
              <span className="text-[10px] uppercase tracking-wide text-text-tertiary mr-1">{tt('Tokens', 'Tokens')}</span>
              {parsed.headers.filter((h) => h && VALID_HEADER.test(h)).map((h, i) => (
                <button
                  key={`${h}-${i}`}
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(`{row:${h}}`)}
                  data-tip={tt('Copy token', 'Copiar token')}
                  className="px-2 py-0.5 text-[11px] font-mono bg-bg-surface border border-border-subtle rounded text-text-secondary hover:text-accent hover:border-accent-solid/40 transition-colors"
                >
                  {`{row:${h}}`}
                </button>
              ))}
            </div>

            {invalidHeaders.length > 0 && (
              <div className="flex items-start gap-2 px-2.5 py-2 rounded bg-warning/10 border border-warning/30 text-[11px] text-text-secondary">
                <TriangleAlert size={12} className="text-warning mt-px shrink-0" />
                <span>
                  {tt(
                    `These column names can’t be used as {row:…} tokens (letters, digits, underscore only): ${invalidHeaders.join(', ')}`,
                    `Estes nomes de coluna não podem virar tokens {row:…} (só letras, dígitos, underscore): ${invalidHeaders.join(', ')}`
                  )}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </DialogShell>
  );
}
