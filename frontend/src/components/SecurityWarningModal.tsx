import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Checkbox } from './Checkbox';
import { DialogShell } from './common/DialogShell';
import { Button } from './common/Button';

interface SecurityWarningModalProps {
  /** Called when the user clicks "I understand". `dontShowAgain` true means persist the ack. */
  onContinue: (dontShowAgain: boolean) => void;
  /** Called when the user cancels (Escape or the Cancel button). */
  onCancel: () => void;
}

/**
 * First-time security warning shown before an import. Modeled after Chrome extension /
 * Tampermonkey style "you're about to execute code, are you sure?" prompts.
 *
 * The dialog is unconditionally rendered when shown — gating on
 * `requiresAcknowledgement` from the bridge happens at the parent (App / ProfilePanel)
 * before instantiating this component.
 *
 * "Don't show again" persists only when the user clicks Continue with the checkbox
 * ticked. Cancel keeps the flag at its current value so the dialog reappears on the
 * next import — that's intentional, the user hasn't acknowledged anything yet.
 */
export function SecurityWarningModal({ onContinue, onCancel }: SecurityWarningModalProps) {
  const [dontShowAgain, setDontShowAgain] = useState(false);

  return (
    <DialogShell
      icon={<AlertTriangle size={14} className="text-amber-400" />}
      title="Heads up"
      widthClass="w-[520px]"
      onClose={onCancel}
      // Security warning exists to be READ before proceeding — a stray click on the
      // scrim must not dismiss it (dismissal is an explicit Cancel or Esc only).
      closeOnBackdrop={false}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => onContinue(dontShowAgain)}
          >
            I understand, continue
          </Button>
        </>
      }
    >
      {/* Body */}
      <div className="px-4 py-4 space-y-3">
        <p className="text-xs text-text-secondary leading-relaxed">
          Profiles run automated mouse and keyboard actions. Only import profiles
          from sources you trust.
        </p>

        <div className="text-xs text-text-secondary leading-relaxed">
          Imported profiles can:
          <ul className="mt-1.5 ml-4 space-y-1 list-disc text-text-tertiary">
            <li>Click anywhere on screen</li>
            <li>Type any text (including passwords if a password field is focused)</li>
            <li>Trigger automatically on windows you allow</li>
          </ul>
        </div>

        <div className="pt-1">
          <Checkbox
            checked={dontShowAgain}
            onChange={setDontShowAgain}
            label="Don't show this again"
          />
        </div>
      </div>
    </DialogShell>
  );
}
