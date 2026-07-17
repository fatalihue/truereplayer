using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using AngleSharp.Dom;
using AngleSharp.Html.Parser;

namespace TrueReplayer.Services
{
    /// <summary>
    /// Allowlist re-serializer for SendText rich text (<see cref="Models.ActionItem.KeyHtml"/>).
    ///
    /// KeyHtml is the ONE field whose value a third-party app interprets as MARKUP: it is placed on
    /// the clipboard as CF_HTML and pasted into Word / Outlook / Gmail / a contenteditable. A foreign
    /// or hand-edited .trprofile is untrusted, so its KeyHtml can carry a tracking beacon
    /// (&lt;img src="https://…/px"&gt;), hidden text (&lt;span style="font-size:1px;color:#fff"&gt;), or a
    /// javascript:/file: link. This scrubs it to exactly the markup the app's own Lexical editor can
    /// produce, by REBUILDING a new tree from an allowlist rather than blacklist-stripping — correct
    /// by construction against mutation-XSS and parser-differential bypasses.
    ///
    /// WHITELIST SOURCE OF TRUTH: frontend/src/components/lexical/LexicalTokenEditor.tsx (the
    /// registered node set `[TokenNode, ListNode, ListItemNode, LinkNode, AutoLinkNode]` at the
    /// `nodes:` line, plus the editor `theme`) and TokenNode.tsx exportDOM (`&lt;span data-token&gt;`).
    /// If a formatting node is added there (HeadingNode / QuoteNode / ImageNode / a new mark), its
    /// output will be SILENTLY STRIPPED here until the corresponding element/attr is added below.
    /// Keep the two in lockstep — the round-trip test (author one action per toolbar format, sanitize,
    /// assert byte-identical modulo dropped class) is what catches drift.
    /// </summary>
    public static class HtmlSanitizer
    {
        // Elements the editor's exportDOM can emit. TextNode wraps BOTH tag families (strong/em/span
        // from the inner tag AND b/i/s/u from wrapElementWith), so both are listed; code is the outer
        // tag; p/br from ParagraphNode; ul/ol/li from the list nodes; a from LinkNode/AutoLinkNode.
        // Headings/quotes/images/tables are deliberately absent — those nodes are NOT registered.
        private static readonly HashSet<string> AllowedElements = new(StringComparer.OrdinalIgnoreCase)
        { "p", "br", "span", "b", "strong", "i", "em", "u", "s", "code", "ul", "ol", "li", "a" };

        // Per-element attribute allowlist; anything else is dropped. `class` is dropped everywhere —
        // the exported Tailwind names reference the app's OWN stylesheet, which is not in the CF_HTML
        // package, so Word/Gmail can't resolve them: inert dead weight, zero fidelity loss. The tags
        // themselves (<b>/<code>/…) carry the formatting.
        private static readonly Dictionary<string, HashSet<string>> AllowedAttributes = new(StringComparer.OrdinalIgnoreCase)
        {
            ["span"] = new(StringComparer.OrdinalIgnoreCase) { "data-token" },       // TokenNode marker (re-chips on import)
            ["a"]    = new(StringComparer.OrdinalIgnoreCase) { "href", "target", "rel", "title" },
            ["ul"]   = new(StringComparer.OrdinalIgnoreCase) { "dir", "__lexicallisttype" },
            ["ol"]   = new(StringComparer.OrdinalIgnoreCase) { "dir", "start", "__lexicallisttype" },
            ["li"]   = new(StringComparer.OrdinalIgnoreCase) { "value", "__lexicallisttype" },
        };

        // Style PROPERTIES re-emitted (never the raw style attribute). Lexical sets white-space:pre-wrap
        // on every exported text span (stripping it collapses multi-space runs and indentation in the
        // pasted target), text-align on paragraphs, and text-transform for upper/lower/capitalize.
        private static readonly HashSet<string> AllowedStyleProps = new(StringComparer.OrdinalIgnoreCase)
        { "white-space", "text-align", "text-transform" };

        // URL schemes allowed on <a href> — mirrors Lexical's SUPPORTED_URL_PROTOCOLS
        // ({http, https, mailto, tel, sms}); the frontend enforces this in createDOM, which the C#
        // send path never runs, so an imported javascript:/file:/data:/vbscript: href would otherwise
        // reach the clipboard verbatim. Anything else drops the href (the link text is kept).
        private static readonly HashSet<string> AllowedSchemes = new(StringComparer.OrdinalIgnoreCase)
        { "http", "https", "mailto", "tel", "sms" };

        // Disallowed elements whose SUBTREE must be discarded, not unwrapped — their text content is
        // code/metadata, not display text, so promoting it would paste garbage (or worse). Every other
        // disallowed element (div, table, h1, img, …) is unwrapped: dropped but its allowed children
        // are kept, so <div><strong>x</strong></div> still pastes "x" bold.
        private static readonly HashSet<string> DropSubtree = new(StringComparer.OrdinalIgnoreCase)
        { "script", "style", "iframe", "object", "embed", "template", "noscript", "head", "title",
          "meta", "link", "base", "textarea", "svg", "math", "frame", "frameset", "applet" };

        /// <summary>
        /// Returns sanitized HTML, or null when the input is empty, sanitizes to nothing (a fully
        /// hostile payload), or fails to parse. Callers treat null as "no rich flavor" and fall back
        /// to plain text — i.e. this fails CLOSED, never emitting unsanitized markup.
        /// </summary>
        public static string? Sanitize(string? html)
        {
            if (string.IsNullOrEmpty(html)) return null;
            try
            {
                var parser = new HtmlParser();
                var doc = parser.ParseDocument("<!DOCTYPE html><html><head></head><body></body></html>");
                var body = doc.Body!;
                var fragment = parser.ParseFragment(html, body);

                var outEl = doc.CreateElement("div");
                foreach (var node in fragment.ToList())
                {
                    var clean = CleanNode(node, doc);
                    if (clean != null) outEl.AppendChild(clean);
                }

                var result = outEl.InnerHtml;
                // Null out an empty result so the caller drops the HTML flavor entirely. A doc that is
                // only whitespace-and-<br> is still meaningful (a blank line), so keep it if it has any
                // element; only truly empty output returns null.
                return outEl.ChildElementCount == 0 && string.IsNullOrWhiteSpace(outEl.TextContent)
                    ? null
                    : result;
            }
            catch
            {
                return null; // fail closed — never paste raw markup on a sanitizer error
            }
        }

        private static INode? CleanNode(INode node, IDocument doc)
        {
            switch (node.NodeType)
            {
                case NodeType.Text:
                    return doc.CreateTextNode(node.TextContent);

                case NodeType.Element:
                    var el = (IElement)node;
                    var tag = el.LocalName;

                    if (DropSubtree.Contains(tag)) return null;

                    if (!AllowedElements.Contains(tag))
                    {
                        // Unwrap: keep allowed children, drop the disallowed wrapper. Returns a
                        // fragment so the children splice into the parent in place.
                        var frag = doc.CreateDocumentFragment();
                        foreach (var child in el.ChildNodes.ToList())
                        {
                            var c = CleanNode(child, doc);
                            if (c != null) frag.AppendChild(c);
                        }
                        return frag.HasChildNodes ? frag : null;
                    }

                    var newEl = doc.CreateElement(tag);

                    if (AllowedAttributes.TryGetValue(tag, out var attrs))
                    {
                        foreach (var attr in el.Attributes)
                        {
                            if (!attrs.Contains(attr.Name)) continue;
                            if (tag.Equals("a", StringComparison.OrdinalIgnoreCase)
                                && attr.Name.Equals("href", StringComparison.OrdinalIgnoreCase))
                            {
                                var safe = SanitizeUrl(attr.Value);
                                if (safe != null) newEl.SetAttribute("href", safe);
                                continue; // drop an unsafe href but keep the link text (recursed below)
                            }
                            newEl.SetAttribute(attr.Name, attr.Value);
                        }
                    }

                    var style = el.GetAttribute("style");
                    if (style != null)
                    {
                        var filtered = FilterStyle(style);
                        if (filtered != null) newEl.SetAttribute("style", filtered);
                    }

                    foreach (var child in el.ChildNodes.ToList())
                    {
                        var c = CleanNode(child, doc);
                        if (c != null) newEl.AppendChild(c);
                    }
                    return newEl;

                default:
                    return null; // comments, processing instructions, etc.
            }
        }

        // Keep only allowlisted style properties, and reject any value carrying an active construct
        // (url(), expression(), a scheme) even on an allowed property — belt-and-suspenders, since
        // these three properties never legitimately need them.
        private static string? FilterStyle(string style)
        {
            var sb = new StringBuilder();
            foreach (var decl in style.Split(';'))
            {
                var idx = decl.IndexOf(':');
                if (idx <= 0) continue;
                var prop = decl.Substring(0, idx).Trim();
                var val = decl.Substring(idx + 1).Trim();
                if (val.Length == 0 || !AllowedStyleProps.Contains(prop)) continue;
                var low = val.ToLowerInvariant();
                if (low.Contains("url(") || low.Contains("expression") || low.Contains("javascript") || low.Contains("</")) continue;
                sb.Append(prop).Append(':').Append(val).Append(';');
            }
            return sb.Length > 0 ? sb.ToString() : null;
        }

        // Allow relative/anchor URLs (no scheme); for absolute URLs, permit only the allowlisted
        // schemes. Whitespace/control chars are stripped from the scheme before the check so
        // "java\tscript:" can't slip past as a relative URL.
        private static string? SanitizeUrl(string? url)
        {
            if (string.IsNullOrWhiteSpace(url)) return null;
            var trimmed = url.Trim();

            var colon = trimmed.IndexOf(':');
            var slash = trimmed.IndexOf('/');
            var question = trimmed.IndexOf('?');
            var hash = trimmed.IndexOf('#');
            // No colon, or the colon comes after a path/query/fragment delimiter → relative URL, safe.
            if (colon < 0
                || (slash >= 0 && slash < colon)
                || (question >= 0 && question < colon)
                || (hash >= 0 && hash < colon))
                return trimmed;

            var scheme = new string(trimmed.Substring(0, colon)
                .Where(c => !char.IsWhiteSpace(c) && !char.IsControl(c)).ToArray());
            if (scheme.Length == 0) return null;
            if (!scheme.All(char.IsLetterOrDigit)) return null;
            return AllowedSchemes.Contains(scheme) ? trimmed : null;
        }
    }
}
