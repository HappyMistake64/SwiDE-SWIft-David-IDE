import test from "node:test";
import assert from "node:assert/strict";
import {folderSelectionToZip,nativeFolderToZip} from "../web/folder-import.mjs";
import {exportZipWorkspace as pack,openZipWorkspace} from "../web/zip-workspace.mjs";

function crc32(bytes) {
  let value=0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let i=0; i<8; i++) value=(value>>>1)^((value&1)?0xedb88320:0);
  }
  return (value^0xffffffff)>>>0;
}
function fixture(path,data="test") {
  const file=new File([data],path.split("/").at(-1));
  Object.defineProperty(file,"webkitRelativePath",{value:path});return file;
}
async function open(file) {return openZipWorkspace(new Uint8Array(await file.arrayBuffer()));}
test("browser folder packages nested project and binary resources unchanged for actual ZIP reader",async()=>{
  const binary=new Uint8Array([0,0xff,3,9,166,0]);
  const archive=await folderSelectionToZip([fixture("Demo/Demo.xcodeproj/project.pbxproj"),fixture("Demo/Sources/Main.swift","\ufeffimport SwiftUI\r\n"),fixture("Demo/Resources/🟢.bin",binary)],pack,crc32);
  assert.equal(archive.name,"Demo.zip");
  const entries=await open(archive);
  assert.deepEqual(entries.map(e=>e.path),["Demo.xcodeproj/project.pbxproj","Sources/Main.swift","Resources/🟢.bin"]);
  assert.equal(entries[1].bom,true);assert.equal(entries[1].crlf,true);assert.deepEqual(entries[2].packed,binary);
});
test("directly selected Xcode package retains its required project/workspace suffix in archived path",async()=>{
  for(const [root,name] of [["Game.xcodeproj","project.pbxproj"],["Game.xcworkspace","contents.xcworkspacedata"]]) {
    const entries=await open(await folderSelectionToZip([fixture(root+"/"+name)],pack,crc32));
    assert.equal(entries[0].path,root+"/"+name);
  }
});
test("native folder preserves explicit empty folders, zero-length files, binary data and Unicode",async()=>{
  const selection={name:"Projekt",dirs:["Resources","Prázdná"],files:[{path:"Resources/picture.bin",base64:"AP8="},{path:"Empty.txt",base64:""}]};
  const entries=await open(await nativeFolderToZip(selection,pack,crc32));
  assert.deepEqual(entries.map(e=>e.path),["Resources/","Prázdná/","Resources/picture.bin","Empty.txt"]);
  assert.deepEqual([...entries[2].packed],[0,255]);assert.equal(entries[3].size,0);
});
test("native and browser reject duplicate names, traversal, mixed root, hierarchy conflicts and invalid base64",async()=>{
  for(const pair of [["Demo/Main","Demo/main"],["Demo/A","Demo/A/F"],["Demo/A/F","Demo/A"],["Demo/Images/A","Demo/images/B"],["Demo/../A","Demo/B"],["X/A","Y/B"]]){
    await assert.rejects(folderSelectionToZip(pair.map(p=>fixture(p)),pack,crc32));
  }
  await assert.rejects(folderSelectionToZip([new File(["x"],"NoPath.swift")],pack,crc32));
  await assert.rejects(nativeFolderToZip({name:"ok",dirs:["x"],files:[{path:"x",base64:""}]},pack,crc32));
  await assert.rejects(nativeFolderToZip({name:"ok",dirs:[],files:[{path:"x",base64:"!!!!"}]},pack,crc32));
});
test("checks batch and exact stored ZIP size before reading any bytes",async()=>{
  let reads=0;
  const f=(id,size)=>({name:id,webkitRelativePath:"P/"+id,size,arrayBuffer(){reads++;throw Error("unexpected");}});
  for(const files of [[f("large",11*1024**2)],[f("a",10*1024**2),f("b",10*1024**2)],Array(2001).fill(f("a",0))]) {
    await assert.rejects(folderSelectionToZip(files,pack,crc32));
  }
  assert.equal(reads,0);
});
