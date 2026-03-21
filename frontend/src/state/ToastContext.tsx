import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { useBridge } from '../bridge/BridgeContext';

export type ToastType = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  toasts: ToastItem[];
  showToast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let nextId = 0;

function inferType(message: string): ToastType {
  const lower = message.toLowerCase();
  if (lower.includes('error') || lower.includes('fail') || lower.includes('conflict') || lower.includes('invalid') || lower.includes('timed out'))
    return 'error';
  if (lower.includes('saved') || lower.includes('created') || lower.includes('updated') || lower.includes('success') || lower.includes('deleted') || lower.includes('imported'))
    return 'success';
  return 'info';
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const { subscribe } = useBridge();
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const showToast = useCallback((message: string, type?: ToastType) => {
    const id = nextId++;
    const resolvedType = type ?? inferType(message);
    setToasts(prev => [...prev, { id, message, type: resolvedType }]);

    // Auto-dismiss: 8s for errors (longer messages), 3s for others
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, resolvedType === 'error' ? 8000 : 3000);
  }, []);

  // Subscribe to bridge alert:show
  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === 'alert:show') {
        showToast(msg.payload.message);
      }
    });
  }, [subscribe, showToast]);

  return (
    <ToastContext.Provider value={{ toasts, showToast }}>
      {children}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
