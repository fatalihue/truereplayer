import { useState, useRef, useEffect } from 'react';
import { Keyboard } from 'lucide-react';
import { DialogShell } from './common/DialogShell';
import { Button } from './common/Button';
import { useBridge } from '../bridge/BridgeContext';
import { useTt } from '../state/LanguageContext';

/**
 * Runtime "Ask-Input" modal for the {input:Label} token. When the replay resolver hits an
 * {input:…} token it PAUSES the run and asks the host to prompt the user; the answer is sent
 * back and substituted. `options` non-null renders a click-to-pick list ({input:Label|menu:a,b,c},
 * a formmenu); null renders a text field. Cancelling (button / Esc) ABORTS the run — the backend
 * treats a cancel like a Stop — so backdrop-dismiss is disabled to avoid an accidental abort.
 */
interface AskInputDialogProps {
  label: string;
  options: string[] | null;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

function AskInputDialog({ label, options, onSubmit, onCancel }: AskInputDialogProps) {
  const tt = useTt();
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const isMenu = options != null && options.length > 0;

  useEffect(() => {
    if (!isMenu) inputRef.current?.focus();
  }, [isMenu]);

  return (
    <DialogShell
      icon={<Keyboard size={14} className="text-accent-solid" />}
      title="Input needed"
      widthClass="w-[400px]"
      onClose={onCancel}
      closeOnBackdrop={false}
      footerHint={isMenu
        ? tt('Pick an option · Esc cancels the run', 'Escolha uma opção · Esc cancela a execução')
        : tt('Enter to submit · Esc cancels the run', 'Enter para enviar · Esc cancela a execução')}
      footer={isMenu ? undefined : (
        <>
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={() => onSubmit(value)}>Submit</Button>
        </>
      )}
      onCardKeyDown={(e) => {
        if (!isMenu && e.key === 'Enter') { e.preventDefault(); onSubmit(value); }
      }}
    >
      <div className="px-4 py-4 flex flex-col gap-3">
        <p className="text-sm text-text-primary break-words">{label}</p>
        {isMenu ? (
          <div className="flex flex-col gap-1.5 max-h-[300px] overflow-y-auto">
            {options!.map((opt, i) => (
              <button
                key={i}
                onClick={() => onSubmit(opt)}
                className="text-left px-3 h-8 rounded border border-border-subtle bg-bg-card hover:bg-bg-surface text-ui text-text-secondary hover:text-text-primary transition-colors truncate"
              >
                {opt}
              </button>
            ))}
          </div>
        ) : (
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="h-8 px-2 rounded border border-border-subtle bg-bg-card text-ui text-text-primary outline-none focus:border-border-default"
          />
        )}
      </div>
    </DialogShell>
  );
}

/**
 * Global host mounted once (App overlays): subscribes to the Ask-Input bridge messages and renders
 * the modal for the current pending request. inputDismiss (Stop mid-prompt — backend already
 * resolved the await) just clears the UI without sending a result.
 */
export function AskInputHost() {
  const { send, subscribe } = useBridge();
  const [req, setReq] = useState<{ requestId: string; label: string; options: string[] | null } | null>(null);

  useEffect(() => subscribe((m) => {
    if (m.type === 'replay:inputRequest') {
      setReq(m.payload);
    } else if (m.type === 'replay:inputDismiss') {
      setReq((cur) => (cur && cur.requestId === m.payload.requestId ? null : cur));
    }
  }), [subscribe]);

  if (!req) return null;

  const finish = (value: string, cancelled: boolean) => {
    send({ type: 'replay:inputResult', payload: { requestId: req.requestId, value, cancelled } });
    setReq(null);
  };

  return (
    <AskInputDialog
      key={req.requestId}
      label={req.label}
      options={req.options}
      onSubmit={(v) => finish(v, false)}
      onCancel={() => finish('', true)}
    />
  );
}
