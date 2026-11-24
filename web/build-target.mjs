import {BUILDER_SHA, TEMPLATE_BLOBS} from "./build-pins.mjs";
import {downloadArtifactArchive} from "./result-download.mjs";

const API = "https://api.github.com";
const PUBLIC_EDITOR_ID = 1454608498;
export const PRIVATE_WORKFLOW = ".github/workflows/swide-build.yml";
export const PRIVATE_SCHEMA = "swide-build-request/v2";
const WORKFLOW_API = "/actions/workflows/swide-build.yml";
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const bindingFields = ["repository_id","owner_id","actor_id","caller_branch","caller_sha",
  "builder_sha","workflow_id","workflow_path"];
const encoder = new TextEncoder();

function requireBuild(ok, message) {
  if (!ok) throw Error(message);
}
function positive(n) { return Number.isSafeInteger(n) && n > 0; }
function sameName(a, b) { return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase(); }
function validRepo(repo) {
  return typeof repo === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(repo)
    && ![".",".."].includes(repo.split("/")[1]);
}
function assertBinding(expected, actual) {
  requireBuild(expected && sameName(expected.repo, actual.repo) &&
    bindingFields.every(k => expected[k] === actual[k]), "Změnila se identita soukromého cíle nebo verze šablony.");
}
async function hexDigest(algorithm, bytes) {
  const hash = await crypto.subtle.digest(algorithm, bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function blobSha(bytes) {
  const header = encoder.encode("blob " + bytes.length + "\0");
  const all = new Uint8Array(header.length + bytes.length);
  all.set(header); all.set(bytes, header.length);
  return hexDigest("SHA-1", all);
}
function refPath(id) { return "heads/requests/" + id; }
function manifestPath(id) { return "requests/" + id + ".json"; }
function approvedOptions(r) {
  return r.mode === "generated" && !r.capturePreview && !r.debugAt &&
    /^[A-Za-z][A-Za-z0-9 ._-]{0,59}$/.test(r.appName || "") &&
    /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*){2,}$/.test(r.bundleId || "");
}
function validateProfile(project) {
  for (const path of [...Object.keys(project.files), ...Object.keys(project.binaries || {}), ...(project.dirs || [])]) {
    requireBuild(!path.split("/").some(part => part.startsWith(".") || part.includes("$")) &&
      !/^Tests(?:\/|$)/i.test(path), "Tento soubor nelze zahrnout do omezeného soukromého buildu: " + path);
  }
  for (const path of Object.keys(project.files)) {
    const resource = path.startsWith("Resources/");
    requireBuild(resource ? /\.(json|txt|csv|plist|xml|md|html|css|js)$/i.test(path) : path.endsWith(".swift"),
      "Soukromý build přijímá Swift a podporované soubory Resources: " + path);
  }
}
function requestManifest(r) {
  return {schema:"swide-request/v2", mode:r.mode, request_id:r.request_id, project_path:r.project_path,
    input_sha256:r.input_sha256, app_name:r.appName, bundle_id:r.bundleId, repository_id:r.repository_id,
    owner_id:r.owner_id, caller_sha:r.caller_sha, builder_sha:r.builder_sha, workflow_id:r.workflow_id,
    workflow_path:r.workflow_path};
}
function assertPrepared(r) {
  requireBuild(r && r.schema === PRIVATE_SCHEMA && approvedOptions(r) && UUID.test(r.request_id) &&
    r.project_path === "pocket-builds/" + r.request_id + ".json" && validRepo(r.repo) &&
    [r.actor_id,r.repository_id,r.owner_id,r.workflow_id].every(positive) && r.actor_id === r.owner_id &&
    r.repository_id !== PUBLIC_EDITOR_ID && HEX40.test(r.caller_sha) && HEX40.test(r.builder_sha) &&
    r.builder_sha === BUILDER_SHA && r.workflow_path === PRIVATE_WORKFLOW &&
    typeof r.caller_branch === "string" && r.caller_branch.length > 0 &&
    HEX64.test(r.input_sha256) && HEX64.test(r.manifest_sha256), "Neúplná identita soukromého požadavku.");
}
export function assertSourceIdentity(r) {
  assertPrepared(r);
  requireBuild(HEX40.test(r.source_sha), "Chybí neměnný snímek projektu.");
  return r;
}
function runTitle(r) { return "SwiDe " + r.request_id + " " + r.source_sha + " " + r.manifest_sha256; }
export function matchesPrivateRun(run, r) {
  try { assertSourceIdentity(r); } catch { return false; }
  return !!run && positive(run.id) && run.event === "workflow_dispatch" &&
    run.display_title === runTitle(r) && String(run.path || "").split("@")[0] === r.workflow_path &&
    run.workflow_id === r.workflow_id && run.head_sha === r.caller_sha && run.head_branch === r.caller_branch &&
    run.actor?.id === r.actor_id && run.repository?.id === r.repository_id && run.repository?.private === true &&
    run.head_repository?.id === r.repository_id && sameName(run.repository?.full_name, r.repo) &&
    sameName(run.head_repository?.full_name, r.repo);
}
export function pickPrivateRun(runs, r, expectedId = null) {
  const candidates = runs.filter(run => matchesPrivateRun(run, r));
  if (expectedId !== null) {
    const found = candidates.find(run => run.id === expectedId);
    return {state:found ? "found" : "mismatch", run:found || null};
  }
  return {state:candidates.length === 1 ? "found" : candidates.length ? "ambiguous" : "awaiting",
    run:candidates.length === 1 ? candidates[0] : null};
}

export class PrivateBuildTarget {
  #token;
  #fetcher;
  #binding = null;
  #validate;
  constructor(token, repo, fetcher, validator) {
    requireBuild(typeof token === "string" && token.trim(), "Vlož GitHub token pro soukromý repozitář.");
    requireBuild(validRepo(repo) && !/^HappyMistake64\/(?:SwiDE-SWIft-David-IDE|Xcode-for-iphone)$/i.test(repo),
      "Vyber vlastní soukromý repozitář ze šablony SwiDe.");
    Object.defineProperty(this, "repo", {value:repo, enumerable:true});
    this.#token = token.trim();
    this.#fetcher = fetcher;
    this.#validate = validator;
  }
  get binding() { return this.#binding; }
  async #send(method, path, body, global = false) {
    const response = await this.#fetcher(API + (global ? "" : "/repos/" + this.repo) + path, {
      method, cache:"no-store", redirect:"error", credentials:"omit", referrerPolicy:"no-referrer",
      headers:{Authorization:"Bearer " + this.#token, Accept:"application/vnd.github+json",
        "X-GitHub-Api-Version":"2026-03-10", ...(body === undefined ? {} : {"Content-Type":"application/json"})},
      ...(body === undefined ? {} : {body:JSON.stringify(body)})
    });
    if (!response.ok) {
      const error = Error("GitHub HTTP " + response.status);
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  }
  // Public callers (repository history and inspection) only get a bounded read capability.
  request(method, path) {
    requireBuild(method === "GET" && (path === "" || /^\/[A-Za-z0-9_/-]+(?:\?[^#]*)?$/.test(path)) &&
      !path.startsWith("//") && !path.includes(".."), "Nepovolená operace vzdáleného rozhraní.");
    return this.#send("GET", path);
  }
  check() { return this.#send("GET", ""); }
  async verifyAccess(expected = null) {
    const [user, repository] = await Promise.all([this.#send("GET", "/user", undefined, true), this.check()]);
    requireBuild(sameName(repository?.full_name, this.repo) && positive(repository.id) &&
      repository.id !== PUBLIC_EDITOR_ID && repository.private === true && repository.visibility === "private" &&
      repository.owner?.type === "User" && !repository.archived && !repository.disabled &&
      positive(user?.id) && repository.owner.id === user.id, "Cíl musí být soukromý osobní repozitář přihlášeného vlastníka.");
    requireBuild(repository.permissions?.push === true, "GitHub nepotvrdil přístup k zápisu do repozitáře.");
    requireBuild(HEX40.test(BUILDER_SHA) && Object.keys(TEMPLATE_BLOBS).length === 2, "Chybí schválená verze šablony builderu.");
    const branch = repository.default_branch;
    requireBuild(typeof branch === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) &&
      !branch.includes("..") && !branch.startsWith("requests/"), "Nepodporovaná řídicí větev.");
    const branchRef = await this.#send("GET", "/git/ref/heads/" + branch.split("/").map(encodeURIComponent).join("/"));
    const head = branchRef?.object?.sha;
    requireBuild(branchRef?.ref === "refs/heads/" + branch && branchRef.object?.type === "commit" && HEX40.test(head),
      "GitHub nepotvrdil řídicí commit.");
    const [tree, workflow] = await Promise.all([this.#tree(head), this.#send("GET", WORKFLOW_API)]);
    this.#checkTree(tree, TEMPLATE_BLOBS);
    requireBuild(workflow?.state === "active" && positive(workflow.id) && workflow.path === PRIVATE_WORKFLOW,
      "V soukromém repozitáři chybí povolený workflow SwiDe.");
    const binding = Object.freeze({repo:repository.full_name, repository_id:repository.id, owner_id:user.id,
      actor_id:user.id, caller_branch:branch, caller_sha:head, builder_sha:BUILDER_SHA,
      workflow_id:workflow.id, workflow_path:workflow.path});
    if (this.#binding) assertBinding(this.#binding, binding);
    if (expected) assertBinding(expected, binding);
    this.#binding = binding;
    return repository;
  }
  async #tree(sha, requireRoot = false) {
    const commit = await this.#send("GET", "/git/commits/" + sha);
    requireBuild(commit?.sha === sha && HEX40.test(commit.tree?.sha), "Nepotvrzený commit nebo strom.");
    if (requireRoot) requireBuild(Array.isArray(commit.parents) && commit.parents.length === 0,
      "Reference požadavku neukazuje na samostatný datový commit.");
    const tree = await this.#send("GET", "/git/trees/" + commit.tree.sha + "?recursive=1");
    requireBuild(tree?.sha === commit.tree.sha, "GitHub vrátil jiný strom.");
    return tree;
  }
  #checkTree(tree, files) {
    const folders = new Set();
    for (const path of Object.keys(files)) {
      const parts = path.split("/");
      for (let n=1; n<parts.length; n++) folders.add(parts.slice(0,n).join("/"));
    }
    requireBuild(tree?.truncated === false && Array.isArray(tree.tree) && tree.tree.length === Object.keys(files).length + folders.size,
      "Strom repozitáře neodpovídá schválenému obsahu.");
    const seen = new Set();
    for (const item of tree.tree) {
      requireBuild(!seen.has(item.path) && (folders.has(item.path) ?
        item.type === "tree" && item.mode === "040000" :
        Object.hasOwn(files, item.path) && item.type === "blob" && item.mode === "100644" && item.sha === files[item.path]),
        "Obsah nebo režim souboru v repozitáři neodpovídá očekávání.");
      seen.add(item.path);
    }
  }
  async prepare(r, project) {
    requireBuild(r?.schema === PRIVATE_SCHEMA && UUID.test(r.request_id) && approvedOptions(r) &&
      sameName(r.repo, this.repo) && r.project_path === "pocket-builds/" + r.request_id + ".json" &&
      !r.input_sha256 && !r.manifest_sha256, "Neplatný nebo již připravený požadavek.");
    this.#validate(project); validateProfile(project);
    const bytes = encoder.encode(JSON.stringify(project));
    await this.verifyAccess();
    Object.assign(r, this.#binding);
    r.input_sha256 = await hexDigest("SHA-256", bytes);
    r.manifest_sha256 = await hexDigest("SHA-256", encoder.encode(JSON.stringify(requestManifest(r))));
    assertPrepared(r);
    return r;
  }
  async #snapshotHead(r) {
    try {
      const ref = await this.#send("GET", "/git/ref/" + refPath(r.request_id));
      requireBuild(ref?.ref === "refs/" + refPath(r.request_id) && ref.object?.type === "commit" &&
        HEX40.test(ref.object.sha), "Neplatná reference požadavku.");
      return ref.object.sha;
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }
  async snapshot(r, project) {
    assertPrepared(r);
    this.#validate(project); validateProfile(project);
    const input = JSON.stringify(project), manifest = JSON.stringify(requestManifest(r));
    const inputBytes = encoder.encode(input), manifestBytes = encoder.encode(manifest);
    const [inputHash, manifestHash, sourceBlob, manifestBlob] = await Promise.all([
      hexDigest("SHA-256", inputBytes), hexDigest("SHA-256", manifestBytes), blobSha(inputBytes), blobSha(manifestBytes)]);
    requireBuild(inputHash === r.input_sha256 && manifestHash === r.manifest_sha256,
      "Projekt nebo volby sestavení se po potvrzení změnily.");
    const path = manifestPath(r.request_id);
    const files = {[r.project_path]:sourceBlob, [path]:manifestBlob};
    await this.verifyAccess(r);
    let head = await this.#snapshotHead(r);
    if (!head) {
      // Create only a new root tree and parentless data commit. No workflow, history or main ref is writable here.
      const tree = await this.#send("POST", "/git/trees", {tree:[
        {path:r.project_path, mode:"100644", type:"blob", content:input},
        {path, mode:"100644", type:"blob", content:manifest}]});
      requireBuild(HEX40.test(tree?.sha), "Chybí SHA datového stromu.");
      const commit = await this.#send("POST", "/git/commits", {message:"SwiDe " + r.request_id, tree:tree.sha, parents:[]});
      requireBuild(HEX40.test(commit?.sha), "Chybí SHA datového commitu.");
      try {
        await this.#send("POST", "/git/refs", {ref:"refs/" + refPath(r.request_id), sha:commit.sha});
      } catch (err) {
        if (![409,422].includes(err.status)) throw err;
      }
      head = await this.#snapshotHead(r);
      requireBuild(head, "GitHub nepotvrdil referenci snímku.");
    }
    if (r.source_sha) requireBuild(head === r.source_sha, "Reference uloženého snímku se změnila.");
    this.#checkTree(await this.#tree(head, true), files);
    return head;
  }
  async #verifyRecord(r) {
    assertSourceIdentity(r);
    const digest = await hexDigest("SHA-256", encoder.encode(JSON.stringify(requestManifest(r))));
    requireBuild(digest === r.manifest_sha256, "Uložené volby nesouhlasí s identitou sestavení.");
    await this.verifyAccess(r);
  }
  async dispatch(r) {
    assertSourceIdentity(r);
    requireBuild(!r.run_id && r.stage === "dispatching", "Před spuštěním musí být uložen stav dispatching.");
    await this.#verifyRecord(r);
    requireBuild(await this.#snapshotHead(r) === r.source_sha, "Soukromá reference se změnila.");
    const answer = await this.#send("POST", WORKFLOW_API + "/dispatches", {ref:r.caller_branch,
      inputs:{request_id:r.request_id, source_sha:r.source_sha, manifest_sha256:r.manifest_sha256}});
    requireBuild(positive(answer?.workflow_run_id), "GitHub nepotvrdil ID běhu. Obnov stav bez dalšího spuštění.");
    r.run_id = answer.workflow_run_id;
    return answer;
  }
  getRun(id) {
    requireBuild(positive(id), "Neplatné ID běhu.");
    return this.#send("GET", "/actions/runs/" + id);
  }
  async findRun(r) {
    await this.#verifyRecord(r);
    if (r.run_id != null) return pickPrivateRun([await this.getRun(r.run_id)], r, r.run_id);
    const matches = [];
    for (let page=1; page<=5; page++) {
      const data = await this.#send("GET", WORKFLOW_API + "/runs?event=workflow_dispatch&head_sha=" +
        r.caller_sha + "&branch=" + encodeURIComponent(r.caller_branch) + "&per_page=100&page=" + page);
      requireBuild(Array.isArray(data?.workflow_runs), "Neplatný seznam běhů.");
      matches.push(...data.workflow_runs.filter(run => matchesPrivateRun(run, r)));
      if (matches.length > 1 || data.workflow_runs.length < 100) return pickPrivateRun(matches, r);
    }
    return {state:"ambiguous", run:null};
  }
  async artifacts(id) {
    requireBuild(positive(id), "Neplatné ID běhu.");
    const result = [];
    for (let page=1; page<=5; page++) {
      const data = await this.#send("GET", "/actions/runs/" + id + "/artifacts?per_page=100&page=" + page);
      requireBuild(Array.isArray(data?.artifacts), "Neplatný seznam artefaktů.");
      result.push(...data.artifacts);
      if (data.artifacts.length < 100) return result;
    }
    throw Error("Úplnost seznamu artefaktů se nepodařilo ověřit.");
  }
  async downloadArtifact(artifact) {
    requireBuild(this.#binding && positive(artifact?.id), "Neověřený cíl stažení.");
    await this.verifyAccess(this.#binding);
    return downloadArtifactArchive({repo:this.repo, artifact, token:this.#token, fetcher:this.#fetcher});
  }
}
