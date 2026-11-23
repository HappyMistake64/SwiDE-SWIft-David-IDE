import {
  STORAGE_KEY, REPOSITORY, GithubAPI, newProject, makeRequest, validateProject,
  validateSettings, restoreState, reconcileArtifacts, validPath
} from "./core.mjs";

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
function renderBuilds() {
  const wrapper=byId("builds");
  wrapper.replaceChildren();
  const previews=byId("preview-results");
  previews.replaceChildren();
  if (!state.builds.length) {
    wrapper.append(htmlEl("p","muted","Zatím žádná kompilace. První build spustíš tlačítkem Sestavit."));
    return;
  }
  for (const item of state.builds) {
    const box=htmlEl("article","build-card");
    const title=htmlEl("div","build-title");
    title.append(htmlEl("strong","",item.appName+" · "+item.stage));
    title.append(htmlEl("span","muted",new Date(item.created_at).toLocaleString("cs-CZ")));
    box.append(title,htmlEl("div","mono",item.request_id));
    if (item.source_sha) box.append(htmlEl("div","small mono","Commit "+item.source_sha.slice(0,12)));
    if (item.message) box.append(htmlEl("p","small",item.message));
    if (item.run_id) box.append(htmlEl("div","small","Workflow run #"+item.run_id));
    if (Array.isArray(item.artifacts)&&item.artifacts.length) {
      const list=htmlEl("div","chips");
      for (const a of item.artifacts) list.append(htmlEl("span","chip",a.name));
      box.append(list);
    }
    const actions=htmlEl("div","action-row");
    const refresh=htmlEl("button","secondary","↻ Ověřit");
    refresh.type="button";
    refresh.addEventListener("click",()=>void refreshBuild(item));
    actions.append(refresh);
    if (item.stage==="success" && Number.isSafeInteger(item.previewArtifact) && Number.isSafeInteger(item.run_id)) {
      const link=htmlEl("a","external",item.appName+" · Stáhnout snímek běhu #"+item.run_id);
      link.href="https://github.com/"+encodeURI(item.repo)+"/actions/runs/"+item.run_id+"/artifacts/"+item.previewArtifact;
      previews.append(link);
      actions.append(link.cloneNode(true));
    }
    const archive = item.artifacts?.find?.(artifact =>
      artifact.name === "pocket-ios-app-" + item.request_id && !artifact.expired &&
      Number.isSafeInteger(artifact.id) && artifact.id > 0
    );
    if (item.stage === "success" && archive && /^\d+$/.test(item.run_id)) {
      const download = htmlEl("a", "secondary", "Stáhnout ZIP s IPA");
      download.href = "https://github.com/" + encodeURI(item.repo) +
        "/actions/runs/" + item.run_id + "/artifacts/" + archive.id;
      actions.append(download);
    }
    if (item.stage==="ambiguous" || item.stage==="mismatch") {
      const choose=htmlEl("button","secondary","Zadat Run ID");
      choose.type="button";
      choose.addEventListener("click",()=>{
        const answer=prompt("Zadej přesné GitHub Actions Run ID ze stránky Actions.");
        if (!answer) return;
        if (!/^[1-9][0-9]*$/.test(answer) || !Number.isSafeInteger(Number(answer))) return note("Neplatné Run ID.","error");
        item.run_id=Number(answer);item.stage="dispatched";item.message="";
        persist();renderBuilds();void refreshBuild(item);
      });
      actions.append(choose);
    }
    if (Number.isSafeInteger(item.run_id) && item.run_id>0) {
      const link=htmlEl("a","small external","📦 Otevřít běh a stáhnout artefakty");
      link.href="https://github.com/"+encodeURI(item.repo)+"/actions/runs/"+item.run_id;
      link.target="_blank";link.rel="noopener noreferrer";
      actions.append(link);
    }
    box.append(actions);
    wrapper.append(box);
  }
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
  try {
    syncSettings();
    const token=byId("connect-token").value.trim();
    if (!token) throw Error("Vlož GitHub token do pole nad tímto tlačítkem.");
    const candidate=new GithubAPI(token,state.settings.repo);
    const repo=await candidate.verifyAccess();
    api=candidate;
    byId("connect-token").value="";
    byId("connect-token").type="password";
    byId("toggle-token").textContent="Zobrazit token";
    byId("toggle-token").setAttribute("aria-pressed","false");
    byId("connection").textContent="● Připojeno: "+repo.full_name;
    byId("connection").dataset.connected="true";
    connectionNote("✅ GitHub připojen. Přístup k repozitáři potvrzen, token zůstává jen v paměti stránky.","success");
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
  if (busy) return;
  busy=true;
  byId("btn-build").disabled=true;
  try {
    if (!api) {
      document.querySelector('[data-view="project"]').click();
      const settings = byId("connect-token").closest("details");
      if (settings) settings.open = true;
      byId("connect-token").focus();
      throw Error("Pro vzdálené sestavení nejdřív připoj GitHub.");
    }
    saveEditing();syncSettings();validateProject(state.project);
    if (state.settings.repo!==api.repo) throw Error("Repozitář se změnil, znovu se připoj.");
    if (!confirm((capturePreview ? "Spustit projekt v simulátoru a uložit snímek obrazovky? " : "") + "Odeslat zdrojové soubory do " + api.repo + " a spustit sestavení na GitHubu? U veřejného repozitáře budou soubory veřejné.")) return;
    const req=makeRequest(state.settings,state.project);
    if (capturePreview) req.capturePreview=true;
    document.querySelector('[data-view="console"]').click();
    state.builds.unshift(req);state.builds=state.builds.slice(0,30);persist();renderBuilds();
    note("Ukládám neměnný snímek projektu do GitHubu...");
    try {
      req.source_sha=await api.snapshot(req,state.project);
      req.stage="committed";persist();renderBuilds();
      // Persist the source SHA BEFORE dispatch: a network failure must not auto-repeat the build.
      await api.dispatch(req);
      req.stage="dispatched";req.message="Požadavek odeslán. Hledám správný běh podle UUID.";
      persist();renderBuilds();
      note("Kompilace odeslána. Průběh bude dostupný i po obnovení stránky.","success");
      await refreshBuild(req);
    } catch(err) {
      req.stage=req.source_sha?"submission_uncertain":"snapshot_failed";
      req.message=errorMessage(err)+(req.source_sha?" — znovu nespouštěj naslepo, nejprve zkontroluj Actions.":"");
      persist();renderBuilds();throw err;
    }
  } catch(err){note(errorMessage(err),"error");}
  finally {busy=false;byId("btn-build").disabled=false;}
}
async function refreshBuild(item) {
  if (!api) return note("Znovu připoj GitHub token po obnovení stránky.","error");
  if (!item.source_sha) return;
  try {
    const located=await api.findRun(item);
    if (located.state!=="found") {
      item.stage=located.state;item.message=located.state==="awaiting"?
        "GitHub zatím nezaindexoval odpovídající běh. Nezakládej nový.":
        "Identita běhu není jednoznačná. Žádný cizí artefakt se nezobrazí.";
      persist();renderBuilds();return;
    }
    const run=located.run;
    item.run_id=run.id;
    if (run.status!=="completed") {
      item.stage=run.status||"running";
      item.message="Čeká se na dokončení GitHub Actions.";
      persist();renderBuilds();return;
    }
    const artifacts=await api.artifacts(run.id);
    const result=reconcileArtifacts(artifacts,item,run);
    const previewName="pocket-ios-preview-"+item.request_id+"-"+item.source_sha;
    const previews=artifacts.filter(a=>a.name===previewName && !a.expired && Number.isSafeInteger(a.id) && (!a.workflow_run || a.workflow_run.id===run.id));
    item.previewArtifact=result.state==="success" && previews.length===1 ? previews[0].id : null;
    item.stage=result.state;item.artifacts=result.artifacts;
    item.message=result.state==="success"?
      "Ověřeny metadata běhu, UUID, SHA a názvy artefaktů. Výstup je NEPODEPSANÝ; instalace vyžaduje podpis.":
      result.state==="failed"?"Build skončil chybou. Otevři GitHub Actions a projdi logy.":
      "Nesoulad či chybějící artefakty. Výsledek nelze bezpečně přiřadit.";
    persist();renderBuilds();
  } catch(err){item.message=errorMessage(err);persist();renderBuilds();}
}
async function refreshAll() {
  if (polling||!api) return;
  polling=true;
  try {
    for (const item of state.builds.slice(0,8)) {
      if (item.source_sha && !["success","failed","missing","mismatch","ambiguous"].includes(item.stage))
        await refreshBuild(item);
    }
  } finally {polling=false;}
}
function exportProject() {
  try{
    saveEditing();validateProject(state.project);
    if (window.webkit?.messageHandlers?.exportProject) {
      window.webkit.messageHandlers.exportProject.postMessage(JSON.stringify(state.project));
      return;
    }
    const url=URL.createObjectURL(new Blob([JSON.stringify(state.project)],{type:"application/json"}));
    const a=htmlEl("a");a.href=url;a.download="xcode-pocket-project.json";a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);note("Projekt exportován.","success");
  }catch(err){note(errorMessage(err),"error");}
}
async function importProject(file) {
  try {
    if (!file || file.size>4_000_000) throw Error("Import podporuje JSON do 4 MB.");
    const result=JSON.parse(await file.text());
    validateProject(result);
    // Only replace after full validation.
    state.project=result;state.active=Object.keys(result.files)[0];
    persist();renderFiles();note("Projekt importován bez ztráty historie buildů.","success");
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
    try{syncSettings();}catch(err){note(errorMessage(err),"error");}
  });
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)void refreshAll();});
  setInterval(()=>{if (!document.hidden)void refreshAll();},12000);
  if(location.protocol !== "file:" && "serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(()=>{});
  note("Lokální editor připraven. GitHub token není uložený na zařízení.");
}
window.pocketIDE = {
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
      note("Struktura projektu je platná. Souborů: " + paths.length + ". Testovacích zdrojů: " + tests.length + ". Kompilace a XCTest proběhnou až při sestavení.", "success");
    } catch (error) { note(errorMessage(error), "error"); }
  }
};
init();
