const GITHUB_ORIGIN = "https://github.com";
const ACTION_RUN_PATH = /^\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9]\d*(?:\/artifacts\/[1-9]\d*)?$/;

export function trustedGitHubURL(value) {
  const url = new URL(value);
  if (url.origin !== GITHUB_ORIGIN || url.username || url.password || url.search || url.hash ||
    !ACTION_RUN_PATH.test(url.pathname)) {
    throw new Error("Nepovolená externí adresa.");
  }
  return url.href;
}
