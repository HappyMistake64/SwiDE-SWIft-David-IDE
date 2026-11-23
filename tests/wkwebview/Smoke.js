// Body of WKWebView.callAsyncJavaScript, executed only by the separate simulator test app.
const assert = (condition, problem) => { if (!condition) throw Error(problem); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const id = name => document.getElementById(name);
const visible = el => {
  const bounds = el.getBoundingClientRect();
  return bounds.width > 0 && bounds.height > 0 && bounds.top < innerHeight &&
    bounds.bottom > 0 && getComputedStyle(el).visibility !== "hidden";
};
try {
  assert(document.title === "SwiDe", "Incorrect editor product name");
  assert(document.querySelector('meta[name="apple-mobile-web-app-title"]')?.content === "SwiDe",
    "Incorrect home screen web app name");
  assert(location.protocol === "file:", "Expected the native file origin");
  document.querySelector('[data-view="code"]').click();
  const code = id("code");
  assert(visible(code) && !code.disabled && !code.readOnly, "Swift editor not visible/editable");
  const name = window.pocketIDE.getActive();
  assert(name.endsWith(".swift") && code.value.includes("SwiftUI"), "Default Swift source missing");
  const marker = "// WKWebView native editor smoke";
  code.focus();
  code.setSelectionRange(code.value.length, code.value.length);
  code.setRangeText("\n" + marker, code.selectionStart, code.selectionEnd, "end");
  code.dispatchEvent(new Event("input", {bubbles:true}));
  assert(window.pocketIDE.getProject().files[name].endsWith(marker), "Edit absent from project model");
  const other = Object.keys(window.pocketIDE.getProject().files).find(path => path !== name);
  assert(other, "Missing second file");
  window.pocketIDE.openFile(other); window.pocketIDE.openFile(name);
  assert(code.value.endsWith(marker), "Edit lost switching files");

  id("btn-build").click();
  const field = id("connect-token"), connected = id("connection");
  if (field.closest("details")) field.closest("details").open = true;
  field.scrollIntoView({block:"center"});
  const fake = "qa-local-token-never-sent-outside";
  const repo = id("repo").value;
  let verified = 0;
  const nativeFetch = window.fetch;
  // Exercise the real connector constructor and the native WebKit fetch implementation.
  // A data URL returns a GitHub-shaped synthetic response without using a credential or network.
  window.fetch = function(url, options) {
    "use strict";
    assert(this === window, "Fetch received the wrong browser-global receiver");
    assert(String(url) === "https://api.github.com/repos/" + repo, "Unexpected request URL");
    assert(options.method === "GET" && options.headers.Authorization === "Bearer " + fake,
      "Incorrect token or request method");
    verified++;
    const body = JSON.stringify({full_name:repo, permissions:{push:true}});
    return Reflect.apply(nativeFetch, this, ["data:application/json;charset=utf-8," + encodeURIComponent(body)]);
  };
  try {
    field.value = fake; field.dispatchEvent(new Event("input", {bubbles:true}));
    id("check-access").click();
    for (let i=0; i<100 && id("check-access").disabled; i++) await wait(40);
    assert(verified === 1, "Mock repository verification was not performed once");
    assert(connected.dataset.connected === "true",
      "Token interaction failed: " + id("connection-status").textContent);
    assert(field.value === "", "Credential remained in the form");
    assert(Object.keys(localStorage).every(k => !String(localStorage.getItem(k)).includes(fake)), "Token persisted");
  } finally {
    window.fetch = nativeFetch;
  }
  document.querySelector('[data-view="project"]').click();
  const importAction = id("btn-device-import");
  const fileInput = document.querySelector("#device-files input[type=file]");
  assert(importAction && fileInput, "Navigator file import is unavailable");

  // The simulator exercises the UI route to its genuine HTML file input. Suppress
  // only the OS chooser and supply a FileList as if Files.app had returned it.
  let requestedChooser = false;
  fileInput.addEventListener("click", event => {
    event.preventDefault();
    requestedChooser = true;
  }, {once:true});
  importAction.click();
  assert(requestedChooser, "Navigator import action did not reach the file picker");
  const importedName = "ReceiptView.swift";
  const importedSource = 'import SwiftUI\n\nstruct ReceiptView: View {\n    var body: some View { Text("Účtenka") }\n}\n';
  const selection = new DataTransfer();
  selection.items.add(new File([importedSource], importedName, {type:"text/plain"}));
  fileInput.files = selection.files;
  fileInput.dispatchEvent(new Event("change", {bubbles:true}));
  for (let i=0; i<100 && window.pocketIDE.getActive() !== importedName; i++) await wait(40);
  const imported = window.pocketIDE.getProject().files;
  assert(imported[importedName] === importedSource && imported[name].endsWith(marker),
    "Imported file or previous edit missing: " + document.querySelector("#device-files [role=status]").textContent);
  const saved = JSON.parse(localStorage.getItem("xcode-pocket-standalone-v1"));
  assert(saved.project.files[importedName] === importedSource && saved.active === importedName,
    "Imported source or active file missing from saved project");
  const row = () => document.querySelector('#tree [data-path="ReceiptView.swift"]');
  document.querySelector('[data-view="project"]').click();
  assert(row(), "Imported Swift file missing from navigator");
  row().click();
  code.scrollIntoView({block:"center"});
  assert(visible(code) && code.value === importedSource, "Navigator did not open the imported Swift source");
  document.querySelector('[data-view="project"]').click();
  document.querySelector('.topbar [data-command="projects"]').click();
  id("show-archive-project").click();
  document.activeElement?.blur();
  window.scrollTo(0, 0);
  const zip = id("zip-workspace"), folder = id("zip-pick-folder");
  assert(zip && folder && typeof window.webkit?.messageHandlers?.importFolder?.postMessage === "function",
    "Missing ZIP workspace or native folder bridge");
  for (let i=0; i<100 && folder.disabled; i++) await wait(40);
  assert(!folder.disabled, "Native folder import did not initialize");
  folder.click();
  const zipFiles = zip.querySelector("select");
  const path = "Sources/Nested/Marker.swift";
  const option = label => Array.from(zipFiles.options).find(entry => entry.textContent === label);
  for (let i=0; i<250 && !option(path); i++) await wait(80);
  assert(option(path) && option("Empty/"),
    "Native folder snapshot lost a nested file or empty directory. " + zip.querySelector("[role=status]").textContent);
  zipFiles.value=option(path).value;
  zipFiles.dispatchEvent(new Event("change", {bubbles:true}));
  assert(zip.querySelector("textarea").value === "let nativeFolderMarker = 4817\n", "Folder Swift content mismatch");
  assert(window.pocketIDE.getProject().files[importedName] === importedSource, "Folder import replaced the separate Swift project");
  return {passed:true, nativeFolderReader:true, nativeFolderBridge:true, nativeFolderZIP:true,
    folderUISelection:"simulated delegate callback", rejectedFolderSymlink:true, editorName:document.title, engine:"WKWebView", origin:location.protocol, edited:name, requests:verified,
    tokenPersisted:false, simulatedGitHubResponse:true, importedFile:importedName,
    simulatedPickerSelection:true, persistedImportedSource:true, userAgent:navigator.userAgent};
} catch (err) {
  return {passed:false, error:String(err.message || err), origin:location.protocol};
}
