// The browser picker supplies a relative path per File; the native picker can also report empty directories.
const limits = {count:2000, file:10*1024*1024, archive:20*1024*1024};
const encoder = new TextEncoder();

function validSegment(name) {
  return typeof name === "string" && name !== "" && name !== "." && name !== ".." &&
    name === name.trim() && !/[\\/:\u0000-\u001f\u007f]/.test(name);
}

function checkCount(count) {
  if (count > limits.count) throw Error("Složka může obsahovat nejvýše 2000 položek.");
}

function checkedFileSize(size) {
  if (!Number.isSafeInteger(size) || size < 0 || size > limits.file) throw Error("Jeden soubor může mít nejvýše 10 MiB.");
  return size;
}

function validatePaths(root, items) {
  if (!validSegment(root)) throw Error("Neplatný název vybrané složky.");
  if (!items.length) throw Error("Složka neobsahuje žádné položky k importu.");
  checkCount(items.length);
  const tree = new Map();
  const packageRoot = /\.(?:xcodeproj|xcworkspace)$/i.test(root);
  let archiveSize = 22;
  return items.map(item => {
    if (typeof item.path !== "string" || item.path.length > 1024) throw Error("Neplatná cesta souboru.");
    const path = ((packageRoot ? root + "/" : "") + item.path).normalize("NFC");
    if (path.length + Number(item.dir) > 1024) throw Error("Cesta přesahuje limit projektu.");
    const segments = path.split("/");
    let children = tree;
    for (let index=0; index<segments.length; index++) {
      const name = segments[index], last = index === segments.length-1;
      if (!validSegment(name)) throw Error("Neplatná součást cesty: " + path);
      const folded = name.toUpperCase().toLowerCase().normalize("NFC");
      let entry = children.get(folded);
      if (!entry) {
        entry = {name,dir:!last || item.dir,explicit:false,children:new Map()};
        children.set(folded,entry);
      }
      if (entry.name !== name || (!last && !entry.dir) || (last && (entry.explicit || entry.dir !== item.dir))) {
        throw Error("Konflikt názvů souborů nebo složek: " + path);
      }
      if (last) entry.explicit = true;
      children = entry.children;
    }
    const zipPath = path + (item.dir ? "/" : "");
    archiveSize += 76 + 2*encoder.encode(zipPath).length + checkedFileSize(item.size);
    if (archiveSize > limits.archive) throw Error("Složka po zabalení překračuje limit vstupního ZIPu 20 MiB.");
    return {...item,path:zipPath};
  });
}

function zipTimestamp(modified) {
  const d = new Date(modified);
  if (!Number.isFinite(d.valueOf()) || d.getFullYear()<1980 || d.getFullYear()>2107) return {date:33,time:0};
  return {date:((d.getFullYear()-1980)<<9)|((d.getMonth()+1)<<5)|d.getDate(),
    time:(d.getHours()<<11)|(d.getMinutes()<<5)|(d.getSeconds()>>>1)};
}

async function makeArchive(root, items, pack, checksum) {
  const plan = validatePaths(root,items), entries = [];
  for (const item of plan) {
    const packed = item.dir ? new Uint8Array() : await item.read();
    if (packed.length !== item.size) throw Error("Velikost souboru se při importu změnila: " + item.path);
    entries.push({path:item.path,dir:item.dir,mode:item.dir ? 0o755 : 0o644,method:0,
      size:item.size,packed,crc:checksum(packed),...zipTimestamp(item.modified)});
  }
  return new File([pack(entries)],root.normalize("NFC") + ".zip",{type:"application/zip"});
}

export async function folderSelectionToZip(files, pack, checksum) {
  if (!files || !files.length) throw Error("Nebyla vybrána složka se soubory.");
  checkCount(files.length);
  let root;
  const items = Array.from(files,file => {
    const relative = file.webkitRelativePath;
    if (!relative || relative.length > 2049) throw Error("Prohlížeč nepředal cestu vybrané složky. Použij import ZIPu.");
    const slash = relative.indexOf("/");
    if (slash <= 0 || relative.slice(relative.lastIndexOf("/")+1) !== file.name) throw Error("Neplatná cesta z výběru složky.");
    const selected = relative.slice(0,slash);
    if (root !== undefined && root !== selected) throw Error("Vyber jedinou kořenovou složku.");
    root = selected;
    return {path:relative.slice(slash+1),dir:false,size:file.size,modified:file.lastModified,
      read:async()=>new Uint8Array(await file.arrayBuffer())};
  });
  return makeArchive(root,items,pack,checksum);
}

export async function nativeFolderToZip(selection,pack,checksum) {
  if (!selection || !Array.isArray(selection.files) || !Array.isArray(selection.dirs)) throw Error("Neplatný výsledek výběru složky.");
  checkCount(selection.files.length + selection.dirs.length);
  const items = selection.dirs.map(path=>({path,dir:true,size:0}));
  for (const file of selection.files) {
    if (!file || typeof file.base64 !== "string" || file.base64.length % 4) throw Error("Neplatná data souboru.");
    const base64 = file.base64;
    const size = checkedFileSize(base64.length/4*3 - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0));
    items.push({path:file.path,dir:false,size,read:()=>{
      let raw;
      try { raw = atob(base64); } catch { throw Error("Poškozený obsah souboru: " + file.path); }
      if (btoa(raw) !== base64) throw Error("Poškozený obsah souboru: " + file.path);
      return Uint8Array.from(raw,byte=>byte.charCodeAt(0));
    }});
  }
  return makeArchive(selection.name,items,pack,checksum);
}
