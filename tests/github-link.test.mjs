import assert from "node:assert/strict";
import test from "node:test";
import {trustedGitHubURL} from "../web/github-link.mjs";

test("allows HTTPS links on github.com", () => {
  assert.equal(trustedGitHubURL("https://github.com/owner/repo/actions/runs/42"),
    "https://github.com/owner/repo/actions/runs/42");
  assert.equal(trustedGitHubURL("https://github.com/owner/repo/actions/runs/42/artifacts/7"),
    "https://github.com/owner/repo/actions/runs/42/artifacts/7");
  assert.throws(() => trustedGitHubURL("https://github.com/owner/repo/actions/runs/0"),
    /Nepovolená externí adresa/);
});

test("rejects unsafe schemes and origins", () => {
  for (const value of [
    "javascript:alert(1)",
    "http://github.com/owner/repo",
    "https://github.com.attacker.invalid/owner/repo",
    "https://attacker.invalid/owner/repo",
    "https://user@github.com/owner/repo",
    "https://github.com/owner/repo/anything",
    "https://github.com/owner/repo/actions/runs/42?next=https://attacker.invalid",
    "https://github.com/owner/repo/actions/runs/42#fragment"
  ]) assert.throws(() => trustedGitHubURL(value), /Nepovolená externí adresa/);
});
