// optimal.js — content script. Sends FEN to offscreen, draws highlights.

const OPTIMAL = (() => {
  let running = false;
  let observer = null;
  let currentFen = null;
  let globalDepth = 18;
  let limitElo = null;
  let style = "aggressive";
  let candidates = [];
  let bestMoveRaw = null;
  let uiCollapsed = false;
  let humanFeel = true;
  let moveNumber = 0;
  let currentEval = null;
  let fenHistory = [];
  let offscreenReady = false;

  const analysisCache = new Map();
  const CACHE_LIMIT = 15;

  const charMap = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 };
  const FG = "#f0f0f0";
  const FG_DIM = "rgba(240,240,240,0.65)";
  const ACCENT = "#8ab4f8";
  const PANEL_BG = "#2a2a2a";
  const PANEL_BORDER = "rgba(255,255,255,0.18)";
  const STORAGE_KEY = "optimal_settings";

  // ... (keep saveSettings, loadSettings, applySettings, cacheGet, cacheSet unchanged)

  function saveSettings() {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;
    chrome.storage.local.set({
      [STORAGE_KEY]: { depth: globalDepth, limitElo, style, humanFeel, collapsed: uiCollapsed }
    });
  }

  function loadSettings(cb) {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return cb(null);
    chrome.storage.local.get(STORAGE_KEY, (r) => cb(r?.[STORAGE_KEY] || null));
  }

  function applySettings(s) {
    if (!s) return;
    if (typeof s.depth === "number") globalDepth = s.depth;
    if (s.limitElo === null || typeof s.limitElo === "number") limitElo = s.limitElo;
    if (typeof s.style === "string") style = s.style;
    if (typeof s.humanFeel === "boolean") humanFeel = s.humanFeel;
    if (typeof s.collapsed === "boolean") uiCollapsed = s.collapsed;
  }

  // ---------- board reading (keep your original getFenString) ----------
  function getFenString() {
    const board = document.querySelector("wc-chess-board");
    if (!board) return null;
    const flipped = board.classList.contains("flipped");
    let fen = "";
    for (let rank = 8; rank >= 1; rank--) {
      let empty = 0;
      for (let file = 1; file <= 8; file++) {
        const el = document.querySelector(`.piece.square-${file}${rank}`);
        if (!el) { empty++; continue; }
        if (empty > 0) { fen += empty; empty = 0; }
        let pieceClass = null;
        for (const cls of el.classList.values()) {
          if (cls.length === 2) { pieceClass = cls; break; }
        }
        if (!pieceClass) { empty++; continue; }
        fen += pieceClass[0] === "w" ? pieceClass[1].toUpperCase() : pieceClass[1];
      }
      if (empty > 0) fen += empty;
      if (rank > 1) fen += "/";
    }
    return `${fen} ${flipped ? "b" : "w"}`;
  }

  // ---------- humanization helpers (keep your originals) ----------
  function expandRow(row) {
    const squares = [];
    for (const ch of row) {
      if (/\d/.test(ch)) for (let i = 0; i < +ch; i++) squares.push(null);
      else squares.push(ch);
    }
    return squares;
  }

  function emptiedSquares(prevFen, currFen) {
    if (!prevFen || !currFen) return new Set();
    const p = prevFen.split(" ")[0].split("/");
    const c = currFen.split(" ")[0].split("/");
    const out = new Set();
    for (let r = 0; r < 8; r++) {
      const rank = 8 - r;
      const ps = expandRow(p[r]), cs = expandRow(c[r]);
      for (let f = 0; f < 8; f++)
        if (ps[f] && !cs[f]) out.add(`${String.fromCharCode(97 + f)}${rank}`);
    }
    return out;
  }

  function moveIsRepeat(move, recent) {
    return !!(move && move.length >= 4 && recent && recent.has(move.slice(0, 2)));
  }

  function moveIsQuietKingMove(move, fen) {
    if (!move || move.length < 4 || moveIsCastle(move)) return false;
    const rows = fen.split(" ")[0].split("/");
    const row = 8 - parseInt(move[1], 10);
    if (row < 0 || row > 7) return false;
    const sq = expandRow(rows[row]);
    const piece = sq[move.charCodeAt(0) - 97];
    return piece?.toLowerCase() === "k";
  }

  function moveIsCapture(move, fen) {
    if (!move || move.length < 4) return false;
    const rows = fen.split(" ")[0].split("/");
    const f = move.charCodeAt(2) - 97, r = 8 - parseInt(move[3], 10);
    if (r < 0 || r > 7 || f < 0 || f > 7) return false;
    return expandRow(rows[r])[f] !== null;
  }

  function moveIsCheck(move, fen) {
    if (!move || move.length < 4) return false;
    const rows = fen.split(" ")[0].split("/");
    const enemy = fen.split(" ")[1] === "w" ? "k" : "K";
    let kf = -1, kr = -1;
    for (let r = 0; r < 8; r++) {
      const sq = expandRow(rows[r]);
      for (let f = 0; f < 8; f++) if (sq[f] === enemy) { kf = f; kr = 8 - r; }
    }
    return kf >= 0 && Math.abs((move.charCodeAt(2) - 97) - kf) <= 1 && Math.abs(parseInt(move[3], 10) - kr) <= 1;
  }

  function moveIsPawnPush(move) {
    if (!move || move.length < 4) return false;
    const dr = Math.abs(parseInt(move[3], 10) - parseInt(move[1], 10));
    return (dr === 1 || dr === 2) && (move[0] === move[2] || Math.abs(move.charCodeAt(0) - move.charCodeAt(2)) === 1);
  }

  function moveIsCastle(move) {
    if (!move || move.length < 4) return false;
    return (move.slice(0, 2) === "e1" && (move.slice(2) === "g1" || move.slice(2) === "c1")) ||
           (move.slice(0, 2) === "e8" && (move.slice(2) === "g8" || move.slice(2) === "c8"));
  }

  function humanFeelWeight(c, best, fen, recent) {
    if (!humanFeel) return 1.0;
    const diff = Math.abs(best - c.score);
    const cap = moveIsCapture(c.move, fen);
    if (diff > (cap ? 120 : 80)) return 0.01;
    let w = 1.0;
    if (cap) w *= 1.15;
    if (moveIsRepeat(c.move, recent)) w *= 0.7;
    if (moveNumber <= 15 && moveIsQuietKingMove(c.move, fen)) w *= 0.5;
    if (moveNumber <= 10) {
      if (moveIsCastle(c.move)) w *= 1.25;
      if (moveIsPawnPush(c.move)) w *= 0.95;
      if (c.move[0] === "d" && c.move[1] === "1" && !moveIsCastle(c.move)) w *= 0.8;
    }
    if (moveIsCastle(c.move)) w *= 1.2;
    if (moveIsCheck(c.move, fen)) w *= 1.1;
    return w;
  }

  function pickByStyle(fen) {
    if (!candidates.length) return bestMoveRaw;
    if (!humanFeel && style === "aggressive")
      return [...candidates].sort((a, b) => a.multipv - b.multipv)[0]?.move || bestMoveRaw;

    const sorted = [...candidates].sort((a, b) => a.multipv - b.multipv);
    const best = sorted[0].score;
    const prev = fenHistory.length >= 2 ? fenHistory[fenHistory.length - 2] : null;
    const recent = prev ? emptiedSquares(prev, fen) : new Set();

    const weighted = sorted.map(c => ({ ...c, weight: humanFeelWeight(c, best, fen, recent) }));

    if (humanFeel && currentEval !== null && currentEval <= -300 && sorted.length > 1 && Math.random() < 0.4)
      return sorted[1 + Math.floor(Math.random() * (sorted.length - 1))].move;

    if (style === "aggressive")
      weighted.forEach(c => { if (moveIsCapture(c.move, fen) || moveIsCheck(c.move, fen)) c.weight *= 1.4; });
    else if (style === "defensive")
      weighted.forEach(c => { if (!moveIsCapture(c.move, fen) && !moveIsPawnPush(c.move)) c.weight *= 1.3; });
    else if (style === "passive") {
      weighted.forEach(c => { if (!moveIsCapture(c.move, fen) && !moveIsCheck(c.move, fen)) c.weight *= 0.6; });
      weighted.sort((a, b) => a.score - b.score);
      for (const c of weighted)
        if (!moveIsCapture(c.move, fen) && !moveIsCheck(c.move, fen)) return c.move;
      return weighted[0].move;
    }

    const total = weighted.reduce((s, c) => s + c.weight, 0);
    if (total <= 0) return sorted[0].move;
    let roll = Math.random() * total;
    for (const c of weighted) { roll -= c.weight; if (roll <= 0) return c.move; }
    return weighted.at(-1).move;
  }

  // ---------- overlay (keep) ----------
  function removeHighlights() {
    document.querySelectorAll(".optimal-highlight").forEach(el => el.remove());
  }

  function drawHighlights(move) {
    removeHighlights();
    const board = document.querySelector("wc-chess-board");
    if (!board || !move || move.length < 4) return;
    for (const sq of [`${charMap[move[0]]}${move[1]}`, `${charMap[move[2]]}${move[3]}`]) {
      const div = document.createElement("div");
      div.className = `highlight optimal-highlight square-${sq}`;
      div.style.background = "red";
      div.style.opacity = "0.5";
      board.appendChild(div);
    }
  }

  // ---------- messaging to offscreen ----------
  function sendAnalyze(fen) {
    chrome.runtime.sendMessage({ target: "background", type: "ensure-offscreen" }, (res) => {
      if (!res?.ok) {
        const label = document.getElementById("optimal-status");
        if (label) label.textContent = "offscreen failed: " + (res?.error || "unknown");
        return;
      }
      offscreenReady = true;
      chrome.runtime.sendMessage({ target: "offscreen", type: "analyze", fen, depth: globalDepth + (-3 + Math.floor(Math.random() * 6)) });
    });
  }

  // listen for bestmove from offscreen
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.target !== "optimal") return;
    if (msg.type === "bestmove" && msg.fen === currentFen) {
      bestMoveRaw = msg.move;
      // bestmove arrived; we don't have multipv lines here, so just use raw.
      // For full multipv you'd extend offscreen to forward info lines.
      const chosen = bestMoveRaw;
      if (!chosen || chosen === "(none)") return;
      const delay = 1000 + Math.floor(Math.random() * 2000);
      const chosenFen = currentFen;
      setTimeout(() => {
        if (!running || getFenString() !== chosenFen) return;
        drawHighlights(chosen);
        const label = document.getElementById("optimal-status");
        if (label) {
          const eloNote = limitElo !== null ? ` | cap ${limitElo}` : "";
          label.textContent = `optimal (${style}): ${chosen} @ depth ${globalDepth}${eloNote}`;
        }
      }, delay);
    }
    if (msg.type === "engine-error") {
      const label = document.getElementById("optimal-status");
      if (label) label.textContent = "engine error: " + msg.error;
    }
  });

  function onBoardChange() {
    if (!running) return;
    const fen = getFenString();
    if (!fen || fen === currentFen) return;
    fenHistory.push(fen);
    if (fenHistory.length > 3) fenHistory.shift();
    currentFen = fen;
    moveNumber++;
    const cached = analysisCache.get(fen);
    if (cached) {
      drawHighlights(cached);
      const label = document.getElementById("optimal-status");
      if (label) label.textContent = `optimal (cached): ${cached}`;
      return;
    }
    sendAnalyze(fen);
  }

  function beginObserver() {
    const board = document.querySelector("wc-chess-board");
    if (!board) return false;
    observer = new MutationObserver(onBoardChange);
    observer.observe(board, { childList: true, subtree: true, attributes: true });
    return true;
  }

  function stopOptimal() {
    running = false;
    observer?.disconnect(); observer = null;
    removeHighlights();
    currentFen = null; moveNumber = 0; currentEval = null; fenHistory = [];
    candidates = []; bestMoveRaw = null;
    const btn = document.getElementById("optimal_button");
    if (btn) { btn.disabled = false; btn.textContent = "Start Optimal"; }
    const s = document.getElementById("optimal-status"); if (s) s.textContent = "";
  }

  function startOptimal(button) {
    if (running) return stopOptimal();
    const board = document.querySelector("wc-chess-board");
    if (!board) { button.textContent = "Start Optimal"; button.disabled = false; return; }

    moveNumber = 0; fenHistory = []; currentEval = null;
    globalDepth = parseInt(document.getElementById("optimal_depth").value, 10) || 18;
    const elo = document.getElementById("optimal_engine_elo");
    limitElo = elo && parseInt(elo.value, 10) >= 1320 ? parseInt(elo.value, 10) : null;
    saveSettings();

    running = true;
    button.disabled = true;
    button.textContent = "Starting…";

    const fen = getFenString();
    if (!fen) { running = false; button.disabled = false; button.textContent = "Start Optimal"; return; }

    currentFen = fen; fenHistory.push(fen);
    sendAnalyze(fen);
    if (!beginObserver()) { stopOptimal(); return; }
    button.textContent = "Stop Optimal";
    const s = document.getElementById("optimal-status"); if (s) s.textContent = "analyzing…";
    onBoardChange();
  }

  // ---------- UI (keep your original makeSliderBlock, makeToggle, makeStyleBlock, applyCollapseState, injectUI) ----------
  function makeSliderBlock(id, title, description, min, max, value, onInput) {
    const wrap = document.createElement("div");
    wrap.style.cssText = `margin:10px 0;padding:8px;border:1px solid ${PANEL_BORDER};border-radius:6px;background:${PANEL_BG};color:${FG};`;
    const row = document.createElement("div");
    row.style.cssText = "display:flex;justify-content:space-between;align-items:baseline;margin-bottom:2px;";
    const t = document.createElement("span"); t.textContent = title; t.style.cssText = `font-size:13px;font-weight:600;color:${FG};`;
    const v = document.createElement("span"); v.id = id + "_value"; v.textContent = value; v.style.cssText = `font-size:13px;font-weight:600;color:${ACCENT};`;
    row.append(t, v);
    const d = document.createElement("div"); d.textContent = description; d.style.cssText = `font-size:11px;color:${FG_DIM};margin-bottom:6px;line-height:1.3;`;
    const s = document.createElement("input"); s.type = "range"; s.id = id; s.min = min; s.max = max; s.value = value; s.style.cssText = "width:100%;";
    s.oninput = () => { v.textContent = s.value; onInput(parseInt(s.value, 10)); saveSettings(); };
    wrap.append(row, d, s);
    return wrap;
  }

  function makeToggle(id, label, desc, initial, onChange) {
    const wrap = document.createElement("div");
    wrap.style.cssText = `margin:10px 0;padding:8px;border:1px solid ${PANEL_BORDER};border-radius:6px;background:${PANEL_BG};color:${FG};`;
    const row = document.createElement("div"); row.style.cssText = "display:flex;justify-content:space-between;align-items:center;";
    const l = document.createElement("span"); l.textContent = label; l.style.cssText = `font-size:13px;font-weight:600;color:${FG};`;
    const b = document.createElement("button"); b.id = id; b.textContent = initial ? "ON" : "OFF";
    b.style.cssText = `padding:4px 12px;border-radius:4px;border:1px solid ${PANEL_BORDER};background:${initial ? ACCENT : "transparent"};color:${initial ? "#000" : FG};cursor:pointer;font-size:12px;font-weight:600;`;
    b.onclick = () => {
      const next = b.textContent === "OFF";
      b.textContent = next ? "ON" : "OFF";
      b.style.background = next ? ACCENT : "transparent";
      b.style.color = next ? "#000" : FG;
      onChange(next); saveSettings();
    };
    row.append(l, b);
    const d = document.createElement("div"); d.textContent = desc; d.style.cssText = `font-size:11px;color:${FG_DIM};margin-top:4px;line-height:1.3;`;
    wrap.append(row, d);
    return wrap;
  }

  function makeStyleBlock() {
    const wrap = document.createElement("div");
    wrap.style.cssText = `margin:10px 0;padding:8px;border:1px solid ${PANEL_BORDER};border-radius:6px;background:${PANEL_BG};color:${FG};`;
    const title = document.createElement("div"); title.textContent = "Playstyle"; title.style.cssText = `font-size:13px;font-weight:600;margin-bottom:2px;color:${FG};`;
    const desc = document.createElement("div"); desc.textContent = "Filters Stockfish candidates. Aggressive prefers checks/captures. Defensive prefers quiet moves. Passive picks weakest safe."; desc.style.cssText = `font-size:11px;color:${FG_DIM};margin-bottom:6px;line-height:1.3;`;
    const row = document.createElement("div"); row.style.cssText = "display:flex;gap:6px;";
    const buttons = {};
    ["aggressive", "defensive", "passive"].forEach((s) => {
      const b = document.createElement("button"); b.textContent = s[0].toUpperCase() + s.slice(1);
      b.style.cssText = `flex:1;padding:6px;border-radius:4px;border:1px solid ${PANEL_BORDER};background:transparent;color:${FG};cursor:pointer;font-size:12px;`;
      b.onclick = () => { style = s; Object.entries(buttons).forEach(([k, el]) => { el.style.background = k === s ? ACCENT : "transparent"; el.style.color = k === s ? "#000" : FG; el.style.fontWeight = k === s ? "600" : "normal"; }); saveSettings(); };
      buttons[s] = b; row.appendChild(b);
    });
    Object.entries(buttons).forEach(([k, el]) => { el.style.background = k === style ? ACCENT : "transparent"; el.style.color = k === style ? "#000" : FG; el.style.fontWeight = k === style ? "600" : "normal"; });
    wrap.append(title, desc, row);
    return wrap;
  }

  function applyCollapseState() {
    const body = document.getElementById("optimal-body");
    const caret = document.getElementById("optimal_caret");
    if (!body || !caret) return;
    body.style.display = uiCollapsed ? "none" : "block";
    caret.textContent = uiCollapsed ? "▸" : "▾";
  }

  function injectUI() {
    const main = document.querySelector(".board-layout-main");
    if (!main || document.getElementById("optimal_button")) return;

    const root = document.createElement("div"); root.id = "optimal-root";
    root.style.cssText = `color:${FG};font-family:inherit;background:#1e1e1e;border:1px solid ${PANEL_BORDER};border-radius:8px;padding:8px;margin:6px 0;`;

    const header = document.createElement("div"); header.style.cssText = "display:flex;gap:6px;align-items:stretch;";
    const btn = document.createElement("button"); btn.id = "optimal_button"; btn.className = "ui_v5-button-component ui_v5-button-primary ui_v5-button-large ui_v5-button-full";
    btn.style.cssText = "flex:1;color:#fff;"; btn.textContent = "Start Optimal"; btn.onclick = () => startOptimal(btn);

    const caret = document.createElement("button"); caret.id = "optimal_caret";
    caret.className = "ui_v5-button-component ui_v5-button-secondary ui_v5-button-large";
    caret.style.cssText = `width:36px;flex:none;font-size:14px;color:${FG};background:${PANEL_BG};border:1px solid ${PANEL_BORDER};border-radius:4px;cursor:pointer;`;
    caret.textContent = "▾";
    caret.onclick = () => { uiCollapsed = !uiCollapsed; applyCollapseState(); saveSettings(); };
    header.append(btn, caret);

    const body = document.createElement("div"); body.id = "optimal-body";
    body.append(
      makeSliderBlock("optimal_depth", "Search Depth", "Higher = stronger but slower. Jitter applied.", 5, 30, globalDepth, v => { globalDepth = v; }),
      makeSliderBlock("optimal_engine_elo", "Stockfish Strength Cap (ELO)", "Cap engine strength. 3190 = full.", 1320, 3190, limitElo ?? 3190, v => { limitElo = v; }),
      makeToggle("optimal_human", "Human-Feel Re-Ranking", "Randomized delay, capture tolerance, anti-repeat.", humanFeel, v => { humanFeel = v; }),
      makeStyleBlock()
    );
    const status = document.createElement("div"); status.id = "optimal-status";
    status.style.cssText = `font-size:12px;color:${FG_DIM};margin-bottom:6px;`;
    body.append(status);

    root.append(header, body);
    main.prepend(root);
    applyCollapseState();
  }

  function boot() {
    loadSettings((s) => {
      applySettings(s);
      injectUI();
      new MutationObserver(() => { if (!document.getElementById("optimal_button")) injectUI(); })
        .observe(document.body, { childList: true, subtree: true });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  return { startOptimal, stopOptimal };
})();
