import copy
import hashlib
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from test_build_manager import manager

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "private-result.json").read_text())


class API:
    def __init__(self):
        self.request = copy.deepcopy(FIXTURE["request"])
        self.run = copy.deepcopy(FIXTURE["run"])
        self.artifact = copy.deepcopy(FIXTURE["artifact"])
        self.repo = copy.deepcopy(self.run["repository"])

    def get(self, path):
        prefix = "/repos/" + self.request["repo"]
        if path == prefix:
            return self.repo
        if path == f"{prefix}/actions/runs/404":
            return self.run
        if path.startswith(f"{prefix}/actions/runs/404/artifacts?name=swide-ipa-"):
            return {"total_count": 1, "artifacts": [self.artifact]}
        raise AssertionError(path)


class PrivateResultTests(unittest.TestCase):
    def setUp(self):
        self.api = API()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.archive = Path(tmp.name) / "result.zip"
        self.ipa = b"inert IPA fixture"
        self.receipt = dict(FIXTURE["receipt"], ipa_sha256=hashlib.sha256(self.ipa).hexdigest())
        self.write()

    def write(self, ipa_name=manager.IPA):
        with zipfile.ZipFile(self.archive, "w", compression=zipfile.ZIP_DEFLATED) as output:
            output.writestr(ipa_name, self.ipa)
            output.writestr(manager.RECEIPT, json.dumps(self.receipt))
        data = self.archive.read_bytes()
        self.api.artifact.update(digest="sha256:" + hashlib.sha256(data).hexdigest(), size_in_bytes=len(data))

    def verify(self):
        return manager.resolve_private(self.api, self.api.request, self.archive)

    def test_independent_correlation_then_verify_bytes(self):
        result = manager.resolve_private(self.api, self.api.request)
        self.assertEqual(result["state"], "awaiting_verification")
        self.assertIs(result["source_verified"], False)
        self.assertEqual(self.verify()["ipa_sha256"], self.receipt["ipa_sha256"])

    def test_refuses_artifact_from_another_private_repo_or_attempt(self):
        self.api.artifact["workflow_run"]["repository_id"] += 1
        with self.assertRaises(ValueError):
            self.verify()
        self.api = API()
        self.write()
        self.api.run["run_attempt"] = 2
        with self.assertRaises(ValueError):
            self.verify()

    def test_fail_closed_on_visibility_and_outer_hash(self):
        self.api.repo["private"] = False
        with self.assertRaises(ValueError):
            self.verify()
        self.api.repo["private"] = True
        self.api.artifact["digest"] = "sha256:" + "0" * 64
        with self.assertRaises(ValueError):
            self.verify()

    def test_receipt_rejects_signed_status_and_inner_tampering(self):
        self.receipt["signed"] = 0
        self.write()
        with self.assertRaises(ValueError):
            self.verify()
        self.receipt["signed"] = False
        self.ipa = b"different IPA"
        self.write()
        with self.assertRaises(ValueError):
            self.verify()

    def test_directory_traversal_never_writes_files(self):
        self.write("../private.ipa")
        with self.assertRaises(ValueError):
            self.verify()
        self.assertFalse((self.archive.parent.parent / "private.ipa").exists())
