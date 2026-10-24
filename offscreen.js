// Offscreen document: (1) the only reliable way to read the clipboard from an MV3 extension,
// (2) a DOM for reading IDs out of page HTML (the service worker has no DOMParser).
import { extractPageId } from "./lib.js";
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== "offscreen") return;
  if (msg.type === "read-clipboard") {
    const ta = document.getElementById("t");
    ta.value = "";
    ta.focus();
    document.execCommand("paste");
    sendResponse(ta.value);
  } else if (msg.type === "write-clipboard") {
    const ta = document.getElementById("t");
    ta.value = String(msg.text || "");
    ta.focus(); ta.select();
    sendResponse(document.execCommand("copy"));
  } else if (msg.type === "page-id") {
    try { sendResponse(extractPageId(new DOMParser().parseFromString(msg.html || "", "text/html"), msg.html || "", msg.specs)); }
    catch (e) { sendResponse({ value: "", error: String(e && e.message || e) }); }
  }
});
