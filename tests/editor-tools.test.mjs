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

import {editSourceCommand} from "../web/editor-tools.mjs";
function run(command,text,start,end=start) {
  const edit=editSourceCommand(command,text,start,end);
  if (!edit) return undefined;
  return {text:edit.insert === undefined ? text : text.slice(0,edit.from)+edit.insert+text.slice(edit.to),
    start:edit.start,end:edit.end};
}
test("moves complete lines while preserving relative UTF-16 range and trailing newline",()=>{
  const text="first\n🚀 line\nžluť\nend\n";
  const start=text.indexOf("🚀"), end=text.indexOf("end");
  const moved=run("up",text,start,end);
  assert.equal(moved.text,"🚀 line\nžluť\nfirst\nend\n");
  assert.equal(moved.text.slice(moved.start,moved.end),"🚀 line\nžluť\n");
  assert.deepEqual(run("down",moved.text,moved.start,moved.end),{text,start,end});
  assert.equal(run("up",text,0),undefined);
  assert.equal(run("down",text,text.indexOf("end")),undefined);
  assert.equal(run("up",text,text.length),undefined);
});
test("moves a complete line selection to the unterminated last line without extending past EOF",()=>{
  assert.deepEqual(run("down","a\nb",0,2),{text:"b\na",start:2,end:3});
  assert.deepEqual(run("down","one\n\nthree",0),{text:"\none\nthree",start:1,end:1});
});
test("duplicate/delete match the selected characters or the current source line",()=>{
  assert.deepEqual(run("duplicate","a🚀b",1,3),{text:"a🚀🚀b",start:3,end:5});
  assert.deepEqual(run("delete","a🚀🚀b",3,5),{text:"a🚀b",start:3,end:3});
  assert.deepEqual(run("duplicate","ab\nc",1),{text:"ab\nab\nc",start:4,end:4});
  assert.deepEqual(run("delete","ab\nc",0),{text:"c",start:0,end:0});
  assert.deepEqual(run("delete","ab\nc",4),{text:"ab",start:2,end:2});
  assert.deepEqual(run("delete","ab\n",3),{text:"ab",start:2,end:2});
  assert.deepEqual(run("delete","x",1),{text:"",start:0,end:0});
  assert.equal(run("duplicate","",0),undefined);
});
test("Unicode casing returns actual range after character expansion and leaves unchanged selections alone",()=>{
  assert.deepEqual(run("upper","x straße!",2,8),{text:"x STRASSE!",start:2,end:9});
  assert.deepEqual(run("lower","Aİ!",1,2),{text:"Ai\u0307!",start:1,end:3});
  assert.deepEqual(run("capitalize","mALÝ ŘÁDEK",0,10),{text:"Malý Řádek",start:0,end:10});
  assert.equal(run("upper","AB",0,2),undefined);
  assert.equal(run("lower","ab",1),undefined);
});
test("balance uses innermost real Swift pair, expands nested selections and skips literals and comments",()=>{
  const text='[call(thing, #"}"#, /* [ */ ["🚀", 7])]';
  const cursor=text.indexOf("7"), innerStart=text.indexOf('["🚀"'), innerEnd=text.indexOf('])')+1;
  assert.deepEqual(run("balance",text,cursor),{text,start:innerStart,end:innerEnd});
  const outer=run("balance",text,innerStart,innerEnd);
  assert.equal(text.slice(outer.start,outer.end),text.slice(text.indexOf("("),text.indexOf(")")+1));
  assert.deepEqual(run("balance",text,outer.start,outer.end),{text,start:0,end:text.length});
  assert.equal(run("balance",text,0,text.length),undefined);
  for(const s of ["(a]", "a {", "a(/x[(]/)", 'foo("hi \\(f(")") )")']) assert.equal(run("balance",s,2),undefined);
});
