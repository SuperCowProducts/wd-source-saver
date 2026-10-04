const id = new URLSearchParams(location.search).get("id");
const $ = x => document.getElementById(x);
const done = v => chrome.runtime.sendMessage(v === null ? { type: "review-done", id, cancel: true } : { type: "review-done", id, selected: v });

(async () => {
  const p = await chrome.runtime.sendMessage({ type: "review-get", id });
  if (!p) { document.body.textContent = "This question is no longer active."; return; }
  $("what").textContent = `${p.rows.length} change${p.rows.length > 1 ? "s" : ""} to ${p.item} ${p.rows.length > 1 ? "are" : "is"} ready, but Wikidata refused the save because its servers are behind` +
    (p.lag != null ? ` (${p.lag}s lag, your maxlag is ${p.maxlag}s).` : ` (your maxlag is ${p.maxlag}s).`);
  for (const r of p.rows) { const li = document.createElement("li"); li.textContent = r; $("rows").append(li); }
  $("info").textContent = p.info || "";
  $("off").focus();
})();
$("off").onclick = () => done("off");
$("retry").onclick = () => done("retry");
$("cancel").onclick = () => done(null);
addEventListener("keydown", e => { if (e.key === "Escape") done(null); });
