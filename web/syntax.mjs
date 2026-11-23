/* Keep the textarea as the editing surface so selection, dictation and IMEs stay native. */
(() => {
  const keywords = new Set(("actor any as associatedtype async await borrowing break case catch class " +
    "consume consuming continue convenience copy default defer deinit didSet do dynamic each else enum " +
    "extension fallthrough false fileprivate final for func get guard if import in indirect infix init " +
    "inout internal is isolated lazy let macro mutating nil nonisolated nonmutating open operator " +
    "optional override package postfix precedencegroup prefix private protocol public repeat required " +
    "rethrows return self Self set some static struct subscript super switch throws throw true try " +
    "typealias unowned var weak where while willSet yield").split(/\s+/));
  const declarationKinds = new Set(["actor", "class", "enum", "extension", "func", "macro", "protocol", "struct", "typealias"]);
  const tokenPattern = /\/\/[^\n]*|\/\*|#*"""|#*"|[@#][\p{L}_][\p{L}\p{N}_]*|#+|\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?)|\x60[^\n\x60]+\x60|[\p{L}_][\p{L}\p{M}\p{N}_]*/gu;

  function commentEnd(text, offset) {
    const markers = /\/\*|\*\//g;
    markers.lastIndex = offset;
    let depth = 1;
    for (let marker; (marker = markers.exec(text));) {
      depth += marker[0] === "/*" ? 1 : -1;
      if (!depth) return markers.lastIndex;
    }
    return text.length;
  }

  function stringEnd(text, offset, opener) {
    const hashes = opener.slice(0, opener.indexOf('"'));
    const quotes = opener.slice(hashes.length);
    const end = quotes + hashes;
    const escape = "\\" + hashes;
    for (let p = offset; p < text.length;) {
      if (text.startsWith(end, p)) return p + end.length;
      if (quotes.length === 1 && text[p] === "\n") return p;
      if (text.startsWith(escape, p)) p += escape.length + 1;
      else p++;
    }
    return text.length;
  }

  function paint(source, layer, swift) {
    const symbols = [];
    if (!swift || source.length > 256 * 1024) {
      layer.textContent = source + "\n";
      return symbols;
    }
    const nodes = document.createDocumentFragment();
    let last = 0;
    let pending = "";
    let previousEnd = 0;
    tokenPattern.lastIndex = 0;
    for (let match; (match = tokenPattern.exec(source));) {
      const word = match[0];
      const start = match.index;
      if (pending && /\S/.test(source.slice(previousEnd, start))) pending = "";
      let kind = "";
      if (word.startsWith("//") || word === "/*") {
        kind = "comment";
        if (word === "/*") tokenPattern.lastIndex = commentEnd(source, tokenPattern.lastIndex);
      } else if (word.endsWith('"')) {
        kind = "string";
        tokenPattern.lastIndex = stringEnd(source, tokenPattern.lastIndex, word);
      } else if (word.startsWith("@")) kind = "attribute";
      else if (word.startsWith("#")) kind = "directive";
      else if (/^\d/.test(word)) kind = "number";
      else {
        if (pending && !keywords.has(word)) symbols.push({label: pending + " " + word, offset: start});
        if (keywords.has(word)) kind = "keyword";
        else if (/^\p{Lu}/u.test(word)) kind = "type";
      }
      if (kind !== "comment") pending = declarationKinds.has(word) ? word : "";
      previousEnd = tokenPattern.lastIndex;
      if (!kind) continue;
      if (start > last) nodes.append(source.slice(last, start));
      const span = document.createElement("span");
      span.className = "tok-" + kind;
      span.textContent = source.slice(start, tokenPattern.lastIndex);
      nodes.append(span);
      last = tokenPattern.lastIndex;
    }
    nodes.append(source.slice(last) + "\n");
    layer.replaceChildren(nodes);
    return symbols;
  }

  function setup() {
    const code = document.getElementById("code");
    const layer = document.getElementById("syntax-layer");
    const lines = document.getElementById("editor-lines");
    if (!code || !layer || !lines || code.dataset.syntaxReady) return;
    code.dataset.syntaxReady = "true";
    code.wrap = "off";
    const outline = document.getElementById("symbol-outline");
    let undo = [], redo = [], frame = 0, composing = false, restoring = false;
    const snapshot = () => ({text: code.value, start: code.selectionStart, end: code.selectionEnd});
    let current = snapshot();
    function remember(stack, item) {
      stack.push(item);
      const max = Math.max(2, Math.min(80, Math.floor(2000000 / Math.max(item.text.length, 1))));
      if (stack.length > max) stack.splice(0, stack.length - max);
    }
    function syncScroll() {
      layer.scrollTop = code.scrollTop;
      layer.scrollLeft = code.scrollLeft;
      lines.scrollTop = code.scrollTop;
    }
    function jump(offset) {
      if (!Number.isInteger(offset) || offset < 0 || offset > code.value.length) return;
      code.focus();
      code.setSelectionRange(offset, offset);
      const row = code.value.slice(0, offset).split("\n").length - 1;
      const lineHeight = parseFloat(getComputedStyle(code).lineHeight);
      if (lineHeight) code.scrollTop = Math.max(0, (row - 2) * lineHeight);
      syncScroll();
    }
    function draw() {
      frame = 0;
      const text = code.value;
      const filename = document.getElementById("files")?.value;
      const symbols = paint(text, layer, !filename || /\.swift$/i.test(filename));
      const count = text.split("\n").length;
      if (lines.dataset.count !== String(count)) {
        lines.textContent = Array.from({length: count}, (_, i) => String(i + 1)).join("\n") + "\n";
        lines.dataset.count = String(count);
      }
      if (outline && outline.tagName === "SELECT") {
        const options = [new Option("Přejít na symbol…", "")];
        for (const symbol of symbols) options.push(new Option(symbol.label, String(symbol.offset)));
        outline.replaceChildren(...options);
      } else if (outline) {
        const entries = document.createDocumentFragment();
        for (const symbol of symbols) {
          const button = document.createElement("button");
          button.type = "button"; button.dataset.offset = String(symbol.offset);
          button.textContent = symbol.label;
          entries.append(button);
        }
        outline.replaceChildren(entries);
      }
      syncScroll();
    }
    function schedule() { if (!frame) frame = requestAnimationFrame(draw); }
    outline?.addEventListener("change", () => {
      if (outline.tagName === "SELECT" && outline.value !== "") jump(Number(outline.value));
    });
    outline?.addEventListener("click", event => {
      const button = event.target.closest("[data-offset]");
      if (button) jump(Number(button.dataset.offset));
    });
    function record() {
      const next = snapshot();
      if (!restoring && current.text !== next.text) {
        remember(undo, current); redo = [];
      }
      current = next;
    }
    function notify() {
      code.dispatchEvent(new Event("input", {bubbles: true}));
    }
    function restore(backwards) {
      const from = backwards ? undo : redo;
      const to = backwards ? redo : undo;
      const next = from.pop();
      if (!next) return;
      remember(to, snapshot());
      restoring = true;
      code.value = next.text;
      code.focus();
      code.setSelectionRange(next.start, next.end);
      notify();
      restoring = false;
    }
    function replace(start, end, value, selectionStart, selectionEnd) {
      current = snapshot();
      code.focus();
      code.setRangeText(value, start, end, "end");
      code.setSelectionRange(selectionStart, selectionEnd);
      notify();
    }
    function command(name) {
      if (composing) return;
      if (name === "undo" || name === "redo") return restore(name === "undo");
      if (!["indent", "outdent", "comment"].includes(name)) return;
      const text = code.value, a = code.selectionStart, b = code.selectionEnd;
      if (name === "indent" && a === b) {
        const width = 4 - ((a - (text.slice(0, a).lastIndexOf("\n") + 1)) % 4);
        return replace(a, b, " ".repeat(width), a + width, a + width);
      }
      const start = text.slice(0, a).lastIndexOf("\n") + 1;
      const searchFrom = b > a && text[b - 1] === "\n" ? b - 1 : b;
      const nextBreak = text.indexOf("\n", searchFrom);
      const end = nextBreak < 0 ? text.length : nextBreak;
      const rows = text.slice(start, end).split("\n");
      const filled = rows.filter(row => /\S/.test(row));
      const uncomment = name === "comment" && filled.length && filled.every(row => /^[ \t]*\/\//.test(row));
      const updated = rows.map(row => {
        if (name === "indent") return "    " + row;
        if (name === "outdent") return row.replace(/^( {1,4}|\t)/, "");
        if (uncomment) return row.replace(/^([ \t]*)\/\/ ?/, "$1");
        return row.replace(/^([ \t]*)/, "$1// ");
      }).join("\n");
      const caret = Math.max(start, Math.min(start + updated.length, a + updated.length - (end - start)));
      replace(start, end, updated, a === b ? caret : start, a === b ? caret : start + updated.length);
    }
    code.addEventListener("beforeinput", event => {
      if (event.isComposing || composing) return;
      if (event.cancelable && ["historyUndo", "historyRedo"].includes(event.inputType)) {
        event.preventDefault(); restore(event.inputType === "historyUndo"); return;
      }
      current = snapshot();
    });
    code.addEventListener("input", () => { if (!composing) record(); schedule(); });
    code.addEventListener("compositionstart", () => { current = snapshot(); composing = true; });
    code.addEventListener("compositionend", () => { composing = false; record(); schedule(); });
    code.addEventListener("scroll", syncScroll, {passive: true});
    code.addEventListener("keydown", event => {
      if (composing || event.isComposing || event.altKey) return;
      const mod = event.metaKey || event.ctrlKey;
      let action;
      if (event.key === "Tab" && !mod) action = event.shiftKey ? "outdent" : "indent";
      if (mod && event.key === "/") action = "comment";
      if (mod && event.key.toLowerCase() === "z") action = event.shiftKey ? "redo" : "undo";
      if (mod && event.key.toLowerCase() === "y") action = "redo";
      if (action) { event.preventDefault(); command(action); }
    });
    document.addEventListener("click", event => {
      const button = event.target.closest("[data-edit]");
      if (button) command(button.dataset.edit);
    });
    document.addEventListener("pocket:fileloaded", () => {
      current = snapshot(); undo = []; redo = []; code.scrollTop = 0; code.scrollLeft = 0; schedule();
    });
    draw();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup, {once: true});
  else setup();
})();
