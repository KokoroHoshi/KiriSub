import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";

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
  empty: document.getElementById("empty"),
  list: document.getElementById("segments"),
  dropHint: document.getElementById("drop-hint"),
  modelList: document.getElementById("model-list"),
  activeBadge: document.getElementById("active-model-badge"),
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
  ui.progressWrap.style.display = "none";
  renderSegments();
  ui.status.textContent = "完成，共 " + state.segments.length + " 段";
});
listen("transcribe-error", (e) => {
  state.busy = false;
  ui.generate.disabled = false;
  ui.progressWrap.style.display = "none";
  ui.status.textContent = "錯誤：" + e.payload;
});

/* ---------- 渲染字幕段落 ---------- */
function renderSegments() {
  ui.list.innerHTML = "";
  if (!state.segments.length) {
    ui.empty.style.display = "block";
    ui.exportBtn.disabled = true;
    return;
  }
  ui.empty.style.display = "none";
  ui.exportBtn.disabled = false;

  state.segments.forEach((seg, i) => {
    const row = document.createElement("div");
    row.className = "seg";

    const idx = document.createElement("span");
    idx.className = "seg-index";
    idx.textContent = String(i + 1);

    const time = document.createElement("span");
    time.className = "seg-time";
    time.textContent = fmtEdge(seg.start) + " → " + fmtEdge(seg.end);

    const actions = document.createElement("div");
    actions.className = "seg-actions";
    actions.appendChild(mkBtn("◀ 起點", () => setStart(seg, time)));
    actions.appendChild(mkBtn("終點 ▶", () => setEnd(seg, time)));
    actions.appendChild(mkBtn("▶ 播放", () => seekTo(seg.start)));
    const del = mkBtn("✕ 刪除", () => {
      state.segments.splice(i, 1);
      renderSegments();
    });
    del.classList.add("danger");
    actions.appendChild(del);

    const text = document.createElement("textarea");
    text.className = "seg-text";
    text.value = seg.text;
    text.rows = 2;
    text.addEventListener("input", () => {
      seg.text = text.value;
    });

    row.append(idx, time, actions, text);
    ui.list.appendChild(row);
  });
}

function mkBtn(label, fn) {
  const b = document.createElement("button");
  b.className = "mini-btn";
  b.textContent = label;
  b.addEventListener("click", fn);
  return b;
}

function setStart(seg, timeEl) {
  const m = currentMedia();
  if (m && Number.isFinite(m.currentTime)) {
    seg.start = snap(m.currentTime);
    timeEl.textContent = fmtEdge(seg.start) + " → " + fmtEdge(seg.end);
  }
}
function setEnd(seg, timeEl) {
  const m = currentMedia();
  if (m && Number.isFinite(m.currentTime)) {
    seg.end = snap(m.currentTime);
    timeEl.textContent = fmtEdge(seg.start) + " → " + fmtEdge(seg.end);
  }
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
  return Math.round(t * 100) / 100;
}
function fmtEdge(t) {
  const s = Math.floor(t % 60);
  const m = Math.floor(t / 60) % 60;
  const h = Math.floor(t / 3600);
  const ss = String(s).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  return h > 0 ? h + ":" + mm + ":" + ss : m + ":" + ss;
}

/* ---------- 匯出 SRT ---------- */
ui.exportBtn.addEventListener("click", async () => {
  if (!state.segments.length) return;
  try {
    const srt = await invoke("build_srt", { segments: state.segments });
    const dest = await save({
      defaultPath: "字幕.srt",
      filters: [{ name: "SRT 字幕", extensions: ["srt"] }],
    });
    if (typeof dest !== "string") return;
    await invoke("write_srt", { path: dest, content: srt });
    ui.status.textContent = "已匯出：" + dest;
  } catch (err) {
    ui.status.textContent = "匯出失敗：" + String(err);
  }
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
    ui.activeBadge.textContent = "使用中：" + active;
    renderModels(models);
  } catch (err) {
    ui.modelList.innerHTML = `<div class="empty">載入模型失敗：${err}</div>`;
  }
}

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
    size.textContent = "大小：約 " + m.sizeMb + " MB";

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
        ui.activeBadge.textContent = "使用中：" + m.id;
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

loadModels();