"""Create and check the generated-project fixture for native XCTest coverage CI."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import uuid

APP_SOURCE = """import SwiftUI

@main
struct CoverageFixtureApp: App {
    var body: some Scene {
        WindowGroup { Text("Coverage fixture") }
    }
}
"""
LOGIC_SOURCE = """enum Price {
    static func discounted(_ price: Int, eligible: Bool) -> Int {
        if eligible {
            return price - 5
        }
        return price
    }
}
"""
TEST_SOURCE = """import XCTest
@testable import PocketApp

final class PriceTests: XCTestCase {
    func testDiscountedPrice() {
        XCTAssertEqual(Price.discounted(10, eligible: true), 5)
    }
}
"""
FILES = {"App.swift": APP_SOURCE, "Pricing/Price.swift": LOGIC_SOURCE, "Tests/PriceTests.swift": TEST_SOURCE}


def prepare():
    directory = Path("artifacts")
    directory.mkdir()
    request_id = str(uuid.uuid4())
    project_path = Path("pocket-builds") / f"{request_id}.json"
    project_path.parent.mkdir()
    project_path.write_text(json.dumps({"format":"xcode-pocket-project","version":1,"files":FILES}))
    identity = {"schema":"xcode-pocket-build-identity/v1","request_id":request_id,
                "source_sha":os.environ["GITHUB_SHA"], "project_path":str(project_path),
                "workflow_run_id":int(os.environ["GITHUB_RUN_ID"]), "workflow_attempt":int(os.environ["GITHUB_RUN_ATTEMPT"]),
                "workflow":".github/workflows/pocket-coverage-check.yml","signed":False}
    (directory/"build-identity.json").write_text(json.dumps(identity))
    generator = Path(__file__).resolve().parents[1] / "native-build/generate_project.py"
    subprocess.run(["python3", str(generator),"--input",str(project_path),"--output","build-project",
                    "--bundle-id","org.example.pocketcoverage"],check=True)


def simulator():
    data = json.loads(subprocess.check_output(["xcrun","simctl","list","devices","available","--json"],text=True))
    choices = []
    for runtime, devices in data["devices"].items():
        match = re.fullmatch(r"com\.apple\.CoreSimulator\.SimRuntime\.iOS-(\d+)-(\d+)(?:-(\d+))?",runtime)
        if not match or int(match[1]) < 17:
            continue
        version = tuple(int(x or 0) for x in match.groups())
        for device in devices:
            if device.get("isAvailable") and device.get("name","").startswith("iPhone"):
                choices.append((version,device["name"],str(uuid.UUID(device["udid"]))))
    if not choices:
        raise RuntimeError("No available iOS 17+ iPhone simulator")
    print(max(choices)[2])


def verify():
    report = json.loads(Path("artifacts/pocket-issues.json").read_text())
    assert report["identity"] == json.loads(Path("artifacts/build-identity.json").read_text())
    tests = report["tests"]
    assert tests["status"] == "success" and tests["counts"]["passedTests"] == 1, tests
    assert tests["counts"]["failedTests"] == 0, tests
    coverage = report["coverage"]
    assert coverage and 0 < coverage["coveredLines"] <= coverage["executableLines"], coverage
    files = {item["path"]:item for item in coverage["files"]}
    assert "Pricing/Price.swift" in files and 0 < files["Pricing/Price.swift"]["coveredLines"], files
    assert set(files).issubset({"Pricing/Price.swift","App.swift"}), files
    for count in ("coveredLines", "executableLines"):
        assert sum(item[count] for item in files.values()) == coverage[count], coverage
    print(json.dumps({"tests":tests["counts"],"coverage":coverage},indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action",choices=("prepare","simulator","verify"))
    {"prepare":prepare,"simulator":simulator,"verify":verify}[parser.parse_args().action]()
