mod audio;
mod models;
mod subtitle;
mod transcribe;

use serde::Deserialize;
use tauri::{Emitter, Manager};
use std::sync::atomic::{AtomicBool, Ordering};

/// 簡易檔案 log：寫到 app_data_dir/kirisub.log，方便診斷安裝版問題。
fn log_line(app: &tauri::AppHandle, msg: &str) {
    use std::io::Write;
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("kirisub.log"))
        {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let _ = writeln!(f, "[{ts}] {msg}");
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscribeRequest {
    video_path: String,
    language: Option<String>,
}

#[tauri::command]
fn transcribe(app: tauri::AppHandle, request: TranscribeRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        transcribe::reset_cancel();
        log_line(&app, &format!("開始轉錄：{} 語系：{:?}", request.video_path, request.language));

        let path = match models::resolve_active_model_path(&app) {
            Ok(p) => p,
            Err(e) => {
                log_line(&app, &format!("模型解析失敗：{e}"));
                let _ = app.emit("transcribe-error", e);
                return;
            }
        };
        log_line(&app, &format!("使用模型：{}", path.display()));

        let _ = app.emit("transcribe-status", "extracting");
        // 模型解析期間也可能被按下中斷
        if transcribe::is_cancelled() {
            log_line(&app, "轉錄被使用者取消（抽音訊前）");
            let _ = app.emit("transcribe-cancelled", ());
            return;
        }
        let mono = match audio::extract_mono_16k(&request.video_path) {
            Ok(m) => m,
            Err(e) if e == audio::CANCELLED_MARKER => {
                log_line(&app, "轉錄被使用者取消（抽音訊中）");
                let _ = app.emit("transcribe-cancelled", ());
                return;
            }
            Err(e) => {
                log_line(&app, &format!("抽音訊失敗：{e}"));
                let _ = app.emit("transcribe-error", e);
                return;
            }
        };
        log_line(&app, &format!("音訊樣本數：{}", mono.samples.len()));

        let _ = app.emit("transcribe-status", "transcribing");

        // 進度 callback 透過 channel 轉發，不在 FFI 執行緒內 emit。
        // 注意：whisper-rs 的 FullParams 沒有實作 Drop，progress callback 內持有的
        // Sender 會被刻意洩漏、永遠不會被 drop，因此 channel 永不關閉。forwarder
        // 若依賴「rx 收到 Disconnect 才結束」會永遠卡住，導致 forwarder.join() 永不返回、
        // transcribe-done 永遠不觸發（字幕段落不出現）。故改用獨立的完成旗標收尾。
        let (tx, rx) = std::sync::mpsc::channel::<i32>();
        let done = std::sync::Arc::new(AtomicBool::new(false));
        let progress_app = app.clone();
        let fwd_done = std::sync::Arc::clone(&done);
        let forwarder = std::thread::spawn(move || {
            let drain = || {
                while let Ok(pct) = rx.try_recv() {
                    let _ = progress_app.emit(
                        "transcribe-progress",
                        serde_json::json!({ "percent": pct }),
                    );
                }
            };
            loop {
                drain();
                if fwd_done.load(Ordering::SeqCst) {
                    drain(); // 完成後再榨乾最後一輪剩餘訊息，避免遺漏 100%
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        });

        let use_gpu =
            cfg!(feature = "gpu-vulkan") && models::gpu_enabled(&app).unwrap_or(true);
        log_line(&app, &format!("GPU 加速：{}", if use_gpu { "開啟 (Vulkan)" } else { "關閉 (CPU)" }));

        let result = {
            let prog = Some(tx);
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                transcribe::transcribe(&path, &mono.samples, request.language.as_deref(), use_gpu, prog)
            }))
        };
        // 無論成功、錯誤或 panic，都先通知 forwarder 結束
        // （whisper-rs 洩漏的 Sender 不會 drop channel，必須靠旗標讓 forwarder 收尾）。
        done.store(true, Ordering::SeqCst);
        let _ = forwarder.join();

        match result {
            Ok(Ok(segments)) => {
                log_line(&app, &format!("轉錄完成，共 {} 段", segments.len()));
                let _ = app.emit("transcribe-done", serde_json::json!({ "segments": segments }));
            }
            Ok(Err(transcribe::TranscribeError::Cancelled)) => {
                log_line(&app, "轉錄被使用者取消");
                let _ = app.emit("transcribe-cancelled", ());
            }
            Ok(Err(transcribe::TranscribeError::Other(e))) => {
                log_line(&app, &format!("轉錄錯誤：{e}"));
                let _ = app.emit("transcribe-error", e);
            }
            Err(p) => {
                let msg = p
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_else(|| "不明 panic".to_string());
                log_line(&app, &format!("轉錄 panic：{msg}"));
                let _ = app.emit(
                    "transcribe-error",
                    format!("轉錄程序異常終止（已記錄到 kirisub.log）：{msg}"),
                );
            }
        }
    });
    Ok(())
}

/// 請求中止目前的轉錄。
#[tauri::command]
fn cancel_transcribe() -> Result<(), String> {
    transcribe::request_cancel();
    Ok(())
}

/// 由分段清單產生 SRT 字串（前端儲存為 .srt）。
#[tauri::command]
fn build_srt(segments: Vec<transcribe::Segment>) -> Result<String, String> {
    Ok(subtitle::to_srt(&segments))
}

/// 以 UTF-8 寫入檔案（用於儲存 .srt）。
#[tauri::command]
fn write_srt(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("寫入失敗：{e}"))
}

/// 字幕快取目錄：app_data_dir/autosave/，每部影片一個檔（檔名為路徑雜湊）。
fn autosave_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取得資料目錄失敗：{e}"))?
        .join("autosave");
    std::fs::create_dir_all(&dir).map_err(|e| format!("建立資料夾失敗：{e}"))?;
    Ok(dir)
}

/// FNV-1a 64-bit：把影片完整路徑雜湊成 hex 檔名（避免長路徑／特殊字元問題）。
fn autosave_file_name(video_path: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in video_path.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}.json")
}

fn autosave_limit(app: &tauri::AppHandle) -> u32 {
    models::read_settings(app)
        .ok()
        .and_then(|s| s.autosave_limit)
        .unwrap_or(models::DEFAULT_AUTOSAVE_LIMIT)
}

/// 依「最後修改時間」新→舊保留 limit 個檔案，刪除其餘。
fn prune_autosaves(dir: &std::path::Path, limit: u32) {
    if limit == 0 {
        return;
    }
    let mut entries: Vec<(std::time::SystemTime, std::path::PathBuf)> = match std::fs::read_dir(dir)
    {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().map(|x| x == "json").unwrap_or(false))
            .filter_map(|e| {
                let meta = e.metadata().ok()?;
                Some((meta.modified().ok()?, e.path()))
            })
            .collect(),
        Err(_) => return,
    };
    entries.sort_by(|a, b| b.0.cmp(&a.0)); // 新在前
    for (_, p) in entries.into_iter().skip(limit as usize) {
        let _ = std::fs::remove_file(p);
    }
}

/// 自動儲存字幕編輯進度：每部影片一個快取檔（autosave/<路徑雜湊>.json）。
/// 上限由設定（autosave_limit，預設 10）控制，0 = 停用快取。
#[tauri::command]
fn save_state(
    app: tauri::AppHandle,
    video_path: String,
    segments: Vec<transcribe::Segment>,
) -> Result<(), String> {
    let limit = autosave_limit(&app);
    if limit == 0 {
        return Ok(()); // 停用快取
    }
    let dir = autosave_dir(&app)?;
    let saved_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let json = serde_json::json!({
        "videoPath": video_path,
        "savedAt": saved_at,
        "segments": segments,
    });
    std::fs::write(
        dir.join(autosave_file_name(&video_path)),
        serde_json::to_string(&json).map_err(|e| format!("序列化失敗：{e}"))?,
    )
    .map_err(|e| format!("寫入失敗：{e}"))?;
    prune_autosaves(&dir, limit);
    Ok(())
}

/// 讀回指定影片的自動儲存進度；找不到則回傳空清單。
/// 第一次找不到新格式時，嘗試從舊版單檔 autosave.json 遷移。
#[tauri::command]
fn load_state(app: tauri::AppHandle, video_path: String) -> Result<Vec<transcribe::Segment>, String> {
    let dir = autosave_dir(&app)?;
    let p = dir.join(autosave_file_name(&video_path));
    if let Ok(txt) = std::fs::read_to_string(&p) {
        return parse_saved(&txt, &video_path);
    }
    // 舊版單檔遷移
    let legacy = dir.join("../autosave.json");
    if let Ok(txt) = std::fs::read_to_string(&legacy) {
        if parse_saved(&txt, &video_path)
            .map(|s| !s.is_empty())
            .unwrap_or(false)
        {
            let _ = std::fs::rename(&legacy, &p);
            return parse_saved(&std::fs::read_to_string(&p).unwrap_or_default(), &video_path);
        }
    }
    Ok(vec![])
}

fn parse_saved(txt: &str, video_path: &str) -> Result<Vec<transcribe::Segment>, String> {
    #[derive(serde::Deserialize)]
    struct Saved {
        #[serde(rename = "videoPath")]
        video_path: String,
        #[serde(default)]
        segments: Vec<transcribe::Segment>,
    }
    let saved: Saved = match serde_json::from_str(txt) {
        Ok(s) => s,
        Err(_) => return Ok(vec![]),
    };
    if saved.video_path != video_path {
        return Ok(vec![]);
    }
    Ok(saved.segments)
}

/// 取得快取設定與現況統計（供設定頁顯示）。
#[tauri::command]
fn get_autosave_settings(
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let dir = autosave_dir(&app)?;
    let mut count = 0u32;
    let mut total_bytes = 0u64;
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.filter_map(|e| e.ok()) {
            if e.path().extension().map(|x| x == "json").unwrap_or(false) {
                count += 1;
                total_bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    Ok(serde_json::json!({
        "limit": autosave_limit(&app),
        "count": count,
        "totalBytes": total_bytes,
    }))
}

/// 設定快取上限（0–100），並立即套用清理。
#[tauri::command]
fn set_autosave_limit(app: tauri::AppHandle, limit: u32) -> Result<(), String> {
    if limit > 100 {
        return Err("上限不可超過 100".to_string());
    }
    let mut s = models::read_settings(&app)?;
    s.autosave_limit = Some(limit);
    models::write_settings(&app, &s)?;
    let dir = autosave_dir(&app)?;
    if limit == 0 {
        // 停用：清空全部
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.filter_map(|e| e.ok()) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    } else {
        prune_autosaves(&dir, limit);
    }
    Ok(())
}

/// 清除全部字幕快取。
#[tauri::command]
fn clear_autosaves(app: tauri::AppHandle) -> Result<(), String> {
    let dir = autosave_dir(&app)?;
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.filter_map(|e| e.ok()) {
            let _ = std::fs::remove_file(e.path());
        }
    }
    Ok(())
}

/// 取得「點擊字幕段時自動播放」設定（預設 false）。
#[tauri::command]
fn get_row_click_play(app: tauri::AppHandle) -> Result<bool, String> {
    Ok(models::read_settings(&app)?
        .row_click_play
        .unwrap_or(false))
}

/// 設定「點擊字幕段時自動播放」。
#[tauri::command]
fn set_row_click_play(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let mut s = models::read_settings(&app)?;
    s.row_click_play = Some(enabled);
    models::write_settings(&app, &s)
}

/* ---------- GPU 加速（Vulkan） ---------- */

/// 透過 DXGI 列舉顯示卡名稱（不含軟體渲染器）。
#[cfg(windows)]
fn gpu_names() -> Vec<String> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};
    // DXGI_ADAPTER_FLAG_SOFTWARE（= 2）：微軟基本渲染驅動，不算真 GPU。
    const DXGI_ADAPTER_FLAG_SOFTWARE: u32 = 2;

    let factory: IDXGIFactory1 = match unsafe { CreateDXGIFactory1() } {
        Ok(f) => f,
        Err(_) => return vec![],
    };
    let mut names = Vec::new();
    let mut i = 0u32;
    loop {
        let adapter = match unsafe { factory.EnumAdapters1(i) } {
            Ok(a) => a,
            Err(_) => break,
        };
        let desc = match unsafe { adapter.GetDesc1() } {
            Ok(d) => d,
            Err(_) => {
                i += 1;
                continue;
            }
        };
        if (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) == 0 {
            // Description 是固定長度 wchar 陣列，字串尾端補 \0；
            // 需在第一個 NUL 截斷，否則會顯示成一串亂碼方框。
            let end = desc.Description.iter().position(|&c| c == 0).unwrap_or(0);
            let name = String::from_utf16_lossy(&desc.Description[..end]);
            let name = name.trim().to_string();
            if !name.is_empty() {
                names.push(name);
            }
        }
        i += 1;
    }
    names
}

#[cfg(not(windows))]
fn gpu_names() -> Vec<String> {
    vec![]
}

/// GPU 資訊（供設定頁顯示）。
/// `vulkanSupported`：本程式建置是否含 Vulkan 後端；
/// `gpus`：偵測到的顯示卡名稱列表。
#[tauri::command]
fn get_gpu_info() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "vulkanSupported": cfg!(feature = "gpu-vulkan"),
        "gpus": gpu_names(),
    }))
}

/// 取得轉錄 GPU 加速設定（預設 true）。
#[tauri::command]
fn get_gpu_accel(app: tauri::AppHandle) -> Result<bool, String> {
    models::gpu_enabled(&app)
}

/// 設定轉錄 GPU 加速（下次轉錄即生效，不需重啟）。
#[tauri::command]
fn set_gpu_accel(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let mut s = models::read_settings(&app)?;
    s.gpu_enabled = Some(enabled);
    models::write_settings(&app, &s)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            models::migrate_legacy(&app.handle());
            models::cleanup_incomplete_downloads(&app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            transcribe,
            cancel_transcribe,
            build_srt,
            write_srt,
            save_state,
            load_state,
            get_autosave_settings,
            set_autosave_limit,
            clear_autosaves,
            get_row_click_play,
            set_row_click_play,
            get_gpu_info,
            get_gpu_accel,
            set_gpu_accel,
            models::models_list,
            models::models_active,
            models::models_select,
            models::models_download,
            models::models_download_cancel,
            models::models_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
