import {STORAGE_KEY, newProject, validateProject, validateSettings} from "./core.mjs";

const closedKey = "swide-project-closed-v1";

function activeFile(project, requested) {
  const active = typeof requested === "string" && Object.hasOwn(project.files, requested)
    ? requested : Object.keys(project.files)[0];
  if (!active) throw Error("Projekt neobsahuje žádný textový soubor pro editor.");
  return active;
}

export function savedDraft(storage) {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) throw Error("V zařízení nebyl nalezen uložený projekt.");
  let draft;
  try { draft = JSON.parse(raw); }
  catch { throw Error("Uložený projekt se nepodařilo přečíst."); }
  const project = validateProject(draft.project);
  return {project, active:activeFile(project, draft.active), settings:validateSettings(draft.settings || {})};
}

// Source data lives in the existing autosave. Closing only records the workspace state.
export function createProjectSession(api, storage) {
  let closed = storage.getItem(closedKey) === "1";

  function open(project, active, settings) {
    api.commitProject(project, active, settings);
    if (closed) storage.removeItem(closedKey);
    closed = false;
  }
  function save() {
    if (closed) throw Error("Nejdřív otevři projekt.");
    api.save();
    return savedDraft(storage);
  }
  return {
    isClosed: () => closed,
    save,
    close() {
      if (closed) return;
      save();
      storage.setItem(closedKey, "1");
      closed = true;
    },
    reopen() {
      if (!closed) return;
      const draft = savedDraft(storage);
      open(draft.project, draft.active, {appName:draft.settings.appName});
    },
    create(name) {
      const appName = name.trim();
      if (!appName) throw Error("Zadej název projektu.");
      validateSettings({appName});
      const project = newProject();
      open(project, activeFile(project, "ContentView.swift"), {appName});
    },
    importJSON(text) {
      let input;
      try { input = JSON.parse(text); }
      catch { throw Error("Vybraný soubor neobsahuje platný JSON."); }
      const project = validateProject(input);
      open(project, activeFile(project, input.active));
    }
  };
}

function element(tag, text) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  return node;
}
function action(title, callback) {
  const button = element("button", title);
  button.type = "button";
  button.addEventListener("click", callback);
  return button;
}

export function mountProjectSession(root, api, storage) {
  if (!root || !api) return;
  const session = createProjectSession(api, storage);
  const shell = [...document.querySelectorAll("body > header, body > nav, body > main")];
  const start = element("section");
  start.id = "project-start-screen";
  start.hidden = true;
  start.setAttribute("aria-label", "Projekty");
  start.style.cssText = "grid-area:1/1/-1/-1;align-self:start;justify-self:center;width:min(100%,40rem);padding:clamp(18px,5vw,40px);max-height:100%;overflow:auto";
  const heading = element("h1", "Projekty");
  heading.tabIndex = -1;
  const last = element("p");
  const activeMessage = element("p");
  const closedMessage = element("p");
  for (const region of [activeMessage, closedMessage]) region.setAttribute("role", "status");
  const picker = element("input");
  picker.type = "file"; picker.accept = ".json,application/json"; picker.hidden = true;
  document.body.append(start, picker);
  const feedback = text => { (session.isClosed() ? closedMessage : activeMessage).textContent = text; };
  function update(focus) {
    const closed = session.isClosed();
    for (const area of shell) area.hidden = closed;
    start.hidden = !closed;
    document.body.toggleAttribute("data-project-closed", closed);
    if (closed) {
      try { last.textContent = "Poslední projekt: " + savedDraft(storage).settings.appName; }
      catch { last.textContent = "Uložený projekt není dostupný."; }
      if (focus) heading.focus();
    } else if (focus) {
      const files = document.querySelector('.activity-rail [data-view="project"]');
      files?.click(); files?.focus();
    }
  }
  function run(fn) {
    try { fn(); }
    catch (error) { feedback(error.message || String(error)); }
  }
  function replaceOK() {
    return window.confirm("Nahradit současný místní projekt? Jeho samostatnou kopii si můžeš předem uložit pomocí Export JSON.");
  }
  const actions = {
    isClosed: session.isClosed,
    save: () => run(() => {
      const draft = session.save();
      feedback("Projekt " + draft.settings.appName + " je uložen v tomto zařízení.");
    }),
    close: () => run(() => {
      if (session.isClosed()) return;
      session.close(); closedMessage.textContent = "";
      update(true);
    }),
    reopen: () => run(() => {
      session.reopen(); update(true);
      feedback("Projekt otevřen.");
    }),
    newProject: () => run(() => {
      const name = window.prompt("Název nového projektu", "MyApp");
      if (name === null) return;
      // Validate the name before asking to replace the active workspace.
      if (!name.trim()) throw Error("Zadej název projektu.");
      validateSettings({appName:name.trim()});
      if (!replaceOK()) return;
      session.create(name); update(true); feedback("Nový projekt je uložen v zařízení.");
    }),
    openJSON: () => { picker.value = ""; picker.click(); },
    openOriginal: () => run(() => {
      if (session.isClosed()) {
        session.reopen();
        update(false);
      }
      document.querySelector('.activity-rail [data-command="original"]').click();
    })
  };
  picker.addEventListener("change", async () => {
    const file = picker.files?.[0];
    if (!file) return;
    try {
      if (file.size > 4_000_000) throw Error("JSON projektu musí mít nejvýše 4 MB.");
      const text = await file.text();
      // Validate before asking for replacement. A failed read leaves the draft intact.
      validateProject(JSON.parse(text));
      if (!replaceOK()) return;
      session.importJSON(text); update(true); feedback("Projekt otevřen ze Souborů.");
    } catch (error) { feedback(error.message || String(error)); }
  });
  const activeActions = element("div");
  activeActions.className = "project-actions";
  activeActions.append(action("Uložit projekt", actions.save), action("Nový projekt", actions.newProject),
    action("Zavřít projekt", actions.close));
  root.append(activeActions, activeMessage);
  const closedActions = element("div");
  closedActions.className = "project-actions";
  closedActions.append(action("Znovu otevřít projekt", actions.reopen), action("Otevřít JSON…", actions.openJSON),
    action("Otevřít ZIP nebo složku", actions.openOriginal), action("Nový projekt", actions.newProject));
  start.append(heading, last, closedActions, closedMessage);
  // A hidden editor must not respond to its global command-palette shortcuts.
  window.addEventListener("keydown", event => {
    if (session.isClosed() && (event.metaKey || event.ctrlKey)) {
      event.stopPropagation();
    }
  }, {capture:true});
  update(false);
  window.pocketProjectSession = actions;
  return actions;
}

if (typeof document !== "undefined") {
  mountProjectSession(document.getElementById("project-session"), window.pocketIDE, window.localStorage);
}
