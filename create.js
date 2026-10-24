// Window: review the draft of a new Wikidata item (read from the page by the recipe of the website) and create it.
import { makeValue, draftProblem } from "./create-lib.js";
const id = new URLSearchParams(location.search).get("id");
const $ = x => document.getElementById(x);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const link = (href, text) => el("a", { href, textContent: text, target: "_blank", rel: "noopener noreferrer" });
const finish = v => chrome.runtime.sendMessage(v === null ? { type: "review-done", id, cancel: true } : { type: "review-done", id, selected: v });

let P = null;
const lists = { labels: [], descriptions: [], aliases: [] };      // [{lang, value, note, lang-input, value-input}]
const stmts = [];                                                  // [{s, cb, inp, lang, why}]

function textRow(kind, x) {
  const row = { x, lang: el("input", { type: "text", className: "lang", value: x.lang, placeholder: "en", spellcheck: false, autocomplete: "off", title: "Language code" }),
                val: el("input", { type: "text", className: "val", value: x.value, spellcheck: false, autocomplete: "off" }) };
  const rm = el("button", { type: "button", className: "x", textContent: "✕", title: "Remove" });
  const wrap = el("div", { className: "r" }, row.lang, row.val, rm);
  if (x.note && kind !== "x") wrap.append(el("div", { className: "note", textContent: x.note }));
  rm.onclick = () => { lists[kind].splice(lists[kind].indexOf(row), 1); wrap.remove(); update(); };
  row.lang.oninput = row.val.oninput = update;
  row.wrap = wrap; lists[kind].push(row); $(kind).append(wrap);
  return row;
}
const collect = kind => lists[kind].map(r => ({ lang: r.lang.value.trim().toLowerCase(), value: r.val.value.replace(/\s+/g, " ").trim() }));

function statementRow(s) {
  const cb = el("input", { type: "checkbox", checked: s.ok });
  const inp = el("input", { type: "text", className: "val", value: s.value, spellcheck: false, autocomplete: "off" });
  const mono = s.info?.datatype === "monolingualtext" ? el("input", { type: "text", className: "lang", value: s.lang, placeholder: "en", spellcheck: false, title: "Language code" }) : null;
  const status = el("span");
  const head = el("span", { className: "pid" }, link("https://www.wikidata.org/wiki/Property:" + s.prop, s.prop));
  const lbl = el("span", { className: "t", textContent: s.info ? s.info.label || "" : "(unknown property)" });
  const tag = s.info ? el("span", { className: "tag", textContent: s.info.datatype }) : "";
  const wrap = el("div", { className: "r" }, cb, head, lbl, tag, inp, ...(mono ? [mono] : []), status);
  if (s.note) wrap.append(el("div", { className: "note", textContent: s.note }));
  const rec = { s, cb, inp, mono, status, ok: s.ok };
  const check = () => {                                           // the value as it will be saved ("https://doi.org/10.1/x" -> "10.1/X"), and why not
    const mv = makeValue(s.prop, s.info, inp.value, mono ? mono.value : s.lang);
    rec.ok = mv.ok; rec.value = mv.value; rec.lang = mono ? mono.value.trim().toLowerCase() : s.lang;
    inp.classList.toggle("bad", !mv.ok && cb.checked);
    status.className = mv.ok ? "ok" : "why";
    status.textContent = mv.ok ? (mv.value !== inp.value.trim() ? "→ " + mv.value : "✓") : mv.why;
    update();
  };
  inp.oninput = () => { cb.checked = true; check(); };
  if (mono) mono.oninput = check;
  cb.onchange = check;
  stmts.push(rec); $("statements").append(wrap); check();
}

function update() {
  const labels = collect("labels"), descriptions = collect("descriptions"), aliases = collect("aliases");
  let why = draftProblem({ labels, descriptions, aliases });
  const used = stmts.filter(r => r.cb.checked);
  if (!why && used.some(r => !r.ok)) why = `${used.find(r => !r.ok).s.prop}: ${used.find(r => !r.ok).status.textContent}`;
  if (!why && P.dups.length && !$("dupOk")?.checked) why = "an item with the same ID exists – tick “create anyway” or open it instead";
  $("create").disabled = !!why;
  $("msg").textContent = why || "";
}

(async () => {
  P = await chrome.runtime.sendMessage({ type: "review-get", id });
  if (!P) { document.body.textContent = "This window is no longer active."; return; }
  $("sub").replaceChildren("from ", link(P.url, P.url), ` (${P.site})`);
  if (P.dups.length) {
    const box = $("dups"); box.hidden = false;
    box.append(el("b", { textContent: "This may already exist on Wikidata:" }));
    for (const d of P.dups) box.append(el("div", {}, `${d.prop} = ${d.value}: `, ...d.items.flatMap((i, n) => [n ? ", " : "", link("https://www.wikidata.org/wiki/" + i.id, i.id + (i.label ? " – " + i.label : ""))])));
    box.append(el("label", {}, el("input", { type: "checkbox", id: "dupOk", onchange: update }), " create a new item anyway"));
  }
  P.labels.forEach(x => textRow("labels", x)); P.descriptions.forEach(x => textRow("descriptions", x)); P.aliases.forEach(x => textRow("aliases", x));
  for (const k of ["Label", "Description", "Alias"]) $("add" + k).onclick = () => { const r = textRow(k.toLowerCase() + (k === "Alias" ? "es" : "s"), { lang: P.defLang, value: "", note: "" }); r.val.focus(); update(); };
  if (!P.statements.length) $("statements").append(el("div", { className: "t", textContent: "(the recipe has no property lines)" }));
  P.statements.forEach(statementRow);
  if (P.describedAt) { $("descRow").hidden = false; $("descQ").textContent = P.describedAt; }
  update();
  $("create").onclick = () => {
    $("create").disabled = true; $("msg").textContent = "creating…";
    finish({ labels: collect("labels"), descriptions: collect("descriptions"), aliases: collect("aliases"),
      statements: stmts.filter(r => r.cb.checked).map(r => ({ prop: r.s.prop, value: r.value, lang: r.lang })), describedAt: !!$("descAt").checked });
  };
  $("cancel").onclick = () => finish(null);
  document.addEventListener("keydown", e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !$("create").disabled) $("create").click(); if (e.key === "Escape") finish(null); });
})();
