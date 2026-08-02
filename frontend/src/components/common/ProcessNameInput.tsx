import { useEffect, useRef, useState } from 'react';
import { X, ChevronDown } from 'lucide-react';
import { useBridge } from '../../bridge/BridgeContext';
import { useTt } from '../../state/LanguageContext';

/**
 * Free-text process name with a running-process picker — type it by hand, or open the
 * dropdown and pick one that is running right now (filterable, shows the window title as
 * a hint). Same control the Window Target matcher offers; this is the standalone version
 * for the sheet editors that only need the process, not the whole matcher trio.
 *
 * Owns the transient UI state (picker open, filter, the fetched list); the persisted
 * value stays with the parent. The list is fetched LAZILY on first open and cached for
 * the component's lifetime — enumerating processes is not free, and a sheet editor that
 * merely renders this field must not pay for it.
 */
export function ProcessNameInput({
  value,
  onChange,
  placeholder = 'chrome.exe',
}: {
  value: string;
  onChange: (name: string) => void;
  placeholder?: string;
}) {
  const { send, subscribe } = useBridge();
  const tt = useTt();

  const [processList, setProcessList] = useState<{ name: string; title: string }[] | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [filter, setFilter] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => subscribe((msg) => {
    if (msg.type === 'process:list') {
      setProcessList((msg.payload as { processes: { name: string; title: string }[] }).processes);
    }
  }), [subscribe]);

  // Esc closes the picker and stops there (capture phase), so it doesn't also reach a host
  // sheet/modal and tear the whole editor down on the same press. Only armed while open.
  useEffect(() => {
    if (!showPicker) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setShowPicker(false);
    };
    // The sheet editor is not a modal, so an outside click has to dismiss the dropdown too —
    // otherwise it hangs over the panel until picked.
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setShowPicker(false);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown, true);
    };
  }, [showPicker]);

  return (
    <div className="relative" ref={rootRef}>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className="w-full h-8 px-2 pr-14 text-ui font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
      />
      <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-1">
        {value && (
          <button
            type="button"
            onClick={() => onChange('')}
            aria-label={tt('Clear', 'Limpar')}
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
          aria-label={tt('Pick a running process', 'Escolher um processo em execução')}
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
                    onChange(p.name);
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
  );
}
