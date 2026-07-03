import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Last-resort catch for render exceptions. Without it, one throw anywhere in
 * the tree (e.g. a malformed bridge payload hitting a render path) unmounts the
 * ENTIRE UI inside WebView2 — the C# watchdog only covers process-level
 * crashes, so the user was left staring at a blank window with no recovery
 * short of restarting the app.
 *
 * The fallback deliberately uses only theme VARIABLES with hardcoded fallback
 * values — if the crash happened before/inside the theme provider, the vars
 * may be unset and the hardcoded fallbacks keep the card readable.
 *
 * Class component by necessity: componentDidCatch/getDerivedStateFromError
 * have no hook equivalent.
 */

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface in the WebView2 devtools console (reachable via the tray menu's
    // Open DevTools) — the only diagnostic channel guaranteed to still work
    // when the React tree is down.
    console.error('[ErrorBoundary] UI render crashed:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--color-bg-base, #121212)',
          color: 'var(--color-text-primary, #e0e0e0)',
          fontFamily: "'Segoe UI', system-ui, sans-serif",
        }}
      >
        <div
          style={{
            maxWidth: 520,
            padding: '24px 28px',
            background: 'var(--color-bg-elevated, #2a2a2a)',
            border: '1px solid var(--color-border-default, rgba(255,255,255,0.1))',
            borderRadius: 8,
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
            The interface hit an error
          </div>
          <div style={{ fontSize: 12, opacity: 0.75, lineHeight: 1.5, marginBottom: 12 }}>
            Your profiles and recordings are safe — this only affected the window's
            rendering. Reload to continue; if it keeps happening, the text below
            says where.
          </div>
          {/* userSelect text: the ONE place error text must be copyable even
              though the app suppresses selection globally. */}
          <pre
            style={{
              userSelect: 'text',
              WebkitUserSelect: 'text',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontSize: 11,
              fontFamily: "Consolas, 'Courier New', monospace",
              background: 'var(--color-bg-input, #0e0e0e)',
              border: '1px solid var(--color-border-subtle, rgba(255,255,255,0.06))',
              borderRadius: 5,
              padding: '10px 12px',
              maxHeight: 180,
              overflow: 'auto',
              marginBottom: 14,
            }}
          >
            {String(this.state.error?.stack || this.state.error)}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              height: 32,
              padding: '0 16px',
              borderRadius: 5,
              border: 'none',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600,
              background: 'var(--color-accent-solid, #42a5f5)',
              color: 'var(--color-accent-ink, #1c1c1c)',
            }}
          >
            Reload interface
          </button>
        </div>
      </div>
    );
  }
}
