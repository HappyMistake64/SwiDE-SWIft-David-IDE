// Submit a user-approved snapshot to the existing original Xcode project workflows.
const BUILD_LIMIT = 20 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const MODES = {
  device: {file:"pocket-original-xcode.yml", title:"Original Xcode", artifact:"original-xcode"},
  simulator: {file:"pocket-original-simulator.yml", title:"Original Simulator", artifact:"original-simulator"}
};
const STATE_KEY = "pocket-original-last-v1";
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;
function requireValue(value,message) { if (!value) throw new Error(message); }
function sha(value) { requireValue(SHA.test(value || ""),"GitHub nevrátil platný SHA."); return value; }

export function originalSchemes(entries) {
  const paths = new Set(entries.filter(e=>!e.dir).map(e=>e.path));
  const result = [];
  for (const path of paths) {
    const match = /^(.+\.xcodeproj)\/xcshareddata\/xcschemes\/([\p{L}\p{N}_ .-]{1,100})\.xcscheme$/u.exec(path);
    if (match && !match[2].startsWith("-") && paths.has(match[1]+"/project.pbxproj")) {
      result.push({project_path:match[1],scheme_path:path,scheme:match[2]});
    }
  }
  return result;
}
export function checkOriginalBuild(entries,choice) {
  requireValue(choice && originalSchemes(entries).some(s=>s.scheme_path===choice.scheme_path &&
    s.scheme===choice.scheme && s.project_path===choice.project_path),"Vyber sdílené schéma projektu .xcodeproj.");
  const prefixes = new Map();
  for (const entry of entries) {
    const parts = entry.path.replace(/\/$/,"").split("/");
    requireValue(entry.path === entry.path.normalize("NFC") && parts.every(p=>p && p.trim()===p),
      "Pro sestavení musí cesty používat NFC a nesmí začínat ani končit mezerou.");
    let prefix = "";
    for (const part of parts) {
      prefix += (prefix ? "/" : "") + part;
      const folded = prefix.toUpperCase().toLowerCase();
      requireValue(!prefixes.has(folded) || prefixes.get(folded)===prefix,"Projekt obsahuje konflikt velikosti písmen v cestě.");
      prefixes.set(folded,prefix);
    }
    if (entry.edit === undefined || entry.edit === entry.text)
      requireValue(entry.size <= 1000 * Math.max(1,entry.packed.length), "Položka ZIP má pro vzdálený build příliš vysoký kompresní poměr.");
  }
  const entry = entries.find(e=>e.path===choice.scheme_path);
  const scheme = entry.edit ?? entry.text;
  requireValue(typeof scheme === "string" && !/<!DOCTYPE|<!ENTITY/i.test(scheme),"Schéma musí být malé čitelné UTF-8 XML bez DTD a entit.");
  const xml = new DOMParser().parseFromString(scheme,"application/xml");
  requireValue(xml.documentElement.nodeName === "Scheme" && !xml.querySelector("parsererror"),"Vybrané schéma nemá platný kořen Scheme.");
}
function toBase64(bytes) {
  const chunks = [];
  for (let i=0; i<bytes.length; i+=24576)
    chunks.push(btoa(String.fromCharCode(...bytes.subarray(i,i+24576))));
  return chunks.join("");
}
export async function submitOriginal({api,archive,choice,mode,approved,onRecord = ()=>{}}) {
  requireValue(approved === true,"Je třeba výslovný souhlas s odesláním a spuštěním kódu.");
  requireValue(Object.hasOwn(MODES,mode),"Neznámý způsob sestavení.");
  requireValue(api && /^[\w.-]+\/[\w.-]+$/.test(api.repo),"Nejdřív připoj GitHub v nastavení.");
  requireValue(archive.size > 0 && archive.size <= BUILD_LIMIT,"ZIP pro vzdálený build musí mít nejvýše 20 MiB.");
  const bytes = new Uint8Array(await archive.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256",bytes));
  const id = crypto.randomUUID(), zipPath = "original-xcode/sources/"+id+".zip";
  const manifest = {version:1,request_id:id,zip_path:zipPath,
    sha256:Array.from(digest,b=>b.toString(16).padStart(2,"0")).join(""),
    project_path:choice.project_path,scheme_path:choice.scheme_path,scheme:choice.scheme};
  const req = (method,path,body)=>api.request(method,path,body);
  await req("GET","/actions/workflows/"+MODES[mode].file);
  const head = sha((await req("GET","/git/ref/heads/main")).object?.sha);
  const baseTree = sha((await req("GET","/git/commits/"+head)).tree?.sha);
  const blobSha = sha((await req("POST","/git/blobs",{content:toBase64(bytes),encoding:"base64"})).sha);
  const tree = sha((await req("POST","/git/trees",{base_tree:baseTree,tree:[
    {path:zipPath,mode:"100644",type:"blob",sha:blobSha},
    {path:"original-xcode/requests/"+id+".json",mode:"100644",type:"blob",content:JSON.stringify(manifest)}
  ]})).sha);
  const commit = sha((await req("POST","/git/commits",{message:"SwiDe original "+id,tree,parents:[head]})).sha);
  // A concurrent update causes a conflict; never force-push or dispatch an unpublished snapshot.
  const ref = await req("PATCH","/git/refs/heads/main",{sha:commit,force:false});
  requireValue(ref?.object?.sha === commit,"GitHub nepotvrdil uložení snapshotu do main.");
  const record = {repo:api.repo,id,commit,mode};
  onRecord(record);
  await req("POST","/actions/workflows/"+MODES[mode].file+"/dispatches",{
    ref:"main",inputs:{request_id:id,source_sha:commit,allow_project_code:"true"}
  });
  return record;
}

export async function findOriginalResult(api,record) {
  requireValue(api && api.repo===record.repo && Object.hasOwn(MODES,record.mode) && SHA.test(record.commit) && UUID.test(record.id),
    "Připoj stejný repozitář jako při sestavení.");
  const mode = MODES[record.mode];
  const matches = [];
  const legacyTitle = mode.title+" "+record.id;
  const snapshotTitle = legacyTitle+" @ "+record.commit;
  for (let page=1;page<=5;page++) {
    const data = await api.request("GET","/actions/workflows/"+mode.file+"/runs?event=workflow_dispatch&branch=main&per_page=100&page="+page);
    const runs = data.workflow_runs || [];
    matches.push(...runs.filter(run=>run.event==="workflow_dispatch" && run.head_branch==="main" &&
      (run.display_title===snapshotTitle || (run.display_title===legacyTitle && run.head_sha===record.commit)) &&
      run.repository?.full_name?.toLowerCase()===record.repo.toLowerCase() && Number.isSafeInteger(run.id)));
    if (runs.length<100) break;
  }
  if (!matches.length) return null;
  requireValue(matches.length===1,"Více běhů se stejnou identitou. Zkontroluj je ručně na GitHubu.");
  const run = matches[0], url = "https://github.com/"+record.repo+"/actions/runs/"+run.id;
  let artifactURL;
  if (run.conclusion === "success") {
    const matches = (await api.artifacts(run.id)).filter(a=>!a.expired && Number.isSafeInteger(a.id) && a.name===mode.artifact+"-"+record.id);
    if (matches.length===1) artifactURL = url+"/artifacts/"+matches[0].id;
  }
  return {url,artifactURL,stage:run.conclusion || run.status};
}

export function mountOriginalRun(container,getWorkspace) {
  const el = (tag,text) => {
    const node=document.createElement(tag);
    if (text) node.textContent=text;
    return node;
  };
  const group=el("section"), title=el("h3","Sestavit původní projekt"), label=el("label","Sdílené schéma ");
  const choices=el("select"); label.append(choices);
  const action=el("select"), actionLabel=el("label","Výstup ");
  for (const [id,text] of [["device","IPA pro iPhone"],["simulator","Spustit v simulátoru a zachytit výsledek"]]) {
    const option=el("option",text); option.value=id; action.append(option);
  }
  actionLabel.append(action);
  const run=el("button","Odeslat a spustit…"), refresh=el("button","Zjistit stav běhu");
  run.type=refresh.type="button";
  const state=el("p"), links=el("p"); state.setAttribute("role","status");
  group.append(title,label,actionLabel,run,refresh,state,links); container.append(group);
  let record, options=[], busy=false;
  try { record=JSON.parse(localStorage.getItem(STATE_KEY)); } catch {}
  const api=()=>globalThis.pocketIDE?.getAPI?.();
  const enable=()=>{
    run.disabled=busy || !options.length;
    refresh.disabled=busy || !record;
    action.disabled=choices.disabled=busy || !options.length;
  };
  const refreshChoices=entries=>{
    options=originalSchemes(entries);
    choices.replaceChildren(...options.map((s,i)=>{const opt=el("option",s.project_path+" · "+s.scheme);opt.value=String(i);return opt;}));
    state.textContent=options.length ? "" : "V archivu je potřeba .xcodeproj se sdíleným schématem (.xcscheme).";
    enable();
  };
  refreshChoices([]);
  const addLink=(name,url)=>{
    const a=el("a",name);a.href=url;a.target="_blank";a.rel="noopener noreferrer";links.append(a,document.createTextNode(" "));
  };
  const updateStatus=async()=>{
    const result=await findOriginalResult(api(),record);
    links.replaceChildren();
    if (!result) {
      state.textContent="Běh s přesnou identitou zatím nebyl nalezen. Po chvíli obnov stav.";
      addLink("Běhy workflow","https://github.com/"+record.repo+"/actions/workflows/"+MODES[record.mode].file);
      return;
    }
    state.textContent="Stav běhu: "+result.stage;
    addLink("Otevřít běh",result.url);
    if (result.artifactURL) addLink(record.mode==="device" ? "Stáhnout ZIP s IPA" : "Stáhnout záznam simulátoru",result.artifactURL);
  };
  refresh.onclick=async()=>{
    busy=true;enable();
    try {await updateStatus();} catch(e){state.textContent=e.message;} finally {busy=false;enable();}
  };
  run.onclick=async()=>{
    if(busy) return;
    busy=true;enable();
    let committed=false;
    try {
      const session=api();requireValue(session,"Nejdřív připoj GitHub v nastavení.");
      const {entries,pack}=getWorkspace(), choice=options[Number(choices.value)], mode=action.value;
      checkOriginalBuild(entries,choice);
      const archive=pack();
      requireValue(archive.size<=BUILD_LIMIT,"ZIP pro vzdálený build musí mít nejvýše 20 MiB.");
      const approved=window.confirm("Odeslat celý upravený ZIP do větve main repozitáře "+session.repo+" a spustit projektové skripty na macOS runneru? Ve veřejném repozitáři budou soubory veřejné. Běh může spotřebovat placené minuty.\n\n"+choice.project_path+" · "+choice.scheme+"\n"+action.selectedOptions[0].textContent);
      if (!approved) return;
      state.textContent="Odesílám snapshot a žádost o běh…";links.replaceChildren();
      await submitOriginal({api:session,archive,choice,mode,approved,onRecord:value=>{
        record=value;committed=true;
        try { localStorage.setItem(STATE_KEY,JSON.stringify(value)); } catch {}
      }});
      state.textContent="Žádost o běh byla přijata. Stav ověříš tlačítkem Zjistit stav běhu.";
    } catch(e) {
      state.textContent=(committed ? "Snapshot je uložený. Před dalším odesláním ověř stav běhu. " : "")+e.message;
    } finally {busy=false;enable();}
  };
  return refreshChoices;
}
