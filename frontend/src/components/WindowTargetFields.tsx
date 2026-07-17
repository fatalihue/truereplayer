import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { X, ChevronDown } from 'lucide-react';
import { useBridge } from '../bridge/BridgeContext';
import { useTt } from '../state/LanguageContext';
import { Field } from './sheet/Field';
import { SegmentedControl } from './common/SegmentedControl';

export type WindowTargetValue = {
  processName: string;
  windowTitle: string;
  titleMatchMode: 'contains' | 'regex';
};

/**
 * The shared "which window" matcher trio — Process (with a running-process picker), Title, and a
 * Contains/Regex mode toggle — plus an optional "Detect window (click on target)" button. Extracted
 * from TargetConfigDialog so the ActivateWindow and If-Window sheet editors get the same picker +
 * Detect they used to lack, and all three sites stay in lockstep.
 *
 * OWNS the transient UI state (picker open/filter, the fetched process list, detecting) and self-wires
 * the bridge (process:list lazy fetch + subscription, profile:detectWindow send + windowTarget:detected/
 * detectState) plus the capture-phase Esc handler that dismisses the picker/detection BEFORE a host
 * modal's own Esc can fire. The PERSISTED values stay owned by the parent via value/onChange.
 *
 * The Test button is intentionally NOT here: the dialog's Test is a foreground-only
 * profile:testWindowMatch, while the sheet editors' Test is an exists-anywhere window:testProbe —
 * different semantics, so each site keeps its own.
 */
export type WindowTargetFieldsHandle = {
  /** Cancel an in-flight "Detect window" if one is active. The host calls this when it commits
   *  WITHOUT unmounting (the dialog's keep-open "Apply target & convert" path) so the global
   *  click-capture doesn't stay armed. Unmount already handles the ordinary close paths. */
  stopDetection: () => void;
};

export const WindowTargetFields = forwardRef<WindowTargetFieldsHandle, {
  value: WindowTargetValue;
  onChange: (patch: Partial<WindowTargetValue>) => void;
  /** Called on any user edit (typing, picker pick, detect). Hosts use it to mark the form dirty
   *  and clear a stale test result. */
  onEdit?: () => void;
  showDetect?: boolean;
  /** Optional error rendered under the Title input (e.g. the dialog's live regex validation). */
  titleError?: string | null;
  processLabel?: string;
  processHint?: string;
  titleHint?: string;
}>(function WindowTargetFields({
  value,
  onChange,
  onEdit,
  showDetect = true,
  titleError = null,
  processLabel = 'Process',
  processHint,
  titleHint,
}, ref) {
  const { send, subscribe } = useBridge();
  const tt = useTt();

  const [processList, setProcessList] = useState<{ name: string; title: string }[] | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [filter, setFilter] = useState('');
  const [isDetecting, setIsDetecting] = useState(false);

  // The subscribe callback below must call the LATEST onChange/onEdit, not the ones captured on
  // first render (a host that passes inline callbacks re-creates them each render). Route through
  // refs so the subscription can depend only on [subscribe] and never go stale.
  const onChangeRef = useRef(onChange);
  const onEditRef = useRef(onEdit);
  onChangeRef.current = onChange;
  onEditRef.current = onEdit;
  const edit = (patch: Partial<WindowTargetValue>) => { onChangeRef.current(patch); onEditRef.current?.(); };

  // Detection is a global click-capture on the backend — if the host (a modal, or the sheet) closes
  // while we're still waiting for the target click, unmount toggles it back off so it doesn't leak.
  // Guarded on a ref so we never send the toggle when detection wasn't active (that would turn it ON).
  const isDetectingRef = useRef(false);
  isDetectingRef.current = isDetecting;
  const sendRef = useRef(send);
  sendRef.current = send;

  // Cancel an active detection NOW. Clears the ref synchronously (before the setState re-render) so
  // the unmount cleanup below can't fire a second toggle — a double toggle would re-arm detection.
  const stopDetection = () => {
    if (!isDetectingRef.current) return;
    isDetectingRef.current = false;
    setIsDetecting(false);
    sendRef.current({ type: 'profile:detectWindow', payload: {} });
  };
  useImperativeHandle(ref, () => ({ stopDetection }), []);

  useEffect(() => () => {
    if (isDetectingRef.current) sendRef.current({ type: 'profile:detectWindow', payload: {} });
  }, []);

  useEffect(() => subscribe((msg) => {
    if (msg.type === 'windowTarget:detected') {
      const p = msg.payload as { processName: string; windowTitle: string };
      edit({ processName: p.processName, windowTitle: p.windowTitle });
      setIsDetecting(false);
    } else if (msg.type === 'windowTarget:detectState') {
      setIsDetecting((msg.payload as { detecting: boolean }).detecting);
    } else if (msg.type === 'process:list') {
      setProcessList((msg.payload as { processes: { name: string; title: string }[] }).processes);
    }
  }), [subscribe]);

  // Esc priority (most specific first): close the picker → cancel detection. Capture phase so we
  // win before a host modal's own Esc tears the whole thing down; when neither overlay is active we
  // leave the event alone so it falls through to the host.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showPicker) {
        e.stopPropagation();
        setShowPicker(false);
      } else if (isDetecting) {
        e.stopPropagation();
        send({ type: 'profile:detectWindow', payload: {} }); // backend toggles detection off
        setIsDetecting(false);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [showPicker, isDetecting, send]);

  const inputCls = 'w-full h-8 px-2 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid';

  return (
    <>
      <Field label={processLabel} hint={processHint}>
        <div className="relative">
          <input
            type="text"
            value={value.processName}
            onChange={(e) => edit({ processName: e.target.value })}
            placeholder="notepad.exe"
            spellCheck={false}
            className={inputCls + ' pr-14'}
          />
          <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-1">
            {value.processName && (
              <button
                type="button"
                onClick={() => edit({ processName: '' })}
                className="p-1 text-text-disabled hover:text-text-secondary transition-colors"
              >
                <X size={12} />
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                const next = !showPicker;
                setShowPicker(next);
                // Lazy fetch — first open enumerates. Re-opens reuse the cache.
                if (next && processList === null) send({ type: 'process:list', payload: {} });
              }}
              data-tip={tt('Pick from running processes', 'Escolher de processos em execução')}
              className={`p-1 transition-colors ${showPicker ? 'text-accent' : 'text-text-tertiary hover:text-text-secondary'}`}
            >
              <ChevronDown size={14} />
            </button>
          </div>
          {showPicker && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-bg-card border border-border-default rounded shadow-lg z-10 max-h-64 overflow-hidden flex flex-col">
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                autoFocus
                placeholder={tt('Filter…', 'Filtrar…')}
                className="w-full h-7 px-2 text-[11px] text-text-primary bg-bg-input border-b border-border-subtle outline-none"
              />
              <div className="overflow-y-auto flex-1">
                {processList === null ? (
                  <div className="px-2 py-2 text-[11px] text-text-tertiary">{tt('Loading…', 'Carregando…')}</div>
                ) : (() => {
                  const f = filter.trim().toLowerCase();
                  const items = f.length === 0
                    ? processList
                    : processList.filter(p => p.name.toLowerCase().includes(f) || p.title.toLowerCase().includes(f));
                  if (items.length === 0) {
                    return <div className="px-2 py-2 text-[11px] text-text-tertiary">{tt('No processes match.', 'Nenhum processo corresponde.')}</div>;
                  }
                  return items.map((p) => (
                    <button
                      type="button"
                      key={p.name}
                      onClick={() => {
                        edit({ processName: p.name });
                        setShowPicker(false);
                        setFilter('');
                      }}
                      className="w-full text-left px-2 py-1 text-[11px] hover:bg-bg-elevated transition-colors"
                    >
                      <span className="font-mono text-text-primary">{p.name}</span>
                      {p.title && <span className="text-text-tertiary"> — {p.title}</span>}
                    </button>
                  ));
                })()}
              </div>
            </div>
          )}
        </div>
      </Field>

      <Field
        label="Title"
        labelAdornment={
          <div className="ml-auto">
            <SegmentedControl<'contains' | 'regex'>
              ariaLabel="Title match mode"
              value={value.titleMatchMode}
              onChange={(m) => edit({ titleMatchMode: m })}
              options={[
                { value: 'contains', label: 'Contains', tip: tt('Title must contain this text (case-insensitive)', 'Título deve conter este texto (sem diferenciar maiúsculas)') },
                { value: 'regex', label: 'Regex', tip: tt('Title is a .NET regular expression (case-insensitive)', 'Título é uma expressão regular .NET (sem diferenciar maiúsculas)') },
              ]}
            />
          </div>
        }
        hint={titleHint}
      >
        <div className="relative">
          <input
            type="text"
            value={value.windowTitle}
            onChange={(e) => edit({ windowTitle: e.target.value })}
            placeholder={value.titleMatchMode === 'regex' ? 'e.g. (Chrome|Firefox)' : ''}
            spellCheck={false}
            className={inputCls + (value.windowTitle ? ' pr-7' : '') + (titleError ? ' border-recording/60 focus:border-recording' : '')}
          />
          {value.windowTitle && (
            <button
              type="button"
              onClick={() => edit({ windowTitle: '' })}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-disabled hover:text-text-secondary transition-colors"
            >
              <X size={12} />
            </button>
          )}
        </div>
        {titleError && <p className="text-[10px] text-recording mt-1 leading-tight">{titleError}</p>}
      </Field>

      {showDetect && (
        <button
          type="button"
          onClick={() => { onEditRef.current?.(); send({ type: 'profile:detectWindow', payload: {} }); }}
          className={`w-full h-8 text-xs border rounded transition-colors ${
            isDetecting
              ? 'text-recording border-recording/40 bg-recording/10 hover:bg-recording/20'
              : 'text-accent border-accent-solid/40 hover:bg-accent-solid/10'
          }`}
        >
          {isDetecting
            ? tt('Waiting for click… (click target window)', 'Aguardando clique… (clique na janela-alvo)')
            : tt('Detect Window (click on target)', 'Detectar janela (clique no alvo)')}
        </button>
      )}
    </>
  );
});
