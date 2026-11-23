import json
from pathlib import Path
import shutil
import signal
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "native-build"))
from pocket_language import frame, query, results_for, setup_workspace, validate_position


class LanguageContract(unittest.TestCase):
    def test_framing_counts_bytes(self):
        header, body = frame({"id": 1, "result": "🍪"}).split(b"\r\n\r\n")
        self.assertEqual(int(header.split(b":")[1]), len(body))
        self.assertEqual(json.loads(body)["result"], "🍪")

    def test_utf16_positions(self):
        text = "first\r\nlet emoji = \"🍪\""
        validate_position(text, {"line": 1, "character": 15})
        for line, col in [(2, 0), (1, 14), (1, 17), (-1, 1), (1, -1)]:
            with self.subTest(line=line, column=col), self.assertRaises(ValueError):
                validate_position(text, {"line": line, "character": col})

    def test_build_context_limits_to_app_sources(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp).resolve()
            project = {"files": {"Model.swift": "struct Model {}", "Tests/Model.swift": "INVALID",
                                 "Resources/Note.txt": "abc", "Nested/Usage.swift": "let a = Model()"}}
            paths, command = setup_workspace(project, folder, "/example/sdk", "/example/bin/swiftc")
            self.assertEqual(set(paths.values()), {"Model.swift", "Nested/Usage.swift"})
            self.assertIn("arm64-apple-ios17.0", command)
            self.assertEqual(len(json.loads((folder/"compile_commands.json").read_text())), 2)

    def test_locations_completions_and_empty(self):
        local = Path("/Sources/Číslo.swift")
        result = [{"targetUri": local.as_uri(), "targetSelectionRange": {"start": {"line": 2, "character": 8}}},
                  {"uri": "file:///SDK/Swift.swiftinterface", "range": {"start": {"line": 0, "character": 0}}}]
        items, partial = results_for("definition", result, {str(local): "Číslo.swift"})
        self.assertEqual(items[0], {"file": "Číslo.swift", "line": 2, "character": 8})
        self.assertTrue(items[1]["external"])
        self.assertFalse(partial)
        self.assertEqual(results_for("definition", None, {}), ([], False))
        items, partial = results_for("completion", {"isIncomplete": True, "items": [{"label": "count"}]}, {})
        self.assertTrue(partial)
        self.assertEqual(items[0]["label"], "count")
        edit = {"range": {"start": {"line": 0, "character": 1}, "end": {"line": 0, "character": 2}},
                "newText": "count"}
        choices = [{"label": "count", "textEdit": edit}, {"label": "snippet", "textEdit": edit, "insertTextFormat": 2}]
        items, _ = results_for("completion", choices, {})
        self.assertEqual(items[0]["edit"], {"range": edit["range"], "text": "count"})
        self.assertNotIn("edit", items[1])


@unittest.skipUnless(sys.platform == "darwin" and shutil.which("xcrun"), "requires Xcode and iPhoneOS SDK")
class SourceKitOnMac(unittest.TestCase):
    def test_go_to_local_definition_from_reference(self):
        source = "func add() -> Int {\n    let pocketLocal = 41\n    return pocketLocal + 1\n}\n"
        project = {"files": {"Arithmetic.swift": source}}
        with tempfile.TemporaryDirectory() as tmp:
            signal.alarm(150)
            try:
                result = query(project, "Arithmetic.swift", {"line": 2, "character": 14},
                               "definition", Path(tmp).resolve())
            finally:
                signal.alarm(0)
        self.assertEqual(result["status"], "ok", result)
        self.assertTrue(any(item.get("file") == "Arithmetic.swift" and item["line"] == 1 and
                            item["character"] == 8 for item in result["items"]), result)


if __name__ == "__main__":
    unittest.main()
