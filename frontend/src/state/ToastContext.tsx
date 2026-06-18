import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useBridge } from '../bridge/BridgeContext';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  type?: ToastType;
  duration?: number;        // ms; defaults to 8000 for errors / 6000 for action toasts / 3000 otherwise
  action?: ToastAction;     // optional inline button (e.g. "Undo")
}

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  action?: ToastAction;
}

interface ToastContextValue {
  toasts: ToastItem[];
  showToast: (message: string, options?: ToastOptions | ToastType) => void;
  dismissToast: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let nextId = 0;

function inferType(message: string): ToastType {
  const lower = message.toLowerCase();
  if (lower.includes('error') || lower.includes('fail') || lower.includes('conflict') || lower.includes('invalid') || lower.includes('timed out'))
    return 'error';
  if (lower.includes('saved') || lower.includes('created') || lower.includes('updated') || lower.includes('success') || lower.includes('deleted') || lower.includes('removed') || lower.includes('imported') || lower.startsWith('set '))
    return 'success';
  return 'info';
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const { subscribe } = useBridge();
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // Track auto-dismiss timers so they can be cancelled on manual dismiss and on unmount —
  // otherwise a pending timer (up to 8s for errors) fires setToasts after the provider is gone.
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismissToast = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  // Accepts either a ToastType string (legacy 2-arg call sites) or an options object.
  const showToast = useCallback((message: string, opts?: ToastOptions | ToastType) => {
    const options: ToastOptions = typeof opts === 'string' ? { type: opts } : (opts ?? {});
    const id = nextId++;
    const resolvedType = options.type ?? inferType(message);
    const duration = options.duration
      ?? (options.action ? 6000 : (resolvedType === 'error' ? 8000 : 3000));
    setToasts(prev => [...prev, { id, message, type: resolvedType, action: options.action }]);
    const timer = setTimeout(() => {
      timersRef.current.delete(id);
      setToasts(prev => prev.filter(t => t.id !== id));
    }, duration);
    timersRef.current.set(id, timer);
  }, []);

  // Cancel any still-pending auto-dismiss timers when the provider unmounts.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);

  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === 'alert:show') {
        // Honour an explicit type from the backend (e.g. a partial-success import warning
        // sent as 'info' so it isn't mis-inferred as a red error); fall back to inference.
        showToast(msg.payload.message, msg.payload.type);
      }
    });
  }, [subscribe, showToast]);

  return (
    <ToastContext.Provider value={{ toasts, showToast, dismissToast }}>
      {children}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
