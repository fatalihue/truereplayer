import { useState, useEffect, useMemo } from 'react';
import { Repeat2 } from 'lucide-react';
import { useAppState } from '../state/AppStateContext';
import { useTt } from '../state/LanguageContext';
import { NumberInput } from './common/NumberInput';
import { DialogShell } from './common/DialogShell';
import { Button } from './common/Button';
import { ProfileSearchList } from './common/ProfileSearchList';

export interface RunProfileDialogProps {
  /** What the dialog is DOING — drives the title and the confirm label. Required, and
   *  deliberately not derived from `initial`: drag-to-insert passes `initial` purely to
   *  pre-fill the dropped profile, and inferring intent from that data made the insert
   *  dialog announce itself as "Edit Run Profile" with a "Save" button. */
  mode: 'add' | 'edit';
  /** Values to open on. Pre-fills the picker and the repeat count; on `add` it is the
   *  profile the user just dropped, on `edit` it is what the action stores. NOT a mode
   *  signal — see `mode`. */
  initial?: { profileName: string; repeatCount: number; runOverData?: boolean };
  /** Name of the profile that will own the action. Used to filter self-reference. */
  excludeProfileName?: string;
  onConfirm: (profileName: string, repeatCount: number, runOverData: boolean) => void;
  onClose: () => void;
}

/**
 * Dialog used by "Add Run Profile" (from the Add Actions menu, and from dragging a profile
 * onto the grid) and by "Edit Run Profile" (double-click on an existing RunProfile row).
 *
 * Shows a profile dropdown (filtered to exclude self-references) and a
 * numeric repeat count. Validates non-empty selection before confirming.
 */
export function RunProfileDialog({ mode, initial, excludeProfileName, onConfirm, onClose }: RunProfileDialogProps) {
  const { profiles } = useAppState();
  const tt = useTt();
  const [profileName, setProfileName] = useState(initial?.profileName ?? '');
  const [repeatCount, setRepeatCount] = useState(initial?.repeatCount ?? 1);
  const [runOverData, setRunOverData] = useState(initial?.runOverData ?? false);

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

  // Seed the picker's search box with the profile this dialog opened on, so the target is
  // READ as well as selected: dragging a profile onto the grid used to open a full list of
  // ~80 names with the dropped one highlighted somewhere inside it, which is a scroll away
  // from telling the user which profile they just dropped.
  //
  // Guarded on the name actually being in the list. A stored target that has since been
  // deleted is not eligible, and seeding it would pre-filter the picker down to NOTHING —
  // strictly worse than the unfiltered list, and for the one case where the user most needs
  // to pick a replacement.
  const seedQuery = useMemo(() => {
    const name = initial?.profileName;
    if (!name) return undefined;
    return eligibleProfiles.some((p) => p.name === name) ? name : undefined;
  }, [initial?.profileName, eligibleProfiles]);

  // Pre-select the first eligible profile if none chosen yet.
  useEffect(() => {
    if (!profileName && eligibleProfiles.length > 0) {
      setProfileName(eligibleProfiles[0].name);
    }
  }, [eligibleProfiles, profileName]);

  // The picker's search field autofocuses (see ProfileSearchList autoFocus) over
  // DialogShell's card focus, so the user can type to filter immediately.

  const canConfirm = profileName.trim().length > 0 && repeatCount >= 1;

  const handleConfirm = () => {
    if (!canConfirm) return;
    onConfirm(profileName, Math.max(1, Math.min(999, repeatCount)), runOverData);
  };

  return (
    <DialogShell
      icon={<Repeat2 size={14} className="shrink-0" style={{ color: 'var(--color-action-runprofile-fg)' }} />}
      title={mode === 'edit' ? 'Edit Run Profile' : 'Add Run Profile'}
      onClose={onClose}
      // Picker dialog: the dropdown pre-selects a value and the repeat count is a
      // one-keystroke tweak — a stray backdrop click discards nothing hard to redo,
      // so backdrop-dismiss stays enabled (the default).
      closeOnBackdrop={true}
      footerHint={tt('Enter to confirm · Esc to cancel', 'Enter confirma · Esc cancela')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleConfirm} disabled={!canConfirm}>
            {mode === 'edit' ? 'Save' : 'Add'}
          </Button>
        </>
      }
      onCardKeyDown={(e) => {
        // Plain Enter confirms — this dialog is single-field (a select), so the
        // multi-line-text justification for Ctrl+Enter (used in SendTextDialog)
        // doesn't apply here. Esc is owned by DialogShell.
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          handleConfirm();
        }
      }}
    >
      {/* Body */}
      <div className="px-4 py-4 flex flex-col gap-4">
        {eligibleProfiles.length === 0 ? (
          <div className="text-xs text-text-tertiary py-4 text-center">
            {tt('No other profile to call.', 'Nenhum outro perfil para chamar.')}
            <br />
            {tt('Create one first.', 'Crie um perfil antes.')}
          </div>
        ) : (
          <>
            {/* Search-and-pick instead of a native <select>: the OS dropdown has no filter,
                so picking one of ~80 profiles meant scrolling a wall of names. Same
                type-to-narrow behaviour as the Profiles panel and the export dialog. */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] uppercase tracking-wide font-semibold text-text-tertiary">
                Profile to run
              </label>
              <ProfileSearchList
                profiles={eligibleProfiles.map((p) => p.name)}
                value={profileName || null}
                onChange={setProfileName}
                autoFocus
                initialQuery={seedQuery}
                ariaLabel={tt('Profile to run', 'Profile a executar')}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] uppercase tracking-wide font-semibold text-text-tertiary">
                Repeat
              </label>
              <div className={`flex items-center gap-2 ${runOverData ? 'opacity-40 pointer-events-none' : ''}`}>
                <span className="inline-flex">
                  <NumberInput
                    value={repeatCount}
                    onChange={setRepeatCount}
                    min={1}
                    max={999}
                    inputWidth="w-16"
                    inputHeight="h-8"
                    ariaLabel={tt('Repeat count', 'Número de repetições')}
                  />
                </span>
                <span className="text-xs text-text-tertiary">
                  {tt(repeatCount === 1 ? 'time per call' : 'times per call',
                      repeatCount === 1 ? 'vez por chamada' : 'vezes por chamada')}
                </span>
              </div>
            </div>

            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={runOverData}
                onChange={(e) => setRunOverData(e.target.checked)}
              />
              <span className="text-xs text-text-primary"
                data-tip={tt('Runs the called profile once per row of ITS own Data table, with {row:column} coming from that row. Overrides Repeat; with no table it just runs once.',
                  'Roda o perfil chamado uma vez por linha da tabela de dados DELE, com {row:column} vindo daquela linha. Substitui o Repeat; sem tabela, roda uma vez só.')}>
                Run once per data row
              </span>
            </label>

            <div className="text-[11px] text-text-tertiary leading-relaxed bg-bg-card border border-border-subtle rounded px-2.5 py-2">
              {tt('The called profile’s actions run right here. Its own Loops / Interval are ignored — use Repeat above. Disabled profiles are skipped, and chains deeper than 5 levels are blocked.',
                'As ações do perfil chamado rodam aqui mesmo. Os Loops / Interval dele são ignorados — use o Repeat acima. Perfis desativados são pulados, e cadeias com mais de 5 níveis são bloqueadas.')}
            </div>
          </>
        )}
      </div>
    </DialogShell>
  );
}
