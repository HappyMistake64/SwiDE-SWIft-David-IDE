// Keep source spans to change only an edited translation; unknown catalog data stays byte-for-byte intact.
function inspectJSON(source) {
  JSON.parse(source);
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:"]+/gy;
  let pos = 0;
  function token() {
    while (/\s/.test(source[pos] || "!")) pos++;
    tokens.lastIndex = pos;
    const match = tokens.exec(source);
    if (!match) throw Error("Neúplný katalog.");
    pos = tokens.lastIndex;
    return match[0];
  }
  function read(depth) {
    if (depth > 128) throw Error("Katalog obsahuje příliš hluboké vnoření.");
    const first = token(), start = pos - first.length;
    let fields;
    if (first === "{" || first === "[") {
      const object = first === "{", close = object ? "}" : "]";
      if (object) fields = new Map();
      while (/\s/.test(source[pos] || "!")) pos++;
      if (source[pos] === close) pos++;
      else for (;;) {
        let name;
        if (object) { name = JSON.parse(token()); token(); }
        const child = read(depth + 1);
        if (object) {
          if (fields.has(name)) throw Error("Katalog má duplicitní klíč. Bezpečná editace není možná.");
          fields.set(name, child);
        }
        if (token() === close) break;
      }
    }
    return {start, end:pos, fields, literal:first, string:first[0] === '"' ? JSON.parse(first) : undefined};
  }
  return read(0);
}

const field = (node, name) => node?.fields?.get(name);
function inspectCatalog(source) {
  const root = inspectJSON(source);
  const entries = field(root, "strings")?.fields;
  if (!entries || field(root,"version")?.string !== "1.0" || !field(root,"sourceLanguage")?.string) {
    throw Error("Podporován je String Catalog verze 1.0 s výchozím jazykem.");
  }
  return {entries, language:field(root,"sourceLanguage").string};
}

function simpleEntry(entry) {
  if (!entry?.fields || field(entry,"variations") || field(entry,"substitutions") ||
      (field(entry,"shouldTranslate") && field(entry,"shouldTranslate").literal !== "true")) return false;
  const loc = field(entry,"localizations");
  if (!loc) return true;
  if (!loc.fields) return false;
  return [...loc.fields.values()].every(value => {
    if (!value.fields || value.fields.size !== 1) return false;
    const unit = field(value,"stringUnit");
    return unit?.fields && field(unit,"value")?.string !== undefined &&
      (!field(unit,"state") || field(unit,"state").string !== undefined);
  });
}

function addMember(source, object, name, value) {
  const insertion = object.end - 1;
  const member = (object.fields.size ? "," : "") + JSON.stringify(name) + ":" + JSON.stringify(value);
  return source.slice(0,insertion) + member + source.slice(insertion);
}

export function writeTranslation(source, key, language, value) {
  const {entries} = inspectCatalog(source), entry = entries.get(key);
  if (!simpleEntry(entry)) throw Error("Tento klíč je vyloučen z překladu nebo má složitou strukturu.");
  if (typeof value !== "string" || typeof language !== "string" || !language.trim()) throw Error("Zadej jazyk překladu.");
  const original = field(entry,"localizations");
  const unit = {state:"translated", value};
  let locale;
  try { locale = Intl.getCanonicalLocales(language.trim())[0]; }
  catch { throw Error("Použij jazykový kód, například cs nebo en-GB."); }
  for (const name of original?.fields.keys() || []) {
    let existing;
    try { existing = Intl.getCanonicalLocales(name)[0]; } catch { existing = name; }
    if (existing === locale) { locale = name; break; }
  }
  if (!original) return addMember(source,entry,"localizations",{[locale]:{stringUnit:unit}});
  const localized = field(original,locale);
  if (!localized) return addMember(source,original,locale,{stringUnit:unit});
  const current = field(localized,"stringUnit");
  const val = field(current,"value"), state = field(current,"state");
  const changes = [];
  if (val.string !== value) changes.push([val.start,val.end,JSON.stringify(value)]);
  if (!state) changes.push([current.end-1,current.end-1,',"state":"translated"']);
  else if (state.string !== "translated") changes.push([state.start,state.end,'"translated"']);
  for (const [start,end,replacement] of changes.sort((a,b)=>b[0]-a[0])) {
    source = source.slice(0,start) + replacement + source.slice(end);
  }
  return source;
}

export function renderStringCatalog(container, source, commit) {
  container.replaceChildren();
  const node = (tag,text) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const legend = node("legend","Překlady · String Catalog");
  container.append(legend);
  let catalog;
  try { catalog = inspectCatalog(source); }
  catch (error) { container.append(node("p",error.message)); return; }
  if (!catalog.entries.size) { container.append(node("p","Katalog zatím neobsahuje klíče.")); return; }
  const select = node("select");
  for (const key of catalog.entries.keys()) select.append(new Option(key || "(prázdný klíč)",key));
  const label = (name, input) => { const wrap=node("label",name); wrap.append(input); return wrap; };
  const langs = node("select"), language = node("input"), text = node("textarea");
  language.autocapitalize = "off"; language.spellcheck = false; language.placeholder = "cs";
  const save = node("button","Uložit překlad"); save.type = "button";
  const message = node("p"); message.setAttribute("role","status");
  const inputs = node("div"); inputs.className = "group-body";
  inputs.append(label("Překlad",langs),label("Jazyk",language),label("Hodnota",text),save);
  container.append(node("p","Výchozí jazyk: " + catalog.language),label("Klíč",select),inputs,message);
  const refreshLocale = () => {
    const entry = catalog.entries.get(select.value);
    const locale = langs.selectedIndex > 0 ? langs.value : "";
    language.value = locale;
    language.readOnly = !!locale;
    text.value = field(field(field(field(entry,"localizations"),locale),"stringUnit"),"value")?.string || "";
  };
  function refreshKey() {
    const entry = catalog.entries.get(select.value);
    const supported = simpleEntry(entry);
    inputs.hidden = !supported;
    if (!supported) { message.textContent = "Klíč je vyloučen z překladu nebo obsahuje složité varianty. Při exportu se zachová."; return; }
    langs.replaceChildren(new Option("Přidat jazyk",""));
    for (const key of field(entry,"localizations")?.fields.keys() || []) langs.append(new Option(key,key));
    langs.selectedIndex = langs.options.length > 1 ? 1 : 0;
    message.textContent = ""; refreshLocale();
  }
  select.addEventListener("change",refreshKey); langs.addEventListener("change", refreshLocale);
  save.addEventListener("click", () => {
    try {
      const name = language.value.trim();
      const next = writeTranslation(source,select.value,name,text.value);
      commit(next); source = next; catalog = inspectCatalog(next);
      refreshKey();
      const canonical = Intl.getCanonicalLocales(name)[0];
      const choice = [...langs.options].find(o => {
        try { return o.value && Intl.getCanonicalLocales(o.value)[0] === canonical; } catch { return false; }
      });
      if (choice) langs.value = choice.value;
      refreshLocale(); message.textContent = "Překlad je součástí upraveného projektu.";
    } catch (error) { message.textContent = error.message; }
  });
  refreshKey();
}
