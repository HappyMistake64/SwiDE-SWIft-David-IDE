// Exercise the exact self-contained HTML embedded in the IPA.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
(async () => {
  const browser = await chromium.launch({channel:"chrome", headless:true});
  try {
    const page = await browser.newPage({viewport:{width:393,height:852}, isMobile:true, hasTouch:true});
    const errors = [];
    page.on("pageerror", err => errors.push(err.message));
    await page.goto(pathToFileURL(process.argv[2]).href);
    const code = page.locator("#code");
    await page.waitForFunction(() => !!window.pocketIDE && document.querySelector("#code").value.includes("SwiftUI"));
    assert(await code.isVisible());
    await code.fill("import SwiftUI\n// Pocket smoke");
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#code").value.endsWith("Pocket smoke"));
    await page.locator('[data-view="project"]').first().click();
    assert(await page.locator("#tree").isVisible());
    assert((await page.locator("#tree").innerText()).includes("ContentView.swift"));
    await page.locator("#palette-open").click();
    await page.locator("#command-query").fill("sestav");
    assert((await page.locator("#command-list").innerText()).toLowerCase().includes("sestav"));
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
    await page.keyboard.press("Control+Shift+o");
    await page.locator("#command-query").fill("contentview.swift:2");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => window.pocketIDE.getActive()), "ContentView.swift");
    const cursor = await code.evaluate(el => [el.selectionStart, el.value.indexOf("\n") + 1]);
    assert.equal(cursor[0], cursor[1]);
    assert.deepEqual(errors, []);
    console.log("Mobile editor, persistent edit, project navigator and command search passed.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
