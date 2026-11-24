import {SHA_RE, UUID_RE, sameRepository} from "./core.mjs";
import {openZipWorkspace} from "./zip-workspace.mjs";

const WORKFLOW = "pocket-language.yml";
const LAST = "pocket-last-language-v1";
const element = (tag, text) => {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  return el;
};

export function cursorPosition(text, offset) {
  const rows = text.slice(0, offset).split(/\r\n|\r|\n/);
  return {line:rows.length - 1, character:rows.at(-1).length};
}
function sourceOffset(text, line, character) {
  const start = [...text.matchAll(/\r\n|\r|\n/g)];
  if (!Number.isInteger(line) || !Number.isInteger(character) || line < 0 || character < 0 || line > start.length) return null;
  const offset = line ? start[line - 1].index + start[line - 1][0].length : 0;
  return offset + character <= (start[line]?.index ?? text.length) ? offset + character : null;
}
async function digest(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
export function validateLanguageResult(result, record) {
  if (!record || !result || result.schema !== "pocket-sourcekit/v1" || result.engine !== "sourcekit-lsp" ||
      !UUID_RE.test(record.request_id) || !SHA_RE.test(record.source_sha) ||
      result.request_id !== record.request_id || result.source_sha !== record.source_sha ||
      result.mode !== record.mode || result.file !== record.file || result.source_digest !== record.sourceDigest ||
      result.position?.line !== record.position.line || result.position?.character !== record.position.character ||
      !["ok","empty","unavailable"].includes(result.status) || !Array.isArray(result.items) || result.items.length > 50) {
    throw Error("Výsledek neodpovídá vybranému dotazu, souboru a verzi projektu.");
  }
  return result;
}

export async function findLanguageRun(api, record) {
  if (!api || !sameRepository(api.repo,record?.repo) || !UUID_RE.test(record.request_id) || !SHA_RE.test(record.source_sha))
    throw Error("Připoj stejný GitHub repozitář jako při odeslání dotazu.");
  const candidates = [];
  for (let page=1; page<=5; page++) {
    const data = await api.request("GET", "/actions/workflows/" + WORKFLOW + "/runs?event=workflow_dispatch&branch=main&per_page=100&page=" + page);
    const runs = data.workflow_runs || [];
    candidates.push(...runs.filter(r => r.display_title === "Pocket SourceKit " + record.request_id &&
      sameRepository(r.repository?.full_name,api.repo) && Number.isSafeInteger(r.id) &&
      r.event === "workflow_dispatch" && r.head_branch === "main" &&
      String(r.path || "").split("@")[0] === ".github/workflows/" + WORKFLOW));
    if (runs.length < 100) break;
  }
  if (candidates.length > 1) throw Error("Více běhů se stejným UUID. Výsledek nelze přiřadit.");
  if (!candidates.length) return null;
  const run = candidates[0], url = "https://github.com/" + api.repo + "/actions/runs/" + run.id;
  const artifacts = run.conclusion === "success" ? await api.artifacts(run.id) : [];
  const matches = artifacts.filter(a => !a.expired && Number.isSafeInteger(a.id) &&
    (!a.workflow_run || a.workflow_run.id === run.id) && a.name === "pocket-language-" + record.request_id + "-" + record.source_sha);
  if (matches.length > 1) throw Error("Běh má více výsledků se stejnou identitou.");
  return {url, status:run.conclusion || run.status, artifact:matches[0] ? url + "/artifacts/" + matches[0].id : null};
}

export function mountLanguageTools(container) {
  const group = element("details"), summary = element("summary", "Swift · definice a doplňování");
  const controls = element("div"), actions = element("div"), status = element("p");
  const links = element("div"), list = element("ul");
  actions.className = "inline-actions"; controls.className = "group-body"; group.className = "group";
  status.setAttribute("role", "status");
  const button = text => {const b = element("button", text); b.type = "button"; actions.append(b); return b;};
  const local = button("Najít text lokálně"), upload = button("Otevřít historický výsledek");
  const input = element("input"); input.type = "file"; input.accept = ".json,.zip"; input.hidden = true;
  const ide = () => globalThis.pocketIDE;
  const code = () => document.getElementById("code");
  let record, busy = false;
  try { record = JSON.parse(localStorage.getItem(LAST)); } catch {}
  function controlsState() {
    local.disabled = busy;
    upload.hidden = !record;
    upload.disabled = busy || !record;
  }
  function lock(action) {
    return async () => {
      if (busy) return;
      busy = true; controlsState();
      try { await action(); } catch (err) { status.textContent = err.message || String(err); }
      finally { busy = false; controlsState(); }
    };
  }
  function go(file, line, character) {
    const text = ide().getProject().files[file];
    if (typeof text !== "string") throw Error("Soubor v projektu chybí.");
    const offset = sourceOffset(text, line, character);
    if (offset === null) throw Error("Pozice v souboru se změnila.");
    ide().openFile(file); code().focus();
    // Textarea.value normalizes CR and CRLF to LF.
    const target = text.slice(0, offset).replace(/\r\n|\r/g, "\n").length;
    code().setSelectionRange(target, target);
    const height = parseFloat(getComputedStyle(code()).lineHeight);
    if (height) code().scrollTop = Math.max(0, (line - 2) * height);
  }
  function entry(text, jump) {
    const li = element("li");
    if (jump) {
      const b = element("button", text); b.type = "button";
      b.addEventListener("click", lock(jump)); li.append(b);
    } else li.textContent = text;
    list.append(li);
  }
  async function renderResult(file) {
    if (!file || file.size > 256*1024) throw Error("Vyber výsledný JSON nebo ZIP do 256 KiB.");
    let text;
    if (file.name.toLowerCase().endsWith(".zip")) {
      const entries = await openZipWorkspace(new Uint8Array(await file.arrayBuffer()));
      const json = entries.find(e => e.path === "language-result.json");
      if (!json?.text || json.size > 256*1024) throw Error("V archivu chybí language-result.json.");
      text = json.text;
    } else text = await file.text();
    const result = validateLanguageResult(JSON.parse(text), record);
    list.replaceChildren(); links.replaceChildren();
    const title = result.mode === "completion" ? "návrhy" : "definice";
    status.textContent = "SourceKit-LSP · " + title + " · " + result.file + ":" + (result.position.line + 1) + " · " +
      (result.status === "unavailable" ? "nedostupné: " + (result.message || "") :
       result.status === "empty" ? "bez výsledků" : result.items.length + " výsledků" + (result.partial ? " (výběr)" : ""));
    if (result.mode === "definition" && result.indexTypecheckSucceeded === false)
      status.textContent += " · index projektu se nepodařilo sestavit";
    async function currentSnapshot() {
      ide().save();
      if (await digest(JSON.stringify(ide().getProject())) !== record.projectDigest)
        throw Error("Projekt byl změněn. Pro tento krok spusť nový dotaz.");
    }
    for (const item of result.items) {
      if (result.mode === "completion") {
        const title = item.label + (item.detail ? " — " + item.detail : "");
        const edit = item.edit;
        if (!edit) { entry(title); continue; }
        entry("Vložit · " + title, async () => {
          await currentSnapshot();
          if (typeof edit.text !== "string" || edit.text.length > 2048) throw Error("Neplatný návrh doplnění.");
          ide().openFile(result.file);
          const editor = code(), range = edit.range;
          const start = sourceOffset(editor.value, range?.start?.line, range?.start?.character);
          const end = sourceOffset(editor.value, range?.end?.line, range?.end?.character);
          if (start === null || end === null || end < start) throw Error("Rozsah návrhu neodpovídá souboru.");
          editor.focus(); editor.setRangeText(edit.text, start, end, "end");
          editor.dispatchEvent(new Event("input", {bubbles:true}));
          status.textContent = "Doplnění vloženo do " + result.file + ".";
        });
      } else if (item.external) entry("Mimo projekt · " + item.label);
      else entry(item.file + ":" + (item.line + 1) + ":" + (item.character + 1), async () => {
        await currentSnapshot();
        go(item.file, item.line, item.character);
      });
    }
  }
  upload.addEventListener("click", () => input.click());
  input.addEventListener("change", lock(async () => {
    const file = input.files[0]; input.value = ""; if (file) await renderResult(file);
  }));
  local.addEventListener("click", lock(() => {
    ide().save(); const editor = code(), cursor = editor.selectionStart;
    const word = editor.value.slice(cursor,editor.selectionEnd) || (editor.value.slice(0,cursor).match(/[\p{L}\p{N}_]+$/u)?.[0] || "") +
      (editor.value.slice(cursor).match(/^[\p{L}\p{N}_]+/u)?.[0] || "");
    if (!word || word.length > 200) throw Error("Umísti kurzor na název nebo vyber krátký text.");
    list.replaceChildren(); links.replaceChildren();
    let count = 0;
    for (const [name, source] of Object.entries(ide().getProject().files)) {
      if (!name.endsWith(".swift")) continue;
      let at = source.indexOf(word);
      while (at !== -1 && count < 50) {
        const pos = cursorPosition(source, at);
        entry(name + ":" + (pos.line + 1) + ":" + (pos.character + 1), () => go(name, pos.line, pos.character));
        count++; at = source.indexOf(word, at + word.length);
      }
      if (count === 50) break;
    }
    status.textContent = "Textové výskyty v lokálním projektu · " + (count === 50 ? "prvních 50" : count) + ".";
  }));
  controls.append(element("p", "Umísti kurzor na název ve Swift souboru a vyhledej jeho výskyty v projektu na zařízení. Vzdálený SourceKit zatím nepodporuje soukromé sestavování."), actions, input, status, links, list);
  group.append(summary, controls); container.append(group); controlsState();
}
if (typeof document !== "undefined") {
  const container = document.getElementById("language-tools");
  if (container) mountLanguageTools(container);
}
