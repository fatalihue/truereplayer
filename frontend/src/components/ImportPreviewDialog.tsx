import { useState, useMemo, useEffect } from 'react';
import { Download, AlertTriangle, FolderOpen, Keyboard, Hash, Pencil, Replace, Ban } from 'lucide-react';
import type { ImportPreviewPayload, ImportConflictResolution } from '../bridge/messageTypes';
import { Checkbox } from './Checkbox';
import { DialogShell } from './common/DialogShell';
import { Button } from './common/Button';

interface ImportPreviewDialogProps {
  preview: ImportPreviewPayload;
  /**
   * Called with the list of selected profile names and the per-profile resolution
   * for any name conflicts. The map only contains entries for profiles whose name
   * collides with an existing local profile; for the rest, the backend imports normally.
   */
  onConfirm: (selectedNames: string[], conflictResolutions: Record<string, ImportConflictResolution>) => void;
  onCancel: () => void;
}

/**
 * Phase 2 of the import flow (after the security warning, if shown). Renders one
 * checkbox row per profile in the .trprofile envelope so the user can review
 * metadata + cherry-pick which ones to actually import.
 *
 * Incompatible profiles (AppMinVersion > running version) are rendered greyed-out
 * with a reason and cannot be selected — the backend rejects them as a safety net
 * even if the frontend bug lets one through.
 *
 * Conflict resolution (Overwrite / Rename / Skip dialog) still happens server-side
 * during confirm; this dialog only shows whether a name conflict EXISTS via a chip.
 */
export function ImportPreviewDialog({ preview, onConfirm, onCancel }: ImportPreviewDialogProps) {
  // Default selection: every compatible profile checked. The user opts out per item
  // rather than opting in — matches the "I'm importing this file because I want it all"
  // mental model and matches Stream Deck / VS Code profile import UX.
  const initialSelection = useMemo(() => {
    const map: Record<string, boolean> = {};
    preview.profiles.forEach(p => { map[p.name] = p.compatible; });
    return map;
  }, [preview.profiles]);

  const [selected, setSelected] = useState<Record<string, boolean>>(initialSelection);

  // Per-conflict resolution. Default "rename" matches the safest choice — never silently
  // destroys existing local work. Only populated for profiles flagged nameConflict; the
  // backend ignores entries that don't actually conflict at import time.
  const initialResolutions = useMemo(() => {
    const map: Record<string, ImportConflictResolution> = {};
    preview.profiles.forEach(p => {
      if (p.nameConflict) map[p.name] = 'rename';
    });
    return map;
  }, [preview.profiles]);

  const [conflictResolutions, setConflictResolutions] = useState<Record<string, ImportConflictResolution>>(initialResolutions);

  // Resync selection when preview changes (defensive — caller usually unmounts/remounts).
  useEffect(() => {
    setSelected(initialSelection);
    setConflictResolutions(initialResolutions);
  }, [initialSelection, initialResolutions]);

  const conflictCount = preview.profiles.filter(p => p.nameConflict).length;
  // Bulk-apply: when every conflicting profile shares the same resolution, the bulk pills
  // show that as the active state. Click switches every conflict at once.
  const bulkResolution: ImportConflictResolution | null = useMemo(() => {
    if (conflictCount === 0) return null;
    const vals = preview.profiles
      .filter(p => p.nameConflict)
      .map(p => conflictResolutions[p.name]);
    const first = vals[0];
    return vals.every(v => v === first) ? first : null;
  }, [preview.profiles, conflictResolutions, conflictCount]);

  const applyBulkResolution = (res: ImportConflictResolution) => {
    setConflictResolutions(prev => {
      const next = { ...prev };
      preview.profiles.forEach(p => {
        if (p.nameConflict) next[p.name] = res;
      });
      return next;
    });
  };

  const selectedCount = Object.entries(selected).filter(([name, on]) => {
    if (!on) return false;
    const p = preview.profiles.find(x => x.name === name);
    return p?.compatible === true;
  }).length;

  // Rows that are checked + compatible but whose name-conflict is resolved to "skip" WON'T
  // actually be written — the backend counts them as skipped. Excluding them from the count
  // keeps the button/footer honest: "Import Selected (3)" that yields "All 2 were skipped" was
  // the reported bug. selectedCount is the raw checked set; effectiveImportCount is what lands.
  const skipResolvedCount = preview.profiles.filter(p =>
    !!selected[p.name] && p.compatible && p.nameConflict && (conflictResolutions[p.name] ?? 'rename') === 'skip'
  ).length;
  const effectiveImportCount = selectedCount - skipResolvedCount;

  const compatibleCount = preview.profiles.filter(p => p.compatible).length;
  const incompatibleCount = preview.profiles.length - compatibleCount;

  const handleConfirm = () => {
    const names = Object.entries(selected)
      .filter(([_, on]) => on)
      .map(([name]) => name)
      .filter(name => preview.profiles.find(p => p.name === name)?.compatible === true);
    onConfirm(names, conflictResolutions);
  };

  const toggleAll = (value: boolean) => {
    const next: Record<string, boolean> = {};
    preview.profiles.forEach(p => { next[p.name] = value && p.compatible; });
    setSelected(next);
  };

  return (
    <DialogShell
      icon={<Download size={14} style={{ color: 'var(--color-accent)' }} />}
      title="Import Profiles"
      // max-h keeps the review list scrollable inside the card on short windows
      // (the profile list below is the flex-1 overflow-y-auto region).
      widthClass="w-[640px] max-h-[90vh]"
      onClose={onCancel}
      // closeOnBackdrop FALSE: accidentally clicking outside while reviewing a
      // dozen profiles would discard the selection + conflict choices. The user
      // dismisses via the Cancel button, Esc, or completing the import.
      closeOnBackdrop={false}
      footerHint={
        skipResolvedCount > 0
          ? <>{effectiveImportCount} will be imported · {skipResolvedCount} skipped</>
          : <>{effectiveImportCount} of {compatibleCount} will be imported</>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button
            variant="primary"
            onClick={handleConfirm}
            disabled={effectiveImportCount === 0}
          >
            Import Selected ({effectiveImportCount})
          </Button>
        </>
      }
      // No Enter rule (unchanged from the hand-rolled version); this handler only
      // preserves the old scrim-level stopPropagation so keystrokes typed while
      // reviewing don't leak to app-level shortcut handlers. Esc is owned by the
      // shell (it already stops propagation before this runs).
      onCardKeyDown={(e) => e.stopPropagation()}
    >
        {/* File summary */}
        <div className="px-4 py-3 border-b border-border-subtle bg-bg-surface/30">
          <div className="flex items-center gap-2 text-xs">
            <FolderOpen size={12} className="text-text-tertiary" />
            <span className="text-text-secondary font-medium truncate">{preview.fileName}</span>
          </div>
          <div className="mt-1 text-[11px] text-text-tertiary flex flex-wrap gap-x-4 gap-y-0.5">
            <span>Exported: {formatDate(preview.exportedAt)}</span>
            <span>Format: v{preview.envelopeVersion}</span>
            <span>Your app: v{preview.runningVersion}</span>
            {preview.hasOrganization && (
              <span className="text-accent-light">
                + folder organization
              </span>
            )}
          </div>
        </div>

        {/* Bulk-select toolbar */}
        <div className="px-4 py-2 border-b border-border-subtle flex items-center justify-between text-[11px] text-text-tertiary">
          <span>
            {preview.profiles.length} profile{preview.profiles.length === 1 ? '' : 's'} in this file
            {incompatibleCount > 0 && (
              <span className="text-amber-400 ml-2">
                ({incompatibleCount} incompatible)
              </span>
            )}
          </span>
          <div className="flex gap-3">
            <button
              onClick={() => toggleAll(true)}
              disabled={compatibleCount === 0}
              className="hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Select all
            </button>
            <button
              onClick={() => toggleAll(false)}
              className="hover:text-text-primary transition-colors"
            >
              Clear
            </button>
          </div>
        </div>

        {/* Bulk conflict resolution — only rendered when at least one selected profile
            collides with an existing local name. Renders large pills with icons so the
            bulk action is the obvious primary control; per-row pills below are smaller
            "override" overrides. Lets the user resolve everything in one click. */}
        {conflictCount > 0 && (
          <div className="px-4 py-3 border-b border-border-subtle bg-amber-900/25 flex items-center gap-4 flex-wrap">
            <span className="text-xs font-medium text-amber-400 flex items-center gap-2">
              <AlertTriangle size={14} />
              {conflictCount} name conflict{conflictCount === 1 ? '' : 's'} — apply to all:
            </span>
            <ResolutionChips
              value={bulkResolution}
              onChange={applyBulkResolution}
              size="lg"
            />
          </div>
        )}

        {/* Profile list */}
        <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1.5">
          {preview.profiles.map(p => {
            const isChecked = !!selected[p.name];
            return (
              <div
                key={p.name}
                className={`flex items-start gap-3 px-3 py-2.5 rounded border ${
                  p.compatible
                    ? 'border-border-subtle bg-bg-card hover:bg-bg-surface'
                    : 'border-amber-900/40 bg-amber-950/10 opacity-70'
                } transition-colors`}
              >
                {/* Checkbox */}
                <div className="pt-0.5">
                  <Checkbox
                    checked={isChecked && p.compatible}
                    onChange={(value) => {
                      if (!p.compatible) return;
                      setSelected(prev => ({ ...prev, [p.name]: value }));
                    }}
                  />
                </div>

                {/* Icon */}
                <div className="text-lg leading-none pt-0.5 select-none w-5 text-center">
                  {p.iconEmoji || '📄'}
                </div>

                {/* Main info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-medium text-text-primary truncate">{p.name}</span>
                    <span className="text-[10px] px-1.5 py-px rounded bg-bg-surface text-text-tertiary border border-border-subtle">
                      v{p.profileVersion}
                    </span>
                  </div>

                  <div className="mt-0.5 flex items-center gap-3 text-[11px] text-text-tertiary flex-wrap">
                    <span>{p.actionCount} action{p.actionCount === 1 ? '' : 's'}</span>
                    {p.hotkey && (
                      <span className="flex items-center gap-1">
                        <Keyboard size={10} />
                        {p.hotkey}
                      </span>
                    )}
                    {p.updatedAt && (
                      <span>Updated {formatRelative(p.updatedAt)}</span>
                    )}
                  </div>

                  {p.targetProcessName && (
                    <div className="mt-0.5 text-[11px] text-text-tertiary truncate">
                      Targets: <span className="font-mono">{p.targetProcessName}</span>
                    </div>
                  )}

                  {p.description && (
                    <div className="mt-1 text-[11px] text-text-secondary leading-snug line-clamp-2">
                      {p.description}
                    </div>
                  )}

                  {p.tags && p.tags.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {p.tags.map(t => (
                        <span
                          key={t}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-bg-surface text-text-tertiary border border-border-subtle"
                        >
                          <Hash size={8} className="inline -mt-px mr-0.5" />
                          {t}
                        </span>
                      ))}
                    </div>
                  )}

                  {!p.compatible && (
                    <div className="mt-1.5 flex items-start gap-1.5 text-[11px] text-amber-400">
                      <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" />
                      <span>
                        Requires TrueReplayer {p.appMinVersion} or newer — cannot import.
                      </span>
                    </div>
                  )}

                  {/* Per-row conflict resolution. Only rendered when this row's name
                      collides with an existing local profile AND the row is selected
                      (no point picking a resolution for a row you've unchecked). */}
                  {p.nameConflict && p.compatible && isChecked && (
                    <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-amber-400/90">
                      <span>Name exists:</span>
                      <ResolutionChips
                        value={conflictResolutions[p.name] ?? 'rename'}
                        onChange={(res) => setConflictResolutions(prev => ({ ...prev, [p.name]: res }))}
                      />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
    </DialogShell>
  );
}

// ── Resolution chips ──
// Segmented control for picking how a name-conflict should be resolved.
//   - size="sm"  → per-row override, compact (no icons, small text)
//   - size="lg"  → bulk header pill, prominent (icons + bigger text) so it's
//                  obvious as the primary control. Per-row chips are visually
//                  subordinate so the user reads top→down as "apply to all,
//                  then tweak individuals".
// `value` is null in the bulk control when the per-row choices disagree — no
// chip highlighted, clicking one resets every conflicting row to that value.

interface ResolutionChipsProps {
  value: ImportConflictResolution | null;
  onChange: (resolution: ImportConflictResolution) => void;
  size?: 'sm' | 'lg';
}

function ResolutionChips({ value, onChange, size = 'sm' }: ResolutionChipsProps) {
  const options: {
    key: ImportConflictResolution;
    label: string;
    Icon: React.ComponentType<{ size?: number; className?: string }>;
  }[] = [
    { key: 'rename', label: 'Rename', Icon: Pencil },
    { key: 'overwrite', label: 'Overwrite', Icon: Replace },
    { key: 'skip', label: 'Skip', Icon: Ban },
  ];

  // Size variants. lg pumps padding + adds an icon; sm stays as the tight overlay
  // it used to be. shadow on lg gives it a button-like lift over the tinted header.
  const isLg = size === 'lg';
  const btnPad = isLg ? 'px-3 py-1.5' : 'px-2 py-0.5';
  const textSize = isLg ? 'text-xs font-medium' : 'text-[11px]';
  const iconSize = isLg ? 12 : 10;
  const containerExtra = isLg ? 'shadow-sm' : '';

  return (
    <div className={`inline-flex rounded border border-border-subtle overflow-hidden ${containerExtra}`}>
      {options.map((opt, i) => {
        const active = value === opt.key;
        return (
          <button
            key={opt.key}
            type="button"
            onClick={() => onChange(opt.key)}
            className={`${btnPad} ${textSize} flex items-center gap-1.5 transition-colors ${
              active
                ? 'bg-accent-solid/30 text-text-primary'
                : 'bg-bg-card text-text-tertiary hover:bg-bg-surface hover:text-text-secondary'
            } ${i > 0 ? 'border-l border-border-subtle' : ''}`}
          >
            {isLg && <opt.Icon size={iconSize} className={active ? 'text-accent' : 'text-text-tertiary'} />}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Date helpers ──
// Kept inline to avoid yet another util module. If a third dialog ends up needing
// these, factor into src/utils/dateFormat.ts.

function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'Unknown';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return 'Unknown';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return 'Unknown';
  }
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const diffMs = Date.now() - d.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return 'just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 30) return `${diffDay}d ago`;
    const diffMo = Math.floor(diffDay / 30);
    if (diffMo < 12) return `${diffMo}mo ago`;
    return `${Math.floor(diffMo / 12)}y ago`;
  } catch {
    return '';
  }
}
