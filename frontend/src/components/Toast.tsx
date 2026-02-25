import { useState, useEffect, useCallback } from 'react';
import { useBridge } from '../bridge/BridgeContext';

export function Toast() {
  const { subscribe } = useBridge();
  const [message, setMessage] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);

  const show = useCallback((text: string) => {
    setMessage(text);
    setVisible(true);
  }, []);

  // Auto-dismiss after 3s
  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => setVisible(false), 3000);
    return () => clearTimeout(timer);
  }, [visible, message]);

  // Subscribe to alert:show messages
  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === 'alert:show') {
        show(msg.payload.message);
      }
    });
  }, [subscribe, show]);

  if (!visible || !message) return null;

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 32,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9999,
        background: '#2a2a2a',
        border: '1px solid rgba(255, 107, 107, 0.3)',
        borderRadius: 8,
        padding: '10px 18px',
        color: '#ff6b6b',
        fontSize: 13,
        fontWeight: 500,
        boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
        animation: 'toast-in 0.2s ease-out',
        maxWidth: '80%',
        textAlign: 'center' as const,
      }}
    >
      {message}
    </div>
  );
}
