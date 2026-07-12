import { splitCombo } from './KbdTag';

/**
 * Hero key-caps for the capture dialogs' pads — one big cap per key, joined by
 * '+'. Deliberately NOT KbdTag (that's the 20px inline tag; these are the
 * headline caps). Was duplicated verbatim in KeystrokeCaptureDialog and
 * PauseDialog; sharing it also fixes two display bugs for free: the literal
 * '+' key now renders (splitCombo) and Pause shows "Menu" instead of raw
 * "VK_93". Display-only — the raw combo stays in state and payloads.
 */
interface KeyCapsProps {
  combo: string;
  /** Cap glyph color, e.g. 'var(--color-action-key-fg)'. */
  fg: string;
}

export function KeyCaps({ combo, fg }: KeyCapsProps) {
  const parts = splitCombo(combo.replace(/\bVK_93\b/, 'Menu'));
  return (
    <div className="inline-flex items-center justify-center self-center gap-1 flex-wrap">
      {parts.map((part, i) => (
        <span key={`${part}-${i}`} className="inline-flex items-center gap-1">
          <kbd
            className="inline-block px-2.5 py-1 bg-bg-elevated border border-border-default rounded font-mono text-[13px] font-semibold shadow-[0_2px_0_var(--color-border-default)]"
            style={{ color: fg }}
          >
            {part}
          </kbd>
          {i < parts.length - 1 && <span className="text-text-tertiary text-[12px]">+</span>}
        </span>
      ))}
    </div>
  );
}
