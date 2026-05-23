import { useState, useEffect, useMemo, useRef } from 'react';
import { Repeat2 } from 'lucide-react';
import { useAppState } from '../state/AppStateContext';
import { NumberInput } from './common/NumberInput';

export interface RunProfileDialogProps {
  /** When set, the dialog is in edit mode for this existing action. */
  initial?: { profileName: string; repeatCount: number };
  /** Name of the profile that will own the action. Used to filter self-reference. */
  excludeProfileName?: string;
  onConfirm: (profileName: string, repeatCount: number) => void;
  onClose: () => void;
}

/**
 * Dialog used by both "Add Run Profile" (from Add Actions menu) and
 * "Edit Run Profile" (double-click on an existing RunProfile row).
 *
 * Shows a profile dropdown (filtered to exclude self-references) and a
 * numeric repeat count. Validates non-empty selection before confirming.
 */
export function RunProfileDialog({ initial, excludeProfileName, onConfirm, onClose }: RunProfileDialogProps) {
  const { profiles } = useAppState();
  const [profileName, setProfileName] = useState(initial?.profileName ?? '');
  const [repeatCount, setRepeatCount] = useState(initial?.repeatCount ?? 1);
  const selectRef = useRef<HTMLSelectElement>(null);

  // Drop self-references and disabled profiles from the picker. Disabled profiles are
  // skipped at replay time anyway (HandleRunProfile early-returns), so hiding them here
  // avoids the foot-gun of picking one that won't run. Exception: keep the currently-
  // selected target visible even if it's disabled, so edit mode shows what's stored.
  const eligibleProfiles = useMemo(() => {
    return profiles.filter(p => {
      if (p.name === excludeProfileName) return false;
      if (p.isDisabled && p.name !== initial?.profileName) return false;
      return true;
    });
  }, [profiles, excludeProfileName, initial?.profileName]);

  // Pre-select the first eligible profile if none chosen yet.
  useEffect(() => {
    if (!profileName && eligibleProfiles.length > 0) {
      setProfileName(eligibleProfiles[0].name);
    }
  }, [eligibleProfiles, profileName]);

  useEffect(() => {
    selectRef.current?.focus();
  }, []);

  const canConfirm = profileName.trim().length > 0 && repeatCount >= 1;

  const handleConfirm = () => {
    if (!canConfirm) return;
    onConfirm(profileName, Math.max(1, Math.min(999, repeatCount)));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleConfirm();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onKeyDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="bg-bg-elevated border border-border-subtle rounded-lg shadow-xl w-[440px] max-w-[95vw] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle">
          <Repeat2 size={16} className="shrink-0" style={{ color: 'var(--color-action-runprofile-fg)' }} />
          <h3 className="text-sm font-semibold text-text-primary flex-1">
            {initial ? 'Edit Run Profile' : 'Add Run Profile'}
          </h3>
        </div>

        {/* Body */}
        <div className="px-4 py-4 flex flex-col gap-4">
          {eligibleProfiles.length === 0 ? (
            <div className="text-xs text-text-tertiary py-4 text-center">
              No other profiles available to chain.
              <br />
              Create another profile first.
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <label className="text-[10px] uppercase tracking-wide font-semibold text-text-tertiary">
                  Profile to run
                </label>
                <select
                  ref={selectRef}
                  value={profileName}
                  onChange={(e) => setProfileName(e.target.value)}
                  className="h-9 px-2 text-xs text-text-primary bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid"
                >
                  {eligibleProfiles.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-[10px] uppercase tracking-wide font-semibold text-text-tertiary">
                  Repeat
                </label>
                <div className="flex items-center gap-2">
                  <NumberInput
                    value={repeatCount}
                    onChange={setRepeatCount}
                    min={1}
                    max={999}
                    inputWidth="w-16"
                    inputHeight="h-9"
                    ariaLabel="Repeat count"
                  />
                  <span className="text-xs text-text-tertiary">
                    {repeatCount === 1 ? 'time' : 'times'} per call
                  </span>
                </div>
              </div>

              <div className="text-[11px] text-text-tertiary leading-relaxed bg-bg-card border border-border-subtle rounded px-2.5 py-2">
                The selected profile's actions run inline at this point. Its own
                Loops / Interval settings are ignored — use the Repeat field above
                instead. Disabled profiles are skipped. Cycles (A → B → A) and
                chains deeper than 5 levels are blocked automatically.
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-between items-center px-4 py-3 border-t border-border-subtle">
          <span className="text-[11px] text-text-tertiary">Ctrl+Enter to confirm</span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-1.5 text-xs font-medium text-text-secondary bg-bg-card hover:bg-bg-surface border border-border-subtle rounded transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={!canConfirm}
              className="px-4 py-1.5 text-xs font-medium text-white bg-accent-solid hover:bg-accent-solid/80 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {initial ? 'Save' : 'Add'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
