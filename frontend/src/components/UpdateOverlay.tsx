import { useState, useEffect, useRef } from 'react';
import { useBridge } from '../bridge/BridgeContext';

type Phase =
  | { step: 'hidden' }
  | { step: 'checking' }
  | { step: 'downloading'; percent: number; version: string; currentVersion: string }
  | { step: 'installing'; version: string; currentVersion: string }
  | { step: 'complete'; version: string; currentVersion: string };

export function UpdateOverlay() {
  const { send, subscribe } = useBridge();
  const [phase, setPhase] = useState<Phase>({ step: 'hidden' });
  const autoApplied = useRef(false);

  useEffect(() => {
    return subscribe((msg) => {
      switch (msg.type) {
        case 'update:available':
          // Update found — start download automatically
          setPhase({
            step: 'downloading',
            percent: 0,
            version: msg.payload.version,
            currentVersion: msg.payload.currentVersion,
          });
          if (!autoApplied.current) {
            autoApplied.current = true;
            send({ type: 'update:apply', payload: {} });
          }
          break;
        case 'update:progress':
          setPhase((prev) => {
            if (prev.step === 'downloading') {
              return { ...prev, percent: msg.payload.percent };
            }
            if (prev.step === 'hidden' || prev.step === 'checking') {
              return prev; // ignore stale progress
            }
            return prev;
          });
          break;
        case 'update:ready':
          setPhase((prev) => {
            if (prev.step === 'downloading' || prev.step === 'installing') {
              return { step: 'complete', version: prev.version, currentVersion: prev.currentVersion };
            }
            return prev;
          });
          break;
        case 'update:none':
          setPhase({ step: 'hidden' });
          break;
        case 'update:error':
          // On error, just hide and let the app work normally
          setPhase({ step: 'hidden' });
          break;
      }
    });
  }, [subscribe, send]);

  // Transition to installing when download reaches 100%
  useEffect(() => {
    if (phase.step === 'downloading' && phase.percent >= 100) {
      const timer = setTimeout(() => {
        setPhase({ step: 'installing', version: phase.version, currentVersion: phase.currentVersion });
      }, 400);
      return () => clearTimeout(timer);
    }
  }, [phase]);

  if (phase.step === 'hidden') return null;

  const version = phase.step !== 'checking' ? phase.version : '';
  const currentVersion = phase.step !== 'checking' ? phase.currentVersion : '';

  return (
    <div style={overlayStyle}>
      {/* Backdrop */}
      <div style={backdropStyle} />

      {/* Card */}
      <div style={cardStyle}>
        {/* Logo */}
        <div
          style={{
            ...logoStyle,
            ...(phase.step === 'complete' ? logoCompleteStyle : {}),
          }}
        >
          {phase.step === 'complete' ? (
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
              <polyline
                points="6 12 10 16 18 8"
                stroke="white"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{
                  strokeDasharray: 24,
                  strokeDashoffset: 0,
                  animation: 'update-checkmark 0.4s ease 0.2s both',
                }}
              />
            </svg>
          ) : (
            <svg width="32" height="32" viewBox="0 0 24 24" fill="white">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </div>

        {/* Title */}
        <div style={titleStyle}>
          {phase.step === 'complete' ? 'Update Complete' : phase.step === 'installing' ? 'Installing Update' : 'Updating TrueReplayer'}
        </div>

        {/* Version */}
        {version && (
          <div style={versionRowStyle}>
            <span>v{currentVersion}</span>
            <span style={{ color: '#60CDFF', fontSize: 11 }}>&#10132;</span>
            <span style={{ color: '#60CDFF', fontWeight: 600 }}>v{version}</span>
          </div>
        )}

        {/* Progress bar */}
        <div style={progressContainerStyle}>
          <div style={progressTrackStyle}>
            <div
              style={{
                ...progressFillStyle,
                ...(phase.step === 'checking'
                  ? { width: '40%', animation: 'update-indeterminate 1.8s ease-in-out infinite' }
                  : phase.step === 'downloading'
                    ? { width: `${phase.percent}%`, animation: 'none', transform: 'none' }
                    : phase.step === 'installing'
                      ? { width: '100%', animation: 'update-install-pulse 1.5s ease-in-out infinite', transform: 'none' }
                      : phase.step === 'complete'
                        ? {
                            width: '100%',
                            animation: 'none',
                            transform: 'none',
                            background: 'linear-gradient(90deg, #0E7A0D, #6bcb77)',
                            boxShadow: '0 0 12px rgba(107, 203, 119, 0.3)',
                          }
                        : {}),
              }}
            />
          </div>
        </div>

        {/* Status text */}
        <div style={statusStyle}>
          {phase.step === 'checking' && 'Checking for updates...'}
          {phase.step === 'downloading' && (
            <>
              Downloading update...{' '}
              <span style={{ color: '#c5c5c5', fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
                {phase.percent}%
              </span>
            </>
          )}
          {phase.step === 'installing' && 'Applying update, please wait...'}
          {phase.step === 'complete' && 'Restarting application...'}
        </div>
      </div>

      {/* Keyframe animations injected as style tag */}
      <style>{keyframes}</style>
    </div>
  );
}

/* ── Keyframes ── */
const keyframes = `
@keyframes update-card-in {
  from { opacity: 0; transform: scale(0.92) translateY(10px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}
@keyframes update-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes update-logo-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.04); }
}
@keyframes update-indeterminate {
  0% { transform: translateX(-120%); }
  100% { transform: translateX(350%); }
}
@keyframes update-install-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}
@keyframes update-checkmark {
  from { stroke-dashoffset: 24; }
  to { stroke-dashoffset: 0; }
}
`;

/* ── Styles ── */
const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 9999,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const backdropStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.65)',
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',
  animation: 'update-fade-in 0.4s ease-out',
};

const cardStyle: React.CSSProperties = {
  position: 'relative',
  width: 420,
  background: 'rgba(45, 45, 45, 0.85)',
  border: '1px solid rgba(255, 255, 255, 0.08)',
  borderRadius: 16,
  padding: '40px 36px 36px',
  textAlign: 'center',
  boxShadow: '0 24px 80px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255,255,255,0.04) inset',
  animation: 'update-card-in 0.5s cubic-bezier(0.16, 1, 0.3, 1)',
};

const logoStyle: React.CSSProperties = {
  width: 64,
  height: 64,
  margin: '0 auto 20px',
  borderRadius: 14,
  background: 'linear-gradient(135deg, #0078D4 0%, #60CDFF 100%)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  boxShadow: '0 8px 24px rgba(0, 120, 212, 0.3)',
  animation: 'update-logo-pulse 2s ease-in-out infinite',
};

const logoCompleteStyle: React.CSSProperties = {
  background: 'linear-gradient(135deg, #0E7A0D 0%, #6bcb77 100%)',
  boxShadow: '0 8px 24px rgba(14, 122, 13, 0.3)',
  animation: 'none',
};

const titleStyle: React.CSSProperties = {
  fontSize: 20,
  fontWeight: 600,
  color: '#ffffff',
  marginBottom: 6,
  letterSpacing: -0.3,
};

const versionRowStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#9a9a9a',
  marginBottom: 28,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
};

const progressContainerStyle: React.CSSProperties = {
  marginBottom: 16,
};

const progressTrackStyle: React.CSSProperties = {
  width: '100%',
  height: 4,
  background: '#404040',
  borderRadius: 2,
  overflow: 'hidden',
};

const progressFillStyle: React.CSSProperties = {
  height: '100%',
  background: 'linear-gradient(90deg, #0078D4, #60CDFF)',
  borderRadius: 2,
  width: '0%',
  transition: 'width 0.4s ease',
  boxShadow: '0 0 12px rgba(96, 205, 255, 0.3)',
};

const statusStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#9a9a9a',
  height: 18,
};
