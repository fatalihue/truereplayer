import { useState, useEffect } from 'react';
import { useBridge } from '../bridge/BridgeContext';

type Phase =
  | { step: 'hidden' }
  | { step: 'available'; version: string; currentVersion: string; notes: string[] }
  | { step: 'downloading'; percent: number; version: string; currentVersion: string }
  | { step: 'installing'; version: string; currentVersion: string }
  | { step: 'complete'; version: string; currentVersion: string };

// Master switch for the user-facing update overlay.
//   true  → splash visible throughout the auto-update flow (checking → downloading →
//           installing → complete), matching mockup/update-splash.html. When the backend
//           has AutoApplyUpdates on (current default), the "available" gate is skipped:
//           the overlay transitions straight to downloading without a confirmation button.
//   false → component stays mounted but renders nothing; backend silently downloads +
//           applies + restarts with no feedback.
const UPDATE_OVERLAY_ENABLED = true;

export function UpdateOverlay() {
  const { send, subscribe } = useBridge();
  const [phase, setPhase] = useState<Phase>({ step: 'hidden' });

  useEffect(() => {
    return subscribe((msg) => {
      // When disabled, swallow every update event so the overlay never appears.
      // The backend will trigger download + apply automatically.
      if (!UPDATE_OVERLAY_ENABLED) return;

      switch (msg.type) {
        case 'update:checking':
          // Non-blocking by design. The startup update check runs in the background, so the
          // app must be visible and usable immediately — a slow or unreachable release server
          // used to trap the user behind a full-screen blur before they could even see the UI.
          // We show NOTHING during checking; the overlay appears only once an update is actually
          // being downloaded/installed (or offered, in manual-gate mode). Manual "Check for
          // Updates" still gets feedback from the Settings panel's own button state.
          break;
        case 'update:available':
          // In silent (auto-apply) mode, skip the gate and transition straight into the
          // downloading splash — the backend has already kicked off HandleUpdateApply.
          // Without this, the user would see the "Baixar e Instalar" button briefly and
          // then the splash would jump as the download started without their click.
          if (msg.payload.autoApply) {
            setPhase({
              step: 'downloading',
              percent: 0,
              version: msg.payload.version,
              currentVersion: msg.payload.currentVersion,
            });
          } else {
            setPhase({
              step: 'available',
              version: msg.payload.version,
              currentVersion: msg.payload.currentVersion,
              notes: msg.payload.notes ?? [],
            });
          }
          break;
        case 'update:progress':
          setPhase((prev) => {
            if (prev.step === 'downloading') {
              // Clamp to [0,100]: a malformed/out-of-range backend percent would otherwise
              // overflow the progress-bar width and could spuriously trip the >=100 install gate.
              const percent = Math.max(0, Math.min(100, msg.payload.percent));
              return { ...prev, percent };
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
        case 'update:error':
          // No update / network failure: hide the splash. Errors fall back to silent so
          // the user can keep using the app — they'll get the update on the next check.
          setPhase({ step: 'hidden' });
          break;
      }
    });
  }, [subscribe]);

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

  const handleAccept = () => {
    if (phase.step !== 'available') return;
    setPhase({
      step: 'downloading',
      percent: 0,
      version: phase.version,
      currentVersion: phase.currentVersion,
    });
    send({ type: 'update:apply', payload: {} });
  };

  // After the 'hidden' early-return above, every remaining phase carries version metadata.
  const version = phase.version;
  const currentVersion = phase.currentVersion;
  const isComplete = phase.step === 'complete';
  const isInstalling = phase.step === 'installing';

  return (
    <div style={overlayStyle}>
      {/* Backdrop */}
      <div style={backdropStyle} />

      {/* Card */}
      <div style={cardStyle}>
        {/* App Icon */}
        <div style={logoContainerStyle}>
          <img
            src="app-icon.png"
            alt="TrueReplayer"
            style={{
              ...logoImgStyle,
              ...(isComplete ? {} : { animation: 'update-logo-pulse 2s ease-in-out infinite' }),
            }}
          />
          {isComplete && (
            <div style={checkBadgeStyle}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <polyline
                  points="6 12 10 16 18 8"
                  stroke="white"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{
                    strokeDasharray: 24,
                    strokeDashoffset: 0,
                    animation: 'update-checkmark 0.4s ease 0.2s both',
                  }}
                />
              </svg>
            </div>
          )}
        </div>

        {/* Title */}
        <div
          style={{
            ...titleStyle,
            ...(isComplete || isInstalling ? { color: 'var(--color-replay)' } : {}),
          }}
        >
          {phase.step === 'available' && 'Atualização disponível'}
          {phase.step === 'downloading' && 'Baixando atualização'}
          {phase.step === 'installing' && `Atualizando para v${version}`}
          {phase.step === 'complete' && 'Atualizado com sucesso!'}
        </div>

        {/* Subtitle */}
        <div style={subtitleStyle}>
          {phase.step === 'available' && 'Uma nova versão do TrueReplayer está pronta'}
          {phase.step === 'downloading' && 'Não feche o aplicativo'}
          {phase.step === 'installing' && 'Encerrando TrueReplayer...'}
          {phase.step === 'complete' && 'Você está agora na versão mais recente'}
        </div>

        {/* Version chips (current ➜ new), or single chip for "complete".
            Hidden during 'checking' because we don't know the target version yet —
            the splash just shows the indeterminate progress bar in that state. */}
        {isComplete ? (
          <div style={versionRowStyle}>
            <div style={{ ...versionChipStyle, ...versionChipNewStyle, minWidth: 120 }}>
              <div style={{ ...versionLabelStyle, color: 'var(--color-accent)' }}>Versão atual</div>
              <div style={{ ...versionValueStyle, color: 'var(--color-accent)' }}>v{version}</div>
            </div>
          </div>
        ) : (
          <div style={versionRowStyle}>
            <div style={versionChipStyle}>
              <div style={versionLabelStyle}>Versão atual</div>
              <div style={versionValueStyle}>v{currentVersion}</div>
            </div>
            <div style={versionArrowStyle}>&#10132;</div>
            <div style={{ ...versionChipStyle, ...versionChipNewStyle }}>
              <div style={{ ...versionLabelStyle, color: 'var(--color-accent)' }}>Nova versão</div>
              <div style={{ ...versionValueStyle, color: 'var(--color-accent)' }}>v{version}</div>
            </div>
          </div>
        )}

        {/* Changelog — only on 'available' phase (full list before user decides) */}
        {phase.step === 'available' && phase.notes.length > 0 && (
          <div style={changelogStyle}>
            <div style={changelogTitleStyle}>
              <span style={changelogDotStyle} />
              O que há de novo
            </div>
            <ul style={changelogListStyle} className="update-changelog-list">
              {phase.notes.slice(0, 6).map((note, i) => (
                <li key={i} style={changelogItemStyle}>
                  {note}
                </li>
              ))}
            </ul>
          </div>
        )}
        {phase.step === 'complete' && <div style={{ height: 12 }} />}

        {/* Progress bar (checking / downloading / installing).
            Checking is indeterminate (40 % bar sliding across), matching the mockup —
            no percent shown since we have nothing to report yet. Downloading is the
            real percent. Installing pulses at 100 % while the apply runs. */}
        {(phase.step === 'downloading' || phase.step === 'installing') && (
          <>
            <div style={progressContainerStyle}>
              <div style={progressTrackStyle}>
                <div
                  style={{
                    ...progressFillStyle,
                    ...(phase.step === 'downloading'
                      ? { width: `${phase.percent}%`, animation: 'none', transform: 'none' }
                      : { width: '100%', animation: 'update-install-pulse 1.5s ease-in-out infinite', transform: 'none' }),
                  }}
                />
              </div>
              {phase.step === 'downloading' && (
                <div style={progressMetaStyle}>
                  <span>Baixando...</span>
                  <span style={{ color: 'var(--color-accent)', fontWeight: 600 }}>{phase.percent}%</span>
                </div>
              )}
            </div>
            {phase.step === 'installing' && (
              <>
                <div style={statusStyle}>Aplicando atualização, aguarde...</div>
                <div style={hintStyle}>O aplicativo será reiniciado automaticamente</div>
              </>
            )}
          </>
        )}

        {/* Button — only on "available" phase */}
        {phase.step === 'available' && (
          <button
            type="button"
            style={primaryButtonStyle}
            onClick={handleAccept}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'linear-gradient(180deg, var(--color-accent-hover), var(--color-accent-solid))';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'linear-gradient(180deg, var(--color-accent-solid), color-mix(in srgb, var(--color-accent-solid) 82%, #000))';
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Baixar e Instalar
          </button>
        )}
      </div>

      {/* Keyframe animations injected as style tag */}
      <style>{keyframes}</style>
    </div>
  );
}

/* ── Keyframes ── */
const keyframes = `
@keyframes update-card-in {
  from { opacity: 0; transform: scale(0.94) translateY(8px); }
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
@keyframes update-install-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.65; }
}
@keyframes update-checkmark {
  from { stroke-dashoffset: 24; }
  to { stroke-dashoffset: 0; }
}
.update-changelog-list li::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 10px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--color-text-disabled);
}
`;

/* ── Styles ──
   Colors are pulled from the active theme's CSS custom properties (set on :root by
   themes.ts → applyTheme) so the update splash tracks whatever theme the user has
   selected. Accent elements use --color-accent / --color-accent-solid / --color-accent-hover;
   the success (complete) state uses --color-replay; surfaces and text use the --color-bg-* /
   --color-text-* / --color-border-* tokens. Non-color depth (drop shadows) and the dark
   modal scrim stay fixed on purpose — a neutral dark backdrop reads well under any theme. */
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
  width: '88%',
  maxWidth: 420,
  background: 'color-mix(in srgb, var(--color-bg-card) 92%, transparent)',
  border: '1px solid var(--color-border-default)',
  borderRadius: 14,
  padding: '28px 28px 24px',
  boxShadow: '0 24px 80px rgba(0, 0, 0, 0.6), inset 0 0 0 1px rgba(255,255,255,0.04)',
  animation: 'update-card-in 0.45s cubic-bezier(0.16, 1, 0.3, 1)',
};

const logoContainerStyle: React.CSSProperties = {
  position: 'relative',
  width: 56,
  height: 56,
  margin: '0 auto 14px',
};

const logoImgStyle: React.CSSProperties = {
  width: 56,
  height: 56,
  borderRadius: 14,
  boxShadow: '0 6px 18px rgba(0, 0, 0, 0.45)',
  display: 'block',
  objectFit: 'cover',
};

const checkBadgeStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: -3,
  right: -3,
  width: 22,
  height: 22,
  borderRadius: '50%',
  background: 'linear-gradient(135deg, color-mix(in srgb, var(--color-replay) 60%, #000), var(--color-replay))',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  boxShadow: '0 2px 6px color-mix(in srgb, var(--color-replay) 40%, transparent)',
  border: '2px solid var(--color-bg-card)',
};

const titleStyle: React.CSSProperties = {
  textAlign: 'center',
  fontSize: 17,
  fontWeight: 600,
  color: 'var(--color-text-primary)',
  letterSpacing: -0.2,
  marginBottom: 4,
};

const subtitleStyle: React.CSSProperties = {
  textAlign: 'center',
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  marginBottom: 18,
};

const versionRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
  marginBottom: 16,
};

const versionChipStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  background: 'var(--color-bg-elevated)',
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 8,
  padding: '8px 14px',
  minWidth: 80,
};

const versionChipNewStyle: React.CSSProperties = {
  background: 'color-mix(in srgb, var(--color-accent) 8%, transparent)',
  borderColor: 'color-mix(in srgb, var(--color-accent) 25%, transparent)',
};

const versionLabelStyle: React.CSSProperties = {
  fontSize: 9,
  color: 'var(--color-text-tertiary)',
  textTransform: 'uppercase',
  letterSpacing: 0.8,
  marginBottom: 2,
};

const versionValueStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--color-text-secondary)',
  fontVariantNumeric: 'tabular-nums',
};

const versionArrowStyle: React.CSSProperties = {
  color: 'var(--color-accent)',
  fontSize: 14,
};

const changelogStyle: React.CSSProperties = {
  marginBottom: 18,
};

const changelogTitleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--color-text-secondary)',
  marginBottom: 8,
  display: 'flex',
  alignItems: 'center',
  gap: 5,
};

const changelogDotStyle: React.CSSProperties = {
  width: 5,
  height: 5,
  borderRadius: '50%',
  background: 'var(--color-accent)',
  display: 'inline-block',
};

const changelogListStyle: React.CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
};

const changelogItemStyle: React.CSSProperties = {
  position: 'relative',
  fontSize: 11.5,
  color: 'var(--color-text-secondary)',
  padding: '3px 0 3px 16px',
  lineHeight: 1.4,
};

const progressContainerStyle: React.CSSProperties = {
  marginBottom: 12,
};

const progressTrackStyle: React.CSSProperties = {
  width: '100%',
  height: 6,
  background: 'color-mix(in srgb, var(--color-text-primary) 12%, transparent)',
  borderRadius: 3,
  overflow: 'hidden',
  position: 'relative',
};

const progressFillStyle: React.CSSProperties = {
  height: '100%',
  background: 'linear-gradient(90deg, var(--color-accent-solid), var(--color-accent))',
  borderRadius: 3,
  width: '0%',
  transition: 'width 0.3s ease',
  boxShadow: '0 0 10px color-mix(in srgb, var(--color-accent) 35%, transparent)',
};

const progressMetaStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  marginTop: 6,
  fontSize: 10.5,
  color: 'var(--color-text-tertiary)',
  fontVariantNumeric: 'tabular-nums',
};

const statusStyle: React.CSSProperties = {
  textAlign: 'center',
  fontSize: 11.5,
  color: 'var(--color-text-tertiary)',
  marginTop: 4,
};

const hintStyle: React.CSSProperties = {
  marginTop: 14,
  fontSize: 10,
  color: 'var(--color-text-tertiary)',
  textAlign: 'center',
};

const primaryButtonStyle: React.CSSProperties = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  height: 36,
  border: 'none',
  borderRadius: 8,
  background: 'linear-gradient(180deg, var(--color-accent-solid), color-mix(in srgb, var(--color-accent-solid) 82%, #000))',
  color: 'white',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  boxShadow: '0 2px 6px color-mix(in srgb, var(--color-accent-solid) 35%, transparent)',
  transition: 'background 0.15s ease',
  fontFamily: 'inherit',
};
