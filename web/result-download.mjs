const MAX_ZIP = 65 * 1024 * 1024;

export async function downloadArtifactArchive({repo, artifact, token, fetcher = fetch}) {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !Number.isSafeInteger(artifact?.id) ||
      [".", ".."].includes(repo.split("/")[1]) || artifact.id <= 0 || !Number.isSafeInteger(artifact.size_in_bytes) ||
      artifact.size_in_bytes <= 0 || artifact.size_in_bytes > MAX_ZIP) {
    throw Error("Neplatné ID nebo velikost archivu na GitHubu.");
  }
  const response = await fetcher("https://api.github.com/repos/" + repo + "/actions/artifacts/" + artifact.id + "/zip", {
    headers: {Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10"},
    credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store",
    // Browser Fetch strips Authorization on cross-origin redirects.
    redirect: "follow"
  });
  if (!response.ok || !response.body) throw Error("GitHub neposkytl archiv. Zkus stejné stažení ze Souborů.");
  const reader = response.body.getReader();
  const bytes = new Uint8Array(artifact.size_in_bytes);
  let offset = 0;
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      if (value.length > bytes.length - offset) {
        await reader.cancel();
        throw Error("Velikost archivu přesáhla údaje GitHubu.");
      }
      bytes.set(value, offset);
      offset += value.length;
    }
  } finally { reader.releaseLock(); }
  if (offset !== bytes.length) throw Error("Stažený archiv je neúplný.");
  return bytes;
}
