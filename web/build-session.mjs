// Keep the original upload available across restarts without duplicating a large
// project in localStorage. IndexedDB completes the write before any upload starts.
async function snapshotStore(operation, mode, name = "projects") {
  const db = await new Promise((resolve, reject) => {
    const open = indexedDB.open("swide-private-snapshots-v2", 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore("projects");
      open.result.createObjectStore("dispatches");
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(name, mode);
      const request = operation(tx.objectStore(name));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error || Error("Místní změna byla přerušena."));
    });
  } finally { db.close(); }
}

export const uploadDrafts = {
  put: (id, project) => snapshotStore(store => store.add(project, id), "readwrite"),
  claim: id => snapshotStore(store => store.add(true, id), "readwrite", "dispatches"),
  read: id => snapshotStore(store => store.get(id), "readonly"),
  remove: id => snapshotStore(store => store.delete(id), "readwrite")
};

export async function sendPreparedBuild({req, client, drafts, save, onCommitted}) {
  if (!["prepared", "snapshot_failed", "committed"].includes(req.stage)) {
    throw Error("Tento požadavek již mohl být odeslán. Obnov jeho stav.");
  }
  if (!req.source_sha) {
    const frozen = await drafts.read(req.request_id);
    if (!frozen) throw Error("Původní místní snímek chybí. Spusť nové sestavení.");
    try {
      req.source_sha = await client.snapshot(req, frozen);
    } catch (error) {
      req.stage = "snapshot_failed";
      save();
      throw error;
    }
    req.stage = "committed";
    save();
    onCommitted?.(frozen, req.source_sha);
    await drafts.remove(req.request_id);
  }
  // A crash after persisting this state is indistinguishable from a lost
  // dispatch response. Recovery only locates the exact existing run.
  req.stage = "dispatching";
  save();
  try {
    await drafts.claim(req.request_id);
    await client.dispatch(req);
  } catch (error) {
    req.stage = "submission_uncertain";
    save();
    throw error;
  }
  req.stage = "dispatched";
  save();
}
