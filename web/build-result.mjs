import {readExactZipFiles} from "./zip-workspace.mjs";

const IPA = "PocketApp-unsigned.ipa";
const RECEIPT = "build-identity.json";
const MAX_IPA = 64 * 1024 * 1024;
export const MAX_RESULT_BYTES = MAX_IPA + 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const workflow = ".github/workflows/swide-build.yml";
const receiptKeys = ["mode","request_id","project_path","source_sha","input_sha256","manifest_sha256",
  "caller_sha","builder_sha","workflow_id","workflow_path","repository_id","owner_id","run_id","run_attempt"];

function check(ok,message) {
  if (!ok) throw new Error(message);
}
function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}
async function checksum(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256",bytes));
  return Array.from(digest,b => b.toString(16).padStart(2,"0")).join("");
}
function checkRun(req,run) {
  check(req?.schema === "swide-build-request/v2" && req.mode === "generated" &&
    UUID.test(req.request_id) && req.project_path === `pocket-builds/${req.request_id}.json` &&
    [req.source_sha,req.caller_sha,req.builder_sha].every(s=>SHA.test(s)) &&
    [req.input_sha256,req.manifest_sha256].every(s=>DIGEST.test(s)) &&
    [req.repository_id,req.owner_id,req.actor_id,req.workflow_id,req.run_id,req.run_attempt].every(positive) &&
    req.actor_id === req.owner_id && typeof req.repo === "string" && typeof req.caller_branch === "string" && req.caller_branch &&
    req.workflow_path === workflow,"Chybí úplná místní identita privátního sestavení.");
  const sameRepo = r=>r?.private === true && r.id === req.repository_id && r.owner?.id === req.owner_id &&
    typeof r.full_name === "string" && r.full_name.toLowerCase() === req.repo.toLowerCase();
  check(run?.id === req.run_id && run.run_attempt === req.run_attempt &&
    run.event === "workflow_dispatch" && run.workflow_id === req.workflow_id &&
    run.path?.split("@")[0] === workflow && run.head_sha === req.caller_sha &&
    run.head_branch === req.caller_branch && sameRepo(run.repository) && sameRepo(run.head_repository) &&
    run.actor?.id === req.actor_id &&
    ((req.run_attempt === 1 && run.triggering_actor == null) || run.triggering_actor?.id === req.actor_id) &&
    run.display_title === `SwiDe ${req.request_id} ${req.source_sha} ${req.manifest_sha256}`,
    "GitHub nepotvrdil identitu soukromého běhu.");
  check(run.status === "completed" && run.conclusion === "success","Sestavení neskončilo úspěšně.");
}

export function selectBuildArtifact(expected,run,artifacts) {
  checkRun(expected,run);
  const name = `swide-ipa-${expected.request_id}-${expected.run_attempt}`;
  const candidates = artifacts.filter(a=>a?.name === name);
  check(candidates.length === 1,"Výsledný artefakt chybí nebo není jednoznačný.");
  const artifact = candidates[0], parent = artifact.workflow_run;
  check(positive(artifact.id) && artifact.expired === false &&
    /^sha256:[0-9a-f]{64}$/.test(artifact.digest) && positive(artifact.size_in_bytes) &&
    artifact.size_in_bytes <= MAX_RESULT_BYTES &&
    parent?.id === run.id && parent.repository_id === expected.repository_id &&
    parent.head_repository_id === expected.repository_id && parent.head_sha === expected.caller_sha &&
    parent.head_branch === expected.caller_branch &&
    (expected.artifact_id == null || artifact.id === expected.artifact_id) &&
    (expected.artifact_digest == null || artifact.digest === expected.artifact_digest),
    "Identita, velikost nebo dostupnost artefaktu nesouhlasí.");
  return artifact;
}

export async function verifyBuildResult({expected,run,artifact,zipBytes}) {
  selectBuildArtifact(expected,run,[artifact]);
  const blob = zipBytes instanceof Blob;
  const size = blob ? zipBytes.size : zipBytes?.byteLength;
  check(size === artifact.size_in_bytes,"Velikost výsledného ZIPu neodpovídá GitHubu.");
  let bytes = zipBytes;
  if (blob) bytes = await zipBytes.arrayBuffer();
  if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
  check(bytes instanceof Uint8Array && `sha256:${await checksum(bytes)}` === artifact.digest,
    "SHA-256 ZIPu neodpovídá artefaktu GitHubu.");
  const files = await readExactZipFiles(bytes,MAX_RESULT_BYTES,{[RECEIPT]:16*1024,[IPA]:MAX_IPA});
  const receipt = JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(files.get(RECEIPT)));
  check(receipt?.schema === "swide-build-identity/v2" && receipt.signed === false &&
    receiptKeys.every(key=>receipt[key] === expected[key]),"Účtenka neodpovídá tomuto projektu a pokusu sestavení.");
  const ipaBytes = files.get(IPA);
  check(DIGEST.test(receipt.ipa_sha256) && await checksum(ipaBytes) === receipt.ipa_sha256,
    "SHA-256 IPA nesouhlasí s účtenkou sestavení.");
  return {ipaBytes,filename:IPA,receipt};
}
