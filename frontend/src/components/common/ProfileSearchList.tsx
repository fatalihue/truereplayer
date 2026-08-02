import { useMemo, useRef, useState, useEffect, useLayoutEffect, useId, type ReactNode } from 'react';
import { Search, SearchX, X } from 'lucide-react';
import { useTt } from '../../state/LanguageContext';

export interface ProfileSearchListProps {
  /** Candidate profile names, already filtered for eligibility by the caller. */
  profiles: string[];
  /** Currently selected name; highlighted and scrolled into view. null = nothing picked. */
  value: string | null;
  onChange: (name: string) => void;
  /** Focus the search field on mount (both current call sites want this). */
  autoFocus?: boolean;
  /** Esc inside the search field. Omit to let Esc bubble (dialogs close on it). */
  onCancel?: () => void;
  placeholder?: string;
  /** Tailwind max-height for the scroll area. Keeps the host layout predictable. */
  listMaxHeightClass?: string;
  /** Optional trailing content per row (badges, counts). */
  renderMeta?: (name: string) => ReactNode;
  ariaLabel?: string;
}

/**
 * Search-and-pick list for profiles — the single-select sibling of the ProfilePanel /
 * Export-dialog search: one text field on top that filters a plain list underneath, so the
 * user types and the whole list narrows at once.
 *
 * Replaces the native `<select>` pickers in Run Profile and Automation. A `<select>` is fine
 * for five options and useless for eighty: the OS popup has no filter, so finding a profile
 * meant scrolling a wall of names (this repo's owner has ~80). Matching is the same rule the
 * export dialog uses — case-insensitive substring on the name.
 *
 * Keyboard: ↑/↓ move the highlight, Enter picks it, Esc calls onCancel. Enter only swallows
 * the event when it actually CHANGES the selection; when the highlighted row is already the
 * current value, Enter bubbles so a host dialog's "Enter confirms" still fires on the first
 * press. That gives "type → Enter (pick) → Enter (confirm)" and keeps the untouched-dialog
 * case at a single Enter, exactly as the old `<select>` behaved.
 */
export function ProfileSearchList({
  profiles,
  value,
  onChange,
  autoFocus = false,
  onCancel,
  placeholder,
  listMaxHeightClass = 'max-h-[190px]',
  renderMeta,
  ariaLabel,
}: ProfileSearchListProps) {
  const tt = useTt();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Row ids so aria-activedescendant can point at the highlighted row — with the rows taken
  // out of the tab order (tabIndex -1 below) this is the only way a screen reader learns
  // which one the arrow keys are on.
  const baseId = useId();
  const rowId = (i: number) => `${baseId}-opt-${i}`;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return profiles;
    return profiles.filter(n => n.toLowerCase().includes(q));
  }, [profiles, query]);

  // The highlight is stored as a NAME, not an index, and resolved to an index on each render.
  //
  // An index in state plus a "re-sync it from `filtered`" effect looks simpler and is a trap:
  // `filtered` is a fresh array whenever the `profiles` prop is (RunProfileDialog maps a new
  // array every render; AutomationPanel's list is rebuilt by its 2 s automation:request poll),
  // so the effect re-ran on unrelated re-renders and snapped the highlight back to the top —
  // the user arrowed to row 30, waited one poll tick, pressed Enter, and got row 0. Deriving
  // the index instead means only a real change (new query, new selection, arrow key, hover)
  // can move it. Falls back to the selected row, then to the first, so typing a query and
  // hitting Enter picks the top match.
  const [highlightName, setHighlightName] = useState<string | null>(null);
  const highlight = useMemo(() => {
    if (highlightName) {
      const i = filtered.indexOf(highlightName);
      if (i >= 0) return i;   // still visible under the current filter — keep it
    }
    if (value) {
      const i = filtered.indexOf(value);
      if (i >= 0) return i;
    }
    return 0;
  }, [filtered, highlightName, value]);

  // Deferred by a frame ON PURPOSE. DialogShell focuses its card in its own mount effect, and
  // effects run deepest-child-first — so a synchronous focus() here (this component is a
  // DESCENDANT of the shell) is immediately clobbered by the card, leaving the user to click or
  // Tab into the search field. Same requestAnimationFrame trick the Profiles panel already uses
  // for its search box. Verified live: without it, document.activeElement was the dialog card.
  useEffect(() => {
    if (!autoFocus) return;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [autoFocus]);

  // Height lock — the list box keeps whatever height the UNFILTERED list gave it, so
  // typing narrows the rows without the host dialog resizing under the cursor (Run
  // Profile jumped from a 190px box to a 2-row one on the first keystroke, moving its
  // own footer buttons). Measured, not computed: the box is already capped by
  // listMaxHeightClass, so its own border-box height IS min(natural, max) — no row-height
  // constant to keep in sync, and it re-measures if the theme changes the row metrics.
  //
  // Pinned with `height`, NOT `min-height`: min-height only stops the box SHRINKING. The
  // "no profile matches" empty state is taller than a 2-3 row list, so a short list still
  // grew ~4.5px the moment a query stopped matching — a visible nudge of the whole dialog,
  // which is centred by the scrim. An exact height is immune in both directions.
  const [lockedHeight, setLockedHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    // Only the unfiltered list is a valid measurement; while a query is active the last
    // lock is what holds the box open. profiles is a dep because AutomationPanel rebuilds
    // its list on a 2 s poll — a profile added/removed there should re-lock.
    if (query) return;
    const el = listRef.current;
    if (!el) return;
    // Drop the pin before reading, or the measurement is just last render's pinned value
    // and the box could never GROW when profiles arrive (the picker mounts before the
    // bridge has pushed the list — it would stay locked at the empty state's height).
    // Same layout pass, restored before paint, so nothing flickers.
    const pinned = el.style.height;
    el.style.height = '';
    const natural = Math.ceil(el.getBoundingClientRect().height);
    el.style.height = pinned;
    setLockedHeight(natural);
  }, [query, profiles]);

  // Keep the highlighted row visible for both keyboard walking and the initial
  // "reopened on a profile that sits far down the list" case.
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-idx="${highlight}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      if (filtered.length === 0) return;
      const next = (highlight + (e.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length;
      setHighlightName(filtered[next]);   // wraps, like the native select did
      return;
    }
    if (e.key === 'Enter') {
      const pick = filtered[highlight];
      // No change to make (empty list, or the highlight already IS the value) → let the
      // host dialog's Enter handler run. See the component doc.
      if (!pick || pick === value) return;
      e.preventDefault();
      e.stopPropagation();
      onChange(pick);
      return;
    }
    if (e.key === 'Escape' && onCancel) {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };

  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      {/* Search field — same chrome as the ProfilePanel / export search boxes. */}
      <div className="flex items-center gap-2 px-2.5 h-8 bg-bg-input border border-border-default rounded focus-within:border-accent-solid transition-colors">
        <Search size={13} className="text-text-disabled shrink-0" />
        <input
          ref={inputRef}
          type="text"
          aria-label={ariaLabel ?? tt('Search profiles', 'Pesquisar profiles')}
          role="combobox"
          aria-expanded
          aria-controls={`${baseId}-list`}
          aria-activedescendant={filtered.length > 0 ? rowId(highlight) : undefined}
          placeholder={placeholder ?? tt('Search profiles...', 'Pesquisar profiles...')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          className="bg-transparent text-xs text-text-primary placeholder:text-text-disabled outline-none flex-1 min-w-0"
        />
        {query && (
          <button
            type="button"
            onClick={() => { setQuery(''); inputRef.current?.focus(); }}
            aria-label={tt('Clear search', 'Limpar pesquisa')}
            className="text-text-disabled hover:text-text-secondary transition-colors shrink-0"
          >
            <X size={12} />
          </button>
        )}
      </div>

      <div
        ref={listRef}
        id={`${baseId}-list`}
        role="listbox"
        aria-label={ariaLabel ?? tt('Profiles', 'Profiles')}
        className={`${listMaxHeightClass} overflow-y-auto border border-border-subtle rounded bg-bg-input/40`}
        // scrollbarGutter reserves the scrollbar's track even when the list doesn't
        // overflow, so filtering a long list down to two rows no longer shifts every row
        // sideways by the scrollbar's width as it disappears.
        style={{ height: lockedHeight ?? undefined, scrollbarGutter: 'stable' }}
      >
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 py-6 text-text-disabled">
            <SearchX size={18} />
            <span className="text-[11px]">
              {profiles.length === 0
                ? tt('No profiles available', 'Nenhum profile disponível')
                : tt('No profile matches', 'Nenhum profile corresponde')}
            </span>
          </div>
        ) : (
          filtered.map((name, i) => {
            const isSelected = name === value;
            const isHighlighted = i === highlight;
            return (
              <button
                key={name}
                id={rowId(i)}
                type="button"
                role="option"
                aria-selected={isSelected}
                data-idx={i}
                // Roving focus: the search input is the ONE tab stop. Without tabIndex -1 the
                // dialog's focus trap made every profile a Tab stop (81 presses to reach the
                // footer), and Enter on a Tab-focused row bubbled to the host dialog's
                // "Enter confirms" handler, which preventDefault()s the button's own click —
                // confirming the PREVIOUS value instead of the focused one.
                tabIndex={-1}
                // Highlight follows the pointer too, so a click never picks a different
                // row than the one Enter would have.
                onMouseEnter={() => setHighlightName(name)}
                onClick={() => onChange(name)}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left transition-colors ${
                  isSelected
                    ? 'text-accent bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]'
                    : isHighlighted
                      ? 'text-text-primary bg-bg-elevated'
                      : 'text-text-secondary hover:bg-bg-elevated'
                }`}
              >
                <span className="text-xs truncate flex-1 min-w-0">{name}</span>
                {renderMeta?.(name)}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
