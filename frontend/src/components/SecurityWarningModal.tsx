import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Checkbox } from './Checkbox';
import { useTt } from '../state/LanguageContext';

interface SecurityWarningModalProps {
  /** Called when the user clicks "I understand". `dontShowAgain` true means persist the ack. */
  onContinue: (dontShowAgain: boolean) => void;
  /** Called when the user cancels (Escape, Cancel button, or backdrop click). */
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
  const tt = useTt();
  const [dontShowAgain, setDontShowAgain] = useState(false);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onKeyDown={(e) => e.stopPropagation()}
      onClick={onCancel}
    >
      <div
        className="bg-bg-elevated border border-border-subtle rounded-lg shadow-xl w-[520px] max-w-[90vw] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle">
          <AlertTriangle size={16} className="text-amber-400" />
          <h3 className="text-sm font-semibold text-text-primary">Heads up</h3>
        </div>

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
              title={tt(
                'Skip this warning on future imports (only saved if you click continue)',
                'Pular este aviso em importações futuras (só é salvo se você clicar em continuar)'
              )}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border-subtle">
          <button
            onClick={onCancel}
            data-tip={tt(
              'Abort the import — nothing is imported and the profile does not run',
              'Cancelar a importação — nada é importado e o profile não roda'
            )}
            className="px-4 py-1.5 text-xs font-medium text-text-secondary bg-bg-card hover:bg-bg-surface border border-border-subtle rounded transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onContinue(dontShowAgain)}
            data-tip={tt(
              'Proceed and import the profile — it can click, type, and trigger automatically',
              'Prosseguir e importar o profile — ele pode clicar, digitar e disparar automaticamente'
            )}
            className="px-4 py-1.5 text-xs font-medium text-white bg-accent-solid hover:bg-accent-solid/80 rounded transition-colors"
          >
            I understand, continue
          </button>
        </div>
      </div>
    </div>
  );
}
