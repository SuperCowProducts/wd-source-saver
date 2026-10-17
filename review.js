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
const ticked = () => [...document.querySelectorAll("input[type=checkbox]")].filter(c => c.checked);

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

function update() {
  const checked = ticked();
  const n = checked.length;
  const rows = rowsById();
  // statements per target: URLs of one website share one P1343 statement (approximate for targets other than the main item)
  const per = new Map();                                 // target -> Map(statement key -> count)
  for (const c of checked) {
    const id = Number(c.dataset.id), r = rows.get(id), T = tOf(id);
    const k = T === payload.item ? (r?.gkey ?? c.dataset.id) : (r?.siteq ? "g:" + r.siteq : "n:" + id);
    if (!per.has(T)) per.set(T, new Map());
    per.get(T).set(k, (per.get(T).get(k) || 0) + 1);
  }
  const bad = !!document.querySelector("input.bad");
  const over = [...per.entries()].find(([, m]) => [...m.values()].reduce((a, b) => a + b, 0) > payload.maxPerEdit);
  const multi = per.size > 1;
  const parts = [...per.entries()].map(([T, m]) => { const g = [...m.values()]; return `${T}: ${g.reduce((a, b) => a + b, 0)}${g.length > 1 ? ` (${g.join("+")})` : ""}`; });
  $("ok").disabled = n === 0 || !!over || bad;
  $("ok").textContent = n ? `Save ${n} to Wikidata${multi ? ` – ${parts.join(", ")}` : (parts.length && [...per.values()][0].size > 1 ? ` (${[...[...per.values()][0].values()].join("+")})` : "")}` : "Nothing selected";
  $("msg").textContent = bad ? "Fix the fields marked red (target: Q123 or L123; or an unusable address)." :
    over ? `At most ${payload.maxPerEdit} statements per edit (Settings) – ${multi ? "for " + over[0] + " " : ""}untick some.` :
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
  labelOf(targets.get(id), row.querySelector(".lbl"));
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
    cb.type = "checkbox"; cb.checked = !r.needsApproval; cb.dataset.id = r.id; cb.onchange = update;
    const b = document.createElement("div");
    const h = document.createElement("div");
    h.textContent = r.label + " – " + r.note;
    if (r.viaSearch) { const t = document.createElement("span"); t.className = "tag s"; t.textContent = "from site search – check it"; h.append(t); }
    if (r.needsApproval) { const t = document.createElement("span"); t.className = "tag s"; t.textContent = "partial title match – tick to approve"; h.append(t); }
    if (r.viaArchive) { const t = document.createElement("span"); t.className = "tag"; t.textContent = "live site unreachable"; h.append(t); }
    const u = document.createElement("div");
    u.className = "t";
    if (r.url && r.text === r.url) linkify(r.text, u);                    // a URL row: the URL itself is the link
    else { u.append(r.text); if (r.url) { u.append("  –  "); u.append(mkLink(r.url, "open the page")); } }
    if (r.archive) { u.append("   (+ Wayback "); u.append(r.archiveUrl ? mkLink(r.archiveUrl, r.archive) : r.archive); u.append(")"); }
    b.append(h, u); m.append(cb, b);
    // where this row goes: empty = the item above
    const tr = document.createElement("div");
    tr.className = "tr";
    const inp = document.createElement("input");
    inp.setAttribute("list", "targets"); inp.placeholder = payload.item; inp.autocomplete = "off"; inp.spellcheck = false;
    inp.onchange = () => { setTarget(r.id, inp.value); update(); };
    inp.oninput = () => inp.classList.remove("bad");
    const go = document.createElement("button"); go.className = "go"; go.hidden = true; go.title = "Send this row to the target in the bar at the top";
    go.onclick = () => { setTarget(r.id, $("bt").value); update(); };
    const lbl = document.createElement("span"); lbl.className = "lbl";
    tr.append("goes to:", inp, go, lbl);
    let ed = null;
    if (r.url) {
      ed = urlEditor(r, u);
      const eb = document.createElement("button"); eb.textContent = "edit URL"; eb.title = "Correct the address before saving";
      eb.onclick = ed.open; tr.append(eb);
    }
    inputs.set(r.id, inp); targets.set(r.id, "");
    d.append(m, tr); if (ed) d.append(ed.wrap); $("rows").append(d);
  }
  if (payload.present.length) {
    $("pres").querySelector("summary").textContent = `${payload.present.length} already on the item`;
    for (const line of payload.present) { const d = document.createElement("div"); linkify(line, d); $("presl").append(d); }
  } else $("pres").hidden = true;

  const applyBulk = only => {
    const t = normId($("bt").value);
    if (!t) { $("bt").classList.add("bad"); return; }
    $("bt").classList.remove("bad");
    const sel = new Set(ticked().map(c => Number(c.dataset.id)));
    for (const r of payload.rows) if (!only || sel.has(r.id)) setTarget(r.id, t);
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

$("ok").onclick = () => {
  const selected = ticked().map(c => Number(c.dataset.id));
  const out = {};
  for (const id of selected) if (targets.get(id)) out[id] = targets.get(id);
  const urls = {};
  for (const id of selected) if (urlEdits.has(id)) urls[id] = urlEdits.get(id);
  chrome.runtime.sendMessage({ type: "review-done", id, selected, targets: out, urls });
};
$("cancel").onclick = () => chrome.runtime.sendMessage({ type: "review-done", id, cancel: true });
addEventListener("keydown", e => { if (e.key === "Escape" && document.activeElement?.tagName !== "INPUT") $("cancel").click(); });
