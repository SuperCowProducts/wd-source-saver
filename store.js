// Everything you configure lives in chrome.storage.local (a browser copy): websites, settings, blocked sites, the history log and the
// "page doesn't exist" cache. Optionally ALL of it is ALSO kept in one JSON file the user chose on disk (e.g. ~/Nextcloud/data.json)
// via the File System Access API: when linked, the file is the source of truth and the browser copy is the fallback used whenever Chrome
// hasn't (re)granted access to the file. Connecting that file on a fresh browser restores the whole environment.
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
export async function setFileLink(handle, { lastSeen = 0 } = {}) {
  await _io.set("handle", handle);
  await chrome.storage.local.set({ fileLink: { enabled: true, name: handle.name, lastSeen }, fileStatus: { ok: true, time: Date.now(), msg: "connected" } });
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

export const DATA_FORMAT = "wikidata-source-saver-data";
// version 2 = the whole environment; version 1 files (websites, optionally settings) are still read
export function dataFilePayload({ sites = [], settings, blockedSites, history, misses } = {}) {
  return {
    format: DATA_FORMAT, version: 2, saved: new Date().toISOString(),
    contents: "websites, settings, blocked sites, history log, 'page doesn't exist' cache",
    sites, ...(settings ? { settings } : {}), blockedSites: blockedSites || [], history: history || { items: {} }, misses: misses || {}
  };
}
export function parseDataFile(text) {
  const d = JSON.parse(text);
  if (Array.isArray(d)) return { sites: d };                       // a bare list of websites is fine too
  if (d?.format !== DATA_FORMAT || !Array.isArray(d.sites)) throw new Error("not a Wikidata Source Saver data file");
  const out = { sites: d.sites };                                  // parts missing from the file (older versions) stay undefined = "not in the file"
  if (d.settings && typeof d.settings === "object") out.settings = d.settings;
  if (Array.isArray(d.blockedSites)) out.blockedSites = d.blockedSites.filter(x => typeof x === "string");
  if (d.history && typeof d.history === "object" && d.history.items && typeof d.history.items === "object") out.history = d.history;
  if (d.misses && typeof d.misses === "object" && !Array.isArray(d.misses)) out.misses = d.misses;
  return out;
}
export async function readDataFile(handle) {
  const f = await handle.getFile();
  return { ...parseDataFile(await f.text()), modified: f.lastModified };
}
export async function writeDataFile(handle, state) {
  const w = await handle.createWritable();
  try { await w.write(JSON.stringify(dataFilePayload(state), null, 2)); } finally { await w.close(); }
  return (await handle.getFile()).lastModified;
}

// ---- keeping the file in step with the browser copy after every change ----
const missT = v => (typeof v === "number" ? v : v?.t) || 0;
export function mergeHistory(a, b) {                              // newest record per statement wins
  const out = { items: {} };
  for (const src of [a, b]) for (const [q, recs] of Object.entries(src?.items || {})) {
    const mine = out.items[q] = out.items[q] || {};
    for (const [k, r] of Object.entries(recs)) if (!mine[k] || (r.t || 0) > (mine[k].t || 0)) mine[k] = r;
  }
  return out;
}
export function mergeMisses(a, b) {
  const out = { ...(a || {}) };
  for (const [u, v] of Object.entries(b || {})) if (missT(v) > missT(out[u])) out[u] = v;
  return out;
}
// patch = {sites?, blockedSites?, history?, misses?}. merge: add to what the file has (a run's new records, a newly blocked site – the file may have
// been extended meanwhile by another computer); without merge the patch REPLACES that part (clearing the log, forgetting an item).
// Never throws: when the file can't be written the browser copy is flagged as newer ("fileDirty") and Settings says so.
let pushChain = Promise.resolve();
export function pushToFile(patch = {}, { merge = false } = {}) {
  const run = async () => {
    const link = await getFileLink().catch(() => null);
    if (!link) return { linked: false, ok: true };
    try {
      if ((await filePermission(link.handle, "readwrite")) !== "granted") throw new Error("access to the file must be granted again");
      const text = await (await link.handle.getFile()).text();
      const cur = text.trim() ? parseDataFile(text) : {};          // an unreadable file throws: it is never overwritten blindly
      const loc = await chrome.storage.local.get(["sites", "settings", "blockedSites", "history", "misses"]);
      const state = { sites: patch.sites ?? cur.sites ?? loc.sites ?? [], settings: cur.settings ?? loc.settings };      // patch.sites REPLACES the list (the caller built it from the file's own list)
      state.blockedSites = patch.blockedSites ? (merge ? [...new Set([...(cur.blockedSites || []), ...patch.blockedSites])] : patch.blockedSites) : (cur.blockedSites ?? loc.blockedSites);
      state.history = patch.history ? (merge ? mergeHistory(cur.history, patch.history) : patch.history) : (cur.history ?? loc.history);
      state.misses = patch.misses ? (merge ? mergeMisses(cur.misses, patch.misses) : patch.misses) : (cur.misses ?? loc.misses);
      const mod = await writeDataFile(link.handle, state);
      await updateFileLink({ lastSeen: mod });
      await chrome.storage.local.remove("fileDirty");
      forgetFileMemo();
      return { linked: true, ok: true };
    } catch (e) {
      await chrome.storage.local.set({ fileDirty: true, fileStatus: { ok: false, time: Date.now(), msg: `the file is behind the browser copy (${e.message || e}) – open Settings → Website data file and press “Write everything to the file”` } });
      return { linked: true, ok: false, error: String(e.message || e) };
    }
  };
  pushChain = pushChain.then(run, run);
  return pushChain;
}
// browser copy first, then the file
export async function saveState(patch, opts) { await chrome.storage.local.set(patch); return pushToFile(patch, opts); }
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
      const { settings: cur = {}, fileDirty } = await chrome.storage.local.get(["settings", "fileDirty"]);
      await chrome.storage.local.set({
        sites: data.sites,                                           // keep the browser copy fresh: it is the fallback
        ...(data.settings ? { settings: { ...cur, ...data.settings } } : {}),
        // blocked sites / history / cache: the file wins - unless a write to it failed earlier, then the browser copy is the newer one
        ...(!fileDirty && data.blockedSites ? { blockedSites: data.blockedSites } : {}),
        ...(!fileDirty && data.history ? { history: data.history } : {}),
        ...(!fileDirty && data.misses ? { misses: data.misses } : {}),
        ...(fileDirty ? {} : { fileStatus: { ok: true, time: Date.now(), msg: `read from ${link.name}` } })
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
// Add websites (e.g. ticked in the review window) WITHOUT opening Settings: they go into the browser copy and straight into the data file.
// A website that is already there (same Q…) is only completed (name, missing URL templates), never overwritten.
const normTpl = t => String(t || "").trim().replace(/^P\d+(:\S+)?\s+/i, "").replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^www\./i, "").toLowerCase();
export async function addSites(list) {
  forgetFileMemo();
  const sites = (await getSites()).map(x => ({ ...x }));
  const added = [], completed = [];
  for (const n of list) {
    const i = n.qid ? sites.findIndex(x => (x.qid || "").toUpperCase() === n.qid.toUpperCase()) : -1;
    const tpls = (n.templates || []).map(t => String(t).trim()).filter(Boolean);
    if (i >= 0) {
      const x = sites[i], have = new Set((x.templates || []).map(normTpl)), miss = tpls.filter(t => !have.has(normTpl(t)));
      let ch = false;
      if (!x.name && n.name) { x.name = n.name; ch = true; }
      if (miss.length) { x.templates = [...(x.templates || []), ...miss]; ch = true; }
      if (ch) completed.push(x.name || n.qid);
    } else {
      sites.push({ name: n.name || "", qid: n.qid || "", idProperty: "", templates: tpls, match: n.match || "", category: n.category || "", language: String(n.language || "").trim().toLowerCase() });
      added.push(n.name || n.qid);
    }
  }
  if (!added.length && !completed.length) return { added, completed, file: { linked: false, ok: true } };
  const file = await saveState({ sites });
  return { added, completed, file };
}
export const saveAll = (sites, settings) => { forgetFileMemo(); return chrome.storage.local.set({ sites, settings }); };
