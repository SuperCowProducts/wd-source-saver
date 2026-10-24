const id = new URLSearchParams(location.search).get("id");
const $ = x => document.getElementById(x);
let payload = null;
const mkLink = (href, label) => { const a = document.createElement("a"); a.href = href; a.textContent = label; a.target = "_blank"; a.rel = "noopener noreferrer"; a.addEventListener("click", e => e.stopPropagation()); return a; };
// only http(s) addresses become links; everything is inserted as text, never as HTML
function linkify(text, parent) {
  const re = /https?:\/\/[^\s<>"']+/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    let u = m[0]; const trail = (u.match(/[.,;:)\]]+$/) || [""])[0];
    if (trail) u = u.slice(0, -trail.length);
    parent.append(mkLink(u, u)); if (trail) parent.append(trail);
    last = m.index + m[0].length;
  }
  if (last < text.length) parent.append(text.slice(last));
}
// Q123 -> /wiki/Q123, L123 -> /wiki/Lexeme:L123, L123-F1 -> /wiki/Lexeme:L123#F1 (form), L123-S1 -> …#S1 (sense)
const entityUrl = q => { const m = String(q || "").match(/^(?:(Q\d+)|(L\d+)(?:-([FS]\d+))?)$/); return m ? "https://www.wikidata.org/wiki/" + (m[1] || "Lexeme:" + m[2] + (m[3] ? "#" + m[3] : "")) : null; };
const itemLink = q => entityUrl(q) ? mkLink(entityUrl(q), q) : document.createTextNode(q);


// "q99" / "L5-f1" / a wikidata.org URL -> "Q99" / "L5-F1"; null when it is none of those
const normId = s => {
  const m = String(s || "").trim().match(/^(?:https?:\/\/(?:www\.|m\.)?wikidata\.org\/(?:wiki|entity)\/)?(?:Lexeme:)?(?:(Q\d+)|(L\d+)(?:[-#]([FS]\d+))?)\/?$/i);
  return m ? (m[1] || m[2] + (m[3] ? "-" + m[3] : "")).toUpperCase() : null;
};
const targets = new Map();          // row id -> target ("" = the main item)
const inputs = new Map();           // row id -> its target <input>
const urlEdits = new Map();         // row id -> edited URL (only valid, changed ones)
const labels = new Map();           // entity id -> short name ("" while unknown)
const known = new Set();            // everything offered in the datalist
const rowsById = () => new Map(payload.rows.map(r => [r.id, r]));
const tOf = id => targets.get(id) || payload.item;
const ticked = () => [...document.querySelectorAll("input[type=checkbox][data-id]")].filter(c => c.checked);

function addKnown(t) {
  if (!t || known.has(t)) return;
  known.add(t);
  const o = document.createElement("option"); o.value = t; $("targets").append(o);
}
async function labelOf(t, into) {
  if (!t) { into.textContent = ""; return; }
  if (!labels.has(t)) { labels.set(t, ""); try { labels.set(t, (await chrome.runtime.sendMessage({ type: "entity-label", id: t })) || ""); } catch { /* no label */ } }
  into.textContent = labels.get(t);
}

// the website item typed on a row from an unknown website: show its name next to the box, so a wrong Q… is obvious
const qLabelCache = new Map();                                    // Q… -> name (only real answers are kept)
function watchWebsiteItem(qi, out) {
  let seq = 0, timer = 0;
  const show = (text, color, title) => { out.textContent = text; out.style.color = color || ""; out.title = title || text; };
  const run = async () => {
    const my = ++seq, v = qi.value.trim();
    if (!v) { show(""); return; }
    const q = qOk(v) ? normId(v) : null;
    if (!q) { show(""); return; }                                 // the red field border already says it is not a Q…
    if (qLabelCache.has(q)) { show("= " + qLabelCache.get(q)); return; }
    show("looking up " + q + "…");
    let name = null;
    try { name = (await chrome.runtime.sendMessage({ type: "entity-label", id: q })) || ""; } catch { name = null; }
    if (my !== seq) return;                                       // the box changed while we were asking
    if (name === null) show("could not look up " + q, "#c62828");
    else if (!name) show("⚠ " + q + " has no label (or does not exist) – double-check the ID", "#c62828");
    else { qLabelCache.set(q, name); show("= " + name); }
  };
  qi.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 250); });
  qi.addEventListener("change", () => { clearTimeout(timer); run(); });
}
const blockedHosts = new Set();                                    // sites blocked in this window (saved to the block list when it closes)
const hostOf = u => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
function setBlocked(host, on) {                                    // block/unblock every row of that site: unticked, greyed out, can't be ticked
  if (on) blockedHosts.add(host); else blockedHosts.delete(host);
  for (const row of document.querySelectorAll(".row")) {
    if (row.dataset.host !== host) continue;
    const cb = row.querySelector("input[data-id]"), btn = row.querySelector(".bblk");
    if (on) { row.dataset.was = cb.checked ? "1" : ""; cb.checked = false; cb.disabled = true; }
    else { cb.disabled = false; cb.checked = row.dataset.was === "1"; }
    row.classList.toggle("blocked", on);
    btn.textContent = on ? `blocked – undo (${btn.dataset.label})` : `block ${btn.dataset.label}`;
  }
  update();
}
// What a row can block: a YouTube VIDEO blocks its CHANNEL (youtube.com/@handle - youtube.com itself and other channels stay allowed; the video URL does not
// hold the channel, so the background script read it from YouTube); every other URL blocks its website. null = a video whose channel could not be read.
function blockTarget(r) {
  if (r.yt) return r.channel ? { key: r.channel.key, label: "channel " + r.channel.label, channel: true } : null;
  const h = hostOf(r.url);
  return h ? { key: h, label: h } : null;
}
function blockButton(row, t) {
  const b = document.createElement("button"); b.className = "bblk"; b.textContent = `block ${t.label}`; b.type = "button"; b.dataset.label = t.label;
  b.title = t.channel ? "Never show videos of this YouTube channel again - other channels (and youtube.com) stay allowed (the list is in Settings → Blocked sites)"
                      : "Never show results from this site again (the list is in Settings → Blocked sites)";
  b.onclick = () => setBlocked(t.key, !blockedHosts.has(t.key));
  row.dataset.host = t.key;
  return b;
}
// the block button of a row, or - for a YouTube video whose channel is unknown - a note instead (blocking youtube.com would be far too much)
function blockControl(d, r) {
  const t = blockTarget(r);
  if (t) return blockButton(d, t);
  if (!r.yt) return null;
  const n = document.createElement("span"); n.className = "lbl"; n.textContent = "channel unknown – can't block it (see the run report)";
  return n;
}
const metaInputs = new Map();                                      // rows from unknown websites: category + language boxes (used when the website is added to Settings)
const wInputs = new Map();                                       // rows saved as P1343 (website item): id -> box to OVERRIDE the website item saved in Settings
const qInputs = new Map(), rememberBoxes = new Map();            // rows from websites that are not in the settings: the website item typed, "add to Settings" box
const qOk = v => /^(?:https?:\/\/(?:www\.|m\.)?wikidata\.org\/(?:wiki|entity)\/)?Q\d+\/?$/i.test(String(v).trim());
// the website item typed on a row to replace the saved one ("" = keep the saved item, or the box does not hold a valid Q…)
const ovOf = id => {
  const wi = wInputs.get(id), r = rowsById().get(id), v = wi ? wi.value.trim() : "";
  if (!v || !qOk(v)) return "";
  const q = normId(v);
  return q && q !== String(r?.siteq || "").toUpperCase() ? q : "";
};
let overNow = false;                                      // is some target above the per-edit limit right now?
function update() {
  const checked = ticked();
  const n = checked.length;
  const rows = rowsById();
  // statements per target: URLs of one website share one P1343 statement (approximate for targets other than the main item)
  const per = new Map();                                 // target -> Map(statement key -> count)
  for (const c of checked) {
    const id = Number(c.dataset.id), r = rows.get(id), T = tOf(id);
    const ov = ovOf(id);                                 // another website item = another P1343 statement (rows with the same item share one)
    const k = ov ? "o:" + ov : T === payload.item ? (r?.gkey ?? c.dataset.id) : (r?.siteq ? "g:" + r.siteq : "n:" + id);
    if (!per.has(T)) per.set(T, new Map());
    per.get(T).set(k, (per.get(T).get(k) || 0) + 1);
  }
  let needQ = false;
  for (const c of checked) {
    const qi = qInputs.get(Number(c.dataset.id)); if (!qi) continue;
    const v = qi.value.trim(); qi.classList.toggle("bad", !!v && !qOk(v));
    if (!qOk(v)) needQ = true;
  }
  for (const [, wi] of wInputs) { const v = wi.value.trim(); wi.classList.toggle("bad", !!v && !qOk(v)); }
  const bad = !!document.querySelector("input.bad");
  const overT = [...per.entries()].find(([, m]) => [...m.values()].reduce((a, b) => a + b, 0) > payload.maxPerEdit);
  const exception = $("exc").checked;
  overNow = !!overT;
  $("exn").textContent = payload.maxPerEdit;
  $("excl").hidden = !overT && !exception;                // offered when the limit strikes (and kept while ticked)
  const over = exception ? undefined : overT;             // an exception lifts the limit for this edit only
  const multi = per.size > 1;
  const parts = [...per.entries()].map(([T, m]) => { const g = [...m.values()]; return `${T}: ${g.reduce((a, b) => a + b, 0)}${g.length > 1 ? ` (${g.join("+")})` : ""}`; });
  $("ok").disabled = n === 0 || !!over || bad || needQ;
  $("ok").textContent = n ? `Save ${n} to Wikidata${multi ? ` – ${parts.join(", ")}` : (parts.length && [...per.values()][0].size > 1 ? ` (${[...[...per.values()][0].values()].join("+")})` : "")}` : "Nothing selected";
  $("msg").textContent = needQ && !bad ? "Type the website item (Q…) for each ticked row from a website that is not in your settings." : bad ? "Fix the fields marked red (a website item Q…, a target Q123 or L123, or an unusable address)." :
    over ? `At most ${payload.maxPerEdit} statements per edit (Settings) – ${multi ? "for " + over[0] + " " : ""}untick some, or make an exception.` :
    overT ? `Exception: ${[...overT[1].values()].reduce((a, b) => a + b, 0)} statements in one edit${multi ? " for " + overT[0] : ""} (your limit is ${payload.maxPerEdit}).` :
    multi ? `${per.size} separate edits (one per target).` : "";
}

// the "edit URL" line of a row: checks the typed address in the background (and shows the ID it holds)
function urlEditor(r, uLine) {
  const wrap = document.createElement("div");
  wrap.className = "tr"; wrap.hidden = true;
  const inp = document.createElement("input");
  inp.value = r.url; inp.style.width = "min(100%,420px)"; inp.spellcheck = false; inp.autocomplete = "off";
  const info = document.createElement("span");
  const undo = document.createElement("button"); undo.textContent = "undo";
  wrap.append("URL:", inp, undo, info);
  let seq = 0, timer = 0;
  const reset = () => { urlEdits.delete(r.id); inp.classList.remove("bad"); info.textContent = ""; info.style.color = ""; uLine.style.textDecoration = ""; };
  const check = async () => {
    const v = inp.value.trim(), my = ++seq;
    if (!v || v === r.url) { inp.value = v || r.url; reset(); update(); return; }
    const res = await chrome.runtime.sendMessage({ type: "check-url", id, row: r.id, url: v });
    if (my !== seq) return;                                // a newer keystroke is already being checked
    if (!res?.ok) { urlEdits.delete(r.id); inp.classList.add("bad"); info.style.color = "#c62828"; info.textContent = res?.why || "not usable"; uLine.style.textDecoration = ""; }
    else {
      inp.classList.remove("bad"); urlEdits.set(r.id, res.url); uLine.style.textDecoration = "line-through";
      info.style.color = ""; info.textContent = [res.text && "→ " + res.text, res.warn && "⚠ " + res.warn, res.archive && "Wayback link looked up again", "not re-checked online"].filter(Boolean).join("  ·  ");
    }
    update();
  };
  inp.oninput = () => { inp.classList.remove("bad"); clearTimeout(timer); timer = setTimeout(check, 300); };
  inp.onchange = () => { clearTimeout(timer); check(); };
  undo.onclick = () => { inp.value = r.url; seq++; reset(); update(); };
  return { wrap, open: () => { wrap.hidden = !wrap.hidden; if (!wrap.hidden) inp.focus(); } };
}

function setTarget(id, v) {
  const t = normId(v), inp = inputs.get(id);
  const val = t === payload.item ? "" : t;
  if (v && t === null) { inp.classList.add("bad"); targets.set(id, ""); }
  else { inp.classList.remove("bad"); targets.set(id, val || ""); inp.value = val || ""; if (val) addKnown(val); }
  const row = inp.closest(".row");
  row.classList.toggle("moved", !!targets.get(id));
  if (rowsById().get(id)?.present) { const pc = row.querySelector("input[type=checkbox][data-id]"); if (pc) pc.checked = !!targets.get(id); }   // already on this item: it only matters when it goes elsewhere
  labelOf(targets.get(id), row.querySelector(".tlbl"));
  refreshBrushButtons();
}
function refreshBrushButtons() {
  const t = normId($("bt").value);
  for (const [id, inp] of inputs) {
    const b = inp.closest(".row").querySelector("button.go");
    b.hidden = !t || t === payload.item || tOf(id) === t;
    b.textContent = "→ " + (t || "");
  }
}

(async () => {
  payload = await chrome.runtime.sendMessage({ type: "review-get", id });
  if (!payload) { document.body.textContent = "This review is no longer active."; return; }
  $("title").replaceChildren("Review changes to ", itemLink(payload.item));
  $("sub").textContent = payload.itemLabel || "";
  addKnown(payload.item); for (const k of payload.known || []) addKnown(k);
  for (const r of payload.rows) {
    const d = document.createElement("div");
    d.className = "row";
    const m = document.createElement("label");
    m.className = "main";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = !r.needsApproval && !r.manual && !r.present; cb.dataset.id = r.id; cb.onchange = update;
    const b = document.createElement("div");
    const h = document.createElement("div");
    h.textContent = r.label + " – " + r.note;
    if (r.viaGoogle) { const t = document.createElement("span"); t.className = "tag s"; t.textContent = r.unknown ? "Google hit, not one of your websites – tick it yourself" : r.manual ? "Google hit, website in another category – tick it yourself" : "Google hit – check it"; h.append(t); }
    else if (r.viaSearch) { const t = document.createElement("span"); t.className = "tag s"; t.textContent = "from site search – check it"; h.append(t); }
    if (r.needsApproval) { const t = document.createElement("span"); t.className = "tag s"; t.textContent = "partial title match – tick to approve"; h.append(t); }
    if (r.viaArchive) { const t = document.createElement("span"); t.className = "tag"; t.textContent = "live site unreachable"; h.append(t); }
    const u = document.createElement("div");
    u.className = "t";
    if (r.url && r.text === r.url) linkify(r.text, u);                    // a URL row: the URL itself is the link
    else { u.append(r.text); if (r.url) { u.append("  –  "); u.append(mkLink(r.url, "open the page")); } }
    if (r.archive) { u.append("   (+ Wayback "); u.append(r.archiveUrl ? mkLink(r.archiveUrl, r.archive) : r.archive); u.append(")"); }
    b.append(h, u);
    if (r.gtext) { const g = document.createElement("div"); g.className = "t"; g.textContent = "Google: " + r.gtext; b.append(g); }
    m.append(cb, b);
    if (r.unknown) {                                                      // not one of your websites: needs the website item (and may go to another item/lexeme); no URL editing
      const tq = document.createElement("div"); tq.className = "tr";
      const qi = document.createElement("input"); qi.placeholder = "Q… of the website/publisher"; qi.autocomplete = "off"; qi.spellcheck = false; qi.style.width = "min(100%,240px)";
      qi.oninput = update;
      const qname = document.createElement("span"); qname.className = "lbl"; qname.style.maxWidth = "min(100%,360px)"; qname.style.fontWeight = "600";
      watchWebsiteItem(qi, qname);
      const rb = document.createElement("input"); rb.type = "checkbox"; rb.checked = !r.ytSite; rb.style.width = "auto";
      const rl = document.createElement("label"); rl.style.marginLeft = "8px";
      if (r.ytSite) { rb.disabled = true; rl.textContent = "(YouTube: not added to Settings – a website with the domain youtube.com would take over every YouTube link)"; rl.className = "lbl"; }
      else rl.append(rb, " also add this website to Settings (ticked automatically next time)");
      // category and language of the website to be added to Settings: start from the current website's, overridable per row
      const mkMeta = (ph, val, w, title) => { const i = document.createElement("input"); i.placeholder = ph; i.value = val || ""; i.title = title; i.autocomplete = "off"; i.spellcheck = false; i.style.width = w; return i; };
      const ci = mkMeta("category", payload.siteDefaults?.category, "110px", "Category of the new website (as in Settings; empty = none yet)");
      const li = mkMeta("en, it", payload.siteDefaults?.language, "70px", "Languages of the new website (empty = every language)");
      const meta = document.createElement("span"); meta.style.cssText = "display:inline-flex;gap:6px;align-items:center;margin-left:8px";
      meta.append("category:", ci, "language:", li);
      rb.onchange = () => { meta.style.opacity = rb.checked ? "" : ".45"; ci.disabled = li.disabled = !rb.checked; };
      if (r.ytSite) { meta.style.display = "none"; ci.disabled = li.disabled = true; }
      metaInputs.set(r.id, { ci, li });
      tq.append("website item:", qi, qname, rl, meta);
      { const bc = blockControl(d, r); if (bc) tq.append(bc); }
      qInputs.set(r.id, qi); rememberBoxes.set(r.id, rb); targets.set(r.id, "");
      // a new website can go to another item/lexeme as well: website item above, target here (empty = the item at the top)
      const tr2 = document.createElement("div"); tr2.className = "tr";
      const inp2 = document.createElement("input");
      inp2.setAttribute("list", "targets"); inp2.placeholder = payload.item; inp2.autocomplete = "off"; inp2.spellcheck = false;
      inp2.onchange = () => { setTarget(r.id, inp2.value); update(); };
      inp2.oninput = () => inp2.classList.remove("bad");
      const go2 = document.createElement("button"); go2.className = "go"; go2.hidden = true; go2.title = "Send this row to the target in the bar at the top";
      go2.onclick = () => { setTarget(r.id, $("bt").value); update(); };
      const lbl2 = document.createElement("span"); lbl2.className = "lbl tlbl";
      tr2.append("goes to:", inp2, go2, lbl2);
      inputs.set(r.id, inp2);
      d.append(m, tq, tr2); $("rows").append(d); continue;
    }
    // where this row goes: empty = the item above
    const tr = document.createElement("div");
    tr.className = "tr";
    const inp = document.createElement("input");
    inp.setAttribute("list", "targets"); inp.placeholder = payload.item; inp.autocomplete = "off"; inp.spellcheck = false;
    inp.onchange = () => { setTarget(r.id, inp.value); update(); };
    inp.oninput = () => inp.classList.remove("bad");
    const go = document.createElement("button"); go.className = "go"; go.hidden = true; go.title = "Send this row to the target in the bar at the top";
    go.onclick = () => { setTarget(r.id, $("bt").value); update(); };
    const lbl = document.createElement("span"); lbl.className = "lbl tlbl";
    tr.append("goes to:", inp, go, lbl);
    let ed = null;
    if (r.url && !r.present) {
      ed = urlEditor(r, u);
      const eb = document.createElement("button"); eb.textContent = "edit URL"; eb.title = "Correct the address before saving";
      eb.onclick = ed.open; tr.append(eb);
    }
    { const bc = blockControl(d, r); if (bc) tr.append(bc); }
    inputs.set(r.id, inp); targets.set(r.id, "");
    let wr = null;
    if (r.siteq) {                                                        // saved as P1343 + P2699 (or P1651): the website item may be overridden here, e.g. an item for one AREA of the website
      wr = document.createElement("div"); wr.className = "tr";
      const wi = document.createElement("input"); wi.placeholder = r.siteq; wi.autocomplete = "off"; wi.spellcheck = false; wi.style.width = "110px";
      wi.title = "Empty = the website item saved in Settings (" + r.siteq + "). Type another Q… to save this row under that item instead (e.g. one that is more specific: an area of the website).";
      const wdef = document.createElement("span"); wdef.className = "lbl"; wdef.style.maxWidth = "min(100%,200px)"; labelOf(r.siteq, wdef);
      const wname = document.createElement("span"); wname.className = "lbl"; wname.style.cssText = "max-width:min(100%,300px);font-weight:600";
      watchWebsiteItem(wi, wname);
      wi.oninput = wi.onchange = () => {                                 // a row that was "already there" becomes new under another website item: tick it for you
        if (r.present) { const pc = d.querySelector("input[type=checkbox][data-id]"); if (pc) pc.checked = !!ovOf(r.id) || !!targets.get(r.id); }
        update();
      };
      const all = document.createElement("button"); all.type = "button"; all.textContent = "same for all rows of this website"; all.title = "Copy this website item to every row that currently uses " + r.siteq;
      all.onclick = () => { for (const [id2, w2] of wInputs) if (rowsById().get(id2)?.siteq === r.siteq) w2.value = wi.value; update(); };
      wr.append("website item:", wi, wname, "(saved in Settings: " + r.siteq, wdef, ")", all);
      wInputs.set(r.id, wi);
    }
    d.append(m, tr); if (wr) d.append(wr); if (ed) d.append(ed.wrap); (r.present ? $("presl") : $("rows")).append(d);
  }
  if (payload.blockedInfo?.length) {                                    // the block list already kept these out of this window
    $("blk").hidden = false;
    $("blk").textContent = "⛔ Left out because of your block list: " + payload.blockedInfo.map(([h, n]) => `${h} (${n})`).join(", ") + " – edit the list in Settings → Blocked sites.";
  }
  const nPres = payload.rows.filter(r => r.present).length;
  if (nPres) $("pres").querySelector("summary").textContent = `${nPres} already on the item – you can still send them to another item`;
  else if (payload.present.length) {
    $("pres").querySelector("summary").textContent = `${payload.present.length} already on the item`;
    for (const line of payload.present) { const d = document.createElement("div"); linkify(line, d); $("presl").append(d); }
  } else $("pres").hidden = true;

  const applyBulk = only => {
    const t = normId($("bt").value);
    if (!t) { $("bt").classList.add("bad"); return; }
    $("bt").classList.remove("bad");
    const sel = new Set(ticked().map(c => Number(c.dataset.id)));
    for (const r of payload.rows) if (only ? sel.has(r.id) : !r.present) setTarget(r.id, t);
    addKnown(t); update();
  };
  $("bt").oninput = () => { $("bt").classList.remove("bad"); refreshBrushButtons(); };
  $("bt").onchange = () => { const t = normId($("bt").value); if ($("bt").value && !t) $("bt").classList.add("bad"); else { if (t) { $("bt").value = t; addKnown(t); } labelOf(t, $("bl")); } refreshBrushButtons(); };
  $("bticked").onclick = () => applyBulk(true);
  $("ball").onclick = () => applyBulk(false);
  $("breset").onclick = () => { for (const r of payload.rows) setTarget(r.id, ""); update(); };
  update();
  $("ok").focus();
})();

$("exc").onchange = update;
$("ok").onclick = () => {
  const selected = ticked().map(c => Number(c.dataset.id));
  const out = {};
  for (const id of selected) if (targets.get(id)) out[id] = targets.get(id);
  const urls = {};
  for (const id of selected) if (urlEdits.has(id)) urls[id] = urlEdits.get(id);
  const qids = {}, remember = [];
  for (const sid of selected) { const qi = qInputs.get(sid); if (qi) { qids[sid] = qi.value.trim(); if (rememberBoxes.get(sid)?.checked) remember.push(sid); } }
  const siteQ = {};
  for (const sid of selected) { const q = ovOf(sid); if (q) siteQ[sid] = q; }
  const meta = {};
  for (const sid of remember) { const m = metaInputs.get(sid); if (m) meta[sid] = { category: m.ci.value.trim(), language: m.li.value.trim() }; }
  chrome.runtime.sendMessage({ type: "review-done", id, selected, targets: out, urls, exception: overNow && $("exc").checked, qids, siteQ, remember, meta, blocked: [...blockedHosts] });
};
$("cancel").onclick = () => chrome.runtime.sendMessage({ type: "review-done", id, cancel: true, blocked: [...blockedHosts] });
addEventListener("keydown", e => { if (e.key === "Escape" && document.activeElement?.tagName !== "INPUT") $("cancel").click(); });
