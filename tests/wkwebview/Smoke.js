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

  document.querySelector('[data-view="project"]').click();
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
  document.querySelector('[data-view="code"]').click(); code.scrollIntoView({block:"center"});
  return {passed:true, engine:"WKWebView", origin:location.protocol, edited:name, requests:verified,
    tokenPersisted:false, simulatedGitHubResponse:true, userAgent:navigator.userAgent};
} catch (err) {
  return {passed:false, error:String(err.message || err), origin:location.protocol};
}
