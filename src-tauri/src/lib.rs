mod audio;
mod models;
mod subtitle;
mod transcribe;

use serde::Deserialize;
use tauri::Emitter;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscribeRequest {
    video_path: String,
    language: Option<String>,
}

/// 在背景執行緒中執行：抽音訊 → 轉錄。進度與最終分段用事件回傳。
#[tauri::command]
fn transcribe(app: tauri::AppHandle, request: TranscribeRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = match models::resolve_active_model_path(&app) {
            Ok(p) => p,
            Err(e) => {
                let _ = app.emit("transcribe-error", e);
                return;
            }
        };

        let _ = app.emit("transcribe-status", "extracting");
        let mono = match audio::extract_mono_16k(&request.video_path) {
            Ok(m) => m,
            Err(e) => {
                let _ = app.emit("transcribe-error", e);
                return;
            }
        };

        let _ = app.emit("transcribe-status", "transcribing");
        match transcribe::transcribe(
            &path,
            &mono.samples,
            request.language.as_deref(),
            &app,
        ) {
            Ok(segments) => {
                let _ = app.emit("transcribe-done", serde_json::json!({ "segments": segments }));
            }
            Err(e) => {
                let _ = app.emit("transcribe-error", e);
            }
        }
    });
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            models::migrate_legacy(&app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            transcribe,
            build_srt,
            write_srt,
            models::models_list,
            models::models_active,
            models::models_select,
            models::models_download,
            models::models_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
