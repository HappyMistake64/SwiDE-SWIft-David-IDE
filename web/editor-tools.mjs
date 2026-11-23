import {validPath, validateProject} from "./core.mjs";

export function renameSource(project, current, target, buffer) {
  if (!Object.hasOwn(project.files, current) || !validPath(target)) throw Error("Neplatná cesta souboru.");
  if (target !== current && (Object.hasOwn(project.files, target) || Object.hasOwn(project.binaries || {}, target))) {
    throw Error("Soubor s touto cestou již existuje.");
  }
  const files = Object.fromEntries(Object.entries(project.files).map(([path, value]) =>
    path === current ? [target, buffer] : [path, value]));
  const next = {...project, files};
  validateProject(next);
  return next;
}

const identifier = /[\p{L}_][\p{L}\p{M}\p{N}_]*/gu;
export function selectedIdentifier(text, start, end) {
  if (end > start) {
    const selected = text.slice(start, end).trim();
    return /^(?:[\p{L}_][\p{L}\p{M}\p{N}_]*)$/u.test(selected) ? selected : "";
  }
  const beginning = text.lastIndexOf("\n", Math.max(-1, start - 1)) + 1;
  const newline = text.indexOf("\n", start);
  const line = text.slice(beginning, newline < 0 ? text.length : newline);
  for (const match of line.matchAll(identifier)) {
    const position = beginning + match.index;
    if (position <= start && start <= position + match[0].length) return match[0];
  }
  return "";
}

// Return completed multiline brace blocks, skipping nested comments and Swift string delimiters.
function scanSwiftDelimiters(text, visit, conservative = false) {
  let pos = 0, row = 0, commentDepth = 0, closing = "", escape = "";
  while (pos < text.length) {
    const ch = text[pos];
    if (ch === "\n") { row++; pos++; if (closing && !closing.startsWith('"""')) closing = ""; continue; }
    if (commentDepth) {
      if (text.startsWith("/*", pos)) { commentDepth++; pos += 2; }
      else if (text.startsWith("*/", pos)) { commentDepth--; pos += 2; }
      else pos++;
      continue;
    }
    if (closing) {
      if (text.startsWith(closing, pos)) { pos += closing.length; closing = ""; }
      else if (text.startsWith(escape, pos)) { pos += escape.length; if (conservative && text[pos] === "(") return false; if (text[pos] !== "\n") pos++; }
      else pos++;
      continue;
    }
    if (text.startsWith("//", pos)) { const end = text.indexOf("\n", pos); pos = end < 0 ? text.length : end; continue; }
    if (text.startsWith("/*", pos)) { commentDepth = 1; pos += 2; continue; }
    if (ch === "#" || ch === '"') {
      let after = pos;
      while (text[after] === "#") after++;
      if (text[after] === '"') {
        const hashes = text.slice(pos, after);
        const quotes = text.startsWith('"""', after) ? '"""' : '"';
        closing = quotes + hashes;
        escape = "\\" + hashes;
        pos = after + quotes.length;
        continue;
      }
      pos = Math.max(pos + 1, after);
      continue;
    }
    // Slash can begin a Swift regex literal. A local scan cannot disambiguate it from an operator.
    if (conservative && ch === "/") return false;
    if ("{}[]()".includes(ch)) visit(ch,pos,row);
    pos++;
  }
  return !commentDepth && !closing;
}

export function foldableBlocks(text) {
  const stack = [], ranges = new Map();
  scanSwiftDelimiters(text, (ch, pos, row) => {
    if (ch === "{") stack.push(row);
    if (ch === "}" && stack.length) {
      const start = stack.pop();
      if (row > start) ranges.set(start, Math.max(row, ranges.get(start) || 0));
    }
  });
  return ranges;
}

// Coordinates follow textarea.selectionStart/End (UTF-16 with normalized LF).
export function editSourceCommand(command, text, start, end) {
  const selection = text.slice(start, end);
  const change = (from, to, insert, caret, limit = caret) => ({from, to, insert, start:caret, end:limit});
  if (command === "balance") {
    const pairs = {")":"(", "]":"[", "}":"{"}, stack = [];
    let result, invalid = false;
    const ok = scanSwiftDelimiters(text, (ch, pos) => {
      if ("([{".includes(ch)) { stack.push({ch,pos}); return; }
      const opener = stack.pop();
      if (opener?.ch !== pairs[ch]) { invalid = true; return; }
      if (!result && opener.pos <= start && end <= pos+1 && (opener.pos !== start || end !== pos+1)) {
        result = {start:opener.pos, end:pos+1};
      }
    }, true);
    return ok && !invalid && !stack.length ? result : undefined;
  }
  if (["upper","lower","capitalize"].includes(command)) {
    if (!selection) return;
    let converted;
    if (command === "upper") converted = selection.toUpperCase();
    else if (command === "lower") converted = selection.toLowerCase();
    else converted = selection.replace(/[\p{L}][\p{L}\p{M}\p{N}]*/gu, word => {
      const [initial, ...rest] = [...word];
      return initial.toUpperCase() + rest.join("").toLowerCase();
    });
    if (converted !== selection) return change(start,end,converted,start,start+converted.length);
    return;
  }
  if (!text.length) return;
  if (selection && command === "duplicate") return change(end,end,selection,end,end+selection.length);
  if (selection && command === "delete") return change(start,end,"",start);
  const lineStart = offset => offset ? text.lastIndexOf("\n",offset-1)+1 : 0;
  const lineEnd = offset => { const newline=text.indexOf("\n",offset); return newline<0 ? text.length : newline; };
  const first = lineStart(start), last = lineEnd(end > start ? end-1 : end);
  const lines = text.slice(first,last);
  if (command === "duplicate") {
    return change(last,last,"\n"+lines,start+lines.length+1);
  }
  if (command === "delete") {
    if (last < text.length) return change(first,last+1,"",first);
    const cut = Math.max(0,first-1);
    return change(cut,last,"",cut);
  }
  if (command === "up") {
    if (!first || (first === text.length && text.endsWith("\n"))) return;
    const prev = lineStart(first-1), offset = first-prev;
    const before = text.slice(prev,first-1);
    return change(prev,last,lines+"\n"+before,start-offset,end-offset);
  }
  if (command === "down") {
    if (last >= text.length-1) return;
    const next = lineEnd(last+1), following = text.slice(last+1,next), offset = following.length+1;
    return change(first,next,following+"\n"+lines,start+offset,Math.min(text.length,end+offset));
  }
}

const snippets = {
  "SwiftUI View": "struct MyView: View {\n    var body: some View {\n        Text(«\"Hello\"»)\n    }\n}",
  "Funkce": "func «name»() {\n    \n}",
  "Podmínka": "if «condition» {\n    \n}",
  "Cyklus": "for item in «items» {\n    \n}",
  "XCTest": "func test«Example»() throws {\n    XCTAssertTrue(true)\n}"
};
export function snippetEdit(template, before) {
  const line = before.slice(before.lastIndexOf("\n") + 1);
  const base = line.match(/^[ \t]*/)[0];
  const withIndent = template.replaceAll("\n", "\n" + base);
  const start = withIndent.indexOf("«"), stop = withIndent.indexOf("»");
  return {text: withIndent.replace("«", "").replace("»", ""), start, end: stop - 1};
}
const glossary = new Map(Object.entries({
  View: ["SwiftUI", "Protokol pohledu. Vlastnost body určuje obsah a rozložení.", "swiftui/view"],
  Text: ["SwiftUI", "Zobrazuje text v rozhraní.", "swiftui/text"],
  Button: ["SwiftUI", "Ovládací prvek s akcí a popiskem.", "swiftui/button"],
  State: ["SwiftUI", "Lokální stav pohledu, jehož změna vyvolá aktualizaci zobrazení.", "swiftui/state"],
  Binding: ["SwiftUI", "Obousměrná vazba na hodnotu vlastněnou jinde.", "swiftui/binding"],
  VStack: ["SwiftUI", "Rozloží podřízené pohledy svisle.", "swiftui/vstack"],
  HStack: ["SwiftUI", "Rozloží podřízené pohledy vodorovně.", "swiftui/hstack"],
  ZStack: ["SwiftUI", "Umístí podřízené pohledy přes sebe.", "swiftui/zstack"],
  List: ["SwiftUI", "Zobrazí řádky v posouvatelném seznamu.", "swiftui/list"],
  NavigationStack: ["SwiftUI", "Spravuje navigaci mezi pohledy v zásobníku.", "swiftui/navigationstack"],
  String: ["Swift", "Text tvořený znaky Unicode.", "swift/string"],
  Array: ["Swift", "Uspořádaná kolekce hodnot stejného typu.", "swift/array"],
  XCTestCase: ["XCTest", "Základní třída pro testovací případy XCTest.", "xctest/xctestcase"]
}));

function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

export function mountEditorTools(root, api, editor) {
  if (!root || !api || !editor || root.dataset.ready) return;
  root.dataset.ready = "true";
  const details = element("details");
  details.className = "group";
  details.append(element("summary", "Nástroje zdrojového kódu"));
  const body = element("div"); body.className = "group-body"; details.append(body);
  root.append(details);
  const status = element("p"); status.setAttribute("role", "status");
  function button(parent, label, action) {
    const control = element("button", label); control.type = "button";
    control.addEventListener("click", () => {
      try { action(); } catch (error) { status.textContent = error.message; }
    });
    parent.append(control);
    return control;
  }
  const touch = element("div"); touch.className = "inline-actions"; touch.setAttribute("aria-label","Znaky pro psaní kódu");
  function insert(value, start, end = start) {
    const from = editor.selectionStart;
    editor.dispatchEvent(new Event("beforeinput", {bubbles:true}));
    editor.setRangeText(value, from, editor.selectionEnd, "end");
    editor.focus();
    editor.setSelectionRange(from + start, from + end);
    editor.dispatchEvent(new Event("input", {bubbles:true}));
  }
  for (const pair of ["{}", "()", "[]", '""', ":", ".", "=", "->"]) {
    const paired = ['{}', '()', '[]', '""'].includes(pair);
    button(touch, pair, () => {
      const selection = editor.value.slice(editor.selectionStart, editor.selectionEnd);
      if (paired) insert(pair[0] + selection + pair[1], 1, 1 + selection.length);
      else insert(pair, pair.length);
    });
  }
  const sourceActions = element("div"); sourceActions.className = "inline-actions";
  const sourceChoice = element("select"); sourceChoice.setAttribute("aria-label","Úprava zdrojového kódu");
  for (const [key,label] of Object.entries({
    up:"Posunout řádky nahoru", down:"Posunout řádky dolů", duplicate:"Duplikovat výběr nebo řádek",
    delete:"Smazat výběr nebo řádek", upper:"Velká písmena", lower:"Malá písmena",
    capitalize:"Velká počáteční písmena", balance:"Vybrat okolní závorky ve Swiftu"
  })) sourceChoice.append(new Option(label,key));
  sourceActions.append(sourceChoice);
  button(sourceActions, "Provést úpravu", () => {
    const command = sourceChoice.value;
    if (command === "balance" && !api.getActive()?.endsWith(".swift")) {
      status.textContent = "Výběr závorek je dostupný pro Swift."; return;
    }
    const edit = editSourceCommand(command,editor.value,editor.selectionStart,editor.selectionEnd);
    if (!edit) { status.textContent = "V této pozici nelze příkaz použít."; return; }
    const direction = editor.selectionDirection;
    if (edit.insert !== undefined) {
      editor.dispatchEvent(new Event("beforeinput",{bubbles:true}));
      editor.setRangeText(edit.insert,edit.from,edit.to,"end");
    }
    editor.focus();
    editor.setSelectionRange(edit.start,edit.end,direction);
    if (edit.insert !== undefined) editor.dispatchEvent(new Event("input",{bubbles:true}));
    status.textContent = "";
  });
  const tools = element("div"); tools.className = "inline-actions";
  const choice = element("select"); choice.setAttribute("aria-label", "Úryvek kódu");
  for (const key of Object.keys(snippets)) choice.append(new Option(key, key));
  tools.append(choice);
  button(tools, "Vložit úryvek", () => {
    const edit = snippetEdit(snippets[choice.value], editor.value.slice(0, editor.selectionStart));
    insert(edit.text, edit.start, edit.end);
  });
  button(tools, "Přejmenovat / přesunout", () => {
    const path = api.getActive();
    const target = window.prompt("Nová cesta souboru v projektu", path);
    if (target === null || target === path) return;
    const next = renameSource(api.getProject(), path, target, editor.value);
    api.commitProject(next, target);
    status.textContent = "Soubor byl přesunut do " + target + ".";
  });
  const help = element("div"); help.setAttribute("role","status");
  button(tools, "Nápověda k symbolu", () => {
    const word = selectedIdentifier(editor.value, editor.selectionStart, editor.selectionEnd);
    help.replaceChildren();
    if (!word) { help.textContent = "Označ identifikátor nebo do něj umísti kurzor."; return; }
    const entry = glossary.get(word), title = element("strong", word);
    help.append(title, element("p", entry ? entry[0] + " · " + entry[1] : "Pro tento název není v místním slovníku žádné heslo."));
    const link = element("a", entry ? "Otevřít dokumentaci Apple" : "Vyhledat název v dokumentaci Apple");
    link.href = entry ? "https://developer.apple.com/documentation/" + entry[2] :
      "https://developer.apple.com/search/?q=" + encodeURIComponent(word);
    link.target = "_blank"; link.rel = "noopener noreferrer"; help.append(link);
  });
  const folding = element("details"); folding.className = "group";
  folding.append(element("summary", "Skládání bloků · pohled pro čtení"));
  const folded = new Set();
  const outline = element("div"); outline.className = "folded-source";
  outline.style.cssText = "max-height:55vh;overflow:auto;font:14px/1.6 ui-monospace,monospace";
  folding.append(outline);
  function renderFolded() {
    if (!details.open || !folding.open) return;
    outline.replaceChildren();
    const source = editor.value;
    if (!api.getActive()?.endsWith(".swift")) { outline.textContent = "Skládání je dostupné pro soubory Swift."; return; }
    if (source.length > 256 * 1024) { outline.textContent = "Skládání je dostupné do velikosti 256 tisíc znaků."; return; }
    const blocks = foldableBlocks(source), lines = source.split("\n"), fragment = document.createDocumentFragment();
    let plain = [];
    function flush() {
      if (!plain.length) return;
      const pre = element("pre",plain.join("\n")); pre.style.margin = "0"; fragment.append(pre); plain = [];
    }
    for (let line = 0; line < lines.length; line++) {
      if (!blocks.has(line)) { plain.push(lines[line] || " "); continue; }
      flush();
      const start = line, collapsed = folded.has(start), end = blocks.get(start);
      const control = button(fragment, (collapsed ? "▸ " : "▾ ") + lines[start] +
        (collapsed ? " … " + (end - start) + " ř." : ""), () => {
        if (folded.has(start)) folded.delete(start); else folded.add(start);
        renderFolded();
        outline.querySelector('[data-line="'+start+'"]')?.focus({preventScroll:true});
      });
      control.dataset.line = String(start);
      control.setAttribute("aria-expanded", String(!collapsed));
      control.style.cssText = "display:block;font:inherit;white-space:pre;text-align:left;padding:0 4px;min-height:32px";
      if (collapsed) line = end;
    }
    flush(); outline.append(fragment);
  }
  folding.addEventListener("toggle", renderFolded);
  details.addEventListener("toggle", renderFolded);
  let frame;
  editor.addEventListener("input", () => {
    folded.clear(); help.replaceChildren();
    if (details.open && folding.open) { cancelAnimationFrame(frame); frame = requestAnimationFrame(renderFolded); }
  });
  document.addEventListener("pocket:fileloaded", () => { folded.clear(); help.replaceChildren(); renderFolded(); });
  body.append(touch, sourceActions, tools, help, folding, status);
}

if (typeof document !== "undefined") {
  mountEditorTools(document.getElementById("editor-tools"), window.pocketIDE, document.getElementById("code"));
}
