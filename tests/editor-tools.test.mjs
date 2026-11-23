import assert from "node:assert/strict";
import test from "node:test";
import {newProject} from "../web/core.mjs";
import {renameSource, selectedIdentifier, foldableBlocks, snippetEdit} from "../web/editor-tools.mjs";

test("rename retains all other project state and latest editor buffer without mutation", () => {
  const p = newProject();
  const before = JSON.stringify(p);
  const next = renameSource(p, "PocketApp.swift", "Sources/Entry.swift", "import SwiftUI");
  assert.equal(JSON.stringify(p), before);
  assert.equal(next.files["Sources/Entry.swift"], "import SwiftUI");
  assert.equal(next.files["ContentView.swift"], p.files["ContentView.swift"]);
  assert.ok(!Object.hasOwn(next.files, "PocketApp.swift"));
});
test("rename rejects missing sources, collisions, traversal and file/directory conflicts atomically", () => {
  const p = newProject();
  const before = JSON.stringify(p);
  for (const path of ["ContentView.swift", "CONTENTVIEW.swift", "../file.swift", "ContentView.swift/Body.swift", "__proto__/path"]) {
    assert.throws(() => renameSource(p,"PocketApp.swift",path,"unchanged"));
  }
  assert.throws(() => renameSource(p,"Missing.swift","Good.swift",""));
  assert.equal(JSON.stringify(p), before);
});
test("documentation identifier respects Unicode, selection and punctuation", () => {
  const text = "let výsledek = VStack()";
  assert.equal(selectedIdentifier(text, 5, 5), "výsledek");
  assert.equal(selectedIdentifier(text, 15, 21), "VStack");
  assert.equal(selectedIdentifier(text, 13, 13), "");
  assert.equal(selectedIdentifier(text, 0, 14), "");
});
test("nested Swift blocks ignore raw and multiline strings, escaped quotes and nested comments", () => {
  const source = [
    "struct Demo {",
    '    let x = #"this } is literal"#',
    '    let multiline = """',
    '       { }',
    '    """',
    '    /* { /* } */ } */',
    '    func go() { // }',
    '        print("\\"}\\\"")',
    '    }',
    '}',
    'func unfinished() {'
  ].join("\n");
  assert.deepEqual([...foldableBlocks(source)], [[6,8],[0,9]]);
});
test("snippets indent each subsequent line and select the placeholder", () => {
  const edit = snippetEdit("if «condition» {\n    work()\n}", "    ");
  assert.equal(edit.text, "if condition {\n        work()\n    }");
  assert.equal(edit.text.slice(edit.start, edit.end), "condition");
});
