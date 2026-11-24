import assert from "node:assert/strict";
import test from "node:test";
import {newProject, STORAGE_KEY} from "../web/core.mjs";
import {createProjectSession, savedDraft} from "../web/project-session.mjs";

function workspace() {
  const entries = new Map();
  const storage = {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key)
  };
  const draft = {
    project:newProject(), active:"ContentView.swift",
    settings:{appName:"Archiv", bundleId:"cz.example.archiv", repo:"example/archive"}, builds:[{run_id:123}]
  };
  const api = {
    save() { storage.setItem(STORAGE_KEY, JSON.stringify(draft)); },
    commitProject(project, active, settings) {
      const next = {...draft, project, active, settings:{...draft.settings, ...settings}};
      storage.setItem(STORAGE_KEY, JSON.stringify(next));
      Object.assign(draft, next);
    }
  };
  api.save();
  return {entries, storage, draft, api, session:createProjectSession(api, storage)};
}

test("close saves the latest changes; reopen recovers the original draft after restart", () => {
  const {entries, storage, draft, api, session} = workspace();
  draft.project.files[draft.active] = "// déšť 🌦️\n";
  session.close();
  assert.equal(session.isClosed(), true);
  assert.throws(() => session.save(), /otevři/);
  assert.equal([...entries.values()].filter(value => String(value).includes("déšť")).length, 1);
  const reopened = createProjectSession(api, storage);
  assert.equal(reopened.isClosed(), true);
  reopened.reopen();
  assert.equal(reopened.isClosed(), false);
  assert.equal(createProjectSession(api, storage).isClosed(), false);
  assert.equal(draft.project.files[draft.active], "// déšť 🌦️\n");
  assert.equal(draft.active, "ContentView.swift");
  assert.equal(draft.settings.bundleId, "cz.example.archiv");
  assert.deepEqual(draft.builds, [{run_id:123}]);
});

test("quota failure leaves the editor open and the saved copy intact", () => {
  const {storage, draft, session} = workspace();
  const initial = storage.getItem(STORAGE_KEY);
  draft.project.files[draft.active] = "// still editable";
  storage.setItem = () => { throw Error("QuotaExceededError"); };
  assert.throws(() => session.close(), /Quota/);
  assert.equal(session.isClosed(), false);
  assert.equal(storage.getItem(STORAGE_KEY), initial);
});

test("corrupt saved draft and malformed import keep the closed workspace intact", () => {
  const {storage, draft, session} = workspace();
  session.close();
  const before = JSON.stringify(draft);
  assert.throws(() => session.importJSON("{"), /JSON/);
  assert.throws(() => session.importJSON('{"files":{}}'), /projekt/i);
  storage.setItem(STORAGE_KEY, "{");
  assert.throws(() => session.reopen(), /nepodařilo/);
  assert.equal(session.isClosed(), true);
  assert.equal(JSON.stringify(draft), before);
});

test("a named new project opens normally and validates before replacing the old draft", () => {
  const {storage, draft, session} = workspace();
  session.close();
  const previous = storage.getItem(STORAGE_KEY);
  assert.throws(() => session.create("   "));
  assert.throws(() => session.create("!!"));
  assert.equal(storage.getItem(STORAGE_KEY), previous);
  session.create("MujProjekt");
  assert.equal(session.isClosed(), false);
  assert.equal(draft.settings.appName, "MujProjekt");
  assert.equal(draft.settings.repo, "");
  assert.equal(draft.active, "ContentView.swift");
  assert.match(draft.project.files[draft.active], /struct ContentView/);
});

test("opening an older export chooses an existing source file and persists it", () => {
  const {storage, draft, session} = workspace();
  session.close();
  const incoming = {format:"xcode-pocket-project", version:1, files:{"Old.swift":"let old = 1"}, active:"Missing.swift"};
  session.importJSON(JSON.stringify(incoming));
  assert.equal(draft.active, "Old.swift");
  assert.equal(session.isClosed(), false);
  assert.deepEqual(savedDraft(storage).project, incoming);
});
