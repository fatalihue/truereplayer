import { useState, useEffect, useRef, useMemo } from 'react';
import { Info, Smile, Hash, X } from 'lucide-react';
import EmojiPicker, { Theme as EmojiTheme, EmojiStyle } from 'emoji-picker-react';
import { useBridge } from '../bridge/BridgeContext';
import type { ProfileMetadataPayload, TagListEntry } from '../bridge/messageTypes';

interface ProfileInfoDialogProps {
  /** Profile name to edit metadata for. Triggers a profile:getMetadata fetch on mount. */
  profileName: string;
  onClose: () => void;
}

const MAX_DESCRIPTION = 200;
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 32;
/** Same regex the backend uses to validate tags. Keep in sync with HandleProfileSetMetadata. */
const TAG_REGEX = /^[a-z0-9\-_+.]+$/;

/**
 * Profile Info / Sharing Metadata editor. Lets the user set:
 *   - Icon emoji (single emoji, picked from emoji-picker-react)
 *   - Description (free text, capped at 200 chars in the UI / 500 backend)
 *   - Tags (lowercased free text with autocomplete from other profiles' tags)
 *   - Profile version (read-only display + Bump button)
 *
 * Created / Updated / AppMinVersion are read-only — the bridge computes / stamps them.
 *
 * Save model: the dialog edits a local copy and only calls profile:setMetadata when
 * the user clicks Save. Cancel discards. This keeps a noisy textarea from triggering
 * a disk write per keystroke.
 */
export function ProfileInfoDialog({ profileName, onClose }: ProfileInfoDialogProps) {
  const { send, subscribe } = useBridge();

  const [loaded, setLoaded] = useState(false);
  const [original, setOriginal] = useState<ProfileMetadataPayload | null>(null);

  // Edit-buffer state
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState('');
  const [iconEmoji, setIconEmoji] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  // Tag autocomplete source — populated on mount from profile:listTags.
  const [allTags, setAllTags] = useState<TagListEntry[]>([]);
  const [showTagSuggestions, setShowTagSuggestions] = useState(false);

  const tagInputRef = useRef<HTMLInputElement>(null);

  // Fetch metadata + tag list on mount. Re-fetches if the profile name changes
  // (caller usually unmounts/remounts, but guard for hot-reload).
  useEffect(() => {
    send({ type: 'profile:getMetadata', payload: { name: profileName } });
    send({ type: 'profile:listTags', payload: {} });
  }, [profileName, send]);

  // Subscribe to bridge replies — handles both the metadata and the tag list.
  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === 'profile:metadata' && msg.payload.name === profileName) {
        const m = msg.payload;
        setOriginal(m);
        setDescription(m.description ?? '');
        setTags(m.tags ?? []);
        setIconEmoji(m.iconEmoji ?? null);
        setLoaded(true);
      } else if (msg.type === 'profile:tagList') {
        setAllTags(msg.payload.tags);
      }
      // profile:versionBumped intentionally not consumed in 2.2.0 — the bump UI was removed.
      // Re-add the handler when the share-via-link / marketplace path resurfaces the bump button.
    });
  }, [subscribe, profileName]);

  // Autocomplete candidates: filter local-known tags by the current draft, exclude
  // already-selected ones. Cap at 8 suggestions so the dropdown stays compact.
  const suggestions = useMemo(() => {
    const draft = tagDraft.trim().toLowerCase();
    return allTags
      .filter(t => !tags.includes(t.tag))
      .filter(t => draft === '' || t.tag.includes(draft))
      .slice(0, 8);
  }, [allTags, tags, tagDraft]);

  const addTag = (raw: string) => {
    const cleaned = raw.trim().toLowerCase();
    if (!cleaned || !TAG_REGEX.test(cleaned)) return;
    if (cleaned.length > MAX_TAG_LENGTH) return;
    if (tags.includes(cleaned)) return;
    if (tags.length >= MAX_TAGS) return;
    setTags(prev => [...prev, cleaned]);
    setTagDraft('');
  };

  const removeTag = (tag: string) => {
    setTags(prev => prev.filter(t => t !== tag));
  };

  const handleTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
      if (tagDraft.trim()) {
        e.preventDefault();
        addTag(tagDraft);
      }
    } else if (e.key === 'Backspace' && tagDraft === '' && tags.length > 0) {
      // Backspace on empty input removes the last tag — matches GitHub / Twitter UX.
      removeTag(tags[tags.length - 1]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (showTagSuggestions) {
        setShowTagSuggestions(false);
      } else {
        onClose();
      }
    }
  };

  const handleSave = () => {
    // Only send fields that actually changed — keeps the diff minimal and avoids
    // touching UpdatedAt when the user just opened the dialog and closed it.
    const payload: { name: string; description?: string | null; tags?: string[] | null; iconEmoji?: string | null } = {
      name: profileName,
    };
    if (description !== (original?.description ?? '')) {
      payload.description = description.trim() || null;
    }
    const originalTags = JSON.stringify(original?.tags ?? []);
    const currentTags = JSON.stringify(tags);
    if (originalTags !== currentTags) {
      payload.tags = tags.length > 0 ? tags : null;
    }
    if ((iconEmoji ?? null) !== (original?.iconEmoji ?? null)) {
      payload.iconEmoji = iconEmoji;
    }

    if (Object.keys(payload).length > 1) {
      send({ type: 'profile:setMetadata', payload });
    }
    onClose();
  };

  // The emoji picker (emoji-picker-react) swallows Escape internally to clear its own search box,
  // so the key never reaches handleKeyDown below. Catch it at the document level in CAPTURE phase
  // while the picker is open and close it ourselves before the picker's handler runs.
  useEffect(() => {
    if (!showEmojiPicker) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setShowEmojiPicker(false);
      }
    };
    document.addEventListener('keydown', onEsc, true);
    return () => document.removeEventListener('keydown', onEsc, true);
  }, [showEmojiPicker]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    // Escape closes the emoji picker first when it's open — previously this was a dead no-op
    // (neither the dialog nor the picker closed). Only close the dialog when no popover is open.
    if (showEmojiPicker) {
      e.preventDefault();
      setShowEmojiPicker(false);
      return;
    }
    if (!showTagSuggestions) {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onKeyDown={(e) => e.stopPropagation()}
      onClick={onClose}
    >
      <div
        className="bg-bg-elevated border border-border-subtle rounded-lg shadow-xl w-[560px] max-w-[95vw] max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle">
          <Info size={14} className="text-[#60cdff]" />
          <h3 className="text-sm font-semibold text-text-primary">Profile Info — {profileName}</h3>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {!loaded ? (
            <div className="text-xs text-text-tertiary py-4 text-center">Loading…</div>
          ) : (
            <>
              {/* Icon + Version row */}
              <div className="flex gap-4">
                <div className="flex flex-col gap-1">
                  <label className="text-[11px] text-text-tertiary uppercase tracking-wide">Icon</label>
                  <button
                    type="button"
                    onClick={() => setShowEmojiPicker(v => !v)}
                    className="w-12 h-12 flex items-center justify-center text-2xl bg-bg-input border border-border-subtle rounded hover:border-accent-solid transition-colors"
                    data-tip="Pick an emoji"
                  >
                    {iconEmoji || <Smile size={18} className="text-text-tertiary" />}
                  </button>
                  {iconEmoji && (
                    <button
                      type="button"
                      onClick={() => setIconEmoji(null)}
                      className="text-[10px] text-text-tertiary hover:text-text-primary transition-colors"
                    >
                      Clear
                    </button>
                  )}
                </div>

                <div className="flex-1 flex flex-col gap-1">
                  <label className="text-[11px] text-text-tertiary uppercase tracking-wide">Version</label>
                  {/* Display-only for now. Bump UI was removed in 2.2.0 because the app has no
                      update-detection consumer yet — re-add when share-via-link / marketplace
                      lands and "newer version available" notifications become possible. The
                      profile:bumpVersion bridge handler still exists for that future use. */}
                  <div className="flex items-center h-12">
                    <span className="text-base font-medium text-text-primary">v{original?.profileVersion ?? 1}</span>
                  </div>
                </div>
              </div>

              {/* Emoji picker dropdown */}
              {showEmojiPicker && (
                <div className="border border-border-subtle rounded overflow-hidden">
                  <EmojiPicker
                    onEmojiClick={(emojiData) => {
                      setIconEmoji(emojiData.emoji);
                      setShowEmojiPicker(false);
                    }}
                    theme={EmojiTheme.DARK}
                    emojiStyle={EmojiStyle.NATIVE}
                    width="100%"
                    height={320}
                    previewConfig={{ showPreview: false }}
                    searchPlaceholder="Search emoji…"
                  />
                </div>
              )}

              {/* Description */}
              <div className="flex flex-col gap-1">
                <label className="text-[11px] text-text-tertiary uppercase tracking-wide">Description</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value.slice(0, MAX_DESCRIPTION))}
                  placeholder="What does this profile do?"
                  rows={3}
                  className="w-full px-3 py-2 text-xs text-text-primary bg-bg-input border border-border-subtle rounded outline-none focus:border-accent-solid placeholder:text-text-disabled transition-colors resize-none"
                />
                <div className="text-[10px] text-text-tertiary text-right">
                  {description.length} / {MAX_DESCRIPTION}
                </div>
              </div>

              {/* Tags */}
              <div className="flex flex-col gap-1 relative">
                <label className="text-[11px] text-text-tertiary uppercase tracking-wide">Tags</label>
                <div className="flex flex-wrap gap-1 px-2 py-2 bg-bg-input border border-border-subtle rounded focus-within:border-accent-solid transition-colors">
                  {tags.map(t => (
                    <span
                      key={t}
                      className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded bg-bg-surface text-text-primary border border-border-subtle"
                    >
                      <Hash size={10} className="text-text-tertiary" />
                      {t}
                      <button
                        type="button"
                        onClick={() => removeTag(t)}
                        className="hover:text-amber-400 transition-colors"
                        data-tip="Remove"
                      >
                        <X size={10} />
                      </button>
                    </span>
                  ))}
                  <input
                    ref={tagInputRef}
                    type="text"
                    value={tagDraft}
                    onChange={(e) => setTagDraft(e.target.value.toLowerCase())}
                    onKeyDown={handleTagKeyDown}
                    onFocus={() => setShowTagSuggestions(true)}
                    onBlur={() => setTimeout(() => setShowTagSuggestions(false), 150)}
                    placeholder={tags.length === 0 ? 'Add a tag…' : ''}
                    disabled={tags.length >= MAX_TAGS}
                    className="flex-1 min-w-[100px] bg-transparent text-xs text-text-primary outline-none placeholder:text-text-disabled disabled:opacity-50"
                  />
                </div>
                <div className="flex items-center justify-between text-[10px] text-text-tertiary">
                  <span>
                    Press Enter or comma to add. {tags.length} / {MAX_TAGS}
                  </span>
                </div>

                {/* Autocomplete dropdown */}
                {showTagSuggestions && suggestions.length > 0 && (
                  <div className="absolute top-full mt-1 left-0 right-0 z-10 bg-bg-elevated border border-border-subtle rounded shadow-lg max-h-[180px] overflow-y-auto">
                    {suggestions.map(s => (
                      <button
                        key={s.tag}
                        type="button"
                        onMouseDown={(e) => {
                          // onMouseDown (not onClick) so it fires before input blur clears the dropdown.
                          e.preventDefault();
                          addTag(s.tag);
                          tagInputRef.current?.focus();
                        }}
                        className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-surface transition-colors"
                      >
                        <span className="flex items-center gap-1.5">
                          <Hash size={10} className="text-text-tertiary" />
                          {s.tag}
                        </span>
                        <span className="text-[10px] text-text-tertiary">
                          used {s.count}×
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Read-only metadata */}
              <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border-subtle">
                <ReadOnlyField label="Created" value={formatDateLong(original?.createdAt)} />
                <ReadOnlyField label="Updated" value={formatDateLong(original?.updatedAt)} />
                <div className="col-span-2">
                  <ReadOnlyField
                    label="Min app version"
                    value={original?.appMinVersion ?? 'Any (no special requirements)'}
                    hint={
                      original?.appMinVersionContributors && original.appMinVersionContributors.length > 0
                        ? `Required by: ${original.appMinVersionContributors.join(', ')}`
                        : undefined
                    }
                  />
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border-subtle">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-medium text-text-secondary bg-bg-card hover:bg-bg-surface border border-border-subtle rounded transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!loaded}
            className="px-4 py-1.5 text-xs font-medium text-white bg-accent-solid hover:bg-accent-solid/80 rounded transition-colors disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function ReadOnlyField({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <label className="text-[10px] text-text-tertiary uppercase tracking-wide">{label}</label>
      <span className="text-xs text-text-secondary">{value}</span>
      {hint && <span className="text-[10px] text-text-tertiary">{hint}</span>}
    </div>
  );
}

function formatDateLong(iso: string | null | undefined): string {
  if (!iso) return 'Unknown';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return 'Unknown';
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return 'Unknown';
  }
}
