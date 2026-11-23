import test from "node:test";
import assert from "node:assert/strict";
import {webcrypto,createHash} from "node:crypto";
import {validateDebugReport,debugSourcePath,debugSourceOffset} from "../web/debug-report.mjs";
if (!globalThis.crypto) Object.defineProperty(globalThis,"crypto",{value:webcrypto});

const build={repo:"acme/tool",run_id:99,run_attempt:2,request_id:"abc",source_sha:"a".repeat(40),debugAt:"Main.swift:2"};
const source="abc\nlet x = 1";
const path="Module/Main.swift", frame={file:"Main.swift",line:2,function:"main"};
const base={schema:"xcode-pocket-debug/v1",repository:build.repo,
  identity:{schema:"xcode-pocket-build-identity/v1",request_id:"abc",source_sha:build.source_sha,workflow_attempt:2,
    workflow_run_id:99,workflow:".github/workflows/pocket-ios.yml",project_path:"pocket-builds/abc.json"},
  status:"hit",breakpoint:{file:"Main.swift",line:2},frames:[frame],locals:[{name:"x",type:"Int",value:"1"}],
  message:"Breakpoint reached.",source_hashes:{[path]:createHash("sha256").update(source).digest("hex")}};
test("bind report to repository, SHA, run, attempt and requested breakpoint",()=>{
  assert.equal(validateDebugReport(base,build),base);
  for(const changes of [{repo:"attacker/repo"},{source_sha:"b".repeat(40)},{run_id:8},{run_attempt:1},{debugAt:"Main.swift:1"}])
    assert.throws(()=>validateDebugReport(base,{...build,...changes}));
  assert.throws(()=>validateDebugReport({...base,status:"starting"},build));
});
test("only open unique frames with exact source content",async()=>{
  assert.equal(debugSourcePath(base,frame),path);
  assert.equal(await debugSourceOffset(base,frame,path,source),4);
  await assert.rejects(debugSourceOffset(base,frame,path,"changed"));
  assert.equal(debugSourcePath({...base,source_hashes:{...base.source_hashes,"Other/Main.swift":"0".repeat(64)}},frame),null);
  assert.equal(debugSourcePath({...base,source_hashes:undefined},frame),null);
});
