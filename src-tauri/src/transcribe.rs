use std::path::Path;
use std::sync::mpsc::Sender;

use serde::{Deserialize, Serialize};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

#[derive(Serialize, Deserialize, Clone)]
pub struct Segment {
    pub index: u32,
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// 轉錄。進度百分比透過 `progress` channel 送出（由呼叫端轉發事件），
/// 避免在 whisper.cpp 的 FFI 回呼執行緒中直接操作 Tauri emit。
pub fn transcribe(
    model_path: &Path,
    audio: &[f32],
    language: Option<&str>,
    progress: Option<Sender<i32>>,
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
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);

    if let Some(tx) = progress {
        params.set_progress_callback_safe(move |percent: i32| {
            // 只做 channel send；任何錯誤都吞掉，不讓回呼 panic
            let _ = tx.send(percent);
        });
    }

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

#[cfg(test)]
mod tests {
    use super::*;

    /// 在 release 模式下重現「轉錄閃退」：cargo test --release
    #[test]
    fn test_transcribe_full_pipeline() {
        let manifest = env!("CARGO_MANIFEST_DIR");
        let model = format!("{manifest}/models/ggml-base.bin");
        let media = format!("{manifest}/test.mp4");
        if !Path::new(&model).exists() || !Path::new(&media).exists() {
            eprintln!("skip: 缺少模型或測試影片");
            return;
        }
        let mono = crate::audio::extract_mono_16k(&media).expect("抽取音訊失敗");
        println!("音訊樣本數：{}", mono.samples.len());
        let (tx, rx) = std::sync::mpsc::channel();
        let segs = transcribe(Path::new(&model), &mono.samples, Some("ja"), Some(tx))
            .expect("轉錄失敗");
        drop(rx);
        println!("分段數：{}", segs.len());
        for s in segs.iter().take(5) {
            println!("  [{:.2}-{:.2}] {}", s.start, s.end, s.text);
        }
    }
}