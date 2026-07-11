import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getNodeByKey, type NodeKey } from 'lexical';
import { TokenNode } from './TokenNode';
import { TokenChipPopover } from './TokenChipPopover';

// Host-provided handler for editing a {clipboard...} chip in a LARGER surface
// than the default 300px popover. SendTextDialog provides one (routing to its
// full-body Clipboard Surface); SheetPanel doesn't — chips there fall back to
// the popover, byte-identical to the old behavior. Defined here (not in
// LexicalTokenEditor) so the provider module can import it without a cycle.
export interface ClipboardChipEditRequest {
  /** The chip's current token text, e.g. `{Clipboard:trim:upper}`. */
  token: string;
  /** Commit a replacement token back onto the chip (no-ops if unchanged upstream). */
  commit: (next: string) => void;
  /** Remove the chip from the editor. */
  remove: () => void;
}
export const ClipboardChipEditContext =
  createContext<((req: ClipboardChipEditRequest) => void) | null>(null);

// React decorator content for a TokenNode. Owns the popover open state AND the
// commit logic — every close path (Esc, click outside, ✕, clicking the chip
// again) funnels through handleClose, so no path can drop the user's edits.
//
// The popover stores live edits in a ref (no re-renders), and only commits when
// the popover closes. That avoids re-rendering the chip mid-typing, which is
// what used to cause controlled inputs in the popover to lose characters.
export function TokenChip({ nodeKey, token }: { nodeKey: NodeKey; token: string }) {
  const [editor] = useLexicalComposerContext();
  const onClipboardChipEdit = useContext(ClipboardChipEditContext);
  const [open, setOpen] = useState(false);
  // Use the state-setter as the ref callback so we never read a ref value
  // during render — the popover anchor lives in state and updates when the
  // span mounts/unmounts.
  const [anchorEl, setAnchorEl] = useState<HTMLSpanElement | null>(null);
  const liveTokenRef = useRef(token);

  // Resync the live ref when the chip's token changes externally (other edits,
  // undo). Without this, opening the popover after such a change would commit
  // the stale liveTokenRef from the prior session.
  useEffect(() => {
    liveTokenRef.current = token;
  }, [token]);

  const handleLiveChange = useCallback((next: string) => {
    liveTokenRef.current = next;
  }, []);

  const handleClose = useCallback(() => {
    const next = liveTokenRef.current;
    if (next !== token) {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if (node instanceof TokenNode) node.setToken(next);
      });
    }
    setOpen(false);
  }, [editor, nodeKey, token]);

  const handleDelete = useCallback(() => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (node) node.remove();
    });
    setOpen(false);
  }, [editor, nodeKey]);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Clipboard chips route to the host's large edit surface when one is
    // provided (Insert Text dialog); otherwise (SheetPanel) the popover below
    // opens exactly as before. Do NOT remove this dispatch as "dead" — the
    // provider lives in a different tree (SendTextDialog via context).
    if (onClipboardChipEdit && /^\{clipboard(?::|\})/i.test(token)) {
      onClipboardChipEdit({
        token,
        commit: (next: string) => {
          if (next === token) return;
          editor.update(() => {
            const node = $getNodeByKey(nodeKey);
            if (node instanceof TokenNode) node.setToken(next);
          });
        },
        remove: handleDelete,
      });
      return;
    }
    if (open) handleClose();
    else setOpen(true);
  };

  return (
    <>
      <span
        ref={setAnchorEl}
        contentEditable={false}
        onClick={handleClick}
        onMouseDown={(e) => e.stopPropagation()}
        // Chip palette tracks the SendText action colour (--color-action-sendtext-fg).
        // Pairing the editor chip with the grid chip and the action-type badge gives the
        // user a single colour language for everything SendText-related — see also
        // SendTextPreview.tsx which uses the exact same opacity ramp.
        className={`inline-flex items-center px-1.5 py-[1px] mx-[1px] text-[12px] font-mono rounded text-[var(--color-action-sendtext-fg)] bg-[var(--color-action-sendtext-fg)]/15 border border-[var(--color-action-sendtext-fg)]/40 select-none cursor-pointer hover:bg-[var(--color-action-sendtext-fg)]/25 transition-colors ${
          open ? 'ring-1 ring-[var(--color-action-sendtext-fg)]/60' : ''
        }`}
      >
        {token.slice(1, -1)}
      </span>
      {open && anchorEl && (
        <TokenChipPopover
          anchor={anchorEl}
          token={token}
          onLiveChange={handleLiveChange}
          onClose={handleClose}
          onDelete={handleDelete}
        />
      )}
    </>
  );
}
