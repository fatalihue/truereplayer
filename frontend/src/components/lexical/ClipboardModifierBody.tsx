import React, { useMemo } from 'react';
import { Section, CheckRow, RadioRow, RadioGroup, NumInput } from './popoverAtoms';
import {
  applyTransformPreview,
  buildClipboardToken,
  type Extract,
  type Limit,
  type TransformState,
} from './clipboardModifiers';

interface ClipboardModifierBodyProps {
  state: TransformState;
  setState: React.Dispatch<React.SetStateAction<TransformState>>;
  clipRaw: string;
  clipReady: boolean;
}

// The Transform / Extract / Limit + Clipboard / Token / Preview sections.
// Stateless about UI shell (header, footer, positioning) — those are owned by
// each consumer popover. Keeps the editor markup identical between insert and
// edit flows so users see the same controls in both contexts.
export function ClipboardModifierBody({
  state,
  setState,
  clipRaw,
  clipReady,
}: ClipboardModifierBodyProps) {
  const token = useMemo(() => buildClipboardToken(state), [state]);
  const preview = useMemo(() => applyTransformPreview(clipRaw, state), [clipRaw, state]);

  const toggleCase = (v: 'upper' | 'lower' | 'sentence' | 'title') =>
    setState((s) => ({ ...s, case: s.case === v ? 'none' : v }));

  const setExtract = (v: Extract) => setState((s) => ({ ...s, extract: v }));
  const setLimit = (v: Limit) => setState((s) => ({ ...s, limit: v }));
  const setExtractN = (n: number) => setState((s) => ({ ...s, extractN: Math.max(1, n) }));
  const setLimitN = (n: number) => setState((s) => ({ ...s, limitN: Math.max(0, n) }));

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
        <div className="text-[9px] uppercase tracking-wide text-text-tertiary mb-0.5">Clipboard</div>
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
    </>
  );
}
