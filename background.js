import {
  normUrl, findCurrent, buildCandidates, dedupeIds, parseClipboard, checkUrl, unwrapArchive, waybackLatest,
  tsToDate, cleanTerm, alignToTerms, cats, sharesCat, usable, searchUrl, extractLinks, pickResultsDetailed,
  matchTemplates, keyFor, applyUrlMode, propForUrl, siteDefaultProp,
  DEFAULTS
} from "./lib.js";
import { getSites, getSettings } from "./store.js";

const VERSION = chrome.runtime.getManifest?.().version || "dev";
const API = "https://www.wikidata.org/w/api.php";
const P_SOURCE = "P1343";   // described by source
const P_URL = "P2699";      // URL (qualifier)
const P_ARCH = "P1065";     // archive URL (qualifier)
const P_ARCHDATE = "P2960"; // archive date (qualifier)

const GAPS = { "www.wikidata.org": 1100, "web.archive.org": 1500 };

// ======================================================================
// config
// ======================================================================
const labelOf = s => s.name || s.match || s.qid || s.idProperty;
const sleep = (ms, signal) => new Promise((res, rej) => {
  if (signal?.aborted) return rej(new DOMException("Aborted", "AbortError"));
  const t = setTimeout(res, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("Aborted", "AbortError")); }, { once: true });
});

// ======================================================================
// run state, activity indicator, stop
// ======================================================================
let current = null;
const reviews = new Map();

function renderBadge() {
  if (!current) return;
  const { done, total, stage } = current;
  chrome.action.setBadgeBackgroundColor({ color: "#1565c0" });
  if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: "#ffffff" });
  chrome.action.setBadgeText({ text: total > 0 ? Math.min(99, Math.floor(done / total * 100)) + "%" : ".".repeat(current.dot % 3 + 1) });
  chrome.action.setTitle({ title: `Wikidata Source Saver – working: ${stage}\nClick the icon (or use the Stop shortcut) to cancel` });
}
function persistStatus() {
  Promise.resolve(chrome.storage.session?.set({ status: {
    running: !!current, stage: current?.stage || "", done: current?.done || 0, total: current?.total || 0, startedAt: current?.startedAt || 0
  } })).catch(() => {});
}
function setStage(stage, done, total) {
  if (!current) return;
  current.stage = stage;
  if (done !== undefined) current.done = done;
  if (total !== undefined) current.total = total;
  renderBadge(); persistStatus();
}
function startIndicators() {
  current.dotTimer = setInterval(() => { current.dot++; renderBadge(); }, 600);
  current.keep = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000); // keep the service worker alive while working
}
function endRun() {
  clearInterval(current?.dotTimer); clearInterval(current?.keep);
  current = null;
  chrome.action.setTitle({ title: "Save this page as a source on the Wikidata item in your clipboard" });
  persistStatus();
}
function stopRun() {
  if (!current) return;
  current.abort.abort();
  for (const [id, r] of reviews) { r.resolve(null); if (r.winId) chrome.windows.remove(r.winId).catch(() => {}); reviews.delete(id); }
}

// ======================================================================
// polite networking: one request at a time per website, spaced out, circuit breaker
// ======================================================================
const chains = new Map(), nextOk = new Map();
function serial(host, fn) {
  const prev = chains.get(host) || Promise.resolve();
  const p = prev.then(fn);
  chains.set(host, p.catch(() => {}));
  return p;
}
const gapFor = (host, s) => s.hostDelayMs === 0 ? 0 : (GAPS[host] ?? s.hostDelayMs);
async function pace(host, signal) {
  const w = (nextOk.get(host) || 0) - Date.now();
  if (w > 0) await sleep(w, signal);
  signal?.throwIfAborted();
}
function paced(host) {
  const s = current?.settings || DEFAULTS;
  nextOk.set(host, Date.now() + gapFor(host, s) + (s.hostDelayMs === 0 ? 0 : Math.random() * 400));
}

function hostFetch(url, opts = {}, { noBreaker = false } = {}) {
  const host = new URL(url).hostname;
  return serial(host, async () => {
    if (!noBreaker && current?.blocked.has(host)) throw Object.assign(new Error("blocked"), { blocked: true });
    const { signal, timeoutMs = 15000, ...rest } = opts;
    await pace(host, signal);
    const sigs = [AbortSignal.timeout(timeoutMs)];
    if (signal) sigs.push(signal);
    let res;
    try { res = await fetch(url, { ...rest, signal: AbortSignal.any(sigs) }); } finally { paced(host); }
    if (!noBreaker && current) {
      if ([429, 403, 503].includes(res.status)) current.blocked.add(host);
      else if (res.status >= 500) {
        const n = (current.strikes.get(host) || 0) + 1;
        current.strikes.set(host, n);
        if (n >= 2) current.blocked.add(host);
      }
    }
    return res;
  });
}

// ======================================================================
// Wikidata API – user-agent, maxlag, assert=user, retries with back-off
// ======================================================================
const UA = s => `WikidataSourceSaver/${VERSION} (browser extension, every edit user-initiated; ` +
  (s.username ? "https://www.wikidata.org/wiki/User:" + encodeURIComponent(s.username.trim().replace(/ /g, "_")) : "no contact set") + ")";

async function api(params, post = false, signal) {
  const s = current?.settings || DEFAULTS;
  const body = new URLSearchParams({ format: "json", formatversion: "2", maxlag: "5", ...params });
  if (post) body.set("assert", "user");               // never edit anonymously if the session expired
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await hostFetch(post ? API : `${API}?${body}`, {
      method: post ? "POST" : "GET", body: post ? body : undefined, credentials: "include",
      headers: { "Api-User-Agent": UA(s) }, timeoutMs: 20000, signal
    }, { noBreaker: true });
    const retryAfter = Number(res.headers?.get?.("Retry-After")) || 0;
    if (res.status === 429 || res.status === 503) { await sleep((retryAfter || 5 * (attempt + 1)) * 1000, signal); continue; }
    const data = await res.json();
    if (data.error?.code === "maxlag") { await sleep(((retryAfter || data.error.lag || 5) + 1) * 1000, signal); continue; }
    if (data.error?.code === "assertuserfailed") throw new Error("You're not logged in to Wikidata. Log in, then try again.");
    if (data.error) throw new Error(data.error.info || data.error.code);
    return data;
  }
  throw new Error("Wikidata is busy (replication lag / rate limit). Nothing was written – try again in a few minutes.");
}

async function getCsrf(signal) {
  const d = await api({ action: "query", meta: "tokens", type: "csrf" }, false, signal);
  const t = d.query.tokens.csrftoken;
  if (t === "+\\") {
    chrome.tabs.create({ url: "https://www.wikidata.org/w/index.php?title=Special:UserLogin" });
    throw new Error("You're not logged in to Wikidata. Log in, then try again.");
  }
  return t;
}

async function fetchTerms(item, s, signal) {
  const lang = s.labelLang || "en";
  const d = await api({ action: "wbgetentities", ids: item, props: "labels|aliases", languages: lang, languagefallback: "1" }, false, signal);
  const e = d.entities?.[item] || {};
  const raw = e.labels?.[lang]?.value || Object.values(e.labels || {})[0]?.value || "";
  return { label: cleanTerm(raw), aliases: (e.aliases?.[lang] || []).map(a => cleanTerm(a.value)).filter(Boolean).slice(0, 3), raw };
}

// ======================================================================
// history log (everything pushed or found already present) + cache of definite misses
// ======================================================================
async function loadHistory(s) {
  const { history = { items: {} }, misses = {} } = await chrome.storage.local.get(["history", "misses"]);
  const cutoff = Date.now() - s.missTtlDays * 864e5;
  for (const k of Object.keys(misses)) if (misses[k] < cutoff) delete misses[k];
  return { history, misses };
}
const saveHistory = (history, misses) => chrome.storage.local.set({ history, misses });

// ======================================================================
// building statements
// ======================================================================
const timeValue = d => ({
  time: `+${d}T00:00:00Z`, timezone: 0, before: 0, after: 0, precision: 11,
  calendarmodel: "http://www.wikidata.org/entity/Q1985727"
});
const snak = (property, type, value) => ({ snaktype: "value", property, datavalue: { type, value } });
const hasQual = (c, p) => (c.qualifiers?.[p] || []).length > 0;
const archQuals = a => ({
  [P_ARCH]: [snak(P_ARCH, "string", a.url)],
  [P_ARCHDATE]: [snak(P_ARCHDATE, "time", timeValue(a.date))]
});

function newClaim(e) {
  if (e.property) {
    const c = { type: "statement", rank: "normal", mainsnak: snak(e.property, "string", e.value) };
    if (e.archive) c.qualifiers = archQuals(e.archive);
    return c;
  }
  return {
    type: "statement", rank: "normal",
    mainsnak: snak(P_SOURCE, "wikibase-entityid", { "entity-type": "item", id: e.site.qid.toUpperCase() }),
    qualifiers: { [P_URL]: [snak(P_URL, "string", e.url)], ...(e.archive ? archQuals(e.archive) : {}) }
  };
}
function addQual(c, prop, sn, append = false) {
  c.qualifiers = c.qualifiers || {};
  c.qualifiers[prop] = append ? [...(c.qualifiers[prop] || []), sn] : [sn];
  if (Array.isArray(c["qualifiers-order"]) && !c["qualifiers-order"].includes(prop)) c["qualifiers-order"].push(prop);
}
function modifyClaim(c, e, status) {
  if (status === "qualifier-added") {
    const have = (c.qualifiers?.[P_URL] || []).some(x => normUrl(x.datavalue?.value) === normUrl(e.url));
    if (!have) addQual(c, P_URL, snak(P_URL, "string", e.url), true);   // several URLs share one P1343 statement
  }
  if (e.archive && !hasQual(c, P_ARCH)) {
    addQual(c, P_ARCH, snak(P_ARCH, "string", e.archive.url));
    addQual(c, P_ARCHDATE, snak(P_ARCHDATE, "time", timeValue(e.archive.date)));
  }
}

// one new P1343 statement carrying several P2699 URLs
function newGroupClaim(entries) {
  return {
    type: "statement", rank: "normal",
    mainsnak: snak(P_SOURCE, "wikibase-entityid", { "entity-type": "item", id: entries[0].site.qid.toUpperCase() }),
    qualifiers: { [P_URL]: entries.map(e => snak(P_URL, "string", e.url)) }
  };
}

// Read-only: compare entries with what the item already has.  -> [{id, entry, status, claim?}]
//  status: "exists" | "created" | "qualifier-added" | "archive-added"
export async function planSources(item, entries, signal) {
  const props = [...new Set(entries.map(e => e.property || P_SOURCE))];
  const claimsBy = {};
  for (const p of props) { // sequential on purpose
    const d = await api({ action: "wbgetclaims", entity: item, property: p }, false, signal);
    claimsBy[p] = (d.claims && d.claims[p]) || [];
  }
  const planned = [], plannedIds = [], usedBare = new Set(), archDone = new Set(), plan = [], groups = new Map();
  entries.forEach((entry, id) => {
    const out = (status, claim) => plan.push({ id, entry, status, ...(claim ? { claim } : {}) });
    if (entry.property) {
      const p = entry.property;
      const have = claimsBy[p].find(c => c.mainsnak?.datavalue?.value === entry.value);
      if (have) {
        if (entry.archive && !hasQual(have, P_ARCH) && !archDone.has(have.id)) { archDone.add(have.id); return out("archive-added", have); }
        return out("exists", have);
      }
      if (plannedIds.some(x => x.p === p && x.v === entry.value)) return out("exists");
      plannedIds.push({ p, v: entry.value });
      return out("created");
    }
    const q = entry.site.qid.toUpperCase();
    const same = claimsBy[P_SOURCE].filter(c => c.mainsnak?.datavalue?.value?.id === q);
    const urlMatch = same.find(c => (c.qualifiers?.[P_URL] || []).some(x => normUrl(x.datavalue?.value) === normUrl(entry.url)));
    if (urlMatch) {
      // an archive link can only be attached to a statement that holds exactly this one URL (otherwise the pairing is lost)
      if (entry.archive && !hasQual(urlMatch, P_ARCH) && (urlMatch.qualifiers?.[P_URL] || []).length === 1 && !archDone.has(urlMatch.id)) {
        archDone.add(urlMatch.id); return out("archive-added", urlMatch);
      }
      return out("exists", urlMatch);
    }
    if (planned.some(p => p.q === q && normUrl(p.url) === normUrl(entry.url))) return out("exists");
    planned.push({ q, url: entry.url });

    if (entry.archive) {                       // URL + its own archive link: keep them together in their own statement
      const bare = same.find(c => !hasQual(c, P_URL) && !hasQual(c, P_ARCH) && !usedBare.has(c.id));
      if (bare) { usedBare.add(bare.id); return out("qualifier-added", bare); }
      return out("created");
    }
    // plain URL: put it under the website's existing P1343 statement, or under ONE new statement shared by all new URLs
    const target = same.find(c => !hasQual(c, P_ARCH));
    if (target) return out("qualifier-added", target);
    let g = groups.get(q);
    if (!g) { g = { lead: id }; groups.set(q, g); }
    plan.push({ id, entry, status: "created", group: q, lead: g.lead === id });
  });
  return plan;
}

// ONE edit containing every chosen change, after waiting for the edit-rate limits.
async function commit(item, plan, chosen, s, signal) {
  const now0 = Date.now();
  const { editTimes = [], lastEdit = 0 } = await chrome.storage.local.get(["editTimes", "lastEdit"]);
  const recent = editTimes.filter(t => now0 - t < 3600e3);
  if (recent.length >= s.maxEditsPerHour) {
    throw new Error(`Hourly edit limit reached (${s.maxEditsPerHour}/hour – see Settings). Nothing was written; try again later.`);
  }
  const wait = lastEdit + s.minEditInterval * 1000 - now0;
  for (let left = Math.ceil(wait / 1000); left > 0; left--) {
    setStage(`waiting ${left}s before editing (edit-rate limit)`);
    await sleep(1000, signal);
  }
  signal.throwIfAborted();

  const claims = [], mods = new Map(), groups = new Map();
  for (const p of chosen) {
    if (p.status === "created") {
      if (p.group) { if (!groups.has(p.group)) groups.set(p.group, []); groups.get(p.group).push(p.entry); }
      else claims.push(newClaim(p.entry));
    } else {
      const c = mods.get(p.claim.id) || structuredClone(p.claim);
      modifyClaim(c, p.entry, p.status);
      mods.set(c.id, c);
    }
  }
  for (const entries of groups.values()) claims.push(newGroupClaim(entries));
  claims.push(...mods.values());

  setStage("saving to Wikidata…");
  const token = await getCsrf(signal);
  signal.throwIfAborted();
  const summary = `Add ${chosen.length > 1 ? chosen.length + " sources/identifiers" : "source/identifier"} (via Wikidata Source Saver, user-initiated)`;
  await api({ action: "wbeditentity", id: item, data: JSON.stringify({ claims }), token, summary }, true); // no signal: once sent, it completes
  const t = Date.now();
  await chrome.storage.local.set({ lastEdit: t, editTimes: [...recent, t] });
}

// ======================================================================
// human review window
// ======================================================================
function askReview(payload) {
  return new Promise(async resolve => {
    const id = crypto.randomUUID();
    const rec = { payload, resolve };
    reviews.set(id, rec);
    const timer = setTimeout(() => { if (reviews.delete(id)) { resolve(null); if (rec.winId) chrome.windows.remove(rec.winId).catch(() => {}); } }, 15 * 60e3);
    rec.resolve = v => { clearTimeout(timer); resolve(v); };
    try {
      const win = await chrome.windows.create({ url: chrome.runtime.getURL("review.html?id=" + id), type: "popup", width: 780, height: 700 });
      rec.winId = win?.id;
    } catch { reviews.delete(id); resolve(null); }
  });
}

chrome.windows?.onRemoved?.addListener(winId => {
  for (const [id, r] of reviews) if (r.winId === winId) { reviews.delete(id); r.resolve(null); }
});
chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg?.type === "review-get") { send(reviews.get(msg.id)?.payload || null); return; }
  if (msg?.type === "review-done") {
    const r = reviews.get(msg.id);
    if (r) { reviews.delete(msg.id); r.resolve(msg.cancel ? null : msg.selected || []); if (r.winId) chrome.windows.remove(r.winId).catch(() => {}); }
    return;
  }
  if (msg?.type === "stop") { stopRun(); return; }
});

// ======================================================================
// notifications
// ======================================================================
const LEVELS = {
  ok:    { color: "#2e7d32", textColor: "#ffffff", ms: 4000 },
  warn:  { color: "#fbc02d", textColor: "#000000", ms: 6000 },
  error: { color: "#c62828", textColor: "#ffffff", ms: 5000 }
};
function notify(title, message, level = "ok", badge) {
  const l = LEVELS[level] || LEVELS.ok;
  chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title, message });
  chrome.action.setBadgeBackgroundColor({ color: l.color });
  if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: l.textColor });
  chrome.action.setBadgeText({ text: badge || (level === "ok" ? "✓" : level === "warn" ? "=" : "!") });
  clearTimeout(notify._t);
  notify._t = setTimeout(() => chrome.action.setBadgeText({ text: "" }), l.ms);
}

// ======================================================================
// discovery helpers
// ======================================================================
async function readClipboard() {
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html", reasons: ["CLIPBOARD"], justification: "Read the Wikidata item ID from the clipboard"
    });
  }
  return chrome.runtime.sendMessage({ target: "offscreen", type: "read-clipboard" });
}

async function pageUrl(tab, site, href, wrapped) {
  if (site.urlMode === "canonical" && !wrapped) {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.querySelector('link[rel="canonical"]')?.href || null
    });
    if (result) return result;
  }
  return applyUrlMode(href, site.urlMode);
}

const hasPerm = async host => chrome.permissions.contains({ origins: [`*://${host}/*`] });

async function lookupArchive(url, signal) {
  if (!(await hasPerm("web.archive.org"))) return { found: false, error: true, noPerm: true };
  return waybackLatest(url, hostFetch, signal);
}

async function checkWithPermission(c, s, signal) {
  if (!(await hasPerm(new URL(c.url).hostname))) return { found: false, reason: "no permission – open settings and press Save" };
  return checkUrl(c.url, c.site, s, hostFetch, signal);
}

async function resolveCandidate(c, s, signal) {
  const [live, arch] = await Promise.all([
    checkWithPermission(c, s, signal),
    c.site.archive ? lookupArchive(c.url, signal) : Promise.resolve(null)
  ]);
  const archive = arch?.found ? arch : null;
  if (live.found) return { found: true, url: live.url, archive };
  if (archive) return { found: true, url: c.url, archive, viaArchive: true };
  const why = arch ? (arch.noPerm ? "no permission for web.archive.org – open settings and press Save"
    : arch.error ? "Wayback lookup failed" : "no Wayback snapshot") : null;
  return { found: false, reason: why ? `${live.reason}; ${why}` : live.reason,
    definitive: !!live.definitive && !(arch && arch.error), stopped: live.stopped };
}

function waitTabComplete(tabId, ms, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(t); chrome.tabs.onUpdated.removeListener(onUpd); };
    const t = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onUpd = (id, info) => { if (id === tabId && info.status === "complete") { cleanup(); resolve(); } };
    chrome.tabs.onUpdated.addListener(onUpd);
    signal?.addEventListener("abort", () => { cleanup(); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
  });
}

// Result links of a site's own search page. "fetch" = plain request; "tab" = render in a background tab (JS-driven sites)
async function fetchSearchLinks(site, url, signal) {
  const host = new URL(url).hostname;
  if (!(await hasPerm(host))) throw new Error("no permission – open settings and press Save");
  if (site.searchMode === "tab") {
    return serial(host, async () => {
      if (current?.blocked.has(host)) throw Object.assign(new Error("blocked"), { blocked: true });
      await pace(host, signal);
      const tab = await chrome.tabs.create({ url, active: false });
      try {
        await waitTabComplete(tab.id, 20000, signal);
        let links = [];
        for (let i = 0; i < 6; i++) {
          await sleep(i === 0 ? 1500 : 1200, signal);
          const [{ result } = {}] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => [...document.querySelectorAll("a[href]")].map(a => ({ href: a.href, text: (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200) }))
          });
          const now = result || [];
          if (now.length && now.length === links.length) break; // results stopped changing
          links = now;
        }
        return links;
      } finally { paced(host); chrome.tabs.remove(tab.id).catch(() => {}); }
    });
  }
  const res = await hostFetch(url, { credentials: "omit", timeoutMs: 15000, signal });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return extractLinks((await res.text()).slice(0, 3_000_000), res.url || url);
}

// prop = Wikidata property storing the ID for this URL ("" = P1343 + P2699 fallback, which needs the website item)
function makeEntry(site, url, value, archive, prop, extra = {}) {
  const base = {
    site, url, label: labelOf(site), archiveWanted: !!site.archive,
    archive: site.archive && archive ? { url: archive.url, date: archive.date } : null, ...extra
  };
  if (!prop) return site.qid ? base : null;
  if (!value) return null;
  return { ...base, property: prop, value };
}
const whyNot = (site, prop) => prop
  ? `couldn't read the ID for ${prop} from this URL – check the template`
  : `no website item (P1343) is set for this site, so the URL can't be saved`;
const entryKey = e => keyFor(e.site, e.url, e.value, e.property);

function describe(e) {
  const main = e.property ? `${e.label} (${e.property}: ${e.value})` : `${e.label} – ${e.url}`;
  return main + (e.archive ? ` + archive ${e.archive.date}` : e.archiveWanted ? " (no Wayback snapshot found)" : "") +
    (e.viaArchive ? " [live site unreachable]" : "") + (e.viaSearch ? " [from site search]" : "") + (e.needsApproval ? " [partial title match – needs approval]" : "");
}

async function mapPool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ======================================================================
// the run
// ======================================================================
async function runInner(tab, only, s, signal) {
  if (!tab?.url || !/^https?:/.test(tab.url)) throw new Error("This page can't be used (not an http/https page).");
  const un = unwrapArchive(tab.url);
  const href = un ? un.original : tab.url;

  const sites = await getSites();
  const cur = findCurrent(sites, href);
  if (!cur) {
    const host = new URL(href).hostname.replace(/^www\./, "");
    await chrome.tabs.create({ url: chrome.runtime.getURL("options.html?add=" + encodeURIComponent(host)) });
    throw new Error(`No Wikidata item configured for ${host}. Opened settings so you can add it.`);
  }
  const site = cur.site;
  const url = await pageUrl(tab, site, href, !!un);

  setStage("reading clipboard…");
  const parsed = parseClipboard((await readClipboard()) || "");
  if (!parsed) throw new Error("No Wikidata item (Qxxx) found in the clipboard.");
  const item = parsed.item;

  const { history, misses } = await loadHistory(s);
  const known = s.useHistory ? (history.items[item] || {}) : {};
  const isKnown = (key, archiveWanted) => { const r = known[key]; return !!r && (!archiveWanted || r.a); };

  // --- terms: ONLY from Wikidata (label/aliases), the clipboard and the page's own ID. Nothing is guessed. ---
  setStage("reading the item's label from Wikidata…");
  let terms = { label: null, aliases: [] };
  try { terms = await fetchTerms(item, s, signal); } catch (e) { if (signal.aborted) throw e; }
  const extras = parsed.extras; // already validated by parseClipboard
  let searchTerms = [terms.label, ...terms.aliases, ...extras].filter(Boolean);
  const ambiguous = (site.separator || "hyphen") === "none";
  const pageWords = cur.extracted ? (ambiguous ? alignToTerms(cur.extracted, searchTerms) : cur.extracted.words) : null;
  if (!searchTerms.length && pageWords) searchTerms = [{ text: pageWords.join(" "), words: pageWords }];
  const ids = dedupeIds([
    ...(pageWords ? [{ words: pageWords }] : []),
    ...[terms.label, ...terms.aliases.slice(0, 2), ...extras].filter(Boolean).map(t => ({ words: t.words }))
  ]);

  // --- the current page ---
  let archive = null;
  if (site.archive) {
    if (un) archive = { url: `https://web.archive.org/web/${un.timestamp}/${un.original}`, date: tsToDate(un.timestamp) };
    else { setStage("looking up the Wayback Machine…"); const a = await lookupArchive(url, signal); if (a.found) archive = a; }
  }
  const entries = [], skipped = [], knownLines = [];
  const firstProp = cur.extracted ? cur.extracted.prop : (siteDefaultProp(site) === "P1343" ? "" : siteDefaultProp(site));
  const first = makeEntry(site, url, cur.extracted?.raw, archive, firstProp);
  if (!first) skipped.push({ label: labelOf(site), url: href, reason: whyNot(site, firstProp) });
  else if (isKnown(entryKey(first), first.archiveWanted)) knownLines.push(describe(first));
  else entries.push(first);

  // --- related websites ---
  if (!only && s.related && cats(site).length) {
    const seen = new Set([normUrl(href), normUrl(url)]);
    const cands = buildCandidates(sites, site, ids, { perSite: s.maxPerSite, total: s.maxTotal }).filter(c => {
      if (seen.has(normUrl(c.url))) return false;
      if (isKnown(keyFor(c.site, c.url, c.value, c.prop), !!c.site.archive)) { knownLines.push(`${labelOf(c.site)} – ${c.url}`); return false; }
      if (misses[c.url]) return false;
      return true;
    });
    const searchSites = sites.filter(x => usable(x) && x.searchUrl && sharesCat(site, x));
    const queries = [...new Map(searchTerms.slice(0, 2).map(t => [t.text.toLowerCase(), t])).values()].slice(0, 1 + (extras.length ? 1 : 0));
    const tasks = [
      ...cands.map(c => ({ kind: "check", c })),
      ...searchSites.flatMap(x => queries.map(q => ({ kind: "search", x, q })))
    ];
    let done = 0;
    setStage("checking related websites…", 0, tasks.length);
    const foundKeys = new Set(), missList = [], foundMap = new Map();
    const addFound = (c, r, extra = {}) => {
      const e = makeEntry(c.site, r.url, c.value, r.archive, c.prop, { viaArchive: r.viaArchive, ...extra });
      if (!e) return skipped.push({ label: labelOf(c.site), url: r.url, reason: whyNot(c.site, c.prop) });
      const k = entryKey(e);
      if (foundMap.has(k) || seen.has(normUrl(e.url)) || isKnown(k, e.archiveWanted)) return;
      foundMap.set(k, e);
    };

    await mapPool(tasks, 4, async t => {
      signal.throwIfAborted();
      try {
        if (t.kind === "check") {
          setStage(`checking ${labelOf(t.c.site)}… (${done + 1}/${tasks.length})`);
          const r = await resolveCandidate(t.c, s, signal);
          const key = t.c.site.name + "|" + t.c.template;
          if (r.found) { foundKeys.add(key); addFound(t.c, r); }
          else {
            if (r.stopped) signal.throwIfAborted();
            missList.push({ key, label: labelOf(t.c.site), url: t.c.url, reason: r.reason });
            if (r.definitive) misses[t.c.url] = Date.now();
          }
        } else {
          setStage(`searching ${labelOf(t.x)} for “${t.q.text}”… (${done + 1}/${tasks.length})`);
          const sUrl = searchUrl(t.x, t.q.text);
          let links;
          try { links = await fetchSearchLinks(t.x, sUrl, signal); }
          catch (e) { if (signal.aborted) throw e; skipped.push({ label: labelOf(t.x), url: sUrl, reason: "search failed: " + (e.blocked ? "host rate-limited/blocking" : e.message) }); return; }
          const picks = pickResultsDetailed(links, t.x, searchTerms, sUrl);
          if (!picks.length) skipped.push({ label: labelOf(t.x), url: sUrl, reason: "search found no matching result" });
          for (const { url: pu, exact } of picks) {
            const { prop, value } = propForUrl(t.x, pu);
            const c = { site: t.x, url: applyUrlMode(pu, t.x.urlMode), value, prop };
            if (prop && !value) { skipped.push({ label: labelOf(t.x), url: pu, reason: "can't read the ID from this search result – add a template for it" }); continue; }
            let archiveRes = null;
            if (t.x.archive) { const a = await lookupArchive(c.url, signal); if (a.found) archiveRes = a; }
            addFound(c, { url: c.url, archive: archiveRes }, { viaSearch: true, needsApproval: !!t.x.approvePartial && !exact });
          }
        }
      } finally { done++; if (current) setStage(current.stage, done, tasks.length); }
    });
    entries.push(...foundMap.values());
    skipped.push(...missList.filter(m => !foundKeys.has(m.key)));
    await saveHistory(history, misses);
  }
  signal.throwIfAborted();

  // --- compare with the item ---
  let plan = [];
  if (entries.length) { setStage("comparing with the item on Wikidata…"); plan = await planSources(item, entries, signal); }
  const fresh = plan.filter(p => p.status !== "exists");
  const present = plan.filter(p => p.status === "exists");

  // --- review (a human decides when there is more than a little, or anything came from a search) ---
  let chosen = fresh, cancelled = false;
  // partial title matches (site option "approve partial matches") ALWAYS need a human decision, whatever the review setting
  const needReview = fresh.length && (fresh.some(p => p.entry.needsApproval) || s.review === "always" ||
    (s.review === "auto" && (fresh.length > s.reviewThreshold || fresh.some(p => p.entry.viaSearch))));
  if (needReview) {
    setStage("waiting for your review…");
    const sel = await askReview({
      item, itemLabel: terms.raw || "", maxPerEdit: s.maxPerEdit,
      rows: fresh.map(p => ({ id: p.id, label: p.entry.label, text: p.entry.property ? `${p.entry.property}: ${p.entry.value}` : p.entry.url,
        archive: p.entry.archive?.date || null, viaSearch: !!p.entry.viaSearch, needsApproval: !!p.entry.needsApproval, viaArchive: !!p.entry.viaArchive,
        note: p.status === "archive-added" ? "adds the archive URL to an existing statement"
          : p.status === "qualifier-added" ? "adds the URL to the existing P1343 statement"
          : p.group && !p.lead ? "added under the same new P1343 statement" : "new statement" })),
      present: present.map(p => describe(p.entry)), skipped: skipped.length
    });
    signal.throwIfAborted();
    if (sel === null) cancelled = true;
    else chosen = fresh.filter(p => sel.includes(p.id));
  }
  let deferred = [];
  if (chosen.length > s.maxPerEdit) { deferred = chosen.slice(s.maxPerEdit); chosen = chosen.slice(0, s.maxPerEdit); }

  // --- write (one edit) ---
  if (chosen.length && !cancelled) await commit(item, plan, chosen, s, signal);

  // --- history ---
  const now = Date.now();
  const items = history.items[item] = history.items[item] || {};
  const rec = (p, k) => { const e = p.entry; items[entryKey(e)] = {
    t: now, k, y: e.property ? "id" : "src", n: e.label, q: e.site.qid || "", p: e.property || "", u: e.url, v: e.value || "",
    a: !!(e.archive || (p.claim && hasQual(p.claim, P_ARCH))) }; };
  if (!cancelled) chosen.forEach(p => rec(p, "pushed"));
  present.forEach(p => rec(p, "present"));
  await saveHistory(history, misses);

  // --- report ---
  const lines = [
    ...(cancelled ? ["✗ review cancelled – nothing written"] : []),
    ...(cancelled ? [] : chosen.map(p => `✓ ${p.status === "archive-added" ? "archive URL added to existing statement" : "added"}: ${describe(p.entry)}`)),
    ...deferred.map(p => `… deferred (more than ${s.maxPerEdit} per edit): ${describe(p.entry)}`),
    ...present.map(p => `= already present: ${describe(p.entry)}`),
    ...knownLines.map(l => `= in your history log (not re-checked): ${l}`),
    ...skipped.map(n => `– skipped: ${n.label}${n.url ? " – " + n.url : ""} (${n.reason})`)
  ];
  await chrome.storage.local.set({ lastRun: { time: now, item, lines } });

  const tag = p => (p.entry.property ? ` (${p.entry.property})` : "") + (p.entry.archive ? " +archive" : "");
  const msg = [
    ...chosen.slice(0, 4).map(p => `✓ ${p.entry.label}${tag(p)}`),
    ...present.slice(0, 2).map(p => `= ${p.entry.label} (already there)`),
    knownLines.length ? `= ${knownLines.length} already in your log` : null,
    deferred.length ? `… ${deferred.length} deferred – run again for the rest` : null,
    skipped.length ? `– ${skipped.length} skipped/not found` : null
  ].filter(Boolean).join("\n");

  if (cancelled) return { level: "warn", title: "Cancelled", message: "Review cancelled – nothing was written.", badge: "■" };
  if (chosen.length) return { level: "ok", title: `Saved ${chosen.length} source${chosen.length > 1 ? "s" : ""} on ${item}`, message: msg, badge: "+" + chosen.length };
  return { level: "warn", title: "⚠ Already on Wikidata – nothing changed", message: msg || "Nothing new.", badge: "=" };
}

export async function run(tab, { only = false } = {}) {
  if (current) return; // a run is already in progress: ignore (the lock is taken synchronously, before any await)
  current = { abort: new AbortController(), stage: "starting…", done: 0, total: 0, dot: 0, startedAt: Date.now(),
    settings: DEFAULTS, blocked: new Set(), strikes: new Map() };
  const mine = current;
  startIndicators(); setStage("starting…");
  const signal = mine.abort.signal;
  let outcome;
  try {
    mine.settings = await getSettings();
    if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    signal.throwIfAborted();
    outcome = await runInner(tab, only, mine.settings, signal);
  } catch (e) {
    outcome = (e.name === "AbortError" || signal.aborted)
      ? { level: "warn", title: "Stopped", message: "Stopped – nothing more was written.", badge: "■" }
      : { level: "error", title: "Wikidata Source Saver", message: String(e.message || e) };
  } finally { endRun(); }
  notify(outcome.title, outcome.message, outcome.level, outcome.badge);
}

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd === "stop-run") return stopRun();
  if (cmd !== "save-source" && cmd !== "save-this-only") return;
  run(tab, { only: cmd === "save-this-only" }); // ignored by run() while another run is active
});
chrome.action.onClicked.addListener(tab => { if (current) stopRun(); else run(tab); });

export const _test = { get current() { return current; } };
