import { useState, useEffect } from 'react';
import { AlertCircle, X } from 'lucide-react';
import { useBridge } from '../bridge/BridgeContext';

export function ExtensionUpdateBanner() {
  const { subscribe } = useBridge();
  const [outdated, setOutdated] = useState<{ current: string; expected: string } | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === 'browser:extensionOutdated') {
        const payload = msg.payload as { currentVersion: string; expectedVersion: string };
        setOutdated({ current: payload.currentVersion, expected: payload.expectedVersion });
        setDismissed(false);
      }
    });
  }, [subscribe]);

  if (!outdated || dismissed) return null;

  return (
    <div className="flex items-center gap-2.5 px-3 py-2 rounded-ui"
      style={{
        background: 'linear-gradient(135deg, rgba(251,146,60,0.08), rgba(251,146,60,0.03))',
        border: '1px solid rgba(251,146,60,0.25)',
      }}
    >
      <AlertCircle size={16} className="shrink-0" style={{ color: '#fb923c' }} />
      <span className="flex-1 text-xs text-text-secondary">
        Chrome Extension update:
        <span className="font-mono text-[11px] mx-1 px-1.5 py-0.5 rounded" style={{ color: '#fb923c', background: 'rgba(251,146,60,0.1)' }}>
          v{outdated.current}
        </span>
        &rarr;
        <span className="font-mono text-[11px] mx-1 px-1.5 py-0.5 rounded" style={{ color: '#fb923c', background: 'rgba(251,146,60,0.1)' }}>
          v{outdated.expected}
        </span>
        &mdash; Reload in chrome://extensions
      </span>
      <button
        onClick={() => setDismissed(true)}
        className="p-1 rounded hover:bg-bg-elevated text-text-disabled hover:text-text-secondary transition-colors"
      >
        <X size={14} />
      </button>
    </div>
  );
}
