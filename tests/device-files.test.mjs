import test from "node:test";
import assert from "node:assert/strict";
import {newProject} from "../web/core.mjs";
import {readDeviceFiles,mergeDeviceFiles} from "../web/device-files.mjs";

const fake = (name,data) => {
  const blob = new Blob([data]);
  return {name,size:blob.size,arrayBuffer:()=>blob.arrayBuffer()};
};
const gif = new Uint8Array([71,73,70,56,57,97,1,0,1,0,0,0,0]);
test("multi-file picker input handles Swift, UTF-8 text and raw bundled image in one project",async()=>{
  const project = newProject(), before=JSON.stringify(project);
  const items = await readDeviceFiles([fake("New.swift","let x=1"),fake("data.txt","žluťoučký\r\n"),fake("icon.gif",gif)],"",project);
  const next=mergeDeviceFiles(project,items);
  assert.equal(next.version,3);assert.equal(next.files["New.swift"],"let x=1");
  assert.equal(next.files["Resources/data.txt"],"žluťoučký\r\n");
  assert.deepEqual(next.binaries["Resources/icon.gif"],{mime:"image/gif",base64:Buffer.from(gif).toString("base64")});
  assert.equal(JSON.stringify(project),before);
});
test("custom nested destination and text-only imports preserve legacy schema",async()=>{
  const project=newProject();
  const items=await readDeviceFiles([fake("Tools.swift","\ufeffimport Foundation")],"Sources/Helpers");
  const next=mergeDeviceFiles(project,items);
  assert.equal(next.files["Sources/Helpers/Tools.swift"],"\ufeffimport Foundation");assert.equal(next.version,2);
  assert.ok(!Object.hasOwn(next,"binaries"));
  const image=await readDeviceFiles([fake("photo.gif",gif)],"Resources/Pictures");
  assert.equal(image[0].path,"Resources/Pictures/photo.gif");
});
test("conflicts, duplicate selection, oversized input and wrong destinations abort before reading",async()=>{
  const project=newProject();
  let reads=0;
  const f=(name,size=2)=>({name,size,arrayBuffer(){reads++;throw Error("unexpected read");}});
  for (const [files,folder] of [[[f("PocketApp.swift")],""],[[f("t.swift"),f("T.swift")],""],[[f("big.txt",4_000_001)],""],
      [[f("big.gif",3_000_001)],""],[[f("icon.gif")],"Sources"],[[f("t.swift")],"Resources/A"],
      [[f("t.txt")],"../foo"],[[f("a/b.swift")],""],[[f("photo.bmp")],""],[[f("x.txt",-1)],""]]) {
    await assert.rejects(readDeviceFiles(files,folder,project));
  }
  assert.equal(reads,0);
});
test("invalid UTF-8, invalid binary or conflicting Swift basename cannot partially import",async()=>{
  const p=newProject(), initial=JSON.stringify(p);
  await assert.rejects(readDeviceFiles([fake("good.swift","ok"),fake("bad.txt",new Uint8Array([255]))]));
  await assert.rejects(readDeviceFiles([fake("bad.plist",new Uint8Array([0]))]));
  const items=await readDeviceFiles([fake("good.swift","ok"),fake("bad.gif","not a GIF")]);
  assert.throws(()=>mergeDeviceFiles(p,items));
  const duplicate=await readDeviceFiles([fake("PocketApp.swift","override")],"Sources",p);
  assert.throws(()=>mergeDeviceFiles(p,duplicate));assert.equal(JSON.stringify(p),initial);
});
test("commit validation rechecks paths against additions made while files were read",async()=>{
  const p=newProject(), items=await readDeviceFiles([fake("Extra.swift","import SwiftUI")],"",p);
  p.files["Extra.swift"]="later edit";assert.throws(()=>mergeDeviceFiles(p,items));assert.equal(p.files["Extra.swift"],"later edit");
});
