"""Collect source-linked Xcode diagnostics and XCTest totals for one Actions run."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess


DIAGNOSTIC = re.compile(r"^(?P<path>.+?):(?P<line>\d+):(?:(?P<column>\d+):)?\s*(?P<severity>error|warning|note):\s*(?P<message>.+)$")
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
MAX_ISSUES = 250


def collect(logs, project, generated):
    path_map = {}
    for path, content in project.get("files", {}).items():
        if not isinstance(content, str):
            continue
        actual = generated / (path if path.startswith(("Tests/", "Resources/")) else "Sources/" + path)
        path_map[actual.resolve()] = path
    issues, hashes, seen = [], {}, set()
    for log in logs:
        if not log.is_file():
            continue
        with log.open(encoding="utf-8", errors="replace") as stream:
            for line in stream:
                match = DIAGNOSTIC.match(ANSI.sub("", line.rstrip()))
                if not match:
                    continue
                path = path_map.get(Path(match["path"]).resolve())
                if path is None:
                    continue
                issue = {"path":path, "line":int(match["line"]), "column":int(match["column"] or 1),
                         "severity":match["severity"], "message":match["message"][:1600]}
                if issue["line"] < 1 or issue["column"] < 1:
                    continue
                key = tuple(issue.values())
                if key in seen:
                    continue
                if len(issues) == MAX_ISSUES:
                    return issues, hashes, True
                seen.add(key)
                issues.append(issue)
                if path not in hashes:
                    hashes[path] = hashlib.sha256(project["files"][path].encode()).hexdigest()
    return issues, hashes, False


def test_summary(bundle, outcome, detail):
    result = {"status":("not_requested" if detail == "not_requested" else outcome), "counts":None}
    if not bundle.exists():
        return result
    command = ["xcrun", "xcresulttool", "get", "test-results", "summary", "--path", str(bundle)]
    try:
        response = subprocess.run(command, capture_output=True, text=True, check=True, timeout=45)
        data = json.loads(response.stdout)
    except (ValueError, subprocess.SubprocessError, OSError):
        return result
    if not isinstance(data, dict):
        return result
    counts = {}
    for key in ["totalTestCount", "passedTests", "failedTests", "skippedTests", "expectedFailures"]:
        value = data.get(key)
        if type(value) is int and value >= 0:
            counts[key] = value
    result["counts"] = counts or None
    return result


def coverage_summary(bundle, project, generated):
    """Read instrumented application Swift files from this project's actual XCTest bundle."""
    if not bundle.exists():
        return None
    command = ["xcrun", "xccov", "view", "--report", "--json", str(bundle)]
    try:
        response = subprocess.run(command, capture_output=True, text=True, check=True, timeout=45)
        data = json.loads(response.stdout)
    except (ValueError, subprocess.SubprocessError, OSError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("targets"), list):
        return None
    eligible = {(generated / "Sources" / name).resolve(): name for name, value in project.get("files", {}).items()
                if isinstance(value, str) and name.endswith(".swift") and not name.startswith(("Tests/", "Resources/"))}
    files = {}
    for target in data["targets"]:
        if not isinstance(target, dict) or target.get("name") not in ("PocketApp", "PocketApp.app"):
            continue
        for item in target.get("files") or []:
            if not isinstance(item, dict) or not isinstance(item.get("path"), str):
                continue
            path = Path(item["path"])
            if not path.is_absolute():
                continue
            name = eligible.get(path.resolve())
            covered, executable = item.get("coveredLines"), item.get("executableLines")
            if name is None or type(covered) is not int or type(executable) is not int or not 0 <= covered <= executable:
                continue
            row = {"path": name, "coveredLines": covered, "executableLines": executable}
            if name in files and files[name] != row:
                # Multiple incompatible records cannot be combined without line-level data.
                return None
            files[name] = row
    if not files:
        return None
    rows = [files[name] for name in sorted(files)]
    return {"coveredLines": sum(row["coveredLines"] for row in rows),
            "executableLines": sum(row["executableLines"] for row in rows), "files": rows}


def main():
    arg = argparse.ArgumentParser()
    arg.add_argument("--artifacts", type=Path, default=Path("artifacts"))
    arg.add_argument("--generated", type=Path, default=Path("build-project"))
    arg.add_argument("--repository", required=True)
    arg.add_argument("--outcome", required=True)
    arg.add_argument("--detail", default="")
    args = arg.parse_args()
    dest = args.artifacts
    identity = json.loads((dest / "build-identity.json").read_text())
    project = json.loads(Path(identity["project_path"]).read_text())
    issues, hashes, truncated = collect([dest/"xcodebuild.log", dest/"xctest.log"], project, args.generated)
    report = {"schema":"xcode-pocket-issues/v1", "repository":args.repository, "identity":identity,
              "diagnostics":issues, "file_hashes":hashes, "truncated":truncated,
              "tests":test_summary(dest/"PocketTests.xcresult", args.outcome, args.detail),
              "coverage":coverage_summary(dest/"PocketTests.xcresult", project, args.generated)}
    (dest/"pocket-issues.json").write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
