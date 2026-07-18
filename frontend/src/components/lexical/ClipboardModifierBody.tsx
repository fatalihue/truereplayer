import React, { useMemo } from 'react';
import { Section, CheckRow, RadioRow, RadioGroup, NumInput } from './popoverAtoms';
import { CheckboxBox } from '../Checkbox';
import {
  applyTransformPreview,
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
}: ClipboardModifierBodyProps) {
  const token = useMemo(
    () => tokenOverride ?? buildClipboardToken(state),
    [tokenOverride, state],
  );
  const preview = useMemo(() => applyTransformPreview(clipRaw, state), [clipRaw, state]);

  const toggleCase = (v: 'upper' | 'lower' | 'sentence' | 'title') =>
    setState((s) => ({ ...s, case: s.case === v ? 'none' : v }));

  const setExtract = (v: Extract) => setState((s) => ({ ...s, extract: v }));
  const setLimit = (v: Limit) => setState((s) => ({ ...s, limit: v }));
  const setExtractN = (n: number) => setState((s) => ({ ...s, extractN: Math.max(1, n) }));
  const setLimitN = (n: number) => setState((s) => ({ ...s, limitN: Math.max(0, n) }));
  const setListPick = (v: ListPick) => setState((s) => ({ ...s, listPick: v }));

  return (
    <>
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
          {preview === '' ? <span className="italic text-text-disabled">(empty)</span> : preview}
        </div>
      </div>
    </>
  );
}
