// Pretty-printing and colouring of response bodies.

import { esc } from "./ui.js";

const escText = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

const MAX_HIGHLIGHT = 2_000_000;
const TOKEN = /\s+|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\]:,]/y;

/** JSON re-indented (numbers kept as written) and coloured, as HTML; null when `text` isn't JSON. */
export function prettyJson(text, { color = true } = {}) {
  const src = text.trim();
  if (!/^[[{"]|^-?\d|^(true|false|null)$/.test(src)) return null;
  try {
    JSON.parse(src);
  } catch {
    return null;
  }
  if (src.length > MAX_HIGHLIGHT) color = false;
  const toks = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < src.length) {
    const m = TOKEN.exec(src);
    if (!m) return null;
    if (!/^\s/.test(m[0])) toks.push(m[0]);
  }
  const out = [];
  let depth = 0;
  const nl = () => "\n" + "  ".repeat(depth);
  const span = (cls, s) => (color ? `<span class="${cls}">${esc(s)}</span>` : esc(s));
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === "{" || t === "[") {
      const close = t === "{" ? "}" : "]";
      if (toks[i + 1] === close) {
        out.push(span("j-p", t + close));
        i++;
      } else {
        depth++;
        out.push(span("j-p", t), nl());
      }
    } else if (t === "}" || t === "]") {
      depth--;
      out.push(nl(), span("j-p", t));
    } else if (t === ",") out.push(span("j-p", ","), nl());
    else if (t === ":") out.push(span("j-p", ":"), " ");
    else if (t[0] === '"') out.push(span(toks[i + 1] === ":" ? "j-k" : "j-s", t));
    else if (t === "true" || t === "false") out.push(span("j-b", t));
    else if (t === "null") out.push(span("j-n", t));
    else out.push(span("j-num", t));
  }
  return out.join("");
}

/** XML/HTML indented loosely, coloured as markup. */
export function prettyMarkup(text) {
  if (text.length > MAX_HIGHLIGHT) return escText(text);
  return escText(text).replace(
    /(&lt;\/?)([\w:.-]+)((?:\s+[\w:.-]+(?:=(?:"[^"]*"|'[^']*'))?)*)(\s*\/?&gt;)/g,
    (m, open, tag, attrs, close) =>
      `<span class="j-p">${open}</span><span class="m-tag">${tag}</span>` +
      attrs.replace(/([\w:.-]+)(=)("[^"]*"|'[^']*')?/g, '<span class="m-attr">$1</span>$2<span class="j-s">$3</span>') +
      `<span class="j-p">${close}</span>`,
  );
}
