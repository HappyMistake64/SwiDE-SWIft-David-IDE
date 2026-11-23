import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";
import {checkOriginalBuild,findOriginalResult,originalSchemes,submitOriginal} from "../web/original-run.mjs";
const project="Demo/Foo.xcodeproj", schemePath=project+"/xcshareddata/xcschemes/Foo.xcscheme";
const entry=(path,text)=>({path,text,size:10,packed:Uint8Array.of(1),dir:false});
const entries=[entry(project+"/project.pbxproj",""),entry(schemePath,"<Scheme/>"),entry(project+"/xcuserdata/a.xcuserdatad/Foo.xcscheme","")];
const [choice]=originalSchemes(entries);
const head="1".repeat(40),tree="2".repeat(40),blob="3".repeat(40),newTree="4".repeat(40),commit="5".repeat(40);
function mockAPI(conflict=false) {
  const calls=[];const api={repo:"owner/repo",calls,async request(method,path,body) {
    calls.push({method,path,body});
    if (path.includes("actions/workflows")) return {};
    if (method==="PATCH") { if(conflict) throw Error("non fast-forward");return {object:{sha:commit}}; }
    if (path==="/git/ref/heads/main") return {object:{sha:head}};
    if (method==="GET") return {tree:{sha:tree}};
    return {sha:({"/git/blobs":blob,"/git/trees":newTree,"/git/commits":commit})[path]};
  }};
  return api;
}
const pack=new Blob(["fixture"]);
test("enumerates only shared schemes under an existing .xcodeproj",()=>{
  assert.deepEqual(originalSchemes(entries),[{scheme:"Foo",project_path:project,scheme_path:schemePath}]);
  assert.deepEqual(originalSchemes(entries.slice(1)),[]);
  assert.throws(()=>checkOriginalBuild([...entries,entry("Demo/Bad /X.swift","")],choice),/NFC/);
  assert.throws(()=>checkOriginalBuild([...entries,entry("demo/Other.swift","")],choice),/písmen/);
  const deflated=entry("Demo/Large.swift","");deflated.size=1001;
  assert.throws(()=>checkOriginalBuild([...entries,deflated],choice),/kompresní/);
  const dtd=entries.map(e=>e.path===schemePath?{...e,edit:"<!DOCTYPE x><Scheme/>"}:e);
  assert.throws(()=>checkOriginalBuild(dtd,choice),/DTD/);
});
test("no network calls without consent or above the 20 MiB limit",async()=>{
  const api=mockAPI();
  await assert.rejects(submitOriginal({api,archive:pack,choice,mode:"device",approved:false}),/souhlas/);
  await assert.rejects(submitOriginal({api,archive:{size:20971521},choice,mode:"device",approved:true}),/20 MiB/);
  assert.equal(api.calls.length,0);
});
test("commits ZIP and SHA-256 manifest atomically, dispatches exact SHA; no dispatch after conflict",async()=>{
  for (const mode of ["device","simulator"]) {
    const api=mockAPI();let saved;
    const record=await submitOriginal({api,archive:pack,mode,choice,approved:true,onRecord:r=>saved=r});
    assert.deepEqual(record,saved);
    const msg=api.calls.find(c=>c.path==="/git/trees").body;
    assert.equal(msg.base_tree,tree);
    const manifest=JSON.parse(msg.tree[1].content);
    assert.equal(manifest.sha256,createHash("sha256").update("fixture").digest("hex"));
    assert.equal(manifest.scheme_path,schemePath);assert.equal(manifest.request_id,record.id);
    assert.equal(msg.tree[0].path,manifest.zip_path);
    assert.equal(msg.tree[1].path,"original-xcode/requests/"+record.id+".json");
    assert.equal(Buffer.from(api.calls.find(c=>c.path==="/git/blobs").body.content,"base64").toString(),"fixture");
    assert.deepEqual(api.calls.at(-2).body,{sha:commit,force:false});
    assert.equal(api.calls.at(-1).path,"/actions/workflows/pocket-original-"+(mode==="device"?"xcode":"simulator")+".yml/dispatches");
    assert.deepEqual(api.calls.at(-1).body.inputs,{source_sha:commit,request_id:record.id,allow_project_code:"true"});
  }
  const api=mockAPI(true);
  await assert.rejects(submitOriginal({api,archive:pack,mode:"simulator",choice,approved:true}),/non fast-forward/);
  assert(!api.calls.some(c=>c.path.endsWith("dispatches")));
});
test("selects only the exact run and artifact",async()=>{
  const id="aaaaaaaa-1111-2222-3333-444444444444", repo="owner/repo";
  const run={id:123,event:"workflow_dispatch",head_branch:"main",head_sha:commit,display_title:"Original Xcode "+id,repository:{full_name:repo},conclusion:"success"};
  const api={repo,request:async()=>({workflow_runs:[run,{...run,head_sha:tree}]}),
    artifacts:async()=>[{id:11,name:"wrong"},{id:12,name:"original-xcode-"+id,expired:true},{id:13,name:"original-xcode-"+id}]};
  const record={id,repo,commit,mode:"device"};
  const result=await findOriginalResult(api,record);
  assert.equal(result.artifactURL,"https://github.com/owner/repo/actions/runs/123/artifacts/13");
  assert.equal(await findOriginalResult(api,{...record,mode:"simulator"}),null);
});

test("source SHA in the trusted workflow title survives a newer dispatch head",async()=>{
  const id="aaaaaaaa-1111-2222-3333-444444444444", repo="owner/repo";
  const record={id,repo,commit,mode:"simulator"};
  const run={id:456,event:"workflow_dispatch",head_branch:"main",head_sha:head,
    display_title:"Original Simulator "+id+" @ "+commit,repository:{full_name:repo},status:"queued"};
  const api={repo,request:async(method,path)=>{
    assert(!path.includes("head_sha="));
    return {workflow_runs:[run,{...run,id:999,display_title:"Original Simulator "+id+" @ "+head}]};
  }};
  assert.equal((await findOriginalResult(api,record)).url,"https://github.com/owner/repo/actions/runs/456");
  api.request=async()=>({workflow_runs:[{...run,display_title:"Original Simulator "+id}]});
  assert.equal(await findOriginalResult(api,record),null);
});
