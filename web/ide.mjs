// Additional editor controls share project state through the app module.
(() => {
  const id = key => document.getElementById(key);
  const api = () => window.pocketIDE;
  const editor = id("code");
  const checkpointKey = "pocket-ide-checkpoint-v1";
  const panelKey = "pocket-ide-panel-v1";
  const folded = new Set();
  let paletteIndex = 0;
  let paletteMode = "commands";
  let paletteCommands = [];
  const dialog = id("command-dialog");

  function report(message, error = false) {
    id("status").textContent = message;
    id("status").dataset.type = error ? "error" : "info";
  }
  // Keep relevant feedback visible when an action originates outside the console.
  const status = id("status");
  const inlineStatus = document.createElement("div");
  inlineStatus.className = "status";
  inlineStatus.setAttribute("role", "status");
  inlineStatus.setAttribute("aria-live", "polite");
  inlineStatus.setAttribute("aria-atomic", "true");
  new MutationObserver(() => {
    const panel = document.querySelector("[data-view-panel]:not([hidden])");
    if (!panel || panel.contains(status)) { inlineStatus.remove(); return; }
    inlineStatus.textContent = status.textContent;
    inlineStatus.dataset.type = status.dataset.type || "info";
    panel.append(inlineStatus);
  }).observe(status, {subtree:true, childList:true, characterData:true});
  function selectPanel(name) {
    const panels = [...document.querySelectorAll("[data-view-panel], [data-panel]")].filter(p => !p.matches("button,a"));
    if (!panels.some(p => (p.dataset.viewPanel || p.dataset.panel) === name)) return;
    inlineStatus.remove();
    for (const panel of panels) {
      const active = (panel.dataset.viewPanel || panel.dataset.panel) === name;
      panel.hidden = !active;
      panel.classList.toggle("active", active);
    }
    for (const control of document.querySelectorAll("[data-view]")) {
      const active = control.dataset.view === name;
      if (active) control.setAttribute("aria-current", "page");
      else control.removeAttribute("aria-current");
      control.classList.toggle("active", active);
    }
    try { localStorage.setItem(panelKey, name); } catch {}
  }
  function button(label, action, className) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = className;
    item.textContent = label;
    item.addEventListener("click", action);
    return item;
  }
  function showCode() {
    const panel = editor.closest("[data-view-panel],[data-panel]");
    if (panel) selectPanel(panel.dataset.viewPanel || panel.dataset.panel);
  }
  function selectRange(start, end) {
    showCode();
    editor.focus();
    editor.setSelectionRange(start, end);
    editor.dispatchEvent(new Event("select", {bubbles: true}));
    const row = editor.value.slice(0, start).split("\n").length - 1;
    const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 20;
    editor.scrollTop = Math.max(0, row * lineHeight - editor.clientHeight / 3);
  }
  function open(path, start, end) {
    api().openFile(path);
    showCode();
    if (Number.isInteger(start)) selectRange(start, end);
  }
  function renderTree() {
    const root = id("tree");
    if (!root || !api()) return;
    const query = (id("ide-filter")?.value || "").trim().toLocaleLowerCase();
    const tree = new Map();
    for (const path of Object.keys(api().getProject().files).sort()) {
      if (!path.toLocaleLowerCase().includes(query)) continue;
      const parts = path.split("/");
      let branch = tree;
      parts.forEach((part, i) => {
        if (i === parts.length - 1) branch.set(part, path);
        else {
          if (!branch.has(part)) branch.set(part, new Map());
          branch = branch.get(part);
        }
      });
    }
    root.replaceChildren();
    function draw(branch, parent, prefix) {
      for (const [name, value] of [...branch].sort(([an,av], [bn,bv]) => Number(bv instanceof Map)-Number(av instanceof Map) || an.localeCompare(bn))) {
        const full = prefix + name;
        if (value instanceof Map) {
          const expanded = !!query || !folded.has(full);
          const control = button((expanded ? "▾ " : "▸ ") + name, () => {
            if (folded.has(full)) folded.delete(full); else folded.add(full);
            renderTree();
          }, "tree-folder");
          control.setAttribute("aria-expanded", String(expanded));
          parent.append(control);
          if (expanded) {
            const group = document.createElement("div");
            group.className = "tree-group";
            group.style.paddingInlineStart = "12px";
            draw(value, group, full + "/"); parent.append(group);
          }
        } else {
          const item = button(name, () => open(value), "tree-file");
          item.title = value;
          item.dataset.path = value;
          if (value === api().getActive()) {
            item.classList.add("active"); item.setAttribute("aria-current", "true");
          }
          parent.append(item);
        }
      }
    }
    draw(tree, root, "");
    if (!tree.size) root.textContent = "Žádné soubory.";
  }
  function renderResults() {
    const out = id("ide-results");
    if (!out || !api()) return;
    out.replaceChildren();
    const term = id("project-search").value;
    if (!term) return;
    let count = 0;
    for (const [path, original] of Object.entries(api().getProject().files)) {
      const source = path === api().getActive() ? editor.value : original;
      let index = source.indexOf(term), previous = 0, line = 1;
      while (index !== -1) {
        line += source.slice(previous, index).split("\n").length - 1;
        const offset = index;
        const sample = source.slice(index, index + 64).split("\n")[0];
        out.append(button(path + ":" + line + " · " + sample, () => open(path, offset, offset + term.length), "search-result"));
        if (++count === 100) {
          out.append(document.createTextNode("Zobrazeno prvních 100 výsledků.")); return;
        }
        previous = index; index = source.indexOf(term, index + term.length);
      }
    }
    if (!count) out.textContent = "Žádné výsledky.";
  }
  function match(next) {
    const term = id("find-text").value;
    if (!term) return -1;
    const start = next ? editor.selectionEnd : editor.selectionStart;
    const pos = editor.value.indexOf(term, start);
    return pos < 0 ? editor.value.indexOf(term) : pos;
  }
  function find(next = true, focus = true) {
    const term = id("find-text").value;
    const pos = match(next);
    if (pos < 0) {
      if (term) report("Text v souboru nenalezen.");
      return;
    }
    if (focus) selectRange(pos, pos + term.length);
    else editor.setSelectionRange(pos, pos + term.length);
  }
  function replace(all) {
    const term = id("find-text").value, replacement = id("replace-text").value;
    if (!term) return;
    if (all) {
      const pieces = editor.value.split(term);
      if (pieces.length === 1) return report("Text v souboru nenalezen.");
      const updated = pieces.join(replacement);
      editor.setRangeText(updated, 0, editor.value.length, "start");
      report("Počet nahrazených výskytů: " + (pieces.length - 1));
    } else {
      const index = match(false);
      if (index < 0) return report("Text v souboru nenalezen.");
      editor.setRangeText(replacement, index, index + term.length, "end");
    }
    editor.dispatchEvent(new Event("input", {bubbles:true}));
  }
  function goToLine() {
    const answer = prompt("Přejít na řádek číslo:");
    if (answer === null) return;
    const target = Number(answer), lines = editor.value.split("\n");
    if (!Number.isInteger(target) || target < 1 || target > lines.length) return report("Zadej řádek od 1 do " + lines.length + ".", true);
    let pos = 0;
    for (let i = 1; i < target; i++) pos += lines[i - 1].length + 1;
    selectRange(pos, pos);
  }
  function snapshot() {
    api().save();
    return JSON.stringify({project:api().getProject(), path:api().getActive(), date:new Date().toISOString()});
  }
  function checkpoint() {
    localStorage.setItem(checkpointKey, snapshot());
    window.dispatchEvent(new Event("pocket-checkpoint"));
    report("Kontrolní bod projektu uložen.");
  }
  function restore() {
    const stored = localStorage.getItem(checkpointKey);
    if (!stored) return report("Dosud není uložen žádný kontrolní bod.");
    const target = JSON.parse(stored);
    if (!target.project?.files) throw Error("Poškozený kontrolní bod.");
    if (!confirm("Obnovit kontrolní bod z " + new Date(target.date).toLocaleString("cs-CZ") + "? Současná verze se uloží jako další bod návratu.")) return;
    const current = snapshot();
    // Preserve current work first; if validation fails, reinstate the old checkpoint.
    localStorage.setItem(checkpointKey, current);
    try { api().setProject(target.project); }
    catch (error) { localStorage.setItem(checkpointKey, stored); throw error; }
    if (Object.prototype.hasOwnProperty.call(target.project.files, target.path)) api().openFile(target.path);
    report("Kontrolní bod obnoven. Předchozí verzi lze vrátit.");
  }
  function focusControl(key) {
    const control = id(key);
    const panel = control.closest("[data-view-panel],[data-panel]");
    if (panel) selectPanel(panel.dataset.viewPanel || panel.dataset.panel);
    const details = control.closest("details");
    if (details) details.open = true;
    control.focus();
  }
  function revealTool(key) {
    const box=id(key);
    const panel=box.closest("[data-panel]");
    if (panel) selectPanel(panel.dataset.panel);
    const control=box.querySelector("button:not(:disabled),input:not(:disabled),select:not(:disabled),summary") || box;
    let section=control.closest("details");
    while (section) {
      section.open=true;
      section=section.parentElement?.closest("details");
    }
    control.focus();
    box.scrollIntoView({block:"nearest"});
  }
  const definitions = {
    "assets":["Spravovat obrázky a imagesety",()=>revealTool("assets")],
    "language":["Swift · přejít na definici a doplnit kód",()=>revealTool("language-tools")],
    "editor-tools":["Šablony, skládání kódu a přesun souboru",()=>revealTool("editor-tools")],
    "diff":["Zobrazit změny zdrojových souborů",()=>revealTool("source-control")],
    "debug-report":["Zobrazit zásobník a proměnné LLDB",()=>revealTool("debug-report")],
    "issues":["Diagnostika kompilátoru a výsledky testů",()=>revealTool("issues")],
    "original":["Otevřít nebo sestavit původní ZIP projekt",()=>revealTool("zip-workspace")],
    "open-quickly":["Rychle otevřít soubor podle názvu nebo cesty", () => invokePalette("files")],
    "project-search":["Hledat v projektu", () => focusControl("project-search")],
    "find":["Hledat v souboru", () => focusControl("find-text")],
    "find-next":["Najít další výskyt", () => find()],
    "replace":["Nahradit výskyt", () => replace(false)],
    "replace-all":["Nahradit vše v souboru", () => replace(true)],
    "goto-line":["Přejít na řádek", goToLine],
    "checkpoint":["Uložit kontrolní bod", checkpoint],
    "restore":["Obnovit kontrolní bod", restore],
    "review":["Zkontrolovat projekt", () => {selectPanel("console"); api().review();}],
    "build":["Sestavit aplikaci", () => id("btn-build").click()],
    "refresh":["Obnovit běhy", () => { selectPanel("console"); id("btn-refresh").click(); }],
    "export":["Exportovat projekt", () => id("btn-export").click()],
    "import":["Importovat projekt", () => id("btn-import").click()],
    "add":["Nový soubor", () => id("btn-add").click()],
    "remove":["Odstranit soubor", () => id("btn-remove").click()],
    "symbol":["Přejít na symbol", () => focusControl("symbol-outline")],
    "connection":["Nastavit připojení ke GitHubu", () => focusControl("connect-token")],
    "save":["Uložit soubor", () => { api().save(); report("Soubor uložen."); }]
  };
  for (const control of document.querySelectorAll("[data-edit]")) {
    definitions[control.dataset.edit] = [control.getAttribute("aria-label") || control.textContent, () => {
      showCode();
      control.click();
    }];
  }
  id("btn-build").addEventListener("click", () => {
    if (id("connection").dataset.connected === "true") selectPanel("console");
    else {
      focusControl("connect-token");
      const hint = id("connection-status");
      hint.textContent = "Pro sestavení připoj GitHub tokenem a znovu klepni na Sestavit.";
      hint.dataset.type = "info";
    }
  }, {capture:true});
  function run(key) {
    try { definitions[key]?.[1](); } catch (error) { report(error.message || String(error), true); }
  }
  function closePalette() {
    if (typeof dialog.close === "function" && dialog.open) dialog.close();
    else { dialog.removeAttribute("open"); dialog.hidden = true; }
  }
  function invokePalette(mode = "commands") {
    paletteMode = mode;
    const files = mode === "files";
    id("palette-title").textContent = files ? "Rychle otevřít" : "Paleta příkazů";
    id("query-label").textContent = files ? "Soubor nebo cesta" : "Najít příkaz";
    id("command-query").placeholder = files ? "ContentView.swift nebo ContentView.swift:12" : "Napiš název příkazu";
    dialog.hidden = false;
    if (typeof dialog.showModal === "function") { if (!dialog.open) dialog.showModal(); }
    else dialog.setAttribute("open", "");
    id("command-query").value = ""; renderPalette(); id("command-query").focus();
  }
  function renderPalette() {
    const field = id("command-query");
    const query = field.value.trim().toLocaleLowerCase();
    if (paletteMode === "files") {
      const all = api().getProject().files;
      const lineQuery = !Object.hasOwn(all, field.value.trim()) && /^(.*):([1-9][0-9]{0,5})$/.exec(query);
      const needle = lineQuery ? lineQuery[1] : query;
      const rank = path => {
        const name = path.split("/").pop().toLocaleLowerCase();
        if (name === needle) return 0;
        if (name.startsWith(needle)) return 1;
        return name.includes(needle) ? 2 : 3;
      };
      paletteCommands = Object.keys(all).filter(path => path.toLocaleLowerCase().includes(needle))
        .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map(path => ({
          label: path,
          action: () => {
            if (!lineQuery) {open(path); editor.focus(); return;}
            const lines = api().getProject().files[path].split("\n");
            const row = Number(lineQuery[2]);
            if (row > lines.length) {open(path); report("Soubor má pouze " + lines.length + " řádků.", true); return;}
            const offset = row > 1 ? lines.slice(0, row - 1).join("\n").length + 1 : 0;
            open(path, offset, offset);
          }
        }));
    } else {
      paletteCommands = Object.keys(definitions)
        .filter(key => (definitions[key][0] + " " + key).toLocaleLowerCase().includes(query))
        .map(key => ({label:definitions[key][0], action:() => run(key)}));
    }
    paletteIndex = 0;
    const list = id("command-list");
    field.setAttribute("aria-controls", list.id);
    list.replaceChildren(...paletteCommands.map(command => button(command.label, () => {closePalette(); command.action();}, "command-item")));
    if (!paletteCommands.length) list.textContent = paletteMode === "files" ? "Žádné odpovídající soubory." : "Žádné odpovídající příkazy.";
    highlightPalette();
  }
  function highlightPalette() {
    [...id("command-list").children].forEach((item, i) => {
      item.classList.toggle("active", i === paletteIndex);
      if (i === paletteIndex) {
        item.setAttribute("aria-current", "true"); item.scrollIntoView({block:"nearest"});
      } else item.removeAttribute("aria-current");
    });
  }
  document.addEventListener("click", e => {
    const control = e.target.closest("[data-command], [data-view], #palette-open");
    if (!control) return;
    if (control.dataset.view) selectPanel(control.dataset.view);
    const command = control.dataset.command;
    if (control.id === "palette-open" || command === "palette") invokePalette();
    else if (command === "close-palette") closePalette();
    else if (command && !["btn-build","btn-refresh","btn-export","btn-import","btn-add"].includes(control.id)) run(command);
  });
  id("command-query").addEventListener("input", renderPalette);
  id("command-query").addEventListener("keydown", e => {
    if (!paletteCommands.length) return;
    if (e.key === "Enter") { e.preventDefault(); closePalette(); paletteCommands[paletteIndex].action(); }
    else if (["ArrowDown","ArrowUp"].includes(e.key)) {
      e.preventDefault();
      paletteIndex = (paletteIndex + (e.key === "ArrowDown" ? 1 : -1) + paletteCommands.length) % paletteCommands.length;
      highlightPalette();
    }
  });
  dialog.addEventListener("click", e => { if (e.target === dialog) closePalette(); });
  document.addEventListener("keydown", e => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key.toLowerCase() === "k" || (e.shiftKey && e.key.toLowerCase() === "p"))) { e.preventDefault(); invokePalette(); }
    else if (mod && e.shiftKey && e.key.toLowerCase() === "o") { e.preventDefault(); invokePalette("files"); }
    else if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); run(e.shiftKey ? "project-search" : "find"); }
    else if (mod && e.key.toLowerCase() === "l" && e.target === editor) { e.preventDefault(); run("goto-line"); }
    else if (e.key === "Escape" && dialog.open) { e.preventDefault(); closePalette(); }
  });
  id("ide-filter")?.addEventListener("input", renderTree);
  id("project-search").addEventListener("input", renderResults);
  id("find-text").addEventListener("input", () => find(false, false));
  id("find-text").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); find(); }});
  editor.addEventListener("input", renderResults);
  function render() { renderTree(); renderResults(); }
  window.addEventListener("pocket-render", render);
  render();
  let initial = "";
  try { initial = localStorage.getItem(panelKey) || ""; } catch {}
  if (initial) selectPanel(initial);
})();
