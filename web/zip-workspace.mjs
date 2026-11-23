import {renderStringCatalog} from "./string-catalog.mjs";
import {mountOriginalRun} from "./original-run.mjs";
// Classic ZIP workspace for iPhone. Codec implementations are supplied by WebKit.
const MiB = 1024 * 1024;
const zipLimits = {input: 20 * MiB, expanded: 50 * MiB, entry: 10 * MiB, output: 32 * MiB, entries: 2000, text: MiB};
const zipEncoder = new TextEncoder();
const zipDecoder = new TextDecoder("utf-8", {fatal:true, ignoreBOM:true});
const editablePath = /\.(?:swift|m|mm|h|c|cpp|hpp|json|xml|plist|md|txt|xcconfig|pbxproj|xcscheme|xcworkspacedata|strings|xcstrings|entitlements|storyboard|xib|yaml|yml|css|html|js|ts)$/i;
const crcTable = Uint32Array.from({length:256}, (_, byte) => {
  for (let bit=0; bit<8; bit++) byte = (byte >>> 1) ^ ((byte & 1) ? 0xedb88320 : 0);
  return byte >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
function check(ok, message) {
  if (!ok) throw new Error(message);
}
function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function safePath(path) {
  const parts = path.replace(/\/$/, "").split("/");
  return path.length <= 1024 && !/[\\:\x00-\x1f\x7f]/.test(path) &&
    parts.every(p => p && p !== "." && p !== "..");
}
function parseDirectory(bytes) {
  check(bytes.length <= zipLimits.input && bytes.length >= 22, "ZIP musí mít nejvýše 20 MiB a platnou hlavičku.");
  const data = view(bytes);
  const u16 = p => data.getUint16(p, true);
  const u32 = p => data.getUint32(p, true);
  let end = bytes.length - 22;
  const last = Math.max(0, end - 65535);
  while (end >= last && (u32(end) !== 0x06054b50 || end+22+u16(end+20) !== bytes.length)) end--;
  check(end >= last, "Konec archivu ZIP se nepodařilo najít.");
  const count = u16(end+10), directoryStart = u32(end+16);
  check(!u16(end+4) && !u16(end+6) && u16(end+8) === count && count <= zipLimits.entries &&
    directoryStart + u32(end+12) === end, "Vícesvazkové archivy, ZIP64 nebo příliš mnoho položek nejsou podporovány.");
  const entries = [], files = new Set(), explicit = new Set();
  let cursor = directoryStart, total = 0;
  for (let n = 0; n < count; n++) {
    check(cursor+46 <= end && u32(cursor) === 0x02014b50, "Poškozený adresář ZIP.");
    const flags = u16(cursor+8), method = u16(cursor+10), crc = u32(cursor+16);
    const compressedSize = u32(cursor+20), size = u32(cursor+24), nameSize = u16(cursor+28);
    const extraSize = u16(cursor+30), commentSize = u16(cursor+32), local = u32(cursor+42);
    const next = cursor+46+nameSize+extraSize+commentSize;
    check(next <= end && !u16(cursor+34) && (flags & ~0x80e) === 0 && (method === 0 || method === 8),
      "ZIP musí používat běžné uložení nebo DEFLATE bez šifrování.");
    check(local+30 <= directoryStart && u32(local) === 0x04034b50 && u16(local+6) === flags &&
      u16(local+8) === method && u16(local+26) === nameSize, "Nesouhlasí lokální hlavička ZIP.");
    const offset = local + 30 + nameSize + u16(local+28);
    check(offset+compressedSize <= directoryStart, "Data položky přesahují konec ZIP.");
    if (!(flags & 8)) check(u32(local+14) === crc && u32(local+18) === compressedSize && u32(local+22) === size,
      "Nesouhlasí velikost nebo kontrolní součet v hlavičkách ZIP.");
    const nameBytes = bytes.subarray(cursor+46, cursor+46+nameSize);
    check(nameBytes.every((b,i) => b === bytes[local+30+i]), "Názvy v hlavičkách ZIP se liší.");
    check((flags & 2048) || nameBytes.every(b => b < 128), "Název souboru není označen jako UTF-8.");
    const path = zipDecoder.decode(nameBytes), dir = path.endsWith("/");
    check(safePath(path), "ZIP obsahuje nepovolenou cestu.");
    const key = path.replace(/\/$/, "").normalize("NFC").toLowerCase();
    check(!explicit.has(key), "ZIP obsahuje duplicitní cestu.");
    explicit.add(key);
    if (!dir) files.add(key);
    const mode = data.getUint8(cursor+5) === 3 ? u32(cursor+38) >>> 16 : 0;
    const type = mode & 0xf000;
    check(!type || type === (dir ? 0x4000 : 0x8000), "ZIP se symbolickými odkazy nebo zvláštními soubory není podporován.");
    check(!dir || size === 0, "Složka ZIP obsahuje neočekávaná data.");
    total += size;
    check(size <= zipLimits.entry && total <= zipLimits.expanded && (method !== 0 || compressedSize === size), "Překročen limit 10 MiB na soubor nebo 50 MiB pro rozbalený ZIP, případně neplatná velikost.");
    entries.push({path, dir, mode, crc, method, size, time:u16(cursor+12), date:u16(cursor+14),
      packed:bytes.subarray(offset, offset+compressedSize), local, end:offset+compressedSize});
    cursor = next;
  }
  check(cursor === end, "Nesouhlasí velikost adresáře ZIP.");
  const orderedPaths = [...explicit].sort();
  for (const file of files) {
    // Find the first lexicographic descendant without expanding every prefix of every name.
    const prefix = file + "/";
    let low = 0, high = orderedPaths.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (orderedPaths[middle] < prefix) low = middle + 1;
      else high = middle;
    }
    check(!orderedPaths[low]?.startsWith(prefix), "ZIP používá stejnou cestu jako složku i soubor.");
  }
  const ranges = entries.slice().sort((a,b) => a.local-b.local);
  for (let i=1; i<ranges.length; i++) check(ranges[i-1].end <= ranges[i].local, "Položky ZIP se překrývají.");
  return entries;
}

async function unpack(entry) {
  if (entry.method === 0) return entry.packed;
  const stream = new Blob([entry.packed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader(), bytes = new Uint8Array(entry.size);
  let offset = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      check(result.value.length <= bytes.length-offset, "Položka ZIP překročila deklarovanou velikost.");
      bytes.set(result.value, offset);
      offset += result.value.length;
    }
    check(offset === bytes.length, "Rozbalená velikost souboru nesouhlasí.");
    return bytes;
  } catch (err) {
    await reader.cancel().catch(()=>{});
    throw err;
  } finally {
    reader.releaseLock();
  }
}

export async function openZipWorkspace(bytes) {
  const entries = parseDirectory(bytes);
  for (const e of entries) {
    const original = await unpack(e);
    check(crc32(original) === e.crc, "Nesouhlasí kontrolní součet souboru " + e.path + ".");
    if (!e.dir && e.size <= zipLimits.text && editablePath.test(e.path)) {
      try {
        const text = zipDecoder.decode(original);
        if (!/[\x00-\x08\x0b\x0e-\x1f]/.test(text)) {
          e.bom = text.startsWith("\ufeff");
          e.text = e.bom ? text.slice(1) : text;
          e.crlf = e.text.includes("\r\n") && !e.text.replaceAll("\r\n","").includes("\n");
        }
      } catch { /* Binary plist and non-UTF-8 text are preserved without editing. */ }
    }
  }
  return entries;
}

export function exportZipWorkspace(entries) {
  const localParts = [], centralParts = [];
  let localSize = 0, centralSize = 0, expandedSize = 0;
  for (const e of entries) {
    const name = zipEncoder.encode(e.path);
    const changed = typeof e.edit === "string" && e.edit !== e.text;
    const packed = changed ? zipEncoder.encode((e.bom ? "\ufeff" : "") + e.edit) : e.packed;
    const size = changed ? packed.length : e.size, method = changed ? 0 : e.method;
    const crc = changed ? crc32(packed) : e.crc;
    expandedSize += size;
    const headerSize = 30 + name.length, centralLength = 46 + name.length;
    check(expandedSize <= zipLimits.expanded && localSize+centralSize+headerSize+packed.length+centralLength+22 <= zipLimits.output,
      "Projekt při exportu přesahuje 32 MiB.");
    const local = new Uint8Array(headerSize), lv = view(local);
    lv.setUint32(0,0x04034b50,true);
    lv.setUint16(4,20,true); lv.setUint16(6,2048,true); lv.setUint16(8,method,true);
    lv.setUint16(10,e.time,true); lv.setUint16(12,e.date,true);
    lv.setUint32(14,crc,true); lv.setUint32(18,packed.length,true); lv.setUint32(22,size,true);
    lv.setUint16(26,name.length,true); local.set(name,30);
    const central = new Uint8Array(centralLength), cv = view(central);
    cv.setUint32(0,0x02014b50,true); cv.setUint16(4,0x314,true);
    central.set(local.subarray(4,28),6);
    const perms = e.mode ? e.mode & 0o777 : (e.dir ? 0o755 : 0o644);
    cv.setUint32(38, ((perms | (e.dir ? 0x4000 : 0x8000)) << 16) | (e.dir ? 16 : 0),true);
    cv.setUint32(42,localSize,true); central.set(name,46);
    localParts.push(local,packed); centralParts.push(central);
    localSize += headerSize + packed.length; centralSize += centralLength;
  }
  const end = new Uint8Array(22), ev = view(end);
  ev.setUint32(0,0x06054b50,true); ev.setUint16(8,entries.length,true); ev.setUint16(10,entries.length,true);
  ev.setUint32(12,centralSize,true); ev.setUint32(16,localSize,true);
  return new Blob([...localParts,...centralParts,end],{type:"application/zip"});
}

function exportName(name) {
  const stem = name.replace(/\.zip$/i,"").replace(/[\\/:\x00-\x1f\x7f]/g,"_").slice(0,106);
  return (stem || "Projekt") + "-upraveny.zip";
}
async function shareArchive(blob,name) {
  const native = globalThis.webkit?.messageHandlers?.exportWorkspaceZip;
  if (native) {
    const base64 = await new Promise((resolve,reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("ZIP se nepodařilo připravit pro sdílení."));
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.readAsDataURL(blob);
    });
    native.postMessage({name,base64});
    return;
  }
  const file = new File([blob],name,{type:"application/zip"});
  if (navigator.canShare?.({files:[file]})) {
    await navigator.share({files:[file]});
    return;
  }
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.download = name; link.href = url;
  document.body.append(link); link.click(); link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
}
function openWorkspaceDB() {
  return new Promise((resolve,reject) => {
    const req = indexedDB.open("xcode-pocket-zip-workspace",1);
    req.onupgradeneeded = () => req.result.createObjectStore("workspace");
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}
function workspaceTransaction(db,mode,action) {
  return new Promise((resolve,reject) => {
    const tx = db.transaction("workspace",mode);
    const store = tx.objectStore("workspace");
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || new Error("Projekt byl změněn v jiném okně. Obnov stránku."));
    action(store,tx,value=>{result=value;});
  });
}
async function readSavedWorkspace(db) {
  return workspaceTransaction(db,"readonly",(store,tx,done) => {
    const result = {edits:new Map()};
    const req = store.openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) { done(result); return; }
      if (c.key === "original") result.original = c.value;
      if (c.key === "id") result.id = c.value;
      if (typeof c.key === "string" && c.key.startsWith("edit:")) result.edits.set(c.key.slice(5),c.value);
      c.continue();
    };
  });
}
function replaceSavedWorkspace(db,id,original,expectedId) {
  return workspaceTransaction(db,"readwrite",(store,tx) => {
    const current = store.get("id");
    current.onsuccess = () => {
      if (current.result !== expectedId) { tx.abort(); return; }
      store.clear();
      store.put(id,"id");
      store.put(original,"original");
    };
  });
}
function saveFileEdit(db,id,entry,edited) {
  return workspaceTransaction(db,"readwrite",(store,tx) => {
    const current = store.get("id");
    current.onsuccess = () => {
      if (current.result !== id) { tx.abort(); return; }
      const key = "edit:"+entry.path;
      if (edited === entry.text) store.delete(key);
      else store.put(edited,key);
    };
  });
}
const mountedZipContainers = new WeakSet();
export function mountZipWorkspace(container) {
  if (!container || mountedZipContainers.has(container)) return;
  mountedZipContainers.add(container);
  const make = (tag,text) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    return node;
  };
  const choose = make("button","Otevřít ZIP"), save = make("button","Exportovat ZIP");
  const originalExport = make("button","Exportovat původní ZIP");
  choose.type = save.type = originalExport.type = "button"; save.disabled = originalExport.disabled = true;
  const input = make("input");
  input.type = "file"; input.accept = ".zip,application/zip"; input.hidden = true;
  const filename = make("p","Žádný otevřený archiv."), label = make("label","Soubor v archivu ");
  const select = make("select"); select.disabled = true; label.append(select);
  const editor = make("textarea");
  editor.spellcheck = false; editor.hidden = true; editor.setAttribute("aria-label","Text souboru v archivu");
  const status = make("p"); status.setAttribute("role","status");
  const catalogPanel = make("fieldset"); catalogPanel.hidden = true;
  container.append(choose,input,filename,label,editor,catalogPanel,save,originalExport,status);
  let entries = [], archiveName = "", originalFile, db, workspaceId, editSequence = 0;
  const updateOriginalRun = mountOriginalRun(container,()=>({entries,pack:()=>exportZipWorkspace(entries)}));
  function updateButtons(busy) {
    choose.disabled = editor.disabled = catalogPanel.disabled = busy;
    select.disabled = busy || !entries.length;
    save.disabled = originalExport.disabled = busy || !originalFile;
  }
  const show = () => {
    const e = entries[Number(select.value)];
    const editable = e && typeof e.text === "string";
    const isCatalog = editable && /\.xcstrings$/i.test(e.path);
    editor.hidden = !editable || isCatalog;
    catalogPanel.hidden = !isCatalog;
    if (isCatalog) renderStringCatalog(catalogPanel, e.edit ?? e.text, next => saveEdit(e, next));
    else catalogPanel.replaceChildren();
    editor.value = editable ? e.edit ?? e.text : "";
    status.textContent = !e ? "Archiv je prázdný." : editable
      ? (db ? "Změny se ukládají na tomto zařízení." : "Úložiště není dostupné. Ulož změny pomocí Exportovat ZIP.")
      : "Tato položka zůstane v exportu beze změny.";
  };
  function displayArchive(candidate,file) {
    entries = candidate; originalFile = file; archiveName = file.name;
    updateOriginalRun(entries);
    filename.textContent = file.name + " · " + entries.length + " položek";
    select.replaceChildren(...entries.map((e,i)=>{
      const option = make("option",e.path); option.value = String(i); return option;
    }));
    const first = entries.findIndex(e => typeof e.text === "string");
    if (first >= 0) select.selectedIndex = first;
    show();
  }
  updateButtons(true);
  void (async () => {
    try {
      db = await openWorkspaceDB();
      const saved = await readSavedWorkspace(db);
      workspaceId = saved.id;
      if (saved.original) {
        const candidate = await openZipWorkspace(new Uint8Array(await saved.original.arrayBuffer()));
        for (const entry of candidate) {
          if (typeof entry.text === "string" && saved.edits.has(entry.path)) entry.edit = saved.edits.get(entry.path);
        }
        displayArchive(candidate,saved.original);
      }
    } catch (error) {
      status.textContent = "Obnovení ZIP není dostupné. " + (error.message || "");
    } finally { updateButtons(false); }
  })();
  choose.addEventListener("click",()=>input.click());
  select.addEventListener("change",show);
  function saveEdit(e, edited) {
    if (e !== entries[Number(select.value)] || editor.disabled) throw Error("Výběr souboru se změnil.");
    if (zipEncoder.encode((e.bom ? "\ufeff" : "") + edited).length > zipLimits.text) {
      throw Error("Limit pro textové úpravy je 1 MiB.");
    }
    e.edit = edited;
    if (db) {
      const sequence = ++editSequence, id = workspaceId;
      status.textContent = "Ukládám změnu…";
      void saveFileEdit(db,id,e,edited).then(()=>{
        if (id === workspaceId && sequence === editSequence) status.textContent = "Změna uložena na tomto zařízení.";
      }).catch(error=>{
        if (id === workspaceId && sequence === editSequence) status.textContent = "Změnu se nepodařilo uložit. Exportuj ZIP. " + error.message;
      });
    }
  }
  editor.addEventListener("input",()=>{
    const e = entries[Number(select.value)];
    if (!e || typeof e.text !== "string") return;
    try { saveEdit(e, e.crlf ? editor.value.replace(/\n/g,"\r\n") : editor.value); }
    catch (error) { editor.value = e.edit ?? e.text; status.textContent = error.message; }
  });
  input.addEventListener("change", async () => {
    const file = input.files[0];
    input.value = "";
    if (!file) return;
    if (entries.some(e => e.edit !== undefined && e.edit !== e.text) &&
        !window.confirm("Otevřít jiný ZIP a zahodit neexportované změny?")) return;
    updateButtons(true);
    status.textContent = "Kontroluji archiv…";
    try {
      check(file.size <= zipLimits.input,"ZIP musí mít nejvýše 20 MiB.");
      const candidate = await openZipWorkspace(new Uint8Array(await file.arrayBuffer()));
      const id = crypto.randomUUID();
      if (db) await replaceSavedWorkspace(db,id,file,workspaceId);
      workspaceId = id;
      displayArchive(candidate,file);
    } catch (error) {
      status.textContent = error.message || "ZIP se nepodařilo otevřít.";
    } finally {
      updateButtons(false);
    }
  });
  const exportCurrent = async original => {
    updateButtons(true);
    try {
      const blob = original ? originalFile : exportZipWorkspace(entries);
      const name = original ? (archiveName.replace(/\.zip$/i,"").replace(/[\\/:\x00-\x1f\x7f]/g,"_").slice(0,116) || "Projekt")+".zip" : exportName(archiveName);
      await shareArchive(blob,name);
      status.textContent = "ZIP byl předán k uložení nebo sdílení.";
    } catch (error) {
      status.textContent = error.name === "AbortError" ? "Sdílení bylo zrušeno." : error.message;
    } finally { updateButtons(false); }
  };
  save.addEventListener("click",()=>void exportCurrent(false));
  originalExport.addEventListener("click",()=>void exportCurrent(true));
}

if (typeof document !== "undefined") {
  const autoMount = () => mountZipWorkspace(document.getElementById("zip-workspace"));
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded",autoMount,{once:true});
  else autoMount();
}
