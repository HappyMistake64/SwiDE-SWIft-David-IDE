import {
  STORAGE_KEY, GithubAPI, makeRequest, validateProject,
  validateSettings, restoreState, validPath, sameRepository
} from "./core.mjs";

import {selectBuildArtifact, verifyBuildResult} from "./build-result.mjs";
import {uploadDrafts, sendPreparedBuild} from "./build-session.mjs";
import {trustedGitHubURL} from "./github-link.mjs";

const byId = id => document.getElementById(id);
const local = restoreState(localStorage.getItem(STORAGE_KEY));
const state = {project:local.project,settings:local.settings,builds:local.builds,active:local.active};
let api = null, polling = false, busy = false;

function persist() {
  localStorage.setItem(STORAGE_KEY,JSON.stringify(state));
}
function note(message, type="info") {
  const area = byId("status");
  area.textContent = message;
  area.dataset.type = type;
}
function errorMessage(err) {return err instanceof Error ? err.message : String(err);}
function htmlEl(tag,className,text) {
  const el=document.createElement(tag);
  if (className) el.className=className;
  if (text !== undefined) el.textContent=text;
  return el;
}
function syncSettings() {
  state.settings=validateSettings({repo:byId("repo").value,appName:byId("app-name").value,bundleId:byId("bundle-id").value});
  byId("ide-title").textContent=state.settings.appName;
  persist();
}
function saveEditing() {
  if (window.pocketProjectSession?.isClosed()) return;
  if (!state.active || !(state.active in state.project.files)) return;
  state.project.files[state.active]=byId("code").value;
  persist();
}
function renderFiles() {
  const names=Object.keys(state.project.files).sort();
  if (!names.includes(state.active)) state.active=names[0];
  byId("files").replaceChildren(...names.map(name=>{
    const option=htmlEl("option","",name);
    option.value=name;option.selected=name===state.active;return option;
  }));
  byId("code").value=state.project.files[state.active]||"";
  byId("filename").textContent=state.active;
  byId("file-tab").textContent=state.active;
  byId("ide-title").textContent=state.settings.appName;
  document.dispatchEvent(new Event("pocket:fileloaded"));
  window.dispatchEvent(new Event("pocket-render"));
}
const buildStatus = {
  prepared:"Připraveno v telefonu", committed:"Snímek uložen", dispatching:"Odesílání požadavku",
  dispatched:"Odesláno", queued:"Ve frontě", in_progress:"Probíhá", running:"Probíhá",
  awaiting:"Čeká na GitHub", ready:"Ke stažení a ověření", failed:"Selhalo",
  mismatch:"Výsledek nesouhlasí", ambiguous:"Více odpovídajících běhů", attempt_changed:"Nový pokus",
  submission_uncertain:"Odeslání je třeba ověřit", snapshot_failed:"Přerušený přenos snímku",
  historical:"Historický záznam před verzí 0.6"
};
const bindingKey = repo => "swide-private-target-v2:" + repo.toLowerCase();
const receipts = new Map();
const working = new Set();
let verifiedIPA = null;
function isCurrent(item) {
  return item.schema === "swide-build-request/v2" && item.mode === "generated" &&
    api && sameRepository(item.repo, api.repo) && api.binding?.repository_id === item.repository_id;
}
function button(label, run) {
  const el = htmlEl("button", "secondary", label);
  el.type = "button";
  el.addEventListener("click", run);
  return el;
}
function external(label, url) {
  const link = htmlEl("a", "small external", label);
  link.href = trustedGitHubURL(url);
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}
function exportVerified(result) {
  const bridge = window.webkit?.messageHandlers?.exportVerifiedIPA;
  if (bridge) {
    const chunks = [];
    for (let i = 0; i < result.ipaBytes.length; i += 8192) {
      chunks.push(String.fromCharCode(...result.ipaBytes.subarray(i, i + 8192)));
    }
    bridge.postMessage({name:result.filename, base64:btoa(chunks.join(""))});
    return;
  }
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([result.ipaBytes], {type:"application/octet-stream"}));
  link.download = result.filename;
  document.body.append(link);
  link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60000);
}
function updateBuilds() { persist(); renderBuilds(); }
function renderBuilds() {
  window.dispatchEvent(new Event("pocket-builds"));
  const wrapper = byId("builds");
  wrapper.replaceChildren();
  if (!state.builds.length) {
    wrapper.append(htmlEl("p","muted","Zatím žádná kompilace. První build spustíš tlačítkem Sestavit."));
  }
  for (const item of state.builds) {
    const box = htmlEl("article","build-card");
    const details = htmlEl("details","build-metadata");
    const status = verifiedIPA?.item === item ? "Ověřená nepodepsaná IPA" : buildStatus[item.stage] || item.stage;
    box.append(htmlEl("strong","",item.appName + " · " + status));
    details.append(htmlEl("summary","","Podrobnosti"), htmlEl("div","mono","Požadavek " + item.request_id));
    for (const [label,value] of [["Repozitář",item.repo],["Zdrojové SHA",item.source_sha],
      ["SHA spouštěče",item.caller_sha],["GitHub Actions",item.run_id],["Pokus",item.run_attempt]]) {
      if (value) details.append(htmlEl("div","mono", label + " · " + value));
    }
    if (item.stage === "historical") box.append(htmlEl("p","small","Starší protokol. Tento záznam se automaticky neobnoví."));
    if (item.message) box.append(htmlEl("p","small",item.message));
    const actions = htmlEl("div","action-row");
    if (isCurrent(item) && !working.has(item.request_id)) {
      const resume = ["prepared","snapshot_failed","committed"].includes(item.stage);
      if (resume) actions.append(button("Pokračovat s původním snímkem", () => void resumeBuild(item)));
      else actions.append(button("Obnovit stav", () => void refreshBuild(item)));
      if (item.stage === "attempt_changed" && item.nextAttempt > item.run_attempt) {
        actions.append(button("Vybrat pokus " + item.nextAttempt, () => {
          item.run_attempt = item.nextAttempt;
          delete item.nextAttempt;
          delete item.artifact_id;
          delete item.artifact_digest;
          item.stage = "dispatched";
          updateBuilds(); void refreshBuild(item);
        }));
      }
      if (Number.isSafeInteger(item.run_id) && item.run_id > 0) {
        const runURL = "https://github.com/" + api.repo + "/actions/runs/" + item.run_id;
        actions.append(external("Otevřít běh na GitHubu", runURL));
        const archive = receipts.get(item.request_id);
        if (archive && item.stage === "ready") {
          actions.append(button("Ověřit stažení IPA", () => void checkArchive(item)));
          actions.append(external("Stáhnout ZIP na GitHubu", runURL + "/artifacts/" + archive.id));
          const picker = htmlEl("input");
          picker.type = "file"; picker.accept = ".zip,application/zip"; picker.hidden = true;
          picker.addEventListener("change", () => { if (picker.files[0]) void checkArchive(item, picker.files[0]); });
          actions.append(button("Ověřit ZIP ze Souborů", () => { picker.value = ""; picker.click(); }), picker);
        }
      }
      if (verifiedIPA?.item === item) actions.append(button("Uložit ověřenou IPA", () => {
        if (isCurrent(item) && verifiedIPA?.item === item) exportVerified(verifiedIPA.result);
      }));
    }
    box.append(actions,details);
    wrapper.append(box);
  }
}
function disconnect() {
  api = null; verifiedIPA = null; receipts.clear();
  byId("connection").textContent = "● Nepřipojeno";
  byId("connection").dataset.connected = "false";
  renderBuilds();
}
function connectionNote(message, type="info") {
  const area=byId("connection-status");
  area.textContent=message;
  area.dataset.type=type;
}
function connectionError(err) {
  const message=errorMessage(err);
  if (/GitHub HTTP 401|Bad credentials/i.test(message)) return "Token GitHub odmítl (401). Zkontroluj, zda je kompletní a nebyl zneplatněn. Token sem do chatu neposílej.";
  if (/GitHub HTTP 403/i.test(message)) return "GitHub odmítl přístup (403). Zkontroluj oprávnění tokenu k repozitáři: Contents Read/Write a Actions Read/Write.";
  if (/GitHub HTTP 404/i.test(message)) return "Repozitář není dostupný pro tento token (404). Zkontroluj výběr repozitáře a jeho oprávnění.";
  if (/Failed to fetch|Load failed|NetworkError|network request failed/i.test(message)) return "Safari se nepřipojilo k GitHub API. Zkontroluj připojení a případně blokování obsahu; pak to zkus znovu.";
  return message;
}
async function connect() {
  const button=byId("check-access");
  if (button.disabled) return;
  button.disabled=true;
  button.textContent="Ověřuji token…";
  connectionNote("Ověřuji přístup k repozitáři na GitHubu…");
  disconnect();
  try {
    syncSettings();
    const token=byId("connect-token").value.trim();
    if (!token) throw Error("Vlož GitHub token do pole nad tímto tlačítkem.");
    const candidate=new GithubAPI(token,state.settings.repo);
    byId("repo").value=candidate.repo;
    const key = bindingKey(candidate.repo);
    const previous = localStorage.getItem(key);
    const repo=await candidate.verifyAccess(previous ? JSON.parse(previous) : null);
    if (!sameRepository(byId("repo").value.trim(), candidate.repo)) throw Error("Vybraný cíl se mezitím změnil.");
    localStorage.setItem(key, JSON.stringify(candidate.binding));
    api=candidate;
    byId("connect-token").value="";
    byId("connect-token").type="password";
    byId("toggle-token").textContent="Zobrazit token";
    byId("toggle-token").setAttribute("aria-pressed","false");
    byId("connection").textContent="● Připojeno: "+repo.full_name;
    byId("connection").dataset.connected="true";
    connectionNote("Soukromý cíl " + repo.full_name + " · Kvóta vlastníka " + repo.owner.login + ". Token je pouze v paměti této relace.","success");
    renderBuilds();
    note("GitHub připojen; můžeš sestavit aplikaci.","success");
    await refreshAll();
  } catch(err) {
    connectionNote("❌ "+connectionError(err),"error");
    // Preserve the typed token so the user can correct it without generating another token.
    byId("connection").textContent="● Nepřipojeno";
    byId("connection").dataset.connected="false";
    api=null;
  } finally {
    button.disabled=false;
    button.textContent="Ověřit a připojit";
  }
}
async function submit(capturePreview = false) {
  if (window.pocketProjectSession?.isClosed() || busy) return;
  if (capturePreview) return note("Vzdálený simulátor není ve verzi 0.6 k dispozici.");
  if (document.body.dataset.projectMode === "archive") {
    document.dispatchEvent(new Event("pocket:show-build"));
    return;
  }
  if (!api) {
    document.dispatchEvent(new Event("pocket:github-required"));
    return note("Pro soukromé sestavení připoj svůj projektový repozitář.");
  }
  busy = true;
  byId("btn-build").disabled = true;
  try {
    saveEditing(); syncSettings();
    const client = api;
    if (!sameRepository(state.settings.repo, client.repo)) throw Error("Znovu připoj vybraný repozitář.");
    const frozen = structuredClone(validateProject(state.project));
    if (!confirm("Sestavit " + state.settings.appName + " v soukromém repozitáři " + client.repo +
      "? Snímek tam mohou číst jeho členové. Sestavení čerpá kredit vlastníka " + client.binding.owner_id + ".")) return;
    const req = makeRequest(state.settings, frozen);
    await client.prepare(req, frozen);
    await uploadDrafts.put(req.request_id, frozen);
    state.builds.unshift(req);
    updateBuilds();
    document.querySelector('[data-view="console"]').click();
    await transmit(req, client);
  } catch (err) { note(errorMessage(err), "error"); }
  finally { busy = false; byId("btn-build").disabled = false; }
}
async function resumeBuild(item) {
  if (!isCurrent(item) || !confirm("Pokračovat s původním snímkem v " + item.repo + "?")) return;
  await transmit(item, api);
}
async function transmit(item, client) {
  if (working.has(item.request_id)) return;
  working.add(item.request_id);
  renderBuilds();
  try {
    await sendPreparedBuild({req:item, client, drafts:uploadDrafts, save:updateBuilds,
      onCommitted(project, sha) {
        window.dispatchEvent(new CustomEvent("pocket-committed", {detail:{project,sha}}));
      }
    });
    item.message = "Požadavek má vlastní ID běhu na GitHubu.";
    note("Sestavení odesláno.", "success");
  } catch (err) {
    item.message = errorMessage(err);
    note(item.message, "error");
  } finally {
    working.delete(item.request_id); updateBuilds();
  }
  if (item.stage === "dispatched") await refreshBuild(item);
}
async function inspectRun(item, client) {
  const located = await client.findRun(item);
  if (located.state !== "found") {
    item.stage = located.state;
    item.message = located.state === "awaiting" ? "Přesný běh zatím není vidět. Odeslání se automaticky neopakuje." :
      "GitHub nevrátil právě jeden odpovídající běh.";
    return;
  }
  const run = located.run;
  item.run_id = run.id;
  if (run.run_attempt > item.run_attempt) {
    item.stage = "attempt_changed";
    item.nextAttempt = run.run_attempt;
    item.message = "GitHub eviduje nový pokus. Pro ověření jej výslovně vyber.";
    return;
  }
  if (run.run_attempt !== item.run_attempt) throw Error("Nesouhlasí pokus sestavení.");
  if (run.status !== "completed") {
    item.stage = run.status || "running"; item.message = "Čeká se na GitHub Actions.";
    return;
  }
  if (run.conclusion !== "success") {
    item.stage = "failed"; item.message = "GitHub ukončil sestavení se stavem " + run.conclusion + ".";
    return;
  }
  const artifact = selectBuildArtifact(item, run, await client.artifacts(run.id));
  item.artifact_id = artifact.id;
  item.artifact_digest = artifact.digest;
  item.stage = "ready"; item.message = "GitHub má výsledek. Pro export ověř archiv a bajty IPA.";
  return {run,artifact};
}
async function refreshBuild(item) {
  if (!isCurrent(item) || !item.source_sha || working.has(item.request_id)) return;
  const client = api;
  working.add(item.request_id);
  receipts.delete(item.request_id);
  if (verifiedIPA?.item === item) verifiedIPA = null;
  try {
    const result = await inspectRun(item, client);
    if (result && api === client) receipts.set(item.request_id, result.artifact);
  } catch (err) { item.stage = "mismatch"; item.message = errorMessage(err); }
  finally { working.delete(item.request_id); updateBuilds(); }
}
async function checkArchive(item, file = null) {
  if (!isCurrent(item) || working.has(item.request_id)) return;
  const client = api;
  working.add(item.request_id);
  verifiedIPA = null;
  renderBuilds();
  try {
    const current = await inspectRun(item, client);
    if (!current || api !== client) throw Error("Nepodařilo se potvrdit identitu běhu.");
    const {run,artifact} = current;
    receipts.set(item.request_id, artifact);
    const bytes = file || await client.downloadArtifact(artifact);
    const result = await verifyBuildResult({expected:item, run, artifact, zipBytes:bytes});
    if (api !== client) throw Error("Připojení se mezitím změnilo.");
    verifiedIPA = {item, result};
    item.message = "ZIP, identita sestavení a SHA-256 IPA souhlasí. Soubor můžeš uložit.";
    note("Výsledek ověřen.", "success");
  } catch (err) {
    item.message = errorMessage(err) + (file ? "" : " ZIP lze stáhnout na GitHubu a ověřit ze Souborů.");
    note(item.message, "error");
  } finally { working.delete(item.request_id); updateBuilds(); }
}
async function refreshAll() {
  if (polling || !api) return;
  polling = true;
  try {
    for (const item of state.builds) {
      if (isCurrent(item) && item.source_sha && ["dispatching","dispatched","awaiting","submission_uncertain",
        "queued","running","in_progress","waiting","requested","pending"].includes(item.stage)) {
        await refreshBuild(item);
      } else if (isCurrent(item) && item.stage === "ready" && !receipts.has(item.request_id)) {
        await refreshBuild(item);
      }
    }
  } finally { polling = false; }
}
function exportProject() {
  try{
    saveEditing();validateProject(state.project);
    if (window.webkit?.messageHandlers?.exportProject) {
      window.webkit.messageHandlers.exportProject.postMessage(JSON.stringify(state.project));
      return;
    }
    const url=URL.createObjectURL(new Blob([JSON.stringify(state.project)],{type:"application/json"}));
    const a=htmlEl("a");a.href=url;a.download="swide-project.json";a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);note("Projekt exportován.","success");
  }catch(err){note(errorMessage(err),"error");}
}
async function importProject(file) {
  try {
    if (!file || file.size>4_000_000) throw Error("Import podporuje JSON do 4 MB.");
    const result=JSON.parse(await file.text());
    validateProject(result);
    window.pocketIDE.commitProject(result,Object.keys(result.files)[0],{repo:""});
    note("Projekt importován bez ztráty historie buildů.","success");
  }catch(err){note(errorMessage(err),"error");}
}
function addFile() {
  const name=prompt("Nový soubor, např. Sources/Model.swift");
  if (!name) return;
  if (!validPath(name)||Object.keys(state.project.files).some(x=>x.toLowerCase()===name.toLowerCase())) return note("Neplatný nebo duplicitní soubor.","error");
  const old=state.active;saveEditing();state.project.files[name]="";
  try{validateProject(state.project);}catch(err){delete state.project.files[name];state.active=old;return note(errorMessage(err),"error");}
  state.active=name;persist();renderFiles();
}
function deleteFile() {
  const name=state.active;if(!name||!confirm("Odstranit "+name+" z lokálního projektu?")) return;
  const old=state.project.files[name];delete state.project.files[name];
  try{validateProject(state.project);}catch(err){state.project.files[name]=old;return note(errorMessage(err),"error");}
  state.active=Object.keys(state.project.files)[0];persist();renderFiles();
}
function init() {
  byId("repo").value=state.settings.repo;
  byId("app-name").value=state.settings.appName;
  byId("bundle-id").value=state.settings.bundleId;
  renderFiles();renderBuilds();
  byId("files").addEventListener("change",e=>{
    saveEditing();state.active=e.target.value;persist();renderFiles();
  });
  byId("code").addEventListener("input",saveEditing);
  byId("forget-target").addEventListener("click", () => {
    const repo = byId("repo").value.trim();
    if (!repo || !confirm("Odpojit " + repo + " a zapomenout jeho ověřenou identitu v tomto zařízení?")) return;
    localStorage.removeItem(bindingKey(repo));
    disconnect();
    byId("connect-token").value = "";
    connectionNote("Cíl odpojen. Při příštím připojení se jeho identita ověří znovu.");
  });
  byId("check-access").addEventListener("click",()=>void connect());
  byId("connect-token").addEventListener("keydown",event=>{
    if (event.key==="Enter") {event.preventDefault();void connect();}
  });
  byId("toggle-token").addEventListener("click",()=>{
    const field=byId("connect-token");
    const visible=field.type==="password";
    field.type=visible?"text":"password";
    byId("toggle-token").textContent=visible?"Skrýt token":"Zobrazit token";
    byId("toggle-token").setAttribute("aria-pressed",String(visible));
    field.focus();
  });
  byId("simulate").addEventListener("click",()=>void submit(true));
  let previewURL;
  byId("preview-file").addEventListener("change",async event=>{
    const file=event.target.files[0];
    if (!file) return;
    const sig=new Uint8Array(await file.slice(0,8).arrayBuffer());
    if (file.size > 20*1024*1024 || sig.join()!=="137,80,78,71,13,10,26,10") {
      alert("Vyber PNG do 20 MiB.");
      return;
    }
    if (previewURL) URL.revokeObjectURL(previewURL);
    previewURL=URL.createObjectURL(file);
    byId("preview-image").src=previewURL;
    byId("preview-caption").textContent="Snímek ze Souborů · "+file.name;
    byId("preview-figure").hidden=false;
  });
  byId("btn-build").addEventListener("click",()=>void submit());
  byId("btn-refresh").addEventListener("click",()=>void refreshAll());
  byId("btn-add").addEventListener("click",addFile);
  byId("btn-remove").addEventListener("click",deleteFile);
  byId("btn-export").addEventListener("click",exportProject);
  byId("btn-import").addEventListener("click",()=>byId("input-import").click());
  byId("input-import").addEventListener("change",e=>{
    void importProject(e.target.files[0]);e.target.value="";
  });
  for (const id of ["repo","app-name","bundle-id"]) byId(id).addEventListener("change",()=>{
    try{if (id === "repo") disconnect(); syncSettings();}catch(err){note(errorMessage(err),"error");}
  });
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)void refreshAll();});
  setInterval(()=>{if (!document.hidden)void refreshAll();},12000);
  if(location.protocol !== "file:" && "serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(()=>{});
  note("Lokální editor připraven. GitHub token není uložený na zařízení.");
}
window.pocketIDE = {
  getAPI() {
    syncSettings();
    if (!api || api.repo !== state.settings.repo) throw Error("Připoj GitHub pro tento repozitář v nastavení projektu.");
    return api;
  },
  getBuilds: () => state.builds,
  commitProject(project,active,settingsPatch) {
    validateProject(project);
    if (!Object.hasOwn(project.files,active)) throw Error("Soubor není v projektu.");
    const settings = settingsPatch ? validateSettings({...state.settings,...settingsPatch}) : state.settings;
    localStorage.setItem(STORAGE_KEY,JSON.stringify({...state,project,active,settings}));
    state.settings=settings;
    byId("app-name").value=settings.appName;
    byId("repo").value=settings.repo;
    if (api && !sameRepository(settings.repo, api.repo)) disconnect();
    state.project=project;
    state.active=active;
    renderFiles();
  },
  getProject: () => state.project,
  getActive: () => state.active,
  save: saveEditing,
  openFile(path) {
    if (!Object.hasOwn(state.project.files, path)) return;
    saveEditing();
    state.active=path;
    persist();
    renderFiles();
  },
  setProject(project) {
    validateProject(project);
    state.project=project;
    persist();
    renderFiles();
  },
  review() {
    try {
      saveEditing();
      validateProject(state.project);
      const paths=Object.keys(state.project.files);
      const tests=paths.filter(path => path.startsWith("Tests/") && path.endsWith(".swift"));
      note("Struktura projektu je platná. Souborů: " + paths.length + ". Testovacích zdrojů: " + tests.length + ". Soukromé sestavení vytvoří nepodepsanou IPA.", "success");
    } catch (error) { note(errorMessage(error), "error"); }
  }
};
init();
