// Exercise the same self-contained HTML that ships in the iPhone IPA.
const assert = require("node:assert/strict");
const {pathToFileURL} = require("node:url");
const {chromium} = require("playwright");

async function assertNoPageOverflow(page) {
  const widths = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth
  }));
  assert(widths.document <= widths.viewport + 1,
    `The ${widths.viewport}px layout expands to ${widths.document}px.`);
}

async function chooseSwiftFile(page, name, contents) {
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.locator("#btn-device-import").click()
  ]);
  await chooser.setFiles({name, mimeType:"text/plain", buffer:Buffer.from(contents)});
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {channel:"chrome"})
  });
  try {
    const page = await browser.newPage({viewport:{width:393,height:852}, isMobile:true, hasTouch:true});
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(pathToFileURL(process.argv[2]).href);
    const code = page.locator("#code");
    const tree = page.locator("#tree");
    const projectTab = page.locator('[data-view="project"]:visible').first();
    const sourceRow = name => tree.locator(`button[data-path="${name}"]`);

    await tree.waitFor({state:"visible"});
    await assertNoPageOverflow(page);
    assert.equal(await code.isVisible(), false);
    await sourceRow("ContentView.swift").click();
    assert(await page.locator("#navigator-preview").isVisible());
    assert.equal(await code.isVisible(), false);
    await page.locator("#open-selected-file").click();
    await code.waitFor({state:"visible"});
    assert.match(await code.inputValue(), /struct ContentView/);
    await code.fill("import SwiftUI\n// Pocket smoke");
    await page.reload();
    await page.waitForFunction(() => window.pocketIDE?.getProject().files["ContentView.swift"]?.endsWith("Pocket smoke"));

    await projectTab.click();
    const importedName = "DeviceFixture.swift";
    const original = "import Foundation\nlet deviceValue = 4817\n";
    await chooseSwiftFile(page, importedName, original);
    await page.waitForFunction(name => window.pocketIDE.getProject().files[name] !== undefined, importedName);
    await projectTab.click();
    await sourceRow(importedName).click();
    await page.locator("#open-selected-file").click();
    assert.equal(await code.inputValue(), original);
    await projectTab.click();
    const before = await page.evaluate(() => JSON.stringify(window.pocketIDE.getProject()));
    await chooseSwiftFile(page, importedName, "let overwritten = true\n");
    await page.waitForFunction(() => /soubor už existuje/i.test(document.querySelector("#device-files [role=status]")?.textContent || ""));
    assert.equal(await page.evaluate(() => JSON.stringify(window.pocketIDE.getProject())), before);
    await page.reload();
    await page.waitForFunction(() => Boolean(window.pocketIDE));
    assert.equal(await page.evaluate(name => window.pocketIDE.getProject().files[name], importedName), original);

    await page.locator("#palette-open").click();
    await page.locator("#command-query").fill("sestav");
    assert.match(await page.locator("#command-list").innerText(), /sestav/i);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+Shift+o");
    await page.locator("#command-query").fill("contentview.swift:2");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => window.pocketIDE.getActive()), "ContentView.swift");
    const cursor = await code.evaluate(el => [el.selectionStart, el.value.indexOf("\n") + 1]);
    assert.equal(cursor[0], cursor[1]);

    await page.setViewportSize({width:320,height:640});
    for (const name of ["project", "code", "preview", "console"]) {
      const tab = page.locator(`[data-view="${name}"]:visible`).first();
      await tab.click();
      assert(await page.locator(`[data-panel="${name}"]`).isVisible());
      await assertNoPageOverflow(page);
    }
    assert.deepEqual(errors, []);
    console.log("Project navigator, persistent editing, local import, collision handling, quick open and narrow navigation passed.");
  } finally {
    await browser.close();
  }
})().catch(error => {console.error(error); process.exitCode=1;});
