import { useLanguage } from '../../state/LanguageContext';
import { formatMs } from '../../utils/displayUtils';

/**
 * One-click millisecond preset chips — unifies the two recipes that had
 * drifted apart between the Keystroke hold presets (heavy accent fill) and the
 * Pause timeout presets (quiet accent mix). The quiet recipe won. A 0 value
 * renders as '∞' (no timeout) and may carry its own data-tip.
 */
interface DurationChipsProps {
  presets: readonly number[];
  value: number;
  /** Keystroke MUST pass its two-track setHoldMs so preset-click-then-instant-Add
   *  commits the fresh value (state+ref written together). */
  onSelect: (ms: number) => void;
  /** data-tip for the ∞ (0 ms) chip. */
  infinityTip?: string;
}

export function DurationChips({ presets, value, onSelect, infinityTip }: DurationChipsProps) {
  const { language } = useLanguage();
  return (
    <div className="flex flex-wrap gap-1.5">
      {presets.map((ms) => {
        const active = value === ms;
        return (
          <button
            key={ms}
            type="button"
            onClick={() => onSelect(ms)}
            data-tip={ms === 0 ? infinityTip : undefined}
            className={`px-2 py-0.5 rounded text-[10px] font-mono tabular-nums border transition-colors ${
              active
                ? 'text-accent border-accent/30 bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]'
                : 'text-text-tertiary border-border-subtle bg-bg-card hover:text-text-secondary hover:bg-bg-input'
            }`}
          >
            {ms === 0 ? '∞' : `${formatMs(ms, language)} ms`}
          </button>
        );
      })}
    </div>
  );
}
