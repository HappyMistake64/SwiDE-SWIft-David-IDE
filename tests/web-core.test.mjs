import {test} from "node:test";
import assert from "node:assert/strict";
import {REPOSITORY,WORKFLOW,newProject,validateProject,validPath,makeRequest,
  validateSettings,assertIdentity,utf8Base64,matchesRun,pickRun,
  restoreState,GithubAPI} from "../web/core.mjs";

import {fixture} from "./private-github-fixture.mjs";
const UUID_A="a7612db1-a3fc-4e61-963c-cc11fedf4d20";
const UUID_B="b8612db1-a3fc-4e61-963c-cc11fedf4d20";
function setup() {
  const f = fixture();
  return {...f, api:new GithubAPI("test-secret",f.repo,f.fetcher)};
}
async function prepare(f, project=newProject(), id=UUID_A) {
  const r=makeRequest({repo:f.repo},project,id);
  await f.api.prepare(r, project);
  return r;
}
function run(r,id=71) {
  const repo={full_name:r.repo,id:r.repository_id,private:true,owner:{id:r.owner_id}};
  return {id,event:"workflow_dispatch",display_title:"SwiDe "+r.request_id+" "+r.source_sha+" "+r.manifest_sha256,
    path:WORKFLOW,workflow_id:r.workflow_id,head_sha:r.caller_sha,head_branch:r.caller_branch,actor:{id:r.actor_id},
    repository:repo,head_repository:repo,status:"completed",conclusion:"success",run_attempt:1};
}
test("default SwiftUI project is valid",()=>{
  const project=validateProject(newProject());
  assert.ok(project.files["PocketApp.swift"].includes("@main"));
  assert.ok(project.files["ContentView.swift"].includes("count"));
});
test("validates paths and prevents collisions",()=>{
  for (const bad of ["../secret","hello\\world","__proto__/x.swift","a//b.swift","x\n.swift"]) assert.equal(validPath(bad),false);
  const project=newProject();project.files["contentview.swift"]="let a=1";
  assert.throws(()=>validateProject(project),/soubor/i);
});
test("rejects unsafe resources and file folder conflicts",()=>{
  const project=newProject();project.files["Resources/pic.png"]="png";
  assert.throws(()=>validateProject(project),/Resource/);
  delete project.files["Resources/pic.png"];
  project.files["Foo"]="hello";project.files["Foo/Child.swift"]="let a=1";
  assert.throws(()=>validateProject(project),/Konflikt/);
});
test("supports Unicode text in Github API base64",()=>{
  assert.equal(atob(utf8Base64("Ahoj žluťoučký svět")).length>0,true);
  const decoded=new TextDecoder().decode(Uint8Array.from(atob(utf8Base64("Příliš")),(c)=>c.charCodeAt(0)));
  assert.equal(decoded,"Příliš");
});
test("requests, snapshots and dispatch share the immutable source, workflow and run identity",async()=>{
  const f=setup(), p=newProject(), r=await prepare(f,p);
  assert.equal(r.project_path,"pocket-builds/"+UUID_A+".json");
  r.source_sha=await f.api.snapshot(r,p);
  assert.equal(assertIdentity(r),r);
  assert.equal(f.state.refs.get("refs/heads/main"),r.caller_sha);
  assert.equal(f.state.refs.get("refs/heads/requests/"+UUID_A),r.source_sha);
  const tree=f.calls.find(c=>c.path==="/git/trees" && c.method==="POST").body;
  assert.deepEqual(tree.tree.map(e=>e.path),[r.project_path,"requests/"+UUID_A+".json"]);
  assert.deepEqual(JSON.parse(tree.tree[0].content),p);
  assert.deepEqual(f.state.commits.get(r.source_sha).parents,[]);
  r.stage="dispatching";
  await f.api.dispatch(r);
  assert.equal(r.run_id,71);
  const submit=f.calls.find(c=>c.path.endsWith("/dispatches"));
  assert.deepEqual(submit.body,{ref:"main",inputs:{request_id:UUID_A,source_sha:r.source_sha,manifest_sha256:r.manifest_sha256}});
  assert.equal(submit.options.headers["X-GitHub-Api-Version"],"2026-03-10");
  assert.ok(f.calls.every(c=>c.options.redirect==="error" && c.options.credentials==="omit"));
  assert.ok(!JSON.stringify(r).includes("test-secret"));
  await assert.rejects(f.api.dispatch(r));
});
test("recovery validates existing bytes and options and never overwrites a request ref",async()=>{
  const f=setup(), p=newProject(), r=await prepare(f,p);
  const sha=await f.api.snapshot(r,p);
  const refWrites=()=>f.calls.filter(c=>c.path==="/git/refs").length;
  assert.equal(refWrites(),1);
  assert.equal(await f.api.snapshot(r,p),sha);
  assert.equal(refWrites(),1);
  const changed={...p,files:{...p.files,"Other.swift":"let x=2"}};
  await assert.rejects(f.api.snapshot(r,changed));
  const colliding=await prepare(f,changed);
  await assert.rejects(f.api.snapshot(colliding,changed));
  const changedOptions=makeRequest({repo:f.repo,appName:"Other"},p,UUID_A);
  await f.api.prepare(changedOptions,p);
  await assert.rejects(f.api.snapshot(changedOptions,p));
  assert.equal(refWrites(),1);
  assert.equal(f.calls.filter(c=>c.path.endsWith("/dispatches")).length,0);
});
test("every ambiguous or different run stays unresolved after a lost dispatch response",async()=>{
  const f=setup(), p=newProject(), r=await prepare(f,p);
  r.source_sha=await f.api.snapshot(r,p);
  const other=await prepare(f,p,UUID_B);
  other.source_sha=await f.api.snapshot(other,p);
  const a=run(r), b=run(other,72);
  for (const changes of [{head_sha:"e".repeat(40)}, {workflow_id:100}, {actor:{id:88}},
    {display_title:a.display_title.replace(r.manifest_sha256,"4".repeat(64))},
    {event:"push"}, {repository:{...a.repository,private:false}}, {head_repository:{...a.repository,id:44}},
    {path:".github/workflows/other.yml"}, {head_branch:"other"}]) assert.equal(matchesRun({...a,...changes},r),false);
  f.state.runs=[a,b];
  assert.equal((await f.api.findRun(r)).run.id,71);
  assert.equal((await f.api.findRun(other)).run.id,72);
  f.state.runs.push({...a,id:73});
  assert.equal((await f.api.findRun(r)).state,"ambiguous");
  assert.equal((await f.api.findRun({...r,run_id:71})).run.id,71);
  assert.equal(pickRun([b],r,72).state,"mismatch");
  assert.equal(f.calls.filter(c=>c.path.endsWith("/dispatches")).length,0);
});
test("private preflight rejects public targets, swapped owners/IDs, altered templates and writes via the read API",async()=>{
  for (const mutate of [
    f=>{f.metadata.visibility="public"; f.metadata.private=false;}, f=>{f.metadata.visibility="internal";},
    f=>{f.metadata.id=1454608498;}, f=>{f.metadata.id=999;}, f=>{f.metadata.owner.type="Organization";},
    f=>{f.metadata.owner.id=999;}, f=>{f.metadata.full_name="another/name";}, f=>{f.metadata.permissions.push=false;},
    f=>{f.state.workflow.state="disabled_manually";}, f=>{f.state.workflow.path=".github/workflows/else.yml";},
    f=>{f.state.trees.get("b".repeat(40)).tree.push({path:"other",type:"blob",mode:"100644"});},
    f=>{f.state.trees.get("b".repeat(40)).tree.at(-1).sha="9".repeat(40);},
    f=>{f.state.trees.get("b".repeat(40)).truncated=true;}
  ]) {
    const f=setup(), p=newProject(), r=await prepare(f,p);
    mutate(f);
    await assert.rejects(f.api.snapshot(r,p));
    assert.ok(f.calls.every(c=>c.method==="GET"));
  }
  for (const repo of ["",REPOSITORY,"HappyMistake64/Xcode-for-iphone","alice/.."]) {
    assert.throws(()=>new GithubAPI("t",repo));
  }
  const f=setup();
  assert.throws(()=>f.api.request("PUT","/contents/new.json",{content:"hello"}));
  assert.equal(f.calls.length,0);
});
test("persisted binding detects target replacement after reconnection",async()=>{
  const f=setup();
  await f.api.verifyAccess();
  const saved=JSON.parse(JSON.stringify(f.api.binding));
  f.metadata.id++;
  await assert.rejects(new GithubAPI("s",f.repo,f.fetcher).verifyAccess(saved));
  assert.ok(f.calls.every(c=>c.method==="GET"));
});
test("forbidden test, preview, hidden and script inputs do not reach GitHub",async()=>{
  for (const path of ["Tests/Thing.swift","tools/run.sh","money$1.swift",".folder/main.swift"]) {
    const f=setup(), p=newProject();
    p.files[path]="let synthetic=0";
    await assert.rejects(prepare(f,p));
    assert.equal(f.calls.length,0);
  }
  const f=setup(), p=newProject(), r=makeRequest({repo:f.repo},p,UUID_A);
  r.capturePreview=true;
  await assert.rejects(f.api.prepare(r,p));
  assert.equal(f.calls.length,0);
});
test("HTTP errors and revoked tokens never dispatch elsewhere or expose server content",async()=>{
  const f=setup(), p=newProject(), r=await prepare(f,p);
  r.source_sha=await f.api.snapshot(r,p); r.stage="dispatching"; f.state.dispatchStatus=403;
  await assert.rejects(f.api.dispatch(r),/GitHub HTTP 403/);
  assert.equal(r.run_id,null);
  const denied=new GithubAPI("test-secret",f.repo,async()=>new Response("test-secret",{status:401}));
  await assert.rejects(denied.verifyAccess(),e=>e.message==="GitHub HTTP 401");
});
test("old public requests stay historical and local projects survive a settings error",()=>{
  const old="HappyMistake64/Xcode-for-iphone", project=newProject();
  const state={project,settings:{repo:old},builds:[{repo:old,request_id:UUID_A,stage:"committed",token:"never"}]};
  const restored=restoreState(JSON.stringify(state));
  assert.equal(restored.settings.repo,"");
  assert.equal(restored.builds[0].stage,"historical");
  assert.equal(restored.builds[0].token,undefined);
  assert.deepEqual(restoreState(JSON.stringify({...state,settings:{repo:"bad"}})).project,project);
  assert.deepEqual(restoreState("bad").builds,[]);
  assert.throws(()=>validateSettings({bundleId:"bad"}));
  assert.throws(()=>makeRequest({},project));
});
test("mobile login feedback is next to the token field",async()=>{
  const {readFile}=await import("node:fs/promises");
  const html=await readFile(new URL("../web/index.html",import.meta.url),"utf8");
  const app=await readFile(new URL("../web/app.mjs",import.meta.url),"utf8");
  assert.match(html,/id="connection-status"/);
  assert.ok(html.indexOf('id="connection-status"')>html.indexOf('id="connect-token"'));
  assert.ok(html.indexOf('id="connection-status"')<html.indexOf('class="panel workspace"'));
  assert.match(app,/connectionNote\("❌ "/);
  assert.match(app,/byId\("connect-token"\)\.addEventListener\("keydown"/);
});

test("default fetch retains the browser global as its receiver", async t => {
  const f=fixture();
  const fetchMock=t.mock.method(globalThis,"fetch",async function(url,options){
    assert.equal(this,globalThis);
    return f.fetcher(url,options);
  });
  assert.equal((await new GithubAPI("test",f.repo).check()).full_name,f.repo);
  assert.equal(fetchMock.mock.callCount(),1);
});

function resourceProject() {
  const root = "Resources/Assets.xcassets";
  const folder = root + "/Mark.imageset";
  const info = {version: 1, author: "xcode"};
  const project = {...newProject(), version: 3, dirs: ["Drafts", folder]};
  project.files[root + "/Contents.json"] = JSON.stringify({info});
  project.files[folder + "/Contents.json"] = JSON.stringify({images: [
    {idiom: "universal", filename: "mark.png", scale: "1x"}
  ], info});
  const png = {mime: "image/png", base64: btoa("\x89PNG\r\n\x1a\n" + "\x00".repeat(4) + "IHDR" + "\x00".repeat(8))};
  project.binaries = {[folder + "/mark.png"]: png};
  return project;
}

test("v3 resources, directories and edited Swift survive local restore and build snapshot", async () => {
  const project = resourceProject();
  const {project: restored} = restoreState(JSON.stringify({project}));
  assert.deepEqual(restored, project);
  restored.files["ContentView.swift"] += "\n// updated";
  const f=setup(), r=await prepare(f,restored);
  r.source_sha=await f.api.snapshot(r,restored);
  const tree=f.calls.find(c=>c.path==="/git/trees" && c.method==="POST").body.tree;
  assert.deepEqual(JSON.parse(tree[0].content),restored);
});

test("rejects malformed assets and conflicting paths before dispatch", () => {
  const folder = "Resources/Assets.xcassets/Mark.imageset/";
  const metadata = folder + "Contents.json", image = folder + "mark.png";
  for (const mutate of [
    p => { p.version = 2; },
    p => { p.binaries[image].base64 = "QUJD"; },
    p => { p.binaries[image].base64 += " "; },
    p => { p.binaries[image].mime = "image/jpeg"; },
    p => { p.binaries[image].extra = true; },
    p => { p.files[image] = "text"; },
    p => { p.dirs.push("resources/Other"); },
    p => { p.dirs.push(image + "/Nested"); },
    p => { p.files["Sub/ContentView.swift"] = ""; },
    p => { p.files[metadata] = p.files[metadata].replace("mark.png", "absent.png"); },
    p => { p.files[metadata] = p.files[metadata].replace('"info":', '"info":{}, "info":'); },
    p => { p.binaries[folder + "extra.png"] = p.binaries[image]; },
    p => { p.files["Resources/data.txt"] = "a\x00b"; },
    p => { p.dirs = Array(401).fill("Drafts"); },
    p => { for (let i=0; i<200; i++) p.files["Notes/" + i] = ""; }
  ]) {
    const project = resourceProject();
    mutate(project);
    assert.throws(() => validateProject(project));
  }
});

test("plain v1/v2 text and v3 non-catalog images remain supported", () => {
  for (const version of [1,2]) {
    const p = {...newProject(), version, dirs:["Resources"]};
    p.files["Resources/ceny.csv"] = "číslo,cena";
    assert.equal(validateProject(p),p);
  }
  const project = {...newProject(), version:3, binaries:{}};
  for (const [name, mime, bytes] of [
    ["camera.jpg","image/jpeg","\xff\xd8\xff\xd9"],
    ["icon.gif","image/gif","GIF89a" + "\0".repeat(7)],
    ["thumb.webp","image/webp","RIFF0000WEBP0000"]
  ]) project.binaries["Resources/" + name] = {mime, base64:btoa(bytes)};
  assert.equal(validateProject(project),project);
});

test("restoring many completed builds keeps every pending request and the selected attempt metadata",()=>{
  const historic=Array.from({length:35},()=>({request_id:UUID_B,stage:"historical"}));
  const pending={request_id:UUID_A,repo:"alice/private-app",schema:"swide-build-request/v2",stage:"attempt_changed",
    nextAttempt:2,run_attempt:1,artifact_id:42,artifact_digest:"sha256:"+"a".repeat(64)};
  const {builds}=restoreState(JSON.stringify({project:newProject(),builds:[...historic,pending]}));
  assert.equal(builds.length,31);
  assert.deepEqual(builds.at(-1),pending);
});
