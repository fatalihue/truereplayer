import { useState, useEffect, useRef, useCallback } from 'react';
import { Timer, Mic, Zap, Monitor, ChevronDown, ChevronRight, Download, MousePointerClick, Palette, Move } from 'lucide-react';
import { useAppState } from '../state/AppStateContext';
import { useBridge } from '../bridge/BridgeContext';
import { useSelectionRef } from '../state/SelectionContext';
import { Toggle } from './common/Toggle';

function Section({ icon: Icon, iconColor, title, children, defaultOpen = true }: {
  icon: React.ElementType;
  iconColor: string;
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="bg-bg-surface border border-border-subtle rounded-ui overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-bg-card transition-colors"
      >
        <Icon size={14} style={{ color: iconColor }} />
        <span className="text-ui font-semibold text-text-primary flex-1 text-left">{title}</span>
        {isOpen ? <ChevronDown size={14} className="text-text-tertiary" /> : <ChevronRight size={14} className="text-text-tertiary" />}
      </button>
      {isOpen && (
        <div className="px-3 pb-3 space-y-1">
          {children}
        </div>
      )}
    </div>
  );
}

function SettingRow({ label, tooltip, children, danger }: { label: string; tooltip?: string; children: React.ReactNode; danger?: boolean }) {
  // `danger` paints the row in a loud red so a disabled-but-critical toggle
  // (e.g. Profile Keys OFF) is impossible to miss when glancing at the panel.
  return (
    <div
      className={
        danger
          ? 'flex items-center justify-between py-1 px-2 -mx-1 rounded bg-red-500/20 border border-red-500/60 shadow-[inset_0_0_0_1px_rgba(239,68,68,0.25)]'
          : 'flex items-center justify-between py-1'
      }
      title={tooltip}
    >
      <span className={danger ? 'text-ui font-semibold text-red-200' : 'text-ui text-text-secondary'}>
        {label}
      </span>
      <div className="flex items-center gap-2.5">
        {children}
      </div>
    </div>
  );
}

function SettingInput({ value: propValue, onCommit, onEnter, width = 'w-14', suffix, mono = true }: {
  value: string;
  onCommit: (v: string) => void;
  onEnter?: (v: string) => void;
  width?: string;
  suffix?: string;
  mono?: boolean;
}) {
  const [localValue, setLocalValue] = useState(propValue);
  const isFocused = useRef(false);
  const committedByEnter = useRef(false);

  useEffect(() => {
    if (!isFocused.current) {
      setLocalValue(propValue);
    }
  }, [propValue]);

  const commit = () => {
    onCommit(localValue);
  };

  return (
    <>
      <input
        type="text"
        value={localValue}
        onChange={(e) => setLocalValue(e.target.value)}
        onFocus={() => { isFocused.current = true; committedByEnter.current = false; }}
        onBlur={() => {
          isFocused.current = false;
          if (!committedByEnter.current) {
            commit();
          }
          committedByEnter.current = false;
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            committedByEnter.current = true;
            commit();
            onEnter?.(localValue);
            (e.target as HTMLInputElement).blur();
          }
        }}
        className={`${width} h-7 px-2 text-ui text-text-primary bg-bg-input border border-border-default rounded text-center outline-none focus:border-accent-solid ${mono ? 'font-mono' : ''}`}
      />
      {suffix && <span className="text-[11px] text-text-disabled w-4">{suffix}</span>}
    </>
  );
}

// Clicker v2 — dedicated section that replaces Execution + Recording in the Profile tab
// when useCursorClick is on. Reads/writes the cursorClick* fields directly via settings:change,
// so it's fully decoupled from the active profile's Delay/Jitter/Loop settings. Visual
// identity: purple header + subtle purple border so the user immediately sees "I'm
// configuring Clicker, not the macro profile".
function ClickerSection({
  button, rate, rateJitter, useRateJitter, hold, positionJitter, usePositionJitter,
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
  const [isOpen, setIsOpen] = useState(true);
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
    <div
      className="bg-bg-surface rounded-ui overflow-hidden"
      style={{
        border: '1px solid color-mix(in srgb, var(--color-clicker) 35%, transparent)',
        boxShadow: '0 0 0 1px color-mix(in srgb, var(--color-clicker) 12%, transparent) inset',
      }}
    >
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-bg-card transition-colors"
      >
        <MousePointerClick size={14} style={{ color: 'var(--color-clicker)' }} />
        <span className="text-ui font-semibold flex-1 text-left" style={{ color: 'var(--color-clicker)' }}>Clicker</span>
        {isOpen ? <ChevronDown size={14} className="text-text-tertiary" /> : <ChevronRight size={14} className="text-text-tertiary" />}
      </button>
      {isOpen && (
        <div className="px-3 pb-3 space-y-1">
          {/* Layout mirrors the Execution panel exactly: label | input | toggle. The Rate
              row puts the /s ↔ ms <select> in the toggle column so the column always lines
              up across rows. Hold has no toggle (0 ms is a valid value, no on/off needed)
              so we render a w-10 spacer to keep the input vertically aligned with the others. */}
          {/* Mouse button picker — moved here from the ActionBar so the panel is the single
              source of truth for "every Clicker setting". Left/Right/Middle, no on/off
              switch (always applied). Spacer matches the toggle column on the other rows. */}
          <SettingRow label="Button" tooltip="Mouse button to click">
            <select
              value={button}
              onChange={(e) => onChange('cursorClickButton', e.target.value)}
              className="w-[80px] h-7 px-2 text-ui font-mono text-text-primary bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid cursor-pointer text-center"
            >
              <option value="Left">Left</option>
              <option value="Right">Right</option>
              <option value="Middle">Middle</option>
            </select>
            <div className="w-10" />
          </SettingRow>
          <SettingRow label="Rate" tooltip="Click rate (clicks per second) vs (delay)">
            <SettingInput
              /* Key is based on (unit, localDelayMs) so the input remounts with the right
                 displayValue whenever either changes — including when the user toggles the
                 unit after typing a value, since commitRate updates localDelayMs optimistically. */
              key={`rate-${unit}-${localDelayMs}`}
              value={displayValue}
              onCommit={commitRate}
              width="w-[80px]"
            />
            <select
              value={unit}
              onChange={(e) => setUnit(e.target.value as 'ms' | 'cps')}
              className="w-10 h-5 pl-1 text-[11px] text-text-secondary bg-bg-input border border-border-default rounded outline-none focus:border-accent-solid font-mono cursor-pointer"
              title="Unit"
            >
              <option value="cps">/s</option>
              <option value="ms">ms</option>
            </select>
          </SettingRow>
          <SettingRow label="Jitter" tooltip="Random ±% applied to each delay (anti-cheat detection)">
            <SettingInput
              value={rateJitter}
              onCommit={(v) => onChange('cursorClickDelayJitter', v)}
              onEnter={() => activateIfOff(useRateJitter, 'cursorClickUseJitter')}
              width="w-[80px]"
            />
            <Toggle isOn={useRateJitter} onChange={(v) => onChange('cursorClickUseJitter', v)} />
          </SettingRow>
          <SettingRow label="Hold" tooltip="How long button stays pressed (ms). 10 = normal click; 50-200 = slow click">
            <SettingInput value={hold} onCommit={(v) => onChange('cursorClickHold', v)} width="w-[80px]" />
            {/* Hold has no on/off — 0 ms is a valid value. Spacer keeps the input column
                aligned with the rows that do have a toggle (matches Toggle's w-10 footprint). */}
            <div className="w-10" />
          </SettingRow>
          <SettingRow label="Position" tooltip="Random ±px offset around the cursor (anti-cheat detection). Mutually exclusive with Area.">
            <SettingInput
              value={positionJitter}
              onCommit={(v) => onChange('cursorClickPositionJitter', v)}
              onEnter={() => setExclusive(
                { key: 'cursorClickUsePositionJitter', on: usePositionJitter },
                { key: 'cursorClickUseArea', on: useArea },
                true,
              )}
              width="w-[80px]"
            />
            <Toggle
              isOn={usePositionJitter}
              onChange={(v) => setExclusive(
                { key: 'cursorClickUsePositionJitter', on: usePositionJitter },
                { key: 'cursorClickUseArea', on: useArea },
                v,
              )}
            />
          </SettingRow>
          {/* Click area row. "Set…" opens the region picker; backend persists + auto-enables
              useArea + disables Position jitter on a successful draw. ✕ lives INSIDE the
              field (absolute, hover-revealed) so the right column stays Toggle-only. */}
          <SettingRow label="Area" tooltip="Click at a random point inside a screen rectangle. Mutually exclusive with Position.">
            <div className="relative group w-[80px]">
              <button
                onClick={() => send({ type: 'clicker:configureArea', payload: { requestId: `clicker-area-${Date.now()}` } })}
                className="h-7 px-2 text-ui font-mono text-text-primary bg-bg-input border border-border-default rounded outline-none hover:border-accent-solid focus:border-accent-solid cursor-pointer flex items-center justify-center gap-1.5 w-full"
                title={area
                  ? `Current: ${area.w}×${area.h} at (${area.x}, ${area.y}). Click to redraw.`
                  : 'Drag a rectangle on screen'}
              >
                {area
                  ? <span className="text-[10px] truncate">{area.w}×{area.h}</span>
                  : <span className="text-[11px]">Set…</span>}
              </button>
              {area && (
                <button
                  onClick={(e) => {
                    // stopPropagation so the click doesn't bubble to the field button below.
                    e.stopPropagation();
                    onChange('cursorClickUseArea', false);
                    onChange('cursorClickArea', null);
                  }}
                  className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus:opacity-100 text-text-tertiary hover:text-text-primary text-[12px] leading-none px-1 transition-opacity bg-bg-input rounded"
                  title="Clear area"
                  tabIndex={-1}
                >
                  ✕
                </button>
              )}
            </div>
            <Toggle
              isOn={useArea}
              onChange={(v) => setExclusive(
                { key: 'cursorClickUseArea', on: useArea },
                { key: 'cursorClickUsePositionJitter', on: usePositionJitter },
                v,
              )}
            />
          </SettingRow>
          <SettingRow label="Loops" tooltip="Number of clicks per run. 0 = infinite">
            <SettingInput
              value={loops}
              onCommit={(v) => onChange('cursorClickLoops', v)}
              onEnter={() => activateIfOff(useLoops, 'cursorClickUseLoops')}
              width="w-[80px]"
            />
            <Toggle isOn={useLoops} onChange={(v) => onChange('cursorClickUseLoops', v)} />
          </SettingRow>
          <SettingRow label="Interval" tooltip="Pause between loop (ms)">
            <SettingInput
              value={interval}
              onCommit={(v) => onChange('cursorClickInterval', v)}
              onEnter={() => activateIfOff(useInterval, 'cursorClickUseInterval')}
              width="w-[80px]"
            />
            <Toggle isOn={useInterval} onChange={(v) => onChange('cursorClickUseInterval', v)} />
          </SettingRow>
        </div>
      )}
    </div>
  );
}

function HotkeyInput({ value, settingKey, onChange }: {
  value: string;
  settingKey: string;
  onChange: (key: string, hotkey: string) => void;
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
      const combo = msg.payload.combo;
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
  return (
    <input
      ref={inputRef}
      type="text"
      readOnly
      value={localValue}
      onFocus={() => { setIsFocused(true); setLocalValue(''); send({ type: 'hotkey:capture', payload: { enabled: true, ownerId: ownerIdRef.current } }); armCaptureTimer(); }}
      onBlur={() => { setIsFocused(false); setLocalValue(value); send({ type: 'hotkey:capture', payload: { enabled: false, ownerId: ownerIdRef.current } }); disarmCaptureTimer(); }}
      className={`w-[110px] h-7 px-2 text-xs font-mono bg-bg-input border rounded text-center outline-none cursor-pointer placeholder:text-accent-light/50 ${
        isFocused
          ? 'text-accent-light border-accent-solid animate-pulse'
          : 'text-accent border-border-default'
      }`}
      placeholder="New key..."
    />
  );
}

export function SettingsPanel() {
  const { settings, settingsResetEpoch } = useAppState();
  const { send, subscribe } = useBridge();
  const selectionRef = useSelectionRef();
  const [activeTab, setActiveTab] = useState<'profile' | 'global'>('profile');
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'up-to-date' | 'error'>('idle');

  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === 'update:available') setUpdateStatus('idle');
      if (msg.type === 'update:none') setUpdateStatus('up-to-date');
      if (msg.type === 'update:error') setUpdateStatus('error');
    });
  }, [subscribe]);

  const changeSetting = (key: string, value: string | boolean | number | object | null) => {
    send({ type: 'settings:change', payload: { key, value } });
  };

  const changeHotkey = (settingKey: string, hotkey: string) => {
    send({ type: 'settings:change', payload: { key: settingKey, value: hotkey } });
  };

  return (
    <div className="w-[220px] flex flex-col shrink-0 overflow-hidden bg-bg-surface border border-border-subtle rounded-ui">
      {/* Tab Bar — explicit 44 px height (matches the Toolbar's measured rendered height in
          the centre column) so the section header below this tab bar lines up vertically
          with the action grid's column-header row in the centre. Without this, the tab
          bar was ~39 px (default py-1.5 + 1 px border) vs the Toolbar's ~46 px, pulling
          the entire right column up by ~7 px. */}
      <div className="flex items-center gap-1 px-1.5 border-b border-border-subtle shrink-0 h-[47px]">
        <button
          onClick={() => setActiveTab('profile')}
          className={`flex-1 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
            activeTab === 'profile'
              ? 'bg-bg-elevated text-text-primary'
              : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-card'
          }`}
        >
          Profile
        </button>
        <button
          onClick={() => setActiveTab('global')}
          className={`flex-1 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
            activeTab === 'global'
              ? 'bg-bg-elevated text-text-primary'
              : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-card'
          }`}
        >
          Global
        </button>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto space-y-1 p-1">
        {activeTab === 'profile' ? (
          <>
            {/* Clicker mode swaps the Execution + Recording stack for a dedicated panel.
                Macro mode keeps the existing layout untouched. */}
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
                loops={settings.cursorClickLoops}
                useLoops={settings.cursorClickUseLoops}
                interval={settings.cursorClickInterval}
                useInterval={settings.cursorClickUseInterval}
                onChange={changeSetting}
              />
            ) : (
              <>
            <Section icon={Timer} iconColor="#ffd93d" title="Execution">
              <SettingRow label="Delay" tooltip="Fixed delay between actions (ms)">
                <SettingInput
                  value={settings.customDelay}
                  onCommit={(v) => changeSetting('customDelay', v)}
                  onEnter={(v) => {
                    if (!settings.useCustomDelay) {
                      changeSetting('useCustomDelay', true);
                    }
                    const indices = selectionRef.current;
                    if (indices.size > 0) {
                      const delay = parseInt(v, 10);
                      if (!isNaN(delay)) {
                        send({ type: 'actions:bulkUpdateDelay', payload: { indices: [...indices], delay } });
                      }
                    }
                  }}
                  width="w-[80px]"
                />
                <Toggle isOn={settings.useCustomDelay} onChange={(v) => changeSetting('useCustomDelay', v)} />
              </SettingRow>
              <SettingRow label="Jitter" tooltip="Random ±% applied to each delay (anti-cheat detection)">
                <SettingInput
                  value={settings.delayVariation}
                  onCommit={(v) => changeSetting('delayVariation', v)}
                  onEnter={() => {
                    if (!settings.useDelayVariation) {
                      changeSetting('useDelayVariation', true);
                    }
                  }}
                  width="w-[80px]"
                />
                <Toggle isOn={settings.useDelayVariation} onChange={(v) => changeSetting('useDelayVariation', v)} />
              </SettingRow>
              <SettingRow label="Loops" tooltip="Number of times to repeat. 0 = infinite">
                <SettingInput
                  value={settings.loopCount}
                  onCommit={(v) => changeSetting('loopCount', v)}
                  onEnter={() => {
                    if (!settings.enableLoop) {
                      changeSetting('enableLoop', true);
                    }
                  }}
                  width="w-[80px]"
                />
                <Toggle isOn={settings.enableLoop} onChange={(v) => changeSetting('enableLoop', v)} />
              </SettingRow>
              <SettingRow label="Interval" tooltip="Pause between loop (ms)">
                <SettingInput
                  value={settings.loopInterval}
                  onCommit={(v) => changeSetting('loopInterval', v)}
                  onEnter={() => {
                    if (!settings.loopIntervalEnabled) {
                      changeSetting('loopIntervalEnabled', true);
                    }
                  }}
                  width="w-[80px]"
                />
                <Toggle isOn={settings.loopIntervalEnabled} onChange={(v) => changeSetting('loopIntervalEnabled', v)} />
              </SettingRow>
            </Section>

            {/* Movement — interpolated cursor path. Required for games (Roblox) that ignore a
                single large jump; off = legacy instant move. */}
            <Section icon={Move} iconColor="#51cf66" title="Movement">
              <SettingRow label="Smooth movement" tooltip="Move the cursor along a path to the target instead of jumping straight there. Required for games like Roblox that ignore a single large jump. Off = legacy instant move.">
                <Toggle isOn={settings.smoothMovement} onChange={(v) => changeSetting('smoothMovement', v)} />
              </SettingRow>
              {settings.smoothMovement && (
                <>
                  <SettingRow label="Path step" tooltip="Max pixels per step along the path. Lower = smoother / more reliable, slightly slower. ~20 works well for Roblox.">
                    <SettingInput value={settings.moveStepPx} onCommit={(v) => changeSetting('moveStepPx', v)} width="w-[80px]" suffix="px" />
                  </SettingRow>
                  <SettingRow label="Step delay" tooltip="Pause between path steps (ms).">
                    <SettingInput value={settings.moveStepDelay} onCommit={(v) => changeSetting('moveStepDelay', v)} width="w-[80px]" suffix="ms" />
                  </SettingRow>
                  <SettingRow label="Click delay" tooltip="Gap after reaching the target before the click fires (ms).">
                    <SettingInput value={settings.moveClickDelay} onCommit={(v) => changeSetting('moveClickDelay', v)} width="w-[80px]" suffix="ms" />
                  </SettingRow>
                </>
              )}
            </Section>

            {/* Recording */}
            <Section icon={Mic} iconColor="#ff6b6b" title="Recording">
              <SettingRow label="Mouse Clicks">
                <Toggle isOn={settings.recordMouse} onChange={(v) => changeSetting('recordMouse', v)} />
              </SettingRow>
              <SettingRow label="Mouse Scroll">
                <Toggle isOn={settings.recordScroll} onChange={(v) => changeSetting('recordScroll', v)} />
              </SettingRow>
              <SettingRow label="Keyboard">
                <Toggle isOn={settings.recordKeyboard} onChange={(v) => changeSetting('recordKeyboard', v)} />
              </SettingRow>
              <SettingRow label="Combined Actions" tooltip="Record each key press and mouse click as a single action (Keystroke / Click) instead of separate Down + Up rows. Modifiers fold into the key (Ctrl+C, Shift+A). Holds and drags aren't captured in this mode — leave it off, or add a HoldKey row, for those.">
                <Toggle isOn={settings.recordCombinedInput} onChange={(v) => changeSetting('recordCombinedInput', v)} />
              </SettingRow>
              <SettingRow label="Profile Keys" danger={!settings.profileKeyEnabled}>
                <Toggle isOn={settings.profileKeyEnabled} onChange={(v) => changeSetting('profileKeyEnabled', v)} />
              </SettingRow>
              <SettingRow label="Browser Actions" tooltip="Record CSS selectors from Chrome instead of mouse coordinates">
                <Toggle isOn={settings.browserSelectorEnabled ?? true} onChange={(v) => changeSetting('browserSelectorEnabled', v)} />
              </SettingRow>
            </Section>
              </>
            )}

          </>
        ) : (
          <>
            {/* Hotkeys */}
            <Section icon={Zap} iconColor="#60cdff" title="Hotkeys">
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
              <SettingRow label="Mode" tooltip="Switch between Macro and Clicker modes">
                <HotkeyInput
                  value={settings.modeToggleHotkey}
                  settingKey="modeToggleHotkey"
                  onChange={changeHotkey}
                />
              </SettingRow>
            </Section>

            {/* Window */}
            <Section icon={Monitor} iconColor="#7a8599" title="Window">
              <SettingRow label="Always On Top">
                <Toggle
                  isOn={settings.alwaysOnTop}
                  onChange={(v) => send({ type: 'window:alwaysOnTop', payload: { enabled: v } })}
                />
              </SettingRow>
              <SettingRow label="System Tray">
                <Toggle
                  isOn={settings.minimizeToTray}
                  onChange={(v) => send({ type: 'window:minimizeToTray', payload: { enabled: v } })}
                />
              </SettingRow>
              <SettingRow label="Run on Startup">
                <Toggle
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
                <Toggle
                  isOn={settings.startMinimized}
                  onChange={(v) => send({ type: 'window:startMinimized', payload: { enabled: v } })}
                  disabled={!settings.runOnStartup}
                />
              </SettingRow>
              <SettingRow label="Run as Administrator" tooltip="Relaunch with admin privileges on startup. Required to record clicks on elevated apps.">
                <Toggle
                  isOn={settings.runAsAdmin ?? false}
                  onChange={(v) => changeSetting('runAsAdmin', v)}
                />
              </SettingRow>
            </Section>

            {/* Appearance — direct action, not a collapsible Section. The category
                only houses a single entry (Theme Editor) right now, so making the user
                expand a submenu before clicking is pure friction. Render as a button
                styled like a collapsed Section header so it slots into the panel's
                visual rhythm. If we ever add more appearance settings (per-action
                accents, font-only toggles, etc.) swap back to <Section> with the
                children inside. */}
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('cmd:themeeditor'))}
              title="Customise colours, font, row height, and per-action accents."
              className="w-full flex items-center gap-2 px-3 py-2.5 bg-bg-surface border border-border-subtle rounded-ui hover:bg-bg-card transition-colors"
            >
              <Palette size={14} style={{ color: '#c084fc' }} />
              <span className="text-ui font-semibold text-text-primary flex-1 text-left">Appearance</span>
              <ChevronRight size={14} className="text-text-tertiary" />
            </button>

            {/* Updates */}
            <Section icon={Download} iconColor="#6bcb77" title="Updates" defaultOpen={false}>
              <SettingRow label="Auto Check">
                <Toggle isOn={true} onChange={() => {}} />
              </SettingRow>
              <button
                onClick={() => {
                  setUpdateStatus('checking');
                  send({ type: 'update:check', payload: {} });
                }}
                disabled={updateStatus === 'checking'}
                className="w-full flex items-center justify-center gap-1.5 mt-1 h-7 rounded text-xs text-text-secondary bg-bg-elevated border border-border-default hover:bg-bg-card hover:text-text-primary transition-colors disabled:opacity-50"
              >
                {updateStatus === 'checking' ? 'Checking...'
                  : updateStatus === 'up-to-date' ? '✓ Up to date'
                  : updateStatus === 'error' ? 'Check failed — Retry'
                  : 'Check for Updates'}
              </button>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
