import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createHash,webcrypto} from "node:crypto";
import test from "node:test";
import {selectBuildArtifact, verifyBuildResult} from "../web/build-result.mjs";
import {exportZipWorkspace} from "../web/zip-workspace.mjs";

globalThis.crypto ??= webcrypto;
const fixture = JSON.parse(await readFile(new URL("./fixtures/private-result.json",import.meta.url)));
const hash = data => createHash("sha256").update(data).digest("hex");
const text = "inert fixture for the IPA hash";
const receipt = {...fixture.receipt,ipa_sha256:hash(text)};
async function sample(entries = [["PocketApp-unsigned.ipa",text],["build-identity.json",JSON.stringify(receipt)]]) {
  const zipBytes = new Uint8Array(await (exportZipWorkspace(entries.map(([path,edit])=>({path,edit})))).arrayBuffer());
  const artifact = {...fixture.artifact,size_in_bytes:zipBytes.length,digest:"sha256:"+hash(zipBytes)};
  return {expected:structuredClone(fixture.request),run:structuredClone(fixture.run),artifact,zipBytes};
}

test("only a hash-verified IPA from the exact private attempt is released", async()=>{
  const item = await sample();
  const {ipaBytes,filename} = await verifyBuildResult({...item,zipBytes:new Blob([item.zipBytes])});
  assert.equal(new TextDecoder().decode(ipaBytes),text);
  assert.equal(filename,"PocketApp-unsigned.ipa");
});
test("reject other owner/repo/actor, concurrent attempt, stale pin or failed run",async()=>{
  for (const [object,key,value] of [
    ["repository","private",false],["repository","id",300],["head_repository","id",300],
    ["actor","id",17],["run","triggering_actor",{id:333}],["run","run_attempt",2],["run","head_sha","a".repeat(40)],
    ["run","head_branch","elsewhere"],["run","display_title","SwiDe"],["run","conclusion","failure"]
  ]) {
    const item = await sample();
    (object === "run" ? item.run : item.run[object])[key] = value;
    await assert.rejects(verifyBuildResult(item));
  }
});
test("reject expired, ambiguous, swapped or metadata-only artifacts",async()=>{
  const {expected,run,artifact} = await sample();
  assert.throws(()=>selectBuildArtifact(expected,run,[artifact,artifact]));
  for (const modified of [{expired:true},{digest:null},{name:"other"},
    {workflow_run:{...artifact.workflow_run,id:19}},{workflow_run:{...artifact.workflow_run,repository_id:111}}]) {
    assert.throws(()=>selectBuildArtifact(expected,run,[{...artifact,...modified}]));
  }
  assert.throws(()=>selectBuildArtifact({...expected,artifact_id:999},run,[artifact]));
});
test("reject modified outer bytes and a receipt with a mismatched IPA hash or source identity",async()=>{
  const item = await sample();
  item.zipBytes[0] ^= 1;
  await assert.rejects(verifyBuildResult(item),/SHA-256 ZIPu/);
  for (const field of ["ipa_sha256","workflow_id","run_attempt","input_sha256","manifest_sha256","source_sha","signed"]) {
    const bad = {...receipt,[field]:"wrong"};
    await assert.rejects(verifyBuildResult(await sample([
      ["PocketApp-unsigned.ipa",text],["build-identity.json",JSON.stringify(bad)]
    ])));
  }
});
test("validate strict root names, receipt size and member count before extraction",async()=>{
  const valid = ["build-identity.json",JSON.stringify(receipt)];
  for (const entries of [
    [["./PocketApp-unsigned.ipa",text],valid], [["../other.ipa",text],valid],
    [["PocketApp-unsigned.ipa",text],valid,["extra.txt","data"]],
    [["PocketApp-unsigned.ipa",text],valid,valid],
    [["PocketApp-unsigned.ipa",text],["build-identity.json"," ".repeat(16385)]]
  ]) await assert.rejects(verifyBuildResult(await sample(entries)));
});
