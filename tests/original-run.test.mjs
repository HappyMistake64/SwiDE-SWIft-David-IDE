import assert from "node:assert/strict";
import test from "node:test";
import {checkOriginalBuild,findOriginalResult,originalSchemes,submitOriginal} from "../web/original-run.mjs";
const project="Demo/Foo.xcodeproj", schemePath=project+"/xcshareddata/xcschemes/Foo.xcscheme";
const entry=(path,text)=>({path,text,size:10,packed:Uint8Array.of(1),dir:false});
const entries=[entry(project+"/project.pbxproj",""),entry(schemePath,"<Scheme/>"),entry(project+"/xcuserdata/a.xcuserdatad/Foo.xcscheme","")];
const [choice]=originalSchemes(entries);
const head="1".repeat(40), tree="2".repeat(40), commit="5".repeat(40);
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
test("legacy original build entry points refuse both modes before reading the archive or using a token",async()=>{
  const requests = [], archiveReads = [];
  const archive = {size:7, async arrayBuffer() { archiveReads.push(true); return new ArrayBuffer(7); }};
  for (const repo of ["HappyMistake64/SwiDE-SWIft-David-IDE", "example/private"]) {
    const api = {repo, async request(...args) { requests.push(args); }};
    for (const mode of ["device", "simulator"]) {
      await assert.rejects(submitOriginal({api, archive, choice, mode, approved:true}), /Soukromé sestavení/);
    }
  }
  assert.deepEqual(requests, []);
  assert.deepEqual(archiveReads, []);
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
