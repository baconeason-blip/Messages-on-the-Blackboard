// ============================================================
// Firebase 設定值
// ============================================================
// 這裡只需要 databaseURL。
// 原因：apiKey 只在使用 Firebase Authentication（驗證）時才需要，
// 本專案不開驗證，資料庫存取權完全由 database.rules.json 決定。
//
// 若日後要換一個 Firebase 專案，只改這一行即可。
// ============================================================

export const FIREBASE_CONFIG = {
  databaseURL: "https://messages-on-the-blackboa-176e7-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "messages-on-the-blackboa-176e7"
};
