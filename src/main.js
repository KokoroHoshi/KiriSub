import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save, ask } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

const state = { videoPath: null, segments: [], busy: false, mediaType: "video" };

const ui = {
  video: document.getElementById("video"),
  audio: document.getElementById("audio"),
  pick: document.getElementById("pick-btn"),
  fileName: document.getElementById("file-name"),
  lang: document.getElementById("lang"),
  generate: document.getElementById("generate-btn"),
  progressWrap: document.getElementById("progress-wrap"),
  progressBar: document.getElementById("progress-bar"),
  status: document.getElementById("status"),
  previewHint: document.getElementById("preview-hint"),
  exportBtn: document.getElementById("export-btn"),
  offsetBar: document.getElementById("offset-bar"),
  helpBtn: document.getElementById("help-btn"),
  helpView: document.getElementById("help-view"),
  helpClose: document.getElementById("help-close"),
  empty: document.getElementById("empty"),
  list: document.getElementById("segments"),
  dropHint: document.getElementById("drop-hint"),
  modelList: document.getElementById("model-list"),
  modelSelect: document.getElementById("model-select"),
  settingsBtn: document.getElementById("settings-btn"),
  settingsView: document.getElementById("settings-view"),
  settingsClose: document.getElementById("settings-close"),
};

/* ---------- 選影片／音訊 ---------- */
const AUDIO_EXT = ["mp3", "wav", "flac", "m4a", "ogg", "aac", "wma", "opus"];
const VIDEO_EXT = ["mp4", "mov", "mkv", "avi", "flv", "webm", "ts", "m4v"];
ui.pick.addEventListener("click", async () => {
  const res = await open({
    multiple: false,
    filters: [
      { name: "影片", extensions: VIDEO_EXT },
      { name: "音訊", extensions: AUDIO_EXT },
    ],
  });
  if (typeof res === "string") setMedia(res);
});

function isAudio(path) {
  const ext = String(path).split(".").pop().toLowerCase();
  return AUDIO_EXT.includes(ext);
}

function setMedia(path) {
  state.videoPath = path;
  state.mediaType = isAudio(path) ? "audio" : "video";
  const name = String(path).split(/[\\/]/).pop();
  ui.fileName.textContent = name;
  ui.fileName.title = path;
  ui.dropHint.style.display = "none";
  ui.previewHint.style.display = "none";
  ui.generate.disabled = false;
  undoStack.length = 0;
  expandedSeg = -1;
  activeSeg = -1;
  editingSeg = -1;
  maybeLoadAutosave();

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
document.addEventListener("drop", (e) => {
  e.preventDefault();
  // Tauri 內無法直接從拖放取絕對路徑，請用「選擇影片/音訊」按鈕。
  ui.status.textContent = "請用「選擇影片／音訊」按鈕選檔";
});

/* ---------- 生成字幕 ---------- */
ui.generate.addEventListener("click", async () => {
  if (!state.videoPath || state.busy) return;
  state.busy = true;
  ui.generate.disabled = true;
  ui.exportBtn.disabled = true;
  ui.lang.disabled = true;
  ui.modelSelect.disabled = true;
  ui.progressWrap.style.display = "block";
  ui.progressBar.style.width = "0%";
  ui.status.textContent = "準備中…";
  const lang = ui.lang.value === "auto" ? null : ui.lang.value;
  try {
    await invoke("transcribe", {
      request: { videoPath: state.videoPath, language: lang },
    });
  } catch (err) {
    ui.status.textContent = "啟動失敗：" + String(err);
    state.busy = false;
    ui.generate.disabled = false;
  }
});

/* ---------- 後端事件 ---------- */
listen("transcribe-status", (e) => {
  ui.status.textContent =
    e.payload === "extracting" ? "抽取音訊…" : "whisper 轉錄中…";
});
listen("transcribe-progress", (e) => {
  const p = Math.max(0, Math.min(100, e.payload.percent));
  ui.progressBar.style.width = p + "%";
  ui.status.textContent = "轉錄中… " + p + "%";
});
listen("transcribe-done", (e) => {
  state.segments = e.payload.segments;
  state.busy = false;
  ui.generate.disabled = false;
  ui.lang.disabled = false;
  ui.modelSelect.disabled = false;
  ui.progressWrap.style.display = "none";
  undoStack.length = 0;
  renderSegments();
  saveAuto();
  ui.status.textContent = "完成，共 " + state.segments.length + " 段";
});
listen("transcribe-error", (e) => {
  state.busy = false;
  ui.generate.disabled = false;
  ui.lang.disabled = false;
  ui.modelSelect.disabled = false;
  ui.progressWrap.style.display = "none";
  ui.status.textContent = "錯誤：" + e.payload;
});

/* ---------- 渲染字幕段落 ---------- */
let expandedSeg = -1; // 目前展開微調的段落 index
let activeSeg = -1;   // 播放中對應的段落 index
let editingSeg = -1;  // 目前就地編輯時間的段落 index（無則 -1）

/* ---------- Undo（Ctrl+Z 復原） ---------- */
const undoStack = [];
function pushUndo() {
  if (undoStack.length >= 50) undoStack.shift();
  undoStack.push(JSON.stringify(state.segments));
}
function undo() {
  if (!undoStack.length) return;
  state.segments = JSON.parse(undoStack.pop());
  expandedSeg = -1;
  editingSeg = -1;
  renderSegments();
  saveAuto();
}

/* ---------- 自動儲存進度 ---------- */
let saveTimer = null;
function saveAuto() {
  if (!state.videoPath) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    invoke("save_state", { videoPath: state.videoPath, segments: state.segments }).catch(() => {});
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

function renderSegments() {
  ui.list.innerHTML = "";
  ui.offsetBar.style.display = state.segments.length ? "flex" : "none";
  if (!state.segments.length) {
    ui.empty.style.display = "block";
    ui.exportBtn.disabled = true;
    return;
  }
  ui.empty.style.display = "none";
  ui.exportBtn.disabled = false;

  state.segments.forEach((seg, i) => {
    const row = document.createElement("div");
    row.className = "seg" + (expandedSeg === i ? " expanded" : "") + (activeSeg === i ? " active" : "");

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
    actions.appendChild(mkBtn("▶ 播放", (e) => {
      e.stopPropagation();
      seekTo(seg.start);
    }));
    const del = mkBtn("✕ 刪除", (e) => {
      e.stopPropagation();
      pushUndo();
      state.segments.splice(i, 1);
      expandedSeg = -1;
      editingSeg = -1;
      renderSegments();
      saveAuto();
    });
    del.classList.add("danger");
    actions.appendChild(del);

    const text = document.createElement("textarea");
    text.className = "seg-text";
    text.value = seg.text;
    text.rows = 2;
    text.addEventListener("input", () => {
      seg.text = text.value;
      fitText(text);
      saveAuto();
    });
    text.addEventListener("click", (e) => e.stopPropagation());

    row.append(idx, time, actions, text);

    // 微調列（僅展開的段落）
    if (expandedSeg === i) {
      const adj = document.createElement("div");
      adj.className = "seg-adjust";
      adj.appendChild(mkBtn("◀ 起點", (e) => { e.stopPropagation(); setStart(i); }));
      adj.appendChild(mkBtn("終點 ▶", (e) => { e.stopPropagation(); setEnd(i); }));
      for (const d of [-0.5, -0.1, -0.05, -0.01, 0.01, 0.05, 0.1, 0.5]) {
        const b = mkBtn((d > 0 ? "+" : "") + d + "s", (e) => {
          e.stopPropagation();
          pushUndo();
          seg.start = snap(Math.max(0, seg.start + d));
          seg.end = snap(Math.max(seg.start + 0.1, seg.end + d));
          updateTimeDisplay(i, seg);
          saveAuto();
        });
        adj.appendChild(b);
      }
      row.appendChild(adj);
    }

    // 點擊整列（但排除時間欄位、文字框、按鈕）→ 展開/收合微調列
    row.addEventListener("click", (e) => {
      if (e.target === row) {
        expandedSeg = expandedSeg === i ? -1 : i;
        editingSeg = editingSeg === i ? -1 : editingSeg;
        renderSegments();
      }
    });

    // 點擊時間欄位 → 進入就地編輯（並展開微調列）
    if (!editingThis) {
      time.addEventListener("click", (e) => {
        e.stopPropagation();
        editingSeg = i;
        expandedSeg = i;
        renderSegments();
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
}

function mkBtn(label, fn) {
  const b = document.createElement("button");
  b.className = "mini-btn";
  b.textContent = label;
  b.addEventListener("click", fn);
  return b;
}

function setStart(i) {
  const seg = state.segments[i];
  const m = currentMedia();
  if (m && Number.isFinite(m.currentTime)) {
    pushUndo();
    seg.start = snap(Math.min(m.currentTime, seg.end - 0.1));
    updateTimeDisplay(i, seg);
    saveAuto();
  }
}
function setEnd(i) {
  const seg = state.segments[i];
  const m = currentMedia();
  if (m && Number.isFinite(m.currentTime)) {
    pushUndo();
    seg.end = snap(Math.max(m.currentTime, seg.start + 0.1));
    updateTimeDisplay(i, seg);
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
  if (!ok) return; // 留在編輯模式，紅框提示
  if (!Number.isFinite(s) || s < 0) { startIn.classList.add("invalid"); ok = false; }
  if (!Number.isFinite(e) || e <= s) { endIn.classList.add("invalid"); ok = false; }
  if (!ok) return;
  pushUndo();
  seg.start = Math.round(s * 1000) / 1000;
  seg.end = Math.round(e * 1000) / 1000;
  editingSeg = -1;
  renderSegments();
  saveAuto();
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

/* ---------- 匯出 SRT ---------- */
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
  } catch (err) {
    ui.status.textContent = "匯出失敗：" + String(err);
  }
}
ui.exportBtn.addEventListener("click", doExport);
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
      // 自動捲動（正在打字編輯時不打擾）
      if (found >= 0 && rows[found] && !(document.activeElement && document.activeElement.tagName === "TEXTAREA")) {
        rows[found].scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
  });
}
watchMedia(ui.video);
watchMedia(ui.audio);

/* ---------- 鍵盤快捷鍵 ---------- */
document.addEventListener("keydown", (e) => {
  const tag = document.activeElement ? document.activeElement.tagName : "";
  const typing = tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT";

  // Esc 關閉所有 overlay；若正在就地編輯時間則優先取消編輯
  if (e.key === "Escape") {
    if (editingSeg >= 0) {
      editingSeg = -1;
      renderSegments();
      return;
    }
    ui.settingsView.style.display = "none";
    ui.helpView.style.display = "none";
    if (up.view) up.view.style.display = "none";
    return;
  }
  // Ctrl+Z 復原（文字框內優先走系統行為）
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !typing) {
    e.preventDefault();
    undo();
    return;
  }
  // Ctrl+S 匯出 SRT
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    doExport();
    return;
  }
  if (typing) return;

  // Space 播放/暫停
  if (e.key === " ") {
    e.preventDefault();
    const m = currentMedia();
    if (m.paused) m.play(); else m.pause();
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

async function loadModels() {
  try {
    const [models, active] = await Promise.all([
      invoke("models_list"),
      invoke("models_active"),
    ]);
    modelState.activeModel = active;
    renderModelSelect(models);
    renderModels(models);
  } catch (err) {
    ui.modelList.innerHTML = `<div class="empty">載入模型失敗：${err}</div>`;
  }
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
  more.textContent = "➕ 更多模型…";
  ui.modelSelect.appendChild(more);
  ui.modelSelect.value = downloaded.some((m) => m.id === prev) ? prev : (downloaded[0] ? downloaded[0].id : "__more__");
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

/* ---------- 設定頁開關 ---------- */
function openSettings() {
  ui.settingsView.style.display = "flex";
  loadModels();
}
function closeSettings() {
  ui.settingsView.style.display = "none";
}
ui.settingsBtn.addEventListener("click", openSettings);
ui.settingsClose.addEventListener("click", closeSettings);
ui.settingsView.addEventListener("click", (e) => {
  if (e.target === ui.settingsView) closeSettings();
});

function renderModels(models) {
  ui.modelList.innerHTML = "";
  for (const m of models) {
    const card = document.createElement("div");
    card.className = "model-card";

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

    const barWrap = document.createElement("div");
    barWrap.className = "progress model-progress";
    barWrap.style.display = "none";
    const bar = document.createElement("div");
    bar.className = "progress-bar";
    barWrap.appendChild(bar);

    const actions = document.createElement("div");
    actions.className = "model-actions";
    const activeBtn = document.createElement("button");
    activeBtn.className = "btn";
    activeBtn.disabled = !m.downloaded || modelState.activeModel === m.id;
    activeBtn.textContent = modelState.activeModel === m.id ? "✓ 使用中" : "使用此模型";
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
      const dlBtn = document.createElement("button");
      dlBtn.className = "btn primary";
      dlBtn.textContent = "⬇ 下載";
      dlBtn.dataset.model = m.id;
      dlBtn.addEventListener("click", () => downloadModel(m.id, bar, barWrap, dlBtn));
      actions.appendChild(dlBtn);
    }

    card.append(head, size, cap, lang, hw, barWrap, actions);
    ui.modelList.appendChild(card);
  }
}

async function downloadModel(id, bar, barWrap, btn) {
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "下載中…";
  barWrap.style.display = "block";
  bar.style.width = "0%";
  try {
    await invoke("models_download", { id });
  } catch (err) {
    ui.status.textContent = "下載啟動失敗：" + err;
  }
  // 進度事件在下方 listen 中處理，完成後由事件重新載入清單
}

listen("model-download-start", () => {
  // 可在此整體更新；此處留待 progress
});
listen("model-download-progress", (e) => {
  const [id, downloaded, total, pct] = e.payload;
  const btn = document.querySelector(`.btn[data-model="${id}"]`);
  if (btn) btn.textContent = "下載中 " + Math.round(pct) + "%";
  // 更新對應進度條
  const card = btn ? btn.closest(".model-card") : null;
  if (card) {
    const bar = card.querySelector(".model-progress .progress-bar");
    if (bar) bar.style.width = pct + "%";
  }
});
listen("model-download-done", () => {
  ui.status.textContent = "模型下載完成";
  loadModels();
});
listen("model-download-failed", (e) => {
  const [id, msg] = e.payload;
  ui.status.textContent = "下載失敗：" + msg;
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