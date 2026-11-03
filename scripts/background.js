// background.js — creates/reuses the offscreen document that hosts Stockfish

let creating = null;

async function ensureOffscreen() {
  const url = chrome.runtime.getURL("scripts/offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url]
  });
  if (contexts.length > 0) return;

  if (creating) {
    await creating;
    return;
  }

  creating = chrome.offscreen.createDocument({
    url: "scripts/offscreen.html",
    reasons: ["WORKERS"],
    justification: "Run the Stockfish chess engine in a Web Worker"
  });

  try {
    await creating;
  } finally {
    creating = null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== "background") return;

  if (msg.type === "ensure-offscreen") {
    ensureOffscreen().then(() => sendResponse({ ok: true })).catch((e) => {
      sendResponse({ ok: false, error: String(e) });
    });
    return true;
  }
});
