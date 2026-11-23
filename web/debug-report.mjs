import {sameRepository} from "./core.mjs";

const debugSpec = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}\.swift:[1-9][0-9]{0,5}$/;
const stringAtMost = (s,n) => typeof s === "string" && s.length <= n;
const positive = n => Number.isSafeInteger(n) && n > 0;

export function validateDebugReport(report, build) {
  const identity = report?.identity;
  if (!build || report?.schema !== "xcode-pocket-debug/v1" ||
      identity?.schema !== "xcode-pocket-build-identity/v1" ||
      identity.request_id !== build.request_id || identity.source_sha !== build.source_sha ||
      identity.project_path !== "pocket-builds/" + build.request_id + ".json" ||
      identity.workflow !== ".github/workflows/pocket-ios.yml" ||
      identity.workflow_run_id !== Number(build.run_id) || !positive(identity.workflow_attempt) ||
      identity.workflow_attempt !== Number(build.run_attempt) ||
      (report.repository !== undefined && !sameRepository(report.repository,build.repo)))
    throw Error("Report LLDB patří k jinému běhu nebo pokusu.");
  const spec = report.breakpoint?.file + ":" + report.breakpoint?.line;
  if (!debugSpec.test(spec) || !positive(report.breakpoint.line) || spec !== build.debugAt)
    throw Error("Breakpoint v reportu neodpovídá požadavku.");
  if (!["hit","not_hit","error"].includes(report.status) || !stringAtMost(report.message,2500) ||
      !Array.isArray(report.frames) || report.frames.length>15 || !Array.isArray(report.locals) || report.locals.length>32)
    throw Error("Neplatný výstup debuggeru.");
  for (const f of report.frames)
    if (!f || !stringAtMost(f.file,160) || !stringAtMost(f.function,256) || !Number.isSafeInteger(f.line) || f.line < 0)
      throw Error("Poškozený záznam zásobníku.");
  for (const l of report.locals)
    if (!l || !stringAtMost(l.name,120) || !stringAtMost(l.type,200) || !stringAtMost(l.value,240))
      throw Error("Poškozený záznam lokální proměnné.");
  if (report.source_hashes !== undefined && (!report.source_hashes || Array.isArray(report.source_hashes) ||
      typeof report.source_hashes !== "object" || Object.keys(report.source_hashes).length>200 ||
      Object.entries(report.source_hashes).some(([p,h]) => !stringAtMost(p,240)||typeof h !== "string"||!/^[a-f0-9]{64}$/.test(h))))
    throw Error("Neplatné otisky zdrojových souborů.");
  return report;
}

export function debugSourcePath(report, frame) {
  if (!positive(frame.line)) return null;
  const matches=Object.keys(report.source_hashes || {}).filter(p => p.split("/").at(-1) === frame.file);
  return matches.length===1 ? matches[0] : null;
}

export async function debugSourceOffset(report, frame, path, source) {
  if (!path || typeof source !== "string" || !globalThis.crypto?.subtle ||
      path !== debugSourcePath(report,frame)) throw Error("Zdroj tohoto rámce nelze přiřadit k otevřenému projektu.");
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(source));
  const hex=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,"0")).join("");
  if (hex !== report.source_hashes[path]) throw Error("Soubor byl od sestavení změněn.");
  const lines=source.split("\n");
  if (frame.line>lines.length) throw Error("Řádek je mimo rozsah zdrojového souboru.");
  return frame.line===1 ? 0 : lines.slice(0,frame.line-1).join("\n").length+1;
}

function mountDebugReport(panel) {
  const api=()=>window.pocketIDE;
  const make=(tag,text)=>{const n=document.createElement(tag); if(text!==undefined)n.textContent=text; return n;};
  const title=make("h3","Ladění LLDB"), field=make("label","Laděný běh "), select=make("select");
  field.append(select);
  const link=make("a","Stáhnout ZIP s reportem LLDB");
  link.target="_blank";link.rel="noopener noreferrer";
  const label=make("label","Otevřít rozbalený debug.json "), input=make("input");
  input.type="file";input.accept=".json,application/json";label.append(input);
  const message=make("p");message.setAttribute("role","status");
  const detail=make("div");
  panel.append(title,field,link,label,message,detail);
  const cache=new Map();
  const key=b=>[b.repo,b.run_id,b.run_attempt,b.request_id,b.source_sha,b.debugAt].join("|");
  const archive=b=>b.artifacts?.find(a=>a.name==="pocket-ios-logs-"+b.request_id && !a.expired && positive(a.id) &&
    (!a.workflow_run || a.workflow_run.id===Number(b.run_id)));
  const builds=()=>(api()?.getBuilds?.()||[]).filter(b=>debugSpec.test(b.debugAt) && positive(Number(b.run_id)) &&
    positive(Number(b.run_attempt)) && ["success","failed"].includes(b.stage) && /^[-\w.]+\/[-\w.]+$/.test(b.repo) && archive(b));
  const current=()=>builds().find(b=>key(b)===select.value);
  async function jump(report,frame,path) {
    const project=api().getProject(), source=project.files[path];
    const offset=await debugSourceOffset(report,frame,path,source);
    if (api().getProject()!==project || project.files[path]!==source || cache.get(select.value)!==report)
      throw Error("Aktivní projekt nebo běh se změnil.");
    api().openFile(path);
    document.querySelector('[data-view="code"]')?.click();
    const code=document.getElementById("code");code.focus();code.setSelectionRange(offset,offset);
    code.scrollTop=Math.max(0,(frame.line-1)*(parseFloat(getComputedStyle(code).lineHeight)||20)-code.clientHeight/3);
    code.dispatchEvent(new Event("select",{bubbles:true}));
  }
  function render() {
    const b=current(),report=b && cache.get(key(b));detail.replaceChildren();
    select.disabled=!b;input.disabled=!b;link.hidden=!b;
    if (!b) {link.removeAttribute("href");message.textContent="Čeká na dokončený běh se zadaným breakpointem.";return;}
    link.href="https://github.com/"+b.repo+"/actions/runs/"+b.run_id+"/artifacts/"+archive(b).id;
    if (!report) {message.textContent="V rozbaleném archivu s protokoly vyber debug.json.";return;}
    const states={hit:"Breakpoint zasažen",not_hit:"Breakpoint nebyl zasažen",error:"Chyba debuggeru"};
    message.textContent=states[report.status]+" · "+b.debugAt+" · běh #"+b.run_id+", pokus "+b.run_attempt+". "+report.message;
    if (report.status!=="hit") return;
    const stack=make("ol");
    for (const f of report.frames) {
      const row=make("li"), name=(f.file||"?")+":"+f.line, path=debugSourcePath(report,f);
      if (path) {
        const button=make("button",name);button.type="button";
        button.addEventListener("click",()=>jump(report,f,path).catch(e=>{message.textContent=e.message;}));row.append(button);
      } else row.append(document.createTextNode(name));
      row.append(document.createTextNode(" · "+f.function));stack.append(row);
    }
    detail.append(make("h4","Zásobník volání"),stack,make("h4","Lokální proměnné"));
    if (!report.locals.length) {detail.append(make("p","Pro tento rámec nejsou dostupné lokální proměnné."));return;}
    const locals=make("ul");
    for (const l of report.locals) locals.append(make("li",l.name+": "+l.type+" = "+l.value));
    detail.append(locals);
  }
  function refresh(){
    const prev=select.value,items=builds();
    select.replaceChildren(...items.map(b=>{const o=make("option","#"+b.run_id+" · "+b.debugAt);o.value=key(b);return o;}));
    if(items.some(b=>key(b)===prev))select.value=prev;
    render();
  }
  input.addEventListener("change",async()=>{
    const b=current(),file=input.files[0];input.value="";if(!b||!file)return;
    try{
      if(file.size>300000)throw Error("Report LLDB je příliš velký.");
      const report=validateDebugReport(JSON.parse(await file.text()),b);cache.set(key(b),report);render();
    }catch(e){message.textContent=e.message;}
  });
  select.addEventListener("change",render);window.addEventListener("pocket-builds",refresh);refresh();
}

if (typeof document !== "undefined") {
  const panel=document.getElementById("debug-report");if(panel)mountDebugReport(panel);
}
