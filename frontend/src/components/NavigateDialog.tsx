import { useState, useRef, useEffect } from 'react';
import { Globe } from 'lucide-react';
import { Checkbox } from './Checkbox';
import { DialogShell } from './common/DialogShell';
import { Button } from './common/Button';

interface NavigateDialogProps {
  onConfirm: (url: string, newTab: boolean) => void;
  onClose: () => void;
}

export function NavigateDialog({ onConfirm, onClose }: NavigateDialogProps) {
  const [url, setUrl] = useState('');
  const [newTab, setNewTab] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the URL input on mount so the user can type immediately. Runs after
  // DialogShell's own card-focus effect (child effects fire before the parent's),
  // so the input keeps the final focus.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleConfirm = () => {
    const trimmed = url.trim();
    if (trimmed) onConfirm(trimmed, newTab);
  };

  return (
    <DialogShell
      icon={<Globe size={14} style={{ color: 'var(--color-action-browser-fg)' }} />}
      title="Open URL"
      widthClass="w-[480px]"
      onClose={onClose}
      // Text-entry dialog: a stray click on the scrim must not discard a
      // typed URL — dismissal is Esc or Cancel only.
      closeOnBackdrop={false}
      footerHint="Enter to confirm · Esc to cancel"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleConfirm} disabled={!url.trim()}>
            Add
          </Button>
        </>
      }
      onCardKeyDown={(e) => {
        // Enter confirms from anywhere in the card (the URL input is the only
        // text field). Esc is owned by DialogShell.
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          handleConfirm();
        }
      }}
    >
      <div className="px-4 py-4 space-y-3">
        <input
          ref={inputRef}
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          className="w-full h-9 px-3 text-sm text-text-primary bg-bg-input border border-border-subtle rounded outline-none focus:border-accent-solid placeholder:text-text-disabled transition-colors"
        />

        <Checkbox
          checked={newTab}
          onChange={setNewTab}
          label="Open in new tab"
        />

        <p className="text-[11px] text-text-tertiary">
          Protocol (https://) will be added automatically if omitted.
        </p>
      </div>
    </DialogShell>
  );
}
