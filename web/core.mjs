// SwiDe browser protocol shared by the UI and Node tests.
import {PrivateBuildTarget, PRIVATE_SCHEMA, PRIVATE_WORKFLOW, assertSourceIdentity, matchesPrivateRun, pickPrivateRun} from "./build-target.mjs";

export const REPOSITORY = "HappyMistake64/SwiDE-SWIft-David-IDE";
const LEGACY_REPOSITORY = "HappyMistake64/Xcode-for-iphone";

function canonicalRepository(name) {
  const key = name.toLowerCase();
  return key === LEGACY_REPOSITORY.toLowerCase() || key === REPOSITORY.toLowerCase() ? REPOSITORY : name;
}

export function sameRepository(a, b) {
  return typeof a === "string" && typeof b === "string" &&
    canonicalRepository(a).toLowerCase() === canonicalRepository(b).toLowerCase();
}
export const WORKFLOW = PRIVATE_WORKFLOW;
export const STORAGE_KEY = "xcode-pocket-standalone-v1";
export const SHA_RE = /^[a-f0-9]{40}$/;
export const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function newProject() {
  return {format: "xcode-pocket-project", version: 2, files: {
    "PocketApp.swift": "import SwiftUI\n\n@main\nstruct PocketApp: App {\n    var body: some Scene {\n        WindowGroup { ContentView() }\n    }\n}\n",
    "ContentView.swift": "import SwiftUI\n\nstruct ContentView: View {\n    @State private var count = 0\n    var body: some View {\n        VStack(spacing: 24) {\n            Text(\"Ahoj z iPhonu\").font(.largeTitle)\n            Button(\"Klepnutí: \\(count)\") { count += 1 }\n                .buttonStyle(.borderedProminent)\n        }.padding()\n    }\n}\n"
  }};
}

export function validPath(name) {
  return typeof name === "string" && !!name && name.length <= 480 && [...name].length <= 240 && name === name.normalize("NFC") &&
    !/[\\\u0000-\u001f\u007f]/.test(name) && name.split("/").every(p =>
      !!p && p === p.trim() && ![".", "..", "__proto__", "constructor", "prototype"].includes(p));
}

const IMAGE_EXTENSIONS = new Map([
  ["image/png", [".png"]], ["image/jpeg", [".jpg", ".jpeg"]],
  ["image/gif", [".gif"]], ["image/webp", [".webp"]]
]);
const CATALOG = "Resources/Assets.xcassets/";
const projectMap = value => value !== null && typeof value === "object" && !Array.isArray(value);
const pathKey = name => name.toUpperCase().toLowerCase().normalize("NFC");

function checkImage(name, entry) {
  if (!projectMap(entry) || Object.keys(entry).length !== 2 ||
      !Object.hasOwn(entry, "mime") || !Object.hasOwn(entry, "base64") ||
      !name.startsWith("Resources/") ||
      !IMAGE_EXTENSIONS.get(entry.mime)?.some(extension => name.toLowerCase().endsWith(extension))) {
    throw Error("Cesta, přípona a MIME obrázku nesouhlasí: " + name);
  }
  const encoded = entry.base64;
  if (typeof encoded !== "string" || !encoded || encoded.length % 4) throw Error("Neplatné base64: " + name);
  let bytes;
  try { bytes = atob(encoded); } catch { throw Error("Neplatné base64: " + name); }
  if (btoa(bytes) !== encoded) throw Error("Neplatné base64: " + name);
  let valid;
  switch (entry.mime) {
    case "image/png":
      valid = bytes.length >= 24 && bytes.startsWith("\x89PNG\r\n\x1a\n") && bytes.slice(12,16) === "IHDR"; break;
    case "image/jpeg":
      valid = bytes.length >= 4 && bytes.startsWith("\xff\xd8\xff") && bytes.endsWith("\xff\xd9"); break;
    case "image/gif":
      valid = bytes.length >= 13 && /^GIF8[79]a/.test(bytes); break;
    case "image/webp":
      valid = bytes.length >= 16 && bytes.startsWith("RIFF") && bytes.slice(8,12) === "WEBP"; break;
  }
  if (!valid) throw Error("Obsah obrázku neodpovídá formátu: " + name);
}

function catalogMetadata(files, path) {
  const text = files[path];
  let value;
  try { value = JSON.parse(text); } catch { throw Error("Chybí nebo je neplatný " + path); }
  // JSON.parse keeps the last duplicate. The native generator rejects duplicate keys.
  const objects = [];
  for (const match of text.matchAll(/"(?:\\.|[^"\\])*"|[{}]/g)) {
    if (match[0] === "{") objects.push(new Set());
    else if (match[0] === "}") objects.pop();
    else if (/^\s*:/.test(text.slice(match.index + match[0].length))) {
      const key = JSON.parse(match[0]), keys = objects[objects.length - 1];
      if (keys.has(key)) throw Error("Duplicitní klíč v " + path);
      keys.add(key);
    }
  }
  if (!projectMap(value) || !projectMap(value.info) || value.info.version !== 1 ||
      Object.keys(value.info).some(key => !["version", "author"].includes(key)) ||
      ("author" in value.info && typeof value.info.author !== "string")) throw Error("Neplatná metadata: " + path);
  return value;
}

function checkCatalog(files, binaries) {
  const assets = [...Object.keys(files), ...Object.keys(binaries)].filter(path =>
    path.split("/").some(part => part.toLowerCase().endsWith(".xcassets")));
  if (!assets.length) return;
  const root = CATALOG + "Contents.json";
  if (Object.keys(catalogMetadata(files, root)).length !== 1) throw Error("Neplatný katalog: " + root);
  const accepted = new Set([root]), sets = new Set();
  for (const path of assets) {
    if (path === root) continue;
    const parts = path.slice(CATALOG.length).split("/");
    if (!path.startsWith(CATALOG) || parts.length !== 2 ||
        !/^[A-Za-z_][A-Za-z0-9_-]{0,79}\.imageset$/.test(parts[0])) throw Error("Nepodporovaná cesta v katalogu: " + path);
    sets.add(parts[0]);
  }
  for (const set of sets) {
    const folder = CATALOG + set + "/", metadata = folder + "Contents.json";
    const value = catalogMetadata(files, metadata);
    if (Object.keys(value).length !== 2 || !Array.isArray(value.images) ||
        value.images.length < 1 || value.images.length > 3) throw Error("Neplatný imageset: " + set);
    accepted.add(metadata);
    const scales = new Set();
    for (const entry of value.images) {
      if (!projectMap(entry) || Object.keys(entry).length !== 3 || entry.idiom !== "universal" ||
          !["1x", "2x", "3x"].includes(entry.scale) || scales.has(entry.scale) ||
          typeof entry.filename !== "string" || !validPath(entry.filename) || entry.filename.includes("/")) {
        throw Error("Neplatný odkaz v imagesetu: " + set);
      }
      const path = folder + entry.filename;
      if (accepted.has(path) || !["image/png", "image/jpeg"].includes(binaries[path]?.mime)) {
        throw Error("Chybějící nebo duplicitní obrázek: " + path);
      }
      accepted.add(path); scales.add(entry.scale);
    }
  }
  if (accepted.size !== assets.length) throw Error("Katalog obsahuje nepoužité soubory.");
}

export function validateProject(p) {
  if (!p || p.format !== "xcode-pocket-project" || ![1, 2, 3].includes(p.version) ||
      !projectMap(p.files) || ("binaries" in p && (p.version !== 3 || !projectMap(p.binaries)))) {
    throw Error("Neplatný projekt.");
  }
  if (new TextEncoder().encode(JSON.stringify(p)).length > 4_000_000) throw Error("Projekt je větší než 4 MB.");
  const binaries = p.binaries || {};
  const names = [...Object.keys(p.files), ...Object.keys(binaries)];
  if (!names.length || names.length > 200) throw Error("Projekt musí mít 1–200 souborů.");
  const dirs = "dirs" in p ? p.dirs : [];
  if (!Array.isArray(dirs) || dirs.length > 400) throw Error("Neplatný seznam složek.");
  const files = new Set(), prefixes = new Map();
  function register(name, directory) {
    if (!validPath(name)) throw Error("Neplatná cesta souboru nebo složky: " + name);
    let path = "";
    for (const part of name.split("/")) {
      path += (path ? "/" : "") + part;
      const key = pathKey(path);
      if (prefixes.has(key) && prefixes.get(key) !== path) throw Error("Konflikt názvů souborů nebo složek: " + path);
      if (files.has(key) || (!directory && path === name && prefixes.has(key))) throw Error("Konflikt soubor/složka: " + path);
      prefixes.set(key, path);
    }
    if (!directory) files.add(pathKey(name));
  }
  names.forEach(name => register(name, false));
  dirs.forEach(name => register(name, true));
  const swiftNames = new Set();
  let mainSwift = false;
  for (const [name, body] of Object.entries(p.files)) {
    if (typeof body !== "string") throw Error("Neplatný obsah souboru: " + name);
    if (name.startsWith("Resources/") && (!/\.(json|txt|csv|plist|xml|md|html|css|js)$/i.test(name) || body.includes("\0"))) {
      throw Error("Nepodporovaný textový Resource: " + name);
    }
    if (name.endsWith(".swift")) {
      const isTest = name.startsWith("Tests/");
      const key = (isTest ? "test:" : "app:") + pathKey(name.split("/").pop());
      if (swiftNames.has(key)) throw Error("Duplicitní název Swift souboru: " + name);
      swiftNames.add(key);
      if (!isTest) mainSwift = true;
    }
  }
  if (!mainSwift) throw Error("Chybí hlavní Swift soubor.");
  for (const [name, entry] of Object.entries(binaries)) checkImage(name, entry);
  checkCatalog(p.files, binaries);
  return p;
}

export function validateSettings(s) {
  const repo = s.repo || "", appName = (s.appName || "PocketApp").trim(), bundleId = s.bundleId || "cz.davidvolf.pocketapp";
  if (repo && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(repo)) throw Error("Repozitář musí být owner/repo.");
  if (!/^[A-Za-z][A-Za-z0-9 ._-]{0,59}$/.test(appName)) throw Error("Neplatný název aplikace.");
  if (!/^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*){2,}$/.test(bundleId)) throw Error("Neplatné Bundle ID.");
  return {repo:canonicalRepository(repo),appName,bundleId};
}

export function makeRequest(s, project, id = crypto.randomUUID()) {
  validateProject(project);
  const settings = validateSettings(s);
  if (!UUID_RE.test(id)) throw Error("Neplatné UUID.");
  if (!settings.repo || sameRepository(settings.repo,REPOSITORY)) throw Error("Vyber vlastní soukromý repozitář.");
  return {...settings, schema:PRIVATE_SCHEMA, mode:"generated", run_attempt:1, request_id:id, project_path:"pocket-builds/" + id + ".json",
    source_sha:null, run_id:null, stage:"prepared", created_at:new Date().toISOString()};
}

export const assertIdentity = assertSourceIdentity;

export function utf8Base64(source) {
  const bytes = new TextEncoder().encode(source);
  let binary = "";
  for (let i=0; i<bytes.length; i+=8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(binary);
}

export const matchesRun = matchesPrivateRun;
export const pickRun = pickPrivateRun;

export class GithubAPI extends PrivateBuildTarget {
  constructor(token,repo,fetcher=globalThis.fetch.bind(globalThis)) {
    super(token, repo, fetcher, validateProject);
  }
}

// Retain old project data and historical records while dropping all credential fields.
function restoreBuild(value) {
  if (!value || !UUID_RE.test(value.request_id)) return null;
  const fields = ["request_id","repo","source_sha","project_path","created_at","stage","appName","bundleId",
    "schema","mode","run_id","run_attempt","repository_id","owner_id","actor_id","workflow_id",
    "workflow_path","caller_branch","caller_sha","builder_sha","input_sha256","manifest_sha256","artifact_id","artifact_digest","nextAttempt"];
  const build = {};
  for (const field of fields) {
    const entry = value[field];
    if (typeof entry === "string" || Number.isSafeInteger(entry) || entry === null) build[field] = entry;
  }
  if (build.schema !== PRIVATE_SCHEMA || sameRepository(build.repo, REPOSITORY)) {
    build.stage = "historical";
  }
  return build;
}

export function restoreState(raw) {
  let saved;
  try { saved = JSON.parse(raw) || {}; } catch { saved = {}; }
  let settings, project;
  try { settings = validateSettings(saved.settings || {}); } catch { settings = validateSettings({}); }
  if (sameRepository(settings.repo, REPOSITORY)) settings.repo = "";
  try { project = validateProject(saved.project); } catch { project = newProject(); }
  const history = Array.isArray(saved.builds) ? saved.builds.map(restoreBuild).filter(Boolean) : [];
  let ended = 0;
  const builds = history.filter(build => {
    if (!["ready","historical","failed"].includes(build.stage)) return true;
    ended += 1;
    return ended <= 30;
  });
  return {project, settings, builds,
    active:typeof saved.active === "string" ? saved.active : "PocketApp.swift"};
}
