import { Pause as PauseIcon, Check } from 'lucide-react';
import { useAppState } from '../state/AppStateContext';
import { useBridge } from '../bridge/BridgeContext';
import { usePauseTick } from '../hooks/usePauseTick';
import { formatClickerStats, formatEta } from '../utils/clickerFormat';
import { ClickerEmptyState } from './ClickerEmptyState';

// Live dashboard for Clicker runs. Three visual states:
//   idle + count==0 → defer to ClickerEmptyState
//   replaying       → bright clicker color, optional progress bar + ETA
//   ready + count>0 → same layout, dimmed
export function ClickerDashboard() {
  const { status, clickerStats, loopProgress, pauseState, settings } = useAppState();
  const { send } = useBridge();
  usePauseTick(pauseState);

  const isReplaying = status === 'replaying';
  if (!isReplaying && clickerStats.count === 0) return <ClickerEmptyState />;

  const { elapsed, rate, rateLabel } = formatClickerStats(clickerStats.count, clickerStats.elapsedMs);
  const loopActive = loopProgress.active;
  const etaText = formatEta(loopActive, loopProgress.total, clickerStats.count, rate);
  const progressPct = loopActive && loopProgress.total > 0
    ? Math.min(100, (loopProgress.current / loopProgress.total) * 100)
    : null;

  const pauseRemainingSec = pauseState.timeoutMs > 0
    ? Math.max(0, Math.ceil((pauseState.timeoutMs - (Date.now() - pauseState.startedAt)) / 1000))
    : 0;

  // Compact recall — only enabled bits. Area takes precedence over Position (mutex enforced upstream).
  const configBits: string[] = [settings.cursorClickButton];
  if (settings.cursorClickUseArea && settings.cursorClickArea) {
    configBits.push(`Area ${settings.cursorClickArea.w}×${settings.cursorClickArea.h}`);
  } else if (settings.cursorClickUsePositionJitter && parseInt(settings.cursorClickPositionJitter, 10) > 0) {
    configBits.push(`±${settings.cursorClickPositionJitter} px`);
  }
  configBits.push(`Hold ${settings.cursorClickHold} ms`);
  if (settings.cursorClickUseJitter && parseInt(settings.cursorClickDelayJitter, 10) > 0) {
    configBits.push(`±${settings.cursorClickDelayJitter}% rate`);
  }
  if (settings.cursorClickUseInterval && parseInt(settings.cursorClickInterval, 10) > 0) {
    configBits.push(`every ${settings.cursorClickInterval} ms`);
  }

  return (
    <div
      className="flex-1 flex flex-col items-center justify-center gap-6 rounded-ui border min-h-0 relative overflow-hidden px-4"
      style={{
        background: 'linear-gradient(135deg, rgba(192,132,252,0.05), rgba(192,132,252,0.01))',
        borderColor: 'var(--color-clicker-border)',
        // No post-run dim — the panel used to drop to 65% opacity when the run
        // finished, which read as a washed-out "glass" layer and hurt text
        // legibility. The "· finished" label already signals the state.
      }}
    >
      {/* tabular-nums prevents digit-width jitter as the count climbs. */}
      <div className="flex flex-col items-center">
        <div
          className="font-mono font-bold tabular-nums"
          style={{
            fontSize: 'clamp(56px, 10vw, 112px)',
            color: 'var(--color-clicker)',
            lineHeight: 1,
            letterSpacing: '-0.02em',
          }}
        >
          {clickerStats.count.toLocaleString()}
        </div>
        <div
          className="text-[11px] uppercase tracking-[0.2em] mt-2 flex items-center gap-2"
          style={{ color: 'var(--color-clicker)', opacity: 0.7 }}
        >
          clicks
          {!isReplaying && (
            <>
              <span style={{ opacity: 0.4 }}>·</span>
              <span className="flex items-center gap-1">
                <Check size={10} />
                finished
              </span>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2 w-full max-w-[480px]">
        <StatCell value={`${rateLabel}/s`} label="Rate" />
        <StatCell value={elapsed} label="Elapsed" />
        <StatCell
          value={loopActive ? `${loopProgress.current}/${loopProgress.total === 0 ? '∞' : loopProgress.total}` : '—'}
          label="Loop"
          dim={!loopActive}
        />
        <StatCell value={etaText} label="ETA" dim={etaText === '—'} />
      </div>

      {progressPct !== null && (
        <div className="w-full max-w-[480px]">
          <div className="h-[3px] bg-bg-elevated rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-[width] duration-300"
              style={{ width: `${progressPct}%`, background: 'var(--color-clicker)' }}
            />
          </div>
        </div>
      )}

      {/* Config recall (button · Hold X ms · every X ms …) — text-secondary, not
          text-disabled, so it stays readable. The faded disabled colour blended
          into the gradient and was hard to make out. */}
      <div className="text-[11px] text-text-secondary font-mono text-center max-w-[480px]">
        {configBits.join('  ·  ')}
      </div>

      {/* Pause — only while actively running and not already paused. Pausing freezes the
          loop (and excludes the paused span from CPS); the overlay's Resume button below
          resumes it. */}
      {isReplaying && !pauseState.isPaused && (
        <button
          onClick={() => send({ type: 'clicker:pause', payload: {} })}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-ui border text-[12px] font-medium transition-colors hover:bg-bg-elevated"
          style={{ borderColor: 'var(--color-clicker-border)', color: 'var(--color-clicker)' }}
        >
          <PauseIcon size={13} fill="currentColor" /> Pause
        </button>
      )}

      <div className="text-[11px] text-text-tertiary flex items-center gap-1.5">
        Press
        <kbd className="kbd kbd-accent">{settings.replayHotkey}</kbd>
        to {isReplaying ? 'stop' : 'run again'}
      </div>

      {pauseState.isPaused && (
        <div
          className="absolute inset-0 flex items-center justify-center backdrop-blur-sm"
          style={{ background: 'rgba(0,0,0,0.45)' }}
        >
          <div
            className="flex flex-col items-center gap-3 px-6 py-5 rounded-ui border"
            style={{
              borderColor: 'var(--color-action-pause-fg)',
              background: 'var(--color-bg-base)',
            }}
          >
            <PauseIcon size={28} style={{ color: 'var(--color-action-pause-fg)' }} fill="currentColor" />
            <div className="text-[16px] font-semibold tracking-wider" style={{ color: 'var(--color-action-pause-fg)' }}>
              PAUSED
            </div>
            {(pauseState.hotkey || pauseState.timeoutMs > 0) && (
              <div className="text-[11px] text-text-secondary text-center">
                {pauseState.hotkey && <>Press <kbd className="kbd kbd-accent">{pauseState.hotkey}</kbd></>}
                {pauseState.hotkey && pauseState.timeoutMs > 0 ? ' or ' : ''}
                {pauseState.timeoutMs > 0 && <>wait <span className="font-mono">{pauseRemainingSec}s</span></>}
              </div>
            )}
            <button
              onClick={() => send({ type: 'replay:resume', payload: {} })}
              className="px-3 py-1 text-[12px] font-medium rounded border border-border-default text-text-primary hover:bg-bg-elevated transition-colors"
            >
              Resume
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// `dim` greys cells whose value is "—" so they read as N/A rather than broken.
function StatCell({ value, label, dim = false }: { value: string; label: string; dim?: boolean }) {
  return (
    <div
      // Solid surface (was bg-bg-surface/40) — the translucent cells contributed
      // to the glassy look and made the numbers harder to read on the gradient.
      className={`flex flex-col items-center py-2 px-1 rounded border border-border-subtle bg-bg-surface ${dim ? 'opacity-40' : ''}`}
    >
      <div className="text-[18px] font-mono font-semibold text-text-primary tabular-nums leading-tight">
        {value}
      </div>
      <div className="text-[9px] uppercase tracking-[0.15em] text-text-tertiary mt-1">
        {label}
      </div>
    </div>
  );
}
