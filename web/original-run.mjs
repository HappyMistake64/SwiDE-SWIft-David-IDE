import {sameRepository} from "./core.mjs";

// Original Xcode projects can contain executable build phases. Keep archives on the
// device until the private protocol supports that separate build mode.
const ARCHIVE_NOTICE = "Soukromé sestavení původních Xcode projektů a spuštění v simulátoru zatím nejsou k dispozici. Archiv můžeš upravit a exportovat do Souborů.";
const SHA = /^[0-9a-f]{40}$/;
const MODES = {
  device: {file:"pocket-original-xcode.yml", title:"Original Xcode", artifact:"original-xcode"},
  simulator: {file:"pocket-original-simulator.yml", title:"Original Simulator", artifact:"original-simulator"}
};
const STATE_KEY = "pocket-original-last-v1";
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;
function requireValue(value,message) { if (!value) throw new Error(message); }

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
// Older integrations can still call this entry point without transmitting anything.
export async function submitOriginal() {
  throw new Error(ARCHIVE_NOTICE);
}

export async function findOriginalResult(api,record) {
  requireValue(api && sameRepository(api.repo,record.repo) && Object.hasOwn(MODES,record.mode) && SHA.test(record.commit) && UUID.test(record.id),
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
      sameRepository(run.repository?.full_name,record.repo) && Number.isSafeInteger(run.id)));
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

export function mountOriginalRun(container) {
  const section = document.createElement("section");
  section.id = "zip-build";
  section.tabIndex = -1;
  const heading = document.createElement("h3");
  heading.textContent = "Sestavit původní projekt";
  const notice = document.createElement("p");
  notice.textContent = ARCHIVE_NOTICE;
  const schemes = document.createElement("p");
  section.append(heading, notice, schemes);

  let record;
  try { record = JSON.parse(localStorage.getItem(STATE_KEY)); } catch {}
  if (record && /^[\w.-]+\/[\w.-]+$/.test(record.repo) && SHA.test(record.commit) && UUID.test(record.id)) {
    const link = document.createElement("a");
    link.textContent = "Zobrazit historický snímek sestavení v1 na GitHubu";
    link.href = "https://github.com/" + record.repo + "/commit/" + record.commit;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    section.append(link);
  }
  container.append(section);
  return entries => {
    const names = originalSchemes(entries).map(choice => choice.scheme);
    schemes.hidden = names.length === 0;
    schemes.textContent = names.length ? "Sdílená schémata v archivu: " + names.join(", ") : "";
  };
}
