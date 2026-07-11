import { ChevronLeft, ClipboardPaste, TriangleAlert, Check } from 'lucide-react';
import { SegmentedControl } from './common/SegmentedControl';
import { CheckboxBox } from './Checkbox';
import { useTt } from '../state/LanguageContext';
import type { Grid } from '../lib/tsv';

export type PasteMode = 'replace' | 'append';

const VALID_HEADER = /^[A-Za-z0-9_]+$/;

interface DataPasteSurfaceProps {
  /** All state is lifted into DataPanel — the DialogShell footer (swapped while
   *  this surface is open) needs the same parse to label its Apply button. */
  text: string;
  onTextChange: (t: string) => void;
  mode: PasteMode;
  onModeChange: (m: PasteMode) => void;
  firstRowHeader: boolean;
  onFirstRowHeaderChange: (v: boolean) => void;
  /** Parsed (debounced) preview of `text` under the current firstRowHeader. */
  parsed: Grid;
  /** Whether the panel currently has a table (labels the Replace-mode copy). */
  hasExistingTable: boolean;
  onBack: () => void;
}

// Full-body "Paste table" sub-surface of the Data Loop panel — the ClipboardSurface
// pattern verbatim: absolute inset-0 OVERLAY inside the dialog's relative body
// wrapper, so the grid underneath never unmounts. Excel stays the heavy editor;
// this surface is the import/bulk-edit path (Replace mode opens PREFILLED with the
// current table, preserving the old paste-over-fix-apply workflow).
export function DataPasteSurface({
  text,
  onTextChange,
  mode,
  onModeChange,
  firstRowHeader,
  onFirstRowHeaderChange,
  parsed,
  hasExistingTable,
  onBack,
}: DataPasteSurfaceProps) {
  const tt = useTt();
  const invalidHeaders = parsed.headers.filter((h) => h && !VALID_HEADER.test(h.trim()));
  const ragged = parsed.rows.some((r) => r.length !== parsed.headers.length);

  return (
    <div className="absolute inset-0 z-20 bg-bg-elevated flex flex-col">
      {/* Sub-header — local back affordance (ClipboardSurface recipe). */}
      <div className="h-9 px-2 flex items-center gap-2 border-b border-border-subtle shrink-0">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 h-6 px-1.5 text-[11px] rounded text-text-tertiary hover:text-text-primary hover:bg-bg-card transition-colors"
          data-tip={tt('Back to the grid (discards this paste)', 'Voltar à grade (descarta esta colagem)')}
        >
          <ChevronLeft size={13} />
          Grid
        </button>
        <div className="w-px h-4 bg-border-subtle" />
        <ClipboardPaste size={13} className="text-accent-light shrink-0" />
        <div className="text-xs font-semibold text-text-primary flex-1">Paste table</div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Left: mode + textarea. */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="p-2 pb-1.5 shrink-0">
            <SegmentedControl<PasteMode>
              grow
              ariaLabel="Paste mode"
              options={[
                {
                  value: 'replace',
                  label: 'Replace table',
                  tip: tt('Parse the text below as the whole new table', 'Interpreta o texto abaixo como a nova tabela inteira'),
                },
                {
                  value: 'append',
                  label: 'Append rows',
                  tip: tt('Add the pasted rows to the current table, matching columns by name', 'Adiciona as linhas coladas à tabela atual, casando colunas pelo nome'),
                },
              ]}
              value={mode}
              onChange={onModeChange}
            />
          </div>
          <div className="relative flex-1 min-h-0 dataloop-editor">
            <textarea
              value={text}
              onChange={(e) => onTextChange(e.target.value)}
              spellCheck={false}
              autoFocus
              placeholder={'cliente\tpedido\tvalor\nMaria\t1023\tR$ 89,90\nJoão\t1044\tR$ 149,00'}
              className="w-full h-full font-mono text-xs bg-bg-input p-4 outline-none resize-none whitespace-pre overflow-auto text-text-primary placeholder:text-text-disabled"
            />
          </div>
        </div>

        {/* Right: live parse preview rail. */}
        <div className="w-[320px] shrink-0 border-l border-border-subtle bg-bg-surface p-3 flex flex-col gap-3 min-h-0 overflow-y-auto">
          <button
            type="button"
            role="checkbox"
            aria-checked={firstRowHeader}
            onClick={() => onFirstRowHeaderChange(!firstRowHeader)}
            className="flex items-center gap-2 text-xs text-text-secondary hover:text-text-primary transition-colors"
            data-tip={tt(
              'Off: columns are named col1..colN and every pasted line is data',
              'Desligado: colunas viram col1..colN e toda linha colada é dado',
            )}
          >
            <CheckboxBox checked={firstRowHeader} />
            {tt('First row is the header', 'Primeira linha é o cabeçalho')}
          </button>

          <div className="text-[11px] text-text-tertiary tabular-nums">
            {parsed.headers.length} {tt('columns', 'colunas')} · {parsed.rows.length} {tt('rows', 'linhas')}
          </div>

          {parsed.headers.length > 0 && (
            <div className="flex flex-col gap-1">
              <div className="label-micro text-text-tertiary">{tt('Columns', 'Colunas')}</div>
              {parsed.headers.map((h, i) => {
                const name = h.trim();
                const ok = name !== '' && VALID_HEADER.test(name);
                return (
                  <div key={`${h}-${i}`} className="flex items-center gap-1.5 text-[11px] font-mono">
                    {ok ? (
                      <Check size={11} className="text-[color:var(--color-replay)] shrink-0" />
                    ) : (
                      <TriangleAlert size={11} className="text-warning shrink-0" />
                    )}
                    <span className={ok ? 'text-text-secondary' : 'text-warning'}>
                      {name || <span className="italic text-text-disabled">({tt('empty', 'vazio')})</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {invalidHeaders.length > 0 && (
            <div className="text-[10px] text-text-tertiary leading-relaxed">
              {tt(
                'Headers marked ⚠ can’t be used as {row:…} tokens (letters, digits, underscore only). They still save.',
                'Cabeçalhos com ⚠ não podem virar tokens {row:…} (só letras, dígitos, underscore). Ainda assim são salvos.',
              )}
            </div>
          )}

          {ragged && (
            <div className="text-[10px] text-text-tertiary leading-relaxed">
              {tt(
                'Some rows have a different cell count than the header — missing cells resolve to empty text.',
                'Algumas linhas têm contagem de células diferente do cabeçalho — células faltantes viram texto vazio.',
              )}
            </div>
          )}

          {mode === 'replace' && hasExistingTable && (
            <div className="text-[10px] text-text-tertiary leading-relaxed mt-auto">
              {tt(
                'The box opens with the current table — edit it in place or paste over it.',
                'A caixa abre com a tabela atual — edite direto ou cole por cima.',
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
