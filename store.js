// Websites + settings live in chrome.storage.local (a browser copy). Optionally they are ALSO kept in a JSON file the user
// chose on disk (e.g. ~/Nextcloud/data.json) via the File System Access API: when linked, the file is the source of truth
// and the browser copy is the fallback used whenever Chrome hasn't (re)granted access to the file.
import { DEFAULTS } from "./lib.js";

// ---- IndexedDB: a FileSystemFileHandle can only be persisted there (chrome.storage can't hold it) ----
export const _io = {
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open("wdss", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  },
  async run(mode, fn) {
    if (typeof indexedDB === "undefined") return undefined;
    const db = await this.open();
    return new Promise((res, rej) => { const q = fn(db.transaction("kv", mode).objectStore("kv")); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  },
  get(k) { return this.run("readonly", s => s.get(k)); },
  set(k, v) { return this.run("readwrite", s => s.put(v, k)); },
  del(k) { return this.run("readwrite", s => s.delete(k)); }
};

export async function getFileLink() {
  const { fileLink } = await chrome.storage.local.get("fileLink");
  if (!fileLink?.enabled) return null;
  const handle = await _io.get("handle");
  return handle ? { ...fileLink, handle } : null;
}
export async function setFileLink(handle, { includeSettings = false, lastSeen = 0 } = {}) {
  await _io.set("handle", handle);
  await chrome.storage.local.set({ fileLink: { enabled: true, name: handle.name, includeSettings, lastSeen }, fileStatus: { ok: true, time: Date.now(), msg: "connected" } });
}
export async function updateFileLink(patch) {
  const { fileLink } = await chrome.storage.local.get("fileLink");
  if (fileLink) await chrome.storage.local.set({ fileLink: { ...fileLink, ...patch } });
}
export async function clearFileLink() {
  await _io.del("handle");
  await chrome.storage.local.set({ fileLink: { enabled: false } });
  await chrome.storage.local.remove("fileStatus");
}

export function dataFilePayload(sites, settings, includeSettings) {
  return { format: "wikidata-source-saver-data", version: 1, saved: new Date().toISOString(), sites, ...(includeSettings ? { settings } : {}) };
}
export function parseDataFile(text) {
  const d = JSON.parse(text);
  if (Array.isArray(d)) return { sites: d };                       // a bare list of websites is fine too
  if (d?.format !== "wikidata-source-saver-data" || !Array.isArray(d.sites)) throw new Error("not a Wikidata Source Saver data file");
  return { sites: d.sites, settings: d.settings && typeof d.settings === "object" ? d.settings : undefined };
}
export async function readDataFile(handle) {
  const f = await handle.getFile();
  return { ...parseDataFile(await f.text()), modified: f.lastModified };
}
export async function writeDataFile(handle, sites, settings, includeSettings) {
  const w = await handle.createWritable();
  try { await w.write(JSON.stringify(dataFilePayload(sites, settings, includeSettings), null, 2)); } finally { await w.close(); }
  return (await handle.getFile()).lastModified;
}
export async function filePermission(handle, mode = "readwrite") {
  try { return await handle.queryPermission({ mode }); } catch { return "denied"; }
}

// one read per ~2 s is enough (a run asks for sites and settings back to back)
let memo = { t: 0, p: null };
async function readLinked() {
  if (memo.p && Date.now() - memo.t < 2000) return memo.p;
  const p = (async () => {
    const link = await getFileLink().catch(() => null);
    if (!link) return null;
    try {
      if ((await filePermission(link.handle, "read")) !== "granted") {
        await chrome.storage.local.set({ fileStatus: { ok: false, time: Date.now(), msg: `access to ${link.name} needs to be granted again (Settings → Website data file) – using the last browser copy` } });
        return null;
      }
      const data = await readDataFile(link.handle);
      const cur = (await chrome.storage.local.get("settings")).settings || {};
      await chrome.storage.local.set({
        sites: data.sites,                                           // keep the browser copy fresh: it is the fallback
        ...(link.includeSettings && data.settings ? { settings: { ...cur, ...data.settings } } : {}),
        fileStatus: { ok: true, time: Date.now(), msg: `read from ${link.name}` }
      });
      return { ...data, link };
    } catch (e) {
      await chrome.storage.local.set({ fileStatus: { ok: false, time: Date.now(), msg: `${link.name}: ${e.message} – using the last browser copy` } });
      return null;
    }
  })();
  memo = { t: Date.now(), p };
  return p;
}
export const forgetFileMemo = () => { memo = { t: 0, p: null }; };

export async function getSites() {
  const f = await readLinked();
  if (f) return f.sites;
  const l = await chrome.storage.local.get("sites");
  if (l.sites) return l.sites;
  return (await chrome.storage.sync.get("sites")).sites || [];
}
export async function getSettings() {
  await readLinked();                                                // refreshes the browser copy of the settings when they live in the file
  let st = (await chrome.storage.local.get("settings")).settings;
  if (!st) st = (await chrome.storage.sync.get("settings")).settings || {};
  return { ...DEFAULTS, ...st };
}
export const saveAll = (sites, settings) => { forgetFileMemo(); return chrome.storage.local.set({ sites, settings }); };
