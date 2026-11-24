import test from "node:test";
import assert from "node:assert/strict";
import {cursorPosition, findLanguageRun, validateLanguageResult} from "../web/language.mjs";

const request_id = "ed926b45-d341-451f-a87b-15d3ec7610a4", source_sha = "a".repeat(40);
const record = {request_id, source_sha, repo:"example/pocket", mode:"definition", file:"App.swift",
  position:{line:1, character:4}, sourceDigest:"e".repeat(64)};
const result = {schema:"pocket-sourcekit/v1",engine:"sourcekit-lsp",request_id,source_sha,mode:"definition",
  file:"App.swift",position:record.position,source_digest:record.sourceDigest,status:"empty",items:[]};
test("textarea cursor uses UTF-16, including CRLF and emoji", () => {
  assert.deepEqual(cursorPosition("first\r\n🍪foo",10),{line:1,character:3});
});
test("stale source, file, operation, position and UUID are rejected on import", () => {
  assert.equal(validateLanguageResult(result,record),result);
  for (const changed of [{source_digest:"wrong"},{source_sha:"b".repeat(40)},{request_id:"wrong"},
    {file:"Other.swift"},{mode:"completion"},{position:{line:1,character:3}},{engine:"keyword search"}])
    assert.throws(() => validateLanguageResult({...result,...changed},record));
});
test("downloads bind to exact run and SHA even if another commit becomes main",async()=>{
  const run = {id:45, display_title:"Pocket SourceKit "+request_id, path:".github/workflows/pocket-language.yml",
    event:"workflow_dispatch", head_branch:"main", head_sha:"f".repeat(40), repository:{full_name:record.repo},conclusion:"success"};
  const artifact = {id:52,name:"pocket-language-"+request_id+"-"+source_sha,workflow_run:{id:45}};
  const api = {repo:record.repo,request:async()=>({workflow_runs:[{...run,id:13,display_title:"Other"},run]}),
    artifacts:async()=>[{...artifact,id:88,workflow_run:{id:13}},artifact]};
  assert.match((await findLanguageRun(api,record)).artifact,/\/runs\/45\/artifacts\/52$/);
});

test("SourceKit offers only local search and historical imports, and opens without network access", async()=>{
  const {mountLanguageTools} = await import("../web/language.mjs");
  const nodes = [];
  const createElement = tag => {
    const node = {tag, children:[], listeners:{}, setAttribute(){}, replaceChildren(){},
      append(...children) { this.children.push(...children); },
      addEventListener(event, handler) { this.listeners[event] = handler; }};
    nodes.push(node); return node;
  };
  const editor = {selectionStart:0,selectionEnd:3,value:"Foo"};
  const previous = ["document","localStorage","pocketIDE"].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]);
  try {
    globalThis.document = {createElement,getElementById:()=>editor};
    Object.defineProperty(globalThis,"localStorage",{configurable:true,value:{getItem:()=>null}});
    globalThis.pocketIDE = {save(){}, getProject(){return {files:{"One.swift":"Foo()"}};},
      getAPI(){assert.fail("Local SourceKit search tried to open a remote connection");}};
    mountLanguageTools(createElement("div"));
    const buttons = nodes.filter(node=>node.tag==="button");
    assert.deepEqual(buttons.filter(node=>!node.hidden).map(node=>node.textContent),["Najít text lokálně"]);
    await buttons[0].listeners.click();
    assert(nodes.some(node=>node.textContent==="One.swift:1:1"));
  } finally {
    for (const [name,original] of previous) {
      if (original) Object.defineProperty(globalThis,name,original);
      else delete globalThis[name];
    }
  }
});
