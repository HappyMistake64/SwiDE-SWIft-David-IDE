import test from "node:test";
import assert from "node:assert/strict";
import {writeTranslation} from "../web/string-catalog.mjs";
import {openZipWorkspace,exportZipWorkspace} from "../web/zip-workspace.mjs";

const source = [
  '{',
  '  "sourceLanguage": "en",',
  '  "strings": {',
  '    "Save": {"comment":"Button","localizations":{"cs":{"stringUnit":{"state":"needs_review","value":"Save","metadata":90071992547409931}}}},',
  '    "Title": {},',
  '    "Count": {"localizations":{"en":{"variations":{"plural":{"one":{"stringUnit":{"value":"one"}}}}}}},',
  '    "Named": {"localizations":{"en":{"substitutions":{"amount":{}}}}}',
  '  },',
  '  "unknown": [[],true,null,1e+09],',
  '  "version": "1.0"',
  '}'
].join("\r\n");

test("edits exactly the unit state and value, leaves metadata, formatting and other entries intact", () => {
  const next = writeTranslation(source,"Save","CS","Uložit 📥");
  assert.equal(next,source.replace('"needs_review"','"translated"').replace('"value":"Save"','"value":"Uložit 📥"'));
  assert.equal(writeTranslation(next,"Save","cs","Uložit 📥"),next);
});
test("adds language on empty key and additional language without changing existing translations",() => {
  let next=writeTranslation(source,"Title","en-gb",'Start "now"');
  next=writeTranslation(next,"Title","cs","Začněte");
  const translations = JSON.parse(next).strings.Title.localizations;
  assert.deepEqual(translations["en-GB"].stringUnit,{state:"translated",value:'Start "now"'});
  assert.equal(translations.cs.stringUnit.value,"Začněte");
  assert.ok(next.includes('"metadata":90071992547409931'));
});
test("rejects complex entries, malformed catalog, duplicate properties and unknown schema",()=>{
  for(const key of ["Count","Named","no-such-key"]) assert.throws(()=>writeTranslation(source,key,"fr","x"));
  for(const raw of ["{",source.replace('"version": "1.0"','"version":"1.0","version":"1.0"'),source.replace('"version": "1.0"','"version":"2.0"')]){
    assert.throws(()=>writeTranslation(raw,"Save","fr","x"));
  }
  assert.throws(()=>writeTranslation(source,"Title","bad/locale","x"));
  assert.throws(()=>writeTranslation(source.replace('"Title": {}','"Title": {"shouldTranslate":false}'),"Title","cs","x"));
});
test("catalog string survives a genuine ZIP workspace export + reopen with BOM and CRLF intact",async()=>{
  const starter = [{path:"Test/Localizable.xcstrings", text:"", edit:source, bom:true, dir:false}];
  const original=await openZipWorkspace(new Uint8Array(await exportZipWorkspace(starter).arrayBuffer()));
  assert.equal(original[0].text,source);
  original[0].edit=writeTranslation(original[0].text,"Save","cs","Uložit");
  const edited=await openZipWorkspace(new Uint8Array(await exportZipWorkspace(original).arrayBuffer()));
  assert.equal(edited[0].text,original[0].edit);assert.ok(edited[0].bom);assert.ok(edited[0].crlf);
});

test("plural edits change only the selected locale and category, including transition to translated",()=>{
  const cats = ["zero","one","two","few","many","other"];
  const units = Object.fromEntries(cats.map(name=>[name,{stringUnit:{value:name,state:"needs_review"}}]));
  const catalog = {version:"1.0",sourceLanguage:"en",strings:{Count:{comment:"Do not remove",
    localizations:{cs:{variations:{plural:units}},en:{variations:{plural:units}}}}}};
  const raw = JSON.stringify(catalog,null,2).replace(/\n/g,"\r\n");
  for (const category of cats) {
    const next = writeTranslation(raw,"Count","cs","%lld položek",category);
    const expected = JSON.parse(raw);
    expected.strings.Count.localizations.cs.variations.plural[category].stringUnit = {value:"%lld položek",state:"translated"};
    assert.equal(next,JSON.stringify(expected,null,2).replace(/\n/g,"\r\n"));
  }
  assert.throws(()=>writeTranslation(raw,"Count","cs","ambiguous"));
  assert.throws(()=>writeTranslation(raw,"Count","cs","unsupported","device"));
  assert.throws(()=>writeTranslation(raw,"Count","fr","unknown","one"));
  assert.throws(()=>writeTranslation(source,"Save","cs","unsupported","one"));
});
test("plural edit preserves numeric metadata and refuses mixed device and substitution structures",()=>{
  const before = source.replace('"value":"one"','"x":90071992547409931,"value":"one"');
  const next = writeTranslation(before,"Count","en","one apple","one");
  assert.equal(next,before.replace('"value":"one"','"value":"one apple","state":"translated"'));
  for(const variation of ['"device":{}','"substitutions":{}']) {
    const mixed=source.replace('"plural":{"one":',variation+',"plural":{"one":');
    assert.throws(()=>writeTranslation(mixed,"Count","en","unsafe","one"));
  }
  assert.throws(()=>writeTranslation(source,"Count","en","absent","other"));
});
