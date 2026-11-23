// Inspect a report exported with the build logs; keep it bound to its verified run.
(() => {
  const panel = document.getElementById("issues");
  if (!panel) return;
  const api = () => window.pocketIDE;
  const make = (tag, text) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const picker = make("select");
  const label = make("label", "Sestavení ");
  label.append(picker);
  const link = make("a", "Stáhnout protokoly a report (ZIP)");
  link.target = "_blank"; link.rel = "noopener noreferrer";
  const help = make("p", "Rozbal ZIP s protokoly sestavení a otevři soubor pocket-issues.json.");
  const importLabel = make("label", "Otevřít výsledky ");
  const input = make("input");
  input.type = "file"; input.accept = ".json,application/json"; importLabel.append(input);
  const summary = make("p");
  summary.setAttribute("role", "status");
  const list = make("ul");
  panel.append(label, link, help, importLabel, summary, list);
  // Match the same logs artifact exposed by the verified build card.
  function logs(build) {
    return build.artifacts?.find(a => a.name === "pocket-ios-logs-" + build.request_id &&
      !a.expired && Number.isSafeInteger(a.id) && a.id > 0 &&
      (!a.workflow_run || Number(a.workflow_run.id) === Number(build.run_id)));
  }
  function key(b) { return [b.repo,b.run_id,b.run_attempt,b.request_id,b.source_sha].join("|"); }
  const available = () => (api()?.getBuilds?.() || []).filter(b =>
    ["failed","success","missing"].includes(b.stage) && b.source_sha && Number.isSafeInteger(Number(b.run_id)) &&
    Number(b.run_id)>0 && /^[-\w.]+\/[-\w.]+$/.test(b.repo) && logs(b));
  const reports = new Map();
  function selected() { return available().find(b => key(b) === picker.value); }
  function validate(report, build) {
    const i = report?.identity;
    if (report?.schema !== "xcode-pocket-issues/v1" || report.repository !== build.repo ||
      i?.schema !== "xcode-pocket-build-identity/v1" || i.request_id !== build.request_id ||
      i.source_sha !== build.source_sha || i.workflow_run_id !== Number(build.run_id) ||
      i.workflow !== ".github/workflows/pocket-ios.yml" || i.project_path !== "pocket-builds/"+build.request_id+".json" ||
      !Number.isSafeInteger(i.workflow_attempt) || i.workflow_attempt < 1 ||
      (build.run_attempt != null && i.workflow_attempt !== Number(build.run_attempt))) throw Error("Report patří k jinému sestavení nebo pokusu.");
    if (!report.tests || !Array.isArray(report.diagnostics) || report.diagnostics.length > 250 ||
      !report.file_hashes || typeof report.file_hashes !== "object") throw Error("Neplatný formát diagnostiky.");
    for (const item of report.diagnostics) {
      if (!item || typeof item.path !== "string" || item.path.length > 240 || !Object.prototype.hasOwnProperty.call(report.file_hashes,item.path) ||
        !/^[0-9a-f]{64}$/.test(report.file_hashes[item.path]) || !["warning","error","note"].includes(item.severity) ||
        !Number.isSafeInteger(item.line) || item.line < 1 || !Number.isSafeInteger(item.column) || item.column < 1 ||
        typeof item.message !== "string" || item.message.length > 1600) throw Error("Poškozený záznam diagnostiky.");
    }
    return report;
  }
  async function jump(report, item) {
    const project = api().getProject();
    const source = project.files[item.path];
    if (typeof source !== "string") throw Error("Soubor v otevřeném projektu chybí.");
    if (!window.crypto?.subtle) throw Error("Pro přesný skok je nutné ověřit verzi souboru. Otevři editor v zabezpečeném kontextu.");
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
    const hex = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
    if (hex !== report.file_hashes[item.path] || api().getProject().files[item.path] !== source)
      throw Error("Soubor se od sestavení změnil. Uvedený řádek odpovídá uloženému commitu.");
    const lines = source.split("\n");
    if (item.line > lines.length) throw Error("Řádek je mimo rozsah souboru.");
    // Swift/Clang diagnostics use UTF-8 byte columns; textarea positions are UTF-16.
    const line = lines[item.line-1];
    let bytes = 1, chars = 0;
    const encoder = new TextEncoder();
    for (const ch of line) {
      const length = encoder.encode(ch).length;
      if (bytes + length > item.column) break;
      chars += ch.length; bytes += length;
    }
    const start = item.line === 1 ? 0 : lines.slice(0, item.line-1).join("\n").length + 1;
    api().openFile(item.path);
    document.querySelector('[data-view="code"]')?.click();
    const editor = document.getElementById("code");
    editor.focus(); editor.setSelectionRange(start+chars,start+chars);
    editor.scrollTop = Math.max(0, (item.line-1)*(parseFloat(getComputedStyle(editor).lineHeight)||20)-editor.clientHeight/3);
    editor.dispatchEvent(new Event("select",{bubbles:true}));
  }
  function display() {
    list.replaceChildren();
    const build = selected();
    picker.disabled = !build; input.disabled = !build; link.hidden = !build; help.hidden = !build;
    if (!build) { link.removeAttribute("href"); summary.textContent="Výsledky budou dostupné po dokončení sestavení s protokoly."; return; }
    link.href = "https://github.com/"+build.repo+"/actions/runs/"+Number(build.run_id)+"/artifacts/"+logs(build).id;
    const report = reports.get(key(build));
    if (!report) {summary.textContent="Čeká na import reportu tohoto běhu."; return;}
    const statuses={not_requested:"bez testů",success:"úspěch",failure:"selhání",skipped:"přeskočeno",cancelled:"zrušeno"};
    const counts = Object.entries({totalTestCount:"celkem",passedTests:"úspěšné",failedTests:"selhaly",skippedTests:"přeskočené",expectedFailures:"očekávaná selhání"})
      .filter(([name])=>Number.isSafeInteger(report.tests.counts?.[name]) && report.tests.counts[name]>=0)
      .map(([name,label])=>label+" "+report.tests.counts[name]);
    summary.textContent="Běh #"+build.run_id+" · pokus "+report.identity.workflow_attempt+" · commit "+build.source_sha.slice(0,8)+
      ". XCTest: "+(statuses[report.tests.status] || "stav nezjištěn")+(counts.length?" ("+counts.join(", ")+")":"")+
      ". Zdrojové diagnostiky: "+report.diagnostics.length+(report.truncated?" (zkráceno)":"")+".";
    for (const item of report.diagnostics) {
      const li=make("li"), location=make("button",item.path+":"+item.line+":"+item.column);
      location.type="button"; location.addEventListener("click",()=>jump(report,item).catch(e=>{summary.textContent=e.message;}));
      li.append(location,document.createTextNode(" "+item.severity+" · "+item.message)); list.append(li);
    }
  }
  function refresh() {
    const previous=picker.value, builds=available();
    picker.replaceChildren(...builds.map(b=>{
      const o=make("option","#"+b.run_id+" · "+(b.appName||"Projekt")+" · "+b.source_sha.slice(0,8)); o.value=key(b); return o;
    }));
    if (builds.some(b=>key(b)===previous)) picker.value=previous;
    display();
  }
  input.addEventListener("change",async()=>{
    const file=input.files[0], build=selected(); input.value="";
    if (!file || !build) return;
    try {
      if (file.size>3500000) throw Error("Report je příliš velký (maximum 3,5 MB).");
      const data=validate(JSON.parse(await file.text()),build);
      reports.set(key(build),data); display();
    } catch(e){summary.textContent=e.message;}
  });
  picker.addEventListener("change",display);
  window.addEventListener("pocket-builds",refresh);
  refresh();
})();
