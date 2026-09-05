import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";

const state = { videoPath: null, segments: [], busy: false };

const ui = {
  video: document.getElementById("video"),
  pick: document.getElementById("pick-btn"),
  fileName: document.getElementById("file-name"),
  lang: document.getElementById("lang"),
  generate: document.getElementById("generate-btn"),
  progressWrap: document.getElementById("progress-wrap"),
  progressBar: document.getElementById("progress-bar"),
  status: document.getElementById("status"),
  exportBtn: document.getElementById("export-btn"),
  empty: document.getElementById("empty"),
  list: document.getElementById("segments"),
  dropHint: document.getElementById("drop-hint"),
};

/* ---------- 選影片 ---------- */
ui.pick.addEventListener("click", async () => {
  const res = await open({
    multiple: false,
    filters: [
      { name: "影片", extensions: ["mp4", "mov", "mkv", "avi", "flv", "webm", "ts", "m4v"] },
    ],
  });
  if (typeof res === "string") setVideo(res);
});

function setVideo(path) {
  state.videoPath = path;
  const name = String(path).split(/[\\/]/).pop();
  ui.fileName.textContent = name;
  ui.fileName.title = path;
  ui.video.src = convertFileSrc(path);
  ui.video.load();
  ui.dropHint.style.display = "none";
  ui.generate.disabled = false;
}

document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  // Tauri 內無法直接從拖放取絕對路徑，請用「選擇影片」按鈕。
  ui.status.textContent = "請用「選擇影片」按鈕選檔";
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
  if (Number.isFinite(ui.video.currentTime)) {
    seg.start = snap(ui.video.currentTime);
    timeEl.textContent = fmtEdge(seg.start) + " → " + fmtEdge(seg.end);
  }
}
function setEnd(seg, timeEl) {
  if (Number.isFinite(ui.video.currentTime)) {
    seg.end = snap(ui.video.currentTime);
    timeEl.textContent = fmtEdge(seg.start) + " → " + fmtEdge(seg.end);
  }
}
function seekTo(t) {
  ui.video.currentTime = t;
  ui.video.play();
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