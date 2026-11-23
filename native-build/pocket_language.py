"""Execute one SourceKit-LSP request against the app Swift sources in a Pocket snapshot."""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
from urllib.parse import unquote, urlparse

from generate_project import read_input


def frame(message):
    body = json.dumps({"jsonrpc": "2.0", **message}, separators=(",", ":")).encode()
    return b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body


class LSP:
    def __init__(self, server, workspace):
        self.process = subprocess.Popen([server], cwd=workspace, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.request_id = 0

    def write(self, message):
        self.process.stdin.write(frame(message))
        self.process.stdin.flush()

    def read(self):
        size = None
        while True:
            line = self.process.stdout.readline(16384)
            if not line:
                raise RuntimeError("SourceKit-LSP closed its output")
            if line in (b"\r\n", b"\n"):
                break
            if line.lower().startswith(b"content-length:"):
                size = int(line.split(b":", 1)[1])
        if size is None or not 0 < size <= 32 * 1024 * 1024:
            raise ValueError("Invalid LSP message length")
        return json.loads(self.process.stdout.read(size))

    def request(self, method, params):
        self.request_id += 1
        sent_id = self.request_id
        self.write({"id": sent_id, "method": method, "params": params})
        while True:
            response = self.read()
            if "method" in response:
                if "id" in response:
                    if response["method"] == "workspace/configuration":
                        result = [None] * len(response.get("params", {}).get("items", []))
                        self.write({"id": response["id"], "result": result})
                    else:
                        self.write({"id": response["id"], "error": {"code": -32601,
                                   "message": "Client method not supported"}})
                continue
            if response.get("id") == sent_id:
                if "error" in response:
                    raise RuntimeError(str(response["error"].get("message", "LSP request failed"))[:400])
                return response["result"]

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=4)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.process.stdin.close()
        self.process.stdout.close()


def validate_position(source, position):
    line, column = position["line"], position["character"]
    rows = re.split(r"\r\n|\r|\n", source)
    if type(line) is not int or type(column) is not int or not 0 <= line < len(rows) or column < 0:
        raise ValueError("Invalid source position")
    encoded = rows[line].encode("utf-16-le")
    if column * 2 > len(encoded):
        raise ValueError("Column out of bounds")
    encoded[:column * 2].decode("utf-16-le")  # LSP columns must not split a surrogate pair.


def setup_workspace(project, workspace, sdk, compiler):
    source_root = workspace / "Sources"
    paths = {}
    for name, value in project["files"].items():
        if not name.endswith(".swift") or name.startswith("Tests/"):
            continue
        path = source_root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(value.encode("utf-8"))
        paths[str(path)] = name
    index = workspace / "index"
    command = [compiler, "-typecheck", "-parse-as-library", "-swift-version", "5", "-module-name", "PocketApp",
               "-sdk", sdk, "-target", "arm64-apple-ios17.0", "-index-store-path", str(index), *paths]
    database = [{"directory": str(workspace), "file": path, "arguments": command} for path in paths]
    (workspace / "compile_commands.json").write_text(json.dumps(database))
    return paths, command


def results_for(mode, response, paths):
    if mode == "completion":
        items = response.get("items", []) if isinstance(response, dict) else response or []
        results = []
        for item in items[:50]:
            if not isinstance(item, dict) or not item.get("label"):
                continue
            row = {"label": str(item["label"])[:250], "detail": str(item.get("detail", ""))[:400]}
            edit = item.get("textEdit") or {}
            region = edit.get("range") or edit.get("replace") or {}
            # Only expose a replacement when no other edits, commands or snippet processing are required.
            if (item.get("insertTextFormat", 1) == 1 and not item.get("additionalTextEdits") and
                    not item.get("command") and isinstance(edit.get("newText"), str) and
                    len(edit["newText"]) <= 2048 and all(
                        isinstance(region.get(point), dict) and all(
                            type(region[point].get(field)) is int and region[point][field] >= 0
                            for field in ("line", "character")) for point in ("start", "end"))):
                row["edit"] = {"range": region, "text": edit["newText"]}
            results.append(row)
        return results, len(items) > 50 or (isinstance(response, dict) and bool(response.get("isIncomplete")))
    locations = response if isinstance(response, list) else ([response] if response else [])
    results = []
    for item in locations[:50]:
        uri = item.get("targetUri", item.get("uri", ""))
        start = (item.get("targetSelectionRange") or item.get("range", {})).get("start", {})
        if any(type(start.get(key)) is not int or start[key] < 0 for key in ("line", "character")):
            continue
        parsed = urlparse(uri)
        path = str(Path(unquote(parsed.path)).resolve()) if parsed.scheme == "file" else None
        if path in paths:
            results.append({"file": paths[path], **start})
        else:
            results.append({"external": True, "label": Path(unquote(parsed.path)).name[:120] or "Swift SDK"})
    return results, len(locations) > 50


def tool(name):
    return subprocess.check_output(["xcrun", "--find", name], text=True, timeout=10).strip()


def query(project, relative, position, mode, workspace):
    if mode not in ("completion", "definition"):
        raise ValueError("Unsupported query mode")
    if relative not in project["files"] or not relative.endswith(".swift") or relative.startswith("Tests/"):
        raise ValueError("Select a Swift source from the app target")
    source = project["files"][relative]
    validate_position(source, position)
    sdk = subprocess.check_output(["xcrun", "--sdk", "iphoneos", "--show-sdk-path"], text=True, timeout=15).strip()
    paths, command = setup_workspace(project, workspace, sdk, tool("swiftc"))
    indexed = False
    if mode == "definition":
        # A syntax error can prevent indexing; an AST-local result may still exist.
        indexed = subprocess.run(command, cwd=workspace, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 timeout=90).returncode == 0
    with contextlib.closing(LSP(tool("sourcekit-lsp"), workspace)) as client:
        root_uri = workspace.as_uri()
        capabilities = client.request("initialize", {
            "processId": os.getpid(), "rootUri": root_uri,
            "workspaceFolders": [{"uri": root_uri, "name": "PocketApp"}],
            "capabilities": {"general": {"positionEncodings": ["utf-16"]}},
        })["capabilities"]
        provider = capabilities.get("definitionProvider" if mode == "definition" else "completionProvider")
        if capabilities.get("positionEncoding", "utf-16") != "utf-16" or provider is None or provider is False:
            raise RuntimeError("This SourceKit-LSP lacks the required capability or UTF-16 positions")
        client.write({"method": "initialized", "params": {}})
        uri = (workspace / "Sources" / relative).as_uri()
        client.write({"method": "textDocument/didOpen", "params": {"textDocument": {
            "uri": uri, "languageId": "swift", "version": 1, "text": source}}})
        if indexed:
            with contextlib.suppress(RuntimeError):
                client.request("workspace/_pollIndex", {})
        response = client.request("textDocument/" + mode, {"textDocument": {"uri": uri}, "position": position})
        results, partial = results_for(mode, response, paths)
    return {"status": "ok" if results else "empty", "items": results, "partial": partial,
            "indexTypecheckSucceeded": indexed if mode == "definition" else None}


def main():
    env = os.environ
    request, sha = env["REQUEST_ID"], env["SOURCE_SHA"]
    if not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", request) or not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise ValueError("Invalid request identity")
    checkout = Path(env["SNAPSHOT_ROOT"]).resolve()
    if subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=checkout, text=True).strip() != sha:
        raise ValueError("Snapshot SHA mismatch")
    snapshot = checkout / "pocket-builds" / (request + ".json")
    if snapshot.resolve() != snapshot:
        raise ValueError("Invalid snapshot path")
    project, _ = read_input(snapshot)
    path = env["SWIFT_FILE"]
    pos = {"line": int(env["SOURCE_LINE"]), "character": int(env["SOURCE_COLUMN"])}
    result = {"schema": "pocket-sourcekit/v1", "engine": "sourcekit-lsp", "request_id": request,
              "source_sha": sha, "file": path, "mode": env["QUERY_MODE"], "position": pos,
              "source_digest": hashlib.sha256(project["files"].get(path, "").encode()).hexdigest()}
    def timeout(*_):
        raise TimeoutError("SourceKit-LSP timed out")
    signal.signal(signal.SIGALRM, timeout)
    signal.alarm(180)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            result.update(query(project, path, pos, result["mode"], Path(tmp).resolve()))
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as exc:
        result.update(status="unavailable", message=str(exc)[:500], items=[], partial=False)
    finally:
        signal.alarm(0)
    Path(env["RESULT_FILE"]).write_text(json.dumps(result, ensure_ascii=False))
    print(f"SourceKit-LSP: {result['status']} ({len(result['items'])} items)")


if __name__ == "__main__":
    main()
