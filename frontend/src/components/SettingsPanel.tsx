import { useState, useEffect, useRef, useCallback, useContext, createContext } from 'react';
import { Timer, TimerReset, Mic, Zap, Monitor, ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, MousePointerClick, Palette, Gamepad2, AlertTriangle, Power, BellRing, X, ArrowLeftRight } from 'lucide-react';
import { APP_VERSION } from '../appVersion';
import { RemapSection } from './RemapSection';
import { useLanguage, useTt } from '../state/LanguageContext';
// `Search` import removed with the disabled Settings filter — re-add it to revive the filter.
import { useAppState } from '../state/AppStateContext';
import { useBridge } from '../bridge/BridgeContext';
import { useSelectionRef } from '../state/SelectionContext';
import { Toggle } from './common/Toggle';
import { SegmentedControl } from './common/SegmentedControl';
import { formatMs } from '../utils/displayUtils';

// Compact 28×16 switch — the redesigned Settings panel uses the smaller size for every
// on/off control; other surfaces (dialogs) keep the default 40×20 Toggle.
function CompactToggle(props: { isOn: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <Toggle {...props} size="sm" />;
}

// ONE width for EVERY right-aligned settings field — hotkeys, value chips, combos — across
// all tabs and both modes (the 2026-07 "Option B" reorg's single 100px column). It fits a
// thousands-separated "10.000 ms" chip, and the widest hotkey default ("Ctrl+PageDown",
// ~86px at 12px Consolas) ONLY because HotkeyInput uses px-1.5 padding (88px content box —
// see the comment there); together with the reserved scrollbar gutter no row label wraps.
const FIELD_W = 'w-[100px]';

// Upper bounds for the timing / scatter fields — typing past these snaps back to the cap on
// commit (blur/Enter). A typo-guard (stops an accidental extra zero making a macro appear to
// hang), NOT a hard behavioural limit: 60 s covers any reasonable inter-action or loop pause —
// longer waits belong in a Pause action — and ±500 px scatters across a large control while the
// Area tool handles bigger regions. Loops (999) and Jitter (100) keep their own inline caps.
const MAX_DELAY_MS = 60000;
const MAX_POSITION_PX = 500;

// Auto-focus knobs — both OFF by request (2026-07-19): the panel never changes tab on its
// own, so whichever tab the user left open stays open. The logic is kept intact behind
// these flags; flip one back to `true` to restore that behaviour.
//   • ON_MODE_SWITCH — a macro↔clicker toggle jumped to Profile (each mode's settings live
//     there, so staying on Keys/App hid them).
//   • ON_RUN_START — a run starting jumped to Profile so the running context was on screen.
// Typed `boolean` (not the inferred `false` literal) so the guarded branches don't read as
// dead code to the compiler/editor while the flags are off.
const FOCUS_PROFILE_ON_MODE_SWITCH: boolean = false;
const FOCUS_PROFILE_ON_RUN_START: boolean = false;

// Live "Filter settings" query (lowercased). SettingRow reads it and hides itself when its
// label doesn't match, so the search needs no prop-drilling through every row.
const FilterContext = createContext('');

// Quiet section header: monochrome label-micro title + hairline rule. The 2026-07
// "Option B" reorg killed the per-group colored dots (12 hues carrying no information)
// and the collapse chevrons — every section is always open; the only hue that survives
// is semantic, passed via `color` (the Clicker purple mode cue). data-section still
// drives the collapsed rail's expand-and-scroll targeting.
function Section({ title, color, children }: {
  title: string;
  // Optional title tint for sections whose hue IS information (Clicker purple).
  color?: string;
  children: React.ReactNode;
}) {
  return (
    <div data-section={title}>
      <div className="flex items-center gap-2 px-1.5 pt-3 pb-0.5">
        <span className="label-micro text-text-tertiary" style={color ? { color } : undefined}>{title}</span>
        <span className="flex-1 h-px bg-border-subtle" />
      </div>
      <div>{children}</div>
    </div>
  );
}

// Merged value+enable control: one chip carrying the number, its unit and an enable dot —
// replaces the old "field + separate switch" pair so a setting reads as a single unit. Same
// FIELD_W as the plain value fields so the column stays aligned. The dot toggles enable;
// editing the number commits on blur/Enter (Enter also runs onEnterActivate — e.g. flip the
// setting on when the user types a value into a disabled chip).
function EnableChip({ value, isOn, unit, format, max, width, onCommitValue, onToggle, onEnterActivate }: {
  value: string;
  isOn: boolean;
  unit?: string;
  format?: boolean;
  // Upper bound applied on commit (Loops 999, Jitter 100): typing a larger number
  // snaps back to max on blur/Enter.
  max?: number;
  // Field width. Defaults to FIELD_W — the panel-wide single column.
  width?: string;
  onCommitValue: (v: string) => void;
  onToggle: (v: boolean) => void;
  onEnterActivate?: (v: string) => void;
}) {
  const { language } = useLanguage();
  const [local, setLocal] = useState(value);
  const [isFocused, setIsFocused] = useState(false);
  useEffect(() => { if (!isFocused) setLocal(value); }, [value, isFocused]);
  const display = !isFocused && format && local !== '' && Number.isFinite(Number(local))
    ? formatMs(Number(local), language) : local;
  const commit = () => {
    let v = local;
    if (max != null && local !== '') {
      const n = parseInt(local, 10);
      if (!isNaN(n) && n > max) { v = String(max); setLocal(v); }
    }
    onCommitValue(v);
    return v;
  };
  return (
    <div
      className={`${width ?? FIELD_W} h-7 flex items-center rounded border overflow-hidden focus-within:!border-accent-solid`}
      style={isOn
        ? { borderColor: 'var(--color-accent-solid)', background: 'color-mix(in srgb, var(--color-accent) 13%, transparent)' }
        : { borderColor: 'var(--color-border-default)', background: 'var(--color-bg-input)' }}
    >
      <button
        type="button"
        onClick={() => onToggle(!isOn)}
        aria-label={isOn ? 'Disable' : 'Enable'}
        className="h-full pl-2 pr-1.5 flex items-center shrink-0 cursor-pointer transition-colors hover:bg-[rgba(127,127,127,0.18)]"
      >
        <span
          className="w-2 h-2 rounded-full block shrink-0"
          style={isOn
            ? { background: 'var(--color-accent-solid)' }
            : { background: 'transparent', border: '1.5px solid var(--color-text-tertiary)' }}
        />
      </button>
      <input
        type="text"
        inputMode="numeric"
        value={display}
        onChange={(e) => setLocal(format ? e.target.value.replace(/[^\d-]/g, '') : e.target.value)}
        onFocus={() => setIsFocused(true)}
        onBlur={() => { setIsFocused(false); commit(); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { const v = commit(); onEnterActivate?.(v); (e.target as HTMLInputElement).blur(); }
        }}
        className={`flex-1 min-w-0 bg-transparent outline-none text-ui font-mono text-right ${isOn ? 'text-text-primary' : 'text-text-tertiary'}`}
      />
      {unit
        ? <span className="text-[10px] shrink-0 text-text-tertiary pl-1 pr-2">{unit}</span>
        : <span className="pr-2" />}
    </div>
  );
}

// Plain value field — same box/size as EnableChip but with no enable dot (always applies),
// for numbers that have no on/off (the Game-mode tuning knobs). Unit sits inside so it lines
// up with the chips above it.
function ValueField({ value, unit, onCommitValue }: {
  value: string;
  unit?: string;
  onCommitValue: (v: string) => void;
}) {
  const [local, setLocal] = useState(value);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setLocal(value); }, [value]);
  return (
    <div className={`${FIELD_W} h-7 flex items-center gap-1.5 px-2 rounded border border-border-default bg-bg-input focus-within:border-accent-solid`}>
      <input
        type="text"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onFocus={() => { focused.current = true; }}
        onBlur={() => { focused.current = false; onCommitValue(local); }}
        onKeyDown={(e) => { if (e.key === 'Enter') { onCommitValue(local); (e.target as HTMLInputElement).blur(); } }}
        className="flex-1 min-w-0 bg-transparent outline-none text-ui font-mono text-right text-text-primary"
      />
      {/* tertiary, not disabled — the unit is real information (audit: text-disabled
          was doing double duty for informative content at ~2:1). */}
      {unit && <span className="text-[10px] shrink-0 text-text-tertiary">{unit}</span>}
    </div>
  );
}

// Inline disclosure for a handful of secondary rows (e.g. the Game-mode tuning knobs) so the
// numbers users rarely touch don't clutter the group. One small caret toggle, no card.
function Disclosure({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(o => !o)} className="group w-full flex items-center gap-1 px-2.5 py-1 text-[11px] text-accent-solid hover:underline transition-colors">
        <ChevronRight size={12} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
        {label}
      </button>
      {open && <div>{children}</div>}
    </>
  );
}

function SettingRow({ label, tooltip, children, danger }: { label: string; tooltip?: string; children: React.ReactNode; danger?: boolean }) {
  // `danger` paints the row in a loud red so a disabled-but-critical toggle
  // (e.g. Profile Keys OFF) is impossible to miss when glancing at the panel.
  const filter = useContext(FilterContext);
  // Hide when the "Filter settings" query doesn't match this row's label.
  if (filter && !label.toLowerCase().includes(filter)) return null;
  // Tooltip via the global TooltipLayer (data-tip) — pos="left" so it opens into the work area
  // (the panel hugs the right window edge) instead of clipping off-screen.
  return (
    <div
      // Compact-but-not-cramped rhythm: h-7 (28px) controls + py-[3px] → ~34px input
      // rows with a visible gap between consecutive bordered fields; toggle rows sit at
      // the min-h-8 floor (32px). Between the original 36px (too tall) and the 32px
      // first pass (too tight) — eased a touch at the user's request.
      className="relative flex items-center justify-between min-h-8 px-2.5 py-[3px] gap-2"
      data-tip={tooltip || undefined}
      data-tip-pos="left"
    >
      {/* Danger = thin red left accent + red icon/label (replaces the old full-row red wash). */}
      {danger && <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 rounded-sm bg-recording" />}
      <span className={`text-ui flex items-center gap-1.5 min-w-0 ${danger ? 'text-recording' : 'text-text-secondary'}`}>
        {danger && <AlertTriangle size={12} className="shrink-0" />}
        {label}
      </span>
      <div className="flex items-center gap-2.5 shrink-0">
        {children}
      </div>
    </div>
  );
}

// Field + a dropdown of options (a combobox). Two modes share one visual identity so the
// Clicker rows look uniform:
//   • editable (Rate): type freely, or click the chevron to pick a preset.
//   • picker   (Button): read-only — click the field or chevron to choose one of the options.
// The input uses the SAME px-2 text-center font-mono box as SettingInput so the value is
// centered identically across every row; the chevron floats over the right padding.
// The menu uses plain absolute positioning (NOT a fixed portal): the page renders at a ~0.95
// UI zoom, which double-scales fixed coords, and absolute shares the field's coordinate space
// so it lands exactly under the input. These rows sit near the top of their group, so the
// short menu stays within the inset and isn't clipped. Closes on outside-click / Escape.
function ComboInput({ value, onCommit, options, width = FIELD_W, editable = true }: {
  value: string;
  onCommit: (v: string) => void;
  options: { value: string; label: string }[];
  width?: string;
  editable?: boolean;
}) {
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const focused = useRef(false);

  // Sync the external value in when not actively editing (matches SettingInput).
  useEffect(() => { if (!focused.current) setText(value); }, [value]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Picker mode shows the selected option's label; editable mode shows the live text.
  const shownValue = editable ? text : (options.find((o) => o.value === value)?.label ?? value);

  return (
    <div ref={wrapRef} className={`relative ${width}`}>
      <input
        type="text"
        value={shownValue}
        readOnly={!editable}
        onChange={editable ? (e) => setText(e.target.value) : undefined}
        onFocus={editable ? () => { focused.current = true; } : undefined}
        // After committing, snap the visible text back to the canonical `value`. When the commit
        // is REJECTED (empty / non-numeric / <=0 — commitRate returns without changing anything),
        // the parent doesn't change `value` and the keyed remount never fires, so without this the
        // field would keep showing the bad text. When the commit is ACCEPTED the parent remounts
        // via its key anyway, making this a harmless no-op. (Enter calls blur(), so it's covered too.)
        onBlur={editable ? () => { focused.current = false; onCommit(text); setText(value); } : undefined}
        onKeyDown={editable ? (e) => { if (e.key === 'Enter') { onCommit(text); (e.target as HTMLInputElement).blur(); } } : undefined}
        onClick={editable ? undefined : () => setOpen((o) => !o)}
        className={`w-full h-7 px-2 text-ui font-mono text-text-primary bg-bg-input border border-border-default rounded text-center outline-none focus:border-accent-solid ${editable ? '' : 'cursor-pointer'}`}
      />
      <button
        type="button"
        tabIndex={-1}
        // Keep the input's focus on chevron click so it doesn't blur-commit before opening.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        // Pinned to the right edge (justify-end) and slightly smaller so the longest centered
        // value (e.g. "Middle") clears it — the text stays centered in the full field.
        className="absolute right-0 top-0 h-7 w-6 flex items-center justify-end pr-1 text-text-tertiary hover:text-text-secondary"
        aria-label={editable ? 'Choose a preset' : 'Choose an option'}
      >
        <ChevronDown size={11} />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 w-full bg-bg-card border border-border-default rounded-md shadow-lg py-1">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setText(o.value); onCommit(o.value); setOpen(false); }}
              className="w-full px-2 py-1 text-center text-[11px] font-mono text-text-secondary hover:bg-bg-elevated hover:text-text-primary transition-colors"
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Clicker v2 — dedicated section that replaces Execution + Recording in the Profile tab
// when useCursorClick is on. Reads/writes the cursorClick* fields directly via settings:change,
// so it's fully decoupled from the active profile's Delay/Jitter/Loop settings. Visual
// identity: the purple section title so the user immediately sees "I'm configuring
// Clicker, not the macro profile".
function ClickerSection({
  button, rate, rateJitter, useRateJitter, positionJitter, usePositionJitter,
  useArea, area, useFixed, fixedPoint,
  loops, useLoops, interval, useInterval, onChange,
}: {
  button: string;
  rate: string;
  rateJitter: string;
  useRateJitter: boolean;
  hold: string;
  positionJitter: string;
  usePositionJitter: boolean;
  useArea: boolean;
  area: { x: number; y: number; w: number; h: number } | null;
  useFixed: boolean;
  fixedPoint: { x: number; y: number } | null;
  loops: string;
  useLoops: boolean;
  interval: string;
  useInterval: boolean;
  onChange: (key: string, value: string | boolean | number | object | null) => void;
}) {
  const { send } = useBridge();
  const tt = useTt();
  // Unit toggle for the Rate row: 'ms' shows the raw delay; '/s' shows clicks per second
  // computed from delay (1000 / ms). Backend always stores ms — the toggle is display-only.
  // Default is 'ms' (more conventional for typical users); reset bounces this back to 'ms'
  // via a React remount triggered by settingsResetEpoch in SettingsPanel.
  const [unit, setUnit] = useState<'ms' | 'cps'>('ms');

  // Optimistic local copy of the current delay (ms). Updated immediately on commit so the
  // Rate input doesn't flicker while waiting for the bridge to echo back the new value via
  // settings:loaded. Synced back from the `rate` prop whenever the prop changes (covers
  // reset, profile load, external settings change). Without this, typing "200" in ms then
  // toggling to /s could briefly show the OLD value (from stale `rate` prop) before the
  // bridge echo arrived — feeling like the typed value got "lost".
  //
  // Lower bound is 1 ms (not 10): user-typed values <10 ms are honoured in the UI even
  // though the replay engine clamps the actual click cadence to 10 ms minimum at runtime
  // for safety. Without this, typing "1" would silently snap to "10" — and if the user
  // typed "1" a SECOND time, the on-screen input would visually show "1" while the stored
  // value was still 10, because identical commits don't trigger a key-driven remount.
  const [localDelayMs, setLocalDelayMs] = useState(() => Math.max(1, parseInt(rate, 10) || 100));
  useEffect(() => {
    setLocalDelayMs(Math.max(1, parseInt(rate, 10) || 100));
  }, [rate]);

  // Strip trailing ".0" so whole-number CPS shows as "1" not "1.0", "5" not "5.0", etc.
  // Non-integer rates (e.g. 6.99/s when delay = 143 ms) keep one decimal: "7.0" → "7"
  // after rounding, "6.5" stays "6.5".
  const cpsFromMs = (ms: number) => (1000 / ms).toFixed(1).replace(/\.0$/, '');
  const displayValue = unit === 'cps' ? cpsFromMs(localDelayMs) : String(localDelayMs);
  const commitRate = (raw: string) => {
    const num = parseFloat(raw);
    if (isNaN(num) || num <= 0) return;
    // Clamp to [1, MAX_DELAY_MS]. In /s mode a tiny cps (e.g. 0.001) maps to a huge delay, so
    // the cap applies to the resulting ms either way — a typo can't leave the clicker idle for
    // minutes. Whole clicks-per-second stay well under the cap (1/s = 1000 ms).
    const ms = Math.min(MAX_DELAY_MS, unit === 'cps'
      ? Math.max(1, Math.round(1000 / num))
      : Math.max(1, Math.round(num)));
    setLocalDelayMs(ms);              // optimistic — keeps the input stable on next render
    onChange('cursorClickDelay', String(ms));
  };

  // Turn a toggle ON if it isn't already — used by row-input onEnter to auto-activate the
  // companion switch when the user types a value (matches the Execution panel's affordance).
  const activateIfOff = (currentlyOn: boolean, settingKey: string) => {
    if (!currentlyOn) onChange(settingKey, true);
  };

  // The three mutually-exclusive "where the click lands" modes. Enabling one turns the
  // other two off; they all write the same axis so only one may be active.
  const CLICK_MODE_KEYS = ['cursorClickUsePositionJitter', 'cursorClickUseArea', 'cursorClickUseFixed'];
  const setClickMode = (key: string, enable: boolean) => {
    onChange(key, enable);
    if (enable) CLICK_MODE_KEYS.forEach((k) => { if (k !== key) onChange(k, false); });
  };

  return (
    // Uses the shared Section so it matches macro mode exactly (header above a single
    // inset group, same row layout). The purple title keeps the "you're in Clicker" cue.
    <Section color="var(--color-clicker)" title="Clicker">
          {/* Flat/chip layout: every settings control is one FIELD_W (100px) box, flush right,
              so chips, combos and the area control all line up — and match the macro Execution
              chips' width across a mode switch. Value+enable rows are a single EnableChip;
              Button/Rate are pickers; Area is chip-shaped (dot + picker). */}
          {/* Mouse button picker — moved here from the ActionBar so the panel is the single
              source of truth for "every Clicker setting". Left/Right/Middle, always applied. */}
          <SettingRow label="Button" tooltip={tt('Mouse button to click', 'Botão do mouse a clicar')}>
            <ComboInput
              editable={false}
              value={button}
              onCommit={(v) => onChange('cursorClickButton', v)}
              options={[
                { value: 'Left', label: 'Left' },
                { value: 'Right', label: 'Right' },
                { value: 'Middle', label: 'Middle' },
              ]}
            />
          </SettingRow>
          <SettingRow label="Rate" tooltip={tt('Click rate: /s or delay (ms). Type or pick a preset.', 'Taxa de clique: /s ou atraso (ms). Digite ou escolha um preset.')}>
            {/* Combo + /s↔ms unit toggle share one FIELD_W slot so the row aligns with the chips. */}
            <div className={`${FIELD_W} flex items-center gap-1`}>
              <ComboInput
                /* Key on (unit, localDelayMs) so it remounts with the right displayValue when
                   either changes — toggling the unit, or picking a preset (commitRate updates
                   localDelayMs optimistically). */
                key={`rate-${unit}-${localDelayMs}`}
                value={displayValue}
                onCommit={commitRate}
                width="flex-1 min-w-0"
                options={unit === 'cps'
                  ? [10, 25, 50, 100, 200].map((c) => ({ value: String(c), label: `${c}/s` }))
                  : [100, 40, 20, 10, 5].map((m) => ({ value: String(m), label: `${m} ms` }))}
              />
              <select
                value={unit}
                onChange={(e) => setUnit(e.target.value as 'ms' | 'cps')}
                className="w-6 h-7 text-center text-[10px] text-text-secondary bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid font-mono cursor-pointer appearance-none shrink-0"
              >
                <option value="cps">/s</option>
                <option value="ms">ms</option>
              </select>
            </div>
          </SettingRow>
          <SettingRow label="Loops" tooltip={tt('Clicks per run. 0 = forever.', 'Cliques por execução. 0 = infinito.')}>
            <EnableChip
              value={loops}
              isOn={useLoops}
              max={999}
              onCommitValue={(v) => onChange('cursorClickLoops', v)}
              onToggle={(v) => onChange('cursorClickUseLoops', v)}
              onEnterActivate={() => activateIfOff(useLoops, 'cursorClickUseLoops')}
            />
          </SettingRow>
          <SettingRow label="Interval" tooltip={tt('Pause between loops (ms).', 'Pausa entre loops (ms).')}>
            <EnableChip
              value={interval}
              isOn={useInterval}
              unit="ms" format max={MAX_DELAY_MS}
              onCommitValue={(v) => onChange('cursorClickInterval', v)}
              onToggle={(v) => onChange('cursorClickUseInterval', v)}
              onEnterActivate={() => activateIfOff(useInterval, 'cursorClickUseInterval')}
            />
          </SettingRow>
          <SettingRow label="Jitter" tooltip={tt('Random ±% on each delay — less robotic.', 'Variação ±% aleatória em cada atraso — menos robótico.')}>
            <EnableChip
              value={rateJitter}
              isOn={useRateJitter}
              unit="%" max={100}
              onCommitValue={(v) => onChange('cursorClickDelayJitter', v)}
              onToggle={(v) => onChange('cursorClickUseJitter', v)}
              onEnterActivate={() => activateIfOff(useRateJitter, 'cursorClickUseJitter')}
            />
          </SettingRow>
          <SettingRow label="Position" tooltip={tt('Random ±px around the cursor. Exclusive with Area / Fixed.', 'Variação ±px aleatória ao redor do cursor. Exclusivo com Area / Fixed.')}>
            <EnableChip
              value={positionJitter}
              isOn={usePositionJitter}
              max={MAX_POSITION_PX}
              onCommitValue={(v) => onChange('cursorClickPositionJitter', v)}
              onToggle={(v) => setClickMode('cursorClickUsePositionJitter', v)}
              onEnterActivate={() => setClickMode('cursorClickUsePositionJitter', true)}
            />
          </SettingRow>
          {/* Click area — chip-shaped: the dot toggles useArea (mutually exclusive with
              Position); the body opens the region picker; ✕ (hover) clears. Backend also
              auto-enables useArea + disables Position jitter on a successful draw. */}
          <SettingRow label="Area" tooltip={tt('Clicks a random point in a screen box. Exclusive with Position / Fixed.', 'Clica em um ponto aleatório em uma caixa na tela. Exclusivo com Position / Fixed.')}>
            <div
              className={`${FIELD_W} h-7 flex items-center rounded border overflow-hidden group`}
              style={useArea
                ? { borderColor: 'var(--color-accent-solid)', background: 'color-mix(in srgb, var(--color-accent) 13%, transparent)' }
                : { borderColor: 'var(--color-border-default)', background: 'var(--color-bg-input)' }}
            >
              <button
                type="button"
                onClick={() => setClickMode('cursorClickUseArea', !useArea)}
                aria-label={useArea ? 'Disable area' : 'Enable area'}
                className="h-full pl-2 pr-1 flex items-center shrink-0 cursor-pointer transition-colors hover:bg-[rgba(127,127,127,0.18)]"
              >
                <span
                  className="w-2 h-2 rounded-full block shrink-0"
                  style={useArea
                    ? { background: 'var(--color-accent-solid)' }
                    : { background: 'transparent', border: '1.5px solid var(--color-text-tertiary)' }}
                />
              </button>
              <button
                onClick={() => send({ type: 'clicker:configureArea', payload: { requestId: `clicker-area-${Date.now()}` } })}
                className={`flex-1 min-w-0 h-full flex items-center justify-end font-mono cursor-pointer hover:underline ${area ? 'pr-1' : 'pr-2'}`}
                // pos="left" opens the tip into the work area (like the SettingRow labels)
                // instead of the default auto placement that lands on top of the field.
                data-tip-pos="left"
                data-tip={area
                  ? tt(`Current: ${area.w}×${area.h} at (${area.x}, ${area.y}). Click to redraw.`, `Atual: ${area.w}×${area.h} em (${area.x}, ${area.y}). Clique para redesenhar.`)
                  : tt('Drag a rectangle on screen', 'Arraste um retângulo na tela')}
              >
                {area
                  ? <span className={`text-[10px] truncate ${useArea ? 'text-text-primary' : 'text-text-tertiary'}`}>{area.w}×{area.h}</span>
                  : <span className={`text-[11px] ${useArea ? 'text-text-secondary' : 'text-text-tertiary'}`}>Set…</span>}
              </button>
              {area && (
                // In-flow (not absolute) so it never overlaps the value text — it takes
                // its own slot at the right edge; muted by default, solid on hover.
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onChange('cursorClickUseArea', false);
                    onChange('cursorClickArea', null);
                  }}
                  aria-label="Clear area"
                  className="shrink-0 h-full px-1 flex items-center text-text-tertiary hover:text-text-primary text-[11px] leading-none transition-colors"
                  tabIndex={-1}
                >
                  ✕
                </button>
              )}
            </div>
          </SettingRow>
          {/* Fixed point — chip-shaped like Area. Dot toggles useFixed (mutex with
              Position/Area); the body opens the single-click point picker. With a point
              set → clicks exactly there; with NONE set → "At start" (locks to the cursor
              when clicking begins). ✕ clears the point back to lock-on-start. Backend also
              auto-enables useFixed + disables the other two on a successful pick. */}
          <SettingRow label="Fixed" tooltip={tt('Always clicks one point. No point set = locks to the cursor when clicking starts. Exclusive with Position / Area.', 'Sempre clica em um ponto. Sem ponto = trava na posição do cursor quando começa a clicar. Exclusivo com Position / Area.')}>
            <div
              className={`${FIELD_W} h-7 flex items-center rounded border overflow-hidden group`}
              style={useFixed
                ? { borderColor: 'var(--color-accent-solid)', background: 'color-mix(in srgb, var(--color-accent) 13%, transparent)' }
                : { borderColor: 'var(--color-border-default)', background: 'var(--color-bg-input)' }}
            >
              <button
                type="button"
                onClick={() => setClickMode('cursorClickUseFixed', !useFixed)}
                aria-label={useFixed ? 'Disable fixed point' : 'Enable fixed point'}
                className="h-full pl-2 pr-1 flex items-center shrink-0 cursor-pointer transition-colors hover:bg-[rgba(127,127,127,0.18)]"
              >
                <span
                  className="w-2 h-2 rounded-full block shrink-0"
                  style={useFixed
                    ? { background: 'var(--color-accent-solid)' }
                    : { background: 'transparent', border: '1.5px solid var(--color-text-tertiary)' }}
                />
              </button>
              <button
                onClick={() => send({ type: 'clicker:configurePoint', payload: { requestId: `clicker-point-${Date.now()}` } })}
                className={`flex-1 min-w-0 h-full flex items-center justify-end font-mono cursor-pointer hover:underline ${fixedPoint ? 'pr-1' : 'pr-2'}`}
                // pos="left" — same as the Area chip / SettingRow labels; opens into the work
                // area instead of on top of the field.
                data-tip-pos="left"
                data-tip={fixedPoint
                  ? tt(`Fixed at (${fixedPoint.x}, ${fixedPoint.y}). Click to re-pick.`, `Fixo em (${fixedPoint.x}, ${fixedPoint.y}). Clique para escolher de novo.`)
                  : tt('Locks to the cursor when clicking starts. Click to pick an exact point.', 'Trava na posição do cursor ao começar a clicar. Clique para escolher um ponto exato.')}
              >
                {fixedPoint
                  ? <span className={`text-[10px] truncate ${useFixed ? 'text-text-primary' : 'text-text-tertiary'}`}>{fixedPoint.x}, {fixedPoint.y}</span>
                  : <span className={`text-[11px] ${useFixed ? 'text-text-secondary' : 'text-text-tertiary'}`}>At start</span>}
              </button>
              {fixedPoint && (
                <button
                  onClick={(e) => {
                    // Clear the point only — keep useFixed on, reverting to lock-on-start.
                    e.stopPropagation();
                    onChange('cursorClickFixedPoint', null);
                  }}
                  aria-label="Clear fixed point"
                  className="shrink-0 h-full px-1 flex items-center text-text-tertiary hover:text-text-primary text-[11px] leading-none transition-colors"
                  tabIndex={-1}
                >
                  ✕
                </button>
              )}
            </div>
          </SettingRow>
          {/* Hold — removed from the panel per request; the default of 10 ms
              (defaultSettings.cursorClickHold) still applies at replay. To show it again,
              re-add `hold` to the ClickerSection destructuring and uncomment this row:
          <SettingRow label="Hold" tooltip="How long button stays pressed (ms). 10 = normal click; 50-200 = slow click">
            <ValueField value={hold} unit="ms" onCommitValue={(v) => onChange('cursorClickHold', v)} />
          </SettingRow>
          */}
    </Section>
  );
}

function HotkeyInput({ value, settingKey, onChange, width = FIELD_W, allowClear = false }: {
  value: string;
  settingKey: string;
  onChange: (key: string, hotkey: string) => void;
  width?: string;
  // Opt-in hotkeys (empty = feature off) get a clear affordance; the always-set
  // five keep the plain input — clearing them would leave a dead core hotkey.
  allowClear?: boolean;
}) {
  const { send, subscribe } = useBridge();
  const [localValue, setLocalValue] = useState(value);
  const [isFocused, setIsFocused] = useState(false);
  const tt = useTt();
  // Idle-cancel timer — without an explicit Esc-to-cancel rule (so users can capture
  // Escape as a hotkey if they want), the only way out of capture mode is to click away
  // or wait this many ms. Resets on every captured combo so an actively engaged user is
  // never surprised mid-press.
  const inputRef = useRef<HTMLInputElement>(null);
  const captureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable refcount slot — each HotkeyInput instance owns its own slot in the backend
  // HashSet so cleaning up one field (e.g. Profile-key toggle) doesn't disable the hook
  // out from under another (Recording hotkey field). See InputHookManager.RegisterCapture.
  const ownerIdRef = useRef(`settings-hotkey-${crypto.randomUUID()}`);
  const KEY_CAPTURE_TIMEOUT_MS = 4000;
  const armCaptureTimer = useCallback(() => {
    if (captureTimerRef.current) clearTimeout(captureTimerRef.current);
    captureTimerRef.current = setTimeout(() => {
      inputRef.current?.blur();
    }, KEY_CAPTURE_TIMEOUT_MS);
  }, []);
  const disarmCaptureTimer = useCallback(() => {
    if (captureTimerRef.current) {
      clearTimeout(captureTimerRef.current);
      captureTimerRef.current = null;
    }
  }, []);
  // Unmount cleanup — same defensive pattern as ActionTable / SheetPanel.
  useEffect(() => disarmCaptureTimer, [disarmCaptureTimer]);
  // Release the hotkey-capture slot on unmount. Normal flow (user blurs the field
  // before tearing down) already does this via onBlur, but tab-switching the
  // Settings panel unmounts the input without a blur — without this, the slot
  // would leak and the backend hook would stay armed until something else
  // claimed and released a slot. HashSet.Remove is idempotent so this is a no-op
  // when the slot was never registered.
  useEffect(() => {
    return () => {
      send({ type: 'hotkey:capture', payload: { enabled: false, ownerId: ownerIdRef.current } });
    };
  }, [send]);

  useEffect(() => {
    if (!isFocused) setLocalValue(value);
  }, [value, isFocused]);

  // Subscribe to backend captures while focused. The low-level hook composes combos
  // (including Win+letter and AltGr quirks the JS layer can't see) and emits them here.
  // We commit on the first composed key+modifier event (matches the old single-press
  // auto-commit behaviour).
  useEffect(() => {
    if (!isFocused) return;
    return subscribe((msg) => {
      if (msg.type !== 'hotkey:captured') return;
      const combo = msg.payload?.combo;
      // Compile-time narrowing types combo as string, but a malformed backend
      // message could deliver a non-string/empty payload at runtime — without
      // this guard it would be set as the field value and committed, and the
      // only backstop is BridgeContext's per-handler try/catch (which just logs).
      if (typeof combo !== 'string' || combo.length === 0) return;
      setLocalValue(combo);
      armCaptureTimer();
      // A pure modifier press ("Win", "Ctrl") shouldn't commit — wait for the real key.
      const isPureModifier = combo === 'Win' || combo === 'Ctrl' || combo === 'Alt' || combo === 'Shift'
        || /^(Win|Ctrl|Alt|Shift)(\+(Win|Ctrl|Alt|Shift))*$/.test(combo);
      if (!isPureModifier) {
        onChange(settingKey, combo);
        disarmCaptureTimer();
        inputRef.current?.blur();
      }
    });
  }, [isFocused, subscribe, settingKey, onChange, armCaptureTimer, disarmCaptureTimer]);

  // Unified "capture mode" UX — same as the grid Key column edit and the SheetPanel /
  // ProfilePanel hotkey inputs. While focused, the field shows the live combo (or empty +
  // "New key..." placeholder if nothing held yet) with an accent border and a soft pulse
  // so it's obvious the input is waiting. Idle state shows the stored value in accent text
  // on a default border. Single visual language across every key-capture surface.
  // Arming is deliberate — click or Enter/Space, never bare focus. Arming on
  // onFocus meant keyboard navigation (Tab restored in Wave 2) would silently
  // put the low-level hook into capture mode and rebind the next keypress.
  const armCapture = () => {
    setIsFocused(true);
    setLocalValue('');
    send({ type: 'hotkey:capture', payload: { enabled: true, ownerId: ownerIdRef.current } });
    armCaptureTimer();
  };
  const input = (
    <input
      ref={inputRef}
      type="text"
      readOnly
      value={localValue}
      onClick={() => { if (!isFocused) armCapture(); }}
      onKeyDown={(e) => {
        if (!isFocused && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          armCapture();
        }
      }}
      onBlur={() => { setIsFocused(false); setLocalValue(value); send({ type: 'hotkey:capture', payload: { enabled: false, ownerId: ownerIdRef.current } }); disarmCaptureTimer(); }}
      // px-1.5 (not the fields' usual px-2): the 100px column's content box is 82px at
      // px-2, and the DEFAULT Replay combo "Ctrl+PageDown" needs ~86px at 12px Consolas —
      // the 6px padding gives it 88px so no factory default ever clips.
      className={`${allowClear ? 'w-full' : width} h-7 px-1.5 text-xs font-mono bg-bg-input border rounded text-center outline-none cursor-pointer placeholder:text-accent-light/50 ${
        isFocused
          ? 'text-accent-light border-accent-solid animate-pulse'
          : 'text-accent border-border-default'
      }`}
      placeholder="New key..."
    />
  );
  if (!allowClear) return input;
  // The clear affordance OVERLAYS the input's right edge inside a wrapper of the same
  // fixed width, so the field stays column-aligned with the plain hotkey inputs above
  // and nothing reflows when the button mounts/unmounts. It stays INVISIBLE until the
  // row is hovered (owner request: the resting panel should read as one clean column of
  // key values) — opacity rather than mounting, so the combo underneath never reflows.
  // focus-visible keeps it reachable by keyboard, where there is no hover to give.
  return (
    <div className={`group relative ${width}`}>
      {input}
      {value !== '' && !isFocused && (
        <button
          type="button"
          onClick={() => onChange(settingKey, '')}
          className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-elevated opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-[opacity,color,background-color]"
          data-tip={tt('Clear (disables this hotkey)', 'Limpar (desativa este hotkey)')}
        >
          <X size={11} />
        </button>
      )}
    </div>
  );
}

interface SettingsPanelProps {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function SettingsPanel({ collapsed = false, onToggleCollapse }: SettingsPanelProps) {
  const { settings, settingsResetEpoch, status } = useAppState();
  const { language, setLanguage } = useLanguage();
  const tt = useTt();
  const { send, subscribe } = useBridge();
  const selectionRef = useSelectionRef();
  // Three scopes (2026-07 "Option B" reorg): Profile = what changes per macro/mode;
  // Keys = everything that intercepts a key (global hotkeys, clicker hotkeys, remaps);
  // App = window/startup/notifications/automation/interface + the Updates footer.
  const [activeTab, setActiveTab] = useState<'profile' | 'keys' | 'app'>('profile');
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'up-to-date' | 'error'>('idle');
  // SETTINGS FILTER (disabled). To revive: uncomment the line below, the filter input + its
  // FilterContext.Provider wrapper in the tab content, and re-add `Search` to the lucide import.
  // const [query, setQuery] = useState('');

  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === 'update:available') setUpdateStatus('idle');
      if (msg.type === 'update:none') setUpdateStatus('up-to-date');
      if (msg.type === 'update:error') setUpdateStatus('error');
    });
  }, [subscribe]);

  // Switching mode in EITHER direction used to jump to the Profile tab (see
  // FOCUS_PROFILE_ON_MODE_SWITCH). Edge-only: fires on an actual macro↔clicker toggle (a
  // value CHANGE), never on mount, so it can't fight the initial 'profile' default. The
  // ref keeps tracking the mode either way, so flipping the flag on needs no other change.
  const prevClickerMode = useRef(settings.useCursorClick);
  useEffect(() => {
    const modeChanged = settings.useCursorClick !== prevClickerMode.current;
    prevClickerMode.current = settings.useCursorClick;
    if (FOCUS_PROFILE_ON_MODE_SWITCH && modeChanged) setActiveTab('profile');
  }, [settings.useCursorClick]);

  // A run STARTING — a macro profile fires or the Clicker begins clicking, both of which
  // set status='replaying' — used to surface the Profile tab (see FOCUS_PROFILE_ON_RUN_START).
  // Keyed off `status`, NOT clickerStats.active/replayActive: clickerStats.active LATCHES
  // true after the first Clicker run (the reducer preserves it on status:changed), which
  // poisoned an OR-combination so it only fired once; `status` cleanly toggles
  // ready↔replaying every run. Edge-only, and only from a non-Profile tab. The ref keeps
  // tracking run state either way, so flipping the flag on needs no other change.
  const prevRunActive = useRef(false);
  const runActive = status === 'replaying';
  useEffect(() => {
    const runStarted = runActive && !prevRunActive.current;
    prevRunActive.current = runActive;
    if (FOCUS_PROFILE_ON_RUN_START && runStarted && activeTab !== 'profile') setActiveTab('profile');
  }, [runActive, activeTab]);

  const changeSetting = (key: string, value: string | boolean | number | object | null) => {
    send({ type: 'settings:change', payload: { key, value } });
  };

  const changeHotkey = (settingKey: string, hotkey: string) => {
    send({ type: 'settings:change', payload: { key: settingKey, value: hotkey } });
  };

  // ── Collapsed rail → expand straight into a section ──
  // Clicking a rail icon expands the panel on the right tab with the target
  // section scrolled into view (sections are always open since the quiet reorg
  // dropped the collapse chevrons).
  const pendingScrollSection = useRef<string | null>(null);
  useEffect(() => {
    if (collapsed || !pendingScrollSection.current) return;
    const title = pendingScrollSection.current;
    pendingScrollSection.current = null;
    requestAnimationFrame(() => {
      document.querySelector(`[data-section="${title}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }, [collapsed]);
  const expandToSection = (tab: 'profile' | 'keys' | 'app', sectionTitle: string) => {
    setActiveTab(tab);
    pendingScrollSection.current = sectionTitle;
    onToggleCollapse?.();
  };

  // Rail entries mirror the three tabs' sections (profile group swaps to the Clicker
  // panel when Clicker mode is on, like the expanded panel does), with two deliberate
  // exceptions: the Keys tab's small Clicker hotkey pair has no entry of its own (it
  // sits right under Hotkeys), and Updates lost its entry along with its section (it's
  // the App-tab footer now). Quiet reorg: icons are MONOCHROME (text-tertiary, hover →
  // primary via CSS) — the only surviving hue is the semantic Clicker purple (`color`).
  type RailEntry = { tab: 'profile' | 'keys' | 'app'; title: string; icon: React.ElementType; color?: string };
  const railProfile: RailEntry[] =
    settings.useCursorClick
      ? [{ tab: 'profile', title: 'Clicker', icon: MousePointerClick, color: 'var(--color-clicker)' }]
      : [
          { tab: 'profile', title: 'Execution', icon: Timer },
          { tab: 'profile', title: 'Game Mode', icon: Gamepad2 },
          { tab: 'profile', title: 'Recording', icon: Mic },
        ];
  const railKeys: RailEntry[] = [
    { tab: 'keys', title: 'Hotkeys', icon: Zap },
    { tab: 'keys', title: 'Key Remaps', icon: ArrowLeftRight },
  ];
  const railApp: RailEntry[] = [
    { tab: 'app', title: 'Window', icon: Monitor },
    { tab: 'app', title: 'Startup', icon: Power },
    { tab: 'app', title: 'Notifications', icon: BellRing },
    { tab: 'app', title: 'Automation', icon: TimerReset },
    { tab: 'app', title: 'Interface', icon: Palette },
  ];

  // Collapsed: a slim icon rail — one button per section (tooltips name them on
  // hover; clicking expands the panel on the right tab with that section open
  // and scrolled into view). No overflow-hidden here: the tooltips render to
  // the LEFT of the rail, outside the strip's box, and would be clipped.
  // width + colors in the transition list so the global theme-change fade isn't
  // overridden by a bare transition-[width] (see ProfilePanel).
  if (collapsed) {
    return (
      <div className="w-12 flex flex-col shrink-0 bg-bg-surface border border-border-subtle rounded-ui transition-[width,background-color,border-color] duration-200">
        <div className="flex items-center justify-center border-b border-border-subtle shrink-0 h-[47px]">
          <button
            onClick={onToggleCollapse}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors"
          >
            <ChevronsLeft size={14} />
          </button>
        </div>
        <div className="flex-1 flex flex-col items-center gap-1 py-2">
          {[railProfile, railKeys, railApp].map((group, gi) => (
            // display:contents wrapper keyed by group index (contributes no box of its
            // own); a thin divider separates the three tab groups.
            <div key={gi} className="contents">
              {gi > 0 && <div className="w-6 my-1 border-t border-border-subtle shrink-0" />}
              {group.map(s => (
                <button
                  key={s.title}
                  onClick={() => expandToSection(s.tab, s.title)}
                  className="group w-8 h-8 flex items-center justify-center rounded hover:bg-bg-elevated transition-colors shrink-0"
                  data-tip={s.title}
                  data-tip-pos="left"
                >
                  <s.icon
                    size={15}
                    className={s.color ? undefined : 'text-text-tertiary group-hover:text-text-primary transition-colors'}
                    style={s.color ? { color: s.color } : undefined}
                  />
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    // No overflow-hidden: the collapse button's tooltip renders to the left of
    // the tab bar and would be clipped at the panel edge (scrolling is handled
    // by the tab-content div below).
    <div className="w-[224px] flex flex-col shrink-0 bg-bg-surface border border-border-subtle rounded-ui transition-[width,background-color,border-color] duration-200">
      {/* Tab Bar — explicit 47 px height (matches the Toolbar's measured rendered height in
          the centre column) so the section header below this tab bar lines up vertically
          with the action grid's column-header row in the centre. Without this, the tab
          bar was ~39 px (default py-1.5 + 1 px border) vs the Toolbar's ~46 px, pulling
          the entire right column up by ~7 px. */}
      <div className="flex items-center gap-1 px-1.5 border-b border-border-subtle shrink-0 h-[47px]">
        <SegmentedControl
          ariaLabel="Settings scope"
          className="flex-1"
          grow
          plain
          value={activeTab}
          onChange={setActiveTab}
          options={[
            { value: 'profile', label: 'Profile' },
            { value: 'keys', label: 'Keys' },
            { value: 'app', label: 'App' },
          ]}
        />
        {onToggleCollapse && (
          <button
            onClick={onToggleCollapse}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors shrink-0"
          >
            <ChevronsRight size={14} />
          </button>
        )}
      </div>

      {/* Tab Content — scrollbar-gutter reserves the 6px scrollbar lane on every tab, so
          the single 100px field column never shifts (and no row label wraps) when one
          tab scrolls and another doesn't. */}
      <div className="flex-1 overflow-y-auto px-1.5 py-2 [scrollbar-gutter:stable]">
        {/* SETTINGS FILTER (disabled — uncomment this block, the Provider close tag below, the
            query state above, and re-add `Search` to the lucide import to revive):
        <div className="flex items-center gap-2 h-7 px-2 mb-1 rounded border border-border-default bg-bg-input">
          <Search size={12} className="text-text-tertiary shrink-0" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
            placeholder="Filter settings"
            className="flex-1 min-w-0 bg-transparent outline-none text-ui text-text-primary placeholder:text-text-tertiary"
          />
        </div>
        <FilterContext.Provider value={query.trim().toLowerCase()}>
        */}
        {activeTab === 'profile' ? (
          <>
            {/* Clicker mode swaps the Execution + Recording stack for a dedicated panel.
                Macro mode keeps the existing layout untouched. The clicker Start/Pause
                hotkeys moved to the Keys tab (2026-07 reorg: every key in one place). */}
            {settings.useCursorClick ? (
              <ClickerSection
                /* Remount on reset so the local /s ↔ ms unit toggle goes back to its
                   default ('ms'). Backend stays the source of truth for everything else. */
                key={settingsResetEpoch}
                button={settings.cursorClickButton}
                rate={settings.cursorClickDelay}
                rateJitter={settings.cursorClickDelayJitter}
                useRateJitter={settings.cursorClickUseJitter}
                hold={settings.cursorClickHold}
                positionJitter={settings.cursorClickPositionJitter}
                usePositionJitter={settings.cursorClickUsePositionJitter}
                useArea={settings.cursorClickUseArea}
                area={settings.cursorClickArea}
                useFixed={settings.cursorClickUseFixed}
                fixedPoint={settings.cursorClickFixedPoint}
                loops={settings.cursorClickLoops}
                useLoops={settings.cursorClickUseLoops}
                interval={settings.cursorClickInterval}
                useInterval={settings.cursorClickUseInterval}
                onChange={changeSetting}
              />
            ) : (
              <>
            <Section title="Execution">
              <SettingRow label="Delay" tooltip={tt('Fixed delay between actions (ms).', 'Atraso fixo entre ações (ms).')}>
                <EnableChip
                  value={settings.customDelay}
                  isOn={settings.useCustomDelay}
                  unit="ms" format max={MAX_DELAY_MS}
                  onCommitValue={(v) => changeSetting('customDelay', v)}
                  onToggle={(v) => changeSetting('useCustomDelay', v)}
                  onEnterActivate={(v) => {
                    const delay = parseInt(v, 10);
                    // Non-numeric input shouldn't flip the toggle on or push a bulk update.
                    if (isNaN(delay)) return;
                    if (!settings.useCustomDelay) changeSetting('useCustomDelay', true);
                    const indices = selectionRef.current;
                    if (indices.size > 0) {
                      send({ type: 'actions:bulkUpdateDelay', payload: { indices: [...indices], delay } });
                    }
                  }}
                />
              </SettingRow>
              <SettingRow label="Loops" tooltip={tt('Times to repeat. 0 = forever.', 'Vezes a repetir. 0 = infinito.')}>
                <EnableChip
                  value={settings.loopCount}
                  isOn={settings.enableLoop}
                  max={999}
                  onCommitValue={(v) => changeSetting('loopCount', v)}
                  onToggle={(v) => changeSetting('enableLoop', v)}
                  onEnterActivate={() => { if (!settings.enableLoop) changeSetting('enableLoop', true); }}
                />
              </SettingRow>
              <SettingRow label="Interval" tooltip={tt('Pause between loops (ms).', 'Pausa entre loops (ms).')}>
                <EnableChip
                  value={settings.loopInterval}
                  isOn={settings.loopIntervalEnabled}
                  unit="ms" format max={MAX_DELAY_MS}
                  onCommitValue={(v) => changeSetting('loopInterval', v)}
                  onToggle={(v) => changeSetting('loopIntervalEnabled', v)}
                  onEnterActivate={() => { if (!settings.loopIntervalEnabled) changeSetting('loopIntervalEnabled', true); }}
                />
              </SettingRow>
              <SettingRow label="Jitter" tooltip={tt('Random ±% on each delay — less robotic.', 'Variação ±% aleatória em cada atraso — menos robótico.')}>
                <EnableChip
                  value={settings.delayVariation}
                  isOn={settings.useDelayVariation}
                  unit="%" max={100}
                  onCommitValue={(v) => changeSetting('delayVariation', v)}
                  onToggle={(v) => changeSetting('useDelayVariation', v)}
                  onEnterActivate={() => { if (!settings.useDelayVariation) changeSetting('useDelayVariation', true); }}
                />
              </SettingRow>
            </Section>

            {/* Game Mode — interpolated cursor path so games (e.g. Roblox) that ignore a single
                large jump follow the cursor. Off = instant jumps, perfect for normal apps. Fast
                approach speeds far moves on top of that; the numeric knobs live under Tuning. */}
            <Section title="Game Mode">
              <SettingRow label="Smooth movement" tooltip={tt('Cursor follows a path so games (e.g. Roblox) accept it. Off = instant jumps, fine for normal apps.', 'O cursor segue um caminho para que jogos (ex.: Roblox) o aceitem. Off = saltos instantâneos, ideal para apps normais.')}>
                <CompactToggle isOn={settings.smoothMovement} onChange={(v) => changeSetting('smoothMovement', v)} />
              </SettingRow>
              {settings.smoothMovement && (
                <>
                  <SettingRow label="Fast approach" tooltip={tt('Teleports long moves (e.g. across monitors), smoothing only the final stretch — far clicks become near-instant. Turn off if a game misclicks.', 'Teletransporta movimentos longos (ex.: entre monitores), suavizando só o trecho final — cliques distantes ficam quase instantâneos. Desligue se um jogo errar o clique.')}>
                    <CompactToggle isOn={settings.fastApproach} onChange={(v) => changeSetting('fastApproach', v)} />
                  </SettingRow>
                  <Disclosure label="Tuning">
                    <SettingRow label="Path step" tooltip={tt('Max px per step. Lower = smoother, slower. ~20 for Roblox.', 'Máx. px por passo. Menor = mais suave, mais lento. ~20 para Roblox.')}>
                      <ValueField value={settings.moveStepPx} unit="px" onCommitValue={(v) => changeSetting('moveStepPx', v)} />
                    </SettingRow>
                    <SettingRow label="Step delay" tooltip={tt('Pause between path steps (ms).', 'Pausa entre passos do caminho (ms).')}>
                      <ValueField value={settings.moveStepDelay} unit="ms" onCommitValue={(v) => changeSetting('moveStepDelay', v)} />
                    </SettingRow>
                    <SettingRow label="Click delay" tooltip={tt('Pause before the click after moving (ms).', 'Pausa antes do clique após mover (ms).')}>
                      <ValueField value={settings.moveClickDelay} unit="ms" onCommitValue={(v) => changeSetting('moveClickDelay', v)} />
                    </SettingRow>
                    {settings.fastApproach && (
                      <SettingRow label="Settle distance" tooltip={tt('Px smoothed before the target after a teleport. Higher = safer, slower. ~80.', 'Px suavizados antes do alvo após um teletransporte. Maior = mais seguro, mais lento. ~80.')}>
                        <ValueField value={settings.settleDistance} unit="px" onCommitValue={(v) => changeSetting('settleDistance', v)} />
                      </SettingRow>
                    )}
                  </Disclosure>
                </>
              )}
            </Section>

            {/* Recording — switches, same as every other on/off row. Profile Keys keeps
                the danger accent (left bar + red icon/label) when off, since its shortcuts
                and hotstrings stop firing. (The 2026-07 reorg tried moving it to
                Global · Hotkeys; the owner preferred it here, next to what it gates.) */}
            <Section title="Recording">
              <SettingRow label="Mouse Clicks">
                <CompactToggle isOn={settings.recordMouse} onChange={(v) => changeSetting('recordMouse', v)} />
              </SettingRow>
              <SettingRow label="Mouse Scroll">
                <CompactToggle isOn={settings.recordScroll} onChange={(v) => changeSetting('recordScroll', v)} />
              </SettingRow>
              <SettingRow label="Keyboard">
                <CompactToggle isOn={settings.recordKeyboard} onChange={(v) => changeSetting('recordKeyboard', v)} />
              </SettingRow>
              <SettingRow label="Combined Actions" tooltip={tt('Records each click/keypress as one action (not Down+Up). Merges double-clicks, folds modifiers (Ctrl+C). Holds & drags need this off.', 'Grava cada clique/tecla como uma ação (não Down+Up). Mescla cliques duplos, agrupa modificadores (Ctrl+C). Holds e arrastos precisam disto desligado.')}>
                <CompactToggle isOn={settings.recordCombinedInput} onChange={(v) => changeSetting('recordCombinedInput', v)} />
              </SettingRow>
              <SettingRow label="Profile Keys" danger={!settings.profileKeyEnabled} tooltip={tt("Profile shortcuts & hotstrings won't fire while off.", 'Atalhos e hotstrings do perfil não disparam enquanto desligado.')}>
                <CompactToggle isOn={settings.profileKeyEnabled} onChange={(v) => changeSetting('profileKeyEnabled', v)} />
              </SettingRow>
              <SettingRow label="Browser Actions" tooltip={tt('Record Chrome CSS selectors instead of coordinates.', 'Grava seletores CSS do Chrome em vez de coordenadas.')}>
                <CompactToggle isOn={settings.browserSelectorEnabled ?? true} onChange={(v) => changeSetting('browserSelectorEnabled', v)} />
              </SettingRow>
            </Section>
              </>
            )}

          </>
        ) : activeTab === 'keys' ? (
          <>
            {/* Keys tab — everything that intercepts a key, in one place: the global
                hotkeys, the clicker Start/Pause pair, and the remap layer. */}
            <Section title="Hotkeys">
              <SettingRow label="Recording">
                <HotkeyInput
                  value={settings.recordingHotkey}
                  settingKey="recordingHotkey"
                  onChange={changeHotkey}
                />
              </SettingRow>
              <SettingRow label="Replay">
                <HotkeyInput
                  value={settings.replayHotkey}
                  settingKey="replayHotkey"
                  onChange={changeHotkey}
                />
              </SettingRow>
              <SettingRow label="Profile Keys">
                <HotkeyInput
                  value={settings.profileKeyToggleHotkey}
                  settingKey="profileKeyToggleHotkey"
                  onChange={changeHotkey}
                />
              </SettingRow>
              <SettingRow label="Foreground">
                <HotkeyInput
                  value={settings.foregroundHotkey}
                  settingKey="foregroundHotkey"
                  onChange={changeHotkey}
                />
              </SettingRow>
              <SettingRow label="Mode" tooltip={tt('Switch Macro ↔ Clicker.', 'Alterna Macro ↔ Clicker.')}>
                <HotkeyInput
                  value={settings.modeToggleHotkey}
                  settingKey="modeToggleHotkey"
                  onChange={changeHotkey}
                />
              </SettingRow>
              <SettingRow
                label="Capture Slot"
                tooltip={tt(
                  'Copies the current selection (Ctrl+C) into the next clipboard slot — {clip:1}…{clip:9}, wrapping. Empty = disabled.',
                  'Copia a seleção atual (Ctrl+C) para o próximo slot — {clip:1}…{clip:9}, dando a volta. Vazio = desativado.',
                )}
              >
                <HotkeyInput
                  value={settings.captureSlotHotkey}
                  settingKey="captureSlotHotkey"
                  onChange={changeHotkey}
                  allowClear
                />
              </SettingRow>
            </Section>

            {/* Clicker Start/Pause — moved here from the Profile tab so every key lives in
                one tab. Decoupled from the macro hotkeys; they only fire in Clicker mode.
                Purple title = the Clicker mode cue (the one surviving section hue). */}
            <Section title="Clicker" color="var(--color-clicker)">
              <SettingRow label="Start" tooltip={tt('Run / stop the clicker. Active in Clicker mode.', 'Inicia / para o clicker. Ativo no modo Clicker.')}>
                <HotkeyInput value={settings.cursorClickStartHotkey} settingKey="cursorClickStartHotkey" onChange={changeHotkey} />
              </SettingRow>
              <SettingRow label="Pause" tooltip={tt('Pause / resume the clicker. Active in Clicker mode.', 'Pausa / retoma o clicker. Ativo no modo Clicker.')}>
                <HotkeyInput value={settings.cursorClickPauseHotkey} settingKey="cursorClickPauseHotkey" onChange={changeHotkey} />
              </SettingRow>
            </Section>

            {/* Key Remaps — the always-on 1:1 layer (CapsLock→Esc, side-button→key,
                disable a key). List body lives in RemapSection; the master switch here.
                Also toggleable from the tray ("Enable Key Remaps") — the mouse-only
                escape hatch for a remap that made typing painful. */}
            <Section title="Key Remaps">
              <SettingRow
                label="Enable Key Remaps"
                tooltip={tt('Turns every remap on or off. Also in the tray menu.',
                  'Liga e desliga todos os remaps. Também no menu da bandeja.')}
              >
                <CompactToggle
                  isOn={settings.remaps.enabled}
                  onChange={(v) => send({ type: 'remap:save', payload: { enabled: v, remaps: settings.remaps.entries } })}
                />
              </SettingRow>
              <RemapSection />
            </Section>
          </>
        ) : (
          <>
            {/* App tab — window behaviour, launch, notifications, automation, interface;
                Updates lives in the panel footer below. */}
            <Section title="Window">
              <SettingRow label="Always On Top">
                <CompactToggle
                  isOn={settings.alwaysOnTop}
                  onChange={(v) => send({ type: 'window:alwaysOnTop', payload: { enabled: v } })}
                />
              </SettingRow>
              <SettingRow label="System Tray">
                <CompactToggle
                  isOn={settings.minimizeToTray}
                  onChange={(v) => send({ type: 'window:minimizeToTray', payload: { enabled: v } })}
                />
              </SettingRow>
            </Section>

            {/* Startup — how the app launches. */}
            <Section title="Startup">
              <SettingRow label="Run on Startup">
                <CompactToggle
                  isOn={settings.runOnStartup}
                  onChange={(v) => {
                    send({ type: 'window:runOnStartup', payload: { enabled: v } });
                    if (!v && settings.startMinimized) {
                      send({ type: 'window:startMinimized', payload: { enabled: false } });
                    }
                  }}
                />
              </SettingRow>
              <SettingRow label="Startup Minimized">
                <CompactToggle
                  isOn={settings.startMinimized}
                  onChange={(v) => send({ type: 'window:startMinimized', payload: { enabled: v } })}
                  disabled={!settings.runOnStartup}
                />
              </SettingRow>
              <SettingRow label="Run as Administrator" tooltip={tt('Relaunch as admin on startup — needed for elevated apps.', 'Reinicia como admin ao iniciar — necessário para apps elevados.')}>
                <CompactToggle
                  isOn={settings.runAsAdmin ?? false}
                  onChange={(v) => changeSetting('runAsAdmin', v)}
                />
              </SettingRow>
            </Section>

            {/* Notifications — out-of-window run-end cues. Both apply only while the
                TrueReplayer window is NOT foreground (the game usually covers it). */}
            <Section title="Notifications">
              <SettingRow label="Flash on Replay End">
                <CompactToggle
                  isOn={settings.runEndFlash}
                  onChange={(v) => send({ type: 'window:runEndFlash', payload: { enabled: v } })}
                />
              </SettingRow>
              <SettingRow label="Sound on Replay End">
                <CompactToggle
                  isOn={settings.runEndSound}
                  onChange={(v) => send({ type: 'window:runEndSound', payload: { enabled: v } })}
                />
              </SettingRow>
            </Section>

            {/* Automation — the trigger daemon's master switch + the panel opener. The
                per-profile triggers themselves are configured inside the panel; this is
                just the always-discoverable settings-surface home (tray mirrors both). */}
            <Section title="Automation">
              <SettingRow
                label="Enable Automations"
                tooltip={tt('Turns every armed automation on or off. Also in the tray menu.',
                  'Liga e desliga todas as automações armadas. Também no menu da bandeja.')}
              >
                <CompactToggle
                  isOn={settings.automationEnabled}
                  onChange={(v) => send({ type: 'automation:setEnabled', payload: { enabled: v } })}
                />
              </SettingRow>
              <SettingRow
                label="Automations"
                tooltip={tt('Fire profiles without a hotkey: on a timer, at a clock time, or when something appears on screen.',
                  'Dispare profiles sem hotkey: por timer, em um horário, ou quando algo aparece na tela.')}
              >
                <button
                  onClick={() => window.dispatchEvent(new CustomEvent('cmd:automation'))}
                  className="flex items-center gap-1 text-ui text-accent-solid hover:underline"
                >
                  Manage <ChevronRight size={12} />
                </button>
              </SettingRow>
            </Section>

            {/* Interface — how the UI looks & speaks. Theme & layout opens the
                Theme Editor; Tooltips picks the tooltip language (names/labels stay
                English — only tooltip text is localised; frontend-only, switches live). */}
            <Section title="Interface">
              <SettingRow label="Theme & layout">
                <button
                  onClick={() => window.dispatchEvent(new CustomEvent('cmd:themeeditor'))}
                  className="flex items-center gap-1 text-ui text-accent-solid hover:underline"
                >
                  Customise <ChevronRight size={12} />
                </button>
              </SettingRow>
              <SettingRow label="Tooltips">
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value as 'en' | 'pt-BR')}
                  className="h-7 px-2 text-ui bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid cursor-pointer text-text-primary"
                >
                  <option value="en">English</option>
                  <option value="pt-BR">Português (BR)</option>
                </select>
              </SettingRow>
            </Section>

          </>
        )}
        {/* </FilterContext.Provider>  ← re-enable together with the disabled filter block above */}
      </div>

      {/* App-tab footer — Updates demoted from a section to one quiet line (the app
          auto-checks on launch; this is just the manual re-check + the running version). */}
      {activeTab === 'app' && (
        <div className="shrink-0 border-t border-border-subtle flex items-center justify-between px-3 py-1.5 text-[11px] text-text-tertiary">
          <span className="font-mono">{APP_VERSION}</span>
          <button
            onClick={() => {
              setUpdateStatus('checking');
              send({ type: 'update:check', payload: {} });
            }}
            disabled={updateStatus === 'checking'}
            className="hover:text-accent-solid hover:underline transition-colors disabled:opacity-50 disabled:no-underline"
          >
            {updateStatus === 'checking' ? 'Checking...'
              : updateStatus === 'up-to-date' ? '✓ Up to date'
              : updateStatus === 'error' ? 'Check failed — Retry'
              : 'Check for Updates'}
          </button>
        </div>
      )}
    </div>
  );
}
