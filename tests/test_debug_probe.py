import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace


path=Path(__file__).resolve().parents[1]/"native-build/debug_probe.py"
spec=importlib.util.spec_from_file_location("debug_probe",path)
probe=importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeTests(unittest.TestCase):
    def test_breakpoint_rejects_paths_commands_and_invalid_lines(self):
        for x in ["foo/App.swift:1","-o.swift:1","App.swift:0","App.swift:2\ncontinue","App.swift:1;quit","App.swift:01"]:
            with self.subTest(x=x), self.assertRaises(ValueError):
                probe.validate(x)
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)
            (p/"App.swift").write_text("first\nsecond\n")
            self.assertEqual(probe.validate("App.swift:2",p),("App.swift",2))
            with self.assertRaises(ValueError): probe.validate("App.swift:3",p)
            (p/"sub").mkdir()
            (p/"sub/App.swift").write_text("also here")
            with self.assertRaises(ValueError): probe.validate("App.swift:1",p)

    def test_timeout_before_and_after_attach(self):
        for armed in [False,True]:
            with self.subTest(armed=armed), tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ):
                p=Path(tmp)
                exe=p/"PocketApp"
                exe.touch()
                (p/"App.swift").write_text("line\n")
                args=SimpleNamespace(spec="App.swift:1",pid=42,sources=p,executable=exe,output=p/"debug.json")
                def timeout(cmd,**kw):
                    self.assertNotIn(args.spec,cmd)
                    if armed:
                        result=json.loads(args.output.read_text())
                        probe.finish(result,"armed","ready")
                    raise subprocess.TimeoutExpired(cmd,60)
                with patch.object(subprocess,"run",side_effect=timeout):
                    probe.run(args)
                self.assertEqual(json.loads(args.output.read_text())["status"],"error")
                self.assertTrue((p/"debug.txt").is_file())


if __name__ == "__main__": unittest.main()
