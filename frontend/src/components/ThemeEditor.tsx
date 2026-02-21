import { useEffect, useRef } from 'react';
import { X, Check } from 'lucide-react';
import { themes } from '../themes';
import { useTheme } from '../state/ThemeContext';

interface ThemeEditorProps {
  onClose: () => void;
}

export function ThemeEditor({ onClose }: ThemeEditorProps) {
  const { activeThemeId, setTheme } = useTheme();
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Close on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay to avoid closing immediately from the button click that opened it
    const timer = setTimeout(() => {
      window.addEventListener('mousedown', handleClick);
    }, 50);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('mousedown', handleClick);
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        ref={panelRef}
        className="w-[460px] bg-bg-surface border border-border-default rounded-lg shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border-subtle">
          <span className="text-sm font-semibold text-text-primary">Theme Editor</span>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Theme Grid */}
        <div className="p-4 grid grid-cols-4 gap-3 max-h-[360px] overflow-y-auto">
          {themes.map((theme) => {
            const isActive = theme.id === activeThemeId;
            return (
              <button
                key={theme.id}
                onClick={() => setTheme(theme.id)}
                className={`group flex flex-col rounded-lg overflow-hidden border transition-all cursor-pointer ${
                  isActive
                    ? 'border-accent ring-1 ring-accent/30'
                    : 'border-border-subtle hover:border-border-strong'
                }`}
              >
                {/* Color preview strip */}
                <div className="flex h-12">
                  {theme.preview.map((color, i) => (
                    <div
                      key={i}
                      className="flex-1"
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>

                {/* Name + checkmark */}
                <div
                  className="flex items-center justify-between px-2.5 py-2"
                  style={{ backgroundColor: theme.colors['bg-card'] }}
                >
                  <span
                    className="text-xs font-medium truncate"
                    style={{ color: theme.colors['text-secondary'] }}
                  >
                    {theme.name}
                  </span>
                  {isActive && (
                    <Check size={12} style={{ color: theme.colors.accent }} />
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
