import React, { useMemo } from 'react';
import { Section, CheckRow, RadioRow, RadioGroup, NumInput, ArgInput } from './popoverAtoms';
import { CheckboxBox } from '../Checkbox';
import { useTt } from '../../state/LanguageContext';
import {
  applyTransformPreview,
  previewIsRuntimeDependent,
  argRefIsUnfinished,
  buildClipboardToken,
  type Extract,
  type Limit,
  type ListPick,
  type TransformState,
} from './clipboardModifiers';

interface ClipboardModifierBodyProps {
  state: TransformState;
  setState: React.Dispatch<React.SetStateAction<TransformState>>;
  clipRaw: string;
  clipReady: boolean;
  /** Override the displayed token — the row-cell chip passes its {row:col:mods}
   *  build; clipboard consumers omit it and get the {clipboard:mods} build. */
  token?: string;
  /** Label above the raw-source box (default "Clipboard"; the row-cell chip
   *  passes "Cell (first row)"). */
  sourceLabel?: string;
  /** Show the "One line per use" control. CLIPBOARD ONLY — {row:col} / {rownext:col}
   *  share this body but their heads have no 'next' modifier, so the control would
   *  promise a behaviour their runtime never performs. Off by default so a consumer
   *  has to opt in deliberately. */
  showNext?: boolean;
}

// The Transform / Extract / Limit + Source / Token / Preview sections.
// Stateless about UI shell (header, footer, positioning) — those are owned by
// each consumer popover. Keeps the editor markup identical between insert and
// edit flows so users see the same controls in both contexts.
export function ClipboardModifierBody({
  state,
  setState,
  clipRaw,
  clipReady,
  token: tokenOverride,
  sourceLabel = 'Clipboard',
  showNext = false,
}: ClipboardModifierBodyProps) {
  const tt = useTt();
  const token = useMemo(
    () => tokenOverride ?? buildClipboardToken(state),
    [tokenOverride, state],
  );
  const preview = useMemo(() => applyTransformPreview(clipRaw, state), [clipRaw, state]);
  // A reference argument has no value until the macro runs — never fabricate one in the preview.
  const runtimeDependent = previewIsRuntimeDependent(state);
  // A half-typed "@" is neither a reference nor a number to the backend: the modifier is skipped
  // and the caller gets everything. Say that, rather than a preview built from a number the user
  // is no longer using.
  const refUnfinished = argRefIsUnfinished(state);

  const toggleCase = (v: 'upper' | 'lower' | 'sentence' | 'title') =>
    setState((s) => ({ ...s, case: s.case === v ? 'none' : v }));

  const setExtract = (v: Extract) => setState((s) => ({ ...s, extract: v }));
  const setLimit = (v: Limit) => setState((s) => ({ ...s, limit: v }));
  const setExtractN = (n: number) => setState((s) => ({ ...s, extractN: Math.max(1, n) }));
  const setLimitN = (n: number) => setState((s) => ({ ...s, limitN: Math.max(0, n) }));
  const setExtractRef = (r: string) => setState((s) => ({ ...s, extractRef: r }));
  const setLimitRef = (r: string) => setState((s) => ({ ...s, limitRef: r }));
  const refTip = tt('Take this number from a variable instead — @name, @counter or @row',
                    'Pegar este número de uma variável — @nome, @counter ou @row');
  const numTip = tt('Back to a fixed number', 'Voltar para um número fixo');
  const setListPick = (v: ListPick) => setState((s) => ({ ...s, listPick: v }));

  // The chain holds something this editor cannot model, so every control is inert: touching one
  // would rebuild the token and drop the part we did not understand. Say so instead of letting
  // the user poke at dead checkboxes, and point at the one place that CAN edit it losslessly.
  if (state.unmodeled) {
    return (
      <div className="p-1 space-y-2">
        <div className="rounded border px-2.5 py-2 text-[11px] leading-relaxed"
          style={{
            color: 'var(--color-recording)',
            borderColor: 'color-mix(in srgb, var(--color-recording) 40%, transparent)',
            backgroundColor: 'color-mix(in srgb, var(--color-recording) 10%, transparent)',
          }}>
          {state.unmodeledRefArg
            ? tt('This token takes a line argument from a variable, which these controls can only show as a literal — so it is read-only here. It still runs; if the variable is missing or does not hold a valid value, the step yields nothing. Edit the token text directly to change it.',
                 'Este token pega um argumento de linha de uma variável, e estes controles só conseguem mostrar um valor literal — por isso está só para leitura. Ele roda normalmente; se a variável não existir ou não tiver um valor válido, o passo não devolve nada. Edite o texto do token para mudá-lo.')
            : tt('This token has a modifier this editor does not know, so it is shown read-only. Editing it here would quietly drop that part.',
                 'Este token tem um modificador que este editor não conhece, então está só para leitura. Editar aqui descartaria essa parte em silêncio.')}
        </div>
        <div className="text-[9px] uppercase tracking-wide text-text-tertiary">Token</div>
        <div className="font-mono text-[11.5px] px-2 py-0.5 rounded break-all"
          style={{
            color: 'var(--color-action-sendtext-fg)',
            background: 'color-mix(in srgb, var(--color-action-sendtext-fg) 10%, transparent)',
          }}>
          {token}
        </div>
        <div className="text-[10px] text-text-tertiary leading-snug">
          {tt('To change it, edit the token text directly in the editor.',
              'Para alterar, edite o texto do token direto no editor.')}
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Sequential consumption. Sits ABOVE Transform because that is the order the backend
          runs it in — pick the line first, then transform that line. Clipboard-only (showNext). */}
      {showNext && (
        <Section label="Sequence">
          <CheckRow
            checked={state.next}
            onChange={() => setState((s) => ({ ...s, next: !s.next }))}
            label="One line per use"
          />
          <div className="text-[10px] text-text-tertiary leading-snug mt-0.5">
            {state.next
              ? tt(
                  'Each use takes the next line and moves on. Copying something new starts over. The preview always shows line 1.',
                  'Cada uso pega a próxima linha e avança. Copiar algo novo recomeça do início. A prévia sempre mostra a linha 1.',
                )
              : tt('Pastes the whole clipboard.', 'Cola a área de transferência inteira.')}
          </div>
        </Section>
      )}

      {/* Transform case — 2-col grid (column-flow). Case options share a single
          radio-style state, so combinations like UPPERCASE + Sentence case are
          impossible by construction. Trim is orthogonal (whitespace, not case). */}
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

      <Section label="Extract">
        <RadioGroup label="Extract">
          <RadioRow
            checked={state.extract === 'none'}
            onChange={() => setExtract('none')}
            label="Everything"
          />
          <RadioRow
            checked={state.extract === 'line'}
            onChange={() => setExtract('line')}
            label="Line #"
            input={
              <ArgInput
                value={state.extractN}
                onChange={setExtractN}
                refValue={state.extractRef}
                onRefChange={setExtractRef}
                disabled={state.extract !== 'line'}
                min={1}
                refTip={refTip}
                numTip={numTip}
              />
            }
          />
          <RadioRow
            checked={state.extract === 'word'}
            onChange={() => setExtract('word')}
            label="Word #"
            input={
              <ArgInput
                value={state.extractN}
                onChange={setExtractN}
                refValue={state.extractRef}
                onRefChange={setExtractRef}
                disabled={state.extract !== 'word'}
                min={1}
                refTip={refTip}
                numTip={numTip}
              />
            }
          />
        </RadioGroup>
      </Section>

      {/* List ops — operate on the content as LINES, before the single-line Extract
          above narrows it down. Order in the emitted token mirrors the backend
          pipeline: range/lines → sort → dedupe → reverse → join. */}
      <Section label="Lines">
        <RadioGroup label="Lines">
          <RadioRow
            checked={state.listPick === 'none'}
            onChange={() => setListPick('none')}
            label="All lines"
          />
          <RadioRow
            checked={state.listPick === 'range'}
            onChange={() => setListPick('range')}
            label="Range"
            input={
              <span className="flex items-center gap-1">
                <NumInput
                  value={state.rangeFrom}
                  onChange={(n) => setState((s) => ({ ...s, rangeFrom: Math.max(1, n) }))}
                  disabled={state.listPick !== 'range'}
                  min={1}
                />
                <span className="text-[11px] text-text-tertiary">–</span>
                <NumInput
                  value={state.rangeTo}
                  onChange={(n) => setState((s) => ({ ...s, rangeTo: Math.max(1, n) }))}
                  disabled={state.listPick !== 'range'}
                  min={1}
                />
              </span>
            }
          />
          <RadioRow
            checked={state.listPick === 'lines'}
            onChange={() => setListPick('lines')}
            label="Pick #s"
            input={
              <input
                type="text"
                value={state.linesSpec}
                onChange={(e) => setState((s) => ({ ...s, linesSpec: e.target.value.replace(/[^0-9,]/g, '') }))}
                disabled={state.listPick !== 'lines'}
                placeholder="3,1,2"
                className="h-7 w-[70px] px-1.5 text-xs font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid disabled:opacity-50"
              />
            }
          />
        </RadioGroup>
        <div className="grid grid-flow-col grid-rows-2 gap-x-3 mt-1">
          <CheckRow
            checked={state.sort}
            onChange={() => setState((s) => ({ ...s, sort: !s.sort }))}
            label="Sort A–Z"
          />
          <CheckRow
            checked={state.dedupe}
            onChange={() => setState((s) => ({ ...s, dedupe: !s.dedupe }))}
            label="Dedupe"
          />
          <CheckRow
            checked={state.reverse}
            onChange={() => setState((s) => ({ ...s, reverse: !s.reverse }))}
            label="Reverse"
          />
        </div>
        <div className="flex items-center gap-2 py-0.5">
          {/* Hand-rolled CheckRow variant: the separator input needs to sit inline,
              and CheckRow's button spans the full row width. Separator can't contain
              { } : (token grammar) — stripped on input. */}
          <button
            type="button"
            role="checkbox"
            aria-checked={state.join}
            onClick={() => setState((s) => ({ ...s, join: !s.join }))}
            className="flex items-center gap-2 text-xs text-text-secondary hover:text-text-primary"
          >
            <CheckboxBox checked={state.join} />
            <span>Join with</span>
          </button>
          <input
            type="text"
            value={state.joinSep}
            onChange={(e) => setState((s) => ({ ...s, joinSep: e.target.value.replace(/[{}:]/g, '') }))}
            disabled={!state.join}
            placeholder=","
            className="h-7 w-[70px] px-1.5 text-xs font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid disabled:opacity-50"
          />
        </div>
      </Section>

      <Section label="Limit length">
        <RadioGroup label="Limit length">
          <RadioRow
            checked={state.limit === 'none'}
            onChange={() => setLimit('none')}
            label="None"
          />
          <RadioRow
            checked={state.limit === 'first'}
            onChange={() => setLimit('first')}
            label="First N chars"
            input={
              <ArgInput
                value={state.limitN}
                onChange={setLimitN}
                refValue={state.limitRef}
                onRefChange={setLimitRef}
                refTip={refTip}
                numTip={numTip}
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
              <ArgInput
                value={state.limitN}
                onChange={setLimitN}
                refValue={state.limitRef}
                onRefChange={setLimitRef}
                refTip={refTip}
                numTip={numTip}
                disabled={state.limit !== 'last'}
                min={0}
              />
            }
          />
        </RadioGroup>
      </Section>

      <div className="px-3.5 py-1.5 bg-bg-surface border-b border-border-subtle">
        <div className="text-[9px] uppercase tracking-wide text-text-tertiary mb-0.5">{sourceLabel}</div>
        <div
          className="font-mono text-[10.5px] text-text-secondary bg-white/[0.03] border-l-2 border-border-subtle px-2 py-0.5 mb-1.5 rounded-r whitespace-pre-wrap break-all max-h-[36px] overflow-auto"
          style={{ lineHeight: 1.35 }}
        >
          {clipReady ? (
            clipRaw === '' ? (
              <span className="italic text-text-disabled">(empty)</span>
            ) : (
              clipRaw
            )
          ) : (
            <span className="italic text-text-disabled">Reading...</span>
          )}
        </div>
        <div className="text-[9px] uppercase tracking-wide text-text-tertiary mb-0.5">Token</div>
        <div
          className="font-mono text-[11.5px] px-2 py-0.5 mb-1.5 rounded break-all"
          style={{
            color: 'var(--color-action-sendtext-fg)',
            background: 'color-mix(in srgb, var(--color-action-sendtext-fg) 10%, transparent)',
          }}
        >
          {token}
        </div>
        <div className="text-[9px] uppercase tracking-wide text-text-tertiary mb-0.5">Preview</div>
        <div
          className="font-mono text-[11px] px-2 py-0.5 rounded border-l-2 whitespace-pre-wrap break-all min-h-[20px] max-h-[72px] overflow-auto"
          style={{
            background: 'color-mix(in srgb, var(--color-replay) 8%, transparent)',
            borderColor: 'color-mix(in srgb, var(--color-replay) 50%, transparent)',
            color: 'var(--color-replay)',
          }}
        >
          {/* Unfinished FIRST: with one good reference and one half-typed "@", the actionable
              message is the one about the field still waiting on a name. */}
          {refUnfinished
            ? <span className="italic" style={{ color: 'var(--color-recording)' }}>
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
    </>
  );
}
