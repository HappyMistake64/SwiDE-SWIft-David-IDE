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

const pluralForms = new Set(["zero","one","two","few","many","other"]);

function simpleUnit(localized) {
  if (!localized?.fields || localized.fields.size !== 1) return false;
  const unit = field(localized,"stringUnit");
  return unit?.fields && field(unit,"value")?.string !== undefined &&
    (!field(unit,"state") || field(unit,"state").string !== undefined);
}

function pluralUnits(localized) {
  if (localized?.fields?.size !== 1) return undefined;
  const variations = field(localized,"variations");
  if (variations?.fields?.size !== 1) return undefined;
  const units = field(variations,"plural")?.fields;
  return units?.size && [...units].every(([form,item]) => pluralForms.has(form) && simpleUnit(item))
    ? units : undefined;
}

function entryKind(entry) {
  if (!entry?.fields || field(entry,"variations") || field(entry,"substitutions") ||
      (field(entry,"shouldTranslate") && field(entry,"shouldTranslate").literal !== "true")) return undefined;
  const loc = field(entry,"localizations");
  if (!loc) return "simple";
  if (!loc.fields) return undefined;
  let kind = "simple";
  for (const localized of loc.fields.values()) {
    if (simpleUnit(localized)) continue;
    if (!pluralUnits(localized)) return undefined;
    kind = "plural";
  }
  return kind;
}

function addMember(source, object, name, value) {
  const insertion = object.end - 1;
  const member = (object.fields.size ? "," : "") + JSON.stringify(name) + ":" + JSON.stringify(value);
  return source.slice(0,insertion) + member + source.slice(insertion);
}

export function writeTranslation(source, key, language, value, form = "") {
  const {entries} = inspectCatalog(source), entry = entries.get(key);
  const kind = entryKind(entry);
  if (!kind) throw Error("Tento klíč je vyloučen z překladu nebo má složitou strukturu.");
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
  if ((form || kind === "plural") && !field(original,locale)) throw Error("Pro množná čísla vyber existující jazyk a tvar.");
  if (!original) return addMember(source,entry,"localizations",{[locale]:{stringUnit:unit}});
  const localized = field(original,locale);
  if (!localized) return addMember(source,original,locale,{stringUnit:unit});
  const units = pluralUnits(localized);
  if ((units && !units.has(form)) || (!units && form)) throw Error("Vyber existující tvar množného čísla.");
  const current = field(units ? units.get(form) : localized,"stringUnit");
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
  const forms = node("select");
  const formLabel = label("Tvar množného čísla",forms);
  inputs.append(label("Překlad",langs),label("Jazyk",language),formLabel,label("Hodnota",text),save);
  container.append(node("p","Výchozí jazyk: " + catalog.language),label("Klíč",select),inputs,message);
  function refreshValue() {
    const loc = field(field(catalog.entries.get(select.value),"localizations"),langs.value);
    const unit = field(formLabel.hidden ? loc : pluralUnits(loc)?.get(forms.value),"stringUnit");
    text.value = field(unit,"value")?.string || "";
  }
  function refreshLocale() {
    const entry = catalog.entries.get(select.value);
    language.value = langs.value;
    language.readOnly = !!langs.value;
    const units = pluralUnits(field(field(entry,"localizations"),langs.value));
    formLabel.hidden = !units;
    forms.replaceChildren(...[...(units?.keys() || [])].map(form => new Option(form,form)));
    refreshValue();
  }
  function refreshKey() {
    const entry = catalog.entries.get(select.value);
    const kind = entryKind(entry);
    inputs.hidden = !kind;
    if (!kind) { message.textContent = "Klíč je vyloučen z překladu nebo obsahuje složité varianty. Při exportu se zachová."; return; }
    langs.replaceChildren();
    if (kind === "simple") langs.append(new Option("Přidat jazyk",""));
    for (const key of field(entry,"localizations")?.fields.keys() || []) langs.append(new Option(key,key));
    langs.selectedIndex = kind === "simple" && langs.options.length > 1 ? 1 : 0;
    message.textContent = ""; refreshLocale();
  }
  forms.addEventListener("change",refreshValue);
  select.addEventListener("change",refreshKey); langs.addEventListener("change", refreshLocale);
  save.addEventListener("click", () => {
    try {
      const name = language.value.trim();
      const form = formLabel.hidden ? "" : forms.value;
      const next = writeTranslation(source,select.value,name,text.value,form);
      commit(next); source = next; catalog = inspectCatalog(next);
      refreshKey();
      const canonical = Intl.getCanonicalLocales(name)[0];
      const choice = [...langs.options].find(o => {
        try { return o.value && Intl.getCanonicalLocales(o.value)[0] === canonical; } catch { return false; }
      });
      if (choice) langs.value = choice.value;
      refreshLocale();
      if (form) { forms.value = form; refreshValue(); }
      message.textContent = "Překlad je součástí upraveného projektu.";
    } catch (error) { message.textContent = error.message; }
  });
  refreshKey();
}
