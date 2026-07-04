import { useState, useEffect, useRef, useCallback, useContext, createContext } from 'react';
import { Timer, Mic, Zap, Monitor, ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, Download, MousePointerClick, Palette, Gamepad2, AlertTriangle, Globe, BellRing } from 'lucide-react';
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

// Default width for right-column controls (comboboxes, hotkey capture fields, and every
// Clicker chip) so they line up in a single column. 110px is set by the widest content that
// can't shrink — a hotkey combo like "Ctrl+PageDown" — and comfortably fits a thousands-
// separated "10.000 ms" too. The macro Execution EnableChips (Delay/Loops/Interval/Jitter)
// deliberately opt OUT of this to a tighter 96px (their EnableChip default) — they only ever
// hold a number, so the extra slack read as loose; the Clicker chips pass width={CTRL_W}
// explicitly so THAT section stays uniform.
const CTRL_W = 'w-[110px]';

// Live "Filter settings" query (lowercased). SettingRow reads it and hides itself when its
// label doesn't match, so the search needs no prop-drilling through every row.
const FilterContext = createContext('');

// Flat section: a small colored dot + label, no bordered card and (by default) no collapse
// chevron — the per-group cards + always-present expanders were the "boxy noise" users
// flagged. Pass collapsible for a long/secondary group (e.g. Updates), which adds the
// chevron; its open state persists across mounts unless persist={false} (see below).
// data-section still drives the collapsed rail's scroll.
function Section({ color, title, children, collapsible = false, defaultOpen = true, persist = true }: {
  color: string;
  title: string;
  children: React.ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  // Remember the open/closed choice across mounts (default). Pass persist={false}
  // for a group that should ALWAYS mount at defaultOpen regardless of a prior
  // choice — used by Updates, which the user wants reliably collapsed on every
  // open; expanding it is a transient, per-view action, not a sticky preference.
  persist?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(() => {
    if (!collapsible) return true;
    if (!persist) return defaultOpen;
    const saved = localStorage.getItem(`ui:settings-section:${title}`);
    return saved === null ? defaultOpen : saved === '1';
  });
  const toggleOpen = () => {
    setIsOpen(prev => {
      if (persist) localStorage.setItem(`ui:settings-section:${title}`, prev ? '0' : '1');
      return !prev;
    });
  };
  const dot = <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color }} />;
  return (
    <div data-section={title}>
      {collapsible ? (
        <button onClick={toggleOpen} className="group w-full flex items-center gap-2 px-1.5 pt-2 pb-0.5">
          {dot}
          <span className="label-micro text-text-tertiary flex-1 text-left group-hover:text-text-secondary transition-colors">{title}</span>
          {isOpen ? <ChevronDown size={12} className="text-text-tertiary" /> : <ChevronRight size={12} className="text-text-tertiary" />}
        </button>
      ) : (
        <div className="flex items-center gap-2 px-1.5 pt-2 pb-0.5">
          {dot}
          <span className="label-micro text-text-tertiary">{title}</span>
        </div>
      )}
      {isOpen && <div>{children}</div>}
    </div>
  );
}

// Merged value+enable control: one chip carrying the number, its unit and an enable dot —
// replaces the old "field + separate switch" pair so a setting reads as a single unit. Same
// CTRL_W as the plain value fields so the column stays aligned. The dot toggles enable;
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
  // Field width. Defaults to the compact 96px used by the macro Execution fields;
  // the Clicker section passes CTRL_W so its fields all line up at one width.
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
      className={`${width ?? 'w-[96px]'} h-7 flex items-center rounded border overflow-hidden focus-within:!border-accent-solid`}
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
    <div className={`${CTRL_W} h-7 flex items-center gap-1.5 px-2 rounded border border-border-default bg-bg-input focus-within:border-accent-solid`}>
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
function ComboInput({ value, onCommit, options, width = CTRL_W, editable = true }: {
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
// identity: purple header + subtle purple border so the user immediately sees "I'm
// configuring Clicker, not the macro profile".
function ClickerSection({
  button, rate, rateJitter, useRateJitter, positionJitter, usePositionJitter,
  useArea, area,
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
    const ms = unit === 'cps'
      ? Math.max(1, Math.round(1000 / num))
      : Math.max(1, Math.round(num));
    setLocalDelayMs(ms);              // optimistic — keeps the input stable on next render
    onChange('cursorClickDelay', String(ms));
  };

  // Turn a toggle ON if it isn't already — used by row-input onEnter to auto-activate the
  // companion switch when the user types a value (matches the Execution panel's affordance).
  const activateIfOff = (currentlyOn: boolean, settingKey: string) => {
    if (!currentlyOn) onChange(settingKey, true);
  };

  // Activate `self`, force `other` off — for mutually-exclusive Position/Area toggles where
  // both write to the same axis (where a click lands).
  const setExclusive = (
    self: { key: string; on: boolean },
    other: { key: string; on: boolean },
    enable: boolean,
  ) => {
    onChange(self.key, enable);
    if (enable && other.on) onChange(other.key, false);
  };

  return (
    // Uses the shared Section so it matches macro mode exactly (header above a single
    // inset group, same row layout). Purple icon/title keep the "you're in Clicker" cue.
    <Section color="var(--color-clicker)" title="Clicker">
          {/* Flat/chip layout: every right-column control is one CTRL_W (110px) box, flush right,
              so chips, combos and the area control all line up. Value+enable rows are a single
              EnableChip; Button/Rate are pickers; Area is chip-shaped (dot + picker). */}
          {/* Mouse button picker — moved here from the ActionBar so the panel is the single
              source of truth for "every Clicker setting". Left/Right/Middle, always applied. */}
          <SettingRow label="Button" tooltip={tt('Mouse button to click', 'Botão do mouse a clicar')}>
            <ComboInput
              editable={false}
              value={button}
              onCommit={(v) => onChange('cursorClickButton', v)}
              width={CTRL_W}
              options={[
                { value: 'Left', label: 'Left' },
                { value: 'Right', label: 'Right' },
                { value: 'Middle', label: 'Middle' },
              ]}
            />
          </SettingRow>
          <SettingRow label="Rate" tooltip={tt('Click rate: /s or delay (ms). Type or pick a preset.', 'Taxa de clique: /s ou atraso (ms). Digite ou escolha um preset.')}>
            {/* Combo + /s↔ms unit toggle share one CTRL_W slot so the row aligns with the chips. */}
            <div className={`${CTRL_W} flex items-center gap-1`}>
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
              width={CTRL_W}
              onCommitValue={(v) => onChange('cursorClickLoops', v)}
              onToggle={(v) => onChange('cursorClickUseLoops', v)}
              onEnterActivate={() => activateIfOff(useLoops, 'cursorClickUseLoops')}
            />
          </SettingRow>
          <SettingRow label="Interval" tooltip={tt('Pause between loops (ms).', 'Pausa entre loops (ms).')}>
            <EnableChip
              value={interval}
              isOn={useInterval}
              unit="ms" format
              width={CTRL_W}
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
              width={CTRL_W}
              onCommitValue={(v) => onChange('cursorClickDelayJitter', v)}
              onToggle={(v) => onChange('cursorClickUseJitter', v)}
              onEnterActivate={() => activateIfOff(useRateJitter, 'cursorClickUseJitter')}
            />
          </SettingRow>
          <SettingRow label="Position" tooltip={tt('Random ±px around the cursor. Exclusive with Area.', 'Variação ±px aleatória ao redor do cursor. Exclusivo com Area.')}>
            <EnableChip
              value={positionJitter}
              isOn={usePositionJitter}
              width={CTRL_W}
              onCommitValue={(v) => onChange('cursorClickPositionJitter', v)}
              onToggle={(v) => setExclusive(
                { key: 'cursorClickUsePositionJitter', on: usePositionJitter },
                { key: 'cursorClickUseArea', on: useArea },
                v,
              )}
              onEnterActivate={() => setExclusive(
                { key: 'cursorClickUsePositionJitter', on: usePositionJitter },
                { key: 'cursorClickUseArea', on: useArea },
                true,
              )}
            />
          </SettingRow>
          {/* Click area — chip-shaped: the dot toggles useArea (mutually exclusive with
              Position); the body opens the region picker; ✕ (hover) clears. Backend also
              auto-enables useArea + disables Position jitter on a successful draw. */}
          <SettingRow label="Area" tooltip={tt('Clicks a random point in a screen box. Exclusive with Position.', 'Clica em um ponto aleatório em uma caixa na tela. Exclusivo com Position.')}>
            <div
              className={`${CTRL_W} h-7 flex items-center rounded border overflow-hidden relative group`}
              style={useArea
                ? { borderColor: 'var(--color-accent-solid)', background: 'color-mix(in srgb, var(--color-accent) 13%, transparent)' }
                : { borderColor: 'var(--color-border-default)', background: 'var(--color-bg-input)' }}
            >
              <button
                type="button"
                onClick={() => setExclusive(
                  { key: 'cursorClickUseArea', on: useArea },
                  { key: 'cursorClickUsePositionJitter', on: usePositionJitter },
                  !useArea,
                )}
                aria-label={useArea ? 'Disable area' : 'Enable area'}
                className="h-full pl-2 pr-1.5 flex items-center shrink-0 cursor-pointer transition-colors hover:bg-[rgba(127,127,127,0.18)]"
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
                className="flex-1 min-w-0 h-full flex items-center justify-end pr-2 font-mono cursor-pointer hover:underline"
                data-tip={area
                  ? tt(`Current: ${area.w}×${area.h} at (${area.x}, ${area.y}). Click to redraw.`, `Atual: ${area.w}×${area.h} em (${area.x}, ${area.y}). Clique para redesenhar.`)
                  : tt('Drag a rectangle on screen', 'Arraste um retângulo na tela')}
              >
                {area
                  ? <span className={`text-[10px] truncate ${useArea ? 'text-text-primary' : 'text-text-tertiary'}`}>{area.w}×{area.h}</span>
                  : <span className={`text-[11px] ${useArea ? 'text-text-secondary' : 'text-text-tertiary'}`}>Set…</span>}
              </button>
              {area && (
                <button
                  onClick={(e) => {
                    // stopPropagation so the click doesn't bubble to the picker button.
                    e.stopPropagation();
                    onChange('cursorClickUseArea', false);
                    onChange('cursorClickArea', null);
                  }}
                  className="absolute right-0.5 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus:opacity-100 text-text-tertiary hover:text-text-primary text-[12px] leading-none px-0.5 transition-opacity"
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

function HotkeyInput({ value, settingKey, onChange, width = CTRL_W }: {
  value: string;
  settingKey: string;
  onChange: (key: string, hotkey: string) => void;
  width?: string;
}) {
  const { send, subscribe } = useBridge();
  const [localValue, setLocalValue] = useState(value);
  const [isFocused, setIsFocused] = useState(false);
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
  return (
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
      className={`${width} h-7 px-2 text-xs font-mono bg-bg-input border rounded text-center outline-none cursor-pointer placeholder:text-accent-light/50 ${
        isFocused
          ? 'text-accent-light border-accent-solid animate-pulse'
          : 'text-accent border-border-default'
      }`}
      placeholder="New key..."
    />
  );
}

interface SettingsPanelProps {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function SettingsPanel({ collapsed = false, onToggleCollapse }: SettingsPanelProps) {
  const { settings, settingsResetEpoch } = useAppState();
  const { language, setLanguage } = useLanguage();
  const tt = useTt();
  const { send, subscribe } = useBridge();
  const selectionRef = useSelectionRef();
  const [activeTab, setActiveTab] = useState<'profile' | 'global'>('profile');
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

  // Entering Clicker mode jumps to the Profile tab — the Clicker settings live there, so
  // landing on a stale Global section would hide them. Only fires on the macro→clicker
  // transition, so the user can still open Global manually while in Clicker mode.
  const prevClickerMode = useRef(settings.useCursorClick);
  useEffect(() => {
    if (settings.useCursorClick && !prevClickerMode.current) setActiveTab('profile');
    prevClickerMode.current = settings.useCursorClick;
  }, [settings.useCursorClick]);

  const changeSetting = (key: string, value: string | boolean | number | object | null) => {
    send({ type: 'settings:change', payload: { key, value } });
  };

  const changeHotkey = (settingKey: string, hotkey: string) => {
    send({ type: 'settings:change', payload: { key: settingKey, value: hotkey } });
  };

  // ── Collapsed rail → expand straight into a section ──
  // Clicking a rail icon expands the panel on the right tab with the target
  // section open and scrolled into view. The open flag is written to
  // localStorage BEFORE expanding because Sections read it in their useState
  // initializer (they're unmounted while the panel is collapsed).
  const pendingScrollSection = useRef<string | null>(null);
  useEffect(() => {
    if (collapsed || !pendingScrollSection.current) return;
    const title = pendingScrollSection.current;
    pendingScrollSection.current = null;
    requestAnimationFrame(() => {
      document.querySelector(`[data-section="${title}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }, [collapsed]);
  const expandToSection = (tab: 'profile' | 'global', sectionTitle: string) => {
    localStorage.setItem(`ui:settings-section:${sectionTitle}`, '1');
    setActiveTab(tab);
    pendingScrollSection.current = sectionTitle;
    onToggleCollapse?.();
  };

  // Rail entries mirror the sections of each tab (profile side swaps to the
  // Clicker panel when Clicker mode is on, like the expanded panel does).
  // `onClick` overrides the default expand-to-section behaviour — Appearance
  // uses it to open the Theme Editor straight from the rail, matching the
  // expanded panel's Appearance button (which is itself a direct action, not a
  // collapsible section).
  type RailEntry = { tab: 'profile' | 'global'; title: string; icon: React.ElementType; color: string; onClick?: () => void };
  // In Clicker mode the relevant hotkeys are the clicker Start/Pause group, which lives in the
  // Profile tab (the global macro hotkeys are inert in Clicker mode). So the rail mirrors the
  // expanded panel: Hotkeys then Clicker under Profile, and the Global group drops its now-
  // redundant Hotkeys icon.
  const railProfile: RailEntry[] =
    settings.useCursorClick
      ? [
          { tab: 'profile', title: 'Hotkeys', icon: Zap, color: '#60cdff' },
          { tab: 'profile', title: 'Clicker', icon: MousePointerClick, color: 'var(--color-clicker)' },
        ]
      : [
          { tab: 'profile', title: 'Execution', icon: Timer, color: '#ffd93d' },
          { tab: 'profile', title: 'Game Mode', icon: Gamepad2, color: '#51cf66' },
          { tab: 'profile', title: 'Recording', icon: Mic, color: '#ff6b6b' },
        ];
  const railGlobal: RailEntry[] = [
    ...(settings.useCursorClick ? [] : [{ tab: 'global', title: 'Hotkeys', icon: Zap, color: '#60cdff' } as RailEntry]),
    { tab: 'global', title: 'Window', icon: Monitor, color: '#7a8599' },
    // Amber, NOT #6bcb77 — the Updates entry below already owns that green and
    // the rail dots are the only per-section identity when collapsed.
    { tab: 'global', title: 'Notifications', icon: BellRing, color: '#ffa94d' },
    { tab: 'global', title: 'Appearance', icon: Palette, color: '#c084fc', onClick: () => window.dispatchEvent(new CustomEvent('cmd:themeeditor')) },
    { tab: 'global', title: 'Language', icon: Globe, color: '#4dd0a0' },
    { tab: 'global', title: 'Updates', icon: Download, color: '#6bcb77' },
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
          {railProfile.map(s => (
            <button
              key={s.title}
              onClick={s.onClick ?? (() => expandToSection(s.tab, s.title))}
              className="w-8 h-8 flex items-center justify-center rounded hover:bg-bg-elevated transition-colors shrink-0"
            >
              <s.icon size={15} style={{ color: s.color }} />
            </button>
          ))}
          <div className="w-6 my-1 border-t border-border-subtle shrink-0" />
          {railGlobal.map(s => (
            <button
              key={s.title}
              onClick={s.onClick ?? (() => expandToSection(s.tab, s.title))}
              className="w-8 h-8 flex items-center justify-center rounded hover:bg-bg-elevated transition-colors shrink-0"
            >
              <s.icon size={15} style={{ color: s.color }} />
            </button>
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
      {/* Tab Bar — explicit 44 px height (matches the Toolbar's measured rendered height in
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
            { value: 'global', label: 'Global' },
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

      {/* Tab Content — more vertical gap between groups now that each section is a
          floating header + inset (not a tight stack of bordered cards). */}
      <div className="flex-1 overflow-y-auto px-1.5 py-2">
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
                Macro mode keeps the existing layout untouched. */}
            {settings.useCursorClick ? (
              <>
              {/* Clicker hotkeys — their own group, pinned above the Clicker settings.
                  Decoupled from the global macro hotkeys; active only in Clicker mode. */}
              <Section color="#60cdff" title="Hotkeys">
                <SettingRow label="Start" tooltip={tt('Run / stop the clicker.', 'Inicia / para o clicker.')}>
                  <HotkeyInput value={settings.cursorClickStartHotkey} settingKey="cursorClickStartHotkey" onChange={changeHotkey} width={CTRL_W} />
                </SettingRow>
                <SettingRow label="Pause" tooltip={tt('Pause / resume the clicker.', 'Pausa / retoma o clicker.')}>
                  <HotkeyInput value={settings.cursorClickPauseHotkey} settingKey="cursorClickPauseHotkey" onChange={changeHotkey} width={CTRL_W} />
                </SettingRow>
              </Section>
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
                loops={settings.cursorClickLoops}
                useLoops={settings.cursorClickUseLoops}
                interval={settings.cursorClickInterval}
                useInterval={settings.cursorClickUseInterval}
                onChange={changeSetting}
              />
              </>
            ) : (
              <>
            <Section color="#ffd93d" title="Execution">
              <SettingRow label="Delay" tooltip={tt('Fixed delay between actions (ms).', 'Atraso fixo entre ações (ms).')}>
                <EnableChip
                  value={settings.customDelay}
                  isOn={settings.useCustomDelay}
                  unit="ms" format
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
                  unit="ms" format
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
            <Section color="#51cf66" title="Game Mode">
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
                and hotstrings stop firing. */}
            <Section color="#ff6b6b" title="Recording">
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
        ) : (
          <>
            {/* Hotkeys */}
            <Section color="#60cdff" title="Hotkeys">
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
            </Section>

            {/* Window */}
            <Section color="#7a8599" title="Window">
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
            <Section color="#ffa94d" title="Notifications">
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

            {/* Appearance — flat Section (matches the rest) with one action row that opens
                the Theme Editor. Section preserves data-section for the collapsed rail. */}
            <Section color="#c084fc" title="Appearance">
              <SettingRow label="Theme & layout">
                <button
                  onClick={() => window.dispatchEvent(new CustomEvent('cmd:themeeditor'))}
                  className="flex items-center gap-1 text-ui text-accent-solid hover:underline"
                >
                  Customise <ChevronRight size={12} />
                </button>
              </SettingRow>
            </Section>

            {/* Language — optional PT-BR tooltips. Names/labels stay English; only the tooltip
                text is localised. Frontend-only (localStorage), switches live. */}
            <Section color="#4dd0a0" title="Language">
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

            {/* Updates — the app auto-checks on launch; this is just a manual re-check.
                (The old always-on "Auto Check" switch was a no-op placeholder — removed.) */}
            <Section color="#6bcb77" title="Updates" collapsible defaultOpen={false} persist={false}>
              <button
                onClick={() => {
                  setUpdateStatus('checking');
                  send({ type: 'update:check', payload: {} });
                }}
                disabled={updateStatus === 'checking'}
                className="w-full flex items-center justify-center gap-1.5 h-9 text-xs text-text-secondary hover:bg-bg-elevated hover:text-text-primary transition-colors disabled:opacity-50"
              >
                {updateStatus === 'checking' ? 'Checking...'
                  : updateStatus === 'up-to-date' ? '✓ Up to date'
                  : updateStatus === 'error' ? 'Check failed — Retry'
                  : 'Check for Updates'}
              </button>
            </Section>
          </>
        )}
        {/* </FilterContext.Provider>  ← re-enable together with the disabled filter block above */}
      </div>
    </div>
  );
}
