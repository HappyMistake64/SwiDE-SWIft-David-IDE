"""Run the two private workflow commands against the JS transport's in-memory GitHub responses."""
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
from unittest.mock import patch
from zipfile import ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "native-build"))
import private_build as builder


class RecordedGitHub:
    def __init__(self, responses):
        self.responses = responses

    def get(self, path, limit=100_000):
        response = self.responses[path]
        assert len(json.dumps(response).encode()) <= limit
        return response


def build_app():
    if os.environ.get("SWIDE_XCODE_PROTOCOL_TEST") == "1":
        subprocess.run([
            "xcodebuild", "-project", "generated/PocketApp.xcodeproj", "-scheme", "PocketApp",
            "-configuration", "Release", "-sdk", "iphoneos", "-destination", "generic/platform=iOS",
            "-disableAutomaticPackageResolution", "-derivedDataPath", "built", "CODE_SIGNING_ALLOWED=NO", "build"
        ], check=True)
    else:
        app = Path("built/Build/Products/Release-iphoneos/PocketApp.app")
        app.mkdir(parents=True)
        (app / "Info.plist").write_bytes(plistlib.dumps({"CFBundleExecutable": "PocketApp"}))
        (app / "PocketApp").write_bytes(b"synthetic cross-language test fixture")


def main():
    wire = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    with patch.dict(os.environ, wire["env"]), patch.object(builder, "GitData", return_value=RecordedGitHub(wire["responses"])):
        builder.prepare()
    assert Path("generated/PocketApp.xcodeproj/project.pbxproj").is_file()
    build_app()
    builder.package()
    # upload-artifact uses these two root members. Fold the actual workflow outputs into a real ZIP.
    result = Path("result")
    with ZipFile("artifact.zip", "x") as archive:
        for member in sorted(result.iterdir()):
            archive.write(member, member.name)


if __name__ == "__main__":
    main()
