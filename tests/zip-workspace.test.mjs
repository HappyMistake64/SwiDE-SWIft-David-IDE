import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import {createServer} from "node:http";
import {createRequire} from "node:module";
import test from "node:test";
import {openZipWorkspace,exportZipWorkspace} from "../web/zip-workspace.mjs";

// Python zipfile fixture: deflated Swift with BOM/CRLF, binary resource and empty directory.
const original = Buffer.from("UEsDBBQAAAAIAKtod12zL5C+EQAAAA8AAAAUAAAAUG9ja2V0L0NvbnRlbnQuc3dpZnR7v3t/TmqJQqKCrYKJES8XAFBLAwQUAAAACACraHddLcfKTysBAAAADAAAFgAAAFBvY2tldC9Bc3NldHMvdGVzdC5iaW5jYGRiZmFlY+fg5OLm4eXjFxAUEhYRFROXkJSSlpGVk1dQVFJWUVVT19DU0tbR1dM3MDQyNjE1M7ewtLK2sbWzd3B0cnZxdXP38PTy9vH18w8IDAoOCQ0Lj4iMio6JjYtPSExKTklNS8/IzMrOyc3LLygsKi4pLSuvqKyqrqmtq29obGpuaW1r7+js6u7p7eufMHHS5ClTp02fMXPW7Dlz581fsHDR4iVLly1fsXLV6jVr163fsHHT5i1bt23fsXPX7j179+0/cPDQ4SNHjx0/cfLU6TNnz52/cPHS5StXr12/cfPW7Tt3791/8PDR4ydPnz1/8fLV6zdv373/8PHT5y9fv33/8fPX7z9///1nGPX/qP9H/T/q/1H/j/p/1P+j/h/1/6j/R5D/AVBLAwQUAAAACACraHddAAAAAAIAAAAAAAAADQAAAFBvY2tldC9FbXB0eS8DAFBLAQIUAxQAAAAIAKtod12zL5C+EQAAAA8AAAAUAAAAAAAAAAAAAACAAQAAAABQb2NrZXQvQ29udGVudC5zd2lmdFBLAQIUAxQAAAAIAKtod10tx8pPKwEAAAAMAAAWAAAAAAAAAAAAAACAAUMAAABQb2NrZXQvQXNzZXRzL3Rlc3QuYmluUEsBAhQDFAAAAAgAq2h3XQAAAAACAAAAAAAAAA0AAAAAAAAAAAAQAP1BogEAAFBvY2tldC9FbXB0eS9QSwUGAAAAAAMAAwDBAAAAzwEAAAAA","base64");
test("ordinary source edits preserve the remaining bytes, entries, and BOM",async()=>{
  const entries = await openZipWorkspace(original);
  assert.deepEqual(entries.map(e=>e.path),["Pocket/Content.swift","Pocket/Assets/test.bin","Pocket/Empty/"]);
  assert(entries[0].bom && entries[0].crlf);
  assert.equal(entries[0].text,"let a = 42\r\n");
  entries[0].edit = "let a = 43\r\n";
  const result = await openZipWorkspace(new Uint8Array(await exportZipWorkspace(entries).arrayBuffer()));
  assert.equal(result[0].text,entries[0].edit);
  assert(result[0].bom && result[0].crlf);
  assert.deepEqual([...result[1].packed],[...entries[1].packed]);
  assert(result[2].dir);
});
test("reject path traversal, CRC mismatch and truncated archives",async()=>{
  // Same-length replacement updates both name headers without moving the directory.
  const unsafe = Buffer.from(original.toString("latin1").replaceAll("Pocket/Content.swift","../bad/Content.swift"),"latin1");
  await assert.rejects(openZipWorkspace(unsafe), /cestu/);
  const broken = Buffer.from(original);
  broken.writeUInt32LE(0,14);
  const central = broken.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
  broken.writeUInt32LE(0,central+16);
  await assert.rejects(openZipWorkspace(broken), /součet/);
  await assert.rejects(openZipWorkspace(original.subarray(0,80)));
});

// Python zipfile generated this archive; its UTF-8 names mirror writers that omit bit 11.
const dotted = Buffer.from("UEsDBBQAAAAIAMBrIVAAAAAAAgAAAAAAAAACAAAALi8DAFBLAwQUAAAACADAayFQg+e+wBAAAAAOAAAAFwAAAC4vVWvDoXprYS9Lb8Whw61rLnN3aWZ0y0ktUTjSm5ilYKtgYsQFAFBLAQIUAxQAAAAIAMBrIVAAAAAAAgAAAAAAAAACAAAAAAAAAAAAAACAAQAAAAAuL1BLAQIUAxQAAAAIAMBrIVCD577AEAAAAA4AAAAXAAAAAAAAAAAAAACAASIAAAAuL1Vrw6F6a2EvS2/FocOtay5zd2lmdFBLBQYAAAAAAgACAHUAAABnAAAAAAA=","base64");
test("ordinary dot-prefixed roots and unflagged UTF-8 filenames retain their content",async()=>{
  const entries = await openZipWorkspace(dotted);
  assert.deepEqual(entries.map(entry=>entry.path),["Ukázka/Košík.swift"]);
  assert.equal(entries[0].text,"let čaj = 42\n");
  const exported = new Uint8Array(await exportZipWorkspace(entries).arrayBuffer());
  assert.equal((await openZipWorkspace(exported))[0].text,entries[0].text);
  const broken = Buffer.from(dotted);
  for(let pos=0;(pos=broken.indexOf(Buffer.from("Košík"),pos))>=0;pos+=2) broken[pos+2]=0xff;
  await assert.rejects(openZipWorkspace(broken),/UTF-8/);
});
test("dot-prefix normalization rejects an otherwise traversing path",async()=>{
  const corrupted = Buffer.from(dotted);
  const originalPart = Buffer.from("./Ukázka/"), badPart = Buffer.from("./../xxxxx");
  assert.equal(originalPart.length,badPart.length);
  for(let pos=0;(pos=corrupted.indexOf(originalPart,pos))>=0;pos+=badPart.length) badPart.copy(corrupted,pos);
  await assert.rejects(openZipWorkspace(corrupted),/nepovolenou cestu/);
});

const require = createRequire(import.meta.url);
let chromium;
try { ({chromium} = require("playwright")); } catch { /* Optional integration runner. */ }
test("ZIP survives reloads, rejected imports, and exports the exact original", {skip:!chromium}, async t => {
  const server = createServer(async (req,res)=>{
    if (/^\/[a-z][a-z0-9-]*\.mjs$/.test(req.url)) {
      const path=req.url === "/zip.mjs" ? "zip-workspace.mjs" : req.url.slice(1);
      try { res.setHeader("Content-Type","text/javascript"); res.end(await readFile(new URL("../web/"+path,import.meta.url))); }
      catch { res.statusCode=404;res.end(); }
      return;
    }
    res.setHeader("Content-Type","text/html"); res.end('<main id="zip-workspace"></main><script type="module" src="/zip.mjs"></script>');
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const browser = await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : existsSync("/usr/bin/chromium") ? {executablePath:"/usr/bin/chromium"} : {})});
  t.after(()=>browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(()=>{
    window.webkit = {messageHandlers:{exportWorkspaceZip:{postMessage:msg=>{window.lastZip=msg;}}}};
  });
  await page.goto("http://127.0.0.1:"+server.address().port+"/");
  const input = page.locator("#zip-input"), code = page.locator("textarea");
  await page.waitForFunction(()=>document.querySelector("button")?.disabled===false);
  await input.setInputFiles({name:"Demo.zip",mimeType:"application/zip",buffer:original});
  await page.waitForFunction(()=>document.querySelector("textarea").value.includes("42"));
  await code.fill("let a = 43\n");
  await page.getByText("Změna uložena na tomto zařízení.").waitFor();
  await page.locator("#zip-save").click();
  await page.getByText("Projekt byl uložen na tomto zařízení.").waitFor();
  await page.reload();
  await page.waitForFunction(()=>document.querySelector("textarea")?.value === "let a = 43\n");
  await code.fill("let a = 44\n");
  await page.locator("#zip-close").click();
  await page.getByText("Projekt byl uložen a zavřen.").waitFor();
  assert(await code.isHidden());
  await page.reload();
  await page.getByText("Poslední zavřený projekt: Demo.zip").waitFor();
  assert(await code.isHidden());
  await page.locator("#zip-reopen").click();
  await page.getByText("Projekt byl znovu otevřen ze zařízení.").waitFor();
  assert.equal(await code.inputValue(),"let a = 44\n");
  await input.setInputFiles({name:"bad.zip",mimeType:"application/zip",buffer:Buffer.from("invalid")});
  await page.getByText(/platnou hlavičku/).waitFor();
  assert.equal(await code.inputValue(),"let a = 44\n");
  await page.getByText("Možnosti archivu",{exact:true}).click();
  await page.getByRole("button",{name:"Exportovat původní ZIP"}).click();
  await page.waitForFunction(()=>window.lastZip?.name==="Demo.zip");
  assert.deepEqual(Buffer.from(await page.evaluate(()=>window.lastZip.base64),"base64"),original);
  await page.getByRole("button",{name:"Exportovat ZIP",exact:true}).click();
  await page.waitForFunction(()=>window.lastZip?.name==="Demo-upraveny.zip");
  const entries = await openZipWorkspace(Buffer.from(await page.evaluate(()=>window.lastZip.base64),"base64"));
  assert.equal(entries[0].text,"let a = 44\r\n");
  const newer = await context.newPage();
  await newer.goto(page.url());
  await newer.waitForFunction(()=>document.querySelector("textarea")?.value === "let a = 44\n");
  newer.once("dialog",dialog=>dialog.accept());
  await newer.locator("#zip-input").setInputFiles({name:"Jiny.zip",mimeType:"application/zip",buffer:dotted});
  await newer.getByText("Jiny.zip · 1 položek").waitFor();
  await code.fill("let a = 45\n");
  await page.locator("#zip-close").click();
  await page.locator("#zip-close:enabled").waitFor();
  await page.getByText(/jiném okně/).waitFor();
  assert(await code.isVisible());
  assert.equal(await code.inputValue(),"let a = 45\n");
  await newer.reload();
  await newer.waitForFunction(()=>document.querySelector("textarea")?.value === "let čaj = 42\n");
});
