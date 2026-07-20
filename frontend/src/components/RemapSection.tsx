import { useEffect, useRef, useState } from 'react';
import { X, Plus, ArrowRight, Ban } from 'lucide-react';
import { useBridge } from '../bridge/BridgeContext';
import { useAppState } from '../state/AppStateContext';
import { useTt } from '../state/LanguageContext';
import { Button } from './common/Button';

type RemapEntry = { from: string; to: string; enabled: boolean };

const MAX_REMAPS = 32;

/**
 * Body of the Settings → Keys → "Key Remaps" section: the always-on 1:1 layer
 * (CapsLock→Esc, XButton1→F, disable a key). Rows edit + save the WHOLE list via
 * remap:save (the backend sidecar is tiny); the master switch lives in the parent
 * SettingRow. Add-flow captures single keys through the shared low-level
 * hotkey:capture channel — combos are rejected (a remap source/target is ONE key).
 */
export function RemapSection() {
  const { send, subscribe } = useBridge();
  const { settings, profiles } = useAppState();
  const tt = useTt();
  const remaps = settings.remaps;

  const [addOpen, setAddOpen] = useState(false);
  const [fromKey, setFromKey] = useState('');
  const [toKey, setToKey] = useState('');
  const [disableMode, setDisableMode] = useState(false);
  // 'from' | 'to' | null — which chip is armed for capture.
  const [capturing, setCapturing] = useState<'from' | 'to' | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const capturingRef = useRef(capturing);
  capturingRef.current = capturing;

  const stopCapture = () => {
    if (capturingRef.current) {
      send({ type: 'hotkey:capture', payload: { enabled: false, ownerId: 'remap-add' } });
    }
    setCapturing(null);
  };

  const startCapture = (side: 'from' | 'to') => {
    setCaptureError(null);
    if (!capturingRef.current) {
      send({ type: 'hotkey:capture', payload: { enabled: true, ownerId: 'remap-add' } });
    }
    setCapturing(side);
  };

  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type !== 'hotkey:captured' || !capturingRef.current) return;
      // Owner filter: this chip is the app's only NON-modal capture consumer — a hotkey
      // dialog opened while the chip is armed registers LATER and is the intended
      // recipient of the broadcast; stealing it would pre-fill a remap key the user
      // never meant to set.
      if (msg.payload.owner && msg.payload.owner !== 'remap-add') return;
      const combo = msg.payload.combo;
      if (combo.includes('+')) {
        setCaptureError(tt('Single keys only — combos are not remappable.', 'Apenas teclas únicas — combos não são remapeáveis.'));
        return;
      }
      // Wheel "keys" can't be remapped at all (nothing to inject, nothing to swallow
      // per-direction), and X-buttons are valid SOURCES only — a keyboard injection of
      // a mouse-button vk is a no-op, which would silently disable the source key.
      if (combo === 'ScrollUp' || combo === 'ScrollDown') {
        setCaptureError(tt('The scroll wheel cannot be remapped.', 'A roda do mouse não pode ser remapeada.'));
        return;
      }
      if (capturingRef.current === 'to' && (combo === 'XButton1' || combo === 'XButton2')) {
        setCaptureError(tt('Mouse side buttons can be remap sources, not targets.', 'Botões laterais do mouse podem ser origem de remap, não destino.'));
        return;
      }
      if (capturingRef.current === 'from') setFromKey(combo);
      else setToKey(combo);
      stopCapture();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe]);

  // Leaving the section (panel collapse/unmount) must release the global capture.
  useEffect(() => () => stopCapture(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveList = (entries: RemapEntry[], enabled = remaps.enabled) =>
    send({ type: 'remap:save', payload: { enabled, remaps: entries } });

  const duplicateFrom = fromKey !== '' && remaps.entries.some(
    (r) => r.from.toLowerCase() === fromKey.toLowerCase());
  const selfRemap = fromKey !== '' && !disableMode && fromKey.toLowerCase() === toKey.toLowerCase();
  const canAdd = fromKey !== '' && (disableMode || toKey !== '')
    && !duplicateFrom && !selfRemap && remaps.entries.length < MAX_REMAPS;

  // A FROM key that is also a hotkey loses to the remap (the remap layer runs first in
  // the hook) — hotkeys silently not firing is the #1 support issue, so warn up front.
  const hotkeyCollision = (() => {
    if (!fromKey) return null;
    const fk = fromKey.toLowerCase();
    const globals: [string, string][] = [
      [settings.recordingHotkey, 'Recording'],
      [settings.replayHotkey, 'Replay'],
      [settings.profileKeyToggleHotkey, 'Profile Keys'],
      [settings.foregroundHotkey, 'Foreground'],
      [settings.modeToggleHotkey, 'Mode Toggle'],
      [settings.captureSlotHotkey, 'Capture Slot'],
    ];
    for (const [hk, label] of globals) {
      if (hk && hk.toLowerCase() === fk) return `${label} hotkey (${hk})`;
    }
    const p = profiles.find((pr) => pr.hotkey && pr.hotkey.toLowerCase() === fk);
    if (p) return `profile "${p.name}" (${p.hotkey})`;
    return null;
  })();

  const handleAdd = () => {
    if (!canAdd) return;
    saveList([...remaps.entries, { from: fromKey, to: disableMode ? '' : toKey, enabled: true }]);
    setFromKey('');
    setToKey('');
    setDisableMode(false);
    setAddOpen(false);
    stopCapture();
  };

  const keyChip = (side: 'from' | 'to', value: string, dimmed: boolean) => (
    <button
      type="button"
      onClick={() => (capturing === side ? stopCapture() : startCapture(side))}
      // flex-1 + min-w-0 lets the two chips split the row evenly instead of sizing to
      // their text and overflowing the 224px panel; truncate is the safety net for a
      // long key name (the placeholders themselves are kept short enough to fit).
      className={`h-7 flex-1 min-w-0 truncate px-2 rounded border text-[11px] transition-colors ${
        capturing === side
          ? 'border-accent-solid text-accent bg-accent-solid/10 animate-pulse'
          : value
            ? 'border-border-strong text-text-primary bg-bg-input'
            : 'border-border-default text-text-tertiary bg-bg-input'
      } ${dimmed ? 'opacity-40 pointer-events-none' : ''}`}
    >
      {capturing === side ? tt('press…', 'aperte…') : value || tt('set key', 'definir')}
    </button>
  );

  return (
    // px-2.5 = the SettingRow content inset, so the chip borders (and the add-flow /
    // empty-state text) line up with the rows above them.
    <div className="flex flex-col gap-1.5 px-2.5 py-1">
      {remaps.entries.length === 0 && !addOpen && (
        <div className="text-[11px] text-text-tertiary leading-relaxed">
          {tt('Nothing yet. A remap turns one key into another — CapsLock → Esc — or disables it.',
            'Nada por aqui. Um remap troca uma tecla por outra — CapsLock → Esc — ou desativa a tecla.')}
        </div>
      )}

      {/* Each entry is one full-width EnableChip-style chip — the same enable-dot +
          accent-wash vocabulary the Execution value chips teach (2026-07 reorg, V1
          "chip" variant): dot toggles the entry, ✕ removes it, both live inside the
          chip so a row is a single object. Off = plain input chrome + tertiary text
          (the hollow dot carries the state; no strike-through needed). */}
      {remaps.entries.map((r, i) => (
        <div
          // Keyed by the FROM key alone, not by index: with the index in the key, deleting
          // one row shifts every later row's key, so React unmounts and rebuilds the
          // survivors — dropping keyboard focus to <body> mid-list. FROM is unique by
          // construction (the add flow rejects a duplicate, and RemapService is first-wins),
          // and the raw string is deliberate: lower-casing it would make "CapsLock" and
          // "capslock" collide in a hand-edited file, which raw keys keep distinct.
          key={r.from}
          className="h-7 flex items-center rounded border overflow-hidden"
          style={r.enabled
            ? { borderColor: 'var(--color-accent-solid)', background: 'color-mix(in srgb, var(--color-accent) 13%, transparent)' }
            : { borderColor: 'var(--color-border-default)', background: 'var(--color-bg-input)' }}
        >
          <button
            type="button"
            onClick={() => saveList(remaps.entries.map((e, j) => (j === i ? { ...e, enabled: !r.enabled } : e)))}
            aria-label={r.enabled ? 'Disable remap' : 'Enable remap'}
            data-tip={tt(r.enabled ? 'Disable this remap' : 'Enable this remap', r.enabled ? 'Desativar este remap' : 'Ativar este remap')}
            className="h-full pl-2 pr-1.5 flex items-center shrink-0 cursor-pointer transition-colors hover:bg-[rgba(127,127,127,0.18)]"
          >
            <span
              className="w-2 h-2 rounded-full block shrink-0"
              style={r.enabled
                ? { background: 'var(--color-accent-solid)' }
                : { background: 'transparent', border: '1.5px solid var(--color-text-tertiary)' }}
            />
          </button>
          <span className={`flex-1 min-w-0 flex items-center gap-1.5 text-[11px] font-mono ${r.enabled ? 'text-text-primary' : 'text-text-tertiary'}`}>
            <span className="truncate">{r.from}</span>
            <ArrowRight size={10} className="text-text-tertiary shrink-0" />
            {r.to ? (
              <span className="truncate">{r.to}</span>
            ) : (
              <span className="text-text-tertiary flex items-center gap-1 min-w-0">
                <Ban size={9} className="shrink-0" /> <span className="truncate">{tt('disabled', 'desativada')}</span>
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={() => saveList(remaps.entries.filter((_, j) => j !== i))}
            className="shrink-0 h-full px-1.5 flex items-center text-text-tertiary hover:text-text-primary transition-colors"
          >
            <X size={11} />
          </button>
        </div>
      ))}

      {addOpen ? (
        <div className="flex flex-col gap-1.5 py-1 border-t border-border-subtle mt-1">
          <div className="flex items-center gap-2">
            {keyChip('from', fromKey, false)}
            <ArrowRight size={10} className="text-text-tertiary shrink-0" />
            {keyChip('to', disableMode ? '' : toKey, disableMode)}
          </div>
          <label className="flex items-center gap-1.5 text-[11px] text-text-tertiary cursor-pointer select-none">
            <input type="checkbox" checked={disableMode}
              onChange={(e) => { setDisableMode(e.target.checked); if (capturing === 'to') stopCapture(); }} />
            {tt('Just disable the key', 'Só desativar a tecla')}
          </label>
          {captureError && <div className="text-[10px]" style={{ color: 'var(--color-recording)' }}>{captureError}</div>}
          {duplicateFrom && (
            <div className="text-[10px]" style={{ color: 'var(--color-recording)' }}>
              {tt('That key is already remapped.', 'Essa tecla já está remapeada.')}
            </div>
          )}
          {selfRemap && (
            <div className="text-[10px]" style={{ color: 'var(--color-recording)' }}>
              {tt('Source and target are the same key.', 'Origem e destino são a mesma tecla.')}
            </div>
          )}
          {hotkeyCollision && (
            <div className="text-[10px]" style={{ color: 'var(--color-recording)' }}>
              {tt(`This key is also the ${hotkeyCollision} — the remap will override it and that hotkey will stop firing.`,
                `Essa tecla também é ${hotkeyCollision} — o remap vai sobrepor e essa hotkey deixará de disparar.`)}
            </div>
          )}
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => { setAddOpen(false); stopCapture(); setFromKey(''); setToKey(''); setDisableMode(false); setCaptureError(null); }}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={handleAdd} disabled={!canAdd}>Add</Button>
          </div>
        </div>
      ) : (
        <div>
          <Button variant="ghost" size="sm" onClick={() => setAddOpen(true)}
            disabled={remaps.entries.length >= MAX_REMAPS}
            data-tip={tt('Remaps apply everywhere while the app runs. They pause automatically while you record a macro. Keyboard keys and mouse side buttons (XButton1/2) can be sources.',
              'Remaps valem em todo o sistema enquanto o app roda. Pausam automaticamente durante gravação de macro. Teclas e botões laterais do mouse (XButton1/2) podem ser origem.')}>
            <Plus size={11} /> Add remap
          </Button>
        </div>
      )}
    </div>
  );
}
