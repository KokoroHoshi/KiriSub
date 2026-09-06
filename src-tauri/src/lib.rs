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
        let mono = match audio::extract_mono_16k(&request.video_path) {
            Ok(m) => m,
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

        let result = {
            let prog = Some(tx);
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                transcribe::transcribe(&path, &mono.samples, request.language.as_deref(), prog)
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

/// 自動儲存字幕編輯進度（app_data_dir/autosave.json）。
#[tauri::command]
fn save_state(
    app: tauri::AppHandle,
    video_path: String,
    segments: Vec<transcribe::Segment>,
) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取得資料目錄失敗：{e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("建立資料夾失敗：{e}"))?;
    let json = serde_json::json!({ "videoPath": video_path, "segments": segments });
    std::fs::write(
        dir.join("autosave.json"),
        serde_json::to_string(&json).map_err(|e| format!("序列化失敗：{e}"))?,
    )
    .map_err(|e| format!("寫入失敗：{e}"))
}

/// 讀回指定影片的自動儲存進度；影片不符則回傳空清單。
#[tauri::command]
fn load_state(app: tauri::AppHandle, video_path: String) -> Result<Vec<transcribe::Segment>, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取得資料目錄失敗：{e}"))?;
    let p = dir.join("autosave.json");
    let Ok(txt) = std::fs::read_to_string(&p) else {
        return Ok(vec![]);
    };
    #[derive(serde::Deserialize)]
    struct Saved {
        #[serde(rename = "videoPath")]
        video_path: String,
        segments: Vec<transcribe::Segment>,
    }
    let saved: Saved = match serde_json::from_str(&txt) {
        Ok(s) => s,
        Err(_) => return Ok(vec![]),
    };
    if saved.video_path != video_path {
        return Ok(vec![]);
    }
    Ok(saved.segments)
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            transcribe,
            cancel_transcribe,
            build_srt,
            write_srt,
            save_state,
            load_state,
            models::models_list,
            models::models_active,
            models::models_select,
            models::models_download,
            models::models_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
