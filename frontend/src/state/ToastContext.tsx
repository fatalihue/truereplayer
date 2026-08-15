import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
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
  showToast: (message: string, options?: ToastOptions | ToastType) => void;
  dismissToast: (id: number) => void;
  // Hover-pause: the renderer freezes the auto-dismiss countdown while the
  // pointer is over a toast (reading an 8s error shouldn't be a race).
  pauseToast: (id: number) => void;
  resumeToast: (id: number) => void;
}

// TWO contexts on purpose, the same split ClickerLiveContext already uses for its 4 Hz push.
//
// The list changes on every show AND every auto-dismiss, while nearly every consumer only ever
// calls showToast: ActionTable, ProfilePanel, SettingsPanel and Toolbar together are ~8900 lines
// that were re-rendering on every toast because the value object bundled `toasts` with the API.
// A plain useMemo cannot fix that — the dependency genuinely changes — but splitting can: the API
// object's members are all stable useCallbacks, so ToastContext never invalidates, and only
// Toast.tsx (via useToasts) subscribes to the list.
const ToastContext = createContext<ToastContextValue | null>(null);
const ToastListContext = createContext<ToastItem[]>([]);

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
  const { subscribe, send } = useBridge();
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // Track auto-dismiss timers so they can be cancelled on manual dismiss and on unmount —
  // otherwise a pending timer (up to 8s for errors) fires setToasts after the provider is gone.
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  // Absolute dismiss deadline per toast (set when its timer is armed) + the
  // remaining budget captured at pause time. Two maps so pause → resume can't
  // confuse "deadline" with "time left".
  const deadlinesRef = useRef<Map<number, number>>(new Map());
  const remainingRef = useRef<Map<number, number>>(new Map());

  const armTimer = useCallback((id: number, ms: number) => {
    deadlinesRef.current.set(id, Date.now() + ms);
    const timer = setTimeout(() => {
      timersRef.current.delete(id);
      deadlinesRef.current.delete(id);
      remainingRef.current.delete(id);
      setToasts(prev => prev.filter(t => t.id !== id));
    }, ms);
    timersRef.current.set(id, timer);
  }, []);

  const dismissToast = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    deadlinesRef.current.delete(id);
    remainingRef.current.delete(id);
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const pauseToast = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (!timer) return;
    clearTimeout(timer);
    timersRef.current.delete(id);
    const deadline = deadlinesRef.current.get(id);
    remainingRef.current.set(id, Math.max(0, (deadline ?? Date.now()) - Date.now()));
  }, []);

  const resumeToast = useCallback((id: number) => {
    if (timersRef.current.has(id)) return; // never paused (or already resumed)
    const remaining = remainingRef.current.get(id);
    if (remaining == null) return;
    remainingRef.current.delete(id);
    // 1.5s floor so a toast the user just finished reading doesn't vanish the
    // instant the pointer leaves it.
    armTimer(id, Math.max(remaining, 1500));
  }, [armTimer]);

  // Accepts either a ToastType string (legacy 2-arg call sites) or an options object.
  const showToast = useCallback((message: string, opts?: ToastOptions | ToastType) => {
    const options: ToastOptions = typeof opts === 'string' ? { type: opts } : (opts ?? {});
    const id = nextId++;
    const resolvedType = options.type ?? inferType(message);
    const duration = options.duration
      ?? (options.action ? 6000 : (resolvedType === 'error' ? 8000 : 3000));
    setToasts(prev => [...prev, { id, message, type: resolvedType, action: options.action }]);
    armTimer(id, duration);
  }, [armTimer]);

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
        // sent as 'info' so it isn't mis-inferred as a red error) and an explicit duration;
        // fall back to inference. Duration must be a POSITIVE finite number — 0/negative
        // would flash-dismiss the toast on the next tick, a silent information drop.
        const d = msg.payload.duration;
        showToast(msg.payload.message, {
          type: msg.payload.type,
          duration: typeof d === 'number' && isFinite(d) && d > 0 ? d : undefined,
        });
      } else if (msg.type === 'profile:exportResult') {
        // Export feedback lives HERE, with the other backend-push toasts — not in a
        // panel component whose mounting the CommandPalette's "Export All Profiles"
        // has no relationship with. The "Show in folder" action echoes the exportId,
        // pinning this toast to the file THIS export wrote (paths stay server-side).
        const p = msg.payload;
        const partial = p.exportedCount < p.requestedCount;
        let m = partial
          ? `Exported ${p.exportedCount} of ${p.requestedCount} profile(s)`
          : `Exported ${p.exportedCount} profile(s)`;
        if (p.fileName) m += ` to ${p.fileName}`;
        m += '.';
        if (partial) m += ` ${p.requestedCount - p.exportedCount} could not be loaded.`;
        if (p.bundledDependencies.length > 0)
          m += ` Included ${p.bundledDependencies.length} referenced sub-profile(s): ${p.bundledDependencies.join(', ')}.`;
        if (p.missingImages > 0) m += ` ${p.missingImages} reference image(s) were missing and not included.`;
        const hasDisclosures = partial || p.bundledDependencies.length > 0 || p.missingImages > 0;
        showToast(m, {
          // A partial export reports data loss — never render it success-green.
          type: hasDisclosures ? 'info' : 'success',
          duration: hasDisclosures ? 8000 : undefined,
          action: { label: 'Show in folder', onClick: () => send({ type: 'file:revealExport', payload: { exportId: p.exportId } }) },
        });
      }
    });
  }, [subscribe, showToast, send]);

  // Never invalidates: every member is a stable useCallback.
  const api = useMemo(
    () => ({ showToast, dismissToast, pauseToast, resumeToast }),
    [showToast, dismissToast, pauseToast, resumeToast],
  );

  return (
    <ToastContext.Provider value={api}>
      <ToastListContext.Provider value={toasts}>
        {children}
      </ToastListContext.Provider>
    </ToastContext.Provider>
  );
}

/** The toast API (show / dismiss / pause / resume). Stable — subscribing does not re-render. */
export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

/** The live toast list. Only the renderer should use this — it changes on every show and dismiss. */
export function useToasts() {
  return useContext(ToastListContext);
}
