import { createElement, type ReactNode } from 'react';
import {
  DecoratorNode,
  type DOMConversionMap,
  type DOMConversionOutput,
  type DOMExportOutput,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import { TokenChip } from './TokenChip';
import { normalizeToken } from './tokenNormalize';

type SerializedTokenNode = Spread<
  { token: string; type: 'token'; version: 1 },
  SerializedLexicalNode
>;

// Inline chip representation of a {variable[:mods]} token. The node serializes
// back to its raw text via getTextContent — that's how Lexical reconstructs the
// plain string the rest of the app stores.
export class TokenNode extends DecoratorNode<ReactNode> {
  __token: string;

  constructor(token: string, key?: NodeKey) {
    super(key);
    this.__token = normalizeToken(token);
  }

  static getType(): string {
    return 'token';
  }

  static clone(node: TokenNode): TokenNode {
    return new TokenNode(node.__token, node.__key);
  }

  static importJSON(json: SerializedTokenNode): TokenNode {
    return new TokenNode(json.token);
  }

  exportJSON(): SerializedTokenNode {
    return { type: 'token', version: 1, token: this.__token };
  }

  // Mutates the node's token in place. Must be called inside editor.update().
  setToken(token: string): void {
    const writable = this.getWritable();
    writable.__token = normalizeToken(token);
  }

  createDOM(): HTMLElement {
    const span = document.createElement('span');
    span.style.display = 'inline-block';
    span.style.verticalAlign = 'middle';
    return span;
  }

  // HTML round-trip for the rich-text payload (KeyHtml). Export: the raw token as
  // TEXT wrapped in a marker span — a paste target that renders the HTML shows the
  // literal "{var:name}" (the backend resolves tokens in the HTML flavor at send
  // time, so what actually pastes is the resolved value). Import: the marker span
  // re-chips when the dialog rebuilds the rich doc from a saved KeyHtml.
  exportDOM(): DOMExportOutput {
    const span = document.createElement('span');
    span.setAttribute('data-token', this.__token);
    span.textContent = this.__token;
    return { element: span };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      span: (domNode: HTMLElement) => {
        if (!domNode.hasAttribute('data-token')) return null;
        return {
          conversion: (el: HTMLElement): DOMConversionOutput => ({
            node: $createTokenNode(el.getAttribute('data-token') || ''),
          }),
          priority: 2,
        };
      },
    };
  }

  updateDOM(): boolean {
    return false;
  }

  // The raw `{...}` text — used by Lexical's $getRoot().getTextContent()
  // serializer so the parent component sees the same string format as today.
  getTextContent(): string {
    return this.__token;
  }

  isInline(): boolean {
    return true;
  }

  // isIsolated => caret cannot enter the chip; backspace deletes the whole node.
  isIsolated(): boolean {
    return true;
  }

  isKeyboardSelectable(): boolean {
    return true;
  }

  decorate(): ReactNode {
    // createElement (rather than JSX) keeps this file free of TSX syntax so the
    // react-refresh rule doesn't flag the class export as a component leak.
    return createElement(TokenChip, { nodeKey: this.__key, token: this.__token });
  }
}

export function $createTokenNode(token: string): TokenNode {
  return new TokenNode(token);
}

export function $isTokenNode(node: LexicalNode | null | undefined): node is TokenNode {
  return node instanceof TokenNode;
}
