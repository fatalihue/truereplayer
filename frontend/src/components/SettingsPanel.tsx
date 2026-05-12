import { useState, useEffect, useRef } from 'react';
import { Timer, Mic, Zap, Monitor, ChevronDown, ChevronRight, Download } from 'lucide-react';
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

function HotkeyInput({ value, settingKey, onChange, onFocusChange }: {
  value: string;
  settingKey: string;
  onChange: (key: string, hotkey: string) => void;
  onFocusChange?: (focused: boolean) => void;
}) {
  const { send } = useBridge();
  const [localValue, setLocalValue] = useState(value);
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    if (!isFocused) setLocalValue(value);
  }, [value, isFocused]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();

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

    if (!modifiers.includes(mainKey)) modifiers.push(mainKey);
    const combo = modifiers.join('+');

    setLocalValue(combo);
    onChange(settingKey, combo);
    (e.target as HTMLInputElement).blur();
  };

  // Unified "capture mode" UX — same as the grid Key column edit and the SheetPanel /
  // ProfilePanel hotkey inputs. While focused, the field shows the live combo (or empty +
  // "New key..." placeholder if nothing held yet) with an accent border and a soft pulse
  // so it's obvious the input is waiting. Idle state shows the stored value in accent text
  // on a default border. Single visual language across every key-capture surface.
  return (
    <input
      type="text"
      readOnly
      value={localValue}
      onFocus={() => { setIsFocused(true); setLocalValue(''); onFocusChange?.(true); send({ type: 'hotkey:suppress', payload: { enabled: true } }); }}
      onBlur={() => { setIsFocused(false); setLocalValue(value); onFocusChange?.(false); send({ type: 'hotkey:suppress', payload: { enabled: false } }); }}
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
  const { settings } = useAppState();
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
