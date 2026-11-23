// Offline fixture: exercise the real editor ZIP/manifest code using an isolated local Git repository.
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {newProject} from "../web/core.mjs";
import {openZipWorkspace,exportZipWorkspace} from "../web/zip-workspace.mjs";
import {originalSchemes,submitOriginal} from "../web/original-run.mjs";

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
git(["commit","--allow-empty","-qm","Fixture base"]);
const base=git(["rev-parse","HEAD"]);
let payload,dispatch;
const api={repo:"fixture/local",async request(method,route,body){
  if(method==="GET" && route==="/actions/workflows/pocket-original-xcode.yml") return {};
  if(method==="GET" && route==="/git/ref/heads/main") return {object:{sha:base}};
  if(method==="GET" && route==="/git/commits/"+base) return {tree:{sha:git(["rev-parse","HEAD^{tree}"])}};
  if(method==="POST" && route==="/git/blobs"){
    payload=Buffer.from(body.content,"base64");
    return {sha:git(["hash-object","-w","--stdin"],payload)};
  }
  if(method==="POST" && route==="/git/trees"){
    for(const file of body.tree){
      assert.match(file.path,/^original-xcode\/(?:sources\/[a-f\d-]+\.zip|requests\/[a-f\d-]+\.json)$/);
      const destination=path.join(snapshot,file.path);
      await mkdir(path.dirname(destination),{recursive:true});
      await writeFile(destination,file.content ?? payload);
      git(["add","--",file.path]);
    }
    return {sha:git(["write-tree"])};
  }
  if(method==="POST" && route==="/git/commits") return {sha:git(["commit-tree",body.tree,"-p",base,"-m",body.message])};
  if(method==="PATCH" && route==="/git/refs/heads/main"){
    assert.equal(body.force,false);
    git(["update-ref","refs/heads/main",body.sha,base]);
    return {object:{sha:git(["rev-parse","HEAD"])}};
  }
  if(method==="POST" && route==="/actions/workflows/pocket-original-xcode.yml/dispatches"){
    dispatch=body.inputs;return {};
  }
  throw Error("Unexpected fixture request: "+method+" "+route);
}};
const {id,commit}=await submitOriginal({api,archive:exportZipWorkspace(entries),choice:choices[0],mode:"device",approved:true});
assert.deepEqual(dispatch,{request_id:id,source_sha:commit,allow_project_code:"true"});
assert.equal(git(["status","--porcelain"]),"");
await writeFile(path.join(work,"inputs.json"),JSON.stringify(dispatch));
console.log("Prepared fixture commit "+commit+" and approved request "+id);
