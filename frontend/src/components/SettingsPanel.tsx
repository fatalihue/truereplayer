import { useState, useEffect, useRef } from 'react';
import { Timer, Mic, Zap, Monitor, ChevronDown, ChevronRight } from 'lucide-react';
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

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-ui text-text-secondary">{label}</span>
      <div className="flex items-center gap-2.5">
        {children}
      </div>
    </div>
  );
}

// Text input with local state — commits on blur/Enter, syncs from props on external changes
// onEnter fires only on Enter key (not blur) — used to auto-enable toggles and apply bulk changes
function SettingInput({ value: propValue, onCommit, onEnter, width = 'w-16', suffix, mono = true }: {
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

  // Sync from props when not focused (e.g., profile loaded from C#)
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
        onFocus={(e) => { isFocused.current = true; committedByEnter.current = false; e.target.select(); }}
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

// Hotkey capture input — captures key combos on keydown
function HotkeyInput({ value, settingKey, onChange }: {
  value: string;
  settingKey: string;
  onChange: (key: string, hotkey: string) => void;
}) {
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

    // Ignore modifier-only presses (show partial combo)
    const modifierKeys = new Set(['Control', 'Alt', 'Shift', 'Meta']);
    if (modifierKeys.has(e.key)) {
      setLocalValue(modifiers.join('+') || '...');
      return;
    }

    // Map key names
    let mainKey = e.key;
    if (mainKey === ' ') mainKey = 'Space';
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

  return (
    <input
      type="text"
      readOnly
      value={isFocused ? (localValue || '...') : localValue}
      onFocus={() => { setIsFocused(true); setLocalValue('...'); }}
      onBlur={() => { setIsFocused(false); setLocalValue(value); }}
      onKeyDown={handleKeyDown}
      className={`w-[110px] h-7 px-2 text-xs font-mono bg-bg-input border rounded text-center outline-none cursor-pointer ${
        isFocused
          ? 'text-white border-accent-solid'
          : 'text-accent border-border-default'
      }`}
      placeholder="Press a key..."
    />
  );
}

export function SettingsPanel() {
  const { settings } = useAppState();
  const { send } = useBridge();
  const selectionRef = useSelectionRef();

  const changeSetting = (key: string, value: string | boolean | number) => {
    send({ type: 'settings:change', payload: { key, value } });
  };

  const changeHotkey = (settingKey: string, hotkey: string) => {
    send({ type: 'settings:change', payload: { key: settingKey, value: hotkey } });
  };

  return (
    <div className="w-[250px] overflow-y-auto shrink-0 space-y-1">
      {/* Execution */}
      <Section icon={Timer} iconColor="#ffd93d" title="Execution">
        <SettingRow label="Fixed Delay">
          <SettingInput
            value={settings.customDelay}
            onCommit={(v) => changeSetting('customDelay', v)}
            onEnter={(v) => {
              // Auto-enable the toggle
              if (!settings.useCustomDelay) {
                changeSetting('useCustomDelay', true);
              }
              // Apply delay to selected actions in the DataGrid
              const indices = selectionRef.current;
              if (indices.size > 0) {
                const delay = parseInt(v, 10);
                if (!isNaN(delay)) {
                  send({ type: 'actions:bulkUpdateDelay', payload: { indices: [...indices], delay } });
                }
              }
            }}
            suffix="ms"
          />
          <Toggle isOn={settings.useCustomDelay} onChange={(v) => changeSetting('useCustomDelay', v)} />
        </SettingRow>
        <SettingRow label="Loop Count">
          <SettingInput
            value={settings.loopCount}
            onCommit={(v) => changeSetting('loopCount', v)}
            onEnter={() => {
              if (!settings.enableLoop) {
                changeSetting('enableLoop', true);
              }
            }}
            suffix="x"
          />
          <Toggle isOn={settings.enableLoop} onChange={(v) => changeSetting('enableLoop', v)} />
        </SettingRow>
        <SettingRow label="Loop Delay">
          <SettingInput
            value={settings.loopInterval}
            onCommit={(v) => changeSetting('loopInterval', v)}
            onEnter={() => {
              if (!settings.loopIntervalEnabled) {
                changeSetting('loopIntervalEnabled', true);
              }
            }}
            suffix="ms"
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
        <SettingRow label="Profile Keys">
          <Toggle isOn={settings.profileKeyEnabled} onChange={(v) => changeSetting('profileKeyEnabled', v)} />
        </SettingRow>
      </Section>

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
      </Section>

      {/* Window */}
      <Section icon={Monitor} iconColor="#7a8599" title="Window" defaultOpen={true}>
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
      </Section>
    </div>
  );
}
