import {
  normUrl, findCurrent, buildCandidates, dedupeIds, parseClipboard, checkUrl,
  unwrapArchive, waybackLatest, tsToDate
} from "./lib.js";

const API = "https://www.wikidata.org/w/api.php";
const P_SOURCE = "P1343";   // described by source
const P_URL = "P2699";      // URL (qualifier)
const P_ARCH = "P1065";     // archive URL (qualifier)
const P_ARCHDATE = "P2960"; // archive date (qualifier)
const DEFAULT_SETTINGS = { related: true, redirects: "skip" };

// ---------- config ----------
async function getSites() {
  const { sites = [] } = await chrome.storage.sync.get("sites");
  return sites;
}
async function getSettings() {
  const { settings = {} } = await chrome.storage.sync.get("settings");
  return { ...DEFAULT_SETTINGS, ...settings };
}
const labelOf = s => s.name || s.match || s.qid || s.idProperty;

// ---------- clipboard ----------
async function readClipboard() {
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html", reasons: ["CLIPBOARD"],
      justification: "Read the Wikidata item ID from the clipboard"
    });
  }
  return chrome.runtime.sendMessage({ target: "offscreen", type: "read-clipboard" });
}

// ---------- Wikidata API (uses your logged-in browser session) ----------
async function api(params, post = false) {
  const body = new URLSearchParams({ format: "json", formatversion: "2", ...params });
  const res = post
    ? await fetch(API, { method: "POST", body, credentials: "include" })
    : await fetch(`${API}?${body}`, { credentials: "include" });
  const data = await res.json();
  if (data.error) throw new Error(data.error.info || data.error.code);
  return data;
}

async function getCsrf() {
  const d = await api({ action: "query", meta: "tokens", type: "csrf" });
  const t = d.query.tokens.csrftoken;
  if (t === "+\\") {
    chrome.tabs.create({ url: "https://www.wikidata.org/w/index.php?title=Special:UserLogin" });
    throw new Error("You're not logged in to Wikidata. Log in, then try again.");
  }
  return t;
}

const timeValue = d => ({
  time: `+${d}T00:00:00Z`, timezone: 0, before: 0, after: 0, precision: 11,
  calendarmodel: "http://www.wikidata.org/entity/Q1985727"
});
const snak = (property, type, value) => ({ snaktype: "value", property, datavalue: { type, value } });

// qualifiers for a new statement
function archiveQualifiers(a) {
  return {
    [P_ARCH]: [snak(P_ARCH, "string", a.url)],
    [P_ARCHDATE]: [snak(P_ARCHDATE, "time", timeValue(a.date))]
  };
}
// wbsetqualifier operations for an existing statement
function archiveOps(claim, a) {
  return [
    { claim, property: P_ARCH, value: a.url },
    { claim, property: P_ARCHDATE, value: timeValue(a.date) }
  ];
}
const hasQual = (c, p) => (c.qualifiers?.[p] || []).length > 0;

// entries: [{site, url, label, archive?, property?, value?}]
//   property set  -> external-ID statement  Pxxx: value
//   no property   -> P1343: <website item> with qualifier P2699: <url>
//   archive set   -> also qualifiers P1065 (archive URL) + P2960 (archive date)
// -> [{entry, status: "exists" | "created" | "qualifier-added" | "archive-added"}]
export async function addSources(item, entries) {
  const props = [...new Set(entries.map(e => e.property || P_SOURCE))];
  const claimsBy = {};
  await Promise.all(props.map(async p => {
    const d = await api({ action: "wbgetclaims", entity: item, property: p });
    claimsBy[p] = (d.claims && d.claims[p]) || [];
  }));

  const planned = [], plannedIds = [], usedBare = new Set(), archDone = new Set();
  const newClaims = [], ops = [], results = [];

  for (const entry of entries) {
    if (entry.property) {
      const p = entry.property;
      const have = claimsBy[p].find(c => c.mainsnak?.datavalue?.value === entry.value);
      if (have) {
        if (entry.archive && !hasQual(have, P_ARCH) && !archDone.has(have.id)) {
          archDone.add(have.id);
          ops.push(...archiveOps(have.id, entry.archive));
          results.push({ entry, status: "archive-added" });
        } else results.push({ entry, status: "exists" });
        continue;
      }
      if (plannedIds.some(x => x.p === p && x.v === entry.value)) { results.push({ entry, status: "exists" }); continue; }
      plannedIds.push({ p, v: entry.value });
      const claim = { type: "statement", rank: "normal", mainsnak: snak(p, "string", entry.value) };
      if (entry.archive) claim.qualifiers = archiveQualifiers(entry.archive);
      newClaims.push(claim);
      results.push({ entry, status: "created" });
      continue;
    }

    const q = entry.site.qid.toUpperCase();
    const same = claimsBy[P_SOURCE].filter(c => c.mainsnak?.datavalue?.value?.id === q);
    const urlMatch = same.find(c => (c.qualifiers?.[P_URL] || []).some(x => normUrl(x.datavalue?.value) === normUrl(entry.url)));
    if (urlMatch) {
      if (entry.archive && !hasQual(urlMatch, P_ARCH) && !archDone.has(urlMatch.id)) {
        archDone.add(urlMatch.id);
        ops.push(...archiveOps(urlMatch.id, entry.archive));
        results.push({ entry, status: "archive-added" });
      } else results.push({ entry, status: "exists" });
      continue;
    }
    if (planned.some(p => p.q === q && normUrl(p.url) === normUrl(entry.url))) { results.push({ entry, status: "exists" }); continue; }

    planned.push({ q, url: entry.url });
    const bare = same.find(c => !hasQual(c, P_URL) && !usedBare.has(c.id));
    if (bare) {
      usedBare.add(bare.id);
      ops.push({ claim: bare.id, property: P_URL, value: entry.url });
      if (entry.archive && !hasQual(bare, P_ARCH)) ops.push(...archiveOps(bare.id, entry.archive));
      results.push({ entry, status: "qualifier-added" });
    } else {
      newClaims.push({
        type: "statement", rank: "normal",
        mainsnak: snak(P_SOURCE, "wikibase-entityid", { "entity-type": "item", id: q }),
        qualifiers: {
          [P_URL]: [snak(P_URL, "string", entry.url)],
          ...(entry.archive ? archiveQualifiers(entry.archive) : {})
        }
      });
      results.push({ entry, status: "created" });
    }
  }

  if (newClaims.length || ops.length) {
    const token = await getCsrf();
    const n = results.filter(r => r.status !== "exists").length;
    const summary = `Add ${n > 1 ? n + " sources/identifiers" : "source/identifier"} (via Wikidata Source Saver)`;
    if (newClaims.length) {
      await api({ action: "wbeditentity", id: item, data: JSON.stringify({ claims: newClaims }), token, summary }, true);
    }
    for (const op of ops) {
      await api({ action: "wbsetqualifier", claim: op.claim, property: op.property,
        snaktype: "value", value: JSON.stringify(op.value), token, summary }, true);
    }
  }
  return results;
}

// ---------- UI feedback ----------
const LEVELS = {
  ok:    { color: "#2e7d32", textColor: "#ffffff", ms: 4000 },
  warn:  { color: "#fbc02d", textColor: "#000000", ms: 6000 }, // already present
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

// ---------- helpers ----------
async function pageUrl(tab, site, href, wrapped) {
  let url = href;
  if (site.urlMode === "canonical" && !wrapped) { // (an archived copy's canonical link is not reliable)
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.querySelector('link[rel="canonical"]')?.href || null
    });
    if (result) url = result;
  } else {
    const u = new URL(url);
    if (site.urlMode === "noquery") u.search = "";
    if (site.urlMode !== "asis") u.hash = "";
    url = u.toString();
  }
  return url;
}

async function checkWithPermission(cand, settings) {
  const host = new URL(cand.url).hostname;
  const ok = await chrome.permissions.contains({ origins: [`*://${host}/*`] });
  if (!ok) return { found: false, reason: "no permission – open settings and press Save" };
  return checkUrl(cand.url, cand.site, settings);
}

async function lookupArchive(url) {
  const ok = await chrome.permissions.contains({ origins: ["*://web.archive.org/*"] });
  if (!ok) return { found: false, error: true, noPerm: true };
  return waybackLatest(url);
}

// live page and/or latest Wayback snapshot (for sites flagged as unreliable)
async function resolveCandidate(c, settings) {
  const [live, arch] = await Promise.all([
    checkWithPermission(c, settings),
    c.site.archive ? lookupArchive(c.url) : Promise.resolve(null)
  ]);
  const archive = arch?.found ? arch : null;
  if (live.found) return { found: true, url: live.url, archive };
  if (archive) return { found: true, url: c.url, archive, viaArchive: true };
  const why = arch ? (arch.noPerm ? "no permission for web.archive.org – open settings and press Save"
                    : arch.error ? "Wayback lookup failed" : "no Wayback snapshot") : null;
  return { found: false, reason: why ? `${live.reason}; ${why}` : live.reason };
}

// run async fn over items with limited concurrency (be polite to the websites)
async function mapPool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

function makeEntry(site, url, value, archive, viaArchive) {
  const base = {
    site, url, label: labelOf(site), viaArchive: !!viaArchive,
    archiveWanted: !!site.archive,
    archive: site.archive && archive ? { url: archive.url, date: archive.date } : null
  };
  if (!site.idProperty) return base;
  const property = (site.idProperty.match(/P\d+/i) || [""])[0].toUpperCase();
  if (!property || !value) return null; // can't build an external-ID statement without the ID
  return { ...base, property, value };
}

function describe(e) {
  const main = e.property ? `${e.label} (${e.property}: ${e.value})` : `${e.label} – ${e.url}`;
  const arch = e.archive ? ` + archive ${e.archive.date}` : e.archiveWanted ? " (no Wayback snapshot found)" : "";
  return main + arch + (e.viaArchive ? " [live site unreachable]" : "");
}

// ---------- main ----------
async function run(tab, { only = false } = {}) {
  try {
    if (!tab?.url || !/^https?:/.test(tab.url)) throw new Error("This page can't be used (not an http/https page).");

    // a page viewed on web.archive.org is treated as the original page + that snapshot
    const un = unwrapArchive(tab.url);
    const href = un ? un.original : tab.url;

    const [sites, settings] = await Promise.all([getSites(), getSettings()]);
    const cur = findCurrent(sites, href);
    if (!cur) {
      const host = new URL(href).hostname.replace(/^www\./, "");
      await chrome.tabs.create({ url: chrome.runtime.getURL("options.html?add=" + encodeURIComponent(host)) });
      throw new Error(`No Wikidata item configured for ${host}. Opened settings so you can add it.`);
    }
    const site = cur.site;
    const url = await pageUrl(tab, site, href, !!un);

    const parsed = parseClipboard((await readClipboard()) || "");
    if (!parsed) throw new Error("No Wikidata item (Qxxx) found in the clipboard.");

    const entries = [];
    const notFound = [];

    let archive = null;
    if (site.archive) {
      archive = un ? { url: `https://web.archive.org/web/${un.timestamp}/${un.original}`, date: tsToDate(un.timestamp) }
                   : await lookupArchive(url);
      if (archive && !archive.found && !un) archive = null;
    }
    const first = makeEntry(site, url, cur.extracted?.raw, archive);
    if (first) entries.push(first);
    else notFound.push({ label: labelOf(site), url: href, reason: `couldn't read the ID for ${site.idProperty} from this URL – check the template` });

    if (!only && settings.related && (site.category || "").trim()) {
      const ids = dedupeIds([
        ...(cur.extracted ? cur.extracted.variants.map(w => ({ words: w })) : []),
        ...parsed.extras.map(t => ({ words: t.split(/[\s_\-]+/).filter(Boolean) }))
      ]);
      if (!ids.length) {
        notFound.push({ label: labelOf(site), url: "", reason: "couldn't read the term from this page's URL (no template matches)" });
      } else {
        const seen = new Set([normUrl(href), normUrl(url)]);
        const cands = buildCandidates(sites, site, ids).filter(c => !seen.has(normUrl(c.url)));
        const foundKeys = new Set(), misses = [];
        const checked = await mapPool(cands, 8, async c => ({ c, r: await resolveCandidate(c, settings) }));
        for (const { c, r } of checked) {
          const key = c.site.name + "|" + c.site.qid + "|" + c.site.idProperty + "|" + c.template;
          if (r.found) {
            foundKeys.add(key);
            const e = makeEntry(c.site, r.url, c.value, r.archive, r.viaArchive);
            if (e) entries.push(e);
          } else misses.push({ key, label: labelOf(c.site), url: c.url, reason: r.reason });
        }
        // an alternative spelling/folder that worked makes the misses for the same template irrelevant
        notFound.push(...misses.filter(m => !foundKeys.has(m.key)));
      }
    }

    if (!entries.length) throw new Error(notFound[0]?.reason || "Nothing to save.");
    const results = await addSources(parsed.item, entries);
    const added = results.filter(r => r.status !== "exists");
    const present = results.filter(r => r.status === "exists");

    const lines = [
      ...added.map(r => `✓ ${r.status === "archive-added" ? "archive URL added to existing statement" : "added"}: ${describe(r.entry)}`),
      ...present.map(r => `= already present: ${describe(r.entry)}`),
      ...notFound.map(n => `– skipped: ${n.label}${n.url ? " – " + n.url : ""} (${n.reason})`)
    ];
    await chrome.storage.local.set({ lastRun: { time: Date.now(), item: parsed.item, lines } });

    const tag = r => (r.entry.property ? ` (${r.entry.property})` : "") + (r.entry.archive ? " +archive" : "");
    const msg = [
      ...added.slice(0, 4).map(r => `✓ ${r.entry.label}${tag(r)}`),
      ...present.slice(0, 3).map(r => `= ${r.entry.label} (already there)`),
      notFound.length ? `– ${notFound.length} related page${notFound.length > 1 ? "s" : ""} not found/skipped` : null
    ].filter(Boolean).join("\n");

    if (added.length) {
      notify(`Saved ${added.length} source${added.length > 1 ? "s" : ""} on ${parsed.item}`, msg, "ok", "+" + added.length);
    } else {
      notify("⚠ Already on Wikidata – nothing changed", msg, "warn");
    }
  } catch (e) {
    notify("Wikidata Source Saver", String(e.message || e), "error");
  }
}

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd !== "save-source" && cmd !== "save-this-only") return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  run(tab, { only: cmd === "save-this-only" });
});
chrome.action.onClicked.addListener(tab => run(tab));
