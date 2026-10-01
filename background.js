const API = "https://www.wikidata.org/w/api.php";
const P_SOURCE = "P1343"; // described by source
const P_URL = "P2699";    // URL (qualifier)

// ---------- config ----------
async function getSites() {
  const { sites = [] } = await chrome.storage.sync.get("sites");
  return sites;
}

function findSite(sites, urlStr) {
  const u = new URL(urlStr);
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const hostPath = host + u.pathname.toLowerCase();
  let best = null, bestLen = -1;
  for (const s of sites) {
    const m = (s.match || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
    if (!m || !s.qid) continue;
    const ok = m.includes("/") ? hostPath.startsWith(m) : (host === m || host.endsWith("." + m));
    if (ok && m.length > bestLen) { best = s; bestLen = m.length; }
  }
  return best; // most specific match wins
}

// ---------- clipboard ----------
async function readClipboard() {
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["CLIPBOARD"],
      justification: "Read the Wikidata item ID from the clipboard"
    });
  }
  return chrome.runtime.sendMessage({ target: "offscreen", type: "read-clipboard" });
}

function normUrl(u) {
  try {
    const x = new URL(u);
    return x.hostname.toLowerCase().replace(/^www\./, "") + x.pathname.replace(/\/+$/, "") + x.search + x.hash;
  } catch { return String(u).trim(); }
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

const SUMMARY = "Add source website and URL (via Wikidata Source Saver)";

async function addSource(item, siteQid, url) {
  const d = await api({ action: "wbgetclaims", entity: item, property: P_SOURCE });
  const existing = (d.claims && d.claims[P_SOURCE]) || [];
  const sameSite = existing.filter(c => c.mainsnak?.datavalue?.value?.id === siteQid);

  // Already there with this exact URL?
  for (const c of sameSite) {
    const urls = (c.qualifiers?.[P_URL] || []).map(q => normUrl(q.datavalue?.value));
    if (urls.includes(normUrl(url))) return { status: "exists" };
  }

  const token = await getCsrf();

  // Existing statement for this website without any URL qualifier -> just add the qualifier
  const bare = sameSite.find(c => !(c.qualifiers?.[P_URL] || []).length);
  if (bare) {
    await api({
      action: "wbsetqualifier", claim: bare.id, property: P_URL,
      snaktype: "value", value: JSON.stringify(url), token, summary: SUMMARY
    }, true);
    return { status: "qualifier-added" };
  }

  // Otherwise create a new statement with the qualifier
  const claim = {
    type: "statement", rank: "normal",
    mainsnak: {
      snaktype: "value", property: P_SOURCE,
      datavalue: { type: "wikibase-entityid", value: { "entity-type": "item", id: siteQid } }
    },
    qualifiers: {
      [P_URL]: [{ snaktype: "value", property: P_URL, datavalue: { type: "string", value: url } }]
    }
  };
  await api({
    action: "wbeditentity", id: item, data: JSON.stringify({ claims: [claim] }),
    token, summary: SUMMARY
  }, true);
  return { status: "created" };
}

// ---------- UI feedback ----------
const LEVELS = {
  ok:    { color: "#2e7d32", text: "✓", textColor: "#ffffff", ms: 3000 },
  warn:  { color: "#fbc02d", text: "=", textColor: "#000000", ms: 6000 }, // already present
  error: { color: "#c62828", text: "!", textColor: "#ffffff", ms: 5000 }
};

function notify(title, message, level = "ok") {
  const l = LEVELS[level] || LEVELS.ok;
  chrome.notifications.create({
    type: "basic", iconUrl: "icons/icon128.png", title, message
  });
  chrome.action.setBadgeBackgroundColor({ color: l.color });
  if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: l.textColor });
  chrome.action.setBadgeText({ text: l.text });
  clearTimeout(notify._t);
  notify._t = setTimeout(() => chrome.action.setBadgeText({ text: "" }), l.ms);
}

// ---------- main ----------
async function run(tab) {
  try {
    if (!tab?.url || !/^https?:/.test(tab.url)) throw new Error("This page can't be used (not an http/https page).");

    const site = findSite(await getSites(), tab.url);
    if (!site) {
      const host = new URL(tab.url).hostname.replace(/^www\./, "");
      await chrome.tabs.create({ url: chrome.runtime.getURL("options.html?add=" + encodeURIComponent(host)) });
      throw new Error(`No Wikidata item configured for ${host}. Opened settings so you can add it.`);
    }

    // URL cleanup
    let url = tab.url;
    if (site.urlMode === "canonical") {
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

    // Item from clipboard
    const clip = (await readClipboard()) || "";
    const m = clip.match(/\bQ\d+\b/i);
    if (!m) throw new Error("No Wikidata item (Qxxx) found in the clipboard.");
    const item = m[0].toUpperCase();
    const siteQid = site.qid.toUpperCase();

    const r = await addSource(item, siteQid, url);
    const what = `${item} ← ${P_SOURCE}: ${siteQid} (${site.name || site.match})`;
    if (r.status === "exists") notify("⚠ Already on Wikidata – nothing changed", `${what}\n${url}`, "warn");
    else notify("Saved to Wikidata", `${what}\n${url}`, "ok");
  } catch (e) {
    notify("Wikidata Source Saver", String(e.message || e), "error");
  }
}

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd !== "save-source") return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  run(tab);
});
chrome.action.onClicked.addListener(run);
