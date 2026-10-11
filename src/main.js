import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save, ask } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { openPath } from "@tauri-apps/plugin-opener";
import { icon } from "./assets/icons";

const state = { videoPath: null, segments: [], busy: false, mediaType: "video", rowClickPlay: false, autoFollow: true, queue: [], editIndex: -1, exportMode: "per-file", exportDir: null };
let queueSeq = 0; // 佇列項目遞增 id

const ui = {
  video: document.getElementById("video"),
  audio: document.getElementById("audio"),
  pick: document.getElementById("pick-btn"),
  fileName: document.getElementById("file-name"),
  lang: document.getElementById("lang"),
  generate: document.getElementById("generate-btn"),
  progressWrap: document.getElementById("progress-wrap"),
  progressBar: document.getElementById("progress-bar"),
  cancelBtn: document.getElementById("cancel-btn"),
  status: document.getElementById("status"),
  previewHint: document.getElementById("preview-hint"),
  exportBtn: document.getElementById("export-btn"),
  offsetBar: document.getElementById("offset-bar"),
  helpBtn: document.getElementById("help-btn"),
  helpView: document.getElementById("help-view"),
  helpClose: document.getElementById("help-close"),
  empty: document.getElementById("empty"),
  emptyPick: document.getElementById("empty-pick"),
  pickFolder: document.getElementById("pick-folder-btn"),
  editorTitle: document.getElementById("editor-title"),
  backBtn: document.getElementById("back-btn"),
  queueView: document.getElementById("queue-view"),
  queueList: document.getElementById("queue-list"),
  queueCount: document.getElementById("queue-count"),
  queueClear: document.getElementById("queue-clear"),
  list: document.getElementById("segments"),
  dropHint: document.getElementById("drop-hint"),
  modelList: document.getElementById("model-list"),
  modelSelect: document.getElementById("model-select"),
  settingsBtn: document.getElementById("settings-btn"),
  settingsView: document.getElementById("settings-view"),
  settingsClose: document.getElementById("settings-close"),
  cacheLimit: document.getElementById("cache-limit"),
  cacheLimitValue: document.getElementById("cache-limit-value"),
  cacheLimitLabel: document.getElementById("cache-limit-label"),
  cacheStats: document.getElementById("cache-stats"),
  cacheClearBtn: document.getElementById("cache-clear-btn"),
  rowClickPlayChk: document.getElementById("row-click-play"),
  autoFollowChk: document.getElementById("auto-follow"),
  followBtn: document.getElementById("follow-btn"),
  zhPhraseChk: document.getElementById("zh-phrase-conv"),
  gpuName: document.getElementById("gpu-name"),
  gpuAccelChk: document.getElementById("gpu-accel"),
  segCount: document.getElementById("seg-count"),
  toast: document.getElementById("toast"),
  exportMenuView: document.getElementById("export-menu-view"),
  exportMenuSub: document.getElementById("export-menu-sub"),
  exportMenuDir: document.getElementById("export-menu-dir"),
  exportModeMerged: document.getElementById("export-mode-merged"),
  exportModePerfile: document.getElementById("export-mode-perfile"),
  exportMenuOk: document.getElementById("export-menu-ok"),
  exportMenuCancel: document.getElementById("export-menu-cancel"),
};

/* ---------- Toast 提示 ---------- */
let toastTimer = null;
function toast(msg, type = "info") {
  const t = ui.toast;
  if (!t) return;
  t.textContent = msg;
  t.dataset.type = type; // success | error | info
  t.style.display = "block";
  // 重新觸發淡入動畫
  t.classList.remove("show");
  void t.offsetWidth; // reflow
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => { t.style.display = "none"; }, 250);
  }, 3000);
}

/* 生成按鈕的忙碌（spinner）狀態 */
function setGenerating(on) {
  ui.generate.classList.toggle("loading", on);
  const label = ui.generate.querySelector(".gen-label");
  if (label) label.textContent = on ? "轉錄中…" : "生成字幕";
}

/* ---------- 批次佇列 ---------- */
let batchPos = -1;      // 目前轉錄中的 queue 索引（-1 = 閒置）
let batchCancelled = false;

async function addToQueue(paths) {
  let added = 0;
  const fresh = [];
  const seen = new Set(state.queue.map((q) => q.path));
  for (const p of paths) {
    if (typeof p !== "string" || !p) continue;
    if (!isMediaPath(p)) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    const item = { id: ++queueSeq, path: p, name: baseName(p), status: "pending", segments: [], cacheChecked: false, duration: 0 };
    state.queue.push(item);
    fresh.push(item);
    added++;
  }
  if (added) {
    // 預設預覽最後加入的檔案
    const last = state.queue[state.queue.length - 1];
    state.videoPath = last.path;
    loadPreview(last.path);
    updateRightPanel();
    toast(`已加入 ${added} 個檔案`, "success");
    // 選檔當下一次檢查快取：有快取的合併成一句一次問，不必逐一點進去
    checkQueueCache(fresh);
  } else {
    toast("沒有新增檔案（重複或不支援的格式）", "info");
  }
}

/// 檢查一批新加入項目的 autosave 快取；有命中的合併一次詢問，確定則全部載入並標為完成
async function checkQueueCache(items) {
  if (state.busy) {
    // 轉錄中不打擾：等批次結束後由 openQueueItem 逐一處理
    return;
  }
  const hits = [];
  for (const item of items) {
    if (item.status === "done" || item.cacheChecked) continue;
    item.cacheChecked = true;
    try {
      const saved = await invoke("load_state", { videoPath: item.path });
      if (saved && saved.length) {
        hits.push({ item, count: saved.length, segments: saved });
      }
    } catch { /* ignore：無快取或讀取失敗就當作沒有 */ }
  }
  if (!hits.length) return;
  const detail = hits.map(({ item, count }) => `・${item.name}（${count} 段）`).join("\n");
  const ok = await ask(
    `有 ${hits.length} 個檔案找到上次的字幕快取，要全部載入嗎？\n${detail}`,
    { title: "KiriSub", kind: "info" }
  );
  if (!ok) return;
  for (const { item, segments } of hits) {
    item.segments = segments;
    item.status = "done";
    probeQueueDuration(item); // 背景預取長度，供合併匯出接續時間軸
  }
  renderQueue();
  updateEditorHeader(); // 快取載入後刷新標題列：清單層匯出按鈕依 done 數量啟用
  updateGenerateBtn();
  toast(`已載入 ${hits.length} 個檔案的字幕快取`, "success");
}

function statusLabel(s) {
  return s === "running" ? "轉錄中" : s === "done" ? "完成" : s === "error" ? "失敗" : "待處理";
}

/// 佇列順序調整（from → to），並同步修正 editIndex；禁在轉錄中呼叫
function moveQueueItem(from, to) {
  if (state.busy) return;
  if (from < 0 || to < 0 || from >= state.queue.length || to >= state.queue.length) return;
  if (from === to) return;
  const [item] = state.queue.splice(from, 1);
  state.queue.splice(to, 0, item);
  if (state.editIndex === from) state.editIndex = to;
  else if (from < state.editIndex && state.editIndex <= to) state.editIndex--;
  else if (to <= state.editIndex && state.editIndex < from) state.editIndex++;
  renderQueue();
}

let queueDragFrom = -1; // 拖曳排序的來源索引

function renderQueue() {
  ui.queueList.innerHTML = "";
  const nPending = state.queue.filter((q) => q.status === "pending" || q.status === "error").length;
  const nRunning = state.queue.filter((q) => q.status === "running").length;
  const nDone = state.queue.filter((q) => q.status === "done").length;
  const nSegs = state.queue.reduce((n, q) => n + (Array.isArray(q.segments) ? q.segments.length : 0), 0);
  ui.queueCount.textContent = state.queue.length
    ? `（共 ${state.queue.length} 個 · 待處理 ${nPending} · 轉錄中 ${nRunning} · 完成 ${nDone} · 共 ${nSegs} 段）`
    : "";
  if (ui.queueClear) ui.queueClear.disabled = state.busy;
  state.queue.forEach((item, i) => {
    const li = document.createElement("li");
    li.className = "queue-item" + (item.status === "running" ? " running" : "");
    li.dataset.status = item.status;
    // 整列可點擊前往檢視（轉錄中鎖定）
    li.tabIndex = state.busy ? -1 : 0;
    li.setAttribute("role", "button");
    li.setAttribute("aria-disabled", String(state.busy));
    li.setAttribute("aria-label", `第 ${i + 1} 個檔案：${item.name}（${statusLabel(item.status)}），點擊載入檢視`);
    li.title = item.status === "done" ? "點擊載入編輯" : item.path;
    // 排序拖曳改用 Pointer 事件實作，不再使用 HTML5 draggable（避免與 Tauri 檔案拖放衝突）

    const badge = document.createElement("span");
    badge.className = "queue-badge";
    badge.dataset.status = item.status;
    badge.textContent = statusLabel(item.status);

    const idx = document.createElement("span");
    idx.className = "queue-index";
    idx.textContent = String(i + 1);

    const name = document.createElement("span");
    name.className = "queue-name";
    name.textContent = item.name + (item.status === "done" && item.segments.length ? ` · ${item.segments.length} 段` : "");
    name.title = item.path;

    const ops = document.createElement("span");
    ops.className = "queue-ops";
    const up = document.createElement("button");
    up.type = "button"; up.className = "mini-btn queue-op"; up.textContent = "↑"; up.title = "上移";
    up.disabled = i === 0 || state.busy;
    up.setAttribute("aria-label", `第 ${i + 1} 個檔案上移`);
    up.addEventListener("click", (e) => { e.stopPropagation(); moveQueueItem(i, i - 1); });
    const down = document.createElement("button");
    down.type = "button"; down.className = "mini-btn queue-op"; down.textContent = "↓"; down.title = "下移";
    down.disabled = i === state.queue.length - 1 || state.busy;
    down.setAttribute("aria-label", `第 ${i + 1} 個檔案下移`);
    down.addEventListener("click", (e) => { e.stopPropagation(); moveQueueItem(i, i + 1); });
    const rm = document.createElement("button");
    rm.type = "button"; rm.className = "mini-btn queue-op queue-rm"; rm.textContent = "移除"; rm.title = "移除";
    rm.disabled = state.busy;
    rm.setAttribute("aria-label", `移除第 ${i + 1} 個檔案`);
    rm.addEventListener("click", (e) => {
      e.stopPropagation();
      if (state.busy) return;
      state.queue.splice(i, 1);
      if (state.editIndex === i) {
        state.editIndex = -1;
        state.segments = [];
        state.videoPath = state.queue.length ? state.queue[state.queue.length - 1].path : null;
        if (state.videoPath) loadPreview(state.videoPath);
        renderSegments();
      } else if (state.editIndex > i) {
        state.editIndex--;
      }
      updateRightPanel();
    });
    ops.append(up, down, rm);
    li.append(badge, idx, name, ops);

    // 整列點擊 → 載入檢視；按鈕點擊已 stopPropagation 不會連動
    li.addEventListener("click", () => openQueueItem(i));
    li.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && !state.busy) {
        e.preventDefault();
        openQueueItem(i);
      }
    });
    /* 拖曳調整順序（Pointer 事件實作）：
     * Tauri v2 WebView 啟用原生 drag-drop 攔截後，HTML5 DnD 在放開時會被
     * 視窗級的檔案拖放吃掉（drop 事件到不了 <li>），故改用 pointer 拖曳：
     * 按住整列（操作按鈕除外）移動超過閾值即進入排序拖曳。 */
    li.addEventListener("pointerdown", (e) => {
      if (state.busy || e.button !== 0) return;
      if (e.target.closest(".queue-ops")) return; // 操作按鈕不觸發拖曳
      e.preventDefault();
      const startY = e.clientY;
      const h = li.offsetHeight + 6; // 列高 + gap
      let dragging = false;
      li.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const dy = ev.clientY - startY;
        if (!dragging && Math.abs(dy) < 6) return;
        if (!dragging) {
          dragging = true;
          queueDragFrom = i;
          li.classList.add("dragging");
        }
        li.style.transform = `translateY(${dy}px)`;
        li.style.zIndex = "5";
        // 依位移量決定插入位置並即時重排（排除最後一個 ghost 佔位）
        const kids = [...ui.queueList.querySelectorAll(".queue-item:not(.dragging)")];
        let target = Math.round(i + dy / h);
        target = Math.max(0, Math.min(state.queue.length - 1, target));
        kids.forEach((el) => el.classList.remove("drag-over"));
        const over = kids[target > i ? target - 1 : target];
        if (over && over !== li) over.classList.add("drag-over");
      };
      const up = (ev) => {
        li.removeEventListener("pointermove", move);
        li.removeEventListener("pointerup", up);
        li.removeEventListener("pointercancel", up);
        li.style.transform = "";
        li.style.zIndex = "";
        ui.queueList.querySelectorAll(".drag-over, .dragging").forEach((el) => el.classList.remove("drag-over", "dragging"));
        if (!dragging) {
          queueDragFrom = -1;
          return; // 視為一般點擊（由 click 事件處理）
        }
        const dy = ev.clientY - startY;
        let target = Math.round(i + dy / h);
        target = Math.max(0, Math.min(state.queue.length - 1, target));
        queueDragFrom = -1;
        moveQueueItem(i, target);
      };
      li.addEventListener("pointermove", move);
      li.addEventListener("pointerup", up);
      li.addEventListener("pointercancel", up);
    });
    ui.queueList.appendChild(li);
  });
}

/// 右側三視圖切換：空狀態 / 佇列清單 / 段落編輯器
function updateRightPanel() {
  const hasQueue = state.queue.length > 0;
  const editing = state.editIndex >= 0 && state.editIndex < state.queue.length;
  const showQueue = hasQueue && !editing;
  ui.empty.style.display = !hasQueue ? "block" : "none";
  // 清單層是 flex 欄佈局（標題／清單／提示）：必須用 flex 顯示，
  // 用 block 會失去欄佈局，.queue-list 拿不到收縮高度、捲軸出不來。
  ui.queueView.style.display = showQueue ? "flex" : "none";
  ui.list.style.display = editing ? "block" : "none";
  // 全段偏移列只屬於編輯器：切到清單層時強制隱藏（renderSegments 只在編輯器內控制它）
  if (!editing) ui.offsetBar.style.display = "none";
  if (hasQueue && !editing) renderQueue();
  updateEditorHeader();
  updateGenerateBtn();
}

/// 標題列依「有無選檔」切換；匯出按鈕在編輯器與清單層都顯示（空狀態隱藏）
function updateEditorHeader() {
  const hasQueue = state.queue.length > 0;
  const editing = isEditingQueueItem();
  ui.editorTitle.textContent = !hasQueue ? "選擇檔案" : editing ? "字幕段落" : "字幕清單";
  ui.backBtn.style.display = editing ? "" : "none";
  ui.followBtn.style.display = editing ? "" : "none";
  // #seg-count（共 N 段）只屬於編輯器：清單層／空狀態隱藏，避免與 #queue-count 重複顯示
  ui.segCount.style.display = editing ? "" : "none";
  // 清單層匯出：有 done 項目且非轉錄中才可按；編輯器內維持原邏輯（有段落才可按）
  ui.exportBtn.style.display = hasQueue ? "" : "none";
  if (hasQueue && !editing) {
    const nDone = state.queue.filter((q) => q.status === "done" && q.segments.length).length;
    ui.exportBtn.disabled = state.busy || nDone === 0;
  }
}

/// 目前是否正在編輯某個佇列項目
function isEditingQueueItem() {
  return state.editIndex >= 0 && state.editIndex < state.queue.length;
}

function updateGenerateBtn() {
  const pending = state.queue.some((q) => q.status === "pending" || q.status === "error");
  ui.generate.disabled = state.busy || !pending;
}

/// 載入佇列項目進編輯器（done 顯示字幕；pending 僅預覽媒體）
async function openQueueItem(i) {
  const item = state.queue[i];
  if (!item || state.busy) return;
  state.videoPath = item.path;
  loadPreview(item.path);
  // 兜底：快取已在選檔當下由 checkQueueCache 一次問完；這裡只處理當時被跳過的（轉錄中加入、或上次拒絕）
  if (item.status !== "done" && !item.segments.length && !item.cacheChecked) {
    item.cacheChecked = true;
    try {
      const saved = await invoke("load_state", { videoPath: item.path });
      if (saved && saved.length) {
        const ok = await ask(`此影片有上次編輯的字幕（${saved.length} 段），要載入嗎？`, { title: "KiriSub", kind: "info" });
        if (ok) {
          item.segments = saved;
          item.status = "done";
          renderQueue(); // 立即刷新徽章與標題計數，不必等切回清單
        }
      }
    } catch { /* ignore */ }
  }
  state.editIndex = i;
  state.segments = item.status === "done" ? item.segments : [];
  undoStack.length = 0;
  redoStack.length = 0;
  expandedSeg = -1;
  editingSeg = -1;
  selectedSeg = -1;
  activeSeg = -1;
  segFocusMode = false;
  renderSegments();
  updateRightPanel();
  if (item.status !== "done") {
    toast("此檔案尚未生成字幕，按「生成字幕」開始批次轉錄", "info");
  }
}

if (ui.backBtn) {
  ui.backBtn.addEventListener("click", () => {
    if (state.busy) return;
    state.editIndex = -1;
    renderSegments();
    updateRightPanel();
  });
}
if (ui.queueClear) {
  ui.queueClear.addEventListener("click", () => {
    if (state.busy || !state.queue.length) return;
    state.queue = [];
    state.editIndex = -1;
    state.segments = [];
    state.videoPath = null;
    renderSegments();
    updateRightPanel();
  });
}

/* ---------- 選檔（多選檔案 / 資料夾） ---------- */
const AUDIO_EXT = ["mp3", "wav", "flac", "m4a", "ogg", "aac", "wma", "opus"];
const VIDEO_EXT = ["mp4", "mov", "mkv", "avi", "flv", "webm", "ts", "m4v"];
const MEDIA_EXT = [...VIDEO_EXT, ...AUDIO_EXT];
const PICK_FILTERS = [
  { name: "影片／音訊", extensions: MEDIA_EXT },
  { name: "所有檔案", extensions: ["*"] },
];

function extOf(path) {
  return String(path).split(".").pop().toLowerCase();
}
function baseName(path) {
  return String(path).split(/[\\/]/).pop();
}
function isAudio(path) {
  return AUDIO_EXT.includes(extOf(path));
}
function isMediaPath(path) {
  return MEDIA_EXT.includes(extOf(path));
}

async function pickFiles() {
  let res;
  try {
    res = await open({ multiple: true, filters: PICK_FILTERS });
  } catch (err) {
    // 使用者取消選檔時 Tauri 會回傳 null（不丟錯）；這裡只處理真正的對話框錯誤
    ui.status.textContent = "開啟選檔視窗失敗：" + String(err);
    toast("開啟選檔視窗失敗：" + String(err), "error");
    return;
  }
  const list = Array.isArray(res) ? res : typeof res === "string" ? [res] : [];
  if (list.length) addToQueue(list);
}
async function pickFolder() {
  let dir;
  try {
    dir = await open({ directory: true, multiple: false });
  } catch (err) {
    ui.status.textContent = "開啟選取資料夾視窗失敗：" + String(err);
    toast("開啟選取資料夾視窗失敗：" + String(err), "error");
    return;
  }
  if (typeof dir !== "string") return;
  try {
    const files = await invoke("scan_media_folder", {
      path: dir,
      recursive: true,
      extensions: MEDIA_EXT,
    });
    if (!files.length) {
      toast("此資料夾找不到支援的影片／音訊檔", "info");
      return;
    }
    addToQueue(files);
  } catch (err) {
    ui.status.textContent = "掃描資料夾失敗：" + err;
    toast("掃描資料夾失敗：" + String(err), "error");
  }
}
ui.pick.addEventListener("click", pickFiles);
ui.pickFolder.addEventListener("click", pickFolder);
ui.emptyPick.addEventListener("click", pickFiles);

/* ---------- 左側預覽：只切換播放來源與檔名，不動佇列/編輯狀態 ---------- */
function loadPreview(path) {
  state.mediaType = isAudio(path) ? "audio" : "video";
  ui.fileName.textContent = baseName(path);
  ui.fileName.title = path;
  ui.dropHint.style.display = "none";
  ui.previewHint.style.display = "none";
  const src = convertFileSrc(path);
  if (state.mediaType === "audio") {
    ui.video.style.display = "none";
    ui.audio.style.display = "block";
    ui.audio.src = src;
    ui.audio.load();
  } else {
    ui.audio.removeAttribute("src");
    ui.audio.style.display = "none";
    ui.video.style.display = "block";
    ui.video.src = src;
    ui.video.load();
    // HEVC/H.265：若 WebView 無法解碼則提示（仍可轉錄）
    ui.video.onerror = () => {
      ui.previewHint.style.display = "block";
      ui.previewHint.textContent = "此影片或系統未支援在窗內預覽（例如 HEVC/H.265），但仍可正常生成字幕。";
    };
    ui.video.onloadeddata = () => {
      ui.previewHint.style.display = "none";
    };
  }
}

document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => e.preventDefault());

/* ---------- 拖放選檔（Tauri 原生 drag-drop） ----------
 * Tauri v2 WebView 預設啟用原生 drag-drop 攔截，HTML5 drop 事件拿不到檔案路徑，
 * 必須改用 onDragDropEvent API 取得絕對路徑。
 */
(async () => {
  try {
    await getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "enter" || p.type === "over") {
        ui.dropHint.classList.add("active");
        ui.empty.classList.add("drag-active");
      } else if (p.type === "leave") {
        ui.dropHint.classList.remove("active");
        ui.empty.classList.remove("drag-active");
      } else if (p.type === "drop") {
        ui.dropHint.classList.remove("active");
        ui.empty.classList.remove("drag-active");
        if (state.busy) return;
        const paths = Array.isArray(p.paths) ? p.paths : [];
        const media = paths.filter((path) => isMediaPath(path));
        if (media.length) {
          addToQueue(media);
        } else if (paths.length) {
          toast("不支援的檔案格式（支援常見影片／音訊格式）", "error");
        }
      }
    });
  } catch (err) {
    console.error("拖放事件監聽失敗：", err);
  }
})();

/* ---------- 生成字幕（批次：依佇列順序逐檔轉錄） ---------- */
/* 左側批次鎖定：轉錄期間禁用選檔/語系/模型，避免中途改動造成狀態錯亂 */
function setBatchLock(locked) {
  for (const el of [ui.pick, ui.pickFolder, ui.lang, ui.modelSelect]) {
    if (el) el.disabled = locked;
  }
}

async function startBatch() {
  if (state.busy) return;
  const targets = state.queue
    .map((q, i) => ({ q, i }))
    .filter(({ q }) => q.status === "pending" || q.status === "error");
  if (!targets.length) {
    toast("沒有待處理的檔案", "info");
    return;
  }
  state.busy = true;
  batchCancelled = false;
  ui.generate.disabled = true;
  setGenerating(true);
  setBatchLock(true);
  renderQueue(); // 右側操作按鈕同步進入禁用（灰色）
  ui.cancelBtn.style.display = "inline-block";
  ui.cancelBtn.disabled = false;
  ui.progressWrap.style.display = "block";
  ui.progressBar.style.width = "0%";
  const lang = ui.lang.value === "auto" ? null : ui.lang.value;

  for (const { q, i } of targets) {
    if (batchCancelled) break;
    batchPos = i;
    q.status = "running";
    state.videoPath = q.path;
    loadPreview(q.path);
    renderQueue();
    ui.status.dataset.tone = "busy";
    ui.status.textContent = `轉錄中（${targets.indexOf(targets.find((t) => t.i === i)) + 1}/${targets.length}）：${q.name}`;
    ui.progressBar.style.width = "0%";
    try {
      // 先註冊 resolver 再 invoke：若事件在 invoke resolve 前送達，
      // settleBatchItem 才有 promise 可 resolve，否則批次會永久卡住。
      const itemDone = waitBatchItem();
      await invoke("transcribe", { request: { videoPath: q.path, language: lang } });
      const result = await itemDone;
      if (result === "cancelled") break;
    } catch (err) {
      batchResolve = null; // 啟動失敗不會有事件，清掉殘留的 resolver
      q.status = "error";
      ui.status.textContent = "啟動失敗：" + String(err);
      ui.status.dataset.tone = "error";
    }
    renderQueue();
  }
  batchPos = -1;
  transcribeEnded();
  updateGenerateBtn();
  renderQueue();
  updateEditorHeader(); // 批次結束刷新標題列：清單層匯出按鈕依完成數重新啟用
  if (batchCancelled) {
    ui.status.textContent = "已取消批次轉錄";
    ui.status.dataset.tone = "info";
  } else {
    const done = state.queue.filter((q) => q.status === "done").length;
    ui.status.textContent = `批次完成：${done}/${state.queue.length} 個檔案`;
    ui.status.dataset.tone = done ? "success" : "";
    toast(`批次轉錄完成（${done}/${state.queue.length}）`, done ? "success" : "info");
  }
  batchCancelled = false;
}

// 等待目前轉錄項目的事件結果（done → "done"，error → "error"，cancelled → "cancelled"）
let batchResolve = null;
function waitBatchItem() {
  return new Promise((resolve) => { batchResolve = resolve; });
}
function settleBatchItem(outcome) {
  if (batchResolve) {
    const r = batchResolve;
    batchResolve = null;
    r(outcome);
  }
}

ui.generate.addEventListener("click", startBatch);

ui.cancelBtn.addEventListener("click", () => {
  ui.cancelBtn.disabled = true;
  ui.status.textContent = "正在中斷…";
  invoke("cancel_transcribe").catch((err) => {
    ui.status.textContent = "中斷請求失敗：" + String(err);
    ui.cancelBtn.disabled = false;
  });
});

// 統一結束轉錄的 UI 清理
function transcribeEnded() {
  state.busy = false;
  ui.generate.disabled = false;
  setGenerating(false);
  setBatchLock(false);
  renderQueue(); // 右側操作按鈕同步解除禁用
  ui.lang.disabled = false;
  ui.modelSelect.disabled = false;
  ui.progressWrap.style.display = "none";
  ui.cancelBtn.style.display = "none";
  ui.cancelBtn.disabled = false;
}

/* ---------- 後端事件 ---------- */
listen("transcribe-status", (e) => {
  ui.status.dataset.tone = "busy";
  ui.status.textContent =
    e.payload === "extracting" ? "抽取音訊…" : "whisper 轉錄中…";
});
listen("transcribe-progress", (e) => {
  const p = Math.max(0, Math.min(100, e.payload.percent));
  ui.progressBar.style.width = p + "%";
  ui.status.textContent = "轉錄中… " + p + "%";
});
listen("transcribe-done", (e) => {
  // 批次模式：結果存進目前轉錄中的佇列項目並逐檔 autosave
  if (batchPos >= 0 && batchPos < state.queue.length) {
    const item = state.queue[batchPos];
    item.segments = e.payload.segments;
    item.status = "done";
    probeQueueDuration(item); // 背景預取長度，供合併匯出接續時間軸
    invoke("save_state", { videoPath: item.path, segments: item.segments }).catch(() => {});
    // 若正在編輯此項目，同步顯示
    if (state.editIndex === batchPos) {
      state.segments = item.segments;
      undoStack.length = 0;
      redoStack.length = 0;
      renderSegments();
      updateRightPanel();
    } else {
      renderQueue();
    }
    ui.status.textContent = `完成：${item.name}（共 ${item.segments.length} 段）`;
    ui.status.dataset.tone = "success";
    settleBatchItem("done");
    return;
  }
  state.segments = e.payload.segments;
  transcribeEnded();
  undoStack.length = 0;
  renderSegments();
  saveAuto();
  ui.status.textContent = "完成，共 " + state.segments.length + " 段";
  ui.status.dataset.tone = "success";
  toast("轉錄完成，共 " + state.segments.length + " 段字幕", "success");
});
listen("transcribe-error", (e) => {
  if (batchPos >= 0 && batchPos < state.queue.length) {
    state.queue[batchPos].status = "error";
    ui.status.textContent = "錯誤：" + e.payload;
    ui.status.dataset.tone = "error";
    toast("轉錄失敗：" + e.payload, "error");
    renderQueue();
    settleBatchItem("error");
    return;
  }
  transcribeEnded();
  ui.status.textContent = "錯誤：" + e.payload;
  ui.status.dataset.tone = "error";
  toast("轉錄失敗：" + e.payload, "error");
});
listen("transcribe-cancelled", () => {
  if (batchPos >= 0 && batchPos < state.queue.length) {
    // 被取消的項目回到待處理（可重試），其餘排隊項目保持 pending
    const item = state.queue[batchPos];
    if (item.status === "running") item.status = "pending";
    batchCancelled = true;
    renderQueue();
    settleBatchItem("cancelled");
    toast("已取消轉錄", "info");
    return;
  }
  transcribeEnded();
  ui.status.textContent = "已取消轉錄";
  ui.status.dataset.tone = "info";
  toast("已取消轉錄", "info");
});

/* ---------- 渲染字幕段落 ---------- */
let expandedSeg = -1; // 目前展開微調的段落 index
let activeSeg = -1;   // 播放中對應的段落 index
let editingSeg = -1;  // 目前就地編輯時間的段落 index（無則 -1）
let playingSeg = -1;  // 播放按鈕呈現「⏸ 暫停」的段落 index
let playBtns = [];    // 每列的播放按鈕元素（renderSegments 時重建）
let selectedSeg = -1; // 鍵盤選中的段落 index（↑/↓/Home/End/Delete 用）
let segFocusMode = false; // Enter 進入「列內焦點循環」模式（Tab 只在展開列內移動）
// Undo / Redo 堆疊（提前宣告：佇列 openQueueItem 在批次完成回填時會用到）
const undoStack = [];
const redoStack = [];

/// 取得列內可聚焦元件：seg 外層列本身也算一格（循環的起訖點），其後為 DOM 順序的按鈕、文字框、輸入框
function rowFocusables(row) {
  const widgets = Array.from(row.querySelectorAll("button, textarea, input"))
    .filter((el) => !el.disabled && el.offsetParent !== null);
  return [row, ...widgets];
}

/* ---------- 字幕列表捲動（只捲容器，不影響其他祖先） ---------- */
// 使用者手動捲動後，暫停自動跟隨的時間窗（毫秒）。期間讓使用者自由瀏覽，
// 直到再次點選字幕段（明確意圖）才恢復跟隨。
const USER_SCROLL_PAUSE_MS = 4000;
let userScrollUntil = 0;      // 暫停自動跟隨的截止時間戳
let suppressScrollWatch = 0;  // 程式捲動期間略過 scroll 事件，避免被誤判為手動捲動

/// 只捲動字幕容器 #segments（不呼叫 scrollIntoView，避免連帶捲動其他可捲動祖先）
function scrollListTo(top) {
  suppressScrollWatch = Date.now() + 150;
  ui.list.scrollTop = Math.max(0, top);
}

/// 將第 i 列捲入可視範圍（nearest 語意：已可見則不捲動）。只捲 #segments。
/// margin：上下各保留的邊距像素。
function scrollRowIntoView(i, margin = 8) {
  const row = ui.list.children[i];
  if (!row) return;
  const list = ui.list;
  const listRect = list.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const relTop = rowRect.top - listRect.top;         // 列頂相對容器可視區上緣
  const relBottom = rowRect.bottom - listRect.top;   // 列底相對容器可視區上緣
  const viewH = list.clientHeight;
  let target;
  if (relTop < margin) {
    target = list.scrollTop + (relTop - margin);              // 列在上方 → 對齊上緣
  } else if (relBottom > viewH - margin) {
    target = list.scrollTop + (relBottom - (viewH - margin)); // 列在下方 → 對齊下緣
  } else {
    return;                                                   // 已完整可見
  }
  scrollListTo(target);
}

/// 標記「使用者正在手動捲動」→ 暫停自動跟隨一小段時間
function markUserScroll() {
  userScrollUntil = Date.now() + USER_SCROLL_PAUSE_MS;
}
// 手動捲動來源：滾輪、觸控、拖曳捲軸（scroll 事件）。程式捲動期間以旗標排除。
ui.list.addEventListener("wheel", markUserScroll, { passive: true });
ui.list.addEventListener("touchstart", markUserScroll, { passive: true });
ui.list.addEventListener("scroll", () => {
  if (Date.now() < suppressScrollWatch) return; // 程式捲動，不視為手動
  markUserScroll();
}, { passive: true });

/// 設定選中列並更新高亮
function setSelected(i) {
  selectedSeg = i;
  const rows = ui.list.children;
  for (let k = 0; k < rows.length; k++) {
    rows[k].classList.toggle("selected", k === selectedSeg);
  }
  // 使用者明確點選/導覽到某段 → 視為恢復跟隨（清除手動捲動的暫停窗）
  userScrollUntil = 0;
  scrollRowIntoView(selectedSeg);
}

function setPlayIcon(i, playing) {
  const btn = playBtns[i];
  if (!btn) return;
  // 移除舊 icon，換成對應的 play/pause icon
  const old = btn.querySelector("svg.icon");
  if (old) old.remove();
  const label = playing ? "暫停" : "播放";
  btn.textContent = label; // 先清掉文字（含舊 icon）
  btn.prepend(icon(playing ? "pause" : "play"));
  btn.setAttribute("aria-label", playing ? "暫停播放" : `播放第 ${i + 1} 段`);
  btn.title = label;
}

/// 點擊字幕段（row 或文字框）→ 跳到該段起始時間；
/// 是否自動播放由設定 state.rowClickPlay 決定（預設不播放）。
function previewSegment(i) {
  const seg = state.segments[i];
  if (!seg) return;
  setSelected(i);
  const m = currentMedia();
  m.currentTime = seg.start;
  if (state.rowClickPlay) {
    if (playingSeg >= 0 && playingSeg !== i) setPlayIcon(playingSeg, false);
    playingSeg = i;
    setPlayIcon(i, true);
    m.play().catch(() => {});
  } else if (!m.paused) {
    m.pause(); // 停在該段起始時間（pause 事件會還原播放按鈕）
  }
}

/* ---------- Undo / Redo（Ctrl+Z 復原、Ctrl+Shift+Z / Ctrl+Y 反復原） ---------- */
//（undoStack / redoStack 已在上方「渲染字幕段落」區提前宣告）
function pushUndo() {
  if (undoStack.length >= 50) undoStack.shift();
  undoStack.push(JSON.stringify(state.segments));
  redoStack.length = 0; // 新動作分支後，舊的 redo 失效
}
function restoreSnapshot(json) {
  state.segments = JSON.parse(json);
  expandedSeg = -1;
  editingSeg = -1;
  segFocusMode = false;
  renderSegments();
  saveAuto();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify(state.segments));
  restoreSnapshot(undoStack.pop());
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(state.segments));
  restoreSnapshot(redoStack.pop());
}

/* ---------- 自動儲存進度 ---------- */
let saveTimer = null;
function saveAuto() {
  if (!state.videoPath) return;
  // 編輯器修改同步回佇列項目（保持 queue 與 state 一致）
  let path = state.videoPath;
  if (state.editIndex >= 0 && state.editIndex < state.queue.length) {
    const item = state.queue[state.editIndex];
    item.segments = state.segments;
    // 批次轉錄期間 state.videoPath 指向「正在轉錄」的檔案，
    // 快取要存回編輯中項目自己的路徑，避免把字幕寫進別檔的快取。
    path = item.path;
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    invoke("save_state", { videoPath: path, segments: state.segments }).catch(() => {});
  }, 500);
}
async function maybeLoadAutosave() {
  try {
    const saved = await invoke("load_state", { videoPath: state.videoPath });
    if (saved && saved.length) {
      const ok = await ask(`此影片有上次編輯的字幕（${saved.length} 段），要載入嗎？`, { title: "KiriSub", kind: "info" });
      if (ok) {
        state.segments = saved;
        renderSegments();
      }
    }
  } catch { /* ignore */ }
}

/// 依 start 穩定排序字幕列（start 相同者維持原相對順序）。
/// movedSeg：剛被改過時間的 segment 物件；排序後把展開/選中/播放等
/// 狀態 index 跟著該段落移動，避免指到錯的列。
function sortSegments(movedSeg) {
  if (state.segments.length < 2) return false;
  const order = state.segments.map((s, idx) => ({ s, idx }));
  order.sort((a, b) => a.s.start - b.s.start || a.idx - b.idx);
  const changed = order.some((o, k) => o.idx !== k);
  if (!changed) return false;
  state.segments = order.map((o) => o.s);
  const newIdx = (oldIdx) => {
    if (oldIdx < 0 || !order[oldIdx]) return -1;
    return state.segments.indexOf(order[oldIdx].s);
  };
  expandedSeg = newIdx(expandedSeg);
  editingSeg = newIdx(editingSeg);
  selectedSeg = newIdx(selectedSeg);
  playingSeg = newIdx(playingSeg);
  activeSeg = newIdx(activeSeg);
  return true;
}

function renderSegments() {
  // 保留目前捲動位置：innerHTML 清空時 scrollTop 會被夾回 0，
  // 若不在重建後還原，列表就會跳回最上面。
  const prevScroll = ui.list.scrollTop;
  ui.list.innerHTML = "";
  ui.offsetBar.style.display = state.segments.length ? "flex" : "none";
  ui.segCount.textContent = state.segments.length ? `（共 ${state.segments.length} 段）` : "";
  // 空狀態 / 清單 / 編輯器的顯示由 updateRightPanel 統一管理，這裡只管匯出按鈕啟用。
  ui.exportBtn.disabled = !state.segments.length;
  if (!state.segments.length) {
    return;
  }

  playBtns = [];
  state.segments.forEach((seg, i) => {
    const row = document.createElement("div");
    row.className = "seg" + (expandedSeg === i ? " expanded" : "") + (activeSeg === i ? " active" : "") + (selectedSeg === i ? " selected" : "");
    // seg 外層可被 Tab 選中；Enter 展開／收合（語意與無障礙）
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-expanded", String(expandedSeg === i));
    row.setAttribute("aria-label", `字幕第 ${i + 1} 段`);

    const idx = document.createElement("span");
    idx.className = "seg-index";
    idx.textContent = String(i + 1);

    // 時間欄位：顯示「起點 → 終點」；點擊進入就地編輯（變成兩顆輸入框）
    const editingThis = editingSeg === i;
    const time = document.createElement(editingThis ? "div" : "button");
    time.className = "seg-time time-btn";
    if (editingThis) {
      time.title = "就地編輯起訖時間（HH:MM:SS.mmm）";
      const startIn = document.createElement("input");
      startIn.value = fmtEdge(seg.start);
      startIn.title = "開始時間";
      const endIn = document.createElement("input");
      endIn.value = fmtEdge(seg.end);
      endIn.title = "結束時間";
      time.append(startIn, endIn);
      // Enter 儲存、Esc 取消、失焦儲存
      const commit = () => commitTimeEdit(i);
      const cancel = () => { editingSeg = -1; renderSegments(); };
      startIn.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        else if (e.key === "Escape") { e.preventDefault(); cancel(); }
        else e.stopPropagation();
      });
      endIn.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        else if (e.key === "Escape") { e.preventDefault(); cancel(); }
        else e.stopPropagation();
      });
      for (const inp of [startIn, endIn]) {
        inp.addEventListener("blur", () => {
          // 移到同列另一個輸入框（Tab）時不立即 commit，等真正離開整個欄位
          setTimeout(() => {
            if (!time.contains(document.activeElement)) commit();
          }, 0);
        });
        inp.addEventListener("click", (e) => e.stopPropagation());
        inp.addEventListener("input", () => inp.classList.remove("invalid"));
      }
    } else {
      time.title = "點擊修改此段起訖時間";
      time.textContent = fmtEdge(seg.start) + " → " + fmtEdge(seg.end);
    }

    const actions = document.createElement("div");
    actions.className = "seg-actions";
    const del = mkBtn("刪除", (e) => {
      e.stopPropagation();
      pushUndo();
      state.segments.splice(i, 1);
      expandedSeg = -1;
      editingSeg = -1;
      segFocusMode = false;
      renderSegments();
      saveAuto();
    }, "delete");
    del.classList.add("danger");
    actions.appendChild(del); // 刪除在上
    // 播放下：播放中變「暫停」；點其他列播放時舊列還原為「播放」
    const playBtn = mkBtn(playingSeg === i ? "暫停" : "播放", (e) => {
      e.stopPropagation();
      const m = currentMedia();
      if (playingSeg === i && !m.paused) {
        m.pause(); // pause 事件會還原按鈕
      } else {
        if (playingSeg >= 0 && playingSeg !== i) setPlayIcon(playingSeg, false);
        playingSeg = i;
        m.currentTime = seg.start;
        setPlayIcon(i, true);
        m.play().catch(() => {});
      }
    }, playingSeg === i ? "pause" : "play");
    playBtns[i] = playBtn;
    actions.appendChild(playBtn);
    // 插入：在該列下方新增一列空字幕（時間銜接該列結束點）
    const ins = mkBtn("插入", (e) => {
      e.stopPropagation();
      pushUndo();
      const start = snap(seg.end);
      const newSeg = { start, end: snap(start + 2), text: "" };
      state.segments.splice(i + 1, 0, newSeg);
      sortSegments(newSeg);
      const ni = state.segments.indexOf(newSeg);
      expandedSeg = ni;
      selectedSeg = ni;
      editingSeg = -1;
      renderSegments();
      const row = ui.list.children[ni];
      const ta = row?.querySelector(".seg-text");
      if (ta) { ta.focus(); ta.setSelectionRange(0, 0); }
      saveAuto();
    }, "insert");
    actions.appendChild(ins);

    const text = document.createElement("textarea");
    text.className = "seg-text";
    text.value = seg.text;
    text.rows = 2;
    text.addEventListener("input", () => {
      seg.text = text.value;
      fitText(text);
      saveAuto();
    });
    // 點文字框＝選中該 row：跳到該段起始時間（是否播放依設定）
    text.addEventListener("click", (e) => {
      e.stopPropagation();
      previewSegment(i);
    });

    row.append(idx, time, text, actions);

    // 微調列（僅展開的段落）
    if (expandedSeg === i) {
      const adj = document.createElement("div");
      adj.className = "seg-adjust";
      // 組 1：套用目前播放位置（入點/出點）
      const g1 = document.createElement("div");
      g1.className = "adjust-group";
      const l1 = document.createElement("span");
      l1.className = "adjust-label";
      l1.textContent = "套用目前位置";
      g1.appendChild(l1);
      g1.appendChild(mkBtn("起點", (e) => { e.stopPropagation(); setStart(i); }));
      g1.appendChild(mkBtn("終點", (e) => { e.stopPropagation(); setEnd(i); }));
      adj.appendChild(g1);
      // 組 2：小幅平移
      const g2 = document.createElement("div");
      g2.className = "adjust-group";
      const l2 = document.createElement("span");
      l2.className = "adjust-label";
      l2.textContent = "平移";
      g2.appendChild(l2);
      for (const d of [-0.5, -0.1, -0.05, -0.01, 0.01, 0.05, 0.1, 0.5]) {
        const b = mkBtn((d > 0 ? "+" : "") + d + "s", (e) => {
          e.stopPropagation();
          pushUndo();
          seg.start = snap(Math.max(0, seg.start + d));
          seg.end = snap(Math.max(seg.start + 0.1, seg.end + d));
          sortSegments(seg);
          renderSegments();
          saveAuto();
        });
        g2.appendChild(b);
      }
      adj.appendChild(g2);
      row.appendChild(adj);
    }

    // 點擊整列（但排除時間欄位、文字框、按鈕）→ 預覽＋展開/收合微調列
    row.addEventListener("click", (e) => {
      if (e.target === row) {
        previewSegment(i);
        expandedSeg = expandedSeg === i ? -1 : i;
        editingSeg = editingSeg === i ? -1 : editingSeg;
        segFocusMode = false;
        renderSegments();
        scrollRowIntoView(i); // 保持被點的列在視野中（展開後列會變高）
      }
    });

    // 列內焦點循環模式：焦點真正離開展開列時自動結束（滑鼠點外面也能正常運作）
    row.addEventListener("focusout", () => {
      if (!segFocusMode) return;
      setTimeout(() => {
        const expandedRow = ui.list.children[expandedSeg];
        if (!expandedRow || !expandedRow.contains(document.activeElement)) {
          segFocusMode = false;
        }
      }, 0);
    });

    // 點擊時間欄位 → 進入就地編輯（並展開微調列）；同時啟用列內焦點循環，Tab 行為一致
    if (!editingThis) {
      time.addEventListener("click", (e) => {
        e.stopPropagation();
        editingSeg = i;
        expandedSeg = i;
        segFocusMode = true;
        renderSegments();
        scrollRowIntoView(i); // 保持進入編輯的列在視野中
      });
    }

    ui.list.appendChild(row);
    fitText(text);
    // 進入編輯時自動 focus 開始輸入框並把游標移到尾端
    if (editingThis) {
      const st = time.querySelector("input");
      st.focus();
      st.setSelectionRange(st.value.length, st.value.length);
    }
  });
  // 重繪造成的捲動位置變動不視為「使用者手動捲動」，避免誤暫停自動跟隨；
  // 並還原剛才記下的捲動位置，避免跳回最上面。
  suppressScrollWatch = Date.now() + 200;
  ui.list.scrollTop = prevScroll;
}

function mkBtn(label, fn, ic = null) {
  const b = document.createElement("button");
  b.className = "mini-btn";
  b.textContent = label;
  if (ic) b.prepend(icon(ic));
  b.addEventListener("click", fn);
  return b;
}

function setStart(i) {
  const seg = state.segments[i];
  const m = currentMedia();
  if (m && Number.isFinite(m.currentTime)) {
    pushUndo();
    seg.start = snap(Math.min(m.currentTime, seg.end - 0.1));
    sortSegments(seg);
    renderSegments();
    saveAuto();
  }
}
function setEnd(i) {
  const seg = state.segments[i];
  const m = currentMedia();
  if (m && Number.isFinite(m.currentTime)) {
    pushUndo();
    seg.end = snap(Math.max(m.currentTime, seg.start + 0.1));
    sortSegments(seg);
    renderSegments();
    saveAuto();
  }
}

// 更新第 i 列時間欄位的顯示文字（非編輯模式下）
function updateTimeDisplay(i, seg) {
  const row = ui.list.children[i];
  if (!row) return;
  const t = row.querySelector(".seg-time");
  if (t && !t.querySelector("input")) {
    t.textContent = fmtEdge(seg.start) + " → " + fmtEdge(seg.end);
  }
}

// 解析 "H:MM:SS.mmm" / "MM:SS.mmm" / "SS.mmm" / "SS" 等格式，回傳秒數；無效則 null
function parseTime(str) {
  if (typeof str !== "string") return null;
  const t = str.trim();
  if (!t) return null;
  const fracOf = (g) => (g ? parseInt(g.padEnd(3, "0"), 10) / 1000 : 0);
  const colons = (t.match(/:/g) || []).length;
  // 兩個冒號：H:M:S(.mmm) — 時/分可多位，秒 1–2 位（0–59）
  if (colons === 2) {
    const m = t.match(/^(\d{1,3}):(\d{1,3}):([0-5]?\d)(?:\.(\d{1,3}))?$/);
    if (m) return snap(+m[1] * 3600 + +m[2] * 60 + +m[3] + fracOf(m[4]));
    return null;
  }
  // 一個冒號：M:SS(.mmm) — 分可多位，秒固定 2 位
  if (colons === 1) {
    const m = t.match(/^(\d{1,3}):([0-5]\d)(?:\.(\d{1,3}))?$/);
    if (m) return snap(+m[1] * 60 + +m[2] + fracOf(m[3]));
    return null;
  }
  // 無冒號：純秒數(.mmm)
  const p = t.match(/^(\d{1,6})(?:\.(\d{1,3}))?$/);
  if (p) return snap(+p[1] + fracOf(p[2]));
  return null;
}

// 就地編輯時間的儲存：解析兩欄，有效才寫入
function commitTimeEdit(i) {
  // 防重入：Enter 觸發 renderSegments 後，blur 的 setTimeout 可能再次呼叫
  if (editingSeg !== i) return;
  const row = ui.list.children[i];
  const t = row?.querySelector(".seg-time");
  if (!row || !t) { editingSeg = -1; renderSegments(); return; }
  const [startIn, endIn] = t.querySelectorAll("input");
  const seg = state.segments[i];
  const s = startIn ? parseTime(startIn.value) : null;
  const e = endIn ? parseTime(endIn.value) : null;
  let ok = true;
  if (s === null) { startIn.classList.add("invalid"); ok = false; }
  if (e === null) { endIn.classList.add("invalid"); ok = false; }
  if (!ok) {
    toast("時間格式不正確，請輸入 HH:MM:SS.mmm（例如 00:01:23,456）", "error");
    return; // 留在編輯模式，紅框提示
  }
  if (!Number.isFinite(s) || s < 0) { startIn.classList.add("invalid"); ok = false; }
  if (!Number.isFinite(e) || e <= s) { endIn.classList.add("invalid"); ok = false; }
  if (!ok) {
    toast(s < 0 ? "開始時間不能是負數" : "結束時間必須晚於開始時間", "error");
    return;
  }
  pushUndo();
  seg.start = Math.round(s * 1000) / 1000;
  seg.end = Math.round(e * 1000) / 1000;
  // 列內焦點循環模式：提交後重繪會重建 DOM，記住焦點位置以便還原，
  // 讓「Tab 從時間欄離開」時焦點能無縫落到下一個元件。
  const wasFocus = segFocusMode && row.contains(document.activeElement);
  const oldFocusables = wasFocus ? rowFocusables(row) : null;
  const focusIdx = wasFocus ? oldFocusables.indexOf(document.activeElement) : -1;
  editingSeg = -1;
  const reordered = sortSegments(seg);
  renderSegments();
  saveAuto();
  // 即時回饋：重排與重疊提醒
  if (reordered) {
    ui.status.textContent = "字幕列已依開始時間重新排序";
    ui.status.dataset.tone = "info";
  }
  const ni = state.segments.indexOf(seg);
  const prev = state.segments[ni - 1];
  const next = state.segments[ni + 1];
  const overlap =
    (prev && seg.start < prev.end && prev.start < seg.end) ||
    (next && seg.end > next.start && next.end > seg.start);
  if (overlap) {
    const other = prev && seg.start < prev.end ? ni : ni + 1;
    toast(`第 ${Math.min(ni, other) + 1}、${Math.max(ni, other) + 1} 段時間重疊，匯出 SRT 時會自動接合`, "info");
  }
  if (wasFocus && focusIdx >= 0) {
    const newRow = ui.list.children[expandedSeg] || ui.list.children[selectedSeg];
    const f = newRow && rowFocusables(newRow);
    if (f && f.length) {
      // 舊序列的時間欄是 2 個輸入框（startIn/endIn），提交後變回 1 顆按鈕，
      // 後面的元件索引整體往前移 1 位。
      const newIdx = focusIdx === 0 ? 0 : Math.min(focusIdx - 1, f.length - 1);
      f[newIdx].focus();
    }
  }
}

/* 文字框依內容自動長高 */
function fitText(t) {
  t.style.height = "auto";
  t.style.height = t.scrollHeight + "px";
}
function currentMedia() {
  return state.mediaType === "audio" ? ui.audio : ui.video;
}
function seekTo(t) {
  const m = currentMedia();
  m.currentTime = t;
  m.play();
}

function snap(t) {
  return Math.round(t * 1000) / 1000; // 毫秒精度
}
function fmtEdge(t) {
  t = Math.max(0, t);
  const ms = Math.floor(t * 1000) % 1000;
  const s = Math.floor(t) % 60;
  const m = Math.floor(t / 60) % 60;
  const h = Math.floor(t / 3600);
  const ss = String(s).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  const mmm = String(ms).padStart(3, "0");
  if (h > 0) {
    return h + ":" + mm + ":" + ss + "." + mmm;
  }
  return m + ":" + ss + "." + mmm;
}

/* ---------- 佇列匯出 ---------- */

/// 以離屏媒體讀取影片／音訊長度（秒）；失敗回傳 0（呼叫端改用 fallback）
function probeQueueDuration(item) {
  if (item.duration > 0) return Promise.resolve(item.duration);
  return new Promise((resolve) => {
    let done = false;
    const finish = (d) => {
      if (done) return;
      done = true;
      item.duration = d > 0 && Number.isFinite(d) ? d : 0;
      resolve(item.duration);
    };
    try {
      const el = document.createElement("video");
      el.preload = "metadata";
      el.muted = true;
      const timer = setTimeout(() => finish(0), 8000);
      el.onloadedmetadata = () => { clearTimeout(timer); finish(el.duration); };
      el.onerror = () => { clearTimeout(timer); finish(0); };
      el.src = convertFileSrc(item.path);
    } catch { finish(0); }
  });
}

/// 標題列匯出按鈕分流：編輯器內單檔匯出；清單層走佇列匯出選單
function onExportClick() {
  if (isEditingQueueItem()) {
    doExport();
  } else {
    openExportMenu();
  }
}

/// 開啟佇列匯出選單（記憶上次的模式；per-file 顯示上次的統一資料夾）
function openExportMenu() {
  const targets = state.queue.filter((q) => q.status === "done" && q.segments.length);
  if (!targets.length || state.busy) return;
  const nSegs = targets.reduce((n, q) => n + q.segments.length, 0);
  ui.exportMenuSub.textContent = `${targets.length} 個檔案、共 ${nSegs} 段已完成，選擇匯出方式：`;
  if (state.exportMode === "merged") ui.exportModeMerged.checked = true;
  else ui.exportModePerfile.checked = true;
  ui.exportMenuDir.textContent = state.exportDir ? `統一匯出資料夾：${state.exportDir}` : "各別匯出時會請你選擇統一匯出資料夾";
  ui.exportMenuView.style.display = "flex";
  (state.exportMode === "merged" ? ui.exportModeMerged : ui.exportModePerfile).focus();
}

function closeExportMenu() {
  ui.exportMenuView.style.display = "none";
}

/// 執行佇列匯出（依選單選擇的模式）；全程 try/catch 回報狀態列＋toast
async function runQueueExport() {
  const mode = ui.exportModeMerged.checked ? "merged" : "per-file";
  state.exportMode = mode;
  invoke("set_export_settings", { mode, dir: null }).catch(() => {});
  closeExportMenu();
  if (mode === "merged") {
    await exportMerged();
  } else {
    await exportPerFile();
  }
}

/// 合併成一個 SRT：依佇列當下順序串接，每部整體平移前面影片的 duration 總和；
/// 讀不到長度時 fallback 為「接續上一部最後一段結束＋1 秒」；不加分隔字幕
async function exportMerged() {
  const targets = state.queue.filter((q) => q.status === "done" && q.segments.length);
  if (!targets.length) return;
  try {
    await Promise.all(targets.map((t) => probeQueueDuration(t)));
    const merged = [];
    let offset = 0;
    for (const t of targets) {
      for (const s of t.segments) {
        merged.push({ index: 0, start: s.start + offset, end: s.end + offset, text: s.text });
      }
      const lastEnd = t.segments.length ? t.segments[t.segments.length - 1].end + offset : offset;
      // duration 有效就用它推進；否則 fallback 接續最後一段結束＋1 秒
      offset = t.duration > 0 ? offset + t.duration : lastEnd + 1;
    }
    // 依開始時間排序後重新編號（build_srt 依陣列順序編號）
    merged.sort((a, b) => a.start - b.start);
    const srt = await invoke("build_srt", { segments: merged });
    const dest = await save({
      defaultPath: "合併字幕.srt",
      filters: [{ name: "SRT 字幕", extensions: ["srt"] }],
    });
    if (typeof dest !== "string") return;
    await invoke("write_srt", { path: dest, content: srt });
    ui.status.textContent = `已匯出合併字幕（${targets.length} 個檔案、共 ${merged.length} 段）：` + dest;
    ui.status.dataset.tone = "success";
    toast(`已匯出合併字幕（共 ${merged.length} 段）`, "success");
  } catch (err) {
    ui.status.textContent = "匯出失敗：" + String(err);
    ui.status.dataset.tone = "error";
    toast("匯出失敗：" + String(err), "error");
  }
}

function stemName(fileName) {
  const i = fileName.lastIndexOf(".");
  return i > 0 ? fileName.slice(0, i) : fileName;
}

/// 各存成各自的 SRT：選一次統一匯出資料夾 → 批次寫入 <原檔名>.srt；同名覆蓋前提示一次
async function exportPerFile() {
  const targets = state.queue.filter((q) => q.status === "done" && q.segments.length);
  if (!targets.length) return;
  try {
    let dir = state.exportDir;
    const picked = await open({ directory: true, multiple: false, defaultPath: dir || undefined });
    if (typeof picked !== "string" || !picked) return;
    dir = picked;
    state.exportDir = dir;
    state.exportMode = "per-file";
    invoke("set_export_settings", { mode: "per-file", dir }).catch(() => {});
    ui.exportMenuDir.textContent = `統一匯出資料夾：${dir}`;
    // 目標路徑由後端拼接（避免前端依賴 path plugin）
    // 遞迴掃描可能含不同子資料夾的同名檔：目標檔名去重（重複加 -2、-3…），
    // 否則後寫入者會無聲覆蓋先前匯出的字幕。
    const seenNames = new Set();
    const dests = [];
    for (const t of targets) {
      let fileName = stemName(t.name) + ".srt";
      if (seenNames.has(fileName)) {
        const stem = stemName(fileName); // 去掉 .srt
        let n = 2;
        while (seenNames.has(`${stem}-${n}.srt`)) n++;
        fileName = `${stem}-${n}.srt`;
      }
      seenNames.add(fileName);
      dests.push(await invoke("join_export_path", { dir, fileName }));
    }
    // 同名覆蓋前提示一次（後端檢查存在性，避免前端依賴 fs plugin）
    const clashes = await invoke("files_exist", { paths: dests });
    if (clashes.length) {
      const ok = await ask(
        `以下 ${clashes.length} 個檔案已存在，要覆蓋嗎？\n${clashes.slice(0, 5).join("\n")}${clashes.length > 5 ? `\n…等共 ${clashes.length} 個` : ""}`,
        { title: "KiriSub", kind: "warning" }
      );
      if (!ok) return;
    }
    // 後端一次產生＋一次寫入（單檔失敗不中斷其餘，回傳成功數）
    const contents = await invoke("build_srt_many", { items: targets.map((t) => t.segments) });
    const files = dests.map((dest, k) => ({ path: dest, content: contents[k] }));
    const okCount = await invoke("write_srt_many", { files });
    ui.status.textContent = `已匯出 ${okCount}/${targets.length} 個 SRT 到：` + dir;
    ui.status.dataset.tone = okCount === targets.length ? "success" : "error";
    toast(`已匯出 ${okCount}/${targets.length} 個 SRT`, okCount === targets.length ? "success" : "error");
  } catch (err) {
    ui.status.textContent = "匯出失敗：" + String(err);
    ui.status.dataset.tone = "error";
    toast("匯出失敗：" + String(err), "error");
  }
}

/* ---------- 匯出 SRT（編輯器內單檔） ---------- */
async function doExport() {
  if (!state.segments.length) return;
  try {
    const srt = await invoke("build_srt", { segments: state.segments });
    const dest = await save({
      defaultPath: "字幕.srt",
      filters: [{ name: "SRT 字幕", extensions: ["srt"] }],
    });
    if (typeof dest !== "string") return;
    await invoke("write_srt", { path: dest, content: srt });
    ui.status.textContent = `已匯出 ${state.segments.length} 段：` + dest;
    ui.status.dataset.tone = "success";
    toast(`已匯出 ${state.segments.length} 段`, "success");
  } catch (err) {
    ui.status.textContent = "匯出失敗：" + String(err);
    ui.status.dataset.tone = "error";
    toast("匯出失敗：" + String(err), "error");
  }
}
ui.exportBtn.addEventListener("click", onExportClick);
ui.exportMenuOk.addEventListener("click", runQueueExport);
ui.exportMenuCancel.addEventListener("click", closeExportMenu);
ui.exportMenuView.addEventListener("click", (e) => {
  if (e.target === ui.exportMenuView) closeExportMenu();
});
/* ---------- 全段偏移 ---------- */
ui.offsetBar.addEventListener("click", (e) => {
  const off = parseFloat(e.target.dataset.off);
  if (!Number.isFinite(off)) return;
  pushUndo();
  for (const seg of state.segments) {
    seg.start = snap(Math.max(0, seg.start + off));
    seg.end = snap(Math.max(seg.start + 0.1, seg.end + off));
  }
  renderSegments();
  saveAuto();
});

/* ---------- 播放中段落同步高亮 ---------- */
function watchMedia(m) {
  m.addEventListener("timeupdate", () => {
    if (!state.segments.length) return;
    const t = m.currentTime;
    let found = -1;
    for (let i = 0; i < state.segments.length; i++) {
      if (t >= state.segments[i].start && t < state.segments[i].end) { found = i; break; }
    }
    if (found !== activeSeg) {
      activeSeg = found;
      const rows = ui.list.children;
      for (let i = 0; i < rows.length; i++) rows[i].classList.toggle("active", i === activeSeg);
      // 自動捲動（採容器限定捲動，避免連帶捲動其他祖先）：
      //  - 需開啟「跟隨播放」設定
      //  - 正在打字編輯時不打擾
      //  - 使用者剛手動捲動過（時間窗內）也不打擾，讓使用者自由瀏覽
      const ae = document.activeElement;
      const editing = ae && ae.tagName === "TEXTAREA";
      if (state.autoFollow && found >= 0 && !editing && Date.now() >= userScrollUntil) {
        scrollRowIntoView(found, 8);
      }
    }
  });
}
watchMedia(ui.video);
watchMedia(ui.audio);
// 任何暫停途徑（Space、影片控制列、播畢、previewSegment 不播放）都還原「⏸」按鈕
function onMediaPause() {
  if (playingSeg >= 0) {
    setPlayIcon(playingSeg, false);
    playingSeg = -1;
  }
}
ui.video.addEventListener("pause", onMediaPause);
ui.audio.addEventListener("pause", onMediaPause);
// 載入「點擊字幕段時自動播放」設定
invoke("get_row_click_play")
  .then((v) => (state.rowClickPlay = !!v))
  .catch(() => {});

/* ---------- 播放時自動跟隨字幕（開關） ---------- */
/// 更新「跟隨播放」按鈕與設定頁勾選框的外觀，使其反映 state.autoFollow
function applyAutoFollowUI() {
  if (ui.followBtn) {
    ui.followBtn.dataset.on = state.autoFollow ? "true" : "false";
    ui.followBtn.setAttribute("aria-pressed", String(state.autoFollow));
    ui.followBtn.textContent = state.autoFollow ? "跟隨播放：開" : "跟隨播放：關";
  }
  if (ui.autoFollowChk) ui.autoFollowChk.checked = state.autoFollow;
}
/// 設定自動跟隨；persist 為 true 時同步寫回後端設定
function setAutoFollow(on, persist = true) {
  state.autoFollow = !!on;
  applyAutoFollowUI();
  if (persist) invoke("set_auto_follow", { enabled: state.autoFollow }).catch(() => {});
}
/// 切換自動跟隨並顯示提示
function toggleAutoFollow() {
  setAutoFollow(!state.autoFollow);
  toast(state.autoFollow ? "已開啟：播放時自動跟隨字幕" : "已關閉：播放時不自動跟隨", "info");
}
if (ui.followBtn) ui.followBtn.addEventListener("click", toggleAutoFollow);
if (ui.autoFollowChk) {
  ui.autoFollowChk.addEventListener("change", () => setAutoFollow(ui.autoFollowChk.checked));
}
// 載入後端設定（不寫回，避免覆蓋）
invoke("get_auto_follow")
  .then((v) => setAutoFollow(!!v, false))
  .catch(() => applyAutoFollowUI());
applyAutoFollowUI();
// 載入匯出設定（模式＋上次的統一資料夾）
invoke("get_export_settings")
  .then((s) => {
    if (s && (s.mode === "merged" || s.mode === "per-file")) state.exportMode = s.mode;
    if (s && typeof s.dir === "string" && s.dir) state.exportDir = s.dir;
  })
  .catch(() => {});

/* ---------- 鍵盤快捷鍵 ---------- */
document.addEventListener("keydown", (e) => {
  const tag = document.activeElement ? document.activeElement.tagName : "";
  const typing = tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT";

  // Esc 關閉所有 overlay；若在列內焦點循環模式則先收合展開列；正在就地編輯時間則優先取消編輯
  if (e.key === "Escape") {
    if (editingSeg >= 0) {
      editingSeg = -1;
      renderSegments();
      return;
    }
    if (segFocusMode && expandedSeg >= 0) {
      e.preventDefault();
      segFocusMode = false;
      expandedSeg = -1;
      renderSegments();
      return;
    }
    ui.settingsView.style.display = "none";
    ui.helpView.style.display = "none";
    ui.exportMenuView.style.display = "none";
    if (up.view) up.view.style.display = "none";
    return;
  }
  // Ctrl+Z 復原 / Ctrl+Shift+Z（或 Ctrl+Y）反復原（文字框內優先走系統行為）
  if ((e.ctrlKey || e.metaKey) && (e.code === "KeyZ" || e.code === "KeyY") && !typing) {
    e.preventDefault();
    if (e.code === "KeyY" || e.shiftKey) redo();
    else undo();
    return;
  }
  // Ctrl+S 匯出 SRT（編輯器單檔／清單層佇列匯出）
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    onExportClick();
    return;
  }
  // Tab / Shift+Tab：列內焦點循環模式下，只在展開列內的元件間循環移動焦點
  // （放在 typing 檢查之前：文字框也是循環的一員，Tab 不應跳出列外）
  if (e.key === "Tab" && segFocusMode && expandedSeg >= 0) {
    const row = ui.list.children[expandedSeg];
    if (row && row.contains(document.activeElement)) {
      const focusables = rowFocusables(row);
      if (focusables.length) {
        e.preventDefault();
        const cur = focusables.indexOf(document.activeElement);
        const next = cur === -1
          ? (e.shiftKey ? focusables.length - 1 : 0)
          : (cur + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length;
        const target = focusables[next];
        // 循環繞回時間鈕時：轉回「起始／結束」兩個輸入框並聚焦「起始」，
        // 讓每圈循環都能再次選到並直接編輯時間。
        if (target.classList.contains("time-btn")) {
          editingSeg = expandedSeg;
          renderSegments();
          const startIn = ui.list.children[expandedSeg]?.querySelector(".seg-time input");
          if (startIn) {
            startIn.focus();
            startIn.setSelectionRange(startIn.value.length, startIn.value.length);
          }
          return;
        }
        target.focus();
        return;
      }
    }
    // 焦點已不在展開列內（例如剛被重繪），結束循環模式讓 Tab 回到正常行為
    segFocusMode = false;
  }

  if (typing) return;

  // Enter 的語意依焦點位置決定：
  // (1) 焦點在 seg 列外層 → 展開／收合該列
  // (2) 焦點在展開列的按鈕上 → 觸發該按鈕
  // (3) 焦點在列表以外的其他元件 → 維持 ↑↓ 選中列的展開／收合
  // (4) 其餘（自然 Tab 到未展開列的時間鈕等）→ 走元件原生功能，不攔截
  if (e.key === "Enter") {
    const ae = document.activeElement;

    // (1) 焦點在 seg 列外層
    if (ae && ae.classList && ae.classList.contains("seg")) {
      e.preventDefault();
      const idx = Array.prototype.indexOf.call(ui.list.children, ae);
      if (idx < 0 || idx >= state.segments.length) return;
      selectedSeg = idx;
      if (expandedSeg === idx) {
        segFocusMode = false;
        expandedSeg = -1;
        editingSeg = -1;
        renderSegments();
      } else {
        previewSegment(idx);
        expandedSeg = idx;
        editingSeg = idx; // 時間欄直接以「起始／結束」輸入框呈現，可被 Tab 選中編輯
        segFocusMode = true;
        renderSegments();
      }
      ui.list.children[idx]?.focus(); // 重繪後焦點留在 seg 本身，Enter 可再切換
      return;
    }

    if (selectedSeg >= 0 && selectedSeg < state.segments.length) {
      // (2) 焦點循環模式中，若焦點在列內按鈕上：觸發該按鈕（Enter = 確認/執行）
      if (segFocusMode && expandedSeg >= 0) {
        const expRow = ui.list.children[expandedSeg];
        if (expRow && ae && ae.tagName === "BUTTON" && expRow.contains(ae)) {
          e.preventDefault();
          const focusables = rowFocusables(expRow);
          const btnIdx = focusables.indexOf(ae);
          ae.click();
          // 起點／終點／平移等按鈕會重繪列表並銷毀原按鈕，焦點會掉到 body；
          // 若循環模式還在，就把焦點還原到新 DOM 的同一個元件，Tab 才能繼續循環。
          const newRow = ui.list.children[expandedSeg];
          if (segFocusMode && newRow && !newRow.contains(document.activeElement)) {
            const f = rowFocusables(newRow);
            if (f.length) f[Math.min(Math.max(btnIdx, 0), f.length - 1)].focus();
          }
          return;
        }
      }
      // (3) 焦點在列表以外（例如 ↑↓ 選中後焦點還在 body）→ 展開／收合選中列
      if (!ui.list.contains(ae)) {
        e.preventDefault();
        if (expandedSeg === selectedSeg) {
          segFocusMode = false;
          expandedSeg = -1;
          renderSegments();
          return;
        }
        expandedSeg = selectedSeg;
        editingSeg = selectedSeg;
        segFocusMode = true;
        renderSegments();
        const row = ui.list.children[selectedSeg];
        if (row) row.focus(); // 焦點放在 seg 外層，Tab 再進入列內循環
        scrollRowIntoView(selectedSeg);
        return;
      }
      // (4) 焦點在列表內的元件上（未攔截的情況）→ 不 preventDefault，走原生行為
    }
  }

  // Space 播放/暫停
  if (e.key === " ") {
    e.preventDefault();
    const m = currentMedia();
    if (m.paused) m.play(); else m.pause();
    return;
  }
  // ← / →：預覽位置倒退/快進 5 秒
  if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
    e.preventDefault();
    const m = currentMedia();
    const dur = isFinite(m.duration) ? m.duration : Infinity;
    const d = e.code === "ArrowLeft" ? -5 : 5;
    m.currentTime = Math.min(Math.max(0, m.currentTime + d), dur);
    return;
  }
  // ↑ / ↓ / Home / End：移動選中的字幕列（並預覽該段起始時間）
  if (e.code === "ArrowUp" || e.code === "ArrowDown" || e.code === "Home" || e.code === "End") {
    e.preventDefault();
    if (!state.segments.length) return;
    // 離開列內焦點循環模式並收合展開列
    if (segFocusMode) {
      segFocusMode = false;
      if (expandedSeg >= 0) {
        expandedSeg = -1;
        renderSegments();
      }
    }
    let next;
    if (e.code === "Home") next = 0;
    else if (e.code === "End") next = state.segments.length - 1;
    else {
      const delta = e.code === "ArrowUp" ? -1 : 1;
      next = selectedSeg < 0 ? (delta > 0 ? 0 : state.segments.length - 1)
                             : Math.min(Math.max(0, selectedSeg + delta), state.segments.length - 1);
      if (next === selectedSeg) return;
    }
    previewSegment(next);
    return;
  }
  // F：開關「播放時自動跟隨字幕」（同步設定頁勾選與後端設定）
  if (e.code === "KeyF") {
    e.preventDefault();
    toggleAutoFollow();
    return;
  }
  // M：開關預覽聲音（用 e.code 判斷，不受輸入法影響）
  if (e.code === "KeyM") {
    e.preventDefault();
    const muted = !ui.video.muted;
    ui.video.muted = muted;
    ui.audio.muted = muted;
    ui.status.textContent = muted ? "預覽聲音：關" : "預覽聲音：開";
    return;
  }
  // A：開／關「點擊字幕段時自動播放」（同步設定頁勾選與後端設定）
  if (e.code === "KeyA") {
    e.preventDefault();
    state.rowClickPlay = !state.rowClickPlay;
    ui.rowClickPlayChk.checked = state.rowClickPlay;
    invoke("set_row_click_play", { enabled: state.rowClickPlay }).catch(() => {});
    ui.status.textContent = state.rowClickPlay
      ? "點擊字幕段自動播放：開"
      : "點擊字幕段自動播放：關";
    return;
  }
  // Delete：刪除當前選中的字幕列
  if (e.code === "Delete" && selectedSeg >= 0 && selectedSeg < state.segments.length) {
    e.preventDefault();
    pushUndo();
    state.segments.splice(selectedSeg, 1);
    // 選中位置移到同位置的下一位（尾端則前一位）
    if (selectedSeg >= state.segments.length) selectedSeg = state.segments.length - 1;
    expandedSeg = -1;
    editingSeg = -1;
    segFocusMode = false;
    renderSegments();
    saveAuto();
    return;
  }
  // I / O：設定展開段落的入點/出點
  if ((e.key === "i" || e.key === "I") && expandedSeg >= 0) {
    e.preventDefault();
    setStart(expandedSeg);
  }
  if ((e.key === "o" || e.key === "O") && expandedSeg >= 0) {
    e.preventDefault();
    setEnd(expandedSeg);
  }
});

/* ---------- 說明頁開關 ---------- */
ui.helpBtn.addEventListener("click", () => {
  ui.helpView.style.display = "flex";
});
ui.helpClose.addEventListener("click", () => {
  ui.helpView.style.display = "none";
});
ui.helpView.addEventListener("click", (e) => {
  if (e.target === ui.helpView) ui.helpView.style.display = "none";
});

/* ---------- 模型管理 ---------- */
const modelState = { activeModel: "base" };
// 追蹤正在下載中的模型 ID，防止重複下載
const downloadingModels = new Set();
// 快取目前模型列表，用於重新渲染時不需重新請求
let cachedModels = [];

async function loadModels() {
  try {
    const [models, active] = await Promise.all([
      invoke("models_list"),
      invoke("models_active"),
    ]);
    // 驗證 active model 是否仍然存在（可能已被刪除）
    const downloaded = models.filter((m) => m.downloaded);
    const activeExists = downloaded.some((m) => m.id === active);
    modelState.activeModel = activeExists ? active : (downloaded[0] ? downloaded[0].id : "");
    cachedModels = models;
    renderModelSelect(models);
    renderModels(models);
  } catch (err) {
    ui.modelList.innerHTML = `<div class="empty">載入模型失敗：${err}</div>`;
  }
}

// 開啟模型資料夾按鈕
const openModelsFolderBtn = document.getElementById("open-models-folder-btn");
if (openModelsFolderBtn) {
  openModelsFolderBtn.addEventListener("click", async () => {
    try {
      const path = await invoke("models_folder_path");
      await openPath(path);
    } catch (err) {
      ui.status.textContent = "開啟資料夾失敗：" + err;
    }
  });
}

/* 主介面下拉選單：只列已下載的模型，最後加「更多模型…」 */
function renderModelSelect(models) {
  const prev = modelState.activeModel;
  ui.modelSelect.innerHTML = "";
  const downloaded = models.filter((m) => m.downloaded);
  if (!downloaded.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "尚未下載任何模型";
    ui.modelSelect.appendChild(opt);
  } else {
    const label = { base: "Base（快・草稿用）", small: "Small（較準・推薦）", "large-v3": "Large-v3（最準・最慢）" };
    for (const m of downloaded) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = label[m.id] || m.name;
      ui.modelSelect.appendChild(opt);
    }
  }
  const more = document.createElement("option");
  more.value = "__more__";
  more.textContent = "＋ 更多模型…";
  ui.modelSelect.appendChild(more);
  ui.modelSelect.value = downloaded.some((m) => m.id === prev) ? prev : (downloaded[0] ? downloaded[0].id : "");
}

ui.modelSelect.addEventListener("change", async () => {
  const id = ui.modelSelect.value;
  if (id === "__more__" || id === "") {
    openSettings();
    return;
  }
  try {
    await invoke("models_select", { id });
    modelState.activeModel = id;
  } catch (err) {
    ui.status.textContent = "切換模型失敗：" + err;
  }
});

/* ---------- 左右分隔條（拖曳調整左欄寬度，記憶到 localStorage） ---------- */
(function initSplitter() {
  const layout = document.querySelector(".layout");
  const splitter = document.getElementById("splitter");
  if (!layout || !splitter) return;

  const STORE_KEY = "kirisub.leftW";
  const MIN_W = 280;
  const MAX_RATIO = 0.7; // 左欄最多佔 layout 寬度的 70%

  function setLeftW(px) {
    const maxW = layout.clientWidth * MAX_RATIO;
    const w = Math.min(Math.max(px, MIN_W), maxW);
    layout.style.setProperty("--left-w", w + "px");
  }

  // 還原上次寬度
  const saved = parseInt(localStorage.getItem(STORE_KEY), 10);
  if (saved > 0) setLeftW(saved);

  let dragging = false;
  splitter.addEventListener("pointerdown", (e) => {
    dragging = true;
    splitter.classList.add("dragging");
    splitter.setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  splitter.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const rect = layout.getBoundingClientRect();
    setLeftW(e.clientX - rect.left);
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove("dragging");
    document.body.style.userSelect = "";
    const cur = document.querySelector(".video-panel").getBoundingClientRect().width;
    if (cur > 0) localStorage.setItem(STORE_KEY, String(Math.round(cur)));
  };
  splitter.addEventListener("pointerup", endDrag);
  splitter.addEventListener("pointercancel", endDrag);
})();

/* ---------- 設定頁開關 ---------- */
function fmtBytes(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}

async function refreshCacheSettings() {
  try {
    const s = await invoke("get_autosave_settings");
    ui.cacheLimit.value = s.limit;
    ui.cacheLimitValue.textContent = s.limit;
    ui.cacheLimitLabel.textContent = s.limit === 0 ? "0（停用）" : s.limit;
    ui.cacheStats.textContent =
      s.limit === 0
        ? "快取已停用"
        : `${s.count} 部影片、共 ${fmtBytes(s.totalBytes)}`;
  } catch {
    ui.cacheStats.textContent = "讀取失敗";
  }
}

function openSettings() {
  ui.settingsView.style.display = "flex";
  loadModels();
  refreshCacheSettings();
  ui.rowClickPlayChk.checked = state.rowClickPlay;
  ui.autoFollowChk.checked = state.autoFollow;
  // 同步台灣用詞轉換設定（以後端儲存值為準）
  invoke("get_zh_phrase_conv")
    .then((v) => (ui.zhPhraseChk.checked = !!v))
    .catch(() => {});
}
function closeSettings() {
  ui.settingsView.style.display = "none";
}
ui.settingsBtn.addEventListener("click", openSettings);
ui.settingsClose.addEventListener("click", closeSettings);
ui.settingsView.addEventListener("click", (e) => {
  if (e.target === ui.settingsView) closeSettings();
});

/* ---------- 播放行為設定 ---------- */
ui.rowClickPlayChk.addEventListener("change", async () => {
  state.rowClickPlay = ui.rowClickPlayChk.checked;
  try {
    await invoke("set_row_click_play", { enabled: state.rowClickPlay });
  } catch (err) {
    ui.status.textContent = "儲存播放設定失敗：" + err;

  }
});

/* ---------- 字幕轉換設定（台灣用詞） ---------- */
ui.zhPhraseChk.addEventListener("change", async () => {
  try {
    await invoke("set_zh_phrase_conv", { enabled: ui.zhPhraseChk.checked });
  } catch (err) {
    ui.status.textContent = "儲存字幕轉換設定失敗：" + err;
  }
});

/* ---------- GPU 加速設定 ---------- */
async function loadGpuSettings() {
  let info = null;
  try {
    info = await invoke("get_gpu_info");
  } catch {
    // 後端偵測失敗：維持停用狀態
  }
  const vulkanOk = !!info && info.vulkanSupported;
  const gpus = info && Array.isArray(info.gpus) ? info.gpus : [];
  if (gpus.length > 0) {
    ui.gpuName.textContent = gpus.join("、");
  } else if (vulkanOk) {
    ui.gpuName.textContent = "未偵測到";
  } else {
    ui.gpuName.textContent = "未偵測到（此版本不含 Vulkan 支援）";
  }
  const usable = vulkanOk && gpus.length > 0;
  ui.gpuAccelChk.disabled = !usable;
  if (usable) {
    try {
      ui.gpuAccelChk.checked = await invoke("get_gpu_accel");
    } catch {
      ui.gpuAccelChk.checked = true;
    }
  } else {
    ui.gpuAccelChk.checked = false;
  }
}
ui.gpuAccelChk.addEventListener("change", async () => {
  try {
    await invoke("set_gpu_accel", { enabled: ui.gpuAccelChk.checked });
  } catch (err) {
    ui.status.textContent = "儲存 GPU 設定失敗：" + err;
  }
});
loadGpuSettings();

/* ---------- 字幕快取設定 ---------- */
ui.cacheLimit.addEventListener("input", () => {
  ui.cacheLimitValue.textContent = ui.cacheLimit.value;
});
ui.cacheLimit.addEventListener("change", async () => {
  const v = parseInt(ui.cacheLimit.value, 10) || 0;
  try {
    await invoke("set_autosave_limit", { limit: v });
  } catch (err) {
    ui.status.textContent = "設定快取上限失敗：" + err;
  }
  refreshCacheSettings();
});
ui.cacheClearBtn.addEventListener("click", async () => {
  const ok = await ask("確定要清除全部影片的字幕快取嗎？此動作無法復原。", {
    title: "KiriSub",
    kind: "warning",
  });
  if (!ok) return;
  try {
    await invoke("clear_autosaves");
  } catch (err) {
    ui.status.textContent = "清除快取失敗：" + err;
  }
  refreshCacheSettings();
});

function renderModels(models) {
  ui.modelList.innerHTML = "";
  for (const m of models) {
    const card = document.createElement("div");
    card.className = "model-card";
    card.dataset.model = m.id;

    const head = document.createElement("div");
    head.className = "model-head";
    const title = document.createElement("span");
    title.className = "model-name";
    title.textContent = m.name;
    const status = document.createElement("span");
    status.className = m.downloaded ? "model-status ok" : "model-status";
    status.textContent = m.downloaded ? "已下載" : "未下載";
    head.append(title, status);

    const size = document.createElement("div");
    size.className = "model-meta";
    const sizeText = typeof m.sizeMb === "number" ? m.sizeMb : "—";
    size.textContent = "大小：約 " + sizeText + " MB";

    const cap = document.createElement("div");
    cap.className = "model-meta";
    cap.textContent = "能力：" + m.capabilities;

    const lang = document.createElement("div");
    lang.className = "model-meta";
    lang.textContent = "語言：" + m.languages;

    const hw = document.createElement("div");
    hw.className = "model-meta";
    hw.textContent = "硬體：" + m.hw;

    // 進度條區域：包含進度條和百分比
    const progressRow = document.createElement("div");
    progressRow.className = "model-progress-row";
    progressRow.style.display = "none";
    const barWrap = document.createElement("div");
    barWrap.className = "progress model-progress";
    const bar = document.createElement("div");
    bar.className = "progress-bar";
    barWrap.appendChild(bar);
    const pctLabel = document.createElement("span");
    pctLabel.className = "model-download-pct";
    pctLabel.textContent = "0%";
    progressRow.append(barWrap, pctLabel);

    const actions = document.createElement("div");
    actions.className = "model-actions";
    const activeBtn = document.createElement("button");
    activeBtn.className = "btn";
    activeBtn.disabled = !m.downloaded || modelState.activeModel === m.id;
    activeBtn.textContent = modelState.activeModel === m.id ? "使用中" : "使用此模型";
    if (modelState.activeModel === m.id) activeBtn.prepend(icon("check"));
    activeBtn.addEventListener("click", async () => {
      try {
        await invoke("models_select", { id: m.id });
        modelState.activeModel = m.id;
        loadModels();
      } catch (err) {
        ui.status.textContent = "切換模型失敗：" + err;
      }
    });
    actions.appendChild(activeBtn);

    if (m.downloaded) {
      const delBtn = document.createElement("button");
      delBtn.className = "btn danger";
      delBtn.textContent = "刪除";
      delBtn.addEventListener("click", async () => {
        if (!confirm("確定刪除模型 " + m.name + "？")) return;
        try {
          await invoke("models_delete", { id: m.id });
          loadModels();
        } catch (err) {
          ui.status.textContent = "刪除失敗：" + err;
        }
      });
      actions.appendChild(delBtn);
    } else {
      if (downloadingModels.has(m.id)) {
        // 下載中：顯示進度條、百分比和中斷按鈕
        progressRow.style.display = "flex";
        const cancelBtn = document.createElement("button");
        cancelBtn.className = "btn danger";
        cancelBtn.textContent = "中斷";
        cancelBtn.prepend(icon("close"));
        cancelBtn.addEventListener("click", () => cancelModelDownload(m.id));
        actions.appendChild(cancelBtn);
      } else {
        const dlBtn = document.createElement("button");
        dlBtn.className = "btn primary";
        dlBtn.textContent = "下載";
        dlBtn.prepend(icon("download"));
        dlBtn.dataset.model = m.id;
        dlBtn.addEventListener("click", () => downloadModel(m.id, bar, progressRow, dlBtn));
        actions.appendChild(dlBtn);
      }
    }

    card.append(head, size, cap, lang, hw, progressRow, actions);
    ui.modelList.appendChild(card);
  }
}

async function downloadModel(id, bar, barWrap, btn) {
  if (downloadingModels.has(id)) return; // 防止重複下載
  downloadingModels.add(id);
  // 立即重新渲染以顯示中斷按鈕
  renderModels(cachedModels);
  try {
    await invoke("models_download", { id });
  } catch (err) {
    ui.status.textContent = "下載啟動失敗：" + err;
    downloadingModels.delete(id);
  }
  // 進度事件在下方 listen 中處理，完成後由事件重新載入清單
}

async function cancelModelDownload(id) {
  try {
    await invoke("models_download_cancel", { id });
  } catch (err) {
    ui.status.textContent = "中斷下載失敗：" + err;
  }
}

listen("model-download-start", () => {
  // 可在此整體更新；此處留待 progress
});
listen("model-download-progress", (e) => {
  const [id, downloaded, total, pct] = e.payload;
  // 更新對應進度條和百分比
  const row = document.querySelector(`.model-card[data-model="${id}"] .model-progress-row`);
  if (row) {
    const bar = row.querySelector(".progress-bar");
    if (bar) bar.style.width = pct + "%";
    const pctLabel = row.querySelector(".model-download-pct");
    if (pctLabel) pctLabel.textContent = Math.round(pct) + "%";
  }
});
listen("model-download-done", (e) => {
  const [id] = e.payload;
  downloadingModels.delete(id);
  ui.status.textContent = "模型下載完成";
  ui.status.dataset.tone = "success";
  toast("模型下載完成", "success");
  loadModels();
});
listen("model-download-failed", (e) => {
  const [id, msg] = e.payload;
  downloadingModels.delete(id);
  ui.status.textContent = "下載失敗：" + msg;
  ui.status.dataset.tone = "error";
  toast("模型下載失敗：" + msg, "error");
  loadModels();
});
listen("model-download-cancelled", (e) => {
  const [id] = e.payload;
  downloadingModels.delete(id);
  ui.status.textContent = "下載已中斷";
  loadModels();
});

/* ---------- 自動更新 ---------- */
const up = {
  view: document.getElementById("update-view"),
  msg: document.getElementById("update-msg"),
  wrap: document.getElementById("update-progress-wrap"),
  bar: document.getElementById("update-progress-bar"),
  install: document.getElementById("update-install-btn"),
  restart: document.getElementById("update-restart-btn"),
  close: document.getElementById("update-close-btn"),
  checkBtn: document.getElementById("check-update-btn"),
  version: document.getElementById("app-version"),
};
let pendingUpdate = null;

async function checkForUpdate(interactive) {
  try {
    if (interactive) {
      up.view.style.display = "flex";
      up.msg.textContent = "檢查新版本中…";
      up.install.style.display = "none";
      up.restart.style.display = "none";
      up.wrap.style.display = "none";
    }
    const update = await check();
    if (!update) {
      if (interactive) up.msg.textContent = "已是最新版本。";
      return;
    }
    pendingUpdate = update;
    up.msg.textContent = `發現新版本 ${update.version}！要更新嗎？`;
    if (update.body) up.msg.textContent += "\n" + update.body;
    up.install.style.display = "inline-block";
    if (!interactive) up.view.style.display = "flex";
  } catch (err) {
    if (interactive) up.msg.textContent = "檢查更新失敗：" + String(err);
  }
}

up.install.addEventListener("click", async () => {
  if (!pendingUpdate) return;
  up.install.disabled = true;
  up.close.style.display = "none";
  up.msg.textContent = "下載更新中…";
  up.wrap.style.display = "block";
  up.bar.style.width = "0%";
  try {
    let contentLength = 0;
    await pendingUpdate.downloadAndInstall((event) => {
      if (event.event === "Started" && event.data.contentLength) {
        contentLength = event.data.contentLength;
      } else if (event.event === "Progress" && contentLength > 0) {
        up.bar.style.width = Math.min(100, Math.round((event.data.chunkLength / contentLength) * 100)) + "%";
      } else if (event.event === "Finished") {
        up.msg.textContent = "更新完成！";
        up.wrap.style.display = "none";
        up.restart.style.display = "inline-block";
      }
    });
  } catch (err) {
    up.msg.textContent = "更新失敗：" + String(err);
    up.wrap.style.display = "none";
  }
  up.install.disabled = false;
  up.close.style.display = "inline-block";
});
up.restart.addEventListener("click", () => relaunch());
up.close.addEventListener("click", () => {
  up.view.style.display = "none";
});
up.checkBtn.addEventListener("click", () => checkForUpdate(true));

// 啟動：顯示版本 + 靜默檢查更新（有新版才跳提示）
getVersion().then((v) => { up.version.textContent = "v" + v; }).catch(() => {});
setTimeout(() => checkForUpdate(false), 3000);

loadModels();