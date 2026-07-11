import { useCallback, useEffect, useState } from 'react';
import { useBridge } from '../../bridge/BridgeContext';

// Reads the current clipboard text via the bridge once on mount. Used by both
// clipboard-related popovers (insert and chip-edit) so the live preview reflects
// what the user would actually paste at runtime. `refresh` re-reads on demand
// (the Clipboard Surface's ⟳ button) — the old content stays visible until the
// fresh read lands, so no flicker.
export function useClipboardContent() {
  const { send, subscribe } = useBridge();
  const [clipRaw, setClipRaw] = useState<string>('');
  const [clipReady, setClipReady] = useState(false);

  useEffect(() => {
    const off = subscribe((msg) => {
      if (msg.type === 'clipboard:content') {
        setClipRaw(msg.payload.text || '');
        setClipReady(true);
      }
    });
    send({ type: 'clipboard:read', payload: {} });
    return off;
  }, [send, subscribe]);

  const refresh = useCallback(() => {
    send({ type: 'clipboard:read', payload: {} });
  }, [send]);

  return { clipRaw, clipReady, refresh };
}
