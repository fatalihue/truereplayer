import type { ReactNode, KeyboardEvent } from 'react';

interface RadioProps {
  selected: boolean;
  onSelect: () => void;
  label: string;
  title?: string;
  /**
   * Optional right-side content (e.g., dropdown that's only meaningful when this
   * radio is selected). Clicks on children don't trigger row selection so the
   * user can interact with the control without re-toggling.
   */
  children?: ReactNode;
}

/**
 * Themed radio row. One option in a radio group. Designed for use inside a
 * Section as a list of mutually-exclusive choices.
 *
 * Visual:
 *   - Unselected: hollow circle, secondary text
 *   - Selected:   filled accent dot, primary text, subtle accent-tinted bg
 *   - Hover (unselected): elevated bg + border darkens
 */
export function Radio({ selected, onSelect, label, title, children }: RadioProps) {
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      onSelect();
    }
  };

  return (
    <div
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      title={title}
      className="w-full flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors group hover:bg-bg-elevated"
    >
      <span
        className={`w-3.5 h-3.5 rounded-full border-[1.5px] flex items-center justify-center transition-colors shrink-0 ${
          selected
            ? 'border-accent-solid'
            : 'border-border-default group-hover:border-text-tertiary'
        }`}
      >
        {selected && <span className="w-1.5 h-1.5 rounded-full bg-accent-solid" />}
      </span>
      <span className="text-ui flex-1 text-left text-text-secondary">
        {label}
      </span>
      {children && (
        <div onClick={(e) => e.stopPropagation()}>{children}</div>
      )}
    </div>
  );
}
