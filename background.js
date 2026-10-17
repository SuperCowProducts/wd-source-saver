import {
  normUrl, findCurrent, buildCandidates, dedupeIds, parseClipboard, checkUrl, unwrapArchive, waybackLatest,
  tsToDate, cleanTerm, alignToTerms, segmentWords, cats, catsFor, sharesCat, usable, scraperFor, pageIdPatterns, pageHtmlInPage, pageValueFor, wordVariants, searchUrl, extractLinks, pickResultsDetailed, parseSearchScript, pageOp, langsOf, termsForSite, KINDS, resolveArchiveUrl, redirectProblem, robotCheckInPage, looksLikeRobotCheckHtml, textFragmentFor,
  parseSiteClipboard, pathTemplate, formatterTemplate, usableValues,
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

// ---- debug log: every decision and request of a run, kept in storage (last runs) and optionally saved as a file ----
function dlog(level, msg, data, max = 1500) {
  if (!current?.log) return;
  const t = ((Date.now() - current.t0) / 1000).toFixed(3).padStart(7);
  let line = `[+${t}s] ${String(level).padEnd(5)} ${msg}`;
  if (data !== undefined) {
    let j;
    try { j = typeof data === "string" ? data : JSON.stringify(data); } catch { j = String(data); }
    if (j && j.length > max) j = j.slice(0, max) + `…(+${j.length - max} chars)`;
    if (j) line += " " + j;
  }
  current.log.push(line);
}

const LOG_KEEP = 8, LOG_MAX_CHARS = 2_000_000;
function buildLogEntry(run, outcome) {
  const text = [
    `=== Wikidata Source Saver ${VERSION} – ${new Date(run.t0).toISOString()} ===`,
    `item: ${run.item || "(none)"}   result: ${outcome.title} – ${String(outcome.message).replace(/\n/g, " / ")}`,
    "", ...run.log
  ].join("\n");
  return { time: new Date(run.t0).toISOString(), item: run.item || "", title: outcome.title, kind: outcome.kind, text };
}
async function persistLog(entry, s) {
  try {
    let { logs = [] } = await chrome.storage.local.get("logs");
    logs.push(entry);
    logs = logs.slice(-LOG_KEEP);
    while (logs.length > 1 && logs.reduce((n, l) => n + l.text.length, 0) > LOG_MAX_CHARS) logs.shift();
    await chrome.storage.local.set({ logs });
  } catch (e) { console.warn("log store failed", e); }
  if (s.logToFile) {
    try {
      if (!chrome.downloads || !(await chrome.permissions.contains({ permissions: ["downloads"] }))) return;
      const b64 = btoa(unescape(encodeURIComponent(entry.text)));
      const stamp = entry.time.replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
      await chrome.downloads.download({
        url: "data:text/plain;charset=utf-8;base64," + b64,
        filename: `WikidataSourceSaver/run-${stamp}-${entry.item || "noitem"}.log`,
        conflictAction: "uniquify", saveAs: false
      });
    } catch (e) { console.warn("log file failed", e); }
  }
}

function renderBadge() {
  if (!current) return;
  if (current.robot) {                                    // waiting for YOU to solve a robot check
    chrome.action.setBadgeBackgroundColor({ color: KINDS.robot.color });
    if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: KINDS.robot.text });
    chrome.action.setBadgeText({ text: "BOT" });
    chrome.action.setTitle({ title: `Robot check on ${current.robot.label}: solve it in the tab that opened – the run continues by itself` });
    return;
  }
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
  chrome.action.setTitle({ title: "Save this page as a source on the Wikidata item or lexeme in your clipboard" });
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
  if (w > 1500) dlog("WAIT", `${Math.round(w)} ms before the next request to ${host}`);
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
    if (!noBreaker && current?.blocked.has(host)) {
      dlog("WARN", `skipped ${url}: ${host} is blocked for the rest of this run`);
      throw Object.assign(new Error("blocked"), { blocked: true });
    }
    const { signal, timeoutMs = 15000, ...rest } = opts;
    await pace(host, signal);
    const sigs = [AbortSignal.timeout(timeoutMs)];
    if (signal) sigs.push(signal);
    let res;
    const t0 = Date.now(), method = rest.method || "GET";
    try { res = await fetch(url, { ...rest, signal: AbortSignal.any(sigs) }); }
    catch (e) { dlog("HTTP", `${method} ${url} -> ERROR ${e.name}: ${e.message} (${Date.now() - t0} ms)`); throw e; }
    finally { paced(host); }
    dlog("HTTP", `${method} ${url} -> ${res.status} (${Date.now() - t0} ms)${res.url && res.url !== url ? " final=" + res.url : ""}`);
    if (!noBreaker && current) {
      if ([429, 403, 503].includes(res.status)) { current.blocked.add(host); dlog("WARN", `${host} answered ${res.status}: not contacting it again in this run`); }
      else if (res.status >= 500) {
        const n = (current.strikes.get(host) || 0) + 1;
        current.strikes.set(host, n);
        if (n >= 2) { current.blocked.add(host); dlog("WARN", `${host} failed twice (${res.status}): not contacting it again in this run`); }
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

async function api(params, post = false, signal, waitSignal = signal, opts = {}) {
  const s = current?.settings || DEFAULTS;
  const body = new URLSearchParams({ format: "json", formatversion: "2", ...params });
  if (post) {
    body.set("assert", "user");                                  // never edit anonymously if the session expired
    const ml = opts.maxlag ?? s.maxlag;
    if (ml > 0) body.set("maxlag", String(ml));                 // reads never carry maxlag; 0 = off (Settings, or “this time only” in the lag window)
  }
  const k = s.hostDelayMs === 0 ? 0.01 : 1;
  const ATTEMPTS = 3;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const res = await hostFetch(post ? API : `${API}?${body}`, {
      method: post ? "POST" : "GET", body: post ? body : undefined, credentials: "include",
      headers: { "Api-User-Agent": UA(s) }, timeoutMs: 20000, signal
    }, { noBreaker: true });
    const retryAfter = Number(res.headers?.get?.("Retry-After")) || 0;
    if (res.status === 429 || res.status === 503) {
      if (attempt === ATTEMPTS) throw new RunError(`Wikidata answered ${res.status} (busy / rate limit) three times. Nothing was written – try again in a few minutes.`, "lag");
      const w = Math.min(30, retryAfter || 5 * attempt);
      dlog("WARN", `Wikidata ${res.status}: waiting ${w}s (attempt ${attempt}/${ATTEMPTS})`);
      setStage(`Wikidata busy (${res.status}) – waiting ${w}s`);
      await sleep(w * 1000 * k, waitSignal); continue;
    }
    const data = await res.json();
    if (data.error?.code === "maxlag") {
      if (attempt === ATTEMPTS) {
        throw Object.assign(new RunError(`Wikidata reports replication lag (maxlag ${opts.maxlag ?? s.maxlag}s): ${data.error.info || ""} Nothing was written. Try again later, or raise/disable “maxlag” in Settings → Safety & politeness if you accept editing during lag.`, "lag"),
          { maxlag: true, lag: data.error.lag, info: data.error.info || "" });
      }
      const w = Math.min(30, (retryAfter || data.error.lag || 5) + 1);
      dlog("WARN", `maxlag: Wikidata is ${data.error.lag ?? "?"}s behind; waiting ${w}s (attempt ${attempt}/${ATTEMPTS})`);
      setStage(`Wikidata lagging – waiting ${w}s before saving`);
      await sleep(w * 1000 * k, waitSignal); continue;
    }
    if (data.error?.code === "assertuserfailed") throw new RunError("You're not logged in to Wikidata. Log in, then try again.", "login");
    if (data.error) { dlog("ERROR", `Wikidata API error for ${params.action}`, data.error); throw new RunError(data.error.info || data.error.code, "api"); }
    return data;
  }
}

async function getCsrf(signal) {
  const d = await api({ action: "query", meta: "tokens", type: "csrf" }, false, signal);
  const t = d.query.tokens.csrftoken;
  if (t === "+\\") {
    chrome.tabs.create({ url: "https://www.wikidata.org/w/index.php?title=Special:UserLogin" });
    throw new RunError("You're not logged in to Wikidata. Log in, then try again.", "login");
  }
  return t;
}

// ======================================================================
// history log (everything pushed or found already present) + cache of definite misses
// ======================================================================
async function loadHistory(s) {
  const { history = { items: {} }, misses = {} } = await chrome.storage.local.get(["history", "misses"]);
  const cutoff = Date.now() - s.missTtlDays * 864e5;
  for (const k of Object.keys(misses)) {
    const v = typeof misses[k] === "number" ? { t: misses[k], why: "cached by an earlier version" } : misses[k];
    if (!v || v.t < cutoff) delete misses[k]; else misses[k] = v;
  }
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

// What identifies one source under a P1343 statement: normally a URL (P2699); for a YouTube video the video ID (P1651).
// Both kinds may sit in the SAME statement (a website with its own content may also have a YouTube presence).
const SRC_QUALS = [P_URL, "P1651"];
const srcQual = e => e.idQual ? { prop: e.idQual.prop, value: e.idQual.value, same: (a, b) => a === b }
                              : { prop: P_URL, value: e.url, same: (a, b) => normUrl(a) === normUrl(b) };
const srcKey = e => { const q = srcQual(e); return q.prop + "|" + (q.prop === P_URL ? normUrl(q.value) : q.value); };
const holdsSrc = (c, e) => { const q = srcQual(e); return (c.qualifiers?.[q.prop] || []).some(x => q.same(x.datavalue?.value, q.value)); };
const srcCount = c => SRC_QUALS.reduce((n, p) => n + (c.qualifiers?.[p] || []).length, 0);
const hasSrcQual = c => srcCount(c) > 0;

function newClaim(e) {
  if (e.property) {
    const c = { type: "statement", rank: "normal", mainsnak: snak(e.property, "string", e.value) };
    if (e.archive) c.qualifiers = archQuals(e.archive);
    return c;
  }
  return {
    type: "statement", rank: "normal",
    mainsnak: snak(P_SOURCE, "wikibase-entityid", { "entity-type": "item", id: e.site.qid.toUpperCase() }),
    qualifiers: { [srcQual(e).prop]: [snak(srcQual(e).prop, "string", srcQual(e).value)], ...(e.archive ? archQuals(e.archive) : {}) }
  };
}
function addQual(c, prop, sn, append = false) {
  c.qualifiers = c.qualifiers || {};
  c.qualifiers[prop] = append ? [...(c.qualifiers[prop] || []), sn] : [sn];
  if (Array.isArray(c["qualifiers-order"]) && !c["qualifiers-order"].includes(prop)) c["qualifiers-order"].push(prop);
}
function modifyClaim(c, e, status) {
  if (status === "qualifier-added") {
    const q = srcQual(e);
    if (!holdsSrc(c, e)) addQual(c, q.prop, snak(q.prop, "string", q.value), true);   // several URLs / video IDs share one P1343 statement
  }
  if (e.archive && !hasQual(c, P_ARCH)) {
    addQual(c, P_ARCH, snak(P_ARCH, "string", e.archive.url));
    addQual(c, P_ARCHDATE, snak(P_ARCHDATE, "time", timeValue(e.archive.date)));
  }
}

// one new P1343 statement carrying several P2699 URLs and/or P1651 video IDs
function newGroupClaim(entries) {
  const qualifiers = {};
  for (const e of entries) { const q = srcQual(e); (qualifiers[q.prop] = qualifiers[q.prop] || []).push(snak(q.prop, "string", q.value)); }
  return {
    type: "statement", rank: "normal",
    mainsnak: snak(P_SOURCE, "wikibase-entityid", { "entity-type": "item", id: entries[0].site.qid.toUpperCase() }),
    qualifiers
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
    const match = same.find(c => holdsSrc(c, entry));
    if (match) {
      // an archive link can only be attached to a statement that holds exactly this one URL / video ID (otherwise the pairing is lost)
      if (entry.archive && !hasQual(match, P_ARCH) && srcCount(match) === 1 && !archDone.has(match.id)) {
        archDone.add(match.id); return out("archive-added", match);
      }
      return out("exists", match);
    }
    const key = srcKey(entry);
    if (planned.some(p => p.q === q && p.key === key)) return out("exists");
    planned.push({ q, key });

    if (entry.archive) {                       // source + its own archive link: keep them together in their own statement
      const bare = same.find(c => !hasSrcQual(c) && !hasQual(c, P_ARCH) && !usedBare.has(c.id));
      if (bare) { usedBare.add(bare.id); return out("qualifier-added", bare); }
      return out("created");
    }
    // plain URL / video ID: put it under the item's existing P1343 statement for this source, or under ONE new statement shared by all new ones
    const target = same.find(c => !hasQual(c, P_ARCH));
    if (target) return out("qualifier-added", target);
    let g = groups.get(q);
    if (!g) { g = { lead: id }; groups.set(q, g); }
    plan.push({ id, entry, status: "created", group: q, lead: g.lead === id });
  });
  return plan;
}

// Which Wikidata statement does a planned change end up in?  (URLs of one website share one P1343 statement)
const stmtKey = p => p.claim?.id || (p.group ? "g:" + p.group : "n:" + p.id);
// "2+1" = two URLs in one statement + one separate statement; shown on the badge, notification and review button
export function groupCounts(items) {
  const m = new Map();
  for (const p of items) m.set(stmtKey(p), (m.get(stmtKey(p)) || 0) + 1);
  return [...m.values()];
}

// ONE edit containing every chosen change, after waiting for the edit-rate limits.
async function commit(item, plan, chosen, s, signal) {
  const now0 = Date.now();
  const { editTimes = [], lastEdit = 0 } = await chrome.storage.local.get(["editTimes", "lastEdit"]);
  const recent = editTimes.filter(t => now0 - t < 3600e3);
  if (recent.length >= s.maxEditsPerHour) {
    throw new RunError(`Hourly edit limit reached (${s.maxEditsPerHour}/hour – see Settings). Nothing was written; try again later.`, "cap");
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

  dlog("EDIT", `one edit on ${item}: ${chosen.length} change(s)`, claims, 8000);
  setStage("saving to Wikidata…");
  const token = await getCsrf(signal);
  signal.throwIfAborted();
  const summary = `Add ${chosen.length > 1 ? chosen.length + " sources/identifiers" : "source/identifier"} (via Wikidata Source Saver, user-initiated)`;
  const editParams = { action: "wbeditentity", id: item, data: JSON.stringify({ claims }), token, summary };
  let lagNow = s.maxlag;                       // this edit only – the saved setting is never changed here
  for (;;) {
    try {
      await api(editParams, true, undefined, signal, { maxlag: lagNow });   // the POST itself is never aborted; waiting for maxlag can be
      break;
    } catch (e) {
      if (!(e.kind === "lag" && e.maxlag)) throw e;
      // Everything is collected and ready – don't throw it away because of replication lag: let the user decide.
      setStage("waiting for your decision – Wikidata is lagging…");
      dlog("WARN", "save blocked by maxlag; asking the user", { lag: e.lag, maxlag: lagNow });
      const choice = await askReview({ kind: "lag", item, maxlag: lagNow, lag: e.lag ?? null, info: e.info || "",
        rows: chosen.map(p => describe(p.entry)) }, "lag.html", [560, 560]);
      signal.throwIfAborted();
      dlog("WARN", `lag decision: ${choice}`);
      if (choice === "off") lagNow = 0;           // retry this one save without maxlag
      else if (choice === "retry") continue;      // another round with the same maxlag
      else throw e;                               // cancelled / window closed: nothing written
      setStage("saving to Wikidata (maxlag off, this time only)…");
    }
  }
  const t = Date.now();
  dlog("EDIT", "saved");
  await chrome.storage.local.set({ lastEdit: t, editTimes: [...recent, t] });
}

// A URL typed into the review window. -> {url, prop, value} or {why}
function parseEditedUrl(e, text) {
  let u;
  try { u = new URL(String(text).trim()); } catch { return { why: "not a valid web address" }; }
  if (!/^https?:$/.test(u.protocol)) return { why: "only http(s) addresses" };
  const url = u.toString();
  if (e.idQual) {                                        // YouTube: the saved ID comes from the address (…?v=ID)
    const sc = scraperFor(url), id = sc?.qualProp === e.idQual.prop ? sc.idFromUrl(u) : "";
    return id ? { url, prop: "", value: "", idQual: { prop: e.idQual.prop, value: id } } : { why: `can't read the ${e.idQual.prop} video ID from this address` };
  }
  if (!e.property) return { url, prop: "", value: "" };
  if (pageIdPatterns(e.site).length) return matchTemplates(e.site, url) ? { url, prop: e.property, value: "", fromPage: true }     // the ID is read from that page when saving
    : { why: "the address matches none of the website's templates" };
  const r = propForUrl(e.site, url);                     // an ID row: the ID is re-read from the new address
  return r.value ? { url, prop: r.prop, value: r.value } : { why: "can't read the ID from this address (it matches none of the website's templates)" };
}
// The entry for an edited row: new URL, ID re-read from it, and the Wayback link looked up again for the new address
async function editedEntry(p, text, signal) {
  const e = p.entry, r = parseEditedUrl(e, text);
  if (!r.url) return null;
  if (r.fromPage) {                                                    // read the ID from the page at the edited address
    const f = await fetchPageId(e.site, r.url, signal).catch(err => { if (signal?.aborted) throw err; return { value: "", why: err.message }; });
    if (!f.value) return null;
    r.value = pageValueFor(e.site, matchTemplates(e.site, r.url)?.template, f.value);
  }
  let archive = null;
  if (e.site.archive) { const a = await lookupArchive(r.url, signal); if (a.found) archive = a; }
  return makeEntry(e.site, r.url, r.value, archive, r.prop || undefined, { viaSearch: e.viaSearch, edited: true, ...(r.idQual ? { idQual: r.idQual } : {}) });
}

// "q99" / "L5-f1" / a wikidata.org URL -> "Q99" / "L5-F1"; null when it is none of those
const normEntity = v => {
  const m = String(v || "").trim().match(/^(?:https?:\/\/(?:www\.|m\.)?wikidata\.org\/(?:wiki|entity)\/)?(?:Lexeme:)?(?:(Q\d+)|(L\d+)(?:[-#]([FS]\d+))?)\/?$/i);
  return m ? (m[1] || m[2] + (m[3] ? "-" + m[3] : "")).toUpperCase() : null;
};

// Items with property = value, e.g. P11245 = "NASA". The value may be stored with or without "@" and in another case, so a few spellings are tried.
async function itemsByStatement(prop, value, signal) {
  const bare = String(value).replace(/^@/, "");
  const tried = [...new Set([bare, "@" + bare, bare.toLowerCase(), "@" + bare.toLowerCase()])];
  for (const v of tried) {
    const d = await api({ action: "query", list: "search", srsearch: `haswbstatement:${prop}=${v}`, srnamespace: 0, srlimit: 5 }, false, signal);
    const items = (d.query?.search || []).map(x => x.title).filter(t => /^Q\d+$/.test(t));
    if (items.length) return { items, tried: tried.slice(0, tried.indexOf(v) + 1) };
  }
  return { items: [], tried };
}

// Q123 -> its English label; L123 -> its lemma(s); forms/senses -> their lexeme's lemma. "" when unknown.
const labelCache = new Map();
async function entityLabel(id) {
  id = String(id || "").toUpperCase();
  const m = id.match(/^(Q\d+|L\d+)(?:-[FS]\d+)?$/);
  if (!m) return "";
  const base = m[1];
  if (labelCache.has(base)) return labelCache.get(base);
  const isQ = base[0] === "Q";
  const d = await api({ action: "wbgetentities", ids: base, ...(isQ ? { props: "labels", languages: "en", languagefallback: "1" } : {}) }, false, new AbortController().signal);
  const e = d.entities?.[base];
  const out = isQ ? (e?.labels?.en?.value || Object.values(e?.labels || {})[0]?.value || "")
                  : Object.values(e?.lemmas || {}).map(l => l.value).join(" / ");
  labelCache.set(base, out);
  return out;
}

// ======================================================================
// human review window
// ======================================================================
function askReview(payload, page = "review.html", size = [780, 700], ctx = null) {
  return new Promise(async resolve => {
    const id = crypto.randomUUID();
    const rec = { payload, resolve, ctx };
    reviews.set(id, rec);
    const timer = setTimeout(() => { if (reviews.delete(id)) { resolve(null); if (rec.winId) chrome.windows.remove(rec.winId).catch(() => {}); } }, 15 * 60e3);
    rec.resolve = v => { clearTimeout(timer); resolve(v); };
    try {
      const win = await chrome.windows.create({ url: chrome.runtime.getURL(page + "?id=" + id), type: "popup", width: size[0], height: size[1] });
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
    // the review window also sends {selected, targets}: which rows, and which item/lexeme each one goes to
    if (r) { reviews.delete(msg.id); r.resolve(msg.cancel ? null : msg.targets ? { selected: msg.selected || [], targets: msg.targets, urls: msg.urls || {} } : msg.selected || []); if (r.winId) chrome.windows.remove(r.winId).catch(() => {}); }
    return;
  }
  if (msg?.type === "check-url") {                       // review window: is the URL typed into a row usable? (and what ID does it hold?)
    send(reviews.get(msg.id)?.ctx?.check?.(msg.row, msg.url) || { ok: false, why: "this review is no longer active" });
    return;
  }
  if (msg?.type === "entity-label") {                    // review window: a short name for a typed target, so a typo is easy to spot
    entityLabel(msg.id).then(send, () => send(""));
    return true;
  }
  if (msg?.type === "stop") { stopRun(); return; }
});

// ======================================================================
// notifications
// ======================================================================
class RunError extends Error { constructor(msg, kind) { super(msg); this.kind = kind; } }
function classify(e) {
  if (e?.kind) return e.kind;
  if (e?.name === "AbortError") return "stopped";
  if (e instanceof TypeError || e?.name === "TimeoutError" || /Failed to fetch|NetworkError|network/i.test(e?.message || "")) return "net";
  return "error";
}

// outcome = { kind, title?, message }; kind picks the symbol and colour
function notify(outcome) {
  const k = KINDS[outcome.kind] || KINDS.error;
  const badge = outcome.badge || k.badge;
  chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title: `${badge}  ${outcome.title || k.label}`, message: outcome.message || k.label });
  chrome.action.setBadgeBackgroundColor({ color: k.color });
  if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: k.text });
  chrome.action.setBadgeText({ text: badge });
  clearTimeout(notify._t);
  notify._t = setTimeout(() => chrome.action.setBadgeText({ text: "" }), k.ms);
}

// ======================================================================
// discovery helpers
// ======================================================================
async function ensureOffscreen() {
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html", reasons: ["CLIPBOARD", "DOM_PARSER"], justification: "Read the Wikidata item ID from the clipboard; read IDs out of page HTML"
    });
  }
}
async function readClipboard() {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: "offscreen", type: "read-clipboard" });
}
// ID of a website that only shows it inside the page: html -> {value, from} | {value:"", bad, hints}
async function readPageId(html, specs) {
  await ensureOffscreen();
  return (await chrome.runtime.sendMessage({ target: "offscreen", type: "page-id", html, specs })) || { value: "" };
}
// fetch a page (cookies sent when the website is set to) and read its ID: -> {value, url, why}
async function fetchPageId(site, url, signal) {
  if (!(await hasPerm(new URL(url).hostname))) return { value: "", why: "no permission – open settings and press Save" };
  const res = await hostFetch(url, { credentials: site.cookies ? "include" : "omit", timeoutMs: 15000, signal });
  if (!res.ok) return { value: "", why: `HTTP ${res.status}` };
  const html = (await res.text()).slice(0, 6e6);
  const got = await readPageId(html, pageIdPatterns(site));
  if (!got.value) dlog("WARN", `no "ID from the page" pattern matched ${url}`, { invalid: got.bad, longNumbersOnThePage: got.hints }, 3000);
  return { value: got.value || "", url: res.url || url, why: got.value ? "" : "none of the “ID from the page” patterns matched" };
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

// Selected text on the page -> "#:~:text=punto%20interno" (opens the page scrolled to / highlighting that passage)
async function selectionFragment(tab, site, s) {
  const mode = site.textFragment || (s.textFragment ? "on" : "off");
  if (mode !== "on") return "";
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => String((window.getSelection && window.getSelection()) || "") });
    return textFragmentFor(r?.result || "");
  } catch { return ""; }
}

const hasPerm = async host => chrome.permissions.contains({ origins: [`*://${host}/*`] });

async function lookupArchive(url, signal) {
  if (!(await hasPerm("web.archive.org"))) return { found: false, error: true, noPerm: true };
  let r = await waybackLatest(url, hostFetch, signal);
  if (r.found && !r.corrected) r = await resolveArchiveUrl(r, hostFetch, signal);
  dlog("ARCH", `${url} -> ${r.found ? r.url + (r.corrected ? "  (corrected by the Wayback Machine)" : "") : r.error ? "lookup failed" : "no snapshot"}`);
  return r;
}

async function checkWithPermission(c, s, signal) {
  if (!(await hasPerm(new URL(c.url).hostname))) return { found: false, reason: "no permission – open settings and press Save" };
  return checkUrl(c.url, c.site, s, hostFetch, signal, !!c.fromPage);
}

async function resolveCandidate(c, s, signal) {
  const live = await checkWithPermission(c, s, signal);
  // the archive is looked up for the address the live site ended on (its spelling is the right one)
  const arch = c.site.archive ? await lookupArchive(live.found ? live.url : c.url, signal) : null;
  const archive = arch?.found ? arch : null;
  if (live.found) {
    let value;
    if (c.fromPage) {                                                  // the ID value is inside the page: read it from the page that was just fetched
      const got = await readPageId(live.html || "", pageIdPatterns(c.site));
      if (got.value) value = pageValueFor(c.site, c.template, got.value);
      else dlog("WARN", `no "ID from the page" pattern matched ${live.url}`, { invalid: got.bad, longNumbersOnThePage: got.hints }, 3000);
    }
    return { found: true, url: live.url, archive, ...(c.fromPage ? { value, pageIdMissing: !value } : {}) };
  }
  if (archive) {
    // live site unreachable: the archived capture knows the correct spelling (…/Harmonic_Number -> …/Harmonic_number)
    const fixed = archive.original && archive.original !== c.url && !redirectProblem(c.site, c.url, archive.original) ? archive.original : c.url;
    return { found: true, url: fixed, archive, viaArchive: true };
  }
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

// Runs a parsed search script in an already loaded tab: clicks, pagination, collecting links.
// Every action is a separate executeScript call, so clicks that navigate to a new page keep working.
export async function runSearchScript(tabId, steps, site, signal, s, host, guard) {
  const k = s.hostDelayMs === 0 ? 0.01 : 1;                    // (tests run without delays)
  const ctx = { links: new Map(), notes: [], clicks: 0, deadline: Date.now() + s.scriptMaxSeconds * 1000 };
  const label = labelOf(site);
  const op = async (name, a) => {
    try { const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: pageOp, args: [name, a || {}] }); return r?.result; }
    catch (e) { if (signal.aborted) throw e; dlog("SCRIPT", `${name} failed: ${e.message}`); return null; }
  };
  const limit = () => {
    if (Date.now() > ctx.deadline) { if (!ctx.notes.includes("time limit reached")) ctx.notes.push("time limit reached"); return true; }
    if (ctx.clicks >= s.scriptMaxClicks) { if (!ctx.notes.includes("click limit reached")) ctx.notes.push("click limit reached"); return true; }
    return false;
  };
  const collect = async () => {
    const before = ctx.links.size;
    for (const l of (await op("collect")) || []) if (!ctx.links.has(l.href) && ctx.links.size < 3000) ctx.links.set(l.href, l);
    dlog("SCRIPT", `collect: +${ctx.links.size - before} new links (${ctx.links.size} total)`);
    return ctx.links.size - before;
  };
  const settle = async () => {                                  // let the click take effect: navigation, then dynamic content
    await sleep(900 * k, signal);
    for (let i = 0; i < 20; i++) { const t = await chrome.tabs.get(tabId); if (t.status === "complete") break; await sleep(500 * k, signal); }
    let last = -1;
    for (let i = 0; i < 5; i++) { const n = ((await op("collect")) || []).length; if (n === last) break; last = n; await sleep(700 * k, signal); }
    if (guard) await guard();                                   // a robot check may appear after any click
  };
  const sub = (t, v) => t.replace(/\{x\}/g, v.x ?? "").replace(/\{n\}/g, v.n ?? "");
  const click = async (kind, name, exact) => {
    if (limit()) return null;
    setStage(`searching ${label}… click ${kind} “${name}”`);
    await pace(host, signal);
    ctx.clicks++;
    const r = await op("click", { kind, name, exact });
    paced(host);
    dlog("SCRIPT", `click ${kind} "${name}" -> ${r?.ok ? "clicked" : "not found"}`);
    if (r?.ok) await settle();
    return !!r?.ok;
  };
  const run = async (list, vars) => {
    for (const st of list) {
      signal.throwIfAborted();
      if (limit()) return "stop";
      if (st.op === "click") {
        const name = sub(st.name, vars), ok = await click(st.kind, name, st.exact);
        if (ok === null) return "stop";
        if (!ok) { ctx.notes.push(`not found: ${st.kind} "${name}"`); if (vars.inEach) return "skip"; }
      } else if (st.op === "collect") await collect();
      else if (st.op === "wait") await sleep(st.ms * k, signal);
      else if (st.op === "pages") {
        let stalls = 0;
        for (let n = 2; n <= st.max; n++) {
          const ok = await click(st.kind, sub(st.tpl, { ...vars, n }), true);
          if (ok === null) return "stop";
          if (!ok) break;                                       // no such page link: that was the last page
          stalls = (await collect()) === 0 ? stalls + 1 : 0;
          if (stalls >= 2) { ctx.notes.push("pagination stopped: two pages in a row had no new links"); break; }
        }
      } else if (st.op === "each") {
        for (const x of st.values) { if ((await run(st.body, { ...vars, x, inEach: true })) === "stop") return "stop"; }
      }
    }
    return "ok";
  };
  await collect();
  await run(steps, {});
  dlog("SCRIPT", `done: ${ctx.clicks} clicks, ${ctx.links.size} links${ctx.notes.length ? ", notes: " + ctx.notes.join("; ") : ""}`);
  return { links: [...ctx.links.values()], notes: ctx.notes };
}

// ---- robot checks: tell the user, bring the tab forward, wait for them to solve it, then carry on ----
async function isRobotCheck(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    if (/google\.[a-z.]+\/sorry\//i.test(t?.url || "")) return true;
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: robotCheckInPage });
    return !!r?.result;
  } catch { return false; }
}
function notifyRobot(label, tabId, canSolve) {
  const id = `robot-${tabId ?? "x"}-${Date.now()}`;
  try {
    chrome.notifications.create(id, {
      type: "basic", iconUrl: "icons/icon128.png", requireInteraction: true, priority: 2,
      title: `BOT  Robot check – ${label}`,
      message: canSolve
        ? `${label} asks you to confirm you are not a robot. Solve it in the tab that just opened – the search continues by itself afterwards.`
        : `${label} asks to confirm you are not a robot, so this search was stopped. Open the site in a normal tab and solve it, or switch the website to “render in a background tab” so the extension can wait for you.`
    });
  } catch (e) { console.warn("robot notification failed", e); }
  return id;
}
async function robotWait(tabId, host, label, signal) {
  const s = current?.settings || DEFAULTS;
  const k = s.hostDelayMs === 0 ? 0.01 : 1;
  if (current) current.robotSeen = true;
  dlog("ROBOT", `robot check on ${host}`);
  if (!(s.captchaWaitSeconds > 0)) {
    notifyRobot(label, tabId, false);
    current?.blocked.add(host);
    throw Object.assign(new Error(`${label} shows a robot check – search stopped (rate-limited/blocking)`), { blocked: true });
  }
  try {
    const t = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (t?.windowId != null) await chrome.windows.update(t.windowId, { focused: true });
  } catch { /* tab may be gone */ }
  const nid = notifyRobot(label, tabId, true);
  current.robot = { tabId, host, label };
  setStage(`waiting for you: robot check on ${label}`);
  const deadline = Date.now() + s.captchaWaitSeconds * 1000;
  try {
    while (Date.now() < deadline) {
      await sleep(2000 * k, signal);
      if (!(await isRobotCheck(tabId))) { dlog("ROBOT", "solved – continuing"); await sleep(1000 * k, signal); return; }
    }
  } finally { if (current) { current.robot = null; renderBadge(); } try { chrome.notifications.clear(nid); } catch { /* ignore */ } }
  current?.blocked.add(host);
  throw Object.assign(new Error(`${label} still shows a robot check after ${s.captchaWaitSeconds}s – search stopped (rate-limited/blocking)`), { blocked: true });
}
chrome.notifications?.onClicked?.addListener(async id => {         // clicking the notification brings the tab forward
  const m = /^robot-(\d+)-/.exec(id);
  if (!m) return;
  try { const t = await chrome.tabs.get(Number(m[1])); await chrome.tabs.update(t.id, { active: true }); await chrome.windows.update(t.windowId, { focused: true }); } catch { /* gone */ }
});

// Result links of a site's own search page. "fetch" = plain request; "tab" = render in a background tab (JS-driven sites)
async function fetchSearchLinks(site, url, signal) {
  const host = new URL(url).hostname;
  if (!(await hasPerm(host))) throw new Error("no permission – open settings and press Save");
  if (site.searchMode === "tab" || (site.searchScript || "").trim()) {
    return serial(host, async () => {
      if (current?.blocked.has(host)) throw Object.assign(new Error("blocked"), { blocked: true });
      await pace(host, signal);
      const tab = await chrome.tabs.create({ url, active: false });
      try {
        await waitTabComplete(tab.id, 20000, signal);
        const captcha = () => isRobotCheck(tab.id).then(r => r && robotWait(tab.id, host, labelOf(site), signal));
        await captcha();
        const script = (site.searchScript || "").trim();
        if (script) {
          let steps;
          try { steps = parseSearchScript(script); } catch (e) { throw new Error("search script, " + e.message); }
          await sleep((current?.settings?.hostDelayMs === 0 ? 10 : 1500), signal);
          const r = await runSearchScript(tab.id, steps, site, signal, current?.settings || DEFAULTS, host, captcha);
          await captcha();
          const out = r.links; out.notes = r.notes;
          return out;
        }
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
        await captcha();
        return links;
      } finally { paced(host); chrome.tabs.remove(tab.id).catch(() => {}); }
    });
  }
  const res = await hostFetch(url, { credentials: "omit", timeoutMs: 15000, signal });
  const html = (await res.text()).slice(0, 3_000_000);
  if (/google\.[a-z.]+\/sorry\//i.test(res.url || "") || looksLikeRobotCheckHtml(html)) {
    if (current) current.robotSeen = true;
    current?.blocked.add(host);
    dlog("ROBOT", `robot check on ${host} (plain request)`);
    notifyRobot(labelOf(site), null, false);
    throw Object.assign(new Error(`${labelOf(site)} showed a robot check – search stopped (rate-limited/blocking). Use “render in a background tab” for this website so you can solve it and the run can continue.`), { blocked: true });
  }
  if (!res.ok) throw new Error("HTTP " + res.status);
  return extractLinks(html, res.url || url);
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
  const main = e.property ? `${e.label} (${e.property}: ${e.value})` : `${e.label} – ${e.url}${e.idQual ? ` (${e.idQual.prop}: ${e.idQual.value})` : ""}`;
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
// defining a website from the clipboard:  "Label (Q123)"  or  "Label (P123)"
// ======================================================================
async function fetchSiteDefinition(d, signal) {
  const s = current?.settings || DEFAULTS;
  const out = { label: d.label, urls: [], notes: [] };
  if (!out.label) {
    try {
      const r = await api({ action: "wbgetentities", ids: d.id, props: "labels", languages: s.labelLang || "en", languagefallback: "1" }, false, signal);
      out.label = Object.values(r.entities?.[d.id]?.labels || {})[0]?.value || "";
    } catch (e) { if (signal.aborted) throw e; out.notes.push(`couldn't read the label of ${d.id}: ${e.message}`); }
  }
  const prop = d.kind === "item" ? "P856" : "P1630";               // official website  |  formatter URL
  try {
    const r = await api({ action: "wbgetclaims", entity: d.id, property: prop }, false, signal);
    out.urls = usableValues(r.claims?.[prop]).slice(0, 3);
    if (!out.urls.length) out.notes.push(`${d.id} has no ${prop} (${d.kind === "item" ? "official website" : "formatter URL"}) – add the URL template yourself`);
  } catch (e) { if (signal.aborted) throw e; out.notes.push(`couldn't read ${prop}: ${e.message}`); }
  return out;
}

async function defineFromClipboard(tab, signal, explicit) {
  const d = parseSiteClipboard((await readClipboard()) || "", { allowBareItem: explicit });
  if (!d) {
    if (explicit) throw new RunError("To configure a website from Wikidata, copy “Label (Q123)” (an item = the website/publisher) or “Label (P123)” / P123 (an ID property), then press this shortcut.", "clipboard");
    return null;
  }
  current.item = d.id;
  setStage(`reading ${d.id} from Wikidata…`);
  const def = await fetchSiteDefinition(d, signal);
  const templates = def.urls.map(d.kind === "item" ? pathTemplate : formatterTemplate).filter(Boolean);
  let host = ""; try { host = new URL(tab.url).hostname.replace(/^www\./, ""); } catch { /* ignore */ }
  const pending = {
    name: def.label, ...(d.kind === "item" ? { qid: d.id } : { idProperty: d.id }),
    templates, match: templates.length ? "" : host,                       // with a template the match is derived from it
    note: `${def.label || d.id} (${d.id})` + (templates.length ? ` · ${def.urls.join(" · ")}` : "") + (def.notes.length ? " · " + def.notes.join("; ") : "")
  };
  dlog("INFO", "website definition from the clipboard", pending);
  await chrome.storage.local.set({ pendingSite: pending });
  await chrome.tabs.create({ url: chrome.runtime.getURL("options.html?prefill=1") });
  return { kind: "config", title: "CFG  Website pre-filled from Wikidata",
    message: `${def.label || d.id} (${d.id}) is filled in in Settings${templates.length ? ": " + templates.join(", ") : ""}.${def.notes.length ? "\n" + def.notes.join("\n") : ""}\nAdd a category, press “Save all”, then run again on this page.` };
}

// ======================================================================
// the run
// ======================================================================
async function runInner(tab, only, s, signal, configure = false) {
  if (configure) return defineFromClipboard(tab, signal, true);
  if (!tab?.url || !/^https?:/.test(tab.url)) throw new RunError("This page can't be used (not an http/https page).", "page");
  const un = unwrapArchive(tab.url);
  const href = un ? un.original : tab.url;

  const sites = await getSites();
  const fileState = (await chrome.storage.local.get("fileStatus")).fileStatus;
  if (fileState && !fileState.ok) dlog("WARN", "website data file: " + fileState.msg);
  const cur = findCurrent(sites, href);
  if (!cur) {
    const def = await defineFromClipboard(tab, signal, false);          // "Label (Q123)" / "Label (P123)" on an unknown page
    if (def) return def;
    const host = new URL(href).hostname.replace(/^www\./, "");
    await chrome.tabs.create({ url: chrome.runtime.getURL("options.html?add=" + encodeURIComponent(host)) });
    throw new RunError(`No Wikidata item configured for ${host}. Opened settings so you can add it.`, "config");
  }
  const site = cur.site;
  const curCats = catsFor(site, cur.extracted);                         // categories of THIS page (a {a|b} group follows the URL's choice)
  let url = await pageUrl(tab, site, href, !!un);
  dlog("INFO", `page ${tab.url}${un ? " (web.archive.org snapshot of " + href + ")" : ""}`);
  dlog("INFO", `matched website "${labelOf(site)}"`, { qid: site.qid, idProperty: site.idProperty, categories: catsFor(site, cur.extracted), separator: site.separator, caseMode: site.caseMode, archive: !!site.archive });
  dlog("INFO", "ID read from the URL", cur.extracted ? { template: cur.extracted.template, raw: cur.extracted.raw, words: cur.extracted.words, sep: cur.extracted.sep, prop: cur.extracted.prop, choices: cur.extracted.choices } : "(page doesn't match a template)");
  const frag = await selectionFragment(tab, site, s);
  if (frag) { url = url.split("#")[0] + frag; dlog("INFO", "the text you selected is added as a text fragment", frag); }
  dlog("INFO", `URL that will be saved: ${url}`);

  setStage("reading clipboard…");
  const parsed = parseClipboard((await readClipboard()) || "");
  if (!parsed) throw new RunError("The clipboard must start with a Wikidata item or lexeme – Q123, L123 (form L123-F1, sense L123-S1) or a wikidata.org URL – optionally followed by extra terms (Q123, en: some term, it: un termine).", "clipboard");
  const item = parsed.item;
  current.item = item;
  dlog("INFO", "clipboard", { item, extras: parsed.extras.map(e => e.text) });

  const { history, misses } = await loadHistory(s);
  const known = s.useHistory ? (history.items[item] || {}) : {};
  for (const k of Object.keys(misses)) if (normUrl(k) === normUrl(href) || normUrl(k) === normUrl(url)) { delete misses[k]; dlog("CACHE", `forgot cached miss for ${k} (you are on that page)`); }
  const isKnown = (key, archiveWanted) => { const r = known[key]; return !!r && (!archiveWanted || r.a); };

  // --- terms: ONLY the page's own ID and the extras you typed. Wikidata labels/aliases are never used. ---
  const extras = parsed.extras;                                        // [{text, words, lang}] (validated by parseClipboard)
  const pageLang = langsOf(site)[0] || "";
  let pageWords = null;
  if (cur.extracted) {
    const ambiguous = cur.extracted.sep === "none";                    // run-together ID: only your extras can say where the words split
    pageWords = (ambiguous && alignToTerms(cur.extracted, termsForSite(extras, site))) || cur.extracted.words;
    // still one lump (e.g. investopedia …/incomestatement.asp)? try splitting it with the English word list,
    // but only for English sites and only when your extras did not already say where the words split
    if (ambiguous && pageWords.length === 1 && (!pageLang || pageLang === "en")) {
      const seg = segmentWords(pageWords[0]);
      if (seg) { dlog("INFO", "split run-together ID with the word list", `${pageWords[0]} -> ${seg.join(" ")}`); pageWords = seg; }
    }
  }
  const scraper = !un ? scraperFor(href) : null;                       // YouTube video page: the video ID is not a word
  if (scraper?.noTerms) pageWords = null;
  const pageTerm = pageWords ? { text: pageWords.join(" "), words: pageWords, lang: pageLang } : null;
  const searchTerms = [pageTerm, ...extras].filter(Boolean);
  const ids = dedupeIds(searchTerms.map(t => ({ words: t.words, lang: t.lang })));

  dlog("INFO", "terms (page ID + your extras)", searchTerms.map(t => `${t.lang || "*"}: ${t.text}`));
  dlog("INFO", "words used to build URLs", ids.map(i => `${i.lang || "*"}: ${i.words.join(" ")}`));

  // --- the current page ---
  let archive = null;
  if (site.archive) {
    if (un) archive = { url: `https://web.archive.org/web/${un.timestamp}/${un.original}`, date: tsToDate(un.timestamp) };
    else { setStage("looking up the Wayback Machine…"); const a = await lookupArchive(url, signal); if (a.found) archive = a; }
  }
  const entries = [], skipped = [], knownLines = [];
  if (fileState && !fileState.ok) skipped.push({ label: "Website data file", url: "", reason: fileState.msg });
  const firstProp = cur.extracted ? cur.extracted.prop : (siteDefaultProp(site) === "P1343" ? "" : siteDefaultProp(site));
  // YouTube video page: the source is the CHANNEL's item (the one whose YouTube handle, P11245, is the handle embedded in the page),
  // saved as P1343 + P2699 (the URL holds the video ID). Not found -> the page is saved the way the website is configured.
  let entrySite = site, entryProp = firstProp, entryValue = cur.extracted?.value, entryExtra = {};
  if (scraper) {
    setStage(`reading the page for the ${scraper.name}…`);
    let got = null;
    try { const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scraper.func }); got = r?.result; } catch (e) { dlog("WARN", `page scrape failed: ${e.message}`); }
    if (!got?.value) skipped.push({ label: scraper.name, url: href, reason: "not found on the page (let the video page finish loading and try again) – saved as the website is configured" });
    else {
      setStage(`looking for the Wikidata item with ${scraper.prop} = ${got.value}…`);
      const found = await itemsByStatement(scraper.prop, got.value, signal);
      dlog("INFO", `${scraper.name}: ${got.value} (${got.from})`, { searched: found.tried, items: found.items });
      if (found.items.length === 1) {
        const lbl = await entityLabel(found.items[0]).catch(() => "");
        entrySite = { ...site, qid: found.items[0], name: lbl ? `${lbl} (${labelOf(site)})` : labelOf(site) };
        entryProp = ""; entryValue = undefined;
        let vid = ""; try { vid = scraper.idFromUrl(new URL(href)); } catch { /* keep empty */ }
        if (vid) entryExtra = { idQual: { prop: scraper.qualProp, value: vid } };
        dlog("INFO", `source item: ${found.items[0]}${lbl ? " " + lbl : ""} (${scraper.prop} = ${got.value}); the video is saved as P1343 + ${vid ? scraper.qualProp + " " + vid : "P2699 (no video ID in the URL)"}`);
      } else skipped.push({ label: scraper.name, url: href, reason: (found.items.length
        ? `${found.items.length} items have ${scraper.prop} = ${got.value} (${found.items.join(", ")})`
        : `no Wikidata item has ${scraper.prop} = ${got.value}`) + " – saved as the website is configured" });
    }
  }
  // ID that only the PAGE carries (OED: …/dictionary/automobile_adj, entry ID 8269459060 inside the page): read it with the website's "ID from the page" patterns
  let pageIdFailed = false;
  const idPats = pageIdPatterns(site);
  if (entryProp && entrySite === site && idPats.length) {
    entryValue = undefined;                                           // never the slug from the URL
    if (un) { pageIdFailed = true; skipped.push({ label: labelOf(site), url: href, reason: `the ${entryProp} value is read from the live page, but this is a web.archive.org snapshot – open the live page and try again` }); }
    else {
      setStage(`reading the ${entryProp} value from the page…`);
      let got = null;
      try {
        const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageHtmlInPage });
        got = await readPageId(r?.result || "", idPats);
      } catch (e) { dlog("WARN", `page ID read failed: ${e.message}`); }
      if (got?.value) { entryValue = pageValueFor(site, cur.extracted?.template, got.value); dlog("INFO", `${entryProp} value read from the page: ${got.value} (${got.from})${entryValue !== got.value ? " -> " + entryValue : ""}`); }
      else {
        pageIdFailed = true;
        dlog("WARN", `no \"ID from the page\" pattern matched`, { patterns: idPats, invalid: got?.bad, longNumbersOnThePage: got?.hints }, 3000);
        skipped.push({ label: labelOf(site), url: href, reason: `the ${entryProp} value wasn't found on the page (none of the website's “ID from the page” lines matched – let the page finish loading, or check them; the debug log lists long numbers found on the page)` });
      }
    }
  }
  const first = makeEntry(entrySite, url, entryValue, archive, entryProp, entryExtra);
  if (!first) { if (!pageIdFailed) skipped.push({ label: labelOf(site), url: href, reason: whyNot(site, firstProp) }); }
  else if (isKnown(entryKey(first), first.archiveWanted)) knownLines.push(describe(first));
  else entries.push(first);

  // --- related websites ---
  if (!only && s.related && curCats.length) {
    const seen = new Set([normUrl(href), normUrl(url)]);
    const cands = buildCandidates(sites, site, ids, { perSite: s.maxPerSite, total: s.maxTotal, curCats }).filter(c => {
      if (seen.has(normUrl(c.url))) return false;
      if (isKnown(keyFor(c.site, c.url, c.value, c.prop), !!c.site.archive)) { knownLines.push(`${labelOf(c.site)} – ${c.url}`); return false; }
      if (misses[c.url]) {
        const m = misses[c.url];
        skipped.push({ label: labelOf(c.site), url: c.url, reason: `not re-checked: cached as not existing since ${new Date(m.t).toISOString().slice(0, 10)} (${m.why}). Settings → Test your templates → “Check if they exist” clears it if the page exists; or clear the cache in Settings → History log` });
        dlog("CACHE", `skipped ${c.url}: cached miss from ${new Date(m.t).toISOString()} (${m.why})`);
        return false;
      }
      return true;
    });
    dlog("INFO", `${cands.length} URL guesses (after skipping the current page, history and cached misses)`, cands.map(c => `${c.site.name || c.site.qid}${c.prop ? " [" + c.prop + "]" : ""} ${c.url}`), 6000);
    const searchSites = sites.filter(x => usable(x) && x.searchUrl && sharesCat(curCats, x));
    // at most two queries per website, from the terms in that website's language(s)
    // (a website with "plural / singular forms" ticked also gets the other number of the main noun: "financial statements" -> + "financial statement")
    const queriesFor = x => {
      const base = [...new Map(termsForSite(searchTerms, x).map(t => [t.text.toLowerCase(), t])).values()].slice(0, 2);
      if (!x.plurals) return base;
      const out = new Map();
      for (const t of base) for (const w of wordVariants(t.words).slice(0, 2)) {
        const text = w.join(" "); if (!out.has(text.toLowerCase())) out.set(text.toLowerCase(), { ...t, text, words: w });
      }
      return [...out.values()].slice(0, 4);
    };
    const tasks = [
      ...cands.map(c => ({ kind: "check", c })),
      ...searchSites.flatMap(x => queriesFor(x).map(q => ({ kind: "search", x, q })))
    ];
    let done = 0;
    setStage("checking related websites…", 0, tasks.length);
    const foundKeys = new Set(), missList = [], foundMap = new Map();
    const addFound = (c, r, extra = {}) => {
      let cc = c;
      if (r.url && r.url !== c.url) {                 // spelling/redirect corrected by the site or the archive: store THAT, not our guess
        const m = matchTemplates(c.site, r.url);
        if (m) cc = { ...c, prop: m.prop, value: m.value };
        else if (c.prop) return skipped.push({ label: labelOf(c.site), url: r.url, reason: `corrected to ${r.url}, which matches no template – can't read the ${c.prop} value from it` });
        dlog("CHECK", `${c.url} was corrected to ${r.url}`, cc.value !== c.value ? { value: `${c.value} -> ${cc.value}` } : undefined);
      }
      if (cc.prop && pageIdPatterns(cc.site).length) {                 // ID lives in the page: never the slug of the URL
        cc = { ...cc, value: r.value || undefined };
        if (!cc.value) return skipped.push({ label: labelOf(c.site), url: r.url, reason: r.viaArchive ? `the ${cc.prop} value is read from the live page, which couldn't be reached` : `the page exists but its ${cc.prop} value wasn't found on it (check the website's “ID from the page” lines; a login may be needed – tick “send my cookies”)` });
      }
      const e = makeEntry(cc.site, r.url, cc.value, r.archive, cc.prop, { viaArchive: r.viaArchive, ...extra });
      if (!e) return skipped.push({ label: labelOf(c.site), url: r.url, reason: whyNot(c.site, cc.prop) });
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
          dlog("CHECK", `${t.c.url} -> ${r.found ? "FOUND" + (r.viaArchive ? " (archive only)" : "") : "no: " + r.reason}`);
          const key = t.c.site.name + "|" + t.c.template;
          if (r.found) { foundKeys.add(key); addFound(t.c, r); }
          else {
            if (r.stopped) signal.throwIfAborted();
            missList.push({ key, label: labelOf(t.c.site), url: t.c.url, reason: r.reason });
            if (r.definitive) misses[t.c.url] = { t: Date.now(), why: r.reason };
          }
        } else {
          setStage(`searching ${labelOf(t.x)} for “${t.q.text}”… (${done + 1}/${tasks.length})`);
          const sUrl = searchUrl(t.x, t.q.text);
          let links;
          try { links = await fetchSearchLinks(t.x, sUrl, signal); }
          catch (e) { if (signal.aborted) throw e; skipped.push({ label: labelOf(t.x), url: sUrl, reason: "search failed: " + (e.message && e.message !== "blocked" ? e.message : "host rate-limited/blocking") }); return; }
          if (links.notes?.length) skipped.push({ label: labelOf(t.x), url: sUrl, reason: "search script: " + links.notes.join("; ") });
          const picks = pickResultsDetailed(links, t.x, termsForSite(searchTerms, t.x), sUrl);
          dlog("SRCH", `${sUrl}: ${links.length} links on the page; first 40`, links.slice(0, 40).map(l => `${l.text.slice(0, 60)} | ${l.href}`), 5000);
          dlog("SRCH", `kept ${picks.length}`, picks);
          if (!picks.length) skipped.push({ label: labelOf(t.x), url: sUrl, reason: "search found no matching result" });
          for (const { url: pu, exact } of picks) {
            let { prop, value } = propForUrl(t.x, pu);
            const c = { site: t.x, url: applyUrlMode(pu, t.x.urlMode), value, prop };
            let pv = "";
            if (prop && !value && pageIdPatterns(t.x).length) {          // ID inside the page: open the result and read it
              const f = await fetchPageId(t.x, c.url, signal).catch(e => { if (signal.aborted) throw e; return { value: "", why: e.message === "blocked" ? "host rate-limited/blocking" : e.message }; });
              if (f.value) { pv = pageValueFor(t.x, matchTemplates(t.x, c.url)?.template, f.value); value = pv; c.value = pv; }
              else { skipped.push({ label: labelOf(t.x), url: pu, reason: `couldn't read the ${prop} value from this search result's page: ${f.why}` }); continue; }
            }
            if (prop && !value) { skipped.push({ label: labelOf(t.x), url: pu, reason: "can't read the ID from this search result – add a template for it" }); continue; }
            let archiveRes = null;
            if (t.x.archive) { const a = await lookupArchive(c.url, signal); if (a.found) archiveRes = a; }
            addFound(c, { url: c.url, archive: archiveRes, value: pv }, { viaSearch: true, needsApproval: !!t.x.approvePartial && !exact });
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
  dlog("PLAN", `${plan.length} entries compared with ${item}`, plan.map(p => `${p.status}${p.group ? " (shared P1343)" : ""}: ${describe(p.entry)}`), 5000);
  const fresh = plan.filter(p => p.status !== "exists");
  const present = plan.filter(p => p.status === "exists");

  // --- review (a human decides when there is more than a little, or anything came from a search) ---
  let chosen = fresh, cancelled = false;
  const edits = new Map();                                             // plan id -> URL typed over the found one in the review window
  const targets = new Map();                                           // plan id -> item/lexeme chosen in the review window (default: the main one)
  // partial title matches (site option "approve partial matches") ALWAYS need a human decision, whatever the review setting
  const needReview = fresh.length && (fresh.some(p => p.entry.needsApproval) || s.review === "always" ||
    (s.review === "auto" && (fresh.length > s.reviewThreshold || fresh.some(p => p.entry.viaSearch))));
  if (needReview) {
    setStage("waiting for your review…");
    const sel = await askReview({
      item, itemLabel: "", maxPerEdit: s.maxPerEdit,
      rows: fresh.map(p => ({ id: p.id, label: p.entry.label, text: p.entry.property ? `${p.entry.property}: ${p.entry.value}` : p.entry.url,
        gkey: stmtKey(p), siteq: p.entry.property ? "" : (p.entry.site.qid || ""), archive: p.entry.archive?.date || null, archiveUrl: p.entry.archive?.url || null, url: p.entry.url, viaSearch: !!p.entry.viaSearch, needsApproval: !!p.entry.needsApproval, viaArchive: !!p.entry.viaArchive,
        note: p.status === "archive-added" ? "adds the archive URL to an existing statement"
          : p.status === "qualifier-added" ? "adds the URL to the existing P1343 statement"
          : p.group && !p.lead ? "added under the same new P1343 statement" : "new statement" })),
      present: present.map(p => describe(p.entry)), skipped: skipped.length,
      // items/lexemes you have saved to before, most recent first: offered as quick targets in the window
      known: Object.entries(history.items).filter(([q]) => q !== item)
        .map(([q, o]) => [q, Math.max(0, ...Object.values(o).map(x => x.t || 0))]).sort((a, c) => c[1] - a[1]).slice(0, 25).map(x => x[0])
    }, "review.html", [780, 700], {
      check: (row, url) => {
        const p = fresh.find(x => x.id === Number(row));
        if (!p) return { ok: false, why: "unknown row" };
        const r = parseEditedUrl(p.entry, url);
        if (!r.url) return { ok: false, why: r.why };
        const host = u => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
        return { ok: true, url: r.url, text: r.fromPage ? `${r.prop}: (read from the page when you save)` : r.value ? `${r.prop}: ${r.value}` : r.idQual ? `${r.idQual.prop}: ${r.idQual.value}` : "",
          warn: host(r.url) !== host(p.entry.url) ? "different website than before" : "",
          archive: !!p.entry.site.archive };
      }
    });
    signal.throwIfAborted();
    dlog("REVIEW", sel === null ? "cancelled / closed" : `approved ${sel.length} of ${fresh.length}`, sel);
    if (sel === null) cancelled = true;
    else {
      const ids = Array.isArray(sel) ? sel : sel.selected;
      for (const [k, v] of Object.entries(Array.isArray(sel) ? {} : sel.targets || {})) {   // row -> item/lexeme it was sent to
        const t = normEntity(v);
        if (t && t !== item) targets.set(Number(k), t);
      }
      chosen = fresh.filter(p => ids.includes(p.id));
      for (const [k, v] of Object.entries(Array.isArray(sel) ? {} : sel.urls || {})) edits.set(Number(k), String(v));
    }
  }
  // rows sent to another item/lexeme are compared with THAT entity and saved there, one edit per target
  const targetOf = p => targets.get(p.id) || item;
  const movedBy = new Map();
  for (const p of chosen) if (targetOf(p) !== item) { const T = targetOf(p); if (!movedBy.has(T)) movedBy.set(T, []); movedBy.get(T).push(p); }
  chosen = chosen.filter(p => targetOf(p) === item);
  // rows whose URL was edited: rebuild the entry (ID re-read, archive looked up again) and compare with the target again
  const entryOf = new Map();
  for (const p of [...chosen, ...[...movedBy.values()].flat()]) {
    if (!edits.has(p.id) || edits.get(p.id) === p.entry.url) continue;
    setStage("reading the edited address…");
    const ne = await editedEntry(p, edits.get(p.id), signal);
    if (ne) { entryOf.set(p.id, ne); dlog("REVIEW", `URL edited: ${p.entry.url} -> ${ne.url}${ne.property ? `  (${ne.property}: ${ne.value})` : ""}`); }
    else skipped.push({ label: p.entry.label, url: edits.get(p.id), reason: "edited address not usable – the original was kept" });
  }
  const entryFor = p => entryOf.get(p.id) || p.entry;
  let editedPresent = [];
  if (!cancelled && chosen.some(p => entryOf.has(p.id))) {
    setStage("comparing the edited rows with the item on Wikidata…");
    const planE = await planSources(item, chosen.map(entryFor), signal);
    editedPresent = planE.filter(p => p.status === "exists");
    chosen = planE.filter(p => p.status !== "exists");
  }
  let deferred = [];
  if (chosen.length > s.maxPerEdit) { deferred = chosen.slice(s.maxPerEdit); chosen = chosen.slice(0, s.maxPerEdit); }
  if (movedBy.size) dlog("REVIEW", "rows sent to other targets", [...movedBy].map(([T, ps]) => `${T}: ${ps.map(p => describe(p.entry)).join(" | ")}`));

  // --- write (one edit per target) ---
  let failure = null;
  const written = [];                                  // [{target, p}] everything really saved
  const presentBy = new Map([[item, [...present, ...editedPresent]]]);        // target -> changes that turned out to be there already
  if (chosen.length && !cancelled) {
    try { await commit(item, plan, chosen, s, signal); chosen.forEach(p => written.push({ target: item, p })); } catch (e) { failure = e; }
  }
  if (!cancelled && !failure) for (const [T, ps] of movedBy) {
    try {
      setStage(`comparing with ${T} on Wikidata…`);
      const planT = await planSources(T, ps.map(entryFor), signal);
      dlog("PLAN", `${planT.length} entries compared with ${T}`, planT.map(p => `${p.status}${p.group ? " (shared P1343)" : ""}: ${describe(p.entry)}`), 5000);
      presentBy.set(T, planT.filter(p => p.status === "exists"));
      let freshT = planT.filter(p => p.status !== "exists");
      if (freshT.length > s.maxPerEdit) { deferred.push(...freshT.slice(s.maxPerEdit).map(p => ({ ...p, target: T }))); freshT = freshT.slice(0, s.maxPerEdit); }
      if (freshT.length) { await commit(T, planT, freshT, s, signal); freshT.forEach(p => written.push({ target: T, p })); }
    } catch (e) { failure = e; break; }               // what was already saved is still recorded below
  }
  chosen = written.map(w => Object.assign(w.p, { target: w.target }));
  const multi = new Set([item, ...movedBy.keys()]).size > 1;
  const at = p => (p.target && p.target !== item ? ` → ${p.target}` : "");

  // --- history ---
  const now = Date.now();
  const rec = (T, p, k) => { const e = p.entry; const items = history.items[T] = history.items[T] || {}; items[entryKey(e)] = {
    t: now, k, y: e.property ? "id" : "src", n: e.label, q: e.site.qid || "", p: e.property || "", u: e.url, v: e.value || "",
    a: !!(e.archive || (p.claim && hasQual(p.claim, P_ARCH))) }; };
  if (!cancelled) written.forEach(w => rec(w.target, w.p, "pushed"));
  for (const [T, ps] of presentBy) ps.forEach(p => rec(T, p, "present"));
  await saveHistory(history, misses);
  dlog("INFO", `history: ${written.length} pushed, ${[...presentBy.values()].flat().length} present, ${Object.keys(misses).length} cached misses`);
  if (failure) {
    if (written.length && !signal.aborted && failure.message) failure.message = `Already saved (${written.map(w => describe(w.p.entry) + at({ target: w.target })).join("; ")}). Then: ` + failure.message;
    throw failure;
  }

  // --- report ---
  const lines = [
    ...(cancelled ? ["✗ review cancelled – nothing written"] : []),
    ...(cancelled ? [] : chosen.map(p => `✓ ${p.status === "archive-added" ? "archive URL added to existing statement" : "added"}: ${describe(p.entry)}${at(p)}`)),
    ...deferred.map(p => `… deferred (more than ${s.maxPerEdit} per edit): ${describe(p.entry)}${at(p)}`),
    ...[...presentBy].flatMap(([T, ps]) => ps.map(p => `= already present${T !== item ? " on " + T : ""}: ${describe(p.entry)}`)),
    ...knownLines.map(l => `= in your history log (not re-checked): ${l}`),
    ...skipped.map(n => `– skipped: ${n.label}${n.url ? " – " + n.url : ""} (${n.reason})`)
  ];
  await chrome.storage.local.set({ lastRun: { time: now, item, lines } });

  const tag = p => (p.entry.property ? ` (${p.entry.property})` : "") + (p.entry.archive ? " +archive" : "");
  const msg = [
    ...chosen.slice(0, 4).map(p => `✓ ${p.entry.label}${tag(p)}${at(p)}`),
    ...[...presentBy.values()].flat().slice(0, 2).map(p => `= ${p.entry.label} (already there)`),
    knownLines.length ? `= ${knownLines.length} already in your log` : null,
    deferred.length ? `… ${deferred.length} deferred – run again for the rest` : null,
    skipped.length ? `– ${skipped.length} skipped/not found` : null
  ].filter(Boolean).join("\n");

  if (cancelled) return { kind: "cancelled", message: "Review cancelled – nothing was written." };
  const trouble = (current?.blocked.size || 0) > 0 || skipped.some(n => /timeout|network error|rate-limited|blocking|failed|HTTP 5|HTTP 403|HTTP 429/.test(n.reason));
  const noPerm = skipped.some(n => /no permission/.test(n.reason));
  if (chosen.length) {
    const groups = [...new Set(chosen.map(p => p.target || item))].flatMap(T => groupCounts(chosen.filter(p => (p.target || item) === T))), split = groups.length > 1 ? groups.join("+") : "";
    let badge = split || "+" + chosen.length;
    if (trouble) badge += "!";
    if (badge.length > 4) badge = "+" + chosen.length + (trouble ? "!" : "");     // the badge only has room for ~4 characters
    dlog("INFO", `written: ${chosen.length} change(s) in ${groups.length} statement(s)`, groups);
    return { kind: trouble ? "partial" : "ok", badge,
      title: `${badge}  ${trouble ? "Saved with problems" : "Saved " + chosen.length + " source" + (chosen.length > 1 ? "s" : "")}${split ? " (" + split + ")" : ""} on ${multi ? [...new Set(chosen.map(p => p.target || item))].join(", ") : item}`, message: msg };
  }
  if (presentBy.size && [...presentBy.values()].some(a => a.length) || knownLines.length) return { kind: "present", message: msg || "Nothing new." };
  if (current?.robotSeen) return { kind: "robot", message: "A website asked you to confirm you are not a robot.\n" + msg };
  if ((current?.blocked.size || 0) > 0) return { kind: "blocked", message: msg + "\nBlocked: " + [...current.blocked].join(", ") };
  if (noPerm) return { kind: "perm", message: "Open Settings and press “Save all” to give the extension access to the websites in your templates/search URLs.\n" + msg };
  if (trouble) return { kind: "net", message: msg };
  return { kind: "nothing", message: msg || "No matching pages were found on the related websites." };
}

export async function run(tab, { only = false, configure = false } = {}) {
  if (current) return; // a run is already in progress: ignore (the lock is taken synchronously, before any await)
  current = { abort: new AbortController(), stage: "starting…", done: 0, total: 0, dot: 0, startedAt: Date.now(),
    settings: DEFAULTS, blocked: new Set(), strikes: new Map(), log: [], t0: Date.now(), item: "" };
  const mine = current;
  startIndicators(); setStage("starting…");
  const signal = mine.abort.signal;
  let outcome;
  try {
    mine.settings = await getSettings();
    dlog("INFO", `run started (this page only: ${only})`);
    dlog("INFO", "settings", { ...mine.settings, username: mine.settings.username ? "(set)" : "" });
    if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    signal.throwIfAborted();
    outcome = await runInner(tab, only, mine.settings, signal, configure);
  } catch (e) {
    dlog("ERROR", e?.stack || String(e));
    const kind = signal.aborted ? "stopped" : classify(e);
    outcome = kind === "stopped" ? { kind, message: "Stopped – nothing more was written." }
      : { kind, message: String(e.message || e) };
  }
  outcome.title = outcome.title || (KINDS[outcome.kind] || KINDS.error).label;
  dlog("INFO", `outcome [${outcome.kind}]: ${outcome.title} – ${String(outcome.message).replace(/\n/g, " / ")}`);
  const entry = buildLogEntry(mine, outcome);
  endRun();
  await persistLog(entry, mine.settings);
  notify(outcome);
}

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd === "stop-run") return stopRun();
  if (cmd !== "save-source" && cmd !== "save-this-only" && cmd !== "configure-site") return;
  run(tab, { only: cmd === "save-this-only", configure: cmd === "configure-site" }); // ignored by run() while another run is active
});
chrome.action.onClicked.addListener(tab => { if (current) stopRun(); else run(tab); });

export const _test = { get current() { return current; } };
