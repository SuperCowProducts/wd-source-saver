// Offscreen document: the only reliable way to read the clipboard from an MV3 extension.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== "offscreen" || msg.type !== "read-clipboard") return;
  const ta = document.getElementById("t");
  ta.value = "";
  ta.focus();
  document.execCommand("paste");
  sendResponse(ta.value);
});
