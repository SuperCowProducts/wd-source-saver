// "What should be searched for?" – shown when the matched URL template has no {id} (e.g. {path}), so the URL holds no single term.
import { cleanTerm, cleanKeywords } from "./lib.js";
const id = new URLSearchParams(location.search).get("id");
const $ = x => document.getElementById(x);
let needPerm = [];                                                  // origins the search needs but this browser has not granted yet
const done = v => chrome.runtime.sendMessage(v === null ? { type: "review-done", id, cancel: true } : { type: "review-done", id, selected: v });

(async () => {
  const p = await chrome.runtime.sendMessage({ type: "review-get", id });
  if (!p) { document.body.textContent = "This question is no longer active."; return; }
  const code = document.createElement("code"); code.textContent = p.url;
  if (p.noId) $("what").replaceChildren("The address of this ", p.site, " page (", code, ") doesn't hold a single word or ID, so type the term to look for on the other websites:");
  else $("what").replaceChildren("Confirm the term to look for on the other websites. The address (", code, ") suggests the term below – shorten or change it if the page is about something narrower or broader:");
  $("info").textContent = "Whatever you had selected on the page is offered as the answer. Settings → “Confirm the search term” turns this question off.";
  if (p.extras && p.extras.length) $("ex").textContent = "Also searched (typed after the item): " + p.extras.join(", ");
  needPerm = p.needPerm || [];
  if (needPerm.length) $("perm").hidden = false;
  if (p.google) { $("kwbox").hidden = false; $("kw").value = p.keywords || ""; }
  $("term").value = p.suggestion || "";
  $("term").focus(); $("term").select();
})();

async function submit() {
  const t = cleanTerm($("term").value.replace(/[?!:;\s]+$/, ""));
  if (!t) { $("err").textContent = "Type 1–6 words (letters, digits, spaces, hyphens, apostrophes), 60 characters at most."; return; }
  if (needPerm.length) {                                              // the click is the user gesture Chrome needs for its permission prompt
    $("ok").disabled = true;
    try { await chrome.permissions.request({ origins: needPerm }); } catch (e) { console.error(e); }
  }
  done($("kwbox").hidden ? t.text : { term: t.text, keywords: cleanKeywords($("kw").value) });
}
$("ok").onclick = submit;
$("skip").onclick = () => done(null);
$("term").addEventListener("input", () => { $("err").textContent = ""; });
addEventListener("keydown", e => { if (e.key === "Enter") submit(); if (e.key === "Escape") done(null); });
