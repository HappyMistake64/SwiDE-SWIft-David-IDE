// Compare the editable text workspace. Binary resources and project metadata are kept on restore.
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const checkpointKey = "pocket-ide-checkpoint-v1";
const MAX_MATRIX_CELLS = 300000;
const MAX_PARSED_LINES = 30000;

export function changedFiles(before, after) {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return paths.flatMap(path => {
    if (!own(before, path)) return [{path, status:"added"}];
    if (!own(after, path)) return [{path, status:"deleted"}];
    return before[path] === after[path] ? [] : [{path, status:"modified"}];
  });
}

function lineCount(text) {
  let count = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) count++;
  return count + (text.length > 0 && !text.endsWith("\n") ? 1 : 0);
}

function* lines(text) {
  for (let start = 0; start < text.length;) {
    const separator = text.indexOf("\n", start);
    const next = separator === -1 ? text.length : separator + 1;
    yield text.slice(start, next);
    start = next;
  }
}

export function lineDiff(before, after, limit = 200) {
  const result = {added:0, removed:0, rows:[], coarse:false, truncated:false};
  if (before === after) return result;
  const n = lineCount(before), m = lineCount(after);
  function change(kind, number, text) {
    result[kind]++;
    if (result.rows.length < limit) result.rows.push({kind, number, text});
    else result.truncated = true;
  }
  if (n + m > MAX_PARSED_LINES) {
    result.coarse = n > 0 && m > 0;
    let i = 0;
    for (const line of lines(before)) change("removed", ++i, line);
    i = 0;
    for (const line of lines(after)) change("added", ++i, line);
    return result;
  }

  const old = [...lines(before)], next = [...lines(after)];
  let start = 0, a = n, b = m;
  while (start < a && start < b && old[start] === next[start]) start++;
  while (a > start && b > start && old[a - 1] === next[b - 1]) { a--; b--; }
  const height = a - start, width = b - start;
  if (!width || !height || (height + 1) * (width + 1) > MAX_MATRIX_CELLS) {
    result.coarse = width > 0 && height > 0;
    for (let i = start; i < a; i++) change("removed", i + 1, old[i]);
    for (let j = start; j < b; j++) change("added", j + 1, next[j]);
    return result;
  }

  // Bounded LCS over the changed middle preserves unchanged lines between separate edits.
  const stride = width + 1, table = new Uint16Array((height + 1) * stride);
  for (let i = height - 1; i >= 0; i--) {
    for (let j = width - 1; j >= 0; j--) {
      const at = i * stride + j;
      table[at] = old[start + i] === next[start + j] ? 1 + table[at + stride + 1]
        : Math.max(table[at + stride], table[at + 1]);
    }
  }
  let i = 0, j = 0;
  while (i < height || j < width) {
    if (i < height && j < width && old[start + i] === next[start + j]) { i++; j++; continue; }
    const at = i * stride + j;
    if (j === width || (i < height && table[at + stride] >= table[at + 1])) {
      change("removed", start + i + 1, old[start + i]); i++;
    } else {
      change("added", start + j + 1, next[start + j]); j++;
    }
  }
  return result;
}

export function restoreFile(project, baseline, path) {
  const files = {...project.files};
  if (own(baseline, path)) files[path] = baseline[path];
  else delete files[path];
  return {...project, files};
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function readCheckpoint() {
  try {
    const record = JSON.parse(localStorage.getItem(checkpointKey));
    if (record?.project?.files) return record;
  } catch {}
  return null;
}

function database() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("pocket-source-control-v1", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("snapshots");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function lastSubmission(db, record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("snapshots", record ? "readwrite" : "readonly");
    const store = tx.objectStore("snapshots");
    const request = record ? store.put(record, "submitted") : store.get("submitted");
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export function mountSourceControl(container, api) {
  const title = element("h2", "Změny souborů");
  const tools = element("div", undefined, "inline-actions");
  const select = element("select");
  select.setAttribute("aria-label", "Porovnat textové soubory s verzí");
  select.append(new Option("Poslední odeslaný snímek", "submitted"), new Option("Lokální kontrolní bod", "checkpoint"));
  const checkpoint = element("button", "Uložit kontrolní bod");
  checkpoint.type = "button";
  const refresh = element("button", "Obnovit přehled");
  refresh.type = "button";
  tools.append(select, checkpoint, refresh);
  const status = element("p", undefined, "small muted");
  const message = element("p"); message.setAttribute("role", "status");
  const list = element("div");
  container.replaceChildren(title, tools, status, message, list);
  let submitted = null, open = new Set(), timer, edits = 0;
  const db = database().catch(() => null);

  function render() {
    const baseline = select.value === "checkpoint" ? readCheckpoint() : submitted;
    list.replaceChildren();
    if (!baseline) {
      status.textContent = select.value === "checkpoint" ? "Ulož kontrolní bod pro porovnání dalších změn."
        : "První odeslaný snímek se zde uloží při odeslání projektu na GitHub.";
      return;
    }
    const base = baseline.project.files, live = api.getProject().files;
    const changes = changedFiles(base, live);
    const reference = baseline.sha ? "Commit " + baseline.sha.slice(0, 12) : "Kontrolní bod";
    status.textContent = reference + (baseline.date ? " · " + new Date(baseline.date).toLocaleString("cs-CZ") : "") +
      (changes.length ? " · Změněné textové soubory: " + changes.length : " · Textové soubory beze změn.");
    open = new Set(changes.map(change => change.path).filter(path => open.has(path)));
    for (const {path, status:kind} of changes) {
      const details = element("details");
      const summary = element("summary", {added:"Přidán", deleted:"Smazán", modified:"Změněn"}[kind] + " · " + path);
      details.append(summary);
      details.open = open.has(path);
      const show = () => {
        if (!details.open) { open.delete(path); return; }
        open.add(path);
        if (details.childElementCount > 1) return;
        const diff = lineDiff(own(base, path) ? base[path] : "", own(live, path) ? live[path] : "");
        details.append(element("div", "+" + diff.added + " / −" + diff.removed, "mono"));
        if (diff.coarse) details.append(element("small", "Velká změna je zobrazena jako náhrada celého úseku."));
        const rows = element("pre", undefined, "mono");
        rows.style.whiteSpace = "pre-wrap"; rows.style.overflowWrap = "anywhere";
        rows.textContent = diff.rows.map(({kind, number, text}) => {
          const source = text.endsWith("\n") ? text.slice(0, -1).replace(/\r$/, " ␍") : text + " ⟨bez konce řádku⟩";
          return (kind === "added" ? "+" : "−") + number + "  " +
            (source.length > 600 ? source.slice(0, 600) + "…" : source);
        }).join("\n");
        details.append(rows);
        if (diff.truncated) details.append(element("small", "Zobrazeno prvních " + diff.rows.length + " změněných řádků."));
        const buttons = element("div", undefined, "inline-actions");
        if (kind !== "deleted") {
          const edit = element("button", "Otevřít v editoru"); edit.type = "button";
          edit.onclick = () => { api.openFile(path); document.querySelector('[data-view="code"]')?.click(); };
          buttons.append(edit);
        }
        const restore = element("button", kind === "added" ? "Odebrat přidaný soubor" : "Obnovit soubor"); restore.type = "button";
        restore.onclick = () => {
          const question = kind === "added" ? "Odebrat přidaný soubor " + path + "?" : "Obnovit " + path + " na porovnávanou verzi?";
          if (!window.confirm(question)) return;
          const previous = api.getProject();
          const project = restoreFile(previous, base, path);
          try {
            api.setProject(project);
            message.textContent = "Změna vrácena: " + path;
          } catch (error) {
            // setProject can assign the new project before storage rejects an oversized write.
            if (api.getProject() === project) {
              try { api.setProject(previous); } catch {}
            }
            message.textContent = error.message;
          }
          render();
        };
        buttons.append(restore); details.append(buttons);
      };
      details.ontoggle = () => { if (list.contains(details)) show(); };
      list.append(details);
      if (details.open) show();
    }
  }
  select.onchange = () => { open.clear(); render(); };
  refresh.onclick = render;
  checkpoint.onclick = () => {
    if (readCheckpoint() && !window.confirm("Nahradit předchozí kontrolní bod aktuálním projektem?")) return;
    try {
      localStorage.setItem(checkpointKey, JSON.stringify({project:api.getProject(), path:api.getActive(), date:new Date().toISOString()}));
      select.value = "checkpoint"; message.textContent = "Kontrolní bod uložen.";
      window.dispatchEvent(new Event("pocket-checkpoint"));
    } catch { message.textContent = "Pro kontrolní bod není v zařízení dostupné úložiště."; }
  };
  window.addEventListener("pocket-committed", async event => {
    const {project, sha} = event.detail || {};
    if (!project?.files || !/^[a-f0-9]{40}$/i.test(sha)) return;
    const record = {project:{files:{...project.files}}, sha, date:new Date().toISOString()};
    submitted = record; edits++; select.value = "submitted"; render();
    try {
      const store = await db;
      if (!store) throw Error();
      await lastSubmission(store, record);
    } catch { message.textContent = "Odeslaný snímek je k porovnání jen do zavření editoru."; }
  });
  window.addEventListener("pocket-render", render);
  window.addEventListener("pocket-checkpoint", render);
  document.getElementById("code")?.addEventListener("input", () => {
    clearTimeout(timer); timer = setTimeout(render, 350);
  });
  render();
  db.then(store => store && lastSubmission(store)).then(record => {
    if (!edits && record?.project?.files) { submitted = record; render(); }
  }).catch(() => {});
}

if (typeof document !== "undefined") {
  const panel = document.getElementById("source-control");
  if (panel && window.pocketIDE) mountSourceControl(panel, window.pocketIDE);
}
