import { Download, AlertTriangle, FolderOpen, Keyboard, ImageOff, Ban, Check } from 'lucide-react';
import type { ImportResultPayload } from '../bridge/messageTypes';
import { DialogShell } from './common/DialogShell';
import { Button } from './common/Button';

interface ImportResultDialogProps {
  result: ImportResultPayload;
  onClose: () => void;
}

/**
 * Post-import result — rendered only when the confirm finished with something worth
 * reading (skips, renames, image failures, folder-target notes, hotkey collisions).
 * A CLEAN import never opens this: it keeps the plain success toast, so the happy
 * path never pays a third modal.
 *
 * This replaces a single 300+ character toast that died in 3 seconds plus one loose
 * toast per hotkey collision (word-sniffed red by the frontend). The most consequential
 * fact of the flow — "the imported profiles will use YOUR folder target, not the
 * sender's" — finally gets a surface that waits to be read.
 */
export function ImportResultDialog({ result, onClose }: ImportResultDialogProps) {
  // final name → requested name, for the "renamed (X was taken)" annotation.
  const renamedFrom = new Map(result.renames.map(r => [r.to, r.from]));

  return (
    <DialogShell
      icon={<Download size={14} style={{ color: 'var(--color-accent)' }} />}
      title="Import complete"
      widthClass="w-[520px] max-h-[85vh]"
      onClose={onClose}
      // Pure reading, nothing to lose — backdrop click may dismiss (unlike the
      // preview, where a stray click would discard a curated selection).
      closeOnBackdrop
      footer={<Button variant="primary" className="min-w-[84px]" onClick={onClose}>Close</Button>}
    >
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-xs">
        {/* Imported — final names; rename-allocated ones say so. */}
        {result.importedNames.length > 0 && (
          <section>
            <div className="font-medium text-text-primary flex items-center gap-1.5">
              <Check size={12} style={{ color: 'var(--color-replay)' }} />
              Imported ({result.imported})
            </div>
            <ul className="mt-1 space-y-0.5 text-text-secondary">
              {result.importedNames.map(n => {
                const from = renamedFrom.get(n);
                return (
                  <li key={n} className="truncate">
                    {n}
                    {from !== undefined && (
                      <span className="text-text-tertiary"> — renamed (&quot;{from}&quot; was taken)</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {result.skipped > 0 && (
          <section>
            <div className="font-medium text-text-primary flex items-center gap-1.5">
              <Ban size={12} className="text-text-tertiary" />
              Skipped ({result.skipped})
            </div>
            {/* Unchecked rows are NOT in this count — they are never sent to the
                backend at all. Only selected rows can be skipped. */}
            <p className="mt-1 text-text-tertiary leading-relaxed">
              Name conflicts resolved as Skip, or entries with invalid names.
            </p>
          </section>
        )}

        {result.imageFailureNames.length > 0 && (
          <section>
            <div className="font-medium text-warning-ink flex items-center gap-1.5">
              <ImageOff size={12} style={{ color: 'var(--color-warning-ink)' }} />
              Reference images not restored ({result.imageFailureNames.length})
            </div>
            {/* Index keys: the same image file name can fail in TWO profiles of one
                envelope (names are per-profile; only the on-disk GUID differs). */}
            <ul className="mt-1 space-y-0.5 text-text-secondary font-mono text-[11px]">
              {result.imageFailureNames.map((n, i) => (
                <li key={i} className="truncate">{n}</li>
              ))}
            </ul>
            <p className="mt-1 text-text-tertiary">See Logs for the per-file reason. WaitImage rows pointing at these will halt replay.</p>
          </section>
        )}

        {(result.hasOrganization || result.adoptedFolderTargets.length > 0 || result.keptLocalFolderTargets.length > 0) && (
          <section>
            <div className="font-medium text-text-primary flex items-center gap-1.5">
              <FolderOpen size={12} className="text-text-tertiary" />
              Folders
            </div>
            <div className="mt-1 space-y-1.5 text-text-secondary leading-relaxed">
              {result.hasOrganization && <p>Folder organization imported.</p>}
              {result.adoptedFolderTargets.length > 0 && (
                <p>Window target set on existing folder(s): <span className="font-medium">{result.adoptedFolderTargets.join(', ')}</span>.</p>
              )}
              {/* The one consequence that must not pass unread: the receiver's own target
                  won, so the imported profiles act on a DIFFERENT window than authored. */}
              {result.keptLocalFolderTargets.length > 0 && (
                <p className="warning-band pl-2.5 py-1.5 rounded-r">
                  Kept your existing window target on folder(s): <span className="font-medium">{result.keptLocalFolderTargets.join(', ')}</span> — the imported profiles there will use <span className="font-medium">your</span> target, not the sender's.
                </p>
              )}
            </div>
          </section>
        )}

        {result.hotkeyCollisions.length > 0 && (
          <section>
            <div className="font-medium text-warning-ink flex items-center gap-1.5">
              <Keyboard size={12} style={{ color: 'var(--color-warning-ink)' }} />
              Hotkey collisions ({result.hotkeyCollisions.length})
            </div>
            <ul className="mt-1 space-y-1 text-text-secondary leading-relaxed">
              {result.hotkeyCollisions.map((msg, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <AlertTriangle size={11} className="mt-0.5 shrink-0" style={{ color: 'var(--color-warning-ink)' }} />
                  <span>{msg}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </DialogShell>
  );
}
