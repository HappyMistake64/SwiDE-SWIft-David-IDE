import {validPath, validateProject} from "./core.mjs";

const images = new Map([
  [".png","image/png"], [".jpg","image/jpeg"], [".jpeg","image/jpeg"],
  [".webp","image/webp"], [".gif","image/gif"]
]);
const textTypes = [".swift",".json",".txt",".csv",".plist",".xml",".md",".html",".css",".js"];
const limit = 4_000_000;
const collisionKey = path => path.toUpperCase().toLowerCase().normalize("NFC");

function planFiles(selection, folder) {
  if (folder && !validPath(folder)) throw Error("Zadej relativní cílovou složku, například Sources nebo Resources/Images.");
  const selected = Array.from(selection);
  if (!selected.length || selected.length > 200) throw Error("Vyber 1 až 200 souborů.");
  const names = new Set();
  let bytes = 0;
  return selected.map(file => {
    const name = file.name.normalize("NFC");
    if (!validPath(name) || name.includes("/")) throw Error("Neplatný název souboru: " + name);
    const ext = name.match(/\.[^.]+$/)?.[0].toLowerCase();
    const mime = images.get(ext);
    if (!(mime || textTypes.includes(ext))) throw Error("Nepodporovaný typ souboru: " + name);
    if (ext === ".swift" && !name.endsWith(".swift")) throw Error("Použij malou příponu .swift: " + name);
    const destination = folder || (ext === ".swift" ? "" : "Resources");
    const path = destination ? destination + "/" + name : name;
    if (!validPath(path)) throw Error("Neplatná cílová cesta: " + path);
    if (mime && !path.startsWith("Resources/")) throw Error("Pro obrázky vyber Resources nebo její podsložku.");
    if (ext === ".swift" && path.startsWith("Resources/")) throw Error("Pro Swift vyber složku mimo Resources.");
    const key = collisionKey(path);
    if (names.has(key)) throw Error("Výběr obsahuje stejnou cílovou cestu vícekrát: " + path);
    names.add(key);
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw Error("Nelze zjistit velikost souboru: " + name);
    bytes += mime ? 4 * Math.ceil(file.size/3) : file.size;
    if (bytes > limit) throw Error("Výběr přesahuje limit projektu 4 MB včetně zakódovaných obrázků.");
    return {file,path,mime};
  });
}

function freePaths(project, items) {
  const paths = [...Object.keys(project.files),...Object.keys(project.binaries || {})];
  if (paths.length + items.length > 200) throw Error("Celý projekt může mít nejvýše 200 souborů.");
  const existing = new Set(paths.map(collisionKey));
  for (const {path} of items) {
    if (existing.has(collisionKey(path))) throw Error("Soubor už existuje: " + path + ". Vyber jinou složku nebo soubor přejmenuj.");
  }
}

function binaryBase64(bytes) {
  let raw = "";
  for (let i=0; i<bytes.length; i+=8192) raw += String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(raw);
}

// Read before committing; no project object is held as a mutable destination during asynchronous file reads.
export async function readDeviceFiles(selection, folder = "", project) {
  const items = planFiles(selection,folder);
  if (project) freePaths(project,items);
  const decoded = [];
  for (const {file,path,mime} of items) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength !== file.size) throw Error("Velikost souboru se během čtení změnila: " + path);
    if (mime) {
      decoded.push({path,asset:{mime,base64:binaryBase64(bytes)}});
    } else {
      let text;
      try { text = new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes); }
      catch { throw Error("Textový soubor není UTF-8: " + path); }
      if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(text)) throw Error("Soubor obsahuje binární data: " + path);
      decoded.push({path,text});
    }
  }
  return decoded;
}

export function mergeDeviceFiles(project, items) {
  freePaths(project,items);
  const next = {...project, files:{...project.files}};
  for (const item of items) {
    if (item.asset) {
      if (next.binaries === project.binaries) next.binaries = {...project.binaries};
      next.version = 3;
      next.binaries[item.path] = item.asset;
    } else next.files[item.path] = item.text;
  }
  return validateProject(next);
}

export function mountDeviceFiles(container, api = globalThis.pocketIDE) {
  if (!container || !api || container.dataset.mounted) return;
  container.dataset.mounted = "true";
  const details = document.createElement("details"); details.className = "group";
  const summary = document.createElement("summary"); summary.textContent = "Přidat soubory z iPhonu"; details.append(summary);
  const controls = document.createElement("div"); controls.className = "group-body"; details.append(controls);
  const label = document.createElement("label"); label.textContent = "Cílová složka (volitelná)";
  const folder = document.createElement("input"); folder.autocapitalize="off"; folder.spellcheck=false;
  folder.placeholder = "Např. Sources nebo Resources/Obrazky"; label.append(folder);
  const hint = document.createElement("p"); hint.className="small muted";
  hint.textContent = "Jeden ZIP otevře celý projekt. Jinak vyber Swift, textová data nebo obrázky PNG, JPEG, GIF či WebP. Bez zadané složky se Swift přidá do kořene a textová data a obrázky do Resources. Soubory se stejnou cestou se nepřepisují.";
  const pick = document.createElement("button"); pick.type="button"; pick.textContent="Vybrat soubory…";
  const input = document.createElement("input"); input.type="file"; input.multiple=true; input.hidden=true;
  // Validate after selection so Files can offer Swift and other plain-text extensions from every provider.
  const status = document.createElement("p"); status.setAttribute("role","status");
  controls.append(label,hint,pick,input,status); container.append(details);
  pick.addEventListener("click",()=>input.click());
  document.addEventListener("pocket:import-files",()=>{ if (!pick.disabled) { details.open=true; input.click(); } });
  input.addEventListener("change",async()=>{
    const selection = Array.from(input.files || []);
    input.value="";
    if (!selection.length || pick.disabled) return;
    if (selection.some(file => /\.zip$/i.test(file.name))) {
      if (selection.length !== 1) {
        status.textContent = "Pro otevření projektu vyber jeden ZIP.";
        return;
      }
      document.dispatchEvent(new CustomEvent("pocket:zip-selected", {detail:{file:selection[0]}}));
      return;
    }
    pick.disabled=folder.disabled=true;
    status.textContent="Čtu vybrané soubory…";
    try {
      const target=api.getProject();
      const items=await readDeviceFiles(selection,folder.value,target);
      if (api.getProject() !== target) throw Error("Mezitím se změnil projekt. Vyber soubory znovu.");
      api.save();
      const next=mergeDeviceFiles(target,items);
      const active=items.find(item=>!item.asset)?.path || api.getActive();
      api.commitProject(next,active);
      status.textContent = "Počet přidaných souborů: " + items.length + ".";
      document.dispatchEvent(new CustomEvent("pocket:device-imported", {detail:{paths:items.map(item => item.path)}}));
    } catch (error) {
      status.textContent = "Import se neprovedl. " + (error.message || String(error));
    } finally { pick.disabled=folder.disabled=false; }
  });
}
if (typeof document !== "undefined") mountDeviceFiles(document.getElementById("device-files"));
