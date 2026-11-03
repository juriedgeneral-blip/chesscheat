// offscreen.js — runs in chrome-extension:// origin, so Worker is same-origin

let engine = null;
let currentFen = null;

function initEngine() {
  if (engine) {
    engine.terminate();
    engine = null;
  }
  engine = new Worker(chrome.runtime.getURL("scripts/stockfish.asm.1abfa10c.js"));

  engine.onmessage = (event) => {
    const line = event.data;
    if (!line) return;

    if (line.startsWith("bestmove")) {
      const move = line.split(" ")[1];
      if (move && move !== "(none)" && currentFen) {
        chrome.runtime.sendMessage({
          target: "optimal",
          type: "bestmove",
          fen: currentFen,
          move
        });
      }
      return;
    }
  };

  engine.onerror = (err) => {
    chrome.runtime.sendMessage({
      target: "optimal",
      type: "engine-error",
      error: String(err?.message || err)
    });
  };

  engine.postMessage("uci");
  engine.postMessage("setoption name MultiPV value 3");
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "offscreen") return;

  if (msg.type === "analyze") {
    if (!engine) initEngine();
    currentFen = msg.fen;
    engine.postMessage(`position fen ${msg.fen}`);
    engine.postMessage(`go depth ${msg.depth || 18}`);
  }

  if (msg.type === "stop") {
    if (engine) {
      engine.postMessage("stop");
    }
  }
});

initEngine();
