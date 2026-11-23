// Additional editor controls share project state through the app module.
(() => {
  const id = key => document.getElementById(key);
  const api = () => window.pocketIDE;
  const editor = id("code");
  const checkpointKey = "pocket-ide-checkpoint-v1";
  const panelKey = "pocket-ide-panel-v1";
  const projectModeKey = "swide-project-mode-v1";
  let archiveMode = false, archiveState = {open:false,name:""};
  try { archiveMode = localStorage.getItem(projectModeKey) === "archive"; } catch {}
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
  function selectPanel(name, topic = "files", railCommand = null) {
    document.body.dataset.workspace = name;
    id("file-actions-menu").hidden = true;
    id("file-actions").setAttribute("aria-expanded","false");
    if (name === "project") {
      document.body.dataset.projectTopic = topic;
      for (const part of document.querySelectorAll(".project [data-topic]")) {
        part.hidden = part.dataset.topic !== topic;
        if (part.tagName === "DETAILS") part.open = !part.hidden;
      }
    }
    const panels = [...document.querySelectorAll("[data-view-panel], [data-panel]")].filter(p => !p.matches("button,a"));
    if (!panels.some(p => (p.dataset.viewPanel || p.dataset.panel) === name)) return;
    inlineStatus.remove();
    for (const panel of panels) {
      const active = (panel.dataset.viewPanel || panel.dataset.panel) === name;
      panel.hidden = !active;
      panel.classList.toggle("active", active);
    }
    for (const control of document.querySelectorAll(".activity-rail button")) {
      const primaryView = name === "preview" ? "console" : name;
      const active = railCommand ? control.dataset.command === railCommand || control.dataset.view === railCommand
        : control.dataset.view === primaryView;
      if (active) control.setAttribute("aria-current", "page");
      else control.removeAttribute("aria-current");
      control.classList.toggle("active", active);
    }
    try { localStorage.setItem(panelKey, name); } catch {}
  }
  function projectTitle() {
    document.body.dataset.projectMode = archiveMode ? "archive" : "swide";
    id("ide-title").hidden = archiveMode;
    id("archive-title").hidden = !archiveMode;
    id("archive-title").textContent = archiveState.name || "ZIP nebo složka";
    id("project-kind").textContent = archiveMode ? "Projekt ze ZIPu nebo složky" : "Projekt SwiDe";
    const archiveUnavailable = archiveMode && (!archiveState.open || archiveState.busy);
    id("save-current").disabled = id("close-current").disabled = archiveUnavailable;
  }
  function setProjectMode(archive) {
    archiveMode = archive;
    projectTitle();
    try { localStorage.setItem(projectModeKey, archive ? "archive" : "swide"); } catch {}
  }
  function showMenu(topic) {
    selectPanel("project", topic, "tools");
    id(topic+"-title").focus();
  }
  function showArchive(tab = "project") {
    setProjectMode(true);
    selectPanel("project","zip",tab);
    const target = {
      project:"zip-workspace",
      code:"zip-editor",
      console:"zip-build"
    }[tab];
    const section = id(target);
    if (section && !section.hidden) {
      section.scrollIntoView({block:"start"});
      section.focus({preventScroll:true});
    }
  }
  function navigate(name) {
    if (archiveMode && ["project","code","console","preview"].includes(name)) {
      showArchive(name === "preview" ? "console" : name);
      return;
    }
    selectPanel(name);
  }
  document.addEventListener("pocket:zip-state", event => {
    archiveState = event.detail;
    projectTitle();
  });
  document.addEventListener("pocket:show-standard", () => {
    setProjectMode(false);
    selectPanel("project");
  });
  document.addEventListener("pocket:project-feedback", event => {
    if (archiveMode) return;
    id("project-kind").textContent = event.detail.message;
  });
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
    if (panel) { setProjectMode(false); selectPanel(panel.dataset.viewPanel || panel.dataset.panel); }
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
  function icon(name) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg"), use = document.createElementNS(ns, "use");
    svg.setAttribute("aria-hidden", "true");
    use.setAttribute("href", "#ico-" + name);
    svg.append(use);
    return svg;
  }
  let selectedPath = "", lastActive = "", treeExpanded = true;
  function renderPeek() {
    const path = selectedPath, image = api().getProject().binaries?.[path];
    id("navigator-preview").hidden = !image;
    id("peek-name").textContent = path.split("/").pop();
    const preview = id("peek-code");
    preview.replaceChildren();
    if (image) {
      const img = document.createElement("img");
      img.alt = path.split("/").pop();
      img.src = "data:" + image.mime + ";base64," + image.base64;
      preview.append(img);
    }
  }
  function renderTree() {
    const root = id("tree");
    if (!root || !api()) return;
    const project = api().getProject(), active = api().getActive();
    if (active !== lastActive || !(Object.hasOwn(project.files, selectedPath) || Object.hasOwn(project.binaries || {}, selectedPath)))
      selectedPath = active;
    lastActive = active;
    id("tree-root-title").textContent = id("app-name").value.trim() || id("ide-title").textContent;
    const query = id("ide-filter").value.trim().toLocaleLowerCase();
    const tree = new Map();
    function add(path, directory) {
      if (!path.toLocaleLowerCase().includes(query)) return;
      const parts = path.split("/");
      let branch = tree;
      parts.forEach((part, i) => {
        if (!directory && i === parts.length - 1) branch.set(part, path);
        else {
          if (!branch.has(part)) branch.set(part, new Map());
          branch = branch.get(part);
        }
      });
    }
    for (const path of project.dirs || []) add(path, true);
    for (const path of [...Object.keys(project.files), ...Object.keys(project.binaries || {})]) add(path, false);
    root.replaceChildren();
    function draw(branch, parent, prefix) {
      for (const [name, value] of [...branch].sort(([an,av], [bn,bv]) => Number(bv instanceof Map)-Number(av instanceof Map) || an.localeCompare(bn))) {
        const full = prefix + name;
        if (value instanceof Map) {
          const expanded = !!query || !folded.has(full);
          const control = button(name, () => {
            if (folded.has(full)) folded.delete(full); else folded.add(full);
            renderTree();
            Array.from(root.querySelectorAll("[data-dir]")).find(b=>b.dataset.dir === full)?.focus({preventScroll:true});
          }, "tree-folder");
          control.dataset.dir = full;
          control.prepend(icon("down"), icon("folder"));
          control.setAttribute("aria-expanded", String(expanded));
          parent.append(control);
          if (expanded) {
            const group = document.createElement("div");
            group.className = "tree-group";
            draw(value, group, full + "/"); parent.append(group);
          }
        } else {
          const item = button(name, () => {
            if (Object.hasOwn(project.files,value)) {
              try { open(value); } catch (error) { report(error.message, true); }
              return;
            }
            selectedPath = value;
            for (const file of root.querySelectorAll("[data-path]")) {
              file.classList.toggle("active", file === item);
              if (file === item) file.setAttribute("aria-current", "true"); else file.removeAttribute("aria-current");
            }
            renderPeek();
          }, "tree-file");
          item.title = value;
          item.dataset.path = value;
          const kind = /\.swift$/i.test(name) ? "swift" : Object.hasOwn(project.binaries || {}, value) ? "photo" : "doc";
          item.dataset.kind = kind; item.prepend(icon(kind));
          if (value === selectedPath) {
            item.classList.add("active"); item.setAttribute("aria-current", "true");
          }
          parent.append(item);
        }
      }
    }
    draw(tree, root, "");
    if (!tree.size) root.textContent = query ? "Žádné odpovídající soubory." : "Projekt je prázdný.";
    root.hidden = !(query || treeExpanded);
    id("tree-root").setAttribute("aria-expanded", String(!root.hidden));
    renderPeek();
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
    if (panel) {
      const map = {"project-search":"tools", "connect-token":"tools"};
      selectPanel(panel.dataset.viewPanel || panel.dataset.panel, control.closest("[data-topic]")?.dataset.topic, map[key]);
    }
    const details = control.closest("details");
    if (details) details.open = true;
    control.focus();
  }
  function revealTool(key) {
    const box=id(key);
    const panel=box.closest("[data-panel]");
    if (panel) {
      const map = {"source-control":"tools", issues:"console", "debug-report":"console"};
      selectPanel(panel.dataset.panel,box.closest("[data-topic]")?.dataset.topic,map[key]);
    }
    if (key === "issues" || key === "debug-report") id("build-diagnostics").open = true;
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
    "projects":["Otevřít nebo přepnout projekt",()=>showMenu("projects")],
    "tools":["Další nástroje",()=>showMenu("tools")],
    "standard-project":["Aktuální projekt SwiDe",()=>document.dispatchEvent(new Event("pocket:show-standard"))],
    "new-project":["Nový projekt SwiDe",()=>window.pocketProjectSession.newProject()],
    "preview":["Náhled v simulátoru",()=>navigate("preview")],
    "snapshots":["Import, export a kontrolní bod projektu",()=>revealTool("snapshots")],
    "device":["Přidat jednotlivé soubory",()=>revealTool("device-files")],
    "session":["Uložit, zavřít nebo vytvořit projekt",()=>revealTool("project-session")],
    "save-project":["Uložit projekt v zařízení",()=>{
      if (archiveMode) {
        showArchive();
        id("zip-save").click();
      } else window.pocketProjectSession.save();
    }],
    "close-project":["Uložit a zavřít projekt",()=>{
      if (archiveMode) { showArchive(); id("zip-close").click(); }
      else window.pocketProjectSession.close();
    }],
    "open-zip":["Otevřít ZIP",()=>{
      showArchive();
      document.dispatchEvent(new Event("pocket:pick-zip"));
    }],
    "open-folder":["Otevřít složku",()=>{
      showArchive();
      document.dispatchEvent(new Event("pocket:pick-folder"));
    }],
    "assets":["Spravovat obrázky a imagesety",()=>revealTool("assets")],
    "language":["Swift · přejít na definici a doplnit kód",()=>revealTool("language-tools")],
    "editor-tools":["Šablony, skládání kódu a přesun souboru",()=>revealTool("editor-tools")],
    "diff":["Zobrazit změny zdrojových souborů",()=>revealTool("source-control")],
    "debug-report":["Zobrazit zásobník a proměnné LLDB",()=>revealTool("debug-report")],
    "issues":["Diagnostika kompilátoru a výsledky testů",()=>{if (archiveMode) showArchive("console"); else revealTool("issues");}],
    "original":["Projekt ze ZIPu nebo složky",()=>showArchive()],
    "open-quickly":["Rychle otevřít soubor podle názvu nebo cesty", () => invokePalette("files")],
    "project-search":["Hledat v projektu", () => focusControl("project-search")],
    "find":["Hledat v souboru", () => focusControl("find-text")],
    "find-next":["Najít další výskyt", () => find()],
    "replace":["Nahradit výskyt", () => replace(false)],
    "replace-all":["Nahradit vše v souboru", () => replace(true)],
    "goto-line":["Přejít na řádek", goToLine],
    "checkpoint":["Uložit kontrolní bod", checkpoint],
    "restore":["Obnovit kontrolní bod", restore],
    "review":["Zkontrolovat projekt", () => {if (archiveMode) showArchive("console"); else {selectPanel("console"); api().review();}}],
    "build":["Sestavit aplikaci", () => id("btn-build").click()],
    "refresh":["Obnovit běhy", () => { selectPanel("console"); id("btn-refresh").click(); }],
    "export":["Exportovat projekt", () => id("btn-export").click()],
    "import":["Otevřít projekt JSON", () => window.pocketProjectSession.openJSON()],
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
  document.addEventListener("pocket:github-required", () => focusControl("connect-token"));
  document.addEventListener("pocket:show-build", () => showArchive("console"));
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
    if (control.dataset.view) navigate(control.dataset.view);
    const command = control.dataset.command;
    if (command === "palette") invokePalette();
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
  id("btn-device-import").addEventListener("click", () => {
    id("file-feedback").hidden = true;
    document.dispatchEvent(new Event("pocket:import-files"));
  });
  document.addEventListener("pocket:zip-selected", event => {
    showArchive();
    document.dispatchEvent(new CustomEvent("pocket:open-zip", {detail:{file:event.detail.file}}));
  });
  document.addEventListener("pocket:device-status", event => {
    const feedback = id("file-feedback");
    feedback.hidden = false;
    feedback.textContent = event.detail.message;
    feedback.dataset.type = event.detail.error ? "error" : "info";
  });
  document.addEventListener("pocket:device-imported", event => {
    const path = event.detail?.paths?.[0], project = api().getProject();
    if (!path || !(Object.hasOwn(project.files,path) || Object.hasOwn(project.binaries || {},path))) return;
    selectedPath=path; lastActive=api().getActive(); treeExpanded=true;
    const parts=path.split("/");
    for (let n=1; n<parts.length; n++) folded.delete(parts.slice(0,n).join("/"));
    id("ide-filter").value="";
    selectPanel("project","files"); renderTree();
    const row = Array.from(id("tree").querySelectorAll("[data-path]")).find(item=>item.dataset.path===path);
    row?.focus({preventScroll:true}); row?.scrollIntoView({block:"nearest"});
  });
  id("tree-root").addEventListener("click", () => { treeExpanded=!treeExpanded; renderTree(); });
  id("file-actions").addEventListener("click", () => {
    const menu=id("file-actions-menu");
    menu.hidden=!menu.hidden; id("file-actions").setAttribute("aria-expanded",String(!menu.hidden));
  });
  id("file-actions-menu").addEventListener("click", () => {
    id("file-actions-menu").hidden=true; id("file-actions").setAttribute("aria-expanded","false");
  });
  id("app-name").addEventListener("input",renderTree);
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
  projectTitle();
  navigate(["project","code","preview","console"].includes(initial) ? initial : "project");
})();
