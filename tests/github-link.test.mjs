import assert from "node:assert/strict";
import test from "node:test";
import {trustedGitHubURL} from "../web/github-link.mjs";

test("allows HTTPS links on github.com", () => {
  assert.equal(trustedGitHubURL("https://github.com/owner/repo/actions/runs/42"),
    "https://github.com/owner/repo/actions/runs/42");
  assert.equal(trustedGitHubURL("https://github.com/owner/repo/actions/runs/42/artifacts/7"),
    "https://github.com/owner/repo/actions/runs/42/artifacts/7");
});

test("rejects unsafe schemes and origins", () => {
  for (const value of [
    "javascript:alert(1)",
    "http://github.com/owner/repo",
    "https://github.com.attacker.invalid/owner/repo",
    "https://attacker.invalid/owner/repo",
    "https://user@github.com/owner/repo"
  ]) assert.throws(() => trustedGitHubURL(value), /Nepovolená externí adresa/);
});
