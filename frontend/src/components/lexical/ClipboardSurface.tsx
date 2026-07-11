import React, { useMemo } from 'react';
import { ChevronLeft, RefreshCw, RotateCcw, Wand2 } from 'lucide-react';
import { SegmentedControl } from '../common/SegmentedControl';
import { NumberInput } from '../common/NumberInput';
import { CheckboxBox } from '../Checkbox';
import { useTt } from '../../state/LanguageContext';
import { useClipboardContent } from './useClipboardContent';
import {
  applyTransformPreview,
  buildClipboardToken,
  type CaseTransform,
  type Extract,
  type Limit,
  type ListPick,
  type TransformState,
} from './clipboardModifiers';

interface ClipboardSurfaceProps {
  /** Lifted TransformState — the parent owns it so the DialogShell footer
   *  (Insert/Apply, swapped in by SendTextDialog) can build the token too. */
  state: TransformState;
  onStateChange: React.Dispatch<React.SetStateAction<TransformState>>;
  /** `‹ Editor` — leave the surface discarding changes (same as footer Cancel). */
  onBack: () => void;
  /** Reset to the session's starting state (DEFAULT_TRANSFORM on insert,
   *  the chip's original token on edit). */
  onReset: () => void;
}

// Full-body "Advanced Clipboard" sub-surface of the Insert Text dialog — the
// ThemeEditor surface-swap pattern, but mounted as an `absolute inset-0`
// OVERLAY inside the dialog's relative body wrapper so the Lexical editor
// underneath never unmounts (undo stack, caret and selection all survive a
// round-trip through this surface).
//
// The five config sections are laid out in the BACKEND PIPELINE ORDER
// (trim → lines → extract → limit → case — see clipboardModifiers.ts header),
// each with a step badge that lights up while its step is active, so the UI
// reads as the data flow it actually is. Serialization stays exclusively in
// buildClipboardToken — this component emits no token strings of its own.
export function ClipboardSurface({ state, onStateChange, onBack, onReset }: ClipboardSurfaceProps) {
  const tt = useTt();
  const { clipRaw, clipReady, refresh } = useClipboardContent();
  const token = useMemo(() => buildClipboardToken(state), [state]);
  const preview = useMemo(() => applyTransformPreview(clipRaw, state), [clipRaw, state]);

  const set = (patch: Partial<TransformState>) => onStateChange((s) => ({ ...s, ...patch }));

  const linesActive =
    state.listPick !== 'none' || state.sort || state.dedupe || state.reverse || state.join;

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
        <div className="text-xs font-semibold text-text-primary flex-1">Advanced Clipboard</div>
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
        {/* Config column — single column, backend pipeline order. */}
        <div className="min-w-0 flex-1 overflow-y-auto p-4 space-y-4">
          <Step n={1} title="Trim" active={state.trim}>
            <CheckRow
              checked={state.trim}
              onChange={() => set({ trim: !state.trim })}
              label="Trim whitespace"
            />
          </Step>

          <Step n={2} title="Lines" active={linesActive}>
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
                      min={1}
                      inputWidth="w-14"
                      inputHeight="h-8"
                    />
                    <span className="text-[11px] text-text-tertiary">–</span>
                    <NumberInput
                      value={state.rangeTo}
                      onChange={(n) => set({ rangeTo: Math.max(1, n) })}
                      min={1}
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

          <Step n={3} title="Extract" active={state.extract !== 'none'}>
            <div className="flex items-center gap-2 flex-wrap">
              <SegmentedControl<Extract>
                ariaLabel="Extract"
                options={[
                  { value: 'none', label: 'Everything' },
                  { value: 'line', label: 'Line #' },
                  { value: 'word', label: 'Word #' },
                ]}
                value={state.extract}
                onChange={(v) => set({ extract: v })}
              />
              {state.extract !== 'none' && (
                <NumberInput
                  value={state.extractN}
                  onChange={(n) => set({ extractN: Math.max(1, n) })}
                  min={1}
                  inputWidth="w-14"
                  inputHeight="h-8"
                />
              )}
            </div>
          </Step>

          <Step n={4} title="Limit length" active={state.limit !== 'none'}>
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
                <NumberInput
                  value={state.limitN}
                  onChange={(n) => set({ limitN: Math.max(0, n) })}
                  min={0}
                  inputWidth="w-14"
                  inputHeight="h-8"
                />
              )}
            </div>
          </Step>

          <Step n={5} title="Case" active={state.case !== 'none'}>
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
          </Step>
        </div>

        {/* Preview rail — permanent, unlike the old popover's cramped strip. */}
        <div className="w-[320px] shrink-0 border-l border-border-subtle bg-bg-surface p-3 flex flex-col gap-2 min-h-0">
          <div className="shrink-0">
            <div className="flex items-center justify-between mb-1">
              <div className="label-micro text-text-tertiary">Clipboard now</div>
              <button
                type="button"
                onClick={refresh}
                className="w-5 h-5 flex items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-bg-card transition-colors"
                data-tip={tt('Re-read the clipboard', 'Reler a área de transferência')}
              >
                <RefreshCw size={11} />
              </button>
            </div>
            <div
              className="font-mono text-[10.5px] text-text-secondary bg-bg-input border border-border-subtle px-2 py-1 rounded whitespace-pre-wrap break-all max-h-24 overflow-auto"
              style={{ lineHeight: 1.35 }}
            >
              {clipReady ? (
                clipRaw === '' ? <span className="italic text-text-disabled">(empty)</span> : clipRaw
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
                color: 'var(--color-replay)',
              }}
            >
              {preview === '' ? <span className="italic text-text-disabled">(empty)</span> : preview}
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
