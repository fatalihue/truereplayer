import { createContext, useContext, useCallback, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { OutgoingMessage, IncomingMessage } from './messageTypes';

interface WebView2API {
  postMessage: (message: unknown) => void;
  addEventListener: (type: string, handler: (event: { data: unknown }) => void) => void;
  removeEventListener: (type: string, handler: (event: { data: unknown }) => void) => void;
}

declare global {
  interface Window {
    chrome?: {
      webview?: WebView2API;
    };
  }
}

type MessageHandler = (message: IncomingMessage) => void;

interface BridgeContextValue {
  send: (message: OutgoingMessage) => void;
  subscribe: (handler: MessageHandler) => () => void;
}

const BridgeContext = createContext<BridgeContextValue | null>(null);

export function BridgeProvider({ children }: { children: ReactNode }) {
  const handlersRef = useRef<Set<MessageHandler>>(new Set());

  const send = useCallback((message: OutgoingMessage) => {
    if (window.chrome?.webview) {
      // Pass object directly — WebView2 serializes to JSON internally
      window.chrome.webview.postMessage(message);
    } else {
      console.log('[Bridge] → C#:', message.type, message.payload);
    }
  }, []);

  const subscribe = useCallback((handler: MessageHandler) => {
    handlersRef.current.add(handler);
    return () => { handlersRef.current.delete(handler); };
  }, []);

  useEffect(() => {
    const onMessage = (event: { data: unknown }) => {
      try {
        const message: IncomingMessage = typeof event.data === 'string'
          ? JSON.parse(event.data)
          : event.data;
        console.log('[Bridge] ← C#:', message.type);
        handlersRef.current.forEach(handler => handler(message));
      } catch (err) {
        console.error('[Bridge] Failed to parse message:', err);
      }
    };

    if (window.chrome?.webview) {
      window.chrome.webview.addEventListener('message', onMessage);
      return () => window.chrome?.webview?.removeEventListener('message', onMessage);
    }
  }, []);

  // Send ui:ready once the bridge is initialized
  useEffect(() => {
    send({ type: 'ui:ready', payload: {} });
  }, [send]);

  return (
    <BridgeContext.Provider value={{ send, subscribe }}>
      {children}
    </BridgeContext.Provider>
  );
}

export function useBridge() {
  const ctx = useContext(BridgeContext);
  if (!ctx) throw new Error('useBridge must be used within BridgeProvider');
  return ctx;
}
