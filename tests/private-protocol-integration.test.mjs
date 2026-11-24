import assert from "node:assert/strict";
import {execFile as execFileCallback} from "node:child_process";
import {createHash, webcrypto} from "node:crypto";
import {promisify} from "node:util";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {GithubAPI, makeRequest, newProject} from "../web/core.mjs";
import {verifyBuildResult} from "../web/build-result.mjs";
import {fixture} from "./private-github-fixture.mjs";

globalThis.crypto ??= webcrypto;
const execFile = promisify(execFileCallback);
const python = fileURLToPath(new URL("./fixtures/private-protocol-builder.py", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

async function upload() {
  const gh = fixture();
  const api = new GithubAPI("synthetic-test-token", gh.repo, gh.fetcher);
  const project = newProject();
  project.files["Resources/pozdrav.txt"] = "Sestavení z iPhonu · příliš žluťoučký kůň\n";
  const request = makeRequest({repo:gh.repo, appName:"Test", bundleId:"cz.swide.fixture"}, project);
  await api.prepare(request, project);
  request.source_sha = await api.snapshot(request, project);
  request.stage = "dispatching";
  await api.dispatch(request);

  const dispatch = gh.calls.find(call => call.method === "POST" && call.path.endsWith("/dispatches"));
  assert.ok(dispatch);
  // Construct only GitHub's read-side envelopes. Payload bytes and dispatch inputs come from the client.
  const {state, metadata} = gh;
  const source = state.commits.get(request.source_sha);
  const tree = structuredClone(state.trees.get(source.tree.sha));
  const ref = "refs/heads/requests/" + request.request_id;
  const responses = {
    "":metadata,
    ["/git/ref/" + ref.slice(5)]:{ref,object:{type:"commit",sha:state.refs.get(ref)}},
    ["/git/commits/" + source.sha]:source,
    ["/git/trees/" + source.tree.sha + "?recursive=1"]:tree
  };
  for (const entry of tree.tree.filter(entry => entry.type === "blob")) {
    const bytes = Buffer.from(state.blobs.get(entry.sha));
    entry.size = bytes.length;
    responses["/git/blobs/" + entry.sha] = {sha:entry.sha,size:bytes.length,encoding:"base64",content:bytes.toString("base64")};
  }
  const {request_id, source_sha, manifest_sha256} = dispatch.body.inputs;
  const env = {
    REQUEST_ID:request_id, SOURCE_SHA:source_sha, MANIFEST_SHA256:manifest_sha256,
    CALLER_SHA:request.caller_sha, BUILDER_SHA:request.builder_sha,
    GITHUB_REPOSITORY:gh.repo, GITHUB_TOKEN:"inert-fixture",
    GITHUB_REPOSITORY_ID:String(metadata.id), GITHUB_REPOSITORY_OWNER_ID:String(metadata.owner.id),
    GITHUB_RUN_ID:String(request.run_id), GITHUB_RUN_ATTEMPT:String(request.run_attempt)
  };
  const run = {
    id:request.run_id, workflow_id:request.workflow_id, event:"workflow_dispatch",
    status:"completed", conclusion:"success", path:request.workflow_path, head_sha:request.caller_sha,
    display_title:`SwiDe ${request_id} ${source_sha} ${manifest_sha256}`,
    run_attempt:request.run_attempt, actor:{id:gh.user.id}, repository:metadata, head_repository:metadata,
    head_branch:dispatch.body.ref
  };
  return {request, wire:{env,responses}, run, tree};
}

async function worker(t, wire) {
  const dir = await mkdtemp(join(tmpdir(), "swide-private-test-"));
  t.after(() => rm(dir, {recursive:true,force:true}));
  const input = join(dir, "request.json");
  await writeFile(input, JSON.stringify(wire));
  // Python runs with an isolated import path. No GitHub credentials or network calls are used.
  await execFile("python3", ["-I", python, input], {cwd:dir, maxBuffer:16*1024*1024});
  return readFile(join(dir, "artifact.zip"));
}

test("client upload, worker validation and packaging, then client verification agree on exact bytes", async t => {
  const {request,wire,run,tree} = await upload();
  const zipBytes = await worker(t, wire);
  const artifact = {id:991, expired:false, name:`swide-ipa-${request.request_id}-${request.run_attempt}`,
    size_in_bytes:zipBytes.length, digest:"sha256:"+hash(zipBytes),
    workflow_run:{id:run.id, repository_id:request.repository_id, head_repository_id:request.repository_id,
      head_sha:request.caller_sha, head_branch:request.caller_branch}};
  const receipt = await verifyBuildResult({expected:request,run,artifact,zipBytes});
  assert.equal(hash(receipt.ipaBytes), receipt.receipt.ipa_sha256);
  assert.equal(receipt.receipt.input_sha256, request.input_sha256);
  assert.equal(receipt.receipt.manifest_sha256, wire.env.MANIFEST_SHA256);

  const altered = Buffer.from(zipBytes);
  altered[altered.length - 1] ^= 1;
  await assert.rejects(verifyBuildResult({expected:request,run,artifact,zipBytes:altered}), /SHA-256 ZIPu/);
  const other = {...request, input_sha256:hash("another project")};
  await assert.rejects(verifyBuildResult({expected:other,run,artifact,zipBytes}), /Účtenka/);

  const input = tree.tree.find(entry => entry.path === request.project_path);
  const blob = wire.responses["/git/blobs/" + input.sha];
  const changed = Buffer.from(blob.content, "base64");
  changed[0] ^= 1;
  blob.content = changed.toString("base64");
  await assert.rejects(worker(t, wire), /digest differs/);
});
