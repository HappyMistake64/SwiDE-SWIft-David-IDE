import importlib.util
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


if __name__ == "__main__":
    unittest.main()
