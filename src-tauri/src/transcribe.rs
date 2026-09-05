use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

#[derive(Serialize, Deserialize, Clone)]
pub struct Segment {
    pub index: u32,
    pub start: f64,
    pub end: f64,
    pub text: String,
}

pub fn resolve_model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("models").join("ggml-base.bin"));
    }
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("models").join("ggml-base.bin"));
    }
    for c in &candidates {
        if c.exists() {
            return Ok(c.clone());
        }
    }
    Err(format!("找不到模型檔，嘗試過：{:?}", candidates))
}

pub fn transcribe(
    model_path: &Path,
    audio: &[f32],
    language: Option<&str>,
    app: &AppHandle,
) -> Result<Vec<Segment>, String> {
    let model_str = model_path
        .to_str()
        .ok_or_else(|| "模型路徑含無效字元".to_string())?;
    let ctx = WhisperContext::new_with_params(model_str, WhisperContextParameters::default())
        .map_err(|e| format!("載入模型失敗：{e}"))?;

    let mut state = ctx.create_state().map_err(|e| format!("建立狀態失敗：{e}"))?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(language);
    params.set_translate(false);
    params.set_print_special(false);
    params.set_print_progress(true);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);

    let progress_app = app.clone();
    params.set_progress_callback_safe(move |percent: i32| {
        let _ = progress_app.emit(
            "transcribe-progress",
            serde_json::json!({ "percent": percent }),
        );
    });

    state
        .full(params, audio)
        .map_err(|e| format!("轉錄失敗：{e}"))?;

    let n = state.full_n_segments();
    let mut segments: Vec<Segment> = Vec::with_capacity(n as usize);
    for i in 0..n {
        if let Some(seg) = state.get_segment(i) {
            let raw = seg
                .to_str_lossy()
                .map_err(|e| format!("讀取文本失敗：{e}"))?;
            segments.push(Segment {
                index: seg.segment_index() as u32,
                start: seg.start_timestamp() as f64 / 100.0,
                end: seg.end_timestamp() as f64 / 100.0,
                text: raw.trim().to_owned(),
            });
        }
    }
    Ok(segments)
}