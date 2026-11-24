const GITHUB_ORIGIN = "https://github.com";

export function trustedGitHubURL(value) {
  const url = new URL(value);
  if (url.origin !== GITHUB_ORIGIN || url.username || url.password) {
    throw new Error("Nepovolená externí adresa.");
  }
  return url.href;
}
