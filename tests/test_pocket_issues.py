import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import subprocess


path = Path(__file__).resolve().parents[1] / "native-build/collect_issues.py"
spec = importlib.util.spec_from_file_location("pocket_issues", path)
issues = importlib.util.module_from_spec(spec)
spec.loader.exec_module(issues)


class IssueTests(unittest.TestCase):
    def test_map_generated_and_test_sources_but_exclude_unrelated_build_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            log = root / "build.log"
            message = f"{root}/Sources/Sources/A.swift:17:4: error: no such symbol"
            log.write_text(f"{message}\n{message}\n{root}/Tests/B.swift:8: warning: caution\n{root}/Other.swift:1:1: note: external\n")
            result, hashes, truncated = issues.collect([log], {"files":{"Sources/A.swift":"abc","Tests/B.swift":"test"}}, root)
            self.assertEqual([(i["path"],i["line"],i["column"]) for i in result], [("Sources/A.swift",17,4),("Tests/B.swift",8,1)])
            self.assertEqual(hashes["Sources/A.swift"],"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
            self.assertFalse(truncated)

    def test_counts_require_real_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            bundle = Path(tmp)/"tests.xcresult"
            self.assertEqual(issues.test_summary(bundle,"success","not_requested"),{"status":"not_requested","counts":None})
            bundle.mkdir()
            with patch.object(subprocess,"run",return_value=subprocess.CompletedProcess([],0,'{"totalTestCount":4,"passedTests":3,"failedTests":1,"skippedTests":"n/a"}',"")):
                data=issues.test_summary(bundle,"failure","requested")
            self.assertEqual(data,{"status":"failure","counts":{"totalTestCount":4,"passedTests":3,"failedTests":1}})
            with patch.object(subprocess,"run",side_effect=OSError()):
                self.assertIsNone(issues.test_summary(bundle,"failure","requested")["counts"])

    def test_coverage_uses_real_application_paths_and_weighted_line_counts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle = root / "PocketTests.xcresult"
            bundle.mkdir()
            project = {"files": {"Main.swift": "a", "Views/Content.swift": "b", "Tests/AppTests.swift": "test"}}
            main = {"name":"Main.swift","path":str(root/"Sources/Main.swift"),"coveredLines":2,
                    "executableLines":8,"lineCoverage":0.25,"functions":[{"name":"App.main()","lineCoverage":0.25}]}
            view = {"name":"Content.swift","path":str(root/"Sources/Views/Content.swift"),"coveredLines":2,
                    "executableLines":2,"lineCoverage":1.0,"functions":[]}
            report = {"coveredLines":105,"executableLines":200,"lineCoverage":0.525,"targets":[
                {"name":"PocketApp.app","buildProductPath":str(root/"Build/Products/PocketApp.app"),"files":[main,main,view,
                 {**main,"path":str(root/"Generated/Dependency/Main.swift")},
                 {**main,"path":str(root/"Tests/AppTests.swift")}]},
                {"name":"PocketAppTests.xctest","files":[{**main,"coveredLines":8}]}]}
            with patch.object(subprocess,"run",return_value=subprocess.CompletedProcess([],0,json.dumps(report),"")) as runner:
                data = issues.coverage_summary(bundle,project,root)
            self.assertEqual(runner.call_args.args[0],["xcrun","xccov","view","--report","--json",str(bundle)])
            self.assertEqual(data,{"coveredLines":4,"executableLines":10,"files":[
                {"path":"Main.swift","coveredLines":2,"executableLines":8},
                {"path":"Views/Content.swift","coveredLines":2,"executableLines":2}]})

    def test_missing_coverage_is_distinct_from_measured_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle = root / "PocketTests.xcresult"
            project = {"files":{"A.swift":""}}
            with patch.object(subprocess,"run") as runner:
                self.assertIsNone(issues.coverage_summary(bundle,project,root))
                runner.assert_not_called()
            bundle.mkdir()
            with patch.object(subprocess,"run",side_effect=OSError()):
                self.assertIsNone(issues.coverage_summary(bundle,project,root))
            fixture = {"targets":[{"name":"PocketApp.app","files":[{"path":str(root/"Sources/A.swift"),
                            "coveredLines":0,"executableLines":4}]}]}
            with patch.object(subprocess,"run",return_value=subprocess.CompletedProcess([],0,json.dumps(fixture),"")):
                self.assertEqual(issues.coverage_summary(bundle,project,root)["coveredLines"],0)


if __name__ == "__main__":
    unittest.main()
