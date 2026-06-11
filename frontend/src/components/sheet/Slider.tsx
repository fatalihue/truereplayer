import { NumberInput } from '../common/NumberInput';

// Range + numeric input combo for bounded values (tolerance, confidence).
// The track/thumb styling lives in index.css (.sheet-slider) using theme vars;
// the paired NumberInput gives precise entry plus +/− nudging. Replaces the
// raw <input type="range"> + bare <input> pairs that each section hand-rolled
// with slightly different layouts.
export function Slider({ value, min, max, step = 1, onChange, suffix, disabled = false }: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (n: number) => void;
  suffix?: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="sheet-slider flex-1 min-w-0"
      />
      <NumberInput
        value={value}
        onChange={onChange}
        min={min}
        max={max}
        step={step}
        suffix={suffix}
        disabled={disabled}
      />
    </div>
  );
}
