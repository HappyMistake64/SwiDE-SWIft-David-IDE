"""Exercise the trusted builder against the exact shape of a private Git Data snapshot."""
import base64
import copy
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import tempfile
import unittest
from zipfile import ZipFile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("private_build", Path(__file__).parents[1] / "native-build/private_build.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)

UUID = "06739aab-670b-4451-8b87-720449397868"
SOURCE = b'{"version":2,"format":"xcode-pocket-project","files":{"App.swift":"import SwiftUI"}}'
ENV = {"GITHUB_REPOSITORY": "alice/demo", "GITHUB_REPOSITORY_ID": "70", "GITHUB_REPOSITORY_OWNER_ID": "11",
       "GITHUB_RUN_ATTEMPT": "2", "GITHUB_RUN_ID": "100", "REQUEST_ID": UUID, "SOURCE_SHA": "2" * 40,
       "CALLER_SHA": "c" * 40, "BUILDER_SHA": "b" * 40}


class Snapshot:
    def __init__(self):
        self.project = f"pocket-builds/{UUID}.json"
        self.manifest = {"schema": "swide-request/v2", "mode": "generated", "owner_id": 11,
                         "repository_id": 70, "request_id": UUID, "project_path": self.project,
                         "input_sha256": builder.digest(SOURCE), "caller_sha": ENV["CALLER_SHA"],
                         "builder_sha": ENV["BUILDER_SHA"], "workflow_id": 95, "workflow_path": builder.WORKFLOW,
                         "app_name": "Example", "bundle_id": "com.example.app"}
        raw = json.dumps(self.manifest).encode()
        self.env = dict(ENV, MANIFEST_SHA256=builder.digest(raw))
        self.tree_path = "/git/trees/" + "3" * 40 + "?recursive=1"
        self.responses = {
            "": {"private": True, "visibility": "private", "full_name": "alice/demo", "id": 70,
                 "owner": {"type": "User", "id": 11}},
            "/git/ref/heads/requests/" + UUID: {"ref": "refs/heads/requests/" + UUID,
                                                "object": {"type": "commit", "sha": ENV["SOURCE_SHA"]}},
            "/git/commits/" + ENV["SOURCE_SHA"]: {"sha": ENV["SOURCE_SHA"], "tree": {"sha": "3" * 40}},
            self.tree_path: {"sha": "3" * 40, "truncated": False, "tree": []}}
        for folder in ["pocket-builds", "requests"]:
            self.responses[self.tree_path]["tree"].append({"path": folder, "type": "tree", "mode": "040000", "sha": "4" * 40})
        for name, data, sha in [(self.project, SOURCE, "5" * 40), (f"requests/{UUID}.json", raw, "6" * 40)]:
            self.responses[self.tree_path]["tree"].append({"path": name, "type": "blob", "mode": "100644",
                                                          "size": len(data), "sha": sha})
            self.responses["/git/blobs/" + sha] = {"sha": sha, "size": len(data), "encoding": "base64",
                                                   "content": base64.b64encode(data).decode()}

    def get(self, path, limit=None):
        return self.responses[path]


class PrivateBuilderTest(unittest.TestCase):
    def test_build_and_package(self):
        api = Snapshot()
        manifest, source = builder.load_source(api, api.env)
        previous = Path.cwd()
        with tempfile.TemporaryDirectory() as folder:
            os.chdir(folder)
            try:
                builder.build_input(source, manifest)
                self.assertTrue(Path("generated/PocketApp.xcodeproj/project.pbxproj").is_file())
                app = Path("built/Build/Products/Release-iphoneos/PocketApp.app")
                app.mkdir(parents=True)
                (app / "Info.plist").write_bytes(plistlib.dumps({"CFBundleExecutable": "PocketApp"}))
                (app / "PocketApp").write_bytes(b"synthetic app fixture")
                Path("identity.json").write_text(json.dumps(builder.make_receipt(manifest, api.env)))
                builder.package()
                result = Path("result")
                receipt = json.loads((result / "build-identity.json").read_text())
                self.assertEqual(receipt["ipa_sha256"], builder.digest((result / builder.IPA).read_bytes()))
                self.assertEqual((receipt["run_id"], receipt["run_attempt"], receipt["signed"]), (100, 2, False))
                with ZipFile(result / builder.IPA) as ipa:
                    self.assertEqual(sorted(ipa.namelist()), ["Payload/PocketApp.app/Info.plist", "Payload/PocketApp.app/PocketApp"])
            finally:
                os.chdir(previous)

    def test_data_boundaries(self):
        orig = Snapshot()
        cases = [(("", "private"), False), (("", "visibility"), "internal"), (("", "id"), 75),
                 (("/git/ref/heads/requests/" + UUID, "object", "sha"), "8" * 40),
                 ((orig.tree_path, "tree", 2, "mode"), "120000"), ((orig.tree_path, "truncated"), True),
                 ((orig.tree_path, "tree", 2, "size"), 5_000_000)]
        for keys, value in cases:
            with self.subTest(keys=keys):
                api = copy.deepcopy(orig)
                field = api.responses
                for key in keys[:-1]:
                    field = field[key]
                field[keys[-1]] = value
                with self.assertRaises(ValueError):
                    builder.load_source(api, api.env)
        for key in ("MANIFEST_SHA256", "CALLER_SHA", "BUILDER_SHA"):
            with self.subTest(key=key):
                with self.assertRaises(ValueError):
                    builder.load_source(orig, {**orig.env, key: "d" * len(orig.env[key])})

    def test_block_project_capabilities(self):
        manifest = Snapshot().manifest
        original = json.loads(SOURCE)
        with patch.object(Path, "write_bytes"), patch.object(builder, "read_input") as read:
            for name in ["Tests/Test.swift", "tools/run.sh", ".github/Build.swift", "$(TEMP)/Extra.swift"]:
                with self.subTest(name=name):
                    read.return_value = ({**original, "files": {**original["files"], name: ""}}, {})
                    with self.assertRaises(ValueError):
                        builder.build_input(SOURCE, manifest)


if __name__ == "__main__":
    unittest.main()
