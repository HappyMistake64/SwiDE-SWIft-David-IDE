"""Trusted private build steps. Only the GitHub API supplies source data."""
import base64
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import sys
from urllib.request import HTTPRedirectHandler, Request, build_opener
from zipfile import ZIP_DEFLATED, ZipFile

# -I keeps the current directory, project and PYTHONPATH off sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from generate_project import MAX_BYTES, generate, read_input

WORKFLOW = ".github/workflows/swide-build.yml"
IPA = "PocketApp-unsigned.ipa"
UUID = r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
SHA = r"[0-9a-f]{40}"
DIGEST = r"[0-9a-f]{64}"
MANIFEST_LIMIT = 8192


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def strict_json(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "Duplicate JSON key.")
            result[key] = value
        return result
    return json.loads(data.decode("utf-8"), object_pairs_hook=unique)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class GitData:
    def __init__(self, repo, token):
        require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo), "Invalid GitHub target.")
        self.url = "https://api.github.com/repos/" + repo
        self.opener = build_opener(NoRedirect())
        self.headers = {"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
                        "X-GitHub-Api-Version": "2026-03-10", "User-Agent": "SwiDe-private-build"}

    def get(self, path, limit=100_000):
        request = Request(self.url + path, headers=self.headers)
        with self.opener.open(request, timeout=30) as response:
            body = response.read(limit + 1)
        require(len(body) <= limit, "GitHub response exceeds the allowed size.")
        return strict_json(body)


def load_source(api, env):
    repo = api.get("")
    require(repo["visibility"] == "private" and repo["private"] is True
            and repo["full_name"] == env["GITHUB_REPOSITORY"]
            and str(repo["id"]) == env["GITHUB_REPOSITORY_ID"]
            and str(repo["owner"]["id"]) == env["GITHUB_REPOSITORY_OWNER_ID"]
            and repo["owner"]["type"] == "User", "Private repository identity differs.")
    request_id, sha, manifest_digest = (env[k] for k in ("REQUEST_ID", "SOURCE_SHA", "MANIFEST_SHA256"))
    require(re.fullmatch(UUID, request_id) and re.fullmatch(SHA, sha) and re.fullmatch(DIGEST, manifest_digest),
            "Invalid request identity.")
    ref = api.get("/git/ref/heads/requests/" + request_id)
    require(ref["ref"] == "refs/heads/requests/" + request_id and ref["object"]["type"] == "commit"
            and ref["object"]["sha"] == sha, "Private request branch and source commit differ.")
    commit = api.get("/git/commits/" + sha)
    tree_sha = commit["tree"]["sha"]
    require(commit["sha"] == sha and re.fullmatch(SHA, tree_sha), "Invalid source commit.")
    tree = api.get("/git/trees/" + tree_sha + "?recursive=1")
    require(tree["sha"] == tree_sha and tree["truncated"] is False, "Incomplete snapshot tree.")
    project_path, manifest_path = (f"{d}/{request_id}.json" for d in ("pocket-builds", "requests"))
    expected = {"pocket-builds": "040000", "requests": "040000", project_path: "100644", manifest_path: "100644"}
    entries = {e["path"]: e for e in tree["tree"]}
    require(len(entries) == len(tree["tree"]) and set(entries) == set(expected), "Unexpected snapshot paths.")
    for path, mode in expected.items():
        item = entries[path]
        require(item["mode"] == mode and item["type"] == ("tree" if mode == "040000" else "blob")
                and re.fullmatch(SHA, item["sha"]), "Invalid snapshot entry type.")

    def blob(path, limit):
        item = entries[path]
        size = item["size"]
        require(type(size) is int and 0 < size <= limit, "Snapshot blob exceeds size limit.")
        value = api.get("/git/blobs/" + item["sha"], size * 2 + 4096)
        require(value["sha"] == item["sha"] and value["encoding"] == "base64" and value["size"] == size,
                "Snapshot blob metadata differs.")
        data = base64.b64decode(value["content"].replace("\n", ""), validate=True)
        require(len(data) == size, "Snapshot blob size differs.")
        return data

    manifest_raw = blob(manifest_path, MANIFEST_LIMIT)
    require(digest(manifest_raw) == manifest_digest, "Request manifest digest differs.")
    manifest = strict_json(manifest_raw)
    expected_manifest = {"schema": "swide-request/v2", "mode": "generated", "repository_id": repo["id"],
                         "owner_id": repo["owner"]["id"], "request_id": request_id, "project_path": project_path,
                         "caller_sha": env["CALLER_SHA"], "builder_sha": env["BUILDER_SHA"], "workflow_path": WORKFLOW}
    require(isinstance(manifest, dict) and set(manifest) == set(expected_manifest) | {
        "input_sha256", "app_name", "bundle_id", "workflow_id"}, "Unsupported request manifest fields.")
    require(all(type(manifest[k]) is type(v) and manifest[k] == v for k, v in expected_manifest.items())
            and type(manifest["workflow_id"]) is int and 0 < manifest["workflow_id"] < 2**53,
            "Request does not belong to this builder, caller, or repository.")
    require(isinstance(manifest["app_name"], str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9 ._-]{0,59}", manifest["app_name"])
            and isinstance(manifest["bundle_id"], str)
            and re.fullmatch(r"[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*){2,}", manifest["bundle_id"]),
            "Invalid application settings.")
    source = blob(project_path, MAX_BYTES)
    require(digest(source) == manifest["input_sha256"], "Snapshot digest differs.")
    return manifest, source


def build_input(source, manifest):
    strict_json(source)
    path = Path("snapshot.json")
    path.write_bytes(source)
    parsed, _ = read_input(path)
    for name in list(parsed["files"]) + list(parsed.get("binaries", {})) + parsed.get("dirs", []):
        parts = name.split("/")
        require(all(not p.startswith(".") and "$" not in p for p in parts)
                and parts[0].casefold() != "tests", "Hidden paths, substitutions and test targets are unsupported.")
    for name in parsed["files"]:
        require(name.startswith("Resources/") or name.endswith(".swift"),
                "The generated private profile only supports Swift source and declared resources.")
    generate(path, Path("generated"), manifest["bundle_id"], manifest["app_name"], "17.0")


def make_receipt(manifest, env):
    keys = ("repository_id", "owner_id", "request_id", "mode", "project_path", "input_sha256",
            "caller_sha", "builder_sha", "workflow_id", "workflow_path")
    return {**{key: manifest[key] for key in keys}, "schema": "swide-build-identity/v2", "signed": False,
            "manifest_sha256": env["MANIFEST_SHA256"], "source_sha": env["SOURCE_SHA"],
            "run_id": int(env["GITHUB_RUN_ID"]), "run_attempt": int(env["GITHUB_RUN_ATTEMPT"])}


def prepare():
    env = os.environ
    api = GitData(env["GITHUB_REPOSITORY"], env["GITHUB_TOKEN"])
    manifest, source = load_source(api, env)
    build_input(source, manifest)
    Path("identity.json").write_text(json.dumps(make_receipt(manifest, env)), encoding="utf-8")


def package():
    app = Path("built/Build/Products/Release-iphoneos/PocketApp.app")
    require(app.is_dir() and not app.is_symlink(), "Missing built app.")
    paths = sorted(app.rglob("*"))
    require(all(not p.is_symlink() and (p.is_file() or p.is_dir()) for p in paths), "Unsafe built app entry.")
    info = plistlib.loads((app / "Info.plist").read_bytes())
    require(info.get("CFBundleExecutable") == "PocketApp" and (app / "PocketApp").is_file()
            and not (app / "_CodeSignature").exists() and not (app / "embedded.mobileprovision").exists(),
            "Incomplete or unexpectedly signed app.")
    output = Path("result")
    output.mkdir()
    ipa = output / IPA
    with ZipFile(ipa, "x", compression=ZIP_DEFLATED) as archive:
        for p in paths:
            if p.is_file():
                archive.write(p, "Payload/PocketApp.app/" + p.relative_to(app).as_posix())
    require(ipa.stat().st_size <= 64 * 1024 * 1024, "IPA exceeds the 64 MiB private build limit.")
    receipt = json.loads(Path("identity.json").read_text(encoding="utf-8"))
    receipt["ipa_sha256"] = digest(ipa.read_bytes())
    (output / "build-identity.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    try:
        {"prepare": prepare, "package": package}[sys.argv[1]]()
    except (KeyError, ValueError, TypeError, OSError, RuntimeError):
        # Errors involving project data can contain filenames, compiler source snippets or Actions commands.
        sys.exit("Private build validation or packaging failed. Check your target, request and generated project profile.")
