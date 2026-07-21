import { useEffect, useMemo, useRef, useState } from 'react';
import { Zap, Plus, Trash2, Pipette, Camera, CircleDot, Frame, X, ScanSearch, Check } from 'lucide-react';
import { useBridge } from '../bridge/BridgeContext';
import { useAppState } from '../state/AppStateContext';
import { useTt } from '../state/LanguageContext';
import { DialogShell } from './common/DialogShell';
import { Button } from './common/Button';
import { Toggle } from './common/Toggle';
import { SegmentedControl } from './common/SegmentedControl';
import { NumberInput } from './common/NumberInput';
import { Field } from './sheet/Field';
import { WindowTargetFields } from './WindowTargetFields';
import { ImageCropper } from './ImageCropper';
import type { AutomationEntry, TriggerConfig } from '../bridge/messageTypes';

// Day-pill order matches the backend bitmask convention (Sun = 1<<0, the If-Time one).
const DAY_PILLS = [
  { bit: 1 << 1, label: 'Mon' },
  { bit: 1 << 2, label: 'Tue' },
  { bit: 1 << 3, label: 'Wed' },
  { bit: 1 << 4, label: 'Thu' },
  { bit: 1 << 5, label: 'Fri' },
  { bit: 1 << 6, label: 'Sat' },
  { bit: 1 << 0, label: 'Sun' },
];

const CONDITION_TYPES = [
  { value: 'WindowOpen', label: 'Window open' },
  { value: 'ProcessRunning', label: 'Process running' },
  { value: 'FileExists', label: 'File exists' },
  { value: 'PixelColorMatch', label: 'Pixel color' },
  { value: 'ImageFound', label: 'Image on screen' },
  { value: 'ClipboardChanged', label: 'Clipboard changed' },
];

function defaultTrigger(): TriggerConfig {
  return {
    kind: 'interval',
    armed: false,
    intervalSeconds: 300,
    timeOfDay: '12:00',
    daysOfWeek: 0,
    conditionType: 'WindowOpen',
    windowProcessName: '',
    windowTitle: '',
    windowTitleMatchMode: 'contains',
    windowMatchForegroundOnly: false,
    filePath: '',
    pixelX: 0,
    pixelY: 0,
    pixelColor: '#FFFFFF',
    pixelTolerance: 10,
    imagePath: null,
    imageConfidence: 0.8,
    imageBase64: null,
    searchRegion: null,
    clipboardPattern: '',
    cooldownSeconds: 30,
    retrigger: 'edge',
  };
}

const inputCls =
  'h-8 px-2 rounded bg-bg-input border border-border-subtle text-[12px] text-text-primary ' +
  'focus:outline-none focus:border-accent-solid w-full';

function fmtWhen(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function kindSummary(t: TriggerConfig, tt: (en: string, pt: string) => string): string {
  if (t.kind === 'interval') {
    const s = Math.max(5, t.intervalSeconds);
    return s % 60 === 0 ? tt(`every ${s / 60} min`, `a cada ${s / 60} min`) : tt(`every ${s}s`, `a cada ${s}s`);
  }
  if (t.kind === 'schedule') return tt(`at ${t.timeOfDay ?? '--:--'}`, `às ${t.timeOfDay ?? '--:--'}`);
  const c = CONDITION_TYPES.find((x) => x.value === t.conditionType);
  return tt(`when ${c?.label ?? t.conditionType ?? '?'}`, `quando ${c?.label ?? t.conditionType ?? '?'}`);
}

export function AutomationPanel({ onClose }: { onClose: () => void }) {
  const { send, subscribe } = useBridge();
  const { automation, profiles } = useAppState();
  const tt = useTt();

  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<TriggerConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [cropperOpen, setCropperOpen] = useState(false); // ImageFound: re-crop the reference PNG
  const [testMatchResult, setTestMatchResult] = useState<{ found: boolean; score: number; error?: string } | null>(null);
  // A not-yet-saved automation for a profile that has none. Only one at a time.
  const [newDraftProfile, setNewDraftProfile] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const seededForRef = useRef<string | null>(null);

  // Live status refresh while open: pushes are change-driven, so a quiet watcher's
  // nextDue countdown would go stale without a poll. 2 s is plenty.
  useEffect(() => {
    send({ type: 'automation:request', payload: {} });
    const id = window.setInterval(() => send({ type: 'automation:request', payload: {} }), 2000);
    return () => window.clearInterval(id);
  }, [send]);

  const entries = automation.entries;
  const entryByProfile = useMemo(() => {
    const m = new Map<string, AutomationEntry>();
    for (const e of entries) m.set(e.profile, e);
    return m;
  }, [entries]);

  // Display list = saved automations + the one unsaved draft (if any).
  const listProfiles = useMemo(() => {
    const names = entries.map((e) => e.profile);
    if (newDraftProfile && !names.includes(newDraftProfile)) names.push(newDraftProfile);
    return names;
  }, [entries, newDraftProfile]);

  const profilesWithoutTrigger = useMemo(
    () => profiles.filter((p) => !entryByProfile.has(p.name) && p.name !== newDraftProfile).map((p) => p.name),
    [profiles, entryByProfile, newDraftProfile],
  );

  // Seed the editor draft ONCE per selection — later automation:state pushes carry
  // runtime status and must never stomp in-progress config edits.
  useEffect(() => {
    if (selected == null) { setDraft(null); seededForRef.current = null; return; }
    if (seededForRef.current === selected) return;
    seededForRef.current = selected;
    const entry = entryByProfile.get(selected);
    setDraft(entry ? { ...entry.trigger } : defaultTrigger());
    setDirty(false);
  }, [selected, entryByProfile]);

  // A saved entry vanishing (deleted elsewhere / profile removed) clears a matching selection.
  useEffect(() => {
    if (selected && !listProfiles.includes(selected)) {
      setSelected(null);
      setDraft(null);
    }
  }, [selected, listProfiles]);

  const patch = (p: Partial<TriggerConfig>) => {
    setDraft((d) => (d ? { ...d, ...p } : d));
    setDirty(true);
  };

  const handleSave = () => {
    if (!selected || !draft) return;
    // Armed is NOT an editor field — the list toggle is the sole arming surface
    // (automation:setArmed persists immediately). Sending the seeded draft.armed here
    // would silently revert a list-toggle made after the draft was seeded.
    const armed = entryByProfile.get(selected)?.trigger.armed ?? false;
    // imageBase64 is display-only (the on-disk PNG is the source) — the backend never parses it, so
    // send null instead of round-tripping the large derived blob across the bridge on every save.
    send({ type: 'automation:save', payload: { profile: selected, trigger: { ...draft, imageBase64: null, armed } } });
    setDirty(false);
    // newDraftProfile stays set until the automation:state echo lands — clearing it now
    // would drop the row from the list (entries doesn't have it yet) and blank the editor.
  };

  // New-draft handoff: once the backend echo carries the saved entry, the store row
  // replaces the local draft row.
  useEffect(() => {
    if (newDraftProfile && entryByProfile.has(newDraftProfile)) setNewDraftProfile(null);
  }, [newDraftProfile, entryByProfile]);

  const handleRemove = () => {
    if (!selected) return;
    if (newDraftProfile === selected) {
      setNewDraftProfile(null);
    } else {
      send({ type: 'automation:save', payload: { profile: selected, trigger: null } });
    }
    setSelected(null);
    setDraft(null);
  };

  // ── Pick-from-screen round-trips (pixel color + image capture) ──
  const pickReqRef = useRef<string | null>(null);
  const captureReqRef = useRef<string | null>(null);
  const regionReqRef = useRef<string | null>(null);
  const testMatchReqRef = useRef<string | null>(null);
  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === 'pixel:colorPicked' && msg.payload.requestId === pickReqRef.current) {
        pickReqRef.current = null;
        if (!msg.payload.cancelled && msg.payload.hex) {
          patch({ pixelX: msg.payload.x ?? 0, pixelY: msg.payload.y ?? 0, pixelColor: msg.payload.hex });
        }
      }
      if (msg.type === 'automation:imageCaptured' && msg.payload.requestId === captureReqRef.current) {
        captureReqRef.current = null;
        if (!msg.payload.cancelled && msg.payload.imagePath) {
          // A new/cropped reference makes any test-match badge stale → drop it. A fresh CAPTURE (not a
          // crop of the same image, which keeps its location) may point at a different target, so also
          // clear the snapped ROI — otherwise the daemon would search the new image inside the old box.
          const wasCrop = msg.payload.requestId.startsWith('autocrop-');
          setTestMatchResult(null);
          patch({ imagePath: msg.payload.imagePath, imageBase64: msg.payload.imageBase64 ?? null, ...(wasCrop ? {} : { searchRegion: null }) });
        }
      }
      // Shared reply message with SheetPanel's WaitImage ROI — the autoregion- requestId + this
      // per-panel ref guard keep the two listeners from crossing wires.
      if (msg.type === 'waitimage:searchRegionSet' && msg.payload.requestId === regionReqRef.current) {
        regionReqRef.current = null;
        const r = msg.payload;
        if (!r.cancelled && r.w && r.h && r.w > 0 && r.h > 0) {
          patch({ searchRegion: { x: r.x ?? 0, y: r.y ?? 0, w: r.w, h: r.h } });
        }
      }
      // Test match reply (shared type with SheetPanel; testMatchReqRef guards it). On a hit, snap the
      // search region to an 80px box around where the image was found — one click sets the ROI right.
      if (msg.type === 'image:testMatchResult' && msg.payload.requestId === testMatchReqRef.current) {
        testMatchReqRef.current = null;
        const r = msg.payload;
        setTestMatchResult({ found: r.found, score: r.score, error: r.error });
        if (r.found) {
          // No Math.max(0,…): watcher coords are ABSOLUTE virtual-screen and go negative on a monitor
          // left of / above the primary; the backend MatchOnce clamps the ROI to the bitmap itself.
          const m = 80;
          patch({ searchRegion: { x: r.x - m, y: r.y - m, w: r.w + m * 2, h: r.h + m * 2 } });
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe]);

  // Drop a stale test-match badge when switching automations.
  useEffect(() => { setTestMatchResult(null); }, [selected]);

  const pickPixel = () => {
    const id = `autopix-${Date.now()}`;
    pickReqRef.current = id;
    // absolute: watcher coords are virtual-screen — the profile-relative translation
    // the If/WaitPixel editors want would store coords the daemon samples wrongly.
    send({ type: 'pixel:pickColor', payload: { requestId: id, absolute: true } });
  };
  const captureImage = () => {
    if (!selected) return;
    const id = `autoimg-${Date.now()}`;
    captureReqRef.current = id;
    send({ type: 'automation:captureImage', payload: { requestId: id, profile: selected } });
  };
  const configureRegion = () => {
    if (!selected) return;
    const id = `autoregion-${Date.now()}`;
    regionReqRef.current = id;
    // absolute: watcher ROI is virtual-screen coords (the backend skips the rel-coords round-trip).
    const r = draft?.searchRegion;
    send({ type: 'waitimage:configureSearchRegion', payload: { requestId: id, absolute: true, ...(r ? { x: r.x, y: r.y, w: r.w, h: r.h } : {}) } });
  };
  // Crop the current reference tighter — the backend replies over automation:imageCaptured (new
  // path + thumbnail), so reuse captureReqRef to match it. rect is image-pixel coords from the cropper.
  const cropReference = (rect: { x: number; y: number; w: number; h: number }) => {
    if (!selected || !draft?.imagePath) { setCropperOpen(false); return; }
    const id = `autocrop-${Date.now()}`;
    captureReqRef.current = id;
    send({ type: 'automation:cropReference', payload: { requestId: id, profile: selected, imagePath: draft.imagePath, ...rect } });
    setCropperOpen(false);
  };
  const testMatch = () => {
    if (!selected || !draft?.imagePath) return;
    const id = `autotest-${Date.now()}`;
    testMatchReqRef.current = id;
    setTestMatchResult(null);
    // absolute + profile: the test image lives under the trigger's profile and its coords are
    // virtual-screen (the backend skips the rel-coords round-trip and reports absolute).
    const r = draft.searchRegion;
    send({ type: 'image:testMatch', payload: { requestId: id, absolute: true, profile: selected, imagePath: draft.imagePath, confidence: draft.imageConfidence || 0.8, ...(r ? { searchRegion: r } : {}) } });
  };

  const selectedEntry = selected ? entryByProfile.get(selected) : undefined;
  const selectedProfile = selected ? profiles.find((p) => p.name === selected) : undefined;
  const noTarget = selectedProfile ? !selectedProfile.hasEffectiveTarget : false;

  return (
    <>
    <DialogShell
      icon={<Zap size={14} className="text-accent-light" />}
      title="Automation"
      widthClass="w-[880px] h-[82vh] max-h-[780px]"
      maxWidthClass="max-w-[calc(100vw-24px)]"
      onClose={onClose}
      closeOnBackdrop={false}
      showClose
      footer={() => (
        <>
          <div className="flex items-center gap-2 mr-auto">
            <Toggle isOn={automation.enabled}
              onChange={(v) => send({ type: 'automation:setEnabled', payload: { enabled: v } })} />
            <span className="text-[12px] text-text-secondary">Automations enabled</span>
          </div>
          <Button variant="secondary" onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={handleSave} disabled={!selected || !draft || !dirty}>Save</Button>
        </>
      )}
    >
      <div className="flex h-full min-h-0">
        {/* ── Left: automations list ── */}
        <div className="w-72 shrink-0 border-r border-border-subtle flex flex-col min-h-0">
          <div className="p-2 border-b border-border-subtle">
            {addOpen ? (
              <select
                autoFocus
                className={inputCls}
                value=""
                onChange={(e) => {
                  const name = e.target.value;
                  setAddOpen(false);
                  if (!name) return;
                  setNewDraftProfile(name);
                  setSelected(name);
                }}
                onBlur={() => setAddOpen(false)}
              >
                <option value="">{tt('Pick a profile…', 'Escolha um profile…')}</option>
                {profilesWithoutTrigger.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => setAddOpen(true)}
                disabled={profilesWithoutTrigger.length === 0}>
                <Plus size={12} /> Add automation
              </Button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto">
            {listProfiles.length === 0 && (
              <div className="p-4 text-[12px] text-text-tertiary leading-relaxed">
                {tt('No automations yet. Add one to fire a profile on a timer, a clock schedule, or a watched condition — no hotkey press needed.',
                  'Nenhuma automação ainda. Adicione uma para disparar um profile por timer, horário ou condição vigiada — sem apertar hotkey.')}
              </div>
            )}
            {listProfiles.map((name) => {
              const entry = entryByProfile.get(name);
              const trig = name === newDraftProfile && !entry ? null : entry?.trigger;
              const isSel = selected === name;
              return (
                <div
                  key={name}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelected(name)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(name); } }}
                  className={`w-full text-left px-3 py-2 border-b border-border-subtle/60 transition-colors cursor-pointer ${
                    isSel ? 'bg-bg-elevated' : 'hover:bg-bg-elevated/50'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] text-text-primary truncate flex-1">{name}</span>
                    {entry ? (
                      <span onClick={(e) => e.stopPropagation()}
                        data-tip={entry.isDisabled
                          ? tt('Profile is disabled — enable it in the sidebar before arming.', 'Profile desativado — reative na barra lateral antes de armar.')
                          : undefined}>
                        <Toggle size="sm" isOn={entry.trigger.armed} disabled={entry.isDisabled}
                          onChange={(v) => send({ type: 'automation:setArmed', payload: { profile: name, armed: v } })} />
                      </span>
                    ) : (
                      <span className="text-[10px] text-text-tertiary uppercase">{tt('new', 'novo')}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-text-tertiary">
                    {entry?.running && (
                      <CircleDot size={10}
                        className={entry.conditionTrue ? 'text-[var(--color-replay)]' : 'text-accent-light'} />
                    )}
                    <span className="truncate">
                      {trig ? kindSummary(trig, tt) : tt('not saved yet', 'ainda não salvo')}
                      {entry && entry.fireCount > 0 && ` · ${entry.fireCount}× · ${fmtWhen(entry.lastFiredAt)}`}
                      {entry?.trigger.armed && entry.nextDueAt && ` · ${tt('next', 'próx.')} ${fmtWhen(entry.nextDueAt)}`}
                    </span>
                  </div>
                  {entry?.lastResult && entry.lastResult !== 'fired' && (
                    <div className="text-[10px] text-text-tertiary mt-0.5 truncate">{entry.lastResult}</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Right: editor ── */}
        <div className="flex-1 min-w-0 overflow-y-auto p-4">
          {!selected || !draft ? (
            <div className="h-full flex items-center justify-center text-[12px] text-text-tertiary">
              {tt('Select an automation on the left, or add one.', 'Selecione uma automação à esquerda, ou adicione uma.')}
            </div>
          ) : (
            // key={selected} for the same reason SettingsPanel keys its tab content:
            // without it, picking a different automation keeps this subtree mounted and
            // React reuses every node by position. The "Foreground only" Toggle would then
            // slide its knob (transition-[left], 150ms) as the new automation's value
            // replaced the old one — a switch animating on a control the user never
            // touched. draft/selected live in this component, not in the subtree, so
            // remounting costs nothing.
            // key={selected} for the same reason SettingsPanel keys its tab content:
            // without it, picking a different automation keeps this subtree mounted and
            // React reuses every node by position — measured: 49 of 49 nodes survive the
            // switch. The "Foreground only" Toggle would then slide its knob
            // (transition-[left], 150ms) as the new automation's value replaced the old
            // one, i.e. a switch animating on a control the user never touched. draft and
            // selected live in this component, not in the subtree, so remounting is free.
            <div key={selected} className="flex flex-col gap-4 max-w-[520px]">
              <div className="flex items-center justify-between">
                <div className="text-[13px] font-medium text-text-primary truncate">{selected}</div>
                <Button variant="ghost" size="sm" onClick={handleRemove}
                  data-tip={tt('Remove this automation (the profile itself is untouched)', 'Remove esta automação (o profile em si não é tocado)')}>
                  <Trash2 size={12} />
                </Button>
              </div>

              {selectedEntry?.isDisabled && (
                <div className="rounded border px-3 py-2 text-[11px] leading-relaxed"
                  style={{
                    color: 'var(--color-recording)',
                    borderColor: 'color-mix(in srgb, var(--color-recording) 40%, transparent)',
                    backgroundColor: 'color-mix(in srgb, var(--color-recording) 10%, transparent)',
                  }}>
                  {tt('This profile is DISABLED — its automation never runs (and cannot be armed) until you enable the profile in the sidebar.',
                    'Este profile está DESATIVADO — a automação dele nunca roda (nem pode ser armada) até você reativá-lo na barra lateral.')}
                </div>
              )}

              {noTarget && (
                <div className="rounded border px-3 py-2 text-[11px] leading-relaxed"
                  style={{
                    color: 'var(--color-recording)',
                    borderColor: 'color-mix(in srgb, var(--color-recording) 40%, transparent)',
                    backgroundColor: 'color-mix(in srgb, var(--color-recording) 10%, transparent)',
                  }}>
                  {tt('This profile has no target window — when the trigger fires, it acts on whichever window happens to be focused.',
                    'Este profile não tem janela-alvo — quando o gatilho disparar, ele age sobre a janela que estiver em foco.')}
                </div>
              )}

              <Field label="Trigger">
                <SegmentedControl
                  ariaLabel="Trigger kind"
                  grow
                  value={draft.kind}
                  onChange={(v) => patch({ kind: v as TriggerConfig['kind'] })}
                  options={[
                    { value: 'interval', label: 'Interval', tip: tt('Fire every N seconds/minutes', 'Dispara a cada N segundos/minutos') },
                    { value: 'schedule', label: 'Schedule', tip: tt('Fire at a clock time on chosen weekdays', 'Dispara em um horário nos dias escolhidos') },
                    { value: 'condition', label: 'Condition', tip: tt('Watch the screen/system and fire when a condition becomes true', 'Vigia a tela/sistema e dispara quando a condição fica verdadeira') },
                  ]}
                />
              </Field>

              {draft.kind === 'interval' && (
                <Field label="Every" hint={tt('Minimum 5 seconds. The first fire happens one interval after arming.', 'Mínimo 5 segundos. O primeiro disparo ocorre um intervalo após armar.')}>
                  <NumberInput
                    value={draft.intervalSeconds}
                    onChange={(v) => patch({ intervalSeconds: Math.max(5, v ?? 5) })}
                    min={5}
                    max={86400}
                    suffix="s"
                    inputWidth="w-24"
                  />
                </Field>
              )}

              {draft.kind === 'schedule' && (
                <>
                  <Field label="At">
                    <input
                      type="time"
                      className={`${inputCls} w-28`}
                      value={draft.timeOfDay ?? ''}
                      onChange={(e) => patch({ timeOfDay: e.target.value })}
                    />
                  </Field>
                  <Field label="Days" hint={tt('None selected = every day.', 'Nenhum selecionado = todos os dias.')}>
                    <div className="flex gap-1">
                      {DAY_PILLS.map((d) => {
                        const on = (draft.daysOfWeek & d.bit) !== 0;
                        return (
                          <button
                            key={d.label}
                            type="button"
                            onClick={() => patch({ daysOfWeek: draft.daysOfWeek ^ d.bit })}
                            className={`h-7 px-2 rounded text-[11px] border transition-colors ${
                              on
                                ? 'bg-accent-solid border-accent-solid text-white'
                                : 'bg-bg-input border-border-subtle text-text-secondary hover:border-border-strong'
                            }`}
                          >
                            {d.label}
                          </button>
                        );
                      })}
                    </div>
                  </Field>
                </>
              )}

              {draft.kind === 'condition' && (
                <>
                  <Field label="Condition">
                    <select
                      className={inputCls}
                      value={draft.conditionType ?? 'WindowOpen'}
                      onChange={(e) => patch({ conditionType: e.target.value })}
                    >
                      {CONDITION_TYPES.map((c) => (
                        <option key={c.value} value={c.value}>{c.label}</option>
                      ))}
                    </select>
                  </Field>

                  {draft.conditionType === 'WindowOpen' && (
                    <>
                      <WindowTargetFields
                        value={{
                          processName: draft.windowProcessName ?? '',
                          windowTitle: draft.windowTitle ?? '',
                          titleMatchMode: draft.windowTitleMatchMode === 'regex' ? 'regex' : 'contains',
                        }}
                        onChange={(p) =>
                          patch({
                            ...(p.processName !== undefined ? { windowProcessName: p.processName } : {}),
                            ...(p.windowTitle !== undefined ? { windowTitle: p.windowTitle } : {}),
                            ...(p.titleMatchMode !== undefined ? { windowTitleMatchMode: p.titleMatchMode } : {}),
                          })
                        }
                      />
                      <div className="flex items-center gap-2">
                        <Toggle size="sm" isOn={draft.windowMatchForegroundOnly}
                          onChange={(v) => patch({ windowMatchForegroundOnly: v })} />
                        <span className="text-[12px] text-text-secondary"
                          data-tip={tt('Only match when the window is in the FOREGROUND (instead of open anywhere).', 'Só considera quando a janela está em PRIMEIRO PLANO (em vez de aberta em qualquer lugar).')}>
                          Foreground only
                        </span>
                      </div>
                    </>
                  )}

                  {draft.conditionType === 'ProcessRunning' && (
                    <Field label="Process" hint={tt('Image name, e.g. "notepad" or "RobloxPlayerBeta.exe".', 'Nome do processo, ex. "notepad" ou "RobloxPlayerBeta.exe".')}>
                      <input
                        className={inputCls}
                        value={draft.windowProcessName ?? ''}
                        onChange={(e) => patch({ windowProcessName: e.target.value })}
                        placeholder="app.exe"
                      />
                    </Field>
                  )}

                  {draft.conditionType === 'FileExists' && (
                    <Field label="Path" hint={tt('Full path of a file or folder. Fires when it appears.', 'Caminho completo de arquivo ou pasta. Dispara quando ele aparece.')}>
                      <input
                        className={inputCls}
                        value={draft.filePath ?? ''}
                        onChange={(e) => patch({ filePath: e.target.value })}
                        placeholder="C:\\path\\to\\flag.txt"
                      />
                    </Field>
                  )}

                  {draft.conditionType === 'PixelColorMatch' && (
                    <>
                      <div className="flex items-end gap-2">
                        <Field label="X">
                          <NumberInput value={draft.pixelX} onChange={(v) => patch({ pixelX: v ?? 0 })}
                            min={-20000} max={20000} inputWidth="w-20" />
                        </Field>
                        <Field label="Y">
                          <NumberInput value={draft.pixelY} onChange={(v) => patch({ pixelY: v ?? 0 })}
                            min={-20000} max={20000} inputWidth="w-20" />
                        </Field>
                        <Field label="Color">
                          <input
                            className={`${inputCls} w-24 font-mono`}
                            value={draft.pixelColor ?? ''}
                            onChange={(e) => patch({ pixelColor: e.target.value })}
                            placeholder="#RRGGBB"
                          />
                        </Field>
                        <Button variant="secondary" size="sm" onClick={pickPixel}
                          data-tip={tt('Pick a pixel from the screen (sets X, Y and color)', 'Escolher um pixel na tela (define X, Y e cor)')}>
                          <Pipette size={12} /> Pick
                        </Button>
                      </div>
                      <Field label="Tolerance" hint={tt('Per-channel color tolerance (0 = exact).', 'Tolerância por canal de cor (0 = exata).')}>
                        <NumberInput value={draft.pixelTolerance} onChange={(v) => patch({ pixelTolerance: v ?? 10 })}
                          min={0} max={255} inputWidth="w-20" />
                      </Field>
                    </>
                  )}

                  {draft.conditionType === 'ImageFound' && (
                    <>
                      <Field label="Reference image">
                        <div
                          onClick={() => draft.imageBase64 && setCropperOpen(true)}
                          data-tip={draft.imageBase64 ? tt('Click to crop tighter', 'Clique para recortar mais justo') : undefined}
                          className={draft.imageBase64
                            ? 'w-full rounded border border-border-subtle bg-bg-input p-1 cursor-pointer hover:border-accent-solid transition-colors'
                            : `${inputCls} flex items-center text-text-tertiary truncate`}>
                          {draft.imageBase64
                            ? <img src={`data:image/png;base64,${draft.imageBase64}`} alt="" className="max-h-[120px] w-full object-contain" />
                            : (draft.imagePath ?? tt('none captured', 'nenhuma capturada'))}
                        </div>
                      </Field>
                      <div className="flex gap-2">
                        <Button variant="secondary" size="sm" onClick={captureImage}
                          data-tip={tt('Capture a region of the screen to watch for', 'Capturar uma região da tela para vigiar')}>
                          <Camera size={12} /> Capture
                        </Button>
                        <Button variant="secondary" size="sm" onClick={testMatch} disabled={!draft.imagePath}
                          data-tip={tt('Search the screen now — on a hit, snaps the region to the match', 'Procura na tela agora — se achar, ajusta a região no ponto do match')}>
                          <ScanSearch size={12} /> Test match
                        </Button>
                      </div>
                      {testMatchResult && (
                        <div className={`flex items-center gap-1.5 text-[11px] ${testMatchResult.found ? 'text-accent-light' : 'text-text-tertiary'}`}>
                          {testMatchResult.found ? <Check size={12} /> : <X size={12} />}
                          {testMatchResult.error
                            ? testMatchResult.error
                            : testMatchResult.found
                              ? `${tt('Found', 'Encontrado')} (${Math.round(testMatchResult.score * 100)}%) — ${tt('region snapped to it', 'região ajustada no ponto')}`
                              : `${tt('Not found on screen', 'Não encontrado na tela')} (${Math.round(testMatchResult.score * 100)}%)`}
                        </div>
                      )}
                      <Field label="Search region" hint={tt('Limit matching to a screen region — faster and fewer false positives for a background watcher. Empty = full screen.', 'Limita a busca a uma região da tela — mais rápido e menos falso-positivo num vigia de fundo. Vazio = tela inteira.')}>
                        <div className="flex items-center gap-2">
                          <div className={`${inputCls} flex-1 flex items-center ${draft.searchRegion ? 'font-mono text-[11px]' : 'text-text-disabled italic'}`}>
                            {draft.searchRegion
                              ? `${draft.searchRegion.x}, ${draft.searchRegion.y}  ·  ${draft.searchRegion.w} × ${draft.searchRegion.h}`
                              : tt('Full screen (default)', 'Tela inteira (padrão)')}
                          </div>
                          <Button variant="secondary" size="sm" onClick={configureRegion}>
                            <Frame size={12} /> {tt('Configure', 'Configurar')}
                          </Button>
                          {draft.searchRegion && (
                            <button type="button" onClick={() => patch({ searchRegion: null })}
                              data-tip={tt('Clear region (search full screen)', 'Limpar região (buscar tela inteira)')}
                              className="h-7 w-7 shrink-0 flex items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-bg-elevated transition-colors">
                              <X size={13} />
                            </button>
                          )}
                        </div>
                      </Field>
                      <Field label="Confidence" hint={tt('Match threshold. 80% is a good start; 100% never matches a live screen.', 'Limiar de match. 80% é um bom começo; 100% nunca bate numa tela real.')}>
                        <NumberInput
                          value={Math.round((draft.imageConfidence || 0.8) * 100)}
                          onChange={(v) => patch({ imageConfidence: Math.min(99, Math.max(10, v ?? 80)) / 100 })}
                          min={10} max={99} suffix="%" inputWidth="w-20"
                        />
                      </Field>
                    </>
                  )}

                  {draft.conditionType === 'ClipboardChanged' && (
                    <Field label="Contains" hint={tt('Optional filter — empty fires on ANY clipboard change. App-made clipboard traffic (replays, capture-slot) never counts.', 'Filtro opcional — vazio dispara em QUALQUER mudança. Tráfego do próprio app (replays, capture-slot) nunca conta.')}>
                      <input
                        className={inputCls}
                        value={draft.clipboardPattern ?? ''}
                        onChange={(e) => patch({ clipboardPattern: e.target.value })}
                        placeholder={tt('text the clipboard must contain', 'texto que o clipboard deve conter')}
                      />
                    </Field>
                  )}

                  {draft.conditionType !== 'ClipboardChanged' && (
                    <Field label="Re-trigger">
                      <SegmentedControl
                        ariaLabel="Retrigger mode"
                        grow
                        value={draft.retrigger === 'level' ? 'level' : 'edge'}
                        onChange={(v) => patch({ retrigger: v })}
                        options={[
                          { value: 'edge', label: 'Once per appearance', tip: tt('Fires once when the condition becomes true; must turn false before it can fire again.', 'Dispara uma vez quando a condição fica verdadeira; precisa ficar falsa antes de disparar de novo.') },
                          { value: 'level', label: 'Continuous', tip: tt('Keeps firing every cooldown while the condition stays true.', 'Continua disparando a cada cooldown enquanto a condição fica verdadeira.') },
                        ]}
                      />
                    </Field>
                  )}

                  <Field label="Cooldown" hint={tt('Minimum gap between fires. 0 = default (30 s).', 'Intervalo mínimo entre disparos. 0 = padrão (30 s).')}>
                    <NumberInput value={draft.cooldownSeconds} onChange={(v) => patch({ cooldownSeconds: v ?? 0 })}
                      min={0} max={86400} suffix="s" inputWidth="w-24" />
                  </Field>
                </>
              )}

              <div className="pt-2 border-t border-border-subtle text-[11px] text-text-tertiary leading-relaxed"
                data-tip={tt('Armed automations run in the background (and re-arm at startup) while the master switch is on. Arming is local to this machine — imports and copies always arrive disarmed.',
                  'Automações armadas rodam em segundo plano (e re-armam ao iniciar) com a chave mestra ligada. Armar é local desta máquina — imports e cópias sempre chegam desarmados.')}>
                {tt('Arm or disarm with the toggle on the list row — it takes effect immediately, independent of Save.',
                  'Arme ou desarme pelo toggle na linha da lista — vale imediatamente, independente do Save.')}
              </div>

              {selectedEntry && (selectedEntry.skippedBusy > 0 || selectedEntry.skippedDirty > 0 || selectedEntry.skippedModal > 0) && (
                <div className="text-[11px] text-text-tertiary leading-relaxed">
                  {tt('Skipped fires', 'Disparos pulados')}: {selectedEntry.skippedBusy} {tt('busy', 'ocupado')} ·{' '}
                  {selectedEntry.skippedDirty} {tt('unsaved changes', 'mudanças não salvas')} ·{' '}
                  {selectedEntry.skippedModal} {tt('dialog open', 'diálogo aberto')}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </DialogShell>
    {cropperOpen && draft?.imageBase64 && (
      <ImageCropper
        imageBase64={draft.imageBase64}
        onSave={cropReference}
        onCancel={() => setCropperOpen(false)}
      />
    )}
    </>
  );
}
