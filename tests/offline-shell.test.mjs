import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const root = new URL("../web/", import.meta.url);
const scope = "https://swide.example/editor/";

async function worker() {
  const handlers = {}, cachesByName = new Map();
  const cache = {
    files: new Map(),
    async addAll(requests) {
      for (const request of requests) {
        const name = request.url.slice(scope.length) || "index.html";
        this.files.set(request.url, await readFile(new URL(name, root), "utf8"));
      }
    },
    async match(request) { return this.files.get(request.url); }
  };
  const context = {
    URL, Request, caches:{
      async open(name) { cachesByName.set(name, cache); return cache; },
      async keys() { return [...cachesByName.keys()]; },
      async delete(name) { return cachesByName.delete(name); }
    },
    self:{registration:{scope}, skipWaiting(){}, clients:{claim(){}},
      addEventListener(type,handler) { handlers[type] = handler; }}
  };
  vm.runInNewContext(await readFile(new URL("sw.js", root), "utf8"), context);
  return {handlers, cache};
}

test("the installable offline shell includes every transitively imported private-build module", async()=>{
  const {handlers, cache} = await worker();
  let work;
  handlers.install({waitUntil(task) { work = task; }});
  await work;
  const html = cache.files.get(scope + "index.html");
  const pending = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match=>new URL(match[1], scope).href);
  const visited = new Set();
  while (pending.length) {
    const url = pending.pop();
    if (visited.has(url)) continue;
    visited.add(url);
    const code = cache.files.get(url);
    assert.ok(code, "Missing offline asset: " + url);
    for (const match of code.matchAll(/^\s*(?:import|export)\s+(?:[^'";]*?\bfrom\s*)?["'](\.{1,2}\/[^"']+)["']/gm)) {
      pending.push(new URL(match[1], url).href);
    }
  }
  assert(visited.has(scope+"app.mjs"));
  assert(visited.has(scope+"build-target.mjs"));
});

test("workflow API calls, temporary URLs and authenticated requests bypass the service worker", async()=>{
  const {handlers} = await worker();
  for (const request of [
    new Request("https://api.github.com/repos/user/app"),
    new Request("https://storage.example/download?signature=example"),
    new Request(scope+"index.html?private=1"),
    new Request(scope+"index.html", {headers:{Authorization:"Bearer synthetic"}})
  ]) {
    handlers.fetch({request, respondWith() { assert.fail("Private request was intercepted"); }});
  }
});

test("public editor workflows cannot accept legacy project upload dispatches", async()=>{
  const {readdir} = await import("node:fs/promises");
  const directory = new URL("../.github/workflows/", import.meta.url);
  const workflows = await readdir(directory);
  for (const legacy of ["pocket-ios.yml","pocket-original-xcode.yml","pocket-original-simulator.yml","pocket-language.yml"]) {
    assert(!workflows.includes(legacy), "Public source dispatcher returned: " + legacy);
  }
  for (const filename of workflows) {
    const yaml = await readFile(new URL(filename, directory),"utf8");
    if (yaml.includes("workflow_dispatch:")) {
      assert.doesNotMatch(yaml,/^\s+(?:source_sha|project_path|zip_path):/m,
        "Public dispatch accepts a user project in "+filename);
      assert.doesNotMatch(yaml,/\bpocket-builds\//, "Public regression uses a user snapshot in "+filename);
    }
  }
});
