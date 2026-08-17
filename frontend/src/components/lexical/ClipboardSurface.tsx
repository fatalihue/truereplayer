import React, { useMemo } from 'react';
import { ChevronLeft, RefreshCw, RotateCcw, Wand2 } from 'lucide-react';
import { SegmentedControl } from '../common/SegmentedControl';
import { NumberInput } from '../common/NumberInput';
import { CheckboxBox } from '../Checkbox';
import { useTt } from '../../state/LanguageContext';
import { ArgInput } from './popoverAtoms';
import { useClipboardContent } from './useClipboardContent';
import {
  applyTransformPreview,
  previewIsRuntimeDependent,
  argRefIsUnfinished,
  buildChainToken,
  type CaseTransform,
  type ChainHead,
  type Extract,
  type Limit,
  type ListPick,
  type Split,
  type TransformState,
} from './clipboardModifiers';
import { useRunStateSnapshot, lookupRunState } from './useRunStateSnapshot';
import { useAppState } from '../../state/AppStateContext';

// The surface is the ONE place a modifier chain is built, so its title names the token it is
// building for rather than always claiming to be about the clipboard.
const HEAD_TITLES: Record<ChainHead['kind'], string> = {
  clipboard: 'Advanced Clipboard',
  row: 'Data column',
  rownext: 'Data column (next row)',
  var: 'Variable',
  clip: 'Clipboard slot',
  winclip: 'Clipboard history',
};

const IDENTITY_LABELS: Record<ChainHead['kind'], string> = {
  clipboard: '',
  row: 'Data column',
  rownext: 'Data column',
  var: 'Variable name',
  clip: 'Slot name',
  winclip: 'History item',
};

type Tt = (en: string, ptBr: string) => string;

const IDENTITY_HINTS: Record<ChainHead['kind'], (tt: Tt) => string> = {
  clipboard: () => '',
  row: (tt) => tt(
    "Replaced with this column's cell of the current data row (loop over data).",
    'Substituído pela célula desta coluna na linha de dados atual (loop sobre dados).',
  ),
  rownext: (tt) => tt(
    'Each use pulls the NEXT data row for this column — 1st use → row 1, 2nd → row 2… Resets each run.',
    'Cada uso puxa a PRÓXIMA linha de dados desta coluna — 1º uso → linha 1, 2º → linha 2… Reinicia a cada execução.',
  ),
  var: (tt) => tt(
    'Replaced with the value a Set Variable action stored under this name.',
    'Substituído pelo valor que uma ação Set Variable guardou com este nome.',
  ),
  clip: (tt) => tt(
    'Replaced with the selection a Copy to Slot action (or the capture hotkey) stored in this slot.',
    'Substituído pela seleção que uma ação Copy to Slot (ou o atalho de captura) guardou neste slot.',
  ),
  winclip: (tt) => tt(
    'Item of the Windows clipboard history (Win+V), newest first. Needs history turned on, and it can hold anything recently copied by any app — including passwords.',
    'Item do histórico de área de transferência do Windows (Win+V), do mais recente para o mais antigo. Precisa do histórico ligado, e ele pode guardar qualquer coisa copiada recentemente por qualquer app — inclusive senhas.',
  ),
};

// What to say when there is no source to preview against. Each reason is DIFFERENT, and saying
// the wrong one is worse than saying nothing: "nothing captured yet" is fixable by the user,
// "only the engine has it" is not.
const UNKNOWN_SOURCE_COPY: Record<ChainHead['kind'], (tt: Tt) => string> = {
  clipboard: () => '',
  row: (tt) => tt('No column by that name in the data table', 'Nenhuma coluna com esse nome na tabela de dados'),
  rownext: (tt) => tt('No column by that name in the data table', 'Nenhuma coluna com esse nome na tabela de dados'),
  var: (tt) => tt('Not set — variables are cleared at the start of every run', 'Não definida — as variáveis são apagadas no começo de cada execução'),
  clip: (tt) => tt('Nothing captured in this slot yet', 'Nada capturado neste slot ainda'),
  winclip: (tt) => tt('Read from Windows when the macro runs', 'Lido do Windows quando a macro roda'),
};

interface ClipboardSurfaceProps {
  /** Lifted TransformState — the parent owns it so the DialogShell footer
   *  (Insert/Apply, swapped in by SendTextDialog) can build the token too. */
  state: TransformState;
  onStateChange: React.Dispatch<React.SetStateAction<TransformState>>;
  /** Which token this chain belongs to, plus its identity (column / name / history index).
   *  Lifted for the same reason the state is: the footer builds the token from both. */
  head: ChainHead;
  onHeadChange: (next: ChainHead) => void;
  /** `‹ Editor` — leave the surface discarding changes (same as footer Cancel). */
  onBack: () => void;
  /** Reset to the session's starting state (DEFAULT_TRANSFORM on insert,
   *  the chip's original token on edit). */
  onReset: () => void;
  /** The token as the user actually has it, used ONLY by the read-only panel — see `token` below. */
  originalToken?: string;
}

// Full-body "Advanced Clipboard" sub-surface of the Insert Text dialog — the
// ThemeEditor surface-swap pattern, but mounted as an `absolute inset-0`
// OVERLAY inside the dialog's relative body wrapper so the Lexical editor
// underneath never unmounts (undo stack, caret and selection all survive a
// round-trip through this surface).
//
// The six config sections are laid out in the BACKEND PIPELINE ORDER
// (sequence → trim → lines → extract → limit → case — see clipboardModifiers.ts header),
// each with a step badge that lights up while its step is active, so the UI
// reads as the data flow it actually is. Serialization stays exclusively in
// buildClipboardToken — this component emits no token strings of its own.
export function ClipboardSurface({ state, onStateChange, head, onHeadChange, onBack, onReset, originalToken }: ClipboardSurfaceProps) {
  const tt = useTt();
  const { clipRaw, clipReady, refresh } = useClipboardContent();
  const runState = useRunStateSnapshot(head.kind === 'clip' || head.kind === 'var');
  const { dataTable } = useAppState();
  // While editable, the rebuilt token is correct — it is what an edit will write. While READ-ONLY
  // it is not: rebuilding is exactly what this surface is refusing to do, so show what the user has.
  const token = useMemo(
    () => (state.unmodeled && originalToken ? originalToken : buildChainToken(head, state)),
    [state, head, originalToken],
  );

  // What the chain will actually run against, per head. `unknown` is not the same as an empty
  // string: an unset slot means "nothing captured yet", and previewing a chain against "" would
  // claim the chain yields nothing — a statement about the user's work rather than about a
  // missing source.
  const source = useMemo((): { raw: string; ready: boolean; unknown: boolean; label: string; note?: string } => {
    switch (head.kind) {
      case 'clipboard':
        return { raw: clipRaw, ready: clipReady, unknown: false, label: 'Clipboard now' };
      case 'row':
      case 'rownext': {
        const key = head.column.trim().toLowerCase();
        // LAST duplicate header wins, mirroring the backend's BuildRowDict.
        let idx = -1;
        dataTable.headers.forEach((h, i) => { if (h.trim().toLowerCase() === key) idx = i; });
        if (idx < 0) return { raw: '', ready: true, unknown: true, label: 'Cell (first row)' };
        return { raw: dataTable.rows[0]?.[idx] ?? '', ready: true, unknown: false, label: 'Cell (first row)' };
      }
      case 'clip': {
        const v = lookupRunState(runState.slots, head.name);
        return v === undefined
          ? { raw: '', ready: true, unknown: true, label: 'Slot text' }
          : { raw: v, ready: true, unknown: false, label: 'Slot text' };
      }
      case 'var': {
        const v = lookupRunState(runState.variables, head.name);
        return v === undefined
          ? { raw: '', ready: true, unknown: true, label: 'Variable value' }
          // Variables are cleared at the start of every run, so anything here came from the LAST
          // one. Saying that is the difference between a useful preview and a misleading one.
          : { raw: v, ready: true, unknown: false, label: 'Variable value', note: tt('from the last run', 'da última execução') };
      }
      case 'winclip':
        // The Windows clipboard history lives in the engine only — nothing to preview against.
        return { raw: '', ready: true, unknown: true, label: 'History item' };
    }
  }, [head, clipRaw, clipReady, dataTable, runState, tt]);

  const preview = useMemo(() => applyTransformPreview(source.raw, state), [source.raw, state]);
  // A reference argument has no value until the macro runs — never fabricate one in the preview.
  const runtimeDependent = previewIsRuntimeDependent(state);
  // A half-typed "@" is neither a reference nor a number to the backend: the modifier is skipped
  // and the caller gets everything. Say that, rather than a preview built from a number the user
  // is no longer using.
  const refUnfinished = argRefIsUnfinished(state);
  const refTip = tt('Take this number from a variable instead — @name, @counter or @row',
                    'Pegar este número de uma variável — @nome, @counter ou @row');
  const numTip = tt('Back to a fixed number', 'Voltar para um número fixo');

  const set = (patch: Partial<TransformState>) => onStateChange((s) => ({ ...s, ...patch }));

  const linesActive =
    state.listPick !== 'none' || state.sort || state.dedupe || state.reverse || state.join;

  // A split with no delimiter emits nothing and does nothing, so the badge must not claim
  // the step is doing work.
  const splitActive = state.split !== 'none' && state.splitDelim.length > 0;

  // `next` is clipboard-only: the other heads have no cursor, so offering the control would
  // promise a behaviour their runtime never performs (the same rule ClipboardModifierBody's
  // `showNext` encodes). The ladder then has to RENUMBER rather than start at 2 — the numbers
  // exist to communicate pipeline order, and a gap at the top says nothing true.
  const showSequence = head.kind === 'clipboard';
  const sn = (clipboardStep: number) => (showSequence ? clipboardStep : clipboardStep - 1);

  // Same read-only rule as the chip popover: this surface rebuilds the whole token from state,
  // so a chain carrying an unrepresentable modifier must not be edited here.
  if (state.unmodeled) {
    return (
      <div className="absolute inset-0 z-20 bg-bg-elevated flex flex-col">
        <div className="h-9 px-2 flex items-center gap-2 border-b border-border-subtle shrink-0">
          <button type="button" onClick={onBack}
            className="flex items-center gap-1 h-6 px-1.5 text-[11px] rounded text-text-tertiary hover:text-text-primary hover:bg-bg-card transition-colors">
            <ChevronLeft size={13} />
            Editor
          </button>
          <div className="w-px h-4 bg-border-subtle" />
          <Wand2 size={13} className="text-accent-light shrink-0" />
          <div className="text-xs font-semibold text-text-primary flex-1">{HEAD_TITLES[head.kind]}</div>
        </div>
        <div className="flex-1 p-4 space-y-3">
          <div className="rounded border px-3 py-2 text-[11px] leading-relaxed"
            style={{
              color: 'var(--color-recording-fg)',
              borderColor: 'color-mix(in srgb, var(--color-recording) 40%, transparent)',
              backgroundColor: 'color-mix(in srgb, var(--color-recording) 10%, transparent)',
            }}>
            {state.unmodeledRefArg
              ? tt('This token takes a line argument from a variable, which these controls can only show as a literal — so it is read-only here. It still runs; if the variable is missing or does not hold a valid value, the step yields nothing. Edit the token text directly in the editor to change it.',
                   'Este token pega um argumento de linha de uma variável, e estes controles só conseguem mostrar um valor literal — por isso está só para leitura. Ele roda normalmente; se a variável não existir ou não tiver um valor válido, o passo não devolve nada. Edite o texto do token direto no editor para mudá-lo.')
              : tt('This builder cannot rebuild this token exactly as written — a modifier it does not know, one used twice, or a different order — so it is read-only here. Edit the token text directly in the editor instead.',
                   'Este construtor não consegue reconstruir este token exatamente como está escrito — um modificador que ele não conhece, um usado duas vezes, ou em outra ordem — então está só para leitura. Edite o texto do token direto no editor.')}
          </div>
          <div className="text-[9px] uppercase tracking-wide text-text-tertiary">Token</div>
          <div className="font-mono text-[12px] px-2 py-1 rounded break-all"
            style={{
              color: 'var(--color-action-sendtext-fg)',
              background: 'color-mix(in srgb, var(--color-action-sendtext-fg) 10%, transparent)',
            }}>
            {token}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 z-20 bg-bg-elevated flex flex-col">
      {/* Sub-header — local back affordance, ThemeEditor sub-surface style. */}
      <div className="h-9 px-2 flex items-center gap-2 border-b border-border-subtle shrink-0">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 h-6 px-1.5 text-[11px] rounded text-text-tertiary hover:text-text-primary hover:bg-bg-card transition-colors"
          data-tip={tt('Back to the editor (discards changes)', 'Voltar ao editor (descarta alterações)')}
        >
          <ChevronLeft size={13} />
          Editor
        </button>
        <div className="w-px h-4 bg-border-subtle" />
        <Wand2 size={13} className="text-accent-light shrink-0" />
        <div className="text-xs font-semibold text-text-primary flex-1">{HEAD_TITLES[head.kind]}</div>
        <button
          type="button"
          onClick={onReset}
          className="flex items-center gap-1 h-6 px-1.5 text-[11px] rounded text-text-tertiary hover:text-text-primary hover:bg-bg-card transition-colors"
          data-tip={tt('Reset all steps', 'Redefinir todas as etapas')}
        >
          <RotateCcw size={12} />
          Reset
        </button>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Config column — single column, backend pipeline order. Capped: its widest row
            is a segmented control plus two number inputs, so past ~560px it just grows
            whitespace. Everything left over goes to the preview rail, which is the part
            that actually benefits from width (long clipboard lines wrap less). */}
        <div className="min-w-0 flex-1 max-w-[560px] overflow-y-auto p-4 space-y-4">
          {/* Identity, NOT a pipeline step — which slot, which variable, which column, which
              history item. Unnumbered on purpose: the ladder's numbers mean "order the backend
              applies these in", and this is not one of them. */}
          {head.kind !== 'clipboard' && (
            <div className="rounded border border-border-subtle bg-bg-card px-3 py-2">
              <div className="label-micro text-text-tertiary mb-1">{IDENTITY_LABELS[head.kind]}</div>
              {head.kind === 'winclip' ? (
                <div className="flex items-center gap-2">
                  <NumberInput
                    value={head.index}
                    onChange={(n) => onHeadChange({ kind: 'winclip', index: n < 1 ? 1 : n })}
                    min={1}
                    inputWidth="w-16"
                    inputHeight="h-8"
                    ariaLabel="History item"
                  />
                  <span className="text-[11px] text-text-tertiary">1 = most recent</span>
                </div>
              ) : (
                <input
                  type="text"
                  value={head.kind === 'row' || head.kind === 'rownext' ? head.column : head.name}
                  // Same charset the typing grammar chips ([A-Za-z0-9_]) — anything else would
                  // produce a token the editor immediately un-chips on round-trip.
                  onChange={(e) => {
                    const clean = e.target.value.replace(/[^A-Za-z0-9_]/g, '');
                    onHeadChange(
                      head.kind === 'row' || head.kind === 'rownext'
                        ? { kind: head.kind, column: clean }
                        : { kind: head.kind, name: clean },
                    );
                  }}
                  autoFocus
                  spellCheck={false}
                  placeholder={head.kind === 'row' || head.kind === 'rownext' ? 'column' : 'name'}
                  className="h-8 w-full px-2 text-xs font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid placeholder:text-text-disabled"
                />
              )}
              <div className="text-[11px] text-text-tertiary mt-1.5 leading-snug">
                {IDENTITY_HINTS[head.kind](tt)}
              </div>
            </div>
          )}

          {/* Step 1 because the backend applies it first — it picks WHICH text the rest of the
              ladder then transforms. The steps below shifted up by one to keep the numbering
              honest about pipeline order, which is what the ladder exists to communicate. */}
          {showSequence && (
          <Step n={1} title="Sequence" active={state.next}>
            <CheckRow
              checked={state.next}
              onChange={() => set({ next: !state.next })}
              label="One line per use"
            />
            <div className="text-[11px] text-text-tertiary leading-snug mt-1">
              {state.next
                ? tt(
                    'Each use takes the next line and moves on; copying something new starts over. The preview always shows line 1 — the real position lives in the run.',
                    'Cada uso pega a próxima linha e avança; copiar algo novo recomeça do início. A prévia sempre mostra a linha 1 — a posição real fica na execução.',
                  )
                : tt(
                    'Off: every use pastes the whole clipboard.',
                    'Desligado: cada uso cola a área de transferência inteira.',
                  )}
            </div>
          </Step>
          )}

          <Step n={sn(2)} title="Trim" active={state.trim}>
            <CheckRow
              checked={state.trim}
              onChange={() => set({ trim: !state.trim })}
              label="Trim whitespace"
            />
          </Step>

          <Step n={sn(3)} title="Split at" active={splitActive}>
            <div className="space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <SegmentedControl<Split>
                  ariaLabel="Split at a delimiter"
                  options={[
                    { value: 'none', label: 'Off' },
                    { value: 'before', label: 'Before' },
                    { value: 'after', label: 'After' },
                  ]}
                  value={state.split}
                  onChange={(v) => set({ split: v })}
                />
                {state.split !== 'none' && (
                  <>
                    <input
                      type="text"
                      value={state.splitDelim}
                      // Same grammar filter as the join separator. A SPACE is deliberately
                      // allowed — " - " is the delimiter this control exists for.
                      onChange={(e) => set({ splitDelim: e.target.value.replace(/[{}:]/g, '') })}
                      placeholder=" - "
                      aria-label="Delimiter"
                      data-tip={tt(
                        'The text to cut at — it is not kept. { } : are reserved by the token grammar and stripped; spaces are fine.',
                        'O texto onde cortar — ele não entra no resultado. { } : são reservados pela gramática do token e removidos; espaços podem.',
                      )}
                      className="h-8 w-28 px-2 text-xs font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid placeholder:text-text-disabled"
                    />
                    <CheckRow
                      checked={state.splitLast}
                      onChange={() => set({ splitLast: !state.splitLast })}
                      label="Last match"
                    />
                  </>
                )}
              </div>
              <div className="text-[11px] text-text-tertiary leading-snug">
                {state.split === 'none'
                  ? tt(
                      'Off: the whole text goes on to the next step.',
                      'Desligado: o texto inteiro segue para a próxima etapa.',
                    )
                  : tt(
                      'If the delimiter is not in the text, this step yields nothing — not everything. That is deliberate: the other answer pastes a whole clipboard where you asked for a fragment.',
                      'Se o delimitador não estiver no texto, esta etapa não devolve nada — e não devolve tudo. É de propósito: a outra resposta colaria a área de transferência inteira onde você pediu um pedaço.',
                    )}
              </div>
            </div>
          </Step>

          <Step n={sn(4)} title="Lines" active={linesActive}>
            <div className="space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <SegmentedControl<ListPick>
                  ariaLabel="Lines"
                  options={[
                    { value: 'none', label: 'All lines' },
                    { value: 'range', label: 'Range' },
                    { value: 'lines', label: 'Pick #s' },
                  ]}
                  value={state.listPick}
                  onChange={(v) => set({ listPick: v })}
                />
                {state.listPick === 'range' && (
                  <span className="flex items-center gap-1">
                    <NumberInput
                      value={state.rangeFrom}
                      onChange={(n) => set({ rangeFrom: Math.max(1, n) })}
                      onClear={() => set({ rangeFrom: null })}
                      min={1}
                      placeholder="1"
                      ariaLabel="First line"
                      inputWidth="w-14"
                      inputHeight="h-8"
                    />
                    <span className="text-[11px] text-text-tertiary">–</span>
                    <NumberInput
                      value={state.rangeTo}
                      onChange={(n) => set({ rangeTo: Math.max(1, n) })}
                      onClear={() => set({ rangeTo: null })}
                      min={1}
                      placeholder="end"
                      ariaLabel="Last line"
                      inputWidth="w-14"
                      inputHeight="h-8"
                    />
                  </span>
                )}
                {state.listPick === 'lines' && (
                  <input
                    type="text"
                    value={state.linesSpec}
                    onChange={(e) => set({ linesSpec: e.target.value.replace(/[^0-9,]/g, '') })}
                    placeholder="3,1,2"
                    data-tip={tt(
                      'Line numbers, comma-separated — repeats allowed (3,1,2). Only digits and commas.',
                      'Números das linhas, separados por vírgula — repetição permitida (3,1,2). Apenas dígitos e vírgulas.',
                    )}
                    className="h-8 w-24 px-2 text-xs font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid placeholder:text-text-disabled"
                  />
                )}
              </div>
              <div className="flex items-center gap-4 flex-wrap">
                <CheckRow checked={state.sort} onChange={() => set({ sort: !state.sort })} label="Sort A–Z" />
                <CheckRow checked={state.dedupe} onChange={() => set({ dedupe: !state.dedupe })} label="Dedupe" />
                <CheckRow checked={state.reverse} onChange={() => set({ reverse: !state.reverse })} label="Reverse" />
              </div>
              <div className="flex items-center gap-2">
                <CheckRow checked={state.join} onChange={() => set({ join: !state.join })} label="Join with" />
                <input
                  type="text"
                  value={state.joinSep}
                  onChange={(e) => set({ joinSep: e.target.value.replace(/[{}:]/g, '') })}
                  disabled={!state.join}
                  placeholder=","
                  data-tip={tt(
                    'Separator between joined lines — empty is legal. { } : are reserved by the token grammar and stripped.',
                    'Separador entre as linhas unidas — vazio é válido. { } : são reservados pela gramática do token e removidos.',
                  )}
                  className="h-8 w-24 px-2 text-xs font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid disabled:opacity-50 placeholder:text-text-disabled"
                />
              </div>
            </div>
          </Step>

          <Step n={sn(5)} title="Extract" active={state.extract !== 'none'}>
            <div className="flex items-center gap-2 flex-wrap">
              <SegmentedControl<Extract>
                ariaLabel="Extract"
                options={[
                  { value: 'none', label: 'Everything' },
                  { value: 'line', label: 'Line #' },
                  { value: 'word', label: 'Word #' },
                  { value: 'words', label: 'Words' },
                ]}
                value={state.extract}
                onChange={(v) => set({ extract: v })}
              />
              {(state.extract === 'line' || state.extract === 'word') && (
                <ArgInput
                  value={state.extractN}
                  onChange={(n) => set({ extractN: Math.max(1, n) })}
                  refValue={state.extractRef}
                  onRefChange={(r) => set({ extractRef: r })}
                  min={1}
                  refTip={refTip}
                  numTip={numTip}
                />
              )}
              {state.extract === 'words' && (
                <span
                  className="flex items-center gap-1"
                  data-tip={tt(
                    'A span of words, kept with the original spacing between them. Leave a side blank for an open end.',
                    'Um intervalo de palavras, mantendo o espaçamento original entre elas. Deixe um lado em branco para não ter limite.',
                  )}
                >
                  <NumberInput
                    value={state.wordsFrom}
                    onChange={(n) => set({ wordsFrom: Math.max(1, n) })}
                    onClear={() => set({ wordsFrom: null })}
                    min={1}
                    placeholder="1"
                    ariaLabel="First word"
                    inputWidth="w-14"
                    inputHeight="h-8"
                  />
                  <span className="text-[11px] text-text-tertiary">–</span>
                  <NumberInput
                    value={state.wordsTo}
                    onChange={(n) => set({ wordsTo: Math.max(1, n) })}
                    onClear={() => set({ wordsTo: null })}
                    min={1}
                    placeholder="end"
                    ariaLabel="Last word"
                    inputWidth="w-14"
                    inputHeight="h-8"
                  />
                </span>
              )}
            </div>
          </Step>

          <Step n={sn(6)} title="Limit length" active={state.limit !== 'none'}>
            <div className="flex items-center gap-2 flex-wrap">
              <SegmentedControl<Limit>
                ariaLabel="Limit length"
                options={[
                  { value: 'none', label: 'None' },
                  { value: 'first', label: 'First N chars' },
                  { value: 'last', label: 'Last N chars' },
                ]}
                value={state.limit}
                onChange={(v) => set({ limit: v })}
              />
              {state.limit !== 'none' && (
                <ArgInput
                  value={state.limitN}
                  onChange={(n) => set({ limitN: Math.max(0, n) })}
                  refValue={state.limitRef}
                  onRefChange={(r) => set({ limitRef: r })}
                  min={0}
                  refTip={refTip}
                  numTip={numTip}
                />
              )}
            </div>
          </Step>

          <Step n={sn(7)} title="Case" active={state.case !== 'none'}>
            {/* Wrap like Steps 2-4 so the block-level SegmentedControl track hugs its
                buttons instead of stretching to the full config-column width (which left
                a wide empty pill after the last "Title" segment). */}
            <div className="flex items-center gap-2 flex-wrap">
              <SegmentedControl<CaseTransform>
                ariaLabel="Case"
                options={[
                  { value: 'none', label: 'None' },
                  { value: 'upper', label: 'UPPER' },
                  { value: 'lower', label: 'lower' },
                  { value: 'sentence', label: 'Sentence' },
                  { value: 'title', label: 'Title' },
                ]}
                value={state.case}
                onChange={(v) => set({ case: v })}
              />
            </div>
          </Step>
        </div>

        {/* Preview rail — permanent, unlike the old popover's cramped strip. Takes all the
            width the capped config column leaves (was a fixed 320px with ~400px sitting
            empty beside it); min-w keeps it readable if the dialog is ever narrow. */}
        <div className="flex-1 min-w-[320px] border-l border-border-subtle bg-bg-surface p-3 flex flex-col gap-2 min-h-0">
          <div className="shrink-0">
            <div className="flex items-center justify-between mb-1">
              <div className="label-micro text-text-tertiary">
                {source.label}
                {source.note && <span className="normal-case opacity-70"> · {source.note}</span>}
              </div>
              {/* Labelled, not a bare icon: the surface has no other refresh affordance,
                  so the action names itself instead of hiding behind a tooltip. Only the
                  clipboard is re-readable from here — the rest arrive by push. */}
              {head.kind === 'clipboard' && (
                <button
                  type="button"
                  onClick={refresh}
                  className="h-5 px-1.5 inline-flex items-center gap-1 rounded label-micro text-text-tertiary hover:text-text-primary hover:bg-bg-card transition-colors"
                >
                  <RefreshCw size={11} className="shrink-0" />
                  Refresh
                </button>
              )}
            </div>
            <div
              className="font-mono text-[10.5px] text-text-secondary bg-bg-input border border-border-subtle px-2 py-1 rounded whitespace-pre-wrap break-all max-h-24 overflow-auto"
              style={{ lineHeight: 1.35 }}
            >
              {source.unknown ? (
                <span className="italic text-text-disabled">{UNKNOWN_SOURCE_COPY[head.kind](tt)}</span>
              ) : source.ready ? (
                source.raw === '' ? <span className="italic text-text-disabled">(empty)</span> : source.raw
              ) : (
                <span className="italic text-text-disabled">Reading...</span>
              )}
            </div>
          </div>

          <div className="flex-1 min-h-0 flex flex-col">
            <div className="label-micro text-text-tertiary mb-1 shrink-0">Result</div>
            <div
              className="flex-1 min-h-0 font-mono text-[11px] px-2 py-1 rounded border-l-2 whitespace-pre-wrap break-all overflow-auto"
              style={{
                background: 'color-mix(in srgb, var(--color-replay) 8%, transparent)',
                borderColor: 'color-mix(in srgb, var(--color-replay) 40%, transparent)',
                color: 'var(--color-replay-fg)',
              }}
            >
              {/* No source, no honest result — this outranks everything below, because those
                  messages are about the CHAIN and this one is about there being nothing to run
                  it on. Unfinished then FIRST among the rest — see ClipboardModifierBody. */}
              {source.unknown
                ? <span className="italic text-text-disabled">
                    {tt('No preview until there is something to transform.',
                        'Sem prévia enquanto não houver algo para transformar.')}
                  </span>
                : refUnfinished
                ? <span className="italic" style={{ color: 'var(--color-recording-fg)' }}>
                    {tt('Finish the name after @ — until then the token keeps the fixed number.',
                        'Complete o nome depois do @ — até lá o token mantém o número fixo.')}
                  </span>
                : runtimeDependent
                  ? <span className="italic text-text-disabled">
                      {tt('Resolved when the macro runs — the index comes from a variable.',
                          'Resolvido quando a macro roda — o índice vem de uma variável.')}
                    </span>
                  : preview === '' ? <span className="italic text-text-disabled">(empty)</span> : preview}
            </div>
          </div>

          <div className="shrink-0">
            <div className="label-micro text-text-tertiary mb-1">Token</div>
            <div
              className="font-mono text-[11.5px] px-2 py-1 rounded break-all"
              style={{
                color: 'var(--color-action-sendtext-fg)',
                background: 'color-mix(in srgb, var(--color-action-sendtext-fg) 10%, transparent)',
              }}
            >
              {token}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Section shell: step badge + micro title, badge lit while the step is active.
function Step({
  n,
  title,
  active,
  children,
}: {
  n: number;
  title: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <span
          className={`w-4 h-4 rounded-full text-[9px] font-semibold flex items-center justify-center border transition-colors ${
            active
              ? 'text-accent-light bg-accent-solid/15 border-accent-solid/40'
              : 'text-text-tertiary bg-bg-surface border-border-subtle'
          }`}
        >
          {n}
        </span>
        <span className="label-micro text-text-tertiary">{title}</span>
      </div>
      <div className="pl-6">{children}</div>
    </div>
  );
}

// Dialog-scale checkbox row (the popoverAtoms CheckRow is popover-compact).
function CheckRow({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={onChange}
      className="flex items-center gap-2 py-0.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
    >
      <CheckboxBox checked={checked} />
      <span>{label}</span>
    </button>
  );
}
