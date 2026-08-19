import { useState } from 'react';
import { AlertTriangle, FolderOpen } from 'lucide-react';
import { Checkbox } from './Checkbox';
import { DialogShell } from './common/DialogShell';
import { Button } from './common/Button';

interface SecurityWarningModalProps {
  /** Name of the .trprofile that triggered the warning — anchors the generic text
   *  to the concrete file the user just picked. Omitted = generic copy only. */
  fileName?: string;
  /** Profile count parsed from that file, shown beside the name. */
  profileCount?: number;
  /** Called when the user clicks "Continue to review". `dontShowAgain` true means persist the ack. */
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
export function SecurityWarningModal({ fileName, profileCount, onContinue, onCancel }: SecurityWarningModalProps) {
  const [dontShowAgain, setDontShowAgain] = useState(false);

  return (
    <DialogShell
      icon={<AlertTriangle size={14} style={{ color: 'var(--color-warning-ink)' }} />}
      title="Heads up"
      widthClass="w-[520px]"
      onClose={onCancel}
      // Security warning exists to be READ before proceeding — a stray click on the
      // scrim must not dismiss it (dismissal is an explicit Cancel or Esc only).
      closeOnBackdrop={false}
      footerHint="Esc to cancel"
      footer={
        <>
          {/* min-w matches the Export dialog's even-button-row convention. */}
          <Button
            variant="secondary"
            className="min-w-[84px]"
            onClick={onCancel}
          >
            Cancel
          </Button>
          {/* "Continue to review", not "I understand, continue": the Import Preview
              comes NEXT — the old label read as a final commit and could make a
              cautious user cancel, thinking Continue meant import-everything-now. */}
          <Button
            variant="primary"
            className="min-w-[84px]"
            onClick={() => onContinue(dontShowAgain)}
          >
            Continue to review
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

        {/* File chip — same idiom as the Import Preview's file summary, so the two
            steps read as one flow anchored on the same file. */}
        {fileName && (
          <div className="flex items-center gap-2 text-xs">
            <FolderOpen size={12} className="text-text-tertiary shrink-0" />
            <span className="text-text-secondary font-medium truncate">{fileName}</span>
            {profileCount !== undefined && (
              <span className="text-[11px] text-text-tertiary shrink-0">
                · {profileCount} profile{profileCount === 1 ? '' : 's'}
              </span>
            )}
          </div>
        )}

        {/* The danger facts get the DS warning band (left rule + translucent tint) —
            visually marked without shouting. */}
        <div className="warning-band text-xs text-text-secondary leading-relaxed pl-3 py-2 rounded-r">
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
