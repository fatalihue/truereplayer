import { Minus, Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLanguage } from '../../state/LanguageContext';
import { formatMs } from '../../utils/displayUtils';

export interface NumberInputProps {
  // `null` = unset / blank — renders empty with placeholder visible. Used by call sites
  // where empty has a distinct meaning from a numeric value (e.g. typeDelay '' = "auto",
  // X/Y '' = "no override"). When the parent stores a real number, just pass that.
  value: number | null;
  onChange: (n: number) => void;
  // Optional callback when the user clears a previously-set field (blur with empty text).
  // Lets the parent restore the "unset" sentinel that bare onChange can't express.
  onClear?: () => void;
  min?: number;
  max?: number;
  step?: number;                      // increment per +/− click (default 1)
  suffix?: string;                    // unit shown after the input (e.g. "ms", "s", "%")
  inputWidth?: string;                // tailwind width class for the input only (defaults w-14)
  inputHeight?: string;               // tailwind height for input + buttons (defaults h-8 — the
                                      // app-wide 32px control standard; pass smaller only for
                                      // genuinely compact surfaces like inline popovers)
  className?: string;                 // outer wrapper class
  disabled?: boolean;
  placeholder?: string;
  // Optional id for label-for association (a11y).
  id?: string;
  // Optional aria-label when no visible label exists nearby.
  ariaLabel?: string;
  // Show the value with locale thousands separators (10000 → "10.000" pt-BR /
  // "10,000" en) while NOT focused; on focus it swaps to the raw digits so typing
  // stays simple. Forces type=text + inputMode=numeric so the separator can render
  // (type=number can't). Use for large ms/duration fields.
  thousands?: boolean;
  // Optional onBlur — some call sites need to react to commit (e.g. validate then re-clamp).
  onBlur?: () => void;
  // Auto-focus on mount — useful inside modal dialogs where React's plain `autoFocus`
  // attribute is unreliable across portals. Forwards to the inner <input>; ignored on
  // re-renders, only the first mount focuses (so toggling it back to false won't blur).
  autoFocus?: boolean;
}

// Always-visible [−] [input] [+] number control. Replaces the platform's tiny hover-only
// spinner with consistent, theme-able click targets. Wheel-to-adjust works when the input
// has focus; native ↑/↓ arrow keys also keep working (they fire as if the user pressed +/−).
//
// `value` is a `number`; if the parent stores numbers as strings (rare in this codebase),
// it should parse before passing in and stringify on the way back. Keeping the API number-
// typed avoids the "what does '' mean" ambiguity that plagues string-backed numeric inputs.
export function NumberInput({
  value,
  onChange,
  onClear,
  min,
  max,
  step = 1,
  suffix,
  inputWidth = 'w-14',
  inputHeight = 'h-8',
  className = '',
  disabled = false,
  placeholder,
  id,
  ariaLabel,
  onBlur,
  autoFocus = false,
  thousands = false,
}: NumberInputProps) {
  const { language } = useLanguage();
  // Raw digits are shown while editing; the thousands-formatted value only while blurred.
  const [isFocused, setIsFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Mount-only focus. React's `autoFocus` attribute is honoured by the JSX runtime via a
  // node.focus() call after mount, but portal/modal mounting in WebView2 has occasionally
  // raced with that — an explicit ref + useEffect is reliable. Selecting the text (instead
  // of just placing the caret) lets the user immediately overwrite the pre-filled default.
  useEffect(() => {
    if (!autoFocus) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
    // empty deps — fire exactly once after first paint. Toggling autoFocus later won't
    // re-focus (matches the native HTML autofocus contract).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Local string state so the user can type freely (clear the field, type a partial
  // value like "" or "1" while heading toward "12") without the parent thrashing. Null
  // value → empty text so the placeholder shows; user has to type or click + to set.
  const [text, setText] = useState(() => value == null ? '' : String(value));
  const lastPropValueRef = useRef<number | null>(value);
  useEffect(() => {
    // Sync when the parent updates value externally (e.g. +/− click or reset). Skip
    // when the change came from our own onChange to avoid clobbering an in-progress
    // edit ("12" → parent normalises to "12" → would overwrite "120" as user types).
    if (value !== lastPropValueRef.current) {
      lastPropValueRef.current = value;
      setText(value == null ? '' : String(value));
    }
  }, [value]);

  const clamp = useCallback((n: number) => {
    if (min !== undefined && n < min) return min;
    if (max !== undefined && n > max) return max;
    return n;
  }, [min, max]);

  const commit = useCallback((n: number) => {
    const clamped = clamp(n);
    lastPropValueRef.current = clamped;
    setText(String(clamped));
    onChange(clamped);
  }, [clamp, onChange]);

  const handleTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // In thousands mode the input is type=text, so a pasted "10.000" could arrive with
    // separators — keep only digits (and a leading '-') so parsing stays correct.
    const raw = thousands ? e.target.value.replace(/[^\d-]/g, '') : e.target.value;
    setText(raw);
    // Parse + commit when the user has typed something parseable. Empty / partial like
    // "-" / "." stay in local state and don't fire onChange until they become a number.
    if (raw === '' || raw === '-') return;
    const n = Number(raw);
    if (Number.isFinite(n)) {
      const clamped = clamp(n);
      lastPropValueRef.current = clamped;
      onChange(clamped);
    }
  };

  const handleBlur = () => {
    setIsFocused(false);
    // Clear path — empty/invalid text. When the parent supports onClear AND had a value
    // before, fire it (parent restores its null/unset sentinel). Otherwise snap back to
    // last good number.
    const n = Number(text);
    if (text === '' || !Number.isFinite(n)) {
      if (onClear && value != null) {
        lastPropValueRef.current = null;
        onClear();
      } else if (value != null) {
        commit(value);
      } else {
        setText('');
      }
    } else {
      const clamped = clamp(n);
      if (clamped !== n || String(clamped) !== text) commit(clamped);
    }
    onBlur?.();
  };

  const handleWheel = (e: React.WheelEvent<HTMLInputElement>) => {
    // Only react when the input has focus — otherwise scrolling over the panel would
    // accidentally bump numbers. preventDefault keeps the page from also scrolling.
    if (document.activeElement !== e.currentTarget) return;
    e.preventDefault();
    const base = value ?? (min ?? 0);
    commit(base + (e.deltaY > 0 ? -step : step));
  };

  // − and + treat null as `min ?? 0`. + then adds step (so first click on a blank
  // field sets it to step, intuitive); − is disabled (can't go below "unset").
  const canDec = value != null && (min === undefined || value > min);
  const canInc = max === undefined || value == null || value < max;

  return (
    <span className={`inline-flex items-stretch gap-0 ${className}`}>
      <button
        type="button"
        onClick={() => { if (value != null) commit(value - step); }}
        disabled={disabled || !canDec}
        aria-label="Decrease"
        className={`${inputHeight} w-6 flex items-center justify-center text-text-secondary bg-bg-input border border-border-default border-r-0 rounded-l hover:bg-bg-elevated hover:text-text-primary active:bg-bg-card disabled:opacity-40 disabled:cursor-not-allowed transition-colors`}
      >
        <Minus size={12} />
      </button>
      <input
        ref={inputRef}
        id={id}
        // type=text (not number) in thousands mode so the separator renders; inputMode
        // keeps the numeric keypad on touch and the caret/wheel behaviour otherwise.
        type={thousands ? 'text' : 'number'}
        inputMode={thousands ? 'numeric' : undefined}
        value={thousands && !isFocused && text !== '' && Number.isFinite(Number(text)) ? formatMs(Number(text), language) : text}
        onChange={handleTextChange}
        onFocus={() => setIsFocused(true)}
        onBlur={handleBlur}
        // Enter commits + reformats the field (blur runs the clamp/format path). Not
        // stopped, so a dialog's own Enter-to-submit still fires afterwards.
        onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }}
        onWheel={handleWheel}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className={`${inputWidth} ${inputHeight} px-1 text-center text-xs font-mono text-text-primary bg-bg-input border border-border-default outline-none focus:border-accent-solid focus:z-10 tabular-nums disabled:opacity-50`}
      />
      <button
        type="button"
        onClick={() => commit((value ?? (min ?? 0)) + step)}
        disabled={disabled || !canInc}
        aria-label="Increase"
        className={`${inputHeight} w-6 flex items-center justify-center text-text-secondary bg-bg-input border border-border-default border-l-0 rounded-r hover:bg-bg-elevated hover:text-text-primary active:bg-bg-card disabled:opacity-40 disabled:cursor-not-allowed transition-colors`}
      >
        <Plus size={12} />
      </button>
      {suffix && <span className="text-[11px] text-text-disabled self-center ml-1.5">{suffix}</span>}
    </span>
  );
}
