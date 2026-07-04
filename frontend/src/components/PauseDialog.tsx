import { useState, useRef, useEffect } from 'react';
import { Hourglass } from 'lucide-react';
import { NumberInput } from './common/NumberInput';
import { DialogShell } from './common/DialogShell';
import { Button } from './common/Button';
import { useBridge } from '../bridge/BridgeContext';
import { useTt, useLanguage } from '../state/LanguageContext';
import { formatMs } from '../utils/displayUtils';

interface PauseDialogProps {
  /**
   * Edit-mode seeds. When ANY initial* is passed the dialog opens in edit mode:
   * capture pad pre-filled with the existing resume hotkey, timeout pre-filled,
   * the primary button reads "Save", and Esc closes (instead of re-arming).
   * `initialKey === undefined` ⇒ insert mode (the toolbar mount passes nothing).
   * An empty-string initialKey is a valid edit seed (a timeout-only Pause).
   */
  initialKey?: string;
  initialTimeoutMs?: number;
  // Resolves with the resume hotkey ('' = none) and the timeout in MILLISECONDS
  // (0 = no timeout). The caller decides whether that's an insert or an edit.
  onConfirm: (key: string, timeoutMs: number) => void;
  onClose: () => void;
}

/**
 * Insert / Edit Pause dialog. Reformulated to mirror the Send Keystroke
 * (KeystrokeCaptureDialog) layout: a big capture pad that grabs the resume
 * hotkey the instant a key is pressed — no click-to-focus-then-press dance — plus
 * a timeout section below. The pad is the headline because "wait until I press X"
 * is the most expressive Pause; the timeout covers "wait N then continue".
 *
 * Both fields are optional, with one rule: at least one must be set (a Pause with
 * neither a hotkey nor a timeout is silently skipped at replay, so Add/Save stays
 * disabled until one is configured).
 *
 *   • Hotkey only          — wait until the captured key is pressed
 *   • Timeout only         — wait N ms then continue
 *   • Both                 — whichever fires first resumes; the engine cancels the other
 *
 * Capture goes through the backend low-level hook (hotkey:capture / hotkey:captured)
 * because the WebView2 JS layer never sees Win+letter combos — the Windows Shell
 * eats them at OS level. The hook stays armed for the dialog's lifetime and is
 * suspended only while a numeric input is focused (so typing "5000" into the
 * timeout doesn't get re-captured as the "5"/"0" keys). Mirrors the exact wiring
 * KeystrokeCaptureDialog uses.
 */

/** Timeout is shown/edited in ms (matches the grid + Send Keystroke's ms knobs).
 *  Chips carry ms values; the label is rendered from the value (locale-grouped "1.000 ms")
 *  at draw time. ∞ (ms=0) pairs with a captured hotkey to form a "wait forever until X is
 *  pressed" Pause. */
const TIMEOUT_PRESETS = [100, 500, 1000, 5000, 30000, 0] as const;

/** Coarser steps once we're in whole-second territory; 100 ms below 1 s. */
const stepFor = (ms: number) => (ms >= 1000 ? 1000 : 100);

export function PauseDialog({ initialKey, initialTimeoutMs, onConfirm, onClose }: PauseDialogProps) {
  const tt = useTt();
  const { language } = useLanguage();
  const isEditing = initialKey !== undefined;

  // Captured resume hotkey. null = none configured (empty pad). Seed from the
  // edited row; an empty initialKey collapses to null so the pad shows its prompt.
  const [captured, setCaptured] = useState<string | null>(initialKey ? initialKey : null);
  // Timeout in ms. Default 1 s for inserts (the common "small sync pause"); seeded
  // from the row on edit. 0 = no timeout (resume by hotkey only).
  const [timeoutMs, setTimeoutMs] = useState<number>(initialTimeoutMs ?? 1000);

  // Stable refcount slot ID — generated once per mount so enable/disable hit the
  // same backend HashSet entry (see InputHookManager.RegisterCapture). Keeps a
  // sibling capture consumer from stomping this dialog's slot on cleanup.
  const ownerIdRef = useRef(`pause-dialog-${crypto.randomUUID()}`);
  const { send, subscribe } = useBridge();

  // Re-sync when reopening the dialog on a different row (parent toggles mount
  // via `{editState && <Dialog />}` but React may reuse the instance at the same
  // JSX position). Without this, a second Edit click could open with stale values.
  // Mirrors the exact seed→state mapping the useState initializers use above.
  useEffect(() => {
    setCaptured(initialKey ? initialKey : null);
    setTimeoutMs(initialTimeoutMs ?? 1000);
  }, [initialKey, initialTimeoutMs]);

  // (Esc focus handling moved into DialogShell — it focuses the card on mount.)

  // Capture wiring — identical pattern to KeystrokeCaptureDialog. Hook on for the
  // dialog's lifetime; suspended while a numeric input is focused so typing into
  // the timeout doesn't re-capture digits as the resume key.
  useEffect(() => {
    send({ type: 'hotkey:capture', payload: { enabled: true, ownerId: ownerIdRef.current } });
    const isPureModifier = (combo: string) =>
      /^(Win|Ctrl|Alt|Shift)(\+(Win|Ctrl|Alt|Shift))*$/.test(combo);

    const unsub = subscribe((msg) => {
      if (msg.type !== 'hotkey:captured') return;
      const combo = msg.payload.combo;
      // Don't clobber an already-captured combo with a bare modifier press — the
      // user is likely holding modifiers while reaching for the next real key.
      setCaptured((prev) => (prev !== null && isPureModifier(combo) ? prev : combo));
    });

    const handleFocusIn = (e: FocusEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') {
        send({ type: 'hotkey:capture', payload: { enabled: false, ownerId: ownerIdRef.current } });
      }
    };
    const handleFocusOut = (e: FocusEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') {
        send({ type: 'hotkey:capture', payload: { enabled: true, ownerId: ownerIdRef.current } });
      }
    };
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);

    return () => {
      send({ type: 'hotkey:capture', payload: { enabled: false, ownerId: ownerIdRef.current } });
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('focusout', handleFocusOut);
      unsub();
    };
  }, [send, subscribe]);

  const canConfirm = !!captured || timeoutMs > 0;

  const handleConfirm = () => {
    if (!canConfirm) return;
    onConfirm((captured ?? '').trim(), Math.max(0, timeoutMs));
  };

  // Timeout for the mode hint — always milliseconds, consistent with the grid and
  // the ms NumberInput above (was "X second(s)" for clean multiples).
  const timeoutLabel = `${formatMs(timeoutMs, language)} ms`;

  return (
    <DialogShell
      icon={<Hourglass size={14} style={{ color: 'var(--color-action-pause-fg)' }} />}
      title={isEditing ? 'Edit Pause' : 'Insert Pause'}
      onClose={onClose}
      // Capture dialog: a stray click outside must not discard a configured
      // hotkey/timeout — dismissal is Esc or Cancel only.
      closeOnBackdrop={false}
      footerHint=""
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleConfirm} disabled={!canConfirm}>
            {isEditing ? 'Save' : 'Add'}
          </Button>
        </>
      }
      onCardKeyDown={(e) => {
        // Enter confirms ONLY while a numeric input is focused (in that state the
        // backend capture is suspended, so Enter isn't doubling as a captured
        // key). Outside input focus the backend hook grabs Enter as the bound key
        // and forwards it via hotkey:captured — so no confirm here. Esc is owned
        // by DialogShell.
        if (e.key === 'Enter') {
          const focusedTag = (document.activeElement as HTMLElement | null)?.tagName;
          if (focusedTag === 'INPUT' && canConfirm) {
            e.preventDefault();
            e.stopPropagation();
            handleConfirm();
          }
        }
      }}
    >
        <div className="px-5 py-5 flex flex-col gap-4">
          {/* Capture pad — press any key/combo to set the resume hotkey directly.
              Optional: leaving it empty makes a timeout-only Pause. */}
          <div className="bg-bg-input border border-dashed rounded-md py-5 px-4 text-center min-h-[140px] flex flex-col justify-center"
               style={{ borderColor: 'color-mix(in srgb, var(--color-action-pause-fg) 40%, transparent)' }}>
            {captured === null ? (
              <>
                <div className="text-[12px] text-text-tertiary mb-1">Press any key to set a resume hotkey</div>
                <div className="text-[10px] text-text-tertiary">
                  Single keys, or Win/Ctrl/Shift/Alt + key. E.g. F8 · Esc · Ctrl+R
                </div>
                <div className="text-[10px] text-text-tertiary mt-1">Optional — or just set a timeout below</div>
              </>
            ) : (
              <>
                <div className="inline-flex items-center justify-center self-center gap-1 flex-wrap">
                  {captured.split('+').map((part, idx, arr) => (
                    <span key={`${part}-${idx}`} className="inline-flex items-center gap-1">
                      <kbd
                        className="inline-block px-2.5 py-1 bg-bg-elevated border border-border-default rounded font-mono text-[13px] font-semibold"
                        style={{ color: 'var(--color-action-pause-fg)', boxShadow: '0 2px 0 rgba(0,0,0,0.3)' }}
                      >
                        {part}
                      </kbd>
                      {idx < arr.length - 1 && <span className="text-text-tertiary text-[12px]">+</span>}
                    </span>
                  ))}
                </div>
                <div className="mt-3 text-[10px] text-text-tertiary">Resumes when this key is pressed</div>
                <div className="mt-1 flex items-center justify-center gap-2 text-[10px] text-text-tertiary">
                  <span>Press another to replace</span>
                  <span aria-hidden>·</span>
                  <button
                    type="button"
                    onClick={() => setCaptured(null)}
                    className="text-text-tertiary hover:text-text-secondary underline underline-offset-2"
                    data-tip={tt('Remove the resume hotkey — leaves a timeout-only Pause', 'Remove a tecla de retomada — deixa um Pause apenas por tempo limite')}
                  >
                    Clear
                  </button>
                </div>
              </>
            )}
          </div>

          {/* Timeout — milliseconds. 0 (the ∞ preset) means "no timeout"; the Pause
              then resumes only via the captured hotkey above. */}
          <div className="flex flex-col gap-2">
            <label className="text-[11px] font-semibold text-text-tertiary uppercase tracking-wider">Timeout</label>
            <div className="flex items-center gap-2">
              <NumberInput
                value={timeoutMs}
                onChange={setTimeoutMs}
                min={0}
                step={stepFor(timeoutMs)}
                thousands
                inputWidth="w-24"
                inputHeight="h-8"
                suffix="ms" suffixInside
                ariaLabel="Pause timeout in milliseconds"
              />
            </div>
            <div className="flex flex-wrap gap-1">
              {TIMEOUT_PRESETS.map((ms) => {
                const isActive = timeoutMs === ms;
                const label = ms === 0 ? '∞' : `${formatMs(ms, language)} ms`;
                return (
                  <button
                    key={ms}
                    type="button"
                    onClick={() => setTimeoutMs(ms)}
                    className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors ${
                      isActive
                        ? 'text-accent border-accent/30 bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]'
                        : 'text-text-tertiary border-border-default bg-bg-elevated hover:text-text-secondary hover:bg-bg-card'
                    }`}
                    data-tip={ms === 0 ? tt('No timeout — resume by hotkey only', 'Sem tempo limite — retoma apenas pela tecla de atalho') : undefined}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Mode hint — explains the active combination. The no-hotkey-no-timeout
              case is a config error (the engine skips such a Pause), so the hint
              tells the user to set at least one — and Add/Save stays disabled. */}
          <p className="text-[11px] text-text-tertiary leading-relaxed">
            {captured && timeoutMs > 0
              ? 'Resumes on the hotkey or timeout — whichever fires first.'
              : captured
                ? 'Waits until the hotkey is pressed.'
                : timeoutMs > 0
                  ? `Waits ${timeoutLabel} then continues.`
                  : 'Set a hotkey or timeout — without either, the Pause is skipped at replay.'}
          </p>
        </div>
    </DialogShell>
  );
}
