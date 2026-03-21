import { useState, useRef, useEffect } from 'react';
import { Globe } from 'lucide-react';

interface NavigateDialogProps {
  onConfirm: (url: string, newTab: boolean) => void;
  onClose: () => void;
}

export function NavigateDialog({ onConfirm, onClose }: NavigateDialogProps) {
  const [url, setUrl] = useState('');
  const [newTab, setNewTab] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleConfirm = () => {
    const trimmed = url.trim();
    if (trimmed) onConfirm(trimmed, newTab);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleConfirm();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onKeyDown={(e) => e.stopPropagation()}
      onClick={onClose}
    >
      <div
        className="bg-bg-elevated border border-border-subtle rounded-lg shadow-xl w-[480px] max-w-[90vw] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle">
          <Globe size={14} className="text-[#60cdff]" />
          <h3 className="text-sm font-semibold text-text-primary">Navigate to URL</h3>
        </div>

        {/* Body */}
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

          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={newTab}
              onChange={(e) => setNewTab(e.target.checked)}
              className="w-3.5 h-3.5 rounded border-border-default accent-accent-solid cursor-pointer"
            />
            <span className="text-xs text-text-secondary">Open in new tab</span>
          </label>

          <p className="text-[11px] text-text-tertiary">
            Protocol (https://) will be added automatically if omitted.
          </p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border-subtle">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-medium text-text-secondary bg-bg-card hover:bg-bg-surface border border-border-subtle rounded transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!url.trim()}
            className="px-4 py-1.5 text-xs font-medium text-white bg-accent-solid hover:bg-accent-solid/80 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
