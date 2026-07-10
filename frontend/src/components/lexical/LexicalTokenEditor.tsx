import { useEffect, useRef } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $isElementNode,
  $createTextNode,
  $createParagraphNode,
  COMMAND_PRIORITY_LOW,
  PASTE_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  TextNode,
  type LexicalNode,
} from 'lexical';
import { TokenNode, $createTokenNode, $isTokenNode } from './TokenNode';

// Tokens recognised by the backend at runtime. Anything outside this set stays
// as plain text — typo'd `{xpto}` shouldn't masquerade as a real token chip.
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
]);

// Modifier segments allow digits/letters plus ',' and '-' so {Random:1-10},
// {Clipboard:range:2-4} and {Clipboard:lines:3,1,2} chip correctly. Separators
// with other characters (e.g. join:" - ") stay plain text when typed — they
// still work at runtime; chips built via the popover keep chip-ness regardless.
const TOKEN_REGEX = /\{[a-zA-Z]+(?::[a-zA-Z0-9,-]+)*\}/g;
// Non-global form for single-match .exec() — stateless, so safe to share across calls.
const TOKEN_REGEX_SINGLE = new RegExp(TOKEN_REGEX.source);

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
  focus: () => void;
}

interface LexicalTokenEditorProps {
  initialText: string;
  onChange: (text: string) => void;
  onSubmit?: () => void;
  apiRef: React.MutableRefObject<LexicalEditorHandle | null>;
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

// One-shot population of the editor with the initial value (only runs first time).
function InitialContentPlugin({ initialText }: { initialText: string }) {
  const [editor] = useLexicalComposerContext();
  const didInit = useRef(false);

  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const para = $createParagraphNode();
      const nodes = buildNodesFromText(initialText);
      if (nodes.length > 0) para.append(...nodes);
      root.append(para);
    });
  }, [editor, initialText]);

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
      focus: () => editor.focus(),
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

      if (before) {
        textNode.setTextContent(before);
        textNode.insertAfter(chip);
      } else {
        textNode.replace(chip);
      }
      // Always have a trailing TextNode so the caret has a place to land right
      // after the chip — otherwise it would clamp to before the (isolated) chip.
      const trailing = $createTextNode(after);
      chip.insertAfter(trailing);
      trailing.select(0, 0);
    });
  }, [editor]);

  return null;
}

// Intercepts paste to convert pasted text containing known `{...}` tokens into
// chips (instead of leaving them as raw text). Plain-text paste only — we don't
// import HTML/Markdown formatting.
function TokenPastePlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      PASTE_COMMAND,
      (event: ClipboardEvent) => {
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
  }, [editor]);

  return null;
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
}: LexicalTokenEditorProps) {
  const initialConfig = {
    namespace: 'SendText',
    nodes: [TokenNode],
    onError: (error: Error) => {
      console.error('[Lexical]', error);
    },
    theme: {
      paragraph: 'm-0',
    },
  };

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div className="relative w-full h-full">
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              className="w-full h-full px-3 py-2 text-sm leading-[1.5] outline-none whitespace-pre-wrap break-words text-text-primary overflow-auto"
              aria-label="Text to send"
              spellCheck={false}
            />
          }
          placeholder={
            <div className="absolute top-2 left-3 text-sm text-text-disabled pointer-events-none select-none">
              Type the text to send...
            </div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <OnChangePlugin
          onChange={(state) => {
            state.read(() => {
              onChange($getRoot().getTextContent());
            });
          }}
        />
        <InitialContentPlugin initialText={initialText} />
        <ImperativeAPIPlugin apiRef={apiRef} />
        <TokenPastePlugin />
        <TokenAutoTransformPlugin />
        <ChipKeyboardPlugin />
        <SubmitPlugin onSubmit={onSubmit} />
      </div>
    </LexicalComposer>
  );
}
