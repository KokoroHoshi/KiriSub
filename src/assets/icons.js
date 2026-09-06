/* KiriSub 小圖示集中管理
 * 全部使用 24x24 viewBox、fill 用 "currentColor"，
 * 讓 `color` 隨按鈕／狀態變色，並能正常響應 hover/focus。
 *
 * 使用方法：
 *   import { icon, addIcon } from "./assets/icons";
 *   btn.appendChild(icon("folder"));           // 取得一個新圖示元素
 *   addIcon(btn, "folder");                    // 直接塞進按鈕（附 aria 與文字）
 *
 * 若要替換成自己畫的 SVG：
 *   - 編輯下方 SVG_ICONS 裡相對應的 `inner`（<svg> 之間的內容），
 *   - 或直接複製整個 <svg> 標籤（去掉外層 <use> 結構）。
 *   viewBox 統一 0 0 24 24，stroke 筆畫粗細可自訂，但建議維持 1.6–2 的一致性。
 */

export const SVG_ICONS = {
  // —— 檔案／資料夾 ——
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5V6.5Z"/>',
  folderOpen: '<path d="M3 7a1.5 1.5 0 0 1 1.5-1.5H9l2 2.5h8A1.5 1.5 0 0 1 20.5 10h-2l2.2 8a1.5 1.5 0 0 1-1.46 1.9H6.2A2 2 0 0 1 4.3 18L3 7Z"/>',
  download: '<path d="M12 4v11m0 0 4-4m-4 4-4-4M5 20h14"/>',

  // —— 生成／AI ——
  sparkles: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3ZM18 16l.9 2.1L21 19l-2.1.9L18 22l-.9-2.1L15 19l2.1-.9L18 16Z"/>',

  // —— 播放控制 ——
  play: '<path d="M7 5.5v13a.6.6 0 0 0 .9.5l10.6-6.5a.6.6 0 0 0 0-1L7.9 5a.6.6 0 0 0-.9.5Z"/>',
  pause: '<path d="M7 6h3.3v12H7zM13.7 6H17v12h-3.3z"/>',

  // —— 編輯操作 ——
  plus: '<path d="M12 5v14M5 12h14"/>',
  delete: '<path d="M9 4h6M6 7h12M9 7v10m3-10v10m3-10v10M9.5 4l.5-1h4l.5 1"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  downloadSmall: '<path d="M12 4v9m0 0 4-4m-4 4-4-4M5 19h14"/>',

  // —— 更新 ——
  refresh: '<path d="M4 12a8 8 0 0 1 13.7-5.7L20 8.5M20 4v4.5h-4.5M20 12a8 8 0 0 1-13.7 5.7L4 15.5M4 20v-4.5h4.5"/>',

  // —— 快取／清除 ——
  trash: '<path d="M9 4h6M6 7h12M9 7l.6 11h4.8L15 7M10 10.5v5m4-5v5"/>',

  // —— 狀態勾選 ——
  check: '<path d="M5 12.5 10 17l9-9"/>',
  minus: '<path d="M6 12h12"/>',

  // —— 新增列 ── 用 insert 語意 ──
  insert: '<path d="M12 4v13M8 13l4 4 4-4M5 20h14"/>',
};

// 回傳一個新的 <svg> 圖示元素（24x24，currentColor）
export function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.classList.add("icon");
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  g.setAttribute("fill", "none");
  g.setAttribute("stroke", "currentColor");
  g.setAttribute("stroke-width", "1.8");
  g.setAttribute("stroke-linecap", "round");
  g.setAttribute("stroke-linejoin", "round");
  if (SVG_ICONS[name]) g.innerHTML = SVG_ICONS[name];
  svg.appendChild(g);
  return svg;
}

// 把圖示塞進按鈕，保留連續文字間的空格。
// label 可為 null（純圖示按鈕，需配 aria-label）。
export function addIcon(btn, name, label) {
  btn.appendChild(icon(name));
  if (label) {
    btn.appendChild(document.createTextNode(" " + label));
  }
}