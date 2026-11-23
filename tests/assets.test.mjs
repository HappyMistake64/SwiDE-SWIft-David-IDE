import test from "node:test";
import assert from "node:assert/strict";
import {addImage} from "../web/assets.mjs";
import {newProject, validateProject} from "../web/core.mjs";

test("asset import creates a valid imageset without editing the previous project", () => {
  const previous = newProject();
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxlkAAAAASUVORK5CYII=";
  const next = addImage(previous, "Logo", "image/png", png);
  validateProject(next);
  assert.equal(previous.version, 2);
  assert.equal(next.binaries["Resources/Assets.xcassets/Logo.imageset/Logo.png"].base64, png);
  assert.throws(() => addImage(next, "logo", "image/png", png), /existuje/);
});
