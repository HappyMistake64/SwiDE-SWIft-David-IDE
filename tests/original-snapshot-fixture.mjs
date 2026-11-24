// Offline fixture: compile a synthetic project edited and exported by the local ZIP editor using an isolated local Git repository.
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {newProject} from "../web/core.mjs";
import {openZipWorkspace,exportZipWorkspace} from "../web/zip-workspace.mjs";
import {originalSchemes} from "../web/original-run.mjs";

const work = path.resolve(process.argv[2]), snapshot = path.join(work,"snapshot");
const generator=fileURLToPath(new URL("../native-build/generate_project.py",import.meta.url));
await mkdir(work,{recursive:true});
await mkdir(snapshot);
await writeFile(path.join(work,"project.json"),JSON.stringify(newProject()));
execFileSync("python3",[generator,"--input","project.json","--output","Demo","--bundle-id","org.example.originalcheck"],{cwd:work});
execFileSync("python3",["-m","zipfile","-c","Demo.zip","Demo"],{cwd:work});
const entries = await openZipWorkspace(new Uint8Array(await readFile(path.join(work,"Demo.zip"))));
const choices=originalSchemes(entries);
assert.equal(choices.length,1);
const source=entries.find(e=>e.path.endsWith("/ContentView.swift"));
source.edit=source.text+"\n// Original ZIP editor fixture\n";

const git=(args,input)=>execFileSync("git",["-c","user.name=Pocket fixture","-c","user.email=fixture@example.invalid",...args],{
  cwd:snapshot,input,encoding:"utf8"
}).trim();
git(["init","-q","-b","main"]);
const requestId = randomUUID();
const zip = new Uint8Array(await exportZipWorkspace(entries).arrayBuffer());
const zipPath = "original-xcode/sources/" + requestId + ".zip";
const manifest = {version:1, request_id:requestId, zip_path:zipPath,
  sha256:createHash("sha256").update(zip).digest("hex"), ...choices[0]};
const manifestPath = "original-xcode/requests/" + requestId + ".json";
for (const file of [zipPath, manifestPath]) {
  await mkdir(path.dirname(path.join(snapshot, file)), {recursive:true});
}
await writeFile(path.join(snapshot, zipPath), zip);
await writeFile(path.join(snapshot, manifestPath), JSON.stringify(manifest));
git(["add", "--", zipPath, manifestPath]);
git(["commit", "-qm", "Synthetic original Xcode regression project"]);
const inputs = {request_id:requestId, source_sha:git(["rev-parse", "HEAD"]), allow_project_code:"true"};
await writeFile(path.join(work, "inputs.json"), JSON.stringify(inputs));
