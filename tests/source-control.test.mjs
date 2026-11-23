import test from "node:test";
import assert from "node:assert/strict";
import {changedFiles, lineDiff, restoreFile} from "../web/source-control.mjs";

test("text statuses include empty additions and deletions", () => {
  assert.deepEqual(changedFiles({x:"", z:"a", t:"same"}, {y:"", z:"b", t:"same"}), [
    {path:"x",status:"deleted"}, {path:"y",status:"added"}, {path:"z",status:"modified"}
  ]);
});

test("edits separated by unchanged lines are counted and located independently", () => {
  const diff = lineDiff("a\nb\nc\nd\n", "a\nB\nc\nD\n");
  assert.equal(diff.coarse, false);
  assert.deepEqual(diff.rows.map(row => [row.kind,row.number,row.text]), [
    ["removed",2,"b\n"],["added",2,"B\n"],["removed",4,"d\n"],["added",4,"D\n"]
  ]);
  assert.equal(diff.added, 2); assert.equal(diff.removed, 2);
});

test("preserves empty files, final newline differences and CRLF", () => {
  assert.equal(lineDiff("", "").rows.length, 0);
  assert.equal(lineDiff("", "\n").added, 1);
  assert.equal(lineDiff("text","text\n").removed,1);
  assert.deepEqual(lineDiff("x\r\n","x\n").rows.map(row=>row.text),["x\r\n","x\n"]);
});

test("large differences use bounded rendering and retain change totals", () => {
  const diff=lineDiff("aaa\n".repeat(17000),"bbb\n".repeat(17000),8);
  assert.equal(diff.coarse,true);assert.equal(diff.truncated,true);
  assert.equal(diff.rows.length,8);assert.equal(diff.added,17000);assert.equal(diff.removed,17000);
});

test("restoring one file retains current metadata and unrelated edits", () => {
  const current={files:{"src.swift":"edit","new.txt":"extra"},binaries:{"img":"x"},dirs:["dir"]};
  const base={"src.swift":"initial","gone.md":"recovered"};
  assert.deepEqual(restoreFile(current,base,"src.swift"),{...current,files:{"src.swift":"initial","new.txt":"extra"}});
  assert.deepEqual(restoreFile(current,base,"new.txt").files,{"src.swift":"edit"});
  assert.equal(restoreFile(current,base,"gone.md").files["gone.md"],"recovered");
  assert.equal(current.files["src.swift"],"edit");
});
