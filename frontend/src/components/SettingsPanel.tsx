import { useState, useEffect, useRef, useCallback } from 'react';
import { Timer, Mic, Zap, Monitor, ChevronDown, ChevronRight, Download, MousePointerClick } from 'lucide-react';
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
  rate, rateJitter, useRateJitter, hold, positionJitter, usePositionJitter,
  loops, useLoops, interval, useInterval, onChange,
}: {
  rate: string;
  rateJitter: string;
  useRateJitter: boolean;
  hold: string;
  positionJitter: string;
  usePositionJitter: boolean;
  loops: string;
  useLoops: boolean;
  interval: string;
  useInterval: boolean;
  onChange: (key: string, value: string | boolean) => void;
}) {
  const [isOpen, setIsOpen] = useState(true);
  // Unit toggle for the Rate row: 'ms' shows the raw delay; '/s' shows clicks per second
  // computed from delay (1000 / ms). Backend always stores ms — the toggle is display-only.
  // Default is 'ms' (more conventional for typical users); reset bounces this back to 'ms'
  // via a React remount triggered by settingsResetEpoch in SettingsPanel.
  const [unit, setUnit] = useState<'ms' | 'cps'>('ms');

  const delayMs = Math.max(10, parseInt(rate, 10) || 100);
  const cpsFromMs = (ms: number) => {
    const v = 1000 / ms;
    return v >= 10 ? v.toFixed(0) : v.toFixed(1);
  };
  const displayValue = unit === 'cps' ? cpsFromMs(delayMs) : String(delayMs);
  const commitRate = (raw: string) => {
    const num = parseFloat(raw);
    if (isNaN(num) || num <= 0) return;
    if (unit === 'cps') {
      const ms = Math.max(10, Math.round(1000 / num));
      onChange('cursorClickDelay', String(ms));
    } else {
      onChange('cursorClickDelay', String(Math.max(10, Math.round(num))));
    }
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
          <SettingRow label="Rate" tooltip="Click rate (clicks per second) vs (delay)">
            <SettingInput
              key={`rate-${unit}-${delayMs}`}
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
          <SettingRow label="Jitter" tooltip="Random ±% applied to each click delay (anti-detection)">
            <SettingInput value={rateJitter} onCommit={(v) => onChange('cursorClickDelayJitter', v)} width="w-[80px]" />
            <Toggle isOn={useRateJitter} onChange={(v) => onChange('cursorClickUseJitter', v)} />
          </SettingRow>
          <SettingRow label="Hold" tooltip="How long button stays pressed (ms). 10 = normal click; 50-200 = slow click">
            <SettingInput value={hold} onCommit={(v) => onChange('cursorClickHold', v)} width="w-[80px]" />
            {/* Hold has no on/off — 0 ms is a valid value. Spacer keeps the input column
                aligned with the rows that do have a toggle (matches Toggle's w-10 footprint). */}
            <div className="w-10" />
          </SettingRow>
          <SettingRow label="Position" tooltip="Random ±px offset around the cursor for each click (anti-detection)">
            <SettingInput value={positionJitter} onCommit={(v) => onChange('cursorClickPositionJitter', v)} width="w-[80px]" />
            <Toggle isOn={usePositionJitter} onChange={(v) => onChange('cursorClickUsePositionJitter', v)} />
          </SettingRow>
          <SettingRow label="Loops" tooltip="Number of clicks per run. 0 = infinite">
            <SettingInput value={loops} onCommit={(v) => onChange('cursorClickLoops', v)} width="w-[80px]" />
            <Toggle isOn={useLoops} onChange={(v) => onChange('cursorClickUseLoops', v)} />
          </SettingRow>
          <SettingRow label="Interval" tooltip="Pause between loop (ms)">
            <SettingInput value={interval} onCommit={(v) => onChange('cursorClickInterval', v)} width="w-[80px]" />
            <Toggle isOn={useInterval} onChange={(v) => onChange('cursorClickUseInterval', v)} />
          </SettingRow>
        </div>
      )}
    </div>
  );
}

function HotkeyInput({ value, settingKey, onChange, onFocusChange }: {
  value: string;
  settingKey: string;
  onChange: (key: string, hotkey: string) => void;
  onFocusChange?: (focused: boolean) => void;
}) {
  const { send } = useBridge();
  const [localValue, setLocalValue] = useState(value);
  const [isFocused, setIsFocused] = useState(false);
  // Idle-cancel timer — without an explicit Esc-to-cancel rule (so users can capture
  // Escape as a hotkey if they want), the only way out of capture mode is to click away
  // or wait this many ms. Resets on every keypress so an actively engaged user is never
  // surprised mid-press.
  const inputRef = useRef<HTMLInputElement>(null);
  const captureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  useEffect(() => {
    if (!isFocused) setLocalValue(value);
  }, [value, isFocused]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Push the idle-cancel timer further out on every key event — even modifiers — so a
    // user mid-combo is never cut off.
    armCaptureTimer();

    const modifiers: string[] = [];
    if (e.ctrlKey) modifiers.push('Ctrl');
    if (e.altKey) modifiers.push('Alt');
    if (e.shiftKey) modifiers.push('Shift');

    const modifierKeys = new Set(['Control', 'Alt', 'Shift', 'Meta']);
    if (modifierKeys.has(e.key)) {
      // Keep the placeholder visible (empty string) while only a modifier is held — the
      // pulse + accent border already signal "still listening". Showing "..." here was
      // dead weight that conflicted with the placeholder.
      setLocalValue(modifiers.join('+'));
      return;
    }

    let mainKey = e.key;
    if (e.code.startsWith('Numpad') && e.code !== 'NumpadEnter') {
      const numpadMap: Record<string, string> = {
        Numpad0: 'Num0', Numpad1: 'Num1', Numpad2: 'Num2', Numpad3: 'Num3',
        Numpad4: 'Num4', Numpad5: 'Num5', Numpad6: 'Num6', Numpad7: 'Num7',
        Numpad8: 'Num8', Numpad9: 'Num9',
        NumpadMultiply: 'NumMultiply', NumpadDivide: 'NumDivide',
        NumpadAdd: 'NumAdd', NumpadSubtract: 'NumSubtract',
        NumpadDecimal: 'NumDecimal',
      };
      mainKey = numpadMap[e.code] ?? e.code;
    } else if (mainKey === ' ') mainKey = 'Space';
    else if (mainKey.length === 1) mainKey = mainKey.toUpperCase();
    else if (mainKey === 'ArrowUp') mainKey = 'Up';
    else if (mainKey === 'ArrowDown') mainKey = 'Down';
    else if (mainKey === 'ArrowLeft') mainKey = 'Left';
    else if (mainKey === 'ArrowRight') mainKey = 'Right';
    // Escape falls through to here unchanged → captured as "Escape", which C# KeyUtils
    // resolves to VK 0x1B. Users CAN bind Escape as a hotkey if they want.

    if (!modifiers.includes(mainKey)) modifiers.push(mainKey);
    const combo = modifiers.join('+');

    setLocalValue(combo);
    onChange(settingKey, combo);
    disarmCaptureTimer();
    (e.target as HTMLInputElement).blur();
  };

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
      onFocus={() => { setIsFocused(true); setLocalValue(''); onFocusChange?.(true); send({ type: 'hotkey:suppress', payload: { enabled: true } }); armCaptureTimer(); }}
      onBlur={() => { setIsFocused(false); setLocalValue(value); onFocusChange?.(false); send({ type: 'hotkey:suppress', payload: { enabled: false } }); disarmCaptureTimer(); }}
      onKeyDown={handleKeyDown}
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

  const changeSetting = (key: string, value: string | boolean | number) => {
    send({ type: 'settings:change', payload: { key, value } });
  };

  const changeHotkey = (settingKey: string, hotkey: string) => {
    send({ type: 'settings:change', payload: { key: settingKey, value: hotkey } });
  };

  const handleHotkeyFocusChange = (_focused: boolean) => {
    // Hotkey inputs no longer suppress global hotkeys
  };

  return (
    <div className="w-[220px] flex flex-col shrink-0 overflow-hidden bg-bg-surface border border-border-subtle rounded-ui">
      {/* Tab Bar */}
      <div className="flex gap-1 px-1.5 py-1.5 border-b border-border-subtle shrink-0">
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
                rate={settings.cursorClickDelay}
                rateJitter={settings.cursorClickDelayJitter}
                useRateJitter={settings.cursorClickUseJitter}
                hold={settings.cursorClickHold}
                positionJitter={settings.cursorClickPositionJitter}
                usePositionJitter={settings.cursorClickUsePositionJitter}
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
              <SettingRow label="Jitter" tooltip="Random ±% applied to each delay for natural timing">
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
              <SettingRow label="Loops" tooltip="Number of times to repeat">
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
              <SettingRow label="Interval" tooltip="Delay between each loop (ms)">
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
                  onFocusChange={handleHotkeyFocusChange}
                />
              </SettingRow>
              <SettingRow label="Replay">
                <HotkeyInput
                  value={settings.replayHotkey}
                  settingKey="replayHotkey"
                  onChange={changeHotkey}
                  onFocusChange={handleHotkeyFocusChange}
                />
              </SettingRow>
              <SettingRow label="Profile Keys">
                <HotkeyInput
                  value={settings.profileKeyToggleHotkey}
                  settingKey="profileKeyToggleHotkey"
                  onChange={changeHotkey}
                  onFocusChange={handleHotkeyFocusChange}
                />
              </SettingRow>
              <SettingRow label="Foreground">
                <HotkeyInput
                  value={settings.foregroundHotkey}
                  settingKey="foregroundHotkey"
                  onChange={changeHotkey}
                  onFocusChange={handleHotkeyFocusChange}
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
