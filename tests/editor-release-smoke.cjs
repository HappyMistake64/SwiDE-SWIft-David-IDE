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

async function chooseDeviceFile(page, name, contents) {
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
    assert.equal(await page.title(), "SwiDe");
    assert.equal(await page.locator('meta[name="apple-mobile-web-app-title"]').getAttribute("content"), "SwiDe");
    const code = page.locator("#code");
    const tree = page.locator("#tree");
    const projectTab = page.locator('[data-view="project"]:visible').first();
    const sourceRow = name => tree.locator(`button[data-path="${name}"]`);

    await tree.waitFor({state:"visible"});
    await assertNoPageOverflow(page);
    assert.equal(await code.isVisible(), false);
    await sourceRow("ContentView.swift").click();
    await code.waitFor({state:"visible"});
    assert.match(await code.inputValue(), /struct ContentView/);
    await code.fill("import SwiftUI\n// Pocket smoke");
    await page.reload();
    await page.waitForFunction(() => window.pocketIDE?.getProject().files["ContentView.swift"]?.endsWith("Pocket smoke"));

    await projectTab.click();
    const importedName = "DeviceFixture.swift";
    const original = "import Foundation\nlet deviceValue = 4817\n";
    await chooseDeviceFile(page, importedName, original);
    await page.waitForFunction(name => window.pocketIDE.getProject().files[name] !== undefined, importedName);
    await projectTab.click();
    await sourceRow(importedName).click();
    assert.equal(await code.inputValue(), original);
    await projectTab.click();
    const before = await page.evaluate(() => JSON.stringify(window.pocketIDE.getProject()));
    await chooseDeviceFile(page, importedName, "let overwritten = true\n");
    await page.waitForFunction(() => /soubor už existuje/i.test(document.querySelector("#device-files [role=status]")?.textContent || ""));
    assert.equal(await page.evaluate(() => JSON.stringify(window.pocketIDE.getProject())), before);
    await page.reload();
    await page.waitForFunction(() => Boolean(window.pocketIDE));
    assert.equal(await page.evaluate(name => window.pocketIDE.getProject().files[name], importedName), original);

    await page.getByRole("button",{name:"Více",exact:true}).click();
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
    assert.deepEqual(await page.locator(".activity-rail button").allTextContents(), ["Soubory","Editor","Sestavení","Více"]);
    for (const name of ["project", "code", "console"]) {
      const tab = page.locator(`[data-view="${name}"]:visible`).first();
      await tab.click();
      assert(await page.locator(`[data-panel="${name}"]`).isVisible());
      await assertNoPageOverflow(page);
    }
    await page.locator("#btn-build").click();
    assert(await page.locator("#connect-token").isVisible());
    await page.getByRole("button",{name:"Více",exact:true}).click();
    await page.getByRole("button",{name:"Náhled v simulátoru",exact:true}).click();
    assert(await page.locator('[data-panel="preview"]').isVisible());
    await assertNoPageOverflow(page);
    const {exportZipWorkspace} = await import("../web/zip-workspace.mjs");
    const saveSource = "let reopened = 4817\n";
    const zip = exportZipWorkspace([{path:"Sources/Fixture.swift", edit:saveSource, mode:0o644, date:33, time:0}]);
    await projectTab.click();
    await chooseDeviceFile(page,"Fixture.zip",await zip.arrayBuffer());
    const zipCode = page.locator('#zip-workspace textarea');
    await zipCode.waitFor({state:"visible"});
    assert.equal(await zipCode.inputValue(), saveSource);
    await zipCode.fill("let reopened = 4818\n");
    assert.equal(await page.locator("#archive-title").textContent(), "Fixture.zip");
    await page.locator("#btn-build").click();
    assert(await page.locator("#zip-build").isVisible());
    assert.equal(await page.locator("#connect-token").isVisible(),false);
    assert.equal(await page.locator('[data-view="console"]').getAttribute("aria-current"),"page");
    await page.locator("#save-current").click();
    await page.getByText("Projekt byl uložen na tomto zařízení.").waitFor();
    await page.locator("#zip-close").click();
    await page.locator("#zip-reopen").waitFor({state:"visible"});
    await page.reload();
    await page.locator("#zip-reopen").click();
    await zipCode.waitFor({state:"visible"});
    assert.equal(await zipCode.inputValue(), "let reopened = 4818\n");

    await page.getByRole("button",{name:"Projekty",exact:true}).click();
    await page.locator("#show-standard-project").click();
    await page.locator("#file-actions").click();
    await page.getByRole("button",{name:"Uložit nebo zavřít projekt SwiDe"}).click();
    await page.locator("#project-session").getByRole("button",{name:"Uložit projekt"}).click();
    await page.locator("#project-session").getByRole("button",{name:"Zavřít projekt"}).click();
    await page.locator("#project-start-screen").waitFor({state:"visible"});
    await page.reload();
    await page.locator("#project-start-screen").getByRole("button",{name:"Znovu otevřít projekt"}).click();
    await tree.waitFor({state:"visible"});
    assert.equal(await page.evaluate(name=>window.pocketIDE.getProject().files[name],importedName),original);

    // Load the native HTML with the exact storage contract used before the rename.
    const upgrade = await browser.newPage({viewport:{width:393,height:852}, isMobile:true, hasTouch:true});
    upgrade.on("pageerror", error => errors.push(error.message));
    const oldProject = {
      project:{format:"xcode-pocket-project", version:2, files:{"Original.swift":"let retained = 4817\n"}},
      active:"Original.swift", builds:[],
      settings:{appName:"MyExistingApp", bundleId:"cz.example.existingproject", repo:"HappyMistake64/Xcode-for-iphone"}
    };
    await upgrade.addInitScript(initial => {
      if (!localStorage.getItem("xcode-pocket-standalone-v1")) {
        localStorage.setItem("xcode-pocket-standalone-v1", JSON.stringify(initial));
      }
    }, oldProject);
    await upgrade.goto(pathToFileURL(process.argv[2]).href);
    await upgrade.waitForFunction(() => Boolean(window.pocketIDE));
    assert.equal(await upgrade.evaluate(() => window.pocketIDE.getActive()), oldProject.active);
    assert.deepEqual(await upgrade.evaluate(() => window.pocketIDE.getProject()), oldProject.project);
    assert.equal(await upgrade.locator("#ide-title").textContent(), oldProject.settings.appName);
    assert.equal(await upgrade.locator("#repo").inputValue(), "HappyMistake64/SwiDE-SWIft-David-IDE");
    await upgrade.close();
    assert.deepEqual(errors, []);
    console.log("Project navigator, persistent editing, local import, collision handling, quick open and narrow navigation passed.");
  } finally {
    await browser.close();
  }
})().catch(error => {console.error(error); process.exitCode=1;});
