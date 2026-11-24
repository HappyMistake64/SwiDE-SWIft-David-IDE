import assert from "node:assert/strict";
import test from "node:test";
import {sendPreparedBuild} from "../web/build-session.mjs";
import {downloadArtifactArchive} from "../web/result-download.mjs";

function harness() {
  const req = {request_id:"request", stage:"prepared"};
  const stages = [], frozen = {files:{"A.swift":"let frozen = true"}};
  let claimed = false;
  const drafts = {read: async () => frozen, remove: async () => {},
    claim: async () => { if (claimed) throw Error("claimed"); claimed = true; }};
  const client = {
    async snapshot(r, project) { assert.equal(project, frozen); return "a".repeat(40); },
    async dispatch(r) { assert.equal(stages.at(-1), "dispatching"); r.run_id = 99; }
  };
  return {req, stages, client, drafts, save() { stages.push(req.stage); }};
}

test("freeze upload before dispatch and restore a verified run id", async () => {
  const h = harness();
  await sendPreparedBuild(h);
  assert.equal(h.req.run_id,99);
  assert.deepEqual(h.stages, ["committed","dispatching","dispatched"]);
});

test("never resubmit an uncertain dispatch even from an older tab", async () => {
  const h = harness();
  let count = 0;
  h.client.dispatch = async () => { count++; throw Error("connection lost"); };
  await assert.rejects(() => sendPreparedBuild(h), /lost/);
  assert.equal(h.req.stage, "submission_uncertain");
  await assert.rejects(() => sendPreparedBuild(h), /již mohl/);
  h.req.stage = "committed";
  await assert.rejects(() => sendPreparedBuild(h), /claimed/);
  assert.equal(count,1);
});

test("a missing recovery snapshot cannot upload the current edit or dispatch", async () => {
  const h = harness();
  h.drafts.read = async () => null;
  await assert.rejects(() => sendPreparedBuild(h), /snímek chybí/);
  assert.deepEqual(h.stages, []);
});

test("artifact download uses a fixed private endpoint and a streamed size bound", async () => {
  let sent;
  const args = {repo:"user/private", token:"synthetic", artifact:{id:8,size_in_bytes:3},
    fetcher:async (url, init) => {sent = {url,init}; return new Response(new Uint8Array([1,2,3]));}};
  assert.deepEqual(Array.from(await downloadArtifactArchive(args)),[1,2,3]);
  assert.equal(sent.url,"https://api.github.com/repos/user/private/actions/artifacts/8/zip");
  assert.equal(sent.init.credentials,"omit");
  assert.equal(sent.init.cache,"no-store");
  assert.equal(sent.init.referrerPolicy,"no-referrer");
  for (const size of [1,4]) {
    await assert.rejects(() => downloadArtifactArchive({...args,artifact:{id:8,size_in_bytes:size}}));
  }
  await assert.rejects(() => downloadArtifactArchive({...args,repo:"user/.."}));
  await assert.rejects(() => downloadArtifactArchive({...args,artifact:{id:8,size_in_bytes:1e10}}));
});
