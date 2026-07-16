import { useEffect, useRef, useState } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin';
import { AutoLinkPlugin } from '@lexical/react/LexicalAutoLinkPlugin';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getRoot,
  $getSelection,
  $setSelection,
  $insertNodes,
  $isRangeSelection,
  $isTextNode,
  $isElementNode,
  $createTextNode,
  $createParagraphNode,
  type BaseSelection,
  COMMAND_PRIORITY_LOW,
  FORMAT_TEXT_COMMAND,
  PASTE_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  TextNode,
  type LexicalNode,
  type TextFormatType,
} from 'lexical';
import {
  ListNode,
  ListItemNode,
  $isListNode,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  REMOVE_LIST_COMMAND,
} from '@lexical/list';
import { LinkNode, AutoLinkNode, $isLinkNode, $isAutoLinkNode, $createLinkNode, $toggleLink, TOGGLE_LINK_COMMAND } from '@lexical/link';
import { $generateHtmlFromNodes, $generateNodesFromDOM } from '@lexical/html';
import { $dfs } from '@lexical/utils';
import {
  Bold, Italic, Underline, Strikethrough, Code, List, ListOrdered, Link2, Check, X,
} from 'lucide-react';
import { TokenNode, $createTokenNode, $isTokenNode } from './TokenNode';
import { ClipboardChipEditContext, type ClipboardChipEditRequest } from './TokenChip';

// Tokens recognised by the backend at runtime. Anything outside this set stays
// as plain text — typo'd `{xpto}` shouldn't masquerade as a real token chip.
// {esc} (SendText's literal-brace escape) is deliberately NOT here — chipping
// it would hide the escape mechanism it exists to expose.
const KNOWN_TOKEN_NAMES: ReadonlySet<string> = new Set([
  'clipboard',
  'date',
  'time',
  'datetime',
  'enter',
  'tab',
  'space',
  'backspace',
  'delete',
  'escape',
  'home',
  'end',
  'pageup',
  'pagedown',
  'up',
  'down',
  'left',
  'right',
  'delay',
  'random',
  // Run-state tokens (2.8.0): first-class chips like everything else the
  // backend resolves — {var:name}, {counter}, {row}, {row:column}.
  'var',
  'counter',
  'row',
]);

// Modifier segments allow digits/letters plus ',', '-' and '_' so {Random:1-10},
// {Clipboard:lines:3,1,2} and {var:my_name} chip correctly. Separators with
// other characters (e.g. join:" - ") stay plain text when typed — they still
// work at runtime; chips built via the popover keep chip-ness regardless.
const TOKEN_REGEX = /\{[a-zA-Z]+(?::[a-zA-Z0-9,_-]+)*\}/g;
// Non-global form for single-match .exec() — stateless, so safe to share across calls.
const TOKEN_REGEX_SINGLE = new RegExp(TOKEN_REGEX.source);

// Counts the known-token chips a serialized payload contains — powers the
// "N tokens" figure in the Insert Text status strip. Same regex + whitelist as
// the chipping pipeline so the count always matches what the user sees as chips.
export function countKnownTokens(text: string): number {
  if (!text.includes('{')) return 0;
  let count = 0;
  const regex = new RegExp(TOKEN_REGEX.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const name = match[0].slice(1, -1).split(':')[0].toLowerCase();
    if (KNOWN_TOKEN_NAMES.has(name)) count++;
  }
  return count;
}

export interface LexicalEditorHandle {
  /** Insert text at the current cursor; known `{...}` substrings become chips. */
  insertText: (text: string) => void;
  /**
   * Insert ONE pre-built token as a chip, bypassing the TOKEN_REGEX gate — for
   * popover-built tokens whose modifier args may contain characters the typing
   * grammar doesn't chip (e.g. a join separator of " " or "; "). Plain insertText
   * would drop those as raw text while visually identical configs became chips.
   */
  insertToken: (token: string) => void;
  /** Rich mode: insert an HTML fragment (a rich snippet) at the cursor —
   *  formatting preserved, `<span data-token>` markers re-chip on import. */
  insertHtml: (html: string) => void;
  focus: () => void;
  /**
   * Rich mode only: the document exported as an HTML fragment, or null when it
   * carries NO formatting (no format bits, lists or links) — a null keeps the
   * action a plain SendText, byte-identical to pre-rich behavior. Token chips
   * export as `<span data-token>{token}</span>` (resolved at send time).
   */
  getHtml: () => string | null;
}

interface LexicalTokenEditorProps {
  initialText: string;
  onChange: (text: string) => void;
  onSubmit?: () => void;
  apiRef: React.MutableRefObject<LexicalEditorHandle | null>;
  /** ContentEditable classes. Default = the compact SheetPanel look; the Insert
   *  Text dialog passes its roomier full-bleed recipe. */
  contentClassName?: string;
  /** Placeholder classes — must mirror contentClassName's padding. */
  placeholderClassName?: string;
  /** When provided, clicking a {clipboard...} chip routes HERE instead of the
   *  built-in 300px popover (see ClipboardChipEditContext). */
  onClipboardChipEdit?: (req: ClipboardChipEditRequest) => void;
  /** Rich-text authoring (Insert Text dialog only): RichTextPlugin + formatting
   *  toolbar + list/link nodes. The SheetPanel browserText surface stays plain. */
  richMode?: boolean;
  /** Rich mode: rebuild the document from a saved KeyHtml fragment instead of
   *  the plain initialText (token marker spans re-chip via TokenNode.importDOM). */
  initialHtml?: string | null;
}

// Splits `text` into alternating plain TextNodes and TokenNodes. Unknown tokens
// (matching the syntax but not in KNOWN_TOKEN_NAMES) stay folded into the
// surrounding text run so the user sees their typo as plain text.
function buildNodesFromText(text: string): LexicalNode[] {
  const nodes: LexicalNode[] = [];
  const regex = new RegExp(TOKEN_REGEX.source, 'g');
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const inner = match[0].slice(1, -1);
    const name = inner.split(':')[0].toLowerCase();
    if (!KNOWN_TOKEN_NAMES.has(name)) continue; // unknown — leave as text
    if (match.index > lastIndex) {
      nodes.push($createTextNode(text.slice(lastIndex, match.index)));
    }
    nodes.push($createTokenNode(match[0]));
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    nodes.push($createTextNode(text.slice(lastIndex)));
  }
  return nodes;
}

// Canonical plain payload for RICH mode. root.getTextContent() is WRONG here: Lexical
// joins non-inline block siblings with a DOUBLE line break, and RichTextPlugin's Enter
// creates ParagraphNodes (plain mode created LineBreakNodes) — so a zero-formatting
// multi-line doc would save "line1\n\nline2" and every plain target would paste blank
// lines. Walk top-level blocks and join with a SINGLE '\n'; list items additionally get
// "- " / "N. " markers so the plain flavor of a formatted list reads as a list.
function $serializePlainForSend(): string {
  const lines: string[] = [];
  for (const block of $getRoot().getChildren()) {
    if ($isListNode(block)) {
      const ordered = block.getListType() === 'number';
      block.getChildren().forEach((item, i) => {
        // A nested list inside an item re-introduces '\n\n' via getTextContent — collapse.
        lines.push((ordered ? `${i + 1}. ` : '- ') + item.getTextContent().replace(/\n\n/g, '\n'));
      });
    } else {
      lines.push(block.getTextContent());
    }
  }
  return lines.join('\n');
}

// One-shot population of the editor with the initial value (only runs first time).
// Rich mode with a saved KeyHtml rebuilds the formatted document from the HTML
// fragment (lists/links/format bits restored; `<span data-token>` re-chips via
// TokenNode.importDOM); otherwise the plain text is parsed into text+chip runs.
function InitialContentPlugin({ initialText, initialHtml }: { initialText: string; initialHtml?: string | null }) {
  const [editor] = useLexicalComposerContext();
  const didInit = useRef(false);

  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      if (initialHtml) {
        const dom = new DOMParser().parseFromString(initialHtml, 'text/html');
        const nodes = $generateNodesFromDOM(editor, dom);
        // $insertNodes (not root.append) — the fragment's top level may hold
        // inline nodes, which insertNodes wraps in paragraphs as needed.
        root.select();
        $insertNodes(nodes);
        return;
      }
      const para = $createParagraphNode();
      const nodes = buildNodesFromText(initialText);
      if (nodes.length > 0) para.append(...nodes);
      root.append(para);
    });
  }, [editor, initialText, initialHtml]);

  return null;
}

// Exposes imperative methods to the parent via apiRef.
function ImperativeAPIPlugin({
  apiRef,
}: {
  apiRef: React.MutableRefObject<LexicalEditorHandle | null>;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    // Shared insert plumbing: focus, resolve a usable range selection (falling
    // back to end-of-document when the editor was never focused), insert nodes.
    // Takes a FACTORY, not nodes: $create*Node calls are only legal inside
    // editor.update() — building the nodes outside it throws and the insert
    // silently no-ops (the palette-chip-does-nothing bug).
    const insertNodesAtCursor = (makeNodes: () => LexicalNode[]) => {
      editor.focus();
      editor.update(() => {
        const nodes = makeNodes();
        if (nodes.length === 0) return;
        let selection = $getSelection();
        // Editor never focused yet (e.g. inserting via side-panel button on a
        // fresh dialog) — fall back to the end of the document.
        if (!$isRangeSelection(selection)) {
          const last = $getRoot().getLastChild();
          if (last && $isElementNode(last)) {
            last.selectEnd();
            selection = $getSelection();
          }
        }
        if ($isRangeSelection(selection)) {
          selection.insertNodes(nodes);
        }
      });
    };

    apiRef.current = {
      insertText: (text: string) => insertNodesAtCursor(() => buildNodesFromText(text)),
      // No regex gate: the caller vouches this is one well-formed token (the
      // Advanced popover builds it via buildClipboardToken).
      insertToken: (token: string) => insertNodesAtCursor(() => [$createTokenNode(token)]),
      insertHtml: (html: string) => insertNodesAtCursor(() => {
        const dom = new DOMParser().parseFromString(html, 'text/html');
        return $generateNodesFromDOM(editor, dom);
      }),
      focus: () => editor.focus(),
      // On-demand HTML export (confirm-time, not per-keystroke). null when the doc
      // has no formatting, so unformatted actions stay plain on disk.
      getHtml: () => {
        let html: string | null = null;
        editor.getEditorState().read(() => {
          // AutoLinkNodes are EXCLUDED from the gate: merely typing a URL must not
          // silently turn the action rich (badge + compat pin + CF_HTML paste) — only
          // deliberate formatting (format bits, lists, explicit toolbar links) does.
          const hasFormatting = $dfs().some(({ node }) =>
            ($isTextNode(node) && node.getFormat() !== 0)
            || $isListNode(node)
            || ($isLinkNode(node) && !$isAutoLinkNode(node)));
          if (hasFormatting) html = $generateHtmlFromNodes(editor, null);
        });
        return html;
      },
    };
    return () => {
      apiRef.current = null;
    };
  }, [editor, apiRef]);

  return null;
}

// Backspace/Delete next to a chip removes the chip atomically. Without this,
// the default cursor behaviour with isolated DecoratorNodes leaves the chip
// stranded — backspace just shifts the caret across it without deleting.
function ChipKeyboardPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const removeBackward = (): boolean => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
      const { anchor } = selection;
      const node = anchor.getNode();
      const offset = anchor.offset;
      if ($isTextNode(node) && offset === 0) {
        const prev = node.getPreviousSibling();
        if (prev && $isTokenNode(prev)) {
          prev.remove();
          return true;
        }
      } else if ($isElementNode(node) && offset > 0) {
        const prev = node.getChildAtIndex(offset - 1);
        if (prev && $isTokenNode(prev)) {
          prev.remove();
          return true;
        }
      }
      return false;
    };

    const removeForward = (): boolean => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
      const { anchor } = selection;
      const node = anchor.getNode();
      const offset = anchor.offset;
      if ($isTextNode(node) && offset === node.getTextContentSize()) {
        const next = node.getNextSibling();
        if (next && $isTokenNode(next)) {
          next.remove();
          return true;
        }
      } else if ($isElementNode(node)) {
        const next = node.getChildAtIndex(offset);
        if (next && $isTokenNode(next)) {
          next.remove();
          return true;
        }
      }
      return false;
    };

    const u1 = editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (event: KeyboardEvent) => {
        if (removeBackward()) {
          event.preventDefault();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
    const u2 = editor.registerCommand(
      KEY_DELETE_COMMAND,
      (event: KeyboardEvent) => {
        if (removeForward()) {
          event.preventDefault();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
    return () => {
      u1();
      u2();
    };
  }, [editor]);

  return null;
}

// Watches every TextNode mutation: when the text contains a complete `{name}`
// or `{name:mods}` sequence and `name` is in KNOWN_TOKEN_NAMES, splits the text
// node and inserts a chip in place. Mirrors the paste behaviour so live typing
// produces the same result. Unknown tokens stay as plain text.
function TokenAutoTransformPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerNodeTransform(TextNode, (textNode: TextNode) => {
      const text = textNode.getTextContent();
      if (!text.includes('{')) return;
      const match = TOKEN_REGEX_SINGLE.exec(text);
      if (!match) return;
      const name = match[0].slice(1, -1).split(':')[0].toLowerCase();
      if (!KNOWN_TOKEN_NAMES.has(name)) return;

      const start = match.index;
      const end = start + match[0].length;
      const before = text.slice(0, start);
      const after = text.slice(end);
      const chip = $createTokenNode(match[0]);

      // Only steal the caret when it actually lived in the node being split —
      // re-chipping pasted/imported content must not yank the cursor around.
      const selection = $getSelection();
      const anchorWasHere =
        $isRangeSelection(selection) && selection.anchor.getNode().getKey() === textNode.getKey();

      if (before) {
        textNode.setTextContent(before);
        textNode.insertAfter(chip);
      } else {
        textNode.replace(chip);
      }
      // Always have a trailing TextNode so the caret has a place to land right
      // after the chip — otherwise it would clamp to before the (isolated) chip.
      // It inherits the split node's format/style, or chipping a token inside a
      // bold/italic run would silently reset the remainder to unformatted.
      const trailing = $createTextNode(after);
      trailing.setFormat(textNode.getFormat());
      trailing.setStyle(textNode.getStyle());
      chip.insertAfter(trailing);
      if (anchorWasHere) trailing.select(0, 0);
    });
  }, [editor]);

  return null;
}

// Intercepts paste to convert pasted text containing known `{...}` tokens into
// chips (instead of leaving them as raw text). In rich mode a paste that CARRIES
// formatting (text/html flavor) is left to Lexical's rich clipboard pipeline —
// hijacking it here would silently strip the formatting; the TokenAutoTransform
// node transform re-chips any tokens in the imported text afterwards.
function TokenPastePlugin({ richMode }: { richMode?: boolean }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      PASTE_COMMAND,
      (event: ClipboardEvent) => {
        if (richMode && event.clipboardData?.getData('text/html')) return false;
        const text = event.clipboardData?.getData('text/plain');
        if (!text) return false;
        // Skip our handler if the pasted text has no token markers — let the
        // default plain-text handler deal with it (preserves IME / undo nuances).
        if (!text.includes('{')) return false;
        event.preventDefault();
        editor.update(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;
          const nodes = buildNodesFromText(text);
          if (nodes.length > 0) selection.insertNodes(nodes);
        });
        return true;
      },
      COMMAND_PRIORITY_LOW,
    );
  }, [editor, richMode]);

  return null;
}

// URL matcher for AutoLink — a typed/pasted URL becomes a live link node. The
// pattern requires a dot-separated host, so it can never collide with the token
// grammar (tokens contain no dots).
const URL_MATCHER =
  /((https?:\/\/(www\.)?)|(www\.))[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)/;
const AUTO_LINK_MATCHERS = [
  (text: string) => {
    const match = URL_MATCHER.exec(text);
    if (match === null) return null;
    return {
      index: match.index,
      length: match[0].length,
      text: match[0],
      url: match[0].startsWith('http') ? match[0] : `https://${match[0]}`,
    };
  },
];

// Formatting toolbar (rich mode only): B/I/U/S, inline code, bullet/numbered
// list, link. Buttons use onMouseDown preventDefault so clicking them never
// collapses the editor selection they act on. Active states track the selection
// via an update listener. The link flow is a tiny inline URL input — apply on
// Enter, cancel on Esc; '{' is rejected (tokens inside link URLs are unsupported).
function RichToolbarPlugin() {
  const [editor] = useLexicalComposerContext();
  const [formats, setFormats] = useState({
    bold: false, italic: false, underline: false, strikethrough: false, code: false,
    link: false, ul: false, ol: false,
  });
  const [linkInputOpen, setLinkInputOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  // The editor loses its DOM selection the moment focus moves into the URL <input>,
  // so snapshot the RangeSelection when the input opens and restore it on apply —
  // otherwise TOGGLE_LINK_COMMAND has nothing to wrap and inserts nothing.
  const savedSelection = useRef<BaseSelection | null>(null);

  const openLinkInput = () => {
    editor.getEditorState().read(() => {
      const sel = $getSelection();
      savedSelection.current = sel ? sel.clone() : null;
    });
    setLinkInputOpen(true);
  };

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const sel = $getSelection();
        if (!$isRangeSelection(sel)) return;
        const anchorNode = sel.anchor.getNode();
        const parents = anchorNode.getParents();
        const listParent = parents.find($isListNode);
        setFormats({
          bold: sel.hasFormat('bold'),
          italic: sel.hasFormat('italic'),
          underline: sel.hasFormat('underline'),
          strikethrough: sel.hasFormat('strikethrough'),
          code: sel.hasFormat('code'),
          link: parents.some($isLinkNode),
          ul: !!listParent && listParent.getListType() === 'bullet',
          ol: !!listParent && listParent.getListType() === 'number',
        });
      });
    });
  }, [editor]);

  const applyLink = () => {
    const url = linkUrl.trim();
    if (!url || url.includes('{')) return;   // tokens in URLs are unsupported
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) ? url : `https://${url}`;
    editor.update(() => {
      // Restore the selection the editor had before focus went to the URL input.
      const saved = savedSelection.current;
      if (saved) $setSelection(saved.clone());
      const sel = $getSelection();
      if ($isRangeSelection(sel) && !sel.isCollapsed()) {
        // Text is selected → wrap it in a link (the plain TOGGLE_LINK_COMMAND case).
        $toggleLink(withScheme);
      } else {
        // No selection → insert a NEW link whose visible text is the URL itself, so
        // the button always produces something (the reported "inserts nothing" bug).
        const linkNode = $createLinkNode(withScheme);
        linkNode.append($createTextNode(url));
        if ($isRangeSelection(sel)) sel.insertNodes([linkNode]);
        else $insertNodes([linkNode]);
      }
    });
    savedSelection.current = null;
    setLinkInputOpen(false);
    setLinkUrl('');
    editor.focus();
  };

  const btnClass = (active: boolean) =>
    `h-6 w-6 flex items-center justify-center rounded transition-colors ${
      active
        ? 'text-accent bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)]'
        : 'text-text-tertiary hover:text-text-secondary hover:bg-[rgba(127,127,127,0.12)]'
    }`;

  const fmtBtn = (fmt: TextFormatType, active: boolean, Icon: typeof Bold, tip: string) => (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, fmt)}
      className={btnClass(active)}
      data-tip={tip}
    >
      <Icon size={13} />
    </button>
  );

  return (
    <div className="flex items-center gap-0.5 px-1.5 py-1 border-b border-border-subtle shrink-0">
      {fmtBtn('bold', formats.bold, Bold, 'Bold (Ctrl+B)')}
      {fmtBtn('italic', formats.italic, Italic, 'Italic (Ctrl+I)')}
      {fmtBtn('underline', formats.underline, Underline, 'Underline (Ctrl+U)')}
      {fmtBtn('strikethrough', formats.strikethrough, Strikethrough, 'Strikethrough')}
      {fmtBtn('code', formats.code, Code, 'Inline code')}
      <div className="w-px h-4 mx-1 bg-border-subtle" />
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor.dispatchCommand(formats.ul ? REMOVE_LIST_COMMAND : INSERT_UNORDERED_LIST_COMMAND, undefined)}
        className={btnClass(formats.ul)}
        data-tip="Bullet list"
      >
        <List size={13} />
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor.dispatchCommand(formats.ol ? REMOVE_LIST_COMMAND : INSERT_ORDERED_LIST_COMMAND, undefined)}
        className={btnClass(formats.ol)}
        data-tip="Numbered list"
      >
        <ListOrdered size={13} />
      </button>
      <div className="w-px h-4 mx-1 bg-border-subtle" />
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (formats.link) {
            editor.dispatchCommand(TOGGLE_LINK_COMMAND, null);   // unlink
          } else if (linkInputOpen) {
            setLinkInputOpen(false);
          } else {
            openLinkInput();   // snapshots the selection BEFORE the input steals focus
          }
        }}
        className={btnClass(formats.link || linkInputOpen)}
        data-tip={formats.link ? 'Remove link' : 'Link'}
      >
        <Link2 size={13} />
      </button>
      {linkInputOpen && (
        <div className="flex items-center gap-1 ml-1">
          <input
            type="text"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); applyLink(); }
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setLinkInputOpen(false); setLinkUrl(''); editor.focus(); }
            }}
            placeholder="https://…"
            autoFocus
            spellCheck={false}
            className="h-6 w-52 px-1.5 text-[11px] font-mono bg-bg-input border border-border-default rounded text-text-primary outline-none focus:border-accent-solid"
          />
          <button type="button" onClick={applyLink} className={btnClass(false)} data-tip="Apply link">
            <Check size={13} />
          </button>
          <button
            type="button"
            onClick={() => { setLinkInputOpen(false); setLinkUrl(''); editor.focus(); }}
            className={btnClass(false)}
            data-tip="Cancel"
          >
            <X size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

// Ctrl+Enter submit forwarded to parent so the same shortcut behaves the same.
function SubmitPlugin({ onSubmit }: { onSubmit?: () => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    if (!onSubmit) return;
    const root = editor.getRootElement();
    if (!root) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault();
        onSubmit();
      }
    };
    root.addEventListener('keydown', handler);
    return () => root.removeEventListener('keydown', handler);
  }, [editor, onSubmit]);
  return null;
}

export function LexicalTokenEditor({
  initialText,
  onChange,
  onSubmit,
  apiRef,
  contentClassName = 'w-full h-full px-3 py-2 text-sm leading-[1.5] outline-none whitespace-pre-wrap break-words text-text-primary overflow-auto',
  placeholderClassName = 'absolute top-2 left-3 text-sm text-text-disabled pointer-events-none select-none',
  onClipboardChipEdit,
  richMode = false,
  initialHtml = null,
}: LexicalTokenEditorProps) {
  const initialConfig = {
    namespace: 'SendText',
    // List/link nodes register only in rich mode, so the plain surfaces
    // (SheetPanel browserText) can never acquire rich content by accident.
    nodes: richMode ? [TokenNode, ListNode, ListItemNode, LinkNode, AutoLinkNode] : [TokenNode],
    onError: (error: Error) => {
      console.error('[Lexical]', error);
    },
    theme: {
      paragraph: 'm-0',
      // Formatting renders through theme tokens (never hardcoded hex — 48 themes).
      text: {
        bold: 'font-semibold',
        italic: 'italic',
        underline: 'underline',
        strikethrough: 'line-through',
        underlineStrikethrough: '[text-decoration:underline_line-through]',
        code: 'font-mono text-[0.9em] bg-bg-input border border-border-subtle rounded px-1',
      },
      list: {
        ul: 'list-disc ml-5',
        ol: 'list-decimal ml-5',
        listitem: 'my-0.5',
      },
      link: 'text-accent underline',
    },
  };

  // Shared shape between the plain and rich root plugins.
  const contentEditable = (
    <ContentEditable
      className={contentClassName}
      aria-label="Text to send"
      spellCheck={false}
    />
  );
  const placeholder = (
    <div className={placeholderClassName}>
      Type the text to send...
    </div>
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      {/* Context flows through Lexical's decorator portals, so TokenChip sees it. */}
      <ClipboardChipEditContext.Provider value={onClipboardChipEdit ?? null}>
      <div className={richMode ? 'w-full h-full flex flex-col' : 'relative w-full h-full'}>
        {richMode && <RichToolbarPlugin />}
        <div className="relative flex-1 min-h-0">
          {richMode ? (
            <RichTextPlugin
              contentEditable={contentEditable}
              placeholder={placeholder}
              ErrorBoundary={LexicalErrorBoundary}
            />
          ) : (
            <PlainTextPlugin
              contentEditable={contentEditable}
              placeholder={placeholder}
              ErrorBoundary={LexicalErrorBoundary}
            />
          )}
        </div>
        <HistoryPlugin />
        {richMode && <ListPlugin />}
        {richMode && <LinkPlugin />}
        {richMode && <AutoLinkPlugin matchers={AUTO_LINK_MATCHERS} />}
        <OnChangePlugin
          onChange={(state) => {
            state.read(() => {
              // Rich mode uses the single-newline block serializer (see
              // $serializePlainForSend); plain mode stays byte-identical to 2.8.0.
              onChange(richMode ? $serializePlainForSend() : $getRoot().getTextContent());
            });
          }}
        />
        <InitialContentPlugin initialText={initialText} initialHtml={richMode ? initialHtml : null} />
        <ImperativeAPIPlugin apiRef={apiRef} />
        <TokenPastePlugin richMode={richMode} />
        <TokenAutoTransformPlugin />
        <ChipKeyboardPlugin />
        <SubmitPlugin onSubmit={onSubmit} />
      </div>
      </ClipboardChipEditContext.Provider>
    </LexicalComposer>
  );
}
