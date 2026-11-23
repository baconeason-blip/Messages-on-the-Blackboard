/* ===========================================================
   黑板 — 核心邏輯
   -----------------------------------------------------------
   資料流：
     手指按下 → 本地立刻畫（不等網路）→ push 一筆新筆畫到資料庫
     手指移動 → 每 100 ms 把新增的點 update 上去（對方看得到筆跡生長）
     手指放開 → 補送最後一段並標記完成
     對方裝置以 onChildAdded / onChildChanged / onChildRemoved 監聽同一路徑

   座標：一律存成 0–1000 的整數（畫布寬高的千分比），
         所以不同尺寸的螢幕看到的構圖完全一致。
   =========================================================== */

import { initializeApp }
  from "https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js";
import {
  getDatabase, ref, push, update, remove,
  onChildAdded, onChildChanged, onChildRemoved, onValue
} from "https://www.gstatic.com/firebasejs/13.3.0/firebase-database.js";
import { FIREBASE_CONFIG } from "./firebase-config.js";

/* ---------------- 常數 ---------------- */

const COLORS   = { p:"#ff9ec7", b:"#8ad4ff" };   // 粉紅 / 淺藍
const WIDTHS   = { 1:0.005, 2:0.012, 3:0.026 };  // 相對畫布寬度的比例
const MAX_STROKES = 2000;   // 黑板筆畫上限，超過自動丟棄最舊的
const MAX_UNDO    = 20;     // 復原堆疊上限
const MAX_PTS     = 400;    // 單筆點數上限，超過就切成下一筆
const FLUSH_MS    = 100;    // 推送節流間隔
const ERASE_MS    = 40;     // 橡皮擦命中判定節流間隔
const HOLD_MS     = 2000;   // 清除鍵長按時間

/* ---------------- DOM ---------------- */

const $ = (id) => document.getElementById(id);
const gate = $("gate"), picker = $("picker"), board = $("board");
const codeInput = $("codeInput"), codeWarn = $("codeWarn"), codeGo = $("codeGo");
const canvas = $("canvas"), stage = $("stage");
const statusDot = $("status"), roomTag = $("roomTag"), toastEl = $("toast");
const eraserBtn = $("eraserBtn"), undoBtn = $("undoBtn");
const clearBtn = $("clearBtn"), clearFill = $("clearFill");
const ctx = canvas.getContext("2d");

/* ---------------- 狀態 ---------------- */

let myColor = localStorage.getItem("bb_color") || null;   // "p" | "b"
let myUid   = localStorage.getItem("bb_uid")   || null;
let penW    = Number(localStorage.getItem("bb_width") || 2);
let eraser  = false;

let strokesRef = null;            // 資料庫中本房間的 strokes 節點
const strokes  = new Map();       // id -> {u,c,w,pts,drawn,bbox}
const myStack  = [];              // 自己畫過的筆畫 id（供復原）
const localIds = new Set();       // 自己在本機已即時畫過的，避免重複描繪

let live = null;                  // 正在畫的那一筆
let flushTimer = null;
let lastEraseAt = 0;

if (!myUid) {
  myUid = Math.random().toString(36).slice(2, 10);
  localStorage.setItem("bb_uid", myUid);
}

/* ---------------- 小工具 ---------------- */

function toast(msg, ms = 1800) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove("show"), ms);
}

/* 邀請碼 → 房間路徑：SHA-256 取前 16 位元組（32 個十六進位字元）。
   原始邀請碼不會離開這台裝置，資料庫只看得到雜湊後的路徑。 */
async function roomKeyFromCode(code) {
  if (!(window.crypto && crypto.subtle)) {
    throw new Error("INSECURE_CONTEXT");
  }
  const data = new TextEncoder().encode("blackboard:" + code.trim().toLowerCase());
  const buf  = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].slice(0, 16)
         .map(b => b.toString(16).padStart(2, "0")).join("");
}

/* 點陣列 <-> 緊湊字串。存成千分比整數，例如 "500,250,512,266" */
function encode(pts) {
  const out = [];
  for (const [x, y] of pts) out.push(Math.round(x * 1000), Math.round(y * 1000));
  return out.join(",");
}
function decode(str) {
  if (!str) return [];
  const n = str.split(",");
  const pts = [];
  for (let i = 0; i + 1 < n.length; i += 2) pts.push([+n[i] / 1000, +n[i + 1] / 1000]);
  return pts;
}
function bboxOf(pts) {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

/* ---------------- 畫布 ---------------- */

/* 畫布固定比例（寬 / 高）。固定比例是兩台不同尺寸裝置看到相同構圖的前提。
   9:16 貼近手機螢幕，幾乎填滿畫面；要改成 3:4 之類的只要動這一行。
   注意：改了之後，先前畫的內容會依新比例被拉伸。 */
const ASPECT = 9 / 16;

function resizeCanvas() {
  const cs = getComputedStyle(stage);
  const availW = stage.clientWidth  - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const availH = stage.clientHeight - parseFloat(cs.paddingTop)  - parseFloat(cs.paddingBottom);
  if (availW <= 0 || availH <= 0) return;

  // 在可用空間內塞進最大的 3:4 矩形
  let cssW = availW, cssH = cssW / ASPECT;
  if (cssH > availH) { cssH = availH; cssW = cssH * ASPECT; }
  canvas.style.width  = cssW + "px";
  canvas.style.height = cssH + "px";

  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = Math.max(1, Math.round(cssW * dpr));
  const h = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width === w && canvas.height === h) return;
  canvas.width = w; canvas.height = h;
  redrawAll();
}

function lineWidthPx(w) {
  return Math.max(1, WIDTHS[w] * canvas.width);
}

/* 畫一筆。fromIndex > 0 時只補畫新增的那一段，避免整張重畫。 */
function drawStroke(s, fromIndex = 0) {
  const pts = s.pts;
  if (!pts.length) return;
  const W = canvas.width, H = canvas.height;

  ctx.save();
  ctx.strokeStyle = COLORS[s.c] || "#ffffff";
  ctx.lineWidth   = lineWidthPx(s.w);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalAlpha = 0.95;
  ctx.shadowColor = ctx.strokeStyle;      // 粉筆的微弱暈光
  ctx.shadowBlur  = ctx.lineWidth * 0.55;

  if (pts.length === 1) {                 // 單點＝點一下，畫成圓點
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.arc(pts[0][0] * W, pts[0][1] * H, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  const start = Math.max(0, fromIndex - 1);
  ctx.beginPath();
  ctx.moveTo(pts[start][0] * W, pts[start][1] * H);
  for (let i = start + 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * W, pts[i][1] * H);
  ctx.stroke();
  ctx.restore();
}

/* 重畫節流：清除整塊時 onChildRemoved 會連發上千次，
   全部合併到同一個動畫影格只重畫一次。 */
let redrawPending = false;
function scheduleRedraw() {
  if (redrawPending) return;
  redrawPending = true;
  requestAnimationFrame(() => { redrawPending = false; redrawAll(); });
}

function redrawAll() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const [id, s] of strokes) {
    if (live && id === live.id) continue;   // 正在畫的那一筆由 live 負責，避免疊畫
    drawStroke(s, 0);
    s.drawn = s.pts.length;
  }
  if (live) { drawStroke(live, 0); live.drawn = live.pts.length; }
}

/* ---------------- 資料庫事件 ---------------- */

function upsertFromDB(id, val) {
  if (!val || typeof val.p !== "string") return;
  const pts = decode(val.p);
  let s = strokes.get(id);

  if (!s) {
    s = { u: val.u, c: val.c, w: val.w, pts, drawn: 0, bbox: bboxOf(pts) };
    strokes.set(id, s);
    if (localIds.has(id)) {
      s.drawn = pts.length;               // 自己的筆畫本機已經畫過了
    } else {
      drawStroke(s, 0);
      s.drawn = pts.length;
    }
    trimIfNeeded();
    return;
  }

  s.pts = pts;
  s.bbox = bboxOf(pts);
  if (localIds.has(id)) { s.drawn = pts.length; return; }
  if (pts.length > s.drawn) {             // 對方的筆畫正在長出來，只補畫新段
    drawStroke(s, s.drawn);
    s.drawn = pts.length;
  } else if (pts.length < s.drawn) {
    scheduleRedraw();
  }
}

/* 超過上限時刪掉最舊的筆畫。Map 的順序就是 push key 的時間順序。 */
let trimming = false;
function trimIfNeeded() {
  if (trimming || strokes.size <= MAX_STROKES) return;
  trimming = true;
  const over = strokes.size - MAX_STROKES;
  const victims = [...strokes.keys()].slice(0, over);
  for (const id of victims) strokes.delete(id);
  Promise.all(victims.map(id => remove(childRef(id)).catch(() => {})))
    .finally(() => { trimming = false; });
}

function childRef(id) {
  return ref(db, `boards/${roomKey}/strokes/${id}`);
}

/* ---------------- 繪圖輸入 ---------------- */

function posOf(ev) {
  const r = canvas.getBoundingClientRect();
  let x = (ev.clientX - r.left) / r.width;
  let y = (ev.clientY - r.top)  / r.height;
  return [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
}

function onDown(ev) {
  if (!strokesRef) return;
  canvas.setPointerCapture(ev.pointerId);
  const p = posOf(ev);

  if (eraser) { eraseAt(p, true); return; }

  const node = push(strokesRef);
  live = { id: node.key, u: myUid, c: myColor, w: penW,
           pts: [p], drawn: 0, bbox: bboxOf([p]), sent: 0 };
  localIds.add(node.key);

  update(node, { u: myUid, c: myColor, w: penW, p: encode(live.pts), d: 0 })
    .catch(err => toast("寫入失敗：" + (err.code || err.message)));
  live.sent = live.pts.length;

  myStack.push(node.key);
  while (myStack.length > MAX_UNDO) myStack.shift();

  drawStroke(live, 0);
  live.drawn = 1;
  scheduleFlush();
}

function onMove(ev) {
  if (eraser) {
    if (eraserDragging) eraseAt(posOf(ev), false);
    return;
  }
  if (!live) return;

  // 合併同一幀的多個事件點，筆跡更順
  const evs = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
  for (const e of evs) {
    const p = posOf(e);
    const last = live.pts[live.pts.length - 1];
    const dx = p[0] - last[0], dy = p[1] - last[1];
    if (dx * dx + dy * dy < 0.0000025) continue;    // 太近的點直接丟掉（約 0.16%）
    live.pts.push(p);
  }
  if (live.pts.length === live.drawn) return;

  drawStroke(live, live.drawn);
  live.drawn = live.pts.length;

  if (live.pts.length >= MAX_PTS) {
    const tail = live.pts[live.pts.length - 1];
    finishStroke();
    startContinuation(tail);
  }
}

/* 一筆畫太長時切段，使用者感覺不到，但單筆資料不會無限膨脹 */
function startContinuation(tail) {
  if (!tail) return;
  const node = push(strokesRef);
  live = { id: node.key, u: myUid, c: myColor, w: penW,
           pts: [tail], drawn: 1, bbox: bboxOf([tail]), sent: 0 };
  localIds.add(node.key);
  update(node, { u: myUid, c: myColor, w: penW, p: encode(live.pts), d: 0 }).catch(() => {});
  live.sent = 1;
  myStack.push(node.key);
  while (myStack.length > MAX_UNDO) myStack.shift();
  scheduleFlush();
}

function onUp(ev) {
  if (eraser) { eraserDragging = false; return; }
  if (!live) return;
  finishStroke();
}

function finishStroke() {
  if (!live) return;
  clearTimeout(flushTimer); flushTimer = null;
  const id = live.id, pts = live.pts.slice();
  update(childRef(id), { p: encode(pts), d: 1 }).catch(() => {});
  // 併入本機快取，之後重畫才看得到
  strokes.set(id, { u: myUid, c: myColor, w: penW,
                    pts, drawn: pts.length, bbox: bboxOf(pts) });
  live = null;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!live) return;
    if (live.pts.length !== live.sent) {
      update(childRef(live.id), { p: encode(live.pts) }).catch(() => {});
      live.sent = live.pts.length;
    }
    scheduleFlush();
  }, FLUSH_MS);
}

/* ---------------- 橡皮擦 ---------------- */

let eraserDragging = false;

/* 點到線段的距離（像素空間，所以 3:4 的比例不會造成誤差） */
function distToSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 ? (wx * vx + wy * vy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = px - (ax + t * vx), dy = py - (ay + t * vy);
  return Math.hypot(dx, dy);
}

function eraseAt(p, force) {
  const now = performance.now();
  if (!force && now - lastEraseAt < ERASE_MS) return;
  lastEraseAt = now;

  const W = canvas.width, H = canvas.height;
  const px = p[0] * W, py = p[1] * H;
  const finger = Math.max(10, 0.022 * W);     // 手指的容許半徑
  const hits = [];

  for (const [id, s] of strokes) {
    const pad = (lineWidthPx(s.w) / 2 + finger);
    const [x0, y0, x1, y1] = s.bbox;          // 先用外接矩形快速排除
    if (px < x0 * W - pad || px > x1 * W + pad ||
        py < y0 * H - pad || py > y1 * H + pad) continue;

    const pts = s.pts;
    let hit = false;
    if (pts.length === 1) {
      hit = Math.hypot(px - pts[0][0] * W, py - pts[0][1] * H) <= pad;
    } else {
      for (let i = 1; i < pts.length && !hit; i++) {
        if (distToSeg(px, py,
              pts[i - 1][0] * W, pts[i - 1][1] * H,
              pts[i][0] * W,     pts[i][1] * H) <= pad) hit = true;
      }
    }
    if (hit) hits.push(id);
  }

  if (!hits.length) return;
  for (const id of hits) {
    strokes.delete(id);
    remove(childRef(id)).catch(() => {});
  }
  scheduleRedraw();
}

/* ---------------- 工具列 ---------------- */

document.querySelectorAll(".widthBtn").forEach(btn => {
  if (Number(btn.dataset.w) === penW) {
    document.querySelectorAll(".widthBtn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
  }
  btn.addEventListener("click", () => {
    penW = Number(btn.dataset.w);
    localStorage.setItem("bb_width", String(penW));
    document.querySelectorAll(".widthBtn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    if (eraser) toggleEraser(false);
  });
});

function toggleEraser(on) {
  eraser = on;
  eraserBtn.classList.toggle("active", on);
  canvas.style.cursor = on ? "cell" : "crosshair";
}
eraserBtn.addEventListener("click", () => toggleEraser(!eraser));

undoBtn.addEventListener("click", () => {
  while (myStack.length) {
    const id = myStack.pop();
    if (!strokes.has(id)) continue;       // 已經被擦掉或被清除了，往前再找
    strokes.delete(id);
    remove(childRef(id)).catch(() => {});
    scheduleRedraw();
    return;
  }
  toast("沒有可以收回的筆畫了");
});

/* 清除整塊：長按兩秒，避免誤觸把兩人的留言全毀 */
let holdTimer = null, holdStart = 0, holdRaf = 0;
function holdBegin(ev) {
  ev.preventDefault();
  holdStart = performance.now();
  const tick = () => {
    const pct = Math.min(100, (performance.now() - holdStart) / HOLD_MS * 100);
    clearFill.style.height = pct + "%";
    if (pct < 100) holdRaf = requestAnimationFrame(tick);
  };
  holdRaf = requestAnimationFrame(tick);
  holdTimer = setTimeout(() => {
    holdEnd();
    strokes.clear(); myStack.length = 0; live = null;
    redrawAll();
    remove(strokesRef).catch(err => toast("清除失敗：" + (err.code || err.message)));
    toast("黑板已清除");
  }, HOLD_MS);
}
function holdEnd() {
  clearTimeout(holdTimer); holdTimer = null;
  cancelAnimationFrame(holdRaf);
  clearFill.style.height = "0%";
}
clearBtn.addEventListener("pointerdown", holdBegin);
clearBtn.addEventListener("pointerup", holdEnd);
clearBtn.addEventListener("pointerleave", holdEnd);
clearBtn.addEventListener("pointercancel", holdEnd);
clearBtn.addEventListener("contextmenu", e => e.preventDefault());

/* ---------------- 啟動流程 ---------------- */

const app = initializeApp({ databaseURL: FIREBASE_CONFIG.databaseURL.replace(/\/+$/, "") });
const db  = getDatabase(app);
let roomKey = null;

/* 連線狀態燈 */
onValue(ref(db, ".info/connected"), snap => {
  const on = snap.val() === true;
  statusDot.classList.toggle("online", on);
  statusDot.title = on ? "已連線" : "離線中（筆畫會先存在本機，恢復連線後自動補送）";
});

function applyMyColor() {
  document.documentElement.style.setProperty("--myColor", COLORS[myColor]);
}

async function enterRoom(code) {
  try {
    roomKey = await roomKeyFromCode(code);
  } catch (err) {
    gate.classList.remove("hidden");
    picker.classList.add("hidden");
    codeWarn.textContent = (err.message === "INSECURE_CONTEXT")
      ? "必須透過 https:// 或 localhost 開啟，直接用檔案或 http 開會無法運作"
      : "無法進入黑板：" + err.message;
    return;
  }
  strokesRef = ref(db, `boards/${roomKey}/strokes`);
  roomTag.textContent = "房間 " + roomKey.slice(0, 6);
  roomTag.style.cursor = "pointer";
  roomTag.title = "點一下複製完整房間代碼（桌面小工具會用到）";

  onChildAdded(strokesRef,   s => upsertFromDB(s.key, s.val()));
  onChildChanged(strokesRef, s => upsertFromDB(s.key, s.val()));
  onChildRemoved(strokesRef, s => { strokes.delete(s.key); scheduleRedraw(); });

  board.classList.remove("hidden");
  requestAnimationFrame(resizeCanvas);
}

function showPicker() {
  gate.classList.add("hidden");
  picker.classList.remove("hidden");
}

document.querySelectorAll(".chalkPick").forEach(btn => {
  btn.addEventListener("click", () => {
    myColor = btn.dataset.color;
    localStorage.setItem("bb_color", myColor);
    applyMyColor();
    picker.classList.add("hidden");
    enterRoom(localStorage.getItem("bb_code"));
  });
});

function submitCode() {
  const code = codeInput.value.trim();
  if (code.length < 4) { codeWarn.textContent = "邀請碼太短，至少 4 個字元"; return; }
  if (code.length < 10) codeWarn.textContent = "";
  localStorage.setItem("bb_code", code);
  gate.classList.add("hidden");
  if (!myColor) { showPicker(); } else { applyMyColor(); enterRoom(code); }
}
codeGo.addEventListener("click", submitCode);
codeInput.addEventListener("keydown", e => { if (e.key === "Enter") submitCode(); });

/* 點左上角房間標籤 → 複製完整的 32 字元房間代碼。
   桌面小工具（Scriptable）需要這串代碼才讀得到這塊黑板。 */
roomTag.addEventListener("click", async () => {
  if (!roomKey) return;
  try {
    await navigator.clipboard.writeText(roomKey);
    toast("房間代碼已複製", 2400);
  } catch (e) {
    // Safari 偶爾會擋剪貼簿；退而求其次，直接把代碼顯示出來讓使用者長按選取
    roomTag.textContent = roomKey;
    roomTag.style.userSelect = "text";
    roomTag.style.webkitUserSelect = "text";
    toast("長按上方代碼即可選取複製", 3200);
  }
});

/* 畫布事件 */
canvas.addEventListener("pointerdown", e => {
  e.preventDefault();
  if (eraser) eraserDragging = true;
  onDown(e);
});
canvas.addEventListener("pointermove", onMove);
canvas.addEventListener("pointerup", onUp);
canvas.addEventListener("pointercancel", onUp);
canvas.addEventListener("contextmenu", e => e.preventDefault());

window.addEventListener("resize", () => requestAnimationFrame(resizeCanvas));
window.addEventListener("orientationchange", () => setTimeout(resizeCanvas, 250));
if (window.ResizeObserver) {
  new ResizeObserver(() => requestAnimationFrame(resizeCanvas)).observe(stage);
}

/* 開場：有存過邀請碼與顏色就直接進黑板 */
(function boot() {
  const saved = localStorage.getItem("bb_code");
  if (saved && myColor) {
    applyMyColor();
    gate.classList.add("hidden");
    enterRoom(saved);
  } else if (saved && !myColor) {
    codeInput.value = saved;
    gate.classList.add("hidden");
    showPicker();
  } else {
    codeInput.focus();
  }
})();

/* Service Worker：加入主畫面後可離線開啟外殼 */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
