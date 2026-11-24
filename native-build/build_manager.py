#!/usr/bin/env python3
"""Resolve SwiDe builds without ever guessing which run owns an artifact.

Private v2 requests bind a local request record to a GitHub run, artifact and IPA.
Use --request with a saved v2 record and --artifact-zip for byte verification.
Historical v1 lookup by UUID and SHA remains available through --repo.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import sys
import stat
import zipfile
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any, Protocol

WORKFLOW = ".github/workflows/pocket-ios.yml"
STATE_SCHEMA = "xcode-pocket-build-state/v1"
MAX_RUN_PAGES = 5
UUID_PATTERN = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z")
SHA_PATTERN = re.compile(r"[0-9a-f]{40}\Z")
REPO_PATTERN = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")


class API(Protocol):
    def get(self, path: str) -> dict[str, Any]: ...


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never send the bearer token to a redirected host or renamed repo.
        return None


class GitHubAPI:
    def __init__(self, token: str | None = None):
        self.token = token

    def get(self, path: str) -> dict[str, Any]:
        if not path.startswith("/repos/"):
            raise ValueError("Only repository-scoped API endpoints are supported")
        req = urllib.request.Request(
            "https://api.github.com" + path,
            headers={
                "Accept": "application/vnd.github+json",
                "User-Agent": "swide-build-manager/0.6",
                "X-GitHub-Api-Version": "2022-11-28",
                **({"Authorization": "Bearer " + self.token} if self.token else {}),
            },
        )
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=15) as response:
            result = json.load(response)
        if not isinstance(result, dict):
            raise ValueError("Unexpected GitHub API response")
        return result


@dataclass(frozen=True)
class Identity:
    repo: str
    request_id: str
    source_sha: str

    def __post_init__(self) -> None:
        if not REPO_PATTERN.fullmatch(self.repo) or any(part in (".", "..") for part in self.repo.split("/")):
            raise ValueError("repo must be in owner/name format")
        if not UUID_PATTERN.fullmatch(self.request_id) or str(uuid.UUID(self.request_id)) != self.request_id:
            raise ValueError("request_id must be a canonical lowercase UUID")
        if not SHA_PATTERN.fullmatch(self.source_sha):
            raise ValueError("source_sha must be a full lowercase 40-character commit SHA")

    @property
    def prefix(self) -> str:
        return f"/repos/{self.repo}"

    @property
    def title(self) -> str:
        return f"Pocket iOS {self.request_id}"

    def artifact_name(self, kind: str) -> str:
        if kind == "identity":
            return f"pocket-ios-identity-{self.request_id}-{self.source_sha}"
        if kind in ("app", "logs"):
            # Retain names consumed by the current web editor; the SHA-bound
            # identity artifact in the SAME run is required before downloads.
            return f"pocket-ios-{kind}-{self.request_id}"
        raise ValueError("Unsupported artifact kind")


def state(identity: Identity, name: str, *, run: dict[str, Any] | None = None,
          artifacts: list[dict[str, Any]] | None = None, verified: bool = False,
          message: str = "", candidates: list[int] | None = None) -> dict[str, Any]:
    return {
        "schema": STATE_SCHEMA,
        "request_id": identity.request_id,
        "source_sha": identity.source_sha,
        "state": name,
        "run_id": run.get("id") if run else None,
        "run_url": run.get("html_url") if run else None,
        "source_verified": verified,
        "artifacts": artifacts or [],
        "message": message,
        "candidate_run_ids": candidates or [],
    }


def run_matches(identity: Identity, run: dict[str, Any]) -> bool:
    if run.get("display_title") != identity.title or run.get("event") != "workflow_dispatch":
        return False
    if str(run.get("path", "")).split("@")[0] != WORKFLOW:
        return False
    repository = run.get("repository") or {}
    head_repository = run.get("head_repository") or {}
    if repository.get("full_name") != identity.repo:
        return False
    if head_repository and head_repository.get("full_name") != identity.repo:
        return False
    return True


def find_run(api: API, identity: Identity, run_id: int | None) -> tuple[dict[str, Any] | None, list[int], str]:
    if run_id is not None:
        if isinstance(run_id, bool) or not isinstance(run_id, int) or run_id <= 0:
            raise ValueError("run_id must be a positive integer")
        run = api.get(f"{identity.prefix}/actions/runs/{run_id}")
        return (run if run_matches(identity, run) else None, [run_id],
                "" if run_matches(identity, run) else "Run identity does not match the requested project.")

    matches: list[dict[str, Any]] = []
    for page in range(1, MAX_RUN_PAGES + 1):
        path = (f"{identity.prefix}/actions/workflows/pocket-ios.yml/runs"
                f"?event=workflow_dispatch&per_page=100&page={page}")
        runs = api.get(path).get("workflow_runs", [])
        if not isinstance(runs, list):
            raise ValueError("Unexpected workflow runs payload")
        matches.extend(r for r in runs if isinstance(r, dict) and run_matches(identity, r))
        if len(runs) < 100 or len(matches) > 1:
            break
    matches.sort(key=lambda r: r.get("id", 0))
    if len(matches) > 1:
        return None, [r["id"] for r in matches], "Multiple runs share this request ID. Supply an exact run ID."
    if not matches:
        return None, [], "No matching run in the latest 500 workflow runs."
    return matches[0], [matches[0]["id"]], ""


def get_artifacts(api: API, identity: Identity, run: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {kind: [] for kind in ("app", "logs", "identity")}
    for page in range(1, 6):
        path = f"{identity.prefix}/actions/runs/{run['id']}/artifacts?per_page=100&page={page}"
        response = api.get(path)
        artifacts = response.get("artifacts", [])
        if not isinstance(artifacts, list):
            raise ValueError("Unexpected workflow artifacts payload")
        for artifact in artifacts:
            if not isinstance(artifact, dict) or artifact.get("expired") is True:
                continue
            parent = artifact.get("workflow_run") or {}
            if parent and parent.get("id") != run["id"]:
                continue
            for kind in grouped:
                if artifact.get("name") == identity.artifact_name(kind):
                    grouped[kind].append({
                        "kind": kind,
                        "name": artifact["name"],
                        "id": artifact["id"],
                        "size_in_bytes": artifact.get("size_in_bytes"),
                        "download_url": f"https://api.github.com{identity.prefix}/actions/artifacts/{artifact['id']}/zip",
                    })
        if len(artifacts) < 100:
            break
    return grouped


def resolve(api: API, identity: Identity, run_id: int | None = None) -> dict[str, Any]:
    run, candidates, warning = find_run(api, identity, run_id)
    if run is None:
        name = "identity_mismatch" if run_id is not None else ("ambiguous" if candidates else "not_found")
        return state(identity, name, message=warning, candidates=candidates)
    status = run.get("status")
    if status in ("queued", "pending", "requested", "waiting", "in_progress"):
        return state(identity, status, run=run, message="Waiting for build completion; source SHA not yet verified.")
    if status != "completed":
        return state(identity, "unknown", run=run, message="Unrecognized GitHub Actions run status.")

    artifacts = get_artifacts(api, identity, run)
    unique = all(len(items) <= 1 for items in artifacts.values())
    if not unique:
        return state(identity, "ambiguous", run=run, message="Duplicate artifact names; refusing to guess.")
    identity_artifact = artifacts["identity"]
    verified = bool(identity_artifact)
    log_artifacts = artifacts["logs"]
    if run.get("conclusion") != "success":
        return state(identity, "failed" if run.get("conclusion") == "failure" else "cancelled",
                     run=run, verified=verified, artifacts=log_artifacts + identity_artifact,
                     message=f"Workflow finished with {run.get('conclusion')}; no app can be installed.")
    if not identity_artifact or not artifacts["app"]:
        return state(identity, "artifact_missing", run=run,
                     message="Build succeeded, but matching SHA-bound identity/app artifacts are missing or expired.")
    return state(identity, "success", run=run, verified=True,
                 artifacts=artifacts["app"] + log_artifacts + identity_artifact,
                 message="Exact run and request verified; source SHA bound by the identity artifact.")


PRIVATE_WORKFLOW = ".github/workflows/swide-build.yml"
MAX_IPA = 64 * 1024 * 1024
MAX_RESULT = MAX_IPA + 1024 * 1024
IPA = "PocketApp-unsigned.ipa"
RECEIPT = "build-identity.json"
RECEIPT_KEYS = ("mode", "request_id", "project_path", "source_sha", "input_sha256", "manifest_sha256",
                "caller_sha", "builder_sha", "workflow_id", "workflow_path", "repository_id", "owner_id",
                "run_id", "run_attempt")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def valid_id(value: Any) -> bool:
    return type(value) is int and 0 < value <= 2 ** 53 - 1


def validate_request(req: dict) -> None:
    require(req.get("schema") == "swide-build-request/v2" and req.get("mode") == "generated",
            "Expected a private generated build request")
    identity = Identity(req["repo"], req["request_id"], req["source_sha"])
    require(req.get("project_path") == f"pocket-builds/{identity.request_id}.json" and
            req.get("workflow_path") == PRIVATE_WORKFLOW and
            isinstance(req.get("caller_branch"), str) and req["caller_branch"], "Invalid request path or branch")
    require(req.get("actor_id") == req.get("owner_id"), "Only owner-dispatched builds are supported")
    for key in ("caller_sha", "builder_sha"):
        require(bool(SHA_PATTERN.fullmatch(req.get(key, ""))), f"Invalid {key}")
    for key in ("manifest_sha256", "input_sha256"):
        require(bool(re.fullmatch(r"[a-f0-9]{64}", req.get(key, ""))), f"Invalid {key}")
    for key in ("workflow_id", "owner_id", "repository_id", "actor_id", "run_id", "run_attempt"):
        require(valid_id(req.get(key)), f"Missing or invalid {key}")


def verify_repository(repo: dict, req: dict) -> None:
    require(repo.get("private") is True and repo.get("id") == req["repository_id"] and
            (repo.get("owner") or {}).get("id") == req["owner_id"] and
            repo.get("full_name", "").lower() == req["repo"].lower(), "Private repository identity mismatch")


def verify_run(req: dict, run: dict) -> None:
    for key in ("repository", "head_repository"):
        verify_repository(run.get(key) or {}, req)
    title = f"SwiDe {req['request_id']} {req['source_sha']} {req['manifest_sha256']}"
    trigger = run.get("triggering_actor")
    require((req["run_attempt"] == 1 and trigger is None) or (trigger or {}).get("id") == req["actor_id"],
            "Unexpected triggering actor for this run attempt")
    require(run.get("id") == req["run_id"] and run.get("run_attempt") == req["run_attempt"] and
            run.get("event") == "workflow_dispatch" and run.get("workflow_id") == req["workflow_id"] and
            run.get("path", "").split("@")[0] == PRIVATE_WORKFLOW and run.get("head_sha") == req["caller_sha"] and
            run.get("head_branch") == req["caller_branch"] and (run.get("actor") or {}).get("id") == req["actor_id"] and
            run.get("display_title") == title, "Workflow run identity mismatch")


def select_result(req: dict, run: dict, candidates: list) -> dict:
    verify_run(req, run)
    require(run.get("status") == "completed" and run.get("conclusion") == "success", "Build did not succeed")
    name = f"swide-ipa-{req['request_id']}-{req['run_attempt']}"
    matches = [a for a in candidates if a.get("name") == name]
    require(len(matches) == 1, "Missing or ambiguous build artifact")
    art = matches[0]
    parent = art.get("workflow_run") or {}
    require(valid_id(art.get("id")) and art.get("expired") is False and
            bool(re.fullmatch(r"sha256:[0-9a-f]{64}", art.get("digest", ""))) and
            valid_id(art.get("size_in_bytes")) and art["size_in_bytes"] <= MAX_RESULT and
            parent.get("id") == req["run_id"] and parent.get("repository_id") == req["repository_id"] and
            parent.get("head_repository_id") == req["repository_id"] and parent.get("head_sha") == req["caller_sha"] and
            parent.get("head_branch") == req["caller_branch"] and
            req.get("artifact_id") in (None, art["id"]) and req.get("artifact_digest") in (None, art["digest"]),
            "Artifact metadata mismatch")
    return art


def check_private_zip(req: dict, artifact: dict, archive: Path) -> dict:
    require(archive.is_file() and archive.stat().st_size == artifact["size_in_bytes"], "Artifact size mismatch")
    with archive.open("rb") as source:
        data = source.read(MAX_RESULT + 1)
    require(len(data) == artifact["size_in_bytes"] and
            "sha256:" + hashlib.sha256(data).hexdigest() == artifact["digest"], "Artifact ZIP digest mismatch")
    with zipfile.ZipFile(io.BytesIO(data)) as result:
        members = result.infolist()
        require(len(members) == 2 and {m.orig_filename for m in members} == {IPA, RECEIPT},
                "Unexpected ZIP members")
        for member in members:
            file_type = stat.S_IFMT(member.external_attr >> 16)
            limit = MAX_IPA if member.filename == IPA else 16 * 1024
            require(file_type in (0, stat.S_IFREG) and not member.is_dir() and member.flag_bits & ~0x80e == 0 and
                    member.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED) and
                    0 < member.file_size <= limit, "Unsafe ZIP member")
        receipt = json.loads(result.read(RECEIPT).decode("utf-8"))
        require(isinstance(receipt, dict) and receipt.get("schema") == "swide-build-identity/v2" and
                receipt.get("signed") is False and all(type(receipt.get(k)) is type(req[k]) and receipt[k] == req[k]
                for k in RECEIPT_KEYS), "Build receipt mismatch")
        digest = hashlib.sha256()
        with result.open(IPA) as ipa:
            for block in iter(lambda: ipa.read(128 * 1024), b""):
                digest.update(block)
        require(digest.hexdigest() == receipt.get("ipa_sha256"), "Inner IPA digest mismatch")
        return receipt


def resolve_private(api: API, req: dict, archive: Path | None = None) -> dict:
    validate_request(req)
    prefix = f"/repos/{req['repo']}"
    verify_repository(api.get(prefix), req)
    run = api.get(f"{prefix}/actions/runs/{req['run_id']}")
    verify_run(req, run)
    output = {"request_id": req["request_id"], "run_id": run["id"], "run_attempt": run["run_attempt"],
              "source_verified": False}
    if run.get("status") != "completed":
        status = run.get("status")
        return dict(output, state=status if status in ("queued", "pending", "requested", "waiting", "in_progress") else "unknown")
    if run.get("conclusion") != "success":
        return dict(output, state="failed", conclusion=run.get("conclusion"))
    name = f"swide-ipa-{req['request_id']}-{req['run_attempt']}"
    response = api.get(f"{prefix}/actions/runs/{run['id']}/artifacts?name={name}&per_page=100")
    require(response.get("total_count") == 1, "Missing or ambiguous build artifact")
    artifact = select_result(req, run, response["artifacts"])
    output.update(artifact_id=artifact["id"], artifact_digest=artifact["digest"])
    if archive is None:
        return dict(output, state="awaiting_verification")
    receipt = check_private_zip(req, artifact, archive)
    return dict(output, state="success", source_verified=True, ipa_sha256=receipt["ipa_sha256"])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--repo", help="owner/repo for historical v1 lookups")
    group.add_argument("--request", type=Path, help="local v2 private request record")
    parser.add_argument("--artifact-zip", type=Path, help="downloaded GitHub result ZIP for --request")
    parser.add_argument("--request-id")
    parser.add_argument("--source-sha", help="full 40-character SHA")
    parser.add_argument("--run-id", type=int, help="strongest binding; use when known")
    args = parser.parse_args(argv)
    try:
        api = GitHubAPI(os.getenv("GH_TOKEN") or os.getenv("GITHUB_TOKEN"))
        if args.request:
            if any((args.run_id, args.request_id, args.source_sha)):
                parser.error("--request already supplies all run and identity fields")
            response = resolve_private(api, json.loads(args.request.read_text(encoding="utf-8")), args.artifact_zip)
        else:
            if args.artifact_zip or not args.request_id or not args.source_sha:
                parser.error("historical v1 lookup requires --repo, --request-id and --source-sha")
            identity = Identity(args.repo, args.request_id, args.source_sha)
            response = resolve(api, identity, args.run_id)
    except (ValueError, TypeError, KeyError, OSError, zipfile.BadZipFile, RuntimeError) as error:
        print(json.dumps({"state": "error", "message": str(error)}), file=sys.stderr)
        return 2
    print(json.dumps(response, indent=2, ensure_ascii=False))
    return 0 if response["state"] in ("success", "awaiting_verification", "queued", "in_progress", "requested", "pending", "waiting") else 1


if __name__ == "__main__":
    raise SystemExit(main())
