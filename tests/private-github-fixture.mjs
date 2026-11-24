// Test-only GitHub REST transport. Synthetic data and Git hashes never leave this process.
import {createHash} from "node:crypto";
import {TEMPLATE_BLOBS} from "../web/build-pins.mjs";

const hash = (data) => createHash("sha1").update(data).digest("hex");
const blobSHA = (bytes) => hash(Buffer.concat([Buffer.from("blob " + bytes.length + "\0"),bytes]));
const caller = "a".repeat(40), callerTree = "b".repeat(40);
const response = (data, status=200) => new Response(JSON.stringify(data), {status});
export function fixture() {
  const repo = "alice/private-app", user = {id:12,login:"alice"};
  const metadata = {id:23,owner:{...user,type:"User"},private:true,visibility:"private",full_name:repo,
    default_branch:"main",permissions:{push:true}};
  const workflow = {id:34,state:"active",path:".github/workflows/swide-build.yml"};
  const dirs = paths => {
    const folders = new Set();
    for (const path of paths) {
      const parts = path.split("/");
      for (let i=1; i<parts.length; i++) folders.add(parts.slice(0,i).join("/"));
    }
    return [...folders].map(path=>({path,type:"tree",mode:"040000",sha:hash(path)}));
  };
  const wrapper = Object.entries(TEMPLATE_BLOBS).map(([path,sha])=>({path,sha,type:"blob",mode:"100644"}));
  const state = {
    workflow, refs:new Map([["refs/heads/main",caller]]),
    commits:new Map([[caller,{sha:caller,tree:{sha:callerTree}}]]),
    trees:new Map([[callerTree,{sha:callerTree,truncated:false,tree:[...dirs(Object.keys(TEMPLATE_BLOBS)),...wrapper]}]]),
    blobs:new Map(),runs:[],artifacts:[],dispatchStatus:200
  };
  const calls = [];
  async function fetcher(url, options) {
    const base = "https://api.github.com/repos/" + repo;
    if (url !== "https://api.github.com/user" && !(url === base || url.startsWith(base+"/"))) {
      throw Error("Unexpected destination: " + url);
    }
    const path = url === "https://api.github.com/user" ? "/user" : url.slice(base.length);
    const method = options.method, body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({method,path,body,options});
    if (method === "GET") {
      if (path === "/user") return response(user);
      if (path === "") return response(metadata);
      if (path === "/actions/workflows/swide-build.yml") return response(workflow);
      if (path.startsWith("/git/ref/")) {
        const ref = "refs/" + path.slice(9);
        return state.refs.has(ref) ? response({ref,object:{type:"commit",sha:state.refs.get(ref)}}) : response({},404);
      }
      if (path.startsWith("/git/commits/")) return response(state.commits.get(path.slice(13)) || {}, state.commits.has(path.slice(13)) ? 200 : 404);
      if (path.startsWith("/git/trees/")) {
        const sha = path.slice(11).split("?")[0];
        return response(state.trees.get(sha) || {},state.trees.has(sha) ? 200 : 404);
      }
      if (path.includes("/runs?")) return response({workflow_runs:state.runs});
      if (path.includes("/artifacts?")) return response({artifacts:state.artifacts});
      if (path.startsWith("/actions/runs/")) {
        const run = state.runs.find(r=>r.id === Number(path.slice(14)));
        return response(run || {}, run ? 200 : 404);
      }
    }
    if (method === "POST" && path === "/git/trees") {
      const leaves = body.tree.map(({path,content,mode,type})=>{
        const bytes = Buffer.from(content), sha = blobSHA(bytes);
        state.blobs.set(sha,bytes);
        return {path,mode,type,sha,size:bytes.length};
      });
      const sha = hash(JSON.stringify(leaves));
      state.trees.set(sha,{sha,truncated:false,tree:[...dirs(leaves.map(e=>e.path)), ...leaves]});
      return response({sha},201);
    }
    if (method === "POST" && path === "/git/commits") {
      const sha = hash(JSON.stringify(body)), commit = {sha,tree:{sha:body.tree},parents:body.parents};
      state.commits.set(sha,commit);
      return response(commit,201);
    }
    if (method === "POST" && path === "/git/refs") {
      if (state.refs.has(body.ref)) return response({},422);
      state.refs.set(body.ref,body.sha);
      return response({ref:body.ref,object:{sha:body.sha,type:"commit"}},201);
    }
    if (method === "POST" && path.endsWith("/dispatches")) {
      return response({workflow_run_id:71},state.dispatchStatus);
    }
    throw Error("Unexpected request: " + method + " " + path);
  }
  return {repo,user,metadata,state,fetcher,calls,caller};
}
