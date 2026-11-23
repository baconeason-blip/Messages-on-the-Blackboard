// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: pink; icon-glyph: chalkboard-teacher;

/* ============================================================
   黑板 · 桌面小工具（Scriptable）

   在主畫面顯示黑板上目前的筆跡，不用打開 App。
   點一下小工具會開啟黑板網頁。

   【安裝】
   1. App Store 下載免費的「Scriptable」
   2. 打開 Scriptable → 右上角 + → 把這整份程式碼貼進去
   3. 左上角檔名改成「黑板」→ 完成
   4. 回主畫面 → 長按空白處 → 左上角 + → 找到 Scriptable
      → 選尺寸 → 加入小工具
   5. 長按剛加入的小工具 → 「編輯小工具」
      → Script 選「黑板」
      → When Interacting 選 Run Script（或 Open URL）

   【設定】只需要改下面 ROOM 這一行。
   房間代碼取得方式：打開黑板 App，點左上角「房間 xxxxxx」
   會自動複製完整的 32 字元代碼，貼過來即可。
   兩個人要填一樣的代碼。
   ============================================================ */

// ===================== 只要改這一行 =====================
const ROOM = "請貼上你的房間代碼";
// =======================================================

const DB_URL  = "https://messages-on-the-blackboa-176e7-default-rtdb.asia-southeast1.firebasedatabase.app";
const APP_URL = "https://baconeason-blip.github.io/Messages-on-the-Blackboard/";

const COLORS      = { p: "#ff9ec7", b: "#8ad4ff" };
const WIDTHS      = { 1: 0.005, 2: 0.012, 3: 0.026 };  // 佔畫布寬度的比例
const ASPECT_W    = 9, ASPECT_H = 16;                  // 黑板固定 9:16
const MAX_ZOOM    = 6;      // 相對於「整塊黑板」的最大放大倍率，避免一個小點被撐滿整格
const REFRESH_MIN = 15;     // 建議 iOS 多久之後重新整理（系統只當參考，不保證）

/* ---------------- 版面尺寸（像素，iOS 會自動縮放） ---------------- */

const FAMILY = config.runsInWidget ? config.widgetFamily : "large";
const SIZES  = {
  small:  [465, 465],
  medium: [987, 465],
  large:  [987, 1035],
  extraLarge: [2000, 1035]
};
const [W, H] = SIZES[FAMILY] || SIZES.medium;

/* ---------------- 小工具 ---------------- */

const widget = new ListWidget();
widget.setPadding(0, 0, 0, 0);
widget.url = APP_URL;
widget.refreshAfterDate = new Date(Date.now() + REFRESH_MIN * 60 * 1000);

if (ROOM.length !== 32) {
  widget.backgroundImage = messageImage("還沒設定房間代碼", "打開黑板 App 點左上角\n「房間 xxxxxx」複製代碼");
} else {
  const { data, stale, err } = await loadStrokes();
  if (data === null) {
    widget.backgroundImage = /permission|denied|401|403/i.test(err || "")
      ? messageImage("沒有讀取權限", "房間代碼可能打錯了\n或安全規則尚未發布")
      : messageImage("讀不到黑板", "檢查網路連線");
  } else {
    const strokes = parseStrokes(data);
    widget.backgroundImage = strokes.length
      ? boardImage(strokes, stale)
      : messageImage("黑板是空的", "點一下開始畫");
  }
}

if (config.runsInWidget) Script.setWidget(widget);
else if (FAMILY === "small") await widget.presentSmall();
else if (FAMILY === "medium") await widget.presentMedium();
else await widget.presentLarge();
Script.complete();

/* ---------------- 讀取資料（含離線快取） ---------------- */

async function loadStrokes() {
  const fm = FileManager.local();
  const cachePath = fm.joinPath(fm.cacheDirectory(), "blackboard-" + ROOM.slice(0, 10) + ".json");
  try {
    const req = new Request(DB_URL + "/boards/" + ROOM + "/strokes.json");
    req.timeoutInterval = 20;
    const data = await req.loadJSON();
    if (data && data.error) throw new Error(data.error);
    fm.writeString(cachePath, JSON.stringify(data || {}));
    return { data: data || {}, stale: false };
  } catch (e) {
    // 連不上就拿上次成功的結果來顯示，總比一片空白好
    if (fm.fileExists(cachePath)) {
      try { return { data: JSON.parse(fm.readString(cachePath)), stale: true, err: String(e) }; } catch (_) {}
    }
    return { data: null, stale: true, err: String(e) };
  }
}

function parseStrokes(obj) {
  const out = [];
  for (const id of Object.keys(obj).sort()) {      // push id 本身就是時間順序
    const s = obj[id];
    if (!s || typeof s.p !== "string") continue;
    const n = s.p.split(",");
    const pts = [];
    for (let i = 0; i + 1 < n.length; i += 2) pts.push([+n[i] / 1000, +n[i + 1] / 1000]);
    if (!pts.length) continue;
    out.push({ id, c: s.c, w: s.w, pts });
  }
  return out;
}

/* Firebase 的 push id 前 8 碼就是建立時間（毫秒），拿來算「幾分鐘前」 */
function pushIdTime(id) {
  const CH = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
  let t = 0;
  for (let i = 0; i < 8; i++) {
    const v = CH.indexOf(id.charAt(i));
    if (v < 0) return null;
    t = t * 64 + v;
  }
  return (t > 1e12 && t < 4e12) ? t : null;
}

function relativeTime(ms) {
  if (ms == null) return "";
  const diff = Math.max(0, Date.now() - ms);
  const m = Math.floor(diff / 60000);
  if (m < 1)    return "剛剛";
  if (m < 60)   return m + " 分鐘前";
  const h = Math.floor(m / 60);
  if (h < 24)   return h + " 小時前";
  const d = Math.floor(h / 24);
  if (d === 1)  return "昨天";
  if (d < 30)   return d + " 天前";
  return "很久以前";
}

/* ---------------- 繪圖 ---------------- */

function backdrop(dc) {
  const bands = 48;
  for (let i = 0; i < bands; i++) {
    const t = i / (bands - 1);
    dc.setFillColor(new Color(rgbHex(36 - 13 * t, 76 - 24 * t, 63 - 19 * t)));
    dc.fillRect(new Rect(0, Math.floor(H * i / bands), W, Math.ceil(H / bands) + 1));
  }
}

function rgbHex(r, g, b) {
  const f = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return "#" + f(r) + f(g) + f(b);
}

function newContext() {
  const dc = new DrawContext();
  dc.size = new Size(W, H);
  dc.opaque = true;
  dc.respectScreenScale = false;
  backdrop(dc);
  return dc;
}

function messageImage(title, sub) {
  const dc = newContext();
  const base = Math.min(W, H);
  dc.setTextAlignedCenter();
  dc.setTextColor(new Color("#cfe0d8"));
  dc.setFont(Font.semiboldSystemFont(Math.round(base * 0.085)));
  dc.drawTextInRect(title, new Rect(0, H * 0.38, W, base * 0.14));
  dc.setTextColor(new Color("#86a89a"));
  dc.setFont(Font.systemFont(Math.round(base * 0.055)));
  dc.drawTextInRect(sub, new Rect(W * 0.08, H * 0.52, W * 0.84, base * 0.26));
  return dc.getImage();
}

function boardImage(strokes, stale) {
  const dc = newContext();

  // 1) 算出所有筆跡的範圍，小工具只顯示有畫東西的那一塊
  let bx0 = 1, by0 = 1, bx1 = 0, by1 = 0;
  for (const s of strokes) for (const [x, y] of s.pts) {
    if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
    if (y < by0) by0 = y; if (y > by1) by1 = y;
  }
  const padN = 0.045;
  bx0 = Math.max(0, bx0 - padN); by0 = Math.max(0, by0 - padN);
  bx1 = Math.min(1, bx1 + padN); by1 = Math.min(1, by1 + padN);

  const inset = Math.round(Math.min(W, H) * 0.085);
  const footH = Math.round(Math.min(W, H) * 0.105);
  const availW = W - 2 * inset;
  const availH = H - 2 * inset - footH;

  const realW = Math.max(1e-4, (bx1 - bx0) * ASPECT_W);
  const realH = Math.max(1e-4, (by1 - by0) * ASPECT_H);
  const fitAll = Math.min(availW / ASPECT_W, availH / ASPECT_H);   // 整塊黑板剛好塞滿的倍率
  const scale  = Math.min(Math.min(availW / realW, availH / realH), fitAll * MAX_ZOOM);

  const ox = (W - realW * scale) / 2;
  const oy = inset + (availH - realH * scale) / 2;
  const toPx = (x, y) => [ox + (x - bx0) * ASPECT_W * scale, oy + (y - by0) * ASPECT_H * scale];

  // 2) 畫筆跡
  let dots = 0;
  for (const s of strokes) {
    const color = new Color(COLORS[s.c] || "#ffffff");
    const lw = Math.max(1.5, (WIDTHS[s.w] || WIDTHS[2]) * ASPECT_W * scale);

    // 轉成像素座標並簡化：太近的點丟掉，省掉大量繪圖呼叫
    const px = [];
    for (const [x, y] of s.pts) {
      const p = toPx(x, y);
      if (px.length) {
        const q = px[px.length - 1];
        if ((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 < 2.0) continue;
      }
      px.push(p);
    }
    if (!px.length) continue;

    if (px.length === 1) {                       // 點一下＝圓點
      dc.setFillColor(color);
      dc.fillEllipse(new Rect(px[0][0] - lw / 2, px[0][1] - lw / 2, lw, lw));
      continue;
    }

    const path = new Path();
    path.move(new Point(px[0][0], px[0][1]));
    for (let i = 1; i < px.length; i++) path.addLine(new Point(px[i][0], px[i][1]));
    dc.setStrokeColor(color);
    dc.setLineWidth(lw);
    dc.addPath(path);
    dc.strokePath();

    // DrawContext 沒有圓頭筆觸，線夠粗時在轉折點補圓點，避免出現缺角
    if (lw >= 4 && dots < 3000) {
      dc.setFillColor(color);
      for (const [x, y] of px) {
        dc.fillEllipse(new Rect(x - lw / 2, y - lw / 2, lw, lw));
        if (++dots >= 3000) break;
      }
    }
  }

  // 3) 底部資訊列
  const fs = Math.round(Math.min(W, H) * 0.062);
  const ty = H - inset - fs * 1.25;
  dc.setFont(Font.mediumSystemFont(fs));
  dc.setTextAlignedLeft();
  dc.setTextColor(new Color("#a8c8b9"));
  dc.drawTextInRect("黑板", new Rect(inset, ty, W * 0.5, fs * 1.6));

  const last = pushIdTime(strokes[strokes.length - 1].id);
  let right = relativeTime(last);
  if (stale) right = right ? right + " · 離線" : "離線";
  if (right) {
    dc.setTextAlignedRight();
    dc.setTextColor(new Color("#789889"));
    dc.drawTextInRect(right, new Rect(W * 0.4, ty, W * 0.6 - inset, fs * 1.6));
  }

  return dc.getImage();
}
