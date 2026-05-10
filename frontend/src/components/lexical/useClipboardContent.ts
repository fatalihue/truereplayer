import { useEffect, useState } from 'react';
import { useBridge } from '../../bridge/BridgeContext';

// Reads the current clipboard text via the bridge once on mount. Used by both
// clipboard-related popovers (insert and chip-edit) so the live preview reflects
// what the user would actually paste at runtime.
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

  return { clipRaw, clipReady };
}
