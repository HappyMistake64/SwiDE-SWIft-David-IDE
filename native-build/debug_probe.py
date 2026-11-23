"""One bounded source breakpoint for the generated simulator app. No expression evaluation."""
import argparse
import json
import hashlib
import os
from pathlib import Path
import re
import subprocess
import time


SPEC = re.compile(r"([A-Za-z0-9_][A-Za-z0-9_.-]{0,119}\.swift):([1-9][0-9]{0,5})")


def validate(spec, root=None):
    match = SPEC.fullmatch(spec)
    if not match:
        raise ValueError("Expected basename.swift:line using ASCII letters, digits, dot, underscore or dash.")
    name, line = match[1], int(match[2])
    if root is not None:
        paths = [p for p in root.rglob("*.swift") if p.name == name]
        if len(paths) != 1:
            raise ValueError("Breakpoint file must exist exactly once in generated app sources.")
        count = len(paths[0].read_text(encoding="utf-8").splitlines())
        if line > count:
            raise ValueError("Breakpoint line is past the end of this source file.")
    return name, line


def finish(result, status, message):
    result.update(status=status, message=message)
    dest = Path(os.environ["POCKET_DEBUG_OUTPUT"])
    temporary = dest.with_suffix(".tmp")
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2)+"\n",encoding="utf-8")
    temporary.replace(dest)


def probe():
    import lldb
    name, line = validate(os.environ["DEBUG_AT"])
    doc = json.loads(Path(os.environ["POCKET_DEBUG_OUTPUT"]).read_text())
    debugger = lldb.debugger
    debugger.SetAsync(False)
    target = debugger.CreateTarget(os.environ["POCKET_DEBUG_EXE"])
    if not target.IsValid():
        raise RuntimeError("LLDB did not create the app target.")
    # Bind before attaching: app code may live in a Swift debug dylib loaded at launch.
    bp = target.BreakpointCreateByLocation(os.environ["POCKET_DEBUG_SOURCE"], line)
    if not bp.IsValid():
        raise RuntimeError("LLDB could not create the source breakpoint.")
    process = target.AttachToProcessWithID(debugger.GetListener(), int(os.environ["POCKET_DEBUG_PID"]), (error := lldb.SBError()))
    if not error.Success() or not process.IsValid():
        raise RuntimeError("LLDB attach failed: " + str(error))
    try:
        doc["locations_at_attach"] = bp.GetNumLocations()
        doc["resolved_at_attach"] = bp.GetNumResolvedLocations()
        finish(doc, "armed", "Attached; waiting for the selected source breakpoint.")
        debugger.SetAsync(True)
        listener = lldb.SBListener("pocket-selected-breakpoint")
        process.GetBroadcaster().AddListener(listener, lldb.SBProcess.eBroadcastBitStateChanged)
        error = process.Continue()
        if not error.Success():
            raise RuntimeError("LLDB continue failed: " + str(error))
        deadline = time.monotonic() + 180
        thread = None
        last_state = ""
        while time.monotonic() < deadline:
            event = lldb.SBEvent()
            if not listener.WaitForEvent(1, event) or not lldb.SBProcess.EventIsProcessEvent(event):
                continue
            state = lldb.SBProcess.GetStateFromEvent(event)
            last_state = lldb.SBDebugger.StateAsCString(state)
            if state == lldb.eStateStopped:
                if lldb.SBProcess.GetRestartedFromEvent(event):
                    continue
                thread = next((t for t in process if t.GetStopReason() == lldb.eStopReasonBreakpoint and
                               any(t.GetStopReasonDataAtIndex(i) == bp.GetID() for i in range(0,t.GetStopReasonDataCount(),2))), None)
                if thread is not None:
                    break
                doc["stop_reasons"] = [str(t.GetStopDescription(180) or "") for t in list(process)[:3]]
                break
            if state in (lldb.eStateExited, lldb.eStateDetached, lldb.eStateCrashed):
                break
        doc["last_state"] = last_state
        doc["resolved_after_resume"] = bp.GetNumResolvedLocations()
        if thread is None:
            finish(doc,"not_hit","Breakpoint not reached before exit, another stop, or the 180-second execution limit.")
            return
        finish(doc,"inspecting","Breakpoint reached; reading its stack and local variables.")
        doc["thread_id"] = thread.GetThreadID()
        frames = []
        for i in range(min(thread.GetNumFrames(), 15)):
            f = thread.GetFrameAtIndex(i)
            entry = f.GetLineEntry()
            frames.append({"function":str(f.GetFunctionName() or "?")[:256],
                           "file":str(entry.GetFileSpec().GetFilename() or "")[:160], "line":entry.GetLine()})
        doc["frames"] = frames
        frame = thread.GetFrameAtIndex(0)
        variables = frame.GetVariables(True,True,False,True)
        locals_ = []
        for index in range(min(variables.GetSize(),32)):
            value = variables.GetValueAtIndex(index).GetNonSyntheticValue()
            raw = value.GetValue()
            if raw is None and value.GetTypeName() in {"Swift.Int", "Int"}:
                # Depending on the toolchain Swift.Int exposes its raw word as a field.
                word = value.GetChildMemberWithName("_value")
                if word.IsValid():
                    raw = str(word.GetValueAsSigned())
            locals_.append({"name":str(value.GetName() or "")[:120], "type":str(value.GetTypeName() or "")[:200],
                            "value":str(raw or "(structured or unavailable)")[:240]})
        doc["locals"] = locals_
        finish(doc,"hit","Breakpoint reached. Frame 0 and in-scope locals are recorded.")
    finally:
        if process.GetState() == lldb.eStateStopped:
            process.Detach()


def run(args):
    name,line = validate(args.spec, args.sources)
    if args.pid < 1 or not args.executable.is_file():
        raise ValueError("Simulator app PID or executable is missing.")
    doc = {"schema":"xcode-pocket-debug/v1", "breakpoint":{"file":name,"line":line}, "frames":[], "locals":[]}
    identity = Path("artifacts/build-identity.json")
    if identity.is_file():
        doc["identity"] = json.loads(identity.read_text())
        doc["repository"] = os.environ.get("GITHUB_REPOSITORY", "")
        project = json.loads(Path(doc["identity"]["project_path"]).read_text())
        # LLDB returns basenames. Ambiguous source names are never offered as jump targets.
        sources = {p:text for p,text in project["files"].items()
                   if p.endswith(".swift") and not p.startswith(("Tests/", "Resources/")) and isinstance(text,str)}
        doc["source_hashes"] = {p:hashlib.sha256(text.encode()).hexdigest() for p,text in sources.items()}

    dest = args.output.resolve()
    os.environ["POCKET_DEBUG_OUTPUT"] = str(dest)
    finish(doc,"starting","Starting debugger.")
    source = next(p for p in args.sources.rglob("*.swift") if p.name == name)
    env = {**os.environ, "POCKET_DEBUG_SOURCE":str(source.resolve()),"DEBUG_AT":args.spec,"POCKET_DEBUG_EXE":str(args.executable.resolve()),"POCKET_DEBUG_PID":str(args.pid)}
    cmd = ["xcrun","lldb","--no-lldbinit","--batch",
           "-o","settings set target.load-script-from-symbol-file false",
           "-o","script import runpy; runpy.run_path('native-build/debug_probe.py', run_name='pocket_lldb')"]
    try:
        process = subprocess.run(cmd,env=env,capture_output=True,text=True,timeout=270)
        result = json.loads(dest.read_text())
        if result["status"] in {"starting","armed","inspecting"}:
            finish(result,"error","Debugger finished without a result: "+(process.stderr or process.stdout)[-1200:])
    except subprocess.TimeoutExpired:
        result = json.loads(dest.read_text())
        if result["status"] in {"armed","starting","inspecting"}:
            phase = result["status"]
            finish(result, "error",
                   {"armed":"Debugger did not deliver a stop or timeout report.", "starting":"Debugger attach timed out.",
                    "inspecting":"Breakpoint reached, but debugger frame/locals inspection timed out."}[phase])
    except OSError as err:
        finish(doc,"error",str(err)[:600])
    result = json.loads(dest.read_text())
    transcript = [args.spec+" · "+result["status"],result["message"],"", "Frames"]
    transcript += [f"#{i} {f['function']} · {f['file']}:{f['line']}" for i,f in enumerate(result["frames"])]
    transcript.append("\nLocals")
    transcript += [f"{v['name']}: {v['type']} = {v['value']}" for v in result["locals"]]
    dest.with_suffix(".txt").write_text("\n".join(transcript)+"\n",encoding="utf-8")
    print("Debug probe:",result["status"])


if __name__ == "pocket_lldb":
    try:
        probe()
    except Exception as exc:
        result = json.loads(Path(os.environ["POCKET_DEBUG_OUTPUT"]).read_text())
        finish(result,"error",str(exc)[:1000])
elif __name__ == "__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("spec")
    parser.add_argument("--sources",type=Path)
    parser.add_argument("--pid",type=int)
    parser.add_argument("--executable",type=Path)
    parser.add_argument("--output",type=Path,default=Path("artifacts/preview/debug.json"))
    args=parser.parse_args()
    if args.pid is None:
        validate(args.spec,args.sources)
    else:
        run(args)
