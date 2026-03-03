import { useState, useEffect } from 'react';
import { useBridge } from '../bridge/BridgeContext';
import { Download, X, RotateCw } from 'lucide-react';

type UpdateState =
  | { phase: 'hidden' }
  | { phase: 'available'; version: string; currentVersion: string }
  | { phase: 'downloading'; percent: number }
  | { phase: 'restarting' }
  | { phase: 'error'; message: string };

export function UpdateBanner() {
  const { send, subscribe } = useBridge();
  const [state, setState] = useState<UpdateState>({ phase: 'hidden' });

  useEffect(() => {
    return subscribe((msg) => {
      switch (msg.type) {
        case 'update:available':
          setState({
            phase: 'available',
            version: msg.payload.version,
            currentVersion: msg.payload.currentVersion,
          });
          break;
        case 'update:progress':
          setState({ phase: 'downloading', percent: msg.payload.percent });
          break;
        case 'update:ready':
          setState({ phase: 'restarting' });
          break;
        case 'update:error':
          setState({ phase: 'error', message: msg.payload.message });
          break;
      }
    });
  }, [subscribe]);

  if (state.phase === 'hidden') return null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 12px',
        background: 'var(--color-bg-elevated)',
        borderBottom: '1px solid var(--color-accent)',
        fontSize: 'var(--font-size)',
        color: 'var(--color-text-primary)',
        minHeight: 34,
      }}
    >
      {state.phase === 'available' && (
        <>
          <Download size={14} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
          <span style={{ flex: 1 }}>
            New version <strong>{state.version}</strong> available
          </span>
          <button onClick={() => send({ type: 'update:apply', payload: {} })} style={btnStyle}>
            Update
          </button>
          <button
            onClick={() => setState({ phase: 'hidden' })}
            style={{ ...iconBtnStyle }}
            title="Dismiss"
          >
            <X size={14} />
          </button>
        </>
      )}

      {state.phase === 'downloading' && (
        <>
          <RotateCw size={14} style={{ color: 'var(--color-accent)', flexShrink: 0, animation: 'spin 1s linear infinite' }} />
          <span style={{ flex: 1 }}>Downloading update... {state.percent}%</span>
          <div style={progressBarTrack}>
            <div style={{ ...progressBarFill, width: `${state.percent}%` }} />
          </div>
        </>
      )}

      {state.phase === 'restarting' && (
        <>
          <RotateCw size={14} style={{ color: 'var(--color-accent)', flexShrink: 0, animation: 'spin 1s linear infinite' }} />
          <span>Restarting...</span>
        </>
      )}

      {state.phase === 'error' && (
        <>
          <span style={{ color: '#ff6b6b', flex: 1 }}>Update failed: {state.message}</span>
          <button onClick={() => setState({ phase: 'hidden' })} style={iconBtnStyle} title="Dismiss">
            <X size={14} />
          </button>
        </>
      )}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: 'var(--color-accent-solid)',
  color: '#fff',
  border: 'none',
  borderRadius: 'var(--border-radius)',
  padding: '3px 12px',
  fontSize: 'var(--font-size)',
  cursor: 'pointer',
  fontWeight: 500,
};

const iconBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--color-text-tertiary)',
  cursor: 'pointer',
  padding: 2,
  display: 'flex',
  alignItems: 'center',
};

const progressBarTrack: React.CSSProperties = {
  width: 120,
  height: 4,
  background: 'var(--color-bg-input)',
  borderRadius: 2,
  overflow: 'hidden',
  flexShrink: 0,
};

const progressBarFill: React.CSSProperties = {
  height: '100%',
  background: 'var(--color-accent)',
  borderRadius: 2,
  transition: 'width 0.3s ease',
};
